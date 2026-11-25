// 0.4.0 Phase 3 HTTP 闭环：真实 ManagedInferenceProvider + fake gateway。
// 覆盖 model 模式的 silent / speak+detail / defer / must_speak / timeout /
// 非法输出 / 隐私 / policyVersion / status.policy / reset。

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
import {
  createSidecarInferenceProvider,
  type SidecarInferenceProvider,
} from '../../src/sidecar/inference-provider.js';
import { SidecarServer } from '../../src/sidecar/server.js';
import { SettlementRuntime } from '../../src/sidecar/settlement.js';
import type { ChatFetch, ChatFetchResponse } from '../../src/inference/gateway.js';
import {
  startFakeCapability,
  type FakeCapabilityServer,
  type FakeMemoryRecord,
} from './fake-capability.js';

const NOW = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const TOKEN_SECRET = 'sk-intervention-secret-never-log';
const DETAIL_SECRET = 'DETAIL-RAW-TEXT-不要进 prompt';
const CHECKPOINT_SECRET = 'CHECKPOINT-STATUS-不要进 prompt';

interface Harness {
  home: string;
  fake: FakeCapabilityServer;
  runtime: SettlementRuntime;
  model: SidecarInferenceProvider;
  server: SidecarServer;
  calls: Array<Record<string, any>>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.runtime.stop().catch(() => undefined);
    await harness.server.close().catch(() => undefined);
    await harness.model.dispose().catch(() => undefined);
    await harness.fake.close();
    await rm(harness.home, { recursive: true, force: true });
  }
});

function jsonResponse(content: string, status = 200): ChatFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() {
      return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
    },
  };
}

interface Reply {
  content?: string;
  delayMs?: number;
}

function beginFetch(handler: () => Reply): { calls: Array<Record<string, any>>; fetchImpl: ChatFetch } {
  const calls: Array<Record<string, any>> = [];
  const fetchImpl: ChatFetch = async (_url, init) => {
    calls.push(JSON.parse(init.body) as Record<string, any>);
    const reply = handler();
    if (reply.delayMs && reply.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, reply.delayMs);
        (timer as unknown as { unref?: () => void }).unref?.();
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted by model timeout'));
        }, { once: true });
      });
    }
    return jsonResponse(reply.content ?? JSON.stringify({
      action: 'speak',
      depth: 'gist',
      confidence: 0.8,
      reason: 'default',
    }));
  };
  return { calls, fetchImpl };
}

