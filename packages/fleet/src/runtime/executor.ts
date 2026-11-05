// 统一执行层（0.3.2 WS1）：
//
// - `TaskExecutor` 仍是**公共契约**（按 taskId 幂等：同一任务重复执行必须得到同一结果且无副作用）；
// - `ExecutorAdapter` 只做**平台翻译**（CLI/HTTP/JSON-RPC/进程内），签名固定为
//   `invoke(request, signal) -> ExecutorResult`；
// - `BaseExecutor` 负责所有执行器共有语义：并发信号量、timeout、AbortSignal、env 白名单、
//   输出截断、结果/错误归一化、健康探测；
// - `ExecutionLog` + `executeOnce` 保证**按 taskId 至多执行一次**。
//
// 平台参数（`-z`、HTTP header、JSON-RPC 方法名等）只能出现在 adapter 内，不得进入本层。

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TaskState } from '../model.js';

export interface ExecutionOutcome {
  ok: boolean;
  resultRef?: string;
  reason?: string;
}

/** 执行器契约：**按 taskId 幂等**（同一任务重复执行必须得到同一结果且无副作用）。 */
export interface TaskExecutor {
  execute(task: TaskState): Promise<ExecutionOutcome>;
}

/** 可选执行/取消语义；为后续 DSH/OpenCode/Claude adapter 预留，不在公共层解释。 */
export type ExecutorExecutionMode = 'cli' | 'http' | 'json-rpc' | 'in-process';
export const EXECUTOR_EXECUTION_MODES: readonly ExecutorExecutionMode[] = ['cli', 'http', 'json-rpc', 'in-process'];
export type ExecutorPromptMode = 'arg' | 'stdin';

/**
 * Fleet 任务会话模式：**一个 Fleet task = 一个全新 session**。
 *
 * 公共层不解释任何平台的 session 语义（session id、resume/continue/attach 参数属于 adapter
 * 或配置层），只要求每个 first-class adapter 在 descriptor 中声明该不变量。
 */
export type ExecutorSessionMode = 'fresh';
export const EXECUTOR_SESSION_MODES: readonly ExecutorSessionMode[] = ['fresh'];

/** Adapter 的稳定元数据（非敏感，可安全展示/写入能力卡）。 */
export interface ExecutorDescriptor {
  /** 与 `FleetAgentConfig.kind` 对齐的稳定标识（如 `command`/`hermes`/`openchamber`）。 */
  kind: string;
  executionMode: ExecutorExecutionMode;
  supportsCancel: boolean;
  supportsStreaming?: boolean;
  /** CLI adapter 的 prompt 传递方式；HTTP/JSON-RPC 可省略。 */
  promptMode?: ExecutorPromptMode;
  /** 会话模式：first-class adapter 必须显式声明 `fresh`（禁止 resume/continue/attach）。 */
  sessionMode: ExecutorSessionMode;
}

/** 公共层交给 adapter 的**已归一化**请求：adapter 只按平台规则翻译。 */
export interface ExecutorRequest {
  task: TaskState;
  /** 任务意图（= task.intent）；adapter 决定把它放参数还是 stdin。 */
  prompt: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** 已按白名单过滤的环境变量；adapter 不得再继承 daemon 全量 env。 */
  env: Readonly<Record<string, string>>;
  cwd?: string;
}

/** Adapter 返回的原始结果；公共层再做截断与归一化。 */
export interface ExecutorResult {
  ok: boolean;
  resultRef?: string;
  reason?: string;
  /** 平台侧总输出字节数（含被 adapter 丢弃的部分），用于统一截断标记。 */
  outputBytes?: number;
}

export type ExecutorHealthStatus = 'ok' | 'degraded' | 'unavailable';

/** 健康探测结果（advisory：不参与任务一致性判定）。 */
export interface ExecutorHealth {
  status: ExecutorHealthStatus;
  /** 探测开始时间（epoch ms） */
  checkedAt: number;
  latencyMs?: number;
  /** 非敏感说明；不得包含 env/凭据/端点 token。 */
  detail?: string;
}

