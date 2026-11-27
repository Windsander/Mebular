// 0.4.0 W3 /context：host plan 预取消费闭环（真实 sidecar + fake capability）。
//
// 覆盖：fresh hit / 首轮 miss / TTL / 新 cue / 候选变化 / replay / malformed /
// 缺 host identity / must_speak 覆盖 / auto fallback。真实宿主 E2E 留 W7。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityClient } from '../../src/sidecar/capability-client.js';
import {
  defaultSidecarConfig,
  normalizeSidecarConfig,
  type SidecarConfig,
} from '../../src/sidecar/config.js';
import { SidecarLocalLayer } from '../../src/sidecar/local-layer.js';
import { SidecarServer } from '../../src/sidecar/server.js';
import { SettlementRuntime } from '../../src/sidecar/settlement.js';
import type { ChatFetch, ChatFetchResponse } from '../../src/inference/gateway.js';
import { createSidecarInferenceProvider } from '../../src/sidecar/inference-provider.js';
import {
  candidateFingerprintOf,
  cueSignatureOf,
  HOST_PLAN_TTL_MS,
} from '../../src/sidecar/host-plan.js';
import {
  startFakeCapability,
  type FakeCapabilityServer,
  type FakeMemoryRecord,
} from './fake-capability.js';

const NOW = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

interface Harness {
  home: string;
  runtime: SettlementRuntime;
  server: SidecarServer;
  fake: FakeCapabilityServer;
  modelCalls: Array<Record<string, any>>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.runtime.stop().catch(() => undefined);
    await harness.server.close().catch(() => undefined);
    await harness.fake.close();
    await rm(harness.home, { recursive: true, force: true });
  }
});

function preferences(): FakeMemoryRecord[] {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `01JHOSTPLAN${index + 1}`,
    type: 'fact',
    kind: 'preference',
    domain: 'user',
    namespace: 'user',
    ownerType: 'user',
    ownerId: 'u_test',
    content: { entity: 'user', preferenceType: 'theme', value: `dark-${index + 1}`, confidence: 0.9 },
    text: `THEME-GIST-${index + 1}`,
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
      threadId: 'th_host_plan',
      agentId: 'opencode',
      agentName: 'OpenCode',
      confirmation: 'explicit',
      at: NOW - (index + 1) * DAY,
    },
    validFrom: NOW - (index + 1) * DAY,
    validTo: null,
    createdAt: NOW - (index + 1) * DAY,
    updatedAt: NOW - (index + 1) * DAY,
    detailAvailable: index === 0,
    legacy: false,
    score: 0.9 - index * 0.08,
  }));
}

function noModelFetch(calls: Array<Record<string, any>>): ChatFetch {
  return async (_url, init) => {
    calls.push(JSON.parse(init.body) as Record<string, any>);
    const response: ChatFetchResponse = {
      ok: false,
      status: 500,
      headers: { get: () => null },
      async text() {
        return '{}';
      },
    };
    return response;
  };
}

