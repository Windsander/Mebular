// 三端互通集成测试（phase-5-plan 5.4，InMemoryHub）
//
// Hermes 端 + JSON 备忘录端 + 纯 Mebular 端：
// 各自经适配器（或直写）产出图 → 两两全双向同步（含两跳中继）→
// 收敛到同一视图；幂等键随图同步，任一端重复导入同源数据零重复。

import { describe, it, expect } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog, type EventSigner } from '../../src/eventlog/EventLog.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { SyncManager, type SyncPeer, type SyncResult } from '../../src/sync/syncmgr/SyncManager.js';
import { SecureChannelSyncTransport } from '../../src/sync/protocol.js';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { importWithAdapter } from '../../src/exchange/adapter.js';
import { HermesAdapter } from '../../src/exchange/hermes-adapter.js';
import { JsonMemoAdapter } from '../../src/exchange/json-memo-adapter.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
} from '../p2p/helpers.js';

const HERMES_DIR = join(__dirname, 'fixtures', 'hermes');

interface End {
  deviceId: string;
  storage: MemoryStorage;
  memory: MemoryStore;
  syncManager: SyncManager;
  publicKey: Uint8Array;
}

/** 带主密钥证书的端（中继事件经证书链验签，5.1 能力） */
async function createEnd(deviceId: string, master: CryptoKeyPair): Promise<End> {
  const identity = await createTestIdentity(deviceId);
  const certificate = await issueCertificate(master.privateKey, identity);
  const signer: EventSigner = {
    deviceId,
    privateKey: identity.identity.devicePrivateKey,
    certificate,
  };
  const storage = new MemoryStorage();
  const eventLog = new EventLog(storage, deviceId, { signer });
  const memory = new MemoryStore(new GraphStore({ storage, author: deviceId, eventLog }));
  const syncManager = new SyncManager({
    eventLog,
    storage,
    deviceId,
    userMasterPublicKey: await masterPublicKeyBytes(master),
  });
  return { deviceId, storage, memory, syncManager, publicKey: identity.identity.devicePublicKey };
}

function peerOf(end: End): SyncPeer {
  return { deviceId: end.deviceId, publicKey: end.publicKey };
}

async function syncPair(a: End, b: End): Promise<[SyncResult, SyncResult]> {
  const hub = new InMemoryHub();
  const peerA = { multihash: a.publicKey, pubKey: a.publicKey, id: a.deviceId };
  const peerB = { multihash: b.publicKey, pubKey: b.publicKey, id: b.deviceId };
  const [connA, connB] = hub.createLinkedPair(peerA, peerB);
  const channelA = new SecureChannelImpl(connA);
  const channelB = new SecureChannelImpl(connB);
  await Promise.all([channelA.start(), channelB.start()]);
  return Promise.all([
    a.syncManager.syncWithDevice(new SecureChannelSyncTransport(channelA), peerOf(b)),
    b.syncManager.acceptSync(new SecureChannelSyncTransport(channelB), peerOf(a)),
  ]);
}

async function sortedNodeIds(end: End): Promise<string[]> {
  return (await end.storage.listNodes()).map((n) => n.id).sort();
}

describe('三端互通：Hermes + json-memo + 纯 Mebular', () => {
  it('经 CMF + 适配器 + 同步收敛到同视图，跨端幂等成立', async () => {
    const master = await generateMasterKeyPair();
    const hermesEnd = await createEnd('end-hermes', master);
    const memoEnd = await createEnd('end-memo', master);
    const mebularEnd = await createEnd('end-mebular', master);

    // 各端异构输入
    const hermesReport = await importWithAdapter(
      new HermesAdapter(),
      { kind: 'hermes-dir', data: HERMES_DIR, origin: 'hermes-laptop' },
      hermesEnd.memory,
    );
    expect(hermesReport.errors).toEqual([]);
    expect(hermesReport.nodesCreated).toBe(9);

    const memoSample = JSON.parse(
      await readFile(join(process.cwd(), 'examples/json-memo/data/memos.json'), 'utf-8'),
    ) as unknown;
    await importWithAdapter(
      new JsonMemoAdapter(),
      { kind: 'json-memo', data: memoSample, origin: 'memo-phone' },
      memoEnd.memory,
    );

    await mebularEnd.memory.addEntity({ entityType: 'concept', name: 'Mebular 本体' });
    await mebularEnd.memory.addFact({ subject: 'Mebular 本体', predicate: 'kind', object: 'graph-memory' });

    // 全互联两两双向同步（H↔M、J↔M 后 M 成为中继；再 H↔J 直接互通）
    await syncPair(hermesEnd, memoEnd);
    await syncPair(memoEnd, mebularEnd);
    await syncPair(hermesEnd, mebularEnd);

    // 收敛：三端节点集合一致（9 Hermes + 3 memo + 2 纯 Mebular）
    const expectedTotal = 9 + 3 + 2;
    const [hIds, jIds, mIds] = await Promise.all([
      sortedNodeIds(hermesEnd),
      sortedNodeIds(memoEnd),
      sortedNodeIds(mebularEnd),
    ]);
    expect(hIds).toHaveLength(expectedTotal);
    expect(jIds).toEqual(hIds);
    expect(mIds).toEqual(hIds);

    // 同视图抽查：memo 端能看到 Hermes 的条目事实；Hermes 端能看到备忘情节
    const factsAtMemo = await memoEnd.memory.listActiveFacts();
    expect(factsAtMemo.some((f) => f.content.predicate === '偏好')).toBe(true);
    const episodesAtHermes = await hermesEnd.memory.listByType('episode');
    expect(
      episodesAtHermes.some(
        (e) => (e.content as Record<string, unknown> | undefined)?.title === '读书摘记',
      ),
    ).toBe(true);
    const conceptAtJsonMemo = await memoEnd.memory.listByType('entity');
    expect(
      conceptAtJsonMemo.some(
        (e) => (e.content as Record<string, unknown> | undefined)?.name === 'Mebular 本体',
      ),
    ).toBe(true);

    // 边同样收敛（5 条 source_of）
    const edgesAtM = await mebularEnd.storage.listEdges();
    expect(edgesAtM.filter((e) => e.relation === 'source_of')).toHaveLength(5);

    // 跨端幂等：纯 Mebular 端重复导入同一 Hermes 目录 → 全量命中跳过
    const reimport = await importWithAdapter(
      new HermesAdapter(),
      { kind: 'hermes-dir', data: HERMES_DIR, origin: 'hermes-laptop' },
      mebularEnd.memory,
    );
    expect(reimport.nodesCreated).toBe(0);
    expect(reimport.skipped).toBe(9);
    expect(await sortedNodeIds(mebularEnd)).toHaveLength(expectedTotal);
  });
});
