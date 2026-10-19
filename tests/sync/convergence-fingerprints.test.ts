// P3·B2 · stateFingerprints 交换与比较单测（红→绿锚点）
//
// 覆盖：
//  - 协议层：sync-done 可选字段解析（宽容），旧端不因未知字段失败（A 类边界直证）；
//  - 比较层：共同域一致/不一致、对端多余（期望内/外）、我方多余（发送集合内）、策略指纹、对端缺指纹；
//  - 交换层：开关启用时 sync-done 携带指纹并各自 emit sync-fingerprint；未启用零变化；
//    对端旧版（缺字段）→ peer-missing 且会话正常；ackedOutgoing / unknownEventTypes 计数。
//
// 红样本：去掉任何一处指纹注入/比较/计数 → 对应用例失败。

import { describe, it, expect } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { SyncManager, type SyncPeer, type SyncResult } from '../../src/sync/syncmgr/SyncManager.js';
import { SecureChannelSyncTransport, parseStateFingerprints, type SyncStateFingerprints } from '../../src/sync/protocol.js';
import { compareStateFingerprints, hashPolicyState, type SyncFingerprintEvent } from '../../src/sync/convergence.js';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type { PolicyState } from '../../src/sync/grantPolicy.js';

const H = (c: string) => c.repeat(64);

describe('stateFingerprints · 协议形状（C3 A 类可选字段）', () => {
  it('合法形状解析成功；缺省 / 畸形 → null（按缺省降级，不使会话失败）', () => {
    expect(parseStateFingerprints(undefined)).toBeNull();
    expect(parseStateFingerprints(null)).toBeNull();
    expect(parseStateFingerprints({ graphs: {}, policy: H('a') })).toEqual({ graphs: {}, policy: H('a') });
    expect(parseStateFingerprints({ graphs: { tasks: H('b') } })).toEqual({ graphs: { tasks: H('b') } });
    expect(parseStateFingerprints({ graphs: 'nope' })).toBeNull();
    expect(parseStateFingerprints({ graphs: { tasks: 42 } })).toBeNull();
    expect(parseStateFingerprints({ graphs: {}, policy: 1 })).toBeNull();
  });

  it('旧端视角：sync-done 含未知字段（含畸形指纹）不影响既有字段消费', () => {
    const raw = JSON.stringify({
      type: 'sync-done',
      finalVectorClock: { 'device-A': 3 },
      stateFingerprints: { graphs: { tasks: H('c') }, policy: H('d') },
      futureUnknownField: { anything: true },
    });
    const parsed = JSON.parse(raw) as { type: string; finalVectorClock: Record<string, number> };
    expect(parsed.type).toBe('sync-done');
    expect(parsed.finalVectorClock).toEqual({ 'device-A': 3 });
    expect(parseStateFingerprints((parsed as { stateFingerprints?: unknown }).stateFingerprints)).toEqual({
      graphs: { tasks: H('c') },
      policy: H('d'),
    });
    // 畸形指纹不抛错（宽容解析）
    expect(parseStateFingerprints({ graphs: { tasks: H('c'), bad: {} } })).toBeNull();
  });
});

