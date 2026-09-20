// W2 B1：DaemonTaskEventStore（走守护 app 接口；无 Mebular/libp2p/身份）单元验证。
import { describe, it, expect, jest } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import { DaemonTaskEventStore } from '../../packages/fleet/src/index.js';
import type { TaskEvent } from '../../packages/fleet/src/protocol/events.js';

jest.setTimeout(30000);

const evt = (taskId: string): TaskEvent => ({
  v: 1,
  eventId: `${taskId}#created`,
  taskId,
  type: 'created',
  actor: { device: 'device-A', agent: 'board' },
  at: 0,
  toStatus: 'queued',
  trace: { chain: [] },
  to: { device: 'device-B', agent: 'echo' },
  intent: taskId,
});

async function startFakeDaemon(): Promise<{ server: Server; endpoint: string; seenAuth: string[] }> {
  const nodes: Array<{ id: string; type: string; namespace: string; content: unknown }> = [];
  const seenAuth: string[] = [];
  let seq = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    seenAuth.push(String(req.headers.authorization ?? ''));
    if (req.method === 'GET' && url.pathname === '/app/nodes') {
      const ns = url.searchParams.get('namespace');
      const type = url.searchParams.get('type');
      const filtered = nodes.filter((n) => (!ns || n.namespace === ns) && (!type || n.type === type));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: filtered.length, nodes: filtered }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/app/nodes') {
      let data = '';
      req.on('data', (c: Buffer) => (data += c.toString('utf-8')));
      req.on('end', () => {
        const body = JSON.parse(data) as { type: string; namespace?: string; content: unknown };
        nodes.push({ id: `n${++seq}`, type: body.type, namespace: body.namespace ?? 'default', content: body.content });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, node: { id: `n${seq}`, type: body.type, namespace: body.namespace ?? 'default' } }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server, endpoint: `http://127.0.0.1:${port}`, seenAuth };
}

describe('W2 DaemonTaskEventStore', () => {
  it('append（去重）/ all / byTask，经文守护 app 接口；带 token 头', async () => {
    const { server, endpoint, seenAuth } = await startFakeDaemon();
    try {
      const store = new DaemonTaskEventStore({ endpoint, namespace: 'tasks', token: 'tok-1' });
      expect(await store.append(evt('task-1'))).toBe(true);
      expect(await store.append(evt('task-1'))).toBe(false); // 幂等去重
      expect(await store.append(evt('task-2'))).toBe(true);
      const all = await store.all();
      expect(all.map((e) => e.taskId).sort()).toEqual(['task-1', 'task-2']);
      expect((await store.byTask('task-1')).length).toBe(1);
      expect(seenAuth.every((h) => h === 'Bearer tok-1')).toBe(true);
      await store.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('负例：缺 endpoint / 守护返回非 200 → 明确报错（不静默）', async () => {
    expect(() => new DaemonTaskEventStore({ endpoint: '' })).toThrow(/endpoint/);
    const { server, endpoint } = await startFakeDaemon();
    try {
      const store = new DaemonTaskEventStore({ endpoint: `${endpoint}/nope`, namespace: 'tasks' });
      await expect(store.all()).rejects.toThrow(/listNodes 失败/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