/** 平台 adapter：唯一职责是把统一请求翻译成平台调用并归一结果。 */
export interface ExecutorAdapter {
  readonly descriptor: ExecutorDescriptor;
  invoke(request: ExecutorRequest, signal: AbortSignal): Promise<ExecutorResult>;
  /** 可选：平台可探测性（命令是否存在/端点是否配置等）。 */
  health?(): Promise<ExecutorHealth>;
}

/** 内置 echo 执行器：结果与意图确定性绑定（幂等、无副作用）。 */
export class EchoExecutor implements TaskExecutor {
  async execute(task: TaskState): Promise<ExecutionOutcome> {
    return { ok: true, resultRef: `echo:${task.intent}` };
  }
}

/** 期望结果（供校验）：与 `EchoExecutor` 对齐。 */
export function echoResultFor(intent: string): string {
  return `echo:${intent}`;
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
  'DSH_HOME', // DSH profile/配置目录（非密路径；不含 API key）
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

/** UTF-8 安全截断（按字节），附截断标记。`totalBytes` 可传平台侧总量（含已丢弃部分）。 */
export function truncateOutput(
  text: string,
  maxBytes: number,
  totalBytes?: number,
): { text: string; truncated: boolean; totalBytes: number } {
  const limit = Math.max(0, Math.trunc(maxBytes));
  const buf = Buffer.from(text, 'utf-8');
  const total = Math.max(buf.byteLength, totalBytes ?? buf.byteLength);
  if (buf.byteLength > limit) {
    const head = buf.subarray(0, limit).toString('utf-8');
    return { text: `${head}\n…[truncated ${total - limit} bytes]`, truncated: true, totalBytes: total };
  }
  if (total > limit) {
    return { text: `${text}\n…[truncated ${total - limit} bytes]`, truncated: true, totalBytes: total };
  }
  return { text, truncated: false, totalBytes: total };
}

/** 简单并发闸（确定性：FIFO）。 */
export class Semaphore {
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

export interface BaseExecutorOptions {
  /** 单次执行超时（默认 60000ms；Hermes/OpenChamber 可覆盖） */
  timeoutMs?: number;
  /** 结果引用截断上限字节（默认 65536） */
  maxOutputBytes?: number;
  /** 并发上限（默认 1；`Infinity` = 不额外限制） */
  concurrency?: number;
  /** 额外环境变量（只按白名单继承 + 这些显式值；值不会被打印/落盘） */
  env?: Readonly<Record<string, string>>;
  /** 默认工作目录（adapter 可在 descriptor/请求中覆盖） */
  cwd?: string;
  /** 可选执行记录：由公共层保证按 taskId 至多执行一次（worker 也可用 `executeOnce`） */
  log?: ExecutionLog;
}

/**
 * 公共执行层：包装任意 `ExecutorAdapter`，统一所有执行器语义。
 * 子类/工厂只构造 adapter 与选项；不得复制并发/超时/截断逻辑。
 */
export class BaseExecutor implements TaskExecutor {
  private readonly semaphore: Semaphore;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly extraEnv: Readonly<Record<string, string>>;
  private readonly cwd: string | undefined;
  private readonly log: ExecutionLog | undefined;

  constructor(
    protected readonly adapter: ExecutorAdapter,
    options: BaseExecutorOptions = {},
  ) {
    this.timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 60_000));
    this.maxOutputBytes = Math.max(0, Math.trunc(options.maxOutputBytes ?? 65_536));
    this.semaphore = new Semaphore(Math.max(1, options.concurrency ?? 1));
    this.extraEnv = options.env ?? {};
    this.cwd = options.cwd;
    this.log = options.log;
  }

  get descriptor(): ExecutorDescriptor {
    return this.adapter.descriptor;
  }

  /** 健康探测：adapter 可选实现；公共层统一超时与错误归一化（advisory）。 */
  async health(timeoutMs = 5_000): Promise<ExecutorHealth> {
    const startedAt = Date.now();
    if (this.adapter.health === undefined) {
      // 没有 probe 不等于可用：标为 degraded（advisory），避免 doctor/task_targets 误判。
      return { status: 'degraded', checkedAt: startedAt, detail: 'adapter has no health probe' };
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const probe = this.adapter.health()
        .then((health) => ({ ...health, checkedAt: health.checkedAt || startedAt }))
        .catch((error: unknown) => ({
          status: 'unavailable' as const,
          checkedAt: Date.now(),
          latencyMs: Date.now() - startedAt,
          detail: `health probe failed: ${errorMessage(error)}`,
        }));
      const timeout = new Promise<ExecutorHealth>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            status: 'unavailable',
            checkedAt: Date.now(),
            detail: `health timeout after ${Math.max(1, timeoutMs)}ms`,
          });
        }, Math.max(1, timeoutMs));
      });
      const health = await Promise.race([probe, timeout]);
      return { ...health, latencyMs: health.latencyMs ?? Date.now() - startedAt };
    } catch (error) {
      return {
        status: 'unavailable',
        checkedAt: Date.now(),
        latencyMs: Date.now() - startedAt,
        detail: `health probe failed: ${errorMessage(error)}`,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async execute(task: TaskState): Promise<ExecutionOutcome> {
    const recorded = this.log?.resultOf(task.taskId);
    if (recorded !== undefined) return { ok: true, resultRef: recorded };
    await this.semaphore.acquire();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const request: ExecutorRequest = {
        task,
        prompt: task.intent,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        env: buildChildEnv(this.extraEnv),
        ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
      };
      const invoked = this.adapter.invoke(request, controller.signal).catch((error: unknown) => ({
        ok: false,
        reason: `EXECUTOR_ERROR: ${errorMessage(error)}`,
      }));
      const timeout = new Promise<ExecutorResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ ok: false, reason: `TIMEOUT after ${this.timeoutMs}ms` });
        }, this.timeoutMs);
      });
      const result = await Promise.race([invoked, timeout]);
      const outcome = this.normalize(result);
      if (outcome.ok) await this.log?.record(task.taskId, outcome.resultRef ?? '');
      return outcome;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.semaphore.release();
    }
  }

  private normalize(result: ExecutorResult): ExecutionOutcome {
    if (!result.ok) {
      return { ok: false, reason: result.reason ?? 'EXECUTOR_ERROR' };
    }
    const text = (result.resultRef ?? '').trim();
    const truncated = truncateOutput(text, this.maxOutputBytes, result.outputBytes);
    return {
      ok: true,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      resultRef: truncated.text,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface LogEntry {
  taskId: string;
  resultRef: string;
}

/** 执行记录：持久化「已执行的 taskId → 结果」，跨重启/重复投递去重执行。 */
export class ExecutionLog {
  private readonly path: string;
  private readonly entries: LogEntry[] = [];
  private readonly index = new Map<string, string>();

  private constructor(path: string) {
    this.path = path;
  }

  static async open(path: string): Promise<ExecutionLog> {
    const log = new ExecutionLog(path);
    await mkdir(dirname(path), { recursive: true });
    let raw = '';
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      raw = '';
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const entry = JSON.parse(trimmed) as LogEntry;
        if (!log.index.has(entry.taskId)) {
          log.index.set(entry.taskId, entry.resultRef);
          log.entries.push(entry);
        }
      } catch {
        continue; // 半行/损坏行跳过
      }
    }
    return log;
  }

  has(taskId: string): boolean {
    return this.index.has(taskId);
  }

  resultOf(taskId: string): string | undefined {
    return this.index.get(taskId);
  }

  /** 记录一次真实执行（若已存在则不重复追加）。 */
  async record(taskId: string, resultRef: string): Promise<void> {
    if (this.index.has(taskId)) return;
    const entry: LogEntry = { taskId, resultRef };
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf-8');
    this.index.set(taskId, resultRef);
    this.entries.push(entry);
  }

  all(): LogEntry[] {
    return [...this.entries];
  }

  size(): number {
    return this.entries.length;
  }

  async close(): Promise<void> {
    // 追加即时落盘；无长连接。
  }
}

/**
 * 按 taskId 至多执行一次：已记录则直接返回记录结果（不再次调用执行器）。
 * 这保证「重复投递不重复执行」与「重启不重复执行」。
 */
export async function executeOnce(
  task: TaskState,
  executor: TaskExecutor,
  log: ExecutionLog,
): Promise<ExecutionOutcome> {
  const existing = log.resultOf(task.taskId);
  if (existing !== undefined) return { ok: true, resultRef: existing };
  const outcome = await executor.execute(task);
  if (outcome.ok) await log.record(task.taskId, outcome.resultRef ?? '');
  return outcome;
}
