// CMF 交换格式测试（phase-5-plan 5.2）
//
// 覆盖：五类节点全量往返无损、未知字段保留袋、未知类型降级与还原、
// 版本协商诚实报错、导入走 MemoryStore 校验路径（非法内容逐条上报）、
// 边端点重映射、跨端稳定指纹。

import { describe, it, expect } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { MebularError } from '../../src/errors.js';
import {
  canonicalCmfNode,
  exportGraphToCmf,
  importCmfToMemory,
  parseCmfDocument,
  serializeCmfDocument,
  stringifyCmfDocument,
  type CmfDocument,
} from '../../src/exchange/cmf.js';

function freshMemory(author: string): { memory: MemoryStore; graph: GraphStore } {
  const graph = new GraphStore({ storage: new MemoryStorage(), author });
  return { memory: new MemoryStore(graph), graph };
}

describe('CMF 五类节点全量往返', () => {
  it('导出→解析→导入后内容/标签/时间窗一致，边端点正确重映射', async () => {
    const { memory: src } = freshMemory('device-src');
    const entity = await src.addEntity({
      entityType: 'project', name: 'Mebular', description: '图式记忆',
      properties: { lang: 'ts' }, labels: ['root'], tags: ['p'],
    });
    const fact = await src.addFact({
      subject: 'Mebular', predicate: 'writtenIn', object: 'TypeScript',
      validFrom: 1000, validTo: 2000, confidence: 0.9, source: 'observation',
      labels: ['fact-label'],
    });
    await src.addEpisode({
      episodeType: 'decision', title: '选型', content: '选择 JSONL 存储',
      startTime: 100, endTime: 200, context: 'session-1',
    });
    await src.addSkill({
      name: 'commit', description: '提交规范', category: 'git',
      steps: ['add', 'commit'], commands: ['git commit'],
    });
    await src.addMeta({ metaType: 'tag', name: 'favorite', value: { level: 5 } });
    await src.getGraph().createEdge(entity.id, fact.id, 'related_to', ['e-label']);

    const doc = await exportGraphToCmf(src.getGraph(), {
      source: { app: 'mebular-test', deviceId: 'device-src' },
    });
    expect(doc.format).toBe('cmf');
    expect(doc.version).toBe(1);
    expect(doc.nodes).toHaveLength(5);
    expect(doc.edges).toHaveLength(1);

    // JSON 文本形态也可解析
    const parsed = parseCmfDocument(stringifyCmfDocument(doc));
    expect(parsed.nodes).toHaveLength(5);

    const { memory: dst, graph: dstGraph } = freshMemory('device-dst');
    const report = await importCmfToMemory(dst, parsed);
    expect(report.errors).toEqual([]);
    expect(report.nodesCreated).toBe(5);
    expect(report.edgesCreated).toBe(1);

    // 实体
    const importedEntityId = report.idMap[entity.id]!;
    const importedEntity = await dstGraph.getNode(importedEntityId);
    expect(importedEntity?.type).toBe('entity');
    expect(importedEntity?.content).toMatchObject({
      entityType: 'project', name: 'Mebular', description: '图式记忆',
    });
    expect(importedEntity?.labels).toContain('root');

    // 事实：时间窗与置信度无损
    const importedFact = await dstGraph.getNode(report.idMap[fact.id]!);
    expect(importedFact?.content).toMatchObject({
      subject: 'Mebular', predicate: 'writtenIn', object: 'TypeScript',
      confidence: 0.9, source: 'observation',
    });
    expect(importedFact?.validFrom).toBe(1000);
    expect(importedFact?.validTo).toBe(2000);

    // 边端点已重映射到本地 ID
    const importedEdges = await dstGraph.listEdges();
    expect(importedEdges[0]!.source).toBe(importedEntityId);
    expect(importedEdges[0]!.target).toBe(report.idMap[fact.id]!);
    expect(importedEdges[0]!.relation).toBe('related_to');
  });

  it('导出的内容不被原图后续修改污染（快照拷贝）', async () => {
    const { memory: src, graph } = freshMemory('device-src');
    const entity = await src.addEntity({ entityType: 'concept', name: 'A' });
    const doc = await exportGraphToCmf(graph);
    (entity.content as Record<string, unknown>).name = 'MUTATED';
    expect((doc.nodes[0]!.content as Record<string, unknown>).name).toBe('A');
  });
});

