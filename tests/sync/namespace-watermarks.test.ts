// 默认拒绝 + per-(对端, 分区) 同步水位（PLAN-namespace-watermarks 第 2/3 节）。
//
// 覆盖验收：
// - hello 订阅声明与分区水位**必填**，缺失/类型错 → 会话被拒绝（协议违例）；
// - 声明槽的 subscribeAll/namespaces 无歧义；授权槽 [] = 拒绝；
// - **扩权回补**（回归锚点）：先授权 nsA → 再扩到 nsA+nsB，nsB 历史必须补发
//   （increment 与快照两条路径）；
// - 撤销/收紧：撤销后不发送，水位不被污染，再扩回仍正确；
// - 重启持久化：per-(peer, ns) 水位落盘，重启后不重发、不遗漏。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog, type EventSigner } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { SyncManager, type SyncPeer, type SyncResult } from '../../src/sync/syncmgr/SyncManager.js';
import type { NamespaceGrantPolicy } from '../../src/sync/namespacePolicy.js';
import { grant } from '../helpers/namespace.js';
import {
  assertValidAck,
  assertValidHello,
  assertValidSnapshot,
  SecureChannelSyncTransport,
  type SyncMessage,
} from '../../src/sync/protocol.js';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type { PeerId } from '../../src/p2p/P2PNetwork.js';
import type { Node } from '../../src/types/index.js';

/** 可变的授权策略：测试中途「扩权 / 撤销」只需改 mapping */
class MutablePolicy implements NamespaceGrantPolicy {
  constructor(public mapping: Record<string, string[]> = {}) {}

  async getAuthorizedNamespaces(peerDeviceId: string): Promise<string[]> {
    return [...(this.mapping[peerDeviceId] ?? [])];
  }
}

interface TestDevice {
  deviceId: string;
  storage: MemoryStorage;
  eventLog: EventLog;
  store: GraphStore;
  syncManager: SyncManager;
  publicKey: Uint8Array;
  peerId: PeerId;
}

interface DeviceOptions {
  namespacePolicy?: NamespaceGrantPolicy;
  subscriptionNamespaces?: string[];
  snapshotThreshold?: number;
  syncStatePath?: string;
}

function makePeerId(deviceId: string, publicKey: Uint8Array): PeerId {
  return { multihash: publicKey, pubKey: publicKey, id: deviceId };
}

/** 在同一 storage/eventLog 上新建 SyncManager（模拟重启） */
function newSyncManager(base: Omit<TestDevice, 'syncManager'>, options: DeviceOptions = {}): SyncManager {
  return new SyncManager({
    eventLog: base.eventLog,
    storage: base.storage,
    deviceId: base.deviceId,
    ...(options.namespacePolicy ? { namespacePolicy: options.namespacePolicy } : {}),
    ...(options.subscriptionNamespaces ? { subscriptionNamespaces: options.subscriptionNamespaces } : {}),
    ...(options.snapshotThreshold !== undefined ? { snapshotThreshold: options.snapshotThreshold } : {}),
    ...(options.syncStatePath ? { syncStatePath: options.syncStatePath } : {}),
  });
}

async function createDevice(deviceId: string, options: DeviceOptions = {}): Promise<TestDevice> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const signer: EventSigner = { deviceId, privateKey: keyPair.privateKey };
  const storage = new MemoryStorage();
  const eventLog = new EventLog(storage, deviceId, { signer });
  const store = new GraphStore({ storage, author: deviceId, eventLog });
  const base = { deviceId, storage, eventLog, store, publicKey, peerId: makePeerId(deviceId, publicKey) };
  return { ...base, syncManager: newSyncManager(base, options) };
}

function peerOf(device: { deviceId: string; publicKey: Uint8Array }): SyncPeer {
  return { deviceId: device.deviceId, publicKey: device.publicKey };
}

async function linkedTransports(
  a: { peerId: PeerId },
  b: { peerId: PeerId },
): Promise<[SecureChannelSyncTransport, SecureChannelSyncTransport]> {
  const hub = new InMemoryHub();
  const [connA, connB] = hub.createLinkedPair(a.peerId, b.peerId);
  const channelA = new SecureChannelImpl(connA);
  const channelB = new SecureChannelImpl(connB);
  await Promise.all([channelA.start(), channelB.start()]);
  return [new SecureChannelSyncTransport(channelA), new SecureChannelSyncTransport(channelB)];
}

