// 本地 llama-server supervisor 的设备级包装（0.3.0）。
//
// - 单实例只持有一个子进程；换 pack 会先停旧进程，避免两个大模型同时驻留；
// - 启动/健康检查/空闲停止/崩溃熔断由 @mebular/core 的 LlamaServerEngine 负责；
// - test 只发送固定的极小 self-test prompt，并限制输出 token；不下载、不扫市场；
// - 状态对象永远不包含引擎 token 或模型响应体。

import {
  InferenceError,
  findModelFilePath,
  inferenceCore,
  readInstalledPack,
} from './inference-store.mjs';

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_TEST_TIMEOUT_MS = 15_000;

function isRunning(status) {
  return status?.state === 'running' || status?.state === 'starting';
}

export class InferenceEngineManager {
  constructor({
    home,
    modelsDir,
    env = process.env,
    now = Date.now,
    sleep,
    engineFactory = null,
    gatewayFactory = null,
    binaryPath = null,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS,
  } = {}) {
    this.home = home;
    this.modelsDir = modelsDir;
    this.env = env;
    this.now = now;
    this.sleep = sleep;
    this.engineFactory = engineFactory;
    this.gatewayFactory = gatewayFactory;
    this.binaryPath = binaryPath;
    this.idleTimeoutMs = idleTimeoutMs;
    this.startupTimeoutMs = startupTimeoutMs;
    this.testTimeoutMs = testTimeoutMs;
    this.current = null; // { packId, modelPath, modelId, engine }
  }

  defaultBinary() {
    if (typeof this.binaryPath === 'string' && this.binaryPath.length > 0) return this.binaryPath;
    const fromEnv = this.env?.MEBULAR_LLAMA_SERVER;
    return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : 'llama-server';
  }

  engineFactoryFor() {
    if (typeof this.engineFactory === 'function') return this.engineFactory;
    const lib = inferenceCore();
    return (options) => new lib.LlamaServerEngine(options);
  }

  gatewayFactoryFor() {
    if (typeof this.gatewayFactory === 'function') return this.gatewayFactory;
    const lib = inferenceCore();
    return (options) => new lib.ChatCompletionGateway(options);
  }

  getStatus() {
    if (!this.current) {
      return {
        state: 'stopped',
        health: 'unknown',
        crashCount: 0,
        restartCount: 0,
      };
    }
    const status = this.current.engine.getStatus();
    return {
      ...status,
      packId: this.current.packId,
      modelId: status.modelId ?? this.current.modelId,
    };
  }

  async start({
    packId,
    threads = null,
    binaryPath = null,
    idleTimeoutMs = null,
    startupTimeoutMs = null,
    modelDir = null,
  } = {}) {
    const installed = await readInstalledPack(this.home, packId, { dir: modelDir });
    if (!installed.installed) {
      throw new InferenceError('not_installed', `模型包未安装：${packId}`, {
        status: 409,
        details: { pack: packId },
      });
    }
    if (!installed.manifest) {
      throw new InferenceError('model_corrupt', `模型包缺少有效 manifest：${packId}`, {
        status: 409,
        details: { pack: packId, errors: installed.errors },
      });
    }
    const modelPath = findModelFilePath(installed.manifest, installed.dir);
    if (!modelPath) {
      throw new InferenceError('model_corrupt', `模型包没有可加载文件：${packId}`, {
        status: 409,
        details: { pack: packId },
      });
    }

    if (this.current) {
      const currentStatus = this.current.engine.getStatus();
      if (this.current.packId === packId && isRunning(currentStatus)) {
        return { ...this.getStatus(), alreadyRunning: true };
      }
      if (this.current.packId !== packId || !isRunning(currentStatus)) {
        try {
          await this.current.engine.stop?.();
        } catch {
          // 旧实例停止失败不应阻止用户显式启动新实例；旧 pid 由 engine 自身熔断记录。
        }
      }
      if (this.current.packId !== packId) this.current = null;
    }

    const engine = this.engineFactoryFor()({
      modelPath,
      modelId: installed.manifest.modelId,
      binaryPath: binaryPath ?? this.defaultBinary(),
      contextSize: installed.manifest.context.length,
      threads: threads ?? installed.manifest.runtime.threads ?? 4,
      idleTimeoutMs: idleTimeoutMs ?? this.idleTimeoutMs,
      startupTimeoutMs: startupTimeoutMs ?? this.startupTimeoutMs,
      autoIdleCheck: true,
      ...(this.sleep ? { sleep: this.sleep } : {}),
    });

    this.current = {
      packId,
      modelPath,
      modelId: installed.manifest.modelId,
      engine,
    };
    // 显式 start 允许从 crashed/circuit_open 恢复；运行时自动调用不会经过这里。
    if (typeof engine.resetCircuit === 'function') engine.resetCircuit();
    try {
      await engine.start();
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'engine_unavailable';
      throw new InferenceError(
        code === 'circuit_open' ? 'circuit_open' : 'engine_unavailable',
        code === 'circuit_open'
          ? '本地模型崩溃熔断已打开；请先显式停止/重置后再试'
          : `本地模型启动失败：${String(error?.message ?? error)}`,
        {
          status: code === 'circuit_open' ? 409 : 503,
          retryable: false,
          details: { pack: packId, engineCode: code },
        },
      );
    }
    return { ...this.getStatus(), alreadyRunning: false };
  }

