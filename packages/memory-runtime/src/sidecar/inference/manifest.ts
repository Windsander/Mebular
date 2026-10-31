// 模型 manifest 解析：sidecar 不复制下载/校验逻辑，只负责找到设备上的 manifest。
//
// 默认位置：`<dataDir>/model-manifests/<packId>.json`。
// manifest 是安装/启动的前提；缺失时必须返回结构化 `manifest_missing`，
// 不得猜测下载地址或 sha256，也不得读取 MCP 安装目录。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelCatalogError, resolveCuratedManifest } from '../../inference/catalog.js';
import { ModelManifestError, parseModelManifest, type ModelManifest } from '../../inference/types.js';
import { InferenceError } from './types.js';

export interface ModelManifestResolver {
  resolve(packId: string): Promise<ModelManifest>;
}

const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function safePackId(packId: string): string {
  if (!PACK_ID_RE.test(packId)) {
    throw new InferenceError('invalid_request', '模型包 id 非法', { status: 400 });
  }
  return packId;
}


/**
 * 精选目录内置 manifest：安装/激活的默认来源。
 * 不访问网络；缺失/未知/不匹配都映射为稳定的 InferenceError。
 */
export class CuratedModelManifestResolver implements ModelManifestResolver {
  async resolve(packId: string): Promise<ModelManifest> {
    const id = safePackId(packId);
    try {
      return resolveCuratedManifest(id);
    } catch (error) {
      if (error instanceof ModelCatalogError) {
        if (error.code === 'unknown_pack' || error.code === 'excluded_model') {
          throw new InferenceError('unknown_pack', '未知模型包', {
            status: 404,
            details: { packId: id },
          });
        }
        throw new InferenceError('manifest_missing', '精选模型缺少完整 manifest', {
          status: 409,
          details: { packId: id, code: error.code },
        });
      }
      throw new InferenceError('manifest_missing', '精选模型缺少完整 manifest', {
        status: 409,
        details: { packId: id },
      });
    }
  }
}

/** 为安装/激活解析完整 manifest；不访问网络。 */
export class FileModelManifestResolver implements ModelManifestResolver {
  constructor(
    readonly manifestDir: string,
    private readonly read: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
  ) {}

  async resolve(packId: string): Promise<ModelManifest> {
    const id = safePackId(packId);
    const path = join(this.manifestDir, `${id}.json`);
    let raw: string;
    try {
      raw = await this.read(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new InferenceError(
          'manifest_missing',
          '模型包缺少完整 manifest（sha256/文件列表）；不会猜测下载地址或哈希',
          { status: 409, details: { packId: id } },
        );
      }
      throw new InferenceError('manifest_invalid', '模型 manifest 不可读', {
        status: 409,
        retryable: true,
        details: { packId: id },
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new InferenceError('manifest_invalid', '模型 manifest 不是合法 JSON', {
        status: 400,
        details: { packId: id },
      });
    }

    let manifest: ModelManifest;
    try {
      manifest = parseModelManifest(parsed);
    } catch (error) {
      const errors = error instanceof ModelManifestError ? error.errors.slice(0, 20) : [];
      throw new InferenceError('manifest_invalid', '模型 manifest 校验失败', {
        status: 400,
        details: { packId: id, errors },
      });
    }
    if (manifest.packId !== id) {
      throw new InferenceError('manifest_mismatch', 'manifest packId 与请求的模型包不一致', {
        status: 400,
        details: { packId: id, manifestPackId: manifest.packId },
      });
    }
    return manifest;
  }
}
