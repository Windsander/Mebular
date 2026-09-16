// 独立随机化交叉验证：默认拒绝授权下的「不漏发 / 不越权」不变量（播种可复现）。
//
// 与场景化套件（namespace-watermarks.test.ts）互补：不做针对性构造，而是随机
// 交错「写不同分区 + 随机扩权/撤销 + 同步（含中途重启）」，每步后断言两条不变量：
//   1. 当前已授权分区的全部历史事件必须出现在对端（不漏发，含扩权回补）；
//   2. 对端出现的本机节点只能来自「曾被授权过」的分区（不越权，含撤销后残留）。
// 任何水位污染 / 授权旁路 / 回补丢失都会在这些不变量上暴露。

import { describe, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog, type EventSigner } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { SyncManager, type SyncPeer } from '../../src/sync/syncmgr/SyncManager.js';
import type { NamespaceGrantPolicy } from '../../src/sync/namespacePolicy.js';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { SecureChannelSyncTransport } from '../../src/sync/protocol.js';
import type { PeerId } from '../../src/p2p/P2PNetwork.js';

const NS_POOL = ['default', 'ns-alpha', 'ns-beta'] as const;

/** mulberry32：确定性 PRNG，保证失败可复现 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Device {
  deviceId: string;
  storage: MemoryStorage;
  eventLog: EventLog;
  store: GraphStore;
  publicKey: Uint8Array;
  peerId: PeerId;
}

async function createDevice(deviceId: string): Promise<Device> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const signer: EventSigner = { deviceId, privateKey: keyPair.privateKey };
  const storage = new MemoryStorage();
  const eventLog = new EventLog(storage, deviceId, { signer });
  const store = new GraphStore({ storage, author: deviceId, eventLog });
  return { deviceId, storage, eventLog, store, publicKey, peerId: { multihash: publicKey, pubKey: publicKey, id: deviceId } };
}

function peerOf(device: Device): SyncPeer {
  return { deviceId: device.deviceId, publicKey: device.publicKey };
}

async function runSync(a: Device, b: Device, aManager: SyncManager, bManager: SyncManager): Promise<void> {
  const hub = new InMemoryHub();
  const [connA, connB] = hub.createLinkedPair(a.peerId, b.peerId);
  const channelA = new SecureChannelImpl(connA);
  const channelB = new SecureChannelImpl(connB);
  await Promise.all([channelA.start(), channelB.start()]);
  await Promise.all([
    aManager.syncWithDevice(new SecureChannelSyncTransport(channelA), peerOf(b), { direction: 'bidirectional' }),
    bManager.acceptSync(new SecureChannelSyncTransport(channelB), peerOf(a)),
  ]);
}

async function runFuzz(seed: number): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mebular-fuzz-'));
  const a = await createDevice('device-A');
  const b = await createDevice('device-B');

  let authorized: string[] = [];
  const everAuthorized = new Set<string>();
  const policyA: NamespaceGrantPolicy = {
    getAuthorizedNamespaces: async () => [...authorized],
  };
  const policyB: NamespaceGrantPolicy = {
    getAuthorizedNamespaces: async () => [...NS_POOL],
  };

  const aStatePath = join(dir, 'a.sync-state.json');
  const bStatePath = join(dir, 'b.sync-state.json');
  const makeManager = (device: Device, policy: NamespaceGrantPolicy, statePath: string) =>
    new SyncManager({
      eventLog: device.eventLog,
      storage: device.storage,
      deviceId: device.deviceId,
      namespacePolicy: policy,
      syncStatePath: statePath,
    });

  let aManager = makeManager(a, policyA, aStatePath);
  const bManager = makeManager(b, policyB, bStatePath);

  const writes: Array<{ id: string; ns: string }> = [];
  const random = rng(seed);

  try {
    for (let step = 0; step < 40; step++) {
      // 随机写入：0~2 条
      const writeCount = Math.floor(random() * 3);
      for (let w = 0; w < writeCount; w++) {
        const ns = NS_POOL[Math.floor(random() * NS_POOL.length)]!;
        const node = await a.store.createNode('fact', { text: `s${seed}-step${step}-w${w}` }, undefined, { namespace: ns });
        writes.push({ id: node.id, ns });
      }
      // 随机授权变更：从池中抽子集（可为空 = 撤销全部）
      authorized = NS_POOL.filter(() => random() < 0.6);
      for (const ns of authorized) everAuthorized.add(ns);

      await runSync(a, b, aManager, bManager);

      // 不变量 1：当前授权分区的历史写入必须全部在 B（扩权回补）
      for (const { id, ns } of writes) {
        if (!authorized.includes(ns)) continue;
        const onB = await b.store.getNode(id);
        if (!onB) throw new Error(`seed=${seed} step=${step} 漏发：ns=${ns} id=${id}`);
      }
      // 不变量 2：B 上的 A 节点不得来自从未授权过的分区（不越权）
      const onBAll = await b.store.listNodes({ type: 'fact' });
      for (const node of onBAll) {
        const ns = node.namespace ?? 'default';
        if (!everAuthorized.has(ns)) {
          throw new Error(`seed=${seed} step=${step} 越权：ns=${ns} id=${node.id}`);
        }
      }

      // 中途重启 A（水位落盘后重建 SyncManager），继续走同一序列
      if (step === 17) {
        aManager = makeManager(a, policyA, aStatePath);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('默认拒绝授权的随机化不变量（独立交叉验证）', () => {
  for (const seed of [1, 7, 42]) {
    it(`seed=${seed}：随机写/扩权/撤销/重启交错后不漏发、不越权`, async () => {
      await runFuzz(seed);
    }, 30000);
  }
});
