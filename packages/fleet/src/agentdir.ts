// W1 每设备 Agent 目录（普通记忆域，默认 `agents`）。
//
// 每设备一条**签名**记录（作者=设备；随已有记忆同步，证书链由 core 校验）：
//   { device, agents:[{name,kind,capabilities?,concurrency,capacity?,executable?,executionMode?}], updatedAt, version }
// `task_targets` = **我 L1 授权过的对端** ∩ 其目录里的 `(device, agent)`。
// `capacity`/`load` 为**建议性**（不参与授权与一致性判定）。

import type { Mebular } from '@mebular/core';
import type { FleetAgentConfig, FleetConfig } from './config.js';
import { EXECUTOR_EXECUTION_MODES, type ExecutorExecutionMode } from './runtime/executor.js';
import { MebularMessageStore } from './store/message-store.js';

export const AGENT_DIRECTORY_MESSAGE_TYPE = 'agent_directory';
/** 每设备 Agent 目录 / 能力卡的普通分区（P1：能力卡为同分区 internal 节点）。 */
export const AGENT_NAMESPACE = 'agents';

export interface AgentDirectoryAgent {
  name: string;
  /** 执行器 kind（与 `FleetAgentConfig.kind` 对齐：echo/command/hermes/openchamber） */
  kind: string;
  capabilities?: string[];
  concurrency?: number;
  /** 建议性容量提示（**不参与授权/一致性**） */
  capacity?: number;
  /**
   * 该 agent 是否具备真实执行能力（由 config/adapter 静态推导）。
   *
   * 旧目录没有该字段时视为**未知**而不是 `false`（兼容旧 peer）；显式 `false`
   * 表示 demo/占位/缺命令，路由不得选中。
   */
  executable?: boolean;
  /** 执行通道；与 `ExecutorExecutionMode` 对齐。旧目录缺省 = 未知。 */
  executionMode?: ExecutorExecutionMode;
}

/** 健康状态（advisory；不参与授权/一致性）。 */
export type AgentExecutionHealthStatus = 'ok' | 'degraded' | 'unavailable';

/** agent 健康快照（advisory；不得包含 env/token/端点凭据）。 */
export interface AgentExecutionHealth {
  status: AgentExecutionHealthStatus;
  checkedAt?: number;
  latencyMs?: number;
  detail?: string;
}

/** 非执行原因（用于 task_targets 解释，不进入授权判定）。 */
export type AgentExecutionReason = 'demo' | 'missing-command' | 'unsupported-kind';

export interface DerivedAgentExecution {
  executable: boolean;
  executionMode: ExecutorExecutionMode;
  reason?: AgentExecutionReason;
}

/**
 * 由本机 config **静态**推导可执行性与执行通道（不探测、不读 command 内容）。
 *
 * - `echo` / `board`：demo/看板，不可执行（`in-process`）；
 * - `command`：有 `command` 才可执行，否则 `missing-command`；
 * - `hermes` / `dsh` / `opencode` / `claude-code`：CLI 执行；
 * - `openchamber`：公开 runner（HTTP）；
 * - 未知 kind：fail-closed 为不可执行（配置校验通常已拦截）。
 */
export function deriveAgentExecution(
  agent: { name: string; kind: string; command?: string },
): DerivedAgentExecution {
  if (agent.name === 'board' || agent.name === 'echo' || agent.kind === 'echo') {
    return { executable: false, executionMode: 'in-process', reason: 'demo' };
  }
  switch (agent.kind) {
    case 'command':
      return typeof agent.command === 'string' && agent.command.length > 0
        ? { executable: true, executionMode: 'cli' }
        : { executable: false, executionMode: 'cli', reason: 'missing-command' };
    case 'hermes':
    case 'dsh':
    case 'opencode':
    case 'claude-code':
      return { executable: true, executionMode: 'cli' };
    case 'openchamber':
      return { executable: true, executionMode: 'http' };
    default:
      return { executable: false, executionMode: 'in-process', reason: 'unsupported-kind' };
  }
}

