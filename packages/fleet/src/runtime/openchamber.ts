// OpenChamber Agent 适配器（M4，次优先）：**接口先行的接缝**。
//
// 调研结论（详见 `packages/fleet/OPENCHAMBER-SEAM.md`）：当前 OpenChamber 没有可被 fleet 进程
// 稳定调用的“运行一次会话/提示”外部接缝——in-app agent-tool 端点需要 OpenChamber 管理的
// `OPENCHAMBER_AGENT_TOOL_TOKEN`，本地 HTTP API 需要 UI 鉴权，`oc-bridge.js` 只存在于 OpenChamber
// 进程内。因此这里**只定义接口**：由 OpenChamber 侧提供一个 seam 实现（插件/MCP/受鉴权的会话 API），
// fleet 侧不臆造行为、不硬编码私有 token。

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
