// 0.4.0 W2：local 源真实生效（两轮预取语义）。
// - 首轮/新 cue/过期/cue mismatch → heuristic + prefetched=false；
// - 上一轮结束后异步 seed local plan，`/context` 决策点不启动本地模型；
// - 第二轮命中新鲜 plan → source=local + prefetched=true；
// - planner 诊断进入 decision/trace/status，不含正文/凭据。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityClient } from '../../src/sidecar/capability-client.js';
import { defaultSidecarConfig, type SidecarConfig } from '../../src/sidecar/config.js';
import { SidecarLocalLayer } from '../../src/sidecar/local-layer.js';
import { RecallService } from '../../src/sidecar/recall.js';
import type {
  InferenceInterventionRequest,
  InferenceInterventionResult,
} from '../../src/sidecar/inference-provider.js';
import {
  startFakeCapability,
  type FakeCapabilityServer,
  type FakeMemoryRecord,
} from './fake-capability.js';

const NOW = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

class FakeLocalModel {
  calls = 0;
  requests: InferenceInterventionRequest[] = [];
  delayMs = 0;
  result: InferenceInterventionResult = {
    ok: true,
    action: 'speak',
    depth: 'gist',
    confidence: 0.86,
    reason: 'prefetched_local',
    model: 'fake-local',
    degraded: false,
    warnings: [],
    latencyMs: 9,
  };

  async planIntervention(
    request: InferenceInterventionRequest,
  ): Promise<InferenceInterventionResult> {
    this.calls += 1;
    this.requests.push(request);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return { ...this.result, source: request.source } as InferenceInterventionResult;
  }
}

interface Harness {
  home: string;
  fake: FakeCapabilityServer;
  service: RecallService;
  model: FakeLocalModel;
  config: SidecarConfig;
  clock: { now: number };
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.fake.close();
    await rm(harness.home, { recursive: true, force: true });
  }
});

function preference(): FakeMemoryRecord {
  return {
    id: '01JLOCALPREF001',
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
      threadId: 'th_local',
      agentId: 'opencode',
      agentName: 'OpenCode',
      confirmation: 'explicit',
      at: NOW - DAY,
    },
    validFrom: NOW - DAY,
    validTo: null,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    detailAvailable: false,
    legacy: false,
    score: 0.9,
  };
}

async function setup(options: { source?: 'local' | 'auto' | 'api' } = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-intervention-local-'));
  const clock = { now: NOW };
  const local = new SidecarLocalLayer({
    root: join(home, 'memory-runtime'),
    now: () => clock.now,
  });
  await local.init();
  const fake = await startFakeCapability({ now: () => clock.now });
  fake.setRecords([preference()]);
  const client = new CapabilityClient({
    baseUrl: fake.baseUrl,
    token: 'cap-token',
    retries: 0,
    retryDelayMs: 0,
  });
  const config = defaultSidecarConfig();
  config.model.sourcePresent = true;
  config.model.source = options.source ?? 'local';
  config.model.local.pack = 'fake-pack';
  config.intervention = {
    ...config.intervention,
    minConfidence: 0.55,
    maxSilentStreak: 99,
    explorationRate: 0,
    modelTimeoutMs: 500,
  };
  const model = new FakeLocalModel();
  const service = new RecallService({
    config,
    local,
    client,
    identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
    inference: model as any,
    now: () => clock.now,
  });
  const harness = { home, fake, service, model, config, clock };
  harnesses.push(harness);
  return harness;
}

function contextBody(query: string, turnId: string) {
  return {
    agentId: 'opencode',
    threadId: 'th_local',
    turnId,
    query,
    allowRemote: true,
    maxFragments: 3,
  };
}

