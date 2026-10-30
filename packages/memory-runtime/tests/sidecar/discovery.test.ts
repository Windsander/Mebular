// discovery：原子写入、0600、不泄露 token、pid 守卫删除、心跳与 stale 判定。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildDiscovery,
  clearDiscovery,
  isDiscoveryDead,
  isDiscoveryStale,
  readDiscovery,
  touchDiscovery,
  writeDiscovery,
} from '../../src/sidecar/discovery.js';

describe('sidecar discovery', () => {
  let home: string;
  let path: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mebular-memory-runtime-discovery-'));
    path = join(home, 'memory-runtime.json');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function make(overrides: Record<string, unknown> = {}) {
    return buildDiscovery({
      pid: 4242,
      host: '127.0.0.1',
      port: 7341,
      tokenFile: join(home, 'memory-runtime', 'host-token'),
      cloudId: 'cl_test',
      profileId: 'default',
      startedAt: 1000,
      updatedAt: 2000,
      capabilities: { ingest: false, recall: false, models: ['heuristic'] },
      ...overrides,
    });
  }

  it('原子写入 0600，字段完整且不包含 token', async () => {
    const discovery = make();
    // 即使调用方误把 token 挂在对象上，写盘时也必须被剔除。
    await writeDiscovery(path, { ...discovery, token: 'secret-token' } as typeof discovery);

    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);

    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toMatch(/"token"\s*:/);

    const parsed = await readDiscovery(path);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe('mebular-memory-runtime');
    expect(parsed?.url).toBe('http://127.0.0.1:7341/memory-runtime/v1');
    expect(parsed?.healthUrl).toBe('http://127.0.0.1:7341/memory-runtime/v1/health');
    expect(parsed?.cloudId).toBe('cl_test');
    expect(parsed?.tokenFile).toBe(join(home, 'memory-runtime', 'host-token'));

    // 没有遗留临时文件（原子写）。
    const entries = await readdir(home);
    expect(entries.filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  it('拒绝非 loopback host / 非法 pid', () => {
    expect(() => make({ host: '10.0.0.1' })).toThrow();
    expect(() => make({ pid: 0 })).toThrow();
    expect(() => make({ port: 70000 })).toThrow();
  });

  it('停止时只删除 pid 匹配的 discovery', async () => {
    await writeDiscovery(path, make());
    expect(await clearDiscovery(path, { pid: 9999 })).toBe(false);
    expect(await readDiscovery(path)).not.toBeNull();
    expect(await clearDiscovery(path, { pid: 4242 })).toBe(true);
    expect(await readDiscovery(path)).toBeNull();
    expect(await clearDiscovery(path, { pid: 4242 })).toBe(false);
  });

  it('心跳只在 pid 匹配时更新，并可判定 stale/dead', async () => {
    await writeDiscovery(path, make());
    expect(await touchDiscovery(path, { pid: 9999, now: 5000, state: 'degraded' })).toBe(false);
    expect(await touchDiscovery(path, { pid: 4242, now: 20_000, state: 'degraded', degraded: true })).toBe(true);

    const updated = await readDiscovery(path);
    expect(updated?.updatedAt).toBe(20_000);
    expect(updated?.state).toBe('degraded');
    expect(updated?.degraded).toBe(true);

    expect(isDiscoveryStale({ updatedAt: 1000 }, 1000 + 15_001)).toBe(true);
    expect(isDiscoveryStale({ updatedAt: 1000 }, 1000 + 15_000)).toBe(false);
    expect(isDiscoveryDead({ updatedAt: 1000 }, 1000 + 30_001)).toBe(true);
    expect(isDiscoveryDead({ updatedAt: 1000 }, 1000 + 30_000)).toBe(false);
  });

  it('损坏的 discovery 不会被 pid 守卫误删', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ broken', { mode: 0o600 });
    expect(await readDiscovery(path)).toBeNull();
    expect(await clearDiscovery(path, { pid: 4242 })).toBe(false);
    expect((await stat(path)).isFile()).toBe(true);
  });
});
