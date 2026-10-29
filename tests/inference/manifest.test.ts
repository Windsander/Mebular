// manifest 校验 + 精选目录边界。

import { describe, it, expect } from '@jest/globals';
import {
  CURATED_MODEL_PACKS,
  DEFAULT_MODEL_PACK_ID,
  ModelCatalogError,
  ModelManifestError,
  createModelCatalog,
  findModelPack,
  getDefaultModelPack,
  parseModelManifest,
  resolveModelManifest,
  validateModelManifest,
} from '../../src/inference/index.js';
import { makeManifest } from './helpers.js';

describe('ModelManifest 校验', () => {
  it('接受完整 manifest，并把 sha256 归一化为小写', () => {
    const manifest = makeManifest({ files: [{ path: 'model.gguf', content: 'hello' }] });
    manifest.files[0]!.sha256 = manifest.files[0]!.sha256.toUpperCase();
    const result = validateModelManifest(manifest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.files[0]!.sha256).toBe(manifest.files[0]!.sha256.toLowerCase());
  });

  it('拒绝缺 sha256、路径穿越、非法阈值与过长输出预算', () => {
    const base = makeManifest();
    const missingSha = structuredClone(base) as any;
    delete missingSha.files[0].sha256;
    expect(validateModelManifest(missingSha)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('sha256')]),
    });

    const traversal = structuredClone(base);
    traversal.files[0]!.path = '../escape.gguf';
    expect(validateModelManifest(traversal).ok).toBe(false);

    const absolute = structuredClone(base);
    absolute.files[0]!.path = '/tmp/model.gguf';
    expect(validateModelManifest(absolute).ok).toBe(false);

    const badMemory = makeManifest({ requirements: { minMemoryBytes: 16, recommendedMemoryBytes: 8 } });
    expect(validateModelManifest(badMemory)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('recommendedMemoryBytes')]),
    });

    const badContext = makeManifest({ contextLength: 128 });
    badContext.context.defaultMaxOutputTokens = 1024;
    expect(validateModelManifest(badContext).ok).toBe(false);
  });

  it('parseModelManifest 抛出结构化错误', () => {
    expect(() => parseModelManifest({ schema: 2 })).toThrow(ModelManifestError);
  });
});

describe('精选 Qwen 目录', () => {
  it('只有 9B 默认、27B 高质量、4B 轻量，32B 不在目录', () => {
    expect(CURATED_MODEL_PACKS.map((pack) => pack.modelId)).toEqual([
      'qwen3.5-9b-instruct',
      'qwen3.5-27b-instruct',
      'qwen3.5-4b-instruct',
    ]);
    expect(getDefaultModelPack().packId).toBe(DEFAULT_MODEL_PACK_ID);
    expect(findModelPack(DEFAULT_MODEL_PACK_ID)?.tier).toBe('default');
    expect(findModelPack('qwen3.5-27b-instruct-q4_k_m')?.tier).toBe('quality');
    expect(findModelPack('qwen3.5-4b-instruct-q4_k_m')?.tier).toBe('light');
    const serialized = JSON.stringify(CURATED_MODEL_PACKS);
    expect(serialized).not.toMatch(/32b/i);
    expect(serialized).not.toContain('http://');
    expect(serialized).not.toContain('https://');
  });

  it('目录本身不伪造 manifest；注入 manifest/repo 后才可解析', () => {
    expect(() => resolveModelManifest(DEFAULT_MODEL_PACK_ID)).toThrow(ModelCatalogError);

    const manifest = makeManifest({
      packId: DEFAULT_MODEL_PACK_ID,
      modelId: 'qwen3.5-9b-instruct',
      files: [{ path: 'qwen.gguf', content: 'fake-qwen-bytes' }],
    });
    const catalog = createModelCatalog({
      manifests: [manifest],
      repositories: {
        [DEFAULT_MODEL_PACK_ID]: {
          provider: 'modelscope',
          repo: 'Qwen/Qwen3.5-9B-GGUF',
          revision: 'v1',
        },
      },
    });
    const pack = findModelPack(DEFAULT_MODEL_PACK_ID, catalog)!;
    expect(pack.manifest?.files[0]?.sha256).toBe(manifest.files[0]!.sha256);
    expect(pack.source.repository?.provider).toBe('modelscope');
    expect(pack.source.repository?.revision).toBe('v1');
    expect(resolveModelManifest(DEFAULT_MODEL_PACK_ID, { manifests: [manifest] }).packId)
      .toBe(DEFAULT_MODEL_PACK_ID);
  });

  it('拒绝目录外 pack、id 不匹配和 32B 注入', () => {
    const unknown = makeManifest({ packId: 'some-other-pack' });
    expect(() => createModelCatalog({ manifests: [unknown] })).toThrow(/not in the curated/);

    const mismatch = makeManifest({
      packId: DEFAULT_MODEL_PACK_ID,
      modelId: 'qwen3.5-32b-instruct',
    });
    expect(() => createModelCatalog({ manifests: [mismatch] })).toThrow(/32B/);

    const wrongModel = makeManifest({
      packId: DEFAULT_MODEL_PACK_ID,
      modelId: 'qwen3.5-4b-instruct',
    });
    expect(() => createModelCatalog({ manifests: [wrongModel] })).toThrow(/modelId/);
  });
});