function preferences(): FakeMemoryRecord[] {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `01JMODELHTTP${index + 1}`,
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
      threadId: 'th_model_http',
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

async function setup(options: {
  reply: () => Reply;
  timeoutMs?: number;
  checkpoint?: boolean;
}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-intervention-model-http-'));
  const local = new SidecarLocalLayer({ root: join(home, 'memory-runtime'), now: () => NOW });
  await local.init();
  const fake = await startFakeCapability({ now: () => NOW });
  fake.setRecords(preferences());
  fake.details.push({
    id: '01JMODELHTTPDETAIL1',
    detailKind: 'raw_chunk',
    domain: 'user',
    recordIds: ['01JMODELHTTP1'],
    role: 'user',
    text: DETAIL_SECRET,
    messageId: 'm_model_detail',
    chunkIndex: 0,
    provenance: { source: 'runtime', deviceId: 'device-a', agentId: 'opencode' },
    createdAt: NOW - DAY,
  } as any);
  if (options.checkpoint) {
    fake.checkpoints.push({
      id: '01JMODELHTTPCKPT',
      domain: 'task:th_model_http',
      agentId: 'opencode',
      threadId: 'th_model_http',
      revision: 1,
      state: {
        schema: 2,
        contentMode: 'structured',
        task: { key: 'task:th_model_http', threadId: 'th_model_http', fleetTaskId: null },
        goal: CHECKPOINT_SECRET,
        constraints: [],
        decisions: [],
        progress: { done: [], doing: [], blocked: [] },
        nextSteps: [{ id: 'n1', text: 'continue' }],
        files: [],
        openQuestions: [],
        references: { recordIds: [], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
      },
      summary: null,
      recordIds: [],
      lease: null,
      expiresAt: 0,
    } as any);
  }

  const client = new CapabilityClient({ baseUrl: fake.baseUrl, token: 'cap-token', retries: 0, retryDelayMs: 0 });
  const identity = { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' };
  const config: SidecarConfig = defaultSidecarConfig();
  config.http.port = 0;
  config.model = normalizeSidecarConfig({
    model: {
      source: 'api',
      api: {
        baseUrl: 'https://api.example.test/v1',
        model: 'test-model',
        keyRef: 'env:TEST_INTERVENTION_KEY',
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
    modelTimeoutMs: options.timeoutMs ?? 500,
  };

  const { calls, fetchImpl } = beginFetch(options.reply);
  const model = createSidecarInferenceProvider(config.model, {
    homeDir: home,
    env: { TEST_INTERVENTION_KEY: TOKEN_SECRET },
    fetch: fetchImpl,
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
  const harness = { home, fake, runtime, model, server, calls };
  harnesses.push(harness);
  return harness;
}

function auth(): Record<string, string> {
  return { authorization: 'Bearer host-token' };
}

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const SPEAK_GIST = JSON.stringify({ action: 'speak', depth: 'gist', confidence: 0.8, reason: 'relevant' });

describe('intervention model HTTP path', () => {
  it('模型 speak/gist：真实 provider 决策生效，policyVersion=model:<hash>，prompt 无正文', async () => {
    const harness = await setup({ reply: () => ({ content: SPEAK_GIST }) });
    const context = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_model_http',
      turnId: 'turn_model_speak',
      query: '深色主题',
      allowRemote: true,
      maxFragments: 5,
    });
    expect(context.status).toBe(200);
    expect(context.body.data.decision).toMatchObject({
      action: 'speak',
      depth: 'gist',
      confidence: 0.8,
      reason: 'relevant',
      enforced: true,
    });
    expect(context.body.data.decision.policyVersion).toMatch(/^model:[0-9a-f]{8}$/);
    expect(context.body.data.decision.degraded).toBeUndefined();
    expect(context.body.data.warnings).not.toContain('intervention_model_fallback');
    expect(context.body.data.fragments.length).toBeGreaterThan(0);

    expect(harness.calls).toHaveLength(1);
    const request = harness.calls[0]!;
    expect(request.temperature).toBe(0);
    expect(request.max_tokens).toBe(256);
    const prompt = request.messages.map((message: any) => message.content).join('\n');
    expect(prompt).toContain('<untrusted_data>');
    expect(prompt).toContain('用户偏好：theme=dark-');
    expect(prompt).toContain('stats: spoken=0');
    expect(prompt).not.toContain(DETAIL_SECRET);
    expect(prompt).not.toContain(CHECKPOINT_SECRET);
    expect(prompt).not.toContain(TOKEN_SECRET);
    expect(JSON.stringify(request)).not.toContain(TOKEN_SECRET);
    // 最多 3 个候选 gist 进入 prompt。
    expect((prompt.match(/<untrusted_data>/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  it('模型 speak/detail：按模型深度展开 detail，prompt 仍然只含 gist', async () => {
    const harness = await setup({
      reply: () => ({
        content: JSON.stringify({ action: 'speak', depth: 'detail', confidence: 0.85, reason: 'why_asked' }),
      }),
    });
    const context = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_model_http',
      turnId: 'turn_model_detail',
      query: '为什么偏好深色主题？',
      allowRemote: true,
    });
    expect(context.status).toBe(200);
    expect(context.body.data.decision).toMatchObject({
      action: 'speak',
      depth: 'detail',
      reason: 'why_asked',
      enforced: true,
    });
    expect(context.body.data.decision.policyVersion).toMatch(/^model:/);
    expect(context.body.data.fragments[0].detail).toBeDefined();

    const prompt = harness.calls[0]!.messages.map((message: any) => message.content).join('\n');
    // 模型请求只能看到 gist；detail 在决策之后才展开，绝不回传模型。
    expect(prompt).not.toContain(DETAIL_SECRET);
  });

  it('模型 silent：不注入 memory fragments；self/checkpoint 语义不变', async () => {
    const harness = await setup({
      checkpoint: true,
      reply: () => ({
        content: JSON.stringify({ action: 'silent', depth: 'gist', confidence: 0.9, reason: 'greeting' }),
      }),
    });
    const context = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_model_http',
      turnId: 'turn_model_silent',
      query: '今天天气怎么样',
      allowRemote: true,
      includeCheckpoint: true,
    });
    expect(context.status).toBe(200);
    expect(context.body.data.decision).toMatchObject({ action: 'silent', enforced: true });
    expect(context.body.data.decision.policyVersion).toMatch(/^model:/);
    expect(context.body.data.fragments).toEqual([]);
    expect(context.body.data.blocks.map((block: any) => block.kind)).toEqual(['checkpoint']);
    expect(context.body.data.blocks[0].content).toContain(CHECKPOINT_SECRET);
    expect(context.body.data.warnings).toContain('intervention_silent');
  });

  it('模型 defer：只保留 self/checkpoint，silenceReason=intervention_defer', async () => {
    const harness = await setup({
      checkpoint: true,
      reply: () => ({
        content: JSON.stringify({ action: 'defer', depth: 'gist', confidence: 0.7, reason: 'continue_without_memory' }),
      }),
    });
    const context = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_model_http',
      turnId: 'turn_model_defer',
      query: '颜色搭配怎么样',
      allowRemote: true,
      includeCheckpoint: true,
    });
    expect(context.status).toBe(200);
    expect(context.body.data.decision).toMatchObject({ action: 'defer', reason: 'continue_without_memory' });
    expect(context.body.data.fragments).toEqual([]);
    expect(context.body.data.blocks.map((block: any) => block.kind)).toEqual(['checkpoint']);
    expect(context.body.data.warnings).toContain('intervention_defer');
  });

  it('must_speak：模型不被调用；即使模型会返回 silent 也强制 speak', async () => {
    const harness = await setup({
      reply: () => ({
        content: JSON.stringify({ action: 'silent', depth: 'gist', confidence: 0.99, reason: 'silent' }),
      }),
    });
    const context = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_model_http',
      turnId: 'turn_model_must',
      query: '你还记得我的喜好吗？',
      allowRemote: true,
    });
    expect(context.status).toBe(200);
    expect(context.body.data.decision).toMatchObject({
      action: 'speak',
      mustSpeak: true,
      enforced: true,
    });
    expect(context.body.data.decision.reason).toMatch(/^must_speak:/);
    expect(context.body.data.decision.policyVersion).toBe('v0-rules');
    expect(context.body.data.warnings).not.toContain('intervention_model_fallback');
    expect(context.body.data.fragments.length).toBeGreaterThan(0);
    expect(harness.calls).toHaveLength(0);
  });

  it('超时：超过 modelTimeoutMs 回退 heuristic + degraded + intervention_model_fallback', async () => {
    const harness = await setup({
      timeoutMs: 40,
      reply: () => ({ content: SPEAK_GIST, delayMs: 300 }),
    });
    const started = Date.now();
    const context = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_model_http',
      turnId: 'turn_model_timeout',
      query: '深色主题',
      allowRemote: true,
    });
    const took = Date.now() - started;
    expect(context.status).toBe(200);
    expect(took).toBeLessThan(260);
    expect(context.body.data.decision).toMatchObject({ action: 'speak', degraded: true });
    expect(context.body.data.decision.policyVersion).toMatch(/^heuristic:/);
    expect(context.body.data.warnings).toEqual(expect.arrayContaining([
      'intervention_model_fallback',
      'model_timeout',
    ]));
    // 请求超时预算被传给 gateway（单次不重试）。
    expect(harness.calls[0]?.max_tokens).toBe(256);

    // 持续失败会让 provider / /status 降级，而不是每轮静默白等。
    const status = await fetch(`${harness.server.url}/status`, { headers: auth() });
    const statusBody = await status.json() as any;
    expect(statusBody.data.model).toMatchObject({
      degraded: true,
      reason: 'model_timeout',
    });
    expect(harness.runtime.degraded).toBe(true);
  });

  it.each([
    ['非法 action', JSON.stringify({ action: 'shout', depth: 'gist', confidence: 0.8, reason: 'x' })],
    ['非法 depth', JSON.stringify({ action: 'speak', depth: 'deep', confidence: 0.8, reason: 'x' })],
    ['非法 confidence', JSON.stringify({ action: 'speak', depth: 'gist', confidence: 1.5, reason: 'x' })],
    ['非法 JSON', '{not-json'],
  ])('%s → 回退 heuristic，不抛到主流程', async (_label, content) => {
    const harness = await setup({ reply: () => ({ content }) });
    const context = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_model_http',
      turnId: 'turn_model_invalid',
      query: '深色主题',
      allowRemote: true,
    });
    expect(context.status).toBe(200);
    expect(context.body.data.decision.action).toBe('speak');
    expect(context.body.data.decision.degraded).toBe(true);
    expect(context.body.data.decision.policyVersion).toMatch(/^heuristic:/);
    expect(context.body.data.warnings).toContain('intervention_model_fallback');
    expect(context.body.data.fragments.length).toBeGreaterThan(0);
  });

  it('remote_not_allowed：没有 allowRemote 时不把正文发给远端，回退 heuristic', async () => {
    const harness = await setup({ reply: () => ({ content: SPEAK_GIST }) });
    const context = await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_model_http',
      turnId: 'turn_model_remote',
      query: '深色主题',
      allowRemote: false,
    });
    expect(context.status).toBe(200);
    expect(context.body.data.decision.policyVersion).toMatch(/^heuristic:/);
    expect(context.body.data.warnings).toEqual(expect.arrayContaining([
      'intervention_model_fallback',
      'remote_not_allowed',
    ]));
    expect(harness.calls).toHaveLength(0);
  });

  it('Phase 4：model 决策后 /status.policy 可读，reset 清空统计并保留可用状态', async () => {
    const harness = await setup({ reply: () => ({ content: SPEAK_GIST }) });
    await post(`${harness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_model_http',
      turnId: 'turn_model_policy',
      query: '深色主题',
      allowRemote: true,
    });
    const before = await harness.runtime.policyStore!.snapshot();
    expect(before.global.spoken).toBeGreaterThan(0);

    const status = await fetch(`${harness.server.url}/status`, { headers: auth() });
    const statusBody = await status.json() as any;
    expect(statusBody.data.policy).toEqual({ degraded: false, lastError: null });

    const reset = await post(`${harness.server.url}/intervention/reset`, {});
    expect(reset.status).toBe(200);
    expect(reset.body.data).toMatchObject({ reset: true, policyVersion: 'v0-rules' });
    const after = await harness.runtime.policyStore!.snapshot();
    expect(after.global).toMatchObject({ spoken: 0, silent: 0 });
    expect(after.domains).toEqual([]);
  });
});
