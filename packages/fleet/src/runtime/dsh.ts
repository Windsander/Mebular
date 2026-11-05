// DSH headless 平台 adapter（0.3.2 WS2）。
//
// v1 官方入口固定为 `dsh --profile headless`；默认 `promptMode: 'stdin'`（大 prompt 安全，
// 不占 argv 上限），也支持 `arg`。本文件**不实现** SDK/JSON-RPC——那是后续独立 adapter。
//
// 安全：
// - 参数数组传参，绝不 shell 拼接；
// - 只继承 `ENV_ALLOWLIST`（`DSH_HOME` 是非密路径，已加入白名单），不传 API key/token；
// - `health()` 只执行 `dsh --version`，缺失/非 0/超时 → unavailable，详情不含 env/stderr。
//
// 公共语义（并发/超时/截断/幂等）由 `BaseExecutor` 负责；argv/stdin 翻译复用 WS1 CLI adapter。

import { BaseExecutor } from './executor.js';
import { PlatformCliAdapter, type PlatformCliAdapterOptions } from './platform-cli.js';
import type { ExecutorPromptMode } from './executor.js';

export interface DshHeadlessAgentOptions {
  /** dsh 可执行文件（默认 `dsh`；测试/自定义安装可覆盖，不写入能力卡） */
  dshPath?: string;
  /** 本地固定参数（`dsh` 后、`--profile headless` 前；不含凭据） */
  baseArgs?: readonly string[];
  /** `'stdin'`（默认）或 `'arg'`。 */
  promptMode?: ExecutorPromptMode;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  concurrency?: number;
  /** 额外环境变量（只按白名单继承 + 这些显式值） */
  env?: Readonly<Record<string, string>>;
}

/** DSH headless 平台 adapter：`[baseArgs] --profile headless [prompt|stdin]`。 */
export class DshHeadlessAdapter extends PlatformCliAdapter {
  constructor(options: DshHeadlessAgentOptions = {}) {
    const descriptorOptions = {
      kind: 'dsh',
      command: options.dshPath ?? 'dsh',
      ...(options.baseArgs !== undefined ? { baseArgs: options.baseArgs } : {}),
      fixedArgs: ['--profile', 'headless'] as const,
      promptMode: options.promptMode ?? 'stdin',
    } satisfies PlatformCliAdapterOptions;
    super(descriptorOptions);
  }
}

/** DSH headless 执行器：公共层包装 DSH adapter。 */
export class DshHeadlessAgent extends BaseExecutor {
  constructor(options: DshHeadlessAgentOptions = {}) {
    super(new DshHeadlessAdapter(options), {
      timeoutMs: options.timeoutMs ?? 600_000,
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      concurrency: options.concurrency ?? 1,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
  }
}
