// Memory Runtime sidecar discovery 文件（`<home>/memory-runtime.json`）。
//
// 规则（sidecar 契约 §3.2）：
// - 原子写、0600；
// - 不包含 token，只包含 tokenFile 路径；
// - 停止时只在 pid 匹配时删除，避免误删新实例的文件；
// - updatedAt 心跳；超过 15s stale、30s dead。
//
// 本模块不 import @mebular/core，也不读取 MCP 的图/事件数据。

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonFile, writeJsonAtomic } from './atomic-json.js';
import {
  SIDECAR_API_VERSION,
  SIDECAR_CAPABILITY_API_VERSION,
  SIDECAR_MAX_MCP_VERSION,
  SIDECAR_MIN_MCP_VERSION,
  SIDECAR_RUNTIME_VERSION,
  formatHostForUrl,
  isLoopbackHost,
} from './config.js';

export const DISCOVERY_KIND = 'mebular-memory-runtime';
export const DISCOVERY_SCHEMA = 1;
export const DISCOVERY_STALE_MS = 15_000;
export const DISCOVERY_DEAD_MS = 30_000;

export type SidecarState =
  | 'not_installed'
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'failed';

export interface SidecarDiscoveryCapabilities {
  ingest: boolean;
  recall: boolean;
  context: boolean;
  checkpoint: boolean;
  compact: boolean;
  self: boolean;
  models: string[];
}

export interface SidecarDiscovery {
  schema: 1;
  kind: 'mebular-memory-runtime';
  pid: number;
  host: string;
  port: number;
  url: string;
  healthUrl: string;
  cloudId: string | null;
  profileId: string | null;
  runtimeVersion: string;
  apiVersion: number;
  capabilityApiVersion: number;
  minMcpVersion: string;
  maxMcpVersion: string;
  state: SidecarState;
  degraded: boolean;
  tokenFile: string;
  startedAt: number;
  updatedAt: number;
  capabilities: SidecarDiscoveryCapabilities;
}

export interface SidecarDiscoveryInput {
  pid: number;
  host: string;
  port: number;
  tokenFile: string;
  cloudId?: string | null;
  profileId?: string | null;
  url?: string;
  healthUrl?: string;
  runtimeVersion?: string;
  apiVersion?: number;
  capabilityApiVersion?: number;
  minMcpVersion?: string;
  maxMcpVersion?: string;
  state?: SidecarState;
  degraded?: boolean;
  startedAt?: number;
  updatedAt?: number;
  capabilities?: Partial<SidecarDiscoveryCapabilities>;
}

export function discoveryPathForHome(home: string): string {
  return join(home, 'memory-runtime.json');
}