export interface AgentDirectoryEntry {
  v: number;
  device: string;
  agents: AgentDirectoryAgent[];
  /** 本机墙钟（**advisory**；不参与一致性判定） */
  updatedAt: number;
  /** 单调版本：同设备取最大者（R-c 式确定序，无墙钟） */
  version: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export interface AgentDirectoryValidation {
  ok: boolean;
  errors: string[];
}

export function validateAgentDirectory(input: unknown): AgentDirectoryValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, errors: ['目录必须是对象'] };
  const e = input as Record<string, unknown>;
  if (e.v !== 1) errors.push('v 必须为 1');
  if (!isNonEmptyString(e.device)) errors.push('device 必须为非空字符串');
  if (typeof e.updatedAt !== 'number' || !Number.isFinite(e.updatedAt)) errors.push('updatedAt 必须为有限数字');
  if (typeof e.version !== 'number' || !Number.isInteger(e.version) || e.version < 0) errors.push('version 必须为非负整数');
  if (!Array.isArray(e.agents)) {
    errors.push('agents 必须为数组');
  } else {
    for (const a of e.agents as Array<Record<string, unknown>>) {
      if (!isNonEmptyString(a?.name)) errors.push('agent.name 必须为非空字符串');
      if (!isNonEmptyString(a?.kind)) errors.push('agent.kind 必须为非空字符串');
      if (a?.capabilities !== undefined && (!Array.isArray(a.capabilities) || a.capabilities.some((c) => typeof c !== 'string'))) {
        errors.push('agent.capabilities 若存在须为字符串数组');
      }
      if (a?.concurrency !== undefined && (typeof a.concurrency !== 'number' || !Number.isInteger(a.concurrency) || a.concurrency < 1)) {
        errors.push('agent.concurrency 若存在须为正整数');
      }
      if (a?.capacity !== undefined && (typeof a.capacity !== 'number' || !Number.isFinite(a.capacity) || a.capacity < 0)) {
        errors.push('agent.capacity 若存在须为非负数字（advisory）');
      }
      if (a?.executable !== undefined && typeof a.executable !== 'boolean') {
        errors.push('agent.executable 若存在须为布尔');
      }
      if (a?.executionMode !== undefined
        && !EXECUTOR_EXECUTION_MODES.includes(a.executionMode as ExecutorExecutionMode)) {
        errors.push('agent.executionMode 若存在须为 cli|http|json-rpc|in-process');
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 构造目录存储（校验 + 幂等键 `device@version`）。 */
export function agentDirectoryStore(mebular: Mebular, namespace = AGENT_NAMESPACE): MebularMessageStore<AgentDirectoryEntry> {
  return new MebularMessageStore<AgentDirectoryEntry>(mebular, {
    type: AGENT_DIRECTORY_MESSAGE_TYPE,
    namespace,
    validate: validateAgentDirectory,
    idOf: (e) => `${e.device}@${e.version}`,
  });
}

/** 每设备最新目录（同设备取 `version` 最大；平局取稳定序列化较大者，确定性）。 */
export function latestDirectories(entries: readonly AgentDirectoryEntry[]): AgentDirectoryEntry[] {
  const byDevice = new Map<string, AgentDirectoryEntry>();
  for (const e of entries) {
    const prev = byDevice.get(e.device);
    if (prev === undefined) {
      byDevice.set(e.device, e);
      continue;
    }
    const stronger =
      e.version !== prev.version
        ? e.version > prev.version
        : stable(e) > stable(prev);
    if (stronger) byDevice.set(e.device, e);
  }
  return [...byDevice.values()].sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
}

function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${stable(rec[k])}`).join(',')}}`;
}

export interface TaskTarget {
  device: string;
  agent: string;
  kind: string;
  concurrency?: number;
  capacity?: number;
  /** 可执行性（additive；旧目录缺字段时不伪造）。 */
  executable?: boolean;
  /** 执行通道（additive；旧目录缺字段时不伪造）。 */
  executionMode?: ExecutorExecutionMode;
  /** 健康快照（additive；来自能力卡，advisory）。 */
  health?: AgentExecutionHealth;
  /** 不可执行/不健康时的可解释原因（additive）。 */
  reason?: string;
}

/**
 * `task_targets` = **L1 授权过的对端** ∩ 其目录里的 `(device, agent)`。
 * 授权集合外的设备记录一律忽略（默认拒绝；授权是前提）。确定序（device, agent）。
 */
export function expandTargets(
  entries: readonly AgentDirectoryEntry[],
  authorizedDevices: readonly string[],
): TaskTarget[] {
  const allowed = new Set(authorizedDevices);
  const targets: TaskTarget[] = [];
  for (const entry of latestDirectories(entries)) {
    if (!allowed.has(entry.device)) continue;
    for (const agent of [...entry.agents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!isNonEmptyString(agent.name) || !isNonEmptyString(agent.kind)) continue;
      targets.push({
        device: entry.device,
        agent: agent.name,
        kind: agent.kind,
        ...(agent.concurrency !== undefined ? { concurrency: agent.concurrency } : {}),
        ...(agent.capacity !== undefined ? { capacity: agent.capacity } : {}),
        // additive：旧目录缺字段时保持“未知”，不当作 false。
        ...(agent.executable !== undefined ? { executable: agent.executable } : {}),
        ...(agent.executionMode !== undefined ? { executionMode: agent.executionMode } : {}),
        ...(agent.executable === false
          ? { reason: deriveAgentExecution({ name: agent.name, kind: agent.kind }).reason ?? 'not-executable' }
          : {}),
      });
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// P1：目录生成/发布（每设备一条，版本单调；同内容不重复发版）
// ---------------------------------------------------------------------------

function normalizeCapabilities(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

/** 由 fleet config 编译本机目录条目（只含标签/并发/执行元数据，不含 command/env）。 */
export function compileAgentDirectory(
  config: Pick<FleetConfig, 'device' | 'agents'>,
  options: { version?: number; updatedAt?: number } = {},
): AgentDirectoryEntry {
  const agents: AgentDirectoryAgent[] = [...config.agents]
    .filter((agent) => agent.name !== '')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((agent: FleetAgentConfig) => {
      const execution = deriveAgentExecution(agent);
      return {
        name: agent.name,
        kind: agent.kind,
        ...(agent.capabilities !== undefined && agent.capabilities.length > 0
          ? { capabilities: normalizeCapabilities(agent.capabilities) }
          : {}),
        ...(agent.concurrency !== undefined ? { concurrency: agent.concurrency } : {}),
        executable: execution.executable,
        executionMode: execution.executionMode,
      };
    });
  return {
    v: 1,
    device: config.device,
    agents,
    updatedAt: options.updatedAt ?? Date.now(),
    version: options.version ?? 1,
  };
}

/** 目录内容指纹：忽略 `updatedAt`/`version`，同内容不重复发版。 */
export function agentDirectoryFingerprint(entry: AgentDirectoryEntry): string {
  return stable({
    v: entry.v,
    device: entry.device,
    agents: entry.agents.map((agent) => ({
      name: agent.name,
      kind: agent.kind,
      capabilities: agent.capabilities ?? [],
      ...(agent.concurrency !== undefined ? { concurrency: agent.concurrency } : {}),
      ...(agent.capacity !== undefined ? { capacity: agent.capacity } : {}),
      ...(agent.executable !== undefined ? { executable: agent.executable } : {}),
      ...(agent.executionMode !== undefined ? { executionMode: agent.executionMode } : {}),
    })),
  });
}

export interface AgentDirectoryPublishResult {
  published: boolean;
  version: number;
  entry: AgentDirectoryEntry;
}

/** Agent 目录后端：embedded 用 Mebular，daemon 用本机 app HTTP。 */
export interface AgentDirectoryBackend {
  listDirectories(): Promise<AgentDirectoryEntry[]>;
  appendDirectory(entry: AgentDirectoryEntry): Promise<boolean>;
}

/** embedded 后端：本地 Mebular 的 `agents` 域消息节点。 */
export function embeddedAgentDirectoryBackend(
  mebular: Mebular,
  namespace = AGENT_NAMESPACE,
): AgentDirectoryBackend {
  const store = agentDirectoryStore(mebular, namespace);
  return {
    listDirectories: () => store.all(),
    appendDirectory: (entry) => store.append(entry),
  };
}

/** 发布 Agent 目录（后端无关）：同设备版本单调；内容未变时返回现有版本。 */
export async function publishAgentDirectoryWithBackend(
  backend: AgentDirectoryBackend,
  config: Pick<FleetConfig, 'device' | 'agents'>,
  options: { now?: number } = {},
): Promise<AgentDirectoryPublishResult> {
  const entries = await backend.listDirectories();
  const latest = latestDirectories(entries).find((entry) => entry.device === config.device) ?? null;
  const candidate = compileAgentDirectory(config, {
    ...(latest !== null ? { version: latest.version } : {}),
    ...(options.now !== undefined ? { updatedAt: options.now } : {}),
  });
  if (latest !== null && agentDirectoryFingerprint(latest) === agentDirectoryFingerprint(candidate)) {
    return { published: false, version: latest.version, entry: latest };
  }
  const entry: AgentDirectoryEntry = {
    ...candidate,
    version: latest === null ? 1 : latest.version + 1,
  };
  await backend.appendDirectory(entry);
  return { published: true, version: entry.version, entry };
}

/** 发布日期目录：同设备版本单调；内容未变时返回现有版本（不写新节点）。 */
export async function publishAgentDirectory(
  mebular: Mebular,
  config: Pick<FleetConfig, 'device' | 'agents'>,
  options: { namespace?: string; now?: number } = {},
): Promise<AgentDirectoryPublishResult> {
  return publishAgentDirectoryWithBackend(
    embeddedAgentDirectoryBackend(mebular, options.namespace ?? AGENT_NAMESPACE),
    config,
    { ...(options.now !== undefined ? { now: options.now } : {}) },
  );
}
