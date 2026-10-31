// 设备级 model store：<home>/inference.json + <home>/models，catalog 只读精选三项。
// 不写 graph/event log；状态文件不包含模型字节或密钥。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ensureInferenceStore,
  loadModelCatalog,
  readInferenceState,
  resolveManifestForPack,
  resolveModelSettings,
  writeInferenceState,
} from '../../packages/mcp/src/inference-store.mjs';
import { createInferenceManager } from '../../packages/mcp/src/inference-admin.mjs';
import {
  PACK_4B,
  PACK_27B,
  PACK_9B,
  cleanupDirs,
  fileMode,
  makeManifest,
  putManifest,
  tempDir,
  writeImportPack,
} from '../../packages/memory-runtime/tests/inference/mcp-helpers.mjs';

const tempDirs = [];

afterEach(async () => {
  await cleanupDirs(tempDirs);
});

async function homeDir() {
  const dir = await tempDir('mebular-inference-store-');
  tempDirs.push(dir);
  return dir;
}

describe('设备级 model store 初始化', () => {
  it('创建 <home>/models 与 0600 inference.json，且不创建记忆存储', async () => {
    const home = await homeDir();
    const paths = await ensureInferenceStore(home);
    expect(paths.modelsDir).toBe(join(home, 'models'));
    expect(paths.statePath).toBe(join(home, 'inference.json'));
    if (process.platform !== 'win32') {
      expect(await fileMode(paths.modelsDir)).toBe(0o700);
      expect(await fileMode(paths.statePath)).toBe(0o600);
    }
    const state = JSON.parse(await readFile(paths.statePath, 'utf-8'));
    expect(state).toMatchObject({ schema: 1, selectedPack: null, downloads: {}, installs: {} });
    expect(JSON.stringify(state)).not.toContain('model.gguf');
    // 设备 store 不 import 图；初始化不产生 store.jsonl / events。
    await expect(readFile(join(home, 'store.jsonl'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('损坏的 inference.json 不被覆盖，读取返回结构化 stateError', async () => {
    const home = await homeDir();
    await writeFile(join(home, 'inference.json'), '{ broken', 'utf-8');
    const read = await readInferenceState(home, { init: false });
    expect(read.stateError).toMatchObject({ code: 'inference_state_invalid' });
    expect(read.warnings).toContain('inference_state_invalid');
    expect(await readFile(join(home, 'inference.json'), 'utf-8')).toBe('{ broken');
  });

  it('中断遗留的 downloading 归一为 paused', async () => {
    const home = await homeDir();
    await writeFile(join(home, 'inference.json'), JSON.stringify({
      schema: 1,
      selectedPack: PACK_4B,
      downloads: { [PACK_4B]: { state: 'downloading', downloadedBytes: 3, totalBytes: 9 } },
    }), 'utf-8');
    const read = await readInferenceState(home, { init: false });
    expect(read.state.downloads[PACK_4B]).toMatchObject({ state: 'paused', reason: 'process_interrupted' });
    expect(read.warnings).toContain(`download_interrupted:${PACK_4B}`);
  });
});

describe('catalog 与选择关系', () => {
  it('精选目录固定 9B/27B/4B，不含 32B；manifest 只接受三项', async () => {
    const home = await homeDir();
    const catalog = await loadModelCatalog(home);
    expect(catalog.packs.map((pack) => pack.packId)).toEqual([PACK_9B, PACK_27B, PACK_4B]);
    expect(JSON.stringify(catalog.packs)).not.toMatch(/32b/i);
    for (const pack of catalog.packs) {
      expect(pack.source.repository.repo).toMatch(/^Qwen\/Qwen3\.5-(4B|9B|27B)-GGUF$/);
      expect(pack.manifest).toBeUndefined();
    }
    await expect(resolveManifestForPack({ home, packId: PACK_9B, catalog }))
      .rejects.toMatchObject({ code: 'manifest_missing' });
  });

  it('config 显式 pack 优先于 inference.selectedPack；否则使用设备选择', async () => {
    const home = await homeDir();
    const preloaded = makeManifest();
    await putManifest(home, preloaded);
    const base = {
      config: { runtime: { model: { source: 'local', local: { pack: null, path: null, threads: 6 } } } },
      state: { selectedPack: PACK_4B },
      home,
    };
    expect(resolveModelSettings(base)).toMatchObject({
      pack: PACK_4B,
      path: join(home, 'models', PACK_4B),
      threads: 6,
      selectionSource: 'inference',
    });
    expect(resolveModelSettings({
      ...base,
      config: { runtime: { model: { source: 'local', local: { pack: PACK_9B, path: '/custom' } } } },
    })).toMatchObject({
      pack: PACK_9B,
      path: '/custom',
      selectionSource: 'config',
    });
  });

  it('select 要求已安装，并同时写 inference.json 与 runtime.model.local', async () => {
    const home = await homeDir();
    const source = await tempDir('mebular-inference-src-');
    tempDirs.push(source);
    await writeImportPack(source, makeManifest());
    const manager = createInferenceManager({ home });
    await expect(manager.select({ pack: PACK_4B })).rejects.toMatchObject({ code: 'not_installed' });
    await manager.importPack({ path: source });

    const result = await manager.select({ pack: PACK_4B });
    expect(result).toMatchObject({ ok: true, selectedPack: PACK_4B, requiresRestart: false });
    expect(result.runtime).toMatchObject({
      source: 'local',
      pack: PACK_4B,
      path: join(home, 'models', PACK_4B),
      selectionSource: 'config',
    });

    const state = JSON.parse(await readFile(join(home, 'inference.json'), 'utf-8'));
    expect(state.selectedPack).toBe(PACK_4B);
    expect(JSON.stringify(state)).not.toContain('tiny-model-bytes');
    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf-8'));
    expect(config.runtime.model.local).toMatchObject({
      pack: PACK_4B,
      path: join(home, 'models', PACK_4B),
    });
    expect(JSON.stringify(config)).not.toMatch(/apiKey|sk-/i);
    await manager.dispose();
  });

  it('uninstall 默认拒绝删除被选择的包；force 同时清空选择与 config', async () => {
    const home = await homeDir();
    const source = await tempDir('mebular-inference-src-');
    tempDirs.push(source);
    await writeImportPack(source, makeManifest());
    const manager = createInferenceManager({ home });
    await manager.importPack({ path: source });
    await manager.select({ pack: PACK_4B, source: 'local' });

    await expect(manager.remove({ pack: PACK_4B })).rejects.toMatchObject({ code: 'selection_in_use' });
    const removed = await manager.remove({ pack: PACK_4B, force: true });
    expect(removed).toMatchObject({ ok: true, removed: true, pack: PACK_4B, selectionCleared: true });
    const state = JSON.parse(await readFile(join(home, 'inference.json'), 'utf-8'));
    expect(state.selectedPack).toBeNull();
    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf-8'));
    expect(config.runtime.model.local.pack).toBeUndefined();
    await manager.dispose();
  });

  it('writeInferenceState 不接受未知字段进入状态文件', async () => {
    const home = await homeDir();
    await mkdir(join(home, 'models'), { recursive: true });
    const written = await writeInferenceState(home, {
      selectedPack: PACK_4B,
      apiKey: 'sk-never-write',
      nodes: [{ id: 'n1' }],
      unknown: true,
    });
    expect(written).toEqual(expect.objectContaining({ schema: 1, selectedPack: PACK_4B }));
    expect(written.apiKey).toBeUndefined();
    const raw = await readFile(join(home, 'inference.json'), 'utf-8');
    expect(raw).not.toContain('sk-never-write');
    expect(raw).not.toContain('"nodes"');
  });
});
