// RuntimeService 模型接入：来源选择、回退、provenance、host pending、compact/context 可选模型。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { MemoryService } from '../../src/memory/MemoryService.js';
import {
  RuntimeService,
  createRuntimeModelRuntime,
  normalizeRuntimeSettings,
  type RuntimeModelExtractionResult,
  type RuntimeModelProbe,
  type RuntimeModelQueryPlanResult,
  type RuntimeModelRuntime,
  type RuntimeModelSummaryResult,
} from '../../src/runtime/index.js';
import type { ChatFetch, ChatFetchResponse } from '../../src/inference/gateway.js';

const SECRET = 'sk-integration-secret-never-log';

let dir: string;
let app: Mebular;
let memory: MemoryService;
let now: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mebular-model-runtime-'));
  now = Date.UTC(2026, 9, 29, 12, 0, 0);
  const master = await new IdentityManager().generateUserMasterKey();
  app = new Mebular({
    storagePath: join(dir, 'device.jsonl'),
    deviceId: 'device-model',
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    sync: { autoSync: false },
  });
  await app.initialize();
  memory = new MemoryService(app);
});

afterEach(async () => {
  await app.shutdown().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

function localProbe(overrides: Partial<RuntimeModelProbe['local']> = {}): RuntimeModelProbe['local'] {
  return {
    configured: false,
    available: false,
    model: null,
    pack: null,
    reason: 'local_not_configured',
    warnings: [],
    ...overrides,
  };
}

function apiProbe(overrides: Partial<RuntimeModelProbe['api']> = {}): RuntimeModelProbe['api'] {
  return {
    configured: false,
    available: false,
    allowRemote: false,
    baseUrlConfigured: false,
    model: null,
    credential: { configured: false, source: null },
    reason: 'api_not_configured',
    warnings: [],
    ...overrides,
  };
}

interface FakeModelOptions {
  local?: Partial<RuntimeModelProbe['local']>;
  api?: Partial<RuntimeModelProbe['api']>;
  extraction?: RuntimeModelExtractionResult;
  summary?: RuntimeModelSummaryResult;
  plan?: RuntimeModelQueryPlanResult;
}

function fakeModel(options: FakeModelOptions = {}): RuntimeModelRuntime & {
  calls: { probe: number; extract: number; summarize: number; planQuery: number; dispose: number; sources: string[] };
} {
  const calls = {
    probe: 0,
    extract: 0,
    summarize: 0,
    planQuery: 0,
    dispose: 0,
    sources: [] as string[],
  };
  const probe = async (): Promise<RuntimeModelProbe> => {
    calls.probe += 1;
    return {
      local: localProbe(options.local),
      api: apiProbe(options.api),
    };
  };
  return {
    calls,
    probe,
    async extractCandidates(request) {
      calls.extract += 1;
      calls.sources.push(request.source);
      return options.extraction ?? {
        ok: false,
        candidates: [],
        extractor: request.source,
        degraded: true,
        reason: 'model_unavailable',
        warnings: ['model_unavailable'],
        latencyMs: 0,
      };
    },
    async summarize() {
      calls.summarize += 1;
      return options.summary ?? {
        ok: false,
        degraded: true,
        reason: 'model_unavailable',
        warnings: ['model_unavailable'],
        latencyMs: 0,
      };
    },
    async planQuery() {
      calls.planQuery += 1;
      return options.plan ?? {
        ok: false,
        degraded: true,
        reason: 'model_unavailable',
        warnings: ['model_unavailable'],
        latencyMs: 0,
      };
    },
    async dispose() {
      calls.dispose += 1;
    },
  };
}

function runtimeWith(runtime: unknown, modelRuntime: RuntimeModelRuntime): RuntimeService {
  return new RuntimeService(app, {
    mode: 'immersive',
    memoryService: memory,
    runtimeDir: join(dir, 'runtime'),
    hostKey: 'home-model',
    agentId: 'opencode',
    runtime,
    modelRuntime,
    now: () => now,
  });
}

function jsonResponse(content: string, status = 200, headers: Record<string, string> = {}): ChatFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    async text() {
      return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
    },
  };
}