  async stop(packId = null) {
    if (!this.current) return { stopped: false, packId: null, state: 'stopped' };
    if (packId !== null && this.current.packId !== packId) {
      return { stopped: false, packId, state: this.getStatus().state };
    }
    const stoppedPack = this.current.packId;
    try {
      await this.current.engine.stop?.();
    } catch (error) {
      throw new InferenceError('engine_stop_failed', `本地模型停止失败：${String(error?.message ?? error)}`, {
        status: 500,
        retryable: true,
        details: { pack: stoppedPack },
      });
    }
    return { stopped: true, packId: stoppedPack, state: this.current?.engine?.getStatus?.().state ?? 'stopped' };
  }

  /**
   * 最小 self-test：启动（必要时）→ 固定短 prompt → 校验 JSON → 若本次启动则停止。
   * 不返回引擎 token、prompt 或完整响应。
   */
  async test({ packId, threads = null, binaryPath = null, timeoutMs = null, prompt = null, modelDir = null } = {}) {
    const before = this.current?.packId === packId ? this.getStatus() : null;
    const startedHere = before?.state !== 'running';
    const start = await this.start({ packId, threads, binaryPath, modelDir });
    let connection;
    try {
      connection = await this.current.engine.acquire();
      const gateway = this.gatewayFactoryFor()({
        baseUrl: connection.baseUrl,
        model: connection.modelId ?? this.current.modelId ?? 'local',
        apiKey: connection.apiKey,
        timeoutMs: Math.max(1, timeoutMs ?? this.testTimeoutMs),
        maxRetries: 0,
        now: this.now,
        ...(this.sleep ? { sleep: this.sleep } : {}),
      });
      const userPrompt = typeof prompt === 'string' && prompt.trim().length > 0
        ? prompt.trim().slice(0, 200)
        : 'Mebular local model self-test. Reply with {"ok":true}.';
      const outcome = await gateway.completeJson(
        {
          messages: [
            {
              role: 'system',
              content: 'You are a local model self-test. Return only the requested tiny JSON object.',
            },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0,
          maxTokens: 16,
          responseSchema: {
            name: 'mebular_model_self_test',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['ok'],
              properties: { ok: { type: 'boolean' } },
            },
          },
        },
        () => ({ ok: false }),
      );
      const ok = outcome.ok === true && outcome.data?.ok === true;
      if (!ok) {
        const reason = outcome.ok === false ? outcome.error?.code ?? 'model_test_failed' : 'model_invalid_response';
        throw new InferenceError('model_test_failed', '本地模型 self-test 未通过', {
          status: 503,
          retryable: reason === 'timeout' || reason === 'network',
          details: { pack: packId, reason, attempts: outcome.attempts ?? 0 },
        });
      }
      return {
        ok: true,
        pack: packId,
        model: connection.modelId ?? this.current.modelId,
        latencyMs: outcome.latencyMs,
        attempts: outcome.attempts,
        startedByTest: startedHere,
        ...(start.alreadyRunning ? { alreadyRunning: true } : {}),
      };
    } finally {
      if (startedHere) {
        try {
          await this.current?.engine.stop?.();
        } catch {
          // self-test 结束后即使停止失败也不掩盖测试结果；daemon close 会再次清理。
        }
      }
    }
  }

  async dispose() {
    const current = this.current;
    this.current = null;
    if (current) {
      try {
        await current.engine.stop?.();
      } catch {
        // 关闭路径不抛出：避免阻止 daemon 退出。
      }
    }
  }
}

export function createInferenceEngineManager(options) {
  return new InferenceEngineManager(options);
}