async function runSyncWith(
  initiatorManager: SyncManager,
  responderManager: SyncManager,
  initiator: TestDevice,
  responder: TestDevice,
  direction: 'push' | 'pull' | 'bidirectional' = 'bidirectional',
): Promise<[SyncResult, SyncResult]> {
  const [tA, tB] = await linkedTransports(initiator, responder);
  return Promise.all([
    initiatorManager.syncWithDevice(tA, peerOf(responder), { direction }),
    responderManager.acceptSync(tB, peerOf(initiator)),
  ]);
}

function runSync(a: TestDevice, b: TestDevice): Promise<[SyncResult, SyncResult]> {
  return runSyncWith(a.syncManager, b.syncManager, a, b);
}

async function namespacesOn(device: TestDevice): Promise<string[]> {
  const nodes = await device.store.listNodes();
  return nodes.map((n: Node) => n.namespace ?? 'default').sort();
}

async function loadState(path: string): Promise<{
  version: number;
  peers: Record<string, string[]>;
  peerWatermarks: Record<string, Record<string, Record<string, number>>>;
}> {
  return JSON.parse(await readFile(path, 'utf-8')) as never;
}

describe('授权边界与协议声明', () => {
  it('hello 缺失 subscribeAll → 协议违例，会话被拒绝（发起方视角）', async () => {
    const a = await createDevice('device-A', { namespacePolicy: new MutablePolicy({ 'device-B': ['nsA'] }) });
    await a.store.createNode('fact', { text: 'x' }, [], { namespace: 'nsA' });

    const b = await createDevice('device-B');
    const [tA, tB] = await linkedTransports(a, b);

    const script = (async () => {
      const it = tB.receive()[Symbol.asyncIterator]();
      await it.next(); // A 的合法 hello
      // 缺失 subscribeAll：视为协议违例，不再解释为「不过滤」
      await tB.send({ type: 'sync-hello', namespaces: [], namespaceClocks: {} } as never);
      return it.next(); // 应收到 A 的 sync-error
    })();

    await expect(
      a.syncManager.syncWithDevice(tA, peerOf(b)),
    ).rejects.toMatchObject({ code: 'SYNC_PROTOCOL_VIOLATION' });

    const reply = await script;
    expect(reply.done).toBe(false);
    expect((reply.value as SyncMessage).type).toBe('sync-error');
  });

  it('hello 的 namespaces 类型错 → 响应方拒绝会话', async () => {
    const a = await createDevice('device-A', { namespacePolicy: new MutablePolicy({ 'device-B': ['nsA'] }) });
    const b = await createDevice('device-B');
    const [tA, tB] = await linkedTransports(a, b);

    const script = (async () => {
      const it = tA.receive()[Symbol.asyncIterator]();
      await tA.send({
        type: 'sync-hello',
        direction: 'bidirectional',
        subscribeAll: true,
        namespaces: 'nsA' as unknown as string[],
        namespaceClocks: {},
      });
      return it.next(); // 应收到 B 的 sync-error
    })();

    await expect(
      b.syncManager.acceptSync(tB, peerOf(a)),
    ).rejects.toMatchObject({ code: 'SYNC_PROTOCOL_VIOLATION' });
    const reply = await script;
    expect((reply.value as SyncMessage).type).toBe('sync-error');
  });

  it('声明槽 subscribeAll=false + []：明确不订阅任何分区（与「订阅空=全部」不再冲突）', async () => {
    const a = await createDevice('device-A', { namespacePolicy: new MutablePolicy({ 'device-B': ['nsA'] }) });
    await a.store.createNode('fact', { text: 'x' }, [], { namespace: 'nsA' });

    const b = await createDevice('device-B');
    const [tA, tB] = await linkedTransports(a, b);

    const script = (async () => {
      const it = tB.receive()[Symbol.asyncIterator]();
      await tB.send({
        type: 'sync-hello',
        direction: 'bidirectional',
        subscribeAll: false,
        namespaces: [],
        namespaceClocks: {},
      });
      await it.next(); // A（响应方）的 hello
      await tB.send({ type: 'sync-offer', events: [] });
      await it.next(); // A 的 ack
      const offer = (await it.next()).value as Extract<SyncMessage, { type: 'sync-offer' }>;
      await tB.send({ type: 'sync-ack', appliedEventIds: [] });
      await tB.send({ type: 'sync-done', finalVectorClock: {} });
      await it.next(); // A 的 done
      return offer.events.length;
    })();

    const result = await a.syncManager.acceptSync(tA, peerOf(b));
    expect(await script).toBe(0); // 声明槽 [] 解析为「不订阅任何分区」
    expect(result.sentEvents).toBe(0);
    expect(result.denied).toBe(true);
  });

  it('响应方发来缺 namespaceClocks 的快照 → 协议违例，会话被拒绝（F2）', async () => {
    const a = await createDevice('device-A', { namespacePolicy: grant('default') });
    const b = await createDevice('device-B');
    const [tA, tB] = await linkedTransports(a, b);

    const script = (async () => {
      const it = tB.receive()[Symbol.asyncIterator]();
      await it.next(); // A 的 hello
      await tB.send({ type: 'sync-hello', direction: 'bidirectional', subscribeAll: true, namespaces: [], namespaceClocks: {} });
      const offer = (await it.next()).value as Extract<SyncMessage, { type: 'sync-offer' }>;
      await tB.send({ type: 'sync-ack', appliedEventIds: (offer.events ?? []).map((e) => e.id) });
      // 缺 namespaceClocks：快照已声明必填，缺失即协议违例（不再容忍）
      await tB.send({
        type: 'sync-offer',
        events: [],
        snapshot: { nodes: [], edges: [], namespaces: ['default'] } as never,
      });
      return it.next(); // A 的 sync-error
    })();

    await expect(
      a.syncManager.syncWithDevice(tA, peerOf(b)),
    ).rejects.toMatchObject({ code: 'SYNC_PROTOCOL_VIOLATION' });
    const reply = await script;
    expect((reply.value as SyncMessage).type).toBe('sync-error');
  });
});

