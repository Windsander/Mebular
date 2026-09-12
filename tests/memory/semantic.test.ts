// 语义召回测试（G2）
//
// 覆盖：
// - LocalVectorIndex 的索引/查询与余弦排序；
// - 同义不同词经 retrieveMemory 命中（关键词基线漏召，向量命中）；
// - Transformers 供應者包装（可注入假 pipeline，无需真实模型）；
// - 缺包时 resolveVectorIndex 降级关键词 + 告警；required 模式抛
//   SEMANTIC_EMBEDDING_NOT_AVAILABLE；
// - 门面 semantic 配置的正/降级两条路径。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { GraphStore } from '../../src/core/GraphStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { LocalVectorIndex, type EmbeddingProvider } from '../../src/memory/embedding.js';
import {
  createTransformersEmbeddingProvider,
  resolveVectorIndex,
} from '../../src/memory/transformers.js';
import { HermesMemoryProvider } from '../../src/hermes/HermesMemoryProvider.js';
import { ErrorCodes } from '../../src/errors.js';

// ---------- 确定性「语义」embedding：同义詞映射到同一概念维 ----------

const CONCEPTS: string[][] = [
  ['dark', 'night', 'dark mode', '深色', '深色主題', '夜間', '夜间', '暗色'],
  ['coffee', '咖啡', 'espresso'],
  ['rust', 'rustlang', '記憶體安全'],
];

function embedText(text: string): number[] {
  const lower = text.toLowerCase();
  return CONCEPTS.map((synonyms) =>
    synonyms.some((s) => lower.includes(s.toLowerCase())) ? 1 : 0,
  );
}

const fakeProvider: EmbeddingProvider = {
  id: 'fake-semantic',
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(embedText);
  },
};

/** 假 Transformers 模块：pipeline 返回可直接 tolist 的結果 */
const fakeTransformerModule = {
  pipeline: async () =>
    async (texts: string[]) => ({ tolist: () => texts.map(embedText) }),
};

const missingImporter = async (): Promise<Record<string, unknown>> => {
  throw new Error('Cannot find module @huggingface/transformers');
};

describe('LocalVectorIndex 语义召回', () => {
  let graph: GraphStore;
  let vectorIndex: LocalVectorIndex;

  beforeEach(() => {
    graph = new GraphStore({ storage: new MemoryStorage(), author: 'device-A' });
    vectorIndex = new LocalVectorIndex(fakeProvider);
  });

  it('写入建索引、查询按餘弦排序返回带分数命中', async () => {
    const memory = new MemoryStore(graph, vectorIndex);
    const dark = await memory.addFact({ subject: 'user', predicate: 'prefers', object: '深色主題' });
    await memory.addFact({ subject: 'user', predicate: 'drinks', object: '咖啡' });

    const hits = await vectorIndex.query('夜間模式', 5);
    expect(hits[0]?.nodeId).toBe(dark.id);
    expect(hits[0]?.score).toBeCloseTo(1, 5);
    expect(vectorIndex.size).toBe(2);
  });

  it('同义不同词：关键词漏召，向量命中', async () => {
    const memory = new MemoryStore(graph, vectorIndex);
    await memory.addFact({ subject: 'user', predicate: 'prefers', object: '深色主題' });

    const keywordOnly = new MemoryStore(graph);
    expect(await keywordOnly.search('夜間模式')).toHaveLength(0);

    const hits = await memory.vectorQuery('夜間模式', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.score).toBeGreaterThan(0.9);
  });

  it('reindexVectorIndex 回填已存在节点（重开存储后恢复语义召回）', async () => {
    const writer = new MemoryStore(graph);
    await writer.addFact({ subject: 'user', predicate: 'prefers', object: '深色主題' });

    // 新会话：索引为空，直接查无命中
    const index = new LocalVectorIndex(fakeProvider);
    const reopened = new MemoryStore(graph, index);
    expect(await index.query('夜間模式', 5)).toEqual([]);

    expect(await reopened.reindexVectorIndex()).toBe(1);
    const hits = await reopened.vectorQuery('夜間模式', 5);
    expect(hits).toHaveLength(1);
  });
});

describe('Transformers 供應者与缺包降级', () => {
  it('createTransformersEmbeddingProvider 经假 pipeline 可嵌入', async () => {
    const provider = await createTransformersEmbeddingProvider({
      importer: async () => fakeTransformerModule,
    });
    const vectors = await provider.embed(['深色', '夜間', '咖啡']);
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toEqual(vectors[1]); // 同概念
    expect(vectors[0]).not.toEqual(vectors[2]);
  });

  it('resolveVectorIndex 注入假 importer 时返回可用索引', async () => {
    const index = await resolveVectorIndex({ importer: async () => fakeTransformerModule });
    expect(index).not.toBeNull();
    const hits = await index!.query('anything', 1);
    expect(hits).toEqual([]); // 无索引时诚实空
  });

  it('缺包时降级关键词并告警（不抛错）', async () => {
    const warnings: string[] = [];
    const index = await resolveVectorIndex({
      importer: missingImporter,
      warn: (message) => warnings.push(message),
    });
    expect(index).toBeNull();
    expect(warnings.join('\n')).toContain('降級為關鍵詞基線');
  });

  it('required 模式缺包时抛 SEMANTIC_EMBEDDING_NOT_AVAILABLE', async () => {
    await expect(
      resolveVectorIndex({ importer: missingImporter, required: true }),
    ).rejects.toMatchObject({ code: ErrorCodes.SEMANTIC_EMBEDDING_NOT_AVAILABLE });
  });
});

describe('门面 semantic 配置', () => {
  let dir: string;
  let storagePath: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-semantic-'));
    storagePath = join(dir, 'store.jsonl');
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('注入 provider：retrieveMemory 同义不同词命中目标记忆', async () => {
    const m = new Mebular({
      storagePath,
      deviceId: 'device-A',
      encryption: masterKeys,
      semantic: { enabled: true, provider: fakeProvider },
      sync: { autoSync: false },
    });
    await m.initialize();
    expect(m.semanticVectorIndex).not.toBeNull();

    const probe = new HermesMemoryProvider(m);
    await probe.storeMemory({ type: 'fact', content: '深色主題' });
    const result = await probe.retrieveMemory({ query: '夜間模式' });
    expect(result.totalMatches).toBe(1);
    expect(result.memories[0]!.relevance).toBeGreaterThan(0.9);
    await m.shutdown();
  });

  it('缺包（注入失败 importer）时告警并降级关键词基线', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const m = new Mebular({
        storagePath,
        deviceId: 'device-A',
        encryption: masterKeys,
        semantic: { enabled: true, importer: missingImporter },
        sync: { autoSync: false },
      });
      await m.initialize();
      expect(m.semanticVectorIndex).toBeNull();
      expect(warnSpy).toHaveBeenCalled();

      const provider = new HermesMemoryProvider(m);
      await provider.storeMemory({ type: 'fact', content: '深色主題' });
      const result = await provider.retrieveMemory({ query: '夜間模式' });
      expect(result.totalMatches).toBe(0); // 关键词基线无法同义召回
      await m.shutdown();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
