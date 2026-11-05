// OpenChamber public runner adapter (0.3.2 WS-B).
//
// This adapter talks to the loopback runner exposed by
// `@mebular/opencode-plugin/fleet-runner` (discovery file
// `$MEBULAR_HOME/openchamber-runner.json`). It does NOT read the private
// oc-hermes-bridge daemon, does NOT resume an existing session, and never
// accepts a `sessionId` from the task or the caller.
//
// Public execution semantics (concurrency/timeout/truncation/normalization)
// stay in `BaseExecutor`; this file only translates Fleet tasks to one
// `POST /v1/run-once` request and maps stable errors back.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  BaseExecutor,
  type ExecutorAdapter,
  type ExecutorDescriptor,
  type ExecutorHealth,
  type ExecutorRequest,
  type ExecutorResult,
} from './executor.js';

export const OPENCHAMBER_RUNNER_SCHEMA = 1;
export const OPENCHAMBER_RUNNER_KIND = 'mebular-openchamber-runner';
export const OPENCHAMBER_RUNNER_DISCOVERY_FILE = 'openchamber-runner.json';
export const OPENCHAMBER_RUNNER_STALE_MS = 15_000;
export const OPENCHAMBER_RUNNER_MAX_TIMEOUT_MS = 600_000;

export type OpenChamberRunnerErrorCode =
  | 'AUTH_FAILED'
  | 'ADAPTER_UNAVAILABLE'
  | 'PROTOCOL_ERROR'
  | 'TIMEOUT';

export interface OpenChamberRunnerDiscovery {
  schema: number;
  kind: string;
  pid: number;
  port: number;
  host?: string;
  token: string;
  version: string;
  startedAt: number;
  updatedAt: number;
}

export type OpenChamberRunnerDiscoveryReason =
  | 'discovery_not_found'
  | 'discovery_invalid'
  | 'discovery_stale'
  | 'discovery_pid_dead';

export interface OpenChamberRunnerDiscoveryResult {
  value: OpenChamberRunnerDiscovery | null;
  reason: OpenChamberRunnerDiscoveryReason | null;
}

export interface OpenChamberRunnerRunInput {
  prompt: string;
  taskId?: string;
  title?: string;
  timeoutMs?: number;
  agent?: string;
  model?: string;
  /** BaseExecutor's timeout signal; the client destroys the socket on abort. */
  signal?: AbortSignal;
}

export interface OpenChamberRunnerRunResult {
  text: string;
  sessionId?: string;
  ms?: number;
  error?: OpenChamberRunnerErrorCode;
  /** Non-sensitive diagnostic (never contains the token or prompt). */
  detail?: string;
}

/** Seam used by tests and by callers that want to inject their own transport. */
export interface OpenChamberRunnerSeam {
  runOnce(input: OpenChamberRunnerRunInput): Promise<OpenChamberRunnerRunResult>;
  health?(): Promise<ExecutorHealth>;
}

export interface OpenChamberRunnerClientOptions {
  /** Explicit discovery file; default `<home>/openchamber-runner.json`. */
  discoveryFile?: string;
  /** Explicit Mebular home; default `$MEBULAR_HOME` or `~/.mebular`. */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  staleMs?: number;
  /** Default agent/model for run-once requests. */
  agent?: string;
  model?: string;
  requestTimeoutMs?: number;
  /** Injectable liveness check (tests). */
  isProcessAlive?: (pid: number) => boolean;
}

export interface OpenChamberRunnerAgentOptions extends OpenChamberRunnerClientOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  concurrency?: number;
}

export function isRunnerProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Resolve `$MEBULAR_HOME` (default `~/.mebular`) without touching Fleet/private config. */
export function resolveOpenChamberRunnerHome(options: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  if (options.homeDir !== undefined && options.homeDir.trim().length > 0) {
    return resolve(options.homeDir);
  }
  const env = options.env ?? process.env;
  const envHome = env.MEBULAR_HOME?.trim();
  if (envHome !== undefined && envHome.length > 0) return resolve(envHome);
  return join(homedir(), '.mebular');
}

