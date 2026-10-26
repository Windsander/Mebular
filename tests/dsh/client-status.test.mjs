// DSH client 状态源：状态映射、共享订阅与去重轮询。
// 这些测试通过 client 的 opt-in __test seam 构造隔离 store，不引入新的运行时依赖。

import { describe, it, expect, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', '..', 'packages', 'dsh-plugin', 'client.js');
const source = readFileSync(clientPath, 'utf-8');

const READY_INFO = {
  ok: true,
  status: 'up',
  loopback: true,
  embedProtocol: 1,
  consoleUrl: 'http://127.0.0.1:7331/console',
  embedUrl: 'http://127.0.0.1:7331/console/?embed=dsh',
};

function loadClientInternals({ lang = 'en' } = {}) {
  let registration = null;
  const fakeWindow = {
    __MEBULAR_DSH_TEST__: true,
    __ModuleLoader__: {
      load(value) {
        registration = value;
      },
    },
  };
  const fakeDocument = { documentElement: { lang } };
  runInNewContext(source, { window: fakeWindow, document: fakeDocument, URL }, { filename: clientPath });
  expect(registration).not.toBeNull();
  const exported = registration.factory((name) => {
    expect(name).toBe('react');
    return { createElement: () => null, useEffect: () => {}, useState: () => [null, () => {}] };
  });
  return exported.__test;
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function fakeClock() {
  let nextId = 0;
  const intervals = new Map();
  return {
    setIntervalFn(fn, ms) {
      nextId += 1;
      intervals.set(nextId, { fn, ms });
      return nextId;
    },
    clearIntervalFn(timer) {
      intervals.delete(timer);
    },
    tick() {
      for (const interval of [...intervals.values()]) interval.fn();
    },
    count() {
      return intervals.size;
    },
    delays() {
      return [...intervals.values()].map((interval) => interval.ms);
    },
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('DSH client 状态映射', () => {
  it('把 embed-info 映射为 connected/starting/unavailable/offline/checking', () => {
    const { statusOf } = loadClientInternals();

    expect(statusOf(null, true, false, null)).toBe('checking');
    expect(statusOf(READY_INFO, false, true, null)).toBe('connected');
    expect(statusOf({ status: 'starting' }, false, false, null)).toBe('starting');
    expect(statusOf({ status: 'up' }, false, false, null)).toBe('unavailable');
    expect(statusOf({ status: 'down' }, false, false, null)).toBe('offline');
    expect(statusOf(null, false, false, 'HTTP 500')).toBe('offline');
    expect(statusOf(READY_INFO, false, true, 'HTTP 500')).toBe('offline');
  });

  it('只有完整且 loopback 的 embed 契约才算 ready', () => {
    const { isReadyInfo } = loadClientInternals();

    expect(isReadyInfo(READY_INFO)).toBe(true);
    expect(isReadyInfo({ ...READY_INFO, embedProtocol: 2 })).toBe(false);
    expect(isReadyInfo({ ...READY_INFO, loopback: false })).toBe(false);
    expect(isReadyInfo({ ...READY_INFO, ok: false })).toBe(false);
    expect(isReadyInfo({ ...READY_INFO, embedUrl: 'http://10.0.0.5:7331/console/?embed=dsh' })).toBe(false);
    expect(isReadyInfo(null)).toBe(false);
  });

  it('状态点颜色遵循 up=绿、starting=琥珀、down=红、unknown=灰', () => {
    const { dotColor } = loadClientInternals();

    expect(dotColor('connected')).toContain('state-success');
    expect(dotColor('starting')).toContain('state-warn');
    expect(dotColor('unavailable')).toContain('state-warn');
    expect(dotColor('offline')).toContain('state-error');
    expect(dotColor('checking')).toContain('label-tertiary');
    expect(dotColor('unknown')).toContain('label-tertiary');
  });

  it('title 始终包含 Mebular 与当前状态，不依赖颜色', () => {
    const { statusTitle } = loadClientInternals();
    const text = { title: 'Mebular', checking: 'Connecting', connected: 'Connected', offline: 'Offline' };

    expect(statusTitle(text, 'connected')).toBe('Mebular: Connected');
    expect(statusTitle(text, 'offline')).toBe('Mebular: Offline');
    expect(statusTitle(text, 'unknown')).toBe('Mebular: Connecting');
  });
});

describe('DSH client 共享 runtime 状态文案', () => {
  const REASONS = [
    'download_required', 'provisioning', 'service_conflict', 'profile_mismatch',
    'version_mismatch', 'managed_cli_missing', 'instance_mismatch', 'instance_missing',
    'cloud_mismatch', 'CLOUD_ALREADY_ACTIVE', 'port_in_use', 'service_unknown',
    'service_foreign', 'service_not_registered', 'supervise_failed', 'child_exited',
    'runtime_resolve_failed', 'start_locked',
  ];

  it('en 为每个共享 runtime reason 提供专门文案，不落到 unknown', () => {
    const { reasonMessage, text } = loadClientInternals();
    const t = text();
    for (const reason of REASONS) {
      expect(typeof t.reasons[reason]).toBe('string');
      expect(t.reasons[reason].length).toBeGreaterThan(20);
      expect(reasonMessage(t, { reason }, null)).toBe(t.reasons[reason]);
      expect(reasonMessage(t, { reason }, null)).not.toBe(t.reasons.unknown);
    }
  });

  it('zh 文案提示打开 App / 安装 CLI / 常驻，不承诺自动下载', () => {
    const { reasonMessage, text } = loadClientInternals({ lang: 'zh' });
    const t = text();
    expect(t.reasons.download_required).toContain('Mebular App');
    expect(t.reasons.download_required).toContain('安装 Mebular CLI');
    expect(t.reasons.download_required).toContain('不会自动下载');
    expect(t.reasons.service_not_registered).toContain('常驻');
    expect(t.reasons.provisioning).toContain('supervisor');
    expect(reasonMessage(t, { reason: 'download_required' }, null)).toBe(t.reasons.download_required);
  });

  it('runtimeMeta 只汇总非敏感字段', () => {
    const { runtimeMeta, text } = loadClientInternals();
    const t = text();
    expect(runtimeMeta(t, {
      profile: { id: 'work', name: 'Work' },
      provider: { kind: 'app' },
      runtimeMode: 'child',
      service: { registered: true, running: true },
    })).toBe('Work · app · child · service running');
    expect(runtimeMeta(t, { profile: { id: 'work', name: null } })).toBe('work');
    expect(runtimeMeta(t, null)).toBe('');
  });

  it('download_required 不是 ready，状态点为 offline', () => {
    const { isReadyInfo, statusOf } = loadClientInternals();
    const info = {
      ok: false,
      status: 'down',
      state: 'download_required',
      reason: 'download_required',
      downloadRequired: true,
      loopback: false,
      embedUrl: null,
    };
    expect(isReadyInfo(info)).toBe(false);
    expect(statusOf(info, false, false, null)).toBe('offline');
  });
});

describe('DSH client 共享状态 store', () => {
  it('多个订阅者只启动一次轮询和一个 interval', async () => {
    const clock = fakeClock();
    const fetchImpl = jest.fn(async () => jsonResponse(READY_INFO));
    const { createEmbedInfoStore } = loadClientInternals();
    const store = createEmbedInfoStore({
      fetchImpl,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
    });
    const first = jest.fn();
    const second = jest.fn();

    const unsubscribeFirst = store.subscribe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(clock.count()).toBe(1);
    expect(clock.delays()).toEqual([2500]);

    const unsubscribeSecond = store.subscribe(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(clock.count()).toBe(1);

    await flush();
    expect(store.getSnapshot()).toMatchObject({ status: 'connected', ready: true, error: null });
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();

    clock.tick();
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    unsubscribeFirst();
    expect(clock.count()).toBe(1);
    unsubscribeSecond();
    expect(clock.count()).toBe(0);

    clock.tick();
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('手动 refresh 复用进行中的请求，不叠加轮询', async () => {
    const clock = fakeClock();
    const pending = deferred();
    const fetchImpl = jest.fn(() => pending.promise);
    const { createEmbedInfoStore } = loadClientInternals();
    const store = createEmbedInfoStore({
      fetchImpl,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
    });

    const first = store.refresh();
    const second = store.refresh();
    expect(first).toBe(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    pending.resolve(jsonResponse(READY_INFO));
    await first;
    await flush();
    expect(store.getSnapshot().status).toBe('connected');
  });

  it('请求失败清掉上次状态，回到 offline/red', async () => {
    const clock = fakeClock();
    let response = jsonResponse(READY_INFO);
    const fetchImpl = jest.fn(async () => response);
    const { createEmbedInfoStore } = loadClientInternals();
    const store = createEmbedInfoStore({
      fetchImpl,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
    });

    const unsubscribe = store.subscribe(() => {});
    await flush();
    expect(store.getSnapshot().status).toBe('connected');

    response = jsonResponse({ error: 'down' }, { ok: false, status: 503 });
    clock.tick();
    await flush();
    expect(store.getSnapshot()).toMatchObject({
      info: null,
      error: 'HTTP 503',
      ready: false,
      status: 'offline',
    });
    unsubscribe();
  });

  it('starting 状态即使 daemon 不可达也不被误判为 offline', async () => {
    const clock = fakeClock();
    const fetchImpl = async () => jsonResponse({ ok: false, status: 'starting', embedUrl: null });
    const { createEmbedInfoStore } = loadClientInternals();
    const store = createEmbedInfoStore({
      fetchImpl,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
    });

    const unsubscribe = store.subscribe(() => {});
    await flush();
    expect(store.getSnapshot()).toMatchObject({ ready: false, status: 'starting' });
    unsubscribe();
  });
});
