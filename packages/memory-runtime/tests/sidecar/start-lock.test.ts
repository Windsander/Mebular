// W3b：sidecar 启动锁（start.lock）单实例、陈旧接管、profile 冲突与 stop 清理。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireStartLock,
  clearStaleStartLock,
  isStartLockStale,
  readStartLock,
  releaseStartLock,
  updateStartLock,
  type StartLockRecord,
} from '../../src/sidecar/start-lock.js';
import { getSidecarStatus, startSidecar, type SidecarHandle } from '../../src/sidecar/main.js';

const homes: string[] = [];
const handles: SidecarHandle[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-memory-runtime-lock-'));
  homes.push(home);
  return home;
}

async function writeStaleLock(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(lockRecord({ pid: DEAD_PID })), { mode: 0o600 });
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop().catch(() => undefined);
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const DEAD_PID = 2_147_483_647;

function lockRecord(overrides: Partial<StartLockRecord> = {}): StartLockRecord {
  return {
    pid: process.pid,
    port: null,
    startedAt: 1000,
    updatedAt: 1000,
    cloudId: null,
    profileId: null,
    command: 'serve',
    ...overrides,
  };
}

describe('sidecar start.lock', () => {
  it('获取锁：0600、字段完整；update 只在 pid 匹配时生效；release 只删自己的锁', async () => {
    const home = await tempHome();
    const path = join(home, 'memory-runtime', 'start.lock');
    const acquired = await acquireStartLock({
      path,
      pid: process.pid,
      startedAt: 1234,
      now: 1234,
      cloudId: 'cl_test',
      profileId: 'default',
    });
    expect(acquired.record).toMatchObject({
      pid: process.pid,
      port: null,
      startedAt: 1234,
      cloudId: 'cl_test',
      profileId: 'default',
      command: 'serve',
    });
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }

    expect(await updateStartLock(path, { pid: 9999, now: 2000, patch: { port: 7000 } })).toBe(false);
    expect(await updateStartLock(path, {
      pid: process.pid,
      now: 2000,
      patch: { port: 7341, profileId: 'default' },
    })).toBe(true);
    expect(await readStartLock(path)).toMatchObject({ port: 7341, updatedAt: 2000 });

    expect(await releaseStartLock(path, { pid: 9999 })).toBe(false);
    expect(await readStartLock(path)).not.toBeNull();
    expect(await releaseStartLock(path, { pid: process.pid })).toBe(true);
    expect(await readStartLock(path)).toBeNull();
  });

  it('存活 pid 的锁：already_running；profile 不匹配：lock_conflict', async () => {
    const home = await tempHome();
    const path = join(home, 'memory-runtime', 'start.lock');
    await acquireStartLock({
      path,
      pid: process.pid,
      cloudId: 'cl_a',
      profileId: 'p_a',
    });

    await expect(acquireStartLock({ path, pid: process.pid + 1 })).rejects.toMatchObject({
      name: 'StartLockError',
      code: 'already_running',
      exitCode: 7,
    });
    await expect(acquireStartLock({
      path,
      pid: process.pid + 1,
      expectedCloudId: 'cl_b',
      expectedProfileId: 'p_a',
    })).rejects.toMatchObject({
      name: 'StartLockError',
      code: 'lock_conflict',
      exitCode: 7,
    });
  });

  it('陈旧锁：pid 不存在可接管；clearStaleStartLock 清理损坏/死锁', async () => {
    const home = await tempHome();
    const path = join(home, 'memory-runtime', 'start.lock');
    await writeStaleLock(path);
    expect(isStartLockStale(lockRecord({ pid: DEAD_PID }), { pidAlive: () => false })).toBe(true);
    expect(isStartLockStale(lockRecord(), { pidAlive: () => true })).toBe(false);

    const acquired = await acquireStartLock({ path, pid: process.pid });
    expect(acquired.record.pid).toBe(process.pid);
    expect(await readStartLock(path)).toMatchObject({ pid: process.pid });

    await writeFile(path, JSON.stringify(lockRecord({ pid: DEAD_PID })), { mode: 0o600 });
    expect(await clearStaleStartLock(path, { pidAlive: () => false })).toBe(true);
    expect(await readStartLock(path)).toBeNull();
  });

  it('startSidecar 单实例：第二次 already_running/exit 7；stop 释放锁，之后可重新启动', async () => {
    const home = await tempHome();
    const env = { MEBULAR_HOME: home };
    const first = await startSidecar({
      home,
      port: 0,
      skipHandshake: true,
      hostToken: 'host-token',
      env,
    });
    handles.push(first);

    const lockPath = join(home, 'memory-runtime', 'start.lock');
    expect(await readStartLock(lockPath)).toMatchObject({
      pid: process.pid,
      port: first.discovery.port,
      command: 'serve',
    });
    if (process.platform !== 'win32') {
      expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    }
    expect((await getSidecarStatus({ home, env })).lock).toMatchObject({
      pid: process.pid,
      stale: false,
    });

    await expect(startSidecar({
      home,
      port: 0,
      skipHandshake: true,
      hostToken: 'host-token-2',
      env,
    })).rejects.toMatchObject({ code: 'already_running', exitCode: 7 });

    await first.stop();
    handles.splice(handles.indexOf(first), 1);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const second = await startSidecar({
      home,
      port: 0,
      skipHandshake: true,
      hostToken: 'host-token-3',
      env,
    });
    handles.push(second);
    expect(second.discovery.pid).toBe(process.pid);
    expect(await readStartLock(lockPath)).toMatchObject({ pid: process.pid, port: second.discovery.port });
  });

  it('startSidecar 接管陈旧锁并写入自己的 pid/port', async () => {
    const home = await tempHome();
    const lockPath = join(home, 'memory-runtime', 'start.lock');
    await writeStaleLock(lockPath);

    const handle = await startSidecar({
      home,
      port: 0,
      skipHandshake: true,
      hostToken: 'host-token',
      env: { MEBULAR_HOME: home },
    });
    handles.push(handle);

    const lock = await readStartLock(lockPath);
    expect(lock).toMatchObject({ pid: process.pid, port: handle.discovery.port });
    expect(JSON.stringify(lock)).not.toContain('host-token');
    const raw = await readFile(lockPath, 'utf8');
    expect(raw).not.toContain('host-token');
  });
});
