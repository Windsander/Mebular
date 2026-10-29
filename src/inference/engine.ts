// llama-server 子进程 supervisor（0.3.0）
//
// 职责：
// - 在 127.0.0.1 的随机端口启动 llama-server，生成随机 bearer token；
// - 轮询 /health，带启动超时；
// - 空闲停止、崩溃计数/熔断、stop 时 SIGTERM → SIGKILL，避免孤儿进程；
// - 不把 token 放进 EngineStatus、日志或错误消息。
//
// spawn / 端口 / 健康探测 / 时钟 / sleep 都可注入；测试不会启动真实模型。

import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import type { EngineState, EngineStatus } from './types.js';

export interface ChildProcessLike {
  pid?: number;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface SpawnLikeOptions {
  env?: NodeJS.ProcessEnv;
  stdio?: 'ignore' | 'inherit' | 'pipe';
  windowsHide?: boolean;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: SpawnLikeOptions,
) => ChildProcessLike;

export interface EngineFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type EngineFetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<EngineFetchResponse>;

export interface LlamaServerEngineOptions {
  modelPath: string;
  modelId?: string;
  binaryPath?: string;
  contextSize?: number;
  threads?: number;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  healthIntervalMs?: number;
  healthProbeTimeoutMs?: number;
  idleTimeoutMs?: number;
  stopTimeoutMs?: number;
  killTimeoutMs?: number;
  crashWindowMs?: number;
  maxCrashes?: number;
  /** 默认 true；测试可关闭，改用 checkIdle() 主动检查。 */
  autoIdleCheck?: boolean;
  spawn?: SpawnLike;
  findPort?: () => Promise<number>;
  healthCheck?: (url: string, token: string, signal?: AbortSignal) => Promise<boolean>;
  fetch?: EngineFetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  tokenFactory?: () => string;
}

export interface EngineConnection {
  baseUrl: string;
  apiKey: string;
  modelPath: string;
  modelId?: string;
  pid?: number;
  port: number;
}

export type EngineErrorCode =
  | 'circuit_open'
  | 'startup_timeout'
  | 'startup_failed'
  | 'spawn_failed'
  | 'process_exited'
  | 'invalid_port'
  | 'not_running'
  | 'stopped';

export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

function defaultFindPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const onError = (error: Error): void => {
      server.close();
      reject(error);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          reject(new Error('could not allocate a loopback port'));
          return;
        }
        resolve(port);
      });
    });
  });
}

const defaultSpawn: SpawnLike = (command, args, options = {}) => nodeSpawn(command, [...args], {
  env: options.env,
  stdio: options.stdio ?? 'ignore',
  windowsHide: options.windowsHide ?? true,
}) as unknown as ChildProcessLike;

function defaultHealthFetch(
  fetchImpl: EngineFetchLike,
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return (async () => {
    try {
      const response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) return false;
      const text = await response.text();
      if (!text.trim()) return true;
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && 'status' in parsed) {
          return (parsed as { status?: unknown }).status === 'ok';
        }
        return true;
      } catch {
        return true;
      }
    } catch {
      return false;
    }
  })();
}

/**
 * 单模型 llama-server supervisor。一个实例只管理一个子进程。
 */
export class LlamaServerEngine {
  private readonly options: Required<Pick<
    LlamaServerEngineOptions,
    | 'modelPath'
    | 'binaryPath'
    | 'contextSize'
    | 'threads'
    | 'startupTimeoutMs'
    | 'healthIntervalMs'
    | 'healthProbeTimeoutMs'
    | 'idleTimeoutMs'
    | 'stopTimeoutMs'
    | 'killTimeoutMs'
    | 'crashWindowMs'
    | 'maxCrashes'
    | 'autoIdleCheck'
  >> & LlamaServerEngineOptions;

  private readonly spawnImpl: SpawnLike;
  private readonly findPortImpl: () => Promise<number>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tokenFactory: () => string;
  private readonly healthCheckImpl: (url: string, token: string, signal?: AbortSignal) => Promise<boolean>;

