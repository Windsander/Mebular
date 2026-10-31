// Sidecar inference host API：安装任务、模型状态、激活/停用、引擎控制与错误信封。

import { afterEach, describe, expect, it } from '@jest/globals';
import { defaultSidecarConfig } from '../../src/sidecar/config.js';
import { SidecarServer, type SidecarStatusSnapshot } from '../../src/sidecar/server.js';
import { CURATED_MODEL_PACKS } from '../../src/inference/catalog.js';
import {
  InferenceError,
  type ModelActivationView,
  type ModelCatalogView,
  type ModelEngineActionView,
  type InferenceEngineView,
  type ModelInstallJob,
  type ModelRemoveView,
  type InferenceApi,
  type InferenceCapabilities,
  type InferenceSettingsView,
  type InferenceStatusView,
  type ModelStatusView,
  type UpdateInferenceSettingsInput,
} from '../../src/sidecar/inference/types.js';

const TEST_PACK = CURATED_MODEL_PACKS.find((pack) => pack.tier === 'light') ?? CURATED_MODEL_PACKS[0]!;
const PACK_ID = TEST_PACK.packId;
const MODEL_ID = TEST_PACK.modelId;

const servers: SidecarServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function job(state: ModelInstallJob['state'] = 'downloading'): ModelInstallJob {
  return {
    schema: 1,
    jobId: 'job_http',
    packId: PACK_ID,
    modelId: MODEL_ID,
    state,
    phase: state === 'completed' ? 'engine' : 'model',
    progress: state === 'completed' ? 1 : 0.5,
    downloadedBytes: 50,
    totalBytes: 100,
    speedBytesPerSecond: 10,
    etaMs: 5000,
    startedAt: 1000,
    updatedAt: 2000,
    completedAt: state === 'completed' ? 2000 : null,
    error: null,
    warnings: [],
  };
}

function engine(): InferenceEngineView {
  return {
    state: 'stopped',
    health: 'unknown',
    packId: null,
    modelId: null,
    crashCount: 0,
    restartCount: 0,
    lastError: null,
    installed: true,
    release: 'b12017',
    platform: 'darwin',
    arch: 'arm64',
    binaryReady: true,
    reason: null,
  };
}

function catalog(): ModelCatalogView {
  return {
    hardware: null,
    recommended: null,
    packs: [{
      packId: PACK_ID,
      modelId: MODEL_ID,
      displayName: 'Qwen 4B',
      description: '',
      tier: 'light',
      quantization: 'Q4_K_M',
      contextLength: 32768,
      estimatedDownloadBytes: 100,
      requirements: {
        platforms: ['darwin'],
        architectures: null,
        minMemoryBytes: 1,
        recommendedMemoryBytes: 2,
        minDiskBytes: 1,
        gpu: 'optional',
      },
      state: 'installed',
      installed: true,
      installedBytes: 100,
      expectedBytes: 100,
      verifiedAt: 1000,
      manifest: { available: true, error: null },
      supported: true,
      active: false,
      install: null,
      warnings: [],
    }],
    active: { source: 'heuristic', packId: null, modelId: null, engine: engine() },
    providers: [],
    install: null,
    engine: {
      state: 'installed',
      installed: true,
      release: 'b12017',
      platform: 'darwin',
      arch: 'arm64',
      asset: 'llama-b12017-bin-macos-arm64.tar.gz',
      binaryReady: true,
      reason: null,
      progress: 1,
      installedAt: 1000,
      verifiedAt: 1000,
      supported: true,
    },
    warnings: [],
  };
}

function statusView(): ModelStatusView {
  return {
    packId: PACK_ID,
    modelId: MODEL_ID,
    displayName: 'Qwen 4B',
    state: 'installed',
    installed: true,
    installedBytes: 100,
    expectedBytes: 100,
    verified: true,
    verifiedAt: 1000,
    manifest: { available: true, error: null },
    supported: true,
    active: false,
    install: null,
    engine: engine(),
    warnings: [],
  };
}

class FakeModelApi implements InferenceApi {
  readonly calls: string[] = [];
  failInstall: Error | null = null;

  capabilities(): InferenceCapabilities {
    return { install: true, activate: true, catalog: true, engine: true };
  }

  async listModels(): Promise<ModelCatalogView> {
    this.calls.push('list');
    return catalog();
  }

  async getModelStatus(packId: string): Promise<ModelStatusView | null> {
    this.calls.push(`status:${packId}`);
    return packId === PACK_ID ? statusView() : null;
  }

  async install(packId: string): Promise<ModelInstallJob> {
    this.calls.push(`install:${packId}`);
    if (this.failInstall) throw this.failInstall;
    return job();
  }

  async getInstall(jobId: string): Promise<ModelInstallJob | null> {
    this.calls.push(`install-get:${jobId}`);
    return jobId === 'job_http' ? job() : null;
  }

  async cancelInstall(jobId: string): Promise<ModelInstallJob> {
    this.calls.push(`install-cancel:${jobId}`);
    return job('cancelled');
  }