function baseUrlFor(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}/memory-runtime/v1`;
}

/** 构造 discovery 记录；显式列字段，避免调用方误传 token。 */
export function buildDiscovery(input: SidecarDiscoveryInput): SidecarDiscovery {
  if (!Number.isInteger(input.pid) || input.pid <= 0) {
    throw new Error('discovery pid 必须是正整数');
  }
  if (!Number.isInteger(input.port) || input.port < 0 || input.port > 65_535) {
    throw new Error('discovery port 必须是 0–65535 的整数');
  }
  if (!isLoopbackHost(input.host)) {
    throw new Error('discovery host 必须是 loopback');
  }
  const url = input.url ?? baseUrlFor(input.host, input.port);
  const capabilities = input.capabilities ?? {};
  return {
    schema: DISCOVERY_SCHEMA,
    kind: DISCOVERY_KIND,
    pid: input.pid,
    host: input.host,
    port: input.port,
    url,
    healthUrl: input.healthUrl ?? `${url}/health`,
    cloudId: input.cloudId ?? null,
    profileId: input.profileId ?? null,
    runtimeVersion: input.runtimeVersion ?? SIDECAR_RUNTIME_VERSION,
    apiVersion: input.apiVersion ?? SIDECAR_API_VERSION,
    capabilityApiVersion: input.capabilityApiVersion ?? SIDECAR_CAPABILITY_API_VERSION,
    minMcpVersion: input.minMcpVersion ?? SIDECAR_MIN_MCP_VERSION,
    maxMcpVersion: input.maxMcpVersion ?? SIDECAR_MAX_MCP_VERSION,
    state: input.state ?? 'ready',
    degraded: input.degraded === true,
    tokenFile: input.tokenFile,
    startedAt: input.startedAt ?? Date.now(),
    updatedAt: input.updatedAt ?? Date.now(),
    capabilities: {
      ingest: capabilities.ingest === true,
      recall: capabilities.recall === true,
      context: capabilities.context === true,
      checkpoint: capabilities.checkpoint === true,
      compact: capabilities.compact === true,
      self: capabilities.self === true,
      models: Array.isArray(capabilities.models) ? [...capabilities.models] : ['heuristic'],
    },
  };
}

/**
 * 原子写入 discovery（0600）。
 * 显式重建字段，防止调用方把 token 等额外属性带进文件。
 */
export async function writeDiscovery(path: string, discovery: SidecarDiscovery): Promise<SidecarDiscovery> {
  const safe: SidecarDiscovery = {
    schema: DISCOVERY_SCHEMA,
    kind: DISCOVERY_KIND,
    pid: discovery.pid,
    host: discovery.host,
    port: discovery.port,
    url: discovery.url,
    healthUrl: discovery.healthUrl,
    cloudId: discovery.cloudId,
    profileId: discovery.profileId,
    runtimeVersion: discovery.runtimeVersion,
    apiVersion: discovery.apiVersion,
    capabilityApiVersion: discovery.capabilityApiVersion,
    minMcpVersion: discovery.minMcpVersion,
    maxMcpVersion: discovery.maxMcpVersion,
    state: discovery.state,
    degraded: discovery.degraded,
    tokenFile: discovery.tokenFile,
    startedAt: discovery.startedAt,
    updatedAt: discovery.updatedAt,
    capabilities: {
      ingest: discovery.capabilities.ingest,
      recall: discovery.capabilities.recall,
      context: discovery.capabilities.context,
      checkpoint: discovery.capabilities.checkpoint,
      compact: discovery.capabilities.compact,
      self: discovery.capabilities.self,
      models: [...discovery.capabilities.models],
    },
  };
  await writeJsonAtomic(path, safe);
  return safe;
}

function isSidecarDiscovery(value: unknown): value is SidecarDiscovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<SidecarDiscovery>;
  return record.schema === DISCOVERY_SCHEMA
    && record.kind === DISCOVERY_KIND
    && typeof record.pid === 'number'
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.host === 'string'
    && typeof record.port === 'number'
    && typeof record.url === 'string'
    && typeof record.healthUrl === 'string'
    && typeof record.tokenFile === 'string'
    && typeof record.startedAt === 'number'
    && typeof record.updatedAt === 'number';
}

/** 读取 discovery；缺失/损坏返回 null。 */
export async function readDiscovery(path: string): Promise<SidecarDiscovery | null> {
  const value = await readJsonFile<unknown>(path);
  return isSidecarDiscovery(value) ? value : null;
}

/**
 * 删除 discovery，但只在 pid 匹配时执行。
 * 文件缺失、损坏或 pid 不匹配都返回 false，绝不误删新实例。
 */
export async function clearDiscovery(path: string, { pid }: { pid: number }): Promise<boolean> {
  const current = await readDiscovery(path);
  if (!current || current.pid !== pid) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 心跳更新 updatedAt/state/degraded；只在 pid 仍属于当前进程时写入。
 * 返回是否更新成功。
 */
export async function touchDiscovery(
  path: string,
  {
    pid,
    now = Date.now(),
    state,
    degraded,
  }: { pid: number; now?: number; state?: SidecarState; degraded?: boolean },
): Promise<boolean> {
  const current = await readDiscovery(path);
  if (!current || current.pid !== pid) return false;
  const next: SidecarDiscovery = {
    ...current,
    updatedAt: now,
    ...(state !== undefined ? { state } : {}),
    ...(degraded !== undefined ? { degraded } : {}),
  };
  await writeDiscovery(path, next);
  return true;
}

export function isDiscoveryStale(discovery: Pick<SidecarDiscovery, 'updatedAt'>, now = Date.now()): boolean {
  return now - discovery.updatedAt > DISCOVERY_STALE_MS;
}

export function isDiscoveryDead(discovery: Pick<SidecarDiscovery, 'updatedAt'>, now = Date.now()): boolean {
  return now - discovery.updatedAt > DISCOVERY_DEAD_MS;
}