  private state: EngineState = 'stopped';
  private child: ChildProcessLike | null = null;
  private port: number | undefined;
  private token: string | undefined;
  private startedAt: number | undefined;
  private lastHealthAt: number | undefined;
  private lastUsedAt: number | undefined;
  private health: 'unknown' | 'ok' | 'unhealthy' = 'unknown';
  private lastError: { code: string; message: string } | undefined;
  private crashTimes: number[] = [];
  private crashCount = 0;
  private restartCount = 0;
  private everStarted = false;
  private startPromise: Promise<EngineConnection> | null = null;
  private stopPromise: Promise<void> | null = null;
  private idleTimer: { unref?: () => void } | null = null;

  constructor(options: LlamaServerEngineOptions) {
    if (!options.modelPath) throw new EngineError('startup_failed', 'modelPath is required');
    this.options = {
      ...options,
      binaryPath: options.binaryPath ?? 'llama-server',
      contextSize: options.contextSize ?? 8192,
      threads: options.threads ?? Math.max(1, Math.min(8, os.cpus().length || 4)),
      startupTimeoutMs: options.startupTimeoutMs ?? 60_000,
      healthIntervalMs: options.healthIntervalMs ?? 250,
      healthProbeTimeoutMs: options.healthProbeTimeoutMs ?? 2_500,
      idleTimeoutMs: options.idleTimeoutMs ?? 5 * 60_000,
      stopTimeoutMs: options.stopTimeoutMs ?? 3_000,
      killTimeoutMs: options.killTimeoutMs ?? 1_000,
      crashWindowMs: options.crashWindowMs ?? 5 * 60_000,
      maxCrashes: Math.max(1, options.maxCrashes ?? 3),
      autoIdleCheck: options.autoIdleCheck ?? true,
    };
    this.spawnImpl = options.spawn ?? defaultSpawn;
    this.findPortImpl = options.findPort ?? defaultFindPort;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('hex'));
    this.healthCheckImpl = options.healthCheck ?? ((url, token, signal) => {
      const fetchImpl = options.fetch ?? ((input, init) => {
        const fetchFn = globalThis.fetch;
        if (typeof fetchFn !== 'function') {
          return Promise.reject(new Error('global fetch is unavailable'));
        }
        return fetchFn(input, init) as unknown as Promise<EngineFetchResponse>;
      });
      return defaultHealthFetch(fetchImpl, url, token, signal);
    });
  }

  getStatus(): EngineStatus {
    return {
      state: this.state,
      crashCount: this.crashCount,
      restartCount: this.restartCount,
      health: this.health,
      ...(this.child?.pid !== undefined ? { pid: this.child.pid } : {}),
      ...(this.port !== undefined ? { port: this.port } : {}),
      ...(this.port !== undefined ? { baseUrl: `http://127.0.0.1:${this.port}/v1` } : {}),
      ...(this.options.modelPath ? { modelPath: this.options.modelPath } : {}),
      ...(this.options.modelId ? { modelId: this.options.modelId } : {}),
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      ...(this.lastHealthAt !== undefined ? { lastHealthAt: this.lastHealthAt } : {}),
      ...(this.lastUsedAt !== undefined ? { lastUsedAt: this.lastUsedAt } : {}),
      ...(this.lastError ? { lastError: { ...this.lastError } } : {}),
    };
  }

  /** 获取/启动引擎；调用方应把返回的 apiKey 只用于本机请求。 */
  async acquire(): Promise<EngineConnection> {
    const connection = await this.start();
    this.touch();
    return connection;
  }

  async start(): Promise<EngineConnection> {
    if (this.stopPromise) await this.stopPromise;
    if (this.state === 'running' && this.child && this.token && this.port) {
      if (this.child.exitCode === null) {
        this.health = this.health === 'unknown' ? 'ok' : this.health;
        return this.connection();
      }
      this.handleChildExit(this.child, this.child.exitCode, null);
    }
    if (this.state === 'circuit_open') {
      throw new EngineError('circuit_open', 'llama-server crash circuit is open');
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private connection(): EngineConnection {
    if (this.state !== 'running' || !this.child || !this.token || this.port === undefined) {
      throw new EngineError('not_running', 'llama-server is not running');
    }
    return {
      baseUrl: `http://127.0.0.1:${this.port}/v1`,
      apiKey: this.token,
      modelPath: this.options.modelPath,
      ...(this.options.modelId ? { modelId: this.options.modelId } : {}),
      ...(this.child.pid !== undefined ? { pid: this.child.pid } : {}),
      port: this.port,
    };
  }

  private pruneCrashes(): void {
    const cutoff = this.now() - this.options.crashWindowMs;
    this.crashTimes = this.crashTimes.filter((at) => at >= cutoff);
  }

  private recordCrash(error: EngineError): void {
    const at = this.now();
    this.crashTimes.push(at);
    this.pruneCrashes();
    this.crashCount += 1;
    this.health = 'unhealthy';
    this.lastError = { code: error.code, message: error.message };
    this.state = this.crashTimes.length >= this.options.maxCrashes ? 'circuit_open' : 'crashed';
  }

  private async startInternal(): Promise<EngineConnection> {
    this.pruneCrashes();
    if (this.crashTimes.length >= this.options.maxCrashes) {
      this.state = 'circuit_open';
      this.lastError = { code: 'circuit_open', message: 'llama-server crash circuit is open' };
      throw new EngineError('circuit_open', this.lastError.message);
    }

    this.state = 'starting';
    this.health = 'unknown';
    this.lastError = undefined;

    let port: number;
    try {
      port = await this.findPortImpl();
    } catch (error) {
      const failure = new EngineError('invalid_port', `could not allocate loopback port: ${messageOf(error)}`);
      this.recordCrash(failure);
      throw failure;
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      const failure = new EngineError('invalid_port', `invalid loopback port: ${port}`);
      this.recordCrash(failure);
      throw failure;
    }
    this.port = port;
    try {
      this.token = this.tokenFactory();
    } catch (error) {
      const failure = new EngineError('startup_failed', `could not generate engine token: ${messageOf(error)}`);
      this.recordCrash(failure);
      throw failure;
    }
    if (!this.token || this.token.length < 16) {
      const failure = new EngineError('startup_failed', 'engine token must be at least 16 characters');
      this.recordCrash(failure);
      throw failure;
    }
    if (this.state !== 'starting') {
      this.port = undefined;
      this.token = undefined;
      throw new EngineError('stopped', 'engine was stopped during startup');
    }

    const args = [
      '--model', this.options.modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--ctx-size', String(this.options.contextSize),
      '--threads', String(this.options.threads),
      '--api-key', this.token,
      ...(this.options.extraArgs ?? []),
    ];

    let child: ChildProcessLike;
    try {
      child = this.spawnImpl(this.options.binaryPath, args, {
        env: { ...process.env, ...this.options.env },
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      const failure = new EngineError('spawn_failed', `could not start llama-server: ${messageOf(error)}`);
      this.recordCrash(failure);
      throw failure;
    }

    this.child = child;
    this.health = 'unknown';
    child.once('exit', (code, signal) => {
      this.handleChildExit(child, code, signal);
    });
    child.once('error', (error) => {
      this.handleChildError(child, error);
    });

    const maxAttempts = Math.max(
      1,
      Math.ceil(this.options.startupTimeoutMs / Math.max(1, this.options.healthIntervalMs)),
    );
    const deadline = this.now() + this.options.startupTimeoutMs;
    const origin = `http://127.0.0.1:${port}`;
    let lastProbeError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (this.state !== 'starting' || this.child !== child) {
        throw new EngineError('startup_failed', 'llama-server exited before it became healthy');
      }
      if (attempt > 0 && this.now() > deadline) break;
      try {
        const healthy = await this.probeHealth(`${origin}/health`, this.token);
        if (healthy) {
          if (this.state !== 'starting' || this.child !== child) {
            throw new EngineError('startup_failed', 'llama-server exited before it became healthy');
          }
          this.state = 'running';
          this.health = 'ok';
          this.startedAt = this.now();
          this.lastHealthAt = this.startedAt;
          this.lastUsedAt = this.startedAt;
          if (this.everStarted) this.restartCount += 1;
          this.everStarted = true;
          this.lastError = undefined;
          this.scheduleIdleCheck();
          return this.connection();
        }
        this.health = 'unhealthy';
        lastProbeError = new Error(`health check returned not-ok for ${origin}`);
      } catch (error) {
        lastProbeError = error;
      }
      if (attempt + 1 < maxAttempts) {
        await this.sleep(this.options.healthIntervalMs);
      }
    }

    const failure = new EngineError(
      'startup_timeout',
      `llama-server did not become healthy within ${this.options.startupTimeoutMs}ms${
        lastProbeError ? `: ${messageOf(lastProbeError)}` : ''
      }`,
    );
    if (this.state === 'starting') {
      await this.abortChild(child);
      this.recordCrash(failure);
    }
    throw failure;
  }

  private async probeHealth(url: string, token: string): Promise<boolean> {
    const controller = new AbortController();
    let resolveTimeout: (healthy: boolean) => void = () => {};
    const timeout = new Promise<boolean>((resolve) => {
      resolveTimeout = resolve;
    });
    const timer = setTimeout(() => {
      controller.abort();
      resolveTimeout(false);
    }, this.options.healthProbeTimeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      return await Promise.race([
        this.healthCheckImpl(url, token, controller.signal),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private handleChildExit(
    child: ChildProcessLike,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (child !== this.child) return;
    this.child = null;
    this.clearIdleTimer();
    this.health = 'unhealthy';

    if (this.state === 'stopping' || this.state === 'stopped') {
      this.state = 'stopped';
      this.token = undefined;
      return;
    }
    const failure = new EngineError(
      'process_exited',
      `llama-server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
    );
    this.recordCrash(failure);
  }

  private handleChildError(child: ChildProcessLike, error: Error): void {
    if (child !== this.child) return;
    this.child = null;
    this.clearIdleTimer();
    this.health = 'unhealthy';
    if (this.state === 'stopping' || this.state === 'stopped') {
      this.state = 'stopped';
      return;
    }
    this.recordCrash(new EngineError('spawn_failed', `llama-server process error: ${messageOf(error)}`));
    try {
      child.kill('SIGKILL');
    } catch {
      // 进程可能已经退出。
    }
  }

  private async abortChild(child: ChildProcessLike): Promise<void> {
    if (this.child === child) this.child = null;
    if (child.exitCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    const exited = await this.waitForExit(child, this.options.stopTimeoutMs);
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {
        return;
      }
      await this.waitForExit(child, this.options.killTimeoutMs);
    }
  }

  private waitForExit(child: ChildProcessLike, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      child.once('exit', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  touch(): void {
    this.lastUsedAt = this.now();
    if (this.state === 'running') this.scheduleIdleCheck();
  }

  async checkIdle(nowMs: number = this.now()): Promise<boolean> {
    if (this.state !== 'running' || !this.child) return false;
    if (this.options.idleTimeoutMs <= 0) return false;
    if (this.lastUsedAt === undefined) return false;
    if (nowMs - this.lastUsedAt < this.options.idleTimeoutMs) return false;
    await this.stop();
    return true;
  }

  private scheduleIdleCheck(): void {
    this.clearIdleTimer();
    if (!this.options.autoIdleCheck || this.options.idleTimeoutMs <= 0) return;
    const delay = Math.max(25, Math.min(this.options.idleTimeoutMs, 30_000));
    const timer = setTimeout(() => {
      this.idleTimer = null;
      void this.checkIdle().finally(() => {
        if (this.state === 'running') this.scheduleIdleCheck();
      });
    }, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.idleTimer = timer;
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer as ReturnType<typeof setTimeout>);
    this.idleTimer = null;
  }

  /** 手动停止：SIGTERM，超时后 SIGKILL；幂等。 */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    this.clearIdleTimer();
    const child = this.child;
    if (!child) {
      if (this.state !== 'circuit_open') this.state = 'stopped';
      this.token = undefined;
      return;
    }

    this.state = 'stopping';
    this.health = 'unknown';
    let exited = false;
    try {
      child.kill('SIGTERM');
      exited = await this.waitForExit(child, this.options.stopTimeoutMs);
      if (!exited) {
        child.kill('SIGKILL');
        exited = await this.waitForExit(child, this.options.killTimeoutMs);
      }
    } catch {
      // kill 失败时仍等待 exit；下面会清理本地引用。
    }
    if (this.child === child) this.child = null;
    this.state = 'stopped';
    this.health = 'unknown';
    this.token = undefined;
    this.port = undefined;
    this.startedAt = undefined;
  }

  /** 熔断后由管理员显式重置；不会自动重启模型。 */
  resetCircuit(): void {
    this.crashTimes = [];
    this.crashCount = 0;
    this.lastError = undefined;
    if (this.state === 'circuit_open' || this.state === 'crashed') {
      this.state = 'stopped';
      this.health = 'unknown';
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
