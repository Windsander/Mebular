// Runtime 模型源原语：api 的 schema/超时/重试/熔断/回退，local 的已安装包/引擎失败。
// 不访问真实网络，不启动真实模型。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRuntimeModelRuntime,
  normalizeRuntimeSettings,
  type RuntimeModelEngine,
  type RuntimeModelEngineConnection,
  type RuntimeModelRuntime,
} from '../../src/runtime/index.js';
import type { ChatFetch, ChatFetchResponse } from '../../src/inference/gateway.js';

const SECRET = 'sk-runtime-secret-never-log';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mebular-model-source-'));
  tempDirs.push(dir);
  return dir;
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
        timeoutMs: 20,
        ...overrides,
      },
    },
  }).model;
}

function localSettings(overrides: Record<string, unknown> = {}) {
  return normalizeRuntimeSettings({
    model: {
      source: 'local',
      local: { pack: 'test-pack-q4', ...overrides },
    },
  }).model;
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

function fetchSequence(responses: ChatFetchResponse[]): {
  fetch: ChatFetch;
  calls: Array<{ url: string; init: Parameters<ChatFetch>[1] }>;
} {
  let index = 0;
  const calls: Array<{ url: string; init: Parameters<ChatFetch>[1] }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (!response) throw new Error('no fake response');
      return response;
    },
  };
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

function candidateRequest(source: 'api' | 'local', allowRemote = true) {
  return {
    source,
    chunks: [{ role: 'user', text: '以后默认用深色主题' }],
    namespace: 'notes',
    agentId: 'opencode',
    allowRemote,
  };
}

function fakeEngine(
  connection: RuntimeModelEngineConnection = {
    baseUrl: 'http://127.0.0.1:12345/v1',
    apiKey: 'engine-secret',
    modelId: 'local-model',
  },
  options: { fail?: boolean } = {},
): RuntimeModelEngine & { calls: { acquire: number; stop: number } } {
  const calls = { acquire: 0, stop: 0 };
  return {
    calls,
    async acquire() {
      calls.acquire += 1;
      if (options.fail) throw new Error('engine failed');
      return connection;
    },
    getStatus() {
      return { state: options.fail ? 'crashed' : 'running' } as { state: 'crashed' | 'running' };
    },
    async stop() {
      calls.stop += 1;
    },
  };
}

async function writeLocalPack(root: string, options: { manifest?: boolean } = {}): Promise<void> {
  const packDir = join(root, 'pack');
  await mkdir(packDir, { recursive: true });
  await writeFile(join(packDir, 'model.gguf'), 'fake-model-bytes');
  if (options.manifest !== false) {
    await writeFile(join(packDir, 'manifest.json'), JSON.stringify({
      schema: 1,
      modelId: 'local-test-model',
      packId: 'test-pack-q4',
      displayName: 'Local test',
      format: 'gguf',
      quantization: 'Q4_K_M',
      files: [{ path: 'model.gguf', sizeBytes: 15, sha256: 'a'.repeat(64) }],
      license: { id: 'apache-2.0' },
      requirements: {
        platforms: ['darwin', 'win32', 'linux'],
        minMemoryBytes: 1,
        recommendedMemoryBytes: 1,
        minDiskBytes: 1,
        gpu: 'optional',
      },
      context: { length: 4096 },
      runtime: { engine: 'llama-server', threads: 4 },
      source: { kind: 'local' },
    }));
  }
}

async function localRuntime(
  root: string,
  engine: RuntimeModelEngine,
  fetchImpl: ChatFetch,
): Promise<RuntimeModelRuntime> {
  return createRuntimeModelRuntime(localSettings({ path: join(root, 'pack') }), {
    runtimeDir: join(root, 'runtime'),
    createEngine: () => engine,
    fetch: fetchImpl,
    sleep: async () => undefined,
    localTimeoutMs: 50,
  });
}