describe('assertValidSnapshot / assertValidAck', () => {
  const validSnapshot = { nodes: [], edges: [], namespaceClocks: {}, namespaces: ['default'] };

  it('合法快照通过', () => {
    expect(() => assertValidSnapshot(validSnapshot)).not.toThrow();
  });

  it.each([
    ['nodes 非数组', { ...validSnapshot, nodes: null }],
    ['edges 非数组', { ...validSnapshot, edges: 3 }],
    ['namespaces 非数组', { ...validSnapshot, namespaces: 'default' }],
    ['namespaces 含非字符串', { ...validSnapshot, namespaces: [1] }],
    ['namespaceClocks 缺失', { nodes: [], edges: [], namespaces: ['default'] }],
    ['namespaceClocks 非对象', { ...validSnapshot, namespaceClocks: 1 }],
    ['分区时钟非对象', { ...validSnapshot, namespaceClocks: { nsA: 1 } }],
    ['作者计数非数值', { ...validSnapshot, namespaceClocks: { nsA: { a: 'x' } } }],
    ['作者计数为负', { ...validSnapshot, namespaceClocks: { nsA: { a: -1 } } }],
    ['nodes 含非对象元素', { ...validSnapshot, nodes: [1] }],
    ['nodes 元素缺字符串 id', { ...validSnapshot, nodes: [{ id: 1 }] }],
    ['edges 含 null 元素', { ...validSnapshot, edges: [null] }],
    ['edges 元素缺 id', { ...validSnapshot, edges: [{}] }],
  ])('快照 %s → 协议违例', (_label, snapshot) => {
    expect(() => assertValidSnapshot(snapshot as never)).toThrow(/sync-offer snapshot/);
  });

  it('合法 ack 通过；appliedEventIds 非数组/含非字符串 → 违例', () => {
    expect(() => assertValidAck({ type: 'sync-ack', appliedEventIds: [] })).not.toThrow();
    expect(() => assertValidAck({ type: 'sync-ack', appliedEventIds: [], snapshotApplied: true })).not.toThrow();
    expect(() => assertValidAck({ type: 'sync-ack', appliedEventIds: 'x' } as never)).toThrow(/sync-ack/);
    expect(() => assertValidAck({ type: 'sync-ack', appliedEventIds: [1] } as never)).toThrow(/sync-ack/);
    expect(() => assertValidAck({ type: 'sync-ack', appliedEventIds: [], snapshotApplied: 'yes' } as never)).toThrow(/sync-ack/);
  });
});

