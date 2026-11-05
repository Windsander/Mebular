// Fleet Agent 适配器（M4 / 0.3.2 WS1）：按 `to.agent` 名字路由到统一执行层。
//
// 分层：
// - `ExecutorRegistry`：名字 → `TaskExecutor`（未知名字返回 null，由 worker 显式失败）；
// - `CliExecutorAdapter` / `HermesExecutorAdapter`：只做**平台参数翻译**；
// - `BaseExecutor`（见 `executor.ts`）：并发、timeout、AbortSignal、env 白名单、截断、归一化。
//
// 安全与工程约束：
// - **参数数组传参**（绝不 shell 拼接，防注入）；
// - **不继承 daemon 的全量 env**：只透传 `ENV_ALLOWLIST` + 调用方显式给出的 env；
// - 平台参数（`-z`/`--usage-file`）只出现在 Hermes adapter 内，不是通用默认。

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskState } from '../model.js';
import {
  BaseExecutor,
  buildChildEnv,
  type ExecutorAdapter,
  type ExecutorDescriptor,
  type ExecutorHealth,
  type ExecutorPromptMode,
  type ExecutorRequest,
  type ExecutorResult,
  type TaskExecutor,
} from './executor.js';

// 兼容旧子路径导入：这些公共语义已迁到 `executor.ts`，此处保持同名 re-export。
export { ENV_ALLOWLIST, buildChildEnv, truncateOutput } from './executor.js';

/** 按 agent 名字选择执行器；**未知 agent 返回 null**（调用方须显式失败，不得静默回退）。 */
export class ExecutorRegistry {
  private readonly exact = new Map<string, TaskExecutor>();
  private readonly listeners = new Set<(agent: string) => void>();
  private wildcard: TaskExecutor | null = null;

  /** 注册某 agent 名；`'*'` 为通配（仅匹配 `to.agent === '*'`）。 */
  register(agent: string, executor: TaskExecutor): this {
    if (agent === '*') this.wildcard = executor;
    else this.exact.set(agent, executor);
    for (const listener of this.listeners) {
      try {
        listener(agent);
      } catch {
        // 监听方失败不得影响注册（能力卡发布是旁路）。
      }
    }
    return this;
  }

  /** 注册变化监听（P1：能力卡自动发布）；返回退订函数。 */
  onChange(listener: (agent: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resolve(agent: string): TaskExecutor | null {
    if (agent === '*') return this.wildcard;
    return this.exact.get(agent) ?? null; // 显式：不 fallback 到通配
  }

  has(agent: string): boolean {
    return agent === '*' ? this.wildcard !== null : this.exact.has(agent);
  }

  names(): string[] {
    return [...this.exact.keys()].sort();
  }

  /** 执行器（若实现统一执行层）的 descriptor；未知/非 BaseExecutor 返回 undefined。 */
  descriptorOf(agent: string): ExecutorDescriptor | undefined {
    const executor = this.resolve(agent);
    return executor instanceof BaseExecutor ? executor.descriptor : undefined;
  }

  /** 执行器健康探测；未知/非 BaseExecutor 返回 unavailable（advisory）。 */
  async healthOf(agent: string, timeoutMs = 5_000): Promise<ExecutorHealth> {
    const executor = this.resolve(agent);
    if (!(executor instanceof BaseExecutor)) {
      return { status: 'unavailable', checkedAt: Date.now(), detail: `no health probe for agent ${agent}` };
    }
    return executor.health(timeoutMs);
  }
}

export interface SpawnResult {
  code: number | null;
  /** 已捕获的 stdout（至多 `maxOutputBytes` 字节） */
  stdout: string;
  /** stdout 的**总字节数**（含未捕获部分） */
  stdoutBytes: number;
  stderrTail: string;
  timedOut: boolean;
  /** 调用方 AbortSignal 触发（与 timeout 区分，公共层会归一为 TIMEOUT/ABORTED）。 */
  aborted?: boolean;
}

/**
 * 以参数数组执行命令；捕获 stdout/stderr（stderr 保留尾部）；超时/AbortSignal kill。
 * 环境仍按白名单过滤（即使调用方传入的 env 已过滤，也不会额外继承 daemon 变量）。
 */
export async function runOnce(options: {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
  /** 写入子进程 stdin（`promptMode: 'stdin'`）；不给则 stdin = ignore */
  stdin?: string;
  signal?: AbortSignal;
}): Promise<SpawnResult> {
  const limit = options.maxOutputBytes;
  return new Promise<SpawnResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(options.command, [...options.args], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        // 只继承白名单 + 显式 env；不把 daemon 的全量环境（含凭据）传给被派发 Agent。
        env: buildChildEnv(options.env),
        stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stdoutBytes: 0,
        stderrTail: (error as Error).message,
        timedOut: false,
        aborted: false,
      });
      return;
    }
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let totalOutBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.max(1, options.timeoutMs));
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      totalOutBytes += chunk.length;
      if (outBytes < limit) {
        // 按**字节**精确封顶：大 chunk 只取剩余额度，避免截断结果超过 maxOutputBytes。
        const remaining = limit - outBytes;
        const piece = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        outChunks.push(piece);
        outBytes += piece.length;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errChunks.push(chunk);
      while (errChunks.length > 0 && Buffer.concat(errChunks).length > 8192) errChunks.shift();
    });
    if (options.stdin !== undefined) {
      child.stdin?.on('error', () => undefined); // EPIPE 等不改变执行结果
      child.stdin?.end(options.stdin);
    }
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const stdout = Buffer.concat(outChunks).toString('utf-8');
      const stderrTail = Buffer.concat(errChunks).toString('utf-8').trim().slice(-800);
      resolve({ code, stdout, stdoutBytes: totalOutBytes, stderrTail, timedOut, aborted });
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

