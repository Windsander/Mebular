// Claude Code CLI 平台 adapter（0.3.2 WS3）。
//
// 入口固定为 `claude -p <prompt>`；默认 `promptMode: 'arg'`（可覆盖为 stdin）。
// 本文件只做平台翻译，不解析 Claude Code 的会话/协议输出。
//
// 安全：参数数组传参；只继承 `ENV_ALLOWLIST`；`health()` 只执行 `claude --version`，
// 不输出 env/token，也不把 stderr 写进健康详情。

import { BaseExecutor } from './executor.js';
import { PlatformCliAdapter, type PlatformCliAdapterOptions } from './platform-cli.js';
import type { ExecutorPromptMode } from './executor.js';

export interface ClaudeCodeAgentOptions {
  /** claude 可执行文件（默认 `claude`；测试/自定义安装可覆盖，不写入能力卡） */
  claudePath?: string;
  /** 本地固定参数（`claude` 后、`-p` 前；不含凭据） */
  baseArgs?: readonly string[];
  /** `'arg'`（默认）或 `'stdin'`。 */
  promptMode?: ExecutorPromptMode;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  concurrency?: number;
  /** 额外环境变量（只按白名单继承 + 这些显式值） */
  env?: Readonly<Record<string, string>>;
}

/** Claude Code 平台 adapter：`[baseArgs] -p [prompt|stdin]`。 */
export class ClaudeCodeAdapter extends PlatformCliAdapter {
  constructor(options: ClaudeCodeAgentOptions = {}) {
    const descriptorOptions = {
      kind: 'claude-code',
      command: options.claudePath ?? 'claude',
      ...(options.baseArgs !== undefined ? { baseArgs: options.baseArgs } : {}),
      fixedArgs: ['-p'] as const,
      promptMode: options.promptMode ?? 'arg',
    } satisfies PlatformCliAdapterOptions;
    super(descriptorOptions);
  }
}

/** Claude Code 执行器：公共层包装 Claude Code adapter。 */
export class ClaudeCodeAgent extends BaseExecutor {
  constructor(options: ClaudeCodeAgentOptions = {}) {
    super(new ClaudeCodeAdapter(options), {
      timeoutMs: options.timeoutMs ?? 600_000,
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      concurrency: options.concurrency ?? 1,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
  }
}
