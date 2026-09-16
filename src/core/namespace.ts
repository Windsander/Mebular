// 记忆分区（namespace）一等概念
//
// namespace 是记忆的「组织维度」：多设备多 Agent 协作时，把任务状态这类
// 高频短命记忆与用户长期记忆隔离，并可只同步订阅的分区。它**不携带任何
// 执行 / 调度 / 任务语义**——只是记忆的一个标签维度，与主旨（所有记忆一致）
// 一致：分区只改变组织与同步范围，不改变一致性模型本身。
//
// 约定：任何缺失的 namespace 一律视为 DEFAULT_NAMESPACE（'default'）。
// 这样旧数据、旧对端、旧快照无需迁移即可参与同步，保证向后兼容。

export const DEFAULT_NAMESPACE = 'default';

/** namespace 过滤形态：单个或数组；undefined 与空数组均表示「不过滤」 */
export type NamespaceFilter = string | string[];

/** 归一化 namespace：缺失/空白一律回落到 default */
export function normalizeNamespace(value?: string | null): string {
  if (typeof value !== 'string') return DEFAULT_NAMESPACE;
  const trimmed = value.trim();
  return trimmed === '' ? DEFAULT_NAMESPACE : trimmed;
}

/** 归一化 namespace 列表：去空白、去重；空/缺失返回空数组 */
export function normalizeNamespaceList(values?: readonly string[] | null): string[] {
  if (!values || values.length === 0) return [];
  const seen = new Set<string>();
  for (const value of values) {
    seen.add(normalizeNamespace(value));
  }
  return [...seen];
}

/** 实体 namespace 是否命中过滤：undefined/空数组过滤 = 全部命中 */
export function matchesNamespace(entityNamespace: string | undefined, filter?: NamespaceFilter): boolean {
  if (filter === undefined) return true;
  const wanted = Array.isArray(filter) ? normalizeNamespaceList(filter) : [normalizeNamespace(filter)];
  if (wanted.length === 0) return true;
  const actual = normalizeNamespace(entityNamespace);
  return wanted.includes(actual);
}

/**
 * 供给端裁剪用的「允许集合」：
 * - `null` 表示未声明（不过滤，向后兼容旧对端）；
 * - 空数组表示明确不允许任何分区；
 * - 非空数组为白名单（已归一化）。
 */
export type NamespaceAllowList = string[] | null;

/**
 * 求交集：任一为「空数组（不允许）」则结果为空；全部为 null（未声明）则 null。
 * 用于「对端被授权 ∩ 对端声明订阅 ∩ 本机订阅」的裁剪链。
 */
export function intersectNamespaceAllowLists(...lists: NamespaceAllowList[]): NamespaceAllowList {
  if (lists.some((list) => list !== null && list.length === 0)) return [];
  const restricted = lists.filter((list): list is string[] => list !== null);
  if (restricted.length === 0) return null;
  const [first, ...rest] = restricted;
  const allowed = new Set(first!);
  for (const list of rest) {
    for (const ns of [...allowed]) {
      if (!list.includes(ns)) allowed.delete(ns);
    }
  }
  return [...allowed];
}

/** 把「本机订阅」转成 allow list：未配置 / 空数组 = 全部（null，保持现状） */
export function subscriptionToAllowList(namespaces?: readonly string[] | null): NamespaceAllowList {
  const normalized = normalizeNamespaceList(namespaces);
  return normalized.length === 0 ? null : normalized;
}

/** 按 allow list 过滤带 namespace 的实体；null = 全通过 */
export function isNamespaceAllowed(entityNamespace: string | undefined, allow: NamespaceAllowList): boolean {
  if (allow === null) return true;
  return allow.includes(normalizeNamespace(entityNamespace));
}
