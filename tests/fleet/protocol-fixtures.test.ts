// Fleet 协议夹具（M0）：语言无关 JSON 夹具的校验 / 往返 / 与 TS 常量一致性。

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLEET_PROTOCOL_VERSION,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  STATUS_RANK,
  TERMINAL_PRECEDENCE,
  isTaskStatus,
  isTerminal,
  resolveStatus,
  canTransition,
  validateEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type TaskEnvelope,
  type TaskStatus,
} from '../../packages/fleet/src/index.js';

const PROTOCOL_DIR = join(process.cwd(), 'packages/fleet/protocol');
const readJson = (name: string): unknown => JSON.parse(readFileSync(join(PROTOCOL_DIR, name), 'utf-8'));

describe('fleet envelope 夹具', () => {
  it('envelope.example.json 合法且往返稳定', () => {
    const example = readJson('envelope.example.json');
    expect(validateEnvelope(example)).toEqual({ ok: true, errors: [] });

    const parsed = parseEnvelope(JSON.stringify(example));
    expect(parsed.v).toBe(FLEET_PROTOCOL_VERSION);

    const once = serializeEnvelope(parsed);
    const twice = serializeEnvelope(parseEnvelope(once));
    expect(twice).toBe(once); // 规范序列化确定
    expect(parseEnvelope(once)).toEqual(parsed); // 往返不丢字段
  });

  it('字段顺序变化不影响规范序列化（canonical）', () => {
    const e: TaskEnvelope = {
      intent: 'x',
      taskId: 't1',
      v: FLEET_PROTOCOL_VERSION,
      from: { device: 'A', agent: 'a' },
      to: { device: 'B', agent: '*' },
      status: 'queued',
      attempts: 0,
      trace: { chain: [] },
    };
    const shuffled = { ...e, trace: { chain: [] as string[] } };
    expect(serializeEnvelope(shuffled)).toBe(serializeEnvelope(e));
  });

  it('非法输入被拒绝（负例）', () => {
    expect(validateEnvelope(null).ok).toBe(false);
    expect(validateEnvelope([]).ok).toBe(false);
    expect(validateEnvelope({}).ok).toBe(false);
    expect(validateEnvelope({ ...({} as object), v: 1, taskId: 't', from: { device: 'A', agent: 'a' }, to: { device: 'B', agent: 'b' }, intent: 'i', status: 'bogus', attempts: 0, trace: { chain: [] } }).ok).toBe(false);
    // attempts 非整数 / 负
    const base = readJson('envelope.example.json') as Record<string, unknown>;
    expect(validateEnvelope({ ...base, attempts: -1 }).ok).toBe(false);
    expect(validateEnvelope({ ...base, attempts: 1.5 }).ok).toBe(false);
    // expiresAt 非有限数
    expect(validateEnvelope({ ...base, expiresAt: Number.NaN }).ok).toBe(false);
    // trace.chain 非字符串数组
    expect(validateEnvelope({ ...base, trace: { chain: [1] } }).ok).toBe(false);
    // parse 抛错
    expect(() => parseEnvelope('{not json')).toThrow(/JSON 解析失败/);
    expect(() => parseEnvelope('{}')).toThrow(/envelope 非法/);
  });
});

describe('fleet 状态机夹具与 TS 常量一致', () => {
  const sm = readJson('state-machine.json') as {
    statuses: string[];
    rank: Record<string, number>;
    terminal: string[];
    terminalPrecedence: Record<string, number>;
    transitions: Record<string, string[]>;
  };

  it('statuses / rank / terminal / precedence 与 TS 出厂值一致', () => {
    expect(sm.statuses).toEqual([...TASK_STATUSES]);
    for (const s of TASK_STATUSES) {
      expect(sm.rank[s]).toBe(STATUS_RANK[s]);
      expect(sm.terminalPrecedence[s]).toBe(TERMINAL_PRECEDENCE[s]);
      expect(sm.terminal.includes(s)).toBe(isTerminal(s));
    }
  });

  it('transitions 表与 TASK_TRANSITIONS / canTransition 一致（含非法迁移拒绝）', () => {
    for (const from of TASK_STATUSES) {
      expect([...(sm.transitions[from] ?? [])].sort()).toEqual([...TASK_TRANSITIONS[from]].sort());
      for (const to of TASK_STATUSES) {
        const allowed = (sm.transitions[from] ?? []).includes(to) || from === to;
        expect(canTransition(from, to)).toBe(allowed);
      }
    }
    expect(canTransition('done', 'running')).toBe(false);
    expect(canTransition('failed', 'done')).toBe(false);
    expect(canTransition('queued', 'claimed')).toBe(true);
    expect(canTransition('queued', 'running')).toBe(false); // 显式迁移表：不可跳级
  });

  it('resolveStatus 可交换且与秩单调（确定性收敛）', () => {
    for (const a of TASK_STATUSES) {
      for (const b of TASK_STATUSES) {
        expect(resolveStatus(a, b)).toBe(resolveStatus(b, a)); // 与到达顺序无关
        expect(STATUS_RANK[resolveStatus(a, b)]).toBeGreaterThanOrEqual(STATUS_RANK[a]!);
        expect(resolveStatus(a, a)).toBe(a);
      }
    }
    // 终态平局：failed 优先于 done（确定性）
    expect(resolveStatus('done', 'failed')).toBe('failed');
    // 非终态 vs 终态：终态胜
    expect(resolveStatus('queued' as TaskStatus, 'done')).toBe('done');
  });

  it('isTaskStatus 守卫', () => {
    expect(isTaskStatus('running')).toBe(true);
    expect(isTaskStatus('nope')).toBe(false);
    expect(isTaskStatus(3)).toBe(false);
  });
});
