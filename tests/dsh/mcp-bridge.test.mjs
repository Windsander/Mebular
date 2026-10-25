// Real-peer integration: mountMcp must await the official cordis fiber, register
// tools, and release both tools and the `serverName` reservation on dispose.
// A local Streamable HTTP MCP server keeps this hermetic (no network, port 0).

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { createServer } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { mountMcp } from '../../packages/dsh-plugin/index.js';

let httpServer;
let mcpHandler;
let baseUrl;

function toolServer() {
  const server = new McpServer({ name: 'fake-mebular', version: '1.0.0' });
  server.registerTool('ping', { description: 'ping' }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  server.registerTool('memory_read', { description: 'read a memory' }, async () => ({
    content: [{ type: 'text', text: '{}' }],
  }));
  return server;
}

async function toFetchRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
  return new Request(`${baseUrl}${req.url}`, {
    method: req.method,
    headers,
    ...(body === undefined ? {} : { body, duplex: 'half' }),
  });
}

beforeAll(async () => {
  mcpHandler = createMcpHandler(toolServer, { responseMode: 'json' });
  httpServer = createServer(async (req, res) => {
    try {
      const response = await mcpHandler.fetch(await toFetchRequest(req));
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body !== null) {
        for await (const chunk of response.body) res.write(Buffer.from(chunk));
      }
      res.end();
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error?.stack ?? error));
    }
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

afterAll(async () => {
  await mcpHandler?.close();
  if (httpServer !== undefined) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

describe('@mebular/dsh-plugin：官方 MCP client 真实挂载', () => {
  it('只有 fiber 连接并注册工具后才 mounted；dispose 注销工具并允许同 serverName 重挂', async () => {
    const ctx = new Context();
    const registered = new Map();
    ctx.provide('tools', {
      register(definition) {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    });
    const logs = [];

    const first = await mountMcp(ctx, baseUrl, {
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    expect(first.ok).toBe(true);
    expect(logs).toEqual(['info:mcp client mounted']);
    expect([...registered.keys()].sort()).toEqual([
      'mcp__mebular__memory_read',
      'mcp__mebular__ping',
    ]);

    await first.dispose();
    expect(registered.size).toBe(0);

    const second = await mountMcp(ctx, baseUrl, {
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    expect(second.ok).toBe(true);
    expect([...registered.keys()].sort()).toEqual([
      'mcp__mebular__memory_read',
      'mcp__mebular__ping',
    ]);

    await second.dispose();
    expect(registered.size).toBe(0);
  }, 15000);

  it('daemon 不可达时 mountMcp 快速失败并返回稳定错误码，不抛出父插件', async () => {
    const ctx = new Context();
    ctx.provide('tools', {
      register() {
        return () => {};
      },
    });
    const logs = [];

    const started = Date.now();
    const result = await mountMcp(ctx, 'http://127.0.0.1:1', {
      log: (level, message) => logs.push(`${level}:${message}`),
    });

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toEqual({ ok: false, code: 'mcp_client_start_failed' });
    expect(logs).toEqual(['warn:mcp client mount failed (mcp_client_start_failed)']);
  }, 15000);
});