describe('CMF 兼容规则', () => {
  it('未知字段收入保留袋，序列化时写回原层级', () => {
    const raw = {
      format: 'cmf',
      version: 1,
      exportedAt: 123,
      futureDocField: { x: 1 },
      nodes: [
        { id: 'n1', type: 'fact', content: { subject: 's', predicate: 'p', object: 'o' }, futureNodeField: 'keep-me' },
      ],
      edges: [
        { source: 'n1', target: 'n1', relation: 'self', futureEdgeField: true },
      ],
    };
    const doc = parseCmfDocument(raw);
    expect(doc.extensions).toMatchObject({ futureDocField: { x: 1 } });
    expect(doc.nodes[0]!.extensions).toMatchObject({ futureNodeField: 'keep-me' });
    expect(doc.edges[0]!.extensions).toMatchObject({ futureEdgeField: true });

    const serialized = serializeCmfDocument(doc) as Record<string, unknown>;
    expect(serialized.futureDocField).toEqual({ x: 1 });
    expect((serialized.nodes as Record<string, unknown>[])[0]!.futureNodeField).toBe('keep-me');
    expect((serialized.edges as Record<string, unknown>[])[0]!.futureEdgeField).toBe(true);
  });

  it('未知节点类型降级 other 并保留 originalType，再导出还原', () => {
    const doc = parseCmfDocument({
      format: 'cmf',
      version: 1,
      nodes: [{ id: 'x1', type: 'custom-widget', content: { foo: 'bar' } }],
    });
    expect(doc.nodes[0]!.type).toBe('other');
    expect(doc.nodes[0]!.originalType).toBe('custom-widget');
    expect(doc.nodes[0]!.content).toEqual({ foo: 'bar' });

    const serialized = serializeCmfDocument(doc) as Record<string, unknown>;
    expect((serialized.nodes as Record<string, unknown>[])[0]!.type).toBe('custom-widget');
  });

  it('降级节点导入直通图层并保留 originalType', async () => {
    const { memory, graph } = freshMemory('device-dst');
    const doc = parseCmfDocument({
      format: 'cmf',
      version: 1,
      nodes: [{ id: 'x1', type: 'custom-widget', content: { foo: 'bar' } }],
    });
    const report = await importCmfToMemory(memory, doc);
    expect(report.errors).toEqual([]);
    const created = await graph.getNode(report.idMap['x1']!);
    expect(created?.type).toBe('other');
    expect(created?.content).toEqual({ foo: 'bar' });
    expect(created?.metadata).toEqual({ originalType: 'custom-widget' });
  });

  it('版本高于本端时诚实报 CMF_VERSION_UNSUPPORTED', () => {
    expect(() => parseCmfDocument({ format: 'cmf', version: 2, nodes: [] })).toThrow(
      expect.objectContaining({ code: 'CMF_VERSION_UNSUPPORTED' }) as unknown as Error,
    );
  });

  it('缺格式标记/非法 JSON/缺 nodes 均报 CMF_FORMAT_INVALID', () => {
    expect(() => parseCmfDocument('{oops')).toThrow(MebularError);
    expect(() => parseCmfDocument({ version: 1, nodes: [] })).toThrow(
      expect.objectContaining({ code: 'CMF_FORMAT_INVALID' }) as unknown as Error,
    );
    expect(() => parseCmfDocument({ format: 'cmf', version: 1 })).toThrow(
      expect.objectContaining({ code: 'CMF_FORMAT_INVALID' }) as unknown as Error,
    );
    expect(() => parseCmfDocument({ format: 'cmf', version: 1, nodes: [{ type: 'fact' }] })).toThrow(
      expect.objectContaining({ code: 'CMF_FORMAT_INVALID' }) as unknown as Error,
    );
  });
});

describe('CMF 导入校验路径', () => {
  it('非法内容逐条上报，不中断整批；指向失败节点的边诚实略过', async () => {
    const { memory } = freshMemory('device-dst');
    const doc: CmfDocument = {
      format: 'cmf',
      version: 1,
      exportedAt: Date.now(),
      nodes: [
        { id: 'bad', type: 'entity', content: { entityType: 'no-such-type', name: 'X' } },
        { id: 'good', type: 'entity', content: { entityType: 'tool', name: 'Y' } },
      ],
      edges: [{ source: 'bad', target: 'good', relation: 'related_to' }],
    };
    const report = await importCmfToMemory(memory, doc);
    expect(report.nodesCreated).toBe(1);
    expect(report.edgesCreated).toBe(0);
    expect(report.errors).toHaveLength(2); // 非法实体 + 端点缺失的边
    expect(report.errors[0]!.nodeId).toBe('bad');
    expect(report.idMap['good']).toBeDefined();
    expect(report.idMap['bad']).toBeUndefined();
  });
});

describe('CMF 节点指纹', () => {
  it('同内容不同 ID/标签顺序得到同一指纹', () => {
    const a = canonicalCmfNode({
      id: 'one', type: 'fact',
      content: { subject: 's', predicate: 'p', object: 'o' },
      labels: ['b', 'a'],
    });
    const b = canonicalCmfNode({
      id: 'two', type: 'fact',
      content: { object: 'o', predicate: 'p', subject: 's' },
      labels: ['a', 'b'],
    });
    expect(a).toBe(b);
  });

  it('内容差异产生不同指纹', () => {
    const a = canonicalCmfNode({ id: 'one', type: 'fact', content: { subject: 's', predicate: 'p', object: 'o' } });
    const b = canonicalCmfNode({ id: 'one', type: 'fact', content: { subject: 's', predicate: 'p', object: 'X' } });
    expect(a).not.toBe(b);
  });
});
