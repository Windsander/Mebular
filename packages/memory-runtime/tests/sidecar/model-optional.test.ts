// 可选模型：recall/query plan 与 compact 摘要。
//
// 失败时保留原 query / 确定性摘要；模型只影响增强路径，不阻塞主流程。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityClient } from '../../src/sidecar/capability-client.js';
import {
  defaultSidecarConfig,
  normalizeSidecarConfig,
  type SidecarConfig,
} from '../../src/sidecar/config.js';
import { defaultSidecarPolicy } from '../../src/sidecar/domains.js';
import { MemoryObjectService } from '../../src/sidecar/internal-objects.js';
import { SidecarLocalLayer } from '../../src/sidecar/local-layer.js';
import {
  createSidecarModelRuntime,
  type SidecarModelEngine,
  type SidecarModelRuntime,
} from '../../src/sidecar/model.js';
import { RecallService } from '../../src/sidecar/recall.js';
import type { ChatFetch, ChatFetchResponse } from '../../src/inference/gateway.js';
import {
  startFakeCapability,
  type FakeCapabilityServer,
  type FakeMemoryRecord,
} from './fake-capability.js';

const NOW = 1_760_000_000_000;

interface Harness {
  home: string;
  local: SidecarLocalLayer;
  fake: FakeCapabilityServer;
  client: CapabilityClient;
  model: SidecarModelRuntime;
  config: SidecarConfig;
}

const harnesses: Harness[] = [];
const runtimes: SidecarModelRuntime[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.fake.close();
    await rm(harness.home, { recursive: true, force: true });
  }
  for (const runtime of runtimes.splice(0)) await runtime.dispose().catch(() => undefined);
});

function completion(content: string, status = 200): ChatFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() {
      return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
    },
  };
}

function modelFetch(options: {
  keywords?: string[];
  summary?: string;
  fail?: number;
}): ChatFetch {
  return async (_url, init) => {
    const body = JSON.parse(init.body) as {
      messages?: Array<{ content?: string }>;
    };
    const system = body.messages?.[0]?.content ?? '';
    if (options.fail) return completion('upstream-body-should-not-leak', options.fail);
    if (system.includes('memory search query')) {
      return completion(JSON.stringify({ keywords: options.keywords ?? ['sidecar'] }));
    }
    if (system.includes('You summarize memory records')) {
      return completion(JSON.stringify({ summary: options.summary ?? '模型生成的摘要' }));
    }
    return completion(JSON.stringify({ candidates: [] }));
  };
}

function modelSettings(path: string) {
  return normalizeSidecarConfig({
    model: {
      source: 'local',
      local: { path, threads: 2 },
    },
    recall: { queryPlan: 'model' },
  }).model;
}

function fakeEngine(): () => SidecarModelEngine {
  return () => ({
    async acquire() {
      return {
        baseUrl: 'http://127.0.0.1:9999/v1',
        apiKey: 'engine-token',
        modelId: 'local-test',
      };
    },
    getStatus() {
      return { state: 'running' };
    },
    async stop() {},
  });
}

async function setup(options: { fetch: ChatFetch; mutateConfig?: (config: SidecarConfig) => void }): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-sidecar-optional-model-'));
  const modelPath = join(home, 'qwen.gguf');
  await writeFile(modelPath, 'gguf-test', { mode: 0o600 });
  const local = new SidecarLocalLayer({ root: join(home, 'memory-runtime'), now: () => NOW });
  await local.init();
  const fake = await startFakeCapability();
  const client = new CapabilityClient({ baseUrl: fake.baseUrl, token: 'cap-token', retries: 0, retryDelayMs: 0 });
  const config = defaultSidecarConfig();
  config.model = modelSettings(modelPath);
  options.mutateConfig?.(config);
  const model = createSidecarModelRuntime(config.model, {
    homeDir: home,
    modelsDir: join(home, 'memory-runtime', 'models'),
    fetch: options.fetch,
    createEngine: fakeEngine(),
    sleep: async () => undefined,
    retryDelayMs: 0,
    now: () => NOW,
  });
  runtimes.push(model);
  const harness = { home, local, fake, client, model, config };
  harnesses.push(harness);
  return harness;
}

function record(id: string, content: string): FakeMemoryRecord {
  return {
    id,
    type: 'fact',
    kind: 'fact',
    domain: 'agent:opencode',
    namespace: 'agent:opencode',
    ownerType: 'agent',
    ownerId: 'opencode',
    content: { subject: '项目', predicate: '使用', object: content },
    text: `项目 使用 ${content}`,
    tags: [],
    provenance: { source: 'runtime', writerType: 'agent', extractor: 'heuristic', version: '0.3.0' },
    validFrom: NOW - 86_400_000,
    validTo: null,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    detailAvailable: true,
    legacy: false,
  };
}

