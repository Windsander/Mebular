// Hermes / json-memo 参考适配器测试（phase-5-plan 5.4 前半）

import { describe, it, expect } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GraphStore } from '../../src/core/GraphStore.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { importWithAdapter } from '../../src/exchange/adapter.js';
import { HermesAdapter } from '../../src/exchange/hermes-adapter.js';
import { JsonMemoAdapter } from '../../src/exchange/json-memo-adapter.js';
import { createBuiltinAdapterRegistry } from '../../src/exchange/builtin-adapters.js';

const HERMES_DIR = join(__dirname, 'fixtures', 'hermes');

function freshMemory(author = 'device-test'): MemoryStore {
  return new MemoryStore(new GraphStore({ storage: new MemoryStorage(), author }));
}

describe('HermesAdapter', () => {
  it('detect：显式 kind 与目录形态识别', () => {
    const adapter = new HermesAdapter();
    expect(adapter.detect({ kind: 'hermes-dir', data: '/anywhere' })).toBe(1);
    expect(adapter.detect({ data: HERMES_DIR })).toBe(0.8);
    expect(adapter.detect({ data: '/no/such/dir' })).toBe(0);
    expect(adapter.detect({ data: 42 })).toBe(0);
  });

  it('目录投影为 CMF：实体+条目事实+source_of 边+技能+会话情节', async () => {
    const doc = await new HermesAdapter().import({ kind: 'hermes-dir', data: HERMES_DIR }, { memory: freshMemory() });
    expect(doc.format).toBe('cmf');

    const entities = doc.nodes.filter((n) => n.type === 'entity');
    const facts = doc.nodes.filter((n) => n.type === 'fact');
    const skills = doc.nodes.filter((n) => n.type === 'skill');
    const episodes = doc.nodes.filter((n) => n.type === 'episode');
    expect(entities).toHaveLength(2); // MEMORY + USER
    expect(facts).toHaveLength(5); // 2 偏好 + 1 事实 + 2 属性
    expect(skills).toHaveLength(1);
    expect(episodes).toHaveLength(1);

    const userEntity = entities.find((n) => n.id === 'doc:USER')!;
    expect(userEntity.content).toMatchObject({ entityType: 'user', name: 'user' });
    const memoryFacts = facts.filter((n) => n.id.startsWith('doc:MEMORY:'));
    expect(memoryFacts[0]!.content).toMatchObject({ subject: '工作记忆', predicate: '偏好' });
    expect(doc.edges).toHaveLength(5);
    expect(doc.edges.every((e) => e.relation === 'source_of')).toBe(true);

    expect(skills[0]!.content).toMatchObject({
      name: 'commit', category: 'imported',
      steps: ['先跑测试', '再写提交说明'],
    });
    expect((skills[0]!.content as Record<string, unknown>).commands).toEqual(['git commit -m "..."']);
    expect(episodes[0]!.content).toMatchObject({
      episodeType: 'conversation', title: '会话 s-001', context: 's-001',
      startTime: 1756300000000, endTime: 1756300600000,
    });
  });

  it('经框架落图幂等：重复导入全部跳过', async () => {
    const memory = freshMemory();
    const source = { kind: 'hermes-dir', data: HERMES_DIR, origin: 'hermes-laptop' };
    const first = await importWithAdapter(new HermesAdapter(), source, memory);
    expect(first.nodesCreated).toBe(9); // 2 实体 + 5 事实 + 1 技能 + 1 情节
    expect(first.edgesCreated).toBe(5);
    expect(first.errors).toEqual([]);

    const second = await importWithAdapter(new HermesAdapter(), source, memory);
    expect(second.nodesCreated).toBe(0);
    expect(second.skipped).toBe(9);
  });
});

describe('JsonMemoAdapter', () => {
  it('detect：kind 与结构启发式', async () => {
    const adapter = new JsonMemoAdapter();
    expect(adapter.detect({ kind: 'json-memo', data: {} })).toBe(1);
    expect(adapter.detect({ data: { memos: [] } })).toBe(0.8);
    expect(adapter.detect({ data: '{"memos":[]}' })).toBe(0.8);
    expect(adapter.detect({ data: { nope: 1 } })).toBe(0);
    expect(adapter.detect({ kind: 'kv', data: { memos: [] } })).toBe(0); // 显式他类不认领
  });

  it('条目按有无 title 分映射 Fact / Episode', async () => {
    const memory = freshMemory();
    const sample = JSON.parse(
      await readFile(join(process.cwd(), 'examples/json-memo/data/memos.json'), 'utf-8'),
    ) as unknown;
    const report = await importWithAdapter(
      new JsonMemoAdapter(),
      { kind: 'json-memo', data: sample, origin: 'memo-phone' },
      memory,
    );
    expect(report.errors).toEqual([]);
    expect(report.nodesCreated).toBe(3);

    const facts = await memory.listActiveFacts();
    expect(facts).toHaveLength(2);
    expect(facts[0]!.content).toMatchObject({ subject: 'memo-phone', predicate: 'memo' });
    const episodes = await memory.listByType('episode');
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.content).toMatchObject({ episodeType: 'observation', title: '读书摘记' });
  });

  it('非法数据诚实报错', async () => {
    await expect(new JsonMemoAdapter().import({ data: { memos: [{ nope: 1 }] } }, { memory: freshMemory() }))
      .rejects.toMatchObject({ code: 'CMF_FORMAT_INVALID' });
    await expect(new JsonMemoAdapter().import({ data: [] }, { memory: freshMemory() }))
      .rejects.toMatchObject({ code: 'CMF_FORMAT_INVALID' });
  });
});

describe('四适配器注册表路由', () => {
  it('KV / Markdown / Hermes / json-memo 各自路由正确', () => {
    const registry = createBuiltinAdapterRegistry();
    registry.register(new HermesAdapter());
    registry.register(new JsonMemoAdapter());

    expect(registry.route({ data: { a: 1 } }).adapter.name).toBe('kv-json');
    expect(registry.route({ data: '# 标题\n\n- 条目' }).adapter.name).toBe('markdown-doc');
    expect(registry.route({ data: HERMES_DIR }).adapter.name).toBe('hermes');
    expect(registry.route({ data: { memos: [{ text: 'x' }] } }).adapter.name).toBe('json-memo');
  });
});