function apiSettings(overrides: Record<string, unknown> = {}) {
  return normalizeRuntimeSettings({
    model: {
      source: 'api',
      api: {
        baseUrl: 'https://api.example.test/v1',
        model: 'test-model',
        keyRef: 'env:TEST_RUNTIME_KEY',
        allowRemote: true,
        timeoutMs: 30,
        ...overrides,
      },
    },
  }).model;
}

function realApiModel(fetchImpl: ChatFetch, overrides: Record<string, unknown> = {}): RuntimeModelRuntime {
  return createRuntimeModelRuntime(apiSettings(overrides), {
    env: { TEST_RUNTIME_KEY: SECRET },
    fetch: fetchImpl,
    sleep: async () => undefined,
  });
}

function validCandidates(): string {
  return JSON.stringify({
    candidates: [
      {
        kind: 'preference',
        data: { entity: 'user', preferenceType: 'theme', value: 'dark', confidence: 0.9 },
        namespace: 'notes',
      },
    ],
  });
}

function countFetch(fetchImpl: ChatFetch): { fetch: ChatFetch; calls: number } {
  const tracker = {
    calls: 0,
    fetch: (async (url: string, init: Parameters<ChatFetch>[1]) => {
      tracker.calls += 1;
      return fetchImpl(url, init);
    }) as ChatFetch,
  };
  return tracker;
}

function apiRuntimeSettings(overrides: Record<string, unknown> = {}) {
  return {
    model: {
      source: 'api',
      api: {
        baseUrl: 'https://api.example.test/v1',
        model: 'test-model',
        keyRef: 'env:TEST_RUNTIME_KEY',
        allowRemote: true,
        timeoutMs: 30,
        ...overrides,
      },
    },
  };
}

