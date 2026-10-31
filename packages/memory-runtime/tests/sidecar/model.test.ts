// Memory Runtime sidecar 模型层：四来源中的 heuristic/local/api 与失败回退。
//
// 用 fake fetch/engine 驱动真实 ChatCompletionGateway；不启动 llama-server、
// 不访问网络、不下载模型。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSidecarConfig, type SidecarModelSettings } from '../../src/sidecar/config.js';
import {
  createSidecarModelRuntime,
  type SidecarModelEngine,
  type SidecarModelEngineConnection,
  type SidecarModelRuntime,
  type SidecarModelRuntimeOptions,
} from '../../src/sidecar/model.js';
import type { ChatFetch, ChatFetchResponse } from '../../src/inference/gateway.js';
import type { LlamaServerEngineOptions } from '../../src/inference/engine.js';

const SECRET = 'sk-sidecar-secret-never-log';
const NOW = 1_760_000_000_000;

const dirs: string[] = [];
const runtimes: SidecarModelRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose().catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-sidecar-model-'));
  dirs.push(home);
  return home;
}

function modelSettings(overrides: Record<string, unknown>): SidecarModelSettings {
  return normalizeSidecarConfig({
    model: {
      source: 'heuristic',
      ...overrides,
    },
  }).model;
}

function apiSettings(overrides: Record<string, unknown> = {}): SidecarModelSettings {
  return modelSettings({
    source: 'api',
    api: {
      baseUrl: 'https://api.example.test/v1',
      model: 'test-model',
      keyRef: 'env:TEST_SIDECAR_KEY',
      allowRemote: true,
      timeoutMs: 50,
      ...overrides,
    },
  });
}

