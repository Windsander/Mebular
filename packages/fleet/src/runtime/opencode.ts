// OpenCode CLI 平台 adapter（0.3.2 WS3）。
//
// 入口固定为 `opencode run <prompt>`；默认 `promptMode: 'arg'`（可覆盖为 stdin）。
// 本文件只做平台翻译，不解析 OpenCode 的会话/SDK 协议。
//
// 安全：参数数组传参；只继承 `ENV_ALLOWLIST`；`health()` 只执行 `opencode --version`，
// 不输出 env/token，也不把 stderr 写进健康详情。

import { BaseExecutor } from './executor.js';
import { PlatformCliAdapter, type PlatformCliAdapterOptions } from './platform-cli.js';
import type { ExecutorPromptMode } from './executor.js';

export interface OpenCodeAgentOptions {
  /** opencode 可执行文件（默认 `opencode`；测试/自定义安装可覆盖，不写入能力卡） */
  opencodePath?: string;
  /** 本地固定参数（`opencode` 后、`run` 前；不含凭据） */
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

/** OpenCode 平台 adapter：`[baseArgs] run [prompt|stdin]`。 */
export class OpenCodeAdapter extends PlatformCliAdapter {
  constructor(options: OpenCodeAgentOptions = {}) {
    const descriptorOptions = {
      kind: 'opencode',
      command: options.opencodePath ?? 'opencode',
      ...(options.baseArgs !== undefined ? { baseArgs: options.baseArgs } : {}),
      fixedArgs: ['run'] as const,
      promptMode: options.promptMode ?? 'arg',
    } satisfies PlatformCliAdapterOptions;
    super(descriptorOptions);
  }
}

/** OpenCode 执行器：公共层包装 OpenCode adapter。 */
export class OpenCodeAgent extends BaseExecutor {
  constructor(options: OpenCodeAgentOptions = {}) {
    super(new OpenCodeAdapter(options), {
      timeoutMs: options.timeoutMs ?? 600_000,
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      concurrency: options.concurrency ?? 1,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
  }
}
