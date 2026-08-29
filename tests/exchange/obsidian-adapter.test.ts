// Obsidian vault 适配器单元测试（phase-6-plan 6.3）

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../../src/core/GraphStore.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { importWithAdapter } from '../../src/exchange/adapter.js';
import {
  ObsidianVaultAdapter,
  extractWikiLinks,
  stripFrontmatter,
  OBSIDIAN_IMPORT_TAG,
} from '../../src/exchange/obsidian-adapter.js';
import type { CmfDocument } from '../../src/exchange/cmf.js';

const EXAMPLE_VAULT = join(process.cwd(), 'examples/obsidian-vault/vault');

function createMemory(): MemoryStore {
  return new MemoryStore(new GraphStore({ storage: new MemoryStorage(), author: 'test' }));
}

describe('stripFrontmatter / extractWikiLinks 纯函数', () => {
  it('剥离文件头 frontmatter 块并保留原文', () => {
    const { body, frontmatter } = stripFrontmatter('---\ntags: [a]\n---\n# 标题\n正文');
    expect(frontmatter).toBe('tags: [a]');
    expect(body).toBe('# 标题\n正文');
  });

  it('无 frontmatter 时原样返回', () => {
    const { body, frontmatter } = stripFrontmatter('# 标题');
    expect(frontmatter).toBeUndefined();
    expect(body).toBe('# 标题');
  });

  it('提取 wiki-link：去别名、去重、忽略代码围栏', () => {
    const text = [
      '[[A]] 与 [[B|别名]] 再到 [[A]]',
      '```',
      '[[代码里的不算]]',
      '```',
      '[[ C ]]', // 两侧空白应被裁掉
    ].join('\n');
    expect(extractWikiLinks(text)).toEqual(['A', 'B', 'C']);
  });
});

describe('ObsidianVaultAdapter.detect', () => {
  const adapter = new ObsidianVaultAdapter();

  it('显式 kind 全置信认领', () => {
    expect(adapter.detect({ kind: 'obsidian-vault', data: '/any' })).toBe(1);
    expect(adapter.detect({ kind: 'obsidian', data: '/any' })).toBe(1);
  });

  it('目录形态：有 .obsidian 高置信，没有则不认领', () => {
    expect(adapter.detect({ data: EXAMPLE_VAULT })).toBe(0.9);
    expect(adapter.detect({ data: process.cwd() })).toBe(0);
  });

  it('其他 kind 一律不认领', () => {
    expect(adapter.detect({ kind: 'markdown', data: EXAMPLE_VAULT })).toBe(0);
  });
});

describe('ObsidianVaultAdapter.import（examples 样例库）', () => {
  const adapter = new ObsidianVaultAdapter();
  let doc: CmfDocument;

  beforeEach(async () => {
    doc = await adapter.import({ kind: 'obsidian-vault', data: EXAMPLE_VAULT, origin: 'vault-a' }, {
      memory: createMemory(),
    });
  });

  it('笔记 → Entity + 条目 Fact + mentions 降级 Fact', async () => {
    const entities = doc.nodes.filter((n) => n.type === 'entity');
    const facts = doc.nodes.filter((n) => n.type === 'fact');
    // 3 篇笔记；条目 3+2+1=6，未解析链接 1 条 mentions
    expect(entities).toHaveLength(3);
    expect(facts).toHaveLength(7);
    expect(facts.filter((f) => (f.content as Record<string, unknown>).predicate === 'mentions'))
      .toHaveLength(1);

    const mebular = entities.find((n) => n.id === 'note:Projects/Mebular');
    expect(mebular).toBeDefined();
    const content = mebular!.content as Record<string, unknown>;
    expect(content.name).toBe('Mebular');
    expect(content.description).toBe('本地优先的图记忆系统。');
    expect((content.properties as Record<string, unknown>).vault).toBe('vault-a');
    expect(mebular!.tags).toContain(OBSIDIAN_IMPORT_TAG);
  });

  it('wiki-link 三种解析路径：basename / 相对路径别名 / 未解析降级', () => {
    const related = doc.edges.filter((e) => e.relation === 'related_to');
    // Mebular→GraphStore（basename）、Mebular→Daily/2026-08-28（相对路径+别名）、
    // GraphStore→Mebular（basename）；[[已废弃的Ring同步]] 与围栏内 [[假链接]] 不成边
    expect(related).toHaveLength(3);
    const pairs = related.map((e) => `${e.source}→${e.target}`).sort();
    expect(pairs).toEqual([
      'note:Concepts/GraphStore→note:Projects/Mebular',
      'note:Projects/Mebular→note:Concepts/GraphStore',
      'note:Projects/Mebular→note:Daily/2026-08-28',
    ]);

    const mention = doc.nodes.find(
      (n) => n.type === 'fact' && (n.content as Record<string, unknown>).predicate === 'mentions',
    );
    expect((mention!.content as Record<string, unknown>).object).toBe('已废弃的Ring同步');
  });

  it('条目 Fact 经 source_of 挂到笔记实体，谓词取小节标题', () => {
    const sourceOf = doc.edges.filter((e) => e.relation === 'source_of');
    expect(sourceOf).toHaveLength(6);
    const archFact = doc.nodes.find(
      (n) => n.type === 'fact' && (n.content as Record<string, unknown>).predicate === '架构',
    );
    expect(archFact).toBeDefined();
    expect(
      sourceOf.some((e) => e.source === 'note:Projects/Mebular' && e.target === archFact!.id),
    ).toBe(true);
  });

  it('frontmatter 剥离进 properties，不污染正文解析', () => {
    const daily = doc.nodes.find((n) => n.id === 'note:Daily/2026-08-28');
    const content = daily!.content as Record<string, unknown>;
    expect((content.properties as Record<string, unknown>).frontmatter).toBe(
      'tags: [daily]\nmood: good',
    );
    expect(content.name).toBe('2026-08-28');
  });

  it('输入守卫：非字符串与缺 .obsidian 诚实报错', async () => {
    await expect(adapter.import({ data: 42 }, { memory: createMemory() })).rejects.toThrow(
      '只接受 vault 根目录路径',
    );
    await expect(
      adapter.import({ data: process.cwd() }, { memory: createMemory() }),
    ).rejects.toThrow('不是 Obsidian vault');
  });
});

