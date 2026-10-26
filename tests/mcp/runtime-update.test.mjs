// Phase 5b1 · 共享 runtime 更新检查：固定来源、semver、TTL/失败防抖、state/lock。
//
// 全程离线：registry 由 fake fetch 注入；时钟/锁 PID 存活/state 写入均可注入；
// 不安装、不启动 daemon、不访问真实 npm。

import { describe, it, expect, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_UPDATE_SOURCE_URL,
  RUNTIME_UPDATE_TTL_MS,
  RUNTIME_UPDATE_FAILURE_TTL_MS,
  checkRuntimeUpdate,
  compareSemver,
  isStableSemver,
  parseSemver,
  readRuntimeUpdateState,
  runtimeUpdateExitCode,
  runtimeUpdateLockPath,
  runtimeUpdateStatePath,
  setRuntimeUpdateSkippedVersion,
} from '../../packages/mcp/src/runtime-update.mjs';import { readRuntimeCurrent, writeRuntimeCurrent } from '../../packages/mcp/src/runtime-current.mjs';
import { pidAlive } from '../../packages/mcp/src/profiles.mjs';

const tempDirs = [];

async function tempDir(prefix = 'runtime-update-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeClock(start = '2026-01-01T00:00:00.000Z') {
  let value = Date.parse(start);
  return {
    now: () => new Date(value),
    advance: (ms) => { value += ms; },
    set: (iso) => { value = Date.parse(iso); },
  };
}

async function writeRuntime(root, version) {
  const runtimePath = join(root, 'runtime', version);
  const core = join(runtimePath, 'node_modules', '@mebular', 'core');
  await mkdir(join(core, 'packages', 'mcp', 'bin'), { recursive: true });
  await writeFile(join(core, 'package.json'), JSON.stringify({ name: '@mebular/core', version }), 'utf-8');
  const cliPath = join(core, 'packages', 'mcp', 'bin', 'mebular.mjs');
  await writeFile(cliPath, '// fake runtime\n', 'utf-8');
  return { runtimePath, cliPath };
}

async function makeRoot({ current = '0.1.2' } = {}) {
  const root = await tempDir();
  if (current !== null) {
    const runtime = await writeRuntime(root, current);
    await writeRuntimeCurrent(root, {
      version: current,
      runtimePath: runtime.runtimePath,
      cliPath: runtime.cliPath,
      provider: 'shared',
      owner: 'shared',
      installedAt: '2026-01-01T00:00:00.000Z',
    });
  }
  return root;
}

function registryFetch(version, { name = '@mebular/core', status = 200, body = null } = {}) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (body ?? { name, version }),
    };
  };
  fn.calls = calls;
  return fn;
}

function failingFetch(error, status = null) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url, options });
    if (status !== null) {
      return { ok: false, status, json: async () => ({}) };
    }
    throw error;
  };
  fn.calls = calls;
  return fn;
}

function baseOptions(root, clock, fetchImpl, extra = {}) {
  return {
    root,
    now: clock.now,
    fetchImpl,
    pidAliveFn: () => false,
    lockRetryMs: 5,
    ...extra,
  };
}

async function readStateFile(root) {
  return JSON.parse(await readFile(runtimeUpdateStatePath(root), 'utf-8'));
}