async function setup(source: 'host' | 'auto' = 'host'): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-host-plan-http-'));
  const local = new SidecarLocalLayer({ root: join(home, 'memory-runtime'), now: () => NOW });
  await local.init();
  const fake = await startFakeCapability({ now: () => NOW });
  fake.setRecords(preferences());

  const client = new CapabilityClient({ baseUrl: fake.baseUrl, token: 'cap-token', retries: 0, retryDelayMs: 0 });
  const identity = { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' };
  const config: SidecarConfig = defaultSidecarConfig();
  config.http.port = 0;
  config.model = normalizeSidecarConfig({
    model: {
      source,
      api: {
        baseUrl: 'https://api.example.test/v1',
        model: 'test-model',
        keyRef: 'env:TEST_HOST_PLAN_KEY',
        allowRemote: true,
        timeoutMs: 5_000,
      },
    },
  }).model;
  config.intervention = {
    ...config.intervention,
    mode: 'model',
    minConfidence: 0.55,
    maxSilentStreak: 99,
    explorationRate: 0,
    modelTimeoutMs: 200,
  };

  const modelCalls: Array<Record<string, any>> = [];
  const model = createSidecarInferenceProvider(config.model, {
    homeDir: home,
    env: { TEST_HOST_PLAN_KEY: 'sk-never-log' },
    fetch: noModelFetch(modelCalls),
    now: () => NOW,
  });
  const runtime = new SettlementRuntime({
    config,
    local,
    client,
    identity,
    policyStatePath: join(home, 'memory-runtime', 'policy', 'state.json'),
    autoStartReplayer: false,
    inference: model,
    now: () => NOW,
  });
  await runtime.init();
  const server = new SidecarServer({
    config,
    hostToken: 'host-token',
    identity,
    getStatus: async () => runtime.statusSnapshot({
      mode: 'immersive',
      identity,
      capability: { reachable: true, version: 1, lastOkAt: NOW, error: null },
      model: await model.status(),
      limits: {
        maxChunkBytes: config.limits.maxChunkBytes,
        maxContextTokens: config.limits.maxContextTokens,
        maxRecall: config.limits.maxRecall,
      },
      warnings: [],
    }),
    getModelStatus: () => model.status(),
    ingest: runtime,
    namespaces: runtime,
    recall: runtime,
    objects: runtime,
    intervention: runtime,
    getDegraded: () => runtime.degraded,
  });
  await server.listen();
  const harness = { home, runtime, server, fake, modelCalls };
  harnesses.push(harness);
  return harness;
}

function auth(
  hostApp: string | null = 'opencode',
  hostInstance = 'hi_opencode_test',
): Record<string, string> {
  return {
    authorization: 'Bearer host-token',
    'content-type': 'application/json',
    ...(hostApp ? { 'x-mebular-host-app': hostApp } : {}),
    ...(hostApp && hostInstance ? { 'x-mebular-host-instance': hostInstance } : {}),
  };
}

