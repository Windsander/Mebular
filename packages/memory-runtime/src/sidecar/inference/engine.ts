// 模型引擎 adapter：sidecar 内唯一的 llama-server supervisor 持有者。
//
// - 同一个 adapter 最多持有一个引擎/子进程；切换 pack/path 时先停旧引擎；
// - model.ts 只通过 adapter facade 获取连接，不再自己维护多份 engine；
// - 对外 view 去掉模型绝对路径、baseUrl、引擎 token 与原始错误消息；
// - 未来 Ollama/MLX/OpenAI-compatible 只需实现新的 adapter，不按模型拆服务。

import { LlamaServerEngine, type EngineConnection, type LlamaServerEngineOptions } from '../../inference/engine.js';
import type { EngineStatus } from '../../inference/types.js';
import type { InferenceEngineFacade, InferenceEngineConnection } from '../inference-provider.js';
import { InferenceError, type InferenceEngineView } from './types.js';

export interface InferenceProcessStartRequest {
  packId: string;
  modelPath: string;
  modelId: string;
  contextSize?: number;
  threads?: number;
  binaryPath?: string | null;
}

export interface EngineAcquireRequest {
  modelPath?: string;
  modelId?: string;
}

/**
 * 本地 native engine 的受管子进程（managed-child）。
 *
 * 这是 sidecar 私有的进程抽象，不是 service：
 * - 只有 `LlamaCppInferenceEngine`/`InferenceService` 能启动/停止；
 * - 没有公开 API、独立 token、独立安装或独立配置；
 * - 不承载记忆、不写图、不参与同步。
 *
 * `LlamaServerEngine` 是该接口当前唯一的 llama.cpp 实现；测试可注入 fake。
 */
export interface InferenceProcess {
  acquire(): Promise<EngineConnection>;
  getStatus(): EngineStatus;
  stop?(): Promise<void>;
  resetCircuit?(): void;
}

/** @deprecated 使用 `InferenceProcess`；保留别名兼容 C8a/C8b 调用方。 */
export type LlamaProcessLike = InferenceProcess;

export type InferenceProcessFactory = (options: LlamaServerEngineOptions) => InferenceProcess;

/** service 依赖的引擎 adapter 面；测试可注入 fake。 */
export interface InferenceEngine {
  prepare(request: InferenceProcessStartRequest): Promise<void>;
  start(request: InferenceProcessStartRequest): Promise<InferenceEngineView>;
  getStatus(): EngineStatus;
  getView(): InferenceEngineView;
  isRunning(): boolean;
  resetCircuit(): void;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export interface InferenceEngineOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  engineFactory?: InferenceProcessFactory;
  startupTimeoutMs?: number;
  idleTimeoutMs?: number;
  binaryPath?: string | null;
  /** 动态解析 EngineInstaller 的二进制路径（sidecar 懒启动时使用）。 */
  binaryPathProvider?: () => string | null;
  /** 生产装配为 true：没有 EngineInstaller 校验过的路径时拒绝 spawn。 */
  requireBinaryPath?: boolean;
}

function engineErrorMessage(code: string): string {
  if (code === 'circuit_open') return '模型引擎已熔断';
  if (code === 'startup_timeout') return '模型引擎启动超时';
  if (code === 'startup_failed' || code === 'spawn_failed') return '模型引擎启动失败';
  if (code === 'process_exited') return '模型引擎进程已退出';
  return '模型引擎不可用';
}

function defaultEngineFactory(options: LlamaServerEngineOptions): InferenceProcess {
  return new LlamaServerEngine(options);
}

export class LlamaCppInferenceEngine implements InferenceEngine {
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly sleep?: (ms: number) => Promise<void>;
  private readonly engineFactory: InferenceProcessFactory;
  private readonly defaultStartupTimeoutMs: number;
  private readonly defaultIdleTimeoutMs: number;
  private readonly binaryPath: string | null;
  private readonly binaryPathProvider: (() => string | null) | null;
  private readonly requireBinaryPath: boolean;
  private current: { request: InferenceProcessStartRequest; engine: InferenceProcess | null } | null = null;
  private starting: Promise<void> | null = null;

