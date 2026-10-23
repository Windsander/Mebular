// 运行中 daemon 的任务工具上下文：注入 live app 后，fleet surface **复用**该实例——
// 不 initialize / 不 shutdown / 不新建离线 Mebular；写入落在 live store（同一 EventLog）。
import { describe, it, expect, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolByName, onboardDevice } from '../../packages/fleet/src/index.js';

jest.setTimeout(30000);

const AGENTS = [{ name: 'echo', kind: 'echo' as const }];

async function setupDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-live-ctx-'));
  await onboardDevice({ dir, device: 'device-A', agents: AGENTS });
  return dir;
}

interface FakeNode {
  type: string;
  content: Record<string, unknown>;
  namespace?: string;
}

/** 最小 live app 替身：只提供 surface 用到的 graph + deviceId + 生命周期探针。 */
function fakeLiveApp() {
  const nodes: FakeNode[] = [];
  const calls = { declared: [] as string[], subscribed: [] as string[] };
  const graph = {
    listNodes: async (filter?: { type?: string }) => nodes.filter((node) => !filter?.type || node.type === filter.type),
    createNode: async (type: string, content: Record<string, unknown>, _edges: unknown[], options?: { namespace?: string }) => {
      nodes.push({ type, content, ...(options?.namespace !== undefined ? { namespace: options.namespace } : {}) });
      return { id: `node-${nodes.length}` };
    },
  };
  const shutdown = jest.fn(async () => {
    throw new Error('live app 不得被工具会话关闭');
  });
  const app = {
    deviceId: 'device-A',
    graph,
    declareNamespace: async ({ namespace }: { namespace: string }) => {
      calls.declared.push(namespace);
      return { id: `evt-declare-${namespace}` };
    },
    subscribeNamespace: async (namespace: string) => {
      calls.subscribed.push(namespace);
      return { id: `evt-sub-${namespace}` };
    },
    shutdown,
  };
  return { app: app as never, nodes, calls, shutdown };
}

describe('fleet surface：live app 上下文', () => {
  it('task_submit 写入 live app 的 store，且 close 不关闭 live app', async () => {
    const dir = await setupDir();
    try {
      const { app, nodes, calls, shutdown } = fakeLiveApp();
      const ctx = { dir, mebular: app };

      const submit = (await toolByName('task_submit')!.handler(
        { intent: 'live-root', to: { device: 'device-B', agent: 'echo' } },
        ctx,
      )) as { ok: boolean; taskId: string; state: { status: string } };

      expect(submit.ok).toBe(true);
      expect(submit.state.status).toBe('queued');
      expect(shutdown).not.toHaveBeenCalled();

      // 事件落在 live app（同一实例）：type/namespace/actor 都来自注入的 app。
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.type).toBe('task_event');
      expect(nodes[0]!.namespace).toBe('tasks');
      expect(nodes[0]!.content.taskId).toBe(submit.taskId);
      expect(nodes[0]!.content.type).toBe('created');
      expect((nodes[0]!.content.actor as { device: string }).device).toBe('device-A');

      // 后续工具调用继续复用同一 app（读回刚写入的事件）。
      const status = (await toolByName('task_status')!.handler({ taskId: submit.taskId }, ctx)) as { ok: boolean; state: { status: string } };
      expect(status.ok).toBe(true);
      expect(status.state.status).toBe('queued');
      expect(nodes).toHaveLength(1);

      const cancel = (await toolByName('task_cancel')!.handler({ taskId: submit.taskId }, ctx)) as { ok: boolean };
      expect(cancel.ok).toBe(true);
      expect(nodes).toHaveLength(2);
      expect(nodes[1]!.content.type).toBe('failed');
      expect(shutdown).not.toHaveBeenCalled();

      // board_create 也复用 live app（公告/订阅写同一 EventLog，不另开离线写者）。
      const board = (await toolByName('board_create')!.handler({ name: 'live-board' }, ctx)) as { ok: boolean; namespace: string };
      expect(board.ok).toBe(true);
      expect(board.namespace).toBe('live-board');
      expect(calls.declared).toEqual(['live-board']);
      expect(calls.subscribed).toEqual(['live-board']);
      expect(shutdown).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('无 live app 时保持离线路径（可用，且不依赖注入）', async () => {
    const dir = await setupDir();
    try {
      const submit = (await toolByName('task_submit')!.handler(
        { intent: 'offline', to: { device: 'device-B', agent: 'echo' } },
        { dir },
      )) as { ok: boolean; taskId: string };
      expect(submit.ok).toBe(true);
      const list = (await toolByName('task_list')!.handler({}, { dir })) as { count: number };
      expect(list.count).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
