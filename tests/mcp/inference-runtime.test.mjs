// inference.json/config 与 Runtime 模型源的关系：选择写入 runtime.model.local.pack/path；
// 显式选择失败不静默换模型（local 已配置但不可用时仍 degraded，不切 api/heuristic 冒充成功）。

import { describe, it, expect, afterEach } from '@jest/globals';
import { join } from 'node:path';
import { createRuntimeModelRuntime, normalizeRuntimeSettings } from '@mebular/memory-runtime';
import { createInferenceManager } from '../../packages/mcp/src/inference-admin.mjs';
import { readDeviceConfig } from '../../packages/mcp/src/inference-store.mjs';
import {
  PACK_4B,
  cleanupDirs,
  makeManifest,
  tempDir,
  writeImportPack,
} from '../../packages/memory-runtime/tests/inference/mcp-helpers.mjs';

const tempDirs = [];

afterEach(async () => {
  await cleanupDirs(tempDirs);
});

async function setup() {
  const home = await tempDir('mebular-inference-runtime-');
  const source = await tempDir('mebular-inference-runtime-src-');
  tempDirs.push(home, source);
  await writeImportPack(source, makeManifest());
  const manager = createInferenceManager({ home });
  await manager.importPack({ path: source });
  await manager.select({ pack: PACK_4B, source: 'local' });
  await manager.dispose();
  return home;
}

describe('Runtime model.local 与设备 store', () => {
  it('select 后 Runtime 能解析 <home>/models/<pack>', async () => {
    const home = await setup();
    const config = await readDeviceConfig(home);
    const settings = normalizeRuntimeSettings(config.runtime);
    expect(settings.model).toMatchObject({
      source: 'local',
      local: {
        pack: PACK_4B,
        path: join(home, 'models', PACK_4B),
      },
    });
    const runtime = createRuntimeModelRuntime(settings.model, {
      runtimeDir: join(home, 'runtime'),
      sleep: async () => undefined,
    });
    const probe = await runtime.probe();
    expect(probe.local).toMatchObject({
      configured: true,
      available: true,
      pack: PACK_4B,
    });
    await runtime.dispose();
  });

  it('显式 pack 指向不存在目录时 unavailable，不会改选其他已安装包', async () => {
    const home = await setup();
    const settings = normalizeRuntimeSettings({
      model: {
        source: 'local',
        local: { pack: 'qwen3.5-9b-instruct-q4_k_m', path: null, threads: 4 },
      },
    });
    const runtime = createRuntimeModelRuntime(settings.model, {
      runtimeDir: join(home, 'runtime'),
      sleep: async () => undefined,
    });
    const probe = await runtime.probe();
    expect(probe.local).toMatchObject({
      configured: true,
      available: false,
      reason: 'model_not_found',
      pack: 'qwen3.5-9b-instruct-q4_k_m',
    });
    expect(probe.local.warnings).toContain('model_local_not_found');
    await runtime.dispose();
  });
});
