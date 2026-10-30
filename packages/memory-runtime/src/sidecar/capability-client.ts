// MCP Memory Capability API 客户端（`/internal/memory/v1`）。
//
// 只允许 Memory Runtime sidecar 使用；所有持久记忆读写都从这里进入 MCP，
// 不 import @mebular/core、GraphStore、EventLog、MemoryService 或 MCP 内部模块。
//
// 职责：
// - Bearer capability token（env/文件由调用方提供，收到 401 时重读一次）；
// - 请求超时与有限重试（网络/429/5xx）；
// - 统一信封解析与错误映射（保留稳定 code/retryable/details）；
// - 覆盖 version/status/namespaces/query/search/history/profile/skills/graph/
//   write/update/delete/archive/internal-object/sync。

import { randomUUID } from 'node:crypto';
import { normalizeCapabilityBaseUrl } from './config.js';

export const CAPABILITY_API_PREFIX = '/internal/memory/v1';
export const CAPABILITY_CLIENT_VERSION = 1;

export type CapabilityQueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Record<string, unknown>
  | unknown[];
export type CapabilityQuery = Record<string, CapabilityQueryValue>;

export interface CapabilityEnvelope<T> {
  ok: true;
  requestId: string;
  capabilityVersion: number;
  data: T;
  warnings: string[];
  degraded: boolean;
  status: number;
}

export interface CapabilityVersionInfo {
  capabilityApiVersion: number;
  schemaVersion: number;
  mcpVersion: string;
  coreVersion?: string;
  features?: Record<string, unknown>;
  limits?: Record<string, number>;
  domains?: Record<string, unknown>;
}

export interface CapabilityIdentity {
  cloudId?: string | null;
  cloudTrustId?: string | null;
  userId?: string | null;
  profileId?: string | null;
  deviceId?: string | null;
  hostId?: string | null;
}

export interface CapabilityStatusInfo {
  initialized?: boolean;
  identity?: CapabilityIdentity;
  counts?: Record<string, number>;
  domains?: unknown[];
  sync?: Record<string, unknown>;
  limits?: Record<string, number>;
  [key: string]: unknown;
}

export interface CapabilityClientErrorOptions {
  status?: number;
  retryable?: boolean;
  details?: unknown;
  requestId?: string;
}

export class CapabilityClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(code: string, message: string, options: CapabilityClientErrorOptions = {}) {
    super(message);
    this.name = 'CapabilityClientError';
    this.code = code;
    this.status = options.status ?? 0;
    this.retryable = options.retryable === true;
    this.details = options.details;
    this.requestId = options.requestId;
  }
}

export interface CapabilityClientOptions {
  /** 例如 http://127.0.0.1:7331/internal/memory/v1；只允许 loopback。 */
  baseUrl: string;
  /** 初始 Bearer token；也可只提供 readToken。 */
  token?: string | null;
  /** 401 时重读 token（token 轮换）。返回 null 表示不可用。 */
  readToken?: () => string | null | Promise<string | null>;
  timeoutMs?: number;
  /** 可重试失败后的额外重试次数；默认 2。 */
  retries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface CapabilityRequestOptions {
  method?: 'GET' | 'POST';
  query?: CapabilityQuery;
  body?: unknown;
  idempotencyKey?: string;
  /** 覆盖客户端默认重试次数。 */
  retries?: number;
}

interface DecodedResponse {
  status: number;
  body: unknown;
  text: string;
  retryAfterMs: number | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), 5000);
  return null;
}

function retryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export class CapabilityClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;

  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readToken?: () => string | null | Promise<string | null>;
  private token: string | null;

  constructor(options: CapabilityClientOptions) {
    try {
      this.baseUrl = normalizeCapabilityBaseUrl(options.baseUrl, { appendSuffix: true });
    } catch (error) {
      throw new CapabilityClientError('invalid_base_url', 'capability 基地址不合法', {
        details: { reason: (error as Error)?.message ?? 'invalid_url' },
      });
    }
    this.token = typeof options.token === 'string' && options.token.length > 0 ? options.token : null;
    this.readToken = options.readToken;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.floor(options.timeoutMs as number)
      : 5000;
    this.retries = Number.isInteger(options.retries) && (options.retries as number) >= 0
      ? (options.retries as number)
      : 2;
    this.retryDelayMs = Number.isFinite(options.retryDelayMs) && (options.retryDelayMs ?? 0) >= 0
      ? Math.floor(options.retryDelayMs as number)
      : 100;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** 更新内存中的 token（由调用方在轮换后主动同步）。 */
  setToken(token: string | null): void {
    this.token = typeof token === 'string' && token.length > 0 ? token : null;
  }

  private async currentToken({ refresh = false }: { refresh?: boolean } = {}): Promise<string> {
    if (refresh && this.readToken) {
      this.token = await this.readToken();
    }
    if (this.token) return this.token;
    if (this.readToken) {
      this.token = await this.readToken();
      if (this.token) return this.token;
    }
    throw new CapabilityClientError('capability_token_missing', '缺少 capability token');
  }

  private buildUrl(path: string, query?: CapabilityQuery): string {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${suffix}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (typeof value === 'object') {
          url.searchParams.set(key, JSON.stringify(value));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async fetchOnce(
    url: string,
    init: RequestInit,
  ): Promise<DecodedResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new CapabilityClientError('timeout', 'capability 请求超时', { retryable: true });
      }
      throw new CapabilityClientError('network_error', '无法连接 capability API', {
        retryable: true,
        details: { reason: (error as Error)?.name ?? 'network_error' },
      });
    } finally {
      clearTimeout(timer);
    }

    let text = '';
    try {
      text = await response.text();
    } catch {
      throw new CapabilityClientError('invalid_response', '读取 capability 响应失败', {
        status: response.status,
      });
    }
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        throw new CapabilityClientError('invalid_response', 'capability 响应不是合法 JSON', {
          status: response.status,
        });
      }
    }
    return {
      status: response.status,
      body,
      text,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    };
  }

  private errorFromResponse(decoded: DecodedResponse, requestId: string): CapabilityClientError {
    const envelope = isObject(decoded.body) ? decoded.body : null;
    const error = isObject(envelope?.error) ? envelope.error : null;
    const code = typeof error?.code === 'string' && error.code.length > 0
      ? error.code
      : `http_${decoded.status}`;
    const message = typeof error?.message === 'string' && error.message.length > 0
      ? error.message
      : 'capability 请求失败';
    const retryable = typeof error?.retryable === 'boolean'
      ? error.retryable
      : retryableStatus(decoded.status);
    return new CapabilityClientError(code, message, {
      status: decoded.status,
      retryable,
      details: error?.details,
      requestId,
    });
  }

  /** 底层调用；返回统一信封。未知端点/字段由调用方按字符串处理。 */
  async call<T>(path: string, options: CapabilityRequestOptions = {}): Promise<CapabilityEnvelope<T>> {
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    const requestId = `req_${randomUUID()}`;
    const maxAttempts = Math.max(0, options.retries ?? this.retries) + 1;
    let attempt = 0;
    let tokenRefreshed = false;

    // 额外一次迭代留给 401 token 轮换后的一次重试。
    for (let iteration = 0; iteration < maxAttempts + 2; iteration += 1) {
      const token = await this.currentToken();
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'x-request-id': requestId,
        'x-mebular-capability-version': String(CAPABILITY_CLIENT_VERSION),
      };
      if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
      let bodyText: string | undefined;
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json';
        try {
          bodyText = JSON.stringify(options.body);
        } catch {
          throw new CapabilityClientError('invalid_request', '请求体不可序列化');
        }
      }

      let decoded: DecodedResponse;
      try {
        decoded = await this.fetchOnce(this.buildUrl(path, options.query), {
          method,
          headers,
          ...(bodyText !== undefined ? { body: bodyText } : {}),
        });
      } catch (error) {
        const clientError = error instanceof CapabilityClientError
          ? error
          : new CapabilityClientError('network_error', 'capability 请求失败', { retryable: true });
        if (clientError.retryable && attempt + 1 < maxAttempts) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw clientError;
      }

      // 401：按契约重读一次 token，再重试一次；仍失败进入 degraded（调用方决定）。
      if (decoded.status === 401 && this.readToken && !tokenRefreshed) {
        tokenRefreshed = true;
        try {
          await this.currentToken({ refresh: true });
          continue;
        } catch {
          throw new CapabilityClientError('capability_token_invalid', 'capability token 已失效', {
            status: 401,
            requestId,
          });
        }
      }

      const envelope = isObject(decoded.body) ? decoded.body : null;
      if (decoded.status >= 200 && decoded.status < 300 && envelope?.ok === true) {
        return {
          ok: true,
          requestId: typeof envelope.requestId === 'string' ? envelope.requestId : requestId,
          capabilityVersion: typeof envelope.capabilityVersion === 'number'
            ? envelope.capabilityVersion
            : CAPABILITY_CLIENT_VERSION,
          data: envelope.data as T,
          warnings: stringArray(envelope.warnings),
          degraded: envelope.degraded === true,
          status: decoded.status,
        };
      }

      const error = this.errorFromResponse(decoded, requestId);
      if (error.retryable && attempt + 1 < maxAttempts) {
        attempt += 1;
        const delay = decoded.retryAfterMs ?? this.retryDelayMs * 2 ** (attempt - 1);
        await this.sleep(delay);
        continue;
      }
      throw error;
    }
    throw new CapabilityClientError('internal', 'capability 请求未能完成', { requestId });
  }

  async get<T>(path: string, query?: CapabilityQuery): Promise<CapabilityEnvelope<T>> {
    return this.call<T>(path, { method: 'GET', query });
  }

  async post<T>(path: string, body: unknown, options: Omit<CapabilityRequestOptions, 'method' | 'body'> = {}): Promise<CapabilityEnvelope<T>> {
    return this.call<T>(path, { ...options, method: 'POST', body });
  }

  getVersion(): Promise<CapabilityEnvelope<CapabilityVersionInfo>> {
    return this.get<CapabilityVersionInfo>('/version');
  }

  getStatus(query?: CapabilityQuery): Promise<CapabilityEnvelope<CapabilityStatusInfo>> {
    return this.get<CapabilityStatusInfo>('/status', query);
  }

  getNamespaces(query?: CapabilityQuery): Promise<CapabilityEnvelope<Record<string, unknown>>> {
    return this.get<Record<string, unknown>>('/namespaces', query);
  }

  query<T = Record<string, unknown>>(body: unknown): Promise<CapabilityEnvelope<T>> {
    return this.post<T>('/query', body);
  }

  search<T = Record<string, unknown>>(body: unknown): Promise<CapabilityEnvelope<T>> {
    return this.post<T>('/search', body);
  }

  history<T = Record<string, unknown>>(body: unknown): Promise<CapabilityEnvelope<T>> {
    return this.post<T>('/history', body);
  }

  profile<T = Record<string, unknown>>(body: unknown): Promise<CapabilityEnvelope<T>> {
    return this.post<T>('/profile', body);
  }

  skills<T = Record<string, unknown>>(body: unknown): Promise<CapabilityEnvelope<T>> {
    return this.post<T>('/skills', body);
  }

  graph<T = Record<string, unknown>>(body: unknown): Promise<CapabilityEnvelope<T>> {
    return this.post<T>('/graph', body);
  }

  write<T = Record<string, unknown>>(body: unknown, options: { idempotencyKey?: string } = {}): Promise<CapabilityEnvelope<T>> {
    return this.post<T>('/write', body, options);
  }

  update<T = Record<string, unknown>>(body: unknown, options: { idempotencyKey?: string } = {}): Promise<CapabilityEnvelope<T>> {
    return this.post<T>('/update', body, options);
  }

  /** 墓碑删除；端点名固定为 `/delete`。 */
  delete<T = Record<string, unknown>>(body: unknown, options: { idempotencyKey?: string } = {}): Promise<CapabilityEnvelope<T>> {
    return this.post<T>('/delete', body, options);
  }

  archive<T = Record<string, unknown>>(body: unknown, options: { idempotencyKey?: string } = {}): Promise<CapabilityEnvelope<T>> {
    return this.post<T>('/archive', body, options);
  }

  internalObject<T = Record<string, unknown>>(body: unknown, options: { idempotencyKey?: string } = {}): Promise<CapabilityEnvelope<T>> {
    return this.post<T>('/internal-object', body, options);
  }

  getSync(query?: CapabilityQuery): Promise<CapabilityEnvelope<Record<string, unknown>>> {
    return this.get<Record<string, unknown>>('/sync', query);
  }

  sync<T = Record<string, unknown>>(body: unknown, options: { idempotencyKey?: string } = {}): Promise<CapabilityEnvelope<T>> {
    return this.post<T>('/sync', body, options);
  }
}
