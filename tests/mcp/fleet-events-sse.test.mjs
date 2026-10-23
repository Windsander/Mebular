// `/admin/events` 的 fleet 事件接线（真实 HTTP SSE handler，子进程沙箱）。
//
// 与 clouds-api / security-gate 同策略：serve.mjs 经 config.mjs → @mebular/core 的 ESM 桶在
// jest --coverage 下可能触发链接错误，因此用原生 Node 子进程启动真实 handler，再以真实 SSE
// 连接验证：本地 event-appended、远端 events-applied 都能广播 `fleet`，且同一事件只发一次。

import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const HARNESS = String.raw`
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.FLEET_SSE_ROOT;
const { startHttpServer } = await import(pathToFileURL(join(ROOT, 'packages/mcp/src/serve.mjs')).href);

const workspace = await mkdtemp(join(tmpdir(), 'fleet-sse-'));
const home = join(workspace, 'home');
process.env.MEBULAR_USER_HOME = workspace;
process.env.MEBULAR_HOME = home;
process.env.MEBULAR_CLOUD_ROOT = join(workspace, 'cloud');
await mkdir(home, { recursive: true });
await writeFile(join(home, 'fleet.config.json'), JSON.stringify({ namespace: 'tasks' }));

const eventLog = new EventEmitter();
const sync = new EventEmitter();
const events = new Map();
eventLog.getEvent = async (id) => events.get(id) ?? null;
const app = {
  deviceId: 'device-local',
  eventLog,
  sync,
  onConvergence: () => () => {},
};
const service = {
  status: async () => ({ running: true, nodeCount: 1, pendingEventCount: 0, peerId: 'peer-local' }),
};

const taskEvent = (taskId, from, to) => ({
  v: 1,
  eventId: taskId + '#created',
  taskId,
  type: 'created',
  actor: { device: from, agent: 'main' },
  at: 1_700_000_000_000,
  toStatus: 'queued',
  trace: { chain: [] },
  to: { device: to, agent: 'echo' },
  intent: 'run tests',
});
const logEvent = (id, content) => ({
  id,
  type: 'node_created',
  namespace: 'tasks',
  data: { node: { type: 'task_event', namespace: 'tasks', content } },
});

const result = { fleet: [], error: null };
let server = null;
let req = null;
let finished = false;

const finish = async (code) => {
  if (finished) return;
  finished = true;
  try { req?.destroy(); } catch { /* ignore */ }
  try { await server?.close(); } catch { /* ignore */ }
  try { await rm(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
  process.stdout.write('FLEET_SSE_RESULT ' + JSON.stringify(result) + '\n');
  process.exit(code);
};

try {
  server = await startHttpServer({
    home,
    app,
    service,
    config: {},
    buildServer: () => ({}),
    host: '127.0.0.1',
    port: 0,
    auth: 'none',
    deviceId: 'device-local',
    namespace: 'tasks',
    writesEnabled: false,
  });

  let buffer = '';
  let injected = false;
  const port = server.port;
  req = http.get({ host: '127.0.0.1', port, path: '/admin/events' }, (res) => {
    if (res.statusCode !== 200) {
      result.error = 'status ' + res.statusCode;
      void finish(1);
      return;
    }
    res.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const name = /^event: (.+)$/m.exec(raw)?.[1] ?? null;
        const dataText = /^data: (.+)$/m.exec(raw)?.[1] ?? null;
        if (!name) continue;
        let data = null;
        try { data = dataText ? JSON.parse(dataText) : null; } catch { data = null; }
        if (name === 'fleet') result.fleet.push(data);
        if (name === 'hello' && !injected) {
          injected = true;
          // 本地 append：应广播一次
          const local = logEvent('evt-local', taskEvent('task-local', 'device-a', 'device-b'));
          eventLog.emit('event-appended', local);
          // 同一条事件重复 append：不得重复广播
          eventLog.emit('event-appended', local);
          // 远端应用：按 eventIds 回查后广播
          const remote = logEvent('evt-remote', taskEvent('task-remote', 'device-c', 'device-a'));
          events.set('evt-remote', remote);
          sync.emit('events-applied', { eventIds: ['evt-remote'], namespaces: ['tasks'] });
        }
      }
      if (result.fleet.length >= 2) {
        // 给重复投递留出窗口：若无去重会多出第三条
        setTimeout(() => void finish(0), 300);
      }
    });
    res.on('error', (error) => {
      if (finished) return;
      result.error = String(error?.message ?? error);
      void finish(1);
    });
  });
  req.on('error', (error) => {
    if (finished) return;
    result.error = String(error?.message ?? error);
    void finish(1);
  });
  setTimeout(() => { result.error = result.error ?? 'timeout'; void finish(1); }, 8000);
} catch (error) {
  result.error = String(error?.message ?? error);
  await finish(1);
}
`;

const runHarness = () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', HARNESS], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, FLEET_SSE_ROOT: ROOT, NODE_NO_WARNINGS: '1' },
  });
  if (child.status !== 0) {
    throw new Error(`fleet SSE harness failed (exit ${child.status}):\n${child.stderr}\n${child.stdout}`);
  }
  const line = String(child.stdout).split('\n').find((entry) => entry.startsWith('FLEET_SSE_RESULT '));
  if (!line) throw new Error(`fleet SSE harness produced no result:\n${child.stdout}\n${child.stderr}`);
  return JSON.parse(line.slice('FLEET_SSE_RESULT '.length));
};

describe('/admin/events fleet 广播', () => {
  const result = runHarness();

  it('本地 append 与远端 events-applied 都广播，字段符合契约', () => {
    expect(result.error).toBeNull();
    expect(result.fleet).toHaveLength(2);
    const [local, remote] = result.fleet;
    expect(local).toMatchObject({
      fromDeviceId: 'device-a',
      toDeviceId: 'device-b',
      taskId: 'task-local',
      eventType: 'created',
      namespace: 'tasks',
    });
    expect(remote).toMatchObject({
      fromDeviceId: 'device-c',
      toDeviceId: 'device-a',
      taskId: 'task-remote',
      eventType: 'created',
      namespace: 'tasks',
    });
    for (const payload of result.fleet) {
      expect(typeof payload.at).toBe('number');
      expect(Number.isFinite(payload.at)).toBe(true);
      expect(Object.keys(payload).sort()).toEqual(
        ['at', 'eventType', 'fromDeviceId', 'namespace', 'taskId', 'toDeviceId'].sort(),
      );
    }
  });
});
