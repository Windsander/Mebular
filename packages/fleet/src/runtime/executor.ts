// 可插拔执行器（M2）：内置 `echo`；执行记录（ExecutionLog）保证**按 taskId 至多执行一次**。

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
