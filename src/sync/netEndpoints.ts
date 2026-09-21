// C5 · 自动广播：`net_endpoints` 记录（命名空间 `__net__`，opt-in）
//
// 语义（SEALING 条款）：**只作 hints，永不参与授权**。
//  - 仅 subject 本人签发（读取侧要求 `event.author === payload.subject`）；
//  - 载荷带 `sig`（subject 设备钥对规范化载荷签名；读取侧可选校验）；
//  - `expiry` 是**本地策略**（墙钟只影响本机是否采用该 hint，**不进一致性**、不影响 stateHash）；
//  - 吊销级联过滤：被吊销的 subject 的记录一律忽略；
//  - 候选排序 `public > lan > relay`（与 EndpointBook 的 direct > lan > relay 一致）；
//  - `relayCapable` 只是信息（无义务、无权限）：不使本机成为桥，也不换取任何授权。

import { extractEndpointHost } from '../p2p/connection/EndpointBook.js';

export const NET_NAMESPACE = '__net__';
export const NET_ENDPOINTS_EVENT = 'net_endpoints';

export type NetEndpointKind = 'public' | 'lan' | 'relay';
/** 广播档位：full（默认，发布实际存在的 lan/public/relay）· relay-only · off */
export type NetBroadcastMode = 'full' | 'relay-only' | 'off';

export interface NetEndpointHint {
  addr: string;
  kind: NetEndpointKind;
}

export interface NetEndpointsPayload {
  subject: string;
  endpoints: NetEndpointHint[];
  relayCapable: boolean;
  issuedAt: number;
  expiry: number;
  /** subject 设备钥签名（base64；可选字段，缺失时读取侧只依赖事件自身签名） */
  sig?: string;
}

/** 与 EndpointBook.KIND_PRIORITY 对齐：public(direct) < lan < relay */
export const NET_KIND_PRIORITY: Record<NetEndpointKind, number> = { public: 0, lan: 1, relay: 2 };

const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./];
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '']);

/** 地址 → 广播类别（relay 优先；私网/link-local → lan；其余 → public） */
export function classifyNetEndpoint(address: string): NetEndpointKind {
  const value = String(address ?? '');
  if (value.includes('/p2p-circuit')) return 'relay';
  const host = extractEndpointHost(value) ?? '';
  if (LOOPBACK.has(host) || host.startsWith('127.')) return 'lan'; // 回环不外发（本地策略按 lan 归类，通常会被过滤）
  if (host.endsWith('.local')) return 'lan';
  if (PRIVATE_V4.some((re) => re.test(host))) return 'lan';
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return 'lan';
  return 'public';
}

/** 供发布侧使用：按档位挑选地址并按优先级排序、去重 */
export function buildNetEndpointsPayload(input: {
  subject: string;
  addresses: string[];
  relayCapable: boolean;
  mode?: NetBroadcastMode;
  now?: number;
  ttlMs?: number;
  sig?: string;
}): NetEndpointsPayload {
  const mode: NetBroadcastMode = input.mode ?? 'full';
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? 24 * 3600_000;
  const seen = new Set<string>();
  const endpoints: NetEndpointHint[] = [];
  for (const addr of input.addresses ?? []) {
    if (typeof addr !== 'string' || addr.length === 0) continue;
    const kind = classifyNetEndpoint(addr);
    if (mode === 'relay-only' && kind !== 'relay') continue;
    if (kind === 'lan' && LOOPBACK.has(extractEndpointHost(addr) ?? '')) continue; // 回环不外发
    if (seen.has(addr)) continue;
    seen.add(addr);
    endpoints.push({ addr, kind });
  }
  endpoints.sort((a, b) => NET_KIND_PRIORITY[a.kind] - NET_KIND_PRIORITY[b.kind] || a.addr.localeCompare(b.addr));
  return {
    subject: input.subject,
    endpoints,
    relayCapable: input.relayCapable === true,
    issuedAt: now,
    expiry: now + ttlMs,
    ...(input.sig !== undefined ? { sig: input.sig } : {}),
  };
}

export type NetEndpointsValidationFailure = 'shape' | 'subject' | 'expired' | 'empty' | 'revoked';

export type NetEndpointsValidation =
  | { ok: true; payload: NetEndpointsPayload }
  | { ok: false; reason: NetEndpointsValidationFailure };

/** 形状校验（读取侧第一步；不涉及任何授权判定） */
export function parseNetEndpointsPayload(raw: unknown): NetEndpointsPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.subject !== 'string' || value.subject.length === 0) return null;
  if (typeof value.relayCapable !== 'boolean') return null;
  if (typeof value.issuedAt !== 'number' || typeof value.expiry !== 'number') return null;
  if (value.sig !== undefined && typeof value.sig !== 'string') return null;
  if (!Array.isArray(value.endpoints)) return null;
  const endpoints: NetEndpointHint[] = [];
  for (const item of value.endpoints) {
    if (!item || typeof item !== 'object') return null;
    const entry = item as Record<string, unknown>;
    if (typeof entry.addr !== 'string' || entry.addr.length === 0) return null;
    const kind = entry.kind;
    if (kind !== 'public' && kind !== 'lan' && kind !== 'relay') return null;
    endpoints.push({ addr: entry.addr, kind });
  }
  return {
    subject: value.subject,
    endpoints,
    relayCapable: value.relayCapable,
    issuedAt: value.issuedAt,
    expiry: value.expiry,
    ...(typeof value.sig === 'string' ? { sig: value.sig } : {}),
  };
}

/**
 * 读取侧过滤（本地策略，无副作用）：
 *  - `author` 必须等于 payload.subject（仅 subject 签发）；
 *  - 事件命名空间必须是 `__net__`；
 *  - `expiry` 过期（本地墙钟）→ 忽略；
 *  - subject 被吊销 → 级联忽略；
 *  - 无有效端点 → 忽略。
 * **注意**：本函数不做任何授权/成员判定；hints 永不参与授权。
 */
export function acceptNetEndpointsEvent(event: { author: string; namespace?: string; data?: unknown }, options: {
  now?: number;
  isRevoked?: (subject: string) => boolean;
} = {}): NetEndpointsValidation {
  if (event.namespace !== NET_NAMESPACE) return { ok: false, reason: 'shape' };
  const payload = parseNetEndpointsPayload(event.data);
  if (!payload) return { ok: false, reason: 'shape' };
  if (payload.subject !== event.author) return { ok: false, reason: 'subject' };
  const now = options.now ?? Date.now();
  if (!(payload.expiry > now)) return { ok: false, reason: 'expired' };
  if (options.isRevoked?.(payload.subject) === true) return { ok: false, reason: 'revoked' };
  if (payload.endpoints.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, payload };
}

/** 按优先级取地址（public > lan > relay；同类按地址字典序，稳定可比） */
export function orderedNetEndpointAddresses(payload: NetEndpointsPayload): string[] {
  return [...payload.endpoints]
    .sort((a, b) => NET_KIND_PRIORITY[a.kind] - NET_KIND_PRIORITY[b.kind] || a.addr.localeCompare(b.addr))
    .map((entry) => entry.addr);
}
