// 记忆节点的可读文本抽取（关键词基线与 embedding 共用）
//
// 关键词检索与向量索引都建立在「节点的可读文本」上；集中在此避免两处
// 抽取规则漂移。

import type { Node } from '../types/index.js';

const TEXT_FIELDS = [
  'name',
  'description',
  'subject',
  'predicate',
  'object',
  'content',
  'title',
  'category',
] as const;

/** 抽取节点的可读文本字段（含标签）；无内容时返回空串 */
export function nodeSearchText(node: Node): string {
  const fields: string[] = [];
  const content = node.content;
  if (typeof content === 'string') {
    fields.push(content);
  } else if (content && typeof content === 'object') {
    for (const key of TEXT_FIELDS) {
      const value = (content as Record<string, unknown>)[key];
      if (typeof value === 'string') {
        fields.push(value);
      }
    }
  }
  fields.push(...(node.tags ?? []));
  return fields.join(' ');
}

/** 关键词匹配：大小写不敏感子串 */
export function nodeMatchesKeyword(node: Node, needle: string): boolean {
  return nodeSearchText(node).toLowerCase().includes(needle);
}
