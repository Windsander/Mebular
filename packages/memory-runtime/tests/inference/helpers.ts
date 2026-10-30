// tests/inference 共用夹具：不访问网络，不启动真实模型。

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  FetchResponseLike,
  ModelManifest,
  ModelFile,
  HardwareProfile,
} from '../../src/index.js';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface ManifestFileInput {
  path: string;
  content: string | Uint8Array;
}

export function makeManifest(options: {
  packId?: string;
  modelId?: string;
  files?: ManifestFileInput[];
  quantization?: string;
  requirements?: Partial<ModelManifest['requirements']>;
  contextLength?: number;
} = {}): ModelManifest {
  const packId = options.packId ?? 'test-pack-q4';
  const modelId = options.modelId ?? 'test-model';
  const inputs = options.files ?? [{ path: 'model.gguf', content: 'test-model-bytes' }];
  const files: ModelFile[] = inputs.map((input) => ({
    path: input.path,
    sizeBytes: typeof input.content === 'string' ? Buffer.byteLength(input.content) : input.content.byteLength,
    sha256: sha256(input.content),
  }));
  return {
    schema: 1,
    modelId,
    packId,
    displayName: 'Test Model',
    description: 'fixture',
    format: 'gguf',
    quantization: options.quantization ?? 'Q4_K_M',
    files,
    license: { id: 'apache-2.0' },
    requirements: {
      platforms: ['darwin', 'win32', 'linux'],
      minMemoryBytes: 8 * 1024 ** 3,
      recommendedMemoryBytes: 16 * 1024 ** 3,
      minDiskBytes: 4 * 1024 ** 3,
      gpu: 'optional',
      ...options.requirements,
    },
    context: { length: options.contextLength ?? 32768, defaultMaxOutputTokens: 1024 },
    runtime: { engine: 'llama-server', threads: 4 },
    source: {
      kind: 'repo',
      repository: { provider: 'huggingface', repo: 'example/test-gguf', revision: 'main' },
    },
  };
}

export function makeHardware(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    platform: 'darwin',
    arch: 'arm64',
    osVersion: 'test',
    cpuModel: 'Apple M3',
    cpuCores: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeMemoryBytes: 8 * 1024 ** 3,
    disk: { path: '/tmp', availableBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
    gpu: { vendor: 'apple', name: 'Apple M3', unifiedMemory: true },
    detectedAt: 0,
    warnings: [],
    ...overrides,
  };
}

export function headerMap(headers: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    get(name: string) {
      return lower.get(name.toLowerCase()) ?? null;
    },
  };
}

export function bytesBody(...chunks: Array<string | Uint8Array>): AsyncIterable<Uint8Array> {
  return (async function* generate() {
    for (const chunk of chunks) {
      yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    }
  })();
}

export function failingBody(prefix: string | Uint8Array, error: Error): AsyncIterable<Uint8Array> {
  return (async function* generate() {
    yield typeof prefix === 'string' ? Buffer.from(prefix) : prefix;
    throw error;
  })();
}

export function response(
  status: number,
  body: AsyncIterable<Uint8Array> | string | Uint8Array | null,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const stream = typeof body === 'string' || body instanceof Uint8Array || body === null
    ? (body === null ? null : bytesBody(body))
    : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerMap(headers),
    body: stream,
  };
}

export async function writeImportTree(
  root: string,
  manifest: ModelManifest,
  contents: Record<string, string | Uint8Array>,
  writeManifest = true,
): Promise<void> {
  for (const [relative, content] of Object.entries(contents)) {
    const target = join(root, ...relative.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  if (writeManifest) {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
