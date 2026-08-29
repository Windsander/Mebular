// Obsidian vault 适配器（phase-6-plan 6.3 生态适配器之一）
//
// 目录形态识别：vault 根下存在 .obsidian/ 即视为 Obsidian vault。
// 映射规则（复用 Phase 4 规则化 markdown 解析）：
// - 每篇笔记 → Entity（entityType='other'，name 取首个 H1 或文件名）
// - 笔记内列表条目 → Fact（谓词取小节标题），经 source_of 边挂在笔记实体上
// - wiki-link [[目标]] / [[目标|别名]] → related_to 边（笔记实体之间）
//
// wiki-link 解析与降级规则（成文约定，见 examples/obsidian-vault/README.md）：
// 1. 先按库内相对路径（去扩展名）精确匹配；
// 2. 再按文件名（basename）匹配，仅当全库唯一时成立（Obsidian 取最短匹配，
//    本投影保守起见遇歧义不猜）；
// 3. 以上失败（含歧义）→ 降级为该笔记上的 Fact(predicate='mentions')，
//    不产生悬空边；同一笔记内同一目标只记一条。
// 围栏代码块内的 [[...]] 不视为链接（代码示例不是关系）。
// YAML frontmatter 不做 YAML 解析：整块剥离后以原文存入实体
// properties.frontmatter，正文解析不受其干扰。
//
// export：图 → CMF 只投影本端导入的节点（obsidian-import 标签）；
// renderMarkdown 把该投影渲染回 vault 文件形态（路径 → markdown 文本），
// related_to 边渲染为「## 链接」小节中的 wiki-link，完成 CMF → markdown 闭环。

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { parseMarkdown } from '../hermes/import/markdown.js';
import { EdgeTypes } from '../memory/types.js';
import { ErrorCodes, MebularError } from '../errors.js';
import { exportGraphToCmf } from './cmf.js';
import type { AdapterContext, AdapterSource, MemoryAdapter } from './adapter.js';
import type { CmfDocument, CmfEdge, CmfNode } from './cmf.js';

