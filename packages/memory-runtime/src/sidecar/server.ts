// Memory Runtime sidecar host API（`/memory-runtime/v1`）。
//
// W3a 骨架只提供：
// - GET /health   （无 token；仅 loopback，最小信息）
// - GET /version  （host token）
// - GET /status   （host token）
// 其余 ingest/recall/context/checkpoint/compact/self 等业务端点返回 501，
// 由 W4 实现；不得在骨架里伪造记忆读写。
//
// 安全基线（sidecar 契约 §4、§8、§11）：
// - 只监听 loopback；拒绝非 loopback Host/Origin；无 CORS、无 cookie；
// - 除 /health 外全部要求 Bearer host token；
// - 统一信封 {ok, requestId, apiVersion, data, warnings, degraded}；
// - 响应不包含 token，错误只给稳定 code + 短句。

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  SIDECAR_API_PREFIX,
  SIDECAR_API_VERSION,
  SIDECAR_CAPABILITY_API_VERSION,
  SIDECAR_MAX_MCP_VERSION,
  SIDECAR_MIN_MCP_VERSION,
  SIDECAR_RUNTIME_VERSION,
  formatHostForUrl,
  isLoopbackHost,
  type SidecarConfig,
} from './config.js';
import type { SidecarState } from './discovery.js';

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const UNIMPLEMENTED_ROUTES = new Set([
  'namespaces',
  'mode',
  'ingest',
  'extractions',
  'recall',
  'context',
  'checkpoints',
  'compact',
  'compacts',
  'self',
  'traces',
  'config',
  'metrics',
]);

export type SidecarServerErrorCode = 'bind_not_loopback' | 'bind_failed' | 'not_listening';

export class SidecarServerError extends Error {
  readonly code: SidecarServerErrorCode;

  constructor(code: SidecarServerErrorCode, message: string) {
    super(message);
    this.name = 'SidecarServerError';
    this.code = code;
  }
}

export interface SidecarStatusIdentity {
  cloudId: string | null;
  profileId: string | null;
  hostId: string | null;
}

export interface SidecarStatusCapability {
  reachable: boolean;
  version: number | null;
  lastOkAt: number | null;
  error: string | null;
}

export interface SidecarStatusModel {
  configured: string;
  active: string;
  degraded: boolean;
  reason: string | null;
}

export interface SidecarStatusCounts {
  rawChunks: number;
  traces: number;
  cachedRecords: number;
  outbox: number;
  deadLetter: number;
}

export interface SidecarStatusOutbox {
  items: number;
  bytes: number;
  oldestAt: number | null;
}

export interface SidecarStatusLimits {
  maxChunkBytes: number;
  maxContextTokens: number;
  maxRecall: number;
}

export interface SidecarStatusSnapshot {
  mode: 'immersive';
  identity: SidecarStatusIdentity;
  capability: SidecarStatusCapability;
  model: SidecarStatusModel;
  counts: SidecarStatusCounts;
  outbox: SidecarStatusOutbox;
  limits: SidecarStatusLimits;
  warnings: string[];
}

export interface SidecarStatus extends SidecarStatusSnapshot {
  state: SidecarState;
  degraded: boolean;
  pid: number;
  uptimeMs: number;
}

export interface SidecarServerOptions {
  config: SidecarConfig;
  hostToken: string;
  identity?: Partial<SidecarStatusIdentity>;
  getStatus?: () => SidecarStatusSnapshot | Promise<SidecarStatusSnapshot>;
  state?: SidecarState;
  degraded?: boolean;
  now?: () => number;
  startedAt?: number;
  runtimeVersion?: string;
  apiVersion?: number;
  capabilityApiVersion?: number;
  minMcpVersion?: string;
  maxMcpVersion?: string;
}

export interface SidecarListenResult {
  host: string;
  port: number;
  url: string;
  healthUrl: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requestIdOf(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : `req_${randomUUID()}`;
}

function safeTokenEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return left.length === right.length && timingSafeEqual(left, right);
}

