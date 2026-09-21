#!/usr/bin/env node
// 控制台 E1 验证（D1）：
//   起真实 serve（临时 MEBULAR_HOME，预置若干 __policy__ 事件与记忆节点），断言
//   /console 200、静态资源 200、只读 API JSON 结构正确、写端点未授权 403、
//   路径穿越被拒。成功退出码 0，失败非 0。前置：npm run build。
//
// 与 scripts/verify-mcp-http.mjs 同风格：spawn 子进程 + SERVE_READY 等待。

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
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
    // 故意与 env MEBULAR_STORAGE_PATH 不同：设置卡必须展示 env 覆盖后的生效值
    storagePath: join(home, 'config-should-not-win.jsonl'),
    storageAdapter: 'json',
    deviceId: 'device-console',
    encryption: { level: 'none', keyFile },
    network: { enabled: false, libp2p: { listen: [], relayServers: [] } },
    sync: { autoSync: true, pushOnWrite: false, antiEntropy: { enabled: false }, policyIssuers: ['device-console'], peerWhitelist: ['device-peer'] },
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
  await writeFile(
    join(home, 'fleet.config.json'),
    JSON.stringify({
      v: 1,
      device: 'device-console',
      dir: home,
      storagePath,
      masterKeyFile: keyFile,
      namespace: 'tasks',
      listen: '',
      peers: [{ device: 'device-peer', addr: '/ip4/127.0.0.1/tcp/4001/p2p/peerid' }],
      policyIssuers: ['device-console'],
      agents: [],
    }, null, 2),
    'utf-8',
  );
  return storagePath;
}

