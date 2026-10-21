// P1 生命周期集成测试：UNINITIALIZED → INITIALIZING → READY，同一进程 / 同一端口。
//
// 与 clouds-api 同策略：serve.mjs → config.mjs → @mebular/core 的 ESM 桶在 jest --coverage 下
// 可能触发链接错误，因此用原生 Node 子进程跑真实 startServeServer + HTTP handler。

import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const HARNESS = String.raw`
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.P1_LIFECYCLE_ROOT;
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { startServeServer } = await load('packages/mcp/src/server.mjs');
const fleet = await load('packages/fleet/dist/index.js');
const core = await load('dist/index.js');

const workspace = await mkdtemp(join(tmpdir(), 'p1-lifecycle-'));
const out = { pid: process.pid, homes: {}, cases: {} };

process.env.MEBULAR_USER_HOME = workspace;
process.env.MEBULAR_NETWORK_ENABLED = '0';
delete process.env.MEBULAR_PROVISION;
delete process.env.MEBULAR_STORAGE_PATH;
delete process.env.MEBULAR_SERVICE_KIND;

const useHome = (name) => {
  const home = join(workspace, name);
  process.env.MEBULAR_HOME = home;
  process.env.MEBULAR_CLOUD_ROOT = home;
  out.homes[name] = home;
  return home;
};

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

// ---------- 1) create：同一 PID / 端口热初始化 ----------
{
  const home = useHome('create');
  const srv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const base = 'http://127.0.0.1:' + srv.port;
  out.cases.create = { port: srv.port, pid: process.pid };
  try {
    const before = await getJson(base, '/app/provision/status');
    out.cases.create.statusBefore = before;
    out.cases.create.overviewBefore = await getJson(base, '/admin/api/overview');
    out.cases.create.configBefore = await readJson(join(home, 'config.json'));

    const auth = await csrf(base);
    out.cases.create.response = await post(base, '/app/provision/create', {
      confirm: true,
      deviceName: '测试机',
      cloudName: '测试忆云',
    }, auth);
    out.cases.create.healthAfter = await getJson(base, '/healthz');
    out.cases.create.overviewAfter = await getJson(base, '/admin/api/overview');
    out.cases.create.statusAfter = await getJson(base, '/app/provision/status');
    out.cases.create.portAfter = srv.port;
    out.cases.create.state = srv.getState();
    out.cases.create.config = await readJson(join(home, 'config.json'));
    out.cases.create.registry = await readJson(join(home, 'profiles.json'));
    out.cases.create.files = await readdir(home);
    out.cases.create.duplicate = await post(base, '/app/provision/create', { confirm: true }, auth);
  } finally {
    await srv.close();
  }
}

// ---------- 2) 失败回滚：config 已写但 app 起不来 → 清干净并允许原地重试 ----------
{
  const home = useHome('rollback');
  // 跨平台失败注入：父路径是一个普通文件，mkdir/打开 storage 必失败。
  // （旧的 /dev/null/... 在 Windows 会变成普通路径，导致 create 反而成功。）
  const blockedStorageParent = join(workspace, 'blocked-storage-parent');
  await writeFile(blockedStorageParent, 'not a directory');
  process.env.MEBULAR_STORAGE_PATH = join(blockedStorageParent, 'store.jsonl');
  const srv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const base = 'http://127.0.0.1:' + srv.port;
  out.cases.rollback = { port: srv.port, pid: process.pid };
  try {
    const auth = await csrf(base);
    out.cases.rollback.invalidName = await post(base, '/app/provision/create', {
      confirm: true,
      deviceName: '合法设备',
      cloudName: 'a/b',
    }, auth);
    out.cases.rollback.invalidDevice = await post(base, '/app/provision/create', {
      confirm: true,
      deviceName: 'a/b',
    }, auth);
    out.cases.rollback.configAfterInvalidName = await readJson(join(home, 'config.json'));

    out.cases.rollback.failed = await post(base, '/app/provision/create', {
      confirm: true,
      deviceName: '失败机',
    }, auth);
    out.cases.rollback.filesAfterFailure = await readdir(home);
    out.cases.rollback.configAfterFailure = await readJson(join(home, 'config.json'));
    out.cases.rollback.keyAfterFailure = await readJson(join(home, 'user-master-key.json'));
    out.cases.rollback.registryAfterFailure = await readJson(join(home, 'profiles.json'));
    out.cases.rollback.statusAfterFailure = await getJson(base, '/app/provision/status');
    out.cases.rollback.lock = await readJson(join(home, 'lock'));
    out.cases.rollback.portAfterFailure = srv.port;

    delete process.env.MEBULAR_STORAGE_PATH;
    out.cases.rollback.retry = await post(base, '/app/provision/create', {
      confirm: true,
      deviceName: '重试机',
    }, auth);
    out.cases.rollback.overviewAfterRetry = await getJson(base, '/admin/api/overview');
    out.cases.rollback.portAfterRetry = srv.port;
    out.cases.rollback.stateAfterRetry = srv.getState();
  } finally {
    await srv.close();
  }
}

// ---------- 3) 服务托管 / 前台同一条路径：不触发 launchd / 重启 ----------
{
  const home = useHome('service');
  process.env.MEBULAR_SERVICE_KIND = 'launchd';
  const srv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const base = 'http://127.0.0.1:' + srv.port;
  out.cases.service = { port: srv.port, pid: process.pid };
  try {
    const auth = await csrf(base);
    out.cases.service.response = await post(base, '/app/provision/create', {
      confirm: true,
      deviceName: '服务机',
    }, auth);
    out.cases.service.overview = await getJson(base, '/admin/api/overview');
    out.cases.service.portAfter = srv.port;
    out.cases.service.state = srv.getState();
  } finally {
    await srv.close();
    delete process.env.MEBULAR_SERVICE_KIND;
  }
}

// ---------- 4) join：令牌加入后同一 PID / 端口热初始化；token 无忆云名 → 默认档案名 ----------
{
  const inviterHome = join(workspace, 'inviter');
  const home = useHome('join');
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
  const endpoint = 'http://127.0.0.1:' + joinSvc.port;
  const token = fleet.encodeJoinToken(await fleet.buildJoinToken({
    mebular: inviter,
    deviceId: 'device-inviter',
    namespace: 'tasks',
    endpoint,
    ttlMs: 600000,
  }));
  const srv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const base = 'http://127.0.0.1:' + srv.port;
  out.cases.join = { port: srv.port, pid: process.pid };
  try {
    const auth = await csrf(base);
    out.cases.join.response = await post(base, '/app/provision/join', {
      confirm: true,
      deviceName: '加入机',
      token,
    }, auth);
    out.cases.join.overview = await getJson(base, '/admin/api/overview');
    out.cases.join.statusAfter = await getJson(base, '/app/provision/status');
    out.cases.join.portAfter = srv.port;
    out.cases.join.state = srv.getState();
    out.cases.join.registry = await readJson(join(home, 'profiles.json'));
    out.cases.join.master = await readJson(join(home, 'master-key.json'));
    out.cases.join.identityExists = await readFile(join(home, 'store.jsonl.identity.json'), 'utf-8').then(() => true).catch(() => false);
    out.cases.join.config = await readJson(join(home, 'config.json'));
  } finally {
    await srv.close();
    await joinSvc.close().catch(() => undefined);
    await inviter.shutdown().catch(() => undefined);
  }
}

await rm(workspace, { recursive: true, force: true });
console.log('P1_RESULT ' + JSON.stringify(out));
`;