describe('Runtime 模型源 · api', () => {
  it('成功：严格 JSON schema、Bearer 来自 keyRef、状态不泄漏密钥', async () => {
    const { fetch, calls } = fetchSequence([jsonResponse(validCandidates())]);
    const model = createRuntimeModelRuntime(apiSettings(), {
      env: { TEST_RUNTIME_KEY: SECRET },
      fetch,
      sleep: async () => undefined,
    });

    const result = await model.extractCandidates(candidateRequest('api'));
    expect(result).toMatchObject({ ok: true, extractor: 'api', model: 'test-model', degraded: false });
    expect(result.candidates).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.example.test/v1/chat/completions');
    expect(calls[0]!.init.headers.Authorization).toBe(`Bearer ${SECRET}`);

    const probe = await model.probe();
    expect(probe.api).toMatchObject({
      configured: true,
      available: true,
      allowRemote: true,
      credential: { configured: true, source: 'env' },
    });
    expect(JSON.stringify({ result, probe })).not.toContain(SECRET);
  });

  it('未配置 / 未允许远端：不发起 fetch，返回明确 warning', async () => {
    const unconfigured = createRuntimeModelRuntime(normalizeRuntimeSettings({
      model: { source: 'api', api: { allowRemote: false } },
    }).model, {
      env: {},
      fetch: fetchSequence([jsonResponse(validCandidates())]).fetch,
      sleep: async () => undefined,
    });
    const missing = await unconfigured.extractCandidates(candidateRequest('api'));
    expect(missing.ok).toBe(false);
    expect(missing.warnings).toEqual(expect.arrayContaining(['model_unavailable']));
    expect(missing.reason).toBe('api_not_configured');
    expect((await unconfigured.probe()).api.credential).toEqual({ configured: false, source: null });

    const denied = fetchSequence([jsonResponse(validCandidates())]);
    const model = createRuntimeModelRuntime(apiSettings({ allowRemote: false }), {
      env: { TEST_RUNTIME_KEY: SECRET },
      fetch: denied.fetch,
      sleep: async () => undefined,
    });
    const result = await model.extractCandidates(candidateRequest('api'));
    expect(result.ok).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining(['remote_not_allowed', 'model_unavailable']));
    expect(denied.calls).toHaveLength(0);
  });

  it('keyRef 只接受引用：明文密钥不读取、不发起请求、不出现在状态', async () => {
    const fake = fetchSequence([jsonResponse(validCandidates())]);
    const model = createRuntimeModelRuntime(apiSettings({ keyRef: SECRET }), {
      env: {},
      fetch: fake.fetch,
      sleep: async () => undefined,
    });
    const result = await model.extractCandidates(candidateRequest('api'));
    expect(result.ok).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([
      'model_credential_invalid_ref',
      'model_unavailable',
    ]));
    expect(fake.calls).toHaveLength(0);
    const probe = await model.probe();
    expect(probe.api.credential).toEqual({ configured: false, source: null });
    expect(JSON.stringify({ result, probe })).not.toContain(SECRET);
  });

  it('请求级 allowRemote=false：即使配置允许也不发起 fetch', async () => {
    const fake = fetchSequence([jsonResponse(validCandidates())]);
    const model = createRuntimeModelRuntime(apiSettings(), {
      env: { TEST_RUNTIME_KEY: SECRET },
      fetch: fake.fetch,
      sleep: async () => undefined,
    });
    const result = await model.extractCandidates(candidateRequest('api', false));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('remote_not_allowed');
    expect(fake.calls).toHaveLength(0);
  });

  it('超时：短超时后回退结果，不包含响应体', async () => {
    const model = createRuntimeModelRuntime(apiSettings({ timeoutMs: 10 }), {
      env: { TEST_RUNTIME_KEY: SECRET },
      fetch: (() => new Promise<ChatFetchResponse>(() => undefined)) as ChatFetch,
      sleep: async () => undefined,
    });
    const result = await model.extractCandidates(candidateRequest('api'));
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining(['model_timeout', 'model_unavailable']));
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('非法 JSON / schema 不匹配：回退，不把模型文本当候选', async () => {
    const invalidJson = fetchSequence([jsonResponse('not-json')]);
    const invalidJsonModel = createRuntimeModelRuntime(apiSettings(), {
      env: { TEST_RUNTIME_KEY: SECRET },
      fetch: invalidJson.fetch,
      sleep: async () => undefined,
    });
    const invalid = await invalidJsonModel.extractCandidates(candidateRequest('api'));
    expect(invalid.ok).toBe(false);
    expect(invalid.warnings).toContain('model_invalid_json');

    const schema = fetchSequence([jsonResponse(JSON.stringify({
      candidates: [{ kind: 'fact', data: { subject: 'user' } }],
    }))]);
    const schemaModel = createRuntimeModelRuntime(apiSettings(), {
      env: { TEST_RUNTIME_KEY: SECRET },
      fetch: schema.fetch,
      sleep: async () => undefined,
    });
    const mismatch = await schemaModel.extractCandidates(candidateRequest('api'));
    expect(mismatch.ok).toBe(false);
    expect(mismatch.warnings).toContain('model_schema_mismatch');
  });

  it('429 / 5xx：最多重试一次，随后回退；429 尊重 Retry-After', async () => {
    const limited = fetchSequence([
      jsonResponse('', 429, { 'retry-after': '0' }),
      jsonResponse('', 429, { 'retry-after': '0' }),
    ]);
    const limitedModel = createRuntimeModelRuntime(apiSettings(), {
      env: { TEST_RUNTIME_KEY: SECRET },
      fetch: limited.fetch,
      sleep: async () => undefined,
    });
    const limitedResult = await limitedModel.extractCandidates(candidateRequest('api'));
    expect(limitedResult.ok).toBe(false);
    expect(limitedResult.warnings).toContain('model_rate_limited');
    expect(limited.calls).toHaveLength(2);

    const failed = fetchSequence([jsonResponse('', 503), jsonResponse('', 503)]);
    const failedModel = createRuntimeModelRuntime(apiSettings(), {
      env: { TEST_RUNTIME_KEY: SECRET },
      fetch: failed.fetch,
      sleep: async () => undefined,
    });
    const failedResult = await failedModel.extractCandidates(candidateRequest('api'));
    expect(failedResult.ok).toBe(false);
    expect(failedResult.warnings).toContain('model_http_error:503');
    expect(failed.calls).toHaveLength(2);
  });

  it('熔断：连续失败后不再发请求', async () => {
    const fake = fetchSequence([jsonResponse('', 503)]);
    const model = createRuntimeModelRuntime(apiSettings(), {
      env: { TEST_RUNTIME_KEY: SECRET },
      fetch: fake.fetch,
      sleep: async () => undefined,
    });
    for (let index = 0; index < 5; index += 1) {
      const result = await model.extractCandidates(candidateRequest('api'));
      expect(result.ok).toBe(false);
    }
    const before = fake.calls.length;
    const open = await model.extractCandidates(candidateRequest('api'));
    expect(open.ok).toBe(false);
    expect(open.warnings).toContain('model_circuit_open');
    expect(fake.calls.length).toBe(before);
  });
});