/** capability / sidecar 只接受这三个 loopback 地址（含 IPv4-mapped IPv6）。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

interface ParsedHost {
  hostname: string;
  port: number | null;
}

export function parseHostHeader(header: string | undefined): ParsedHost | null {
  if (typeof header !== 'string' || header.trim().length === 0) return null;
  const value = header.trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return null;
    const hostname = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (rest === '') return { hostname, port: null };
    if (!rest.startsWith(':')) return null;
    const port = Number(rest.slice(1));
    return Number.isInteger(port) && port > 0 ? { hostname, port } : null;
  }
  const colon = value.lastIndexOf(':');
  if (colon < 0) return { hostname: value, port: null };
  const hostname = value.slice(0, colon);
  if (hostname.includes(':')) return { hostname: value, port: null };
  const port = Number(value.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  return { hostname, port };
}

/** Host 头必须是 loopback；若带端口，必须与本地监听端口一致。 */
export function isLoopbackHostHeader(header: string | undefined, localPort?: number): boolean {
  const parsed = parseHostHeader(header);
  if (!parsed || !isLoopbackHost(parsed.hostname)) return false;
  if (parsed.port !== null && typeof localPort === 'number' && Number.isInteger(localPort) && localPort > 0 && parsed.port !== localPort) {
    return false;
  }
  return true;
}

/** 存在 Origin 时必须指向本机 loopback；不存在则允许（纯 bearer 调用）。 */
export function isLoopbackOrigin(origin: string | undefined, localPort?: number): boolean {
  if (origin === undefined || origin === '') return true;
  if (origin === 'null') return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username.length > 0 || url.password.length > 0) return false;
  if (!isLoopbackHost(url.hostname)) return false;
  if (url.port && typeof localPort === 'number' && Number.isInteger(localPort) && localPort > 0 && Number(url.port) !== localPort) {
    return false;
  }
  return true;
}

export class SidecarServer {
  readonly config: SidecarConfig;
  readonly hostToken: string;
  readonly startedAt: number;
  readonly runtimeVersion: string;
  readonly apiVersion: number;
  readonly capabilityApiVersion: number;
  readonly minMcpVersion: string;
  readonly maxMcpVersion: string;

  state: SidecarState;
  degraded: boolean;

  private readonly identity: SidecarStatusIdentity;
  private readonly getStatus?: () => SidecarStatusSnapshot | Promise<SidecarStatusSnapshot>;
  private readonly now: () => number;
  private server: Server | null = null;
  private host = '';
  private port = 0;
  private stopping = false;

  constructor(options: SidecarServerOptions) {
    this.config = options.config;
    this.hostToken = options.hostToken;
    this.identity = {
      cloudId: options.identity?.cloudId ?? null,
      profileId: options.identity?.profileId ?? null,
      hostId: options.identity?.hostId ?? null,
    };
    this.getStatus = options.getStatus;
    this.state = options.state ?? 'starting';
    this.degraded = options.degraded === true;
    this.now = options.now ?? Date.now;
    this.startedAt = options.startedAt ?? this.now();
    this.runtimeVersion = options.runtimeVersion ?? SIDECAR_RUNTIME_VERSION;
    this.apiVersion = options.apiVersion ?? SIDECAR_API_VERSION;
    this.capabilityApiVersion = options.capabilityApiVersion ?? SIDECAR_CAPABILITY_API_VERSION;
    this.minMcpVersion = options.minMcpVersion ?? SIDECAR_MIN_MCP_VERSION;
    this.maxMcpVersion = options.maxMcpVersion ?? SIDECAR_MAX_MCP_VERSION;
  }

  get isListening(): boolean {
    return this.server !== null;
  }

  get listenedHost(): string {
    return this.host;
  }

  get listenedPort(): number {
    return this.port;
  }

  get url(): string {
    return `http://${formatHostForUrl(this.host)}:${this.port}${SIDECAR_API_PREFIX}`;
  }

  get healthUrl(): string {
    return `${this.url}/health`;
  }