function spawnServe({ home, storage, args = [], env = {}, deviceId = 'device-console', portFlag = '0' }) {
  const serveArgs = ['serve', ...(portFlag === null ? [] : ['--port', String(portFlag)]), ...args];
  const proc = spawn(process.execPath, [bin, ...serveArgs], {
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

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
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
  const handle = spawnServe({ home, storage, env: { MEBULAR_PUSH_ON_WRITE: 'true' } });
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
  check(
    'namespaces 含成员制/订阅/重入扩展字段',
    (namespaces.json ?? []).every((n) => typeof n.membershipEnabled === 'boolean'
      && Array.isArray(n.members) && Array.isArray(n.effectiveMembers) && Array.isArray(n.grantedTo)
      && typeof n.subscribed === 'boolean' && typeof n.rejoinReset === 'boolean'
      && typeof n.selfAuthorized === 'boolean' && (n.selfMember === null || typeof n.selfMember === 'boolean')),
  );
  check('notes membershipEnabled=true 且种子成员已注销', notes?.membershipEnabled === true && notes.members.includes('device-peer') === false, `members=${JSON.stringify(notes?.members)}`);
  check('work membershipEnabled=false（未启用成员制）', work?.membershipEnabled === false, `work.membershipEnabled=${work?.membershipEnabled}`);

  const settings = await getJson(port, '/admin/api/settings');
  check('GET /admin/api/settings 200', settings.status === 200);
  check('settings.storage.path 反映 env 覆盖（非 config）', settings.json?.storage?.path === storage, `path=${settings.json?.storage?.path}`);
  check('settings.sync.pushOnWrite 反映 env 覆盖（config=false）', settings.json?.sync?.pushOnWrite === true, `pushOnWrite=${settings.json?.sync?.pushOnWrite}`);
  check('settings.mcp.port 反映实际监听端口（--port 0）', settings.json?.mcp?.port === port, `settings=${settings.json?.mcp?.port} actual=${port}`);
  check('settings.mcp.host 反映实际监听地址', settings.json?.mcp?.host === '127.0.0.1', `host=${settings.json?.mcp?.host}`);
  check(
    'settings 形状（identity/storage/sync/network/mcp/semantic/签名集）',
    settings.json?.identity?.deviceId === 'device-console'
      && typeof settings.json?.storage?.adapter === 'string'
      && typeof settings.json?.sync?.pushOnWrite === 'boolean'
      && typeof settings.json?.sync?.antiEntropy?.enabled === 'boolean'
      && Array.isArray(settings.json?.sync?.subscriptions)
      && typeof settings.json?.network?.enabled === 'boolean'
      && Array.isArray(settings.json?.network?.listen)
      && Array.isArray(settings.json?.network?.listenConfigured)
      && Array.isArray(settings.json?.sync?.peerWhitelist)
      && (settings.json?.identity?.mode === null || typeof settings.json?.identity?.mode === 'string')
      && typeof settings.json?.join?.enabled === 'boolean'
      && typeof settings.json?.join?.port === 'number'
      && typeof settings.json?.fleet?.configured === 'boolean'
      && Array.isArray(settings.json?.tools)
      && typeof settings.json?.mcp?.host === 'string'
      && typeof settings.json?.semantic?.enabled === 'boolean'
      && Array.isArray(settings.json?.policyIssuers)
      && Array.isArray(settings.json?.sync?.configPolicyIssuers),
    `issuers=${JSON.stringify(settings.json?.policyIssuers)}`,
  );
  check('settings.policyIssuers 含已声明的 device-console', settings.json?.policyIssuers?.includes('device-console') === true);
  check('settings.identity.mode = root（本地主密钥）', settings.json?.identity?.mode === 'root', `mode=${settings.json?.identity?.mode}`);
  {
    const { TOOL_NAMES } = await import('../../mcp/src/tools.mjs');
    check(
      'settings.tools = 实际 MCP/CLI 工具面（逐字一致）',
      Array.isArray(settings.json?.tools)
        && settings.json.tools.length === TOOL_NAMES.length
        && TOOL_NAMES.every((t) => settings.json.tools.includes(t)),
      `tools=${JSON.stringify(settings.json?.tools)}`,
    );
  }
  check(
    'settings.fleet 反映 fleet.config.json（任务面独立配置）',
    settings.json?.fleet?.configured === true && settings.json?.fleet?.namespace === 'tasks' && settings.json?.fleet?.peers === 1,
    `fleet=${JSON.stringify(settings.json?.fleet)}`,
  );
  check('settings.sync.peerWhitelist 反映 config（L5 透传）', settings.json?.sync?.peerWhitelist?.length === 1 && settings.json.sync.peerWhitelist[0] === 'device-peer', `whitelist=${JSON.stringify(settings.json?.sync?.peerWhitelist)}`);
  check('devices 含 memberships/declaredIssuer 字段', (devices.json ?? []).every((d) => Array.isArray(d.memberships) && typeof d.declaredIssuer === 'boolean'));
  check('device-console declaredIssuer=true（种子声明）', byId.get('device-console')?.declaredIssuer === true);
  check('device-peer declaredIssuer=false', byId.get('device-peer')?.declaredIssuer === false);

  const plan = await getJson(port, '/admin/api/namespaces/work/handoff-plan?successor=device-peer');
  check(
    'GET handoff-plan 200 + 结构化（ok/namespace/successor）',
    plan.status === 200 && typeof plan.json?.ok === 'boolean' && plan.json?.namespace === 'work' && plan.json?.successor === 'device-peer',
    `status=${plan.status} ok=${plan.json?.ok}`,
  );
  const planBad = await getJson(port, '/admin/api/namespaces/work/handoff-plan');
  check('GET handoff-plan 缺 successor → 400', planBad.status === 400, `status=${planBad.status}`);

  // 防回归：overview 轮询不得重新签发/轮换 CSRF（否则与并发写请求竞争 → 403）
  const overviewCsrfProbe = await fetch(`http://127.0.0.1:${port}/admin/api/overview`);
  check(
    'overview 不轮换 CSRF（无 x-mebular-csrf / set-cookie）',
    overviewCsrfProbe.status === 200
      && !overviewCsrfProbe.headers.get('x-mebular-csrf')
      && !overviewCsrfProbe.headers.get('set-cookie'),
    `status=${overviewCsrfProbe.status}`,
  );

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

  // ---------- 设置/成员/交接写端点 ----------
  const issuerResp = await fetch(`http://127.0.0.1:${port}/admin/api/policy-issuers`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ subject: 'device-peer' }),
  });
  const issuerJson = await issuerResp.json().catch(() => null);
  check('POST policy-issuers → 201 + eventId', issuerResp.status === 201 && issuerJson?.subject === 'device-peer' && typeof issuerJson?.eventId === 'string', `status=${issuerResp.status}`);
  const devicesAfterIssuer = await getJson(port, '/admin/api/devices');
  check('新声明签发者在设备卡可见', (devicesAfterIssuer.json ?? []).find((d) => d.deviceId === 'device-peer')?.declaredIssuer === true);

  const memberResp = await fetch(`http://127.0.0.1:${port}/admin/api/memberships`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ member: 'device-new', namespace: 'notes', active: true }),
  });
  const memberJson = await memberResp.json().catch(() => null);
  check('POST memberships → 201 + eventId', memberResp.status === 201 && typeof memberJson?.eventId === 'string', `status=${memberResp.status}`);
  const nsAfterMember = await getJson(port, '/admin/api/namespaces');
  const notesAfterMember = (nsAfterMember.json ?? []).find((n) => n.namespace === 'notes');
  check(
    '新成员在册但未生效（缺授权）',
    notesAfterMember?.members?.includes('device-new') === true && notesAfterMember?.effectiveMembers?.includes('device-new') !== true,
    `members=${JSON.stringify(notesAfterMember?.members)} effective=${JSON.stringify(notesAfterMember?.effectiveMembers)}`,
  );
  const selfFollow = await fetch(`http://127.0.0.1:${port}/admin/api/memberships`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ member: 'device-console', namespace: 'notes', active: true }),
  });
  check('POST memberships 本机在册（关注语义）→ 201', selfFollow.status === 201, `status=${selfFollow.status}`);
  const nsAfterSelf = await getJson(port, '/admin/api/namespaces');
  check(
    '本机在册反映在 namespaces.selfMember',
    (nsAfterSelf.json ?? []).find((n) => n.namespace === 'notes')?.selfMember === true,
    `selfMember=${(nsAfterSelf.json ?? []).find((n) => n.namespace === 'notes')?.selfMember}`,
  );
  await fetch(`http://127.0.0.1:${port}/admin/api/memberships`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ member: 'device-console', namespace: 'notes', active: false }),
  });
  const nsAfterUnfollow = await getJson(port, '/admin/api/namespaces');
  check(
    '取消关注 → selfMember 回落 false',
    (nsAfterUnfollow.json ?? []).find((n) => n.namespace === 'notes')?.selfMember === false,
    `selfMember=${(nsAfterUnfollow.json ?? []).find((n) => n.namespace === 'notes')?.selfMember}`,
  );

  const memberBad = await fetch(`http://127.0.0.1:${port}/admin/api/memberships`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ namespace: 'notes' }),
  });
  check('memberships 缺 member → 400', memberBad.status === 400, `status=${memberBad.status}`);

  const rejoin = await fetch(`http://127.0.0.1:${port}/admin/api/namespaces/notes/rejoin`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({}),
  });
  const rejoinJson = await rejoin.json().catch(() => null);
  check('rejoin 未满足生效授权 → 409 结构化', rejoin.status === 409 && rejoinJson?.ok !== true, `status=${rejoin.status} reason=${rejoinJson?.reason ?? rejoinJson?.error}`);

  const leaveForce = await fetch(`http://127.0.0.1:${port}/admin/api/namespaces/notes/leave`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ successor: 'device-peer', force: true }),
  });
  check('leave force → 400（force 仅本地 CLI）', leaveForce.status === 400, `status=${leaveForce.status}`);

  const leave = await fetch(`http://127.0.0.1:${port}/admin/api/namespaces/notes/leave`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ successor: 'device-peer' }),
  });
  const leaveJson = await leave.json().catch(() => null);
  check('leave 继任者未全量 ack → 409 结构化（不清理）', leave.status === 409 && leaveJson?.ok !== true, `status=${leave.status} reason=${leaveJson?.reason ?? leaveJson?.error}`);

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

  // ---------- 控制台配置读写（curated：白名单 + 原子写 + 备份） ----------
  const cfgGet = await getJson(port, '/admin/api/config');
  check('GET /admin/api/config 200 + path/config', cfgGet.status === 200 && typeof cfgGet.json?.path === 'string' && typeof cfgGet.json?.config === 'object');
  const cfgBadKey = await fetch(`http://127.0.0.1:${port}/admin/api/config`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ patch: { deviceId: 'x' } }),
  });
  const cfgBadKeyJson = await cfgBadKey.json().catch(() => null);
  check('config 改身份字段 → 400（curated 拒绝）', cfgBadKey.status === 400 && Array.isArray(cfgBadKeyJson?.details), `status=${cfgBadKey.status}`);
  const cfgBadType = await fetch(`http://127.0.0.1:${port}/admin/api/config`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ patch: { sync: { autoSync: 'yes' } } }),
  });
  check('config 类型错误 → 400', cfgBadType.status === 400, `status=${cfgBadType.status}`);
  const cfgOk = await fetch(`http://127.0.0.1:${port}/admin/api/config`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ patch: { sync: { antiEntropy: { intervalMs: 120000 }, snapshotThreshold: 4096 }, joinService: { enabled: false, bind: '127.0.0.1', port: 4002 } } }),
  });
  const cfgOkJson = await cfgOk.json().catch(() => null);
  check(
    'config 合法补丁 → 200 + applied/备份/重启标记',
    cfgOk.status === 200 && cfgOkJson?.ok === true && cfgOkJson.restartRequired === true
      && cfgOkJson.applied?.includes('sync.snapshotThreshold') && Boolean(cfgOkJson.backup),
    `status=${cfgOk.status}`,
  );
  const cfgOnDisk = JSON.parse(await readFile(join(home, 'config.json'), 'utf-8'));
  check(
    'config 写入磁盘且保留其他键',
    cfgOnDisk.sync?.snapshotThreshold === 4096 && cfgOnDisk.sync?.antiEntropy?.intervalMs === 120000
      && cfgOnDisk.sync?.peerWhitelist?.[0] === 'device-peer' && cfgOnDisk.deviceId === 'device-console'
      && cfgOnDisk.joinService?.bind === '127.0.0.1' && cfgOnDisk.joinService?.port === 4002,
  );
  const cfgAfterWrite = await getJson(port, '/admin/api/config');
  check('GET config 反映写入', cfgAfterWrite.json?.config?.sync?.snapshotThreshold === 4096);
  const cfgClear = await fetch(`http://127.0.0.1:${port}/admin/api/config`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ patch: { sync: { snapshotThreshold: null } } }),
  });
  const cfgAfterClear = JSON.parse(await readFile(join(home, 'config.json'), 'utf-8'));
  check('config 置空 → 删除键', cfgClear.status === 200 && !('snapshotThreshold' in (cfgAfterClear.sync ?? {})), `status=${cfgClear.status}`);

  // ---------- 邀请新设备（T2 令牌加入） ----------
  const inviteDisabled = await fetch(`http://127.0.0.1:${port}/admin/api/invite`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({}),
  });
  const inviteDisabledJson = await inviteDisabled.json().catch(() => null);
  check('未启用 joinService → invite 409 结构化', inviteDisabled.status === 409 && inviteDisabledJson?.error === 'join_disabled', `status=${inviteDisabled.status}`);

  {
    const inviteHome = join(home, 'invite');
    const invitePort = await freePort();
    await mkdir(inviteHome, { recursive: true });
    await writeFile(join(inviteHome, 'config.json'), JSON.stringify({
      storagePath: join(inviteHome, 'store.jsonl'),
      deviceId: 'device-invite',
      encryption: { level: 'none' },
      network: { enabled: false },
      mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none', tls: false } },
      joinService: { enabled: true, bind: '127.0.0.1', port: invitePort },
    }, null, 2), 'utf-8');
    const inviteHandle = spawnServe({ home: inviteHome, storage: join(inviteHome, 'store.jsonl'), deviceId: 'device-invite' });
    servers.push(inviteHandle);
    const inviteReady = await waitReady(inviteHandle);
    const invitePage = await fetch(`http://127.0.0.1:${inviteReady.port}/console/`);
    const inviteCsrf = invitePage.headers.get('x-mebular-csrf');
    const inviteCookie = cookieFrom(invitePage);
    const inviteRes = await fetch(`http://127.0.0.1:${inviteReady.port}/admin/api/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mebular-csrf': inviteCsrf, cookie: `mebular_csrf=${inviteCookie}` },
      body: JSON.stringify({ ttlMs: 60000 }),
    });
    const inviteJson = await inviteRes.json().catch(() => null);
    check('启用 joinService → invite 201 + 令牌', inviteRes.status === 201 && typeof inviteJson?.token === 'string' && inviteJson.token.length > 40, `status=${inviteRes.status}`);
    const settingsInvite = await (await fetch(`http://127.0.0.1:${inviteReady.port}/admin/api/settings`)).json().catch(() => null);
    check('settings.join 反映启用与端点', settingsInvite?.join?.enabled === true && settingsInvite?.join?.port === invitePort, `join=${JSON.stringify(settingsInvite?.join)}`);
    const { decodeJoinToken } = await import('../../mcp/src/jointoken.mjs');
    const decoded = decodeJoinToken(inviteJson?.token ?? '');
    check('令牌可解码且指向本机守护', decoded?.inviterDeviceId === 'device-invite' && String(decoded?.endpoint ?? '').includes(String(invitePort)), `endpoint=${decoded?.endpoint}`);
  }

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
    // 配置参与：不传 --port/--auth/--tokens-file，全部由 config.mcp.http 提供
    await writeFile(
      join(bearerHome, 'config.json'),
      JSON.stringify({ mcp: { http: { host: '127.0.0.1', port: 0, auth: 'bearer', tokensFile } } }, null, 2),
      'utf-8',
    );
    const bearerHandle = spawnServe({
      home: bearerHome,
      storage: join(bearerHome, 's.jsonl'),
      deviceId: 'device-bearer',
      portFlag: null,
    });
    servers.push(bearerHandle);
    const bearerReady = await waitReady(bearerHandle);
    const bport = bearerReady.port;
    const base = `http://127.0.0.1:${bport}`;

    const bearerSettings = await (await fetch(`${base}/admin/api/settings`, { headers: { authorization: `Bearer ${readToken}` } })).json();
    check('serve 读取 config.mcp.http.port/auth（无 CLI 标志）', Number.isInteger(bport) && bport > 0 && bearerSettings?.mcp?.port === bport && bearerSettings?.mcp?.auth === 'bearer', `port=${bport} settings.port=${bearerSettings?.mcp?.port} auth=${bearerSettings?.mcp?.auth}`);

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


  // ---------- H2：写端点【端点 ↔ scope ↔ 等价面】一致性（逐端点未授权 403） ----------
  const WRITE_ENDPOINTS = [
    ['POST', '/admin/api/grants'],
    ['POST', '/admin/api/grants/g-1/revoke'],
    ['POST', '/admin/api/devices/device-x/revoke'],
    ['POST', '/admin/api/devices/device-x/connect'],
    ['POST', '/admin/api/devices/device-x/disconnect'],
    ['POST', '/admin/api/devices/device-x/sync'],
    ['POST', '/admin/api/devices/device-x/reset-watermarks'],
    ['POST', '/admin/api/config'],
    ['POST', '/admin/api/invite'],
    ['POST', '/admin/api/policy-issuers'],
    ['POST', '/admin/api/memberships'],
    ['POST', '/admin/api/namespaces/notes/rejoin'],
    ['POST', '/admin/api/namespaces/notes/leave'],
  ];
  const unauthStatuses = [];
  for (const [method, p] of WRITE_ENDPOINTS) {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    unauthStatuses.push(`${method} ${p}:${r.status}`);
  }
  check(`H2 写端点未授权一律 403（${WRITE_ENDPOINTS.length} 个）`, unauthStatuses.every((x) => x.endsWith(':403')), unauthStatuses.filter((x) => !x.endsWith(':403')).join(' '));
  {
    const serveSrc = await readFile(join(rootDir, 'packages', 'mcp', 'src', 'serve.mjs'), 'utf-8');
    const writeBlock = serveSrc.slice(serveSrc.indexOf('async function handleAdminWrite'), serveSrc.indexOf('const handler = async (req, res)'));
    check('H2 写端点统一要求 memory.admin scope（与工具面同一 scope 体系）', writeBlock.includes("'memory.admin'") && writeBlock.includes('csrfValid'));
  }

  // ---------- H3：CSRF/回环/写方法/只读降级 ----------
  check('H3 CSRF cookie SameSite=Strict', /SameSite=Strict/i.test(index.headers.get('set-cookie') ?? ''), index.headers.get('set-cookie') ?? '');
  const methodGet = await fetch(`http://127.0.0.1:${port}/admin/api/grants`, { headers: writeHeaders });
  check('H3 写端点 GET → 405', methodGet.status === 405, `status=${methodGet.status}`);
  const crossOrigin = await fetch(`http://127.0.0.1:${port}/admin/api/grants`, {
    method: 'POST',
    headers: { ...writeHeaders, origin: 'http://evil.example' },
    body: JSON.stringify({ subject: 'device-x', namespaces: ['notes'] }),
  });
  check('H3 跨站点 Origin → 403', crossOrigin.status === 403, `status=${crossOrigin.status}`);
  {
    const roHome = join(home, 'readonly');
    await mkdir(roHome, { recursive: true });
    const roStorage = await seedHome(roHome);
    const roProc = spawnServe({ home: roHome, storage: roStorage, env: { MEBULAR_CONSOLE_WRITES: '0' }, portFlag: null });
    try {
      const ro = await waitReady(roProc);
      const csrfResp = await fetch(`http://127.0.0.1:${ro.port}/console/`);
      const roCsrf = csrfResp.headers.get('x-mebular-csrf');
      const roCookie = (csrfResp.headers.get('set-cookie') ?? '').match(/mebular_csrf=([^;]+)/)?.[1];
      const roWrite = await fetch(`http://127.0.0.1:${ro.port}/admin/api/grants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mebular-csrf': roCsrf, cookie: `mebular_csrf=${roCookie}` },
        body: JSON.stringify({ subject: 'device-x', namespaces: ['notes'] }),
      });
      const roJson = await roWrite.json().catch(() => null);
      check('H3 MEBULAR_CONSOLE_WRITES=0 → 写降级 403 console_read_only', roWrite.status === 403 && roJson?.reason === 'console_read_only', `status=${roWrite.status} reason=${roJson?.reason}`);
    } finally {
      roProc.proc.kill('SIGKILL');
    }
  }

  // ---------- H4/F：config 白名单 + 秘密不可写 + 组合校验 ----------
  const sensitive = [
    { storagePath: '/tmp/x.jsonl' },
    { encryption: { passphrase: 'p' } },
    { mcp: { http: { tokensFile: '/tmp/t.json' } } },
    { deviceId: 'x' },
  ];
  const sensitiveResults = [];
  for (const patch of sensitive) {
    const r = await fetch(`http://127.0.0.1:${port}/admin/api/config`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ patch }) });
    sensitiveResults.push(`${Object.keys(patch)}:${r.status}`);
  }
  check('H4 敏感/身份字段不可写（全部 400）', sensitiveResults.every((x) => x.endsWith(':400')), sensitiveResults.join(' '));

  const combos = [
    [{ mcp: { http: { host: '0.0.0.0' } } }, true, '非回环+auth=none'],
    [{ mcp: { http: { host: '0.0.0.0', auth: 'bearer' } } }, true, '非回环+未启 TLS'],
    [{ mcp: { http: { tls: true } } }, true, 'TLS 开启但缺证书'],
    [{ mcp: { http: { host: '0.0.0.0', auth: 'bearer', tls: true, tlsKey: '/tmp/k.pem', tlsCert: '/tmp/c.pem' } } }, false, '合法组合'],
  ];
  const comboResults = [];
  for (const [patch, shouldReject, label] of combos) {
    const r = await fetch(`http://127.0.0.1:${port}/admin/api/config`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ patch }) });
    const ok = shouldReject ? r.status === 400 : r.status === 200;
    comboResults.push(`${label}:${r.status}${ok ? '' : '(✗)'}`);
  }
  check('F-C2 组合校验：非法 host/auth/tls 组合被拒、合法组合可用', comboResults.every((x) => !x.includes('(✗)')), comboResults.join(' '));
  // 还原为回环 + 无 TLS，避免影响后续/重复运行
  await fetch(`http://127.0.0.1:${port}/admin/api/config`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ patch: { mcp: { http: { host: '127.0.0.1', auth: 'none', tls: false, tlsKey: null, tlsCert: null } } } }),
  });
  const cfgFiles = (await (await import('node:fs/promises')).readdir(home)).filter((f) => f.includes('.tmp-'));
  check('H4 原子写：无 .tmp- 残留且 .bak 存在', cfgFiles.length === 0 && existsSync(join(home, 'config.json.bak')), `tmp=${cfgFiles.join(',')}`);

  // ---------- F-C1：TLS 真开关（缺证书启动即报错；有证书 https 可用） ----------
  {
    const tlsHome = join(home, 'tls');
    await mkdir(tlsHome, { recursive: true });
    const tlsStorage = await seedHome(tlsHome);
    const cfgPath = join(tlsHome, 'config.json');
    const baseCfg = JSON.parse(await readFile(cfgPath, 'utf-8'));
    baseCfg.mcp = { http: { host: '127.0.0.1', port: 0, auth: 'none', tls: true } };
    await writeFile(cfgPath, JSON.stringify(baseCfg, null, 2), 'utf-8');
    const badProc = spawnServe({ home: tlsHome, storage: tlsStorage, portFlag: null });
    const exitCode = await new Promise((resolve) => {
      const t = setTimeout(() => { badProc.proc.kill('SIGKILL'); resolve('timeout'); }, 15000);
      badProc.proc.on('close', (code) => { clearTimeout(t); resolve(code); });
    });
    check('F-C1 tls=true 缺证书 → 启动失败（MCP_INSECURE_CONFIG，不静默降级）',
      exitCode !== 'timeout' && exitCode !== 0 && /MCP_INSECURE_CONFIG/.test(badProc.getErr() + badProc.getOut()),
      `exit=${exitCode} err=${badProc.getErr().trim().slice(-120)}`);

    let openssl = true;
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { openssl = false; }
    if (!openssl) {
      console.log('  - F-C1 有证书 https 可用：SKIP（本机无 openssl）');
    } else {
      const keyPath = join(tlsHome, 'key.pem');
      const certPath = join(tlsHome, 'cert.pem');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
      baseCfg.mcp.http.tlsKey = keyPath;
      baseCfg.mcp.http.tlsCert = certPath;
      await writeFile(cfgPath, JSON.stringify(baseCfg, null, 2), 'utf-8');
      const goodProc = spawnServe({ home: tlsHome, storage: tlsStorage, portFlag: null });
      try {
        const info = await waitReady(goodProc);
        const httpsOk = await new Promise((resolve) => {
          import('node:https').then(({ default: https }) => {
            const req = https.get({ host: '127.0.0.1', port: info.port, path: '/healthz', rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
            req.on('error', () => resolve(false));
          });
        });
        check('F-C1 有证书 → https /healthz 200', httpsOk, `port=${info.port}`);
      } catch (error) {
        check('F-C1 有证书 → https /healthz 200', false, String(error?.message ?? error));
      } finally {
        goodProc.proc.kill('SIGKILL');
      }
    }
  }

  // ---------- F-C3/F-C4：生效值字段与文案诚实化 ----------
  const settingsNow = await getJson(port, '/admin/api/settings');
  check('F-C3 settings 暴露 listenConfigured / relays（区分配置值 vs 实际）',
    Array.isArray(settingsNow.json?.network?.listenConfigured) && Array.isArray(settingsNow.json?.network?.relays) && Array.isArray(settingsNow.json?.network?.listen),
    JSON.stringify({ listenConfigured: settingsNow.json?.network?.listenConfigured, relays: settingsNow.json?.network?.relays }));
  {
    const consoleSrc = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    const needed = [
      'MEBULAR_OAUTH_ADMIN_SECRET', // auth=oauth warn
      '@huggingface/transformers',  // semantic warn
      'quickstart 依赖 LAN 可达',    // joinService.bind 文案诚实
      '非回环',                      // mcp.http.host warn
      'tlsKey',                      // 证书可编辑
      'TLS',                         // 实际运行状态展示
    ];
    check('F-C4 文案/工具面诚实化（oauth/semantic/joinService.bind/host/TLS）', needed.every((token) => consoleSrc.includes(token)), needed.filter((t) => !consoleSrc.includes(t)).join(','));
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