describe('ObsidianVaultAdapter 歧义 basename 与点目录跳过', () => {
  const adapter = new ObsidianVaultAdapter();
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'obsidian-vault-'));
    await mkdir(join(dir, '.obsidian'));
    await mkdir(join(dir, 'a'));
    await mkdir(join(dir, 'b'));
    await mkdir(join(dir, '.trash'));
    await writeFile(join(dir, 'a', '同名.md'), '# 同名A\n- 条目\n[[同名]]\n');
    await writeFile(join(dir, 'b', '同名.md'), '# 同名B\n');
    await writeFile(join(dir, '.trash', '垃圾.md'), '# 不应被收\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('basename 歧义 → 降级 mentions；点目录不扫描', async () => {
    const doc = await adapter.import({ data: dir, origin: 'v' }, { memory: createMemory() });
    expect(doc.nodes.map((n) => n.id)).not.toContain('note:.trash/垃圾');
    // [[同名]] 命中两个候选 → 不成边，降级 mentions
    expect(doc.edges.filter((e) => e.relation === 'related_to')).toHaveLength(0);
    const mentions = doc.nodes.filter(
      (n) => n.type === 'fact' && (n.content as Record<string, unknown>).predicate === 'mentions',
    );
    expect(mentions).toHaveLength(1);
    expect((mentions[0]!.content as Record<string, unknown>).object).toBe('同名');
  });
});

describe('export + renderMarkdown（CMF → markdown 闭环）', () => {
  it('落图后导出本端投影并渲染回 vault 文件', async () => {
    const adapter = new ObsidianVaultAdapter();
    const memory = createMemory();
    const report = await importWithAdapter(
      adapter,
      { kind: 'obsidian-vault', data: EXAMPLE_VAULT, origin: 'vault-a' },
      memory,
    );
    expect(report.errors).toEqual([]);
    expect(report.nodesCreated).toBe(10);

    const doc = await adapter.export({ memory });
    expect(doc.nodes.length).toBeGreaterThan(0);
    expect(
      doc.nodes.every((n) => (n.tags ?? []).includes(OBSIDIAN_IMPORT_TAG)),
    ).toBe(true);

    const files = adapter.renderMarkdown(doc);
    const mebular = files.get('Projects/Mebular.md');
    expect(mebular).toBeDefined();
    expect(mebular).toContain('# Mebular');
    expect(mebular).toContain('## 架构');
    expect(mebular).toContain('- 图存储基于 [[GraphStore]]');
    expect(mebular).toContain('## 链接');
    expect(mebular).toContain('- [[GraphStore]]');
    // mentions 降级标记不回写正文（原条目文本里的 wiki-link 原样保留是正确行为）
    expect(mebular).not.toMatch(/^- 已废弃的Ring同步$/m);

    const daily = files.get('Daily/2026-08-28.md');
    expect(daily).toContain('---\ntags: [daily]\nmood: good\n---');
  });
});
