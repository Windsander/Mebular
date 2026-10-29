// Engine supervisor 包装：按需 start/stop、self-test 小数据、token 不出状态、失败结构化。
// 使用假 engine/gateway；不启动真实 llama-server。

import { describe, it, expect, afterEach } from '@jest/globals';
import { createInferenceManager } from '../../packages/mcp/src/inference-admin.mjs';
import {
  PACK_4B,
  cleanupDirs,
  makeManifest,
  tempDir,
  writeImportPack,
} from '../inference/mcp-helpers.mjs';

const tempDirs = [];
const SECRET = 'engine-token-never-returned';

afterEach(async () => {
  await cleanupDirs(tempDirs);
});

async function setup({ failStart = false } = {}) {
  const home = await tempDir('mebular-inference-engine-');
  const source = await tempDir('mebular-inference-engine-src-');
  tempDirs.push(home, source);
  await writeImportPack(source, makeManifest());
  const manager = createInferenceManager({ home });
  await manager.importPack({ path: source });

  const calls = { start: 0, stop: 0, acquire: 0, reset: 0, gateway: 0 };
  let state = failStart ? 'crashed' : 'stopped';
  const engine = {
    async start() {
      calls.start += 1;
      if (failStart) throw Object.assign(new Error('boom'), { code: 'startup_timeout' });
      state = 'running';
      return { baseUrl: 'http://127.0.0.1:12345/v1', apiKey: SECRET, modelId: 'qwen3.5-4b-instruct', port: 12345 };
    },
    async acquire() {
      calls.acquire += 1;
      return { baseUrl: 'http://127.0.0.1:12345/v1', apiKey: SECRET, modelId: 'qwen3.5-4b-instruct', port: 12345 };
    },
    getStatus() {
      return {
        state,
        health: state === 'running' ? 'ok' : 'unknown',
        crashCount: 0,
        restartCount: 0,
        ...(state === 'running' ? { port: 12345, baseUrl: 'http://127.0.0.1:12345/v1' } : {}),
      };
    },
    resetCircuit() {
      calls.reset += 1;
      state = 'stopped';
    },
    async stop() {
      calls.stop += 1;
      state = 'stopped';
    },
  };
  const gateway = {
    isCircuitOpen: () => false,
    async completeJson(request) {
      calls.gateway += 1;
      expect(request.maxTokens).toBeLessThanOrEqual(16);
      return {
        ok: true,
        data: { ok: true },
        content: '{"ok":true}',
        attempts: 1,
        latencyMs: 7,
        degraded: false,
      };
    },
  };
  const withFakes = createInferenceManager({
    home,
    engineFactory: () => engine,
    gatewayFactory: () => gateway,
  });
  return { home, manager: withFakes, calls };
}

describe('InferenceEngineManager', () => {
  it('显式 start 启动引擎，test 使用极小输出，stop 后无运行实例', async () => {
    const { manager, calls } = await setup();
    const started = await manager.start({ pack: PACK_4B });
    expect(started).toMatchObject({ ok: true, state: 'running', packId: PACK_4B });
    expect(calls.start).toBe(1);
    expect(calls.reset).toBe(1);

    const tested = await manager.test({ pack: PACK_4B });
    expect(tested).toMatchObject({ ok: true, pack: PACK_4B, startedByTest: false });
    expect(calls.gateway).toBe(1);
    expect(JSON.stringify(tested)).not.toContain(SECRET);
    expect(JSON.stringify(manager.engineFor().getStatus())).not.toContain(SECRET);

    const stopped = await manager.stop({ pack: PACK_4B });
    expect(stopped).toMatchObject({ ok: true, stopped: true, pack: PACK_4B });
    expect(calls.stop).toBe(1);
    expect(manager.engineFor().getStatus().state).toBe('stopped');
    await manager.dispose();
  });

  it('test 在未运行时自动启动并在结束后停止（不留孤儿）', async () => {
    const { manager, calls } = await setup();
    const result = await manager.test({ pack: PACK_4B });
    expect(result).toMatchObject({ ok: true, startedByTest: true });
    expect(calls.start).toBe(1);
    expect(calls.stop).toBe(1);
    expect(manager.engineFor().getStatus().state).toBe('stopped');
    await manager.dispose();
  });

  it('启动失败返回结构化 engine_unavailable，不暴露底层 token', async () => {
    const { manager } = await setup({ failStart: true });
    await expect(manager.start({ pack: PACK_4B })).rejects.toMatchObject({
      code: 'engine_unavailable',
      status: 503,
    });
    await expect(manager.test({ pack: PACK_4B })).rejects.toMatchObject({ code: 'engine_unavailable' });
    await manager.dispose();
  });

  it('未安装 / 未选择 / 未知包都返回稳定错误码', async () => {
    const home = await tempDir('mebular-inference-engine-errors-');
    tempDirs.push(home);
    const manager = createInferenceManager({ home });
    await expect(manager.start({})).rejects.toMatchObject({ code: 'no_model_selected' });
    await expect(manager.start({ pack: PACK_4B })).rejects.toMatchObject({ code: 'not_installed' });
    await expect(manager.test({ pack: 'qwen3.5-32b-nope' })).rejects.toMatchObject({ code: 'not_installed' });
    await manager.dispose();
  });
});