describe('assertValidHello 订阅声明校验', () => {
  const validHello = {
    type: 'sync-hello' as const,
    subscribeAll: true,
    namespaces: [] as string[],
    namespaceClocks: {},
  };

  it('合法声明通过', () => {
    expect(() => assertValidHello(validHello)).not.toThrow();
  });

  it.each([
    ['缺失 subscribeAll', { type: 'sync-hello', namespaces: [], namespaceClocks: {} }],
    ['subscribeAll 类型错', { type: 'sync-hello', subscribeAll: 'yes', namespaces: [], namespaceClocks: {} }],
    ['namespaces 非数组', { type: 'sync-hello', subscribeAll: true, namespaces: 'nsA', namespaceClocks: {} }],
    ['namespaces 含非字符串', { type: 'sync-hello', subscribeAll: true, namespaces: [1], namespaceClocks: {} }],
    ['namespaceClocks 为数组', { type: 'sync-hello', subscribeAll: true, namespaces: [], namespaceClocks: [] }],
    ['namespaceClocks 为 null', { type: 'sync-hello', subscribeAll: true, namespaces: [], namespaceClocks: null }],
    ['分区时钟非对象', { type: 'sync-hello', subscribeAll: true, namespaces: [], namespaceClocks: { nsA: 3 } }],
    ['作者计数非数值', { type: 'sync-hello', subscribeAll: true, namespaces: [], namespaceClocks: { nsA: { a: 'x' } } }],
    ['作者计数为负', { type: 'sync-hello', subscribeAll: true, namespaces: [], namespaceClocks: { nsA: { a: -1 } } }],
  ])('%s → 协议违例', (_label, hello) => {
    expect(() => assertValidHello(hello as never)).toThrow(/sync-hello/);
  });
});

describe('分区同步水位（缺失判定 per-(对端, 分区)）', () => {
  it('扩权回补（回归锚点 · increment）：先授权 nsA，扩到 nsB 后历史事件补发', async () => {
    const policy = new MutablePolicy({ 'device-B': ['nsA'] });
    const a = await createDevice('device-A', { namespacePolicy: policy });
    const b = await createDevice('device-B');

    await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await a.store.createNode('fact', { text: 'b1' }, [], { namespace: 'nsB' });
    await a.store.createNode('fact', { text: 'a2' }, [], { namespace: 'nsA' });

    const [, first] = await runSync(a, b);
    // 只授权 nsA：nsB 事件被跳过，且不得把 nsB 记为已同步
    expect(await namespacesOn(b)).toEqual(['nsA', 'nsA']);
    expect(first.receivedEvents).toBe(2);

    // 扩权：nsB 的历史事件必须能补发（旧实现用全局累积时钟会在此失败）
    policy.mapping['device-B'] = ['nsA', 'nsB'];
    const [secondA, secondB] = await runSync(a, b);

    expect(secondA.sentEvents).toBe(1); // 仅补发 nsB 那条
    expect(secondB.receivedEvents).toBe(1);
    expect(await namespacesOn(b)).toEqual(['nsA', 'nsA', 'nsB']);
  });

  it('扩权回补（快照路径）：新对端在扩权后经快照拿到历史分区', async () => {
    const policy = new MutablePolicy({ 'device-B': ['nsA'] });
    const a = await createDevice('device-A', { namespacePolicy: policy, snapshotThreshold: 1 });
    const b = await createDevice('device-B');

    for (let i = 0; i < 3; i++) await a.store.createNode('fact', { text: `a${i}` }, [], { namespace: 'nsA' });
    for (let i = 0; i < 2; i++) await a.store.createNode('fact', { text: `b${i}` }, [], { namespace: 'nsB' });

    const [firstA, firstB] = await runSync(a, b);
    expect(firstA.snapshotSent).toBe(3); // 只含被授权的 nsA
    expect(firstB.snapshotApplied).toBe(3);
    expect(await namespacesOn(b)).toEqual(['nsA', 'nsA', 'nsA']);

    // 扩权后：不重发 nsA（水位已含 nsA），补发 nsB 历史
    policy.mapping['device-B'] = ['nsA', 'nsB'];
    const [secondA, secondB] = await runSync(a, b);
    expect(secondA.snapshotSent).toBeUndefined(); // 对端分区水位非空 → 走增量
    expect(secondB.receivedEvents).toBe(2);
    expect(await namespacesOn(b)).toEqual(['nsA', 'nsA', 'nsA', 'nsB', 'nsB']);

    // 快照路径：另一个全新对端在同样（已扩权）授权下，快照必须含 nsB 历史
    const c = await createDevice('device-C');
    policy.mapping['device-C'] = ['nsA', 'nsB'];
    const [thirdA, thirdC] = await runSync(a, c);
    expect(thirdA.snapshotSent).toBe(5);
    expect(thirdC.snapshotApplied).toBe(5);
    expect(await namespacesOn(c)).toEqual(['nsA', 'nsA', 'nsA', 'nsB', 'nsB']);
  });

  it('快照按分区裁剪边：未授权分区的边不进快照', async () => {
    const policy = new MutablePolicy({ 'device-B': ['nsA'] });
    const a = await createDevice('device-A', { namespacePolicy: policy, snapshotThreshold: 1 });
    const b = await createDevice('device-B');

    const na1 = await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    const na2 = await a.store.createNode('fact', { text: 'a2' }, [], { namespace: 'nsA' });
    const nb1 = await a.store.createNode('fact', { text: 'b1' }, [], { namespace: 'nsB' });
    const nb2 = await a.store.createNode('fact', { text: 'b2' }, [], { namespace: 'nsB' });
    await a.store.createEdge(na1.id, na2.id, 'rel');
    await a.store.createEdge(nb1.id, nb2.id, 'rel');

    const [resultA, resultB] = await runSync(a, b);

    expect(resultA.snapshotSent).toBe(3); // 2 个 nsA 节点 + 1 条 nsA 边
    expect(resultB.snapshotApplied).toBe(3);
    expect(await b.store.listNodes()).toHaveLength(2);
    const edges = await b.store.listEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0]!.namespace).toBe('nsA'); // 未授权的 nsB 边被裁掉
  });

  it('撤销/收紧：撤销后不发送、水位不被污染，再扩回仍正确', async () => {
    const policy = new MutablePolicy({ 'device-B': ['nsA', 'nsB'] });
    const a = await createDevice('device-A', { namespacePolicy: policy });
    const b = await createDevice('device-B');

    const a1 = await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    const b1 = await a.store.createNode('fact', { text: 'b1' }, [], { namespace: 'nsB' });
    await runSync(a, b);
    expect(await namespacesOn(b)).toEqual(['nsA', 'nsB']);

    // 撤销 nsB：之后新增的 nsB 事件不得发送
    policy.mapping['device-B'] = ['nsA'];
    const a2 = await a.store.createNode('fact', { text: 'a2' }, [], { namespace: 'nsA' });
    const b2 = await a.store.createNode('fact', { text: 'b2' }, [], { namespace: 'nsB' });
    await runSync(a, b);
    expect(await b.store.getNode(b2.id)).toBeNull();
    expect(await b.store.getNode(a2.id)).not.toBeNull();

    // 再扩回 nsB：从正确水位续传（只补 b2，不重发 b1）
    policy.mapping['device-B'] = ['nsA', 'nsB'];
    const [againA] = await runSync(a, b);
    expect(againA.sentEvents).toBe(1);
    expect(await b.store.getNode(b2.id)).not.toBeNull();
    expect(await b.store.getNode(b1.id)).not.toBeNull();
    expect(await b.store.getNode(a1.id)).not.toBeNull();
  });
});

