// service-loader：bare `@mebular/service` → core tarball 内置 packages/service/dist 回退。
//
// 安装布局用一个临时 “@mebular/core” 树模拟：把 loader 原样复制到
// `<core>/packages/mcp/src/`，只放 bundled dist，不创建 node_modules/@mebular/service。
// 这样能真实校验 `new URL('../../service/dist/index.js', import.meta.url)` 的路径。

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  bundledServiceModuleUrl,
  loadServiceModule,
  resetServiceModuleCache,
} from '../../packages/mcp/src/service-loader.mjs';

const LOADER_SOURCE = fileURLToPath(new URL('../../packages/mcp/src/service-loader.mjs', import.meta.url));
const MCP_SRC = fileURLToPath(new URL('../../packages/mcp/src', import.meta.url));
const MCP_BIN = fileURLToPath(new URL('../../packages/mcp/bin', import.meta.url));
const tempDirs = [];

async function tempDir(prefix = 'service-loader-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

afterEach(async () => {
  resetServiceModuleCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

describe('service-loader：bare → bundled dist', () => {
  it('bare 可用时直接返回 bare，不触碰 bundled', async () => {
    const bare = { serviceStatus: () => ({ registered: false, source: 'bare' }) };
    let bundledCalls = 0;
    const module = await loadServiceModule({
      cache: false,
      importBare: async () => bare,
      importBundled: async () => {
        bundledCalls += 1;
        return { source: 'bundled' };
      },
    });
    expect(module).toBe(bare);
    expect(bundledCalls).toBe(0);
  });

  it('bare 失败时回退 bundled，并保留原错误供诊断', async () => {
    const bareError = Object.assign(new Error('Cannot find package @mebular/service'), { code: 'ERR_MODULE_NOT_FOUND' });
    let bundledCalls = 0;
    const bundled = { restartService: () => ({ ok: true }) };
    const module = await loadServiceModule({
      cache: false,
      importBare: async () => { throw bareError; },
      importBundled: async () => {
        bundledCalls += 1;
        return bundled;
      },
    });
    expect(module).toBe(bundled);
    expect(bundledCalls).toBe(1);
  });

  it('两者都失败 → SERVICE_MODULE_UNAVAILABLE（带两个 cause）', async () => {
    const bareError = new Error('bare missing');
    const bundledError = new Error('bundled missing');
    let caught = null;
    try {
      await loadServiceModule({
        cache: false,
        importBare: async () => { throw bareError; },
        importBundled: async () => { throw bundledError; },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'SERVICE_MODULE_UNAVAILABLE' });
    expect(caught.bareError).toBe(bareError);
    expect(caught.bundledError).toBe(bundledError);
    expect(caught.cause).toBe(bareError);
  });

  it('只缓存成功结果；失败不缓存，修复后可重试', async () => {
    resetServiceModuleCache();
    const success = { marker: 'cached' };
    let bareCalls = 0;
    const first = await loadServiceModule({
      importBare: async () => {
        bareCalls += 1;
        return success;
      },
    });
    const second = await loadServiceModule({
      importBare: async () => {
        bareCalls += 1;
        return { marker: 'other' };
      },
    });
    expect(first).toBe(success);
    expect(second).toBe(success);
    expect(bareCalls).toBe(1);

    resetServiceModuleCache();
    let attempts = 0;
    await expect(loadServiceModule({
      importBare: async () => {
        attempts += 1;
        throw new Error('still broken');
      },
      importBundled: async () => { throw new Error('still broken'); },
    })).rejects.toMatchObject({ code: 'SERVICE_MODULE_UNAVAILABLE' });
    const recovered = await loadServiceModule({
      importBare: async () => {
        attempts += 1;
        return { marker: 'recovered' };
      },
    });
    expect(recovered).toMatchObject({ marker: 'recovered' });
    expect(attempts).toBe(2);
  });

  it('bundled URL 指向 core/packages/service/dist/index.js', () => {
    const url = bundledServiceModuleUrl();
    expect(url.protocol).toBe('file:');
    expect(url.pathname.split('/').slice(-4).join('/')).toBe('packages/service/dist/index.js');
  });

  it('安装布局：bare 不可用时从 <core>/packages/service/dist 回退', async () => {
    const root = await tempDir('service-loader-installed-');
    const core = join(root, 'node_modules', '@mebular', 'core');
    const loaderDir = join(core, 'packages', 'mcp', 'src');
    const serviceDir = join(core, 'packages', 'service', 'dist');
    await mkdir(loaderDir, { recursive: true });
    await mkdir(serviceDir, { recursive: true });
    await writeFile(join(loaderDir, 'service-loader.mjs'), await readFile(LOADER_SOURCE, 'utf-8'), 'utf-8');
    await writeFile(join(serviceDir, 'index.js'), [
      "export const marker = 'bundled-installed-layout';",
      'export function serviceStatus() { return { ok: true, registered: false }; }',
      '',
    ].join('\n'), 'utf-8');

    const fakeLoader = await import(pathToFileURL(join(loaderDir, 'service-loader.mjs')).href);
    const module = await fakeLoader.loadServiceModule({
      cache: false,
      importBare: async () => { throw new Error('bare @mebular/service unavailable in installed layout'); },
    });
    expect(module.marker).toBe('bundled-installed-layout');
    expect(module.serviceStatus()).toMatchObject({ ok: true, registered: false });
  });

  it('安装布局 smoke：runtime resolve 在无 service 注册时返回 registered:false（不是 service_unknown）', async () => {
    const root = await tempDir('service-loader-smoke-');
    const prefix = join(root, 'prefix');
    const core = join(prefix, 'node_modules', '@mebular', 'core');
    const serviceDir = join(core, 'packages', 'service', 'dist');
    const cloudRoot = join(root, 'cloud');
    const serviceHome = join(root, 'service-home');
    const port = await freePort();

    await mkdir(serviceDir, { recursive: true });
    await mkdir(cloudRoot, { recursive: true });
    await mkdir(serviceHome, { recursive: true });
    await cp(MCP_SRC, join(core, 'packages', 'mcp', 'src'), { recursive: true });
    await cp(MCP_BIN, join(core, 'packages', 'mcp', 'bin'), { recursive: true });
    await writeFile(join(core, 'package.json'), JSON.stringify({
      name: '@mebular/core',
      version: '0.1.2',
      type: 'module',
    }), 'utf-8');
    await writeFile(join(serviceDir, 'index.js'), [
      'export function serviceStatus() {',
      "  return { ok: true, registered: false, running: false, label: null, autostart: null, foreign: false, unitPath: null };",
      '}',
      'export function installService() { return { ok: true, started: true }; }',
      'export function uninstallService() { return { ok: true, removed: false }; }',
      'export function restartService() { return { ok: true }; }',
      'export function restartPlanFor() { return { ok: true }; }',
      'export function startHeartbeat() {}',
      "export function resolveBuildSha() { return 'test'; }",
      'export function runServiceCli() { return 0; }',
      '',
    ].join('\n'), 'utf-8');
    await writeFile(join(cloudRoot, 'config.json'), JSON.stringify({
      deviceId: 'device-test',
      mcp: { http: { host: '127.0.0.1', port, auth: 'none' } },
    }, null, 2), 'utf-8');

    const env = {
      ...process.env,
      MEBULAR_CLOUD_ROOT: cloudRoot,
      MEBULAR_HOME: cloudRoot,
      MEBULAR_SERVICE_UNIT_HOME: serviceHome,
    };
    delete env.MEBULAR_HTTP_PORT;
    delete env.MEBULAR_HTTP_HOST;

    const result = spawnSync(
      process.execPath,
      [join(core, 'packages', 'mcp', 'bin', 'mebular.mjs'), 'runtime', 'resolve', '--json'],
      { env, encoding: 'utf-8', timeout: 30_000 },
    );

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({
      ok: true,
      mode: 'child',
      service: { ok: true, registered: false, running: false },
    });
    expect(json.mode).not.toBe('conflict');
    expect(json.reason).not.toBe('service_unknown');
  });

  it('安装布局缺少 bundled dist 时明确失败', async () => {
    const root = await tempDir('service-loader-missing-');
    const core = join(root, 'node_modules', '@mebular', 'core');
    const loaderDir = join(core, 'packages', 'mcp', 'src');
    await mkdir(loaderDir, { recursive: true });
    await writeFile(join(loaderDir, 'service-loader.mjs'), await readFile(LOADER_SOURCE, 'utf-8'), 'utf-8');

    const fakeLoader = await import(pathToFileURL(join(loaderDir, 'service-loader.mjs')).href);
    await expect(fakeLoader.loadServiceModule({
      cache: false,
      importBare: async () => { throw new Error('bare unavailable'); },
    })).rejects.toMatchObject({ code: 'SERVICE_MODULE_UNAVAILABLE' });
  });
});
