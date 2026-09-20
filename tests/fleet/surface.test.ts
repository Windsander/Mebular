// W1 工具面：16 工具 handler + CLI 对等表 + MCP JSON-RPC（同一 handler）。
import { describe, it, expect, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  toolByName,
  statusOfEventType,
  toolByCli,
  toolCliTable,
  onboardDevice,
} from '../../packages/fleet/src/index.js';
import { handleMcpMessage, runFleetMcp } from '../../packages/fleet/src/mcp.js';
import { Readable, Writable } from 'node:stream';

jest.setTimeout(60000);

const AGENTS = [{ name: 'echo', kind: 'echo' as const }];

async function setupDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-surface-'));
  await onboardDevice({ dir, device: 'device-A', agents: AGENTS, configGrant: false, policyIssuers: ['device-A'] });
  return dir;
}

describe('W1 工具面（CLI/MCP 同一 handler）', () => {
  it('工具 ↔ CLI 对照表：16 项、1:1、名字唯一', () => {
    const table = toolCliTable();
    expect(table).toHaveLength(16);
    expect(new Set(table.map((t) => t.tool)).size).toBe(16);
    expect(new Set(table.map((t) => t.cli)).size).toBe(16);
    expect(toolByName('task_submit')?.cli).toBe('task_submit');
    expect(toolByCli('board_create')?.name).toBe('board_create');
  });

  it('核心 handler：submit/list/status/history/children/summarize/subscribe/cancel/retry/batch/negotiate/chatter/quota/targets/board', async () => {
    const dir = await setupDir();
    try {
      const ctx = { dir };
      const submit = (await toolByName('task_submit')!.handler({ intent: 'root', to: { device: 'device-B', agent: 'echo' }, budget: { maxDepth: 2, maxChildren: 4, maxTasks: 8 }, dispatch: 'children-ok' }, ctx)) as { ok: boolean; taskId: string };
      expect(submit.ok).toBe(true);
      expect(typeof submit.taskId).toBe('string');

      const status = (await toolByName('task_status')!.handler({ taskId: submit.taskId }, ctx)) as { ok: boolean; state: { status: string } };
      expect(status.ok).toBe(true);
      expect(status.state.status).toBe('queued');

      const list = (await toolByName('task_list')!.handler({}, ctx)) as { count: number };
      expect(list.count).toBeGreaterThanOrEqual(1);

      const history = (await toolByName('task_history')!.handler({ taskId: submit.taskId }, ctx)) as { events: unknown[] };
      expect(history.events.length).toBe(1);

      const children = (await toolByName('task_children')!.handler({ taskId: submit.taskId }, ctx)) as { children: string[] };
      expect(children.children).toEqual([]);

      const summarize = (await toolByName('task_summarize')!.handler({ taskId: submit.taskId }, ctx)) as { root: string };
      expect(summarize.root).toBe(submit.taskId);

      const subscribe = (await toolByName('task_subscribe')!.handler({}, ctx)) as { changed: unknown[]; cursor: Record<string, string> };
      expect(subscribe.changed.length).toBeGreaterThanOrEqual(1);
      const again = (await toolByName('task_subscribe')!.handler({ cursor: subscribe.cursor }, ctx)) as { changed: unknown[] };
      expect(again.changed).toEqual([]);

      // negotiate（消息类型随记忆同步；此处只验证 append 结构与幂等）
      const neg = (await toolByName('task_negotiate')!.handler({ taskId: submit.taskId, kind: 'counter', round: 1, text: 'more' }, ctx)) as { ok: boolean; messageId: string };
      expect(neg.ok).toBe(true);
      expect(neg.messageId).toContain(submit.taskId);

      // chatter
      const sent = (await toolByName('chatter_send')!.handler({ topic: 'status', text: 'hi' }, ctx)) as { ok: boolean; decision: string };
      expect(sent.ok).toBe(true);
      const inbox = (await toolByName('chatter_inbox')!.handler({}, ctx)) as { count: number };
      expect(inbox.count).toBe(1);

      // batch
      const batch = (await toolByName('task_submit_batch')!.handler({ tasks: [{ intent: 'b1', to: { device: 'device-B', agent: 'echo' } }, { intent: 'b2', to: { device: 'device-B', agent: 'echo' } }] }, ctx)) as { ok: boolean; count: number };
      expect(batch.ok).toBe(true);
      expect(batch.count).toBe(2);

      // retry（新任务 causedBy 原任务）与 cancel
      const retry = (await toolByName('task_retry')!.handler({ taskId: submit.taskId }, ctx)) as { ok: boolean; taskId: string; retryOf: string };
      expect(retry.ok).toBe(true);
      expect(retry.retryOf).toBe(submit.taskId);
      const cancel = (await toolByName('task_cancel')!.handler({ taskId: retry.taskId }, ctx)) as { ok: boolean; status: string };
      expect(cancel.ok).toBe(true);
      expect(cancel.status).toBe('failed');
      const cancelTerminal = (await toolByName('task_cancel')!.handler({ taskId: retry.taskId }, ctx)) as { ok: boolean; reason: string };
      expect(cancelTerminal.reason).toBe('already-terminal');

      const quota = (await toolByName('task_quota')!.handler({}, ctx)) as { limitPerDevice: number };
      expect(quota.limitPerDevice).toBeGreaterThan(0);

      const targets = (await toolByName('task_targets')!.handler({}, ctx)) as { ok: boolean; targets: unknown[] };
      expect(targets.ok).toBe(true);

      const board = (await toolByName('board_create')!.handler({ name: 'team', with: ['device-B'] }, ctx)) as { ok: boolean; members: string[]; granted: Array<{ device: string }> };
      expect(board.ok).toBe(true);
      expect(board.members).toContain('device-A');
      expect(board.granted[0]!.device).toBe('device-B');
      // 额外分支：payloadRef/expiresAt/causedBy/chain、过滤、unknown、无 with 的 board、statusOfEventType
      const withMeta = (await toolByName('task_submit')!.handler({ intent: 'meta', to: { device: 'device-B', agent: 'echo' }, payloadRef: 'ref-1', expiresAt: 123, causedBy: submit.taskId, chain: [] }, ctx)) as { ok: boolean; state: { trace: { causedBy?: string } } };
      expect(withMeta.ok).toBe(true);
      expect(withMeta.state.trace.causedBy).toBe(submit.taskId);
      const filtered = (await toolByName('task_list')!.handler({ status: 'queued', fromDevice: 'device-A' }, ctx)) as { count: number };
      expect(filtered.count).toBeGreaterThanOrEqual(1);
      await expect(toolByName('task_cancel')!.handler({ taskId: 'nope' }, ctx)).rejects.toThrow(/不存在/);
      await expect(toolByName('task_retry')!.handler({ taskId: 'nope' }, ctx)).rejects.toThrow(/不存在/);
      const chat2 = (await toolByName('chatter_send')!.handler({ topic: 't', text: 'x', messageId: 'fixed-1' }, ctx)) as { ok: boolean; messageId: string };
      expect(chat2.messageId).toBe('fixed-1');
      const board2 = (await toolByName('board_create')!.handler({ name: 'solo' }, ctx)) as { ok: boolean; granted: unknown[] };
      expect(board2.ok).toBe(true);
      expect(board2.granted).toEqual([]);
      // targets 走 config.peers 分支（approve 登记 device-B 后遍历）
      const { approveDevice } = await import('../../packages/fleet/src/index.js');
      await approveDevice(dir, { device: 'device-B', namespace: 'tasks' });
      const targets2 = (await toolByName('task_targets')!.handler({}, ctx)) as { authorized: string[] };
      expect(Array.isArray(targets2.authorized)).toBe(true);
      expect(statusOfEventType('done')).toBe('done');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('MCP JSON-RPC：initialize / tools/list / tools/call / 负例 / 通知', async () => {
    const dir = await setupDir();
    try {
      const ctx = { dir };
      const init = JSON.parse((await handleMcpMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), ctx))!) as { result: { protocolVersion: string; serverInfo: { name: string } } };
      expect(init.result.protocolVersion).toBe('2024-11-05');
      expect(init.result.serverInfo.name).toBe('mebular-fleet');

      const list = JSON.parse((await handleMcpMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), ctx))!) as { result: { tools: Array<{ name: string }> } };
      expect(list.result.tools).toHaveLength(16);

      const call = JSON.parse((await handleMcpMessage(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task_submit', arguments: { intent: 'x', to: { device: 'device-B', agent: 'echo' } } } }), ctx))!) as { result: { content: Array<{ text: string }> } };
      const parsed = JSON.parse(call.result.content[0]!.text) as { ok: boolean };
      expect(parsed.ok).toBe(true);

      const unknown = JSON.parse((await handleMcpMessage(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } }), ctx))!) as { error: { code: number } };
      expect(unknown.error.code).toBe(-32602);

      const bad = JSON.parse((await handleMcpMessage('not json', ctx))!) as { error: { code: number } };
      expect(bad.error.code).toBe(-32700);

      const notification = await handleMcpMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), ctx);
      expect(notification).toBeNull();

      const notFound = JSON.parse((await handleMcpMessage(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'no/such' }), ctx))!) as { error: { code: number } };
      expect(notFound.error.code).toBe(-32601);

      // stdio 主循环（含无换行尾行）
      let out = '';
      const sink = new Writable({ write(chunk, _enc, cb) { out += String(chunk); cb(); } });
      const input = Readable.from([
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n\n',
        JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) + '\n',
        JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize' }),
      ]);
      await runFleetMcp({ dir }, input, sink);
      const lines = out.trim().split('\n').map((l) => JSON.parse(l) as { id: number });
      expect(lines.map((l) => l.id)).toEqual([9, 10]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
