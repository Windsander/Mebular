// `mebular models ... --json`：只走 MCP admin -> sidecar 薄代理；无 daemon 时结构化失败。
// 不下载真实模型、不启动引擎、不写 <home>/models。

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'packages', 'mcp', 'bin', 'mebular.mjs');
const PACK_4B = 'qwen3-4b-instruct-q4_k_m';
const tempDirs = [];
const servers = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
  while (tempDirs.length > 0) await rm(tempDirs.pop(), { recursive: true, force: true });
});

function runCli(home, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'models', ...args, '--json'], {
      env: {
        ...process.env,
        MEBULAR_HOME: home,
        MEBULAR_CLOUD_ROOT: join(home, 'cloud'),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr, json: safeJson(stdout) }));
  });
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'mebular-inference-cli-'));
  tempDirs.push(home);
  return home;
}

async function startFakeAdmin() {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw.length > 0 ? safeJson(raw) : null;
      if (req.method === 'POST') calls.push({ method: req.method, path: req.url, body });
      if (req.url === '/healthz') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, ready: true }));
        return;
      }
      if (req.url === '/console/') {
        res.statusCode = 200;
        res.setHeader('x-mebular-csrf', 'csrf-token');
        res.setHeader('set-cookie', 'mebular_csrf=csrf-cookie; Path=/; HttpOnly');
        res.setHeader('content-type', 'text/html');
        res.end('<html></html>');
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (req.url === '/admin/api/models') {
        res.end(JSON.stringify({
          ok: true,
          effectivePack: null,
          runtime: { source: 'heuristic', pack: null },
          packs: [{ packId: PACK_4B, state: 'installed', selected: false }],
        }));
        return;
      }
      if (req.url === '/admin/api/models/status') {
        res.end(JSON.stringify({
          ok: true,
          install: {
            jobId: 'job_cli_1',
            packId: PACK_4B,
            state: 'completed',
            progress: 1,
            downloadedBytes: 100,
            totalBytes: 100,
            warnings: [],
          },
          recommendation: { kind: 'local', packId: PACK_4B },
          packs: [{ packId: PACK_4B, state: 'installed' }],
        }));
        return;
      }
      if (req.url === '/admin/api/models/install') {
        res.statusCode = 202;
        res.end(JSON.stringify({
          ok: true,
          accepted: true,
          job: { jobId: 'job_cli_1', packId: PACK_4B, state: 'downloading' },
        }));
        return;
      }
      if (req.url === '/admin/api/models/select') {
        res.end(JSON.stringify({ ok: true, selectedPack: PACK_4B, activated: true, active: 'local' }));
        return;
      }
      if (req.url === '/admin/api/models/remove') {
        res.end(JSON.stringify({ ok: true, removed: true, pack: PACK_4B }));
        return;
      }
      if (req.url === '/admin/api/models/start') {
        res.end(JSON.stringify({ ok: true, pack: PACK_4B, started: true, engine: { state: 'running' } }));
        return;
      }
      if (req.url === '/admin/api/models/stop') {
        res.end(JSON.stringify({ ok: true, pack: PACK_4B, stopped: true, engine: { state: 'stopped' } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'not found' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { port: server.address().port, calls };
}

async function writeRuntime(home, port) {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'runtime.json'), JSON.stringify({
    version: '0.3.0',
    pid: process.pid,
    http: { host: '127.0.0.1', port },
    consolePath: '/console',
    mcpPath: '/mcp',
    embedProtocol: 1,
  }), { encoding: 'utf-8', mode: 0o600 });
}

describe('mebular models CLI', () => {
  it('无 daemon：list/status/install/select/remove/start/stop 都返回 daemon_unavailable', async () => {
    const home = await makeHome();
    for (const args of [
      ['list'],
      ['status'],
      ['install', PACK_4B],
      ['select', PACK_4B],
      ['remove', PACK_4B],
      ['start', PACK_4B],
      ['stop', PACK_4B],
    ]) {
      const result = await runCli(home, args);
      expect(result.code).toBe(2);
      expect(result.json).toMatchObject({
        ok: false,
        command: `models.${args[0]}`,
        error: { code: 'daemon_unavailable' },
      });
      expect(JSON.stringify(result.json)).not.toMatch(/token|host-token/i);
    }
    expect(existsSync(join(home, 'models'))).toBe(false);
    expect(existsSync(join(home, 'inference.json'))).toBe(false);
  });

  it('import/test/pause/resume 明确 unsupported，即使 daemon 可用', async () => {
    const home = await makeHome();
    const { port, calls } = await startFakeAdmin();
    await writeRuntime(home, port);
    for (const args of [
      ['import', '/tmp/pack'],
      ['test', PACK_4B],
      ['pause', PACK_4B],
      ['resume', PACK_4B],
    ]) {
      const result = await runCli(home, args);
      expect(result.code).toBe(2);
      expect(result.json).toMatchObject({
        ok: false,
        command: `models.${args[0]}`,
        error: { code: 'unsupported' },
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('daemon 可用：list/status/install/select/remove/start/stop 走 admin proxy，--json 稳定', async () => {
    const home = await makeHome();
    const { port, calls } = await startFakeAdmin();
    await writeRuntime(home, port);

    const list = await runCli(home, ['list']);
    expect(list.code).toBe(0);
    expect(list.json).toMatchObject({ ok: true, command: 'models.list' });
    expect(list.json.packs).toHaveLength(1);

    const status = await runCli(home, ['status']);
    expect(status.code).toBe(0);
    expect(status.json).toMatchObject({ ok: true, recommendation: { kind: 'local', packId: PACK_4B } });

    const install = await runCli(home, ['install', PACK_4B]);
    expect(install.code).toBe(0);
    expect(install.json).toMatchObject({
      ok: true,
      command: 'models.install',
      pack: PACK_4B,
      state: 'installed',
      job: { jobId: 'job_cli_1', state: 'completed' },
    });

    const select = await runCli(home, ['select', PACK_4B]);
    expect(select.code).toBe(0);
    expect(select.json).toMatchObject({ ok: true, selectedPack: PACK_4B });

    const remove = await runCli(home, ['remove', PACK_4B]);
    expect(remove.code).toBe(0);
    expect(remove.json).toMatchObject({ ok: true, removed: true, pack: PACK_4B });

    const start = await runCli(home, ['start', PACK_4B]);
    expect(start.code).toBe(0);
    expect(start.json).toMatchObject({ ok: true, started: true });

    const stop = await runCli(home, ['stop', PACK_4B]);
    expect(stop.code).toBe(0);
    expect(stop.json).toMatchObject({ ok: true, stopped: true });

    expect(calls.map((call) => call.path)).toEqual([
      '/admin/api/models/install',
      '/admin/api/models/select',
      '/admin/api/models/remove',
      '/admin/api/models/start',
      '/admin/api/models/stop',
    ]);
    expect(calls[0].body).toMatchObject({ pack: PACK_4B });
    expect(existsSync(join(home, 'models'))).toBe(false);
    expect(existsSync(join(home, 'inference.json'))).toBe(false);
    const serialized = JSON.stringify([list.json, status.json, install.json, select.json, remove.json, start.json, stop.json]);
    expect(serialized).not.toMatch(/token|host-token/i);
  }, 30000);

  it('daemon 返回 409 memory_runtime_disabled 时保留结构化错误', async () => {
    const home = await makeHome();
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/healthz') {
        res.end(JSON.stringify({ ok: true, ready: true }));
        return;
      }
      if (req.url === '/console/') {
        res.setHeader('x-mebular-csrf', 'csrf-token');
        res.setHeader('set-cookie', 'mebular_csrf=csrf-cookie; Path=/; HttpOnly');
        res.end('<html></html>');
        return;
      }
      res.statusCode = 409;
      res.end(JSON.stringify({
        ok: false,
        error: { code: 'memory_runtime_disabled', message: '记忆运行时未启用', retryable: false },
      }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    await writeRuntime(home, server.address().port);

    const list = await runCli(home, ['list']);
    expect(list.code).toBe(2);
    expect(list.json).toMatchObject({
      ok: false,
      error: { code: 'memory_runtime_disabled' },
    });
  });

  it('daemon 不可达（runtime.json 存在但 healthz 失败）返回 daemon_unavailable', async () => {
    const home = await makeHome();
    await writeRuntime(home, 9);
    const list = await runCli(home, ['list']);
    expect(list.code).toBe(2);
    expect(list.json).toMatchObject({ ok: false, error: { code: 'daemon_unavailable' } });
  });

  it('runtime.json 指向的 daemon 不写任何设备模型文件', async () => {
    const home = await makeHome();
    const { port } = await startFakeAdmin();
    await writeRuntime(home, port);
    await runCli(home, ['status']);
    const runtime = JSON.parse(await readFile(join(home, 'runtime.json'), 'utf-8'));
    expect(runtime.http.port).toBe(port);
    expect(existsSync(join(home, 'models'))).toBe(false);
  });
});