export interface CommandAgentOptions {
  /** 可执行文件（不经 shell） */
  command: string;
  /** 命令后、prompt 相关参数前的固定参数 */
  baseArgs?: readonly string[];
  /**
   * prompt 参数：
   * - 函数：返回**完整** prompt 参数（含 prompt 本身；旧用法，优先生效）；
   * - 字符串数组：插在 prompt 之前的固定参数（配合 `promptMode`）。
   */
  promptArgs?: readonly string[] | ((task: TaskState) => readonly string[]);
  /** `'arg'`（默认：prompt 作为最后一个参数）或 `'stdin'`（写入 stdin） */
  promptMode?: ExecutorPromptMode;
  cwd?: string;
  /** 额外环境变量（值不会被打印/落盘） */
  env?: Readonly<Record<string, string>>;
  /** 超时（默认 60000ms） */
  timeoutMs?: number;
  /** stdout 截断上限字节（默认 65536） */
  maxOutputBytes?: number;
  /** 并发上限（默认 1） */
  concurrency?: number;
  /** 结果引用生成（默认：截断后的 stdout） */
  resultRef?: (stdout: string, task: TaskState) => string;
}

/** 通用命令行 adapter：只负责 argv/stdin 翻译与退出码归一化。 */
export class CliExecutorAdapter implements ExecutorAdapter {
  readonly descriptor: ExecutorDescriptor;

  constructor(private readonly options: CommandAgentOptions) {
    this.descriptor = {
      kind: 'command',
      executionMode: 'cli',
      supportsCancel: true,
      promptMode: options.promptMode ?? 'arg',
      // 通用 CLI 同样一次性执行：resume 参数由 config 层统一拒绝。
      sessionMode: 'fresh',
    };
  }

  private argv(request: ExecutorRequest): { args: string[]; stdin?: string } {
    const base = [...(this.options.baseArgs ?? [])];
    const promptArgs = this.options.promptArgs;
    if (typeof promptArgs === 'function') {
      return { args: [...base, ...promptArgs(request.task)] };
    }
    const fixed = [...(promptArgs ?? [])];
    if ((this.options.promptMode ?? 'arg') === 'stdin') {
      return { args: [...base, ...fixed], stdin: request.prompt };
    }
    return { args: [...base, ...fixed, request.prompt] };
  }

  async invoke(request: ExecutorRequest, signal: AbortSignal): Promise<ExecutorResult> {
    const { args, stdin } = this.argv(request);
    const result = await runOnce({
      command: this.options.command,
      args,
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      env: request.env,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      ...(stdin !== undefined ? { stdin } : {}),
      signal,
    });
    if (result.timedOut || result.aborted) {
      return { ok: false, reason: `TIMEOUT after ${request.timeoutMs}ms` };
    }
    if (result.code !== 0) {
      return { ok: false, reason: `EXIT_${result.code}${result.stderrTail ? `: ${result.stderrTail}` : ''}` };
    }
    const stdout = result.stdout.trim();
    const resultRef = this.options.resultRef?.(stdout, request.task);
    return {
      ok: true,
      resultRef: resultRef ?? result.stdout,
      ...(resultRef === undefined ? { outputBytes: result.stdoutBytes } : {}),
    };
  }
}

