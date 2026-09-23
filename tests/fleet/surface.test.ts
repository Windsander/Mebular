// W1 工具面：16 工具 handler + CLI 对等表 + 统一 MCP 入口（`mebular mcp`，同 handler）。
// R1：`fleet mcp` 已删除——任务工具经**统一入口**（mebular mcp / HTTP /mcp）暴露；此处用真实 CLI 覆盖。
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
import { execFileSync, spawnSync } from 'node:child_process';

// jest 以仓库根为 cwd
const MCP_BIN = join(process.cwd(), 'packages', 'mcp', 'bin', 'mebular.mjs');

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

  it('统一 MCP 入口（mebular mcp）：27 工具 + 任务 handler 同源 + 结构化错误信封', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mebular-unified-mcp-'));
    try {
      // 守护 home（config.json + user-master-key.json）——记忆面与任务面都可服务
      // 不设 MEBULAR_DEVICE_ID：init 与后续 mcp 用同一派生 deviceId（避免身份文件与 config 不一致）
      const env = { ...process.env, MEBULAR_HOME: dir, MEBULAR_STORAGE_PATH: join(dir, 'store.jsonl') };
      execFileSync(process.execPath, [MCP_BIN, 'init'], { env, encoding: 'utf-8' });
      // SDK 不保证响应顺序：按 JSON-RPC id 取响应（CI 上曾因顺序不同而误判）
      const rpc = (messages: unknown[]): Map<number, Record<string, unknown>> => {
        const input = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
        const out = spawnSync(process.execPath, [MCP_BIN, 'mcp'], { env, input, encoding: 'utf-8', timeout: 30000 });
        const byId = new Map<number, Record<string, unknown>>();
        for (const line of out.stdout.trim().split('\n')) {
          if (!line) continue;
          const parsed = JSON.parse(line) as { id?: number };
          if (typeof parsed.id === 'number') byId.set(parsed.id, parsed as Record<string, unknown>);
        }
        return byId;
      };
      const resultOf = (byId: Map<number, Record<string, unknown>>, id: number): Record<string, unknown> =>
        ((byId.get(id) as { result?: Record<string, unknown> })?.result ?? {});

      const listed = rpc([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
      const names = ((resultOf(listed, 2).tools as Array<{ name: string }>) ?? []).map((t) => t.name);
      expect(names).toHaveLength(27);
      expect(names).toContain('memory_status');
      expect(names).toContain('task_submit');
      expect(names).toContain('task_status');

      const called = rpc([
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'task_quota', arguments: {} } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory_status', arguments: {} } },
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'task_submit', arguments: { to: { device: 'device-B', agent: 'echo' } } } },
        { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'board_create', arguments: { name: 'board-x' } } },
      ]);
      // 任务 handler 与 fleet 同源：task_quota 在守护 home 上可读
      const quota = resultOf(called, 3).structuredContent as { ok?: boolean; device?: string } | undefined;
      expect(quota?.ok).toBe(true);
      expect(typeof quota?.device).toBe('string');
      const memory = resultOf(called, 4).structuredContent as { deviceId?: string } | undefined;
      expect(typeof memory?.deviceId).toBe('string');
      // R3.3：错误信封（缺必填 intent → E_INPUT）
      const bad = resultOf(called, 5) as { isError?: boolean; structuredContent?: { ok?: boolean; error?: { code?: string; message?: string } } };
      expect(bad.isError).toBe(true);
      expect(bad.structuredContent?.ok).toBe(false);
      expect(bad.structuredContent?.error?.code).toBe('E_INPUT');
      // 评审 M1：board_create 在**守护 home**（仅 config.json）上不再 ENOENT（onboard 辅助走 loadToolConfig）
      const board = resultOf(called, 6) as { isError?: boolean; structuredContent?: { ok?: boolean; namespace?: string } };
      expect(board.isError).toBeUndefined();
      expect(board.structuredContent?.ok).toBe(true);
      expect(board.structuredContent?.namespace).toBe('board-x');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