describe('上报水位只用作者自身计数（F1）', () => {
  it('B 的事件携带 C 的计数、但 B 没有 C 在该分区的事件时，C 仍发送该分区历史', async () => {
    // 三设备：C 在 nsB 有一条事件；D 同步拿到 C 的计数后在 nsA 写入；
    // B 只从 D 拿到 nsA（于是 clock 含 C 的计数，但没有 C 的 nsB 事件）；
    // B 在 nsB 写入，其 vectorClock 因而携带 C 的计数。
    const cPolicy = new MutablePolicy({ 'device-B': ['nsA', 'nsB'], 'device-D': ['nsA', 'nsB'] });
    // B→C 只供 nsB：避免 B 把从 D 收到的第三方（D）事件中继给 C（夹具无证书链，中继会验签失败）
    const bPolicy = new MutablePolicy({ 'device-C': ['nsB'], 'device-D': ['nsA', 'nsB'] });
    const dPolicy = new MutablePolicy({ 'device-B': ['nsA'], 'device-C': ['nsA', 'nsB'] });

    const c = await createDevice('device-C', { namespacePolicy: cPolicy });
    const d = await createDevice('device-D', { namespacePolicy: dPolicy });
    const b = await createDevice('device-B', { namespacePolicy: bPolicy });

    const cNsB = await c.store.createNode('fact', { text: 'c-nsB' }, [], { namespace: 'nsB' });
    await runSync(c, d); // D 拿到 C 的 nsB 事件与其计数
    expect(await d.store.getNode(cNsB.id)).not.toBeNull();

    await d.store.createNode('fact', { text: 'd-nsA' }, [], { namespace: 'nsA' });
    await runSync(d, b); // D 只授权 B 接收 nsA：B 的 clock 含 C 的计数，但没有 C 的 nsB 事件
    expect(await b.store.getNode(cNsB.id)).toBeNull();

    const bNsB = await b.store.createNode('fact', { text: 'b-nsB' }, [], { namespace: 'nsB' });

    // C 与 B 同步：C 必须把 nsB 的历史事件（cNsB）发给 B
    await runSync(c, b);

    expect(await b.store.getNode(cNsB.id)).not.toBeNull(); // 修复前：上报水位被 C 的累积计数污染 → 永久不发送
    expect(await b.store.getNode(bNsB.id)).not.toBeNull();
  });
});

