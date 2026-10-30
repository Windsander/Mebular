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
import type {
  IngestExtractionResult,
  IngestExtractionView,
  IngestHttpResult,
} from './ingest.js';
import type { SidecarObjectsApi } from './internal-objects.js';
import { SidecarSettlementError } from './errors.js';
import type { NamespacesView } from './settlement.js';

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const UNIMPLEMENTED_ROUTES = new Set([
  'mode',
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
  /** 可选的模型告警；不包含密钥、prompt 或响应体。 */
  warnings?: string[];
  /** 只报告 credential 是否存在与来源，不报告 keyRef 或密钥。 */
  credential?: {
    configured: boolean;
    source: 'env' | 'file' | 'keychain' | null;
  };
  /** 本设备当前可用的模型来源。 */
  sources?: string[];
}

export interface SidecarStatusCounts {
  /** 本地 staging chunk 数（未沉降，非权威）。 */
  stagingChunks: number;
  localStagingChunks: number;
  traces: number;
  cachedRecords: number;
  /** 详情只读缓存条目数。 */
  detailCacheEntries: number;
  /** 详情只读缓存字节数。 */
  detailCacheBytes: number;
  outbox: number;
  deadLetter: number;
  /** 本地 Trace 数量。 */
  localTraces: number;
  /** 已接受的 ingest 请求数（不含幂等重放）。 */
  ingested: number;
  /** 已成功沉降到 capability 的记录数（含重复确认）。 */
  settled: number;
  /** 召回请求数（/recall）。 */
  recalls?: number;
  /** 上下文组装请求数（/context）。 */
  contexts?: number;
  /** 召回反馈数。 */
  feedback?: number;
  /** 沉默的召回/上下文次数。 */
  recallSilent?: number;
  /** 已确认写入/复用的 Compact 数。 */
  compacts?: number;
  /** 已确认写入的 ContextCheckpoint 数。 */
  checkpoints?: number;
  /** 已确认写入的 SelfRecord 数。 */
  selfRecords?: number;
  /** 进入 outbox 的对象写请求数。 */
  objectWritesQueued?: number;
  /** 永久失败的对象写请求数。 */
  objectWritesFailed?: number;
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

/** 详情能力/配额/保留诊断；不包含正文与 token。 */
export interface SidecarStatusDetails {
  /** capability `/detail` 是否可用（sidecar 已装配）。 */
  available: boolean;
  staging: {
    chunks: number;
    hours: number;
    maxBytes: number;
  };
  cache: {
    entries: number;
    bytes: number;
    days: number;
    maxBytes: number;
  };
  outbox: {
    items: number;
    bytes: number;
  };
  quota: {
    bytesPerDomain: number;
    bytesCloud: number;
    /** capability 报告的当前详情字节数（若可用）。 */
    usedBytes: number | null;
    /** capability 报告的配额（若可用）。 */
    bytes: number | null;
  };
  retentionDays: {
    conversation: number;
    tool_output: number;
    document_slice: number;
  };
}

export interface SidecarStatusError {
  code: string;
  message: string;
  at: number;
}

export interface SidecarStatusSnapshot {
  mode: 'immersive';
  identity: SidecarStatusIdentity;
  capability: SidecarStatusCapability;
  model: SidecarStatusModel;
  counts: SidecarStatusCounts;
  details: SidecarStatusDetails;
  outbox: SidecarStatusOutbox;
  limits: SidecarStatusLimits;
  warnings: string[];
  /** 最近的沉降错误；不包含正文/token。 */
  lastError: SidecarStatusError | null;
}

export interface SidecarStatus extends SidecarStatusSnapshot {
  state: SidecarState;
  degraded: boolean;
  pid: number;
  uptimeMs: number;
}

export interface SidecarIngestApi {
  handleIngest(request: unknown, options: { idempotencyKey?: string | null }): Promise<IngestHttpResult>;
  getExtraction(id: string): Promise<IngestExtractionView | null>;
  completeExtraction(id: string, candidates: unknown): Promise<IngestExtractionResult>;
}

export interface SidecarNamespacesApi {
  getNamespaces(agentId: string | null): Promise<NamespacesView>;
}

/** 召回/上下文/trace 的 host API；由 RecallService 实现。 */
export interface SidecarRecallApi {
  handleRecall(request: unknown): Promise<{
    status: 200;
    data: unknown;
    warnings: string[];
    degraded: boolean;
  }>;
  handleContext(request: unknown): Promise<{
    status: 200;
    data: unknown;
    warnings: string[];
    degraded: boolean;
  }>;
  getTraces(query: {
    limit?: number | string | null;
    agentId?: string | null;
    threadId?: string | null;
  }): Promise<{
    traces: unknown[];
    total: number;
    warnings: string[];
    degraded: boolean;
  }>;
  getTrace(id: string): Promise<unknown | null>;
  expandRecall(recallId: string, request: unknown): Promise<{
    status: 200;
    data: unknown;
    warnings: string[];
    degraded: boolean;
  }>;
  getDetail(id: string): Promise<{
    status: 200;
    data: unknown;
    warnings: string[];
    degraded: boolean;
  }>;
  submitFeedback(traceId: string, body: unknown): Promise<{
    traceId: string;
    feedback: { useful: boolean; reason?: string; at: number };
    quarantined: string[];
    warnings: string[];
    degraded: boolean;
  }>;
}

export interface SidecarServerOptions {
  config: SidecarConfig;
  hostToken: string;
  identity?: Partial<SidecarStatusIdentity>;
  getStatus?: () => SidecarStatusSnapshot | Promise<SidecarStatusSnapshot>;
  /** `/version` 的模型状态；缺省从 getStatus().model 读取。 */
  getModelStatus?: () => SidecarStatusModel | Promise<SidecarStatusModel>;
  ingest?: SidecarIngestApi;
  namespaces?: SidecarNamespacesApi;
  recall?: SidecarRecallApi;
  objects?: SidecarObjectsApi;
  /** 动态降级标记（沉降/outbox）；与显式 degraded 取或。 */
  getDegraded?: () => boolean;
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

/**
 * 读取 JSON 请求体；超过 2 MiB 返回 413，不无限缓冲。
 * 超限后继续排空请求，避免客户端收到连接重置而不是错误信封。
 */
async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) chunks.push(buffer);
  }
  if (tooLarge) {
    throw new SidecarSettlementError('payload_too_large', '请求体超过 2 MiB', { status: 413 });
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) {
    throw new SidecarSettlementError('invalid_request', '请求体必须是 JSON 对象', { status: 400 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new SidecarSettlementError('invalid_request', '请求体不是合法 JSON', { status: 400 });
  }
  if (!isObject(parsed)) {
    throw new SidecarSettlementError('invalid_request', '请求体必须是 JSON 对象', { status: 400 });
  }
  return parsed;
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
  private readonly getModelStatus?: () => SidecarStatusModel | Promise<SidecarStatusModel>;
  private readonly ingest?: SidecarIngestApi;
  private readonly namespaces?: SidecarNamespacesApi;
  private readonly recall?: SidecarRecallApi;
  private readonly objects?: SidecarObjectsApi;
  private readonly getDegraded?: () => boolean;
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
    this.getModelStatus = options.getModelStatus;
    this.ingest = options.ingest;
    this.namespaces = options.namespaces;
    this.recall = options.recall;
    this.objects = options.objects;
    this.getDegraded = options.getDegraded;
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

  /** 当前降级状态：显式标记或沉降/outbox 动态状态。 */
  currentDegraded(): boolean {
    return this.degraded || this.getDegraded?.() === true;
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
    res.setHeader('x-mebular-degraded', String(this.currentDegraded()));
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

  private async modelPayload(): Promise<SidecarStatusModel> {
    let model: SidecarStatusModel | null = null;
    if (this.getModelStatus) {
      const provided = await this.getModelStatus();
      if (isObject(provided)) model = provided as SidecarStatusModel;
    } else if (this.getStatus) {
      const snapshot = await this.getStatus();
      if (isObject(snapshot?.model)) model = snapshot.model as SidecarStatusModel;
    }
    const configured = typeof model?.configured === 'string' ? model.configured : 'heuristic';
    const active = typeof model?.active === 'string' ? model.active : 'heuristic';
    const credential = isObject(model?.credential)
      ? {
        configured: model.credential.configured === true,
        source: model.credential.source === 'env' || model.credential.source === 'file'
          || model.credential.source === 'keychain'
          ? model.credential.source
          : null,
      }
      : { configured: false, source: null as 'env' | 'file' | 'keychain' | null };
    return {
      configured,
      active,
      degraded: model?.degraded === true,
      reason: typeof model?.reason === 'string' ? model.reason : null,
      warnings: Array.isArray(model?.warnings)
        ? model.warnings.filter((warning): warning is string => typeof warning === 'string')
        : [],
      credential,
      sources: Array.isArray(model?.sources)
        ? model.sources.filter((source): source is string => typeof source === 'string')
        : ['heuristic', 'host'],
    };
  }

  private async statusPayload(): Promise<SidecarStatus> {
    const fallback: SidecarStatusSnapshot = {
      mode: 'immersive',
      identity: { ...this.identity },
      capability: { reachable: false, version: null, lastOkAt: null, error: null },
      model: {
        configured: 'heuristic',
        active: 'heuristic',
        degraded: false,
        reason: null,
        warnings: [],
        credential: { configured: false, source: null },
        sources: ['heuristic', 'host'],
      },
      counts: {
        stagingChunks: 0,
        localStagingChunks: 0,
        traces: 0,
        cachedRecords: 0,
        detailCacheEntries: 0,
        detailCacheBytes: 0,
        outbox: 0,
        deadLetter: 0,
        localTraces: 0,
        ingested: 0,
        settled: 0,
        recalls: 0,
        contexts: 0,
        feedback: 0,
        recallSilent: 0,
        compacts: 0,
        checkpoints: 0,
        selfRecords: 0,
        objectWritesQueued: 0,
        objectWritesFailed: 0,
      },
      details: {
        available: Boolean(this.recall),
        staging: {
          chunks: 0,
          hours: this.config.detail.stagingHours,
          maxBytes: this.config.detail.stagingBytes,
        },
        cache: {
          entries: 0,
          bytes: 0,
          days: this.config.detail.cacheDays,
          maxBytes: this.config.detail.cacheBytes,
        },
        outbox: { items: 0, bytes: 0 },
        quota: {
          bytesPerDomain: this.config.detail.quotaBytesPerDomain,
          bytesCloud: this.config.detail.quotaBytesCloud,
          usedBytes: null,
          bytes: null,
        },
        retentionDays: { conversation: 30, tool_output: 7, document_slice: 90 },
      },
      outbox: { items: 0, bytes: 0, oldestAt: null },
      limits: {
        maxChunkBytes: this.config.limits.maxChunkBytes,
        maxContextTokens: this.config.limits.maxContextTokens,
        maxRecall: this.config.limits.maxRecall,
      },
      warnings: [],
      lastError: null,
    };
    let snapshot = fallback;
    if (this.getStatus) {
      const provided = await this.getStatus();
      if (isObject(provided)) snapshot = provided as SidecarStatusSnapshot;
    }
    return {
      ...snapshot,
      model: { ...fallback.model, ...(snapshot.model ?? {}) },
      counts: { ...fallback.counts, ...(snapshot.counts ?? {}) },
      details: { ...fallback.details, ...(snapshot.details ?? {}) },
      state: this.state,
      degraded: this.currentDegraded(),
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
      const isPost = method === 'POST';
      const isPut = method === 'PUT';

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
          degraded: this.currentDegraded(),
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
        const model = await this.modelPayload();
        this.send(res, 200, this.envelope(requestId, {
          runtimeVersion: this.runtimeVersion,
          apiVersion: this.apiVersion,
          capabilityApiVersion: this.capabilityApiVersion,
          minMcpVersion: this.minMcpVersion,
          maxMcpVersion: this.maxMcpVersion,
          state: this.state,
          mode: 'immersive',
          degraded: this.currentDegraded(),
          pid: process.pid,
          startedAt: this.startedAt,
          model,
          capabilities: {
            ingest: Boolean(this.ingest),
            recall: Boolean(this.recall),
            context: Boolean(this.recall),
            feedback: Boolean(this.recall),
            traces: Boolean(this.recall),
            details: Boolean(this.recall),
            checkpoint: Boolean(this.objects),
            compact: Boolean(this.objects),
            self: Boolean(this.objects),
            models: model.sources ?? ['heuristic', 'host'],
          },
          details: {
            stagingHours: this.config.detail.stagingHours,
            cacheDays: this.config.detail.cacheDays,
            quotaBytesPerDomain: this.config.detail.quotaBytesPerDomain,
            quotaBytesCloud: this.config.detail.quotaBytesCloud,
            retentionDays: { conversation: 30, tool_output: 7, document_slice: 90 },
          },
        }, [], this.currentDegraded()));
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

      if (relative === 'ingest') {
        if (!isPost) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'ingest 仅接受 POST');
          return;
        }
        if (this.state === 'stopping') {
          req.resume();
          this.sendError(res, 503, requestId, 'stopping', 'sidecar 正在停止', undefined, true);
          return;
        }
        if (!this.ingest) {
          req.resume();
          this.sendError(res, 501, requestId, 'not_implemented', 'ingest 尚未启用');
          return;
        }
        const body = await readJsonBody(req);
        const header = req.headers['idempotency-key'];
        const idempotencyKey = typeof header === 'string'
          ? header
          : Array.isArray(header) ? header[0] ?? null : null;
        const result = await this.ingest.handleIngest(body, { idempotencyKey });
        this.send(res, result.status, this.envelope(requestId, result.data, result.warnings, result.degraded));
        return;
      }

      if (relative.startsWith('extractions/')) {
        const id = relative.slice('extractions/'.length);
        if (id.length === 0 || id.includes('/')) {
          req.resume();
          this.sendError(res, 404, requestId, 'not_found', '未知抽取任务');
          return;
        }
        if (!this.ingest) {
          req.resume();
          this.sendError(res, 501, requestId, 'not_implemented', 'extractions 尚未启用');
          return;
        }
        if (isGet) {
          const extraction = await this.ingest.getExtraction(id);
          if (!extraction) {
            this.sendError(res, 404, requestId, 'not_found', '抽取任务不存在或已过期');
            return;
          }
          this.send(res, 200, this.envelope(requestId, extraction, extraction.warnings, extraction.degraded));
          return;
        }
        if (!isPost) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'extractions 仅接受 GET/POST');
          return;
        }
        if (this.state === 'stopping') {
          req.resume();
          this.sendError(res, 503, requestId, 'stopping', 'sidecar 正在停止', undefined, true);
          return;
        }
        const body = await readJsonBody(req);
        const candidates = isObject(body) ? body.candidates : undefined;
        if (!Array.isArray(candidates)) {
          this.sendError(res, 400, requestId, 'invalid_request', 'candidates 必须是数组');
          return;
        }
        const result = await this.ingest.completeExtraction(id, candidates);
        this.send(
          res,
          result.queued ? 202 : 200,
          this.envelope(requestId, result, result.warnings, result.degraded),
        );
        return;
      }

      if (relative === 'compact') {
        if (!isPost) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'compact 仅接受 POST');
          return;
        }
        if (!this.objects) {
          req.resume();
          this.sendError(res, 501, requestId, 'not_implemented', 'compact 尚未启用');
          return;
        }
        if (this.state === 'stopping') {
          req.resume();
          this.sendError(res, 503, requestId, 'stopping', 'sidecar 正在停止', undefined, true);
          return;
        }
        const body = await readJsonBody(req);
        const result = await this.objects.handleCompact(body);
        this.send(res, result.status, this.envelope(requestId, result.data, result.warnings, result.degraded));
        return;
      }

      if (relative.startsWith('compacts/')) {
        if (!isGet) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'compacts 仅接受 GET');
          return;
        }
        if (!this.objects) {
          req.resume();
          this.sendError(res, 501, requestId, 'not_implemented', 'compacts 尚未启用');
          return;
        }
        const id = relative.slice('compacts/'.length);
        if (id.length === 0 || id.includes('/')) {
          req.resume();
          this.sendError(res, 404, requestId, 'not_found', 'compact 不存在');
          return;
        }
        const result = await this.objects.getCompact(id);
        this.send(res, result.status, this.envelope(requestId, result.data, result.warnings, result.degraded));
        return;
      }

      if (relative.startsWith('checkpoints/')) {
        if (!this.objects) {
          req.resume();
          this.sendError(res, 501, requestId, 'not_implemented', 'checkpoints 尚未启用');
          return;
        }
        const threadId = relative.slice('checkpoints/'.length);
        if (threadId.length === 0 || threadId.includes('/')) {
          req.resume();
          this.sendError(res, 404, requestId, 'not_found', 'checkpoint 不存在');
          return;
        }
        const agentId = url.searchParams.get('agentId') ?? url.searchParams.get('agent');
        const sync = url.searchParams.get('sync');
        if (isGet) {
          const result = await this.objects.getCheckpoint(threadId, { agentId, sync });
          this.send(res, result.status, this.envelope(requestId, result.data, result.warnings, result.degraded));
          return;
        }
        if (method === 'DELETE') {
          if (this.state === 'stopping') {
            req.resume();
            this.sendError(res, 503, requestId, 'stopping', 'sidecar 正在停止', undefined, true);
            return;
          }
          const result = await this.objects.deleteCheckpoint(threadId, { agentId, sync });
          this.send(res, result.status, this.envelope(requestId, result.data, result.warnings, result.degraded));
          return;
        }
        if (!isPut) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'checkpoints 仅接受 GET/PUT/DELETE');
          return;
        }
        if (this.state === 'stopping') {
          req.resume();
          this.sendError(res, 503, requestId, 'stopping', 'sidecar 正在停止', undefined, true);
          return;
        }
        const body = await readJsonBody(req);
        if (agentId && isObject(body) && typeof body.agentId === 'string' && body.agentId !== agentId) {
          this.sendError(res, 403, requestId, 'forbidden_scope', 'Agent 不能写入其他 Agent 的 checkpoint');
          return;
        }
        const result = await this.objects.putCheckpoint(threadId, body);
        this.send(res, result.status, this.envelope(requestId, result.data, result.warnings, result.degraded));
        return;
      }

      if (relative.startsWith('self/')) {
        if (!this.objects) {
          req.resume();
          this.sendError(res, 501, requestId, 'not_implemented', 'self 尚未启用');
          return;
        }
        const agentId = relative.slice('self/'.length);
        if (agentId.length === 0 || agentId.includes('/')) {
          req.resume();
          this.sendError(res, 404, requestId, 'not_found', 'SelfRecord 不存在');
          return;
        }
        if (url.searchParams.has('sync')) {
          req.resume();
          this.sendError(res, 400, requestId, 'legacy_sync_unsupported', '不再支持 sync / checkpoint.sync / self.sync');
          return;
        }
        if (isGet) {
          const result = await this.objects.getSelf(agentId);
          this.send(res, result.status, this.envelope(requestId, result.data, result.warnings, result.degraded));
          return;
        }
        if (!isPut) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'self 仅接受 GET/PUT');
          return;
        }
        if (this.state === 'stopping') {
          req.resume();
          this.sendError(res, 503, requestId, 'stopping', 'sidecar 正在停止', undefined, true);
          return;
        }
        const body = await readJsonBody(req);
        const result = await this.objects.putSelf(agentId, body);
        this.send(res, result.status, this.envelope(requestId, result.data, result.warnings, result.degraded));
        return;
      }

      if (relative === 'namespaces') {
        if (!isGet) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'namespaces 仅接受 GET');
          return;
        }
        if (!this.namespaces) {
          req.resume();
          this.sendError(res, 501, requestId, 'not_implemented', 'namespaces 尚未启用');
          return;
        }
        const agentId = url.searchParams.get('agentId');
        const view = await this.namespaces.getNamespaces(agentId && agentId.length > 0 ? agentId : null);
        this.send(res, 200, this.envelope(requestId, view, view.warnings, view.degraded));
        return;
      }

      if (relative === 'recall') {
        if (!isPost) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'recall 仅接受 POST');
          return;
        }
        if (!this.recall) {
          req.resume();
          this.sendError(res, 501, requestId, 'not_implemented', 'recall 尚未启用');
          return;
        }
        if (this.state === 'stopping') {
          req.resume();
          this.sendError(res, 503, requestId, 'stopping', 'sidecar 正在停止', undefined, true);
          return;
        }
        const body = await readJsonBody(req);
        const result = await this.recall.handleRecall(body);
        this.send(res, result.status, this.envelope(requestId, result.data, result.warnings, result.degraded));
        return;
      }

      if (relative === 'context') {
        if (!isPost) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'context 仅接受 POST');
          return;
        }
        if (!this.recall) {
          req.resume();
          this.sendError(res, 501, requestId, 'not_implemented', 'context 尚未启用');
          return;
        }
        if (this.state === 'stopping') {
          req.resume();
          this.sendError(res, 503, requestId, 'stopping', 'sidecar 正在停止', undefined, true);
          return;
        }
        const body = await readJsonBody(req);
        const result = await this.recall.handleContext(body);
        this.send(res, result.status, this.envelope(requestId, result.data, result.warnings, result.degraded));
        return;
      }

      if (relative.startsWith('recall/')) {
        const parts = relative.split('/');
        if (parts.length !== 3 || (parts[2] !== 'feedback' && parts[2] !== 'expand')) {
          req.resume();
          this.sendError(res, 404, requestId, 'not_found', '未知召回路径');
          return;
        }
        if (!isPost) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'feedback/expand 仅接受 POST');
          return;
        }
        if (!this.recall) {
          req.resume();
          this.sendError(res, 501, requestId, 'not_implemented', 'recall 扩展尚未启用');
          return;
        }
        if (this.state === 'stopping') {
          req.resume();
          this.sendError(res, 503, requestId, 'stopping', 'sidecar 正在停止', undefined, true);
          return;
        }
        const traceId = parts[1] ?? '';
        if (traceId.length === 0) {
          req.resume();
          this.sendError(res, 404, requestId, 'not_found', 'trace 不存在');
          return;
        }
        const body = await readJsonBody(req);
        if (parts[2] === 'expand') {
          const result = await this.recall.expandRecall(traceId, body);
          this.send(res, 200, this.envelope(requestId, result.data, result.warnings, result.degraded));
          return;
        }
        const result = await this.recall.submitFeedback(traceId, body);
        this.send(res, 200, this.envelope(requestId, result, result.warnings, result.degraded));
        return;
      }

      if (relative.startsWith('details/')) {
        if (!isGet) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'details 仅接受 GET');
          return;
        }
        if (!this.recall) {
          req.resume();
          this.sendError(res, 501, requestId, 'not_implemented', 'details 尚未启用');
          return;
        }
        const id = relative.slice('details/'.length);
        if (id.length === 0 || id.includes('/')) {
          req.resume();
          this.sendError(res, 404, requestId, 'not_found', '详情不存在');
          return;
        }
        const result = await this.recall.getDetail(id);
        this.send(res, 200, this.envelope(requestId, result.data, result.warnings, result.degraded));
        return;
      }

      if (relative === 'traces') {
        if (!isGet) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'traces 仅接受 GET');
          return;
        }
        if (!this.recall) {
          req.resume();
          this.sendError(res, 501, requestId, 'not_implemented', 'traces 尚未启用');
          return;
        }
        const result = await this.recall.getTraces({
          limit: url.searchParams.get('limit'),
          agentId: url.searchParams.get('agentId'),
          threadId: url.searchParams.get('threadId'),
        });
        this.send(res, 200, this.envelope(requestId, result, result.warnings, result.degraded));
        return;
      }

      if (relative.startsWith('traces/')) {
        if (!isGet) {
          req.resume();
          this.sendError(res, 405, requestId, 'method_not_allowed', 'traces 仅接受 GET');
          return;
        }
        if (!this.recall) {
          req.resume();
          this.sendError(res, 501, requestId, 'not_implemented', 'traces 尚未启用');
          return;
        }
        const id = relative.slice('traces/'.length);
        if (id.length === 0 || id.includes('/')) {
          req.resume();
          this.sendError(res, 404, requestId, 'not_found', 'trace 不存在');
          return;
        }
        const trace = await this.recall.getTrace(id);
        if (!trace) {
          this.sendError(res, 404, requestId, 'not_found', 'trace 不存在或已过期');
          return;
        }
        this.send(res, 200, this.envelope(requestId, trace));
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
    } catch (error) {
      if (error instanceof SidecarSettlementError) {
        if (!res.headersSent) {
          this.sendError(
            res,
            error.status,
            requestId,
            error.code,
            error.message,
            error.details,
            error.retryable,
          );
        } else if (!res.writableEnded) {
          res.destroy();
        }
        return;
      }
      if (!res.headersSent) {
        this.sendError(res, 500, requestId, 'internal', 'sidecar 内部错误');
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
  }
}
