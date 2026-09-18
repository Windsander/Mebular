// Fleet Agent 适配器（M4）：按 `to.agent` 名字路由到可插拔执行器。
//
// 安全与工程约束：
// - **参数数组传参**（绝不 shell 拼接，防注入）；
// - 超时 / 非零退出 / 输出超限 各自语义明确（超时与非零 → 任务 `failed` 带原因）；
// - **不继承 daemon 的全量 env**：只透传 `ENV_ALLOWLIST`（PATH/HOME/… 运行所需）+ 调用方显式
//   给出的 `options.env`；凭据/令牌不外流。同时不打印/不落盘任何 env 值；
// - 工作目录与并发上限可配。

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskState } from '../model.js';
import type { ExecutionOutcome, TaskExecutor } from './executor.js';

/** 按 agent 名字选择执行器；**未知 agent 返回 null**（调用方须显式失败，不得静默回退）。 */
export class ExecutorRegistry {
  private readonly exact = new Map<string, TaskExecutor>();
  private wildcard: TaskExecutor | null = null;

  /** 注册某 agent 名；`'*'` 为通配（仅匹配 `to.agent === '*'`）。 */
  register(agent: string, executor: TaskExecutor): this {
    if (agent === '*') this.wildcard = executor;
    else this.exact.set(agent, executor);
    return this;
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
}

/** UTF-8 安全截断（按字节），附截断标记。 */
export function truncateOutput(text: string, maxBytes: number): { text: string; truncated: boolean; totalBytes: number } {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false, totalBytes: buf.byteLength };
  const head = buf.subarray(0, maxBytes).toString('utf-8');
  return { text: `${head}\n…[truncated ${buf.byteLength - maxBytes} bytes]`, truncated: true, totalBytes: buf.byteLength };
}

/** 简单并发闸（确定性：FIFO）。 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }
  release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
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
}

/**
 * 允许透传给被派发 Agent 的环境变量**白名单**（非私密运行所需）。
 * 其余（尤其凭据/令牌）**一律不继承**——daemon 的 env 不外流。
 */
export const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'HERMES_HOME', // Hermes profile 解析（非密）
  // Windows 运行所需（存在才带）
  'SystemRoot',
  'PATHEXT',
  'COMSPEC',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
];

/** 按白名单构建子进程 env；`extra`（调用方显式给出）覆盖白名单同名项。 */
export function buildChildEnv(
  extra?: Readonly<Record<string, string>>,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) env[key] = value;
  return env;
}

/** 以参数数组执行命令；捕获 stdout/stderr（stderr 保留尾部）；超时 kill。 */
export async function runOnce(options: {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<SpawnResult> {
  const limit = options.maxOutputBytes;
  return new Promise<SpawnResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(options.command, [...options.args], {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        // 只继承白名单 + 显式 env；不把 daemon 的全量环境（含凭据）传给被派发 Agent。
        env: buildChildEnv(options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stdoutBytes: 0, stderrTail: (error as Error).message, timedOut: false });
      return;
    }
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let totalOutBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.max(1, options.timeoutMs));

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
    const finish = (code: number | null): void => {
      clearTimeout(timer);
      const stdout = Buffer.concat(outChunks).toString('utf-8');
      const stderrTail = Buffer.concat(errChunks).toString('utf-8').trim().slice(-800);
      resolve({ code, stdout, stdoutBytes: totalOutBytes, stderrTail, timedOut });
    };
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

export interface CommandAgentOptions {
  /** 可执行文件（不经 shell） */
  command: string;
  /** 命令后、prompt 参数前的固定参数 */
  baseArgs?: readonly string[];
  /** 由任务生成 prompt 相关参数（默认 `['-z', task.intent]`） */
  promptArgs?: (task: TaskState) => string[];
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

/** 通用「命令行 Agent」执行器。 */
export class CommandAgent implements TaskExecutor {
  private readonly sem: Semaphore;
  constructor(private readonly options: CommandAgentOptions) {
    this.sem = new Semaphore(Math.max(1, options.concurrency ?? 1));
  }

  async execute(task: TaskState): Promise<ExecutionOutcome> {
    await this.sem.acquire();
    try {
      const args = [
        ...(this.options.baseArgs ?? []),
        ...(this.options.promptArgs ? this.options.promptArgs(task) : ['-z', task.intent]),
      ];
      const timeoutMs = this.options.timeoutMs ?? 60_000;
      const maxOutputBytes = this.options.maxOutputBytes ?? 65_536;
      const result = await runOnce({
        command: this.options.command,
        args,
        ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
        ...(this.options.env !== undefined ? { env: this.options.env } : {}),
        timeoutMs,
        maxOutputBytes,
      });
      if (result.timedOut) return { ok: false, reason: `TIMEOUT after ${timeoutMs}ms` };
      if (result.code !== 0) {
        return { ok: false, reason: `EXIT_${result.code}${result.stderrTail ? `: ${result.stderrTail}` : ''}` };
      }
      const stored = result.stdout.trim();
      const text = result.stdoutBytes > maxOutputBytes ? `${stored}\n…[truncated ${result.stdoutBytes - maxOutputBytes} bytes]` : stored;
      const resultRef = this.options.resultRef ? this.options.resultRef(text, task) : text;
      return { ok: true, resultRef };
    } finally {
      this.sem.release();
    }
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

/**
 * Hermes 一次性非交互适配器：`hermes [-p P] [-t T] [-m M] [--in DIR] -z <prompt> --usage-file <tmp>`。
 * 成功 → 结果 = stdout（截断）；超时/非零退出 → `failed` 带原因与 stderr 尾巴。
 */
export class HermesAgent implements TaskExecutor {
  private readonly sem: Semaphore;
  constructor(private readonly options: HermesAgentOptions = {}) {
    this.sem = new Semaphore(Math.max(1, options.concurrency ?? 2));
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

  async execute(task: TaskState): Promise<ExecutionOutcome> {
    await this.sem.acquire();
    const dir = await mkdtemp(join(this.options.usageDir ?? tmpdir(), 'fleet-hermes-'));
    const usagePath = join(dir, 'usage.json');
    try {
      const timeoutMs = this.options.timeoutMs ?? 600_000;
      const maxOutputBytes = this.options.maxOutputBytes ?? 65_536;
      const result = await runOnce({
        command: this.options.hermesPath ?? 'hermes',
        args: this.argv(task.intent, usagePath),
        ...(this.options.cwd !== undefined ? { cwd: this.options.cwd } : {}),
        timeoutMs,
        maxOutputBytes,
      });
      if (result.timedOut) return { ok: false, reason: `TIMEOUT after ${timeoutMs}ms` };
      if (result.code !== 0) {
        return { ok: false, reason: `EXIT_${result.code}${result.stderrTail ? `: ${result.stderrTail}` : ''}` };
      }
      const stored = result.stdout.trim();
      const text = result.stdoutBytes > maxOutputBytes ? `${stored}\n…[truncated ${result.stdoutBytes - maxOutputBytes} bytes]` : stored;
      // usage 仅用于观测 sessionId；解析失败不影响结果。
      let sessionId: string | undefined;
      try {
        const usage = JSON.parse(await readFile(usagePath, 'utf-8')) as { session_id?: string };
        sessionId = usage.session_id;
      } catch {
        sessionId = undefined;
      }
      return { ok: true, ...(sessionId !== undefined ? { reason: `session:${sessionId}` } : {}), resultRef: text };
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
      this.sem.release();
    }
  }
}