  constructor(options: InferenceEngineOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep;
    this.engineFactory = options.engineFactory ?? defaultEngineFactory;
    this.defaultStartupTimeoutMs = Math.max(1, options.startupTimeoutMs ?? 30_000);
    this.defaultIdleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? 5 * 60_000);
    this.binaryPath = options.binaryPath ?? null;
    this.binaryPathProvider = options.binaryPathProvider ?? null;
    this.requireBinaryPath = options.requireBinaryPath ?? false;
  }

  /** 记录引擎目标但不启动；用于 sidecar 重启后按配置懒启动。 */
  async prepare(request: InferenceProcessStartRequest): Promise<void> {
    if (this.current?.request.modelPath === request.modelPath
      && this.current.request.packId === request.packId
      && this.current.request.modelId === request.modelId) {
      return;
    }
    await this.stop();
    this.current = { request: { ...request }, engine: null };
  }

  async start(request: InferenceProcessStartRequest): Promise<InferenceEngineView> {
    await this.ensureStarted(request, true);
    return this.getView();
  }

  /** model.ts facade 使用；path 变化会按需换引擎。 */
  async acquire(request: EngineAcquireRequest = {}): Promise<InferenceEngineConnection> {
    if (!this.current && !request.modelPath) {
      throw new InferenceError('engine_not_running', '模型引擎尚未启动', { status: 409 });
    }
    if (request.modelPath) {
      const target: InferenceProcessStartRequest = {
        packId: this.current?.request.packId ?? 'local',
        modelPath: request.modelPath,
        modelId: request.modelId ?? this.current?.request.modelId ?? 'local',
        ...(this.current?.request.contextSize !== undefined ? { contextSize: this.current.request.contextSize } : {}),
        ...(this.current?.request.threads !== undefined ? { threads: this.current.request.threads } : {}),
        ...(this.current?.request.binaryPath ? { binaryPath: this.current.request.binaryPath } : {}),
      };
      await this.ensureStarted(target, false);
    } else if (!this.current?.engine) {
      throw new InferenceError('engine_not_running', '模型引擎尚未启动', { status: 409 });
    }
    const engine = this.current?.engine;
    if (!engine) {
      throw new InferenceError('engine_not_running', '模型引擎尚未启动', { status: 409 });
    }
    return engine.acquire();
  }

  getStatus(): EngineStatus {
    const engine = this.current?.engine;
    if (!engine) {
      return {
        state: 'stopped',
        crashCount: 0,
        restartCount: 0,
        health: 'unknown',
        ...(this.current?.request.modelId ? { modelId: this.current.request.modelId } : {}),
      };
    }
    return engine.getStatus();
  }

  getView(): InferenceEngineView {
    const status = this.getStatus();
    const request = this.current?.request ?? null;
    const sanitizedError = status.lastError
      ? { code: status.lastError.code, message: engineErrorMessage(status.lastError.code) }
      : null;
    return {
      state: status.state,
      health: status.health,
      packId: request?.packId ?? null,
      modelId: status.modelId ?? request?.modelId ?? null,
      ...(status.pid !== undefined ? { pid: status.pid } : {}),
      ...(status.startedAt !== undefined ? { startedAt: status.startedAt } : {}),
      crashCount: status.crashCount,
      restartCount: status.restartCount,
      lastError: sanitizedError,
    };
  }

  isRunning(): boolean {
    return this.current?.engine?.getStatus().state === 'running';
  }

  resetCircuit(): void {
    this.current?.engine?.resetCircuit?.();
  }

  async stop(): Promise<void> {
    if (this.starting) {
      await this.starting.catch(() => undefined);
    }
    await this.stopEngineNow();
  }

  private async stopEngineNow(): Promise<void> {
    const engine = this.current?.engine;
    this.current = this.current ? { ...this.current, engine: null } : null;
    if (engine?.stop) {
      await engine.stop().catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.current = null;
  }

  /** 给 SidecarInferenceProvider 注入的单引擎 facade；生命周期仍由本 adapter 持有。 */
  asModelEngine(): InferenceEngineFacade {
    return {
      acquire: (request) => this.acquire(request ?? {}),
      getStatus: () => ({ state: this.getStatus().state }),
      resetCircuit: () => this.resetCircuit(),
      // 不暴露 stop：service 是引擎生命周期的唯一 owner。
    };
  }

  private async ensureStarted(request: InferenceProcessStartRequest, explicit: boolean): Promise<void> {
    // 同一路径已在运行/启动：直接复用。
    if (this.current?.request.modelPath === request.modelPath) {
      if (!this.current.engine) {
        await this.createEngine(this.current.request);
      } else if (explicit && this.current.engine.getStatus().state !== 'running') {
        await this.current.engine.acquire();
      }
      return;
    }
    if (this.starting) {
      await this.starting;
      if (this.current?.request.modelPath === request.modelPath && this.current.engine) return;
    }
    this.starting = (async () => {
      await this.stopEngineNow();
      this.current = { request: { ...request }, engine: null };
      await this.createEngine(this.current.request);
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async createEngine(request: InferenceProcessStartRequest): Promise<void> {
    const binaryPath = request.binaryPath
      ?? this.binaryPathProvider?.()
      ?? this.binaryPath
      ?? undefined;
    if (!binaryPath && this.requireBinaryPath) {
      throw new InferenceError('engine_not_installed', 'llama.cpp 引擎尚未安装或未通过校验', {
        status: 503,
        retryable: true,
      });
    }
    const engine = this.engineFactory({
      modelPath: request.modelPath,
      modelId: request.modelId,
      ...(request.contextSize !== undefined ? { contextSize: request.contextSize } : {}),
      ...(request.threads !== undefined ? { threads: request.threads } : {}),
      binaryPath,
      startupTimeoutMs: this.defaultStartupTimeoutMs,
      idleTimeoutMs: this.defaultIdleTimeoutMs,
      autoIdleCheck: true,
      env: this.env,
      now: this.now,
      ...(this.sleep ? { sleep: this.sleep } : {}),
    });
    if (this.current) this.current.engine = engine;
    try {
      await engine.acquire();
    } catch (error) {
      if (this.current) this.current.engine = null;
      await engine.stop?.().catch(() => undefined);
      if (error instanceof InferenceError) throw error;
      const code = typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code
        : 'engine_unavailable';
      throw new InferenceError('engine_unavailable', engineErrorMessage(code), {
        status: 503,
        retryable: true,
        details: { engineCode: code },
      });
    }
  }
}