describe('对端自报不得抬升水位（R1）', () => {
  it('对端自报高于本机记录：不抬升水位，本机仍发送该分区事件（回归锚点）', async () => {
    const a = await createDevice('device-A', { namespacePolicy: grant('nsA') });
    await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await a.store.createNode('fact', { text: 'a2' }, [], { namespace: 'nsA' });

    const b = await createDevice('device-B');
    const [tA, tB] = await linkedTransports(a, b);

    let offeredCount = -1;
    const script = (async () => {
      const it = tB.receive()[Symbol.asyncIterator]();
      await it.next(); // A 的 hello
      // 谎报：自称已有 device-A 在 nsA 的前 99 条（远超真实）
      await tB.send({
        type: 'sync-hello',
        direction: 'bidirectional',
        subscribeAll: true,
        namespaces: [],
        namespaceClocks: { nsA: { 'device-A': 99 } },
      });
      const offer = (await it.next()).value as Extract<SyncMessage, { type: 'sync-offer' }>;
      offeredCount = offer.events.length;
      await tB.send({ type: 'sync-ack', appliedEventIds: offer.events.map((e) => e.id) });
      await tB.send({ type: 'sync-offer', events: [] });
      await it.next(); // A 的 ack
      await it.next(); // A 的 done
      await tB.send({ type: 'sync-done', finalVectorClock: {} });
    })();

    const result = await a.syncManager.syncWithDevice(tA, peerOf(b));
    await script;

    expect(offeredCount).toBe(2); // 自报不得抬升水位 → 事件照发（修复前为 0）
    expect(result.reportedAhead).toEqual({ nsA: { 'device-A': 99 } }); // 诊断信号
  });

  it('对端自报低于/等于本机记录：水位不抬升也不下降，无 divergence 信号', async () => {
    const a = await createDevice('device-A', { namespacePolicy: grant('nsA') });
    const b = await createDevice('device-B', { namespacePolicy: grant('nsA') });
    await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await runSync(a, b); // A 的 ack 水位 → {nsA:{'device-A':1}}

    const [tA, tB] = await linkedTransports(a, b);
    let offeredCount = -1;
    const script = (async () => {
      const it = tB.receive()[Symbol.asyncIterator]();
      await it.next(); // A 的 hello
      // 自称空（低于本机 ack 记录）：不得因此把本机水位下调
      await tB.send({ type: 'sync-hello', direction: 'bidirectional', subscribeAll: true, namespaces: [], namespaceClocks: {} });
      const offer = (await it.next()).value as Extract<SyncMessage, { type: 'sync-offer' }>;
      offeredCount = offer.events.length;
      await tB.send({ type: 'sync-ack', appliedEventIds: [] });
      await tB.send({ type: 'sync-offer', events: [] });
      await it.next(); // A 的 ack
      await it.next(); // A 的 done
      await tB.send({ type: 'sync-done', finalVectorClock: {} });
    })();

    const result = await a.syncManager.syncWithDevice(tA, peerOf(b));
    await script;

    expect(offeredCount).toBe(0); // ack 水位保留 → 已确认事件不重发
    expect(result.reportedAhead).toBeUndefined();
  });
});

