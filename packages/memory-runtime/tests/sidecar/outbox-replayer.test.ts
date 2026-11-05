import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundedOutbox, SidecarLocalLayer } from '../../src/sidecar/local-layer.js';
import { CapabilityClientError } from '../../src/sidecar/capability-client.js';
import { LifecycleGate } from '../../src/sidecar/lifecycle-gate.js';
import { OutboxReplayer } from '../../src/sidecar/outbox-replayer.js';
import { aggregateOutboxDiagnostics } from '../../src/sidecar/settlement.js';

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

describe('WP1 x WP2 lifecycle gates', () => {
  async function setupLayer(now: () => number, gate: LifecycleGate) {
    const home = await mkdtemp(join(tmpdir(), 'mebular-outbox-lifecycle-'));
    homes.push(home);
    const layer = new SidecarLocalLayer({
      root: join(home, 'memory-runtime'),
      lifecycle: gate,
      now,
    });
    await layer.init();
    return { home, layer };
  }

  it('drain 后 completeReplay 三种终态均 skipped，不写 dead/attempts/lease/staging', async () => {
    const clock = 20_000;
    const gate = new LifecycleGate();
    const { layer } = await setupLayer(() => clock, gate);
    await layer.outbox.enqueue({
      id: 'ob_drain_terminal',
      requestId: 'req_drain_terminal',
      endpoint: '/write',
      body: { items: [] },
      createdAt: clock,
    });
    const lease = await layer.outbox.acquireReplayLease('ob_drain_terminal', {
      now: clock,
      leaseMs: 60_000,
    });
    expect(lease.state).toBe('acquired');
    const owner = lease.state === 'acquired' ? lease.item.replayLeaseOwner : undefined;
    const before = JSON.stringify(await layer.outbox.get('ob_drain_terminal'));
    const stagingBefore = (await layer.store.stats()).stagingChunks;

    gate.beginDrain('test');
    gate.finishDrain();

    for (const outcome of ['settled', 'retry', 'dead'] as const) {
      expect(await layer.outbox.completeReplay('ob_drain_terminal', {
        outcome,
        owner,
        now: clock,
        error: 'drained',
        retryDelayMs: 1,
      })).toBe('skipped');
      expect(JSON.stringify(await layer.outbox.get('ob_drain_terminal'))).toBe(before);
      expect(await layer.outbox.deadCount()).toBe(0);
      expect((await layer.store.stats()).stagingChunks).toBe(stagingBefore);
    }

    // mode_mismatch/drain 后所有出站写入口都拒绝。
    expect(await layer.outbox.recordAttempt('ob_drain_terminal', { error: 'x' })).toBeNull();
    expect(await layer.outbox.deadLetter('ob_drain_terminal', 'x')).toBe(false);
    await expect(layer.outbox.enqueue({
      id: 'ob_after_drain',
      requestId: 'req_after_drain',
      endpoint: '/write',
      body: {},
    })).rejects.toMatchObject({ code: 'lifecycle_blocked' });
  });

  it('mode_mismatch/replay 竞态：不 recordAttempt、不 deadLetter、不新增 outbox', async () => {
    const clock = 25_000;
    const gate = new LifecycleGate();
    const { layer } = await setupLayer(() => clock, gate);
    await layer.outbox.enqueue({
      id: 'ob_mode_mismatch',
      requestId: 'req_mode_mismatch',
      endpoint: '/write',
      body: { items: [] },
      createdAt: clock,
    });
    const recordAttempt = jest.spyOn(layer.outbox, 'recordAttempt');
    const deadLetter = jest.spyOn(layer.outbox, 'deadLetter');
    const client = {
      post: jest.fn(async () => {
        throw new CapabilityClientError('mode_mismatch', 'revoked', {
          status: 409,
          retryable: false,
        });
      }),
    } as any;

    const summary = await new OutboxReplayer({ outbox: layer.outbox, client, now: () => clock }).replayOnce();

    expect(summary).toMatchObject({ settled: 0, retried: 0, dead: 0, remaining: 1 });
    expect(recordAttempt).not.toHaveBeenCalled();
    expect(deadLetter).not.toHaveBeenCalled();
    expect(await layer.outbox.get('ob_mode_mismatch')).toMatchObject({
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    });
    expect(await layer.outbox.deadCount()).toBe(0);
    expect(await layer.outbox.stats()).toMatchObject({ items: 1 });
  });

  it('恢复后同一 requestId 只结算一次，提交后 lease 随 active 删除', async () => {
    let clock = 30_000;
    const gate = new LifecycleGate();
    const { layer } = await setupLayer(() => clock, gate);
    await layer.outbox.enqueue({
      id: 'ob_resume_once',
      requestId: 'req_resume_once',
      endpoint: '/write',
      body: { items: [] },
      createdAt: clock,
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let calls = 0;
    const keys: Array<string | undefined> = [];
    const client = {
      post: jest.fn(async (_endpoint: string, _body: unknown, options?: { idempotencyKey?: string }) => {
        calls += 1;
        keys.push(options?.idempotencyKey);
        if (calls === 1) {
          markStarted();
          await firstGate;
        }
        return { data: { created: 1, results: [] } };
      }),
    } as any;
    const onSettled = jest.fn(async () => true);
    const replayer = new OutboxReplayer({
      outbox: layer.outbox,
      client,
      now: () => clock,
      lifecycle: gate,
      onSettled,
    });

    const first = replayer.replayOnce();
    await started;
    gate.beginDrain('test');
    gate.finishDrain();
    releaseFirst();
    expect(await first).toMatchObject({ settled: 0, retried: 0, dead: 0, remaining: 1 });
    expect(await layer.outbox.get('ob_resume_once')).toMatchObject({
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    });
    expect(onSettled).not.toHaveBeenCalled();

    gate.resume();
    clock += 61_000;
    expect(await replayer.replayOnce()).toMatchObject({ settled: 1, retried: 0, dead: 0, remaining: 0 });
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledTimes(2);
    expect(keys).toEqual(['req_resume_once', 'req_resume_once']);
    expect(await layer.outbox.get('ob_resume_once')).toBeNull();
    expect(await layer.outbox.deadCount()).toBe(0);
  });
});

describe('outbox conflict diagnostics', () => {
  it('queued revision_mismatch 保留 409 诊断并显式 dead，不 rebase 原 revision', async () => {
    const clock = 40_000;
    const { outbox } = await setup(() => clock);
    await outbox.enqueue({
      id: 'ob_revision_conflict',
      requestId: 'req_stable_revision',
      endpoint: '/internal-object',
      body: { kind: 'context_checkpoint', expectedRevision: 3, threadId: 't1' },
      createdAt: clock,
      expiresAt: clock + 120_000,
      meta: { kind: 'object' },
    });
    const client = {
      post: jest.fn(async () => {
        throw new CapabilityClientError('revision_mismatch', 'checkpoint revision 冲突', {
          status: 409,
          retryable: true,
          details: {
            agentId: 'opencode',
            threadId: 't1',
            currentRevision: 4,
            expectedRevision: 3,
          },
        });
      }),
    } as any;

    const summary = await new OutboxReplayer({ outbox, client, now: () => clock }).replayOnce();
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith('/internal-object', expect.objectContaining({ expectedRevision: 3 }), {
      idempotencyKey: 'req_stable_revision',
      retries: 0,
    });
    expect(summary).toMatchObject({ settled: 0, retried: 0, dead: 1, remaining: 0 });
    expect(summary.errors[0]).toMatchObject({
      code: 'revision_mismatch',
      status: 409,
      disposition: 'conflict',
      stage: 'replay',
      details: {
        currentRevision: 4,
        expectedRevision: 3,
        threadId: 't1',
      },
    });

    const dead = await outbox.getDead('ob_revision_conflict');
    expect(dead).toMatchObject({
      requestId: 'req_stable_revision',
      body: { expectedRevision: 3 },
      error: 'revision_mismatch',
      failureStage: 'replay',
      lastFailure: {
        code: 'revision_mismatch',
        details: { currentRevision: 4, expectedRevision: 3 },
      },
    });
    const diagnostics = aggregateOutboxDiagnostics([], [dead!], clock);
    expect(diagnostics.lastConflict).toMatchObject({
      code: 'revision_mismatch',
      operation: 'checkpoint',
      requestId: 'req_stable_revision',
      currentRevision: 4,
      expectedRevision: 3,
    });
    expect(diagnostics.deadReasons).toEqual([{ reason: 'revision_mismatch', count: 1 }]);
  });

  it('checkpoint_lease_held 只做有限协作重试，随后显式 dead', async () => {
    let clock = 50_000;
    const { outbox } = await setup(() => clock);
    await outbox.enqueue({
      id: 'ob_lease_conflict',
      requestId: 'req_stable_lease',
      endpoint: '/internal-object',
      body: { kind: 'context_checkpoint', expectedRevision: 2 },
      createdAt: clock,
      expiresAt: clock + 600_000,
    });
    const client = {
      post: jest.fn(async () => {
        throw new CapabilityClientError('checkpoint_lease_held', 'checkpoint 租约被其他 host 持有', {
          status: 409,
          retryable: true,
          details: { hostId: 'h_other', until: clock + 100 },
        });
      }),
    } as any;
    const replayer = new OutboxReplayer({ outbox, client, now: () => clock });

    let calls = 0;
    for (; calls < 10; calls += 1) {
      const summary = await replayer.replayOnce();
      if (summary.dead > 0) break;
      const item = await outbox.get('ob_lease_conflict');
      expect(item).not.toBeNull();
      clock = Math.max(clock + 1, item?.nextAttemptAt ?? clock + 1);
    }

    expect(calls).toBeLessThan(10);
    expect(client.post).toHaveBeenCalledTimes(calls + 1);
    const dead = await outbox.getDead('ob_lease_conflict');
    expect(dead).toMatchObject({
      requestId: 'req_stable_lease',
      error: 'checkpoint_lease_held',
      lastFailure: {
        code: 'checkpoint_lease_held',
        disposition: 'conflict',
        details: { hostId: 'h_other' },
      },
    });
    const diagnostics = aggregateOutboxDiagnostics([], [dead!], clock);
    expect(diagnostics.lastConflict).toMatchObject({
      code: 'checkpoint_lease_held',
      hostId: 'h_other',
      expectedRevision: 2,
    });
  });

  it('ambiguous partial 只提示可能已提交与对账，不伪造 committed', async () => {
    const clock = 60_000;
    const { outbox } = await setup(() => clock);
    await outbox.enqueue({
      id: 'ob_partial_ambiguous',
      requestId: 'req_partial_ambiguous',
      endpoint: '/detail',
      body: { items: [{ clientItemId: 'det_1' }] },
      createdAt: clock,
      expiresAt: clock + 600_000,
      meta: { kind: 'detail' },
    });
    const client = {
      post: jest.fn(async () => ({ data: { results: [], failed: 1, partial: true } })),
    } as any;
    const summary = await new OutboxReplayer({
      outbox,
      client,
      now: () => clock,
      onSettled: () => false,
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 0, retried: 1, dead: 0, remaining: 1 });
    expect(summary.errors[0]).toMatchObject({
      code: 'partial_failure',
      disposition: 'ambiguous',
      possibleCommit: true,
      stage: 'settle',
    });

    const active = (await outbox.list())[0]!;
    const diagnostics = aggregateOutboxDiagnostics([active], [], clock);
    expect(diagnostics.ambiguous).toHaveLength(1);
    expect(diagnostics.ambiguous[0]).toMatchObject({
      requestId: 'req_partial_ambiguous',
      operation: 'detail',
      possiblyCommitted: true,
      hint: 'may_have_been_committed',
      reconciliation: 'read_authoritative_objects',
    });
    expect(diagnostics.ambiguous[0]).not.toHaveProperty('committed');
  });

  it('post 已成功但 onSettled 普通 Error：有界重试而非 dead，恢复后正常 finalize', async () => {
    let clock = 65_000;
    const { outbox } = await setup(() => clock);
    await outbox.enqueue({
      id: 'ob_settle_plain_error',
      requestId: 'req_settle_plain_error',
      endpoint: '/write',
      body: { items: [{ clientItemId: 'rec_1' }] },
      createdAt: clock,
      expiresAt: clock + 600_000,
      meta: { kind: 'record' },
    });
    let settledAttempts = 0;
    const onSettled = jest.fn(async () => {
      settledAttempts += 1;
      if (settledAttempts === 1) throw new Error('local cache readback failed');
      return true;
    });
    const onComplete = jest.fn(async (_item: any, _outcome: any) => undefined);
    const client = {
      post: jest.fn(async () => ({ data: { created: 1, results: [{ status: 'created', id: 'rec_1' }] } })),
    } as any;
    const replayer = new OutboxReplayer({
      outbox,
      client,
      now: () => clock,
      onSettled,
      onComplete,
    });

    const first = await replayer.replayOnce();
    expect(first).toMatchObject({ settled: 0, retried: 1, dead: 0, remaining: 1 });
    expect(first.errors[0]).toMatchObject({
      code: 'internal',
      disposition: 'retryable',
      stage: 'settle',
      possibleCommit: true,
    });
    const retried = await outbox.get('ob_settle_plain_error');
    expect(retried).toMatchObject({
      requestId: 'req_settle_plain_error',
      attempts: 1,
      lastFailure: {
        code: 'internal',
        disposition: 'retryable',
        stage: 'settle',
        possibleCommit: true,
      },
    });
    expect(await outbox.deadStats()).toMatchObject({ items: 0 });
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ id: 'ob_settle_plain_error' }), 'retry');
    expect(onComplete).not.toHaveBeenCalledWith(expect.anything(), 'dead');

    clock = Math.max(clock + 1, retried?.nextAttemptAt ?? clock + 1);
    const second = await replayer.replayOnce();
    expect(second).toMatchObject({ settled: 1, retried: 0, dead: 0, remaining: 0 });
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(await outbox.get('ob_settle_plain_error')).toBeNull();
    expect(await outbox.deadStats()).toMatchObject({ items: 0 });
  });

  it('dead 按操作/endpoint 聚合且暴露最老年龄与原因', async () => {
    let clock = 70_000;
    const { outbox } = await setup(() => clock);
    await outbox.enqueue({
      id: 'ob_dead_detail',
      requestId: 'req_dead_detail',
      endpoint: '/detail',
      body: { items: [] },
      createdAt: clock - 10_000,
      expiresAt: clock + 60_000,
      meta: { kind: 'detail' },
    });
    expect(await outbox.deadLetter('ob_dead_detail', 'validation_failed')).toBe(true);
    clock += 5_000;
    await outbox.enqueue({
      id: 'ob_dead_record',
      requestId: 'req_dead_record',
      endpoint: '/write',
      body: { items: [] },
      createdAt: clock - 2_000,
      expiresAt: clock + 60_000,
      meta: { kind: 'record' },
    });
    expect(await outbox.deadLetter('ob_dead_record', 'retention_expired')).toBe(true);

    const dead = await outbox.listDead();
    const diagnostics = aggregateOutboxDiagnostics([], dead, clock);
    expect(diagnostics.dead).toBe(2);
    expect(diagnostics.deadOldestAgeMs).toBe(5_000);
    expect(diagnostics.deadReasons).toEqual([
      { reason: 'retention_expired', count: 1 },
      { reason: 'validation_failed', count: 1 },
    ]);
    expect(diagnostics.byOperation).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'detail', endpoint: '/detail', dead: 1 }),
      expect.objectContaining({ operation: 'record', endpoint: '/write', dead: 1 }),
    ]));
    expect(diagnostics.byEndpoint).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'detail', endpoint: '/detail', dead: 1 }),
      expect.objectContaining({ operation: 'record', endpoint: '/write', dead: 1 }),
    ]));
  });
});
