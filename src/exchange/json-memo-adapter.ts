// JSON 备忘录端适配器（phase-5-plan 5.4 异构端参考）
//
// 极简异构端契约（见 examples/json-memo/）：
//   { "memos": [{ "text": string, "title"?: string, "createdAt"?: number }] }
// 映射规则：带 title 的条目 → Episode(episodeType='observation')；
// 纯文本条目 → Fact(subject=来源端名, predicate='memo')。

import { ErrorCodes, MebularError } from '../errors.js';
import type { AdapterSource, MemoryAdapter } from './adapter.js';
import type { CmfDocument, CmfNode } from './cmf.js';

export interface JsonMemoEntry {
  text: string;
  title?: string;
  createdAt?: number;
}

export interface JsonMemoFile {
  memos: JsonMemoEntry[];
}

export function parseJsonMemo(data: unknown): JsonMemoFile {
  const raw = typeof data === 'string' ? JSON.parse(data) : data;
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as JsonMemoFile).memos)) {
    throw new MebularError('JSON 备忘录必须是含 memos 数组的对象', ErrorCodes.CMF_FORMAT_INVALID);
  }
  for (const memo of (raw as JsonMemoFile).memos) {
    if (!memo || typeof memo.text !== 'string') {
      throw new MebularError('JSON 备忘录条目缺少 text 字段', ErrorCodes.CMF_FORMAT_INVALID);
    }
  }
  return raw as JsonMemoFile;
}

export class JsonMemoAdapter implements MemoryAdapter {
  readonly name = 'json-memo';

  detect(source: AdapterSource): number {
    if (source.kind === 'json-memo') return 1;
    if (source.kind !== undefined) return 0;
    try {
      const data = typeof source.data === 'string' ? JSON.parse(source.data) : source.data;
      if (data && typeof data === 'object' && Array.isArray((data as JsonMemoFile).memos)) {
        return 0.8;
      }
    } catch {
      // 不是 JSON 即不认领
    }
    return 0;
  }

  async import(source: AdapterSource, _ctx?: import("./adapter.js").AdapterContext): Promise<CmfDocument> {
    const file = parseJsonMemo(source.data);
    const origin = source.origin ?? 'json-memo';
    const nodes: CmfNode[] = file.memos.map((memo, index) => {
      if (memo.title !== undefined) {
        return {
          id: `memo:${index}`,
          type: 'episode',
          content: {
            episodeType: 'observation',
            title: memo.title,
            content: memo.text,
            ...(memo.createdAt !== undefined ? { startTime: memo.createdAt } : {}),
            context: origin,
          },
        };
      }
      return {
        id: `memo:${index}`,
        type: 'fact',
        content: { subject: origin, predicate: 'memo', object: memo.text },
      };
    });
    return { format: 'cmf', version: 1, exportedAt: Date.now(), nodes, edges: [] };
  }
}
