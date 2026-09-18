// OpenChamber Agent 适配器（M4）：**中立接口 + 执行器**。
//
// fleet 对 provider 毫不知情：`OpenChamberAgent` 只依赖注入的 `OpenChamberSessionSeam`（prompt →
// {text, sessionId?, error?}），选项仅 `timeoutMs/maxOutputBytes/cwd/model/agent`。具体 provider
// 由调用方注入（字段与错误码见 `packages/fleet/OPENCHAMBER-SEAM.md`）。
// 当前 provider #1 是 oc-hermes-bridge daemon 的 `POST /agent/run-once`（见 `openchamber-http.ts`
// 的中立 HTTP seam）；将来换成独立 provider 或 OpenChamber 官方 API，**不改本文件**。

import type { TaskState } from '../model.js';
import type { ExecutionOutcome, TaskExecutor } from './executor.js';
import { truncateOutput } from './agent.js';

/** 一次会话提示的输入。 */
export interface OpenChamberPromptInput {
  prompt: string;
  cwd?: string;
  model?: string;
  agent?: string;
  /** 期望的最长等待（seam 实现负责超时并在超时后抛错/返回失败） */
  timeoutMs?: number;
}

/** OpenChamber 会话 seam：把「运行一次提示」抽象出来，交由 OpenChamber 侧实现。 */
export interface OpenChamberSessionSeam {
  /**
   * 运行一次 OpenChamber 会话提示，返回最终文本与（可选）会话 id。
   * 超时/失败应以异常或 `{ error }` 表达；实现方不得在此打印/落盘任何凭据。
   */
  prompt(input: OpenChamberPromptInput): Promise<{ text: string; sessionId?: string; error?: string }>;
}

export interface OpenChamberAgentOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
  model?: string;
  agent?: string;
}

/** 基于注入 seam 的 OpenChamber 执行器（默认不接任何真实通道）。 */
export class OpenChamberAgent implements TaskExecutor {
  constructor(
    private readonly seam: OpenChamberSessionSeam,
    private readonly options: OpenChamberAgentOptions = {},
  ) {}

  async execute(task: TaskState): Promise<ExecutionOutcome> {
    const input: OpenChamberPromptInput = { prompt: task.intent };
    if (this.options.cwd !== undefined) input.cwd = this.options.cwd;
    if (this.options.model !== undefined) input.model = this.options.model;
    if (this.options.agent !== undefined) input.agent = this.options.agent;
    if (this.options.timeoutMs !== undefined) input.timeoutMs = this.options.timeoutMs;
    try {
      const result = await this.seam.prompt(input);
      if (result.error !== undefined) return { ok: false, reason: `OPENCHAMBER_ERROR: ${result.error}` };
      const truncated = truncateOutput(result.text.trim(), this.options.maxOutputBytes ?? 65_536);
      return {
        ok: true,
        ...(result.sessionId !== undefined ? { reason: `session:${result.sessionId}` } : {}),
        resultRef: truncated.text,
      };
    } catch (error) {
      return { ok: false, reason: `OPENCHAMBER_ERROR: ${(error as Error).message}` };
    }
  }
}
