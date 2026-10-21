// P2 MCP facade 集成测试：UNINITIALIZED 下 /mcp 可握手 / 列表，tools/call 返回 NOT_INITIALIZED；
// create 后同一 HTTP MCP client/session 原地恢复（不 reconnect / 不重新 initialize）。
//
// 与 provision-lifecycle 同策略：用原生 Node 子进程跑真实 startServeServer + HTTP handler，
// 避免 serve.mjs → @mebular/core 的 ESM 桶在 jest --coverage 下触发链接错误。

import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const HARNESS = String.raw`
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.P2_MCP_ROOT;
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { startServeServer } = await load('packages/mcp/src/server.mjs');
const { Client, StreamableHTTPClientTransport } = await load('node_modules/@modelcontextprotocol/client/dist/index.mjs');
const fleet = await load('packages/fleet/dist/index.js');
const core = await load('dist/index.js');

const workspace = await mkdtemp(join(tmpdir(), 'p2-mcp-'));
const userHome = join(workspace, 'user');
const home = join(workspace, 'home');
const out = { pid: process.pid, cases: {} };

process.env.MEBULAR_USER_HOME = userHome;
process.env.MEBULAR_NETWORK_ENABLED = '0';
process.env.MEBULAR_HOME = home;
process.env.MEBULAR_CLOUD_ROOT = join(workspace, 'cloud');
delete process.env.MEBULAR_PROVISION;
delete process.env.MEBULAR_STORAGE_PATH;
delete process.env.MEBULAR_SERVICE_KIND;

const readJson = async (path) => {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return null; }
};

const csrf = async (base) => {
  const page = await fetch(base + '/console/');
  return {
    token: page.headers.get('x-mebular-csrf'),
    cookie: page.headers.getSetCookie().find((value) => value.startsWith('mebular_csrf=')).split(';')[0],
  };
};

const post = async (base, path, body, auth) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mebular-csrf': auth.token,
      cookie: auth.cookie,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const getJson = async (base, path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json().catch(() => null) };
};

function toolSummary(result) {
  return (result?.tools ?? []).map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

const srv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
const base = 'http://127.0.0.1:' + srv.port;
const mcpHttpStatuses = [];
const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
  fetch: async (...args) => {
    const res = await fetch(...args);
    mcpHttpStatuses.push(res.status);
    return res;
  },
});
const client = new Client({ name: 'p2-mcp-test', version: '1.0.0' });
try {
  await client.connect(transport);
  const sessionIdBefore = transport.sessionId ?? null;
  const toolsBefore = toolSummary(await client.listTools());
  const promptsBefore = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
  const memoryBefore = await client.callTool({ name: 'memory_status', arguments: {} });
  const taskBefore = await client.callTool({ name: 'task_list', arguments: {} });
  const statusesBeforeCreate = [...mcpHttpStatuses];

  const auth = await csrf(base);
  const clientsList = await getJson(base, '/admin/api/clients');
  out.cases.clientsList = {
    status: clientsList.status,
    ids: (clientsList.body?.clients ?? []).map((entry) => entry.id),
  };
  const noCsrfRes = await fetch(base + '/admin/api/clients/opencode/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  out.cases.connectNoCsrf = { status: noCsrfRes.status, body: await noCsrfRes.json().catch(() => null) };
  out.cases.configBeforeConnect = await readJson(join(userHome, '.config', 'opencode', 'opencode.json'));
  out.cases.preview = await post(base, '/admin/api/clients/opencode/preview', {}, auth);
  out.cases.connect = await post(base, '/admin/api/clients/opencode/connect', {}, auth);
  out.cases.verify = await post(base, '/admin/api/clients/opencode/verify', {}, auth);
  out.cases.opencodeConfig = await readJson(join(userHome, '.config', 'opencode', 'opencode.json'));
  out.cases.blocked = {
    overview: await getJson(base, '/admin/api/overview'),
    memories: await getJson(base, '/admin/api/memories'),
    net: await getJson(base, '/admin/api/net'),
    settings: await getJson(base, '/admin/api/settings'),
    appNetwork: await getJson(base, '/app/network'),
  };
  out.cases.phaseBefore = srv.getState().phase;
  out.cases.portBefore = srv.port;

  out.cases.create = await post(base, '/app/provision/create', {
    confirm: true,
    deviceName: 'P2 测试机',
    cloudName: 'P2 测试忆云',
  }, auth);
  out.cases.opencodeConfigAfterCreate = await readJson(join(userHome, '.config', 'opencode', 'opencode.json'));

  // 关键：不 close / 不重建 transport / 不再 connect —— 直接在同一 client 上继续调用。
  const memoryAfter = await client.callTool({ name: 'memory_status', arguments: {} });
  const toolsAfter = toolSummary(await client.listTools());
  const promptsAfter = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
  const sessionIdAfter = transport.sessionId ?? null;

  out.cases.mcp = {
    sessionIdBefore,
    sessionIdAfter,
    toolsBefore,
    toolsAfter,
    promptsBefore,
    promptsAfter,
    memoryBefore,
    taskBefore,
    memoryAfter,
    statusesBeforeCreate,
    statusesAll: [...mcpHttpStatuses],
  };
  out.cases.phaseAfter = srv.getState().phase;
  out.cases.portAfter = srv.port;
  out.cases.clientsAfter = await getJson(base, '/admin/api/clients');
} finally {
  await client.close().catch(() => undefined);
  await srv.close();
}

// ---------- join：同一 MCP session 在热加入后原地恢复 ----------
{
  const inviterHome = join(workspace, 'inviter');
  const joinHome = join(workspace, 'join');
  process.env.MEBULAR_HOME = joinHome;
  process.env.MEBULAR_CLOUD_ROOT = join(workspace, 'join-cloud');
  await fleet.onboardDevice({
    dir: inviterHome,
    device: 'device-inviter',
    agents: [{ name: 'echo', kind: 'echo' }],
  });
  const inviterCfg = await fleet.loadFleetConfig(fleet.fleetConfigPath(inviterHome));
  const inviterEnc = await fleet.readMasterKeyFile(inviterCfg.masterKeyFile);
  const inviter = new core.Mebular(fleet.offlineMebularOptions(inviterCfg, inviterEnc));
  await inviter.initialize();
  const joinSvc = await fleet.startJoinService({
    mebular: inviter,
    deviceId: 'device-inviter',
    storagePath: join(inviterHome, 'store.jsonl'),
    port: 0,
  });
  const token = fleet.encodeJoinToken(await fleet.buildJoinToken({
    mebular: inviter,
    deviceId: 'device-inviter',
    namespace: 'tasks',
    endpoint: 'http://127.0.0.1:' + joinSvc.port,
    ttlMs: 600000,
  }));
  const joinSrv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const joinBase = 'http://127.0.0.1:' + joinSrv.port;
  const joinTransport = new StreamableHTTPClientTransport(new URL(joinBase + '/mcp'));
  const joinClient = new Client({ name: 'p2-mcp-join-test', version: '1.0.0' });
  try {
    await joinClient.connect(joinTransport);
    const sessionIdBefore = joinTransport.sessionId ?? null;
    const before = await joinClient.callTool({ name: 'memory_status', arguments: {} });
    const joinAuth = await csrf(joinBase);
    const response = await post(joinBase, '/app/provision/join', {
      confirm: true,
      deviceName: '加入机',
      token,
    }, joinAuth);
    // 关键：不 reconnect / 不重新 initialize。
    const after = await joinClient.callTool({ name: 'memory_status', arguments: {} });
    out.cases.join = {
      sessionIdBefore,
      sessionIdAfter: joinTransport.sessionId ?? null,
      before,
      after,
      response,
      phase: joinSrv.getState().phase,
      port: joinSrv.port,
    };
  } finally {
    await joinClient.close().catch(() => undefined);
    await joinSrv.close();
    await joinSvc.close().catch(() => undefined);
    await inviter.shutdown().catch(() => undefined);
  }
}

await rm(workspace, { recursive: true, force: true });
console.log('P2_RESULT ' + JSON.stringify(out));
`;

