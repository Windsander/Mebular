// 引擎 adapter：单实例持有、切换 pack 停旧引擎、失败结构化、视图脱敏。

import { describe, expect, it } from '@jest/globals';
import type { EngineConnection, LlamaServerEngineOptions } from '../../src/inference/engine.js';
import type { EngineStatus } from '../../src/inference/types.js';
import {
  LlamaCppInferenceEngine,
  type LlamaProcessLike,
} from '../../src/sidecar/inference/engine.js';

const SECRET_PATH = '/secret/models/model.gguf';

function connection(): EngineConnection {
  return {
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'engine-token-secret',
    modelPath: SECRET_PATH,
    port: 1234,
  };
}

function fakeEngine(options: LlamaServerEngineOptions, fail: Error | null = null): LlamaProcessLike & {
  options: LlamaServerEngineOptions;
  stopped: number;
  acquired: number;
} {
  let running = false;
  return {
    options,
    stopped: 0,
    acquired: 0,
    async acquire() {
      this.acquired += 1;
      if (fail) throw fail;
      running = true;
      return connection();
    },
    getStatus(): EngineStatus {
      return {
        state: fail ? 'crashed' : running ? 'running' : 'stopped',
        health: fail ? 'unhealthy' : running ? 'ok' : 'unknown',
        crashCount: 0,
        restartCount: 0,
        modelPath: SECRET_PATH,
        baseUrl: 'http://127.0.0.1:1234/v1',
        lastError: fail ? { code: 'startup_timeout', message: `failed at ${SECRET_PATH}` } : undefined,
      };
    },
    async stop() {
      this.stopped += 1;
      running = false;
    },
  };
}

describe('LlamaCppInferenceEngine', () => {
  it('start 启动引擎并在 view 中去掉路径/baseUrl/引擎 token', async () => {
    const created: Array<ReturnType<typeof fakeEngine>> = [];
    const adapter = new LlamaCppInferenceEngine({
      engineFactory: (options) => {
        const engine = fakeEngine(options);
        created.push(engine);
        return engine;
      },
      now: () => 1000,
    });

    const view = await adapter.start({
      packId: 'pack',
      modelPath: SECRET_PATH,
      modelId: 'model',
      contextSize: 2048,
      threads: 2,
    });
    expect(view).toMatchObject({
      state: 'running',
      health: 'ok',
      packId: 'pack',
      modelId: 'model',
    });
    expect(JSON.stringify(view)).not.toContain(SECRET_PATH);
    expect(JSON.stringify(view)).not.toContain('engine-token-secret');
    expect(created[0]?.options).toMatchObject({
      modelPath: SECRET_PATH,
      modelId: 'model',
      contextSize: 2048,
      threads: 2,
    });
    expect(created[0]?.acquired).toBe(1);
  });

  it('启动失败返回结构化 engine_unavailable，并清理半启动引擎', async () => {
    const created: Array<ReturnType<typeof fakeEngine>> = [];
    const adapter = new LlamaCppInferenceEngine({
      engineFactory: (options) => {
        const engine = fakeEngine(options, Object.assign(new Error('timeout'), { code: 'startup_timeout' }));
        created.push(engine);
        return engine;
      },
    });
    await expect(adapter.start({
      packId: 'pack',
      modelPath: SECRET_PATH,
      modelId: 'model',
    })).rejects.toMatchObject({
      code: 'engine_unavailable',
      status: 503,
      options: { details: { engineCode: 'startup_timeout' } },
    });
    expect(created[0]?.stopped).toBe(1);
    expect(adapter.getView()).toMatchObject({ state: 'stopped', lastError: null });
  });

  it('切换 pack/path 会先停旧引擎，最多持有一个子进程', async () => {
    const created: Array<ReturnType<typeof fakeEngine>> = [];
    const adapter = new LlamaCppInferenceEngine({
      engineFactory: (options) => {
        const engine = fakeEngine(options);
        created.push(engine);
        return engine;
      },
    });
    await adapter.start({ packId: 'pack-a', modelPath: '/a/model.gguf', modelId: 'a' });
    await adapter.start({ packId: 'pack-b', modelPath: '/b/model.gguf', modelId: 'b' });
    expect(created).toHaveLength(2);
    expect(created[0]?.stopped).toBe(1);
    expect(adapter.getView()).toMatchObject({ packId: 'pack-b', modelId: 'b', state: 'running' });
  });

  it('asModelEngine 按 modelPath 懒启动；stop/dispose 清理引擎', async () => {
    let created = 0;
    const adapter = new LlamaCppInferenceEngine({
      engineFactory: (options) => {
        created += 1;
        return fakeEngine(options);
      },
    });
    const facade = adapter.asModelEngine();
    const acquired = await facade.acquire({ modelPath: '/custom/model.gguf', modelId: 'custom' });
    expect(acquired.baseUrl).toContain('127.0.0.1');
    expect(created).toBe(1);
    expect(facade.getStatus().state).toBe('running');
    await adapter.stop();
    expect(facade.getStatus().state).toBe('stopped');
    await adapter.dispose();
    expect(adapter.getView()).toMatchObject({ state: 'stopped', packId: null });
  });

  it('requireBinaryPath 时没有 EngineInstaller 路径就拒绝 spawn', async () => {
    let created = 0;
    const adapter = new LlamaCppInferenceEngine({
      requireBinaryPath: true,
      engineFactory: (options) => {
        created += 1;
        return fakeEngine(options);
      },
    });
    await expect(adapter.start({
      packId: 'pack',
      modelPath: SECRET_PATH,
      modelId: 'model',
    })).rejects.toMatchObject({
      code: 'engine_not_installed',
      status: 503,
    });
    expect(created).toBe(0);
    expect(adapter.getView()).toMatchObject({ state: 'stopped' });
  });

  it('启动过程中 stop 不会等待自身而死锁', async () => {
    let release!: (value: EngineConnection) => void;
    const adapter = new LlamaCppInferenceEngine({
      engineFactory: (options) => ({
        ...fakeEngine(options),
        acquire: () => new Promise<EngineConnection>((resolve) => { release = resolve; }),
      }),
    });
    const starting = adapter.start({ packId: 'pack', modelPath: SECRET_PATH, modelId: 'model' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stopping = adapter.stop();
    release(connection());
    await starting;
    await stopping;
    expect(adapter.getView()).toMatchObject({ state: 'stopped' });
  });
});
