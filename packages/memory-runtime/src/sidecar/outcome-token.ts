// 0.4.0 W4：outcome 归因的 opaque binding token。
//
// 契约（W0-A §5.1）：
// - sidecar 在 `/context` 响应签发；宿主只回传，不解析；
// - 绑定 traceId + agentId + threadId + turnId + hostApp；
// - HMAC-SHA256，key 来自当前 host token；
// - TTL = `intervention.outcomeWindowMs`；
// - 不落盘、不含 raw query/detail/token/Authorization；
// - host token 轮换后旧 token 因签名不匹配立即失效；
// - traceId 为空（trace off / W5 skip）时不签发。
//
// 本模块只做编码/签名/校验；不读写文件、不写日志、不碰 store。

import { createHmac, timingSafeEqual } from 'node:crypto';

export const OUTCOME_BINDING_PREFIX = 'obt_';
export const OUTCOME_BINDING_VERSION = 1;

export interface OutcomeBindingScope {
  traceId: string;
  agentId: string;
  threadId: string | null;
  turnId: string | null;
  hostApp: string | null;
}

export interface IssueOutcomeBindingOptions {
  scope: OutcomeBindingScope;
  /** 当前 host token；只作为 HMAC key，不进入 token。 */
  hostToken: string;
  now: number;
  /** TTL；来自 `intervention.outcomeWindowMs`。 */
  windowMs: number;
}

export type OutcomeBindingErrorCode =
  | 'outcome_binding_invalid'
  | 'outcome_binding_expired';

export type VerifyOutcomeBindingResult =
  | { ok: true; scope: OutcomeBindingScope; expiresAt: number }
  | { ok: false; code: OutcomeBindingErrorCode };

interface OutcomeBindingPayload {
  /** payload version。 */
  v: 1;
  /** traceId。 */
  t: string;
  /** agentId。 */
  a: string;
  /** threadId；null 时省略。 */
  th?: string;
  /** turnId；null 时省略。 */
  tu?: string;
  /** hostApp；null 时省略。 */
  h?: string;
  /** expiresAt（epoch ms）。 */
  e: number;
}

function toBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function sign(payloadSegment: string, hostToken: string): string {
  return createHmac('sha256', hostToken).update(payloadSegment, 'utf8').digest('base64url');
}

function equalSignature(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 签发 opaque binding token。
 *
 * - `scope.traceId` 为空、hostToken 为空或 windowMs 非正数时返回 null（fail closed，
 *   宿主不得对 `traceId:null` 上报 outcome）。
 * - 只编码 ID/过期时间；不编码 query、detail、gist、token、Authorization。
 */
export function issueOutcomeBinding({
  scope,
  hostToken,
  now,
  windowMs,
}: IssueOutcomeBindingOptions): string | null {
  if (!isNonEmptyString(scope.traceId)) return null;
  if (!isNonEmptyString(scope.agentId)) return null;
  if (!isNonEmptyString(hostToken)) return null;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
  const payload: OutcomeBindingPayload = {
    v: OUTCOME_BINDING_VERSION,
    t: scope.traceId,
    a: scope.agentId,
    ...(scope.threadId ? { th: scope.threadId } : {}),
    ...(scope.turnId ? { tu: scope.turnId } : {}),
    ...(scope.hostApp ? { h: scope.hostApp } : {}),
    e: Math.floor(now + windowMs),
  };
  const segment = toBase64Url(JSON.stringify(payload));
  return `${OUTCOME_BINDING_PREFIX}${segment}.${sign(segment, hostToken)}`;
}

function decodePayload(segment: string): OutcomeBindingPayload | null {
  try {
    const raw = Buffer.from(segment, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (value.v !== OUTCOME_BINDING_VERSION) return null;
    if (!isNonEmptyString(value.t) || !isNonEmptyString(value.a)) return null;
    if (!Number.isFinite(value.e)) return null;
    if (value.th !== undefined && !isNonEmptyString(value.th)) return null;
    if (value.tu !== undefined && !isNonEmptyString(value.tu)) return null;
    if (value.h !== undefined && !isNonEmptyString(value.h)) return null;
    return {
      v: OUTCOME_BINDING_VERSION,
      t: value.t,
      a: value.a,
      ...(value.th !== undefined ? { th: value.th as string } : {}),
      ...(value.tu !== undefined ? { tu: value.tu as string } : {}),
      ...(value.h !== undefined ? { h: value.h as string } : {}),
      e: Math.floor(value.e as number),
    };
  } catch {
    return null;
  }
}

/**
 * 校验 token：格式、HMAC、过期。
 *
 * 注意：这里只做密码学校验；trace/agent/thread/turn/host 的跨域匹配由
 * `submitOutcome()` 用返回的 scope 再核对（token 内 scope 与 URL trace 必须一致）。
 */
export function verifyOutcomeBinding(
  token: string,
  hostToken: string,
  now: number,
): VerifyOutcomeBindingResult {
  if (!isNonEmptyString(token) || !isNonEmptyString(hostToken)) {
    return { ok: false, code: 'outcome_binding_invalid' };
  }
  if (!token.startsWith(OUTCOME_BINDING_PREFIX)) {
    return { ok: false, code: 'outcome_binding_invalid' };
  }
  const parts = token.slice(OUTCOME_BINDING_PREFIX.length).split('.');
  if (parts.length !== 2) return { ok: false, code: 'outcome_binding_invalid' };
  const [segment, signature] = parts;
  if (!segment || !signature) return { ok: false, code: 'outcome_binding_invalid' };
  const expected = sign(segment, hostToken);
  if (!equalSignature(expected, signature)) {
    return { ok: false, code: 'outcome_binding_invalid' };
  }
  const payload = decodePayload(segment);
  if (!payload) return { ok: false, code: 'outcome_binding_invalid' };
  if (payload.e <= now) return { ok: false, code: 'outcome_binding_expired' };
  return {
    ok: true,
    expiresAt: payload.e,
    scope: {
      traceId: payload.t,
      agentId: payload.a,
      threadId: payload.th ?? null,
      turnId: payload.tu ?? null,
      hostApp: payload.h ?? null,
    },
  };
}
