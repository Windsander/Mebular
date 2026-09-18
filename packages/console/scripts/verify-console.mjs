#!/usr/bin/env node
// 控制台 E1 验证（D1）：
//   起真实 serve（临时 MEBULAR_HOME，预置若干 __policy__ 事件与记忆节点），断言
//   /console 200、静态资源 200、只读 API JSON 结构正确、写端点未授权 403、
//   路径穿越被拒。成功退出码 0，失败非 0。前置：npm run build。
//
// 与 scripts/verify-mcp-http.mjs 同风格：spawn 子进程 + SERVE_READY 等待。

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createWizardState, wizardReduce, selectedMemoryCount } from '../wizard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const consoleDir = join(__dirname, '..');
const rootDir = join(consoleDir, '..', '..');
const bin = join(rootDir, 'packages', 'mcp', 'bin', 'mebular.mjs');

let passed = true;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) passed = false;
};

async function seedHome(home) {
  const { Mebular, IdentityManager, MemoryService, POLICY_NAMESPACE } = await import('@mebular/core');
  const storagePath = join(home, 'store.jsonl');
  const keyFile = join(home, 'user-master-key.json');
  await mkdir(home, { recursive: true });

  const master = await new IdentityManager().generateUserMasterKey();
  await writeFile(
    keyFile,
    JSON.stringify({
      publicKey: Buffer.from(master.publicKey).toString('base64'),
      privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
      createdAt: new Date().toISOString(),
    }, null, 2),
    'utf-8',
  );
  const config = {
    storagePath,
    storageAdapter: 'json',
    deviceId: 'device-console',
    encryption: { level: 'none', keyFile },
    network: { enabled: false, libp2p: { listen: [], relayServers: [] } },
    sync: { autoSync: true, pushOnWrite: false, antiEntropy: { enabled: false }, policyIssuers: ['device-console'] },
    mcp: { http: { host: '127.0.0.1', port: 7331, auth: 'none', tls: false } },
  };
  await writeFile(join(home, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');

  const app = new Mebular({
    storagePath,
    deviceId: 'device-console',
    encryption: { level: 'none', userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    network: { enabled: false },
    sync: { autoSync: true, policyIssuers: ['device-console'] },
  });
  await app.initialize();
  const service = new MemoryService(app);
  await service.write([
    { type: 'fact', content: 'alpha', metadata: { namespace: 'notes' } },
    { type: 'fact', content: 'beta', metadata: { namespace: 'notes' } },
    { type: 'fact', content: 'gamma', metadata: { namespace: 'work' } },
  ]);
  await app.grantNamespaces({ subject: 'device-peer', namespaces: ['notes'] });
  const revocable = await app.grantNamespaces({ subject: 'device-other', namespaces: ['work'] });
  await app.revokeGrant({ grantId: revocable.data.grant.grantId, subject: 'device-other' });
  await app.revokeDevice({ subject: 'device-bad' });
  // C1 / M1–M3 / 2b：预置新三类策略事件（审计渲染与 API 结构防回归）
  await app.declarePolicyIssuer({ subject: 'device-console' });
  await app.declareNamespaceMembership({ member: 'device-peer', namespace: 'notes', active: true });
  await app.declareNamespaceMembership({ member: 'device-peer', namespace: 'notes', active: false });
  await app.eventLog.append({
    type: 'namespace_handoff',
    data: { handoff: { handoffId: 'handoff-1', namespace: 'work', successor: 'device-peer', forced: false, pendingCount: 0, issuedAt: Date.now() } },
    namespace: POLICY_NAMESPACE,
  });
  await app.shutdown();
  return storagePath;
}

function spawnServe({ home, storage, args = [], env = {}, deviceId = 'device-console' }) {
  const proc = spawn(process.execPath, [bin, 'serve', '--port', '0', ...args], {
    env: {
      ...process.env,
      MEBULAR_HOME: home,
      MEBULAR_STORAGE_PATH: storage,
      MEBULAR_DEVICE_ID: deviceId,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });
  return { proc, getOut: () => out, getErr: () => err };
}

function waitReady(handle, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = handle.getOut().match(/SERVE_READY (\{.*\})/);
      if (match) {
        clearInterval(timer);
        resolve(JSON.parse(match[1]));
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`serve 未就绪：${handle.getErr()}`));
      }
    }, 100);
  });
}

