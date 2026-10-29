// 模型存储：断点/If-Range、镜像回退、流式哈希失败、原子安装/回滚、离线导入、卸载。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ModelStore,
  createNodeModelStoreFs,
  type ModelStoreFetch,
  type ModelStoreFs,
} from '../../src/inference/index.js';
import {
  bytesBody,
  failingBody,
  makeManifest,
  response,
  writeImportTree,
} from './helpers.js';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('ModelStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mebular-model-store-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('中断后第二次下载使用 Range + If-Range 并从 partial 续传', async () => {
    const content = Buffer.from('0123456789abcdef'.repeat(8192));
    const prefix = content.subarray(0, 65_536);
    const suffix = content.subarray(65_536);
    const manifest = makeManifest({
      files: [{ path: 'model.gguf', content }],
    });
    const urls: string[] = [];
    let call = 0;
    const fetchImpl: ModelStoreFetch = async (url, init) => {
      call += 1;
      urls.push(url);
      if (call === 1) {
        expect(init?.headers?.Range).toBeUndefined();
        return response(200, failingBody(prefix, new Error('connection dropped')), {
          etag: '"v1"',
        });
      }
      expect(init?.headers?.Range).toBe(`bytes=${prefix.length}-`);
      expect(init?.headers?.['If-Range']).toBe('"v1"');
      return response(206, bytesBody(suffix), {
        etag: '"v1"',
        'content-range': `bytes ${prefix.length}-${content.length - 1}/${content.length}`,
      });
    };

    const store = new ModelStore({
      rootDir: root,
      fetch: fetchImpl,
      now: () => 1000,
      nonce: () => 'fixed',
    });

    await expect(store.download(manifest, { mirrors: ['https://mirror.test/pack'] }))
      .rejects.toMatchObject({ code: 'download_failed' });
    expect(store.getDownloadStatus(manifest.packId)).toMatchObject({
      state: 'failed',
      downloadedBytes: prefix.length,
    });
    expect(await exists(join(root, manifest.packId))).toBe(false);

    const result = await store.download(manifest, { mirrors: ['https://mirror.test/pack'] });
    expect(result.resumedBytes).toBe(prefix.length);
    expect(urls).toHaveLength(2);
    expect(await readFile(join(root, manifest.packId, 'model.gguf'))).toEqual(content);
    expect((await store.verify(manifest.packId)).ok).toBe(true);
    expect(await store.getModelStatus(manifest.packId)).toMatchObject({
      state: 'installed',
      modelId: manifest.modelId,
    });
  });

  it('同一 pack 的新 manifest 不复用旧版本的 partial', async () => {
    const oldContent = Buffer.from('old-version-content');
    const newContent = Buffer.from('new-version-content');
    expect(newContent.length).toBe(oldContent.length);
    const oldManifest = makeManifest({ files: [{ path: 'model.gguf', content: oldContent }] });
    const newManifest = makeManifest({ files: [{ path: 'model.gguf', content: newContent }] });
    let call = 0;
    const fetchImpl: ModelStoreFetch = async (_url, init) => {
      call += 1;
      if (call === 1) {
        return response(200, failingBody(oldContent.subarray(0, 4), new Error('dropped')), {
          etag: '"old"',
        });
      }
      expect(init?.headers?.Range).toBeUndefined();
      return response(200, bytesBody(newContent), { etag: '"new"' });
    };
    const store = new ModelStore({ rootDir: root, fetch: fetchImpl, nonce: () => 'fixed' });

    await expect(store.download(oldManifest, { mirrors: ['https://mirror.test'] }))
      .rejects.toMatchObject({ code: 'download_failed' });
    await store.download(newManifest, { mirrors: ['https://mirror.test'] });
    expect(await readFile(join(root, newManifest.packId, 'model.gguf'))).toEqual(newContent);
  });

  it('镜像回退：首个镜像 500，第二个镜像成功', async () => {
    const content = Buffer.from('mirror-fallback');
    const manifest = makeManifest({ files: [{ path: 'model.gguf', content }] });
    const urls: string[] = [];
    const fetchImpl: ModelStoreFetch = async (url) => {
      urls.push(url);
      if (url.startsWith('https://bad.test/')) return response(500, null);
      return response(200, bytesBody(content));
    };
    const store = new ModelStore({ rootDir: root, fetch: fetchImpl, nonce: () => 'fixed' });

    const result = await store.download(manifest, {
      mirrors: ['https://bad.test/base', 'https://good.test/base'],
    });
    expect(result.path).toBe(join(root, manifest.packId));
    expect(urls).toEqual([
      'https://bad.test/base/model.gguf',
      'https://good.test/base/model.gguf',
    ]);
    expect(await readFile(join(result.path, 'model.gguf'))).toEqual(content);
  });

  it('流式 SHA256 不匹配：拒绝安装并清理 partial', async () => {
    const expected = Buffer.from('expected');
    const actual = Buffer.from('tampered');
    expect(actual.length).toBe(expected.length);
    const manifest = makeManifest({ files: [{ path: 'model.gguf', content: expected }] });
    const fetchImpl: ModelStoreFetch = async () => response(200, bytesBody(actual));
    const store = new ModelStore({ rootDir: root, fetch: fetchImpl, nonce: () => 'fixed' });

    await expect(store.download(manifest, { mirrors: ['https://mirror.test'] }))
      .rejects.toMatchObject({ code: 'checksum_mismatch' });
    expect(await exists(join(root, manifest.packId))).toBe(false);
    expect(store.getDownloadStatus(manifest.packId)?.state).toBe('failed');
  });

  it('原子覆盖：提交 rename 失败时回滚到旧安装', async () => {
    const oldManifest = makeManifest({
      files: [{ path: 'model.gguf', content: 'old-content' }],
    });
    const oldStore = new ModelStore({
      rootDir: root,
      nonce: () => 'old',
      fetch: async () => response(200, bytesBody('old-content')),
    });
    await oldStore.download(oldManifest, { mirrors: ['https://mirror.test'] });

    const newManifest = makeManifest({
      files: [{ path: 'model.gguf', content: 'new-content' }],
    });
    const baseFs = createNodeModelStoreFs();
    let failNextCommit = true;
    const flakyFs: ModelStoreFs = {
      ...baseFs,
      async rename(from, to) {
        if (failNextCommit && from.includes(`${join(root, '.staging')}`)) {
          failNextCommit = false;
          throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
        }
        return baseFs.rename(from, to);
      },
    };
    const newStore = new ModelStore({
      rootDir: root,
      fs: flakyFs,
      nonce: () => 'new',
      fetch: async () => response(200, bytesBody('new-content')),
    });

    await expect(newStore.download(newManifest, { mirrors: ['https://mirror.test'], force: true }))
      .rejects.toMatchObject({ code: 'download_failed' });
    expect(await readFile(join(root, newManifest.packId, 'model.gguf'), 'utf8')).toBe('old-content');
    expect((await oldStore.verify(oldManifest.packId)).ok).toBe(true);
    expect(newStore.getDownloadStatus(newManifest.packId)?.state).toBe('failed');
  });

  it('离线导入目录：校验后安装；哈希错误拒绝；卸载幂等', async () => {
    const content = 'imported-bytes';
    const manifest = makeManifest({ files: [{ path: 'model.gguf', content }] });
    const sourceDir = join(root, 'offline-good');
    await writeImportTree(sourceDir, manifest, { 'model.gguf': content });

    const store = new ModelStore({ rootDir: root, nonce: () => 'import' });
    const result = await store.importDirectory({ sourceDir });
    expect(result.path).toBe(join(root, manifest.packId));
    expect(await readFile(join(result.path, 'model.gguf'), 'utf8')).toBe(content);
    expect((await store.verify(manifest.packId)).ok).toBe(true);

    await expect(store.importDirectory({ sourceDir })).rejects.toMatchObject({ code: 'install_exists' });

    const tamperedManifest = makeManifest({ packId: 'tampered-pack', files: [{ path: 'model.gguf', content: 'original' }] });
    const tamperedDir = join(root, 'offline-bad');
    await writeImportTree(tamperedDir, tamperedManifest, { 'model.gguf': 'tampered' });
    await expect(store.importDirectory({ sourceDir: tamperedDir }))
      .rejects.toMatchObject({ code: 'checksum_mismatch' });
    expect(await exists(join(root, 'tampered-pack'))).toBe(false);

    expect(await store.uninstall(manifest.packId)).toMatchObject({ removed: true });
    expect(await store.uninstall(manifest.packId)).toMatchObject({ removed: false });
    await expect(store.verify(manifest.packId)).rejects.toMatchObject({ code: 'not_installed' });
    expect((await store.getModelStatus(manifest.packId)).state).toBe('not_installed');
  });

  it('没有镜像/URL 时明确失败，不编造下载源', async () => {
    const manifest = makeManifest();
    const store = new ModelStore({ rootDir: root, fetch: async () => response(200, null) });
    await expect(store.download(manifest)).rejects.toMatchObject({ code: 'no_source' });
    expect(await exists(join(root, manifest.packId))).toBe(false);
  });

  it('导入缺少 manifest 时不安装', async () => {
    const sourceDir = join(root, 'empty-import');
    await mkdir(sourceDir, { recursive: true });
    const store = new ModelStore({ rootDir: root });
    await expect(store.importDirectory({ sourceDir })).rejects.toMatchObject({ code: 'manifest_missing' });
  });
});