describe('runtime update semver', () => {
  it('覆盖 0.1.2 vs 0.10.0 与 prerelease/build metadata', () => {
    expect(compareSemver('0.1.2', '0.10.0')).toBe(-1);
    expect(compareSemver('0.10.0', '0.1.2')).toBe(1);
    expect(compareSemver('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1);
    expect(compareSemver('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0+build.1', '1.0.0+build.2')).toBe(0);
    expect(compareSemver('1.0.0+abc', '1.0.0')).toBe(0);
    expect(isStableSemver('1.2.3+build.9')).toBe(true);
    expect(isStableSemver('1.2.3-beta.1')).toBe(false);
    expect(isStableSemver('not-a-version')).toBe(false);
    expect(parseSemver('v1.2.3')).toBeNull();
    expect(parseSemver('1.2.3-01')).toBeNull();
  });
});

describe('runtime update check', () => {
  it('首次检查：latest > current → update_available，并原子写 0600 state', async () => {
    const root = await makeRoot();
    const clock = makeClock();
    const fetchImpl = registryFetch('0.2.0');

    const result = await checkRuntimeUpdate(baseOptions(root, clock, fetchImpl));

    expect(result).toMatchObject({
      ok: true,
      action: 'check-update',
      status: 'update_available',
      decision: 'update_available',
      available: true,
      skipped: false,
      cached: false,
      force: false,
      currentVersion: '0.1.2',
      latestVersion: '0.2.0',
      currentSource: 'main',
    });
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].url).toBe(RUNTIME_UPDATE_SOURCE_URL);
    expect(fetchImpl.calls[0].options.headers).toEqual({ accept: 'application/json' });
    expect(fetchImpl.calls[0].options.headers.authorization).toBeUndefined();

    const state = await readStateFile(root);
    expect(state).toMatchObject({
      v: 1,
      lastCheckedAt: '2026-01-01T00:00:00.000Z',
      lastAttemptAt: '2026-01-01T00:00:00.000Z',
      lastAttemptOk: true,
      latest: '0.2.0',
      current: '0.1.2',
      available: true,
      skippedVersion: null,
      reason: null,
      failureReason: null,
      source: RUNTIME_UPDATE_SOURCE_URL,
    });
    const mode = (await stat(runtimeUpdateStatePath(root))).mode & 0o777;
    expect(mode).toBe(0o600);
    const leftovers = (await readdir(join(root, 'runtime')))
      .filter((name) => name.startsWith('update-state.json.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('相等或更低 → up_to_date；0.1.2 vs 0.10.0 正确判为更新', async () => {
    const root = await makeRoot();
    const clock = makeClock();
    const equal = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.1.2')));
    expect(equal).toMatchObject({ ok: true, status: 'up_to_date', available: false, latestVersion: '0.1.2' });

    const lower = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.0.9'), { force: true }));
    expect(lower).toMatchObject({ ok: true, status: 'up_to_date', available: false });

    const newer = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.10.0'), { force: true }));
    expect(newer).toMatchObject({ ok: true, status: 'update_available', available: true });
    expect(compareSemver(newer.latestVersion, newer.currentVersion)).toBeGreaterThan(0);
  });

  it('current 缺失 → current_missing，不自动升级；仍记录 latest', async () => {
    const root = await makeRoot({ current: null });
    const clock = makeClock();
    const result = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.2.0')));

    expect(result).toMatchObject({
      ok: true,
      status: 'current_missing',
      decision: 'current_missing',
      available: false,
      currentVersion: null,
      latestVersion: '0.2.0',
      currentSource: 'missing',
    });
    const state = await readStateFile(root);
    expect(state).toMatchObject({ latest: '0.2.0', current: null, available: false, reason: 'current_missing' });
  });

  it('build metadata 不影响判断；prerelease 不当 stable 更新', async () => {
    const root = await makeRoot();
    const clock = makeClock();
    const build = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.1.2+build.9')));
    expect(build).toMatchObject({ ok: true, status: 'up_to_date', available: false });

    const pre = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.2.0-beta.1'), { force: true }));
    expect(pre).toMatchObject({
      ok: false,
      status: 'prerelease_ignored',
      reason: 'prerelease_ignored',
      available: false,
      latestVersion: '0.1.2+build.9',
    });
    const state = await readStateFile(root);
    expect(state.lastCheckedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.lastAttemptOk).toBe(false);
    expect(state.failureReason).toBe('prerelease_ignored');
  });

  it('skipVersion 命中 → skipped/available:false；后续检查沿用 state 中的跳过版本', async () => {
    const root = await makeRoot();
    const clock = makeClock();
    const first = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.2.0'), {
      skipVersion: '0.2.0',
    }));
    expect(first).toMatchObject({
      ok: true,
      status: 'skipped',
      decision: 'skipped',
      available: false,
      skipped: true,
      skippedVersion: '0.2.0',
    });
    expect(await readStateFile(root)).toMatchObject({ skippedVersion: '0.2.0', available: false });

    const second = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.2.0'), { force: true }));
    expect(second).toMatchObject({ status: 'skipped', skipped: true, available: false });

    const buildEquivalent = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.2.0+build.1'), {
      force: true,
    }));
    expect(buildEquivalent).toMatchObject({ status: 'skipped', skipped: true, available: false });

    const set = await setRuntimeUpdateSkippedVersion(root, null, { now: clock.now().toISOString() });
    expect(set.state.skippedVersion).toBeNull();
    await expect(setRuntimeUpdateSkippedVersion(root, '0.2.0-beta.1')).rejects.toMatchObject({
      code: 'unsupported_version',
    });
  });

  it('24h 节流返回缓存，不重复请求；--force 绕过；过期后重新请求', async () => {
    const root = await makeRoot();
    const clock = makeClock();
    const fetchImpl = registryFetch('0.2.0');
    const first = await checkRuntimeUpdate(baseOptions(root, clock, fetchImpl));
    expect(first.status).toBe('update_available');
    expect(fetchImpl.calls).toHaveLength(1);

    clock.advance(60 * 60 * 1000);
    const cached = await checkRuntimeUpdate(baseOptions(root, clock, fetchImpl));
    expect(cached).toMatchObject({
      ok: true,
      status: 'throttled',
      decision: 'update_available',
      available: true,
      cached: true,
      stale: false,
      throttled: true,
      lastCheckedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(fetchImpl.calls).toHaveLength(1);

    const forced = await checkRuntimeUpdate(baseOptions(root, clock, fetchImpl, { force: true }));
    expect(forced).toMatchObject({ status: 'update_available', cached: false });
    expect(fetchImpl.calls).toHaveLength(2);

    clock.advance(RUNTIME_UPDATE_TTL_MS);
    const expired = await checkRuntimeUpdate(baseOptions(root, clock, fetchImpl));
    expect(expired.status).toBe('update_available');
    expect(fetchImpl.calls).toHaveLength(3);
  });

  it('离线/4xx/5xx/timeout/非法 JSON → 稳定 reason，不抛错', async () => {
    const cases = [];
    const offline = new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    offline.cause = { code: 'ENOTFOUND' };
    cases.push({
      name: 'offline',
      fetchImpl: failingFetch(offline),
      expect: { status: 'offline', httpStatus: null },
    });
    cases.push({
      name: '404',
      fetchImpl: failingFetch(null, 404),
      expect: { status: 'http_error', httpStatus: 404 },
    });
    cases.push({
      name: '500',
      fetchImpl: failingFetch(null, 500),
      expect: { status: 'http_error', httpStatus: 500 },
    });
    cases.push({
      name: 'invalid-json',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }),
      expect: { status: 'invalid_response' },
    });
    cases.push({
      name: 'wrong-name',
      fetchImpl: registryFetch('0.2.0', { name: '@evil/core' }),
      expect: { status: 'invalid_response' },
    });
    cases.push({
      name: 'invalid-version',
      fetchImpl: registryFetch('not-semver'),
      expect: { status: 'invalid_response' },
    });

    for (const item of cases) {
      const root = await makeRoot();
      const clock = makeClock();
      const result = await checkRuntimeUpdate(baseOptions(root, clock, item.fetchImpl));
      expect({ name: item.name, status: result.status, ok: result.ok }).toEqual({
        name: item.name,
        status: item.expect.status,
        ok: false,
      });
      expect(result.available).toBe(false);
      if (item.expect.httpStatus !== undefined) expect(result.httpStatus).toBe(item.expect.httpStatus);
      const state = await readStateFile(root);
      expect(state.lastCheckedAt).toBeNull();
      expect(state.lastAttemptOk).toBe(false);
      expect(state.failureReason).toBe(item.expect.status);
    }

    const root = await makeRoot();
    const clock = makeClock();
    const timeoutFetch = async (url, { signal }) => new Promise((resolvePromise, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
    const timeout = await checkRuntimeUpdate(baseOptions(root, clock, timeoutFetch, { timeoutMs: 5 }));
    expect(timeout).toMatchObject({ ok: false, status: 'timeout', available: false });
  });

  it('失败不推进 lastCheckedAt，失败 TTL 防抖；到期后重试', async () => {
    const root = await makeRoot();
    const clock = makeClock();
    const offline = new Error('offline');
    offline.cause = { code: 'ENOTFOUND' };
    const failed = await checkRuntimeUpdate(baseOptions(root, clock, failingFetch(offline)));
    expect(failed.status).toBe('offline');
    let state = await readStateFile(root);
    expect(state.lastCheckedAt).toBeNull();
    expect(state.lastAttemptAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.lastAttemptOk).toBe(false);

    clock.advance(60 * 1000);
    const backoffFetch = registryFetch('0.2.0');
    const backoff = await checkRuntimeUpdate(baseOptions(root, clock, backoffFetch));
    expect(backoff).toMatchObject({
      ok: true,
      status: 'throttled',
      reason: 'failure_backoff',
      cached: true,
      stale: true,
      available: false,
      failureReason: 'offline',
    });
    expect(backoffFetch.calls).toHaveLength(0);

    clock.advance(RUNTIME_UPDATE_FAILURE_TTL_MS);
    const retried = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.2.0')));
    expect(retried.status).toBe('update_available');
    state = await readStateFile(root);
    expect(state.lastCheckedAt).toBe(clock.now().toISOString());
    expect(state.failureReason).toBeNull();
  });

  it('成功后失败：保留 lastCheckedAt/latest，只写失败尝试', async () => {
    const root = await makeRoot();
    const clock = makeClock();
    await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.1.2')));
    clock.advance(60 * 60 * 1000);
    const offline = new Error('offline');
    offline.cause = { code: 'ENOTFOUND' };
    const failed = await checkRuntimeUpdate(baseOptions(root, clock, failingFetch(offline), { force: true }));

    expect(failed).toMatchObject({ ok: false, status: 'offline', available: false });
    const state = await readStateFile(root);
    expect(state.lastCheckedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state.lastAttemptAt).toBe('2026-01-01T01:00:00.000Z');
    expect(state.lastAttemptOk).toBe(false);
    expect(state.latest).toBe('0.1.2');
    expect(state.failureReason).toBe('offline');
  });

  it('固定来源：忽略 url/registry/source 选项；不发送凭据', async () => {
    const root = await makeRoot();
    const clock = makeClock();
    const fetchImpl = registryFetch('0.2.0');
    const result = await checkRuntimeUpdate(baseOptions(root, clock, fetchImpl, {
      url: 'https://evil.example/@mebular/core/latest',
      registry: 'https://evil.example',
      source: 'https://evil.example',
    }));
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].url).toBe(RUNTIME_UPDATE_SOURCE_URL);
    expect(result.source).toMatchObject({
      kind: 'npm',
      package: '@mebular/core',
      channel: 'stable',
      url: RUNTIME_UPDATE_SOURCE_URL,
    });
    expect(JSON.stringify(result)).not.toMatch(/evil\.example/);
  });

  it('state 不含响应中的秘密；损坏 state 回退为空并可自愈', async () => {
    const root = await makeRoot();
    const clock = makeClock();
    const fetchImpl = registryFetch('0.2.0', {
      body: { name: '@mebular/core', version: '0.2.0', token: 'super-secret', auth: 'Bearer nope' },
    });
    const result = await checkRuntimeUpdate(baseOptions(root, clock, fetchImpl));
    expect(JSON.stringify(result)).not.toMatch(/super-secret|Bearer nope/);
    const stateText = await readFile(runtimeUpdateStatePath(root), 'utf-8');
    expect(stateText).not.toMatch(/super-secret|Bearer nope|token/);

    await writeFile(runtimeUpdateStatePath(root), '{ not json', 'utf-8');
    clock.advance(1000);
    const recovered = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.2.0')));
    expect(recovered).toMatchObject({ ok: true, status: 'update_available' });
    expect(recovered.warnings.join('\n')).toMatch(/update-state 无法解析/);
    expect(JSON.parse(await readFile(runtimeUpdateStatePath(root), 'utf-8')).latest).toBe('0.2.0');
  });

  it('state 写入失败不破坏检查结果', async () => {
    const root = await makeRoot();
    const clock = makeClock();
    const result = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.2.0'), {
      writeStateFn: async () => { throw new Error('EACCES'); },
    }));
    expect(result).toMatchObject({ ok: true, status: 'update_available', available: true });
    expect(result.warnings).toContain('update_state_write_failed');
  });

  it('runningVersion 来自注入/探测/state，不阻塞检查', async () => {
    const root = await makeRoot();
    const clock = makeClock();
    const injected = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.2.0'), {
      runningVersion: '0.1.1',
    }));
    expect(injected.runningVersion).toBe('0.1.1');
    expect(await readStateFile(root)).toMatchObject({ runningVersion: '0.1.1' });

    const detected = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.2.0'), {
      force: true,
      detectRunningVersion: async () => '0.1.1',
    }));
    expect(detected.runningVersion).toBe('0.1.1');

    const thrown = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.2.0'), {
      force: true,
      detectRunningVersion: async () => { throw new Error('health probe failed'); },
    }));
    expect(thrown).toMatchObject({ ok: true, status: 'update_available', runningVersion: '0.1.1' });

    const cached = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.2.0')));
    expect(cached).toMatchObject({ status: 'throttled', runningVersion: '0.1.1' });
  });

  it('两个入口并发：一个请求，另一个 busy；完成后释放锁', async () => {
    const root = await makeRoot();
    const clock = makeClock();
    let releaseFetch;
    const gate = new Promise((resolvePromise) => { releaseFetch = resolvePromise; });
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      await gate;
      return { ok: true, status: 200, json: async () => ({ name: '@mebular/core', version: '0.2.0' }) };
    };

    const firstPromise = checkRuntimeUpdate(baseOptions(root, clock, fetchImpl, {
      pidAliveFn: pidAlive,
      lockAttempts: 2,
      lockRetryMs: 5,
    }));
    const lockPath = runtimeUpdateLockPath(root);
    for (let i = 0; i < 100 && !existsSync(lockPath); i += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
    }
    expect(existsSync(lockPath)).toBe(true);

    const second = await checkRuntimeUpdate(baseOptions(root, clock, fetchImpl, {
      pidAliveFn: pidAlive,
      lockAttempts: 2,
      lockRetryMs: 5,
    }));
    expect(second).toMatchObject({ ok: true, status: 'busy', reason: 'busy', busy: true, available: false });
    expect(calls).toHaveLength(1);

    releaseFetch();
    const first = await firstPromise;
    expect(first).toMatchObject({ ok: true, status: 'update_available' });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('陈旧/损坏/超龄锁可回收；活锁 busy 不无限等待', async () => {
    const clock = makeClock();
    const lockPayload = (pid, startedAt, token = 'old') => `${JSON.stringify({ v: 1, pid, token, startedAt, command: 'check-update' })}\n`;

    const deadRoot = await makeRoot();
    await mkdir(join(deadRoot, 'runtime'), { recursive: true });
    await writeFile(runtimeUpdateLockPath(deadRoot), lockPayload(999999, clock.now().toISOString()), 'utf-8');
    const dead = await checkRuntimeUpdate(baseOptions(deadRoot, clock, registryFetch('0.2.0')));
    expect(dead.status).toBe('update_available');
    expect(existsSync(runtimeUpdateLockPath(deadRoot))).toBe(false);

    const corruptRoot = await makeRoot();
    await mkdir(join(corruptRoot, 'runtime'), { recursive: true });
    await writeFile(runtimeUpdateLockPath(corruptRoot), 'not json', 'utf-8');
    const corrupt = await checkRuntimeUpdate(baseOptions(corruptRoot, clock, registryFetch('0.2.0')));
    expect(corrupt.status).toBe('update_available');

    const agedRoot = await makeRoot();
    await mkdir(join(agedRoot, 'runtime'), { recursive: true });
    await writeFile(runtimeUpdateLockPath(agedRoot), lockPayload(process.pid, '2020-01-01T00:00:00.000Z'), 'utf-8');
    const aged = await checkRuntimeUpdate(baseOptions(agedRoot, clock, registryFetch('0.2.0'), {
      pidAliveFn: pidAlive,
      lockStaleMs: 1000,
    }));
    expect(aged.status).toBe('update_available');

    const liveRoot = await makeRoot();
    await mkdir(join(liveRoot, 'runtime'), { recursive: true });
    await writeFile(runtimeUpdateLockPath(liveRoot), lockPayload(process.pid, clock.now().toISOString()), 'utf-8');
    const liveFetch = registryFetch('0.2.0');
    const live = await checkRuntimeUpdate(baseOptions(liveRoot, clock, liveFetch, {
      pidAliveFn: pidAlive,
      lockAttempts: 2,
      lockRetryMs: 2,
    }));
    expect(live).toMatchObject({ ok: true, status: 'busy', busy: true });
    expect(liveFetch.calls).toHaveLength(0);
  });

  it('update-state show 摘要与退出码语义', async () => {
    const root = await makeRoot();
    const clock = makeClock();
    const result = await checkRuntimeUpdate(baseOptions(root, clock, registryFetch('0.2.0')));
    expect(runtimeUpdateExitCode(result)).toBe(0);
    expect(runtimeUpdateExitCode({ ok: false })).toBe(2);

    const state = await readRuntimeUpdateState(root);
    expect(state.source).toBe('main');
    expect(state.state).toMatchObject({ latest: '0.2.0', current: '0.1.2', available: true });
    expect(JSON.stringify(state.state)).not.toMatch(/token|secret|authorization/i);

    const current = await readRuntimeCurrent(root);
    expect(current.usable).toBe(true);
  });
});