async function stop(handle) {
  if (handle?.proc && handle.proc.exitCode === null) {
    handle.proc.kill('SIGTERM');
    await new Promise((resolve) => handle.proc.on('exit', resolve));
  }
}

// 用原始 http 请求，保留未规范化的路径（用于验证 %2e%2e 穿越）
function rawRequest(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function getJson(port, path, init = undefined) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, json, text };
}

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie') ?? '';
  const match = raw.match(/mebular_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** 打开 SSE 流，收到 status 事件或超时后返回 */
function openSse(port, path, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      const finish = () => {
        clearTimeout(timer);
        req.destroy();
        resolve({ status: res.statusCode, headers: res.headers, body: buf });
      };
      const timer = setTimeout(finish, timeoutMs);
      res.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('event: status')) finish();
      });
      res.on('end', finish);
    });
    req.on('error', (error) => {
      if (error.code === 'ECONNRESET') return;
      reject(error);
    });
    req.end();
  });
}

console.log('Mebular 控制台 E1 验证（D1+D2，含 D3 向导状态机）');
console.log('===============================');

// ---------- D3 添加设备向导状态机（纯函数，无需起服务） ----------
{
  let s = createWizardState();
  check('向导初始 step=local', s.step === 'local');
  s = wizardReduce(s, { type: 'GO_CONNECT' });
  check('缺 deviceId/address → 拦截', s.step === 'local' && Boolean(s.error));
  s = wizardReduce(s, { type: 'PEER_INPUT', deviceId: 'device-B', address: '/ip4/127.0.0.1/tcp/4011/p2p/xyz' });
  s = wizardReduce(s, { type: 'GO_CONNECT' });
  check('输入齐全 → step=connect/connecting', s.step === 'connect' && s.connection === 'connecting');
  s = wizardReduce(s, { type: 'GO_DOMAINS' });
  check('未连接 → 不能进入 domains', s.step === 'connect' && Boolean(s.error));
  s = wizardReduce(s, { type: 'CONNECT_SUCCESS' });
  s = wizardReduce(s, { type: 'GO_DOMAINS' });
  check('已连接 → step=domains', s.step === 'domains');
  s = wizardReduce(s, { type: 'GRANT_START' });
  check('未选域 → GRANT_START 被拦', s.granting !== true && Boolean(s.error));
  s = wizardReduce(s, { type: 'TOGGLE_NAMESPACE', namespace: 'notes' });
  check('选择域 notes', s.selected.includes('notes'));
  check(
    'selectedMemoryCount 汇总所选域记忆数',
    selectedMemoryCount([{ namespace: 'notes', count: 2 }, { namespace: 'work', count: 3 }], s.selected) === 2,
  );
  s = wizardReduce(s, { type: 'GRANT_START' });
  check('已选域 → granting', s.granting === true);
  s = wizardReduce(s, { type: 'GRANT_SUCCESS', grantId: 'g-1' });
  check('签发成功 → step=done + grantId', s.step === 'done' && s.grantId === 'g-1');
  s = wizardReduce(s, { type: 'BACK' });
  check('done 不可后退（保持）', s.step === 'done');
  const reset = wizardReduce(s, { type: 'RESET' });
  check('RESET 回到初始', reset.step === 'local' && reset.selected.length === 0);
  let f = wizardReduce(createWizardState(), { type: 'PEER_INPUT', deviceId: 'd', address: 'a' });
  f = wizardReduce(f, { type: 'GO_CONNECT' });
  f = wizardReduce(f, { type: 'CONNECT_FAILURE', message: 'refused' });
  check('连接失败可重试', f.connection === 'failed' && f.error === 'refused');
  f = wizardReduce(f, { type: 'BACK' });
  check('connect → BACK 回 local', f.step === 'local');
}

