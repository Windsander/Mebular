// 运行中 daemon 的 HTTP `/mcp` 任务工具：必须复用 live app（同一 EventLog）。
//
// 回归点（E2E 发现）：此前 task-tools 直接调 fleet handler，`openSession` 只拿 `dir` 新建了
// 第二个离线 Mebular —— 写进同一 JSONL，但 daemon 的 EventLog 不感知 append（push-on-write /
// fleet SSE 都不触发）。这里用真实 startServeServer + 真实 HTTP MCP client 验证：
//   1) task_submit 返回 ok；
//   2) daemon 的 live EventLog 收到本地 append（`event-appended`）；
//   3) live app 的 graph 能直接读到该 task_event；
//   4) 后续 task_status 走同一份数据。
//
// 与 provision-mcp / fleet-events-sse 同策略：用原生 Node 子进程跑真实 serve + HTTP handler，
// 避免 serve.mjs → @mebular/core 的 ESM 桶在 jest --coverage 下触发链接错误。

import { describe, it, expect } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MCP_BIN = join(ROOT, 'packages', 'mcp', 'bin', 'mebular.mjs');

const HARNESS = String.raw`
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.LIVE_TASK_ROOT;
const home = process.env.LIVE_TASK_HOME;
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const { startServeServer } = await load('packages/mcp/src/server.mjs');
const { Client, StreamableHTTPClientTransport } = await load('node_modules/@modelcontextprotocol/client/dist/index.mjs');

const result = { errors: [], submit: null, liveGraph: null, liveAppended: 0, status: null };
let srv = null;
let client = null;

try {
  srv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const base = 'http://127.0.0.1:' + srv.port;
  const app = srv.getRuntime()?.app ?? null;
  if (!app) throw new Error('运行中上下文没有 live app');

  const appended = [];
  app.eventLog.on('event-appended', (event) => appended.push(event));

  client = new Client({ name: 'live-task-tools-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));

  const submitted = await client.callTool({
    name: 'task_submit',
    arguments: { intent: 'live-mcp', to: { device: 'device-B', agent: 'echo' } },
  });
  result.submit = submitted.structuredContent ?? null;
  const taskId = result.submit?.taskId;
  if (!result.submit?.ok || typeof taskId !== 'string') {
    throw new Error('task_submit 未返回 ok/taskId：' + JSON.stringify(result.submit));
  }

  // 本地 append 必须发生在 daemon 自己的 EventLog 上（第二个离线实例不可能触发这里）。
  result.liveAppended = appended.filter((event) => JSON.stringify(event).includes(taskId)).length;

  // live app 的内存图直接可见（若工具另开实例写文件，live graph 不会出现这个节点）。
  const nodes = await app.graph.listNodes({ type: 'task_event' });
  const node = nodes.find((entry) => entry?.content?.taskId === taskId) ?? null;
  result.liveGraph = node
    ? { found: true, namespace: node.namespace ?? null, type: node.content?.type ?? null }
    : { found: false };

  const status = await client.callTool({ name: 'task_status', arguments: { taskId } });
  result.status = status.structuredContent ?? null;
  if (result.status?.ok !== true || result.status?.state?.status !== 'queued') {
    throw new Error('task_status 未读到刚提交的任务：' + JSON.stringify(result.status));
  }
} catch (error) {
  result.errors.push(String(error?.stack ?? error));
} finally {
  await client?.close().catch(() => undefined);
  await srv?.close?.().catch(() => undefined);
}

process.stdout.write('LIVE_TASK_RESULT ' + JSON.stringify(result) + '\n');
process.exit(result.errors.length > 0 ? 1 : 0);
`;

describe('运行中 daemon：/mcp 任务工具复用 live app', () => {
  it('task_submit 落在 live EventLog + live graph，task_status 可读回', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mebular-live-task-'));
    const home = join(workspace, 'home');
    const env = {
      ...process.env,
      MEBULAR_HOME: home,
      MEBULAR_USER_HOME: join(workspace, 'user'),
      MEBULAR_CLOUD_ROOT: join(workspace, 'cloud'),
      MEBULAR_STORAGE_PATH: join(home, 'store.jsonl'),
      MEBULAR_NETWORK_ENABLED: '0',
    };
    delete env.MEBULAR_PROVISION;
    delete env.MEBULAR_SERVICE_KIND;
    try {
      // 已初始化 home（config.json + user-master-key.json）：走 READY，不经过引导态。
      execFileSync(process.execPath, [MCP_BIN, 'init'], { env, encoding: 'utf-8' });

      const run = spawnSync(process.execPath, ['--input-type=module', '-e', HARNESS], {
        env: { ...env, LIVE_TASK_ROOT: ROOT, LIVE_TASK_HOME: home },
        encoding: 'utf-8',
        timeout: 120_000,
      });
      const line = String(run.stdout ?? '').split('\n').find((entry) => entry.startsWith('LIVE_TASK_RESULT '));
      if (!line) throw new Error(`harness 未返回结果\n${run.stderr ?? ''}\n${run.stdout ?? ''}`);
      expect(line).toBeDefined();
      const result = JSON.parse(line.slice('LIVE_TASK_RESULT '.length));
      expect(result.errors).toEqual([]);
      expect(result.submit?.ok).toBe(true);
      expect(result.liveAppended).toBeGreaterThanOrEqual(1);
      expect(result.liveGraph).toMatchObject({ found: true, namespace: 'tasks', type: 'created' });
      expect(result.status?.state?.status).toBe('queued');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 120_000);
});
