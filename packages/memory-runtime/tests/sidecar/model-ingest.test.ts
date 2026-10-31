// Sidecar ingest 的模型来源接入：heuristic/local/api/host/auto。
//
// fake capability + fake gateway/engine；不启动真实模型或网络。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityClient } from '../../src/sidecar/capability-client.js';
import {
  defaultSidecarConfig,
  normalizeSidecarConfig,
  type SidecarConfig,
  type InferenceSettings,
} from '../../src/sidecar/config.js';
import { defaultSidecarPolicy } from '../../src/sidecar/domains.js';
import { IngestService } from '../../src/sidecar/ingest.js';
import { SidecarLocalLayer } from '../../src/sidecar/local-layer.js';
import {
  createSidecarInferenceProvider,
  type InferenceEngineFacade,
  type SidecarInferenceProvider,
} from '../../src/sidecar/inference-provider.js';
import type { ChatFetch, ChatFetchResponse } from '../../src/inference/gateway.js';
import type { LlamaServerEngineOptions } from '../../src/inference/engine.js';
import { startFakeCapability, type FakeCapabilityServer } from './fake-capability.js';

const SECRET = 'sk-ingest-secret-never-log';
const NOW = 1_760_000_000_000;

interface Harness {
  home: string;
  local: SidecarLocalLayer;
  fake: FakeCapabilityServer;
  model: SidecarInferenceProvider;
  service: IngestService;
  config: SidecarConfig;
}

const harnesses: Harness[] = [];
const runtimes: SidecarInferenceProvider[] = [];
const extraDirs: string[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.fake.close();
    await rm(harness.home, { recursive: true, force: true });
  }
  for (const runtime of runtimes.splice(0)) await runtime.dispose().catch(() => undefined);
  for (const dir of extraDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function settings(overrides: Record<string, unknown>): InferenceSettings {
  return normalizeSidecarConfig({
    model: {
      source: 'heuristic',
      ...overrides,
    },
  }).model;
}

function configWith(model: InferenceSettings): SidecarConfig {
  const config = defaultSidecarConfig();
  config.model = model;
  config.http.port = 0;
  return config;
}

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

function fakeEngine(connection: { baseUrl: string; apiKey: string; modelId?: string }): (
  options: LlamaServerEngineOptions,
) => InferenceEngineFacade {
  return () => ({
    async acquire() {
      return connection;
    },
    getStatus() {
      return { state: 'running' };
    },
    async stop() {},
  });
}

async function setup(
  model: InferenceSettings,
  options: {
    fetch?: ChatFetch;
    createEngine?: (options: LlamaServerEngineOptions) => InferenceEngineFacade;
    modelPath?: string;
  } = {},
): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-sidecar-model-ingest-'));
  const local = new SidecarLocalLayer({ root: join(home, 'memory-runtime'), now: () => NOW });
  await local.init();
  const fake = await startFakeCapability();
  const client = new CapabilityClient({
    baseUrl: fake.baseUrl,
    token: 'cap-token',
    retries: 0,
    retryDelayMs: 0,
  });
  const config = configWith(model);
  const inference = createSidecarInferenceProvider(model, {
    homeDir: home,
    modelsDir: join(home, 'memory-runtime', 'models'),
    env: { TEST_SIDECAR_KEY: SECRET },
    sleep: async () => undefined,
    retryDelayMs: 0,
    now: () => NOW,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.createEngine ? { createEngine: options.createEngine } : {}),
  });
  runtimes.push(inference);
  const service = new IngestService({
    config,
    local,
    client,
    identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
    policy: defaultSidecarPolicy(),
    inference,
    now: () => NOW,
  });
  await service.init();
  const harness = { home, local, fake, model: inference, service, config };
  harnesses.push(harness);
  return harness;
}

function preferenceRequest(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'opencode',
    threadId: 'th_model',
    chunks: [{ role: 'user', text: '以后默认用深色主题', messageId: 'm1', chunkIndex: 0 }],
    ...overrides,
  };
}

function validCandidates(): string {
  return JSON.stringify({
    candidates: [
      {
        kind: 'preference',
        data: { entity: 'user', preferenceType: 'theme', value: 'dark', confidence: 0.95 },
      },
    ],
  });
}