const home = await mkdtemp(join(tmpdir(), 'mebular-console-'));
const servers = [];

try {
  const storage = await seedHome(home);
  const handle = spawnServe({ home, storage });
  servers.push(handle);
  const ready = await waitReady(handle);
  const port = ready.port;
  check('serve 启动（SERVE_READY）', Number.isInteger(port) && port > 0, `port=${port}`);

  // ---------- 静态托管 ----------
  const index = await fetch(`http://127.0.0.1:${port}/console`);
  const indexText = await index.text();
  check('GET /console 200 + text/html', index.status === 200 && /text\/html/.test(index.headers.get('content-type') ?? ''), `status=${index.status}`);
  check('/console 返回控制台页面', indexText.includes('Mebular 控制台'));
  check('/console 下发 CSRF cookie 与响应头', (index.headers.get('set-cookie') ?? '').includes('mebular_csrf=') && Boolean(index.headers.get('x-mebular-csrf')));

  for (const [file, mime] of [['console.css', 'text/css'], ['console.js', 'text/javascript'], ['starfield.js', 'text/javascript'], ['wizard.js', 'text/javascript'], ['nebula.js', 'text/javascript'], ['stars.js', 'text/javascript']]) {
    const res = await fetch(`http://127.0.0.1:${port}/console/${file}`);
    check(`静态资源 /console/${file} 200`, res.status === 200 && (res.headers.get('content-type') ?? '').includes(mime), `status=${res.status}`);
  }

  const missing = await fetch(`http://127.0.0.1:${port}/console/nope.js`);
  check('未知静态文件 404', missing.status === 404);

  const traversal = await rawRequest(port, '/console/%2e%2e/package.json');
  const traversal2 = await rawRequest(port, '/console/..%2Fpackage.json');
  check('路径穿越（%2e%2e / ..%2F）被拒', traversal.status === 404 && traversal2.status === 404, `${traversal.status}/${traversal2.status}`);

  // ---------- 只读 API ----------
  const overview = await getJson(port, '/admin/api/overview');
  check('GET /admin/api/overview 200', overview.status === 200);
  check('overview.device.deviceId', overview.json?.device?.deviceId === 'device-console', overview.json?.device?.deviceId);
  check('overview.status.nodeCount ≥ 3', (overview.json?.status?.nodeCount ?? 0) >= 3, String(overview.json?.status?.nodeCount));
  check('overview.onlinePeers 为数组', Array.isArray(overview.json?.onlinePeers));
  check('overview.revokedCount = 1', overview.json?.revokedCount === 1, String(overview.json?.revokedCount));
  check('overview.status.stateHashByNamespace 存在', typeof overview.json?.status?.stateHashByNamespace === 'object');
  check('overview.features.writes 为 boolean', typeof overview.json?.features?.writes === 'boolean');

  const devices = await getJson(port, '/admin/api/devices');
  check('GET /admin/api/devices 200 + 数组', devices.status === 200 && Array.isArray(devices.json));
  const byId = new Map((devices.json ?? []).map((d) => [d.deviceId, d]));
  const peer = byId.get('device-peer');
  check('devices 含 device-peer 且 grantedByMe 含 notes', Array.isArray(peer?.grantedByMe) && peer.grantedByMe.includes('notes'));
  const other = byId.get('device-other');
  check('device-other 的 grant 已撤销（grantedByMe 为空）', other && other.grantedByMe.length === 0);
  const bad = byId.get('device-bad');
  check('device-bad revoked=true', bad?.revoked === true);
  check('devices 项字段齐全', (devices.json ?? []).every((d) => typeof d.deviceId === 'string' && typeof d.online === 'boolean' && typeof d.revoked === 'boolean' && Array.isArray(d.grantedByMe) && Array.isArray(d.grantedToMe) && 'pendingEventCount' in d));

  const policy = await getJson(port, '/admin/api/policy');
  check('GET /admin/api/policy 200 + 数组', policy.status === 200 && Array.isArray(policy.json));
  {
    const types = new Set((policy.json ?? []).map((e) => e.type));
    check(
      '审计含 C1/M1–M3/2b 三类事件（declare/membership/handoff）',
      ['policy_issuer_declare', 'namespace_membership', 'namespace_handoff'].every((t) => types.has(t)),
      `types=${[...types].sort().join(',')}`,
    );
    const memberships = (policy.json ?? []).filter((e) => e.type === 'namespace_membership');
    check(
      '成员事件字段完整且含在册/注销两态',
      memberships.length >= 2
        && memberships.every((e) => e.subject === 'device-peer' && e.namespace === 'notes' && typeof e.active === 'boolean')
        && memberships.some((e) => e.active === true)
        && memberships.some((e) => e.active === false),
      `count=${memberships.length} states=${memberships.map((e) => e.active).join(',')}`,
    );
  }
  const types = new Set((policy.json ?? []).map((e) => e.type));
  check('policy 含 grant/revoke/device_revoke', types.has('namespace_grant') && types.has('namespace_revoke') && types.has('device_revoke'));
  check('policy 项字段齐全', (policy.json ?? []).every((e) => typeof e.eventId === 'string' && typeof e.issuer === 'string' && typeof e.at === 'number' && typeof e.valid === 'boolean'));
  const revokedGrant = (policy.json ?? []).find((e) => e.type === 'namespace_revoke');
  const targetGrant = (policy.json ?? []).find((e) => e.type === 'namespace_grant' && e.grantId === revokedGrant?.grantId);
  check('被撤销的 grant 标记 valid=false', targetGrant?.valid === false);

  const namespaces = await getJson(port, '/admin/api/namespaces');
  check('GET /admin/api/namespaces 200 + 数组', namespaces.status === 200 && Array.isArray(namespaces.json));
  const notes = (namespaces.json ?? []).find((n) => n.namespace === 'notes');
  const work = (namespaces.json ?? []).find((n) => n.namespace === 'work');
  check('namespaces 含 notes（count ≥ 2）', (notes?.count ?? 0) >= 2, String(notes?.count));
  check('namespaces 含 work（count ≥ 1）', (work?.count ?? 0) >= 1, String(work?.count));
  check('namespaces 项字段齐全', (namespaces.json ?? []).every((n) => typeof n.namespace === 'string' && typeof n.count === 'number' && 'lastUpdatedAt' in n && 'stateHash' in n));

  // ---------- 写端点未授权 ----------
  const writeNoCsrf = await fetch(`http://127.0.0.1:${port}/admin/api/grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: 'x', namespaces: ['notes'] }),
  });
  check('POST /admin/api/grants 未授权 → 403', writeNoCsrf.status === 403, `status=${writeNoCsrf.status}`);
  const revokeNoCsrf = await fetch(`http://127.0.0.1:${port}/admin/api/grants/abc/revoke`, { method: 'POST' });
  check('POST /admin/api/grants/:id/revoke 未授权 → 403', revokeNoCsrf.status === 403, `status=${revokeNoCsrf.status}`);
  const deviceNoCsrf = await fetch(`http://127.0.0.1:${port}/admin/api/devices/device-peer/revoke`, { method: 'POST' });
  check('POST /admin/api/devices/:id/revoke 未授权 → 403', deviceNoCsrf.status === 403, `status=${deviceNoCsrf.status}`);

  // ---------- D2 写端点（CSRF 双提交 + 授权） ----------
  const csrf = index.headers.get('x-mebular-csrf');
  const csrfCookie = cookieFrom(index);
  check('CSRF cookie 与响应头成对下发', Boolean(csrf) && Boolean(csrfCookie));
  const writeHeaders = { 'content-type': 'application/json', 'x-mebular-csrf': csrf, cookie: `mebular_csrf=${csrfCookie}` };

  const headerOnly = await fetch(`http://127.0.0.1:${port}/admin/api/grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf },
    body: JSON.stringify({ subject: 'device-x', namespaces: ['notes'] }),
  });
  check('仅 CSRF 头、无 cookie → 403', headerOnly.status === 403, `status=${headerOnly.status}`);
  const cookieOnly = await fetch(`http://127.0.0.1:${port}/admin/api/grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `mebular_csrf=${csrfCookie}` },
    body: JSON.stringify({ subject: 'device-x', namespaces: ['notes'] }),
  });
  check('仅 cookie、无 CSRF 头 → 403', cookieOnly.status === 403, `status=${cookieOnly.status}`);

  const created = await fetch(`http://127.0.0.1:${port}/admin/api/grants`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ subject: 'device-new', namespaces: ['notes'] }),
  });
  const createdJson = (await created.json().catch(() => null));
  check('CSRF 完整 → 签发 grant 201', created.status === 201 && typeof createdJson?.grantId === 'string', `status=${created.status}`);

  // grantedByMe 语义：只算本机签发；本机行的 grantedByMe 不得出现刚签发的域
  const devicesAfterGrant = await getJson(port, '/admin/api/devices');
  const peerRow = (devicesAfterGrant.json ?? []).find((d) => d.deviceId === 'device-new');
  const selfRow = (devicesAfterGrant.json ?? []).find((d) => d.deviceId === 'device-console');
  check(
    'grantedByMe 仅算本机签发（peer 行含 notes、self 行不含）',
    peerRow?.grantedByMe?.includes('notes') === true && selfRow?.grantedByMe?.includes('notes') !== true,
    `peer=${JSON.stringify(peerRow?.grantedByMe)} self=${JSON.stringify(selfRow?.grantedByMe)}`,
  );

  const revoked = await fetch(`http://127.0.0.1:${port}/admin/api/grants/${encodeURIComponent(createdJson?.grantId ?? '')}/revoke`, {
    method: 'POST',
    headers: writeHeaders,
  });
  const revokedJson = await revoked.json().catch(() => null);
  check('撤销 grant → 200', revoked.status === 200 && revokedJson?.ok === true, `status=${revoked.status}`);

  const policyAfter = await getJson(port, '/admin/api/policy');
  check(
    '新 grant 与其撤销均入审计',
    (policyAfter.json ?? []).some((e) => e.type === 'namespace_grant' && e.grantId === createdJson?.grantId)
      && (policyAfter.json ?? []).some((e) => e.type === 'namespace_revoke' && e.grantId === createdJson?.grantId),
  );

  const badBody = await fetch(`http://127.0.0.1:${port}/admin/api/grants`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ subject: 'device-new' }),
  });
  check('缺 namespaces → 400', badBody.status === 400, `status=${badBody.status}`);

  // 防回归：sync 端点对未运行网络/未连接设备必须给结构化 4xx，而不是 500
  //（此前实现对已连接设备在裸信道上另起 syncWithDevice，与会话循环抢帧 →
  //  "Sync timeout waiting for sync-hello" 被兜底成 500）
  const syncOffline = await fetch(`http://127.0.0.1:${port}/admin/api/devices/device-offline/sync`, {
    method: 'POST',
    headers: writeHeaders,
  });
  const syncOfflineJson = await syncOffline.json().catch(() => null);
  check(
    'sync 未连接设备 → 409 结构化错误（非 500）',
    syncOffline.status === 409 && ['not_connected', 'network_not_running'].includes(syncOfflineJson?.error),
    `status=${syncOffline.status} error=${syncOfflineJson?.error}`,
  );

  // ---------- SSE ----------
  const sse = await openSse(port, '/admin/events', 8000);
  check(
    'GET /admin/events 200 + text/event-stream + status 事件',
    sse.status === 200 && (sse.headers['content-type'] ?? '').includes('text/event-stream') && sse.body.includes('event: status'),
    `status=${sse.status}`,
  );

  // ---------- D2 bearer + scope ----------
  {
    const bearerHome = join(home, 'bearer');
    const tokensFile = join(bearerHome, 'auth', 'tokens.json');
    await mkdir(dirname(tokensFile), { recursive: true });
    const readToken = 'meb_console_read';
    const adminToken = 'meb_console_admin';
    await writeFile(
      tokensFile,
      JSON.stringify({
        tokens: [
          { id: 'r', sha256: sha256(readToken), scope: ['memory.read'], revoked: false },
          { id: 'a', sha256: sha256(adminToken), scope: ['memory.admin'], revoked: false },
        ],
      }),
      'utf-8',
    );
    const bearerHandle = spawnServe({
      home: bearerHome,
      storage: join(bearerHome, 's.jsonl'),
      args: ['--auth', 'bearer', '--tokens-file', tokensFile],
      deviceId: 'device-bearer',
    });
    servers.push(bearerHandle);
    const bearerReady = await waitReady(bearerHandle);
    const bport = bearerReady.port;
    const base = `http://127.0.0.1:${bport}`;

    const noToken = await fetch(`${base}/admin/api/overview`);
    check('bearer：无 token 读 → 401', noToken.status === 401, `status=${noToken.status}`);
    const readOk = await fetch(`${base}/admin/api/overview`, { headers: { authorization: `Bearer ${readToken}` } });
    check('bearer：read token 读 → 200', readOk.status === 200, `status=${readOk.status}`);

    const consoleRes = await fetch(`${base}/console`);
    const bcsrf = consoleRes.headers.get('x-mebular-csrf');
    const bcookie = cookieFrom(consoleRes);
    const bWriteHeaders = { 'content-type': 'application/json', 'x-mebular-csrf': bcsrf, cookie: `mebular_csrf=${bcookie}` };

    const readWrite = await fetch(`${base}/admin/api/grants`, {
      method: 'POST',
      headers: { ...bWriteHeaders, authorization: `Bearer ${readToken}` },
      body: JSON.stringify({ subject: 'device-x', namespaces: ['notes'] }),
    });
    check('bearer：read scope 写 → 403', readWrite.status === 403, `status=${readWrite.status}`);
    const adminWrite = await fetch(`${base}/admin/api/grants`, {
      method: 'POST',
      headers: { ...bWriteHeaders, authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ subject: 'device-x', namespaces: ['notes'] }),
    });
    check('bearer：admin scope 写 → 201', adminWrite.status === 201, `status=${adminWrite.status}`);

    const bearerSse = await openSse(bport, `/admin/events?token=${readToken}`, 8000);
    check('bearer：SSE ?token= 200 + status', bearerSse.status === 200 && bearerSse.body.includes('event: status'), `status=${bearerSse.status}`);
  }

  // ---------- CLI：mebular console ----------
  try {
    const cliOut = execFileSync(process.execPath, [bin, 'console', '--port', String(port)], {
      env: { ...process.env, MEBULAR_HOME: home },
      encoding: 'utf-8',
    });
    check('mebular console 打印控制台 URL', cliOut.includes(`/console`), cliOut.trim().split('\n')[0]);
  } catch (error) {
    check('mebular console 打印控制台 URL', false, String(error?.message ?? error).substring(0, 160));
  }

  // ---------- 未知 API ----------
  const unknown = await getJson(port, '/admin/api/nope');
  check('未知 /admin/api 路径 404', unknown.status === 404);
} catch (error) {
  check('控制台端到端', false, String(error?.message ?? error).substring(0, 400));
} finally {
  for (const server of servers) await stop(server);
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

console.log('===============================');
if (passed) {
  console.log('✓ 控制台 E1 验证通过');
  process.exit(0);
} else {
  console.log('✗ 控制台 E1 验证失败');
  process.exit(1);
}