/** 通用「命令行 Agent」执行器（公共层包装 CLI adapter）。 */
export class CommandAgent extends BaseExecutor {
  constructor(options: CommandAgentOptions) {
    super(new CliExecutorAdapter(options), {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
  }
}

export interface HermesAgentOptions {
  /** hermes 可执行文件（默认 `hermes`） */
  hermesPath?: string;
  /** 命令后、hermes 参数前的固定参数（测试注入用；生产留空） */
  commandArgs?: readonly string[];
  /** Hermes profile（`-p`） */
  profile?: string;
  /** toolsets（`-t`） */
  toolsets?: string;
  /** 模型（`-m`） */
  model?: string;
  /** 工作目录（`--in`） */
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  concurrency?: number;
  /** `--usage-file` 临时目录 */
  usageDir?: string;
}

const HEALTH_MAX_OUTPUT_BYTES = 4_096;
const HEALTH_DETAIL_MAX_CHARS = 120;

/**
 * `hermes --version` 探测（advisory）。
 *
 * - 命令缺失/非 0/超时 → `unavailable`；成功 → `ok`（detail 只保留首行版本）；
 * - 不继承 daemon 全量 env，不返回 stderr/凭据；不影响执行超时与并发。
 */
async function probeHermesVersion(command: string, timeoutMs = 5_000): Promise<ExecutorHealth> {
  const startedAt = Date.now();
  try {
    const result = await runOnce({
      command,
      args: ['--version'],
      env: buildChildEnv(),
      timeoutMs,
      maxOutputBytes: HEALTH_MAX_OUTPUT_BYTES,
    });
    const latencyMs = Date.now() - startedAt;
    if (result.timedOut || result.aborted) {
      return {
        status: 'unavailable',
        checkedAt: Date.now(),
        latencyMs,
        detail: `${command} --version timed out after ${Math.max(1, timeoutMs)}ms`,
      };
    }
    if (result.code === null) {
      return { status: 'unavailable', checkedAt: Date.now(), latencyMs, detail: `${command} not found` };
    }
    if (result.code !== 0) {
      return {
        status: 'unavailable',
        checkedAt: Date.now(),
        latencyMs,
        detail: `${command} --version exited ${result.code}`,
      };
    }
    const firstLine = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return {
      status: 'ok',
      checkedAt: Date.now(),
      latencyMs,
      detail: firstLine !== undefined
        ? `${command}: ${firstLine.slice(0, HEALTH_DETAIL_MAX_CHARS)}`
        : `${command} --version ok`,
    };
  } catch {
    return {
      status: 'unavailable',
      checkedAt: Date.now(),
      latencyMs: Date.now() - startedAt,
      detail: `${command} --version failed`,
    };
  }
}

/**
 * Hermes 专用 adapter：`hermes [-p P] [-t T] [-m M] [--in DIR] -z <prompt> --usage-file <tmp>`。
 * `-z`/`--usage-file` 是 Hermes 平台细节，**只出现在这里**。
 */
export class HermesExecutorAdapter implements ExecutorAdapter {
  readonly descriptor: ExecutorDescriptor = {
    kind: 'hermes',
    executionMode: 'cli',
    supportsCancel: true,
    promptMode: 'arg',
    // Hermes one-shot：每次任务都由全新进程/会话来执行。
    sessionMode: 'fresh',
  };

  constructor(private readonly options: HermesAgentOptions = {}) {}

  /** 只探测 `hermes --version`；缺失/异常 → unavailable（不伪造 ok）。 */
  health(): Promise<ExecutorHealth> {
    return probeHermesVersion(this.options.hermesPath ?? 'hermes');
  }

  private argv(prompt: string, usagePath: string): string[] {
    const args: string[] = [...(this.options.commandArgs ?? [])];
    if (this.options.profile) args.push('-p', this.options.profile);
    if (this.options.toolsets) args.push('-t', this.options.toolsets);
    if (this.options.model) args.push('-m', this.options.model);
    if (this.options.cwd) args.push('--in', this.options.cwd);
    args.push('-z', prompt, '--usage-file', usagePath);
    return args;
  }

  async invoke(request: ExecutorRequest, signal: AbortSignal): Promise<ExecutorResult> {
    const dir = await mkdtemp(join(this.options.usageDir ?? tmpdir(), 'fleet-hermes-'));
    const usagePath = join(dir, 'usage.json');
    try {
      const result = await runOnce({
        command: this.options.hermesPath ?? 'hermes',
        args: this.argv(request.prompt, usagePath),
        ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
        env: request.env,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        signal,
      });
      if (result.timedOut || result.aborted) {
        return { ok: false, reason: `TIMEOUT after ${request.timeoutMs}ms` };
      }
      if (result.code !== 0) {
        return { ok: false, reason: `EXIT_${result.code}${result.stderrTail ? `: ${result.stderrTail}` : ''}` };
      }
      // usage 仅用于观测 sessionId；解析失败不影响结果。
      let sessionId: string | undefined;
      try {
        const usage = JSON.parse(await readFile(usagePath, 'utf-8')) as { session_id?: string };
        sessionId = usage.session_id;
      } catch {
        sessionId = undefined;
      }
      return {
        ok: true,
        ...(sessionId !== undefined ? { reason: `session:${sessionId}` } : {}),
        resultRef: result.stdout,
        outputBytes: result.stdoutBytes,
      };
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  }
}

/**
 * Hermes 一次性非交互执行器（公共层包装 Hermes adapter）。
 * 成功 → 结果 = stdout（截断）；超时/非零退出 → `failed` 带原因与 stderr 尾巴。
 */
export class HermesAgent extends BaseExecutor {
  constructor(options: HermesAgentOptions = {}) {
    super(new HermesExecutorAdapter(options), {
      timeoutMs: options.timeoutMs ?? 600_000,
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      concurrency: options.concurrency ?? 2,
    });
  }
}
