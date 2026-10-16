// P3·B2 · 收敛监控状态机单测（红→绿锚点）
//
// 覆盖：状态翻转与去抖、指纹匹配/不匹配、对端缺指纹、会话失败连击、
// 未确认积压、backlog 记账矛盾 + A1 限频探测、提示类信号（reportedAhead /
// 向下修正 / identityFailures）、离线与恢复、summary 口径。
//
// 红样本：删任一判定（如 mismatch 去抖、A1 限频、no-ack-progress 窗口）→ 对应用例失败。

import { describe, it, expect } from '@jest/globals';
import {
  ConvergenceMonitor,
  type ConvergenceConfig,
  type ConvergenceTransition,
  type SyncFingerprintEvent,
} from '../../src/sync/convergence.js';
import type { SyncResult } from '../../src/sync/syncmgr/SyncManager.js';

const T0 = 1_000_000;

function baseResult(peerDeviceId: string, extra: Partial<SyncResult> = {}): SyncResult {
  return {
    peerDeviceId,
    direction: 'bidirectional',
    sentEvents: 0,
    receivedEvents: 0,
    duplicates: 0,
    conflicts: [],
    durationMs: 1,
    finalVectorClock: {},
    ...extra,
  };
}

function fp(peerDeviceId: string, at: number, extra: Partial<SyncFingerprintEvent> = {}): SyncFingerprintEvent {
  return {
    peerDeviceId,
    at,
    result: 'match',
    commonDomains: ['tasks'],
    mismatchedDomains: [],
    peerOnlyDomains: [],
    localOnlyDomains: [],
    policy: 'match',
    ...extra,
  };
}

function makeHarness(config: Partial<ConvergenceConfig> = {}) {
  const clock = { t: T0 };
  const online = new Set<string>();
  const backlogs = new Map<string, { pendingById: number; missingByWatermark: number }>();
  const drops = { nudgeDroppedStaleEntry: 0, staleEntrySignals: 0, identityFailures: 0 };
  const probes: string[] = [];
  const transitions: ConvergenceTransition[] = [];
  const monitor = new ConvergenceMonitor({
    config: {
      enabled: true,
      evalIntervalMs: 1000,
      quietMs: 100,
      stallWindowMs: 10_000,
      failStreak: 3,
      mismatchConfirmations: 2,
      autoProbe: true,
      ...config,
    },
    now: () => clock.t,
    getOnlinePeers: () => [...online].map((deviceId) => ({ deviceId })),
    getBacklog: async (peerDeviceId) => backlogs.get(peerDeviceId) ?? { pendingById: 0, missingByWatermark: 0 },
    getDropCounters: () => ({ ...drops }),
    requestSession: (peerDeviceId) => {
      probes.push(peerDeviceId);
      return true;
    },
    getExpectedIncomingDomains: () => [],
  });
  monitor.on('transition', (t) => transitions.push(t));
  const status = (peer: string) => {
    const s = monitor.getStatus().peers.find((p) => p.peerDeviceId === peer);
    if (!s) throw new Error(`missing peer status: ${peer}`);
    return s;
  };
  return { monitor, clock, online, backlogs, drops, probes, transitions, status };
}

