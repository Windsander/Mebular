// W2a：capability 挂载/鉴权/loopback/Host/Origin/轻量零副作用。
import { describe, it, expect, afterEach } from '@jest/globals';
import http from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';
import {
  capabilityTokenDir,
  capabilityTokenPath,
  readCapabilityToken,
} from '../../packages/mcp/src/memory-runtime-token.mjs';
import {
  isLoopbackRemoteAddress,
  isLoopbackHostname,
  originAllowed,
  parseHostHeader,
} from '../../packages/mcp/src/memory-capability.mjs';

const cleanups = [];
const dirs = [];
const savedCapabilityToken = process.env.MEBULAR_CAPABILITY_TOKEN;
const savedCloudRoot = process.env.MEBULAR_CLOUD_ROOT;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()().catch(() => undefined);
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true });
  if (savedCapabilityToken === undefined) delete process.env.MEBULAR_CAPABILITY_TOKEN;
  else process.env.MEBULAR_CAPABILITY_TOKEN = savedCapabilityToken;
  if (savedCloudRoot === undefined) delete process.env.MEBULAR_CLOUD_ROOT;
  else process.env.MEBULAR_CLOUD_ROOT = savedCloudRoot;
});

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const fakeApp = {
  deviceId: 'device-fake',
  isInitialized: () => true,
  storage: { listNodes: async () => [] },
  graph: { getNode: async () => null },
  getNamespaceDirectory: async () => [],
};
const fakeService = {
  status: async () => ({ running: false, pendingEventCount: 0, deviceId: 'device-fake' }),
};

async function start({ config, home, env } = {}) {
  const actualHome = home ?? await tempDir('memory-capability-security-');
  process.env.MEBULAR_CLOUD_ROOT = join(actualHome, 'cloud');
  if (env?.MEBULAR_CAPABILITY_TOKEN !== undefined) {
    process.env.MEBULAR_CAPABILITY_TOKEN = env.MEBULAR_CAPABILITY_TOKEN;
  } else {
    delete process.env.MEBULAR_CAPABILITY_TOKEN;
  }
  const server = await startHttpServer({
    home: actualHome,
    app: fakeApp,
    service: fakeService,
    config: config ?? { mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } } },
    buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
    host: '127.0.0.1',
    port: 0,
    auth: 'none',
  });
  cleanups.push(() => server.close());
  return { home: actualHome, server, base: `http://127.0.0.1:${server.port}` };
}

