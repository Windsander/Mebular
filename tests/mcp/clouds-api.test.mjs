// E2-A1：clouds HTTP API / healthz 身份 / root active.lock（真实 HTTP handler，沙箱）
//
// 与 security-gate 夹具同策略：serve.mjs 经 config.mjs → @mebular/core 的 ESM 桶在 jest
// `--coverage` 下可能触发链接错误，因此用原生 Node 子进程跑真实 handler；harness 在测试运行时
// 写入系统临时目录（不新增仓库文件），避免污染仓库文件域。

import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const HARNESS = String.raw`
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.E2A1_ROOT;
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { startHttpServer } = await load('packages/mcp/src/serve.mjs');
const fleet = await load('packages/fleet/dist/index.js');
const core = await load('dist/index.js');

const root = await mkdtemp(join(tmpdir(), 'e2a1-clouds-'));
const inviterHome = await mkdtemp(join(tmpdir(), 'e2a1-inviter-'));
const customHome = await mkdtemp(join(tmpdir(), 'e2a1-custom-'));
process.env.MEBULAR_CLOUD_ROOT = root;
process.env.MEBULAR_HOME = root;
process.env.MEBULAR_USER_HOME = root;

const config = {
  deviceId: 'device-local',
  mcp: { http: { host: '127.0.0.1', port: 17331, auth: 'none' } },
  joinService: { enabled: true, port: 14002 },
  network: { libp2p: { listen: ['/ip4/0.0.0.0/tcp/14001'] } },
};
await writeFile(join(root, 'config.json'), JSON.stringify(config));
await writeFile(join(root, 'user-master-key.json'), JSON.stringify({ publicKey: Buffer.alloc(32, 7).toString('base64') }));
await writeFile(join(customHome, 'config.json'), JSON.stringify({}));

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
const makeToken = async (extra) => {
  const base = { mebular: inviter, deviceId: 'device-inviter', namespace: 'tasks', endpoint, ttlMs: 600000 };
  return fleet.encodeJoinToken(await fleet.buildJoinToken({ ...base, ...(extra || {}) }));
};

const app = {
  deviceId: 'device-local',
  securityCalls: 0,
  getSecurityTier: async () => {
    app.securityCalls += 1;
    return { level: 'high', admitted: [], rejections: [] };
  },
  getBlockedDevices: async () => [],
  getConvergenceStatus: () => null,
};
const service = {
  status: async () => ({ running: true, peerId: 'peer-local', listenAddrs: [], relays: [], nodeCount: 1, pendingEventCount: 0 }),
};
const start = async (opts) => {
  const options = opts || {};
  return startHttpServer({
    home: options.home || root,
    app,
    service,
    config: options.config || config,
    buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
    host: '127.0.0.1',
    port: 0,
    auth: 'none',
    writesEnabled: true,
    namespace: 'tasks',
    runtime: options.runtime || { mcp: { port: 17331 }, join: { port: 14002 } },
  });
};

const out = {};
out.root = root;
let server = await start();
const base = 'http://127.0.0.1:' + server.port;
const page = await fetch(base + '/console/');
const csrf = page.headers.get('x-mebular-csrf');
const cookie = page.headers.getSetCookie().find((value) => value.startsWith('mebular_csrf=')).split(';')[0];
const get = async (path) => {
  const res = await fetch(base + path, { headers: { cookie } });
  return { status: res.status, body: await res.json() };
};
const post = async (path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf, cookie, origin: base },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

try {
  out.health = await get('/healthz');
  out.listBefore = await get('/admin/api/clouds');
  out.overviewBefore = await get('/admin/api/overview');
  out.lockPresent = JSON.parse(await readFile(join(root, 'active.lock'), 'utf-8'));
  const inspectToken = await makeToken();
  out.inspectBefore = await post('/admin/api/clouds/inspect', { token: inspectToken });

  out.confirm = await post('/admin/api/clouds/join', {});
  out.tokenRequired = await post('/admin/api/clouds/join', { confirm: true });
  out.invalid = await post('/admin/api/clouds/join', { confirm: true, token: 'not-a-token' });
  out.expired = await post('/admin/api/clouds/join', {
    confirm: true,
    token: await makeToken({ now: Date.now() - 60000, ttlMs: 1000 }),
  });

  const beforeDirs = await readdir(join(root, 'profiles')).catch(() => []);
  const unreachableToken = await makeToken({ endpoint: 'http://127.0.0.1:1' });
  out.unreachable = await post('/admin/api/clouds/join', { confirm: true, token: unreachableToken });
  const afterDirs = await readdir(join(root, 'profiles')).catch(() => []);
  out.unreachableDirsUnchanged = JSON.stringify(beforeDirs.sort()) === JSON.stringify(afterDirs.sort());

  const logs = [];
  const originalError = console.error;
  console.error = (...args) => { logs.push(args.map(String).join(' ')); originalError(...args); };
  const validToken = await makeToken();
  out.join = await post('/admin/api/clouds/join', { confirm: true, token: validToken });
  console.error = originalError;
  out.joinLogsLeakToken = logs.join('\n').includes(validToken);
  out.joinResponseLeaksToken = JSON.stringify(out.join.body).includes(validToken);

  const registryText = await readFile(join(root, 'profiles.json'), 'utf-8');
  out.registryLeaksToken = registryText.includes(validToken);
  out.listAfter = await get('/admin/api/clouds');
  out.inspectAfter = await post('/admin/api/clouds/inspect', { token: inspectToken });
  const id = out.join.body.profile.id;
  out.newConfig = JSON.parse(await readFile(join(root, 'profiles', id, 'config.json'), 'utf-8'));
  const provisioningGone = await readdir(join(root, 'profiles', id)).then((names) => !names.includes('.provisioning'));

  out.duplicate = await post('/admin/api/clouds/join', { confirm: true, token: await makeToken() });
  const profileDirs = (await readdir(join(root, 'profiles'))).filter((name) => name.startsWith('p_'));
  out.profileDirCount = profileDirs.length;
  out.provisioningGone = provisioningGone;
  out.securityCallsAfterJoin = app.securityCalls;

  out.rename = await post('/admin/api/clouds/rename', { id, name: ' 工作室 ' });
  out.renameTaken = await post('/admin/api/clouds/rename', { id, name: '忆云 1' });
  out.renameInvalid = await post('/admin/api/clouds/rename', { id, name: 'a/b' });
  out.renameMissing = await post('/admin/api/clouds/rename', { id: 'p_ffffffff', name: 'x' });
  out.overviewAfter = await get('/admin/api/overview');
  out.listRenamed = await get('/admin/api/clouds');
  out.lockAfter = JSON.parse(await readFile(join(root, 'active.lock'), 'utf-8'));

  let activeConflict = null;
  try {
    const second = await start({
      home: join(root, 'profiles', id),
      runtime: { mcp: { port: 17332 }, join: { port: 14003 } },
    });
    await second.close();
  } catch (error) {
    activeConflict = { code: error.code, message: error.message };
  }
  out.activeConflict = activeConflict;

  await server.close();
  out.lockReleased = await readFile(join(root, 'active.lock'), 'utf-8').then(() => false).catch(() => true);

  delete process.env.MEBULAR_CLOUD_ROOT;
  delete process.env.MEBULAR_HOME;
  const unavailable = await start({ home: customHome, config: {}, runtime: { mcp: { port: 0 }, join: { port: 0 } } });
  const unavailableBase = 'http://127.0.0.1:' + unavailable.port;
  const unavailableRes = await fetch(unavailableBase + '/admin/api/clouds');
  out.unavailable = { status: unavailableRes.status, body: await unavailableRes.json() };
  const unavailablePage = await fetch(unavailableBase + '/console/');
  const unavailableCsrf = unavailablePage.headers.get('x-mebular-csrf');
  const unavailableCookie = unavailablePage.headers.getSetCookie().find((value) => value.startsWith('mebular_csrf=')).split(';')[0];
  const unavailableJoin = await fetch(unavailableBase + '/admin/api/clouds/join', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mebular-csrf': unavailableCsrf,
      cookie: unavailableCookie,
      origin: unavailableBase,
    },
    body: JSON.stringify({ confirm: true, token: 'x' }),
  });
  out.unavailableJoin = { status: unavailableJoin.status, body: await unavailableJoin.json() };
  await unavailable.close();

  process.env.MEBULAR_CLOUD_ROOT = root;
  process.env.MEBULAR_HOME = root;
  await writeFile(join(root, 'profiles.json'), '{broken', 'utf-8');
  await writeFile(join(root, 'profiles.json.bak'), '{broken', 'utf-8');
  const broken = await start();
  const brokenRes = await fetch('http://127.0.0.1:' + broken.port + '/admin/api/clouds');
  out.invalidRegistry = { status: brokenRes.status, body: await brokenRes.json() };
  await broken.close();
} finally {
  await server.close().catch(() => undefined);
  await joinSvc.close().catch(() => undefined);
  await inviter.shutdown().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
  await rm(inviterHome, { recursive: true, force: true });
  await rm(customHome, { recursive: true, force: true });
}

console.log('CLOUDS_RESULT ' + JSON.stringify(out));
`;

