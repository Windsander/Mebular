import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundedOutbox } from '../../src/sidecar/local-layer.js';
import { CapabilityClientError } from '../../src/sidecar/capability-client.js';
import { OutboxReplayer } from '../../src/sidecar/outbox-replayer.js';

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function setup(now: () => number) {
  const home = await mkdtemp(join(tmpdir(), 'mebular-outbox-replayer-deadline-'));
  homes.push(home);
  const outbox = new BoundedOutbox({
    root: join(home, 'outbox'),
    deadRoot: join(home, 'outbox', 'dead'),
    now,
  });
  await outbox.init();
  return { home, outbox };
}

function successClient() {
  return {
    post: jest.fn(async () => ({
      data: { created: 1, results: [] },
    })),
  } as any;
}

describe('OutboxReplayer deadline 与 replay lease', () => {
  it('负例：已过期操作不得发送网络请求', async () => {
    const clock = 1_000;
    const { outbox } = await setup(() => clock);
    await outbox.enqueue({
      id: 'ob_expired_before_send',
      requestId: 'req_expired_before_send',
      endpoint: '/write',
      body: { items: [] },
      createdAt: clock - 10,
      expiresAt: clock,
    });
    const client = successClient();
    const summary = await new OutboxReplayer({ outbox, client, now: () => clock }).replayOnce();

    expect(client.post).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ dead: 1, settled: 0, remaining: 0 });
    expect(await outbox.deadStats()).toMatchObject({ items: 1 });
  });

  it('负例：cleanup 与成功响应并发不得产生 active+dead 或 committed+dead 双态', async () => {
    let clock = 10_000;
    const { outbox } = await setup(() => clock);
    await outbox.enqueue({
      id: 'ob_inflight_success',
      requestId: 'req_inflight_success',
      endpoint: '/write',
      body: { items: [] },
      createdAt: clock,
      expiresAt: clock + 1_000,
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = {
      post: jest.fn(async () => {
        markStarted();
        await gate;
        return { data: { created: 1, results: [] } };
      }),
    } as any;
    const replayer = new OutboxReplayer({ outbox, client, now: () => clock });
    const replay = replayer.replayOnce();
    await started;

    clock += 1_001;
    expect(await outbox.cleanup(clock)).toEqual({ expired: 0, deadRemoved: 0 });
    expect(await outbox.stats()).toMatchObject({ items: 1 });
    expect(await outbox.deadStats()).toMatchObject({ items: 0 });

    release();
    const summary = await replay;
    expect(summary).toMatchObject({ settled: 1, dead: 0, remaining: 0 });
    expect(await outbox.stats()).toMatchObject({ items: 0 });
    expect(await outbox.deadStats()).toMatchObject({ items: 0 });
  });

  it('负例：响应期间到期的 partial 结果按 dead 汇总，不无限 retry', async () => {
    let clock = 15_000;
    const { outbox } = await setup(() => clock);
    await outbox.enqueue({
      id: 'ob_partial_deadline',
      requestId: 'req_partial_deadline',
      endpoint: '/detail',
      body: { items: [{ clientItemId: 'det_partial' }] },
      createdAt: clock,
      expiresAt: clock + 1_000,
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = {
      post: jest.fn(async () => {
        markStarted();
        await gate;
        return { data: { results: [], failed: 1, partial: true } };
      }),
    } as any;
    const replay = new OutboxReplayer({
      outbox,
      client,
      now: () => clock,
      onSettled: () => false,
    }).replayOnce();
    await started;
    clock += 1_001;
    release();
    expect(await replay).toMatchObject({ settled: 0, retried: 0, dead: 1, remaining: 0 });
    expect(await outbox.deadStats()).toMatchObject({ items: 1 });
  });

  it('负例：成功响应晚于 lease/cleanup 时只保留 committed，不留 dead 双态', async () => {
    let clock = 12_000;
    const { outbox } = await setup(() => clock);
    await outbox.enqueue({
      id: 'ob_late_success_cleanup',
      requestId: 'req_late_success_cleanup',
      endpoint: '/write',
      body: { items: [] },
      createdAt: clock,
      expiresAt: clock + 1_000,
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = {
      post: jest.fn(async () => {
        markStarted();
        await gate;
        return { data: { created: 1, results: [] } };
      }),
    } as any;
    const replay = new OutboxReplayer({ outbox, client, now: () => clock }).replayOnce();
    await started;

    clock += 61_000;
    expect(await outbox.cleanup(clock)).toEqual({ expired: 1, deadRemoved: 0 });
    expect(await outbox.deadStats()).toMatchObject({ items: 1 });

    release();
    expect(await replay).toMatchObject({ settled: 1, dead: 0, remaining: 0 });
    expect(await outbox.stats()).toMatchObject({ items: 0 });
    expect(await outbox.deadStats()).toMatchObject({ items: 0 });
  });

  it('负例：capability timeout 超过 60s 时 replay lease 覆盖整个请求，cleanup 不得提前 dead', async () => {
    let clock = 17_000;
    const { outbox } = await setup(() => clock);
    await outbox.enqueue({
      id: 'ob_timeout_over_lease',
      requestId: 'req_timeout_over_lease',
      endpoint: '/write',
      body: { items: [] },
      createdAt: clock,
      expiresAt: clock + 1_000,
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = {
      timeoutMs: 120_000,
      post: jest.fn(async () => {
        markStarted();
        await gate;
        return { data: { created: 1, results: [] } };
      }),
    } as any;
    const replay = new OutboxReplayer({ outbox, client, now: () => clock }).replayOnce();
    await started;

    clock += 61_000;
    expect(await outbox.cleanup(clock)).toEqual({ expired: 0, deadRemoved: 0 });
    expect(await outbox.stats()).toMatchObject({ items: 1 });
    expect(await outbox.deadStats()).toMatchObject({ items: 0 });

    release();
    expect(await replay).toMatchObject({ settled: 1, dead: 0, remaining: 0 });
    expect(await outbox.deadStats()).toMatchObject({ items: 0 });
  });

  it('负例：崩溃遗留 lease 到期后可用同一幂等键恢复，不永久卡住', async () => {
    let clock = 20_000;
    const { outbox } = await setup(() => clock);
    await outbox.enqueue({
      id: 'ob_crash_lease',
      requestId: 'req_crash_lease',
      endpoint: '/write',
      body: { items: [] },
      createdAt: clock,
      expiresAt: clock + 120_000,
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const crashedClient = {
      post: jest.fn(async () => {
        markStarted();
        await firstGate;
        return { data: { created: 1, results: [] } };
      }),
    } as any;
    const first = new OutboxReplayer({ outbox, client: crashedClient, now: () => clock }).replayOnce();
    await started;

    const recoveryClient = successClient();
    const recovery = new OutboxReplayer({ outbox, client: recoveryClient, now: () => clock });
    expect(await recovery.replayOnce()).toMatchObject({ settled: 0, remaining: 1 });
    expect(recoveryClient.post).not.toHaveBeenCalled();

    clock += 61_000;
    expect(await recovery.replayOnce()).toMatchObject({ settled: 1, dead: 0, remaining: 0 });
    expect(recoveryClient.post).toHaveBeenCalledWith('/write', expect.anything(), {
      idempotencyKey: 'req_crash_lease',
      retries: 0,
    });

    releaseFirst();
    await first;
    expect(await outbox.deadStats()).toMatchObject({ items: 0 });
  });

  it('负例：旧 lease attempt 的 retry/permanent/success 都不能修改 B 的活动项', async () => {
    for (const scenario of ['retry', 'dead', 'success'] as const) {
      let clock = 100_000;
      const { outbox } = await setup(() => clock);
      const id = `ob_owner_${scenario}`;
      await outbox.enqueue({
        id,
        requestId: `req_owner_${scenario}`,
        endpoint: '/write',
        body: { items: [] },
        createdAt: clock,
        expiresAt: clock + 300_000,
      });

      let markAStarted!: () => void;
      const aStarted = new Promise<void>((resolve) => { markAStarted = resolve; });
      let releaseA!: () => void;
      const aGate = new Promise<void>((resolve) => { releaseA = resolve; });
      const aClient = {
        post: jest.fn(async () => {
          markAStarted();
          await aGate;
          if (scenario === 'dead') {
            throw new CapabilityClientError('validation_failed', 'permanent failure', {
              status: 422,
              retryable: false,
            });
          }
          return { data: { created: 1, results: [] } };
        }),
      } as any;
      const aReplay = new OutboxReplayer({
        outbox,
        client: aClient,
        now: () => clock,
        ...(scenario === 'retry' ? { onSettled: () => false } : {}),
      }).replayOnce();
      await aStarted;

      clock += 61_000;
      let markBStarted!: () => void;
      const bStarted = new Promise<void>((resolve) => { markBStarted = resolve; });
      let releaseB!: () => void;
      const bGate = new Promise<void>((resolve) => { releaseB = resolve; });
      const bClient = {
        post: jest.fn(async () => {
          markBStarted();
          await bGate;
          return { data: { created: 1, results: [] } };
        }),
      } as any;
      const bReplay = new OutboxReplayer({ outbox, client: bClient, now: () => clock }).replayOnce();
      await bStarted;
      const leasedB = await outbox.get(id);
      expect(leasedB?.replayLeaseOwner).toEqual(expect.any(String));

      releaseA();
      expect(await aReplay).toMatchObject({ settled: 0, dead: 0, retried: 0, remaining: 1 });
      const afterA = await outbox.get(id);
      expect(afterA).toMatchObject({
        replayLeaseOwner: leasedB!.replayLeaseOwner,
        replayLeaseUntil: leasedB!.replayLeaseUntil,
        attempts: 0,
        lastError: null,
      });
      expect(afterA?.nextAttemptAt).toBeUndefined();
      expect(await outbox.deadStats()).toMatchObject({ items: 0 });

      releaseB();
      expect(await bReplay).toMatchObject({ settled: 1, remaining: 0 });
    }
  });
});
