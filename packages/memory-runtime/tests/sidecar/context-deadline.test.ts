// 0.4.0 W5：`/context` 硬 deadline、planner 预算、trace skip 与队列 fallback。
// 只测 sidecar 行为；不依赖真实模型/宿主。

import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityClient } from '../../src/sidecar/capability-client.js';
import { defaultSidecarConfig, type SidecarConfig } from '../../src/sidecar/config.js';
import { SidecarLocalLayer } from '../../src/sidecar/local-layer.js';
import { RecallService } from '../../src/sidecar/recall.js';
import { InterventionPlannerQueue } from '../../src/sidecar/intervention-queue.js';
import {
  startFakeCapability,
  type FakeCapabilityServer,
  type FakeMemoryRecord,
} from './fake-capability.js';

const DAY = 24 * 60 * 60 * 1000;

interface FakeModel {
  planQueryCalls: number;
  planInterventionCalls: number;
  planInterventionTimeout: number | null;
  lastPlannerDeadline: number | null;
  selectOptionalSource: () => Promise<{ source: 'api'; warnings: string[]; degraded: boolean }>;
  planQuery: () => Promise<{
    ok: boolean;
    query?: string;
    degraded: boolean;
    warnings: string[];
    latencyMs: number;
  }>;
  planIntervention: (
    request: unknown,
    options?: { timeoutMs?: number },
  ) => Promise<{
    ok: boolean;
    degraded: boolean;
    reasonCode?: string;
    warnings: string[];
    latencyMs: number;
  }>;
  noteFailure: (source: string, reason: string, warnings: string[]) => void;
  clearFailure: (source?: string) => void;
}

function hang(): Promise<never> {
  return new Promise<never>(() => undefined);
}

function fakeModel(options: {
  queryDelayMs?: number;
  planDelayMs?: number;
  selectionHang?: boolean;
} = {}): FakeModel {
  const model: FakeModel = {
    planQueryCalls: 0,
    planInterventionCalls: 0,
    planInterventionTimeout: null,
    lastPlannerDeadline: null,
    selectOptionalSource: async () => {
      if (options.selectionHang) await hang();
      return { source: 'api', warnings: [], degraded: false };
    },
    planQuery: async () => {
      model.planQueryCalls += 1;
      if (options.queryDelayMs) await hang();
      return {
        ok: true,
        query: 'planned query',
        degraded: false,
        warnings: [],
        latencyMs: options.queryDelayMs ?? 0,
      };
    },
    planIntervention: async (_request, planOptions) => {
      model.planInterventionCalls += 1;
      model.planInterventionTimeout = planOptions?.timeoutMs ?? null;
      if (options.planDelayMs) await hang();
      return {
        ok: true,
        action: 'speak',
        depth: 'gist',
        confidence: 0.9,
        reason: 'fake_api',
        degraded: false,
        warnings: [],
        latencyMs: options.planDelayMs ?? 0,
      } as never;
    },
    noteFailure: () => undefined,
    clearFailure: () => undefined,
  };
  return model;
}

