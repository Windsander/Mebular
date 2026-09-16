// CMF 交换格式的 namespace 贯通（PLAN 1.1「容易漏掉的通道」）
//
// 导出节点带 namespace（缺失补 default），导入还原到相同分区；
// 不破坏既有格式版本；缺失与显式 default 的指纹一致，幂等不破。

import { describe, it, expect } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import {
  canonicalCmfNode,
  exportGraphToCmf,
  importCmfToMemory,
  parseCmfDocument,
} from '../../src/exchange/cmf.js';

function newMemory(author = 'test'): MemoryStore {
  return new MemoryStore(new GraphStore({ storage: new MemoryStorage(), author }));
}

describe('CMF namespace 往返', () => {
  it('导出带 namespace；导入还原到相同分区', async () => {
    const source = newMemory();
    await source.addEntity({ entityType: 'other', name: 'A', namespace: 'alpha' });
    await source.addFact({ subject: 's', predicate: 'p', object: 'o', namespace: 'beta' });

    const doc = await exportGraphToCmf(source.getGraph());
    const alphaNode = doc.nodes.find((n) => (n.content as { name?: string } | undefined)?.name === 'A');
    expect(alphaNode?.namespace).toBe('alpha');

    const target = newMemory();
    await importCmfToMemory(target, doc);
    const nodes = await target.getGraph().listNodes();
    const importedAlpha = nodes.find((n) => (n.content as { name?: string }).name === 'A');
    const importedBeta = nodes.find((n) => (n.content as { object?: string }).object === 'o');
    expect(importedAlpha?.namespace).toBe('alpha');
    expect(importedBeta?.namespace).toBe('beta');
  });

  it('旧 CMF 文档（无 namespace）导入为 default；导出无 namespace 节点写 default', async () => {
    const legacyDoc = parseCmfDocument({
      format: 'cmf',
      version: 1,
      exportedAt: 0,
      nodes: [{ id: 'x', type: 'fact', content: { subject: 's', predicate: 'p', object: 'o' } }],
      edges: [],
    });
    expect(legacyDoc.nodes[0]!.namespace).toBeUndefined();

    const target = newMemory();
    await importCmfToMemory(target, legacyDoc);
    const imported = await target.getGraph().listNodes();
    expect(imported[0]!.namespace).toBe('default');

    const source = newMemory();
    await source.getGraph().createNode('fact', { subject: 's', predicate: 'p', object: 'o' });
    const doc = await exportGraphToCmf(source.getGraph());
    expect(doc.nodes[0]!.namespace).toBe('default');
  });

  it('canonicalCmfNode：缺失与显式 default 指纹相同（幂等不破）', () => {
    const base = { id: 'x', type: 'fact' as const, content: { subject: 's', predicate: 'p', object: 'o' } };
    expect(canonicalCmfNode(base)).toBe(canonicalCmfNode({ ...base, namespace: 'default' }));
    expect(canonicalCmfNode(base)).not.toBe(canonicalCmfNode({ ...base, namespace: 'alpha' }));
  });
});
