// 日志型端适配器单元测试（phase-6-plan 6.3）

import { describe, it, expect } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { importWithAdapter } from '../../src/exchange/adapter.js';
import {
  LogJournalAdapter,
  parseLogJournal,
  LOG_JOURNAL_IMPORT_TAG,
} from '../../src/exchange/log-journal-adapter.js';

function createMemory(): MemoryStore {
  return new MemoryStore(new GraphStore({ storage: new MemoryStorage(), author: 'test' }));
}

describe('parseLogJournal：JSONL 形态', () => {
  it('识别 time/timestamp/ts 与 message/text/msg/content', () => {
    const entries = parseLogJournal(
      [
        '{"time": 1000, "message": "a"}',
        '{"timestamp": "2026-08-28T10:00:00Z", "text": "b"}',
        '{"ts": 3000, "msg": "c", "level": "warn"}',
        '{"content": "d"}',
      ].join('\n'),
    );
    expect(entries).toEqual([
      { text: 'a', time: 1000, level: undefined },
      { text: 'b', time: Date.parse('2026-08-28T10:00:00Z'), level: undefined },
      { text: 'c', time: 3000, level: 'warn' },
      { text: 'd', time: undefined, level: undefined },
    ]);
  });

  it('坏 JSON / 缺正文字段 → 带行号诚实报错；非 { 开头行落纯文本', () => {
    expect(() => parseLogJournal('{"message": "ok"}\n{坏}')).toThrow('第 2 行解析失败');
    expect(() => parseLogJournal('{"message": "ok"}\n{"level": "x"}')).toThrow(
      '第 2 行缺少正文字段',
    );
    // 不以 { 开头的行使整体落到纯文本形态，不报错（宽容的纯文本端）
    expect(parseLogJournal('{"message": "ok"}\n[1,2]')).toHaveLength(2);
  });

  it('空输入报错', () => {
    expect(() => parseLogJournal('  \n\n')).toThrow('日志内容为空');
  });
});

describe('parseLogJournal：纯文本形态', () => {
  it('ISO 时间戳前缀 + [LEVEL] 前缀可选', () => {
    const entries = parseLogJournal(
      [
        '2026-08-28T09:00:00Z [INFO] 设备上线',
        '2026-08-28T09:05:12Z 心跳正常',
        '[WARN] 磁盘水位 80%',
        '随手一记',
      ].join('\n'),
    );
    expect(entries[0]).toEqual({
      text: '设备上线',
      time: Date.parse('2026-08-28T09:00:00Z'),
      level: 'INFO',
    });
    expect(entries[1]).toEqual({
      text: '心跳正常',
      time: Date.parse('2026-08-28T09:05:12Z'),
      level: undefined,
    });
    expect(entries[2]).toEqual({ text: '磁盘水位 80%', time: undefined, level: 'WARN' });
    expect(entries[3]).toEqual({ text: '随手一记', time: undefined, level: undefined });
  });
});

describe('LogJournalAdapter.detect', () => {
  const adapter = new LogJournalAdapter();

  it('显式 kind 全置信认领', () => {
    expect(adapter.detect({ kind: 'log-journal', data: '' })).toBe(1);
    expect(adapter.detect({ kind: 'jsonl', data: '' })).toBe(1);
    expect(adapter.detect({ kind: 'log', data: '' })).toBe(1);
  });

  it('JSONL 串 0.7；纯文本多行 0.3；markdown 形态与单行不认领', () => {
    expect(adapter.detect({ data: '{"message": "a"}\n{"message": "b"}' })).toBe(0.7);
    expect(adapter.detect({ data: '第一行\n第二行' })).toBe(0.3);
    expect(adapter.detect({ data: '# 标题\n- 条目' })).toBe(0); // 让位 markdown-doc
    expect(adapter.detect({ data: '单行' })).toBe(0);
    expect(adapter.detect({ kind: 'markdown', data: 'x\ny' })).toBe(0);
  });
});

describe('LogJournalAdapter.import', () => {
  const adapter = new LogJournalAdapter();

  it('JSONL → 容器 Entity + Episode 序列 + source_of + follows 链', async () => {
    const doc = await adapter.import(
      {
        kind: 'jsonl',
        data: '{"time": 1000, "level": "info", "message": "启动"}\n{"message": "完成"}',
        origin: 'device-x',
      },
      { memory: createMemory() },
    );

    const journal = doc.nodes.find((n) => n.id === 'log:journal');
    expect(journal).toBeDefined();
    expect((journal!.content as Record<string, unknown>).name).toBe('device-x');

    const episodes = doc.nodes.filter((n) => n.type === 'episode');
    expect(episodes).toHaveLength(2);
    const first = episodes[0]!.content as Record<string, unknown>;
    expect(first.episodeType).toBe('observation');
    expect(first.content).toBe('启动');
    expect(first.startTime).toBe(1000);
    expect(first.context).toBe('device-x');
    expect(episodes[0]!.tags).toContain('level:info');
    expect(episodes[0]!.tags).toContain(LOG_JOURNAL_IMPORT_TAG);

    const sourceOf = doc.edges.filter((e) => e.relation === 'source_of');
    expect(sourceOf).toHaveLength(2);
    expect(sourceOf.every((e) => e.source === 'log:journal')).toBe(true);

    const follows = doc.edges.filter((e) => e.relation === 'follows');
    expect(follows).toEqual([{ source: 'log:1', target: 'log:0', relation: 'follows' }]);
  });

  it('非字符串输入诚实报错', async () => {
    await expect(adapter.import({ data: [] }, { memory: createMemory() })).rejects.toThrow(
      '只接受字符串',
    );
  });

  it('经框架落图：幂等键命中后重复导入零重复', async () => {
    const memory = createMemory();
    const source = { kind: 'jsonl', data: '{"message": "a"}\n{"message": "b"}', origin: 'dev' };
    const first = await importWithAdapter(adapter, source, memory);
    expect(first.errors).toEqual([]);
    expect(first.nodesCreated).toBe(3); // 容器 + 2 条目

    const second = await importWithAdapter(adapter, source, memory);
    expect(second.nodesCreated).toBe(0);
    expect(second.skipped).toBe(3);
    expect((await memory.getGraph().listNodes()).length).toBe(3);
  });
});
