// W2a：capability token 的生成/落盘/权限/覆盖/校验（不启动 HTTP）。
import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITY_TOKEN_DIR,
  CAPABILITY_TOKEN_FILE,
  capabilityTokenDir,
  capabilityTokenPath,
  ensureCapabilityToken,
  generateCapabilityToken,
  hashCapabilityToken,
  readCapabilityToken,
  removeCapabilityToken,
  tokenIdForToken,
  verifyCapabilityToken,
} from '../../packages/mcp/src/memory-runtime-token.mjs';

const dirs = [];

afterEach(async () => {
  while (dirs.length > 0) {
    await rm(dirs.pop(), { recursive: true, force: true });
  }
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'memory-capability-token-'));
  dirs.push(home);
  return home;
}

describe('memory capability token', () => {
  it('生成 ≥32 字节随机 base64url，且每次不同', () => {
    const a = generateCapabilityToken();
    const b = generateCapabilityToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(Buffer.from(a, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(b);
    expect(hashCapabilityToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenIdForToken(a)).toMatch(/^tok_[0-9a-f]{16}$/);
  });

  it('写入 memory-runtime/capability-token：目录 0700、文件 0600，内容只含约定字段', async () => {
    const home = await tempHome();
    expect(capabilityTokenDir(home)).toBe(join(home, CAPABILITY_TOKEN_DIR));
    expect(capabilityTokenPath(home)).toBe(join(home, CAPABILITY_TOKEN_DIR, CAPABILITY_TOKEN_FILE));

    const record = await ensureCapabilityToken({ home, env: {}, now: 1_700_000_000_000 });
    if (process.platform !== 'win32') {
      const dirMode = (await stat(capabilityTokenDir(home))).mode & 0o777;
      const fileMode = (await stat(capabilityTokenPath(home))).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }

    const raw = JSON.parse(await readFile(capabilityTokenPath(home), 'utf-8'));
    expect(Object.keys(raw).sort()).toEqual(['expiresAt', 'issuedAt', 'mcpPid', 'token', 'version'].sort());
    expect(raw.token).toBe(record.token);
    expect(raw.version).toBe(1);
    expect(raw.issuedAt).toBe(1_700_000_000_000);
    expect(raw.expiresAt).toBeGreaterThan(raw.issuedAt);

    const read = await readCapabilityToken({ home, env: {}, now: 1_700_000_000_001 });
    expect(read?.token).toBe(record.token);
    expect(read?.source).toBe('file');
    expect(read?.tokenHash).toBe(record.tokenHash);
    expect(read?.expired).toBe(false);
  });

  it('MEBULAR_CAPABILITY_TOKEN 覆盖：不创建目录/文件', async () => {
    const home = await tempHome();
    const token = 'test-override-token-0123456789abcdefghijklmnopqrstuvwxyz';
    const record = await ensureCapabilityToken({ home, env: { MEBULAR_CAPABILITY_TOKEN: token } });
    expect(record.token).toBe(token);
    expect(record.source).toBe('env');
    expect(record.file).toBeNull();
    await expect(stat(capabilityTokenDir(home))).rejects.toThrow();

    const read = await readCapabilityToken({ home, env: { MEBULAR_CAPABILITY_TOKEN: token } });
    expect(read?.source).toBe('env');
    expect(read?.token).toBe(token);
  });

  it('校验：正确 token 通过，错误/过期 token 拒绝', async () => {
    const home = await tempHome();
    const record = await ensureCapabilityToken({ home, env: {}, now: 1000, ttlMs: 60_000 });
    expect(verifyCapabilityToken(record.token, record, { now: 2000 })).toBe(true);
    expect(verifyCapabilityToken(`${record.token}x`, record, { now: 2000 })).toBe(false);
    expect(verifyCapabilityToken('', record, { now: 2000 })).toBe(false);
    expect(verifyCapabilityToken(record.token, record, { now: 1000 + 60_000 })).toBe(false);
  });

  it('removeCapabilityToken 只删文件、不删目录', async () => {
    const home = await tempHome();
    await ensureCapabilityToken({ home, env: {}, now: 1000 });
    await removeCapabilityToken({ home });
    await expect(stat(capabilityTokenPath(home))).rejects.toThrow();
    expect((await stat(capabilityTokenDir(home))).isDirectory()).toBe(true);
  });
});