describe('sidecar ingest model sources', () => {
  it('默认 heuristic：不调用模型，Raw 保留，provenance=heuristic', async () => {
    const { service, fake, model } = await setup(settings({ source: 'heuristic' }));
    const result = await service.ingest(preferenceRequest());

    expect(result.status).toBe(200);
    expect(result.data.extraction).toMatchObject({
      status: 'completed',
      extractor: 'heuristic',
      degraded: false,
    });
    expect(result.data.detailIds).toHaveLength(1);
    expect(result.data.records).toHaveLength(1);
    const item = (fake.writeRequests[0]!.body.items as any[])[0];
    expect(item.provenance).toMatchObject({ extractor: 'heuristic', model: null, source: 'runtime' });
    expect((await model.status()).active).toBe('heuristic');
  });

  it('host：无候选返回 202 pending；宿主回填后使用候选并显示 active=host', async () => {
    const { service, fake, model, local } = await setup(settings({ source: 'host' }));

    const pending = await service.ingest(preferenceRequest({ extractor: 'auto' }));
    expect(pending.status).toBe(202);
    expect(pending.data).toMatchObject({
      queued: false,
      degraded: false,
      accepted: { chunks: 1, records: 0 },
    });
    expect(pending.data.extraction).toMatchObject({ status: 'pending', extractor: 'host' });
    expect(pending.data.stagingChunkIds).toHaveLength(1);
    expect(await local.store.countStagingChunks({ cloudId: 'cl_test', agentId: 'opencode', threadId: 'th_model' })).toBe(1);
    expect(fake.writeRequests).toHaveLength(0);

    const before = await model.status();
    expect(before).toMatchObject({
      configured: 'host',
      active: 'heuristic',
      degraded: true,
      reason: 'host_candidates_missing',
    });

    const completed = await service.ingest(preferenceRequest({
      requestId: 'req_host_completed',
      extractor: 'host',
      candidates: [
        {
          kind: 'preference',
          content: { entity: 'user', preferenceType: 'theme', value: 'dark' },
        },
      ],
    }));
    expect(completed.status).toBe(200);
    expect(completed.data.extraction).toMatchObject({
      status: 'completed',
      extractor: 'host',
      model: 'host-provided',
      degraded: false,
    });
    expect(fake.writeRequests[0]!.body.items[0].provenance).toMatchObject({
      source: 'host',
      extractor: 'host',
      model: 'host-provided',
    });
    expect(await model.status()).toMatchObject({ configured: 'host', active: 'host', degraded: false });
  });

  it('local 未安装：Raw 不丢，回退 heuristic 并记录 degraded provenance', async () => {
    const { service, fake, model } = await setup(settings({
      source: 'local',
      local: { pack: 'missing-pack', threads: 2 },
    }));
    const result = await service.ingest(preferenceRequest());

    expect(result.status).toBe(200);
    expect(result.data.degraded).toBe(true);
    expect(result.data.detailIds).toHaveLength(1);
    expect(result.data.records).toHaveLength(1);
    expect(result.data.extraction).toMatchObject({ extractor: 'heuristic', degraded: true });
    expect(result.data.warnings).toEqual(expect.arrayContaining(['model_local_not_found', 'model_unavailable']));
    const item = (fake.writeRequests[0]!.body.items as any[])[0];
    expect(item.provenance).toMatchObject({ extractor: 'heuristic', model: null });
    expect(await model.status()).toMatchObject({
      configured: 'local',
      active: 'heuristic',
      degraded: true,
      reason: 'model_not_found',
    });
  });

  it('local 成功：使用 engine/gateway，provenance=local，status=active=local', async () => {
    const extra = await mkdtemp(join(tmpdir(), 'mebular-sidecar-model-local-'));
    extraDirs.push(extra);
    const modelPath = join(extra, 'qwen.gguf');
    await writeFile(modelPath, 'gguf-test', { mode: 0o600 });
    const tracker = countFetch(async () => jsonResponse(validCandidates()));
    const { service, fake } = await setup(settings({
      source: 'local',
      local: { path: modelPath, threads: 2 },
    }), {
      fetch: tracker.fetch,
      createEngine: fakeEngine({
        baseUrl: 'http://127.0.0.1:9999/v1',
        apiKey: 'local-engine-token',
        modelId: 'local-test',
      }),
    });

    const result = await service.ingest(preferenceRequest());
    expect(result.data).toMatchObject({ degraded: false });
    expect(result.data.extraction).toMatchObject({
      extractor: 'local',
      model: 'local-test',
      degraded: false,
    });
    const item = (fake.writeRequests[0]!.body.items as any[])[0];
    expect(item.provenance).toMatchObject({ source: 'runtime', extractor: 'local', model: 'local-test' });
    expect(JSON.stringify(result)).not.toContain('local-engine-token');
  });

  it('api 成功：显式 allowRemote、记录 extractor/model、密钥不泄漏', async () => {
    const tracker = countFetch(async () => jsonResponse(validCandidates()));
    const { service, fake, model } = await setup(settings({
      source: 'api',
      api: {
        baseUrl: 'https://api.example.test/v1',
        model: 'test-model',
        keyRef: 'env:TEST_SIDECAR_KEY',
        allowRemote: true,
        timeoutMs: 50,
      },
    }), { fetch: tracker.fetch });

    const result = await service.ingest(preferenceRequest({
      extractor: 'api',
      allowRemote: true,
    }));

    expect(tracker.calls).toBe(1);
    expect(result.data.degraded).toBe(false);
    expect(result.data.detailIds).toHaveLength(1);
    expect(result.data.extraction).toMatchObject({
      extractor: 'api',
      model: 'test-model',
      degraded: false,
    });
    const item = (fake.writeRequests[0]!.body.items as any[])[0];
    expect(item.provenance).toMatchObject({ extractor: 'api', model: 'test-model' });
    const status = await model.status();
    expect(status).toMatchObject({
      configured: 'api',
      active: 'api',
      degraded: false,
      credential: { configured: true, source: 'env' },
    });
    expect(JSON.stringify({ result, status })).not.toContain(SECRET);
  });

  it('api 5xx：重试一次后回退 heuristic，Raw 保留且响应体/密钥不泄漏', async () => {
    const tracker = countFetch(async () => jsonResponse('upstream-body-should-not-leak', 503));
    const { service, fake, model } = await setup(settings({
      source: 'api',
      api: {
        baseUrl: 'https://api.example.test/v1',
        model: 'test-model',
        keyRef: 'env:TEST_SIDECAR_KEY',
        allowRemote: true,
        timeoutMs: 50,
      },
    }), { fetch: tracker.fetch });

    const result = await service.ingest(preferenceRequest({
      extractor: 'api',
      allowRemote: true,
    }));

    expect(tracker.calls).toBe(2);
    expect(result.data.degraded).toBe(true);
    expect(result.data.detailIds).toHaveLength(1);
    expect(result.data.records).toHaveLength(1);
    expect(result.data.extraction).toMatchObject({ extractor: 'heuristic', degraded: true });
    expect(result.data.warnings).toEqual(expect.arrayContaining(['model_http_error:503', 'model_unavailable']));
    const item = (fake.writeRequests[0]!.body.items as any[])[0];
    expect(item.provenance).toMatchObject({ extractor: 'heuristic', model: null });
    const serialized = JSON.stringify({ result, nodes: fake.nodes, status: await model.status() });
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('upstream-body-should-not-leak');
  });

  it('模型输出不可信：域非法时不直接写图，回退 heuristic', async () => {
    const tracker = countFetch(async () => jsonResponse(JSON.stringify({
      candidates: [
        {
          kind: 'fact',
          data: { subject: 'user', predicate: 'x', object: 'model-output-should-not-write' },
          namespace: '__self__',
        },
      ],
    })));
    const { service, fake } = await setup(settings({
      source: 'api',
      api: {
        baseUrl: 'https://api.example.test/v1',
        model: 'test-model',
        keyRef: 'env:TEST_SIDECAR_KEY',
        allowRemote: true,
        timeoutMs: 50,
      },
    }), { fetch: tracker.fetch });

    const result = await service.ingest(preferenceRequest({
      extractor: 'api',
      allowRemote: true,
    }));

    expect(result.data.degraded).toBe(true);
    expect(result.data.extraction).toMatchObject({ extractor: 'heuristic', degraded: true });
    expect(result.data.warnings).toEqual(expect.arrayContaining(['model_invalid_candidates', 'model_unavailable']));
    expect(fake.nodes.every((node) => !node.domain.startsWith('__'))).toBe(true);
    expect(JSON.stringify(fake.nodes)).not.toContain('model-output-should-not-write');
  });

  it('auto：local 已配置但失败时回退 heuristic，不自动调用 api', async () => {
    const tracker = countFetch(async () => jsonResponse(validCandidates()));
    const { service, model } = await setup(settings({
      source: 'auto',
      local: { pack: 'missing-pack', threads: 2 },
      api: {
        baseUrl: 'https://api.example.test/v1',
        model: 'remote-model',
        keyRef: 'env:TEST_SIDECAR_KEY',
        allowRemote: true,
        timeoutMs: 50,
      },
    }), { fetch: tracker.fetch });

    const result = await service.ingest(preferenceRequest({
      extractor: 'auto',
      allowRemote: true,
    }));

    expect(tracker.calls).toBe(0);
    expect(result.data.degraded).toBe(true);
    expect(result.data.extraction).toMatchObject({ extractor: 'heuristic', degraded: true });
    expect(result.data.warnings).toEqual(expect.arrayContaining(['model_local_not_found', 'model_unavailable']));
    expect(result.data.warnings).not.toContain('model_http_error:503');
    expect(await model.status()).toMatchObject({
      configured: 'auto',
      active: 'heuristic',
      degraded: true,
      reason: 'model_not_found',
    });
  });
});
