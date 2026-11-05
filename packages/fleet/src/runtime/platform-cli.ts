// 0.3.2 WS2/WS3：dsh / opencode / claude-code 共用的小型 CLI 平台助手。
//
// 只做两件事：
// - 把「本地 baseArgs + 固定平台前缀参数 + prompt(arg|stdin)」翻译交给 `CliExecutorAdapter`；
// - 用 `<command> --version` 做非敏感健康探测。
//
// 安全：探测只继承 `ENV_ALLOWLIST`（含 `DSH_HOME`），不携带 daemon 全量 env、API key 或令牌；
// 探测输出只保留首行并截断，不回传 stderr（避免把凭据写进健康详情/日志）。

import { CliExecutorAdapter, runOnce } from './agent.js';
import {
  buildChildEnv,
  type ExecutorAdapter,
  type ExecutorDescriptor,
  type ExecutorHealth,
  type ExecutorPromptMode,
  type ExecutorRequest,
  type ExecutorResult,
} from './executor.js';

const HEALTH_MAX_OUTPUT_BYTES = 4_096;
const HEALTH_DETAIL_MAX_CHARS = 120;

export interface PlatformCliAdapterOptions {
  /** descriptor.kind（与 config 的 FleetAgentKind 对齐） */
  kind: string;
  /** 可执行文件（默认由各 adapter 提供） */
  command: string;
  /** 本地固定参数（命令后、平台前缀前；测试夹具路径等非密参数） */
  baseArgs?: readonly string[];
  /** 平台固定前缀参数（如 `run` / `-p` / `--profile headless`） */
  fixedArgs?: readonly string[];
  promptMode?: ExecutorPromptMode;
}

/**
 * 平台 CLI adapter 的公共骨架：descriptor 由平台声明，argv/stdin 翻译复用 WS1
 * `CliExecutorAdapter`，因此超时/非 0/截断语义与其他 CLI 执行器一致。
 */
export class PlatformCliAdapter implements ExecutorAdapter {
  readonly descriptor: ExecutorDescriptor;
  private readonly cli: CliExecutorAdapter;

  constructor(private readonly options: PlatformCliAdapterOptions) {
    this.descriptor = {
      kind: options.kind,
      executionMode: 'cli',
      supportsCancel: true,
      promptMode: options.promptMode ?? 'arg',
    };
    this.cli = new CliExecutorAdapter({
      command: options.command,
      baseArgs: [...(options.baseArgs ?? []), ...(options.fixedArgs ?? [])],
      promptMode: options.promptMode ?? 'arg',
    });
  }

  invoke(request: ExecutorRequest, signal: AbortSignal): Promise<ExecutorResult> {
    return this.cli.invoke(request, signal);
  }

  health(): Promise<ExecutorHealth> {
    return probeCliVersion(this.options.command);
  }
}

/**
 * `dsh/opencode/claude --version` 探测。
 *
 * - 命令缺失（spawn error → code=null）、非 0、超时 → `unavailable`；
 * - 成功 → `ok`，detail 仅包含首行版本号；
 * - 永不返回 env/token；stderr 不进入 detail。
 */
export async function probeCliVersion(command: string, timeoutMs = 5_000): Promise<ExecutorHealth> {
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
    // 异常信息可能含路径；保留固定文案，不拼接原始错误。
    return {
      status: 'unavailable',
      checkedAt: Date.now(),
      latencyMs: Date.now() - startedAt,
      detail: `${command} --version failed`,
    };
  }
}