  private candidatePorts(configured: number): number[] {
    if (configured === 0) return [0];
    if (configured === 7341) {
      return [7341, 7342, 7343, 7344, 7345, 7346, 7347, 7348, 7349, 7350, 0];
    }
    return [configured, 0];
  }

  private async bind(port: number): Promise<void> {
    if (!isLoopbackHost(this.config.http.host)) {
      throw new SidecarServerError('bind_not_loopback', 'sidecar HTTP 只允许绑定 loopback 地址');
    }
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, this.config.http.host);
    }).catch((error: NodeJS.ErrnoException) => {
      server.close(() => undefined);
      throw error;
    });
    const address = server.address();
    if (address && typeof address === 'object') {
      this.host = address.address;
      this.port = address.port;
    } else {
      this.host = this.config.http.host;
      this.port = port;
    }
    this.server = server;
  }

  /** 监听；默认端口占用时按 7341–7350 → 临时端口回退。 */
  async listen(): Promise<SidecarListenResult> {
    if (this.server) {
      return { host: this.host, port: this.port, url: this.url, healthUrl: this.healthUrl };
    }
    let lastError: unknown = null;
    for (const port of this.candidatePorts(this.config.http.port)) {
      try {
        await this.bind(port);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
        break;
      }
    }
    if (this.server === null) {
      const code = (lastError as NodeJS.ErrnoException)?.code;
      throw new SidecarServerError(
        'bind_failed',
        code === 'EACCES' ? 'sidecar 端口无权限绑定' : 'sidecar HTTP 监听失败',
      );
    }
    if (this.state === 'starting') this.state = 'ready';
    return { host: this.host, port: this.port, url: this.url, healthUrl: this.healthUrl };
  }

  async close(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.state = 'stopping';
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 不等待 keep-alive 连接自然过期；测试与父进程退出都要求快速关闭。
      server.closeAllConnections?.();
    });
    this.state = 'stopped';
  }

  setState(state: SidecarState): void {
    this.state = state;
  }

  setDegraded(degraded: boolean): void {
    this.degraded = degraded;
  }

  private envelope(requestId: string, data: unknown, warnings: string[] = [], degraded = false) {
    return {
      ok: true,
      requestId,
      apiVersion: this.apiVersion,
      data,
      warnings,
      degraded,
    };
  }

  private errorEnvelope(
    requestId: string,
    code: string,
    message: string,
    details?: unknown,
    retryable = false,
  ) {
    return {
      ok: false,
      requestId,
      apiVersion: this.apiVersion,
      error: {
        code,
        message,
        retryable,
        ...(details !== undefined ? { details } : {}),
      },
    };
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded) return;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-mebular-degraded', String(this.degraded));
    res.end(JSON.stringify(body));
  }

  private sendError(
    res: ServerResponse,
    status: number,
    requestId: string,
    code: string,
    message: string,
    details?: unknown,
    retryable = false,
  ): void {
    if (status === 401) res.setHeader('www-authenticate', 'Bearer');
    this.send(res, status, this.errorEnvelope(requestId, code, message, details, retryable));
  }

  private authorize(req: IncomingMessage): { ok: true } | { ok: false; code: string } {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return { ok: false, code: 'unauthorized' };
    }
    const token = header.slice('Bearer '.length).trim();
    if (token.length === 0) return { ok: false, code: 'unauthorized' };
    if (!safeTokenEqual(token, this.hostToken)) return { ok: false, code: 'invalid_token' };
    return { ok: true };
  }

  private async statusPayload(): Promise<SidecarStatus> {
    const fallback: SidecarStatusSnapshot = {
      mode: 'immersive',
      identity: { ...this.identity },
      capability: { reachable: false, version: null, lastOkAt: null, error: null },
      model: { configured: 'heuristic', active: 'heuristic', degraded: false, reason: null },
      counts: { rawChunks: 0, traces: 0, cachedRecords: 0, outbox: 0, deadLetter: 0 },
      outbox: { items: 0, bytes: 0, oldestAt: null },
      limits: {
        maxChunkBytes: this.config.limits.maxChunkBytes,
        maxContextTokens: this.config.limits.maxContextTokens,
        maxRecall: this.config.limits.maxRecall,
      },
      warnings: [],
    };
    let snapshot = fallback;
    if (this.getStatus) {
      const provided = await this.getStatus();
      if (isObject(provided)) snapshot = provided as SidecarStatusSnapshot;
    }
    return {
      ...snapshot,
      state: this.state,
      degraded: this.degraded,
      pid: process.pid,
      uptimeMs: Math.max(0, this.now() - this.startedAt),
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = requestIdOf(req);
    res.setHeader('x-request-id', requestId);
    try {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        this.sendError(res, 403, requestId, 'loopback_required', '仅允许本机回环调用');
        return;
      }
      const localPort = req.socket.localPort;
      if (!isLoopbackHostHeader(req.headers.host, localPort)) {
        this.sendError(res, 403, requestId, 'loopback_required', 'Host 头必须是本机回环地址');
        return;
      }
      if (!isLoopbackOrigin(req.headers.origin, localPort)) {
        this.sendError(res, 403, requestId, 'forbidden_origin', 'Origin 必须是本机回环地址');
        return;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';
      const isGet = method === 'GET' || method === 'HEAD';

      if (pathname === `${SIDECAR_API_PREFIX}/health`) {
        if (!isGet) {
          this.sendError(res, 405, requestId, 'method_not_allowed', 'health 仅接受 GET');
          return;
        }
        this.send(res, 200, {
          ok: true,
          requestId,
          apiVersion: this.apiVersion,
          state: this.state,
          ready: this.state === 'ready' && !this.stopping,
          degraded: this.degraded,
          pid: process.pid,
          runtimeVersion: this.runtimeVersion,
          capabilityApiVersion: this.capabilityApiVersion,
          uptimeMs: Math.max(0, this.now() - this.startedAt),
          cloudId: this.identity.cloudId,
          profileId: this.identity.profileId,
        });
        return;
      }

      if (!pathname.startsWith(`${SIDECAR_API_PREFIX}/`) && pathname !== SIDECAR_API_PREFIX) {
        req.resume();
        this.sendError(res, 404, requestId, 'not_found', '未知路径');
        return;
      }

      const authorization = this.authorize(req);
      if (!authorization.ok) {
        req.resume();
        this.sendError(res, 401, requestId, authorization.code, '缺少或无效的 host token');
        return;
      }

      const relative = pathname.slice(SIDECAR_API_PREFIX.length).replace(/^\/+/, '');
      if (relative === 'version') {
        if (!isGet) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'version 仅接受 GET');
          return;
        }
        this.send(res, 200, this.envelope(requestId, {
          runtimeVersion: this.runtimeVersion,
          apiVersion: this.apiVersion,
          capabilityApiVersion: this.capabilityApiVersion,
          minMcpVersion: this.minMcpVersion,
          maxMcpVersion: this.maxMcpVersion,
          state: this.state,
          degraded: this.degraded,
          pid: process.pid,
          startedAt: this.startedAt,
        }, [], this.degraded));
        return;
      }

      if (relative === 'status') {
        if (!isGet) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'status 仅接受 GET');
          return;
        }
        const status = await this.statusPayload();
        this.send(res, 200, this.envelope(
          requestId,
          status,
          Array.isArray(status.warnings) ? status.warnings : [],
          status.degraded,
        ));
        return;
      }

      const head = relative.split('/')[0] ?? '';
      if (UNIMPLEMENTED_ROUTES.has(head)) {
        req.resume();
        this.sendError(
          res,
          501,
          requestId,
          'not_implemented',
          '该端点属于 W4 记忆业务，W3a sidecar 骨架未实现',
          { endpoint: head, plannedIn: 'W4' },
        );
        return;
      }

      req.resume();
      this.sendError(res, 404, requestId, 'not_found', '未知路径');
    } catch {
      if (!res.headersSent) {
        this.sendError(res, 500, requestId, 'internal', 'sidecar 内部错误');
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
  }
}