describe('快照前提与回退保护（R2/R3）', () => {
  it('R2：对端分区水位非空时不发快照，改走增量', async () => {
    const a = await createDevice('device-A', { namespacePolicy: grant('nsA'), snapshotThreshold: 1 });
    const b = await createDevice('device-B', { namespacePolicy: grant('nsA') });
    await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });

    const [firstA] = await runSync(a, b);
    expect(firstA.snapshotSent).toBe(1); // 对端空 → 走快照

    const n2 = await a.store.createNode('fact', { text: 'a2' }, [], { namespace: 'nsA' });
    const [secondA] = await runSync(a, b);
    expect(secondA.snapshotSent).toBeUndefined(); // 对端分区水位非空 → 不发快照
    expect(secondA.sentEvents).toBe(1);
    expect(await b.store.getNode(n2.id)).not.toBeNull();
  });

  it('R3：旧快照不得回退本地更新的实体', async () => {
    const a = await createDevice('device-A', { namespacePolicy: grant('default') });
    const b = await createDevice('device-B');
    const created = await a.store.createNode('fact', { text: 'old' }, [], { namespace: 'default' });
    await a.store.updateNode(created.id, { content: { text: 'new' } });
    const staleNode = { ...created, content: { text: 'old' } }; // 快照里的旧版本（clock {A:1}）

    const [tA, tB] = await linkedTransports(a, b);
    const script = (async () => {
      const it = tB.receive()[Symbol.asyncIterator]();
      await it.next(); // A 的 hello
      await tB.send({ type: 'sync-hello', direction: 'bidirectional', subscribeAll: true, namespaces: [], namespaceClocks: {} });
      const offer = (await it.next()).value as Extract<SyncMessage, { type: 'sync-offer' }>;
      await tB.send({ type: 'sync-ack', appliedEventIds: (offer.events ?? []).map((e) => e.id) });
      await tB.send({
        type: 'sync-offer',
        events: [],
        snapshot: {
          nodes: [staleNode],
          edges: [],
          namespaceClocks: { default: { 'device-A': 1 } },
          namespaces: ['default'],
        },
      });
      await it.next(); // A 的 ack
      await it.next(); // A 的 done
      await tB.send({ type: 'sync-done', finalVectorClock: {} });
    })();

    const result = await a.syncManager.syncWithDevice(tA, peerOf(b));
    await script;

    expect(result.snapshotApplied).toBeUndefined(); // 旧版本被跳过（0 应用）
    expect((await a.store.getNode(created.id))?.content).toEqual({ text: 'new' }); // 未被回退
  });
});

describe('同步查询面与传输收尾', () => {
  it('getLocalVectorClock 与事件日志一致；传输可关闭', async () => {
    const a = await createDevice('device-A', { namespacePolicy: grant('default') });
    const b = await createDevice('device-B', { namespacePolicy: grant('default') });
    await a.store.createNode('fact', { text: 'x' });
    expect(a.syncManager.getLocalVectorClock().toJSON()).toEqual(a.eventLog.getClock().toJSON());

    const [tA, tB] = await linkedTransports(a, b);
    await expect(tA.close()).resolves.toBeUndefined();
    await expect(tB.close()).resolves.toBeUndefined();
  });
});