export const OBSIDIAN_IMPORT_TAG = 'obsidian-import';

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
const CODE_FENCE_RE = /^\s*```/;

interface NoteRecord {
  /** 库内相对路径（posix 分隔，去 .md 扩展名），即 wiki-link 的精确匹配键 */
  relKey: string;
  filePath: string;
  text: string;
}

/** 剥离 YAML frontmatter（文件开头的 --- ... --- 块），返回正文与原文块 */
export function stripFrontmatter(text: string): { body: string; frontmatter?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { body: text };
  return { body: text.slice(match[0].length), frontmatter: match[1] };
}

/** 去除围栏代码块（wiki-link 提取前的预处理；代码示例中的 [[...]] 不是关系） */
function stripCodeFences(text: string): string {
  const kept: string[] = [];
  let inCode = false;
  for (const line of text.split(/\r?\n/)) {
    if (CODE_FENCE_RE.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (!inCode) kept.push(line);
  }
  return kept.join('\n');
}

/** 提取 wiki-link 目标列表（去别名、去重，保序） */
export function extractWikiLinks(text: string): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const match of stripCodeFences(text).matchAll(WIKI_LINK_RE)) {
    const target = (match[1] ?? '').trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      targets.push(target);
    }
  }
  return targets;
}

async function collectNotes(dir: string, root: string, out: NoteRecord[]): Promise<void> {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name.startsWith('.')) continue; // .obsidian / .trash 等点目录一律跳过
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectNotes(full, root, out);
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      const relKey = relative(root, full).split(sep).join('/').replace(/\.md$/i, '');
      out.push({ relKey, filePath: full, text: await readFile(full, 'utf-8') });
    }
  }
}

export class ObsidianVaultAdapter implements MemoryAdapter {
  readonly name = 'obsidian-vault';

  detect(source: AdapterSource): number {
    if (source.kind === 'obsidian' || source.kind === 'obsidian-vault') return 1;
    if (source.kind === undefined && typeof source.data === 'string') {
      // 目录形态识别：存在 .obsidian/ 即视为 Obsidian vault
      if (existsSync(join(source.data, '.obsidian'))) return 0.9;
    }
    return 0;
  }

  async import(source: AdapterSource, _ctx?: AdapterContext): Promise<CmfDocument> {
    if (typeof source.data !== 'string') {
      throw new TypeError('obsidian-vault 适配器只接受 vault 根目录路径字符串');
    }
    const root = source.data;
    if (!existsSync(join(root, '.obsidian'))) {
      throw new MebularError(
        `不是 Obsidian vault（缺少 .obsidian 目录）：${root}`,
        ErrorCodes.CMF_FORMAT_INVALID,
      );
    }

    const notes: NoteRecord[] = [];
    await collectNotes(root, root, notes);
    const origin = source.origin ?? basename(root);

    // wiki-link 解析表：相对路径精确键 + 唯一 basename 键
    const byRelKey = new Map<string, string>();
    const byBasename = new Map<string, string>();
    const ambiguousBasenames = new Set<string>();
    for (const note of notes) {
      const entityId = `note:${note.relKey}`;
      byRelKey.set(note.relKey, entityId);
      const base = basename(note.relKey);
      if (byBasename.has(base)) {
        ambiguousBasenames.add(base);
      } else {
        byBasename.set(base, entityId);
      }
    }
    for (const base of ambiguousBasenames) byBasename.delete(base);

    const nodes: CmfNode[] = [];
    const edges: CmfEdge[] = [];

    for (const note of notes) {
      const { body, frontmatter } = stripFrontmatter(note.text);
      const parsed = parseMarkdown(body);
      const name = parsed.title ?? basename(note.relKey);
      const entityId = `note:${note.relKey}`;

      nodes.push({
        id: entityId,
        type: 'entity',
        content: {
          entityType: 'other',
          name,
          ...(parsed.description !== undefined ? { description: parsed.description } : {}),
          properties: {
            format: 'markdown',
            path: note.relKey,
            vault: origin,
            ...(frontmatter !== undefined ? { frontmatter } : {}),
          },
        },
        tags: [OBSIDIAN_IMPORT_TAG],
      });

      // 列表条目 → Fact（谓词取小节标题），source_of 挂到笔记实体
      let index = 0;
      for (const section of parsed.sections) {
        for (const item of section.items) {
          const factId = `${entityId}:item-${index}`;
          nodes.push({
            id: factId,
            type: 'fact',
            content: {
              subject: name,
              predicate: section.heading ?? 'note',
              object: item,
              source: note.relKey,
            },
            tags: [OBSIDIAN_IMPORT_TAG],
          });
          edges.push({ source: entityId, target: factId, relation: EdgeTypes.SOURCE_OF });
          index += 1;
        }
      }

      // wiki-link → related_to 边；未解析（含歧义）→ mentions Fact 降级
      const mentioned = new Set<string>();
      for (const target of extractWikiLinks(note.text)) {
        const targetId = byRelKey.get(target) ?? byBasename.get(target);
        if (targetId !== undefined && targetId !== entityId) {
          edges.push({ source: entityId, target: targetId, relation: EdgeTypes.RELATED_TO });
        } else if (targetId === undefined && !mentioned.has(target)) {
          mentioned.add(target);
          nodes.push({
            id: `${entityId}:mention-${target}`,
            type: 'fact',
            content: { subject: name, predicate: 'mentions', object: target, source: note.relKey },
            tags: [OBSIDIAN_IMPORT_TAG],
          });
        }
        // targetId === entityId：自链接直接忽略（自环边无语义增量）
      }
    }

    return { format: 'cmf', version: 1, exportedAt: Date.now(), nodes, edges };
  }

  /** 图 → CMF 查询投影：只含本端导入的节点（obsidian-import 标签） */
  async export(ctx: AdapterContext): Promise<CmfDocument> {
    return exportGraphToCmf(ctx.memory.getGraph(), {
      projectNode: (node) =>
        (node.tags ?? []).includes(OBSIDIAN_IMPORT_TAG)
          ? {
              id: node.id,
              type: node.type as CmfNode['type'],
              content: node.content as Record<string, unknown>,
              tags: node.tags,
              labels: node.labels,
            }
          : null,
    });
  }

  /**
   * CMF → vault 文件投影：返回「库内相对路径（含 .md）→ markdown 文本」。
   * 条目 Fact 按谓词分小节渲染；related_to 边渲染为「## 链接」wiki-link 小节；
   * 原 frontmatter 原文回填。非本端投影的节点（无 properties.path）诚实跳过。
   */
  renderMarkdown(doc: CmfDocument): Map<string, string> {
    const files = new Map<string, string>();
    const nameById = new Map<string, string>();
    for (const node of doc.nodes) {
      const content = node.content as Record<string, unknown> | undefined;
      if (node.type === 'entity' && typeof content?.name === 'string') {
        nameById.set(node.id, content.name);
      }
    }

    for (const node of doc.nodes) {
      if (node.type !== 'entity') continue;
      const content = node.content as Record<string, unknown>;
      const props = content.properties as Record<string, unknown> | undefined;
      const relPath = props?.path;
      if (typeof relPath !== 'string') continue;

      const lines: string[] = [];
      if (typeof props?.frontmatter === 'string') {
        lines.push('---', props.frontmatter, '---', '');
      }
      lines.push(`# ${String(content.name)}`, '');
      if (typeof content.description === 'string') {
        lines.push(content.description, '');
      }

      // 条目 Fact 按谓词归组（经 source_of 边归属到本笔记）
      const factIds = new Set(
        doc.edges
          .filter((e) => e.source === node.id && e.relation === EdgeTypes.SOURCE_OF)
          .map((e) => e.target),
      );
      const byPredicate = new Map<string, string[]>();
      for (const fact of doc.nodes) {
        if (fact.type !== 'fact' || !factIds.has(fact.id)) continue;
        const fc = fact.content as Record<string, unknown>;
        if (fc.predicate === 'mentions') continue; // 降级标记不回写正文
        const predicate = String(fc.predicate ?? 'note');
        const list = byPredicate.get(predicate) ?? [];
        list.push(String(fc.object ?? ''));
        byPredicate.set(predicate, list);
      }
      for (const [predicate, items] of byPredicate) {
        if (predicate !== 'note') lines.push(`## ${predicate}`);
        for (const item of items) lines.push(`- ${item}`);
        lines.push('');
      }

      // related_to 边 → wiki-link 小节
      const linked = doc.edges
        .filter((e) => e.source === node.id && e.relation === EdgeTypes.RELATED_TO)
        .map((e) => nameById.get(e.target))
        .filter((n): n is string => n !== undefined);
      if (linked.length > 0) {
        lines.push('## 链接');
        for (const target of linked) lines.push(`- [[${target}]]`);
        lines.push('');
      }

      files.set(`${relPath}.md`, lines.join('\n'));
    }
    return files;
  }
}
