// `/status` / `/version` 的模型字段：configured/active/degraded/reason/warnings/credential。
// credential 只显示来源，不泄漏密钥。

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
  createSidecarModelRuntime,
  type SidecarModelRuntime,
} from '../../src/sidecar/model.js';
import { SidecarServer } from '../../src/sidecar/server.js';
import { SettlementRuntime } from '../../src/sidecar/settlement.js';
import type { ChatFetch, ChatFetchResponse } from '../../src/inference/gateway.js';
import { startFakeCapability, type FakeCapabilityServer } from './fake-capability.js';

const SECRET = 'sk-status-secret-never-log';
const NOW = 1_760_000_000_000;

interface Harness {
  home: string;
  fake: FakeCapabilityServer;
  runtime: SettlementRuntime;
  model: SidecarModelRuntime;
  server: SidecarServer;
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

async function setup(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-sidecar-model-http-'));
  const local = new SidecarLocalLayer({ root: join(home, 'memory-runtime'), now: () => NOW });
  await local.init();
  const fake = await startFakeCapability();
  const client = new CapabilityClient({ baseUrl: fake.baseUrl, token: 'cap-token', retries: 0, retryDelayMs: 0 });
  const config: SidecarConfig = defaultSidecarConfig();
  config.http.port = 0;
  config.model = normalizeSidecarConfig({
    model: {
      source: 'api',
      api: {
        baseUrl: 'https://api.example.test/v1',
        model: 'test-model',
        keyRef: 'env:TEST_STATUS_KEY',
        allowRemote: true,
        timeoutMs: 50,
      },
    },
  }).model;
  const fetchImpl: ChatFetch = async () => jsonResponse(JSON.stringify({ candidates: [] }));
  const model = createSidecarModelRuntime(config.model, {
    homeDir: home,
    env: { TEST_STATUS_KEY: SECRET },
    fetch: fetchImpl,
    now: () => NOW,
  });
  const identity = { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' };
  const runtime = new SettlementRuntime({
    config,
    local,
    client,
    identity,
    autoStartReplayer: false,
    modelRuntime: model,
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
    getDegraded: () => runtime.degraded,
    now: () => NOW,
  });
  await server.listen();
  const harness = { home, fake, runtime, model, server };
  harnesses.push(harness);
  return harness;
}

function auth(): Record<string, string> {
  return { authorization: 'Bearer host-token' };
}

describe('sidecar model status/version', () => {
  it('GET /status 显示 configured/active/degraded/reason/warnings/credential 且不含密钥', async () => {
    const { server } = await setup();
    const response = await fetch(`${server.url}/status`, { headers: auth() });
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.data.model).toMatchObject({
      configured: 'api',
      active: 'api',
      degraded: false,
      reason: null,
      warnings: [],
      credential: { configured: true, source: 'env' },
    });
    expect(body.data.model.sources).toEqual(expect.arrayContaining(['heuristic', 'host', 'api']));
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('GET /version 显示同一模型状态与动态 sources', async () => {
    const { server } = await setup();
    const response = await fetch(`${server.url}/version`, { headers: auth() });
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.data.model).toMatchObject({
      configured: 'api',
      active: 'api',
      degraded: false,
      credential: { configured: true, source: 'env' },
    });
    expect(body.data.capabilities.models).toEqual(expect.arrayContaining(['heuristic', 'host', 'api']));
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });
});
