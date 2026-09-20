// Mebular Fleet —— 任务 envelope 与显式状态机（M0 骨架；M1 扩展为完整模型）。
//
// **任务 = 记忆**：任务是一类带 `namespace`（如 `tasks`）的图上记忆，生命周期由**显式状态事件**
// 驱动；`expiresAt` 只是本机任务板的**软约定**，不参与跨端一致性判定（见 `SEALING.md` 红线：
// 墙钟不进一致性判定）。本文件**只消费 `@mebular/core` 的公共 API**，不在 core 引入任务语义。

/** 协议版本（envelope 线格式版本；改动 = 破坏性，需全端同版本）。 */
export const FLEET_PROTOCOL_VERSION = 1 as const;

/**
 * 任务状态（**单调秩**，用于并发/乱序下的确定性收敛）：
 * - `queued` → `claimed` → `running` → `done` | `failed`
 * - `done` / `failed` 为**终态**（同秩，平局由 `TERMINAL_PRECEDENCE` 兜底）。
 */
export const TASK_STATUSES = ['queued', 'claimed', 'running', 'done', 'failed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 状态秩：`done`/`failed` 同秩（终态），其余严格递增。 */
export const STATUS_RANK: Readonly<Record<TaskStatus, number>> = {
  queued: 0,
  claimed: 1,
  running: 2,
  done: 3,
  failed: 3,
};

/** 终态平局裁决：数值大者胜（确定性）。 */
export const TERMINAL_PRECEDENCE: Readonly<Record<TaskStatus, number>> = {
  queued: 0,
  claimed: 0,
  running: 0,
  failed: 2,
  done: 1,
};

/** 任务树预算（**W1**）：随树单调递减；root 声明，子任务 ≤ 父剩余。 */
export interface TaskBudget {
  /** 允许的最大深度（root 深度 0；链长 = 祖先数） */
  maxDepth: number;
  /** 每个父任务可派生的直接子任务上限 */
  maxChildren: number;
  /** 整个子树的任务总数上限（含 root） */
  maxTasks: number;
}

/** root 级派发策略：`children-ok`（默认，可派生）| `root-only`（执行者只能干、不得再派）。 */
export const DISPATCH_POLICIES = ['children-ok', 'root-only'] as const;
export type TaskDispatch = (typeof DISPATCH_POLICIES)[number];

/** root 预算默认值（W1 上界，可由 root 收紧）。 */
export const DEFAULT_ROOT_BUDGET: Readonly<TaskBudget> = { maxDepth: 8, maxChildren: 16, maxTasks: 256 };

/** 预算合法性（非负整数；越界由树不变式判定，这里只做形状）。 */
export function isTaskBudget(value: unknown): value is TaskBudget {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Record<string, unknown>;
  return (
    Number.isInteger(b.maxDepth) && (b.maxDepth as number) >= 0 &&
    Number.isInteger(b.maxChildren) && (b.maxChildren as number) >= 0 &&
    Number.isInteger(b.maxTasks) && (b.maxTasks as number) >= 0
  );
}

/** 派发策略守卫。 */
export function isTaskDispatch(value: unknown): value is TaskDispatch {
  return typeof value === 'string' && (DISPATCH_POLICIES as readonly string[]).includes(value);
}

/** 端标识：设备 + 该设备上的 Agent 名。 */
export interface FleetEndpoint {
  device: string;
  agent: string;
}

/** 因果追踪：`causedBy` 指向触发本任务/迁移的父任务；`chain` 为祖先链（去重、有序）。 */
export interface FleetTrace {
  causedBy?: string;
  chain: string[];
}

/** 任务 envelope（图上一类记忆的规范化负载）。 */
export interface TaskEnvelope {
  /** 协议版本 */
  v: number;
  /** 任务唯一 ID（内容寻址前的逻辑 id；由发起方生成） */
  taskId: string;
  /** 发起端 */
  from: FleetEndpoint;
  /** 目标端（`to.agent` 为 `*` 表示该设备任一 Agent 可领取） */
  to: FleetEndpoint;
  /** 意图/指令（人可读；执行语义由执行器解释） */
  intent: string;
  /** 负载引用（如 Blob/记忆节点 id；不在 envelope 内联大对象） */
  payloadRef?: string;
  /** 当前权威状态（显式状态事件驱动） */
  status: TaskStatus;
  /** 已尝试次数（至少一次投递 + 幂等应用；见 M1） */
  attempts: number;
  /** **软约定**：仅影响本机任务板展示；不参与跨端状态判定 */
  expiresAt?: number;
  /** 因果链 */
  trace: FleetTrace;
}

/** 校验结果。 */
export interface EnvelopeValidation {
  ok: boolean;
  errors: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 端标识守卫（`{device,agent}` 均为非空字符串）。 */
export function isFleetEndpoint(value: unknown): value is FleetEndpoint {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return isNonEmptyString(e.device) && isNonEmptyString(e.agent);
}

/** 状态判定。 */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/** 终态判定。 */
export function isTerminal(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed';
}

/**
 * 确定性状态裁决：返回 `a` / `b` 中更靠后的那个（收敛用，与到达顺序无关）。
 * 先比 `STATUS_RANK`；同秩（终态）比 `TERMINAL_PRECEDENCE`；再平局取字典序大的状态名。
 */
export function resolveStatus(a: TaskStatus, b: TaskStatus): TaskStatus {
  if (STATUS_RANK[a] !== STATUS_RANK[b]) return STATUS_RANK[a] > STATUS_RANK[b] ? a : b;
  if (TERMINAL_PRECEDENCE[a] !== TERMINAL_PRECEDENCE[b]) {
    return TERMINAL_PRECEDENCE[a] > TERMINAL_PRECEDENCE[b] ? a : b;
  }
  return a >= b ? a : b;
}

/**
 * 合法迁移表（显式，避免跳级；与 `protocol/state-machine.json` 一致）。
 * 非法迁移必须被拒绝（M1 负例）。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['claimed', 'failed'],
  claimed: ['running', 'failed'],
  running: ['done', 'failed'],
  done: [],
  failed: [],
};

/** 状态是否可迁移（`from === to` 视为幂等自迁移）。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return TASK_TRANSITIONS[from].includes(to);
}

/** 校验一个未知输入是否为合法 `TaskEnvelope`（不做数值语义裁决）。 */
export function validateEnvelope(input: unknown): EnvelopeValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['envelope 必须是对象'] };
  }
  const e = input as Record<string, unknown>;
  if (e.v !== FLEET_PROTOCOL_VERSION) errors.push(`v 必须为 ${FLEET_PROTOCOL_VERSION}`);
  if (!isNonEmptyString(e.taskId)) errors.push('taskId 必须为非空字符串');
  if (!isFleetEndpoint(e.from)) errors.push('from 必须为 {device,agent} 非空字符串');
  if (!isFleetEndpoint(e.to)) errors.push('to 必须为 {device,agent} 非空字符串');
  if (!isNonEmptyString(e.intent)) errors.push('intent 必须为非空字符串');
  if (e.payloadRef !== undefined && !isNonEmptyString(e.payloadRef)) {
    errors.push('payloadRef 若存在须为非空字符串');
  }
  if (!isTaskStatus(e.status)) errors.push(`status 必须为 ${TASK_STATUSES.join('|')}`);
  if (typeof e.attempts !== 'number' || !Number.isInteger(e.attempts) || e.attempts < 0) {
    errors.push('attempts 必须为非负整数');
  }
  if (e.expiresAt !== undefined && (typeof e.expiresAt !== 'number' || !Number.isFinite(e.expiresAt))) {
    errors.push('expiresAt 若存在须为有限数字（软约定，不参与跨端状态）');
  }
  if (typeof e.trace !== 'object' || e.trace === null) {
    errors.push('trace 必须为对象');
  } else {
    const trace = e.trace as Record<string, unknown>;
    if (trace.causedBy !== undefined && !isNonEmptyString(trace.causedBy)) {
      errors.push('trace.causedBy 若存在须为非空字符串');
    }
    if (!Array.isArray(trace.chain) || !trace.chain.every(isNonEmptyString)) {
      errors.push('trace.chain 必须为字符串数组');
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 递归键序规范化（键按字典序，`undefined` 丢弃）→ 同一对象恒得同一字节串。 */
function canonicalize(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonicalize);
  if (typeof input === 'object' && input !== null) {
    const src = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      if (src[key] !== undefined) out[key] = canonicalize(src[key]);
    }
    return out;
  }
  return input;
}

/** 序列化为**确定序** JSON（同一 envelope → 同一字节串）。 */
export function serializeEnvelope(envelope: TaskEnvelope): string {
  return JSON.stringify(canonicalize(envelope));
}

/** 解析并校验；非法输入抛错（错误信息含全部违规项）。 */
export function parseEnvelope(json: string): TaskEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`envelope JSON 解析失败：${(error as Error).message}`);
  }
  const result = validateEnvelope(raw);
  if (!result.ok) throw new Error(`envelope 非法：${result.errors.join('; ')}`);
  return raw as TaskEnvelope;
}