function localSettings(path: string, enginePath: string | null = null): SidecarModelSettings {
  return modelSettings({
    source: 'local',
    local: { path, enginePath, threads: 2 },
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

function validCandidates(): string {
  return JSON.stringify({
    candidates: [
      {
        kind: 'preference',
        data: { entity: 'user', preferenceType: 'theme', value: 'dark', confidence: 0.9 },
      },
    ],
  });
}

function countFetch(handler: ChatFetch): { fetch: ChatFetch; calls: number } {
  const tracker = {
    calls: 0,
    fetch: (async (url: string, init: Parameters<ChatFetch>[1]) => {
      tracker.calls += 1;
      return handler(url, init);
    }) as ChatFetch,
  };
  return tracker;
}

function runtime(
  settings: SidecarModelSettings,
  options: Partial<SidecarModelRuntimeOptions> & { homeDir: string },
): SidecarModelRuntime {
  const created = createSidecarModelRuntime(settings, {
    env: { TEST_SIDECAR_KEY: SECRET },
    sleep: async () => undefined,
    retryDelayMs: 0,
    now: () => NOW,
    ...options,
  });
  runtimes.push(created);
  return created;
}

function fakeEngine(
  connection: SidecarModelEngineConnection | Error,
  seen: LlamaServerEngineOptions[] = [],
): (options: LlamaServerEngineOptions) => SidecarModelEngine {
  return (options) => {
    seen.push(options);
    return {
      async acquire() {
        if (connection instanceof Error) throw connection;
        return connection;
      },
      getStatus() {
        return { state: connection instanceof Error ? 'crashed' : 'running' };
      },
      async stop() {},
    };
  };
}

describe('sidecar model runtime', () => {
  it('heuristic 始终可用且不发起模型调用', async () => {
    const home = await tempHome();
    const tracker = countFetch(async () => jsonResponse(validCandidates()));
    const model = runtime(modelSettings({ source: 'heuristic' }), { homeDir: home, fetch: tracker.fetch });

    const selection = await model.selectExtractionSource('auto', true);
    expect(selection).toMatchObject({ source: 'heuristic', degraded: false });

    const extracted = await model.extractCandidates({
      source: 'heuristic',
      chunks: [{ text: '我喜欢深色主题', role: 'user' }],
      domain: 'agent:opencode',
      agentId: 'opencode',
      allowRemote: false,
    });
    expect(extracted).toMatchObject({ ok: true, extractor: 'heuristic', degraded: false });
    expect(extracted.candidates.length).toBeGreaterThan(0);
    expect(tracker.calls).toBe(0);

    const status = await model.status();
    expect(status).toMatchObject({
      configured: 'heuristic',
      active: 'heuristic',
      degraded: false,
      reason: null,
      credential: { configured: false, source: null },
    });
  });

  it('local 使用已安装模型与注入 engine/gateway，记录 model 且不泄漏密钥', async () => {
    const home = await tempHome();
    const modelPath = join(home, 'qwen-test.gguf');
    const enginePath = join(home, 'llama-server-test');
    await writeFile(modelPath, 'gguf-test', { mode: 0o600 });
    await writeFile(enginePath, '#!/bin/sh\n', { mode: 0o700 });
    const tracker = countFetch(async (url) => {
      expect(url).toContain('127.0.0.1');
      return jsonResponse(validCandidates());
    });
    const engines: LlamaServerEngineOptions[] = [];
    const model = runtime(localSettings(modelPath, enginePath), {
      homeDir: home,
      fetch: tracker.fetch,
      createEngine: fakeEngine({
        baseUrl: 'http://127.0.0.1:9999/v1',
        apiKey: 'engine-token',
        modelId: 'local-test',
      }, engines),
    });

    const statusBefore = await model.status();
    expect(statusBefore).toMatchObject({ configured: 'local', active: 'local', degraded: false });

    const result = await model.extractCandidates({
      source: 'local',
      chunks: [{ text: '以后默认用深色主题', role: 'user' }],
      domain: 'agent:opencode',
      agentId: 'opencode',
      allowRemote: false,
    });
    expect(result).toMatchObject({
      ok: true,
      extractor: 'local',
      model: 'local-test',
      degraded: false,
    });
    expect(tracker.calls).toBe(1);
    expect(engines[0]).toMatchObject({ modelPath, binaryPath: enginePath, threads: 2 });
    expect(JSON.stringify(result)).not.toContain('engine-token');
    expect(JSON.stringify(await model.status())).not.toContain('engine-token');
  });

  it('local 未安装/路径缺失：degraded + heuristic 选择，不启动 engine、不下载', async () => {
    const home = await tempHome();
    const engines: LlamaServerEngineOptions[] = [];
    const tracker = countFetch(async () => jsonResponse(validCandidates()));
    const model = runtime(modelSettings({
      source: 'local',
      local: { pack: 'missing-pack', threads: 2 },
    }), {
      homeDir: home,
      fetch: tracker.fetch,
      createEngine: fakeEngine({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x' }, engines),
    });

    const selection = await model.selectExtractionSource('auto', false);
    expect(selection).toMatchObject({
      source: 'heuristic',
      degraded: true,
      reason: 'model_not_found',
    });
    expect(selection.warnings).toEqual(expect.arrayContaining(['model_local_not_found', 'model_unavailable']));

    const status = await model.status();
    expect(status).toMatchObject({
      configured: 'local',
      active: 'heuristic',
      degraded: true,
      reason: 'model_not_found',
    });
    expect(status.warnings).toEqual(expect.arrayContaining(['model_local_not_found', 'model_unavailable']));

    const result = await model.extractCandidates({
      source: 'local',
      chunks: [{ text: '以后默认用深色主题', role: 'user' }],
      domain: 'agent:opencode',
      agentId: 'opencode',
      allowRemote: false,
    });
    expect(result).toMatchObject({ ok: false, reason: 'model_not_found' });
    expect(engines).toHaveLength(0);
    expect(tracker.calls).toBe(0);
  });

  it('local engine 启动失败：不写状态密钥，失败原因可见', async () => {
    const home = await tempHome();
    const modelPath = join(home, 'qwen-broken.gguf');
    await writeFile(modelPath, 'gguf-test', { mode: 0o600 });
    const tracker = countFetch(async () => jsonResponse(validCandidates()));
    const model = runtime(localSettings(modelPath), {
      homeDir: home,
      fetch: tracker.fetch,
      createEngine: fakeEngine(new Error('boom')),
    });

    const result = await model.extractCandidates({
      source: 'local',
      chunks: [{ text: '以后默认用深色主题', role: 'user' }],
      domain: 'agent:opencode',
      agentId: 'opencode',
      allowRemote: false,
    });
    expect(result).toMatchObject({ ok: false, reason: 'engine_unavailable', degraded: true });
    expect(result.warnings).toEqual(expect.arrayContaining(['model_engine_unavailable', 'model_unavailable']));
    expect(tracker.calls).toBe(0);
  });

  it('api 成功：严格 schema、记录 model，status 显示 credential 但不泄漏密钥', async () => {
    const home = await tempHome();
    const tracker = countFetch(async (_url, init) => {
      expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
      return jsonResponse(validCandidates());
    });
    const model = runtime(apiSettings(), { homeDir: home, fetch: tracker.fetch });

    const result = await model.extractCandidates({
      source: 'api',
      chunks: [{ text: '以后默认用深色主题', role: 'user' }],
      domain: 'agent:opencode',
      agentId: 'opencode',
      allowRemote: true,
    });
    expect(result).toMatchObject({ ok: true, extractor: 'api', model: 'test-model', degraded: false });
    expect(tracker.calls).toBe(1);

    const status = await model.status();
    expect(status).toMatchObject({
      configured: 'api',
      active: 'api',
      degraded: false,
      credential: { configured: true, source: 'env' },
    });
    const serialized = JSON.stringify({ result, status });
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('Bearer');
  });

  it('api 未配置/未允许：不发起网络，回退原因明确', async () => {
    const home = await tempHome();
    const tracker = countFetch(async () => jsonResponse(validCandidates()));
    const model = runtime(apiSettings({ baseUrl: null, model: null, keyRef: null }), {
      homeDir: home,
      fetch: tracker.fetch,
    });
    const unconfigured = await model.extractCandidates({
      source: 'api',
      chunks: [{ text: '以后默认用深色主题', role: 'user' }],
      domain: 'agent:opencode',
      agentId: 'opencode',
      allowRemote: true,
    });
    expect(unconfigured).toMatchObject({ ok: false, reason: 'api_not_configured' });
    expect(tracker.calls).toBe(0);

    const allowed = runtime(apiSettings(), { homeDir: home, fetch: tracker.fetch });
    const notAllowed = await allowed.extractCandidates({
      source: 'api',
      chunks: [{ text: '以后默认用深色主题', role: 'user' }],
      domain: 'agent:opencode',
      agentId: 'opencode',
      allowRemote: false,
    });
    expect(notAllowed).toMatchObject({ ok: false, reason: 'remote_not_allowed', degraded: true });
    expect(notAllowed.warnings).toEqual(expect.arrayContaining(['remote_not_allowed', 'model_unavailable']));
    expect(tracker.calls).toBe(0);
  });

  it('api 超时：重试一次后回退 heuristic', async () => {
    const home = await tempHome();
    const tracker = countFetch((_url, init) => new Promise<ChatFetchResponse>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const model = runtime(apiSettings({ timeoutMs: 10 }), { homeDir: home, fetch: tracker.fetch });

    const result = await model.extractCandidates({
      source: 'api',
      chunks: [{ text: '以后默认用深色主题', role: 'user' }],
      domain: 'agent:opencode',
      agentId: 'opencode',
      allowRemote: true,
    });
    expect(result).toMatchObject({ ok: false, reason: 'model_timeout', degraded: true });
    expect(result.warnings).toEqual(expect.arrayContaining(['model_timeout', 'model_unavailable']));
    expect(tracker.calls).toBe(2);
  });

  it('api 非法 JSON / 429 / 5xx：失败回退，429/5xx 只重试一次', async () => {
    const home = await tempHome();
    const invalid = countFetch(async () => jsonResponse('not-json'));
    const invalidModel = runtime(apiSettings(), { homeDir: home, fetch: invalid.fetch });
    const invalidResult = await invalidModel.extractCandidates({
      source: 'api',
      chunks: [{ text: '以后默认用深色主题', role: 'user' }],
      domain: 'agent:opencode',
      agentId: 'opencode',
      allowRemote: true,
    });
    expect(invalidResult).toMatchObject({ ok: false, reason: 'model_invalid_json' });
    expect(invalid.calls).toBe(1);

    const rate = countFetch(async () => jsonResponse('', 429));
    const rateModel = runtime(apiSettings(), { homeDir: home, fetch: rate.fetch });
    const rateResult = await rateModel.extractCandidates({
      source: 'api',
      chunks: [{ text: '以后默认用深色主题', role: 'user' }],
      domain: 'agent:opencode',
      agentId: 'opencode',
      allowRemote: true,
    });
    expect(rateResult).toMatchObject({ ok: false, reason: 'model_rate_limited' });
    expect(rate.calls).toBe(2);

    const server = countFetch(async () => jsonResponse('upstream-body-should-not-leak', 503));
    const serverModel = runtime(apiSettings(), { homeDir: home, fetch: server.fetch });
    const serverResult = await serverModel.extractCandidates({
      source: 'api',
      chunks: [{ text: '以后默认用深色主题', role: 'user' }],
      domain: 'agent:opencode',
      agentId: 'opencode',
      allowRemote: true,
    });
    expect(serverResult).toMatchObject({ ok: false, reason: 'model_http_error:503' });
    expect(server.calls).toBe(2);
    expect(JSON.stringify(serverResult)).not.toContain('upstream-body-should-not-leak');
  });

  it('api schema 不匹配：不返回原始输出，回退 heuristic', async () => {
    const home = await tempHome();
    const tracker = countFetch(async () => jsonResponse(JSON.stringify({
      candidates: [
        {
          kind: 'fact',
          data: { subject: 'user', predicate: 'x', object: 'y' },
          command: 'rm -rf /',
        },
      ],
    })));
    const model = runtime(apiSettings(), { homeDir: home, fetch: tracker.fetch });
    const result = await model.extractCandidates({
      source: 'api',
      chunks: [{ text: '以后默认用深色主题', role: 'user' }],
      domain: 'agent:opencode',
      agentId: 'opencode',
      allowRemote: true,
    });
    expect(result).toMatchObject({ ok: false, reason: 'model_schema_mismatch', degraded: true });
    expect(JSON.stringify(result)).not.toContain('rm -rf /');
  });

  it('熔断后不再请求 endpoint，返回 model_circuit_open', async () => {
    const home = await tempHome();
    const tracker = countFetch(async () => jsonResponse('', 503));
    const model = runtime(apiSettings(), {
      homeDir: home,
      fetch: tracker.fetch,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 60_000,
    });
    const request = {
      source: 'api' as const,
      chunks: [{ text: '以后默认用深色主题', role: 'user' }],
      domain: 'agent:opencode',
      agentId: 'opencode',
      allowRemote: true,
    };

    await model.extractCandidates(request);
    await model.extractCandidates(request);
    expect(tracker.calls).toBe(4);

    const open = await model.extractCandidates(request);
    expect(open).toMatchObject({ ok: false, reason: 'circuit_open', degraded: true });
    expect(open.warnings).toContain('model_circuit_open');
    expect(tracker.calls).toBe(4);
  });
});
