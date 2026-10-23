// P5.1 · 长连接下的优雅停止：keep-alive、MCP session、SSE 都不能让 running.close() 挂住。
// close 必须先收 MCP sessions，再结束 HTTP 连接，最后等 listener（有限超时），并始终清理 runtime.json。

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';
import { runtimePath } from '../../packages/mcp/src/runtime-file.mjs';

const CLOSE_BUDGET_MS = 5_000;

let home = null;
const cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
  if (home !== null) await rm(home, { recursive: true, force: true });
  home = null;
});

async function tempHome() {
  home = await mkdtemp(join(tmpdir(), 'mebular-shutdown-'));
  return home;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 未完成`)), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function openKeepAlive(port) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', agent }, (res) => {
      res.resume();
      res.on('error', () => undefined);
    });
    req.on('error', reject);
    agent.once('free', (socket) => resolve({ req, agent, socket }));
  });
}

function openSse(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/admin/events' }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`/admin/events status=${res.statusCode}`));
        return;
      }
      res.setEncoding('utf-8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.includes('event: hello')) resolve({ req, res });
      });
      res.on('error', () => undefined);
    });
    req.on('error', reject);
  });
}

const fakeApp = {
  sync: { on() {}, off() {} },
  getBlockedDevices: async () => [],
};
const fakeService = {
  status: async () => ({ running: true, nodeCount: 0, pendingEventCount: 0, peerId: null }),
};

describe('P5.1 优雅停止：长连接不阻塞 close', () => {
  it('keep-alive 空闲连接存在时仍在 5s 内 close，并清理 runtime.json', async () => {
    const dir = await tempHome();
    const running = await startHttpServer({ home: dir, host: '127.0.0.1', port: 0 });
    cleanups.push(async () => { await running.close(); });
    const keepAlive = await openKeepAlive(running.port);
    cleanups.push(async () => { keepAlive.req.destroy(); keepAlive.agent.destroy(); });
    expect(keepAlive.socket.destroyed).toBe(false);
    expect(Object.values(keepAlive.agent.freeSockets).flat()).toContain(keepAlive.socket);

    const started = Date.now();
    await withTimeout(running.close(), CLOSE_BUDGET_MS, 'keep-alive close');
    expect(Date.now() - started).toBeLessThan(CLOSE_BUDGET_MS);
    expect(existsSync(runtimePath(dir))).toBe(false);
  }, 15_000);

  it('MCP session + SSE 长连接同时存在时 close 仍完成并清理 runtime.json', async () => {
    const dir = await tempHome();
    const running = await startHttpServer({
      home: dir,
      host: '127.0.0.1',
      port: 0,
      app: fakeApp,
      service: fakeService,
      buildServer: () => new McpServer({ name: 'mebular-shutdown-test', version: '0.0.0' }),
    });
    cleanups.push(async () => { await running.close(); });

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`));
    const client = new Client({ name: 'mebular-shutdown-test', version: '0.0.0' });
    cleanups.push(async () => {
      await withTimeout(client.close(), 2_000, 'client close').catch(() => undefined);
    });
    await client.connect(transport);
    await client.ping();

    const sse = await openSse(running.port);
    cleanups.push(async () => { sse.req.destroy(); });

    const started = Date.now();
    await withTimeout(running.close(), CLOSE_BUDGET_MS, 'MCP/SSE close');
    expect(Date.now() - started).toBeLessThan(CLOSE_BUDGET_MS);
    expect(existsSync(runtimePath(dir))).toBe(false);
  }, 15_000);

  it('close 幂等，并保留最新 main 的 onClose 收尾钩子', async () => {
    const dir = await tempHome();
    const onClose = jest.fn(async () => undefined);
    const running = await startHttpServer({
      home: dir,
      host: '127.0.0.1',
      port: 0,
      onClose,
    });
    cleanups.push(async () => { await running.close(); });
    const [first, second] = await Promise.all([running.close(), running.close()]);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(existsSync(runtimePath(dir))).toBe(false);
  }, 15_000);
});