export function resolveOpenChamberRunnerDiscoveryFile(options: {
  discoveryFile?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  if (options.discoveryFile !== undefined && options.discoveryFile.trim().length > 0) {
    return resolve(options.discoveryFile);
  }
  return join(resolveOpenChamberRunnerHome(options), OPENCHAMBER_RUNNER_DISCOVERY_FILE);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Read and validate the runner discovery file.
 *
 * A valid file must be schema 1, kind `mebular-openchamber-runner`, have a
 * live PID, a fresh `updatedAt` (default 15s), a valid loopback port and a
 * non-empty token. The token is only returned to the caller; it is never
 * included in errors or health details.
 */
export function readOpenChamberRunnerDiscovery(
  path: string,
  options: {
    now?: () => number;
    staleMs?: number;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): OpenChamberRunnerDiscoveryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { value: null, reason: code === 'ENOENT' ? 'discovery_not_found' : 'discovery_invalid' };
  }
  if (
    !isObject(parsed)
    || parsed.schema !== OPENCHAMBER_RUNNER_SCHEMA
    || parsed.kind !== OPENCHAMBER_RUNNER_KIND
    || typeof parsed.pid !== 'number'
    || !Number.isInteger(parsed.pid)
    || parsed.pid <= 0
    || typeof parsed.port !== 'number'
    || !Number.isInteger(parsed.port)
    || parsed.port <= 0
    || parsed.port > 65_535
    || typeof parsed.token !== 'string'
    || parsed.token.length === 0
    || typeof parsed.updatedAt !== 'number'
    || !Number.isFinite(parsed.updatedAt)
    || parsed.updatedAt <= 0
  ) {
    return { value: null, reason: 'discovery_invalid' };
  }
  const host = parsed.host === undefined ? '127.0.0.1' : parsed.host;
  if (typeof host !== 'string' || !isLoopbackHost(host)) {
    return { value: null, reason: 'discovery_invalid' };
  }
  const now = options.now ? options.now() : Date.now();
  const staleMs = Math.max(1, Math.trunc(options.staleMs ?? OPENCHAMBER_RUNNER_STALE_MS));
  if (now - parsed.updatedAt > staleMs) {
    return { value: null, reason: 'discovery_stale' };
  }
  const alive = options.isProcessAlive ?? isRunnerProcessAlive;
  if (!alive(parsed.pid)) {
    return { value: null, reason: 'discovery_pid_dead' };
  }
  return {
    value: {
      schema: OPENCHAMBER_RUNNER_SCHEMA,
      kind: OPENCHAMBER_RUNNER_KIND,
      pid: parsed.pid,
      port: parsed.port,
      host,
      token: parsed.token,
      version: typeof parsed.version === 'string' ? parsed.version : '',
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      updatedAt: parsed.updatedAt,
    },
    reason: null,
  };
}

interface HttpResult {
  status: number | null;
  body: string;
  error?: OpenChamberRunnerErrorCode;
}

function requestHttp(options: {
  host: string;
  port: number;
  path: string;
  method: string;
  body?: string;
  token?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<HttpResult> {
  return new Promise((resolveRequest) => {
    let settled = false;
    const finish = (result: HttpResult) => {
      if (settled) return;
      settled = true;
      resolveRequest(result);
    };
    const headers: Record<string, string | number> = {};
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(options.body);
    }
    const req = http.request(
      {
        host: options.host,
        port: options.port,
        path: options.path,
        method: options.method,
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          // Bound response memory; the runner result is capped upstream.
          if (size <= 4 * 1024 * 1024) chunks.push(chunk);
        });
        res.on('end', () => {
          if (size > 4 * 1024 * 1024) {
            finish({ status: res.statusCode ?? null, body: '', error: 'PROTOCOL_ERROR' });
            return;
          }
          finish({ status: res.statusCode ?? null, body: Buffer.concat(chunks).toString('utf-8') });
        });
        res.on('error', () => finish({ status: null, body: '', error: 'PROTOCOL_ERROR' }));
      },
    );
    req.on('error', () => finish({ status: null, body: '', error: 'ADAPTER_UNAVAILABLE' }));
    req.setTimeout(Math.max(1, options.timeoutMs), () => {
      req.destroy();
      finish({ status: null, body: '', error: 'TIMEOUT' });
    });
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        req.destroy();
        finish({ status: null, body: '', error: 'TIMEOUT' });
        return;
      }
      options.signal.addEventListener(
        'abort',
        () => {
          req.destroy();
          finish({ status: null, body: '', error: 'TIMEOUT' });
        },
        { once: true },
      );
    }
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function errorForStatus(status: number | null, parsed: Record<string, unknown>): OpenChamberRunnerErrorCode {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 408 || status === 504) return 'TIMEOUT';
  const code = typeof parsed.error === 'string' ? parsed.error.toUpperCase() : '';
  if (code === 'TIMEOUT') return 'TIMEOUT';
  if (code === 'AUTH_FAILED' || code === 'UNAUTHORIZED') return 'AUTH_FAILED';
  if (code === 'ADAPTER_UNAVAILABLE') return 'ADAPTER_UNAVAILABLE';
  if (status === 503) return 'ADAPTER_UNAVAILABLE';
  return 'PROTOCOL_ERROR';
}

