// verify:onboarding —— GUI 首次上手（引导态 + 建新 + 加入），全程不碰 CLI。
//
//   O1 引导态：空家目录 serve → PROVISION_READY；**不自举 root**（无 user-master-key.json）；
//      admin API 409 provision_required；/mcp 可 initialize（tools/call 待初始化）；/console 首屏含「建新 / 加入」两入口；/app/provision/status 可用
//   O2 建新：POST /app/provision/create → root 主密钥 + config（joinService 开 / mcp 回环）→ 自动重启
//      → 正常态（/admin/api/overview 200、邀请面板可用）；重复调 → 409
//   O3 加入：inviter 签发令牌 → 新空 home POST /app/provision/join → 委派身份（**无主私钥**）+ hints
//      + 本机订阅令牌分区 → 自动重启 → 正常态（doctor --net 正常）
//   O4 错误可读：过期 / 错签 / 端点不可达 → 4xx + 可读原因；重复 provision → 409；非回环 → fail closed；失败不残留半成品
//
// 重启通道复用 A 轮（MEBULAR_SERVICE_KIND + MEBULAR_RESTART_CMD 注入）——与生产同一路径。

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');
const bin = join(rootDir, 'packages', 'mcp', 'bin', 'mebular.mjs');

let pass = 0;
let fail = 0;
const failures = [];
function check(label, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`); }
  else { fail += 1; failures.push(label); console.log(`  ✗ ${label}${detail ? `（${detail}）` : ''}`); }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function spawnServe({ home, port, env = {}, args = [] }) {
  const proc = spawn(process.execPath, [bin, 'serve', '--port', String(port), ...args], {
    env: { ...process.env, MEBULAR_HOME: home, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });
  return { proc, getOut: () => out, getErr: () => err };
}

function waitReady(handle, { timeoutMs = 20000, provision = null } = {}) {
  const pattern = provision === true ? /PROVISION_READY (\{.*\})/ : /SERVE_READY (\{.*\})/;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = handle.getOut().match(pattern);
      if (match) { clearInterval(timer); resolve({ ready: JSON.parse(match[1]), provision: true }); return; }
      const other = handle.getOut().match(provision === true ? /SERVE_READY/ : /PROVISION_READY/);
      if (other) { clearInterval(timer); resolve({ ready: null, provision: provision !== true }); return; }
      if (handle.proc.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`serve 提前退出（exit=${handle.proc.exitCode}）：${handle.getErr().slice(-300)}`));
        return;
      }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`serve 未就绪：${handle.getErr().slice(-300)}`)); }
    }, 100);
  });
}

async function stop(handle) {
  if (!handle?.proc || handle.proc.exitCode !== null || handle.proc.signalCode !== null) return;
  handle.proc.kill('SIGTERM');
  await Promise.race([new Promise((r) => handle.proc.once('exit', r)), sleep(4000)]);
}

async function getJson(port, path, headers = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch (error) {
    return { status: 0, json: null, error: String(error?.message ?? error) };
  }
}

async function csrf(port) {
  const res = await fetch(`http://127.0.0.1:${port}/console/`);
  const raw = (res.headers.getSetCookie?.() ?? []).join('; ') || res.headers.get('set-cookie') || '';
  const token = /mebular_csrf=([^;]+)/.exec(raw)?.[1] ?? '';
  return { token, cookie: `mebular_csrf=${token}` };
}

