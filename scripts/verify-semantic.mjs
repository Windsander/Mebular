#!/usr/bin/env node
// 语义召回验证（G2）
//
// 在构建产物上验证：
//   1. 注入确定性语义 embedding 时，retrieveMemory({query: 同义不同词}) 命中目标记忆；
//      同一查询在纯关键词基线下漏召（证明向量路径确实起作用）。
//   2. 缺 embedding 包时 resolveVectorIndex 降级关键词并告警，不抛错。
//   3. required 模式缺包时诚实抛 SEMANTIC_EMBEDDING_NOT_AVAILABLE。
//   4. 可选（MEBULAR_EMBEDDING_E2E=1）：加载真实 @huggingface/transformers 做一次
//      同义召回，作为真实模型冒烟；未设置则明确跳过（不冒充已跑）。
//
// 前置：npm run build
// 运行：node scripts/verify-semantic.mjs
//       MEBULAR_EMBEDDING_E2E=1 node scripts/verify-semantic.mjs  # 含真实模型

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

let allPassed = true;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) allPassed = false;
};

console.log('Mebular G2 语义召回验证');
console.log('========================');

const mebular = await import(join(rootDir, 'dist', 'index.js'));
const {
  Mebular,
  IdentityManager,
  HermesMemoryProvider,
  MemoryStore,
  resolveVectorIndex,
  createTransformersEmbeddingProvider,
} = mebular;

const CONCEPTS = [
  ['dark', 'night', 'dark mode', '深色', '深色主題', '夜間', '夜间', '暗色'],
  ['coffee', '咖啡', 'espresso'],
  ['rust', 'rustlang', '記憶體安全'],
];
const embedText = (text) => {
  const lower = text.toLowerCase();
  return CONCEPTS.map((syns) => (syns.some((s) => lower.includes(s.toLowerCase())) ? 1 : 0));
};
const fakeProvider = {
  id: 'fake-semantic',
  async embed(texts) {
    return texts.map(embedText);
  },
};

const dir = await mkdtemp(join(tmpdir(), 'mebular-semantic-'));
try {
  const master = await new IdentityManager().generateUserMasterKey();
  const masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };

  // 1. 注入 provider：同义召回
  const app = new Mebular({
    storagePath: join(dir, 'store.jsonl'),
    deviceId: 'device-semantic',
    encryption: masterKeys,
    semantic: { enabled: true, provider: fakeProvider },
    sync: { autoSync: false },
  });
  await app.initialize();
  check('门面 semantic 注入后向量索引就绪', app.semanticVectorIndex !== null);

  const provider = new HermesMemoryProvider(app);
  await provider.storeMemory({ type: 'fact', content: '深色主題' });
  const result = await provider.retrieveMemory({ query: '夜間模式' });
  check(
    'retrieveMemory 同义不同词命中目标记忆',
    result.totalMatches === 1 && (result.memories[0]?.relevance ?? 0) > 0.9,
    `totalMatches=${result.totalMatches}`,
  );

  const keywordStore = new MemoryStore(app.graph);
  const keywordHits = await keywordStore.search('夜間模式');
  check('关键词基线对同义查询漏召（对照）', keywordHits.length === 0, `hits=${keywordHits.length}`);
  await app.shutdown();

  // 2. 缺包降级 + 告警
  const warnings = [];
  const missing = await resolveVectorIndex({
    importer: async () => {
      throw new Error('Cannot find module @huggingface/transformers');
    },
    warn: (m) => warnings.push(m),
  });
  check('缺包时 resolveVectorIndex 返回 null（降级）', missing === null);
  check('缺包时输出降级告警', warnings.some((w) => w.includes('降級為關鍵詞基線')));

  // 3. required 模式诚实报错
  let requiredCode = null;
  try {
    await resolveVectorIndex({
      importer: async () => {
        throw new Error('Cannot find module @huggingface/transformers');
      },
      required: true,
    });
  } catch (error) {
    requiredCode = error?.code ?? null;
  }
  check(
    'required 模式缺包抛 SEMANTIC_EMBEDDING_NOT_AVAILABLE',
    requiredCode === 'SEMANTIC_EMBEDDING_NOT_AVAILABLE',
    String(requiredCode),
  );

  // 4. 可选真实模型冒烟
  if (process.env.MEBULAR_EMBEDDING_E2E === '1') {
    try {
      const real = await createTransformersEmbeddingProvider({});
      const vectors = await real.embed(['深色主題', '夜間模式']);
      const cosine = (a, b) => {
        let dot = 0;
        let na = 0;
        let nb = 0;
        for (let i = 0; i < a.length; i++) {
          dot += a[i] * b[i];
          na += a[i] * a[i];
          nb += b[i] * b[i];
        }
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
      };
      check('真实模型加载并嵌入', vectors.length === 2);
      check(
        '真实模型同义余弦相似度 > 0.5',
        cosine(vectors[0], vectors[1]) > 0.5,
        `cos=${cosine(vectors[0], vectors[1]).toFixed(3)}`,
      );
    } catch (error) {
      check('真实模型冒烟', false, String(error?.message ?? error).substring(0, 160));
    }
  } else {
    console.log('  ⚠ 跳过真实模型冒烟（设 MEBULAR_EMBEDDING_E2E=1 启用；需安装可选包并下载模型）');
  }
} catch (error) {
  console.log('  ✗ 验证异常:', String(error?.stack ?? error).substring(0, 600));
  allPassed = false;
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('='.repeat(24));
if (allPassed) {
  console.log('✓ G2 语义召回验证通过');
  process.exit(0);
} else {
  console.log('✗ G2 语义召回验证失败');
  process.exit(1);
}
