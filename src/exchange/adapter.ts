// 记忆适配器框架（phase-5-plan 5.3）
//
// 定位：异构端（键值存储、文档、未来的表格）经适配器投影为 CMF，
// 再由框架统一走幂等键 + importCmfToMemory 落图——图仍是唯一权威模型，
// CMF 是交换投影，适配器只负责「异构 → 投影」的映射判断。
//
// 幂等：去重键 = import:<适配器名>:<sha256(适配器名 + 来源端标识 + 节点指纹)>
// （Phase 6.1 层级规范，见 import-keys.ts），作为节点 label 随图同步，
// 同内容经不同端/不同格式导入零重复；读取侧兼容既有图的旧格式
// import:<sha256> 键（双读过渡，不迁移、自然老化）。

import { createHash } from 'crypto';
import { ErrorCodes, MebularError } from '../errors.js';
import type { MemoryStore } from '../memory/MemoryStore.js';
import {
  canonicalCmfNode,
  importCmfToMemory,
  type CmfDocument,
  type CmfImportReport,
} from './cmf.js';
import { importLabel, legacyImportLabel } from './import-keys.js';

// ---------- 接口 ----------

/** 适配器输入源：kind 由适配器约定，origin 为来源端标识（进入幂等键） */
export interface AdapterSource {
  kind?: string;
  data: unknown;
  origin?: string;
}

/** 适配器运行上下文 */
export interface AdapterContext {
  memory: MemoryStore;
}

export interface MemoryAdapter {
  /** 适配器名（进入幂等键，跨端稳定） */
  readonly name: string;
  /** 认领置信度 0..1；0 表示不认领。路由取最高者 */
  detect(source: AdapterSource): number;
  /** 异构源 → CMF 投影（不落图；落图由框架统一完成） */
  import(source: AdapterSource, ctx: AdapterContext): Promise<CmfDocument>;
  /** 图 → CMF 查询投影（可选；缺省用 exportGraphToCmf 的调用方自理） */
  export?(ctx: AdapterContext): Promise<CmfDocument>;
}

export interface AdapterImportReport extends CmfImportReport {
  /** 因幂等键命中而跳过的节点数 */
  skipped: number;
  adapter: string;
}

// ---------- 幂等键 ----------

/** 跨端稳定去重摘要：适配器名 + 来源端 + 节点内容指纹 */
export function adapterDedupDigest(
  adapterName: string,
  origin: string,
  node: Parameters<typeof canonicalCmfNode>[0],
): string {
  return createHash('sha256')
    .update(`${adapterName}\n${origin}\n${canonicalCmfNode(node)}`)
    .digest('hex');
}

/** 跨端稳定去重键（Phase 6.1 新格式）：import:<适配器名>:<digest> */
export function adapterDedupKey(
  adapterName: string,
  origin: string,
  node: Parameters<typeof canonicalCmfNode>[0],
): string {
  return importLabel(adapterName, adapterDedupDigest(adapterName, origin, node));
}

// ---------- 框架 ----------

/**
 * 经适配器导入：投影为 CMF → 逐节点算幂等键（已存在则跳过，新旧两格式
 * 键都认）→ 未命中集合走 importCmfToMemory（MemoryStore 校验路径不变）。
 */
export async function importWithAdapter(
  adapter: MemoryAdapter,
  source: AdapterSource,
  memory: MemoryStore,
): Promise<AdapterImportReport> {
  const doc = await adapter.import(source, { memory });
  const origin = source.origin ?? 'unknown';

  const fresh: CmfDocument = { ...doc, nodes: [], edges: [...doc.edges] };
  let skipped = 0;
  const existingIdMap: Record<string, string> = {};
  for (const node of doc.nodes) {
    const digest = adapterDedupDigest(adapter.name, origin, node);
    let existing = await memory.getGraph().listNodes({ labels: [importLabel(adapter.name, digest)], limit: 1 });
    if (existing.length === 0) {
      // 双读兼容（Phase 6.1）：既有图上的旧格式 import:<digest> 键仍然有效
      existing = await memory.getGraph().listNodes({ labels: [legacyImportLabel(digest)], limit: 1 });
    }
    if (existing.length > 0) {
      skipped += 1;
      // 幂等命中的节点同样参与边端点映射（Phase 6.1 修复）：
      // 重复导入含边场景下边端点解析到已有本地 ID，不再落入 errors
      existingIdMap[node.id] = existing[0]!.id;
      continue;
    }
    fresh.nodes.push({ ...node, labels: [...(node.labels ?? []), importLabel(adapter.name, digest)] });
  }

  const inner = await importCmfToMemory(memory, fresh, { existingIdMap });
  return { ...inner, skipped, adapter: adapter.name };
}

// ---------- 注册表 ----------

export interface AdapterRoute {
  adapter: MemoryAdapter;
  confidence: number;
}

export class AdapterRegistry {
  private readonly adapters: MemoryAdapter[] = [];

  register(adapter: MemoryAdapter): void {
    if (this.adapters.some((a) => a.name === adapter.name)) {
      throw new MebularError(`适配器重复注册：${adapter.name}`, ErrorCodes.ADAPTER_DUPLICATE);
    }
    this.adapters.push(adapter);
  }

  /** 按 detect 置信度路由；同分时先注册者优先；无认领诚实报错 */
  route(source: AdapterSource): AdapterRoute {
    let best: AdapterRoute | null = null;
    for (const adapter of this.adapters) {
      const confidence = adapter.detect(source);
      if (confidence <= 0) continue;
      if (!best || confidence > best.confidence) {
        best = { adapter, confidence };
      }
    }
    if (!best) {
      throw new MebularError(
        `没有适配器认领该来源（kind=${source.kind ?? '未标注'}）`,
        ErrorCodes.ADAPTER_NOT_FOUND,
      );
    }
    return best;
  }

  /** 路由 + 导入的便捷组合 */
  async import(source: AdapterSource, memory: MemoryStore): Promise<AdapterImportReport> {
    const { adapter } = this.route(source);
    return importWithAdapter(adapter, source, memory);
  }

  list(): readonly MemoryAdapter[] {
    return this.adapters;
  }
}