function runHarness() {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', HARNESS], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 180_000,
    env: { ...process.env, E2A1_ROOT: ROOT, NODE_NO_WARNINGS: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`clouds harness failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`);
  }
  const line = String(result.stdout).split('\n').find((entry) => entry.startsWith('CLOUDS_RESULT '));
  if (!line) throw new Error(`clouds harness produced no result:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice('CLOUDS_RESULT '.length));
}

const result = runHarness();

describe('E2-A1 GET /admin/api/clouds + healthz 身份 + active.lock', () => {
  it('healthz 带 instance=homeKey(home) 与 cloudId', () => {
    expect(result.health.status).toBe(200);
    expect(result.health.body.instance).toMatch(/^[0-9a-f]{12}$/);
    expect(result.health.body.cloudId).toBe('default');
    expect(result.health.body.instance).toHaveLength(12);
  });

  it('GET clouds：合成默认忆云；overview 带 cloud', () => {
    expect(result.listBefore.status).toBe(200);
    expect(result.listBefore.body.ok).toBe(true);
    expect(result.listBefore.body.current).toBe('default');
    expect(result.listBefore.body.profiles).toHaveLength(1);
    expect(result.listBefore.body.profiles[0]).toMatchObject({ id: 'default', name: '忆云 1', current: true });
    expect(result.overviewBefore.body.cloud).toMatchObject({ id: 'default', name: '忆云 1', current: true });
  });

  it('active.lock 记录 pid/home/profileId；被活 PID 不同 home 占用 → CLOUD_ALREADY_ACTIVE；关闭释放', () => {
    expect(result.lockPresent.pid).toBeGreaterThan(0);
    expect(result.lockPresent.profileId).toBe('default');
    expect(result.lockPresent.home).toBe(result.root);
    expect(result.lockAfter.home).toBe(result.root);
    expect(result.activeConflict?.code).toBe('CLOUD_ALREADY_ACTIVE');
    expect(result.lockReleased).toBe(true);
  });

  it('join 错误码：CONFIRMATION_REQUIRED / TOKEN_REQUIRED / TOKEN_INVALID / TOKEN_EXPIRED', () => {
    expect(result.confirm.status).toBe(400);
    expect(result.confirm.body.error).toBe('CONFIRMATION_REQUIRED');
    expect(result.tokenRequired.status).toBe(400);
    expect(result.tokenRequired.body.error).toBe('TOKEN_REQUIRED');
    expect(result.invalid.status).toBe(400);
    expect(result.invalid.body.error).toBe('TOKEN_INVALID');
    expect(result.expired.status).toBe(400);
    expect(result.expired.body.error).toBe('TOKEN_EXPIRED');
  });

  it('端点不可达 → 502 ENDPOINT_UNREACHABLE，且不残留目录/注册表不变', () => {
    expect(result.unreachable.status).toBe(502);
    expect(result.unreachable.body.error).toBe('ENDPOINT_UNREACHABLE');
    expect(result.unreachableDirsUnchanged).toBe(true);
  });

  it('join 201：current 仍 default、默认名忆云 2、令牌不入响应/注册表/日志', () => {
    expect(result.join.status).toBe(201);
    expect(result.join.body.ok).toBe(true);
    expect(result.join.body.current).toBe('default');
    expect(result.join.body.profile.id).toMatch(/^p_[0-9a-f]{8}$/);
    expect(result.join.body.profile.name).toBe('忆云 2');
    expect(result.join.body.profile.home).toBe(`profiles/${result.join.body.profile.id}`);
    expect(result.join.body.switch).toEqual({ required: true, command: `mebular cloud use ${result.join.body.profile.id}` });
    expect(result.joinResponseLeaksToken).toBe(false);
    expect(result.registryLeaksToken).toBe(false);
    expect(result.joinLogsLeakToken).toBe(false);
    expect(result.provisioningGone).toBe(true);
    // 端口复用当前忆云（准备阶段只写 config，不探测/不 bind）。
    expect(result.newConfig.mcp.http.port).toBe(17331);
    expect(result.newConfig.joinService.port).toBe(14002);
    expect(result.newConfig.network.libp2p.listen[0]).toContain('/tcp/14001');
    // 红线 §6.3：加入是出站动作，**不得**走当前忆云的安全写门禁。
    expect(result.securityCallsAfterJoin).toBe(0);
    expect(result.listAfter.body.profiles).toHaveLength(2);
    expect(result.listAfter.body.current).toBe('default');
  });

  it('inspect 预览：不消费令牌；加入后 alreadyJoined 指向已有条目', () => {
    expect(result.inspectBefore.status).toBe(200);
    expect(result.inspectBefore.body.ok).toBe(true);
    expect(result.inspectBefore.body.inviterDeviceId).toBe('device-inviter');
    expect(result.inspectBefore.body.namespace).toBe('tasks');
    expect(result.inspectBefore.body.masterFingerprint).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(result.inspectBefore.body.alreadyJoined).toBeNull();
    expect(result.inspectAfter.status).toBe(200);
    expect(result.inspectAfter.body.alreadyJoined).toEqual({
      id: result.join.body.profile.id,
      name: result.join.body.profile.name,
    });
  });

  it('重复忆云 → 409 CLOUD_ALREADY_JOINED（带已有 id/name），不创建第二个目录', () => {
    expect(result.duplicate.status).toBe(409);
    expect(result.duplicate.body.error).toBe('CLOUD_ALREADY_JOINED');
    expect(result.duplicate.body.existing).toEqual({
      id: result.join.body.profile.id,
      name: result.join.body.profile.name,
    });
    expect(result.profileDirCount).toBe(1);
  });

  it('rename：成功 / NAME_TAKEN / INVALID_NAME / PROFILE_NOT_FOUND；overview 立即反映', () => {
    expect(result.rename.status).toBe(200);
    expect(result.rename.body.profile.name).toBe('工作室');
    expect(result.renameTaken.status).toBe(400);
    expect(result.renameTaken.body.error).toBe('NAME_TAKEN');
    expect(result.renameInvalid.status).toBe(400);
    expect(result.renameInvalid.body.error).toBe('INVALID_NAME');
    expect(result.renameMissing.status).toBe(404);
    expect(result.renameMissing.body.error).toBe('PROFILE_NOT_FOUND');
    expect(result.listRenamed.body.profiles.find((profile) => profile.id === result.join.body.profile.id).name).toBe('工作室');
    expect(result.overviewAfter.body.cloud).toMatchObject({ id: 'default', name: '忆云 1', current: true });
  });

  it('CLOUD_UNAVAILABLE（自定义 home）→ 503；join → 403 CLOUD_DISABLED；注册表损坏 → 500 CLOUD_REGISTRY_INVALID', () => {
    expect(result.unavailable.status).toBe(503);
    expect(result.unavailable.body.error).toBe('CLOUD_UNAVAILABLE');
    expect(result.unavailableJoin.status).toBe(403);
    expect(result.unavailableJoin.body.error).toBe('CLOUD_DISABLED');
    expect(result.invalidRegistry.status).toBe(500);
    expect(result.invalidRegistry.body.error).toBe('CLOUD_REGISTRY_INVALID');
  });
});