describe('optional model integration', () => {
  it('recall query plan 成功时用扩展检索词；trace 记录 query=local', async () => {
    const { fake, client, local, model, config } = await setup({
      fetch: modelFetch({ keywords: ['sidecar'] }),
      mutateConfig: (cfg) => { cfg.recall.queryPlan = 'model'; },
    });
    fake.setRecords([record('01JMODEL1', 'Neovim')]);
    const service = new RecallService({
      config,
      local,
      client,
      identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test', deviceId: 'device-local' },
      policy: defaultSidecarPolicy(),
      modelRuntime: model,
      now: () => NOW,
    });

    const result = await service.handleRecall({
      agentId: 'opencode',
      threadId: 'th_model',
      query: '项目 Neovim',
      domains: ['agent:opencode'],
      turnKind: 'human',
      allowRemote: true,
      tokenBudget: 1000,
    });
    expect(result.data.degraded).toBe(false);
    const queryRequest = fake.requests.find((request) => request.path === '/internal/memory/v1/query');
    expect(queryRequest?.body.query).toContain('sidecar');
    expect(result.data.fragments.length).toBeGreaterThan(0);
    expect(result.data.traceId).toBeTruthy();
    const trace = await service.getTrace(result.data.traceId!);
    expect(trace?.model).toMatchObject({ query: 'local' });
  });

  it('recall query plan 失败：保留原 query，degraded 可见但不阻塞召回', async () => {
    const { fake, client, local, model, config } = await setup({
      fetch: modelFetch({ fail: 503 }),
      mutateConfig: (cfg) => { cfg.recall.queryPlan = 'model'; },
    });
    fake.setRecords([record('01JMODEL2', 'Neovim')]);
    const service = new RecallService({
      config,
      local,
      client,
      identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test', deviceId: 'device-local' },
      policy: defaultSidecarPolicy(),
      modelRuntime: model,
      now: () => NOW,
    });

    const result = await service.handleRecall({
      agentId: 'opencode',
      threadId: 'th_model',
      query: '项目 Neovim',
      domains: ['agent:opencode'],
      turnKind: 'human',
      allowRemote: true,
      tokenBudget: 1000,
    });
    expect(result.data.degraded).toBe(true);
    expect(result.data.warnings).toEqual(expect.arrayContaining([
      'model_http_error:503',
      'model_unavailable',
      'query_plan_fallback_heuristic',
    ]));
    const queryRequest = fake.requests.find((request) => request.path === '/internal/memory/v1/query');
    expect(queryRequest?.body.query).toBe('项目 Neovim');
    expect(result.data.fragments.length).toBeGreaterThan(0);
  });

  it('compact 使用模型摘要；provenance/model 记录来源', async () => {
    const { fake, client, local, model, config } = await setup({
      fetch: modelFetch({ summary: '模型生成的摘要' }),
    });
    fake.setRecords([
      record('01JSRC1', 'TypeScript'),
      record('01JSRC2', 'Node.js'),
    ]);
    const objects = new MemoryObjectService({
      config,
      local,
      client,
      identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
      policy: defaultSidecarPolicy(),
      modelRuntime: model,
      now: () => NOW,
    });

    const result = await objects.handleCompact({
      agentId: 'opencode',
      domain: 'agent:opencode',
      strategy: 'summary',
      allowRemote: true,
    });
    expect(result.status).toBe(200);
    expect((result.data as any).summary).toBe('模型生成的摘要');
    expect(result.degraded).toBe(false);
    const request = fake.requests.find((entry) => entry.path === '/internal/memory/v1/internal-object'
      && entry.body?.kind === 'compact' && entry.body?.op === 'upsert');
    expect(request?.body.model).toMatchObject({ extractor: 'local', model: 'local-test' });
    expect(request?.body.provenance).toMatchObject({ extractor: 'local', model: 'local-test' });
  });

  it('compact 模型失败：保留确定性摘要，不丢源记录', async () => {
    const { fake, client, local, model, config } = await setup({
      fetch: modelFetch({ fail: 503 }),
    });
    fake.setRecords([
      record('01JSRC1', 'TypeScript'),
      record('01JSRC2', 'Node.js'),
    ]);
    const objects = new MemoryObjectService({
      config,
      local,
      client,
      identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
      policy: defaultSidecarPolicy(),
      modelRuntime: model,
      now: () => NOW,
    });

    const result = await objects.handleCompact({
      agentId: 'opencode',
      domain: 'agent:opencode',
      strategy: 'summary',
      allowRemote: true,
    });
    expect(result.status).toBe(200);
    expect(result.degraded).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      'model_http_error:503',
      'model_unavailable',
      'compact_fallback_heuristic',
    ]));
    expect((result.data as any).summary).toContain('TypeScript');
    expect((result.data as any).summary).toContain('Node.js');
    expect(fake.compacts).toHaveLength(1);
    const request = fake.requests.find((entry) => entry.path === '/internal/memory/v1/internal-object'
      && entry.body?.kind === 'compact' && entry.body?.op === 'upsert');
    expect(request?.body.model).toMatchObject({ extractor: 'heuristic', model: 'heuristic' });
  });
});
