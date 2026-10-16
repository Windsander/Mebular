#!/usr/bin/env node
// P3·B2 · 收敛健康度沙箱验证（daemon×daemon；loopback；显式 MEBULAR_HOME/MEBULAR_USER_HOME）
//
// 场景（每格独立沙箱）：
//   converge-ok          基线：双方收敛 → 各自 convergence.state = ok（状态指纹对账）
//   backlog-red-green    「记账矛盾」死锁（水位污染）：signal=stalled(backlog-mismatch) 且
//                        新记忆不落对端（红）→ 既有「重置水位」动作 → 收敛（绿）
//   auto-probe-heal      同上红样本，但 autoProbe=true（A1 批准项）：自动探测一轮自愈（绿），
//                        probes ≥ 1（无需人工动作）
//
// 断言口径：/admin/api/devices 的 convergence 字段 + /admin/api/overview 汇总 +
//           对端 /app/nodes 实际落图。红→绿两相位在本脚本内先后判定。
//
// 前置：npm run build（脚本跑 dist 产物）。摘要行 CONVERGENCE_HEALTH。KEEP=1 保留沙箱。
// SCENARIOS=converge-ok,backlog-red-green 可只跑指定场景。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, appendFile, readFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdentityManager, verifyCertificateChain, hexToBytes } from '@mebular/core';

