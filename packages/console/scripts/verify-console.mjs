#!/usr/bin/env node
// 控制台 E1 验证（D1）：
//   起真实 serve（临时 MEBULAR_HOME，预置若干 __policy__ 事件与记忆节点），断言
//   /console 200、静态资源 200、只读 API JSON 结构正确、写端点未授权 403、
//   路径穿越被拒。成功退出码 0，失败非 0。前置：npm run build。
//
// 与 scripts/verify-mcp-http.mjs 同风格：spawn 子进程 + SERVE_READY 等待。

import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

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
  const { Mebular, IdentityManager, MemoryService } = await import('@mebular/core');
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
  await app.shutdown();
  return storagePath;
}

function spawnServe({ home, storage }) {
  const proc = spawn(process.execPath, [bin, 'serve', '--port', '0'], {
    env: {
      ...process.env,
      MEBULAR_HOME: home,
      MEBULAR_STORAGE_PATH: storage,
      MEBULAR_DEVICE_ID: 'device-console',
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

console.log('Mebular 控制台 E1 验证（D1）');
console.log('===============================');

const home = await mkdtemp(join(tmpdir(), 'mebular-console-'));
let handle = null;

try {
  const storage = await seedHome(home);
  handle = spawnServe({ home, storage });
  const ready = await waitReady(handle);
  const port = ready.port;
  check('serve 启动（SERVE_READY）', Number.isInteger(port) && port > 0, `port=${port}`);

  // ---------- 静态托管 ----------
  const index = await fetch(`http://127.0.0.1:${port}/console`);
  const indexText = await index.text();
  check('GET /console 200 + text/html', index.status === 200 && /text\/html/.test(index.headers.get('content-type') ?? ''), `status=${index.status}`);
  check('/console 返回控制台页面', indexText.includes('Mebular 控制台'));
  check('/console 下发 CSRF cookie 与响应头', (index.headers.get('set-cookie') ?? '').includes('mebular_csrf=') && Boolean(index.headers.get('x-mebular-csrf')));

  for (const [file, mime] of [['console.css', 'text/css'], ['console.js', 'text/javascript'], ['starfield.js', 'text/javascript']]) {
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
  await stop(handle);
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