  async activate(packId: string): Promise<ModelActivationView> {
    this.calls.push(`activate:${packId}`);
    return {
      activated: true,
      active: 'local',
      packId,
      modelId: MODEL_ID,
      reason: null,
      warnings: [],
      engine: { ...engine(), state: 'running', health: 'ok', packId },
      restartRequired: false,
    };
  }

  async deactivate(packId: string): Promise<ModelActivationView> {
    this.calls.push(`deactivate:${packId}`);
    return {
      activated: false,
      active: 'heuristic',
      packId,
      modelId: MODEL_ID,
      reason: null,
      warnings: [],
      engine: engine(),
      restartRequired: false,
    };
  }

  async startEngine(packId: string): Promise<ModelEngineActionView> {
    this.calls.push(`start:${packId}`);
    return { packId, started: true, stopped: false, reason: null, warnings: [], engine: { ...engine(), state: 'running' } };
  }

  async stopEngine(packId: string): Promise<ModelEngineActionView> {
    this.calls.push(`stop:${packId}`);
    return { packId, started: false, stopped: true, reason: null, warnings: [], engine: engine() };
  }

  async removeModel(packId: string): Promise<ModelRemoveView> {
    this.calls.push(`remove:${packId}`);
    return { packId, removed: true, wasActive: false, warnings: [] };
  }

  async status(): Promise<InferenceStatusView> {
    this.calls.push('runtime-status');
    return {
      active: { source: 'heuristic', packId: null, modelId: null, engine: engine() },
      engine: engine(),
      install: job(),
      recommended: null,
      installedPackIds: [PACK_ID],
      warnings: [],
    };
  }

  async settings(): Promise<InferenceSettingsView> {
    this.calls.push('settings');
    return { ...await this.status(), config: { source: 'heuristic' }, providers: [] };
  }

  async updateSettings(input: UpdateInferenceSettingsInput): Promise<InferenceSettingsView> {
    this.calls.push(`settings-update:${input.source}`);
    const source = (input as { source: string }).source;
    if (source === 'local') {
      throw new InferenceError('pack_required', 'local 来源必须通过模型包激活设置', { status: 400 });
    }
    if (!['heuristic', 'host', 'api', 'auto'].includes(source)) {
      throw new InferenceError('invalid_request', 'source 必须是 heuristic/host/api/auto', { status: 400 });
    }
    return {
      ...await this.status(),
      config: { source: input.source },
      active: { ...(await this.status()).active, source: input.source },
      providers: [],
    };
  }

  async dispose(): Promise<void> {}
}

function snapshot(api: FakeModelApi): Promise<SidecarStatusSnapshot> {
  return api.status().then((models) => ({
    mode: 'immersive',
    identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
    capability: { reachable: true, version: 1, lastOkAt: 1000, error: null },
    model: { configured: 'heuristic', active: 'heuristic', degraded: false, reason: null },
    counts: {
      stagingChunks: 0,
      localStagingChunks: 0,
      traces: 0,
      cachedRecords: 0,
      detailCacheEntries: 0,
      detailCacheBytes: 0,
      outbox: 0,
      deadLetter: 0,
      localTraces: 0,
      ingested: 0,
      settled: 0,
    },
    details: {
      available: true,
      staging: { chunks: 0, hours: 24, maxBytes: 268435456 },
      cache: { entries: 0, bytes: 0, days: 30, maxBytes: 268435456 },
      outbox: { items: 0, bytes: 0 },
      quota: { bytesPerDomain: 268435456, bytesCloud: 1073741824, usedBytes: null, bytes: null },
      retentionDays: { conversation: 30, tool_output: 7, document_slice: 90 },
    },
    outbox: { items: 0, bytes: 0, oldestAt: null },
    limits: { maxChunkBytes: 262144, maxContextTokens: 12000, maxRecall: 50 },
    warnings: [],
    lastError: null,
    inference: models,
  }));
}

async function startServer(api: FakeModelApi): Promise<SidecarServer> {
  const config = defaultSidecarConfig();
  config.http.port = 0;
  const server = new SidecarServer({
    config,
    hostToken: 'host-token',
    identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
    getStatus: () => snapshot(api),
    inference: api,
  });
  await server.listen();
  servers.push(server);
  return server;
}

function auth(): Record<string, string> {
  return { authorization: 'Bearer host-token' };
}