describe('RuntimeService 模型来源', () => {
  it('默认 heuristic：不调用模型，provenance=heuristic，status 明确', async () => {
    const model = fakeModel();
    const runtime = runtimeWith({ capture: 'local' }, model);

    const result = await runtime.ingest({
      requestId: 'req_model_heuristic',
      agentId: 'opencode',
      threadId: 'th_model',
      namespace: 'notes',
      capture: 'local',
      chunks: [{ role: 'user', text: '以后默认用深色主题' }],
    });

    expect(result.degraded).toBe(false);
    expect(result.extraction).toMatchObject({ status: 'completed', extractor: 'heuristic', degraded: false });
    expect(result.records).toHaveLength(1);
    expect(result.rawChunkIds).toHaveLength(1);
    expect(model.calls.extract).toBe(0);

    const node = await app.graph.getNode(result.records[0]!.id);
    expect((node?.metadata as Record<string, unknown>).runtime).toMatchObject({
      provenance: { extractor: 'heuristic', source: 'runtime' },
    });
    const status = await runtime.status();
    expect(status.model).toMatchObject({
      configured: 'heuristic',
      active: 'heuristic',
      degraded: false,
      reason: null,
      warnings: [],
    });
    expect(status.warnings).not.toContain('runtime_model_degraded');
  });

  it('local 失败：raw 已落本地，heuristic 回退并记录 degraded provenance', async () => {
    const model = fakeModel({
      local: {
        configured: true,
        available: true,
        model: 'local-model',
        pack: 'test-pack',
      },
      extraction: {
        ok: false,
        candidates: [],
        extractor: 'local',
        degraded: true,
        reason: 'model_local_not_found',
        warnings: ['model_local_not_found', 'model_unavailable'],
        latencyMs: 1,
      },
    });
    const runtime = runtimeWith({
      capture: 'local',
      model: { source: 'local', local: { pack: 'test-pack' } },
    }, model);

    const result = await runtime.ingest({
      requestId: 'req_model_local_fail',
      agentId: 'opencode',
      threadId: 'th_model',
      namespace: 'notes',
      capture: 'local',
      chunks: [{ role: 'user', text: '以后默认用深色主题' }],
    });

    expect(result.degraded).toBe(true);
    expect(result.rawChunkIds).toHaveLength(1);
    expect(result.records).toHaveLength(1);
    expect(result.extraction).toMatchObject({ extractor: 'heuristic', degraded: true });
    expect(result.warnings).toEqual(expect.arrayContaining(['model_local_not_found', 'model_unavailable']));

    const node = await app.graph.getNode(result.records[0]!.id);
    expect((node?.metadata as Record<string, unknown>).runtime).toMatchObject({
      provenance: { extractor: 'heuristic', degraded: true },
    });

    const status = await runtime.status();
    expect(status.model).toMatchObject({
      configured: 'local',
      active: 'heuristic',
      degraded: true,
      reason: 'model_local_not_found',
    });
    expect(status.model.warnings).toEqual(expect.arrayContaining(['model_local_not_found', 'model_unavailable']));
    expect(status.warnings).toEqual(expect.arrayContaining(['runtime_model_degraded', 'model_unavailable']));
    expect((await runtime.localStats())?.rawChunks).toBe(1);
  });

  it('auto：local 已配置但失败时回退 heuristic，不自动调用 api', async () => {
    const model = fakeModel({
      local: {
        configured: true,
        available: false,
        model: null,
        pack: 'test-pack',
        reason: 'model_not_found',
        warnings: ['model_local_not_found'],
      },
      api: {
        configured: true,
        available: true,
        allowRemote: true,
        baseUrlConfigured: true,
        model: 'remote-model',
        credential: { configured: true, source: 'env' },
      },
      extraction: {
        ok: true,
        candidates: [{ kind: 'fact', data: { subject: 'user', predicate: 'remote', object: 'should-not-run' } }],
        extractor: 'api',
        model: 'remote-model',
        degraded: false,
        warnings: [],
        latencyMs: 1,
      },
    });
    const runtime = runtimeWith({
      model: {
        source: 'auto',
        api: {
          baseUrl: 'https://api.example.test/v1',
          model: 'remote-model',
          keyRef: 'env:TEST_RUNTIME_KEY',
          allowRemote: true,
        },
      },
    }, model);

    const result = await runtime.ingest({
      requestId: 'req_model_auto',
      agentId: 'opencode',
      threadId: 'th_model',
      namespace: 'notes',
      capture: 'off',
      allowRemote: true,
      chunks: [{ role: 'user', text: '以后默认用深色主题' }],
    });

    expect(model.calls.extract).toBe(0);
    expect(model.calls.sources).toEqual([]);
    expect(result.extraction).toMatchObject({ extractor: 'heuristic', degraded: true });
    expect(result.warnings).toEqual(expect.arrayContaining(['model_local_not_found', 'model_unavailable']));
    expect(result.records.some((record) => record.kind === 'fact')).toBe(false);
  });

  it('api：请求未 allowRemote 时不发起网络，直接 heuristic', async () => {
    const fake = countFetch(async () => jsonResponse(validCandidates()));
    const model = realApiModel(fake.fetch);
    const runtime = runtimeWith(apiRuntimeSettings(), model);

    const result = await runtime.ingest({
      requestId: 'req_model_api_consent',
      agentId: 'opencode',
      threadId: 'th_model',
      namespace: 'notes',
      capture: 'off',
      extractor: 'auto',
      allowRemote: false,
      chunks: [{ role: 'user', text: '以后默认用深色主题' }],
    });

    expect(fake.calls).toBe(0);
    expect(result.extraction).toMatchObject({ extractor: 'heuristic', degraded: true });
    expect(result.warnings).toEqual(expect.arrayContaining(['remote_not_allowed', 'model_unavailable']));
  });

  it('api 成功：记录 extractor/model/provenance，status 显示 active=api，不泄漏密钥', async () => {
    const fake = countFetch(async () => jsonResponse(validCandidates()));
    const model = realApiModel(fake.fetch);
    const runtime = runtimeWith({ ...apiRuntimeSettings(), capture: 'local' }, model);

    const result = await runtime.ingest({
      requestId: 'req_model_api_ok',
      agentId: 'opencode',
      threadId: 'th_model',
      namespace: 'notes',
      capture: 'local',
      extractor: 'api',
      allowRemote: true,
      chunks: [{ role: 'user', text: '以后默认用深色主题' }],
    });

    expect(fake.calls).toBe(1);
    expect(result.degraded).toBe(false);
    expect(result.extraction).toMatchObject({
      status: 'completed',
      extractor: 'api',
      model: 'test-model',
      degraded: false,
    });
    expect(result.records).toHaveLength(1);
    expect(result.rawChunkIds).toHaveLength(1);

    const node = await app.graph.getNode(result.records[0]!.id);
    expect((node?.metadata as Record<string, unknown>).runtime).toMatchObject({
      provenance: { extractor: 'api', model: 'test-model' },
    });
    const status = await runtime.status();
    expect(status.model).toMatchObject({
      configured: 'api',
      active: 'api',
      degraded: false,
      credential: { configured: true, source: 'env' },
    });
    expect(JSON.stringify({ result, status })).not.toContain(SECRET);
  });

  it('api 5xx：回退 heuristic，raw 不丢，warning 不含响应体/密钥', async () => {
    const fake = countFetch(async () => jsonResponse('upstream-body-should-not-leak', 503));
    const model = realApiModel(fake.fetch);
    const runtime = runtimeWith({ ...apiRuntimeSettings(), capture: 'local' }, model);

    const result = await runtime.ingest({
      requestId: 'req_model_api_fail',
      agentId: 'opencode',
      threadId: 'th_model',
      namespace: 'notes',
      capture: 'local',
      extractor: 'api',
      allowRemote: true,
      chunks: [{ role: 'user', text: '以后默认用深色主题' }],
    });

    expect(fake.calls).toBe(2);
    expect(result.degraded).toBe(true);
    expect(result.rawChunkIds).toHaveLength(1);
    expect(result.records).toHaveLength(1);
    expect(result.extraction).toMatchObject({ extractor: 'heuristic', degraded: true });
    expect(result.warnings).toEqual(expect.arrayContaining(['model_http_error:503', 'model_unavailable']));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('upstream-body-should-not-leak');
  });

  it('模型输出不合 schema：不直接写图，回退 heuristic', async () => {
    const fake = countFetch(async () => jsonResponse(JSON.stringify({
      candidates: [{
        kind: 'fact',
        data: { subject: 'user', predicate: 'x', object: 'y' },
        command: 'rm -rf /',
      }],
    })));
    const model = realApiModel(fake.fetch);
    const runtime = runtimeWith(apiRuntimeSettings(), model);

    const result = await runtime.ingest({
      requestId: 'req_model_bad_output',
      agentId: 'opencode',
      threadId: 'th_model',
      namespace: 'notes',
      capture: 'off',
      extractor: 'api',
      allowRemote: true,
      chunks: [{ role: 'user', text: '以后默认用深色主题' }],
    });

    expect(result.degraded).toBe(true);
    expect(result.extraction).toMatchObject({ extractor: 'heuristic', degraded: true });
    expect(result.warnings).toEqual(expect.arrayContaining(['model_schema_mismatch', 'model_unavailable']));
    expect(result.records).toHaveLength(1);
    const node = await app.graph.getNode(result.records[0]!.id);
    expect(JSON.stringify(node)).not.toContain('rm -rf /');
  });

  it('模型输出保留 namespace：拒绝写图，回退 heuristic', async () => {
    const fake = countFetch(async () => jsonResponse(JSON.stringify({
      candidates: [{
        kind: 'fact',
        data: { subject: 'user', predicate: 'x', object: 'y' },
        namespace: '__self__',
      }],
    })));
    const model = realApiModel(fake.fetch);
    const runtime = runtimeWith(apiRuntimeSettings(), model);

    const result = await runtime.ingest({
      requestId: 'req_model_reserved_output',
      agentId: 'opencode',
      threadId: 'th_model',
      namespace: 'notes',
      capture: 'off',
      extractor: 'api',
      allowRemote: true,
      chunks: [{ role: 'user', text: '以后默认用深色主题' }],
    });

    expect(result.degraded).toBe(true);
    expect(result.extraction).toMatchObject({ extractor: 'heuristic', degraded: true });
    expect(result.warnings).toEqual(expect.arrayContaining(['model_invalid_candidates', 'model_unavailable']));
    expect(result.records).toHaveLength(1);
    const selfNodes = await app.graph.listNodes({ namespace: '__self__' });
    expect(selfNodes).toHaveLength(0);
  });

  it('host：无候选 pending，不调用模型；宿主提交后 status active=host', async () => {
    const model = fakeModel();
    const runtime = runtimeWith({ model: { source: 'host' } }, model);

    const pending = await runtime.ingest({
      requestId: 'req_model_host_pending',
      agentId: 'opencode',
      threadId: 'th_model',
      namespace: 'notes',
      capture: 'off',
      extractor: 'auto',
      chunks: [{ role: 'user', text: '等待宿主候选' }],
    });
    expect(pending.extraction).toMatchObject({ status: 'pending', extractor: 'host', degraded: false });
    expect(pending.records).toEqual([]);
    expect(pending.degraded).toBe(false);
    expect(model.calls.extract).toBe(0);

    const before = await runtime.status();
    expect(before.model).toMatchObject({
      configured: 'host',
      active: 'heuristic',
      degraded: true,
      reason: 'host_candidates_missing',
    });
    expect(before.model.warnings).toContain('host_candidates_missing');

    const completed = await runtime.ingest({
      requestId: 'req_model_host_done',
      agentId: 'opencode',
      threadId: 'th_model',
      namespace: 'notes',
      capture: 'off',
      extractor: 'host',
      candidates: [
        { kind: 'fact', data: { subject: 'user', predicate: 'editor', object: 'Neovim' }, namespace: 'notes' },
      ],
    });
    expect(completed.extraction).toMatchObject({ status: 'completed', extractor: 'host', degraded: false });
    expect(model.calls.extract).toBe(0);

    const after = await runtime.status();
    expect(after.model).toMatchObject({ configured: 'host', active: 'host', degraded: false });
  });
});

