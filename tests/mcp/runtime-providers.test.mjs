// Shared runtime provider 注册表：原子写/锁/校验 + `mebular runtime provider` CLI 契约。
//
// 红线：只存 kind/path/version/capabilities；不存 token/身份；损坏注册表不阻塞 attach，
// 但写入/移除必须 fail-closed（不覆盖损坏文件）。

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUNTIME_PROVIDERS_LOCK_FILE,
  listRuntimeProviders,
  readRuntimeProviders,
  registerRuntimeProvider,
  removeRuntimeProvider,
  runtimeProviderId,
  runtimeProvidersPath,
  writeRuntimeProviders,
} from '../../packages/mcp/src/runtime-providers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'packages', 'mcp', 'bin', 'mebular.mjs');

const tempDirs = [];

async function tempDir(prefix = 'runtime-providers-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function fakeProvider(root, name = 'fake-mebular.mjs') {
  const path = join(root, name);
  await writeFile(path, '// fake runtime entry\n', 'utf-8');
  return path;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

describe('runtime provider 注册表：写入 / 读取 / 移除', () => {
  it('注册只落 kind/path/version/capabilities（未知字段被丢弃），文件 0600 且原子无 tmp 残留', async () => {
    const root = await tempDir();
    const path = await fakeProvider(root);
    const result = await registerRuntimeProvider(root, {
      kind: 'cli',
      path,
      version: '0.1.2',
      capabilities: ['serve', 'console'],
      token: 'must-not-persist',
      identity: { privateKey: 'nope' },
    });
    expect(result.created).toBe(true);
    expect(result.provider.id).toBe(runtimeProviderId('cli', path));

    const file = runtimeProvidersPath(root);
    expect(existsSync(file)).toBe(true);
    const raw = await readFile(file, 'utf-8');
    expect(raw).not.toMatch(/token|privateKey|must-not-persist/i);
    const parsed = JSON.parse(raw);
    expect(parsed.v).toBe(1);
    expect(parsed.providers).toHaveLength(1);
    expect(Object.keys(parsed.providers[0]).sort()).toEqual([
      'capabilities',
      'id',
      'kind',
      'path',
      'registeredAt',
      'updatedAt',
      'version',
    ]);
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(`${file}.tmp-${process.pid}`)).toBe(false);
  });

  it('同一 kind+path 重复注册 → 更新 version/capabilities，保留 registeredAt', async () => {
    const root = await tempDir();
    const path = await fakeProvider(root);
    const first = await registerRuntimeProvider(root, {
      kind: 'app',
      path,
      version: '0.1.0',
      capabilities: ['serve'],
    }, { now: '2026-01-01T00:00:00.000Z' });
    const second = await registerRuntimeProvider(root, {
      kind: 'app',
      path,
      version: '0.2.0',
      capabilities: ['serve', 'console'],
    }, { now: '2026-02-01T00:00:00.000Z' });

    expect(second.created).toBe(false);
    expect(second.provider.registeredAt).toBe(first.provider.registeredAt);
    expect(second.provider.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    const state = await readRuntimeProviders(root);
    expect(state.registry.providers).toHaveLength(1);
    expect(state.registry.providers[0].version).toBe('0.2.0');
  });

  it('按 id 或 kind+path 移除；不存在时 RUNTIME_PROVIDER_NOT_FOUND', async () => {
    const root = await tempDir();
    const path = await fakeProvider(root);
    const { provider } = await registerRuntimeProvider(root, { kind: 'cli', path, version: '1.0.0' });

    const removed = await removeRuntimeProvider(root, { id: provider.id });
    expect(removed.removed.id).toBe(provider.id);
    expect((await readRuntimeProviders(root)).registry.providers).toHaveLength(0);

    await registerRuntimeProvider(root, { kind: 'cli', path, version: '1.0.0' });
    const byPath = await removeRuntimeProvider(root, { kind: 'cli', path });
    expect(byPath.removed.path).toBe(path);

    await expect(removeRuntimeProvider(root, { id: provider.id }))
      .rejects.toMatchObject({ code: 'RUNTIME_PROVIDER_NOT_FOUND' });
  });

  it('相对路径 / 未知 kind / 非法版本 → 拒绝', async () => {
    const root = await tempDir();
    await expect(registerRuntimeProvider(root, { kind: 'cli', path: 'relative/mebular.mjs' }))
      .rejects.toMatchObject({ code: 'RUNTIME_PROVIDER_INVALID_PATH' });
    await expect(registerRuntimeProvider(root, { kind: 'other', path: '/tmp/x' }))
      .rejects.toMatchObject({ code: 'RUNTIME_PROVIDER_INVALID_KIND' });
    await expect(registerRuntimeProvider(root, { kind: 'cli', path: '/tmp/x', version: 'not a version!' }))
      .rejects.toMatchObject({ code: 'RUNTIME_PROVIDER_INVALID_VERSION' });
  });

  it('损坏注册表：读取返回空 + warning；写入/移除 fail-closed 不覆盖', async () => {
    const root = await tempDir();
    const path = await fakeProvider(root);
    await writeFile(runtimeProvidersPath(root), '{broken', 'utf-8');

    const state = await readRuntimeProviders(root);
    expect(state.source).toBe('invalid');
    expect(state.registry.providers).toEqual([]);
    expect(state.warnings.length).toBeGreaterThan(0);

    await expect(registerRuntimeProvider(root, { kind: 'cli', path }))
      .rejects.toMatchObject({ code: 'RUNTIME_PROVIDERS_INVALID' });
    expect(await readFile(runtimeProvidersPath(root), 'utf-8')).toBe('{broken');

    await rm(runtimeProvidersPath(root), { force: true });
    const recovered = await registerRuntimeProvider(root, { kind: 'cli', path });
    expect(recovered.created).toBe(true);
  });

  it('读取时丢弃无效条目并保留有效条目（向前兼容）', async () => {
    const root = await tempDir();
    const path = await fakeProvider(root);
    await writeFile(runtimeProvidersPath(root), JSON.stringify({
      v: 1,
      providers: [
        { id: 'bad', kind: 'nope', path, version: '1.0.0', capabilities: [] },
        { kind: 'cli', path, version: '1.0.0', capabilities: ['serve'] },
      ],
    }), 'utf-8');

    const state = await readRuntimeProviders(root);
    expect(state.source).toBe('invalid');
    expect(state.registry.providers).toHaveLength(1);
    expect(state.registry.providers[0].kind).toBe('cli');
    expect(state.warnings).toHaveLength(1);
  });

  it('写入非 v1 注册表 → 拒绝', async () => {
    const root = await tempDir();
    await expect(writeRuntimeProviders(root, { v: 2, providers: [] }))
      .rejects.toMatchObject({ code: 'RUNTIME_PROVIDERS_INVALID' });
  });
});

describe('runtime provider 注册表：锁', () => {
  it('活 PID 持锁 → RUNTIME_PROVIDERS_LOCKED；释放后可写', async () => {
    const root = await tempDir();
    const path = await fakeProvider(root);
    const lock = join(root, RUNTIME_PROVIDERS_LOCK_FILE);
    await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf-8');

    await expect(registerRuntimeProvider(root, { kind: 'cli', path }))
      .rejects.toMatchObject({ code: 'RUNTIME_PROVIDERS_LOCKED' });

    await rm(lock, { force: true });
    const result = await registerRuntimeProvider(root, { kind: 'cli', path });
    expect(result.created).toBe(true);
  });

  it('陈旧 PID 锁自动回收', async () => {
    const root = await tempDir();
    const path = await fakeProvider(root);
    const lock = join(root, RUNTIME_PROVIDERS_LOCK_FILE);
    await writeFile(lock, JSON.stringify({ pid: 2147483647, startedAt: new Date().toISOString() }), 'utf-8');

    const result = await registerRuntimeProvider(root, { kind: 'cli', path });
    expect(result.created).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('list 附带 available（路径存在性），不修改注册表', async () => {
    const root = await tempDir();
    const path = await fakeProvider(root);
    await registerRuntimeProvider(root, { kind: 'cli', path });
    await registerRuntimeProvider(root, { kind: 'shared', path: join(root, 'missing', 'mebular') });

    const state = await listRuntimeProviders(root);
    expect(state.providers).toHaveLength(2);
    expect(state.providers.find((entry) => entry.kind === 'cli').available).toBe(true);
    expect(state.providers.find((entry) => entry.kind === 'shared').available).toBe(false);
  });
});

describe('mebular runtime provider CLI', () => {
  function envFor(root) {
    return {
      ...process.env,
      MEBULAR_CLOUD_ROOT: root,
      MEBULAR_HOME: root,
      MEBULAR_SERVICE_UNIT_HOME: join(root, 'service-home'),
    };
  }

  function runCli(root, ...args) {
    return spawnSync(process.execPath, [CLI, 'runtime', 'provider', ...args, '--json'], {
      env: envFor(root),
      encoding: 'utf-8',
      timeout: 20_000,
    });
  }

  it('add → list → remove 输出稳定 JSON', async () => {
    const root = await tempDir('runtime-provider-cli-');
    const path = await fakeProvider(root);
    const added = runCli(root, 'add', '--kind', 'cli', '--path', path, '--version', '9.9.9', '--capabilities', 'serve,console');
    expect(added.status).toBe(0);
    const addJson = JSON.parse(added.stdout);
    expect(addJson.ok).toBe(true);
    expect(addJson.created).toBe(true);
    expect(addJson.provider).toMatchObject({
      kind: 'cli',
      path,
      version: '9.9.9',
      capabilities: ['serve', 'console'],
      available: true,
    });

    const listed = runCli(root, 'list');
    expect(listed.status).toBe(0);
    const listJson = JSON.parse(listed.stdout);
    expect(listJson.ok).toBe(true);
    expect(listJson.providers).toHaveLength(1);
    expect(listJson.providers[0].id).toBe(addJson.provider.id);
    expect(listJson.providers[0].available).toBe(true);

    const removed = runCli(root, 'remove', '--id', addJson.provider.id);
    expect(removed.status).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ ok: true, removed: { id: addJson.provider.id } });

    const empty = runCli(root, 'list');
    expect(JSON.parse(empty.stdout).providers).toEqual([]);
  });

  it('非法 kind / 缺失路径 → exit 2 + JSON 错误（stdout 只有 JSON）', async () => {
    const root = await tempDir('runtime-provider-cli-');
    const path = await fakeProvider(root);
    const badKind = runCli(root, 'add', '--kind', 'nope', '--path', path);
    expect(badKind.status).toBe(2);
    expect(JSON.parse(badKind.stdout)).toMatchObject({
      ok: false,
      mode: 'error',
      reason: 'RUNTIME_PROVIDER_INVALID_KIND',
    });
    expect(badKind.stderr).toBe('');

    const missing = runCli(root, 'add', '--kind', 'cli', '--path', join(root, 'nope.mjs'));
    expect(missing.status).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, reason: 'PROVIDER_PATH_MISSING' });
  });
});
