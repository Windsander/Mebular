// manifest 校验 + 精选 Qwen3 目录边界。

import { describe, it, expect } from '@jest/globals';
import {
  CURATED_MODEL_PACKS,
  DEFAULT_MODEL_PACK_ID,
  ModelCatalogError,
  ModelManifestError,
  createModelCatalog,
  curatedPackIds,
  findModelPack,
  getDefaultModelPack,
  huggingFaceResolveUrl,
  listCuratedManifests,
  parseModelManifest,
  resolveCuratedManifest,
  resolveModelManifest,
  validateModelManifest,
  type ModelManifest,
} from '../../src/index.js';
import { makeManifest } from './helpers.js';

function packById(packId: string): ModelManifest {
  return resolveCuratedManifest(packId);
}

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

describe('精选 Qwen3 目录', () => {
  it('只含真实 Qwen3 4B/8B/14B（+30B-A3B），默认 8B，不含 Qwen3.5/32B', () => {
    expect(CURATED_MODEL_PACKS.map((pack) => pack.modelId)).toEqual([
      'qwen3-8b-instruct',
      'qwen3-30b-a3b-instruct',
      'qwen3-14b-instruct',
      'qwen3-4b-instruct',
    ]);
    expect(curatedPackIds()).toEqual([
      'qwen3-8b-instruct-q4_k_m',
      'qwen3-30b-a3b-instruct-q4_k_m',
      'qwen3-14b-instruct-q4_k_m',
      'qwen3-4b-instruct-q4_k_m',
    ]);
    expect(DEFAULT_MODEL_PACK_ID).toBe('qwen3-8b-instruct-q4_k_m');
    expect(getDefaultModelPack().packId).toBe(DEFAULT_MODEL_PACK_ID);
    expect(findModelPack(DEFAULT_MODEL_PACK_ID)?.tier).toBe('default');
    expect(findModelPack('qwen3-14b-instruct-q4_k_m')?.tier).toBe('quality');
    expect(findModelPack('qwen3-30b-a3b-instruct-q4_k_m')?.tier).toBe('high');
    expect(findModelPack('qwen3-4b-instruct-q4_k_m')?.tier).toBe('light');

    const serialized = JSON.stringify(CURATED_MODEL_PACKS);
    expect(serialized).not.toMatch(/qwen3\.5/i);
    expect(serialized).not.toMatch(/32b/i);
    expect(serialized).not.toMatch(/https?:\/\/(?!huggingface\.co\/)/);
  });

  it('内置 manifest 的 revision/大小/sha256/license/URL 正确', () => {
    const expected = {
      'qwen3-4b-instruct-q4_k_m': {
        repo: 'Qwen/Qwen3-4B-GGUF',
        revision: 'bc640142c66e1fdd12af0bd68f40445458f3869b',
        file: 'Qwen3-4B-Q4_K_M.gguf',
        sizeBytes: 2497280256,
        sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
      },
      'qwen3-8b-instruct-q4_k_m': {
        repo: 'Qwen/Qwen3-8B-GGUF',
        revision: '7c41481f57cb95916b40956ab2f0b139b296d974',
        file: 'Qwen3-8B-Q4_K_M.gguf',
        sizeBytes: 5027783488,
        sha256: 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785',
      },
      'qwen3-14b-instruct-q4_k_m': {
        repo: 'Qwen/Qwen3-14B-GGUF',
        revision: '530227a7d994db8eca5ab5ced2fb692b614357fd',
        file: 'Qwen3-14B-Q4_K_M.gguf',
        sizeBytes: 9001752960,
        sha256: '500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0',
      },
      'qwen3-30b-a3b-instruct-q4_k_m': {
        repo: 'Qwen/Qwen3-30B-A3B-GGUF',
        revision: 'e4d4bafdfb96a411a163846265362aceb0b9c63a',
        file: 'Qwen3-30B-A3B-Q4_K_M.gguf',
        sizeBytes: 18556685824,
        sha256: '0d003f6662faee786ed5da3e31b29c978de5ae5d275c8794c606a7f3c01aa8f5',
      },
    } as const;

    for (const [packId, data] of Object.entries(expected)) {
      const manifest = packById(packId);
      expect(manifest).toMatchObject({
        schema: 1,
        packId,
        format: 'gguf',
        quantization: 'Q4_K_M',
        license: { id: 'apache-2.0', requiresAcceptance: false },
        runtime: { engine: 'llama-server' },
      });
      expect(manifest.source.repository).toEqual({
        provider: 'huggingface',
        repo: data.repo,
        revision: data.revision,
      });
      expect(manifest.files).toHaveLength(1);
      expect(manifest.files[0]).toMatchObject({
        path: data.file,
        sizeBytes: data.sizeBytes,
        sha256: data.sha256,
      });
      expect(manifest.files[0]!.url).toBe(
        `https://huggingface.co/${data.repo}/resolve/${data.revision}/${data.file}`,
      );
      expect(validateModelManifest(manifest).ok).toBe(true);
    }

    expect(listCuratedManifests().map((manifest) => manifest.packId)).toEqual(curatedPackIds());
  });

  it('默认 catalog 带完整 manifest；includeManifests:false 回到坐标视图', () => {
    const packs = createModelCatalog();
    expect(packs).toHaveLength(CURATED_MODEL_PACKS.length);
    expect(packs.every((pack) => pack.manifest !== undefined)).toBe(true);
    expect(packs.every((pack) => pack.manifest?.files[0]?.url?.startsWith('https://huggingface.co/'))).toBe(true);

    const without = createModelCatalog({ includeManifests: false });
    expect(without.every((pack) => pack.manifest === undefined)).toBe(true);
    expect(() => resolveModelManifest(DEFAULT_MODEL_PACK_ID, { includeManifests: false }))
      .toThrow(ModelCatalogError);
    expect(resolveModelManifest(DEFAULT_MODEL_PACK_ID).packId).toBe(DEFAULT_MODEL_PACK_ID);
  });

  it('注入 manifest/仓库覆盖仍兼容，且文件 URL 只能由仓库坐标推导', () => {
    const manifest = makeManifest({
      packId: DEFAULT_MODEL_PACK_ID,
      modelId: 'qwen3-8b-instruct',
      files: [{ path: 'qwen.gguf', content: 'fake-qwen-bytes' }],
    });
    manifest.files[0]!.url = 'https://evil.example/arbitrary.gguf';
    manifest.files[0]!.mirrors = ['https://evil.example/mirror.gguf'];

    const catalog = createModelCatalog({
      manifests: [manifest],
      repositories: {
        [DEFAULT_MODEL_PACK_ID]: {
          provider: 'modelscope',
          repo: 'Qwen/Qwen3-8B-GGUF',
          revision: 'v1',
        },
      },
    });
    const pack = findModelPack(DEFAULT_MODEL_PACK_ID, catalog)!;
    expect(pack.manifest?.files[0]?.sha256).toBe(manifest.files[0]!.sha256);
    expect(pack.source.repository?.provider).toBe('modelscope');
    expect(pack.source.repository?.revision).toBe('v1');
    expect(pack.manifest?.files[0]?.url).toBeUndefined();
    expect(pack.manifest?.files[0]?.mirrors).toBeUndefined();
    expect(resolveModelManifest(DEFAULT_MODEL_PACK_ID, { manifests: [manifest] }).packId)
      .toBe(DEFAULT_MODEL_PACK_ID);

    const localManifest = makeManifest({
      packId: DEFAULT_MODEL_PACK_ID,
      modelId: 'qwen3-8b-instruct',
      files: [{ path: 'qwen.gguf', content: 'fake-qwen-bytes' }],
    });
    localManifest.source = { kind: 'local' };
    localManifest.files[0]!.url = 'https://evil.example/local.gguf';
    const localPack = findModelPack(
      DEFAULT_MODEL_PACK_ID,
      createModelCatalog({ manifests: [localManifest] }),
    )!;
    expect(localPack.manifest?.files[0]?.url).toBeUndefined();

    const hfManifest = makeManifest({
      packId: DEFAULT_MODEL_PACK_ID,
      modelId: 'qwen3-8b-instruct',
      files: [{ path: 'qwen.gguf', content: 'fake-qwen-bytes' }],
    });
    hfManifest.files[0]!.url = 'https://evil.example/arbitrary.gguf';
    hfManifest.source.repository = {
      provider: 'huggingface',
      repo: 'Qwen/Qwen3-8B-GGUF',
      revision: '7c41481f57cb95916b40956ab2f0b139b296d974',
    };
    const hfPack = findModelPack(
      DEFAULT_MODEL_PACK_ID,
      createModelCatalog({ manifests: [hfManifest] }),
    )!;
    expect(hfPack.manifest?.files[0]?.url).toBe(
      'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/7c41481f57cb95916b40956ab2f0b139b296d974/qwen.gguf',
    );
  });

  it('拒绝 Qwen3.5/未知 pack、32B、id 不匹配与任意 URL 推导', () => {
    expect(() => resolveCuratedManifest('qwen3.5-8b-instruct-q4_k_m'))
      .toThrow(/unknown model pack/);
    expect(() => resolveModelManifest('qwen3.5-8b-instruct-q4_k_m'))
      .toThrow(/unknown model pack/);
    expect(() => resolveCuratedManifest('qwen3-32b-instruct-q4_k_m'))
      .toThrow(/32B/);

    const unknown = makeManifest({ packId: 'some-other-pack' });
    expect(() => createModelCatalog({ manifests: [unknown] })).toThrow(/not in the curated/);

    const mismatch = makeManifest({
      packId: DEFAULT_MODEL_PACK_ID,
      modelId: 'qwen3-32b-instruct',
    });
    expect(() => createModelCatalog({ manifests: [mismatch] })).toThrow(/32B/);

    const wrongModel = makeManifest({
      packId: DEFAULT_MODEL_PACK_ID,
      modelId: 'qwen3-4b-instruct',
    });
    expect(() => createModelCatalog({ manifests: [wrongModel] })).toThrow(/modelId/);

    expect(() => createModelCatalog({
      repositories: {
        'qwen3.5-8b-instruct-q4_k_m': {
          provider: 'huggingface',
          repo: 'Qwen/Qwen3.5-8B-GGUF',
          revision: 'main',
        },
      },
    })).toThrow(/unknown pack/);

    expect(() => huggingFaceResolveUrl(
      { provider: 'modelscope', repo: 'Qwen/Qwen3-8B-GGUF', revision: 'main' },
      'model.gguf',
    )).toThrow(/HuggingFace/);
    expect(() => huggingFaceResolveUrl(
      { provider: 'huggingface', repo: 'Qwen/Qwen3-8B-GGUF', revision: 'main' },
      '../escape.gguf',
    )).toThrow(/unsafe/);
  });
});