function runHarness() {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', HARNESS], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 240_000,
    env: { ...process.env, P1_LIFECYCLE_ROOT: ROOT, NODE_NO_WARNINGS: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`P1 lifecycle harness failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`);
  }
  const line = String(result.stdout).split('\n').find((entry) => entry.startsWith('P1_RESULT '));
  if (!line) throw new Error(`P1 lifecycle harness produced no result:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice('P1_RESULT '.length));
}

const result = runHarness();

describe('P1 单进程热初始化生命周期', () => {
  it('UNINITIALIZED：引导端点可用；admin API 409；尚未写 config', () => {
    const c = result.cases.create;
    expect(c.statusBefore.status).toBe(200);
    expect(c.statusBefore.body).toMatchObject({ provision: true, phase: 'UNINITIALIZED', restartRequired: false });
    expect(c.overviewBefore.status).toBe(409);
    expect(c.overviewBefore.body.error).toBe('provision_required');
    expect(c.configBefore).toBeNull();
  });

  it('create：同一 PID / 同一监听端口完成热初始化，READY 后 admin API 200', () => {
    const c = result.cases.create;
    expect(c.pid).toBe(result.pid);
    expect(c.response.status).toBe(200);
    expect(c.response.body).toMatchObject({ ok: true, action: 'create', initialized: true, phase: 'READY' });
    expect(c.response.body.restart).toBeUndefined();
    expect(c.response.body.restarting).toBeUndefined();
    expect(c.portAfter).toBe(c.port);
    expect(c.healthAfter.status).toBe(200);
    expect(c.overviewAfter.status).toBe(200);
    expect(c.state).toMatchObject({ phase: 'READY', hotInitialized: true });
    expect(c.statusAfter.status).toBe(404);
  });

  it('create：写入 config + profile registry（current/default + 忆云名），设备名生效', () => {
    const c = result.cases.create;
    expect(c.config).toMatchObject({ deviceName: '测试机', mcp: { http: { port: c.port } } });
    expect(c.registry).toMatchObject({ v: 1, current: 'default' });
    expect(c.registry.profiles).toHaveLength(1);
    expect(c.registry.profiles[0]).toMatchObject({ id: 'default', name: '测试忆云' });
    expect(c.overviewAfter.body.cloud?.name).toBe('测试忆云');
    expect(c.overviewAfter.body.device?.name).toBe('测试机');
  });

  it('重复 create：409 already_provisioned（不重复写盘 / 不重启）', () => {
    const c = result.cases.create;
    expect(c.duplicate.status).toBe(409);
    expect(c.duplicate.body).toMatchObject({
      error: 'already_provisioned',
      provisioned: true,
      initialized: true,
      restartRequired: false,
    });
  });

  it('失败回滚：热初始化失败后清掉 config / 主密钥 / registry，锁仍由本进程持有并可原地重试', () => {
    const c = result.cases.rollback;
    expect(c.invalidName.status).toBe(400);
    expect(c.invalidName.body.error).toBe('INVALID_NAME');
    expect(c.invalidDevice.status).toBe(400);
    expect(c.invalidDevice.body.error).toBe('INVALID_NAME');
    expect(c.configAfterInvalidName).toBeNull();
    expect(c.failed.status).toBe(400);
    expect(c.failed.body).toMatchObject({ error: 'STORAGE_INIT_FAILED', phase: 'UNINITIALIZED' });
    expect(c.filesAfterFailure).toEqual(['lock']);
    expect(c.configAfterFailure).toBeNull();
    expect(c.keyAfterFailure).toBeNull();
    expect(c.registryAfterFailure).toBeNull();
    expect(c.statusAfterFailure.body.phase).toBe('UNINITIALIZED');
    expect(c.lock.pid).toBe(result.pid);
    expect(c.portAfterFailure).toBe(c.port);
    expect(c.retry.status).toBe(200);
    expect(c.retry.body).toMatchObject({ action: 'create', initialized: true, phase: 'READY' });
    expect(c.overviewAfterRetry.status).toBe(200);
    expect(c.portAfterRetry).toBe(c.port);
    expect(c.stateAfterRetry.phase).toBe('READY');
  });

  it('服务托管路径与前台一致：不调用 launchd / 不产生 restart 计划', () => {
    const c = result.cases.service;
    expect(c.response.status).toBe(200);
    expect(c.response.body).toMatchObject({ initialized: true, phase: 'READY' });
    expect(c.response.body.restart).toBeUndefined();
    expect(c.response.body.restarting).toBeUndefined();
    expect(c.overview.status).toBe(200);
    expect(c.portAfter).toBe(c.port);
    expect(c.pid).toBe(result.pid);
    expect(c.state.phase).toBe('READY');
  });

  it('join：令牌加入后同一 PID / 端口进入 READY；token 不含忆云名 → 默认档案名并说明', () => {
    const c = result.cases.join;
    expect(c.pid).toBe(result.pid);
    expect(c.response.status).toBe(200);
    expect(c.response.body).toMatchObject({ ok: true, action: 'join', initialized: true, phase: 'READY' });
    expect(c.response.body.notes.join('\n')).toContain('令牌不含忆云名时沿用默认');
    expect(c.portAfter).toBe(c.port);
    expect(c.overview.status).toBe(200);
    expect(c.statusAfter.status).toBe(404);
    expect(c.state).toMatchObject({ phase: 'READY', hotInitialized: true });
    expect(c.registry).toMatchObject({ current: 'default' });
    expect(c.registry.profiles[0]).toMatchObject({ id: 'default', name: '忆云 1' });
    expect(c.config.deviceName).toBe('加入机');
    expect(c.config.identity?.mode).toBe('delegated');
    expect(c.identityExists).toBe(true);
    expect(c.master?.privateKeyPkcs8).toBeUndefined();
  });
});