const MCP = fileURLToPath(new URL('../packages/mcp/bin/mebular.mjs', import.meta.url));
const KEEP = process.env.KEEP === '1';
const ONLY = process.env.SCENARIOS ? new Set(process.env.SCENARIOS.split(',')) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, pollMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(pollMs);
  }
  return last;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function getJson(url, opts) {
  const res = await fetch(url, opts);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const get = (url) => getJson(url);
const post = (url, body, headers = {}) => getJson(url, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
async function csrfHeaders(port) {
  const pre = await fetch(`http://127.0.0.1:${port}/console/`, { headers: { accept: 'text/html' } });
  const token = pre.headers.get('x-mebular-csrf');
  const cookie = (pre.headers.get('set-cookie') ?? '').split(';')[0];
  await pre.arrayBuffer().catch(() => undefined);
  return token && cookie ? { 'x-mebular-csrf': token, cookie } : {};
}

// ---------- 守护进程夹具 ----------

class Daemon {
  constructor(home, label) {
    this.home = home;
    this.label = label;
    this.child = null;
    this.out = '';
  }
  start() {
    const env = { ...process.env, MEBULAR_HOME: this.home, MEBULAR_USER_HOME: this.home };
    this.child = spawn(process.execPath, [MCP, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.out = '';
    const logPath = join(this.home, '..', `daemon-${this.label}.log`);
    this.child.stdout.on('data', (d) => { this.out += d; if (KEEP) void appendFile(logPath, d).catch(() => undefined); });
    this.child.stderr.on('data', (d) => { this.out += d; if (KEEP) void appendFile(logPath, d).catch(() => undefined); });
    return waitFor(() => /SERVE_READY/.test(this.out), 20000);
  }
  async stop() {
    if (!this.child) return;
    try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
    this.child = null;
    await sleep(150);
  }
}

function masterKeyRecord(master, privateKeyPkcs8) {
  return { publicKey: Buffer.from(master.publicKey).toString('base64'), privateKeyPkcs8 };
}

/** P3 收敛阈值：小窗快评（沙箱）；autoProbe 按场景注入 */
function convergenceConfig(autoProbe) {
  return { enabled: true, evalIntervalMs: 500, quietMs: 100, stallWindowMs: 3000, failStreak: 3, mismatchConfirmations: 2, autoProbe };
}

async function bootRoot(ctx, deviceId, { sync = {}, withJoin = true } = {}) {
  const home = join(ctx.root, deviceId);
  await mkdir(home, { recursive: true });
  const im = new IdentityManager();
  const master = await im.generateUserMasterKey();
  await writeFile(join(home, 'master-key.json'), JSON.stringify(masterKeyRecord(master, await IdentityManager.exportPrivateKey(master.privateKey)), null, 2), { mode: 0o600 });
  const port = await freePort();
  const joinPort = await freePort();
  const p2pPort = await freePort();
  await writeFile(join(home, 'config.json'), JSON.stringify({
    storagePath: join(home, 'store.jsonl'), deviceId,
    identity: { mode: 'root' },
    encryption: { level: 'none', keyFile: join(home, 'master-key.json') },
    network: { enabled: true, libp2p: { listen: [`/ip4/127.0.0.1/tcp/${p2pPort}`] } },
    sync: {
      autoSync: false, // 红样本需要：重连不自动起会话，把触发权交给 anti-entropy/A1
      pushOnWrite: true, namespaces: ['tasks'],
      policyIssuers: [deviceId],
      antiEntropy: { enabled: true, intervalMs: 1500, jitterRatio: 0 },
      ...sync,
    },
    ...(withJoin ? { joinService: { enabled: true, bind: '127.0.0.1', port: joinPort } } : {}),
    mcp: { http: { host: '127.0.0.1', port, auth: 'none' } },
  }, null, 2), { mode: 0o600 });
  const daemon = new Daemon(home, deviceId);
  (ctx.daemons ??= []).push(daemon);
  return { home, port, joinPort, master, daemon };
}

/** 经守护 join 得委派链后，写 delegated home（不启动） */
async function onboardDelegated(ctx, inviter, deviceId, { peers = [], sync = {} } = {}) {
  const invite = await post(`http://127.0.0.1:${inviter.port}/app/join/invite`, { namespace: 'tasks', ttlMs: 120000 });
  const im = new IdentityManager();
  const key = await im.generateDeviceKey(deviceId, deviceId);
  const joined = await getJson(`http://127.0.0.1:${inviter.joinPort}/mebular/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: invite.json.token, deviceId, devicePublicKey: Buffer.from(key.publicKey).toString('hex') }),
  });
  const chain = joined.json?.chain ?? [];
  const masterPubB64 = JSON.parse(readFileSync(join(inviter.home, 'master-key.json'), 'utf-8')).publicKey;
  const chainOk = await verifyCertificateChain(chain, hexToBytes(Buffer.from(masterPubB64, 'base64').toString('hex')), { subjectDeviceId: deviceId });
  if (joined.status !== 200 || chain.length !== 2 || !chainOk) {
    throw new Error(`onboard ${deviceId} 失败：status=${joined.status} chain=${chain.length} chainOk=${chainOk}`);
  }
  const home = join(ctx.root, deviceId);
  await mkdir(home, { recursive: true });
  await writeFile(`${join(home, 'store.jsonl')}.identity.json`, JSON.stringify({
    deviceId, deviceName: deviceId, publicKeyHex: Buffer.from(key.publicKey).toString('hex'),
    certificate: joined.json.certificate, certificateChain: chain, createdAt: Date.now(),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(key.privateKey),
  }, null, 2), { mode: 0o600 });
  await writeFile(join(home, 'user-master-key.json'), JSON.stringify({ publicKey: masterPubB64 }, null, 2), { mode: 0o600 });
  const port = await freePort();
  await writeFile(join(home, 'config.json'), JSON.stringify({
    storagePath: join(home, 'store.jsonl'), deviceId,
    identity: { mode: 'delegated' },
    encryption: { level: 'none', userMasterPublicKeyFile: join(home, 'user-master-key.json') },
    network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] }, ...(peers.length > 0 ? { peers } : {}) },
    sync: {
      autoSync: false,
      pushOnWrite: true, namespaces: ['tasks'],
      peerNamespacePolicy: { 'device-A': ['tasks'] },
      policyIssuers: ['device-A'],
      antiEntropy: { enabled: true, intervalMs: 1500, jitterRatio: 0 },
      ...sync,
    },
    mcp: { http: { host: '127.0.0.1', port, auth: 'none' } },
  }, null, 2), { mode: 0o600 });
  const daemon = new Daemon(home, deviceId);
  (ctx.daemons ??= []).push(daemon);
  return { home, port, daemon };
}

/** A 侧预批准（现实姿态）：授权 + 双方在册（M3 闸门起见本机也须在册） */
async function getRootPreApproved(root, peerDeviceId = 'device-B') {
  await post(`http://127.0.0.1:${root.port}/app/policy/grant`, { subject: peerDeviceId, namespaces: ['tasks'] });
  await post(`http://127.0.0.1:${root.port}/app/policy/member`, { member: 'device-A', namespace: 'tasks', active: true });
  await post(`http://127.0.0.1:${root.port}/app/policy/member`, { member: peerDeviceId, namespace: 'tasks', active: true });
  const ok = await waitFor(async () => {
    const m = await getJson(`http://127.0.0.1:${root.port}/app/policy/membership?namespace=tasks`);
    const members = m.json?.members ?? [];
    return members.includes('device-A') && members.includes(peerDeviceId);
  }, 15000);
  if (!ok) throw new Error('预批准失败：成员未在册');
}

// ---------- P3 帮助函数 ----------

async function deviceEntry(port, deviceId) {
  const r = await get(`http://127.0.0.1:${port}/admin/api/devices`);
  return (Array.isArray(r.json) ? r.json : []).find((d) => d.deviceId === deviceId) ?? null;
}

async function convergenceOf(port, deviceId) {
  const entry = await deviceEntry(port, deviceId);
  return entry?.convergence ?? null;
}

async function nodeTextsPresent(port, marker) {
  const r = await getJson(`http://127.0.0.1:${port}/app/nodes?namespace=tasks&limit=200`);
  return (r.json?.nodes ?? []).some((n) => n.content?.text === marker);
}

/** 污染 A 侧对 B 的水位（模拟历史污染/备份恢复）：pendingById>0 ∧ missingByWatermark=0 的记账矛盾 */
async function polluteWatermark(rootHome, peerDeviceId, authorDeviceId, ns = 'tasks') {
  const file = join(rootHome, 'store.jsonl.sync-state.json');
  if (!existsSync(file)) throw new Error(`sync-state 文件不存在：${file}`);
  const record = JSON.parse(await readFile(file, 'utf-8'));
  record.peerWatermarks = record.peerWatermarks ?? {};
  record.peerWatermarks[peerDeviceId] = record.peerWatermarks[peerDeviceId] ?? {};
  record.peerWatermarks[peerDeviceId][ns] = {
    ...(record.peerWatermarks[peerDeviceId][ns] ?? {}),
    [authorDeviceId]: 9999,
  };
  await writeFile(file, JSON.stringify(record, null, 2), 'utf-8');
  return { file, watermarks: record.peerWatermarks[peerDeviceId] };
}

/** 基线：连接并收敛（A 摘要 ok ≥ 1；返回双方） */
async function setupAndConverge(ctx, result, { autoProbe }) {
  const root = await bootRoot(ctx, 'device-A', {
    sync: { peerNamespacePolicy: { 'device-B': ['tasks'] }, convergence: convergenceConfig(autoProbe) },
  });
  await root.daemon.start();
  const aAddr = (await getJson(`http://127.0.0.1:${root.port}/app/network`)).json?.multiaddrs?.find((m) => m.includes('/p2p/'));
  if (!aAddr) throw new Error('A 无可拨 multiaddr');
  const b = await onboardDelegated(ctx, root, 'device-B', {
    peers: [{ device: 'device-A', addr: aAddr }],
    sync: { convergence: convergenceConfig(autoProbe) },
  });
  await getRootPreApproved(root);
  await b.daemon.start();

  const connected = await waitFor(async () => {
    const o = await getJson(`http://127.0.0.1:${root.port}/admin/api/overview`);
    return (o.json?.onlinePeers ?? []).length >= 1;
  }, 30000);
  if (!connected) throw new Error('A↔B 连接未建立');

  // 种一条基线记忆：让对端在 tasks 域确有数据（hello 会带该域的水位——
  // R2 向下修正只对 hello 申报的域生效；空域样本另行由「红相位」展示）。
  const baseMarker = `convergence-base-${Date.now().toString(36)}`;
  await post(`http://127.0.0.1:${root.port}/app/nodes`, {
    type: 'convergence_note', namespace: 'tasks', content: { text: baseMarker },
  });
  const baseArrived = await waitFor(() => nodeTextsPresent(b.port, baseMarker), 20000, 300);
  result.detail.baseMarkerArrived = baseArrived;
  if (!baseArrived) throw new Error('基线记忆未到达 B（同步触发异常？）');

  const baseline = await waitFor(async () => {
    const conv = await convergenceOf(root.port, 'device-B');
    return conv?.state === 'ok' ? conv : null;
  }, 30000, 300);
  result.detail.baselineState = baseline?.state ?? null;
  if (!baseline) throw new Error('基线未收敛（convergence.state != ok）');
  const overview = await getJson(`http://127.0.0.1:${root.port}/admin/api/overview`);
  result.detail.baselineSummary = overview.json?.convergence?.summary ?? null;
  if (!(overview.json?.convergence?.summary?.ok >= 1)) {
    throw new Error(`基线汇总口径异常：${JSON.stringify(overview.json?.convergence ?? null)}`);
  }
  return { root, b, aAddr };
}

/** 红相位：停 B → A 写 marker → 停 A → 污染水位 → 重启 A、B（autoSync=false：无会话触发） */
async function enterStuckState(ctx, result, { root, b }) {
  const marker = `convergence-stuck-${Date.now().toString(36)}`;
  await b.daemon.stop();
  const write = await post(`http://127.0.0.1:${root.port}/app/nodes`, {
    type: 'convergence_note', namespace: 'tasks', content: { text: marker },
  });
  if (write.status >= 400) throw new Error(`A 写 marker 失败：${write.status}`);
  await root.daemon.stop();
  const polluted = await polluteWatermark(root.home, 'device-B', 'device-A');
  result.detail.polluted = polluted.watermarks;
  await root.daemon.start();
  await b.daemon.start();
  const reconnected = await waitFor(async () => {
    const o = await getJson(`http://127.0.0.1:${root.port}/admin/api/overview`);
    return (o.json?.onlinePeers ?? []).length >= 1;
  }, 30000);
  if (!reconnected) throw new Error('红相位：A↔B 未重连');
  return marker;
}

// ---------- 场景 ----------

async function scenarioConvergeOk(ctx, result) {
  const { root, b } = await setupAndConverge(ctx, result, { autoProbe: true });
  const aSide = await convergenceOf(root.port, 'device-B');
  const bSide = await waitFor(async () => {
    const conv = await convergenceOf(b.port, 'device-A');
    return conv?.state === 'ok' ? conv : null;
  }, 15000, 300);
  result.detail.aSide = aSide ? { state: aSide.state, reasons: aSide.reasons } : null;
  result.detail.bSide = bSide ? { state: bSide.state } : await convergenceOf(b.port, 'device-A');
  if (aSide?.state !== 'ok') throw new Error(`A 视角未收敛：${aSide?.state}`);
  if (!bSide) throw new Error(`B 视角未收敛：${JSON.stringify(result.detail.bSide)}`);
}

async function scenarioBacklogRedGreen(ctx, result) {
  const { root, b } = await setupAndConverge(ctx, result, { autoProbe: false });
  const marker = await enterStuckState(ctx, result, { root, b });

  // 红：停滞可见（backlog-mismatch）+ marker 未到达 B（autoProbe=false 无自动修复）
  const red = await waitFor(async () => {
    const conv = await convergenceOf(root.port, 'device-B');
    if (conv?.state !== 'stalled') return null;
    return conv;
  }, 20000, 300);
  result.detail.redState = red ? { state: red.state, reasons: red.reasons, probes: red.probes } : null;
  if (!red) throw new Error('红相位失败：convergence.state 未变为 stalled');
  if (!(red.reasons ?? []).some((r) => r.code === 'backlog-mismatch')) {
    throw new Error(`红相位失败：缺少 backlog-mismatch 原因（${JSON.stringify(red.reasons)}）`);
  }
  const leaked = await nodeTextsPresent(b.port, marker);
  result.detail.markerOnBWhileStuck = leaked;
  if (leaked) throw new Error('红相位失败：marker 意外已落 B（污染未生效？）');
  if (red.probes > 0) throw new Error('红相位失败：autoProbe=false 仍触发了探测');

  // 绿（既有「重置水位」动作）：缺失判定恢复 → anti-entropy 送达 → 收敛
  const headers = await csrfHeaders(root.port);
  const reset = await post(`http://127.0.0.1:${root.port}/admin/api/devices/device-B/reset-watermarks`, {}, headers);
  if (reset.status >= 400) throw new Error(`重置水位失败：${reset.status} ${JSON.stringify(reset.json)}`);
  const healed = await waitFor(async () => {
    const conv = await convergenceOf(root.port, 'device-B');
    if (conv?.state !== 'ok') return null;
    return conv;
  }, 30000, 300);
  result.detail.healedState = healed?.state ?? null;
  const arrived = await waitFor(() => nodeTextsPresent(b.port, marker), 15000, 300);
  result.detail.markerOnBAfterHeal = arrived;
  if (!healed) throw new Error('绿相位失败：重置水位后未回到 ok');
  if (!arrived) throw new Error('绿相位失败：marker 未落 B');
}

async function scenarioAutoProbeHeal(ctx, result) {
  const { root, b } = await setupAndConverge(ctx, result, { autoProbe: true });
  const marker = await enterStuckState(ctx, result, { root, b });

  // A1 自动探测（限频）→ 会话 → hello 自报触发 R2 向下修正 → marker 送达 → 收敛
  let maxProbes = 0;
  const healed = await waitFor(async () => {
    const conv = await convergenceOf(root.port, 'device-B');
    if (conv) maxProbes = Math.max(maxProbes, conv.probes ?? 0);
    if ((conv?.probes ?? 0) >= 1 && conv?.state === 'ok') return conv;
    return null;
  }, 30000, 250);
  result.detail.healedState = healed?.state ?? null;
  result.detail.probes = maxProbes;
  const arrived = await waitFor(() => nodeTextsPresent(b.port, marker), 15000, 300);
  result.detail.markerOnB = arrived;
  if (!healed) throw new Error(`A1 自愈失败：state=${healed?.state ?? 'n/a'} probes=${maxProbes}`);
  if (maxProbes < 1) throw new Error('A1 自愈失败：探测计数为 0');
  if (!arrived) throw new Error('A1 自愈失败：marker 未落 B');
}

// ---------- 运行器 ----------

const SCENARIOS = [
  ['converge-ok', scenarioConvergeOk],
  ['backlog-red-green', scenarioBacklogRedGreen],
  ['auto-probe-heal', scenarioAutoProbeHeal],
];

const results = [];
for (const [name, fn] of SCENARIOS) {
  if (ONLY && !ONLY.has(name)) continue;
  const ctx = { root: await mkdtemp(join(tmpdir(), `convergence-${name}-`)) };
  const result = { name, ok: false, detail: {} };
  try {
    await fn(ctx, result);
    result.ok = true;
  } catch (error) {
    result.detail.error = String(error?.message ?? error);
  } finally {
    for (const daemon of ctx.daemons ?? []) await daemon.stop();
    await sleep(150);
    if (!KEEP) await rm(ctx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    else result.detail.sandbox = ctx.root;
  }
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  [${name}]  ${JSON.stringify(result.detail)}`);
  results.push(result);
}

const passed = results.filter((r) => r.ok).length;
console.log(`CONVERGENCE_HEALTH ${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
