// Stage 1 一键上车：纯函数与安全卫生单测（不启网络；E2E 见 verify:fleet:quickstart）。
import { describe, it, expect } from '@jest/globals';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertListenAvailable,
  commandExists,
  decodeJoinCode,
  describeJoinCode,
  detectAgents,
  encodeJoinCode,
  permissionsApplicable,
  readJoinCode,
  sanitizeDeviceName,
  writeJoinCodeFile,
  type JoinCode,
} from '../../packages/fleet/src/index.js';

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'fleet-qs-unit-'));
}

const baseTrust = {
  publicKey: Buffer.from(new Uint8Array(32)).toString('base64'),
  privateKeyPkcs8: Buffer.from(new Uint8Array(48)).toString('base64'),
};

function sampleCode(overrides: Partial<JoinCode> = {}): JoinCode {
  return {
    v: 1,
    kind: 'mebular-fleet-join',
    sha: 'sha-abc',
    device: 'device-A',
    namespace: 'tasks',
    multiaddrs: ['/ip4/127.0.0.1/tcp/4001/p2p/peer-a'],
    policyIssuer: 'device-A',
    fingerprint: 'sha256:deadbeef',
    issuedAt: 1,
    trust: baseTrust,
    ...overrides,
  };
}

describe('quickstart 纯函数', () => {
  it('sanitizeDeviceName：小写、非法字符→-、去首尾、空→device', () => {
    expect(sanitizeDeviceName('MacBook-Pro.local')).toBe('macbook-pro.local');
    expect(sanitizeDeviceName('  My Laptop!  ')).toBe('my-laptop');
    expect(sanitizeDeviceName('---')).toBe('device');
    expect(sanitizeDeviceName('A__B')).toBe('a__b');
  });

  it('commandExists：PATH 命中/未命中（含 Windows PATHEXT 语义）', async () => {
    const dir = await tempDir();
    try {
      await writeFile(join(dir, 'hermes'), '#!/bin/sh\n', { mode: 0o755 });
      const env = { PATH: dir };
      expect(commandExists('hermes', env, 'linux')).toBe(true);
      expect(commandExists('nope', env, 'linux')).toBe(false);
      await writeFile(join(dir, 'hermes.EXE'), '');
      expect(commandExists('hermes', { PATH: dir, PATHEXT: '.EXE' }, 'win32')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detectAgents：hermes(PATH) / openchamber(env) / echo 兜底', () => {
    expect(detectAgents({ PATH: '', MEBULAR_FLEET_OPENCHAMBER_ENDPOINT: 'http://x' }, 'linux').agents).toEqual([
      { name: 'openchamber', kind: 'openchamber' },
    ]);
    const none = detectAgents({ PATH: '' }, 'linux');
    expect(none.agents).toEqual([{ name: 'echo', kind: 'echo' }]);
    expect(none.sources).toEqual(['echo:default']);
  });

  it('加入码 encode/decode 往返；describeJoinCode 不含信任材料', () => {
    const code = sampleCode();
    const decoded = decodeJoinCode(encodeJoinCode(code));
    expect(decoded).toEqual(code);
    const described = JSON.stringify(describeJoinCode(decoded));
    expect(described).not.toContain(code.trust.privateKeyPkcs8);
    expect(described).not.toContain('privateKeyPkcs8');
    expect(describeJoinCode(decoded).hasTrustMaterial).toBe(true);
  });

  it('decodeJoinCode：拒绝空/坏 base64/版本错/缺字段/信任材料非法', () => {
    expect(() => decodeJoinCode('')).toThrow(/空/);
    expect(() => decodeJoinCode('not-base64-@@@')).toThrow(/无法解析/);
    expect(() => decodeJoinCode(Buffer.from(JSON.stringify({ v: 2, kind: 'mebular-fleet-join' })).toString('base64'))).toThrow(/版本\/类型/);
    const missing = { ...sampleCode(), multiaddrs: undefined } as unknown;
    expect(() => decodeJoinCode(Buffer.from(JSON.stringify(missing)).toString('base64'))).toThrow(/multiaddrs/);
    const badTrust = { ...sampleCode(), trust: { publicKey: 'x' } } as unknown;
    expect(() => decodeJoinCode(Buffer.from(JSON.stringify(badTrust)).toString('base64'))).toThrow(/信任材料/);
  });

  it('writeJoinCodeFile：0600；readJoinCode：内联/文件/缺失报错', async () => {
    const dir = await tempDir();
    try {
      const path = join(dir, 'code.txt');
      await writeJoinCodeFile(path, 'abc');
      if (permissionsApplicable()) {
        const mode = (await stat(path)).mode & 0o777;
        expect(mode).toBe(0o600);
      }
      expect(await readJoinCode({ codeFile: path })).toBe('abc');
      expect(await readJoinCode({ code: 'inline' })).toBe('inline');
      await expect(readJoinCode({})).rejects.toThrow(/--code/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('assertListenAvailable：端口占用 → 清晰报错；释放后通过', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', () => resolve()));
    const port = (holder.address() as net.AddressInfo).port;
    try {
      await expect(assertListenAvailable(`/ip4/127.0.0.1/tcp/${port}`)).rejects.toThrow(/端口被占用/);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
    await expect(assertListenAvailable(`/ip4/127.0.0.1/tcp/${port}`)).resolves.toBeUndefined();
    // tcp/0 = 随机端口：跳过检查
    await expect(assertListenAvailable('/ip4/127.0.0.1/tcp/0')).resolves.toBeUndefined();
  });
});
