// W1 每设备 Agent 目录（普通记忆域，默认 `agents`）。
//
// 每设备一条**签名**记录（作者=设备；随已有记忆同步，证书链由 core 校验）：
//   { device, agents:[{name,kind,capabilities?,concurrency,capacity?}], updatedAt, version }
// `task_targets` = **我 L1 授权过的对端** ∩ 其目录里的 `(device, agent)`。
// `capacity`/`load` 为**建议性**（不参与授权与一致性判定）。

import type { Mebular } from '@mebular/core';
import { MebularMessageStore } from './store/message-store.js';

export const AGENT_DIRECTORY_MESSAGE_TYPE = 'agent_directory';

export interface AgentDirectoryAgent {
  name: string;
  /** 执行器 kind（与 `FleetAgentConfig.kind` 对齐：echo/command/hermes/openchamber） */
  kind: string;
  capabilities?: string[];
  concurrency?: number;
  /** 建议性容量提示（**不参与授权/一致性**） */
  capacity?: number;
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
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 构造目录存储（校验 + 幂等键 `device@version`）。 */
export function agentDirectoryStore(mebular: Mebular, namespace = 'agents'): MebularMessageStore<AgentDirectoryEntry> {
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
      });
    }
  }
  return targets;
}
