// P1·B2 · N3「丢弃必须发声」判别性断言：
// 三类静默点（nudge 丢弃 / stale entry / 身份缺失）各有分类计数 + `sync-frames-dropped` 事件。
//
// 红→绿锚点：把任一 noteDropped 调用删掉（或把 guard 改回裸 `return`）→ 对应用例失败。

import { describe, it, expect } from '@jest/globals';
import { EventEmitter } from 'events';
import { SyncManager } from '../../src/sync/syncmgr/SyncManager.js';
import { EventLog } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import type { AuthSession } from '../../src/p2p/handshake/AuthenticationHandshake.js';
import type { Connection } from '../../src/p2p/P2PNetwork.js';

const CANONICAL_KEY = 'peer-canonical-key';

function fakeCertificate(deviceId: string) {
  return {
    deviceId,
    devicePublicKey: 'aa'.repeat(32),
    createdAt: 0,
    signature: 'x',
  };
}

function makeSession(connection: unknown, options: { certificate?: boolean } = {}): AuthSession {
  const session: AuthSession = {
    peerId: { id: CANONICAL_KEY, multihash: new Uint8Array(), pubKey: new Uint8Array() },
    state: 'authenticated',
    connection: connection as Connection,
    ...(options.certificate === false ? {} : { certificate: fakeCertificate('device-B') }),
  };
  return session;
}

/** 伪节点：只提供 attachToNode 所需最小面（events/getChannel/onConnectionClosed） */
function makeFakeNode(handshake: EventEmitter) {
  return {
    getHandshake: () => handshake,
    onConnectionClosed: () => undefined,
    getChannel: async () => null,
  } as unknown as Parameters<SyncManager['attachToNode']>[0];
}

function makeManager(): SyncManager {
  const storage = new MemoryStorage();
  const eventLog = new EventLog(storage, 'device-A');
  return new SyncManager({ eventLog, storage, deviceId: 'device-X' /* 角色：对 device-B 为响应方 */ });
}

describe('N3 · 丢弃计数器（nudge / stale entry / 身份缺失）', () => {
  it('身份缺失：已认证会话无证书 deviceId → identityFailures=1，对端不登记', () => {
    const handshake = new EventEmitter();
    const sm = makeManager();
    const drops: unknown[] = [];
    sm.on('sync-frames-dropped', (d) => drops.push(d));
    sm.attachToNode(makeFakeNode(handshake));

    handshake.emit('authenticated', makeSession(undefined, { certificate: false }));

    expect(sm.getDropCounters().identityFailures).toBe(1);
    expect(sm.getDropCounters().nudgeDroppedStaleEntry).toBe(0);
    expect(drops).toHaveLength(1);
    expect((drops[0] as { kind: string }).kind).toBe('identityFailures');
    // 未登记 onlinePeers（禁静默兜底成 peerId.id）
    expect(
      (sm as unknown as { onlinePeers: Map<string, unknown> }).onlinePeers.size,
    ).toBe(0);
  });

  it('nudge 丢弃：落在被替换的旧 entry → nudgeDroppedStaleEntry=1；当前 entry 的 nudge 不计', () => {
    const handshake = new EventEmitter();
    const sm = makeManager();
    const drops: Array<{ kind: string }> = [];
    sm.on('sync-frames-dropped', (d) => drops.push(d as { kind: string }));
    sm.attachToNode(makeFakeNode(handshake));

    const conn1 = {} as Connection;
    const conn2 = {} as Connection;
    handshake.emit('authenticated', makeSession(conn1));
    const onlinePeers = (sm as unknown as { onlinePeers: Map<string, unknown> }).onlinePeers;
    const entry1 = onlinePeers.get(CANONICAL_KEY);
    handshake.emit('authenticated', makeSession(conn2)); // 同键替换（同设备新连接）
    const entry2 = onlinePeers.get(CANONICAL_KEY);
    expect(entry2).not.toBe(entry1);

    // 旧 entry 的 nudge（真实来源：旧连接信道上的滞后帧）
    (sm as unknown as { onPeerNudge: (e: unknown) => void }).onPeerNudge(entry1);
    expect(sm.getDropCounters().nudgeDroppedStaleEntry).toBe(1);

    // 当前 entry 的 nudge 不计入丢弃（角色为响应方 → 合法忽略）
    (sm as unknown as { onPeerNudge: (e: unknown) => void }).onPeerNudge(entry2);
    expect(sm.getDropCounters().nudgeDroppedStaleEntry).toBe(1);
    expect(drops.map((d) => d.kind)).toEqual(['nudgeDroppedStaleEntry']);
  });

  it('stale entry：旧连接的关闭清理被代际比对忽略 → staleEntrySignals=1，当前登记保留', () => {
    const handshake = new EventEmitter();
    const sm = makeManager();
    const drops: Array<{ kind: string }> = [];
    sm.on('sync-frames-dropped', (d) => drops.push(d as { kind: string }));
    sm.attachToNode(makeFakeNode(handshake));

    const conn1 = {} as Connection;
    const conn2 = {} as Connection;
    handshake.emit('authenticated', makeSession(conn1));
    handshake.emit('authenticated', makeSession(conn2));

    const removeOnlinePeer = (sm as unknown as {
      removeOnlinePeer: (peerId: { id: string }, connection?: Connection) => void;
    }).removeOnlinePeer.bind(sm);
    const onlinePeers = (sm as unknown as { onlinePeers: Map<string, unknown> }).onlinePeers;

    // 旧连接的关闭事件：不得清除新连接登记
    removeOnlinePeer({ id: CANONICAL_KEY }, conn1);
    expect(sm.getDropCounters().staleEntrySignals).toBe(1);
    expect(onlinePeers.has(CANONICAL_KEY)).toBe(true);

    // 当前连接的关闭事件：正常清理、不再计丢弃
    removeOnlinePeer({ id: CANONICAL_KEY }, conn2);
    expect(sm.getDropCounters().staleEntrySignals).toBe(1);
    expect(onlinePeers.has(CANONICAL_KEY)).toBe(false);
    expect(drops.map((d) => d.kind)).toEqual(['staleEntrySignals']);
  });
});
