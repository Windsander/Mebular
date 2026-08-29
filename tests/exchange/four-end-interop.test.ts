// 四端互通集成测试（phase-6-plan 6.3，InMemoryHub）
//
// Hermes 端 + JSON 备忘录端 + Obsidian vault 端 + 日志型端：
// 各自经适配器产出图 → 分组同步再两两汇合 → 收敛到同一视图；
// 幂等键随图同步，任一端重复导入同源数据零重复；既有三端测试不回退。

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
import { ObsidianVaultAdapter } from '../../src/exchange/obsidian-adapter.js';
import { LogJournalAdapter } from '../../src/exchange/log-journal-adapter.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
} from '../p2p/helpers.js';

const HERMES_DIR = join(__dirname, 'fixtures', 'hermes');
const OBSIDIAN_VAULT = join(process.cwd(), 'examples/obsidian-vault/vault');
const LOG_JSONL = join(process.cwd(), 'examples/log-journal/data/journal.jsonl');

interface End {
  deviceId: string;
  storage: MemoryStorage;
  memory: MemoryStore;
  syncManager: SyncManager;
  publicKey: Uint8Array;
}

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

describe('四端互通：Hermes + json-memo + Obsidian + 日志型', () => {
  it('经 CMF + 适配器 + 同步收敛到同视图，跨端幂等成立', async () => {
    const master = await generateMasterKeyPair();
    const hermesEnd = await createEnd('end-hermes', master);
    const memoEnd = await createEnd('end-memo', master);
    const obsidianEnd = await createEnd('end-obsidian', master);
    const logEnd = await createEnd('end-log', master);

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

    const obsidianReport = await importWithAdapter(
      new ObsidianVaultAdapter(),
      { kind: 'obsidian-vault', data: OBSIDIAN_VAULT, origin: 'vault-desktop' },
      obsidianEnd.memory,
    );
    expect(obsidianReport.errors).toEqual([]);
    expect(obsidianReport.nodesCreated).toBe(10); // 3 笔记实体 + 6 条目 Fact + 1 mentions

    const logReport = await importWithAdapter(
      new LogJournalAdapter(),
      { kind: 'jsonl', data: await readFile(LOG_JSONL, 'utf-8'), origin: 'device-gateway' },
      logEnd.memory,
    );
    expect(logReport.errors).toEqual([]);
    expect(logReport.nodesCreated).toBe(4); // 容器 + 3 条目

    // 分组同步再汇合：H↔J、O↔L 后 H↔O 与 J↔L 交叉汇合
    await syncPair(hermesEnd, memoEnd);
    await syncPair(obsidianEnd, logEnd);
    await syncPair(hermesEnd, obsidianEnd);
    await syncPair(memoEnd, logEnd);

    // 收敛：四端节点集合一致（9 + 3 + 10 + 4）
    const expectedTotal = 9 + 3 + 10 + 4;
    const [hIds, jIds, oIds, lIds] = await Promise.all([
      sortedNodeIds(hermesEnd),
      sortedNodeIds(memoEnd),
      sortedNodeIds(obsidianEnd),
      sortedNodeIds(logEnd),
    ]);
    expect(hIds).toHaveLength(expectedTotal);
    expect(jIds).toEqual(hIds);
    expect(oIds).toEqual(hIds);
    expect(lIds).toEqual(hIds);

    // 同视图抽查：日志端能看到 Obsidian 笔记实体；Hermes 端能看到日志情节
    const entitiesAtLog = await logEnd.memory.listByType('entity');
    expect(
      entitiesAtLog.some(
        (e) => (e.content as Record<string, unknown> | undefined)?.name === 'GraphStore',
      ),
    ).toBe(true);
    const episodesAtHermes = await hermesEnd.memory.listByType('episode');
    expect(
      episodesAtHermes.some(
        (e) =>
          (e.content as Record<string, unknown> | undefined)?.content ===
          '手动记录：今天把 vault 接进了图',
      ),
    ).toBe(true);

    // 边同样收敛：wiki-link related_to 3 条 + 日志 follows 2 条，每端可见
    const edgesAtMemo = await memoEnd.storage.listEdges();
    expect(edgesAtMemo.filter((e) => e.relation === 'related_to')).toHaveLength(3);
    expect(edgesAtMemo.filter((e) => e.relation === 'follows')).toHaveLength(2);

    // 跨端幂等：日志端重复导入同一 vault → 全量命中跳过
    const reimport = await importWithAdapter(
      new ObsidianVaultAdapter(),
      { kind: 'obsidian-vault', data: OBSIDIAN_VAULT, origin: 'vault-desktop' },
      logEnd.memory,
    );
    expect(reimport.nodesCreated).toBe(0);
    expect(reimport.skipped).toBe(10);
    expect(await sortedNodeIds(logEnd)).toHaveLength(expectedTotal);

    // 跨端幂等（另一端源）：Obsidian 端重复导入同一 JSONL → 全量命中跳过
    const reimportLog = await importWithAdapter(
      new LogJournalAdapter(),
      { kind: 'jsonl', data: await readFile(LOG_JSONL, 'utf-8'), origin: 'device-gateway' },
      obsidianEnd.memory,
    );
    expect(reimportLog.nodesCreated).toBe(0);
    expect(reimportLog.skipped).toBe(4);
    expect(await sortedNodeIds(obsidianEnd)).toHaveLength(expectedTotal);
  });
});
