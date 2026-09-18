// 1d 夹具先行：协商/闲聊消息与 DAG 计划的语言无关夹具（`protocol/collab.example.json`）
// 必须被实现接受；非法变异必须被拒。线格式未进入 `TaskEvent`（独立消息类型）。

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateNegotiationMessage,
  type NegotiationMessage,
} from '../../packages/fleet/src/collab/negotiation.js';
import { validateChatterMessage, type ChatterMessage } from '../../packages/fleet/src/collab/chatter.js';
import { mapPlanner, childTaskId } from '../../packages/fleet/src/runtime/planner.js';
import type { TaskState } from '../../packages/fleet/src/model.js';

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'packages/fleet/protocol/collab.example.json'), 'utf-8'),
) as { negotiation: NegotiationMessage; chatter: ChatterMessage; dagPlan: Record<string, Array<{ intent: string }>> };

describe('1d 协作夹具', () => {
  it('协商消息夹具合法；非法 kind/round 被拒', () => {
    expect(validateNegotiationMessage(fixture.negotiation)).toEqual({ ok: true, errors: [] });
    expect(validateNegotiationMessage({ ...fixture.negotiation, kind: 'nope' }).ok).toBe(false);
    expect(validateNegotiationMessage({ ...fixture.negotiation, round: -1 }).ok).toBe(false);
  });

  it('闲聊消息夹具合法；非法 topic 被拒', () => {
    expect(validateChatterMessage(fixture.chatter)).toEqual({ ok: true, errors: [] });
    expect(validateChatterMessage({ ...fixture.chatter, topic: '' }).ok).toBe(false);
  });

  it('DAG 计划夹具：root → 2 子任务；子任务 id 确定', () => {
    const planner = mapPlanner(fixture.dagPlan);
    const state = { taskId: 'task-root', intent: 'root' } as TaskState;
    const children = planner.plan(state, { ok: true, resultRef: 'ECHO:root' });
    expect(children.map((c) => c.intent)).toEqual(['child-0', 'child-1']);
    expect(childTaskId('task-root', 0)).toBe('task-root~c0');
    expect(mapPlanner(fixture.dagPlan).plan({ taskId: 'x', intent: 'child-0' } as TaskState, { ok: true })).toEqual([]);
  });
});
