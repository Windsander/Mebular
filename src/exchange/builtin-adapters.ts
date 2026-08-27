// 内置参考适配器（phase-5-plan 5.3 异构映射规则）
//
// - KvJsonAdapter：键值型 → 每键一条 Fact（subject=来源端名, predicate=键）
// - MarkdownDocAdapter：文档型 → Entity（标题/描述）+ 条目 Fact
//   （复用 Phase 4 的规则化 markdown 解析器，条目挂 contains 边）
//
// 表格型适配器预留：MemoryAdapter 接口不变，后续按 detect 注册即可。

import { parseMarkdown } from '../hermes/import/markdown.js';
import type { CmfDocument, CmfEdge, CmfNode } from './cmf.js';
import { AdapterRegistry, type AdapterSource, type MemoryAdapter } from './adapter.js';

// ---------- 键值型 ----------

function isFlatScalarObject(data: unknown): data is Record<string, string | number | boolean> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return Object.values(data).every((v) => ['string', 'number', 'boolean'].includes(typeof v));
}

export class KvJsonAdapter implements MemoryAdapter {
  readonly name = 'kv-json';

  detect(source: AdapterSource): number {
    if (source.kind === 'kv' || source.kind === 'kv-json') return 1;
    if (source.kind === undefined && isFlatScalarObject(source.data)) return 0.6;
    return 0;
  }

  async import(source: AdapterSource): Promise<CmfDocument> {
    if (!isFlatScalarObject(source.data)) {
      throw new TypeError('kv-json 适配器只接受值均为标量的扁平对象');
    }
    const subject = source.origin ?? 'kv';
    const nodes: CmfNode[] = Object.entries(source.data).map(([key, value]) => ({
      id: `kv:${key}`,
      type: 'fact',
      content: { subject, predicate: key, object: String(value) },
    }));
    return { format: 'cmf', version: 1, exportedAt: Date.now(), nodes, edges: [] };
  }
}

// ---------- 文档型 ----------

const HEADING_OR_LIST = /^(#{1,6}\s+|\s*(?:[-*+]|\d+[.)])\s+)/m;

export class MarkdownDocAdapter implements MemoryAdapter {
  readonly name = 'markdown-doc';

  detect(source: AdapterSource): number {
    if (source.kind === 'markdown') return 1;
    if (source.kind === undefined && typeof source.data === 'string' && HEADING_OR_LIST.test(source.data)) {
      return 0.5;
    }
    return 0;
  }

  async import(source: AdapterSource): Promise<CmfDocument> {
    if (typeof source.data !== 'string') {
      throw new TypeError('markdown-doc 适配器只接受字符串');
    }
    const parsed = parseMarkdown(source.data);
    const origin = source.origin ?? 'document';
    const title = parsed.title ?? origin;

    const nodes: CmfNode[] = [
      {
        id: 'doc:root',
        type: 'entity',
        content: {
          entityType: 'other',
          name: title,
          ...(parsed.description !== undefined ? { description: parsed.description } : {}),
          properties: { origin, format: 'markdown' },
        },
      },
    ];
    const edges: CmfEdge[] = [];

    let index = 0;
    for (const section of parsed.sections) {
      for (const item of section.items) {
        const factId = `doc:item-${index}`;
        nodes.push({
          id: factId,
          type: 'fact',
          content: {
            subject: title,
            predicate: section.heading ? `entry:${section.heading}` : 'entry',
            object: item,
            source: origin,
          },
        });
        edges.push({ source: 'doc:root', target: factId, relation: 'contains' });
        index += 1;
      }
    }

    return { format: 'cmf', version: 1, exportedAt: Date.now(), nodes, edges };
  }
}

/** 便捷工厂：注册了两个内置适配器的注册表 */
export function createBuiltinAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new KvJsonAdapter());
  registry.register(new MarkdownDocAdapter());
  return registry;
}