/**
 * Loopback HTTP client for the public OpenChamber runner. Discovery is read on
 * every call so a restarted plugin is picked up without a Fleet restart.
 */
export class OpenChamberRunnerClient implements OpenChamberRunnerSeam {
  private readonly options: OpenChamberRunnerClientOptions;

  constructor(options: OpenChamberRunnerClientOptions = {}) {
    this.options = options;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private discoveryFile(): string {
    return resolveOpenChamberRunnerDiscoveryFile(this.options);
  }

  private timeoutMs(input?: number): number {
    const requested = input ?? this.options.requestTimeoutMs ?? OPENCHAMBER_RUNNER_MAX_TIMEOUT_MS;
    return Math.max(1, Math.min(Math.trunc(requested), OPENCHAMBER_RUNNER_MAX_TIMEOUT_MS));
  }

  private readDiscovery(): OpenChamberRunnerDiscoveryResult {
    return readOpenChamberRunnerDiscovery(this.discoveryFile(), {
      now: this.options.now,
      ...(this.options.staleMs !== undefined ? { staleMs: this.options.staleMs } : {}),
      ...(this.options.isProcessAlive !== undefined
        ? { isProcessAlive: this.options.isProcessAlive }
        : {}),
    });
  }

  async runOnce(input: OpenChamberRunnerRunInput): Promise<OpenChamberRunnerRunResult> {
    const discovery = this.readDiscovery();
    if (discovery.value === null) {
      return {
        text: '',
        error: 'ADAPTER_UNAVAILABLE',
        detail: discovery.reason ?? 'discovery_invalid',
      };
    }
    const timeoutMs = this.timeoutMs(input.timeoutMs);
    const title = input.title ?? (input.taskId !== undefined ? `fleet ${input.taskId}` : 'fleet run');
    const payload: Record<string, unknown> = {
      prompt: input.prompt,
      timeoutSec: Math.max(1, Math.ceil(timeoutMs / 1000)),
      title,
    };
    const agent = input.agent ?? this.options.agent;
    if (agent !== undefined) payload.agent = agent;
    const model = input.model ?? this.options.model;
    if (model !== undefined) payload.model = model;
    // Deliberately no sessionId: every Fleet task runs in a new session.

    const response = await requestHttp({
      host: discovery.value.host ?? '127.0.0.1',
      port: discovery.value.port,
      path: '/v1/run-once',
      method: 'POST',
      body: JSON.stringify(payload),
      token: discovery.value.token,
      timeoutMs,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (response.error !== undefined) {
      return { text: '', error: response.error };
    }
    // Status-only failures must stay stable even when the body is not JSON.
    if (response.status === 401 || response.status === 403) {
      return { text: '', error: 'AUTH_FAILED' };
    }
    if (response.status === 408 || response.status === 504) {
      return { text: '', error: 'TIMEOUT' };
    }
    if (response.status === 503) {
      return { text: '', error: 'ADAPTER_UNAVAILABLE' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return { text: '', error: 'PROTOCOL_ERROR', detail: 'runner returned non-JSON' };
    }
    if (!isObject(parsed)) {
      return { text: '', error: 'PROTOCOL_ERROR', detail: 'runner returned invalid JSON' };
    }
    if (parsed.ok !== true) {
      return { text: '', error: errorForStatus(response.status, parsed) };
    }
    const result = parsed.result;
    if (!isObject(result) || typeof result.text !== 'string') {
      return { text: '', error: 'PROTOCOL_ERROR', detail: 'runner result has no text' };
    }
    const sessionId = typeof result.sessionId === 'string' && result.sessionId.length > 0
      ? result.sessionId
      : undefined;
    const ms = typeof result.ms === 'number' && Number.isFinite(result.ms) ? result.ms : undefined;
    return {
      text: result.text,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(ms !== undefined ? { ms } : {}),
    };
  }

  async health(): Promise<ExecutorHealth> {
    const checkedAt = this.now();
    const discovery = this.readDiscovery();
    if (discovery.value === null) {
      return {
        status: 'unavailable',
        checkedAt,
        detail: discovery.reason ?? 'discovery_invalid',
      };
    }
    const startedAt = Date.now();
    const response = await requestHttp({
      host: discovery.value.host ?? '127.0.0.1',
      port: discovery.value.port,
      path: '/health',
      method: 'GET',
      timeoutMs: 2_000,
    });
    const latencyMs = Date.now() - startedAt;
    if (response.error !== undefined || response.status !== 200) {
      return {
        status: 'unavailable',
        checkedAt,
        latencyMs,
        detail: response.error ?? `runner health status ${response.status ?? '?'}`,
      };
    }
    try {
      const parsed = JSON.parse(response.body) as unknown;
      if (!isObject(parsed) || parsed.ok !== true) {
        return { status: 'unavailable', checkedAt, latencyMs, detail: 'runner health invalid' };
      }
    } catch {
      return { status: 'unavailable', checkedAt, latencyMs, detail: 'runner health non-JSON' };
    }
    return { status: 'ok', checkedAt, latencyMs };
  }
}

/** Adapter: maps one Fleet task to one public-runner request. */
export class OpenChamberRunnerAdapter implements ExecutorAdapter {
  readonly descriptor: ExecutorDescriptor = {
    kind: 'openchamber',
    executionMode: 'http',
    supportsCancel: true,
    sessionMode: 'fresh',
  };

  constructor(
    private readonly seam: OpenChamberRunnerSeam,
    private readonly options: {
      agent?: string;
      model?: string;
      timeoutMs?: number;
    } = {},
  ) {}

  async invoke(request: ExecutorRequest, signal: AbortSignal): Promise<ExecutorResult> {
    const timeoutMs = this.options.timeoutMs ?? request.timeoutMs;
    const result = await this.seam.runOnce({
      prompt: request.prompt,
      taskId: request.task.taskId,
      title: `fleet ${request.task.taskId}`,
      timeoutMs,
      ...(this.options.agent !== undefined ? { agent: this.options.agent } : {}),
      ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      signal,
    });
    if (result.error !== undefined) {
      return { ok: false, reason: result.error };
    }
    return {
      ok: true,
      resultRef: result.text,
      ...(result.sessionId !== undefined ? { reason: `session:${result.sessionId}` } : {}),
    };
  }

  async health(): Promise<ExecutorHealth> {
    if (this.seam.health === undefined) {
      return { status: 'degraded', checkedAt: Date.now(), detail: 'runner seam has no health probe' };
    }
    return this.seam.health();
  }
}

/**
 * Fleet executor for the public OpenChamber runner.
 *
 * `new OpenChamberRunnerAgent()` uses the default discovery path; a custom
 * seam or client options may be injected for tests.
 */
export class OpenChamberRunnerAgent extends BaseExecutor {
  constructor(
    seamOrOptions: OpenChamberRunnerSeam | OpenChamberRunnerAgentOptions = {},
    maybeOptions: OpenChamberRunnerAgentOptions = {},
  ) {
    const hasSeam = typeof (seamOrOptions as OpenChamberRunnerSeam).runOnce === 'function';
    const options = hasSeam ? maybeOptions : (seamOrOptions as OpenChamberRunnerAgentOptions);
    const seam = hasSeam
      ? (seamOrOptions as OpenChamberRunnerSeam)
      : new OpenChamberRunnerClient(options);
    const configuredTimeout = Math.max(1, Math.trunc(options.timeoutMs ?? OPENCHAMBER_RUNNER_MAX_TIMEOUT_MS));
    super(new OpenChamberRunnerAdapter(seam, {
      ...(options.agent !== undefined ? { agent: options.agent } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      timeoutMs: configuredTimeout,
    }), {
      // Give the client a chance to return the stable TIMEOUT code itself;
      // BaseExecutor remains the final bounded backstop.
      timeoutMs: Math.min(configuredTimeout + 1_000, OPENCHAMBER_RUNNER_MAX_TIMEOUT_MS + 1_000),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      concurrency: options.concurrency ?? Number.POSITIVE_INFINITY,
    });
  }
}