async function post(port, path, body, { withCsrf = true, timeoutMs = 20000 } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (withCsrf) {
    const t = await csrf(port);
    headers['x-mebular-csrf'] = t.token;
    headers.cookie = t.cookie;
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf-8')); } catch { return null; } };

/**
 * F-UNI-1（同类审计）：轮询 /admin/api/settings 直到 predicate 为真；禁单次读碰运气。
 * 超时返回最后一次观测（断言据此判红），并附等待时长。
 */
async function waitForSettings(port, predicate, { timeoutMs = 20000, pollMs = 300 } = {}) {
  const started = Date.now();
  let attempts = 0;
  let last = null;
  for (;;) {
    attempts += 1;
    const res = await getJson(port, '/admin/api/settings');
    last = res.json ?? null;
    if (last && predicate(last)) return { ok: true, settings: last, waitedMs: Date.now() - started, attempts };
    if (Date.now() - started > timeoutMs) return { ok: false, settings: last, waitedMs: Date.now() - started, attempts };
    await sleep(pollMs);
  }
}
async function main() {
  console.log('Mebular 首次上手验证（verify:onboarding：引导态 / 建新 / 加入 / 错误可读）\n');
  const provision = await import('../packages/mcp/src/provision.mjs');

  // ---------- F-ONB-1：设备名 → deviceId 归一化（去重复 device- 前缀；create/join 同一入口） ----------
  {
    const three = ['TestB', 'device-TestB', 'device-device-TestB'];
    const ids = three.map((name) => provision.deriveDeviceId(name));
    check('F-ONB-1 三种输入归一化到同一 deviceId（TestB / device-TestB / device-device-TestB → device-TestB）',
      ids.every((id) => id === 'device-TestB') && new Set(ids).size === 1,
      three.map((n, i) => `${n}→${ids[i]}`).join(' · '));
    check('F-ONB-1 大小写不敏感 + 连续前缀（DEVICE-TestB / device-device-device-TestB → device-TestB）',
      provision.deriveDeviceId('DEVICE-TestB') === 'device-TestB'
        && provision.deriveDeviceId('device-device-device-TestB') === 'device-TestB',
      `${provision.deriveDeviceId('DEVICE-TestB')} · ${provision.deriveDeviceId('device-device-device-TestB')}`);
    check("F-ONB-1 非法字符/空名边界（MacBook Pro→device-MacBook-Pro；空名→device-local；device / device-→device-local）",
      provision.deriveDeviceId('MacBook Pro') === 'device-MacBook-Pro'
        && provision.deriveDeviceId('') === 'device-local'
        && provision.deriveDeviceId('device') === 'device-local'
        && provision.deriveDeviceId('device-') === 'device-local'
        && provision.deriveDeviceId('device---X') === 'device-X',
      `''→${provision.deriveDeviceId('')} · device→${provision.deriveDeviceId('device')}`);
    check('F-ONB-1 显式 deviceId：以 device- 开头则归一化，自定义 ID 原样保留',
      provision.normalizeExplicitDeviceId('device-device-X') === 'device-X'
        && provision.normalizeExplicitDeviceId('my_custom.id') === 'my_custom.id'
        && provision.normalizeExplicitDeviceId('') === null,
      `device-device-X→${provision.normalizeExplicitDeviceId('device-device-X')} · my_custom.id→${provision.normalizeExplicitDeviceId('my_custom.id')}`);
  }
  const workspace = await mkdtemp(join(tmpdir(), 'mebular-onboard-'));
  const livePids = new Set();
  const track = (h) => { if (h?.proc?.pid) livePids.add(h.proc.pid); return h; };
  const workspaceEnv = {
    MEBULAR_SERVICE_KIND: 'mebular-serve',
    MEBULAR_APPLY_TIMEOUT_MS: '20000',
  };

  // ============================================================ O1 引导态
  const homeA = join(workspace, 'A');
  await mkdir(homeA, { recursive: true });
  const portA = await freePort();
  const a = track(spawnServe({ home: homeA, port: portA, env: workspaceEnv }));
  const readyA = await waitReady(a, { provision: true });
  check('O1 空家目录 serve → 引导态（PROVISION_READY，非 SERVE_READY）', readyA.provision === true, `port=${portA}`);
  check('O1 引导态**不自举 root**（未生成 user-master-key.json / 身份文件 / config.json）',
    !existsSync(join(homeA, 'user-master-key.json'))
      && !existsSync(join(homeA, 'store.jsonl.identity.json'))
      && !existsSync(join(homeA, 'config.json')),
    `files=${(await import('node:fs/promises')).readdir ? (await (await import('node:fs/promises')).readdir(homeA)).join(',') : ''}`);
  const adminWhileProvision = await getJson(portA, '/admin/api/overview');
  check('O1 引导态下 admin API → 409 provision_required',
    adminWhileProvision.status === 409 && adminWhileProvision.json?.error === 'provision_required', `status=${adminWhileProvision.status}`);
  const mcpInitRes = await fetch(`http://127.0.0.1:${portA}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'verify-onboarding', version: '1.0.0' },
      },
    }),
  }).catch(() => null);
  const mcpInit = mcpInitRes ? await mcpInitRes.json().catch(() => null) : null;
  const mcpSessionId = mcpInitRes?.headers.get('mcp-session-id') ?? '';
  const mcpCallRes = mcpSessionId
    ? await fetch(`http://127.0.0.1:${portA}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': mcpSessionId,
        'mcp-protocol-version': String(mcpInit?.result?.protocolVersion ?? '2025-06-18'),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_status', arguments: {} } }),
    }).catch(() => null)
    : null;
  const mcpCall = mcpCallRes ? await mcpCallRes.json().catch(() => null) : null;
  check('O1 引导态下 /mcp 可 initialize（不再 409）',
    mcpInitRes?.status === 200 && mcpInit?.result?.serverInfo?.name === 'mebular',
    `status=${mcpInitRes?.status ?? 0}`);
  check('O1 引导态下 tools/call → 200 + NOT_INITIALIZED 业务错误（无 409/500）',
    mcpCallRes?.status === 200 && mcpCall?.result?.structuredContent?.error?.code === 'NOT_INITIALIZED',
    `status=${mcpCallRes?.status ?? 0} code=${mcpCall?.result?.structuredContent?.error?.code ?? ''}`);
  const statusA = await getJson(portA, '/app/provision/status');
  check('O1 /app/provision/status 可用（含默认设备名 / 家目录 / 引导提示）',
    statusA.status === 200 && statusA.json?.provision === true && typeof statusA.json?.defaultDeviceName === 'string' && /建新|加入/.test(String(statusA.json?.note)),
    `status=${statusA.status}`);
  check('F-ONB-1 status 默认 deviceId 同样走归一化（device-<name>，无重复前缀）',
    statusA.json?.defaultDeviceId === provision.deriveDeviceId(statusA.json?.defaultDeviceName),
    `defaultDeviceId=${statusA.json?.defaultDeviceId}`);
  const consoleHtml = await (await fetch(`http://127.0.0.1:${portA}/console/`)).text();
  check('O1 首屏锁定主控制台含两入口（新建忆云 / 加入忆云）',
    consoleHtml.includes('新建忆云') && consoleHtml.includes('加入忆云')
      && consoleHtml.includes('id="create-cloud"') && consoleHtml.includes('id="join-cloud"')
      && consoleHtml.includes('id="onboard-create"') && consoleHtml.includes('id="onboard-join"'),
    'index.html 锁定壳两入口');

  // 非回环 fail closed（引导态仅 loopback）
  {
    const badHome = join(workspace, 'A-badhost');
    await mkdir(badHome, { recursive: true });
    const bad = spawnServe({ home: badHome, port: portA, args: ['--host', '0.0.0.0'] });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => { bad.proc.kill('SIGKILL'); resolve('timeout'); }, 15000);
      bad.proc.on('exit', (c) => { clearTimeout(timer); resolve(c ?? 0); });
    });
    check('O4 引导态非回环 → fail closed（拒绝启动 + 明确提示）',
      code !== 'timeout' && code !== 0 && /引导态仅允许 loopback/.test(bad.getErr()),
      `exit=${code} err=${bad.getErr().trim().slice(-90)}`);
    await rm(badHome, { recursive: true, force: true });
  }

  // ============================================================ O2 建新
  {
    const pidBefore = a.proc.pid;
    const created = await post(portA, '/app/provision/create', { confirm: true, deviceName: 'Mac-A' });
    const healthAfter = await getJson(portA, '/healthz');
    const provisionAfter = await getJson(portA, '/app/provision/status');
    check('O2 建新 → 200 + initialized:true + phase:READY；同一 PID / 同一端口（不重启）',
      created.status === 200 && created.json?.ok === true && created.json?.initialized === true
        && created.json?.phase === 'READY' && created.json?.restarting === undefined
        && a.proc.pid === pidBefore && a.proc.exitCode === null
        && healthAfter.status === 200 && provisionAfter.status === 404
        && created.json?.ports?.mcp === portA,
      `status=${created.status} pid=${a.proc.pid} port=${created.json?.ports?.mcp}`);
    const cfgA = await readJson(join(homeA, 'config.json'));
    const identityA = await readJson(join(homeA, 'store.jsonl.identity.json'));
    const masterA = await readJson(join(homeA, 'user-master-key.json'));
    check('O2 落盘：root 主密钥（含 privateKeyPkcs8）+ config 开 joinService / mcp 回环 + 身份文件',
      typeof masterA?.privateKeyPkcs8 === 'string'
        && cfgA?.joinService?.enabled === true
        && cfgA?.mcp?.http?.host === '127.0.0.1' && cfgA?.mcp?.http?.auth === 'none'
        && cfgA?.mcp?.http?.port === portA
        && cfgA?.deviceId === undefined && cfgA?.deviceName === undefined
        && identityA?.deviceId === created.json?.deviceId,
      `deviceId=${identityA?.deviceId} joinPort=${cfgA?.joinService?.port}`);
    check('F-ONB-1 建新（普通名 Mac-A）→ deviceId=device-Mac-A（单前缀）',
      identityA?.deviceId === 'device-Mac-A', `deviceId=${identityA?.deviceId}`);
    const repeated = await post(portA, '/app/provision/create', { confirm: true });
    check('O2 重复调 provision → 409 already_provisioned（initialized=true）',
      repeated.status === 409 && repeated.json?.error === 'already_provisioned' && repeated.json?.initialized === true,
      `status=${repeated.status}`);
    const overview = await getJson(portA, '/admin/api/overview');
    check('O2 正常态 admin API 可用（overview 200）', overview.status === 200, `status=${overview.status}`);
    const invite = await post(portA, '/admin/api/invite', { namespace: 'tasks' }, { withCsrf: true });
    check('O2 邀请面板可用（/admin/api/invite → 令牌）',
      (invite.status === 201 || invite.status === 200) && typeof invite.json?.token === 'string' && invite.json.token.length > 0,
      `status=${invite.status}`);
    const s2 = await waitForSettings(portA, (j) => j.identity?.mode === 'root');
    check('O2 设置页数据可用（/admin/api/settings 200 + identity.mode=root）',
      s2.ok,
      s2.ok ? `mode=root 等待=${s2.waitedMs}ms` : `mode=${s2.settings?.identity?.mode ?? 'undefined'} 等待=${s2.waitedMs}ms/${s2.attempts} 次`);
  }

  // ============================================================ O3 加入
  {
    // inviter 令牌（端点 = 本机 join 端口）
    const issueToken = async (namespace = 'tasks') => {
      const t = await csrf(portA);
      const res = await fetch(`http://127.0.0.1:${portA}/admin/api/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mebular-csrf': t.token, cookie: t.cookie },
        body: JSON.stringify({ namespace }),
      });
      const json = await res.json().catch(() => null);
      return { token: json?.token, endpoint: json?.endpoint };
    };
    const token = await issueToken();

    const homeB = join(workspace, 'B');
    await mkdir(homeB, { recursive: true });
    const portB = await freePort();
    const b = track(spawnServe({ home: homeB, port: portB, env: workspaceEnv }));
    await waitReady(b, { provision: true });
    const pidBBefore = b.proc.pid;

    const joined = await post(portB, '/app/provision/join', { confirm: true, deviceName: 'device-Mac-B', token: token.token });
    const healthB = await getJson(portB, '/healthz');
    const provisionB = await getJson(portB, '/app/provision/status');
    check('O3 加入 → 200 + initialized:true + 同一 PID / 端口 + inviter/分区/hints 回报',
      joined.status === 200 && joined.json?.initialized === true && joined.json?.phase === 'READY'
        && b.proc.pid === pidBBefore && b.proc.exitCode === null
        && healthB.status === 200 && provisionB.status === 404
        && joined.json?.inviterDeviceId
        && joined.json?.namespace === 'tasks' && Number(joined.json?.hinted) > 0,
      `status=${joined.status} pid=${b.proc.pid} inviter=${joined.json?.inviterDeviceId} hinted=${joined.json?.hinted}`);
    const cfgB = await readJson(join(homeB, 'config.json'));
    const masterB = await readJson(join(homeB, 'master-key.json'));
    const identityB = await readJson(join(homeB, 'store.jsonl.identity.json'));
    const masterHome = existsSync(join(homeB, 'user-master-key.json')) ? await readJson(join(homeB, 'user-master-key.json')) : null;
    check('F-ONB-1 加入（输入 device-Mac-B）→ deviceId=device-Mac-B（不重复前缀）',
      joined.json?.deviceId === 'device-Mac-B' && identityB?.deviceId === 'device-Mac-B'
        && cfgB?.deviceId === undefined && cfgB?.deviceName === undefined,
      `deviceId=${identityB?.deviceId}`);
    check('O3 委派身份落盘：config.identity.mode=delegated + 主密钥文件**无 privateKeyPkcs8**',
      cfgB?.identity?.mode === 'delegated' && masterB?.publicKey && masterB?.privateKeyPkcs8 === undefined
        && (masterHome === null || masterHome?.privateKeyPkcs8 === undefined),
      `master-key keys=${Object.keys(masterB ?? {}).join(',')}`);
    check('O3 身份文件含委派证书链（device 私钥本地保留，主私钥不在）',
      Boolean(identityB?.certificate) && Array.isArray(identityB?.certificateChain) && identityB.certificateChain.length >= 2,
      `chain=${identityB?.certificateChain?.length}`);
    const hints = await readJson(join(homeB, 'net', 'peers.json'));
    check('O3 inviter 地址 hints 已入地址簿（<home>/net/peers.json）', Boolean(hints) && Object.keys(hints).length > 0, `keys=${Object.keys(hints ?? {}).join(',')}`);
    check('O3 热初始化后 overview 200（无需重启）',
      (await getJson(portB, '/admin/api/overview')).status === 200, `port=${portB}`);
    const s3 = await waitForSettings(portB, (j) => j.identity?.mode === 'delegated');
    const settingsB = s3.settings;
    check('O3 正常态身份为 delegated（控制台显示委派模式）',
      s3.ok,
      s3.ok ? `mode=delegated 等待=${s3.waitedMs}ms` : `mode=${settingsB?.identity?.mode ?? 'undefined'} 等待=${s3.waitedMs}ms/${s3.attempts} 次`);
    // 本机订阅 = 令牌分区（B 自己声明；订阅零门槛）
    const deviceB = identityB?.deviceId ?? joined.json?.deviceId;
    const effective = await getJson(portB, `/app/policy/subscriptions?device=${encodeURIComponent(deviceB)}`);
    check('O3 本机订阅 = 令牌分区（/app/policy/subscriptions 含 tasks）',
      effective.json?.ok === true && (effective.json?.namespaces ?? []).includes('tasks'),
      `namespaces=${JSON.stringify(effective.json?.namespaces)}`);
    // doctor --net（正常态自检）
    let doctorOk = false;
    let doctorOut = '';
    try {
      doctorOut = execFileSync(process.execPath, [bin, 'doctor', '--net'], {
        env: { ...process.env, MEBULAR_HOME: homeB }, timeout: 30000, encoding: 'utf-8',
      });
      doctorOk = true;
    } catch (error) {
      doctorOut = String(error?.stdout ?? error?.message ?? error);
    }
    check('O3 doctor --net 正常（退出 0）', doctorOk, doctorOut.trim().split('\n').slice(0, 2).join(' | ').slice(0, 140));

    // O4：失败不残留半成品 + 可读错误（用第 3 个空 home）
    const homeC = join(workspace, 'C');
    await mkdir(homeC, { recursive: true });
    const portC = await freePort();
    const c = track(spawnServe({ home: homeC, port: portC, env: workspaceEnv }));
    await waitReady(c, { provision: true });
    // 均已使用过（O3）→ 复用同一令牌：应被 one-time 语义拒绝
    const reused = await post(portC, '/app/provision/join', { confirm: true, token: token.token });
    check('O4 已使用的令牌 → 4xx + 可读原因（一次性 nonce）',
      reused.status === 400 && /used|令牌不可用/i.test(String(reused.json?.message)),
      `status=${reused.status} msg=${String(reused.json?.message).slice(0, 70)}`);
    // fresh 令牌（未被消费）用于 错签 / 过期 / 不可达
    const fresh = await issueToken();
    const tampered = (() => {
      const json = JSON.parse(Buffer.from(fresh.token, 'base64').toString('utf-8'));
      json.namespace = 'tampered';
      return Buffer.from(JSON.stringify(json), 'utf-8').toString('base64');
    })();
    const badSign = await post(portC, '/app/provision/join', { confirm: true, token: tampered });
    check('O4 错签令牌 → 4xx + 可读原因（签名不符）',
      badSign.status === 400 && /签名|signature/i.test(String(badSign.json?.message)),
      `status=${badSign.status} msg=${String(badSign.json?.message).slice(0, 80)}`);
    const expired = (() => {
      const json = JSON.parse(Buffer.from(fresh.token, 'base64').toString('utf-8'));
      json.expiresAt = 1;
      return Buffer.from(JSON.stringify(json), 'utf-8').toString('base64');
    })();
    const expiredRes = await post(portC, '/app/provision/join', { confirm: true, token: expired });
    check('O4 过期令牌 → 4xx + 可读原因（提示重新生成）',
      expiredRes.status === 400 && /过期/.test(String(expiredRes.json?.message)), `status=${expiredRes.status}`);
    const unreachable = (() => {
      const json = JSON.parse(Buffer.from(fresh.token, 'base64').toString('utf-8'));
      json.endpoint = 'http://127.0.0.1:1';
      return Buffer.from(JSON.stringify(json), 'utf-8').toString('base64');
    })();
    const unreachableRes = await post(portC, '/app/provision/join', { confirm: true, token: unreachable }, { timeoutMs: 25000 });
    check('O4 端点不可达 → 4xx + 可读原因（确认对方 serve 在跑）',
      unreachableRes.status === 400 && /不可达/.test(String(unreachableRes.json?.message)),
      `status=${unreachableRes.status}`);
    check('O4 失败不残留半成品（仍处于引导态，可重试）',
      !existsSync(join(homeC, 'config.json')) && !existsSync(join(homeC, 'store.jsonl.identity.json')) && !existsSync(join(homeC, 'master-key.json'))
        && (await getJson(portC, '/app/provision/status')).status === 200,
      `files=${(await (await import('node:fs/promises')).readdir(homeC)).filter((f) => !f.startsWith('test-serve') && !f.endsWith('.log')).join(',')}`);
    // 无 CSRF → 403
    const noCsrf = await post(portC, '/app/provision/create', { confirm: true }, { withCsrf: false });
    check('O4 无 CSRF → 403（写操作仍受保护）', noCsrf.status === 403, `status=${noCsrf.status}`);
    // 缺 confirm → 400
    const noConfirm = await post(portC, '/app/provision/create', {});
    check('O4 缺二次确认 → 400 confirmation_required', noConfirm.status === 400, `status=${noConfirm.status}`);
    await stop(c);
    await stop(b);
    await stop(a);
  }

  for (const pid of livePids) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
  await rm(workspace, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? '✓' : '✗'} 首次上手验证${fail === 0 ? '通过' : '失败'}（${pass} 通过 / ${fail} 失败）`);
  if (failures.length > 0) console.log(`失败项：\n- ${failures.join('\n- ')}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main().catch((error) => {
  console.error(`✗ verify:onboarding 异常：${error?.stack ?? error}`);
  process.exit(1);
});