async function post(
  url: string,
  body: unknown,
  hostApp: string | null = 'opencode',
  hostInstance = 'hi_opencode_test',
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: auth(hostApp, hostInstance),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function firstContext(harness: Harness, query = '深色主题') {
  const response = await post(`${harness.server.url}/context`, {
    agentId: 'opencode',
    threadId: 'th_host_plan',
    turnId: 'turn_1',
    turnKind: 'human',
    query,
    maxFragments: 5,
  });
  expect(response.status).toBe(200);
  return response.body.data.interventionMeta;
}

function planFrom(
  meta: { cueFingerprint: string[]; candidateFingerprint: string[]; turnId: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 1,
    planId: 'hp_01JHOSTPLAN0001',
    host: 'opencode',
    hostInstanceId: 'hi_opencode_test',
    agentId: 'opencode',
    threadId: 'th_host_plan',
    scope: 'session',
    basedOnTurnId: meta.turnId,
    cueSignature: cueSignatureOf(meta.cueFingerprint),
    cueFingerprint: meta.cueFingerprint,
    basisCandidateFingerprint: meta.candidateFingerprint,
    createdAt: NOW - 1000,
    expiresAt: NOW - 1000 + HOST_PLAN_TTL_MS,
    action: 'speak',
    depth: 'gist',
    confidence: 0.81,
    reasonCode: 'high_relevance',
    plannerKind: 'host-model',
    plannerVersion: 'opencode:test',
    ...overrides,
  };
}

describe('host plan /context consumption', () => {
  it('首轮无 prior → heuristic + prefetched=false + 暴露 cue/candidate basis', async () => {
    const harness = await setup('host');
    const meta = await firstContext(harness);
    expect(meta).toMatchObject({
      source: 'heuristic',
      resolvedSource: 'heuristic',
      configuredSource: 'host',
      prefetched: false,
      fallbackReason: 'host_plan_missing',
      turnId: 'turn_1',
    });
    expect(meta.cueFingerprint.length).toBeGreaterThan(0);
    expect(meta.candidateFingerprint.length).toBeGreaterThan(0);
    expect(harness.modelCalls).toHaveLength(0);
  });

  it('fresh session prior → source=host + prefetched=true，不调用任何模型', async () => {
    const harness = await setup('host');
    const meta = await firstContext(harness);
    const second = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_host_plan',
      turnId: 'turn_2',
      previousTurnId: 'turn_1',
      turnKind: 'human',
      query: '深色主题',
      hostPlan: planFrom(meta),
      maxFragments: 5,
    });
    expect(second.status).toBe(200);
    expect(second.body.data.decision).toMatchObject({
      action: 'speak',
      depth: 'gist',
      confidence: 0.81,
      reason: 'host_plan:high_relevance',
      enforced: true,
    });
    expect(second.body.data.interventionMeta).toMatchObject({
      source: 'host',
      resolvedSource: 'host',
      prefetched: true,
      planId: 'hp_01JHOSTPLAN0001',
      planScope: 'session',
      cueMatched: true,
    });
    expect(harness.modelCalls).toHaveLength(0);
  });

  it('fresh session prior + alreadyInjectedIds → 仍消费 host plan（prefetched=true），但不重复注入', async () => {
    const harness = await setup('host');
    const first = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_host_plan',
      turnId: 'turn_1',
      turnKind: 'human',
      query: '深色主题',
      maxFragments: 5,
    });
    expect(first.status).toBe(200);
    const injectedIds = first.body.data.fragments.map((fragment: any) => fragment.id);
    const meta = first.body.data.interventionMeta;

    const second = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_host_plan',
      turnId: 'turn_2',
      previousTurnId: 'turn_1',
      turnKind: 'human',
      query: '深色主题',
      hostPlan: planFrom(meta),
      alreadyInjectedIds: injectedIds,
      maxFragments: 5,
    });
    expect(second.status).toBe(200);
    expect(second.body.data.interventionMeta).toMatchObject({
      source: 'host',
      resolvedSource: 'host',
      prefetched: true,
      planId: 'hp_01JHOSTPLAN0001',
    });
    expect(second.body.data.decision).toMatchObject({ action: 'silent', reason: 'no_novelty' });
    expect(second.body.data.fragments).toEqual([]);
    expect(second.body.data.blocks).toEqual([]);
    expect(second.body.data.applied).toMatchObject({ action: 'silent', fragments: 0 });
    expect(harness.modelCalls).toHaveLength(0);
  });

  it('过期 plan → host_plan_expired，立即 heuristic，不等待宿主模型', async () => {
    const harness = await setup('host');
    const meta = await firstContext(harness);
    const second = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_host_plan',
      turnId: 'turn_2',
      previousTurnId: 'turn_1',
      query: '深色主题',
      hostPlan: planFrom(meta, {
        planId: 'hp_01JEXPIRED0001',
        createdAt: NOW - 70_000,
        expiresAt: NOW - 10_000,
      }),
    });
    expect(second.body.data.interventionMeta).toMatchObject({
      source: 'heuristic',
      prefetched: false,
      fallbackReason: 'host_plan_expired',
    });
    expect(second.body.data.warnings).toContain('host_plan_expired');
    expect(harness.modelCalls).toHaveLength(0);
  });

  it('新 cue → host_plan_cue_mismatch，立即 heuristic', async () => {
    const harness = await setup('host');
    const meta = await firstContext(harness);
    const second = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_host_plan',
      turnId: 'turn_2',
      previousTurnId: 'turn_1',
      query: '生产数据库端口是多少',
      hostPlan: planFrom(meta),
    });
    expect(second.body.data.interventionMeta).toMatchObject({
      source: 'heuristic',
      prefetched: false,
      fallbackReason: 'host_plan_cue_mismatch',
    });
    expect(second.body.data.warnings).toContain('host_plan_cue_mismatch');
  });

  it('当前 top-1 不在 basis top-3 → host_plan_candidates_changed', async () => {
    const harness = await setup('host');
    const meta = await firstContext(harness);
    const second = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_host_plan',
      turnId: 'turn_2',
      previousTurnId: 'turn_1',
      query: '深色主题',
      hostPlan: planFrom(meta, {
        basisCandidateFingerprint: candidateFingerprintOf([
          { fragmentId: 'mf_other_a' },
          { fragmentId: 'mf_other_b' },
        ]),
      }),
    });
    expect(second.body.data.interventionMeta).toMatchObject({
      source: 'heuristic',
      prefetched: false,
      fallbackReason: 'host_plan_candidates_changed',
    });
  });

  it('同一 planId 重放 → host_plan_replayed', async () => {
    const harness = await setup('host');
    const meta = await firstContext(harness);
    const plan = planFrom(meta);
    const second = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_host_plan',
      turnId: 'turn_2',
      previousTurnId: 'turn_1',
      query: '深色主题',
      hostPlan: plan,
    });
    expect(second.body.data.interventionMeta.prefetched).toBe(true);
    const replay = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_host_plan',
      turnId: 'turn_3',
      previousTurnId: 'turn_2',
      query: '深色主题',
      hostPlan: { ...plan, basedOnTurnId: 'turn_2' },
    });
    expect(replay.body.data.interventionMeta).toMatchObject({
      source: 'heuristic',
      prefetched: false,
      fallbackReason: 'host_plan_replayed',
    });
  });

  it('malformed plan / 缺 host identity → 丢弃并 fallback，不 4xx', async () => {
    const harness = await setup('host');
    const meta = await firstContext(harness);
    const malformed = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_host_plan',
      turnId: 'turn_2',
      previousTurnId: 'turn_1',
      query: '深色主题',
      hostPlan: { ...planFrom(meta), action: 'yell' },
    });
    expect(malformed.status).toBe(200);
    expect(malformed.body.data.interventionMeta.fallbackReason).toBe('host_plan_invalid');

    const noHost = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_host_plan',
      turnId: 'turn_3',
      previousTurnId: 'turn_2',
      query: '深色主题',
      // body 伪造必须被 server 丢弃；没有 header 就不算 host 身份。
      hostApp: 'opencode',
      hostInstanceId: 'hi_opencode_test',
      hostPlan: { ...planFrom(meta), planId: 'hp_01JNOHOST000001' },
    }, null);
    expect(noHost.status).toBe(200);
    expect(noHost.body.data.interventionMeta.fallbackReason).toBe('host_plan_scope_mismatch');
    expect(noHost.body.data.interventionMeta.hostApp).toBeUndefined();
  });

  it('hostInstance 与 plan 不一致 → host_plan_scope_mismatch', async () => {
    const harness = await setup('host');
    const meta = await firstContext(harness);
    const second = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_host_plan',
      turnId: 'turn_2',
      previousTurnId: 'turn_1',
      query: '深色主题',
      hostPlan: planFrom(meta),
    }, 'opencode', 'hi_other_instance');
    expect(second.body.data.interventionMeta).toMatchObject({
      source: 'heuristic',
      prefetched: false,
      fallbackReason: 'host_plan_scope_mismatch',
    });
  });

  it('must_speak 硬规则优先；plan silent 不能覆盖，且 plan 被消费', async () => {
    const harness = await setup('host');
    const meta = await firstContext(harness, '上次我说过什么偏好');
    const second = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_host_plan',
      turnId: 'turn_2',
      previousTurnId: 'turn_1',
      query: '上次我说过什么偏好',
      hostPlan: planFrom(meta, {
        action: 'silent',
        depth: 'gist',
        reasonCode: 'low_relevance',
        confidence: 0.2,
      }),
    });
    expect(second.body.data.decision.action).toBe('speak');
    expect(second.body.data.decision.reason).toMatch(/^must_speak:/);
    expect(second.body.data.interventionMeta).toMatchObject({
      source: 'heuristic',
      prefetched: false,
      fallbackReason: 'host_plan_overridden_by_hard_rule',
    });
  });

  it('auto：host plan 不命中时走既有 local/api 解析，不成功冒充 host', async () => {
    const harness = await setup('auto');
    const meta = await firstContext(harness);
    const second = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_host_plan',
      turnId: 'turn_2',
      previousTurnId: 'turn_1',
      query: '生产数据库端口是多少',
      hostPlan: planFrom(meta),
    });
    expect(second.body.data.interventionMeta.source).not.toBe('host');
    expect(second.body.data.interventionMeta.prefetched).toBe(false);
    expect(second.body.data.interventionMeta.fallbackReason).toBe('host_plan_cue_mismatch');
  });
});