describe('compareStateFingerprints · 判据', () => {
  const local: SyncStateFingerprints = { graphs: { tasks: H('1'), notes: H('2') }, policy: H('p') };

  it('共同域一致 + 策略一致 → match', () => {
    const peer: SyncStateFingerprints = { graphs: { tasks: H('1'), notes: H('2') }, policy: H('p') };
    const cmp = compareStateFingerprints(local, peer);
    expect(cmp.result).toBe('match');
    expect(cmp.mismatchedDomains).toEqual([]);
  });

  it('共同域不一致 → mismatch（列差异分区）', () => {
    const peer: SyncStateFingerprints = { graphs: { tasks: H('9') } };
    const cmp = compareStateFingerprints(local, peer);
    expect(cmp.result).toBe('mismatch');
    expect(cmp.mismatchedDomains).toEqual(['tasks']);
    expect(cmp.commonDomains).toEqual(['tasks']);
  });

  it('对端多出的分区：在期望收到集合内 → mismatch；不在 → 忽略', () => {
    const peer: SyncStateFingerprints = { graphs: { tasks: H('1'), notes: H('2'), work: H('w') } };
    expect(compareStateFingerprints(local, peer, { expectedIncoming: ['work'] }).result).toBe('mismatch');
    expect(compareStateFingerprints(local, peer, { expectedIncoming: ['work'] }).mismatchedDomains).toEqual(['work']);
    expect(compareStateFingerprints(local, peer, { expectedIncoming: [] }).result).toBe('match');
    expect(compareStateFingerprints(local, peer, { expectedIncoming: 'all' }).result).toBe('mismatch');
  });

  it('我方多出的分区：在本次发送集合内 → mismatch（对端缺）；不在 → 忽略', () => {
    const peer: SyncStateFingerprints = { graphs: { tasks: H('1') } };
    expect(compareStateFingerprints(local, peer, { outgoingAllow: ['notes'] }).result).toBe('mismatch');
    expect(compareStateFingerprints(local, peer, { outgoingAllow: ['notes'] }).mismatchedDomains).toEqual(['notes']);
    expect(compareStateFingerprints(local, peer, { outgoingAllow: [] }).result).toBe('match');
  });

  it('策略指纹：双方不一致 → mismatch；仅单侧提供 → 不因此判 mismatch', () => {
    const peerMismatch: SyncStateFingerprints = { graphs: { tasks: H('1'), notes: H('2') }, policy: H('x') };
    const cmp = compareStateFingerprints(local, peerMismatch);
    expect(cmp.result).toBe('mismatch');
    expect(cmp.policy).toBe('mismatch');
    const peerNoPolicy: SyncStateFingerprints = { graphs: { tasks: H('1'), notes: H('2') } };
    expect(compareStateFingerprints(local, peerNoPolicy).result).toBe('match');
    expect(compareStateFingerprints(peerNoPolicy, local).result).toBe('match');
  });

  it('对端无指纹 → peer-missing；无共同域且无期望差 → inconclusive', () => {
    expect(compareStateFingerprints(local, null).result).toBe('peer-missing');
    const peer: SyncStateFingerprints = { graphs: { elsewhere: H('9') } };
    expect(compareStateFingerprints(local, peer, { expectedIncoming: [] }).result).toBe('inconclusive');
  });
});

describe('hashPolicyState · 确定性', () => {
  function policyState(overrides: Partial<PolicyState> = {}): PolicyState {
    return {
      subscriptions: new Map([['tasks', new Set(['device-A', 'device-B'])]]),
      subscriptionNamespaces: new Set(['tasks']),
      subscriptionRecords: new Map([['tasks', new Set(['device-A', 'device-B'])]]),
      blocked: new Set<string>(),
      declarations: new Set(['tasks']),
      restoreAt: new Map<string, number>(),
      converged: true,
      iterations: 2,
      ...overrides,
    };
  }

  it('同一策略状态（插入序不同）→ 同一哈希', () => {
    const a = policyState();
    const b = policyState({
      subscriptions: new Map([['tasks', new Set(['device-B', 'device-A'])]]),
    });
    expect(hashPolicyState(a)).toBe(hashPolicyState(b));
  });

  it('订阅 / 移出 / 安全档差异 → 哈希不同', () => {
    const base = policyState();
    expect(hashPolicyState(base)).not.toBe(hashPolicyState(policyState({
      subscriptions: new Map([['tasks', new Set(['device-A'])]]),
    })));
    expect(hashPolicyState(base)).not.toBe(hashPolicyState(policyState({
      blocked: new Set(['device-B']),
    })));
    expect(hashPolicyState(base)).not.toBe(hashPolicyState(policyState({
      security: { level: 'high', admitted: ['device-A'], rejections: [] },
    })));
  });
});

// ---------- 交换层（双端 SyncManager 真实信道） ----------

interface TestDevice {
  deviceId: string;
  storage: MemoryStorage;
  eventLog: EventLog;
  store: GraphStore;
  syncManager: SyncManager;
  publicKey: Uint8Array;
  peerId: { id: string; multihash: Uint8Array; pubKey: Uint8Array };
}

async function createDevice(
  deviceId: string,
  options: { fingerprints?: { report: () => Promise<SyncStateFingerprints> } } = {},
): Promise<TestDevice> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const storage = new MemoryStorage();
  const eventLog = new EventLog(storage, deviceId, { signer: { deviceId, privateKey: keyPair.privateKey } });
  const store = new GraphStore({ storage, author: deviceId, eventLog });
  const syncManager = new SyncManager({
    eventLog,
    storage,
    deviceId,
    ...(options.fingerprints ? { fingerprints: options.fingerprints } : {}),
  });
  return { deviceId, storage, eventLog, store, syncManager, publicKey, peerId: { id: deviceId, multihash: publicKey, pubKey: publicKey } };
}

