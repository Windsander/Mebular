// 幂等键命名空间统一回归测试（Phase 6.1，开门决策点 1：双写过渡）
//
// 规范：新格式 import:<source>:<digest>；旧格式 import:<digest> 不迁移，
// 写入侧只写新键，读取侧新旧都认（旧键随图同步继续有效，自然老化）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../../src/core/GraphStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { HermesImporter } from '../../src/hermes/import/HermesImporter.js';
import {
  adapterDedupDigest,
  adapterDedupKey,
  importWithAdapter,
  type MemoryAdapter,
} from '../../src/exchange/adapter.js';
import { importLabel, legacyImportLabel, toLegacyImportLabel } from '../../src/exchange/import-keys.js';

function newMemory(author = 'test'): MemoryStore {
  return new MemoryStore(new GraphStore({ storage: new MemoryStorage(), author }));
}

const MEMORY_MD = `# 长期记忆

用户的基本偏好与事实。

## 偏好
- 喜欢深色主题
`;

describe('幂等键格式', () => {
  it('新格式层级结构：import:<source>:<digest>', () => {
    const node = { id: 'x', type: 'fact' as const, content: { subject: 's', predicate: 'p', object: 'o' } };
    expect(adapterDedupKey('kv-json', 'appA', node)).toMatch(/^import:kv-json:[0-9a-f]{64}$/);
    expect(importLabel('hermes', 'ab'.repeat(32))).toBe(`import:hermes:${'ab'.repeat(32)}`);
    expect(toLegacyImportLabel(`import:hermes:${'ab'.repeat(32)}`)).toBe(`import:${'ab'.repeat(32)}`);
    expect(toLegacyImportLabel(`import:${'ab'.repeat(32)}`)).toBeNull();
  });
});

describe('适配器轨道双读', () => {
  it('既有图上的旧格式键仍命中幂等（不重复新建）', async () => {
    const memory = newMemory();
    const node = { id: 'kv:theme', type: 'fact' as const, content: { subject: 's', predicate: 'theme', object: 'dark' } };

    // 模拟 Phase 5 图谱遗留：旧格式 import:<digest> 键节点
    const legacyKey = legacyImportLabel(adapterDedupDigest('kv-json', 'appA', node));
    await memory.addFact({ subject: 's', predicate: 'theme', object: 'dark', labels: [legacyKey] });

    const adapter: MemoryAdapter = {
      name: 'kv-json',
      detect: () => 1,
      import: async () => ({ format: 'cmf', version: 1, exportedAt: 0, nodes: [node], edges: [] }),
    };
    const report = await importWithAdapter(adapter, { kind: 'kv', data: null, origin: 'appA' }, memory);

    expect(report.skipped).toBe(1);
    expect(report.nodesCreated).toBe(0);
    expect(await memory.listActiveFacts()).toHaveLength(1);
  });
});

describe('hermes 轨道双读与写新键', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-keys-'));
    await writeFile(join(dir, 'MEMORY.md'), MEMORY_MD);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('新导入写入 import:hermes:<digest> 新格式键', async () => {
    const memory = newMemory();
    await new HermesImporter(memory).importMarkdownFile(join(dir, 'MEMORY.md'));

    const labels = (await memory.getGraph().listNodes({})).flatMap((n) => n.labels ?? []);
    expect(labels.some((l) => /^import:hermes:[0-9a-f]{64}$/.test(l))).toBe(true);
    expect(labels.some((l) => /^import:[0-9a-f]{64}$/.test(l))).toBe(false);
  });

  it('既有图上的旧格式 hermes 键仍命中幂等', async () => {
    const memory = newMemory();
    const filePath = join(dir, 'MEMORY.md');
    // 模拟旧版图谱：实体节点的旧格式键 import:<sha256(filePath + '\n' + 实体名)>
    const legacyKey = `import:${createHash('sha256').update(`${filePath}\n长期记忆`, 'utf-8').digest('hex')}`;
    const preexisting = await memory.addEntity({
      entityType: 'other',
      name: '长期记忆',
      labels: [legacyKey],
    });

    const report = await new HermesImporter(memory).importMarkdownFile(filePath);

    expect(report.entities).toHaveLength(1);
    expect(report.entities[0]!.created).toBe(false);
    expect(report.entities[0]!.id).toBe(preexisting.id);
    const entities = (await memory.getGraph().listNodes({ type: 'entity' }))
      .filter((n) => (n.content as { name?: string }).name === '长期记忆');
    expect(entities).toHaveLength(1);
  });
});