function request(base, path, { method = 'GET', token, headers = {} } = {}) {
  const url = new URL(`${base}${path}`);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('轻量模式（默认）', () => {
  it('返回 404 capability_disabled，且不创建 memory-runtime 目录/token', async () => {
    const { home, base } = await start();
    const version = await request(base, '/internal/memory/v1/version');
    expect(version.status).toBe(404);
    expect(version.body.ok).toBe(false);
    expect(version.body.error.code).toBe('capability_disabled');
    const status = await request(base, '/internal/memory/v1/status?agentId=opencode');
    expect(status.status).toBe(404);
    expect(status.body.error.code).toBe('capability_disabled');
    await expect(stat(capabilityTokenDir(home))).rejects.toThrow();
    await expect(stat(capabilityTokenPath(home))).rejects.toThrow();
  });

  it('enabled=false 同样不挂载，不创建 token', async () => {
    const { home, base } = await start({
      config: {
        memoryRuntime: { enabled: false },
        mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
      },
    });
    const res = await request(base, '/internal/memory/v1/version');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('capability_disabled');
    await expect(stat(capabilityTokenDir(home))).rejects.toThrow();
  });
});

describe('启用后的 token 与鉴权', () => {
  it('启动时生成 token 文件（0600/0700），并能用文件 token 访问 /version', async () => {
    const { home, base } = await start({
      config: {
        memoryRuntime: { enabled: true },
        mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
      },
    });
    if (process.platform !== 'win32') {
      const dirMode = (await stat(capabilityTokenDir(home))).mode & 0o777;
      const fileMode = (await stat(capabilityTokenPath(home))).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }
    const record = await readCapabilityToken({ home, env: {} });
    expect(record?.source).toBe('file');
    const res = await request(base, '/internal/memory/v1/version', { token: record.token });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.text).not.toContain(record.token);
  });

  it('缺 token / 错 token / 仅 cookie → 401；无 CORS 头', async () => {
    const { base } = await start({
      config: {
        memoryRuntime: { enabled: true },
        mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
      },
    });
    const missing = await request(base, '/internal/memory/v1/version');
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('capability_token_invalid');
    expect(missing.headers['access-control-allow-origin']).toBeUndefined();

    const wrong = await request(base, '/internal/memory/v1/version', { token: 'not-the-token' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('capability_token_invalid');

    const cookie = await request(base, '/internal/memory/v1/version', {
      headers: { cookie: 'mebular_csrf=abc' },
    });
    expect(cookie.status).toBe(401);
    expect(cookie.headers['set-cookie']).toBeUndefined();
  });

  it('MEBULAR_CAPABILITY_TOKEN 覆盖：不创建文件，覆盖值可用', async () => {
    const override = 'env-override-token-0123456789abcdefghijklmnopqrstuvwxyz';
    const { home, base } = await start({
      config: {
        memoryRuntime: { enabled: true },
        mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
      },
      env: { MEBULAR_CAPABILITY_TOKEN: override },
    });
    await expect(stat(capabilityTokenDir(home))).rejects.toThrow();
    const res = await request(base, '/internal/memory/v1/version', { token: override });
    expect(res.status).toBe(200);
  });

  it('Host / Origin 必须是 loopback；loopback Origin 放行', async () => {
    const { home, base } = await start({
      config: {
        memoryRuntime: { enabled: true },
        mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
      },
    });
    const token = (await readCapabilityToken({ home, env: {} }))?.token;
    const evilHost = await request(base, '/internal/memory/v1/version', {
      token,
      headers: { host: 'evil.example' },
    });
    expect(evilHost.status).toBe(403);
    expect(evilHost.body.error.code).toBe('loopback_required');

    const evilOrigin = await request(base, '/internal/memory/v1/version', {
      token,
      headers: { origin: 'http://evil.example' },
    });
    expect(evilOrigin.status).toBe(403);
    expect(evilOrigin.body.error.code).toBe('loopback_required');

    const goodOrigin = await request(base, '/internal/memory/v1/version', {
      token,
      headers: { origin: base },
    });
    expect(goodOrigin.status).toBe(200);
  });

  it('capability major 不匹配 → 409', async () => {
    const { home, base } = await start({
      config: {
        memoryRuntime: { enabled: true },
        mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
      },
    });
    const token = (await readCapabilityToken({ home, env: {} }))?.token;
    const res = await request(base, '/internal/memory/v1/version', {
      token,
      headers: { 'x-mebular-capability-version': '2' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('capability_version_unsupported');
  });
});

describe('路由/方法', () => {
  it('未知端点 404；错误方法 405；OPTIONS 不返回 CORS', async () => {
    const { home, base } = await start({
      config: {
        memoryRuntime: { enabled: true },
        mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
      },
    });
    const token = (await readCapabilityToken({ home, env: {} }))?.token;
    const unknown = await request(base, '/internal/memory/v1/nope', { token });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');

    const wrongMethod = await request(base, '/internal/memory/v1/query', { token });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.body.error.code).toBe('method_not_allowed');

    const options = await request(base, '/internal/memory/v1/version', {
      method: 'OPTIONS',
      token,
      headers: { origin: base, 'access-control-request-method': 'GET' },
    });
    expect(options.status).toBe(405);
    expect(options.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('daemon 关闭后撤销 token 文件', async () => {
    const home = await tempDir('memory-capability-dispose-');
    process.env.MEBULAR_CLOUD_ROOT = join(home, 'cloud');
    delete process.env.MEBULAR_CAPABILITY_TOKEN;
    const server = await startHttpServer({
      home,
      app: fakeApp,
      service: fakeService,
      config: {
        memoryRuntime: { enabled: true },
        mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
      },
      buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
      host: '127.0.0.1',
      port: 0,
      auth: 'none',
    });
    await stat(capabilityTokenPath(home));
    await server.close();
    await expect(stat(capabilityTokenPath(home))).rejects.toThrow();
  });
});

describe('loopback 原语', () => {
  it('只接受 127.0.0.1 / ::1 / ::ffff:127.0.0.1', () => {
    expect(isLoopbackRemoteAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackRemoteAddress('::1')).toBe(true);
    expect(isLoopbackRemoteAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackRemoteAddress('192.168.1.2')).toBe(false);
    expect(isLoopbackRemoteAddress('127.0.0.2')).toBe(false);
    expect(isLoopbackRemoteAddress('::ffff:10.0.0.1')).toBe(false);
  });

  it('Host 解析支持 IPv4/域名/IPv6 方括号，拒绝非 loopback', () => {
    expect(parseHostHeader('127.0.0.1:7331')).toEqual({ hostname: '127.0.0.1', port: '7331' });
    expect(parseHostHeader('localhost:7331')).toEqual({ hostname: 'localhost', port: '7331' });
    expect(parseHostHeader('[::1]:7331')).toEqual({ hostname: '::1', port: '7331' });
    expect(parseHostHeader('::1:7331')).toBeNull();
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('example.com')).toBe(false);
    expect(originAllowed('http://[::1]:7331', 7331)).toBe(true);
    expect(originAllowed('http://localhost:7331', 7331)).toBe(true);
    expect(originAllowed('http://evil.example:7331', 7331)).toBe(false);
  });
});