describe('Runtime 模型源 · local', () => {
  it('已安装包：经 engine 原语调用 loopback，返回模型 id 与候选', async () => {
    const root = await tempDir();
    await writeLocalPack(root);
    const engine = fakeEngine();
    const fake = fetchSequence([jsonResponse(validCandidates())]);
    const model = await localRuntime(root, engine, fake.fetch);

    const probe = await model.probe();
    expect(probe.local).toMatchObject({
      configured: true,
      available: true,
      model: 'local-test-model',
      pack: 'test-pack-q4',
    });

    const result = await model.extractCandidates(candidateRequest('local'));
    expect(result).toMatchObject({ ok: true, extractor: 'local', model: 'local-model', degraded: false });
    expect(engine.calls.acquire).toBe(1);
    expect(fake.calls[0]!.url).toBe('http://127.0.0.1:12345/v1/chat/completions');
    expect(fake.calls[0]!.init.headers.Authorization).toBe('Bearer engine-secret');
    expect(JSON.stringify(result)).not.toContain('engine-secret');

    await model.dispose();
    expect(engine.calls.stop).toBe(1);
  });

  it('未配置 / 路径不存在：显式 unavailable，不启动引擎', async () => {
    const unconfigured = createRuntimeModelRuntime(normalizeRuntimeSettings({
      model: { source: 'local' },
    }).model, { sleep: async () => undefined });
    const none = await unconfigured.probe();
    expect(none.local).toMatchObject({ configured: false, available: false, reason: 'local_not_configured' });

    const root = await tempDir();
    const engine = fakeEngine();
    const model = await localRuntime(root, engine, fetchSequence([jsonResponse(validCandidates())]).fetch);
    const result = await model.extractCandidates(candidateRequest('local'));
    expect(result.ok).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining(['model_local_not_found', 'model_unavailable']));
    expect(engine.calls.acquire).toBe(0);
  });

  it('引擎启动失败：回退结果明确，不尝试网络供应商', async () => {
    const root = await tempDir();
    await writeLocalPack(root);
    const engine = fakeEngine(undefined, { fail: true });
    const model = await localRuntime(root, engine, fetchSequence([jsonResponse(validCandidates())]).fetch);
    const probe = await model.probe();
    expect(probe.local.available).toBe(true);

    const result = await model.extractCandidates(candidateRequest('local'));
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining(['model_engine_unavailable', 'model_unavailable']));
  });
});
