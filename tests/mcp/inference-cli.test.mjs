// `mebular models ... --json`：稳定 JSON/退出码；install 用小文件本地 HTTP，不下载真实模型。

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACK_4B,
  cleanupDirs,
  makeManifest,
  putManifest,
  tempDir,
  writeImportPack,
} from '../inference/mcp-helpers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'packages', 'mcp', 'bin', 'mebular.mjs');
const tempDirs = [];
const servers = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
  await cleanupDirs(tempDirs);
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
  const home = await tempDir('mebular-inference-cli-');
  tempDirs.push(home);
  return home;
}

async function writeFakeLlama(dir) {
  const path = join(dir, 'llama-server');
  await writeFile(path, `#!/usr/bin/env node
import { createServer } from 'node:http';
const args = process.argv.slice(2);
const get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const port = Number(get('--port'));
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (req.url === '/health') { res.end(JSON.stringify({ status: 'ok' })); return; }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ ok: true }) } }] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
server.listen(port, '127.0.0.1');
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`, 'utf-8');
  await chmod(path, 0o755);
  return path;
}

describe('mebular models CLI', () => {
  it('list/status/import/select/remove 稳定 JSON；未启动 daemon 时 start 返回 daemon_unavailable', async () => {
    const home = await makeHome();
    const list = await runCli(home, ['list']);
    expect(list.code).toBe(0);
    expect(list.json).toMatchObject({ ok: true, command: 'models.list' });
    expect(list.json.packs).toHaveLength(3);

    const status = await runCli(home, ['status'], {
      MEBULAR_MODEL_HARDWARE_JSON: JSON.stringify({
        platform: 'darwin', arch: 'arm64', osVersion: 'test', cpuCores: 8,
        totalMemoryBytes: 16 * 1024 ** 3, freeMemoryBytes: 8 * 1024 ** 3,
        disk: { path: '/tmp', availableBytes: 100 * 1024 ** 3 },
        gpu: { vendor: 'apple', unifiedMemory: true }, detectedAt: 0, warnings: [],
      }),
    });
    expect(status.code).toBe(0);
    expect(status.json).toMatchObject({ ok: true, recommendation: { kind: 'local' } });

    const source = await tempDir('mebular-inference-cli-src-');
    tempDirs.push(source);
    await writeImportPack(source, makeManifest());
    const imported = await runCli(home, ['import', source]);
    expect(imported.code).toBe(0);
    expect(imported.json).toMatchObject({ ok: true, imported: true, pack: PACK_4B });

    const selected = await runCli(home, ['select', PACK_4B, '--source', 'local']);
    expect(selected.code).toBe(0);
    expect(selected.json).toMatchObject({ ok: true, selectedPack: PACK_4B });

    const refused = await runCli(home, ['remove', PACK_4B]);
    expect(refused.code).toBe(2);
    expect(refused.json).toMatchObject({ ok: false, error: { code: 'selection_in_use' } });

    const removed = await runCli(home, ['remove', PACK_4B, '--force']);
    expect(removed.code).toBe(0);
    expect(removed.json).toMatchObject({ ok: true, removed: true });

    const start = await runCli(home, ['start', PACK_4B]);
    expect(start.code).toBe(2);
    expect(start.json).toMatchObject({ ok: false, error: { code: 'daemon_unavailable' } });
  });

  it('install 通过本地 HTTP 小文件完成；test 用假 llama-server 后自动停止', async () => {
    if (process.platform === 'win32') return;
    const home = await makeHome();
    const content = Buffer.from('tiny-model-bytes');
    const manifest = makeManifest({ files: [{ path: 'model.gguf', content }] });
    await putManifest(home, manifest);

    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-length': content.length, etag: '"tiny"' });
      res.end(content);
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/pack`;

    const install = await runCli(home, ['install', PACK_4B, '--mirror', base]);
    expect(install.code).toBe(0);
    expect(install.json).toMatchObject({ ok: true, pack: PACK_4B, state: 'installed' });

    const binDir = await tempDir('mebular-inference-cli-bin-');
    tempDirs.push(binDir);
    const binary = await writeFakeLlama(binDir);
    const test = await runCli(home, ['test', PACK_4B], { MEBULAR_LLAMA_SERVER: binary });
    expect(test.code).toBe(0);
    expect(test.json).toMatchObject({ ok: true, pack: PACK_4B, startedByTest: true });
    const state = JSON.parse(await readFile(join(home, 'inference.json'), 'utf-8'));
    expect(state.installs[PACK_4B]).toBeTruthy();
  });
});
