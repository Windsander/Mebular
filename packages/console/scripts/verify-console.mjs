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
import { createWizardState, wizardReduce } from '../wizard.js';

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
    sync: { autoSync: true, pushOnWrite: false, antiEntropy: { enabled: false }, namespaces: ['notes', 'work'], peerWhitelist: ['device-peer'] },
    mcp: { http: { host: '127.0.0.1', port: 7331, auth: 'none', tls: false } },
  };
  await writeFile(join(home, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');

  const app = new Mebular({
    storagePath,
    deviceId: 'device-console',
    encryption: { level: 'none', userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    network: { enabled: false },
    sync: { autoSync: true, namespaces: ['notes', 'work'] },
  });
  await app.initialize();
  const service = new MemoryService(app);
  await service.write([
    { type: 'fact', content: 'alpha', metadata: { namespace: 'notes' } },
    { type: 'fact', content: 'beta', metadata: { namespace: 'notes' } },
    { type: 'fact', content: 'gamma', metadata: { namespace: 'work' } },
  ]);
  await app.declareNamespace({ namespace: 'notes', note: 'seed' });
  await app.declareNamespace({ namespace: 'work', note: 'seed' });
  await app.subscribeNamespace('notes');
  await app.revokeDevice({ subject: 'device-bad' });
  // 2b：预置交接审计事件（审计渲染与 API 结构防回归）
  await app.eventLog.append({
    type: 'namespace_handoff',
    data: { handoff: { handoffId: 'handoff-1', namespace: 'work', successor: 'device-peer', forced: false, pendingCount: 0, issuedAt: Date.now() } },
    namespace: POLICY_NAMESPACE,
  });
  // S3：审计安全行（低 → 中 → 低；动态码导入留痕）——不改变最终档位，避免影响后续写端点断言
  const secNow = Date.now();
  await app.eventLog.append({
    type: 'security_tier',
    data: { securityTier: { level: 'medium', nonce: 'seed-tier-medium', issuedAt: secNow - 120_000 } },
    namespace: POLICY_NAMESPACE,
  });
  await app.eventLog.append({
    type: 'security_tier',
    data: { securityTier: { level: 'low', nonce: 'seed-tier-low', issuedAt: secNow - 60_000 } },
    namespace: POLICY_NAMESPACE,
  });
  await app.eventLog.append({
    type: 'security_totp',
    data: { securityTotp: { device: 'device-console', fingerprint: 'a1b2c3d4', issuedAt: secNow - 30_000, note: 'seed' } },
    namespace: POLICY_NAMESPACE,
  });
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
      MEBULAR_USER_HOME: home,   // F-FIX-A：沙箱 harness 声明用户主目录；否则 assistant 落面指向真实 home
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
      const match = handle.getOut().match(/(?:PROVISION_READY|SERVE_READY) (\{.*\})/);
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
  const proc = handle?.proc;
  if (!proc) return;
  // 已退出（正常或被信号杀死）直接返回；否则限时等待，超时 SIGKILL 兜底
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) { resolve(); return; }
    proc.once('exit', resolve);
    proc.once('close', resolve);
  });
  try { proc.kill('SIGTERM'); } catch { /* 已退出 */ }
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 8000)),
  ]);
  if (timedOut) {
    try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
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

// ---------- E1 · 手动连接（网内传输修复）状态机（纯函数，无需起服务） ----------
{
  let s = createWizardState();
  check('E1 手动连接初始 step=local', s.step === 'local');
  s = wizardReduce(s, { type: 'GO_CONNECT' });
  check('E1 缺 deviceId/address → 拦截', s.step === 'local' && Boolean(s.error));
  s = wizardReduce(s, { type: 'PEER_INPUT', deviceId: 'device-B', address: '/ip4/127.0.0.1/tcp/4011/p2p/xyz' });
  s = wizardReduce(s, { type: 'GO_CONNECT' });
  check('E1 输入齐全 → step=connect/connecting', s.step === 'connect' && s.connection === 'connecting');
  s = wizardReduce(s, { type: 'CONNECT_SUCCESS' });
  check('E1 连接成功 → connected（无共享域/签发步骤）', s.connection === 'connected' && s.step === 'connect');
  const reset = wizardReduce(s, { type: 'RESET' });
  check('E1 RESET 回到初始', reset.step === 'local' && reset.deviceId === '' && reset.address === '');
  let f = wizardReduce(createWizardState(), { type: 'PEER_INPUT', deviceId: 'd', address: 'a' });
  f = wizardReduce(f, { type: 'GO_CONNECT' });
  f = wizardReduce(f, { type: 'CONNECT_FAILURE', message: 'refused' });
  check('E1 连接失败可重试', f.connection === 'failed' && f.error === 'refused');
  f = wizardReduce(f, { type: 'BACK' });
  check('E1 connect → BACK 回 local', f.step === 'local');
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

  // 防再犯：index.html 中 id 必须唯一（provision-restart 待重启面板曾被整块复制两遍，
  // 重复 id ×5，JS querySelector 只接线第一块，第二块成为带重复 id 的死代码）
  {
    const ids = [...indexText.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dupIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    check('index.html 元素 id 全部唯一（面板单实例，无重复块）', dupIds.length === 0, dupIds.join(','));
    check('provision 待重启面板单实例（provision-restart* 各出现一次）',
      ['provision-restart', 'provision-restart-note', 'provision-restart-command', 'provision-restart-copy', 'provision-restart-hint']
        .every((id) => ids.filter((x) => x === id).length === 1));
  }
  check('/console 下发 CSRF cookie 与响应头', (index.headers.get('set-cookie') ?? '').includes('mebular_csrf=') && Boolean(index.headers.get('x-mebular-csrf')));

  for (const [file, mime] of [['console.css', 'text/css'], ['console.js', 'text/javascript'], ['assistants.js', 'text/javascript'], ['settings-ia.js', 'text/javascript'], ['starfield.js', 'text/javascript'], ['wizard.js', 'text/javascript'], ['nebula.js', 'text/javascript'], ['stars.js', 'text/javascript']]) {
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
  check('overview.blockedCount = 1', overview.json?.blockedCount === 1, String(overview.json?.blockedCount));
  check('overview.status.stateHashByNamespace 存在', typeof overview.json?.status?.stateHashByNamespace === 'object');
  check('overview.features.writes 为 boolean', typeof overview.json?.features?.writes === 'boolean');

  const devices = await getJson(port, '/admin/api/devices');
  check('GET /admin/api/devices 200 + 数组', devices.status === 200 && Array.isArray(devices.json));
  const byId = new Map((devices.json ?? []).map((d) => [d.deviceId, d]));
  const peer = byId.get('device-peer');
  check('devices 含 device-peer 且 subscriptions 为数组', Array.isArray(peer?.subscriptions));
  const selfDevice = byId.get('device-console');
  check('device-console 的 subscriptions 含 notes', Array.isArray(selfDevice?.subscriptions) && selfDevice.subscriptions.includes('notes'));
  const bad = byId.get('device-bad');
  check('device-bad blocked=true', bad?.blocked === true);
  check('devices 项字段齐全', (devices.json ?? []).every((d) => typeof d.deviceId === 'string' && typeof d.online === 'boolean' && typeof d.blocked === 'boolean' && Array.isArray(d.subscriptions) && Array.isArray(d.sharesWithMe) && 'pendingEventCount' in d));

  const policy = await getJson(port, '/admin/api/policy');
  check('GET /admin/api/policy 200 + 数组', policy.status === 200 && Array.isArray(policy.json));
  {
    const types = new Set((policy.json ?? []).map((e) => e.type));
    check(
      '审计含订阅/公告/交接三类事件',
      ['namespace_subscription', 'namespace_declare', 'namespace_handoff'].every((t) => types.has(t)),
      `types=${[...types].sort().join(',')}`,
    );
    const subscriptions = (policy.json ?? []).filter((e) => e.type === 'namespace_subscription');
    check(
      '订阅事件字段完整且含 active 三态',
      subscriptions.length >= 1
        && subscriptions.every((e) => e.subject === 'device-console' && e.namespace === 'notes' && typeof e.active === 'boolean')
        && subscriptions.some((e) => e.active === true),
      `count=${subscriptions.length} states=${subscriptions.map((e) => e.active).join(',')}`,
    );
  }
  const types = new Set((policy.json ?? []).map((e) => e.type));
  check('policy 含 subscription/declare/device_revoke', types.has('namespace_subscription') && types.has('namespace_declare') && types.has('device_revoke'));
  check('policy 项字段齐全', (policy.json ?? []).every((e) => typeof e.eventId === 'string' && typeof e.issuer === 'string' && typeof e.at === 'number' && typeof e.valid === 'boolean'));

  const namespaces = await getJson(port, '/admin/api/namespaces');
  check('GET /admin/api/namespaces 200 + 数组', namespaces.status === 200 && Array.isArray(namespaces.json));
  const notes = (namespaces.json ?? []).find((n) => n.namespace === 'notes');
  const work = (namespaces.json ?? []).find((n) => n.namespace === 'work');
  check('namespaces 含 notes（count ≥ 2）', (notes?.count ?? 0) >= 2, String(notes?.count));
  check('namespaces 含 work（count ≥ 1）', (work?.count ?? 0) >= 1, String(work?.count));
  check('namespaces 项字段齐全', (namespaces.json ?? []).every((n) => typeof n.namespace === 'string' && typeof n.count === 'number' && 'lastUpdatedAt' in n && 'stateHash' in n));
  check(
    'namespaces 含订阅/公告/重入扩展字段',
    (namespaces.json ?? []).every((n) => typeof n.subscriptionDeclared === 'boolean'
      && Array.isArray(n.subscribers)
      && typeof n.subscribed === 'boolean' && typeof n.selfSubscribed === 'boolean'
      && typeof n.rejoinReset === 'boolean' && typeof n.declared === 'boolean'),
  );
  check('notes 已声明订阅且含本机', notes?.subscriptionDeclared === true && notes.subscribers.includes('device-console'), `subs=${JSON.stringify(notes?.subscribers)}`);
  check('work 为域公告（declared=true）', work?.declared === true, `declared=${work?.declared}`);

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
      && Array.isArray(settings.json?.declaredNamespaces)
      && typeof settings.json?.blockedCount === 'number'
      && (settings.json?.identity?.mode === null || typeof settings.json?.identity?.mode === 'string')
      && typeof settings.json?.join?.enabled === 'boolean'
      && typeof settings.json?.join?.port === 'number'
      && typeof settings.json?.fleet?.configured === 'boolean'
      && Array.isArray(settings.json?.tools)
      && typeof settings.json?.mcp?.host === 'string'
      && typeof settings.json?.semantic?.enabled === 'boolean',
    `declared=${JSON.stringify(settings.json?.declaredNamespaces)}`,
  );
  check('settings.declaredNamespaces 含 notes/work', ['notes', 'work'].every((ns) => settings.json?.declaredNamespaces?.includes(ns) === true));
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
  check('devices 含 subscriptions/blocked 字段', (devices.json ?? []).every((d) => Array.isArray(d.subscriptions) && typeof d.blocked === 'boolean'));
  check('device-console subscriptions 含 notes', byId.get('device-console')?.subscriptions?.includes('notes') === true);
  check('device-peer subscriptions 为空数组', Array.isArray(byId.get('device-peer')?.subscriptions) && byId.get('device-peer').subscriptions.length === 0);

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
  const writeNoCsrf = await fetch(`http://127.0.0.1:${port}/admin/api/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ namespace: 'notes', active: true }),
  });
  check('POST /admin/api/subscriptions 未授权 → 403', writeNoCsrf.status === 403, `status=${writeNoCsrf.status}`);
  const createNoCsrf = await fetch(`http://127.0.0.1:${port}/admin/api/namespaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ namespace: 'ledger' }),
  });
  check('POST /admin/api/namespaces 未授权 → 403', createNoCsrf.status === 403, `status=${createNoCsrf.status}`);
  const deviceNoCsrf = await fetch(`http://127.0.0.1:${port}/admin/api/devices/device-peer/revoke`, { method: 'POST' });
  check('POST /admin/api/devices/:id/revoke 未授权 → 403', deviceNoCsrf.status === 403, `status=${deviceNoCsrf.status}`);

  // ---------- D2 写端点（CSRF 双提交 + 授权） ----------
  const csrf = index.headers.get('x-mebular-csrf');
  const csrfCookie = cookieFrom(index);
  check('CSRF cookie 与响应头成对下发', Boolean(csrf) && Boolean(csrfCookie));
  const writeHeaders = { 'content-type': 'application/json', 'x-mebular-csrf': csrf, cookie: `mebular_csrf=${csrfCookie}` };

  const headerOnly = await fetch(`http://127.0.0.1:${port}/admin/api/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf },
    body: JSON.stringify({ namespace: 'work', active: true }),
  });
  check('仅 CSRF 头、无 cookie → 403', headerOnly.status === 403, `status=${headerOnly.status}`);
  const cookieOnly = await fetch(`http://127.0.0.1:${port}/admin/api/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `mebular_csrf=${csrfCookie}` },
    body: JSON.stringify({ namespace: 'work', active: true }),
  });
  check('仅 cookie、无 CSRF 头 → 403', cookieOnly.status === 403, `status=${cookieOnly.status}`);

  const created = await fetch(`http://127.0.0.1:${port}/admin/api/subscriptions`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ namespace: 'work', active: true }),
  });
  const createdJson = (await created.json().catch(() => null));
  check('CSRF 完整 → 订阅写入 200 + eventId', created.status === 200 && typeof createdJson?.eventId === 'string', `status=${created.status}`);

  const devicesAfterGrant = await getJson(port, '/admin/api/devices');
  const peerRow = (devicesAfterGrant.json ?? []).find((d) => d.deviceId === 'device-peer');
  const selfRowAfter = (devicesAfterGrant.json ?? []).find((d) => d.deviceId === 'device-console');
  check(
    '订阅只改本机（self 含 work；peer 不变）',
    selfRowAfter?.subscriptions?.includes('work') === true && peerRow?.subscriptions?.includes('work') !== true,
    `peer=${JSON.stringify(peerRow?.subscriptions)} self=${JSON.stringify(selfRowAfter?.subscriptions)}`,
  );

  const revoked = await fetch(`http://127.0.0.1:${port}/admin/api/subscriptions`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ namespace: 'work', active: false }),
  });
  const revokedJson = await revoked.json().catch(() => null);
  check('退订 → 200', revoked.status === 200 && revokedJson?.ok === true, `status=${revoked.status}`);

  const policyAfter = await getJson(port, '/admin/api/policy');
  check(
    '订阅与退订均入审计',
    (policyAfter.json ?? []).some((e) => e.type === 'namespace_subscription' && e.namespace === 'work' && e.active === true)
      && (policyAfter.json ?? []).some((e) => e.type === 'namespace_subscription' && e.namespace === 'work' && e.active === false),
  );

  const badBody = await fetch(`http://127.0.0.1:${port}/admin/api/subscriptions`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ active: true }),
  });
  check('缺 namespace → 400', badBody.status === 400, `status=${badBody.status}`);

  // ---------- 建域 / 订阅 / 交接写端点 ----------
  const declareResp = await fetch(`http://127.0.0.1:${port}/admin/api/namespaces`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ namespace: 'ledger' }),
  });
  const declareJson = await declareResp.json().catch(() => null);
  check('POST namespaces → 201 + eventId + 默认自订阅', declareResp.status === 201 && typeof declareJson?.eventId === 'string' && declareJson?.subscribed === true, `status=${declareResp.status}`);
  const nsAfterDeclare = await getJson(port, '/admin/api/namespaces');
  const ledger = (nsAfterDeclare.json ?? []).find((n) => n.namespace === 'ledger');
  check('新域立即可见且默认自订阅（count=0）', ledger?.declared === true && ledger?.count === 0 && ledger?.selfSubscribed === true, `ledger=${JSON.stringify(ledger)}`);

  const selfSubscribe = await fetch(`http://127.0.0.1:${port}/admin/api/subscriptions`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ namespace: 'notes', active: true }),
  });
  check('POST subscriptions 本机订阅 → 200', selfSubscribe.status === 200, `status=${selfSubscribe.status}`);
  const nsAfterSelf = await getJson(port, '/admin/api/namespaces');
  check(
    '本机订阅反映在 namespaces.selfSubscribed',
    (nsAfterSelf.json ?? []).find((n) => n.namespace === 'notes')?.selfSubscribed === true,
    `selfSubscribed=${(nsAfterSelf.json ?? []).find((n) => n.namespace === 'notes')?.selfSubscribed}`,
  );
  await fetch(`http://127.0.0.1:${port}/admin/api/subscriptions`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ namespace: 'notes', active: false }),
  });
  const nsAfterUnfollow = await getJson(port, '/admin/api/namespaces');
  check(
    '退订 → selfSubscribed 回落 false',
    (nsAfterUnfollow.json ?? []).find((n) => n.namespace === 'notes')?.selfSubscribed === false,
    `selfSubscribed=${(nsAfterUnfollow.json ?? []).find((n) => n.namespace === 'notes')?.selfSubscribed}`,
  );

  const memberBad = await fetch(`http://127.0.0.1:${port}/admin/api/subscriptions`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({ active: true }),
  });
  check('subscriptions 缺 namespace → 400', memberBad.status === 400, `status=${memberBad.status}`);

  const rejoin = await fetch(`http://127.0.0.1:${port}/admin/api/namespaces/notes/rejoin`, {
    method: 'POST',
    headers: writeHeaders,
    body: JSON.stringify({}),
  });
  const rejoinJson = await rejoin.json().catch(() => null);
  check(
    'rejoin 满足「本机订阅声明 ∧ 未移出」→ 200 结构化（W1-B 新准入）',
    rejoin.status === 200 && rejoinJson?.ok === true && rejoinJson?.reset === true,
    `status=${rejoin.status} ok=${rejoinJson?.ok} reason=${rejoinJson?.reason ?? rejoinJson?.error}`,
  );

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
      sync: { autoSync: true, pushOnWrite: false, antiEntropy: { enabled: false, intervalMs: 600000, jitterRatio: 0.2 }, namespaces: [], peerWhitelist: [] },
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
    const gRow = (gSettings.json?.effective ?? []).find((row) => row.path === 'sync.antiEntropy.enabled');
    check(
      'D 三元组：已配置 / 实际 / 未生效原因（服务端计算；待重启项 reason 明确）',
      gRow && 'configured' in gRow && 'actual' in gRow && typeof gRow.reason === 'string'
        && gSettings.json?.effective?.some((row) => /待重启/.test(String(row.reason))),
      `antiEntropy.enabled reason=${gRow?.reason}`,
    );
    check(
      'A 暴露面由 schema 驱动载荷（configSchema 14 editable / statusSchema 10 只读 / relayServers 只在只读面）',
      (gSettings.json?.configSchema ?? []).length === 14 && (gSettings.json?.statusSchema ?? []).length === 10
        && !(gSettings.json?.configSchema ?? []).some((e) => e.path === 'network.libp2p.relayServers')
        && (gSettings.json?.statusSchema ?? []).some((e) => e.path === 'network.libp2p.relayServers'),
      `editable=${(gSettings.json?.configSchema ?? []).length} status=${(gSettings.json?.statusSchema ?? []).length}`,
    );
    // 前台模式：无 lastApply（未发生自动重启）；控制台接线齐备
    check('G 前台模式不产生自动重启记录（lastApply 为空）', !gSettings.json?.lastApply);
    const consoleSrc3 = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    check(
      'G 控制台接线：写入并重启 / 自动重启中 / 已生效 / 已回滚 / 最近一次应用结果（简化轮即时生效）',
      consoleSrc3.includes('确认并重启') && consoleSrc3.includes('正在自动重启使配置生效…')
        && consoleSrc3.includes('已生效') && consoleSrc3.includes('已回滚')
        && consoleSrc3.includes('最近一次应用结果') && consoleSrc3.includes('needsConfirmation'),
    );
  }

  // ---------- 引导态（首次上手）：正常实例不泄漏 provision 接口 + 控制台两入口齐备 ----------
  {
    const provStatus = await getJson(port, '/app/provision/status');
    check('引导接口在正常实例不可用（/app/provision/status 404，不误伤）', provStatus.status === 404, `status=${provStatus.status}`);
    const provCreate = await fetch(`http://127.0.0.1:${port}/app/provision/create`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ confirm: true }),
    });
    check('正常实例 POST /app/provision/create → 404（引导路径不泄漏）', provCreate.status === 404, `status=${provCreate.status}`);
    const consoleSrcOnboard = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    const htmlSrcOnboard = await readFile(join(consoleDir, 'index.html'), 'utf-8');
    check('GUI 首次上手接线：控制台含「建新 / 加入」两入口 + provision 客户端逻辑',
      htmlSrcOnboard.includes('id="provision-create"') && htmlSrcOnboard.includes('id="provision-join"')
        && htmlSrcOnboard.includes('建新忆云') && htmlSrcOnboard.includes('加入已有忆云')
        && consoleSrcOnboard.includes('fetchProvisionStatus') && consoleSrcOnboard.includes('/app/provision/create')
        && consoleSrcOnboard.includes('/app/provision/join') && consoleSrcOnboard.includes('renderProvision'),
      'index.html 两入口 + console.js provision 客户端');
  }

  // ---------- F-ONB-2：引导态建新后的「待重启」UX（前台 vs 服务托管） ----------
  {
    const onboardHome = join(home, 'onboard');
    await mkdir(onboardHome, { recursive: true });
    const onboardHandle = spawnServe({ home: onboardHome, storage: join(onboardHome, 'store.jsonl'), deviceId: 'device-onboard' });
    servers.push(onboardHandle);
    const onboardReady = await waitReady(onboardHandle);
    const obase = `http://127.0.0.1:${onboardReady.port}`;
    const st0 = await (await fetch(`${obase}/app/provision/status`)).json().catch(() => null);
    check('F-ONB-2 空 home：status provisioned=false / restartRequired=false',
      st0?.provision === true && st0?.provisioned === false && st0?.restartRequired === false,
      JSON.stringify({ provision: st0?.provision, provisioned: st0?.provisioned, restartRequired: st0?.restartRequired }));

    const obPage = await fetch(`${obase}/console/`);
    const obHeaders = {
      'content-type': 'application/json',
      'x-mebular-csrf': obPage.headers.get('x-mebular-csrf'),
      cookie: `mebular_csrf=${cookieFrom(obPage)}`,
    };
    const created = await fetch(`${obase}/app/provision/create`, { method: 'POST', headers: obHeaders, body: JSON.stringify({ confirm: true }) });
    const createdJson = await created.json().catch(() => null);
    check('F-ONB-2 前台建新：202 + restarting=false + restart.mode=foreground + 手动命令',
      created.status === 202 && createdJson?.restarting === false && createdJson?.restart?.mode === 'foreground'
        && typeof createdJson?.restart?.command === 'string' && createdJson.restart.command.includes('mebular serve'),
      `status=${created.status} restarting=${createdJson?.restarting} mode=${createdJson?.restart?.mode}`);

    const st1 = await (await fetch(`${obase}/app/provision/status`)).json().catch(() => null);
    check('F-ONB-2 建新后仍是引导态：status provisioned=true/restartRequired=true/restart.mode=foreground，且 note 不再称「家目录为空」',
      st1?.provision === true && st1?.provisioned === true && st1?.restartRequired === true
        && st1?.restarting === false && st1?.restart?.mode === 'foreground'
        && !/家目录为空/.test(st1?.note ?? ''),
      `provisioned=${st1?.provisioned} restartRequired=${st1?.restartRequired} note=${st1?.note}`);

    const dup = await fetch(`${obase}/app/provision/create`, { method: 'POST', headers: obHeaders, body: JSON.stringify({ confirm: true }) });
    const dupJson = await dup.json().catch(() => null);
    check('F-ONB-2 重复建新：409 already_provisioned + restartRequired + restart（结构化，不裸报错）',
      dup.status === 409 && dupJson?.error === 'already_provisioned' && dupJson?.restartRequired === true
        && dupJson?.restart?.mode === 'foreground',
      `status=${dup.status} error=${dupJson?.error}`);

    const consoleSrcOnb2 = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    const htmlSrcOnb2 = await readFile(join(consoleDir, 'index.html'), 'utf-8');
    check('F-ONB-2 前端分流：restarting 判定 + 前台「无法自动重启」+ already_provisioned → 待重启面板 + 复制按钮',
      /res\?\.restarting/.test(consoleSrcOnb2) && /already_provisioned/.test(consoleSrcOnb2)
        && /showProvisionRestart/.test(consoleSrcOnb2) && /无法自动重启/.test(consoleSrcOnb2)
        && htmlSrcOnb2.includes('id="provision-restart"') && htmlSrcOnb2.includes('id="provision-restart-copy"')
        && htmlSrcOnb2.includes('id="provision-restart-command"'),
      'console.js 分流 + index.html 待重启面板');
  }

  // ---------- F-ONB-2：服务托管分支回归（restarting=true；引导态启动 + 写入 config，不触发真实重启） ----------
  {
    const svcHome = join(home, 'onboard-svc');
    await mkdir(svcHome, { recursive: true });
    const svcHandle = spawnServe({
      home: svcHome,
      storage: join(svcHome, 'store.jsonl'),
      deviceId: 'device-onboard-svc',
      env: { MEBULAR_SERVICE_KIND: 'launchd' },
    });
    servers.push(svcHandle);
    const svcReady = await waitReady(svcHandle);
    const sbase = `http://127.0.0.1:${svcReady.port}`;
    // 模拟「建新完成」：写入 config（serve 进程仍处引导态）
    await writeFile(join(svcHome, 'config.json'), JSON.stringify({ deviceId: 'device-onboard-svc', encryption: { level: 'none' } }, null, 2), 'utf-8');
    const sst = await (await fetch(`${sbase}/app/provision/status`)).json().catch(() => null);
    check('F-ONB-2 服务托管分支：status restarting=true + restart.mode=service（回归不破）',
      sst?.provisioned === true && sst?.restartRequired === true && sst?.restarting === true && sst?.restart?.mode === 'service',
      `restarting=${sst?.restarting} mode=${sst?.restart?.mode}`);
  }

  // ---------- H-1：常驻运行 + 连接 AI 助手 ----------
  {
    const h1Home = join(home, 'h1');
    await mkdir(join(h1Home, '.config', 'opencode'), { recursive: true });
    await writeFile(join(h1Home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ theme: 'dark' }, null, 2), 'utf-8');
    await writeFile(join(h1Home, 'config.json'), JSON.stringify({
      storagePath: join(h1Home, 'store.jsonl'),
      deviceId: 'device-h1',
      encryption: { level: 'none' },
      network: { enabled: false },
      sync: { autoSync: false },
      mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none', tls: false } },
    }, null, 2), 'utf-8');
    const h1Handle = spawnServe({ home: h1Home, storage: join(h1Home, 'store.jsonl'), deviceId: 'device-h1', env: { MEBULAR_SERVICE_DRY_RUN: '1' } });
    servers.push(h1Handle);
    const h1Ready = await waitReady(h1Handle);
    const h1Base = `http://127.0.0.1:${h1Ready.port}`;
    const h1Page = await fetch(`${h1Base}/console/`);
    const h1Headers = {
      'content-type': 'application/json',
      'x-mebular-csrf': h1Page.headers.get('x-mebular-csrf'),
      cookie: `mebular_csrf=${cookieFrom(h1Page)}`,
    };

    const svc = await getJson(h1Ready.port, '/admin/api/service');
    check('H-1 读面 /admin/api/service 形状（platform/kind/home/registered/running/autostart）',
      svc.status === 200 && svc.json?.kind === 'mebular-serve' && svc.json?.home === h1Home
        && typeof svc.json?.registered === 'boolean' && typeof svc.json?.running === 'boolean' && 'autostart' in (svc.json ?? {}),
      `kind=${svc.json?.kind} registered=${svc.json?.registered}`);

    const clients = await getJson(h1Ready.port, '/admin/api/clients');
    const ids = (clients.json?.clients ?? []).map((c) => c.id);
    check('H-1 读面 /admin/api/clients 覆盖 7 个客户端（含 OpenChamber 复用 opencode）',
      ['opencode', 'openchamber', 'claude-code', 'claude-desktop', 'cursor', 'dsh', 'generic'].every((x) => ids.includes(x))
        && (clients.json?.clients ?? []).find((c) => c.id === 'openchamber')?.reuseOf === 'opencode',
      ids.join(','));

    const connect = await fetch(`${h1Base}/admin/api/clients/opencode/connect`, { method: 'POST', headers: h1Headers, body: '{}' });
    const connectJson = await connect.json().catch(() => null);
    const ocCfg = JSON.parse(await readFile(join(h1Home, '.config', 'opencode', 'opencode.json'), 'utf-8'));
    check('H-1 接入 opencode：只并 mcp.servers.mebular（remote → 守护 HTTP /mcp）+ 保留 theme + 写前备份（A-17+F-FIX-B 形状）',
      connect.status === 200 && connectJson?.changed === true && Boolean(connectJson?.backupPath)
        && ocCfg.theme === 'dark'
        && ocCfg.mcp?.servers?.mebular?.type === 'remote'
        && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(ocCfg.mcp?.servers?.mebular?.url ?? '')
        && ocCfg.mcp?.mebular === undefined,
      `changed=${connectJson?.changed} backup=${Boolean(connectJson?.backupPath)} url=${ocCfg.mcp?.servers?.mebular?.url}`);

    const again = await fetch(`${h1Base}/admin/api/clients/opencode/connect`, { method: 'POST', headers: h1Headers, body: '{}' });
    const againJson = await again.json().catch(() => null);
    check('H-1 重复接入幂等（changed=false，无新备份）',
      again.status === 200 && againJson?.changed === false && againJson?.backupPath === null,
      `changed=${againJson?.changed}`);

    await mkdir(join(h1Home, '.cursor'), { recursive: true });
    await writeFile(join(h1Home, '.cursor', 'mcp.json'), '{ not json', 'utf-8');
    const bad = await fetch(`${h1Base}/admin/api/clients/cursor/connect`, { method: 'POST', headers: h1Headers, body: '{}' });
    const badJson = await bad.json().catch(() => null);
    check('H-1 解析失败 → 422 needsManual 且**不写**（原文保持）',
      bad.status === 422 && badJson?.needsManual === true
        && (await readFile(join(h1Home, '.cursor', 'mcp.json'), 'utf-8')) === '{ not json',
      `status=${bad.status}`);

    const noCsrf = await fetch(`${h1Base}/admin/api/clients/opencode/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    check('H-1 接入无 CSRF → 403', noCsrf.status === 403, `status=${noCsrf.status}`);

    const svcInstall = await fetch(`${h1Base}/admin/api/service/install`, { method: 'POST', headers: h1Headers, body: '{}' });
    const svcInstallJson = await svcInstall.json().catch(() => null);
    const unitPath = svcInstallJson?.result?.unitPath;
    const unit = unitPath ? await readFile(unitPath, 'utf-8').catch(() => '') : '';
    const unitBase = h1Home.split(/[\\/]/).filter(Boolean).pop();
    const unitOk = process.platform === 'win32'
      ? (unit.includes('WorkingDirectory') && unit.includes(unitBase))
      : (unit.includes('MEBULAR_HOME') && unit.includes(unitBase));
    check('H-1 服务托管（试运行替身）：命令序列 + 单元带守护自身 home',
      svcInstall.status === 200 && svcInstallJson?.dryRun === true
        && Array.isArray(svcInstallJson?.commands) && svcInstallJson.commands.length > 0 && unitOk,
      `commands=${(svcInstallJson?.commands ?? []).length} platform=${process.platform} unitOk=${unitOk}`);

    const jsSrcH1 = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    const htmlSrcH1 = await readFile(join(consoleDir, 'index.html'), 'utf-8');
    const asstSrcH1 = await readFile(join(consoleDir, 'assistants.js'), 'utf-8');
    check('H-1/UX-2 前端接线：设置·AI 助手专区（单列表 + 服务/客户端动作 + diff 预览）+ 别名重定向 + 首屏叠加层',
      !htmlSrcH1.includes('id="connect-view"') && !htmlSrcH1.includes('data-view="connect"')
        && htmlSrcH1.includes('id="status-pill"') && htmlSrcH1.includes('id="attention-card"')
        && jsSrcH1.includes('renderOverlays') && jsSrcH1.includes('data-svc-action')
        && jsSrcH1.includes('data-cli-action') && jsSrcH1.includes('renderSettings(deepLink.openSettings)')
        && asstSrcH1.includes('connect-diff') && asstSrcH1.includes('assistantsPanelHtml'),
      '专区 + 别名 + 叠加层');
  }

  // ---------- 邀请设备（T2 令牌加入） ----------
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

    const readWrite = await fetch(`${base}/admin/api/subscriptions`, {
      method: 'POST',
      headers: { ...bWriteHeaders, authorization: `Bearer ${readToken}` },
      body: JSON.stringify({ namespace: 'notes', active: true }),
    });
    check('bearer：read scope 写 → 403', readWrite.status === 403, `status=${readWrite.status}`);
    const adminWrite = await fetch(`${base}/admin/api/subscriptions`, {
      method: 'POST',
      headers: { ...bWriteHeaders, authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ namespace: 'notes', active: true }),
    });
    check('bearer：admin scope 写 → 200', adminWrite.status === 200, `status=${adminWrite.status}`);

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
    const cliOut = execFileSync(process.execPath, [bin, 'console', '--port', String(port)], { timeout: 30000,
      env: { ...process.env, MEBULAR_HOME: home },
      encoding: 'utf-8',
    });
    check('mebular console 打印控制台 URL', cliOut.includes(`/console`), cliOut.trim().split('\n')[0]);
  } catch (error) {
    check('mebular console 打印控制台 URL', false, String(error?.message ?? error).substring(0, 160));
  }


  // ---------- H2：写端点【端点 ↔ scope ↔ 等价面】一致性（逐端点未授权 403） ----------
  const WRITE_ENDPOINTS = [
    ['POST', '/admin/api/subscriptions'],
    ['POST', '/admin/api/namespaces'],
    ['POST', '/admin/api/devices/device-x/revoke'],
    ['POST', '/admin/api/devices/device-x/restore'],
    ['POST', '/admin/api/devices/device-x/connect'],
    ['POST', '/admin/api/devices/device-x/disconnect'],
    ['POST', '/admin/api/devices/device-x/sync'],
    ['POST', '/admin/api/devices/device-x/reset-watermarks'],
    ['POST', '/admin/api/config'],
    ['POST', '/admin/api/restart'],
    ['POST', '/admin/api/invite'],
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
  const methodGet = await fetch(`http://127.0.0.1:${port}/admin/api/subscriptions`, { headers: writeHeaders });
  check('H3 写端点 GET → 405', methodGet.status === 405, `status=${methodGet.status}`);
  const crossOrigin = await fetch(`http://127.0.0.1:${port}/admin/api/subscriptions`, {
    method: 'POST',
    headers: { ...writeHeaders, origin: 'http://evil.example' },
    body: JSON.stringify({ namespace: 'notes', active: true }),
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
      const roWrite = await fetch(`http://127.0.0.1:${ro.port}/admin/api/subscriptions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mebular-csrf': roCsrf, cookie: `mebular_csrf=${roCookie}` },
        body: JSON.stringify({ namespace: 'notes', active: true }),
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
    try { execFileSync('openssl', ['version'], { stdio: 'ignore', timeout: 15000 }); } catch { openssl = false; }
    if (!openssl) {
      console.log('  - F-C1 有证书 https 可用：SKIP（本机无 openssl）');
    } else {
      const keyPath = join(tlsHome, 'key.pem');
      const certPath = join(tlsHome, 'cert.pem');
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore', timeout: 30000 });
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
    const HOMES = new Set(['common', 'advanced', 'mcp', 'about', 'domains']); // E1：MCP 接入独立 tab；诊断并入高级；订阅域归主页「记忆共享」
    const commonFields = ia.IA_COMMON_FIELDS;
    check(`E1 IA 常用不再有可编辑字段（三卡迁出；实得 ${commonFields.length}）`, commonFields.length === 0, commonFields.join(', '));

    const advancedCardFields = ia.IA_ADVANCED_CARDS.flatMap((card) => card.fields);
    const mcpFields = ia.IA_MCP_CARD.fields;
    const editorFaces = new Set([...ia.IA_COMMON_FIELDS, ...advancedCardFields, ...mcpFields, ...ia.IA_ADVANCED_FIELDS]);
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
    const iaEditable = [...ia.IA_EDITOR_PATHS].sort(); // 全量可编辑面（设置 13 + 记忆共享 1）
    const iaStatusOnly = [...ia.IA_STATUS_ONLY_PATHS].sort();
    const diffSets = (a, b) => [...a.filter((x) => !b.includes(x)), ...b.filter((x) => !a.includes(x))];
    const editableDrift = diffSets(schemaEditable, iaEditable);
    const statusDrift = diffSets(schemaStatusOnly, iaStatusOnly);
    check(`schema↔IA 防漂移：editable 集合逐项一致（各 ${schemaEditable.length}）`,
      schemaEditable.length === 14 && editableDrift.length === 0,
      `schema=${schemaEditable.length} ia=${iaEditable.length} 差异=${editableDrift.join(',') || '无'}`);
    check(`schema↔IA 防漂移：status-only 集合逐项一致（各 ${schemaStatusOnly.length}）`,
      schemaStatusOnly.length === 10 && statusDrift.length === 0,
      `schema=${schemaStatusOnly.length} ia=${iaStatusOnly.length} 差异=${statusDrift.join(',') || '无'}`);
    // B：收敛回归——relayServers 从编辑面消失（status-only）、relayUnlimited 不再渲染（internal）
    const advancedDrift = [...advancedCardFields, ...mcpFields, ...ia.IA_ADVANCED_FIELDS].filter((p) => ['network.libp2p.relayServers', 'network.libp2p.relayUnlimited'].includes(p));
    check('B 暴露面收敛：relayServers 退出编辑面（→只读自动池）/ relayUnlimited 退出 GUI（→internal）',
      ia.IA_ADVANCED_FIELDS.length === 4 && advancedDrift.length === 0
        && schema.exposureOf('network.libp2p.relayServers') === 'status-only'
        && schema.exposureOf('network.libp2p.relayUnlimited') === 'internal'
        && schema.isWritable('network.libp2p.relayServers') === false,
      `advanced=${ia.IA_ADVANCED_FIELDS.length} cards=${advancedCardFields.length} mcp=${mcpFields.length} 残留=${advancedDrift.join(',') || '无'}`);

    const pathsWithoutHome = ia.IA_EDITOR_PATHS.filter((path) => homesOf(path).length !== 1);
    const infoWithoutHome = Object.keys(ia.IA_INFO_BLOCKS).filter((block) => homesOf(block).length !== 1);
    const rendered = new Set([...ia.IA_COMMON_FIELDS, ...advancedCardFields, ...mcpFields, ...ia.IA_ADVANCED_FIELDS]);
    const drifted = ia.IA_EDITOR_PATHS.filter((path) => (ia.IA_MIGRATION[path] === 'common' || ia.IA_MIGRATION[path] === 'advanced' || ia.IA_MIGRATION[path] === 'mcp') !== rendered.has(path));
    const statusWithoutHome = ia.IA_STATUS_ONLY_PATHS.filter((path) => homesOf(path).length !== 1);
    check('IA 不丢项：14 可编辑 path + 10 只读 path + 10 信息块各有且仅有唯一去处（迁移表驱动）',
      ia.IA_EDITOR_PATHS.length === 14 && pathsWithoutHome.length === 0 && infoWithoutHome.length === 0 && drifted.length === 0 && statusWithoutHome.length === 0,
      `editorPaths=${ia.IA_EDITOR_PATHS.length} 只读无去处=${statusWithoutHome.join(',') || '无'} 编辑无去处=${pathsWithoutHome.join(',') || '无'} 信息块无去处=${infoWithoutHome.join(',') || '无'} 编辑面漂移=${drifted.join(',') || '无'}`);

    const cardFields = advancedCardFields;
    check('E1 高级只留「常驻服务」卡（3 字段）；MCP 六项独立成卡（危险）',
      ia.IA_ADVANCED_CARDS.length === 1 && ia.IA_ADVANCED_CARDS[0].id === 'join-service'
        && cardFields.length === 3 && new Set(cardFields).size === 3
        && ia.IA_MCP_CARD.id === 'mcp' && ia.IA_MCP_CARD.danger === true
        && mcpFields.length === 6 && new Set(mcpFields).size === 6
        && ['mcp.http.port', 'mcp.http.auth', 'mcp.http.host', 'mcp.http.tls', 'mcp.http.tlsKey', 'mcp.http.tlsCert'].every((p) => mcpFields.includes(p))
        && cardFields.includes('joinService.enabled') && cardFields.includes('joinService.bind') && cardFields.includes('joinService.port')
        && !cardFields.includes('sync.namespaces') && !cardFields.includes('mcp.http.port'),
      `advancedCards=${ia.IA_ADVANCED_CARDS.length} fields=${cardFields.join(',')} mcp=${mcpFields.join(',')}`);


    const htmlSrc = await readFile(join(consoleDir, 'index.html'), 'utf-8');
    const consoleSrc2 = await readFile(join(consoleDir, 'console.js'), 'utf-8');

    // UX-2 简化轮：内容管理出设置（订阅域归「记忆共享」）；自动策略出 GUI（internal）；即时生效无「保存」按钮
    check('简化轮 · 订阅域归主页「记忆共享」（设置页不渲染）且黑盒自动策略 internal（GUI 不渲染，API 仍可写）',
      ia.IA_MIGRATION['sync.namespaces'] === 'domains'
        && !ia.IA_EDITOR_RENDER_PATHS.includes('sync.namespaces')
        && ia.IA_EDITOR_PATHS.includes('sync.namespaces')
        && ['sync.antiEntropy.intervalMs', 'sync.antiEntropy.jitterRatio', 'sync.snapshotThreshold', 'semantic.minScore']
          .every((p) => schema.exposureOf(p) === 'internal' && schema.isWritable(p) === true)
        && ia.IA_EDITOR_RENDER_PATHS.length === 13,
      `render=${ia.IA_EDITOR_RENDER_PATHS.length} namespacesHome=${ia.IA_MIGRATION['sync.namespaces']}`);
    check('简化轮 · 即时生效（无「保存/撤销」按钮；字段 change 即写入；409 自锁走品牌确认卡）',
      !/data-cfg-action="save"/.test(consoleSrc2) && !/data-cfg-action="reset"/.test(consoleSrc2)
        && consoleSrc2.includes('applyConfigField') && consoleSrc2.includes('submitConfigPatch')
        && consoleSrc2.includes('confirmModal') && consoleSrc2.includes("addEventListener('change'"),
      '草稿机制已退场');
    const tabIds = ia.IA_TABS.map((tab) => tab.id).join(',');
    const tabLabels = ia.IA_TABS.map((tab) => tab.label).join(',');
    check('E1 IA Tab 结构（常用/安全/AI 助手/MCP 接入/高级；诊断并入高级）与「关于本机」入口齐备',
      tabIds === 'common,security,assistants,mcp,advanced' && tabLabels === '常用,安全,AI 助手,MCP 接入,高级'
        && (ia.IA_SETTINGS_EXTRA ?? []).some((item) => item.id === 'about' && item.opens === 'about-modal')
        && htmlSrc.includes('id="self-badge"') && htmlSrc.includes('id="about"') && htmlSrc.includes('关于本机')
        && consoleSrc2.includes('data-settings-tab') && consoleSrc2.includes('IA_ADVANCED_CARDS') && consoleSrc2.includes('IA_MCP_CARD')
        && consoleSrc2.includes('IA_ADVANCED_FIELDS') && consoleSrc2.includes('IA_MIGRATION')
        && consoleSrc2.includes('assistantsPanelHtml') && consoleSrc2.includes("panel('assistants'") && consoleSrc2.includes("panel('mcp'")
        && ia.IA_ADVANCED_ACTIONS.length === 0
        && !consoleSrc2.includes('declare-issuer') && !consoleSrc2.includes('declareIssuer')
        && !htmlSrc.includes('declare-issuer'),
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

  // ---------- 轮 C：设置页三症状 + 呈现分级（弹层壳 / 关闭规范 / 常显-折叠-异常） ----------
  {
    const cssSrc = await readFile(join(consoleDir, 'console.css'), 'utf-8');
    const jsSrc = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    const htmlSrc = await readFile(join(consoleDir, 'index.html'), 'utf-8');
    // E1 断言沿用 consoleSrc2 命名（与本段 jsSrc 同源）
    const consoleSrc2 = jsSrc;

    check('轮 C ① 弹层壳：背板固定不滚 + .modal-box 限高内滚（六处弹层共用）',
      /\.modal \{[^}]*overflow: hidden;[^}]*padding: 24px;/.test(cssSrc)
        && /\.modal-box \{[^}]*max-height: calc\(100vh - 48px\);[^}]*overflow-y: auto;/.test(cssSrc)
        && cssSrc.includes('body.modal-open { overflow: hidden; }'),
      'backdrop fixed / box max-height + overflow-y auto / body 锁滚动');

    check('轮 C ② 弹层关闭规范：Esc ∧ 点空白一处实现；确认弹层=取消、引导态不可关',
      jsSrc.includes("event.key !== 'Escape'")
        && jsSrc.includes("classList.contains('modal')")
        && jsSrc.includes("event.target.classList.contains('modal')")
        && jsSrc.includes('settleConfirmModal(false)')
        && jsSrc.includes("el.id === 'provision'")
        && jsSrc.includes("wizardState.connection === 'connecting'"),
      'Esc/backdrop 全局监听 + 危险语义规则');

    check('轮 C ③ 呈现分级：常态「生效中」/ 异常完整三元组 / 帮助与警告墙折叠',
      jsSrc.includes('data-cfg-state="ok"')
        && jsSrc.includes('✓ 生效中')
        && jsSrc.includes('data-cfg-state="exception"')
        && jsSrc.includes('class="cfg-more"')
        && jsSrc.includes('runtimeFoldedReason')
        && jsSrc.includes('cfg-pending')
        && jsSrc.includes('settingsFoldKey')
        && jsSrc.includes('prevScrollTop')
        && cssSrc.includes('.cfg-more > summary'),
      '名称+控件+状态常显；帮助/机制/警告入 details；异常自动出现');

    check('轮 C 配套：页头内部口径删除、写盘路径/.bak 归「关于本机」、邀请帮助去重、帮助行长收窄',
      !htmlSrc.includes('运行时可用项可直接操作')
        && !jsSrc.includes('修改写入 <code>')
        && jsSrc.includes("copyRowOf('配置文件', configPath)")
        && jsSrc.includes('写盘备份')
        && jsSrc.includes('兑换只建立入网信任')
        && !jsSrc.includes('兑换令牌只建立入网信任')
        && cssSrc.includes('max-width: 62ch'),
      '页头/写盘/邀请/行长四项配套');

    const securitySlotLine = jsSrc.split('\n').find((line) => line.includes('id="settings-security-slot"')) ?? '';
    const commonPanelAt = jsSrc.indexOf("panel('common'");
    const securityPanelAt = jsSrc.indexOf("panel('security'");
    const commonPanelSrc = commonPanelAt >= 0 && securityPanelAt > commonPanelAt
      ? jsSrc.slice(commonPanelAt, securityPanelAt)
      : '';
    check('E1 安全卡落位：设置·安全 tab（安全卡随迁，常用页不再占位）',
      securitySlotLine.includes('<section') && !securitySlotLine.includes('hidden')
        && securitySlotLine.includes('data-settings-slot="security"')
        && securitySlotLine.includes('securityCardHtml()')
        && securityPanelAt > 0
        && jsSrc.slice(securityPanelAt, securityPanelAt + 320).includes('settings-security-slot')
        && commonPanelSrc.length > 0 && !commonPanelSrc.includes('settings-security-slot'),
      '安全卡已接管「安全」页签插槽');

    // E1 · 入口收口：顶栏只留邀请；连接已有地址撤下，传输修复移入诊断/设备卡「连不上」语境
    check('E1 顶栏收口：无「连接已有地址」，仅保留「邀请设备」；空态无旧入口',
      !htmlSrc.includes('id="add-device"') && !htmlSrc.includes('domains-empty-connect')
        && !consoleSrc2.includes("$('#add-device')") && !consoleSrc2.includes("$('#domains-empty-connect')")
        && htmlSrc.includes('id="invite-device"')
        && consoleSrc2.includes('diag-open-wizard') && consoleSrc2.includes('manual-connect'),
      'add-device/空态连接入口已撤下；诊断与设备卡保留手动连接');

    // E2-A2 · 忆云入口：品牌后徽章 + 对称两按钮；加入弹层与卡片接线
    check('E2-A2 顶栏：品牌后 #cloud-badge + 对称「加入忆云 / 邀请设备」',
      /class="brand"[\s\S]{0,160}id="cloud-badge"/.test(htmlSrc)
        && htmlSrc.includes('id="join-cloud"') && htmlSrc.includes('加入忆云')
        && htmlSrc.includes('id="invite-device"') && htmlSrc.includes('邀请设备')
        && !htmlSrc.includes('id="add-device"') && !consoleSrc2.includes("$('#add-device')"),
      '品牌后徽章 + 两枚入口对称；无旧连接入口');
    check('E2-A2 加入弹层：令牌 / 名字 / 指纹预览 / 分步 / 结果面板',
      ['cloud-join-token', 'cloud-join-name', 'cloud-join-inspect', 'cloud-join-steps', 'cloud-join-result', 'cloud-join-submit']
        .every((id) => htmlSrc.includes(`id="${id}"`))
        && consoleSrc2.includes('/admin/api/clouds/inspect')
        && consoleSrc2.includes('/admin/api/clouds/join')
        && /body:\s*\{\s*token,\s*name,\s*confirm:\s*true\s*\}/.test(consoleSrc2)
        && consoleSrc2.includes('正在校验令牌') && consoleSrc2.includes('正在创建忆云')
        && consoleSrc2.includes('mebular cloud use')
        && consoleSrc2.includes('window.mebularDesktop?.cloudSwitch'),
      'inspect 不消费 nonce；join confirm:true；无 App 桥给 CLI 兜底');
    check('E2-A2 忆云卡：设置·常用只读状态之后 / 当前不可切换 / 改名 / 无删除入口',
      consoleSrc2.includes('settings-cloud-card')
        && consoleSrc2.includes('/admin/api/clouds/rename')
        && consoleSrc2.includes('归档保留，不删除')
        && !consoleSrc2.includes('data-cloud-delete')
        && !consoleSrc2.includes('删除忆云')
        && /cloudRowHtml[\s\S]{0,1400}current\s*\?\s*''\s*:\s*`<button[^`]*data-cloud-switch/.test(consoleSrc2)
        && consoleSrc2.indexOf('settings-common-status') < consoleSrc2.indexOf('cloudCardHtml()'),
      '当前项无切换按钮；改名写注册表；无删除');
    check('E2-A2 深链 focus=clouds：常用页滚到忆云卡（纯函数 + 启动接线）',
      (await import('../deep-link.js')).initialViewFromSearch('?view=settings&focus=clouds').focusClouds === true
        && consoleSrc2.includes('deepLink.focusClouds') && consoleSrc2.includes('settings-cloud-card'),
      '?view=settings&focus=clouds → 常用 + 卡片聚焦');
    check('E2-A2 术语：忆云 / 加入忆云 / 邀请设备 / 切换忆云 / 已归档 / 加入令牌；无「档案」「删除忆云」',
      !htmlSrc.includes('档案') && !consoleSrc2.includes('档案') && !consoleSrc2.includes('删除忆云')
        && consoleSrc2.includes('切换忆云') && consoleSrc2.includes('已归档') && consoleSrc2.includes('加入令牌'),
      '用户可见词表零违例');

    // E1 · 邀请单屏：令牌 + 二维码（缺依赖降级）+ 复制在首屏；机制说明收「详情」
    const inviteSrc = (() => {
      const start = consoleSrc2.indexOf('function showInviteResult');
      const end = consoleSrc2.indexOf("$('#invite-device')", start);
      return start >= 0 && end > start ? consoleSrc2.slice(start, end) : '';
    })();
    const inviteDetailsAt = inviteSrc.indexOf('<details');
    check('E1 邀请单屏：首屏令牌 + 二维码/降级 + 复制；端点与命令收「详情」',
      inviteSrc.length > 0
        && inviteDetailsAt > 0
        && inviteSrc.indexOf('令牌（一次性') >= 0 && inviteSrc.indexOf('令牌（一次性') < inviteDetailsAt
        && inviteSrc.indexOf('qrBlock') >= 0 && inviteSrc.indexOf('qrBlock') < inviteDetailsAt
        && inviteSrc.indexOf('二维码不可用') >= 0
        && inviteSrc.indexOf('data-copy=') >= 0
        && /<details[^>]*>\s*<summary>详情/.test(inviteSrc)
        && inviteSrc.slice(inviteDetailsAt).includes('${endpointEditor}'),
      `detailsAt=${inviteDetailsAt}`);

    // E1 · 邀请未启用时就地一键启用（复用设置写路径；不再指路「设置 → 常用」）
    check('E1 邀请未启用：弹层内一键启用并继续（改配置 + 重启提示）',
      consoleSrc2.includes('invite-enable-service')
        && consoleSrc2.includes("fieldOf('joinService.enabled')")
        && consoleSrc2.includes('applyConfigField')
        && /将重启守护/.test(consoleSrc2)
        && !htmlSrc.includes('invite-to-settings'),
      '就地启用按钮 + applyConfigField + 重启提示；旧设置指路已删');
    const stripComments = (src) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    const consoleCode = stripComments(consoleSrc2);
    const htmlCode = htmlSrc.replace(/<!--[\s\S]*?-->/g, '');
    const assistantsCode = stripComments(await readFile(join(consoleDir, 'assistants.js'), 'utf-8'));
    const bannedWords = [['屏', '蔽'].join(''), ['踢', '出'].join(''), ['吊', '销'].join('')];
    check('E1 术语：「忆云 / 移出 / 加入」；禁用词=0（注释除外）',
      !consoleCode.includes('网络') && !htmlCode.includes('网络') && !assistantsCode.includes('网络')
        && bannedWords.every((word) => !consoleCode.includes(word) && !htmlCode.includes(word) && !assistantsCode.includes(word))
        && consoleCode.includes('加入忆云') && consoleCode.includes('移出后')
        && htmlCode.includes('没加入忆云') && htmlCode.includes('移出设备'),
      `console=${(consoleCode.match(/网络/g) ?? []).length} html=${(htmlCode.match(/网络/g) ?? []).length}`);
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
    check('C7 邀请响应提供二维码（qrSvg：SVG 字符串或缺可选依赖时为 null）',
      inviteRes.status === 201 && 'qrSvg' in (inviteJson ?? {}) && (inviteJson?.qrSvg === null || String(inviteJson?.qrSvg).startsWith('<svg')),
      { status: inviteRes.status, qr: inviteJson?.qrSvg === null ? 'null（缺可选依赖）' : 'svg' });
    const consoleSrc6 = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    check('C7 控制台邀请面板渲染二维码与订阅说明',
      ['扫码即通', 'qrSvg', '自行订阅'].every((token) => consoleSrc6.includes(token)));
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

  // ---------- G-ML-1：记忆生命周期（读面默认过滤 + 动作式写端点 + 前端锚点） ----------
  {
    const listDefault = await getJson(port, '/admin/api/memories');
    check('G-ML-1 GET /admin/api/memories 200 + 形状（total/memories/includeArchived/includeDeleted）',
      listDefault.status === 200
        && typeof listDefault.json?.total === 'number'
        && Array.isArray(listDefault.json?.memories)
        && listDefault.json?.includeArchived === false
        && listDefault.json?.includeDeleted === false,
      `total=${listDefault.json?.total} a=${listDefault.json?.includeArchived} d=${listDefault.json?.includeDeleted}`);
    const memId = listDefault.json?.memories?.[0]?.id;
    check('G-ML-1 默认列表返回存活记忆（含 preview/id/type）',
      typeof memId === 'string'
        && listDefault.json.memories.every((m) => typeof m.id === 'string' && typeof m.type === 'string'
          && typeof m.preview === 'string' && m.deleted === false && m.archived === false));

    const memNoCsrf = await fetch(`http://127.0.0.1:${port}/admin/api/memories/${encodeURIComponent(memId)}/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    check('G-ML-1 删除无 CSRF → 403（动作式写需 CSRF）', memNoCsrf.status === 403, `status=${memNoCsrf.status}`);

    const archived = await fetch(`http://127.0.0.1:${port}/admin/api/memories/${encodeURIComponent(memId)}/archive`, {
      method: 'POST',
      headers: writeHeaders,
      body: '{}',
    });
    const archivedJson = await archived.json().catch(() => null);
    check('G-ML-1 归档 → 200 且 archived 含该 id', archived.status === 200 && (archivedJson?.archived ?? []).includes(memId), `status=${archived.status}`);
    const afterArchive = await getJson(port, '/admin/api/memories');
    const withArchived = await getJson(port, '/admin/api/memories?includeArchived=1');
    check('G-ML-1 归档后默认列表不含、includeArchived=1 含且 archived=true',
      afterArchive.json?.memories.some((m) => m.id === memId) === false
        && withArchived.json?.memories.find((m) => m.id === memId)?.archived === true,
      `default=${afterArchive.json?.total} archived=${withArchived.json?.total}`);
    const oneNs = withArchived.json?.memories.find((m) => m.id === memId)?.namespace;
    const nsFiltered = await getJson(port, `/admin/api/memories?includeArchived=1&namespace=${encodeURIComponent(oneNs)}`);
    const nsExcluded = await getJson(port, '/admin/api/memories?includeArchived=1&namespace=__no_such_namespace__');
    check('G-ML-1 按域过滤：命中该域包含目标、未知域为空',
      nsFiltered.json?.memories.some((m) => m.id === memId) === true && nsExcluded.json?.total === 0,
      `ns=${oneNs} hit=${nsFiltered.json?.total} miss=${nsExcluded.json?.total}`);

    const unarchived = await fetch(`http://127.0.0.1:${port}/admin/api/memories/${encodeURIComponent(memId)}/unarchive`, {
      method: 'POST',
      headers: writeHeaders,
      body: '{}',
    });
    const afterUnarchive = await getJson(port, '/admin/api/memories');
    check('G-ML-1 解除归档 → 200 且默认列表恢复含该 id（可逆）',
      unarchived.status === 200 && afterUnarchive.json?.memories.some((m) => m.id === memId) === true);

    const notFound = await fetch(`http://127.0.0.1:${port}/admin/api/memories/missing-id-xyz/archive`, {
      method: 'POST',
      headers: writeHeaders,
      body: '{}',
    });
    check('G-ML-1 归档不存在的 id → 404', notFound.status === 404, `status=${notFound.status}`);

    const deleted = await fetch(`http://127.0.0.1:${port}/admin/api/memories/${encodeURIComponent(memId)}/delete`, {
      method: 'POST',
      headers: writeHeaders,
      body: '{}',
    });
    const deletedJson = await deleted.json().catch(() => null);
    check('G-ML-1 删除 → 200 且 deleted 含该 id', deleted.status === 200 && (deletedJson?.deleted ?? []).includes(memId), `status=${deleted.status}`);
    const afterDelete = await getJson(port, '/admin/api/memories');
    const withDeleted = await getJson(port, '/admin/api/memories?includeDeleted=1');
    check('G-ML-1 删除后默认列表不含、includeDeleted=1 含且 deleted=true',
      afterDelete.json?.memories.some((m) => m.id === memId) === false
        && withDeleted.json?.memories.find((m) => m.id === memId)?.deleted === true,
      `default=${afterDelete.json?.total} deleted=${withDeleted.json?.total}`);

    // 前端锚点：视图/过滤器/动作按钮/解除归档
    const consoleHtml = await readFile(join(consoleDir, 'index.html'), 'utf-8');
    const consoleSrc8 = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    check('G-ML-1 控制台含记忆视图与默认过滤开关（显示已归档 / 显示已删除）',
      ['id="memories-view"', 'data-view="memories"', 'id="mem-filter-archived"', 'id="mem-filter-deleted"'].every((t) => consoleHtml.includes(t))
        && consoleSrc8.includes('memoryFilters') && /includeArchived/.test(consoleSrc8) && /includeDeleted/.test(consoleSrc8));
    check('G-ML-1 控制台含归档 / 解除归档 / 删除动作（动作式，无开关）',
      ['data-mem-action', 'memAction', "'archive'", "'unarchive'", "'delete'"].every((t) => consoleSrc8.includes(t))
        && /归档/.test(consoleHtml) && /解除归档/.test(consoleSrc8));
  }

  // ---------- v4 记忆共享 UI 收口（W1-A）：无审批族 + 术语统一 + mock 数据缺口 ----------
  {
    const consoleSrcV4 = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    const htmlSrcV4 = await readFile(join(consoleDir, 'index.html'), 'utf-8');
    check('v4 UI：域级审批整组删除（无批准/撤回动作与「待你批准」文案；S3 设备会签不属域级审批）',
      !consoleSrcV4.includes('data-approve') && !consoleSrcV4.includes('data-revoke-ns')
        && !consoleSrcV4.includes('handleApprove') && !consoleSrcV4.includes('handleRevokeNamespace')
        && !consoleSrcV4.includes('待你批准') && !consoleSrcV4.includes('撤回')
        && !consoleSrcV4.includes('域级批准'));
    const retiredTokens = ['AUTH →', 'MEMBERS →', '成员制 ACTIVE', '重入恢复', '待重入', '退订交接', '暂无分区', 'HASH ']
      .filter((t) => consoleSrcV4.includes(t) || htmlSrcV4.includes(t));
    check('v4 UI：术语统一（订阅/已订阅/未订阅/也在订阅/退出并交接/状态指纹；退役词清除）',
      consoleSrcV4.includes('记忆域') && consoleSrcV4.includes('未订阅') && consoleSrcV4.includes('也在订阅这个域')
        && consoleSrcV4.includes('退出并交接') && consoleSrcV4.includes('状态指纹')
        && retiredTokens.length === 0,
      `残留=${retiredTokens.join(',') || '无'}`);
    check('v4 UI：mock 数据缺口补齐（memories 字段 + 订阅字段）',
      consoleSrcV4.includes('MOCK_MEMORIES') && /memories:\s*\{ total:/.test(consoleSrcV4)
        && consoleSrcV4.includes('subscriptionDeclared') && consoleSrcV4.includes('subscribers') && consoleSrcV4.includes('selfSubscribed'));
    check('v4 UI：空态重做 + 统计新口径 + 卡尾危险区（scene-1/2 落点）',
      htmlSrcV4.includes('id="domains-empty"') && htmlSrcV4.includes('还没有可以共享的记忆')
        && consoleSrcV4.includes('退出并交接这个域…') && consoleSrcV4.includes('记忆域 ${items.length}')
        && consoleSrcV4.includes('已订阅'));
    check('v4 UI：自动签发入口已删除（无可配置入口）',
      !consoleSrcV4.includes('订阅自动签发') && !consoleSrcV4.includes('auto' + 'GrantRowText')
        && !consoleSrcV4.includes('sync?.auto' + 'Grant?.enabled'));
    check('v4 UI：审计自动签发折叠/自动标记已删除',
      !consoleSrcV4.includes('auditNoteHtml') && !consoleSrcV4.includes('auditIdHtml')
        && !consoleSrcV4.includes('isAutoGrantEvent') && !consoleSrcV4.includes('auditAutoGroupHtml'));
    check('§7 UI：导航序与命名（星图/共享/记忆/审计；data-view 切换契约不变）',
      htmlSrcV4.includes('<span class="view-label">共享</span>')
        && !htmlSrcV4.includes('<span class="view-label">记忆共享</span>')
        && htmlSrcV4.indexOf('data-view="memories"') < htmlSrcV4.indexOf('data-view="audit"'));
    check('v4 UI：记忆过滤 checkbox 有 accessible name（a11y）',
      htmlSrcV4.includes('id="mem-filter-archived" type="checkbox" aria-label="显示已归档"')
        && htmlSrcV4.includes('id="mem-filter-deleted" type="checkbox" aria-label="显示已删除"'));
    check('v4 UI：设备卡 interop 段改订阅事实（它订阅的记忆域 / 订阅情况；无第二套开关）',
      consoleSrcV4.includes('我订阅的记忆域') && consoleSrcV4.includes('它订阅的记忆域') && consoleSrcV4.includes('订阅情况')
        && consoleSrcV4.includes('双方都已订阅') && consoleSrcV4.includes('这个域还没有内容')
        && !consoleSrcV4.includes('data-follow') && !consoleSrcV4.includes('handleFollowToggle'));
    check('v4 UI：窄屏横幅让位 + 面板视图隐藏设备卡空壳（CSS 落点）',
      (await readFile(join(consoleDir, 'console.css'), 'utf-8')).includes('.stage-wrap.has-banner .panel-view')
        && (await readFile(join(consoleDir, 'console.css'), 'utf-8')).includes('.layout.is-panel-view .aside')
        && consoleSrcV4.includes("classList.toggle('is-panel-view'"));
  }

  // ---------- P3 · 收敛健康（阶段 B）：只读 API 汇总 + 控制台锚点 ----------
  {
    const overviewConv = await getJson(port, '/admin/api/overview');
    check('P3 收敛健康：overview 带汇总（守护默认开；无对端时 peers=0）',
      overviewConv.json?.convergence?.summary?.peers === 0
        && typeof overviewConv.json?.convergence?.summary?.ok === 'number',
      JSON.stringify(overviewConv.json?.convergence ?? null));
    const consoleSrcP3 = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    check('P3 收敛健康：控制台锚点（设备卡同步健康 / 关于本机汇总 / SSE convergence / 人话原因）',
      consoleSrcP3.includes('收敛健康') && consoleSrcP3.includes('同步健康')
        && consoleSrcP3.includes('CONVERGENCE_STATE_META') && consoleSrcP3.includes('convergenceChipRows')
        && consoleSrcP3.includes('convergenceAboutSection') && consoleSrcP3.includes("addEventListener('convergence'")
        && consoleSrcP3.includes('状态指纹') && consoleSrcP3.includes('backlog-mismatch'));
  }

  // ---------- S3 · 安全三档（只消费 S2 端点；控制台审计/卡片契约） ----------
  {
    const secRead = await getJson(port, '/admin/api/security');
    check('S3 GET /admin/api/security 200 + 状态形状（level/admitted/rejections/totp/recovery/pending）',
      secRead.status === 200
        && ['low', 'medium', 'high'].includes(secRead.json?.level)
        && Array.isArray(secRead.json?.admitted)
        && Array.isArray(secRead.json?.rejections)
        && typeof secRead.json?.totp?.imported === 'boolean'
        && typeof secRead.json?.recovery?.registered === 'boolean'
        && Array.isArray(secRead.json?.pendingApprovals),
      `level=${secRead.json?.level}`);
    check('S3 GET /admin/api/security 不泄露种子/私钥/恢复码明文',
      !/"secret"\s*:/.test(secRead.text)
        && !/"privateKey"/.test(secRead.text)
        && !/"recoveryCode"\s*:/.test(secRead.text)
        && !/"codeFormatted"\s*:/.test(secRead.text));

    const policySec = await getJson(port, '/admin/api/policy');
    const secTimeline = (policySec.json ?? []).filter((e) => String(e.type).startsWith('security_'));
    check('S3 审计含安全事件（security_tier / security_totp）',
      ['security_tier', 'security_totp'].every((t) => (policySec.json ?? []).some((e) => e.type === t)),
      `types=${[...new Set(secTimeline.map((e) => e.type))].join(',')}`);
    check('S3 审计安全行字段（等级 from→to / fingerprint；valid 口径存在）',
      secTimeline.every((e) => typeof e.valid === 'boolean')
        && secTimeline.filter((e) => e.type === 'security_tier').every((e) => ['low', 'medium', 'high'].includes(e.level))
        && secTimeline.filter((e) => e.type === 'security_totp').every((e) => typeof e.fingerprint === 'string'));

    const req = await fetch(`http://127.0.0.1:${port}/admin/api/security/approvals`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ op: 'kick', target: 'device-peer', note: 'S3 E1' }),
    });
    const reqJson = await req.json().catch(() => null);
    check('S3 会签请求（high 前置流程）201 + approvalId/配对号',
      req.status === 201 && typeof reqJson?.approvalId === 'string' && /^\d{3}-\d{3}$/.test(reqJson?.pairingCode ?? ''),
      `status=${req.status} pairing=${reqJson?.pairingCode}`);
    const pendingRead = await getJson(port, '/admin/api/security');
    check('S3 待批准入口数据可见（pendingApprovals 含刚发起请求）',
      (pendingRead.json?.pendingApprovals ?? []).some((a) => a.approvalId === reqJson?.approvalId));
    const selfApprove = await fetch(`http://127.0.0.1:${port}/admin/api/security/approvals/${encodeURIComponent(reqJson?.approvalId ?? '')}/approve`, {
      method: 'POST',
      headers: writeHeaders,
      body: '{}',
    });
    check('S3 自批被拒（发起设备不能批准自己的动作）→ 403', selfApprove.status === 403, `status=${selfApprove.status}`);
    const selfDeny = await fetch(`http://127.0.0.1:${port}/admin/api/security/approvals/${encodeURIComponent(reqJson?.approvalId ?? '')}/deny`, {
      method: 'POST',
      headers: writeHeaders,
      body: '{}',
    });
    check('S3 自拒同样 403（批准侧只处理他机请求）', selfDeny.status === 403, `status=${selfDeny.status}`);

    const toMedium = await fetch(`http://127.0.0.1:${port}/admin/api/security/tier`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ level: 'medium' }),
    });
    const toMediumJson = await toMedium.json().catch(() => null);
    check('S3 低→中（显式确认，无码）→ 200', toMedium.status === 200 && toMediumJson?.level === 'medium', `status=${toMedium.status}`);
    const mediumState = await getJson(port, '/admin/api/security');
    check('S3 中档离屏状态读取 = medium（GET 不泄密）', mediumState.json?.level === 'medium' && !/"secret"\s*:/.test(mediumState.text));

    const inviteNoCode = await fetch(`http://127.0.0.1:${port}/admin/api/invite`, {
      method: 'POST',
      headers: writeHeaders,
      body: '{}',
    });
    const inviteNoCodeJson = await inviteNoCode.json().catch(() => null);
    check('S3 中档邀请无动态码 → 403 totp_required（可读原因）',
      inviteNoCode.status === 403 && inviteNoCodeJson?.error === 'totp_required',
      `status=${inviteNoCode.status} error=${inviteNoCodeJson?.error}`);
    const tierNoCode = await fetch(`http://127.0.0.1:${port}/admin/api/security/tier`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ level: 'low' }),
    });
    const tierNoCodeJson = await tierNoCode.json().catch(() => null);
    check('S3 中档降级无动态码 → 403 totp_required', tierNoCode.status === 403 && tierNoCodeJson?.error === 'totp_required', `status=${tierNoCode.status}`);

    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const imported = await fetch(`http://127.0.0.1:${port}/admin/api/security/totp/import`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ secret }),
    });
    const importedJson = await imported.json().catch(() => null);
    check('S3 动态码种子导入 → 200 + fingerprint（8 hex）',
      imported.status === 200 && /^[0-9a-f]{8}$/.test(importedJson?.fingerprint ?? ''),
      `status=${imported.status} fp=${importedJson?.fingerprint}`);
    const { totpCodeAt, generateRecoveryCode } = await import('@mebular/fleet');
    const step = Math.floor(Date.now() / 30_000);
    const toLow = await fetch(`http://127.0.0.1:${port}/admin/api/security/tier`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ level: 'low', code: totpCodeAt(secret, step) }),
    });
    const toLowJson = await toLow.json().catch(() => null);
    check('S3 中→低携有效动态码 → 200（本机门槛）', toLow.status === 200 && toLowJson?.level === 'low', `status=${toLow.status}`);

    const toHigh = await fetch(`http://127.0.0.1:${port}/admin/api/security/tier`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ level: 'high' }),
    });
    const toHighJson = await toHigh.json().catch(() => null);
    check('S3 低→高强制生成并一次性返回恢复码（mustAcknowledge）',
      toHigh.status === 200 && toHighJson?.level === 'high'
        && typeof toHighJson?.recoveryCode === 'string'
        && /[0-9A-Z]{4}/.test(toHighJson?.recoveryCodeFormatted ?? '')
        && toHighJson?.mustAcknowledge === true,
      `status=${toHigh.status} keyId=${toHighJson?.recoveryKeyId?.slice(0, 8)}`);
    const highState = await getJson(port, '/admin/api/security');
    check('S3 高挡状态：recovery 已登记 + current=true',
      highState.json?.level === 'high'
        && highState.json?.recovery?.registered === true
        && highState.json?.recovery?.current === true);

    const inviteNoApproval = await fetch(`http://127.0.0.1:${port}/admin/api/invite`, {
      method: 'POST',
      headers: writeHeaders,
      body: '{}',
    });
    const inviteNoApprovalJson = await inviteNoApproval.json().catch(() => null);
    check('S3 高档邀请无会签 → 403 approval_required', inviteNoApproval.status === 403 && inviteNoApprovalJson?.error === 'approval_required', `status=${inviteNoApproval.status}`);
    const downgradeNoProof = await fetch(`http://127.0.0.1:${port}/admin/api/security/tier`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ level: 'medium' }),
    });
    const downgradeNoProofJson = await downgradeNoProof.json().catch(() => null);
    check('S3 高档降档无会签/恢复码 → 403（防降级逃逸）', downgradeNoProof.status === 403 && downgradeNoProofJson?.error === 'approval_required', `status=${downgradeNoProof.status}`);

    // S4：高档恢复码执行通路（移出 / 降档）。码只在请求体出现，任何响应/审计都不得回显。
    const recoveryCode = toHighJson?.recoveryCode;
    const kickWrong = await fetch(`http://127.0.0.1:${port}/admin/api/devices/device-peer/revoke`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ recoveryCode: generateRecoveryCode().code }),
    });
    const kickWrongJson = await kickWrong.json().catch(() => null);
    check('S4 高档移出错恢复码 → 403 recovery_mismatch（可读原因）',
      kickWrong.status === 403 && kickWrongJson?.error === 'recovery_mismatch'
        && !JSON.stringify(kickWrongJson).includes(recoveryCode),
      `status=${kickWrong.status} error=${kickWrongJson?.error}`);
    const kickRecovery = await fetch(`http://127.0.0.1:${port}/admin/api/devices/device-peer/revoke`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ recoveryCode, note: 'S4 E1 recovery kick' }),
    });
    const kickRecoveryJson = await kickRecovery.json().catch(() => null);
    check('S4 高档移出携恢复码 → 200 + breakGlass（审计标注恢复码；响应无码）',
      kickRecovery.status === 200 && kickRecoveryJson?.method === 'breakGlass'
        && kickRecoveryJson?.auditLabel === '恢复码'
        && !JSON.stringify(kickRecoveryJson).includes(recoveryCode),
      `status=${kickRecovery.status} method=${kickRecoveryJson?.method}`);
    const policyAfterKick = await getJson(port, '/admin/api/policy');
    const kickRow = (policyAfterKick.json ?? []).find((e) => e.type === 'device_revoke' && e.subject === 'device-peer');
    check('S4 移出审计行内嵌 breakGlassKeyId（UI 标注恢复码）；审计无码明文',
      typeof kickRow?.breakGlassKeyId === 'string'
        && kickRow.breakGlassKeyId === highState.json?.recovery?.keyId
        && !policyAfterKick.text.includes(recoveryCode),
      `keyId=${kickRow?.breakGlassKeyId?.slice(0, 8)}`);

    const tierWrong = await fetch(`http://127.0.0.1:${port}/admin/api/security/tier`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ level: 'medium', recoveryCode: generateRecoveryCode().code }),
    });
    const tierWrongJson = await tierWrong.json().catch(() => null);
    check('S4 高档降档错恢复码 → 403 recovery_mismatch',
      tierWrong.status === 403 && tierWrongJson?.error === 'recovery_mismatch',
      `status=${tierWrong.status} error=${tierWrongJson?.error}`);
    const tierRecovery = await fetch(`http://127.0.0.1:${port}/admin/api/security/tier`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ level: 'low', recoveryCode, note: 'S4 E1 recovery tier' }),
    });
    const tierRecoveryJson = await tierRecovery.json().catch(() => null);
    check('S4 高档降档携恢复码 → 200 + 写 tier 记录（审计标注恢复码；响应无码）',
      tierRecovery.status === 200 && tierRecoveryJson?.level === 'low'
        && tierRecoveryJson?.method === 'breakGlass' && tierRecoveryJson?.auditLabel === '恢复码'
        && !JSON.stringify(tierRecoveryJson).includes(recoveryCode),
      `status=${tierRecovery.status} level=${tierRecoveryJson?.level}`);
    const policyAfterTier = await getJson(port, '/admin/api/policy');
    const tierRow = (policyAfterTier.json ?? []).find((e) => e.type === 'security_tier' && typeof e.breakGlassKeyId === 'string');
    check('S4 降档审计行内嵌 breakGlassKeyId（UI 标注恢复码）；审计无码明文',
      typeof tierRow?.breakGlassKeyId === 'string'
        && !policyAfterTier.text.includes(recoveryCode),
      `keyId=${tierRow?.breakGlassKeyId?.slice(0, 8)}`);

    const tierNotApplicable = await fetch(`http://127.0.0.1:${port}/admin/api/security/tier`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ level: 'medium', recoveryCode }),
    });
    const tierNotApplicableJson = await tierNotApplicable.json().catch(() => null);
    check('S4 非高档携恢复码 → 409 recovery_not_applicable（不误用码）',
      tierNotApplicable.status === 409 && tierNotApplicableJson?.error === 'recovery_not_applicable',
      `status=${tierNotApplicable.status} error=${tierNotApplicableJson?.error}`);
    const kickNotApplicable = await fetch(`http://127.0.0.1:${port}/admin/api/devices/device-peer/revoke`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ recoveryCode }),
    });
    const kickNotApplicableJson = await kickNotApplicable.json().catch(() => null);
    check('S4 非高档移出携恢复码 → 409 recovery_not_applicable',
      kickNotApplicable.status === 409 && kickNotApplicableJson?.error === 'recovery_not_applicable',
      `status=${kickNotApplicable.status} error=${kickNotApplicableJson?.error}`);
    const backToHigh = await fetch(`http://127.0.0.1:${port}/admin/api/security/tier`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ level: 'high' }),
    });
    const backToHighJson = await backToHigh.json().catch(() => null);
    check('S4 恢复码降档后低→高回到高档（恢复码仍登记，不重复生成）',
      backToHigh.status === 200 && backToHighJson?.level === 'high' && backToHighJson?.recoveryCode === undefined,
      `status=${backToHigh.status} level=${backToHighJson?.level}`);

    const rotate = await fetch(`http://127.0.0.1:${port}/admin/api/security/recovery/rotate`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ oldCode: toHighJson?.recoveryCode }),
    });
    const rotateJson = await rotate.json().catch(() => null);
    check('S3 恢复码轮换 → 200 + 新码一次性 + oldKeyId',
      rotate.status === 200 && typeof rotateJson?.code === 'string' && typeof rotateJson?.oldKeyId === 'string' && rotateJson?.shownOnce === true,
      `status=${rotate.status}`);
    const rotateAgain = await fetch(`http://127.0.0.1:${port}/admin/api/security/recovery/rotate`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ oldCode: toHighJson?.recoveryCode }),
    });
    check('S3 旧恢复码再次轮换 → 403（keyId 不再当前）', rotateAgain.status === 403, `status=${rotateAgain.status}`);

    const showSeed = await fetch(`http://127.0.0.1:${port}/admin/api/security/totp/show`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ code: totpCodeAt(secret, Math.floor(Date.now() / 30_000) + 1) }),
    });
    const showSeedJson = await showSeed.json().catch(() => null);
    check('S3 显示动态码种子需本机码 → 200 + 分组文本/otpauth（QR 可选）',
      showSeed.status === 200
        && (typeof showSeedJson?.groups === 'string' || Array.isArray(showSeedJson?.groups))
        && /^otpauth:\/\/totp\//.test(showSeedJson?.otpauth ?? '')
        && (showSeedJson?.qrSvg === null || typeof showSeedJson?.qrSvg === 'string'),
      `status=${showSeed.status} qr=${typeof showSeedJson?.qrSvg}`);

    const policyFinal = await getJson(port, '/admin/api/policy');
    const finalTypes = new Set((policyFinal.json ?? []).map((e) => e.type));
    check('S3 审计时间线覆盖 security_tier / security_approval / security_recovery / security_totp',
      ['security_tier', 'security_approval', 'security_recovery', 'security_totp'].every((t) => finalTypes.has(t)),
      `types=${[...finalTypes].filter((t) => t.startsWith('security_')).join(',')}`);
    const recoveryRows = (policyFinal.json ?? []).filter((e) => e.type === 'security_recovery');
    check('S3 审计恢复码行含 keyId/mode（轮换后新旧两行）',
      recoveryRows.length >= 2 && recoveryRows.every((e) => typeof e.keyId === 'string' && ['set', 'rotate'].includes(e.mode)));

    // 前端锚点：安全卡 / 三操作改道 / 审计过滤器 / 壳徽章 / a11y 静态契约
    const consoleSrcSec = await readFile(join(consoleDir, 'console.js'), 'utf-8');
    const htmlSec = await readFile(join(consoleDir, 'index.html'), 'utf-8');
    const cssSec = await readFile(join(consoleDir, 'console.css'), 'utf-8');
    check('S3 前端锚点：安全卡（设置·安全 tab），插槽不再隐藏',
      /id="settings-security-slot"/.test(consoleSrcSec) && !/settings-slot[^>]*hidden/.test(consoleSrcSec)
        && /securityCardHtml/.test(consoleSrcSec)
        && /中 · 动态码（防顺手）/.test(consoleSrcSec)
        && /高 · 设备会签/.test(consoleSrcSec)
        && /挡不住拿走整台设备的人/.test(consoleSrcSec));
    check('S3 前端锚点：三操作改道（邀请 medium 码 / high 会签；移出按档位分级；批准侧）',
      /async function openInvite/.test(consoleSrcSec) && /securityCodeModal/.test(consoleSrcSec)
        && /securityStartApproval/.test(consoleSrcSec) && /securityRevokeFlow/.test(consoleSrcSec)
        && /data-security-action/.test(consoleSrcSec) && /pendingApprovals/.test(consoleSrcSec)
        && /配对号一致，批准/.test(consoleSrcSec));
    check('S4 前端锚点：高档移出/降档「用恢复码执行」入口 + 码输入不回显/不落 localStorage',
      /securityRecoveryCodeModal/.test(consoleSrcSec)
        && /data-security-recovery-switch/.test(consoleSrcSec)
        && /securityRevokeViaRecovery/.test(consoleSrcSec)
        && /securityTierViaRecovery/.test(consoleSrcSec)
        && /type="password"/.test(consoleSrcSec)
        && !/recovery[^\n]*localStorage|localStorage[^\n]*recovery/i.test(consoleSrcSec));
    check('S3 前端锚点：顶栏只读徽章 + 星图「需要注意」安全项',
      htmlSec.includes('id="security-badge"') && /🛡 安全：/.test(consoleSrcSec)
        && /动态码种子未导入/.test(await readFile(join(consoleDir, 'assistants.js'), 'utf-8'))
        && /待批准/.test(await readFile(join(consoleDir, 'assistants.js'), 'utf-8')));
    check('S3 前端锚点：审计安全过滤器/标签/拒绝原因映射',
      htmlSec.includes('value="security_tier"') && htmlSec.includes('value="security_approval"')
        && /安全等级变更/.test(consoleSrcSec) && /设备会签/.test(consoleSrcSec)
        && /缺少会签证明/.test(consoleSrcSec));
    check('S3 前端锚点：a11y（配对号 aria-live / 恢复码焦点）+ reduced-motion + 窄屏样式',
      /aria-live="polite"/.test(consoleSrcSec) && /tabindex="-1"/.test(consoleSrcSec)
        && /prefers-reduced-motion/.test(cssSec) && /security-card/.test(cssSec)
        && /@media \(max-width: 900px\)/.test(cssSec));
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