describe('RuntimeService 可选模型（compact/context）', () => {
  it('mcp 轻量模式不调用模型，context 仍走 heuristic 读路径', async () => {
    await memory.write([
      { type: 'fact', content: '项目使用 Neovim', metadata: { namespace: 'notes' } },
    ]);
    const model = fakeModel({
      local: { configured: true, available: true, model: 'local-model', pack: 'test-pack' },
      plan: {
        ok: true,
        query: 'expanded',
        model: 'local-model',
        degraded: false,
        warnings: [],
        latencyMs: 1,
      },
    });
    const runtime = new RuntimeService(app, {
      mode: 'mcp',
      memoryService: memory,
      runtimeDir: join(dir, 'runtime'),
      hostKey: 'home-model',
      agentId: 'opencode',
      runtime: { model: { source: 'local' } },
      modelRuntime: model,
      now: () => now,
    });

    const context = await runtime.context({
      agentId: 'opencode',
      query: 'Neovim',
      namespaces: ['notes'],
      tokenBudget: 2000,
    });
    expect(model.calls.planQuery).toBe(0);
    expect(model.calls.extract).toBe(0);
    expect(context.blocks.some((block) => block.kind === 'memory')).toBe(true);
  });


  it('compact 使用模型摘要；失败时保留确定性摘要', async () => {
    await memory.write([
      { type: 'fact', content: '项目使用 TypeScript', metadata: { namespace: 'notes' } },
      { type: 'fact', content: '项目使用 Node.js', metadata: { namespace: 'work' } },
    ]);

    const success = fakeModel({
      local: { configured: true, available: true, model: 'local-model', pack: 'test-pack' },
      summary: {
        ok: true,
        summary: '模型生成的摘要',
        model: 'local-model',
        degraded: false,
        warnings: [],
        latencyMs: 1,
      },
    });
    const runtime = runtimeWith({ model: { source: 'local' } }, success);
    const compact = await runtime.compact({ namespace: 'notes' });
    expect(compact.degraded).toBe(false);
    expect(compact.warnings).toEqual([]);
    const view = await runtime.getCompact(compact.compactId!);
    expect(view?.summary).toBe('模型生成的摘要');

    const fallback = fakeModel({
      local: { configured: true, available: true, model: 'local-model', pack: 'test-pack' },
      summary: {
        ok: false,
        degraded: true,
        reason: 'model_timeout',
        warnings: ['model_timeout', 'model_unavailable'],
        latencyMs: 1,
      },
    });
    const runtimeFallback = runtimeWith({ model: { source: 'local' } }, fallback);
    const compactFallback = await runtimeFallback.compact({ namespace: 'work' });
    expect(compactFallback.degraded).toBe(true);
    expect(compactFallback.warnings).toEqual(expect.arrayContaining([
      'model_timeout',
      'model_unavailable',
      'compact_fallback_heuristic',
    ]));
    const fallbackView = await runtimeFallback.getCompact(compactFallback.compactId!);
    expect(fallbackView?.summary).toContain('Node.js');
  });

  it('context 查询规划成功时使用扩展词；失败时保留原 query 并降级', async () => {
    await memory.write([
      { type: 'fact', content: '项目使用 Neovim', metadata: { namespace: 'notes' } },
    ]);

    const success = fakeModel({
      local: { configured: true, available: true, model: 'local-model', pack: 'test-pack' },
      plan: {
        ok: true,
        query: 'Neovim',
        model: 'local-model',
        degraded: false,
        warnings: [],
        latencyMs: 1,
      },
    });
    const runtime = runtimeWith({ model: { source: 'local' } }, success);
    const context = await runtime.context({
      agentId: 'opencode',
      query: 'zzz-no-hit',
      namespaces: ['notes'],
      tokenBudget: 2000,
    });
    expect(success.calls.planQuery).toBe(1);
    expect(context.blocks.some((block) => block.kind === 'memory')).toBe(true);
    expect(context.degraded).toBe(false);
    const trace = await runtime.getTrace(context.traceId!);
    expect(trace?.model.query).toBe('local');

    const failure = fakeModel({
      local: { configured: true, available: true, model: 'local-model', pack: 'test-pack' },
      plan: {
        ok: false,
        degraded: true,
        reason: 'model_timeout',
        warnings: ['model_timeout', 'model_unavailable'],
        latencyMs: 1,
      },
    });
    const runtimeFailure = runtimeWith({ model: { source: 'local' } }, failure);
    const failed = await runtimeFailure.context({
      agentId: 'opencode',
      query: 'Neovim',
      namespaces: ['notes'],
      tokenBudget: 2000,
    });
    expect(failure.calls.planQuery).toBe(1);
    expect(failed.degraded).toBe(true);
    expect(failed.warnings).toEqual(expect.arrayContaining([
      'model_timeout',
      'model_unavailable',
      'query_plan_fallback_heuristic',
    ]));
    expect(failed.blocks.some((block) => block.kind === 'memory')).toBe(true);
  });
});
