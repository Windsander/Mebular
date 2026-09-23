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

  for (const [file, mime] of [['console.css', 'text/css'], ['console.js', 'text/javascript'], ['settings-ia.js', 'text/javascript'], ['starfield.js', 'text/javascript'], ['wizard.js', 'text/javascript'], ['nebula.js', 'text/javascript'], ['stars.js', 'text/javascript']]) {
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

  // ---------- 待重启（pendingRestart）：磁盘 config.json 与启动快照不一致 ----------
  {
    // 主实例：保存后磁盘值与启动快照不一致 → pendingRestart 命中刚改的键
    const pendingWrite = await fetch(`http://127.0.0.1:${port}/admin/api/config`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ patch: { network: { enabled: true }, joinService: { enabled: true } } }),
    });
    check('pendingRestart：可写入 network/join 开关', pendingWrite.status === 200, `status=${pendingWrite.status}`);
    const settingsPending = await getJson(port, '/admin/api/settings');
    const pending = Array.isArray(settingsPending.json?.pendingRestart) ? settingsPending.json.pendingRestart : null;
    const pendingPaths = new Set((pending ?? []).map((p) => p.path));
    check(
      'pendingRestart 含刚改的键（network.enabled / joinService.enabled / sync.antiEntropy.intervalMs）',
      Array.isArray(pending)
        && pendingPaths.has('network.enabled')
        && pendingPaths.has('joinService.enabled')
        && pendingPaths.has('sync.antiEntropy.intervalMs')
        && pending.every((p) => typeof p.path === 'string' && 'file' in p && 'running' in p),
      `pending=${[...pendingPaths].join(',')}`,
    );
    const networkPending = (pending ?? []).find((p) => p.path === 'network.enabled');
    check(
      'pendingRestart 元素含 file/running（network.enabled 磁盘 true / 启动快照 false）',
      networkPending?.file === true && networkPending?.running === false,
      JSON.stringify(networkPending),
    );
    check(
      'pendingRestart 暴露重启元信息（restart.serviceHeartbeat / serviceManaged 为 boolean）',
      typeof settingsPending.json?.restart?.serviceHeartbeat === 'boolean'
        && typeof settingsPending.json?.restart?.serviceManaged === 'boolean',
      JSON.stringify(settingsPending.json?.restart),
    );
  }

  // 独立 home：同一实例重启后，磁盘值成为启动快照 → pendingRestart 清空
  {
    const restartHome = join(home, 'pending-restart');
    const restartMcpPort = await freePort();
    const restartJoinPort = await freePort();
    await mkdir(restartHome, { recursive: true });
    await writeFile(join(restartHome, 'config.json'), JSON.stringify({
      storagePath: join(restartHome, 'store.jsonl'),
      deviceId: 'device-pending',
      encryption: { level: 'none' },
      network: { enabled: false, libp2p: { listen: [], relayServers: [] } },
      sync: { autoSync: true, pushOnWrite: false, antiEntropy: { enabled: false, intervalMs: 600000, jitterRatio: 0.2 }, namespaces: [], peerWhitelist: [], policyIssuers: [] },
      semantic: { enabled: false, minScore: 0.2 },
      mcp: { http: { host: '127.0.0.1', port: restartMcpPort, auth: 'none', tls: false } },
      joinService: { enabled: false, bind: '127.0.0.1', port: restartJoinPort },
    }, null, 2), 'utf-8');
    const restartEnv = { MEBULAR_PUSH_ON_WRITE: 'false', MEBULAR_SEMANTIC_ENABLED: 'false', MEBULAR_NETWORK_ENABLED: 'false' };
    const restartOpts = { home: restartHome, storage: join(restartHome, 'store.jsonl'), deviceId: 'device-pending', portFlag: null, env: restartEnv };
    const first = spawnServe(restartOpts);
    servers.push(first);
    const firstReady = await waitReady(first);
    const firstSettings = await getJson(firstReady.port, '/admin/api/settings');
    check(
      'pendingRestart 全新实例为空（磁盘 = 启动快照）',
      Array.isArray(firstSettings.json?.pendingRestart) && firstSettings.json.pendingRestart.length === 0,
      JSON.stringify(firstSettings.json?.pendingRestart),
    );

    const firstPage = await fetch(`http://127.0.0.1:${firstReady.port}/console/`);
    const firstHeaders = { 'content-type': 'application/json', 'x-mebular-csrf': firstPage.headers.get('x-mebular-csrf'), cookie: `mebular_csrf=${cookieFrom(firstPage)}` };
    const change = await fetch(`http://127.0.0.1:${firstReady.port}/admin/api/config`, {
      method: 'POST',
      headers: firstHeaders,
      body: JSON.stringify({ patch: { joinService: { enabled: true } } }),
    });
    check('pendingRestart：保存重启类改动 → 200', change.status === 200, `status=${change.status}`);
    const changedSettings = await getJson(firstReady.port, '/admin/api/settings');
    check(
      '保存后 pendingRestart 含 joinService.enabled',
      (changedSettings.json?.pendingRestart ?? []).some((p) => p.path === 'joinService.enabled'),
      JSON.stringify(changedSettings.json?.pendingRestart),
    );

    await stop(first);
    const second = spawnServe(restartOpts);
    servers.push(second);
    const secondReady = await waitReady(second);
    const secondSettings = await getJson(secondReady.port, '/admin/api/settings');
    check(
      '同一 home 重启后 pendingRestart 清空',
      Array.isArray(secondSettings.json?.pendingRestart) && secondSettings.json.pendingRestart.length === 0,
      JSON.stringify(secondSettings.json?.pendingRestart),
    );
  }

  // ---------- G：保存即生效（前台模式契约 + 三元组/原因 + 一键重启接线） ----------
  {
    // G1（前台 nohup）：无服务托管 → 保存需重启项返回 restarting:false + 手动指引；待重启语义保留
    const gSaved = await fetch(`http://127.0.0.1:${port}/admin/api/config`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ patch: { sync: { snapshotThreshold: 8192 } } }),
    });
    const gJson = await gSaved.json().catch(() => null);
    check(
      'G1 前台保存需重启项 → 200 + restarting:false + restart.mode=foreground（手动指引）',
      gSaved.status === 200 && gJson?.restarting === false && gJson?.restart?.mode === 'foreground'
        && /nohup mebular serve/.test(String(gJson?.restart?.command ?? ''))
        && typeof gJson?.restart?.backup === 'string',
      `status=${gSaved.status} mode=${gJson?.restart?.mode}`,
    );
    // G4：自锁项未确认 → 409 needsConfirmation（不写盘、不重启）
    const gLock = await fetch(`http://127.0.0.1:${port}/admin/api/config`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ patch: { mcp: { http: { auth: 'bearer' } } } }),
    });
    const gLockJson = await gLock.json().catch(() => null);
    check(
      'G4 自锁项（mcp.http.auth）未确认 → 409 needsConfirmation',
      gLock.status === 409 && gLockJson?.needsConfirmation === true && (gLockJson?.paths ?? []).includes('mcp.http.auth'),
      `status=${gLock.status} paths=${JSON.stringify(gLockJson?.paths)}`,
    );
    const gLocked = JSON.parse(await readFile(join(home, 'config.json'), 'utf-8'));
    check('G4 未确认时不写盘（auth 仍为 none）', gLocked.mcp?.http?.auth === 'none', `auth=${gLocked.mcp?.http?.auth}`);
    // 三元组 + 未生效原因 + 暴露面（单一真源）
    const gSettings = await getJson(port, '/admin/api/settings');
    const gRow = (gSettings.json?.effective ?? []).find((row) => row.path === 'sync.antiEntropy.intervalMs');
    check(
      'D 三元组：已配置 / 实际 / 未生效原因（服务端计算；待重启项 reason 明确）',
      gRow && 'configured' in gRow && 'actual' in gRow && typeof gRow.reason === 'string'
        && gSettings.json?.effective?.some((row) => /待重启/.test(String(row.reason))),
      `intervalMs reason=${gRow?.reason}`,
    );
    check(
      'A 暴露面由 schema 驱动载荷（configSchema 20 editable / statusSchema 11 只读 / relayServers 只在只读面）',
      (gSettings.json?.configSchema ?? []).length === 20 && (gSettings.json?.statusSchema ?? []).length === 11
        && !(gSettings.json?.configSchema ?? []).some((e) => e.path === 'network.libp2p.relayServers')
        && (gSettings.json?.statusSchema ?? []).some((e) => e.path === 'network.libp2p.relayServers'),
      `editable=${(gSettings.json?.configSchema ?? []).length} status=${(gSettings.json?.statusSchema ?? []).length}`,
    );
    // 前台模式：无 lastApply（未发生自动重启）；控制台接线齐备
    check('G 前台模式不产生自动重启记录（lastApply 为空）', !gSettings.json?.lastApply);
    const consoleSrc3 = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    check(
      'G 控制台接线：保存并重启 / 重启中 / 已生效 / 已回滚 / 最近一次应用结果',
      consoleSrc3.includes('保存并重启') && consoleSrc3.includes('正在重启…重连中…')
        && consoleSrc3.includes('已生效') && consoleSrc3.includes('已回滚')
        && consoleSrc3.includes('最近一次应用结果') && consoleSrc3.includes('needsConfirmation'),
    );
  }

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

  // ---------- F-C6：邀请端点必须为新设备可达地址（bind=0.0.0.0 时不得写回环） ----------
  {
    const { pickLanHost } = await import('../../mcp/src/lan-host.mjs');
    const reachHome = join(home, 'reach');
    const reachPort = await freePort();
    await mkdir(reachHome, { recursive: true });
    await writeFile(join(reachHome, 'config.json'), JSON.stringify({
      storagePath: join(reachHome, 'store.jsonl'),
      deviceId: 'device-reach',
      encryption: { level: 'none' },
      network: { enabled: false },
      mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none', tls: false } },
      joinService: { enabled: true, bind: '0.0.0.0', port: reachPort },
    }, null, 2), 'utf-8');
    const reachHandle = spawnServe({ home: reachHome, storage: join(reachHome, 'store.jsonl'), deviceId: 'device-reach' });
    servers.push(reachHandle);
    const reachReady = await waitReady(reachHandle);
    const reachPage = await fetch(`http://127.0.0.1:${reachReady.port}/console/`);
    const reachHeaders = {
      'content-type': 'application/json',
      'x-mebular-csrf': reachPage.headers.get('x-mebular-csrf'),
      cookie: `mebular_csrf=${cookieFrom(reachPage)}`,
    };
    const lan = pickLanHost();
    const reachInvite = await fetch(`http://127.0.0.1:${reachReady.port}/admin/api/invite`, {
      method: 'POST',
      headers: reachHeaders,
      body: JSON.stringify({ ttlMs: 60000 }),
    });
    const reachJson = await reachInvite.json().catch(() => null);
    const reachHost = reachJson?.endpoint ? new URL(reachJson.endpoint).hostname : null;
    const { decodeJoinToken: decodeReach } = await import('../../mcp/src/jointoken.mjs');
    const reachDecoded = decodeReach(reachJson?.token ?? '');
    check('F-C6 bind=0.0.0.0 → 邀请端点取可达地址（非回环；无 LAN 时明确告警）',
      reachInvite.status === 201 && ((lan !== '127.0.0.1' && reachHost === lan)
        || (lan === '127.0.0.1' && reachHost === '127.0.0.1' && typeof reachJson?.warning === 'string')),
      `endpoint=${reachJson?.endpoint} lan=${lan} warning=${reachJson?.warning ? 'yes' : 'no'}`);
    check('F-C6 令牌内 endpoint 与返回/设置一致',
      Boolean(reachDecoded?.endpoint) && reachDecoded.endpoint === reachJson?.endpoint
        && (await (await fetch(`http://127.0.0.1:${reachReady.port}/admin/api/settings`)).json())?.join?.endpoint === reachJson?.endpoint,
      `token=${reachDecoded?.endpoint} resp=${reachJson?.endpoint}`);

    const overrideEndpoint = 'http://10.20.30.40:4321';
    const ov = await fetch(`http://127.0.0.1:${reachReady.port}/admin/api/invite`, {
      method: 'POST',
      headers: reachHeaders,
      body: JSON.stringify({ endpoint: overrideEndpoint, ttlMs: 60000 }),
    });
    const ovJson = await ov.json().catch(() => null);
    const ovDecoded = decodeReach(ovJson?.token ?? '');
    check('F-C6 邀请面板可覆盖端点（令牌 endpoint 随之覆盖）',
      ov.status === 201 && ovJson?.endpoint === overrideEndpoint && ovJson?.endpointSource === 'override' && ovDecoded?.endpoint === overrideEndpoint,
      `status=${ov.status} endpoint=${ovJson?.endpoint} source=${ovJson?.endpointSource} token=${ovDecoded?.endpoint}`);
    const badEndpoint = await fetch(`http://127.0.0.1:${reachReady.port}/admin/api/invite`, {
      method: 'POST',
      headers: reachHeaders,
      body: JSON.stringify({ endpoint: 'not-a-url' }),
    });
    check('F-C6 非法 endpoint → 400（不落半截令牌）', badEndpoint.status === 400, `status=${badEndpoint.status}`);
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
    check('F-C7 bearer：/console 仍 200（可粘贴 token 自救，不被自锁挡在门外）', consoleRes.status === 200, `status=${consoleRes.status}`);
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

  // ---------- F-C7：auth=oauth 自锁（静态 token 无效、/register 默认 404、控制台内无法自救） ----------
  {
    const oauthHome = join(home, 'oauth');
    await mkdir(oauthHome, { recursive: true });
    await writeFile(join(oauthHome, 'config.json'), JSON.stringify({
      mcp: { http: { host: '127.0.0.1', port: 0, auth: 'oauth' } },
    }, null, 2), 'utf-8');
    const oauthHandle = spawnServe({ home: oauthHome, storage: join(oauthHome, 's.jsonl'), deviceId: 'device-oauth', portFlag: null });
    servers.push(oauthHandle);
    const oauthReady = await waitReady(oauthHandle);
    const obase = `http://127.0.0.1:${oauthReady.port}`;
    const oNoToken = await fetch(`${obase}/admin/api/overview`);
    const oStatic = await fetch(`${obase}/admin/api/overview`, { headers: { 'x-mebular-token': 'static-token' } });
    const oRegister = await fetch(`${obase}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const oPage = await fetch(`${obase}/console/`);
    check('F-C7 oauth：无凭证 401 且静态 token 401（JWT 校验，控制台内无法自救）',
      oNoToken.status === 401 && oStatic.status === 401, `no-token=${oNoToken.status} static=${oStatic.status}`);
    check('F-C7 oauth：/register 默认 404（未配 env secret）+ /console 仍 200（可看到恢复说明）',
      oRegister.status === 404 && oPage.status === 200, `register=${oRegister.status} console=${oPage.status}`);
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
    ['POST', '/admin/api/restart'],
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
    // seedHome 的 config.mcp.http.port=7331；这里改用临时端口，避免与本机已在运行的真实实例（~/.mebular）抢 7331。
    const roCfgPath = join(roHome, 'config.json');
    const roCfg = JSON.parse(await readFile(roCfgPath, 'utf-8'));
    roCfg.mcp = { ...(roCfg.mcp ?? {}), http: { ...(roCfg.mcp?.http ?? {}), port: 0 } };
    await writeFile(roCfgPath, JSON.stringify(roCfg, null, 2), 'utf-8');
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
    // confirm:true：合法组合可能命中 G4 自锁项（host/auth/tls）——组合校验仍先于自锁确认
    const r = await fetch(`http://127.0.0.1:${port}/admin/api/config`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ patch, confirm: true }) });
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

        // 单一真值：证书齐备即实际启用 TLS（tls 开关只表示「必须启用」），与 server/status 定义一致
        const nfHome = join(home, 'tls-no-flag');
        await mkdir(nfHome, { recursive: true });
        const nfStorage = await seedHome(nfHome);
        const nfCfg = JSON.parse(await readFile(join(nfHome, 'config.json'), 'utf-8'));
        nfCfg.mcp = { http: { host: '127.0.0.1', port: 0, auth: 'none', tls: false, tlsKey: keyPath, tlsCert: certPath } };
        await writeFile(join(nfHome, 'config.json'), JSON.stringify(nfCfg, null, 2), 'utf-8');
        const noFlagProc = spawnServe({ home: nfHome, storage: nfStorage, portFlag: null });
        try {
          const info2 = await waitReady(noFlagProc);
          const https2 = await new Promise((resolve) => {
            import('node:https').then(({ default: https }) => {
              const req = https.get({ host: '127.0.0.1', port: info2.port, path: '/healthz', rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
              req.on('error', () => resolve(false));
            });
          });
          check('F-C1 证书齐备但 tls 未置 true → 仍按同一真值走 https（状态与实际一致）', https2, `port=${info2.port}`);
        } catch (error) {
          check('F-C1 证书齐备但 tls 未置 true → 仍按同一真值走 https（状态与实际一致）', false, String(error?.message ?? error));
        } finally {
          noFlagProc.proc.kill('SIGKILL');
        }
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
    // F-C8：raw 配置 ≠ 运行时（本 home 的 config.port=7331，实际由 --port 0 随机）——编辑器必须双行对照
    const cfgRaw = JSON.parse(await readFile(join(home, 'config.json'), 'utf-8'));
    check('F-C8 设置卡 runtime 与 config 分离（编辑器据此双行对照）',
      settingsNow.json?.mcp?.port !== cfgRaw.mcp.http.port,
      `config.port=${cfgRaw.mcp.http.port} runtime.port=${settingsNow.json?.mcp?.port}`);
    const semanticCfg = { ...cfgRaw, semantic: { enabled: true, minScore: 0.2 } };
    await writeFile(join(home, 'config.json'), JSON.stringify(semanticCfg, null, 2), 'utf-8');
    const settingsSemantic = await getJson(port, '/admin/api/settings');
    const rawSemantic = await getJson(port, '/admin/api/config');
    const transformersInstalled = existsSync(join(rootDir, 'node_modules', '@huggingface', 'transformers'));
    const runtimeSemantic = settingsSemantic.json?.semantic?.enabled;
    check('F-C8 已配置(raw) 与运行时(settings) 分离暴露：semantic.enabled config=true / runtime=false（编辑器据此双行并 ⚠ 不一致）',
      rawSemantic.json?.config?.semantic?.enabled === true
        && runtimeSemantic === (transformersInstalled ? true : false)
        && (transformersInstalled || runtimeSemantic !== rawSemantic.json.config.semantic.enabled),
      `config.enabled=${rawSemantic.json?.config?.semantic?.enabled} runtime.enabled=${runtimeSemantic} transformers=${transformersInstalled}`);
    await writeFile(join(home, 'config.json'), JSON.stringify(cfgRaw, null, 2), 'utf-8');
    const consoleSrc = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    // A：编辑器文案已随单一真源迁到 config-schema.mjs（serve 端），控制台只保留运行状态/恢复指引类文案
    const schemaSrc = await readFile(join(rootDir, 'packages', 'mcp', 'src', 'config-schema.mjs'), 'utf-8');
    const neededInConsole = [
      'MEBULAR_OAUTH_ADMIN_SECRET', // 恢复指引：auth 误切（oauth）
      'tlsKey',                      // 证书可编辑/恢复
      'TLS',                         // 实际运行状态展示
      '已配置',                       // F-C8 双行：已配置 X / 实际 Y
      '实际',                         // F-C8
      'endpoint',                    // F-C6 邀请端点可编辑/展示
      'token grant',                 // F-C7 auth 误切恢复步骤
      '未生效原因',                    // D：三元组第三列
    ];
    const neededInSchema = [
      '@huggingface/transformers',  // semantic warn（单一真源）
      'quickstart 依赖 LAN 可达',    // joinService.bind 文案诚实
      '非回环',                      // mcp.http.host warn
    ];
    check('F-C4 文案/工具面诚实化（oauth/semantic/joinService.bind/host/TLS）',
      neededInConsole.every((token) => consoleSrc.includes(token))
        && neededInSchema.every((token) => schemaSrc.includes(token)),
      `console 缺=${neededInConsole.filter((t) => !consoleSrc.includes(t)).join(',') || '无'} schema 缺=${neededInSchema.filter((t) => !schemaSrc.includes(t)).join(',') || '无'}`);
  }

  // ---------- IA（设置页信息架构：常用/高级/诊断 + 关于本机） ----------
  {
    const ia = await import('../settings-ia.js');
    const HOMES = new Set(['common', 'advanced', 'about', 'diagnostics']);
    const commonFields = ia.IA_COMMON_FIELDS;
    check(`IA 常用恰 6 字段（实得 ${commonFields.length}）`, commonFields.length === 6, commonFields.join(', '));

    const editorFaces = new Set([...ia.IA_COMMON_FIELDS, ...ia.IA_ADVANCED_FIELDS]);
    check('IA 同步节奏（autoSync/pushOnWrite）不在任何编辑面（只读进「关于本机」）',
      !editorFaces.has('sync.autoSync') && !editorFaces.has('sync.pushOnWrite')
        && ia.IA_MIGRATION['sync.autoSync'] === 'about' && ia.IA_MIGRATION['sync.pushOnWrite'] === 'about'
        && ia.IA_INFO_BLOCKS.syncRate === 'about',
      `编辑面命中=${[...editorFaces].filter((x) => x === 'sync.autoSync' || x === 'sync.pushOnWrite').join(',') || '无'}`);

    const homesOf = (path) => [ia.IA_MIGRATION[path]].filter((home) => HOMES.has(home));
    // A/F：**防漂移断言**——schema（单一真源）的 exposure 集合 与 settings-ia 渲染面/只读面逐项一致（多/少即红）
    const schema = await import('../../mcp/src/config-schema.mjs');
    const schemaEditable = [...schema.EDITABLE_PATHS].sort();
    const schemaStatusOnly = [...schema.STATUS_ONLY_PATHS].sort();
    const iaEditable = [...ia.IA_EDITOR_RENDER_PATHS].sort();
    const iaStatusOnly = [...ia.IA_STATUS_ONLY_PATHS].sort();
    const diffSets = (a, b) => [...a.filter((x) => !b.includes(x)), ...b.filter((x) => !a.includes(x))];
    const editableDrift = diffSets(schemaEditable, iaEditable);
    const statusDrift = diffSets(schemaStatusOnly, iaStatusOnly);
    check(`schema↔IA 防漂移：editable 集合逐项一致（各 ${schemaEditable.length}）`,
      schemaEditable.length === 20 && editableDrift.length === 0,
      `schema=${schemaEditable.length} ia=${iaEditable.length} 差异=${editableDrift.join(',') || '无'}`);
    check(`schema↔IA 防漂移：status-only 集合逐项一致（各 ${schemaStatusOnly.length}）`,
      schemaStatusOnly.length === 11 && statusDrift.length === 0,
      `schema=${schemaStatusOnly.length} ia=${iaStatusOnly.length} 差异=${statusDrift.join(',') || '无'}`);
    // B：收敛回归——relayServers 从编辑面消失（status-only）、relayUnlimited 不再渲染（internal）
    const advancedDrift = ia.IA_ADVANCED_FIELDS.filter((p) => ['network.libp2p.relayServers', 'network.libp2p.relayUnlimited'].includes(p));
    check('B 暴露面收敛：relayServers 退出编辑面（→只读自动池）/ relayUnlimited 退出 GUI（→internal）',
      ia.IA_ADVANCED_FIELDS.length === 14 && advancedDrift.length === 0
        && schema.exposureOf('network.libp2p.relayServers') === 'status-only'
        && schema.exposureOf('network.libp2p.relayUnlimited') === 'internal'
        && schema.isWritable('network.libp2p.relayServers') === false,
      `advanced=${ia.IA_ADVANCED_FIELDS.length} 残留=${advancedDrift.join(',') || '无'}`);

    const pathsWithoutHome = ia.IA_EDITOR_PATHS.filter((path) => homesOf(path).length !== 1);
    const infoWithoutHome = Object.keys(ia.IA_INFO_BLOCKS).filter((block) => homesOf(block).length !== 1);
    const rendered = new Set([...ia.IA_COMMON_FIELDS, ...ia.IA_ADVANCED_FIELDS]);
    const drifted = ia.IA_EDITOR_PATHS.filter((path) => (ia.IA_MIGRATION[path] === 'common' || ia.IA_MIGRATION[path] === 'advanced') !== rendered.has(path));
    const statusWithoutHome = ia.IA_STATUS_ONLY_PATHS.filter((path) => homesOf(path).length !== 1);
    check('IA 不丢项：20 可编辑 path + 11 只读 path + 10 信息块各有且仅有唯一去处（迁移表驱动）',
      ia.IA_EDITOR_PATHS.length === 20 && pathsWithoutHome.length === 0 && infoWithoutHome.length === 0 && drifted.length === 0 && statusWithoutHome.length === 0,
      `editorPaths=${ia.IA_EDITOR_PATHS.length} 只读无去处=${statusWithoutHome.join(',') || '无'} 编辑无去处=${pathsWithoutHome.join(',') || '无'} 信息块无去处=${infoWithoutHome.join(',') || '无'} 编辑面漂移=${drifted.join(',') || '无'}`);

    const cardFields = ia.IA_TASK_CARDS.flatMap((card) => card.fields);
    check('IA 常用四张任务卡共 6 字段且不重复（含 agent 危险卡）',
      ia.IA_TASK_CARDS.length === 4 && cardFields.length === 6 && new Set(cardFields).size === 6
        && ia.IA_TASK_CARDS.some((card) => card.id === 'agent' && card.danger === true),
      `cards=${ia.IA_TASK_CARDS.length} fields=${cardFields.join(',')}`);

    const htmlSrc = await readFile(join(consoleDir, 'index.html'), 'utf-8');
    const consoleSrc2 = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    const tabIds = ia.IA_TABS.map((tab) => tab.id).join(',');
    const tabLabels = ia.IA_TABS.map((tab) => tab.label).join(',');
    check('IA Tab 结构（常用/高级/诊断）与「关于本机」入口齐备',
      tabIds === 'common,advanced,diagnostics' && tabLabels === '常用,高级,诊断'
        && htmlSrc.includes('id="self-badge"') && htmlSrc.includes('id="about"') && htmlSrc.includes('关于本机')
        && consoleSrc2.includes('data-settings-tab') && consoleSrc2.includes('IA_TASK_CARDS')
        && consoleSrc2.includes('IA_ADVANCED_FIELDS') && consoleSrc2.includes('IA_MIGRATION'),
      `tabs=${tabIds} labels=${tabLabels}`);
    // A：编辑器字段改由服务端 schema 驱动（不再在控制台重复声明）；C：一键重启接线
    check('A 编辑器由单一真源驱动（configSchema）且不再内置字段表',
      consoleSrc2.includes('configSchema') && consoleSrc2.includes('rebuildConfigFields')
        && !/const CONFIG_EDITOR = \[/.test(consoleSrc2),
      'console.js 从 /admin/api/settings.configSchema 建字段表');
    check('C 一键重启接线（按钮 + POST /admin/api/restart + 二次确认 + 手动指引回退）',
      consoleSrc2.includes("data-cfg-action=\"restart\"") && consoleSrc2.includes('/admin/api/restart')
        && consoleSrc2.includes('confirmModal') && consoleSrc2.includes('not_service_managed') === false
        && consoleSrc2.includes('手动重启'),
      'restart 按钮/接口/确认/回退齐备');

    const recoveryTokens = ['auth 误切', 'host 误设', '缺证书', '控制台打不开', 'MCP_INSECURE_CONFIG', 'MCP_STORAGE_LOCKED', 'token grant'];
    check('IA 诊断恢复指引文案完整（auth 误切 / host 误设 / 缺证书 / 控制台打不开）',
      recoveryTokens.every((token) => consoleSrc2.includes(token)),
      recoveryTokens.filter((token) => !consoleSrc2.includes(token)).join(',') || '全部命中');
  }

  // ---------- 排版不变量：单一 kv 行模板 / cfg 行同构 / token 化间距 / 无内联宽 ----------
  {
    const cssSrc = await readFile(join(consoleDir, 'console.css'), 'utf-8');
    const jsSrc = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    const tokens = ['--row-label-w', '--kv-action-w', '--row-gap', '--row-gap-y', '--control-h', '--section-gap'];
    check('排版 token 齐备（label 列宽 / 动作列宽 / 行距 / 控件高 / section 间距）',
      tokens.every((t) => cssSrc.includes(`${t}:`)), tokens.filter((t) => !cssSrc.includes(`${t}:`)).join(',') || '全部命中');

    check('kv 与 cfg 共用同一 label 列宽变量（不再各写一套栅格）',
      cssSrc.includes('grid-template-columns: var(--row-label-w) minmax(0, 1fr) var(--kv-action-w)')
        && cssSrc.includes('grid-template-columns: var(--row-label-w) minmax(0, 1fr)'),
      'settings-kv=3 列（label/value/action），cfg-row=2 列（label/control），label 列同为 var(--row-label-w)');

    check('动作列固定宽且行高统一（button 不撑高行）',
      cssSrc.includes('.settings-kv .kv-action { display: flex; align-items: center; justify-content: flex-end; min-height: var(--control-h); }')
        && cssSrc.includes('.settings-kv .kv-action .btn { height: var(--control-h);'),
      'kv-action 固定列 + 按钮高 = --control-h');

    check('双值行结构化 + 状态色（一致=暗色 / 不一致=警示色）',
      cssSrc.includes('.cfg-effective.is-mismatch { color: #ffd27a; }')
        && cssSrc.includes('.settings-kv .kv-sub.is-mismatch { color: #ffd27a; }')
        && jsSrc.includes("class=\"cfg-effective${mismatch ? ' is-mismatch' : ''}\"")
        && jsSrc.includes("class=\"kv-sub${mismatch ? ' is-mismatch' : ''}\""),
      'cfg-effective / kv-sub 均按 mismatch 切换警示色');

    check('响应式 ≤760px：kv 与 cfg 行转上下布局（无横向滚动）',
      /@media \(max-width: 760px\) \{[\s\S]*?\.settings-kv \{\s*grid-template-columns: minmax\(0, 1fr\);[\s\S]*?\.cfg-row \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(cssSrc),
      '760 断点内 kv/cfg 单列');

    check('渲染模板无内联 width（对齐只能来自 CSS token）',
      !/style="width/.test(jsSrc), /style="width/.test(jsSrc) ? '发现内联 width' : '无内联 width');
  }

  // ---------- C2：对端连接路径（只读渲染断言，不涉行为） ----------
  {
    const settingsNow2 = await getJson(port, '/admin/api/settings');
    const peers = settingsNow2.json?.peers;
    check('C2 settings.peers 暴露路径视图（enabled + paths 数组 + 候选/错误字段）',
      typeof peers?.enabled === 'boolean' && Array.isArray(peers?.paths)
        && peers.paths.every((p) => 'key' in p && 'connected' in p && 'kind' in p && 'candidates' in p),
      `enabled=${peers?.enabled} paths=${peers?.paths?.length ?? 'n/a'}`);

    const consoleSrc3 = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    const cssSrc3 = await readFile(join(consoleDir, 'console.css'), 'utf-8');
    const tokensC2 = ['对端连接路径', 'path-row', 'path-kind-', '最近切换', '地址簿'];
    check('C2 控制台渲染对端路径行（设备卡 + 关于本机只读区）',
      tokensC2.every((token) => consoleSrc3.includes(token)),
      tokensC2.filter((token) => !consoleSrc3.includes(token)).join(',') || '全部命中');
    check('C2 路径行沿用统一行模板（label 列宽 token + 窄屏单列）',
      cssSrc3.includes('.path-row { display: grid; grid-template-columns: var(--row-label-w, 150px) minmax(0, 1fr);')
        && cssSrc3.includes('@media (max-width: 760px) { .path-row { grid-template-columns: minmax(0, 1fr); } }'),
      'path-row 复用 --row-label-w');
  }

  // ---------- C6：内建 relay 角色（只读渲染断言，不涉行为） ----------
  {
    const settingsRelay = await getJson(port, '/admin/api/settings');
    const relay = settingsRelay.json?.relay;
    check('C6 settings.relay 暴露内建桥角色（mode/serving/reason/publicAddrs/allowedClients）',
      relay && ['auto', 'off', 'on'].includes(relay.mode) && typeof relay.serving === 'boolean'
        && typeof relay.reason === 'string' && Array.isArray(relay.publicAddrs) && typeof relay.allowedClients === 'number',
      relay);
    const consoleSrc4 = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    const tokensC6 = ['本机当桥', '当前经桥', '桥白名单'];
    check('C6 控制台只读展示「本机当桥/当前经桥/桥白名单」',
      tokensC6.every((token) => consoleSrc4.includes(token)),
      tokensC6.filter((token) => !consoleSrc4.includes(token)).join(',') || '全部命中');
    const binSrc = await readFile(join(rootDir, 'packages', 'mcp', 'bin', 'mebular.mjs'), 'utf-8');
    // 注意：用拼接构造被禁字样，避免本文件自身命中「无残留引用」扫描
    const forbidden = [['case ', "'relay'"].join(''), ['runRelay', 'Host'].join(''), ['MEBULAR_', 'RELAY_'].join('')];
    check('C6 无独立 relay 命令（bin 无 relay 子命令 / 旧实现 / 旧环境变量）',
      forbidden.every((token) => !binSrc.includes(token)));
  }

  // ---------- C5：地址自动广播（只读渲染断言，不涉行为） ----------
  {
    const settingsNet = await getJson(port, '/admin/api/settings');
    const net = settingsNet.json?.net;
    check('C5 settings.net 暴露广播状态（enabled/mode/ttlMs/published/applied/ignored）',
      net && typeof net.enabled === 'boolean' && ['full', 'relay-only', 'off'].includes(net.mode)
        && typeof net.ttlMs === 'number' && typeof net.published === 'number' && typeof net.applied === 'number'
        && net.ignored && typeof net.ignored === 'object',
      net);
    const consoleSrc5 = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    const tokensC5 = ['地址广播', '__net__', '广播忽略'];
    check('C5 控制台只读展示「地址广播」（档位/已发布/已采用/忽略原因）',
      tokensC5.every((token) => consoleSrc5.includes(token)),
      tokensC5.filter((token) => !consoleSrc5.includes(token)).join(',') || '全部命中');
  }

  // ---------- C7：扫码即通（邀请响应带二维码 + 控制台渲染断言） ----------
  {
    const inviteHome2 = join(home, 'invite-qr');
    const invitePort2 = await freePort();
    await mkdir(inviteHome2, { recursive: true });
    await writeFile(join(inviteHome2, 'config.json'), JSON.stringify({
      storagePath: join(inviteHome2, 'store.jsonl'),
      deviceId: 'device-qr',
      encryption: { level: 'none' },
      network: { enabled: false },
      mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none', tls: false } },
      joinService: { enabled: true, bind: '127.0.0.1', port: invitePort2 },
    }, null, 2), 'utf-8');
    const qrHandle = spawnServe({ home: inviteHome2, storage: join(inviteHome2, 'store.jsonl'), deviceId: 'device-qr' });
    servers.push(qrHandle);
    const qrReady = await waitReady(qrHandle);
    const qrPage = await fetch(`http://127.0.0.1:${qrReady.port}/console/`);
    const qrHeaders = {
      'content-type': 'application/json',
      'x-mebular-csrf': qrPage.headers.get('x-mebular-csrf'),
      cookie: `mebular_csrf=${cookieFrom(qrPage)}`,
    };
    const inviteRes = await fetch(`http://127.0.0.1:${qrReady.port}/admin/api/invite`, {
      method: 'POST', headers: qrHeaders, body: JSON.stringify({ ttlMs: 60000 }),
    });
    const inviteJson = await inviteRes.json().catch(() => null);
    // 可选依赖在场 → SVG；缺包 → null（只给文本）；两者都合法，字段必须存在
    check('C7 邀请响应提供二维码（qrSvg：SVG 字符串或缺可选依赖时为 null）+ grantOnJoin',
      inviteRes.status === 201 && 'qrSvg' in (inviteJson ?? {}) && (inviteJson?.qrSvg === null || String(inviteJson?.qrSvg).startsWith('<svg'))
        && inviteJson?.grantOnJoin === true,
      { status: inviteRes.status, qr: inviteJson?.qrSvg === null ? 'null（缺可选依赖）' : 'svg', grantOnJoin: inviteJson?.grantOnJoin });
    const consoleSrc6 = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    check('C7 控制台邀请面板渲染二维码与自动授权说明',
      ['扫码即通', 'qrSvg', '兑换后自动授权'].every((token) => consoleSrc6.includes(token)));
    const pkg = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf-8'));
    check('C7 二维码依赖为**精确 pin** 的可选依赖（依赖政策）',
      typeof pkg.optionalDependencies?.qrcode === 'string' && /^\d+\.\d+\.\d+$/.test(pkg.optionalDependencies.qrcode),
      { qrcode: pkg.optionalDependencies?.qrcode });
  }

  // ---------- C4：NAT 打洞（只读渲染断言） ----------
  {
    const settingsNat = await getJson(port, '/admin/api/settings');
    const nat = settingsNat.json?.nat;
    check('C4 settings.nat 暴露打洞状态（enabled/autonat/dcutr/directUpgrades/relayConnections/loadError）',
      nat && typeof nat.enabled === 'boolean' && typeof nat.autonatEnabled === 'boolean'
        && typeof nat.dcutrEnabled === 'boolean' && typeof nat.directUpgrades === 'number'
        && typeof nat.relayConnections === 'number' && 'loadError' in nat,
      nat);
    const consoleSrc7 = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    check('C4 控制台只读展示「NAT 打洞」（AutoNAT/DCUtR/直连升级）',
      ['NAT 打洞', 'DCUtR', '直连升级'].every((token) => consoleSrc7.includes(token)));
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
