// Transformers.js 本地 embedding 供應者（G2，可選依賴）
//
// 沿 libp2p（D19）模式：
// - `@huggingface/transformers` 是可選依賴，只做**運行時動態導入**；
//   缺包時 `createTransformersEmbeddingProvider` 誠實拋
//   `SEMANTIC_EMBEDDING_NOT_AVAILABLE`，`resolveVectorIndex` 據此降級
//   關鍵詞基線並告警。
// - 本檔案只用結構化型別描述用到的模組表面，編譯期不依賴可選包型別。
// - 模型可配置（`model`）且緩存路徑可指定（`cacheDir`）；pipeline 惰性
//   建立，首次 embed 才加載模型。
// - 動態導入器可注入（測試「缺包」路徑與假 pipeline）。

import { ErrorCodes, MebularError } from '../errors.js';
import { LocalVectorIndex, type EmbeddingProvider } from './embedding.js';
import type { VectorIndex } from './VectorIndex.js';

/** 默認 embedding 模型（MiniLM 多語言小模型，約 23MB 量化） */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** 可選包名 */
export const TRANSFORMERS_PACKAGE = '@huggingface/transformers';

/** 動態導入器：可注入以便測試缺包路徑；默認實現繞開轉譯器的 import 改寫 */
export type EmbeddingModuleImporter = (specifier: string) => Promise<Record<string, unknown>>;

const defaultImporter: EmbeddingModuleImporter = new Function(
  'specifier',
  'return import(specifier);',
) as EmbeddingModuleImporter;

// ---------- 可選包的最小結構化表面 ----------

interface TensorLike {
  tolist(): number[][];
}

type FeatureExtractor = (
  texts: string[],
  options?: Record<string, unknown>,
) => Promise<TensorLike>;

type PipelineFactory = (
  task: string,
  model: string,
  options?: Record<string, unknown>,
) => Promise<FeatureExtractor>;

interface TransformersModule {
  pipeline?: PipelineFactory;
  env?: { cacheDir?: string };
}

export interface TransformersEmbeddingOptions {
  /** 模型 ID（缺省 {@link DEFAULT_EMBEDDING_MODEL}） */
  model?: string;
  /** 模型緩存目錄（可選） */
  cacheDir?: string;
  /** 權重精度/後端（如 'q8'、'fp32'）；缺省由 Transformers.js 決定 */
  dtype?: string;
  /** 動態導入器（測試用） */
  importer?: EmbeddingModuleImporter;
}

/** 基於 Transformers.js feature-extraction 的本地 embedding 實現 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'transformers';
  private readonly options: TransformersEmbeddingOptions;
  private readonly module: TransformersModule;
  private pipelinePromise: Promise<FeatureExtractor> | null = null;

  constructor(module: TransformersModule, options: TransformersEmbeddingOptions) {
    this.module = module;
    this.options = options;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const pipeline = await this.getPipeline();
    try {
      const output = await pipeline(texts, { pooling: 'mean', normalize: true });
      return output.tolist();
    } catch (error) {
      throw new MebularError(
        '本地 embedding 推理失敗（模型加載或推理異常）',
        ErrorCodes.SEMANTIC_EMBEDDING_FAILED,
        error as Error,
      );
    }
  }

  private getPipeline(): Promise<FeatureExtractor> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        const pipeline = this.module.pipeline!;
        const model = this.options.model ?? DEFAULT_EMBEDDING_MODEL;
        if (this.options.cacheDir && this.module.env) {
          this.module.env.cacheDir = this.options.cacheDir;
        }
        const pipelineOptions: Record<string, unknown> = {};
        if (this.options.dtype) {
          pipelineOptions['dtype'] = this.options.dtype;
        }
        return pipeline('feature-extraction', model, pipelineOptions);
      })();
    }
    return this.pipelinePromise;
  }
}

/**
 * 加載可選包並構造 provider；缺包或表面不符即拋
 * `SEMANTIC_EMBEDDING_NOT_AVAILABLE`（附安裝提示）。
 */
export async function createTransformersEmbeddingProvider(
  options: TransformersEmbeddingOptions = {},
): Promise<TransformersEmbeddingProvider> {
  const importer = options.importer ?? defaultImporter;
  let module: TransformersModule;
  try {
    module = (await importer(TRANSFORMERS_PACKAGE)) as TransformersModule;
  } catch (error) {
    throw new MebularError(
      `本地 embedding 可選依賴缺失（${TRANSFORMERS_PACKAGE}）。` +
        `安裝：npm install ${TRANSFORMERS_PACKAGE}（傳遞依賴約 450MB）；` +
        '或注入自訂 EmbeddingProvider。',
      ErrorCodes.SEMANTIC_EMBEDDING_NOT_AVAILABLE,
      error as Error,
    );
  }
  if (typeof module.pipeline !== 'function') {
    throw new MebularError(
      `${TRANSFORMERS_PACKAGE} 未導出 pipeline（版本不符）`,
      ErrorCodes.SEMANTIC_EMBEDDING_NOT_AVAILABLE,
    );
  }
  return new TransformersEmbeddingProvider(module, options);
}

export interface ResolveVectorIndexOptions extends TransformersEmbeddingOptions {
  /** 直接注入 provider（優先於可選包；測試/替代實現用） */
  provider?: EmbeddingProvider;
  /** true：缺包時拋錯而非降級；缺省 false（降級 + 告警） */
  required?: boolean;
  /** 告警輸出（缺省 console.warn） */
  warn?: (message: string) => void;
}

/**
 * 解析向量索引：
 * - 注入 `provider` 時直接包成 `LocalVectorIndex`；
 * - 否則嘗試加載可選包；
 * - 缺包時 `required=false` 告警並返回 null（調用方回退關鍵詞基線），
 *   `required=true` 拋 `SEMANTIC_EMBEDDING_NOT_AVAILABLE`。
 */
export async function resolveVectorIndex(
  options: ResolveVectorIndexOptions = {},
): Promise<VectorIndex | null> {
  if (options.provider) {
    return new LocalVectorIndex(options.provider);
  }
  const warn = options.warn ?? ((message: string) => console.warn(message));
  try {
    const provider = await createTransformersEmbeddingProvider(options);
    return new LocalVectorIndex(provider);
  } catch (error) {
    if (options.required) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    warn(`[Mebular] ${detail} 語義召回降級為關鍵詞基線。`);
    return null;
  }
}
