// CMF 图级往返与适配器边端点回归测试（Phase 6.1）
//
// 缺陷 1：CMF 降级（other）节点的 originalType 存于节点顶层 metadata，
//         导出投影不读取 → 图级再导出丢原类型。
// 缺陷 2：importWithAdapter 幂等命中跳过的节点不进 idMap，
//         指向它们的边落入 errors；且重复导入时边不幂等。

import { describe, it, expect } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import {
  exportGraphToCmf,
  importCmfToMemory,
  parseCmfDocument,
  serializeCmfDocument,
  type CmfDocument,
} from '../../src/exchange/cmf.js';
import { importWithAdapter, type MemoryAdapter } from '../../src/exchange/adapter.js';

function newMemory(author = 'test'): MemoryStore {
  return new MemoryStore(new GraphStore({ storage: new MemoryStorage(), author }));
}

describe('CMF 图级往返（缺陷 1）', () => {
  it('降级（other）节点图级再导出恢复原类型', async () => {
    const memory = newMemory();
    const doc = parseCmfDocument({
      format: 'cmf',
      version: 1,
      exportedAt: Date.now(),
      nodes: [{ id: 'n1', type: 'custom-widget', content: { text: 'hello' } }],
      edges: [],
    });
    const report = await importCmfToMemory(memory, doc);
    expect(report.errors).toEqual([]);

    // 图级再导出：序列化层应写回原类型 custom-widget
    const exported = serializeCmfDocument(await exportGraphToCmf(memory.getGraph()));
    const nodes = exported.nodes as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.type).toBe('custom-widget');

    // 再解析仍正确降级，往返稳定
    const reparsed = parseCmfDocument(exported);
    expect(reparsed.nodes[0]!.type).toBe('other');
    expect(reparsed.nodes[0]!.originalType).toBe('custom-widget');
  });
});

describe('适配器幂等命中的边端点映射（缺陷 2）', () => {
  const doc: CmfDocument = {
    format: 'cmf',
    version: 1,
    exportedAt: 0,
    nodes: [
      { id: 'a', type: 'fact', content: { subject: 's1', predicate: 'p', object: 'o1' } },
      { id: 'b', type: 'fact', content: { subject: 's2', predicate: 'p', object: 'o2' } },
    ],
    edges: [{ source: 'a', target: 'b', relation: 'related_to' }],
  };
  const adapter: MemoryAdapter = {
    name: 'mini-fixture',
    detect: () => 1,
    import: async () => doc,
  };

  it('重复导入含边场景：零 errors、边幂等不重复', async () => {
    const memory = newMemory();
    const source = { kind: 'mini', data: null, origin: 'test' };

    const first = await importWithAdapter(adapter, source, memory);
    expect(first.errors).toEqual([]);
    expect(first.nodesCreated).toBe(2);
    expect(first.edgesCreated).toBe(1);

    const second = await importWithAdapter(adapter, source, memory);
    expect(second.skipped).toBe(2);
    expect(second.nodesCreated).toBe(0);
    // 幂等命中的节点仍应参与边端点解析：不再落入 errors
    expect(second.errors).toEqual([]);
    // 边同样幂等：重复导入不产生第二条同关系边
    expect(second.edgesCreated).toBe(0);
    expect(await memory.getGraph().listEdges({})).toHaveLength(1);
    // 幂等命中节点的来源 ID → 本地 ID 映射仍入报告
    expect(second.idMap['a']).toBe(first.idMap['a']);
    expect(second.idMap['b']).toBe(first.idMap['b']);
  });
});