function runHarness() {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', HARNESS], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 240_000,
    env: { ...process.env, P2_MCP_ROOT: ROOT, NODE_NO_WARNINGS: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`P2 MCP harness failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`);
  }
  const line = String(result.stdout).split('\n').find((entry) => entry.startsWith('P2_RESULT '));
  if (!line) throw new Error(`P2 MCP harness produced no result:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice('P2_RESULT '.length));
}

const result = runHarness();

function errorOf(call) {
  return call?.structuredContent?.error ?? null;
}

describe('P2 UNINITIALIZED MCP facade', () => {
  it('UNINITIALIZED：initialize / tools/list / prompts/list 成功，tools/list 为 29 且工具面稳定', () => {
    const c = result.cases.mcp;
    expect(c.sessionIdBefore).toEqual(expect.any(String));
    expect(c.toolsBefore).toHaveLength(29);
    expect(c.toolsBefore.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'memory_status', 'memory_write', 'task_list', 'task_submit', 'board_create',
    ]));
    expect(c.toolsBefore.every((tool) => tool.inputSchema && typeof tool.inputSchema === 'object')).toBe(true);
    expect(c.promptsBefore).toContain('memory_policy');
  });

  it('UNINITIALIZED：所有 tools/call 返回稳定 NOT_INITIALIZED 业务错误（无 409/500）', () => {
    const c = result.cases.mcp;
    expect(c.memoryBefore.isError).toBe(true);
    expect(errorOf(c.memoryBefore)).toMatchObject({ code: 'NOT_INITIALIZED', message: '请先新建或加入忆云' });
    expect(c.taskBefore.isError).toBe(true);
    expect(errorOf(c.taskBefore)).toMatchObject({ code: 'NOT_INITIALIZED', message: '请先新建或加入忆云' });
    expect(c.statusesBeforeCreate.length).toBeGreaterThan(0);
    expect(c.statusesBeforeCreate).not.toContain(409);
    expect(c.statusesBeforeCreate).not.toContain(500);
  });

  it('UNINITIALIZED：助手 clients list / preview / connect 可用，verify 明确返回待初始化', () => {
    const c = result.cases;
    expect(c.clientsList.status).toBe(200);
    expect(c.clientsList.ids).toContain('opencode');
    expect(c.connectNoCsrf.status).toBe(403);
    expect(c.configBeforeConnect).toBeNull();
    expect(c.preview.status).toBe(200);
    expect(c.preview.body.ok).toBe(true);
    expect(c.preview.body.preview).toContain('mebular');
    expect(c.connect.status).toBe(200);
    expect(c.connect.body).toMatchObject({ ok: true, changed: true });
    expect(c.verify.status).toBe(200);
    expect(c.verify.body).toMatchObject({
      ok: false,
      state: 'pending-initialization',
      pendingInitialization: true,
      reason: 'not_initialized',
    });
  });

  it('UNINITIALIZED：助手配置以 HTTP /mcp 写入，READY 后同一路径无需重写', () => {
    const entry = result.cases.opencodeConfig?.mcp?.servers?.mebular;
    expect(entry).toMatchObject({ type: 'remote', url: expect.stringMatching(/\/mcp$/) });
    expect(result.cases.opencodeConfigAfterCreate).toEqual(result.cases.opencodeConfig);
  });

  it('UNINITIALIZED：memory / network / admin 数据面仍 409，不被 facade 放宽', () => {
    const c = result.cases.blocked;
    for (const res of [c.overview, c.memories, c.net, c.settings, c.appNetwork]) {
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('provision_required');
    }
  });

  it('create 后同一 MCP session 原地恢复：不 reconnect / 不重新 initialize', () => {
    const c = result.cases;
    expect(c.create.status).toBe(200);
    expect(c.create.body).toMatchObject({ ok: true, action: 'create', initialized: true, phase: 'READY' });
    expect(c.portAfter).toBe(c.portBefore);
    expect(c.phaseBefore).toBe('UNINITIALIZED');
    expect(c.phaseAfter).toBe('READY');
    expect(c.mcp.sessionIdAfter).toBe(c.mcp.sessionIdBefore);
    expect(c.mcp.memoryAfter.isError).not.toBe(true);
    expect(c.mcp.memoryAfter.structuredContent?.deviceId).toEqual(expect.any(String));
    expect(c.mcp.toolsAfter).toEqual(c.mcp.toolsBefore);
    expect(c.mcp.promptsAfter).toEqual(c.mcp.promptsBefore);
  });

  it('READY 后助手列表在同一服务器上继续可用', () => {
    expect(result.cases.clientsAfter.status).toBe(200);
    expect(result.cases.clientsAfter.body.clients.length).toBeGreaterThan(0);
  });

  it('join 后同一 MCP session 原地恢复：tools/call 从 NOT_INITIALIZED 变为成功', () => {
    const c = result.cases.join;
    expect(c.response.status).toBe(200);
    expect(c.response.body).toMatchObject({ ok: true, action: 'join', initialized: true, phase: 'READY' });
    expect(c.phase).toBe('READY');
    expect(c.sessionIdAfter).toBe(c.sessionIdBefore);
    expect(errorOf(c.before)).toMatchObject({ code: 'NOT_INITIALIZED' });
    expect(c.after.isError).not.toBe(true);
    expect(c.after.structuredContent?.deviceId).toEqual(expect.any(String));
  });
});
