// OpenChamber public runner adapter (WS-B): hermetic fake runner HTTP server.
// No real OpenChamber process or private bridge daemon is touched.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  OPENCHAMBER_RUNNER_KIND,
  OPENCHAMBER_RUNNER_SCHEMA,
  OpenChamberRunnerAgent,
  OpenChamberRunnerClient,
  readOpenChamberRunnerDiscovery,
  resolveOpenChamberRunnerDiscoveryFile,
} from '../../packages/fleet/src/index.js';
import { mkEvent } from './helpers.js';
import { reduceTaskEvents } from '../../packages/fleet/src/index.js';

type Behavior = (req: {
  auth: string | undefined;
  body: Record<string, unknown> | undefined;
  method: string | undefined;
  path: string | undefined;
}) => { status: number; json?: unknown; raw?: string; never?: boolean };

interface FakeRunner {
  port: number;
  last: {
    auth?: string;
    body?: Record<string, unknown>;
    method?: string;
    path?: string;
  };
  requests: number;
  close: () => Promise<void>;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-oc-runner-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const task = (intent: string, taskId = `oc-${intent}`) =>
  reduceTaskEvents([
    mkEvent('created', taskId, {
      to: { device: 'device-B', agent: 'openchamber' },
      intent,
      trace: { chain: [] },
    }),
  ])!;

async function startRunner(behavior: Behavior): Promise<FakeRunner> {
  const last: FakeRunner['last'] = {};
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      let body: Record<string, unknown> | undefined;
      try {
        body = data.length > 0 ? (JSON.parse(data) as Record<string, unknown>) : undefined;
      } catch {
        body = undefined;
      }
      last.auth = req.headers.authorization;
      last.body = body;
      last.method = req.method;
      last.path = req.url;
      const out = behavior({ auth: req.headers.authorization, body, method: req.method, path: req.url });
      if (out.never === true) return;
      res.statusCode = out.status;
      res.setHeader('content-type', 'application/json');
      res.end(out.json !== undefined ? JSON.stringify(out.json) : (out.raw ?? ''));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    last,
    get requests() {
      return requests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function writeDiscovery(file: string, port: number, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const record = {
    schema: OPENCHAMBER_RUNNER_SCHEMA,
    kind: OPENCHAMBER_RUNNER_KIND,
    pid: process.pid,
    port,
    host: '127.0.0.1',
    token: 'runner-token',
    version: '0.3.0',
    startedAt: now,
    updatedAt: now,
    ...overrides,
  };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(record), { mode: 0o600 });
  return record;
}

describe('OpenChamberRunnerAgent（公开 runner HTTP）', () => {
  it('descriptor：openchamber/http/可取消/fresh session', () => {
    const agent = new OpenChamberRunnerAgent({ discoveryFile: join(dir, 'missing.json') });
    expect(agent.descriptor).toMatchObject({
      kind: 'openchamber',
      executionMode: 'http',
      supportsCancel: true,
      sessionMode: 'fresh',
    });
  });

  it('成功：Bearer token、title=fleet taskId、请求不含 sessionId、结果映射', async () => {
    const runner = await startRunner(() => ({
      status: 200,
      json: { ok: true, result: { sessionId: 'ses-1', text: 'RUNNER_OK', ms: 7 } },
    }));
    const discoveryFile = join(dir, 'openchamber-runner.json');
    await writeDiscovery(discoveryFile, runner.port);
    const agent = new OpenChamberRunnerAgent({ discoveryFile });
    try {
      expect(await agent.execute(task('do work', 'task-42'))).toEqual({
        ok: true,
        reason: 'session:ses-1',
        resultRef: 'RUNNER_OK',
      });
      expect(runner.last.auth).toBe('Bearer runner-token');
      expect(runner.last.method).toBe('POST');
      expect(runner.last.path).toBe('/v1/run-once');
      expect(runner.last.body).toMatchObject({ prompt: 'do work', title: 'fleet task-42', timeoutSec: 600 });
      expect(Object.prototype.hasOwnProperty.call(runner.last.body, 'sessionId')).toBe(false);
    } finally {
      await runner.close();
    }
  });

  it('透传 agent/model，且仍不发送 sessionId', async () => {
    const runner = await startRunner(() => ({
      status: 200,
      json: { ok: true, result: { sessionId: 'ses-2', text: 'OK' } },
    }));
    const discoveryFile = join(dir, 'openchamber-runner.json');
    await writeDiscovery(discoveryFile, runner.port);
    const agent = new OpenChamberRunnerAgent({ discoveryFile, agent: 'build', model: 'p/m' });
    try {
      expect(await agent.execute(task('x'))).toMatchObject({ ok: true, resultRef: 'OK' });
      expect(runner.last.body).toMatchObject({ agent: 'build', model: 'p/m' });
      expect(Object.prototype.hasOwnProperty.call(runner.last.body, 'sessionId')).toBe(false);
    } finally {
      await runner.close();
    }
  });

  it('401 → AUTH_FAILED，且错误不含 token', async () => {
    const runner = await startRunner(() => ({ status: 401, json: { ok: false, error: 'UNAUTHORIZED' } }));
    const discoveryFile = join(dir, 'openchamber-runner.json');
    await writeDiscovery(discoveryFile, runner.port);
    const agent = new OpenChamberRunnerAgent({ discoveryFile });
    try {
      const outcome = await agent.execute(task('x'));
      expect(outcome).toEqual({ ok: false, reason: 'AUTH_FAILED' });
      expect(JSON.stringify(outcome)).not.toContain('runner-token');
    } finally {
      await runner.close();
    }
  });

  it('超时 → TIMEOUT，且有界退出', async () => {
    const runner = await startRunner(() => ({ status: 200, never: true }));
    const discoveryFile = join(dir, 'openchamber-runner.json');
    await writeDiscovery(discoveryFile, runner.port);
    const agent = new OpenChamberRunnerAgent({ discoveryFile, timeoutMs: 150 });
    const startedAt = Date.now();
    try {
      expect(await agent.execute(task('x'))).toEqual({ ok: false, reason: 'TIMEOUT' });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      await runner.close();
    }
  });

  it('非 JSON → PROTOCOL_ERROR', async () => {
    const runner = await startRunner(() => ({ status: 200, raw: 'not json' }));
    const discoveryFile = join(dir, 'openchamber-runner.json');
    await writeDiscovery(discoveryFile, runner.port);
    const agent = new OpenChamberRunnerAgent({ discoveryFile });
    try {
      expect(await agent.execute(task('x'))).toEqual({ ok: false, reason: 'PROTOCOL_ERROR' });
    } finally {
      await runner.close();
    }
  });

  it('runner 返回 ok:false → PROTOCOL_ERROR；504 → TIMEOUT；503 → ADAPTER_UNAVAILABLE', async () => {
    const errorRunner = await startRunner(() => ({ status: 200, json: { ok: false, error: 'boom' } }));
    let discoveryFile = join(dir, 'openchamber-runner.json');
    await writeDiscovery(discoveryFile, errorRunner.port);
    expect(await new OpenChamberRunnerAgent({ discoveryFile }).execute(task('x'))).toEqual({
      ok: false,
      reason: 'PROTOCOL_ERROR',
    });
    await errorRunner.close();

    const timeoutRunner = await startRunner(() => ({ status: 504, json: { ok: false, error: 'TIMEOUT' } }));
    discoveryFile = join(dir, 'openchamber-runner2.json');
    await writeDiscovery(discoveryFile, timeoutRunner.port);
    expect(await new OpenChamberRunnerAgent({ discoveryFile }).execute(task('x'))).toEqual({
      ok: false,
      reason: 'TIMEOUT',
    });
    await timeoutRunner.close();

    const unavailableRunner = await startRunner(() => ({ status: 503, json: { ok: false, error: 'offline' } }));
    discoveryFile = join(dir, 'openchamber-runner3.json');
    await writeDiscovery(discoveryFile, unavailableRunner.port);
    expect(await new OpenChamberRunnerAgent({ discoveryFile }).execute(task('x'))).toEqual({
      ok: false,
      reason: 'ADAPTER_UNAVAILABLE',
    });
    await unavailableRunner.close();
  });

  it('缺 discovery / stale / dead pid / 错误 kind → ADAPTER_UNAVAILABLE', async () => {
    expect(await new OpenChamberRunnerAgent({ discoveryFile: join(dir, 'none.json') }).execute(task('x'))).toEqual({
      ok: false,
      reason: 'ADAPTER_UNAVAILABLE',
    });

    const stale = join(dir, 'stale.json');
    await writeDiscovery(stale, 1, { updatedAt: Date.now() - 60_000 });
    expect(await new OpenChamberRunnerAgent({ discoveryFile: stale }).execute(task('x'))).toEqual({
      ok: false,
      reason: 'ADAPTER_UNAVAILABLE',
    });

    const dead = join(dir, 'dead.json');
    await writeDiscovery(dead, 1, { pid: 999_999 });
    expect(await new OpenChamberRunnerAgent({ discoveryFile: dead }).execute(task('x'))).toEqual({
      ok: false,
      reason: 'ADAPTER_UNAVAILABLE',
    });

    const wrongKind = join(dir, 'wrong-kind.json');
    await writeDiscovery(wrongKind, 1, { kind: 'something-else' });
    expect(await new OpenChamberRunnerAgent({ discoveryFile: wrongKind }).execute(task('x'))).toEqual({
      ok: false,
      reason: 'ADAPTER_UNAVAILABLE',
    });

    const badSchema = join(dir, 'bad-schema.json');
    await writeDiscovery(badSchema, 1, { schema: 2 });
    expect(await new OpenChamberRunnerAgent({ discoveryFile: badSchema }).execute(task('x'))).toEqual({
      ok: false,
      reason: 'ADAPTER_UNAVAILABLE',
    });
  });

  it('health：在线 ok，缺 discovery unavailable；detail 不含 token', async () => {
    const runner = await startRunner(({ path }) =>
      path === '/health'
        ? { status: 200, json: { ok: true, pid: 1 } }
        : { status: 404, json: { ok: false } },
    );
    const discoveryFile = join(dir, 'openchamber-runner.json');
    await writeDiscovery(discoveryFile, runner.port);
    try {
      const agent = new OpenChamberRunnerAgent({ discoveryFile });
      const health = await agent.health();
      expect(health.status).toBe('ok');
      expect(JSON.stringify(health)).not.toContain('runner-token');
    } finally {
      await runner.close();
    }

    const missing = await new OpenChamberRunnerAgent({ discoveryFile: join(dir, 'missing.json') }).health();
    expect(missing.status).toBe('unavailable');
    expect(missing.detail).toMatch(/discovery/);
  });
});

describe('OpenChamberRunnerClient discovery', () => {
  it('默认路径为 <home>/openchamber-runner.json，并校验 pid/updatedAt', async () => {
    expect(resolveOpenChamberRunnerDiscoveryFile({ homeDir: dir })).toBe(join(dir, 'openchamber-runner.json'));
    const file = resolveOpenChamberRunnerDiscoveryFile({ homeDir: dir });
    const record = await writeDiscovery(file, 1234);
    const read = readOpenChamberRunnerDiscovery(file);
    expect(read.value).toMatchObject({ port: 1234, token: 'runner-token' });
    expect(read.reason).toBeNull();
    expect(record.schema).toBe(1);
  });

  it('client.runOnce 缺 discovery → ADAPTER_UNAVAILABLE + 稳定 detail', async () => {
    const client = new OpenChamberRunnerClient({ discoveryFile: join(dir, 'none.json') });
    expect(await client.runOnce({ prompt: 'x' })).toMatchObject({
      text: '',
      error: 'ADAPTER_UNAVAILABLE',
      detail: 'discovery_not_found',
    });
  });

  it('非 JSON 且无 sessionId；成功返回 text/sessionId', async () => {
    const runner = await startRunner(() => ({
      status: 200,
      json: { ok: true, result: { sessionId: 'ses-c', text: 'CLIENT_OK' } },
    }));
    const discoveryFile = join(dir, 'openchamber-runner.json');
    await writeDiscovery(discoveryFile, runner.port);
    const client = new OpenChamberRunnerClient({ discoveryFile });
    try {
      expect(await client.runOnce({ prompt: 'p', taskId: 't1' })).toEqual({
        text: 'CLIENT_OK',
        sessionId: 'ses-c',
        ms: undefined,
      });
      expect(runner.last.body).toMatchObject({ prompt: 'p', title: 'fleet t1' });
      expect(Object.prototype.hasOwnProperty.call(runner.last.body, 'sessionId')).toBe(false);
    } finally {
      await runner.close();
    }
  });
});
