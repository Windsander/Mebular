#!/usr/bin/env node
// 语义召回验证（G2-R）
//
// 两种模式：
//   node scripts/verify-semantic.mjs            降级/失败路径（缺包回退、required 报错）
//   node scripts/verify-semantic.mjs --real     真实模型 + 产品路径（E1 能力声明）
//
// --real 会：
//   1) 断言可选包可加载（缺包即红，退出码 1）；
//   2) 不注入 provider，配置 semantic.enabled + 真实模型，走 Mebular/Hermes 产品路径；
//   3) 中文同义召回命中（打印真实余弦）；
//   4) 重启恢复：写入 → shutdown → 重新 initialize → 同义召回仍命中（惰性重建）；
//   5) 分布式召回：A 写 → B 同步 → B 同义召回命中；
//   6) 低相关查询返回空（阈值过滤，不硬塞 top-k）。
//
// 前置：npm run build；--real 需已安装 @huggingface/transformers。
// 模型缓存目录：MEBULAR_EMBEDDING_CACHE_DIR（缺省 <repo>/.cache/transformers，CI 缓存此目录）。

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const REAL =
  process.argv.includes('--real') ||
  process.env.MEBULAR_EMBEDDING_REAL === '1' ||
  process.env.npm_config_real === 'true';
const CACHE_DIR = process.env.MEBULAR_EMBEDDING_CACHE_DIR ?? join(rootDir, '.cache', 'transformers');

let allPassed = true;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) allPassed = false;
};

console.log(`Mebular G2-R 语义召回验证（${REAL ? 'REAL 真实模型' : '降级/失败路径'}）`);
console.log('=================================================');

const mebular = await import(join(rootDir, 'dist', 'index.js'));
const {
  Mebular,
  IdentityManager,
  HermesMemoryProvider,
  MemoryStore,
  resolveVectorIndex,
  createTransformersEmbeddingProvider,
  InMemoryHub,
} = mebular;

