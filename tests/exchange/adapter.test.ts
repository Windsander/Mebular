// 适配器框架测试（phase-5-plan 5.3）
//
// 覆盖：detect 置信度路由（显式 kind 优先 / 同分先注册 / 无认领报错 /
// 重复注册报错）、KV 与 Markdown 异构映射、跨端幂等键（含来源端标识）、
// 导入→导出→回读闭环。

import { describe, it, expect } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import {
  AdapterRegistry,
  adapterDedupKey,
  importWithAdapter,
  type MemoryAdapter,
} from '../../src/exchange/adapter.js';
import {
  KvJsonAdapter,
  MarkdownDocAdapter,
  createBuiltinAdapterRegistry,
} from '../../src/exchange/builtin-adapters.js';
import { exportGraphToCmf, parseCmfDocument } from '../../src/exchange/cmf.js';

function freshMemory(author = 'device-test'): MemoryStore {
  return new MemoryStore(new GraphStore({ storage: new MemoryStorage(), author }));
}

const KV_DATA = { theme: 'dark', fontSize: 14, vim: true };
const MD_DATA = '# 购物清单\n\n本周要采购的东西。\n\n## 食品\n\n- 牛奶\n- 鸡蛋\n\n## 用品\n\n- 电池\n';

describe('AdapterRegistry 路由', () => {
  it('按 detect 置信度选最高者；显式 kind 优先于启发式', () => {
    const registry = createBuiltinAdapterRegistry();
    expect(registry.route({ data: KV_DATA }).adapter.name).toBe('kv-json');
    expect(registry.route({ data: MD_DATA }).adapter.name).toBe('markdown-doc');
    // 显式 kind=markdown 的字符串即便不像 markdown 也由文档适配器认领
    expect(registry.route({ kind: 'markdown', data: 'plain text' }).adapter.name).toBe('markdown-doc');
  });

  it('同置信度时先注册者优先', () => {
    const a: MemoryAdapter = {
      name: 'first', detect: () => 0.5,
      import: async () => ({ format: 'cmf', version: 1, exportedAt: 0, nodes: [], edges: [] }),
    };
    const b: MemoryAdapter = { ...a, name: 'second' };
    const registry = new AdapterRegistry();
    registry.register(a);
    registry.register(b);
    expect(registry.route({ data: 'anything' }).adapter.name).toBe('first');
  });

  it('无适配器认领时报 ADAPTER_NOT_FOUND；重复注册报 ADAPTER_DUPLICATE', () => {
    const registry = createBuiltinAdapterRegistry();
    expect(() => registry.route({ kind: 'relational-table', data: [] })).toThrow(
      expect.objectContaining({ code: 'ADAPTER_NOT_FOUND' }) as unknown as Error,
    );
    expect(() => registry.register(new KvJsonAdapter())).toThrow(
      expect.objectContaining({ code: 'ADAPTER_DUPLICATE' }) as unknown as Error,
    );
  });
});

describe('KV 型映射与幂等', () => {
  it('扁平对象 → 每键一条 Fact（subject=来源端名）', async () => {
    const memory = freshMemory();
    const report = await importWithAdapter(
      new KvJsonAdapter(),
      { kind: 'kv', data: KV_DATA, origin: 'settings-app' },
      memory,
    );
    expect(report.errors).toEqual([]);
    expect(report.nodesCreated).toBe(3);
    const facts = await memory.listActiveFacts();
    expect(facts.map((f) => f.content.predicate).sort()).toEqual(['fontSize', 'theme', 'vim']);
    expect(facts.every((f) => f.content.subject === 'settings-app')).toBe(true);
    expect(facts.find((f) => f.content.predicate === 'vim')?.content.object).toBe('true');
  });

  it('同端同内容重复导入零重复；幂等键含来源端标识', async () => {
    const memory = freshMemory();
    const source = { kind: 'kv', data: KV_DATA, origin: 'settings-app' };
    const first = await importWithAdapter(new KvJsonAdapter(), source, memory);
    const second = await importWithAdapter(new KvJsonAdapter(), source, memory);
    expect(first.nodesCreated).toBe(3);
    expect(second.nodesCreated).toBe(0);
    expect(second.skipped).toBe(3);
    expect((await memory.listActiveFacts())).toHaveLength(3);

    // 键含来源端：不同端各自持有（诚实保留出处，不跨端误并）
    const other = await importWithAdapter(
      new KvJsonAdapter(),
      { kind: 'kv', data: KV_DATA, origin: 'another-app' },
      memory,
    );
    expect(other.nodesCreated).toBe(3);
    expect((await memory.listActiveFacts())).toHaveLength(6);
  });

  it('adapterDedupKey 对来源端与内容敏感', async () => {
    const node = { id: 'kv:theme', type: 'fact' as const, content: { subject: 's', predicate: 'theme', object: 'dark' } };
    const k1 = adapterDedupKey('kv-json', 'appA', node);
    const k2 = adapterDedupKey('kv-json', 'appB', node);
    const k3 = adapterDedupKey('kv-json', 'appA', { ...node, content: { ...node.content, object: 'light' } });
    expect(k1).toMatch(/^import:[0-9a-f]{64}$/);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });
});

describe('文档型映射', () => {
  it('Markdown → Entity + 条目 Fact + contains 边', async () => {
    const memory = freshMemory();
    const report = await importWithAdapter(
      new MarkdownDocAdapter(),
      { kind: 'markdown', data: MD_DATA, origin: 'notes-app' },
      memory,
    );
    expect(report.errors).toEqual([]);
    expect(report.nodesCreated).toBe(4); // 1 实体 + 3 条目
    expect(report.edgesCreated).toBe(3);

    const entities = await memory.listByType('entity');
    expect(entities).toHaveLength(1);
    expect(entities[0]!.content).toMatchObject({ name: '购物清单', description: '本周要采购的东西。' });

    const facts = await memory.listActiveFacts();
    expect(facts.map((f) => f.content.predicate).sort()).toEqual(['entry:用品', 'entry:食品', 'entry:食品']);
    const entityId = entities[0]!.id;
    const edges = await memory.getGraph().listEdges({ source: entityId });
    expect(edges).toHaveLength(3);
    expect(edges.every((e) => e.relation === 'contains')).toBe(true);
  });
});

describe('导入→导出→回读闭环', () => {
  it('导入后的图导出为 CMF 可被解析，且再导入全量幂等命中', async () => {
    const memory = freshMemory();
    const registry = createBuiltinAdapterRegistry();
    await registry.import({ kind: 'kv', data: KV_DATA, origin: 'settings-app' }, memory);

    const doc = await exportGraphToCmf(memory.getGraph(), { source: { app: 'mebular' } });
    const parsed = parseCmfDocument(doc); // 5.2 转换器回读
    expect(parsed.nodes).toHaveLength(3);

    // 用同一适配器键再导入：全部 skipped（幂等键随节点 labels 保留在图里）
    const reimport = await importWithAdapter(
      new KvJsonAdapter(),
      { kind: 'kv', data: KV_DATA, origin: 'settings-app' },
      memory,
    );
    expect(reimport.skipped).toBe(3);
    expect(reimport.nodesCreated).toBe(0);
  });
});
