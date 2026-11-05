// OpenChamber Agent 适配器（M4 / 0.3.2 WS1）：**中立接口 + 执行器**。
//
// fleet 对 provider 毫不知情：`OpenChamberAdapter` 只依赖注入的 `OpenChamberSessionSeam`
// （prompt → {text, sessionId?, error?}），选项仅 `timeoutMs/maxOutputBytes/cwd/model/agent`。
// 具体 provider 由调用方注入（字段与错误码见 `packages/fleet/OPENCHAMBER-SEAM.md`）。
// 当前 provider #1 是 oc-hermes-bridge daemon 的 `POST /agent/run-once`（见 `openchamber-http.ts`
// 的中立 HTTP seam）；将来换成独立 provider 或 OpenChamber 官方 API，**不改本文件**。
//
// 公共语义（并发/超时/截断/归一化）由 `BaseExecutor` 负责；本文件只做 seam 翻译。

import {
  BaseExecutor,
  type ExecutorAdapter,
  type ExecutorDescriptor,
  type ExecutorRequest,
  type ExecutorResult,
} from './executor.js';

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
  /** 并发上限（默认不额外限制，保持旧行为） */
  concurrency?: number;
}

/** OpenChamber 平台 adapter：只把统一请求映射到 seam。 */
export class OpenChamberAdapter implements ExecutorAdapter {
  readonly descriptor: ExecutorDescriptor = {
    kind: 'openchamber',
    executionMode: 'http',
    supportsCancel: false,
    promptMode: 'arg',
    // bridge 每次 `run-once` 都新建会话，不复用用户当前会话。
    sessionMode: 'fresh',
  };

  constructor(
    private readonly seam: OpenChamberSessionSeam,
    private readonly options: OpenChamberAgentOptions = {},
  ) {}

  async invoke(request: ExecutorRequest): Promise<ExecutorResult> {
    const input: OpenChamberPromptInput = { prompt: request.prompt };
    const cwd = this.options.cwd ?? request.cwd;
    if (cwd !== undefined) input.cwd = cwd;
    if (this.options.model !== undefined) input.model = this.options.model;
    if (this.options.agent !== undefined) input.agent = this.options.agent;
    if (this.options.timeoutMs !== undefined) input.timeoutMs = this.options.timeoutMs;
    try {
      const result = await this.seam.prompt(input);
      if (result.error !== undefined) return { ok: false, reason: `OPENCHAMBER_ERROR: ${result.error}` };
      return {
        ok: true,
        ...(result.sessionId !== undefined ? { reason: `session:${result.sessionId}` } : {}),
        resultRef: result.text,
      };
    } catch (error) {
      return { ok: false, reason: `OPENCHAMBER_ERROR: ${(error as Error).message}` };
    }
  }
}

/** 基于注入 seam 的 OpenChamber 执行器（默认不接任何真实通道）。 */
export class OpenChamberAgent extends BaseExecutor {
  constructor(
    seam: OpenChamberSessionSeam,
    options: OpenChamberAgentOptions = {},
  ) {
    super(new OpenChamberAdapter(seam, options), {
      timeoutMs: options.timeoutMs ?? 600_000,
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      concurrency: options.concurrency ?? Number.POSITIVE_INFINITY,
    });
  }
}