async function post(url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...auth(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

describe('sidecar model runtime HTTP', () => {
  it('模型端点沿用 host token/loopback/统一信封，/version 暴露结构化 models capability', async () => {
    const api = new FakeModelApi();
    const server = await startServer(api);

    const noAuth = await fetch(`${server.url}/models`);
    expect(noAuth.status).toBe(401);
    expect((await noAuth.json() as any).error.code).toBe('unauthorized');

    const models = await fetch(`${server.url}/models`, { headers: auth() });
    const modelsBody = await models.json() as any;
    expect(models.status).toBe(200);
    expect(modelsBody.ok).toBe(true);
    expect(modelsBody.data.packs[0].packId).toBe(PACK_ID);
    expect(modelsBody.data.engine).toMatchObject({
      installed: true,
      release: 'b12017',
      platform: 'darwin',
      arch: 'arm64',
      binaryReady: true,
      reason: null,
    });
    expect(JSON.stringify(modelsBody)).not.toContain('host-token');

    const version = await fetch(`${server.url}/version`, { headers: auth() });
    const versionBody = await version.json() as any;
    expect(versionBody.data.capabilities.models).toMatchObject({
      install: true,
      activate: true,
      catalog: true,
    });
    expect(versionBody.data.capabilities.inference).toMatchObject({ engine: true });

    const status = await fetch(`${server.url}/status`, { headers: auth() });
    const statusBody = await status.json() as any;
    expect(statusBody.data.inference).toMatchObject({
      installedPackIds: [PACK_ID],
      install: { jobId: 'job_http', phase: 'model' },
      engine: { installed: true, binaryReady: true, release: 'b12017' },
    });
  });

  it('inference 设置端点：GET 返回来源/引擎/安装/推荐，POST 热切换且拒绝 local', async () => {
    const api = new FakeModelApi();
    const server = await startServer(api);

    const settings = await fetch(`${server.url}/inference`, { headers: auth() });
    const settingsBody = await settings.json() as any;
    expect(settings.status).toBe(200);
    expect(settingsBody.data).toMatchObject({
      config: { source: 'heuristic' },
      active: { source: 'heuristic', packId: null },
      engine: { state: 'stopped' },
      install: { jobId: 'job_http' },
      recommended: null,
      installedPackIds: [PACK_ID],
    });
    expect(JSON.stringify(settingsBody)).not.toContain('host-token');
    expect(JSON.stringify(settingsBody)).not.toContain('/secret');

    const updated = await post(`${server.url}/inference/settings`, { source: 'host' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.config.source).toBe('host');
    expect(api.calls).toContain('settings-update:host');

    const local = await post(`${server.url}/inference/settings`, { source: 'local' });
    expect(local.status).toBe(400);
    expect(local.body).toMatchObject({
      ok: false,
      error: { code: 'pack_required' },
    });

    const invalid = await post(`${server.url}/inference/settings`, { source: 'nope' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('invalid_request');
  });

  it('安装任务：202 + jobId、查询进度、取消与未知任务 404', async () => {
    const api = new FakeModelApi();
    const server = await startServer(api);

    const install = await post(`${server.url}/models/${PACK_ID}/install`);
    expect(install.status).toBe(202);
    expect(install.body.data).toMatchObject({ jobId: 'job_http', state: 'downloading' });

    const fetched = await fetch(`${server.url}/installs/job_http`, { headers: auth() });
    const fetchedBody = await fetched.json() as any;
    expect(fetched.status).toBe(200);
    expect(fetchedBody.data).toMatchObject({ downloadedBytes: 50, totalBytes: 100 });
    expect(JSON.stringify(fetchedBody)).not.toContain('/secret');

    const cancelled = await post(`${server.url}/installs/job_http/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.state).toBe('cancelled');

    const missing = await fetch(`${server.url}/installs/nope`, { headers: auth() });
    expect(missing.status).toBe(404);
    expect((await missing.json() as any).error.code).toBe('install_not_found');
  });

  it('模型状态/激活/停用/start/stop/remove 路由与状态码', async () => {
    const api = new FakeModelApi();
    const server = await startServer(api);

    const status = await fetch(`${server.url}/models/${PACK_ID}/status`, { headers: auth() });
    expect(status.status).toBe(200);
    expect((await status.json() as any).data.active).toBe(false);
    expect((await fetch(`${server.url}/models/unknown/status`, { headers: auth() })).status).toBe(404);

    const activate = await post(`${server.url}/models/${PACK_ID}/activate`);
    expect(activate.status).toBe(200);
    expect(activate.body.data).toMatchObject({ activated: true, active: 'local', restartRequired: false });

    const deactivate = await post(`${server.url}/models/${PACK_ID}/deactivate`);
    expect(deactivate.body.data).toMatchObject({ active: 'heuristic' });

    const start = await post(`${server.url}/models/${PACK_ID}/start`);
    expect(start.body.data.started).toBe(true);
    const stop = await post(`${server.url}/models/${PACK_ID}/stop`);
    expect(stop.body.data.stopped).toBe(true);
    const remove = await post(`${server.url}/models/${PACK_ID}/remove`);
    expect(remove.body.data.removed).toBe(true);

    expect(api.calls).toEqual(expect.arrayContaining([
      `status:${PACK_ID}`,
      `activate:${PACK_ID}`,
      `deactivate:${PACK_ID}`,
      `start:${PACK_ID}`,
      `stop:${PACK_ID}`,
      `remove:${PACK_ID}`,
    ]));
  });

  it('安装失败返回结构化错误码而不是 500/自由文本', async () => {
    const api = new FakeModelApi();
    api.failInstall = new InferenceError('manifest_missing', '模型包缺少完整 manifest', {
      status: 409,
      details: { packId: PACK_ID },
    });
    const server = await startServer(api);
    const response = await post(`${server.url}/models/${PACK_ID}/install`);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'manifest_missing', message: '模型包缺少完整 manifest' },
    });
  });
});