interface Harness {
  home: string;
  fake: FakeCapabilityServer;
  service: RecallService;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.fake.close();
    await rm(harness.home, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function preference(now: number): FakeMemoryRecord {
  return {
    id: '01JW5DEADLINE001',
    type: 'fact',
    kind: 'preference',
    domain: 'user',
    namespace: 'user',
    ownerType: 'user',
    ownerId: 'u_test',
    content: { entity: 'user', preferenceType: 'theme', value: 'dark', confidence: 0.92 },
    text: 'THEME-GIST-DARK',
    tags: ['preference'],
    provenance: {
      source: 'runtime',
      writerType: 'agent',
      writerId: 'opencode',
      extractor: 'host',
      model: 'host-provided',
      version: '0.3.0',
      deviceId: 'device-local',
      hostId: 'h_test',
      threadId: 'th_deadline',
      agentId: 'opencode',
      agentName: 'OpenCode',
      confirmation: 'explicit',
      at: now - DAY,
    },
    validFrom: now - DAY,
    validTo: null,
    createdAt: now - DAY,
    updatedAt: now - DAY,
    detailAvailable: false,
    legacy: false,
    score: 0.9,
  };
}

interface SetupOptions {
  deadlineMs?: number;
  source?: 'heuristic' | 'local' | 'host' | 'api' | 'auto';
  slowSelfMs?: number;
  selfDelayMs?: number;
  slowCheckpointMs?: number;
  inference?: unknown;
  queryPlan?: 'heuristic' | 'model';
  plannerQueue?: unknown;
  traceDelayMs?: number;
  traceFail?: boolean;
  namespacesHang?: boolean;
}

interface SlowSourceState {
  selfCalls: number;
  checkpointCalls: number;
}

async function setup(options: SetupOptions = {}): Promise<Harness & {
  model: FakeModel;
  slow: SlowSourceState;
  config: SidecarConfig;
}> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-w5-deadline-'));
  const now = () => Date.now();
  const nowMs = now();
  const local = new SidecarLocalLayer({
    root: join(home, 'memory-runtime'),
    now,
  });
  await local.init();
  const fake = await startFakeCapability({ now });
  fake.setRecords([preference(nowMs)]);

  const config = defaultSidecarConfig();
  config.context.deadlineMs = options.deadlineMs ?? 1500;
  config.context.deadlineClamped = false;
  config.model.sourcePresent = true;
  config.model.source = options.source ?? 'heuristic';
  config.model.api.baseUrl = 'http://127.0.0.1:9';
  config.model.api.model = 'fake-api';
  config.model.api.allowRemote = true;
  if (options.source === 'local' || options.source === 'auto') {
    config.model.local.pack = 'fake-pack';
  }
  config.recall.queryPlan = options.queryPlan ?? 'heuristic';

  const slow: SlowSourceState = { selfCalls: 0, checkpointCalls: 0 };
  const slowSource = {
    async getSelf() {
      slow.selfCalls += 1;
      if (options.selfDelayMs) await sleep(options.selfDelayMs);
      if (options.slowSelfMs) await hang();
      return { status: 200, data: {}, warnings: [], degraded: false };
    },
    async getCheckpoint() {
      slow.checkpointCalls += 1;
      if (options.slowCheckpointMs) await hang();
      return { status: 200, data: {}, warnings: [], degraded: false };
    },
  };

  if (options.traceDelayMs) {
    const store = local.store as unknown as {
      putTrace: (trace: unknown) => Promise<void>;
    };
    // 永不返回：模拟慢 store；deadline 必须跳过 trace，而不是等它写完。
    store.putTrace = async () => hang();
  }
  if (options.traceFail) {
    const store = local.store as unknown as {
      putTrace: (trace: unknown) => Promise<void>;
    };
    store.putTrace = async () => {
      throw new Error('trace store unavailable');
    };
  }

  const client = new CapabilityClient({
    baseUrl: fake.baseUrl,
    token: 'cap-token',
    retries: 0,
    retryDelayMs: 0,
  });
  if (options.namespacesHang) {
    client.getNamespaces = async () => hang() as never;
  }

  const service = new RecallService({
    config,
    local,
    client,
    identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
    checkpointSource: slowSource as never,
    selfSource: slowSource as never,
    ...(options.inference ? { inference: options.inference as never } : {}),
    ...(options.plannerQueue ? { plannerQueue: options.plannerQueue as never } : {}),
  });
  const harness = { home, fake, service };
  harnesses.push(harness);
  return {
    ...harness,
    model: (options.inference ?? fakeModel()) as FakeModel,
    slow,
    config,
  };
}

function body(turnId = 'turn_w5') {
  return {
    agentId: 'opencode',
    threadId: 'th_deadline',
    turnId,
    query: '深色主题偏好',
    allowRemote: true,
    maxFragments: 3,
  };
}

describe('/context hard deadline (W5)', () => {
  it('慢 self 不突破总 deadline；checkpoint 不再启动', async () => {
    const { service, slow } = await setup({
      deadlineMs: 1000,
      slowSelfMs: 5000,
      slowCheckpointMs: 5000,
    });
    const started = Date.now();
    const response = await service.handleContext(body());
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThanOrEqual(1000);
    expect(response.data.timing.totalMs).toBeLessThanOrEqual(1000);
    expect(response.data.warnings).toContain('context_deadline_exceeded');
    expect(response.data.warnings).toContain('self_deadline_exceeded');
    expect(slow.selfCalls).toBe(1);
    expect(slow.checkpointCalls).toBe(0);
    expect(response.data.degraded).toBe(true);
  });

  it('response reserve：慢 checkpoint 也在 deadline 内收尾', async () => {
    const { service } = await setup({
      deadlineMs: 1000,
      slowCheckpointMs: 5000,
    });
    const started = Date.now();
    const response = await service.handleContext(body());
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThanOrEqual(1000);
    expect(response.data.warnings).toContain('checkpoint_deadline_exceeded');
    expect(response.data.timing.totalMs).toBeLessThanOrEqual(1000);
  });

  it('trace 来不及时 skip-on-deadline：traceId/bindingToken=null，tracePersisted=false', async () => {
    const { service } = await setup({
      deadlineMs: 600,
      traceDelayMs: 900,
    });
    const started = Date.now();
    const response = await service.handleContext(body());
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThanOrEqual(600);
    expect(response.data.traceId).toBeNull();
    expect(response.data.bindingToken).toBeNull();
    expect(response.data.tracePersisted).toBe(false);
    expect(response.data.degraded).toBe(true);
    expect(response.data.warnings).toContain('trace_write_skipped_deadline');
  });

  it('正常 trace 写入成功：tracePersisted=true 且 traceId 非空', async () => {
    const { service } = await setup({ deadlineMs: 1000 });
    const response = await service.handleContext(body());
    expect(response.data.traceId).not.toBeNull();
    expect(response.data.tracePersisted).toBe(true);
  });

  it('trace 写入失败：tracePersisted=false，W4 不得据此签发 token', async () => {
    const { service } = await setup({ deadlineMs: 1000, traceFail: true });
    const response = await service.handleContext(body('turn_trace_fail'));
    expect(response.data.traceId).toBeNull();
    expect(response.data.tracePersisted).toBe(false);
    expect(response.data.warnings).toContain('trace_write_failed');
  });

  it('慢 namespaces 不突破 deadline；降级到策略可读默认域', async () => {
    const { service } = await setup({
      deadlineMs: 600,
      namespacesHang: true,
    });
    const started = Date.now();
    const response = await service.handleContext({ ...body('turn_namespaces'), includeOtherAgents: true });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThanOrEqual(600);
    expect(response.data.timing.totalMs).toBeLessThanOrEqual(600);
    expect(response.data.warnings).toContain('context_deadline_exceeded');
    expect(response.data.warnings).toContain('domains_deadline_exceeded');
    // 降级仍使用默认可读域，而不是空域/ forbidden 状态。
    expect(response.data.silenceReason).not.toBe('domain_forbidden');
  });

  it('慢 selectOptionalSource 不启动 planQuery，保留原 query + heuristic', async () => {
    const model = fakeModel({ selectionHang: true });
    const { service } = await setup({
      deadlineMs: 700,
      source: 'api',
      queryPlan: 'model',
      inference: model,
    });
    const started = Date.now();
    const response = await service.handleContext(body('turn_selection'));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThanOrEqual(700);
    expect(model.planQueryCalls).toBe(0);
    expect(response.data.warnings).toContain('query_plan_deadline_exceeded');
    expect(response.data.warnings).toContain('query_plan_fallback_heuristic');
    expect(response.data.decision?.planner).toMatchObject({
      fallbackReason: 'deadline',
    });
  });

  it('剩余预算 <200ms：不启动 API，fallbackReason=deadline', async () => {
    const model = fakeModel();
    const { service, slow } = await setup({
      deadlineMs: 500,
      source: 'api',
      selfDelayMs: 200,
      inference: model,
    });
    const started = Date.now();
    const response = await service.handleContext(body());
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThanOrEqual(500);
    expect(slow.selfCalls).toBe(1);
    expect(model.planInterventionCalls).toBe(0);
    expect(response.data.decision?.planner).toMatchObject({
      configuredSource: 'api',
      resolvedSource: null,
      fallbackReason: 'deadline',
      prefetched: false,
    });
    expect(response.data.warnings).toContain('planner_deadline_exceeded');
  });

  it('API 单次调用受剩余预算约束；超时回退 heuristic', async () => {
    const model = fakeModel({ planDelayMs: 5000 });
    const { service } = await setup({
      deadlineMs: 700,
      source: 'api',
      inference: model,
    });
    const started = Date.now();
    const response = await service.handleContext(body());
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThanOrEqual(700);
    expect(model.planInterventionCalls).toBe(1);
    expect(model.planInterventionTimeout).toBeGreaterThanOrEqual(200);
    expect(model.planInterventionTimeout).toBeLessThanOrEqual(700);
    expect(response.data.decision?.planner).toMatchObject({
      resolvedSource: null,
      fallbackReason: 'timeout',
    });
    expect(response.data.warnings).toContain('model_timeout');
  });

  it('queryPlan 与 intervention 共享同一 deadline：query 超时后不再启动模型', async () => {
    const model = fakeModel({ queryDelayMs: 5000 });
    const { service } = await setup({
      deadlineMs: 800,
      source: 'api',
      queryPlan: 'model',
      inference: model,
    });
    const started = Date.now();
    const response = await service.handleContext(body());
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThanOrEqual(800);
    expect(model.planQueryCalls).toBe(1);
    expect(model.planInterventionCalls).toBe(0);
    expect(response.data.warnings).toContain('query_plan_deadline_exceeded');
    expect(response.data.warnings).toContain('query_plan_fallback_heuristic');
    expect(response.data.decision?.planner).toMatchObject({
      fallbackReason: 'deadline',
    });
  });

  it('local/host miss 不启动同步模型', async () => {
    const hostModel = fakeModel();
    const host = await setup({ deadlineMs: 1000, source: 'host', inference: hostModel });
    const hostResponse = await host.service.handleContext(body('turn_host'));
    expect(hostModel.planInterventionCalls).toBe(0);
    expect(hostResponse.data.decision?.planner).toMatchObject({
      fallbackReason: 'host_plan_missing',
    });

    const localModel = fakeModel();
    const local = await setup({ deadlineMs: 1000, source: 'local', inference: localModel });
    const localResponse = await local.service.handleContext(body('turn_local'));
    expect(localModel.planInterventionCalls).toBe(0);
    expect(localResponse.data.decision?.planner).toMatchObject({
      fallbackReason: 'prefetch_miss',
    });
  });

  it('planner 队列溢出：立即 heuristic + planner_queue_overflow', async () => {
    const model = fakeModel();
    const queue = {
      enqueue: async () => ({ status: 'overflow' }),
      metrics: () => new InterventionPlannerQueue({ concurrency: 1, maxQueue: 1 }).metrics(),
    };
    const { service } = await setup({
      deadlineMs: 1000,
      source: 'api',
      inference: model,
      plannerQueue: queue,
    });
    const response = await service.handleContext(body());

    expect(model.planInterventionCalls).toBe(0);
    expect(response.data.decision?.planner).toMatchObject({
      fallbackReason: 'planner_queue_overflow',
    });
    expect(response.data.warnings).toContain('planner_queue_overflow');
  });
});

describe('W4 × W5 binding token gating', () => {
  it('normal trace：tracePersisted=true 且签发 token', async () => {
    const { service } = await setup({ deadlineMs: 1000 });
    const response = await service.handleContext(body('turn_token_normal'), 'host-token');

    expect(response.data.tracePersisted).toBe(true);
    expect(response.data.traceId).not.toBeNull();
    expect(response.data.bindingToken).toMatch(/^obt_/);
  });

  it('trace 写入失败：tracePersisted=false，即使有 host token 也不签发', async () => {
    const { service } = await setup({ deadlineMs: 1000, traceFail: true });
    const response = await service.handleContext(body('turn_token_fail'), 'host-token');

    expect(response.data.tracePersisted).toBe(false);
    expect(response.data.bindingToken).toBeNull();
  });

  it('skip-on-deadline：traceId/bindingToken=null，即使有 host token 也不签发', async () => {
    const { service } = await setup({ deadlineMs: 600, traceDelayMs: 900 });
    const response = await service.handleContext(body('turn_token_skip'), 'host-token');

    expect(response.data.tracePersisted).toBe(false);
    expect(response.data.traceId).toBeNull();
    expect(response.data.bindingToken).toBeNull();
  });
});
