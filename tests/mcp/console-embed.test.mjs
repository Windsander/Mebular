// P1 · Console embed HTTP 契约：普通 Console 保持 DENY；loopback + ?embed=dsh 才允许被 frame；
// /app/embed/info 匿名只读且不含敏感信息，并且在 bearer/OAuth 鉴权之前。

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_VERSION,
  buildEmbedInfo,
  consoleSecurityHeaders,
  startHttpServer,
} from '../../packages/mcp/src/serve.mjs';
import { readRuntimeFile } from '../../packages/mcp/src/runtime-file.mjs';

function headerRecorder() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
  };
}

describe('P1 console embed：安全头', () => {
  it('普通 / 非 loopback：XFO DENY + frame-ancestors none（与现状一致）', () => {
    for (const options of [undefined, { embed: false, loopback: true }, { embed: true, loopback: false }]) {
      const res = headerRecorder();
      consoleSecurityHeaders(res, options);
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    }
  });

  it('embed=true + loopback=true：移除 XFO，只允许 loopback 祖先', () => {
    const res = headerRecorder();
    consoleSecurityHeaders(res, { embed: true, loopback: true });
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain('frame-ancestors http://127.0.0.1:* http://localhost:*');
    expect(res.headers['content-security-policy']).not.toContain("frame-ancestors 'none'");
    // 其余安全头不回退
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('buildEmbedInfo：非 loopback 明确 embedConsole=false', () => {
    const info = buildEmbedInfo({ origin: 'http://127.0.0.1:7331', loopback: false });
    expect(info.loopback).toBe(false);
    expect(info.capabilities.embedConsole).toBe(false);
    expect(info.embedUrl).toBe('http://127.0.0.1:7331/console/?embed=dsh');
  });
});

describe('P1 console embed：真实 HTTP server', () => {
  let home;
  let running;
  let base;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'mebular-embed-'));
    // auth=bearer：/app/embed/info 仍必须在鉴权前可匿名读取（不提供 tokensFile）。
    running = await startHttpServer({ home, host: '127.0.0.1', port: 0, auth: 'bearer' });
    base = `http://127.0.0.1:${running.port}`;
  });

  afterAll(async () => {
    await running?.close();
    await rm(home, { recursive: true, force: true });
  });

  it('普通 /console/：XFO DENY + frame-ancestors none', async () => {
    const res = await fetch(`${base}/console/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('/console?embed=dsh 的 308 保留 query；/console/?embed=dsh 允许 loopback frame', async () => {
    const redirect = await fetch(`${base}/console?embed=dsh`, { redirect: 'manual' });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe('/console/?embed=dsh');

    const res = await fetch(`${base}/console/?embed=dsh`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBeNull();
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain('frame-ancestors http://127.0.0.1:* http://localhost:*');
    expect(csp).not.toContain("frame-ancestors 'none'");
  });

  it('host.js 在静态白名单内，embed 下按同一套安全头提供', async () => {
    const res = await fetch(`${base}/console/host.js?embed=dsh`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(await res.text()).toContain('createConsoleHost');
  });

  it('/app/embed/info：顶层字段精确、embedProtocol=1、loopback 可嵌入、无敏感字段、鉴权前可读', async () => {
    const res = await fetch(`${base}/app/embed/info`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const info = await res.json();
    expect(Object.keys(info).sort()).toEqual([
      'capabilities', 'consoleUrl', 'embedProtocol', 'embedUrl',
      'loopback', 'mcpUrl', 'name', 'ok', 'version',
    ]);
    expect(info).toEqual({
      ok: true,
      name: 'mebular',
      version: APP_VERSION,
      embedProtocol: 1,
      consoleUrl: `${base}/console`,
      embedUrl: `${base}/console/?embed=dsh`,
      mcpUrl: `${base}/mcp`,
      loopback: true,
      capabilities: { embedConsole: true },
    });
    expect(APP_VERSION).toBe('0.1.0');
    const serialized = JSON.stringify(info).toLowerCase();
    for (const word of ['token', 'secret', 'key', 'config', 'home']) {
      expect(serialized).not.toContain(word);
    }
  });

  it('/app/embed/info 只接受 GET', async () => {
    const res = await fetch(`${base}/app/embed/info`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('runtime.json 与 /app/embed/info 使用同一套版本/协议，且不含敏感信息', async () => {
    const runtime = await readRuntimeFile(home);
    expect(runtime).toMatchObject({
      version: APP_VERSION,
      pid: process.pid,
      http: { host: '127.0.0.1', port: running.port },
      consolePath: '/console',
      mcpPath: '/mcp',
      embedProtocol: 1,
    });
    expect(JSON.stringify(runtime)).not.toMatch(/token|secret|key|config|home/);
  });
});
