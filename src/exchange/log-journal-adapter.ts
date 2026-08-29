// 日志型端适配器（phase-6-plan 6.3 生态适配器之二）
//
// append-only 日志 → Episode 序列，保留时序语义：
// - 每行 → Episode(episodeType='observation')，时间戳进 startTime
// - 容器 Entity（journal）经 source_of 边收编全部条目
// - 相邻条目接 follows 边（后一条 follows 前一条），append-only 序在图内可遍历
//
// 两种输入形态（同一适配器，按内容自动判别）：
// 1. JSONL：每行一个 JSON 对象，识别字段——
//    时间：time / timestamp / ts（epoch 毫秒或 ISO 字符串）
//    正文：message / text / msg / content（必需，字符串）
//    级别：level（字符串，进节点标签 level:<level>）
//    任一行解析失败或缺正文字段 → 诚实报错（CMF_FORMAT_INVALID，带行号）
// 2. 纯文本：每行一条；可选 ISO 时间戳前缀（如 `2026-08-28T10:00:00Z `）
//    与可选 [LEVEL] 前缀，其余为正文。
//
// 幂等：条目 id 为确定性 `log:<index>`，跨端去重由适配器框架的
// import:log-journal:<digest> 统一承载（digest 含内容指纹，乱序/重发不误判）。

import { ErrorCodes, MebularError } from '../errors.js';
import { EdgeTypes } from '../memory/types.js';
import type { AdapterContext, AdapterSource, MemoryAdapter } from './adapter.js';
import type { CmfDocument, CmfEdge, CmfNode } from './cmf.js';

export const LOG_JOURNAL_IMPORT_TAG = 'log-journal-import';

const ISO_PREFIX_RE =
  /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s+/;
const LEVEL_PREFIX_RE = /^\[([A-Za-z]+)\]\s*/;

const TIME_KEYS = ['time', 'timestamp', 'ts'] as const;
const TEXT_KEYS = ['message', 'text', 'msg', 'content'] as const;

export interface LogEntry {
  text: string;
  time?: number;
  level?: string;
}

function parseTimeValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/** JSONL 行 → 条目；失败抛 CMF_FORMAT_INVALID（带行号） */
function parseJsonLine(line: string, lineNo: number): LogEntry {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch (error) {
    throw new MebularError(
      `JSONL 第 ${lineNo} 行解析失败：${(error as Error).message}`,
      ErrorCodes.CMF_FORMAT_INVALID,
      error as Error,
    );
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new MebularError(`JSONL 第 ${lineNo} 行不是对象`, ErrorCodes.CMF_FORMAT_INVALID);
  }
  const record = obj as Record<string, unknown>;
  const text = TEXT_KEYS.map((k) => record[k]).find((v) => typeof v === 'string');
  if (typeof text !== 'string' || text.trim() === '') {
    throw new MebularError(
      `JSONL 第 ${lineNo} 行缺少正文字段（message/text/msg/content）`,
      ErrorCodes.CMF_FORMAT_INVALID,
    );
  }
  const time = TIME_KEYS.map((k) => parseTimeValue(record[k])).find((v) => v !== undefined);
  const level = typeof record.level === 'string' ? record.level : undefined;
  return { text, time, level };
}

/** 纯文本行 → 条目（时间戳/[LEVEL] 前缀可选；永不抛错） */
function parsePlainLine(line: string): LogEntry {
  let rest = line;
  let time: number | undefined;
  let level: string | undefined;
  const tsMatch = ISO_PREFIX_RE.exec(rest);
  if (tsMatch) {
    time = Date.parse(tsMatch[1]!.replace(' ', 'T'));
    rest = rest.slice(tsMatch[0].length);
  }
  const levelMatch = LEVEL_PREFIX_RE.exec(rest);
  if (levelMatch) {
    level = levelMatch[1];
    rest = rest.slice(levelMatch[0].length);
  }
  return { text: rest, time, level };
}

/** 判断输入是否为 JSONL 形态（每行都以 { 开头；逐行严格性由 parseJsonLine 校验） */
function looksLikeJsonl(lines: string[]): boolean {
  return lines.length > 0 && lines.every((line) => line.startsWith('{'));
}

export function parseLogJournal(data: string): LogEntry[] {
  const lines = data.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) {
    throw new MebularError('日志内容为空', ErrorCodes.CMF_FORMAT_INVALID);
  }
  if (looksLikeJsonl(lines)) {
    return lines.map((line, i) => parseJsonLine(line, i + 1));
  }
  return lines.map(parsePlainLine);
}

export class LogJournalAdapter implements MemoryAdapter {
  readonly name = 'log-journal';

  detect(source: AdapterSource): number {
    if (source.kind === 'log-journal' || source.kind === 'jsonl' || source.kind === 'log') return 1;
    if (source.kind === undefined && typeof source.data === 'string') {
      const lines = source.data.split(/\r?\n/).filter((l) => l.trim() !== '');
      // 每行都是可解析且带正文字段的 JSON 对象 → 高置信 JSONL 认领
      if (
        looksLikeJsonl(lines) &&
        lines.every((line) => {
          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            return TEXT_KEYS.some((k) => typeof obj?.[k] === 'string');
          } catch {
            return false;
          }
        })
      ) {
        return 0.7;
      }
      // 纯文本多行且不带 markdown 标题/列表标记 → 低置信认领（让位 markdown-doc）
      if (lines.length > 1 && !/^(#{1,6}\s+|\s*(?:[-*+]|\d+[.)])\s+)/m.test(source.data)) {
        return 0.3;
      }
    }
    return 0;
  }

  async import(source: AdapterSource, _ctx?: AdapterContext): Promise<CmfDocument> {
    if (typeof source.data !== 'string') {
      throw new TypeError('log-journal 适配器只接受字符串（JSONL 或纯文本行）');
    }
    const entries = parseLogJournal(source.data);
    const origin = source.origin ?? 'log-journal';

    const journalId = 'log:journal';
    const nodes: CmfNode[] = [
      {
        id: journalId,
        type: 'entity',
        content: {
          entityType: 'other',
          name: origin,
          description: `日志（${entries.length} 条）`,
          properties: { format: 'log-journal', entries: entries.length },
        },
        tags: [LOG_JOURNAL_IMPORT_TAG],
      },
    ];
    const edges: CmfEdge[] = [];

    entries.forEach((entry, index) => {
      const episodeId = `log:${index}`;
      nodes.push({
        id: episodeId,
        type: 'episode',
        content: {
          episodeType: 'observation',
          content: entry.text,
          ...(entry.time !== undefined ? { startTime: entry.time } : {}),
          context: origin,
        },
        tags: [
          LOG_JOURNAL_IMPORT_TAG,
          ...(entry.level !== undefined ? [`level:${entry.level}`] : []),
        ],
      });
      edges.push({ source: journalId, target: episodeId, relation: EdgeTypes.SOURCE_OF });
      if (index > 0) {
        // append-only 序：后一条 follows 前一条
        edges.push({ source: episodeId, target: `log:${index - 1}`, relation: EdgeTypes.FOLLOWS });
      }
    });

    return { format: 'cmf', version: 1, exportedAt: Date.now(), nodes, edges };
  }
}
