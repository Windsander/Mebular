// Admin/CLI 共用 manager：mock 小文件下载（Range/暂停/恢复）、离线导入、结构化错误。
// 不访问网络，不下载真实大模型。

import { describe, it, expect, afterEach } from '@jest/globals';
import { join } from 'node:path';
import {
  createInferenceManager,
  handleModelsWrite,
} from '../../packages/mcp/src/inference-admin.mjs';
import {
  PACK_4B,
  PACK_8B,
  cleanupDirs,
  makeManifest,
  putManifest,
  tempDir,
  writeImportPack,
} from '../../packages/memory-runtime/tests/inference/mcp-helpers.mjs';

const tempDirs = [];

afterEach(async () => {
  await cleanupDirs(tempDirs);
});

function response(status, body, headers = {}, signal = null) {
  const stream = (async function* generate() {
    if (signal) {
      yield body;
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', resolve, { once: true });
      });
      throw new Error('connection aborted');
    }
    yield body;
  })();
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: stream,
  };
}

describe('InferenceManager · download/import/remove', () => {
  it('小文件下载成功；manifest 缺失/未安装/选择占用均结构化', async () => {
    const home = await tempDir('mebular-inference-admin-');
    tempDirs.push(home);
    const manifest = makeManifest();
    await putManifest(home, manifest);
    const content = Buffer.from('tiny-model-bytes');
    const manager = createInferenceManager({
      home,
      fetch: async () => response(200, content),
    });

    // 内置 manifest 让所有精选项都可安装；未知 pack 仍在下载前拒绝。
    await expect(manager.download({ pack: 'qwen3.5-9b-instruct-q4_k_m', wait: true }))
      .rejects.toMatchObject({ code: 'unknown_pack' });
    const listedBefore = await manager.list();
    expect(listedBefore.packs.find((pack) => pack.packId === PACK_8B)?.manifestAvailable).toBe(true);

    const downloaded = await manager.download({
      pack: PACK_4B,
      mirrors: ['https://mirror.test/pack'],
      wait: true,
    });
    expect(downloaded).toMatchObject({ ok: true, state: 'installed', pack: PACK_4B });
    const listed = await manager.list();
    expect(listed.packs.find((pack) => pack.packId === PACK_4B)).toMatchObject({
      state: 'installed',
      installed: true,
      manifestAvailable: true,
    });

    await expect(manager.download({ pack: PACK_4B, wait: true }))
      .rejects.toMatchObject({ code: 'install_exists' });

    const removed = await manager.remove({ pack: PACK_4B });
    expect(removed).toMatchObject({ ok: true, removed: true, pack: PACK_4B });
    expect((await manager.list()).packs.find((pack) => pack.packId === PACK_4B).state).toBe('not_installed');
    await manager.dispose();
  });

  it('下载暂停保留 partial，恢复时用 Range 续传并安装', async () => {
    const home = await tempDir('mebular-inference-resume-');
    tempDirs.push(home);
    const content = Buffer.from('0123456789abcdef'.repeat(16));
    const prefix = content.subarray(0, 64);
    const manifest = makeManifest({ files: [{ path: 'model.gguf', content }] });
    await putManifest(home, manifest);

    let call = 0;
    let firstSignal = null;
    const manager = createInferenceManager({
      home,
      fetch: async (_url, init) => {
        call += 1;
        if (call === 1) {
          firstSignal = init.signal;
          return response(200, prefix, { etag: '"v1"' }, init.signal);
        }
        expect(init.headers.Range).toBe(`bytes=${prefix.length}-`);
        expect(init.headers['If-Range']).toBe('"v1"');
        return response(206, content.subarray(prefix.length), {
          etag: '"v1"',
          'content-range': `bytes ${prefix.length}-${content.length - 1}/${content.length}`,
        });
      },
    });

    const started = await manager.download({
      pack: PACK_4B,
      mirrors: ['https://mirror.test/pack'],
      wait: false,
    });
    expect(started).toMatchObject({ ok: true, accepted: true });
    const deadline = Date.now() + 5000;
    while (manager.jobs.get(PACK_4B)?.downloadedBytes === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(firstSignal).not.toBeNull();
    const paused = await manager.pause({ pack: PACK_4B });
    expect(paused).toMatchObject({ ok: true, paused: true });
    expect(paused.job).toMatchObject({ state: 'paused' });

    const resumed = await manager.resume({ pack: PACK_4B, wait: true });
    expect(resumed).toMatchObject({ ok: true, state: 'installed' });
    expect(call).toBe(2);
    await manager.dispose();
  });

  it('cancel 清掉 partial，不再占用下载槽', async () => {
    const home = await tempDir('mebular-inference-cancel-');
    tempDirs.push(home);
    const manifest = makeManifest();
    await putManifest(home, manifest);
    const manager = createInferenceManager({
      home,
      fetch: async (_url, init) => response(200, Buffer.from('tiny-model-bytes'), {}, init.signal),
    });
    await manager.download({ pack: PACK_4B, mirrors: ['https://mirror.test/pack'], wait: false });
    const cancelled = await manager.cancel({ pack: PACK_4B });
    expect(cancelled).toMatchObject({ ok: true, cancelled: true, pack: PACK_4B });
    const state = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(join(home, 'inference.json'), 'utf-8')));
    expect(state.downloads[PACK_4B]).toBeUndefined();
    await manager.dispose();
  });

  it('离线导入只接受精选三项；未知 pack 被拒绝', async () => {
    const home = await tempDir('mebular-inference-import-');
    const source = await tempDir('mebular-inference-import-src-');
    tempDirs.push(home, source);
    await writeImportPack(source, makeManifest());
    const manager = createInferenceManager({ home });
    await expect(manager.importPack({ path: source, pack: 'qwen3-32b-instruct-q4_k_m' }))
      .rejects.toMatchObject({ code: 'manifest_mismatch' });

    const unsupported = await tempDir('mebular-inference-import-32b-');
    tempDirs.push(unsupported);
    await writeImportPack(unsupported, makeManifest({
      packId: 'qwen3-32b-instruct-q4_k_m',
      modelId: 'qwen3-32b-instruct',
    }));
    await expect(manager.importPack({ path: unsupported }))
      .rejects.toMatchObject({ code: 'unknown_pack' });

    const imported = await manager.importPack({ path: source });
    expect(imported).toMatchObject({ ok: true, imported: true, pack: PACK_4B });
    await manager.dispose();
  });
});

describe('handleModelsWrite', () => {
  it('未知 action / 未安装 start 都返回结构化 error.code', async () => {
    const home = await tempDir('mebular-inference-admin-errors-');
    tempDirs.push(home);
    const unknown = await handleModelsWrite({ home, action: 'explode', input: {} });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('unknown_action');

    const start = await handleModelsWrite({ home, action: 'start', input: { pack: PACK_4B } });
    expect(start.status).toBe(409);
    expect(start.body).toMatchObject({
      ok: false,
      error: { code: 'not_installed', retryable: false },
    });
  });
});
