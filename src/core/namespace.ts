// 记忆分区（namespace）一等概念
//
// namespace 是记忆的「组织维度」：多设备多 Agent 协作时，把任务状态这类
// 高频短命记忆与用户长期记忆隔离，并可只同步订阅的分区。它**不携带任何
// 执行 / 调度 / 任务语义**——只是记忆的一个标签维度，与主旨（所有记忆一致）
// 一致：分区只改变组织与同步范围，不改变一致性模型本身。
//
// 约定：任何缺失的 namespace 一律视为 DEFAULT_NAMESPACE（'default'），
// 使图、存储与查询对「没有分区概念」的实体有统一解释。
//
// 同步侧的授权姿态（默认拒绝）不在此文件：这里只提供原语，以及三态 allow
// list（`null` = 该槽不限制 / `[]` = 拒绝 / 非空 = 白名单）。

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
 * 供给端裁剪用的「允许集合」三态：
 * - `null`：该槽不限制（唯一来源是订阅声明 `subscribeAll=true`，不限制将来新增分区）；
 * - `[]`：明确不允许任何分区（拒绝）；
 * - 非空数组：白名单（已归一化）。
 */
export type NamespaceAllowList = string[] | null;

/**
 * 求交集：任一为「空数组（拒绝）」则结果为空；全部为 null（不限制）则 null。
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

/**
 * 本机订阅 → allow list：未配置 / 空数组 = 不限制（null）。
 * 保留语义「本机订阅空 = 参与全部」。
 */
export function subscriptionToAllowList(namespaces?: readonly string[] | null): NamespaceAllowList {
  const normalized = normalizeNamespaceList(namespaces);
  return normalized.length === 0 ? null : normalized;
}

/**
 * 线协议订阅声明 → allow list（订阅声明槽的权威解释）：
 * - `subscribeAll=true` → 不限制（null，含将来新增分区）；
 * - `subscribeAll=false` → 显式白名单（`[]` 表示不订阅任何分区）。
 *
 * 声明**必须**显式：`[]` 只由 subscribeAll=false 产生，不再与「订阅空 = 全部」
 * 冲突——后者由 subscribeAll=true 表达。授权槽的 `[]` 仍然明确表示拒绝。
 */
export function declarationToAllowList(
  subscribeAll: boolean,
  namespaces?: readonly string[] | null,
): NamespaceAllowList {
  return subscribeAll ? null : normalizeNamespaceList(namespaces);
}

/** 按 allow list 过滤带 namespace 的实体；null = 全通过 */
export function isNamespaceAllowed(entityNamespace: string | undefined, allow: NamespaceAllowList): boolean {
  if (allow === null) return true;
  return allow.includes(normalizeNamespace(entityNamespace));
}

// ---------- 分区时钟（per-namespace vector clock） ----------

/**
 * 分区时钟：namespace → (author → counter)。
 *
 * 用于 per-(对端, 分区) 同步水位：缺失判定只在同一分区内比较。这样其他分区的
 * 计数不会把本分区某作者的计数推高，未授权分区被跳过后、日后扩权仍能从正确
 * 起点回补（修复「全局累积时钟比对」导致的永久缺失）。
 */
export type NamespaceClocks = Record<string, Record<string, number>>;

/** 逐作者最大值把 clock 并入 clocks[namespace]（就地修改 clocks） */
export function mergeClockInto(
  clocks: NamespaceClocks,
  namespace: string,
  clock: Record<string, number>,
): void {
  const target = (clocks[namespace] ??= {});
  for (const [author, value] of Object.entries(clock)) {
    if ((target[author] ?? 0) < value) target[author] = value;
  }
}

/** 逐分区、逐作者最大值合并（返回新对象，不改动入参） */
export function mergeNamespaceClocks(...maps: NamespaceClocks[]): NamespaceClocks {
  const out: NamespaceClocks = {};
  for (const map of maps) {
    for (const [ns, clock] of Object.entries(map)) mergeClockInto(out, ns, clock);
  }
  return out;
}

/** 取某分区时钟；缺失返回空对象（调用方可直接读取，无需判空） */
export function namespaceClockOf(clocks: NamespaceClocks, namespace: string): Record<string, number> {
  return clocks[namespace] ?? {};
}