describe('ConvergenceMonitor · 状态机', () => {
  it('基线：指纹匹配 → ok；重复评估不重复发翻转事件', async () => {
    const h = makeHarness();
    h.online.add('device-B');
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t));
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).toBe('ok');
    const transitionCount = h.transitions.length;
    await h.monitor.evaluateNow();
    expect(h.transitions.length).toBe(transitionCount);
    expect(h.transitions.at(-1)?.to).toBe('ok');
  });

  it('未收敛去抖：连续两次静止确认才 diverged，并列出不一致分区', async () => {
    const h = makeHarness();
    h.online.add('device-B');
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t, {
      result: 'mismatch',
      mismatchedDomains: ['tasks'],
    }));
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).not.toBe('diverged');
    h.clock.t += 200; // 超过 quietMs
    await h.monitor.evaluateNow();
    const s = h.status('device-B');
    expect(s.state).toBe('diverged');
    const reason = s.reasons.find((r) => r.code === 'fingerprint-mismatch');
    expect(reason?.domains).toEqual(['tasks']);
  });

  it('对端缺指纹 → unverifiable；出现 match → ok', async () => {
    const h = makeHarness();
    h.online.add('device-B');
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t, { result: 'peer-missing' }));
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).toBe('unverifiable');
    h.clock.t += 1000;
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t));
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).toBe('ok');
  });

  it('会话失败连击 ≥ failStreak → stalled；恢复成功后回到 ok', async () => {
    const h = makeHarness();
    h.online.add('device-B');
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t));
    h.monitor.noteSessionFailed({ peerDeviceId: 'device-B' });
    h.monitor.noteSessionFailed({ peerDeviceId: 'device-B' });
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).not.toBe('stalled'); // 2 < 3
    h.monitor.noteSessionFailed({ peerDeviceId: 'device-B' });
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).toBe('stalled');
    expect(h.status('device-B').reasons.some((r) => r.code === 'session-failures')).toBe(true);
    h.clock.t += 1000;
    h.monitor.noteSessionCompleted(baseResult('device-B', { sentEvents: 1, ackedOutgoing: 1 }));
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t));
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).toBe('ok');
  });

  it('未确认积压：最近两次 sent>0/acked=0 的会话 → stalled；出现 ack 进展即恢复', async () => {
    const h = makeHarness();
    h.online.add('device-B');
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t));
    h.monitor.noteSessionCompleted(baseResult('device-B', { sentEvents: 3, ackedOutgoing: 0 }));
    h.clock.t += 500;
    h.monitor.noteSessionCompleted(baseResult('device-B', { sentEvents: 3, ackedOutgoing: 0 }));
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).toBe('stalled');
    expect(h.status('device-B').reasons.some((r) => r.code === 'no-ack-progress')).toBe(true);
    h.clock.t += 500;
    h.monitor.noteSessionCompleted(baseResult('device-B', { sentEvents: 3, ackedOutgoing: 3 }));
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).toBe('ok');
  });

  it('backlog 记账矛盾（pendingById>0 ∧ missing=0）→ stalled + A1 探测（每窗口限一次）；恢复后 ok', async () => {
    const h = makeHarness();
    h.online.add('device-B');
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t));
    h.backlogs.set('device-B', { pendingById: 3, missingByWatermark: 0 });
    await h.monitor.evaluateNow();
    const s = h.status('device-B');
    expect(s.state).toBe('stalled');
    expect(s.reasons.some((r) => r.code === 'backlog-mismatch')).toBe(true);
    expect(h.probes).toEqual(['device-B']);
    await h.monitor.evaluateNow(); // 同一窗口：不再探测
    expect(h.probes).toEqual(['device-B']);
    h.clock.t += 1100;
    await h.monitor.evaluateNow();
    expect(h.probes).toEqual(['device-B', 'device-B']);

    // 探测后会话恢复：backlog 清零 + 新 match → ok
    h.backlogs.set('device-B', { pendingById: 0, missingByWatermark: 0 });
    h.clock.t += 100;
    h.monitor.noteSessionCompleted(baseResult('device-B', { sentEvents: 3, ackedOutgoing: 3 }));
    h.clock.t += 100;
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t));
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).toBe('ok');
  });

  it('提示类信号：reportedAhead ×2 / 向下修正 ×3 / unknownEventTypes 进入 notes，不改变 ok', async () => {
    const h = makeHarness();
    h.online.add('device-B');
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t));
    h.monitor.noteSessionCompleted(baseResult('device-B', {
      sentEvents: 0,
      ackedOutgoing: 0,
      reportedAhead: { tasks: { 'device-A': 2 } },
      watermarkDownCorrections: 3,
      unknownEventTypes: 1,
    }));
    h.clock.t += 100;
    h.monitor.noteSessionCompleted(baseResult('device-B', {
      sentEvents: 0,
      ackedOutgoing: 0,
      reportedAhead: { tasks: { 'device-A': 1 } },
    }));
    h.clock.t += 100;
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t));
    await h.monitor.evaluateNow();
    const s = h.status('device-B');
    expect(s.state).toBe('ok');
    expect(s.reasons.some((r) => r.code === 'peer-claims-ahead')).toBe(true);
    expect(s.reasons.some((r) => r.code === 'peer-state-loss')).toBe(true);
    expect(s.reasons.some((r) => r.code === 'unknown-event-types')).toBe(true);
  });

  it('identityFailures 增量 > 0 → stalled（键控回归哨兵）', async () => {
    const h = makeHarness();
    h.online.add('device-B');
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t));
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).toBe('ok');
    h.drops.identityFailures += 1;
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).toBe('stalled');
    expect(h.status('device-B').reasons.some((r) => r.code === 'keying-drop')).toBe(true);
  });

  it('离线 → offline；重新在线且指纹匹配 → ok', async () => {
    const h = makeHarness();
    h.online.add('device-B');
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t));
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).toBe('ok');
    h.online.delete('device-B');
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).toBe('offline');
    h.online.add('device-B');
    h.clock.t += 1000;
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t));
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).toBe('ok');
  });

  it('summary 口径：按状态计数（online 对端 + 离线对端）', async () => {
    const h = makeHarness();
    h.online.add('device-B');
    h.online.add('device-C');
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t));
    h.monitor.noteFingerprintComparison(fp('device-C', h.clock.t));
    await h.monitor.evaluateNow();
    const summary = h.monitor.getStatus().summary;
    expect(summary.online).toBe(2);
    expect(summary.ok).toBe(2);
    expect(summary.peers).toBe(2);
  });

  it('autoProbe=false：backlog 矛盾仍为 stalled，但不触发探测', async () => {
    const h = makeHarness({ autoProbe: false });
    h.online.add('device-B');
    h.monitor.noteFingerprintComparison(fp('device-B', h.clock.t));
    h.backlogs.set('device-B', { pendingById: 1, missingByWatermark: 0 });
    await h.monitor.evaluateNow();
    expect(h.status('device-B').state).toBe('stalled');
    expect(h.probes).toEqual([]);
  });
});