async function flushPrefetch(): Promise<void> {
  // setImmediate 后再让 provider 的 async 调用完成。
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('local intervention prefetch (W2)', () => {
  it('首轮：heuristic + prefetched=false；响应期间不启动本地模型', async () => {
    const { service, model } = await setup();
    const response = await service.handleContext(contextBody('深色主题偏好', 'turn_1'));

    expect(response.data.decision).toMatchObject({
      action: 'speak',
      enforced: true,
    });
    expect(response.data.decision?.policyVersion).toMatch(/^heuristic:/);
    expect(response.data.decision?.planner).toMatchObject({
      configuredSource: 'local',
      resolvedSource: null,
      prefetched: false,
      prefetchState: 'first_turn',
      fallbackReason: 'prefetch_miss',
    });
    // `/context` 返回时本地模型调用必须仍为 0（预取只能发生在响应之后）。
    expect(model.calls).toBe(0);
    expect(response.data.warnings).toContain('intervention_prefetch_first_turn');

    await flushPrefetch();
    expect(model.calls).toBe(1);
    // 预取请求只含聚合 cue + gist，不含 raw query/detail。
    const request = model.requests[0]!;
    expect(request.source).toBe('local');
    expect(request.allowRemote).toBe(false);
    expect(JSON.stringify(request)).not.toContain('深色主题偏好');
  });

  it('第二轮同 cue：消费新鲜 plan，source=local + prefetched=true，不重复同步调用', async () => {
    const { service, model } = await setup();
    await service.handleContext(contextBody('深色主题偏好', 'turn_1'));
    await flushPrefetch();
    expect(model.calls).toBe(1);

    const response = await service.handleContext(contextBody('深色主题偏好', 'turn_2'));
    const planner = response.data.decision?.planner;
    expect(planner).toMatchObject({
      configuredSource: 'local',
      resolvedSource: 'local',
      prefetched: true,
      prefetchState: 'hit',
      fallbackReason: null,
      model: 'fake-local',
    });
    expect(planner?.planId).toMatch(/^lp_/);
    expect(planner?.planAgeMs).toBeGreaterThanOrEqual(0);
    expect(response.data.decision).toMatchObject({
      reason: 'prefetched_local',
      enforced: true,
    });
    expect(response.data.decision?.policyVersion).toMatch(/^model:/);
    // 命中后不重新同步调用 provider；响应返回时仍只有上一轮的预取。
    expect(model.calls).toBe(1);

    // trace 只记录 planner 元数据，不落 planner 正文/凭据。
    const trace = await service.getTrace(response.data.traceId!);
    expect(trace?.decision?.planner).toMatchObject({
      resolvedSource: 'local',
      prefetched: true,
      prefetchState: 'hit',
    });
    expect(JSON.stringify(trace?.decision?.planner)).not.toContain('深色主题偏好');
  });

  it('新 cue：cue_mismatch → heuristic + prefetched=false', async () => {
    const { service, model } = await setup();
    await service.handleContext(contextBody('深色主题偏好', 'turn_1'));
    await flushPrefetch();

    const response = await service.handleContext(contextBody('颜色搭配怎么样', 'turn_2'));
    expect(response.data.decision?.planner).toMatchObject({
      configuredSource: 'local',
      resolvedSource: null,
      prefetched: false,
      prefetchState: 'cue_mismatch',
      fallbackReason: 'prefetch_miss',
    });
    expect(response.data.decision?.policyVersion).toMatch(/^heuristic:/);
    expect(response.data.warnings).toContain('intervention_prefetch_cue_mismatch');
    expect(model.calls).toBe(1);
  });

  it('过期：超过 60s 后不消费旧 plan', async () => {
    const { service, model, clock } = await setup();
    await service.handleContext(contextBody('深色主题偏好', 'turn_1'));
    await flushPrefetch();
    expect(model.calls).toBe(1);

    clock.now = NOW + 60_001;
    const response = await service.handleContext(contextBody('深色主题偏好', 'turn_2'));
    expect(response.data.decision?.planner).toMatchObject({
      configuredSource: 'local',
      resolvedSource: null,
      prefetched: false,
      prefetchState: 'expired',
      fallbackReason: 'prefetch_miss',
    });
    expect(response.data.warnings).toContain('intervention_prefetch_expired');
  });

  it('auto：local 已配置但未命中 → heuristic，不切 api', async () => {
    const { service, model } = await setup({ source: 'auto' });
    const response = await service.handleContext(contextBody('深色主题偏好', 'turn_1'));
    expect(response.data.decision?.planner).toMatchObject({
      configuredSource: 'auto',
      resolvedSource: null,
      prefetched: false,
      fallbackReason: 'prefetch_miss',
    });
    expect(model.calls).toBe(0);
  });

  it('reset 清空预取：reset 后同 cue 回到 first_turn', async () => {
    const { service, model } = await setup();
    await service.handleContext(contextBody('深色主题偏好', 'turn_1'));
    await flushPrefetch();
    service.resetInterventionState();

    const response = await service.handleContext(contextBody('深色主题偏好', 'turn_2'));
    expect(response.data.decision?.planner).toMatchObject({
      resolvedSource: null,
      prefetchState: 'first_turn',
      prefetched: false,
    });
    expect(model.calls).toBe(1);
  });
});