const missingImporter = async () => {
  throw new Error('Cannot find module @huggingface/transformers');
};

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function runReal() {
  // 1) 可选包必须可加载（缺包即红）
  try {
    await createTransformersEmbeddingProvider({ cacheDir: CACHE_DIR });
  } catch (error) {
    check('真实 embedding 包可加载', false, String(error?.code ?? error?.message));
    console.log(
      `\n✗ 缺少可选依赖 ${mebular.TRANSFORMERS_PACKAGE ?? '@huggingface/transformers'}。` +
        `安装：npm install @huggingface/transformers（CI 见 .github/workflows/ci.yml 的 semantic-real job）`,
    );
    return;
  }
  check('真实 embedding 包可加载', true, CACHE_DIR);

  const dir = await mkdtemp(join(tmpdir(), 'mebular-semantic-real-'));
  const master = await new IdentityManager().generateUserMasterKey();
  const masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  const semantic = { enabled: true, cacheDir: CACHE_DIR };
  const evidence = { model: mebular.DEFAULT_EMBEDDING_MODEL, cacheDir: CACHE_DIR, checks: {} };

  try {
    // 2) 产品路径中文同义召回
    const pathA = join(dir, 'a.jsonl');
    const a = new Mebular({ storagePath: pathA, deviceId: 'device-A', encryption: masterKeys, semantic, sync: { autoSync: false } });
    await a.initialize();
    check('门面 semantic 真实模型就绪（未注入 provider）', a.semanticVectorIndex !== null);

    const providerA = new HermesMemoryProvider(a);
    await providerA.storeMemory({ type: 'fact', content: '我偏好深色主題' });
    await providerA.storeMemory({ type: 'fact', content: '我喜歡喝咖啡' });

    const result = await providerA.retrieveMemory({ query: '夜間模式' });
    const top = result.memories[0];
    evidence.checks.productPath = { query: '夜間模式', totalMatches: result.totalMatches, top: top?.content, relevance: top?.relevance };
    check(
      '产品路径同义召回命中（中文）',
      result.totalMatches >= 1 && typeof top?.content === 'string' && top.content.includes('深色'),
      `top=${top?.content} relevance=${(top?.relevance ?? 0).toFixed(3)}`,
    );

    const keywordOnly = new MemoryStore(a.graph);
    const keywordHits = await keywordOnly.search('夜間模式');
    check('关键词基线对同义查询漏召（对照）', keywordHits.length === 0, `hits=${keywordHits.length}`);

    // 真实余弦（报告用）
    const real = await createTransformersEmbeddingProvider({ cacheDir: CACHE_DIR });
    const [q, dark, coffee] = await real.embed(['夜間模式', '我偏好深色主題', '我喜歡喝咖啡']);
    evidence.cosines = { query_dark: cosine(q, dark), query_coffee: cosine(q, coffee) };
    check(
      '真实余弦：同义 > 无关',
      cosine(q, dark) > cosine(q, coffee),
      `dark=${cosine(q, dark).toFixed(3)} coffee=${cosine(q, coffee).toFixed(3)}`,
    );

    // 3) 低相关查询返回空（阈值过滤）
    const lowRel = await providerA.retrieveMemory({ query: '量子力學弦論的十維緊緻化推導' });
    evidence.checks.lowRelevance = { totalMatches: lowRel.totalMatches };
    check('低相关查询返回空（不硬塞 top-k）', lowRel.totalMatches === 0, `totalMatches=${lowRel.totalMatches}`);

    await a.shutdown();

    // 4) 重启恢复：重新 initialize 后同义召回仍命中（自动化重建，无需手动调用）
    const a2 = new Mebular({ storagePath: pathA, deviceId: 'device-A', encryption: masterKeys, semantic, sync: { autoSync: false } });
    await a2.initialize();
    const providerA2 = new HermesMemoryProvider(a2);
    const restart = await providerA2.retrieveMemory({ query: '夜間模式' });
    evidence.checks.restart = { totalMatches: restart.totalMatches, top: restart.memories[0]?.content };
    check(
      '重启恢复：无需手动重建即召回命中',
      restart.totalMatches >= 1 && String(restart.memories[0]?.content ?? '').includes('深色'),
      `totalMatches=${restart.totalMatches}`,
    );
    await a2.shutdown();

    // 5) 分布式召回：A 写 → B 同步 → B 召回命中
    const hub = new InMemoryHub();
    const bPath = join(dir, 'b.jsonl');
    const a3 = new Mebular({ storagePath: join(dir, 'a-sync.jsonl'), deviceId: 'device-A', encryption: masterKeys, semantic, network: { enabled: true, provider: hub }, sync: { autoSync: true } });
    const b3 = new Mebular({ storagePath: bPath, deviceId: 'device-B', encryption: masterKeys, semantic, network: { enabled: true, provider: hub }, sync: { autoSync: true } });
    await a3.initialize();
    await b3.initialize();
    const providerA3 = new HermesMemoryProvider(a3);
    const providerB3 = new HermesMemoryProvider(b3);
    await providerA3.storeMemory({ type: 'fact', content: '我偏好深色主題' });
    const syncedB = new Promise((resolve) => b3.sync.once('sync-completed', resolve));
    const syncedA = new Promise((resolve) => a3.sync.once('sync-completed', resolve));
    await b3.node.connectToPeer(a3.node.peerId);
    await Promise.all([syncedA, syncedB]);
    const distributed = await providerB3.retrieveMemory({ query: '夜間模式' });
    evidence.checks.distributed = { totalMatches: distributed.totalMatches, top: distributed.memories[0]?.content };
    check(
      '分布式召回：对端同步入库节点本端可召回',
      distributed.totalMatches >= 1 && String(distributed.memories[0]?.content ?? '').includes('深色'),
      `totalMatches=${distributed.totalMatches}`,
    );
    await a3.shutdown();
    await b3.shutdown();

    const outDir = join(rootDir, '.semantic-evidence');
    await mkdir(outDir, { recursive: true });
    const outPath = join(outDir, `semantic-real-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(outPath, JSON.stringify(evidence, null, 2), 'utf-8');
    console.log(`  ↳ 证据写入：${outPath}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runDegrade() {
  const warnings = [];
  const missing = await resolveVectorIndex({ importer: missingImporter, warn: (m) => warnings.push(m) });
  check('缺包时 resolveVectorIndex 返回 null（降级）', missing === null);
  check('缺包时输出降级告警', warnings.some((w) => w.includes('降級為關鍵詞基線')));

  let requiredCode = null;
  try {
    await resolveVectorIndex({ importer: missingImporter, required: true });
  } catch (error) {
    requiredCode = error?.code ?? null;
  }
  check(
    'required 模式缺包抛 SEMANTIC_EMBEDDING_NOT_AVAILABLE',
    requiredCode === 'SEMANTIC_EMBEDDING_NOT_AVAILABLE',
    String(requiredCode),
  );

  console.log('  ⚠ 本模式只验证降级/失败路径；能力声明请运行 `npm run verify:semantic --real`（E1）。');
}

try {
  if (REAL) {
    await runReal();
  } else {
    await runDegrade();
  }
} catch (error) {
  console.log('  ✗ 验证异常:', String(error?.stack ?? error).substring(0, 800));
  allPassed = false;
}

console.log('='.repeat(49));
if (allPassed) {
  console.log(REAL ? '✓ G2-R 语义召回真实验证通过' : '✓ G2 语义召回降级路径验证通过');
  process.exit(0);
} else {
  console.log('✗ G2-R 语义召回验证失败');
  process.exit(1);
}
