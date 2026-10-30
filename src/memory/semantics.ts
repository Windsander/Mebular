// 记忆语义类型（preference / observation）的唯一展开与匹配规则。
//
// 公共 MCP 工具与内部 capability `/query` `/search` 都经 MemoryService 使用这里：
// - `preference` 是 fact + `preference` 标签（0.2 形状），不是独立节点类型；
// - `observation` 新写入为 episode(episodeType=observation)，同时兼容 0.2 capability
//   曾写入的 legacy fact observation（`metadata.kind=observation`）。
//
// 适配器只负责把外部请求的类型数组传进来，不得再复制这些规则。

import type { Node } from '../types/index.js';

/** 公共 `memory_query` 在未指定 types 时的节点类型集合（保持 0.2 行为）。 */
export const DEFAULT_MEMORY_NODE_TYPES: readonly string[] = ['entity', 'fact', 'episode', 'skill', 'meta'];

const KNOWN_SEMANTIC_TYPES = new Set([
  'fact',
  'preference',
  'episode',
  'observation',
  'skill',
  'entity',
  'meta',
]);

/** 语义类型 → 需要扫描的节点类型（去重）。types 缺省时沿用 0.2 默认集合。 */
export function expandMemoryTypes(types?: readonly string[]): string[] {
  if (!types || types.length === 0) return [...DEFAULT_MEMORY_NODE_TYPES];
  const expanded = new Set<string>();
  for (const type of types) {
    if (type === 'preference') {
      expanded.add('fact');
    } else if (type === 'observation') {
      // 新 observation = episode；legacy observation = fact。
      expanded.add('episode');
      expanded.add('fact');
    } else {
      expanded.add(type);
    }
  }
  return [...expanded];
}

/** 节点的语义 kind：metadata.kind / content.kind 优先，再按标签与 episodeType 归一。 */
export function semanticKindOf(node: Pick<Node, 'type' | 'content' | 'tags' | 'metadata'> | null | undefined): string {
  const content = isRecord(node?.content) ? node.content : {};
  const metadata = isRecord(node?.metadata) ? node.metadata : {};
  if (typeof metadata.kind === 'string' && KNOWN_SEMANTIC_TYPES.has(metadata.kind)) return metadata.kind;
  if (typeof content.kind === 'string' && KNOWN_SEMANTIC_TYPES.has(content.kind)) return content.kind;
  const type = node?.type;
  const tags = Array.isArray(node?.tags) ? node.tags : [];
  if (type === 'fact' && tags.includes('preference')) return 'preference';
  if (type === 'episode' && content.episodeType === 'observation') return 'observation';
  return type ?? 'unknown';
}

/**
 * 节点是否命中请求的语义类型。
 *
 * - `fact` 包含普通事实与（legacy）observation/preference 事实；
 * - `preference` 只命中偏好事实；
 * - `episode` 包含全部 episode；
 * - `observation` 只命中 observation episode / legacy observation fact。
 */
export function matchesMemoryTypes(
  node: Pick<Node, 'type' | 'content' | 'tags' | 'metadata'>,
  types?: readonly string[],
): boolean {
  if (!types || types.length === 0) return true;
  const kind = semanticKindOf(node);
  if (node.type === 'fact') {
    return types.includes('fact')
      || (types.includes('preference') && kind === 'preference')
      || (types.includes('observation') && kind === 'observation');
  }
  if (node.type === 'episode') {
    return types.includes('episode') || (types.includes('observation') && kind === 'observation');
  }
  return types.includes(node.type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