function peerOf(device: TestDevice): SyncPeer {
  return { deviceId: device.deviceId, publicKey: device.publicKey };
}

async function runSync(initiator: TestDevice, responder: TestDevice): Promise<[SyncResult, SyncResult]> {
  const hub = new InMemoryHub();
  const [connA, connB] = hub.createLinkedPair(initiator.peerId, responder.peerId);
  const channelA = new SecureChannelImpl(connA);
  const channelB = new SecureChannelImpl(connB);
  await Promise.all([channelA.start(), channelB.start()]);
  const tA = new SecureChannelSyncTransport(channelA);
  const tB = new SecureChannelSyncTransport(channelB);
  return Promise.all([
    initiator.syncManager.syncWithDevice(tA, peerOf(responder), { direction: 'bidirectional' }),
    responder.syncManager.acceptSync(tB, peerOf(initiator)),
  ]);
}

describe('stateFingerprints · 会话交换', () => {
  it('双方启用：sync-done 携带指纹，各自 emit sync-fingerprint=match', async () => {
    const report = async (): Promise<SyncStateFingerprints> => ({ graphs: { default: H('a') }, policy: H('p') });
    const a = await createDevice('device-A', { fingerprints: { report } });
    const b = await createDevice('device-B', { fingerprints: { report } });
    await a.store.createNode('fact', { text: 'a1' });

    const eventsA: SyncFingerprintEvent[] = [];
    const eventsB: SyncFingerprintEvent[] = [];
    a.syncManager.on('sync-fingerprint', (e) => eventsA.push(e as SyncFingerprintEvent));
    b.syncManager.on('sync-fingerprint', (e) => eventsB.push(e as SyncFingerprintEvent));

    const [resA, resB] = await runSync(a, b);
    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    expect(eventsA[0]).toMatchObject({ peerDeviceId: 'device-B', result: 'match' });
    expect(eventsB[0]).toMatchObject({ peerDeviceId: 'device-A', result: 'match' });
    // ackedOutgoing：A 发 1 条被 ack；B 无 pending
    expect(resA.sentEvents).toBe(1);
    expect(resA.ackedOutgoing).toBe(1);
    expect(resB.ackedOutgoing).toBe(0);
  });

  it('对端旧版（无字段）：会话正常、我方记 peer-missing（降级不告警）', async () => {
    const a = await createDevice('device-A', { fingerprints: { report: async () => ({ graphs: { default: H('a') } }) } });
    const b = await createDevice('device-B'); // 未启用 = 旧端行为
    const eventsA: SyncFingerprintEvent[] = [];
    a.syncManager.on('sync-fingerprint', (e) => eventsA.push(e as SyncFingerprintEvent));
    const [resA] = await runSync(a, b);
    expect(resA.receivedEvents).toBe(0);
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]?.result).toBe('peer-missing');
  });

  it('未启用（默认）：无指纹字段、无比较事件（库行为零变化）', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B');
    const eventsA: unknown[] = [];
    a.syncManager.on('sync-fingerprint', (e) => eventsA.push(e));
    await runSync(a, b);
    expect(eventsA).toHaveLength(0);
  });

  it('未知事件类型：入日志不物化，计数 unknownEventTypes=1', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B');
    await a.eventLog.append({ type: 'future_thing', data: { x: 1 }, namespace: 'default' });
    const [, resB] = await runSync(a, b);
    expect(resB.unknownEventTypes).toBe(1);
  });

  it('水位向下修正计数：对端自报低于本机记录 → watermarkDownCorrections≥1', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B');
    await a.store.createNode('fact', { text: 'a1' });
    // 先正常同步一轮，建立水位
    await runSync(a, b);
    // 手工抬高 A 对 B 的记录（模拟历史污染/备份恢复），下轮 hello 自报更低 → 向下修正
    const watermarks = (a.syncManager as unknown as { peerWatermarks: Map<string, Record<string, Record<string, number>>> }).peerWatermarks;
    watermarks.set('device-B', { default: { 'device-A': 999 } });
    const [resA] = await runSync(a, b);
    expect(resA.watermarkDownCorrections).toBeGreaterThanOrEqual(1);
  });
});
