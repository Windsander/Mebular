// G2-R 真实语义召回用例（真实模型 + 产品路径）
//
// 用 Node 内建 test runner（非 jest）：onnxruntime 在 jest 的 vm realm 下会因
// Float32Array 跨 realm 判定失败；node:test 在普通 realm 运行，可加载真实模型。
//
// 运行（需已安装 @huggingface/transformers）：
//   MEBULAR_EMBEDDING_CACHE_DIR=.cache/transformers node --test tests-semantic/real-semantic.test.mjs
// 由 CI 的 semantic-real job 驱动。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = await import(join(rootDir, 'dist', 'index.js'));
const { Mebular, IdentityManager, HermesMemoryProvider, MemoryStore, InMemoryHub } = dist;

const CACHE_DIR = process.env.MEBULAR_EMBEDDING_CACHE_DIR ?? join(rootDir, '.cache', 'transformers');
const semantic = () => ({ enabled: true, cacheDir: CACHE_DIR });

let dir;
let masterKeys;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mebular-real-semantic-'));
  const master = await new IdentityManager().generateUserMasterKey();
  masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('真实模型产品路径：中文同义召回命中，关键词基线漏召', async () => {
  const app = new Mebular({
    storagePath: join(dir, 'p1.jsonl'),
    deviceId: 'device-A',
    encryption: masterKeys,
    semantic: semantic(),
    sync: { autoSync: false },
  });
  await app.initialize();
  assert.notEqual(app.semanticVectorIndex, null);

  const provider = new HermesMemoryProvider(app);
  await provider.storeMemory({ type: 'fact', content: '我偏好深色主題' });
  await provider.storeMemory({ type: 'fact', content: '我喜歡喝咖啡' });

  const result = await provider.retrieveMemory({ query: '夜間模式' });
  assert.ok(result.totalMatches >= 1, `totalMatches=${result.totalMatches}`);
  assert.match(String(result.memories[0].content), /深色/);
  assert.ok(result.memories[0].relevance > 0.2, `relevance=${result.memories[0].relevance}`);

  const keywordOnly = new MemoryStore(app.graph);
  assert.equal((await keywordOnly.search('夜間模式')).length, 0);

  await app.shutdown();
});

test('重启恢复：重新 initialize 后无需手动重建即召回命中', async () => {
  const storagePath = join(dir, 'p2.jsonl');
  const first = new Mebular({
    storagePath,
    deviceId: 'device-A',
    encryption: masterKeys,
    semantic: semantic(),
    sync: { autoSync: false },
  });
  await first.initialize();
  await new HermesMemoryProvider(first).storeMemory({ type: 'fact', content: '我偏好深色主題' });
  await first.shutdown();

  const second = new Mebular({
    storagePath,
    deviceId: 'device-A',
    encryption: masterKeys,
    semantic: semantic(),
    sync: { autoSync: false },
  });
  await second.initialize();
  const result = await new HermesMemoryProvider(second).retrieveMemory({ query: '夜間模式' });
  assert.ok(result.totalMatches >= 1, `totalMatches=${result.totalMatches}`);
  assert.match(String(result.memories[0].content), /深色/);
  await second.shutdown();
});

test('分布式召回：对端同步入库的节点本端可见', async () => {
  const hub = new InMemoryHub();
  const a = new Mebular({
    storagePath: join(dir, 'a.jsonl'),
    deviceId: 'device-A',
    encryption: masterKeys,
    semantic: semantic(),
    network: { enabled: true, provider: hub },
    // 默认拒绝：分布式召回需显式授权对端（本用例记忆落在 default 分区）
    sync: { autoSync: true, peerNamespacePolicy: { 'device-B': ['default'] } },
  });
  const b = new Mebular({
    storagePath: join(dir, 'b.jsonl'),
    deviceId: 'device-B',
    encryption: masterKeys,
    semantic: semantic(),
    network: { enabled: true, provider: hub },
    sync: { autoSync: true, peerNamespacePolicy: { 'device-A': ['default'] } },
  });
  await a.initialize();
  await b.initialize();
  await new HermesMemoryProvider(a).storeMemory({ type: 'fact', content: '我偏好深色主題' });

  const aSynced = new Promise((resolve) => a.sync.once('sync-completed', resolve));
  const bSynced = new Promise((resolve) => b.sync.once('sync-completed', resolve));
  await b.node.connectToPeer(a.node.peerId);
  await Promise.all([aSynced, bSynced]);

  const result = await new HermesMemoryProvider(b).retrieveMemory({ query: '夜間模式' });
  assert.ok(result.totalMatches >= 1, `totalMatches=${result.totalMatches}`);
  assert.match(String(result.memories[0].content), /深色/);

  await a.shutdown();
  await b.shutdown();
});

test('低相关查询返回空（阈值过滤，不硬塞 top-k）', async () => {
  const app = new Mebular({
    storagePath: join(dir, 'p4.jsonl'),
    deviceId: 'device-A',
    encryption: masterKeys,
    semantic: semantic(),
    sync: { autoSync: false },
  });
  await app.initialize();
  const provider = new HermesMemoryProvider(app);
  await provider.storeMemory({ type: 'fact', content: '我偏好深色主題' });
  const result = await provider.retrieveMemory({ query: '量子力學弦論的十維緊緻化推導' });
  assert.equal(result.totalMatches, 0);
  await app.shutdown();
});