describe('同步水位持久化', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ns-watermark-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('per-(peer, ns) 水位落盘；重启后不重发已确认分区、不遗漏新分区', async () => {
    const statePath = join(dir, 'a.sync-state.json');
    const policy = new MutablePolicy({ 'device-B': ['nsA', 'nsB'] });
    const a1 = await createDevice('device-A', { namespacePolicy: policy, syncStatePath: statePath });
    const b = await createDevice('device-B');

    await a1.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await a1.store.createNode('fact', { text: 'b1' }, [], { namespace: 'nsB' });
    const [first] = await runSync(a1, b);
    expect(first.sentEvents).toBe(2);

    // 状态文件形状（v2）：per-(peer, ns) 水位存在且分区正确
    const saved = await loadState(statePath);
    expect(saved.version).toBe(2);
    expect(saved.peers['device-B']).toHaveLength(2);
    expect(Object.keys(saved.peerWatermarks['device-B']!).sort()).toEqual(['nsA', 'nsB']);

    // 重启：同一 storage/eventLog + 同一状态文件，新 SyncManager 实例
    const restarted = newSyncManager(a1, { namespacePolicy: policy, syncStatePath: statePath });

    // 重启后新增 nsA 事件：只发这条；旧事件不重发（水位持久化生效）
    const a2 = await a1.store.createNode('fact', { text: 'a2' }, [], { namespace: 'nsA' });
    const [postA, postB] = await runSyncWith(restarted, b.syncManager, a1, b);
    expect(postA.sentEvents).toBe(1);
    expect(postB.receivedEvents).toBe(1);
    expect(await b.store.getNode(a2.id)).not.toBeNull();

    // 不遗漏：重启后新增 nsB 事件也能送达
    const b2 = await a1.store.createNode('fact', { text: 'b2' }, [], { namespace: 'nsB' });
    const [thirdA] = await runSyncWith(restarted, b.syncManager, a1, b);
    expect(thirdA.sentEvents).toBe(1);
    expect(await b.store.getNode(b2.id)).not.toBeNull();
  });

  it('快照同步：确认 snapshotApplied 后按快照水位推进 peerWatermarks（F4）', async () => {
    const statePath = join(dir, 'a-f4.sync-state.json');
    const a = await createDevice('device-A', {
      namespacePolicy: grant('nsA'),
      snapshotThreshold: 1,
      syncStatePath: statePath,
    });
    const b = await createDevice('device-B', { namespacePolicy: grant('nsA') });
    await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await a.store.createNode('fact', { text: 'a2' }, [], { namespace: 'nsA' });

    const [resultA, resultB] = await runSync(a, b);
    expect(resultA.snapshotSent).toBe(2);
    expect(resultB.snapshotApplied).toBe(2);

    const saved = await loadState(statePath);
    // 发送方水位已由「快照已应用」确认推进，不再依赖对端下次 hello 自报
    expect(saved.peerWatermarks['device-B']?.nsA).toEqual({ 'device-A': 2 });
  });

  it('未确认 snapshotApplied：不乐观推进对端水位（F4）', async () => {
    const statePath = join(dir, 'a-f4-neg.sync-state.json');
    const a = await createDevice('device-A', {
      namespacePolicy: grant('nsA'),
      snapshotThreshold: 1,
      syncStatePath: statePath,
    });
    const b = await createDevice('device-B');
    await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await a.store.createNode('fact', { text: 'a2' }, [], { namespace: 'nsA' });

    const [tA, tB] = await linkedTransports(a, b);
    const script = (async () => {
      const it = tB.receive()[Symbol.asyncIterator]();
      await it.next(); // A 的 hello
      await tB.send({ type: 'sync-hello', direction: 'bidirectional', subscribeAll: true, namespaces: [], namespaceClocks: {} });
      await it.next(); // A 的 offer（快照）
      await tB.send({ type: 'sync-ack', appliedEventIds: [] }); // 故意不带 snapshotApplied
      await tB.send({ type: 'sync-offer', events: [] });
      await it.next(); // A 的 ack
      await it.next(); // A 的 done
      await tB.send({ type: 'sync-done', finalVectorClock: {} });
    })();

    const resultA = await a.syncManager.syncWithDevice(tA, peerOf(b));
    await script;
    expect(resultA.snapshotSent).toBe(2);
    const saved = await loadState(statePath);
    expect(saved.peerWatermarks['device-B']?.nsA).toBeUndefined(); // 未确认 → 不推进
  });

  it('resetPeerWatermarks：清水位但保留 per-event ack；被污染水位重置后事件会重发（F3）', async () => {
    const statePath = join(dir, 'a-f3.sync-state.json');
    const a0 = await createDevice('device-A', { namespacePolicy: grant('nsA') });
    const b = await createDevice('device-B', { namespacePolicy: grant('nsA') });
    const a1 = await a0.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await runSync(a0, b); // B 拿到 a1

    // 模拟被污染的水位：A 声称 B 在 nsA 已有 device-A:9（远高于实际），并沿用已确认集合
    await writeFile(
      statePath,
      JSON.stringify({
        version: 2,
        peers: { 'device-B': [a1.id] },
        peerWatermarks: { 'device-B': { nsA: { 'device-A': 9 } } },
        localSnapshotClocks: {},
      }),
      'utf-8',
    );
    const a = newSyncManager(a0, { namespacePolicy: grant('nsA'), syncStatePath: statePath });

    // 新增一条 nsA 事件（A:2）：被污染水位（9）覆盖 → 静默不发（正是要修的缺陷）
    const a2 = await a0.store.createNode('fact', { text: 'a2' }, [], { namespace: 'nsA' });
    const [before] = await runSyncWith(a, b.syncManager, a0, b);
    expect(before.sentEvents).toBe(0);

    // 修复路径：重置该对端水位 → 水位回落到对端自报（A:1），a2 被补发
    await a.resetPeerWatermarks('device-B');
    const saved = await loadState(statePath);
    expect(saved.peerWatermarks['device-B']).toBeUndefined();
    expect(saved.peers['device-B']).toEqual([a1.id]); // per-event ack 集合未被清

    const [after] = await runSyncWith(a, b.syncManager, a0, b);
    // 水位清空后不再被污染值抑制：a1、a2 都会重发（安全方向，最多冗余）
    expect(after.sentEvents).toBe(2);
    expect(await b.store.getNode(a2.id)).not.toBeNull();

    // 全部重置
    await a.resetPeerWatermarks();
    const cleared = await loadState(statePath);
    expect(Object.keys(cleared.peerWatermarks)).toHaveLength(0);
  });
});
