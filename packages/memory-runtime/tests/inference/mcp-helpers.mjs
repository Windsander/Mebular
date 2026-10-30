// tests/mcp/inference* 共用夹具：只写小文件，不下载真实模型、不启动真实 llama-server。

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PACK_4B = 'qwen3.5-4b-instruct-q4_k_m';
export const PACK_9B = 'qwen3.5-9b-instruct-q4_k_m';
export const PACK_27B = 'qwen3.5-27b-instruct-q4_k_m';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export async function tempDir(prefix = 'mebular-inference-') {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanupDirs(dirs) {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export function makeManifest({ packId = PACK_4B, modelId = 'qwen3.5-4b-instruct', content = 'tiny-model-bytes', files = null } = {}) {
  const data = typeof content === 'string' ? Buffer.from(content) : content;
  const list = files ?? [{ path: 'model.gguf', content: data }];
  return {
    schema: 1,
    modelId,
    packId,
    displayName: 'Test Qwen pack',
    description: 'fixture',
    format: 'gguf',
    quantization: 'Q4_K_M',
    files: list.map((file) => ({
      path: file.path,
      sizeBytes: Buffer.byteLength(file.content),
      sha256: sha256(file.content),
    })),
    license: { id: 'apache-2.0' },
    requirements: {
      platforms: ['darwin', 'win32', 'linux'],
      minMemoryBytes: 1,
      recommendedMemoryBytes: 1,
      minDiskBytes: 1,
      gpu: 'optional',
    },
    context: { length: 4096, defaultMaxOutputTokens: 256 },
    runtime: { engine: 'llama-server', threads: 2 },
    source: { kind: 'local' },
  };
}

export async function writeImportPack(root, manifest = makeManifest(), contents = null) {
  const payload = contents ?? { 'model.gguf': 'tiny-model-bytes' };
  for (const [relative, content] of Object.entries(payload)) {
    const target = join(root, ...relative.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function putManifest(home, manifest) {
  const dir = join(home, 'models', 'manifests');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${manifest.packId}.json`);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

export async function fileMode(path) {
  const info = await stat(path);
  return info.mode & 0o777;
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}
