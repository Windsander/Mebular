// token：host token 生成/读取/权限、capability token env/文件/过期、停止清理。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureHostToken,
  generateHostToken,
  readCapabilityToken,
  readHostToken,
  removeHostTokenIfMatches,
  TokenError,
} from '../../src/sidecar/token.js';
import { writeJsonAtomic } from '../../src/sidecar/atomic-json.js';

describe('sidecar token', () => {
  let dir: string;
  let hostTokenFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-memory-runtime-token-'));
    hostTokenFile = join(dir, 'host-token');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('生成 host token 并原子写入 0600，可读回', async () => {
    const ensured = await ensureHostToken({ tokenFile: hostTokenFile, env: {}, now: 1000 });
    expect(ensured.token.length).toBeGreaterThanOrEqual(32);
    expect(ensured.source).toBe('generated');
    expect((await stat(hostTokenFile)).mode & 0o777).toBe(0o600);

    const read = await readHostToken({ tokenFile: hostTokenFile, env: {} });
    expect(read?.token).toBe(ensured.token);
    expect(read?.source).toBe('file');
    expect(read?.issuedAt).toBe(1000);
  });

  it('MEBULAR_MEMORY_RUNTIME_TOKEN 覆盖 host token，并写入 0600 文件', async () => {
    const ensured = await ensureHostToken({
      tokenFile: hostTokenFile,
      env: { MEBULAR_MEMORY_RUNTIME_TOKEN: 'env-host-token' },
    });
    expect(ensured.token).toBe('env-host-token');
    expect(ensured.source).toBe('env');
    expect((await readHostToken({ tokenFile: hostTokenFile, env: {} }))?.token).toBe('env-host-token');

    const override = await readHostToken({
      tokenFile: hostTokenFile,
      env: { MEBULAR_MEMORY_RUNTIME_TOKEN: 'direct-override' },
    });
    expect(override).toMatchObject({ token: 'direct-override', source: 'env', path: null });
  });

  it('组/其他可读的 host token 文件拒绝使用（POSIX）', async () => {
    if (process.platform === 'win32') return;
    await ensureHostToken({ tokenFile: hostTokenFile, env: {} });
    await chmod(hostTokenFile, 0o644);
    await expect(readHostToken({ tokenFile: hostTokenFile, env: {} }))
      .rejects.toMatchObject({ code: 'token_permissions_insecure' });
    await expect(readHostToken({ tokenFile: hostTokenFile, env: {} }))
      .rejects.toBeInstanceOf(TokenError);
  });

  it('capability token 优先 env，其次文件；支持过期标记与缺失', async () => {
    const fromEnv = await readCapabilityToken({
      dataDir: dir,
      env: { MEBULAR_CAPABILITY_TOKEN: 'cap-env' },
      now: 1000,
    });
    expect(fromEnv).toMatchObject({ token: 'cap-env', source: 'env', expired: false });

    await writeJsonAtomic(join(dir, 'capability-token'), {
      version: 1,
      token: 'cap-file',
      issuedAt: 1000,
      expiresAt: 2000,
      mcpPid: 123,
    });
    const fromFile = await readCapabilityToken({ dataDir: dir, env: {}, now: 1500 });
    expect(fromFile).toMatchObject({
      token: 'cap-file',
      source: 'file',
      mcpPid: 123,
      expired: false,
    });
    expect((await stat(join(dir, 'capability-token'))).mode & 0o777).toBe(0o600);

    const expired = await readCapabilityToken({ dataDir: dir, env: {}, now: 3000 });
    expect(expired?.expired).toBe(true);

    expect(await readCapabilityToken({ dataDir: join(dir, 'missing'), env: {} })).toBeNull();
  });

  it('不安全的 capability token 权限拒绝使用', async () => {
    if (process.platform === 'win32') return;
    const path = join(dir, 'capability-token');
    await writeFile(path, JSON.stringify({ version: 1, token: 'x' }), { mode: 0o644 });
    await chmod(path, 0o644);
    await expect(readCapabilityToken({ dataDir: dir, env: {} }))
      .rejects.toMatchObject({ code: 'token_permissions_insecure' });
  });

  it('停止时只删除匹配的 host token', async () => {
    const ensured = await ensureHostToken({ tokenFile: hostTokenFile, env: {} });
    expect(await removeHostTokenIfMatches(hostTokenFile, 'other-token')).toBe(false);
    expect((await stat(hostTokenFile)).isFile()).toBe(true);
    expect(await removeHostTokenIfMatches(hostTokenFile, ensured.token)).toBe(true);
    await expect(stat(hostTokenFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('随机 token 足够长且不重复', () => {
    const a = generateHostToken();
    const b = generateHostToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });
});
