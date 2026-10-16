#!/usr/bin/env node
// P1·B2 · 键控修复四方向矩阵（沙箱 daemon×daemon；loopback；显式 MEBULAR_HOME/MEBULAR_USER_HOME）
//
// 场景矩阵（每格独立沙箱）：
//   b2a-single / b2a-redial-hex / b2a-redial-device      委派 B 拨 root A（单连接 / 派生 hex 再拨 / deviceId 再拨）
//   a2b-single / a2b-redial-hex                          root A 拨委派 B（单连接 / B 以派生 hex 再拨）
//   pair-single / pair-redial                           委派↔委派（两机同 root 下车，直连；单连接 / 再拨）
//   reconnect-dialer / reconnect-acceptor               重连竞态（拨号侧/被拨侧重启后自动收敛）
//   rogue-second-auth-fails                             对抗：第二连接认证失败（异主同名证书）→ 旧连接继续服务
//
// 每格断言（统一口径）：
//   D1 缺陷向：委派侧写亲签 membership + 记忆 → root 侧事件日志/图/成员表可见（B→A 数据方向）
//   D2 对照向：root 侧写记忆 → 委派侧可见（A→B 数据方向）
//   D3 收敛：两侧在线对端均认证通过（多连接自动收敛为单活）
//
// 前置：npm run build。摘要行 KEYING_MATRIX。可选 PRELOAD=1 注入分层探针（scripts/keying-preload.mjs）。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdentityManager, verifyCertificateChain, hexToBytes, derivePeerIdHex } from '@mebular/core';

const MCP = fileURLToPath(new URL('../packages/mcp/bin/mebular.mjs', import.meta.url));
/** 混合版本抽查：旧版（如 bbc2e13 构建）mcp 入口路径；未设置则混合场景记 skip */
const OLD_MCP = process.env.OLD_MCP ?? null;
const PRELOAD = fileURLToPath(new URL('./keying-preload.mjs', import.meta.url));
const KEEP = process.env.KEEP === '1';
const WITH_PRELOAD = process.env.PRELOAD === '1';
const ONLY = process.env.SCENARIOS ? new Set(process.env.SCENARIOS.split(',')) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, pollMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
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
function readStoreEvents(storePath) {
  if (!existsSync(storePath)) return [];
  const out = [];
  for (const line of readFileSync(storePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const v = rec.value ?? rec;
      if (v && v.id && v.author) {
        out.push({
          id: v.id, author: v.author, type: v.type, ns: v.namespace ?? 'default',
          ...(v.data?.grant ? { subject: v.data.grant.subject, note: v.data.grant.note } : {}),
        });
      }
    } catch { /* 跳过 */ }
  }
  return out;
}

// ---------- 守护进程夹具 ----------

class Daemon {
  constructor(home, label, mcpPath = MCP) {
    this.home = home;
    this.label = label;
    this.mcpPath = mcpPath;
    this.child = null;
    this.out = '';
    this.err = '';
  }
  start() {
    const env = {
      ...process.env,
      MEBULAR_HOME: this.home,
      MEBULAR_USER_HOME: this.home,
      MEBULAR_KEYING_SIDE: this.label,
    };
    if (WITH_PRELOAD) env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import ${PRELOAD}`.trim();
    this.child = spawn(process.execPath, [this.mcpPath, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.out = '';
    this.err = '';
    const logPath = join(this.home, '..', `daemon-${this.label}.log`);
    this.child.stdout.on('data', (d) => { this.out += d; if (KEEP) void appendFile(logPath, d).catch(() => undefined); });
    this.child.stderr.on('data', (d) => { this.err += d; if (KEEP) void appendFile(logPath, d).catch(() => undefined); });
    return waitFor(() => /SERVE_READY/.test(this.out), 20000);
  }
  async stop() {
    if (!this.child) return;
    try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
    this.child = null;
    await sleep(150);
  }
  kill() {
    if (!this.child) return;
    try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
    this.child = null;
  }
  async net(port) {
    return (await getJson(`http://127.0.0.1:${port}/app/network`)).json;
  }
  async overview(port) {
    return (await getJson(`http://127.0.0.1:${port}/admin/api/overview`)).json;
  }
  async connectedPeers(port) {
    return ((await this.overview(port))?.onlinePeers ?? []).filter((p) => p.authenticated);
  }
}

function masterKeyRecord(master, privateKeyPkcs8) {
  return {
    publicKey: Buffer.from(master.publicKey).toString('base64'),
    privateKeyPkcs8,
  };
}

async function bootRoot(ctx, deviceId, { sync = {}, withJoin = true, fixedPorts = true, mcp = MCP } = {}) {
  const home = join(ctx.root, deviceId);
  await mkdir(home, { recursive: true });
  const im = new IdentityManager();
  const master = await im.generateUserMasterKey();
  await writeFile(join(home, 'master-key.json'), JSON.stringify(masterKeyRecord(master, await IdentityManager.exportPrivateKey(master.privateKey)), null, 2), { mode: 0o600 });
  const port = await freePort();
  const joinPort = await freePort();
  const p2pPort = fixedPorts ? await freePort() : 0;
  await writeFile(join(home, 'config.json'), JSON.stringify({
    storagePath: join(home, 'store.jsonl'), deviceId,
    identity: { mode: 'root' },
    encryption: { level: 'none', keyFile: join(home, 'master-key.json') },
    network: { enabled: true, libp2p: { listen: [`/ip4/127.0.0.1/tcp/${p2pPort}`] } },
    sync: {
      autoSync: true, pushOnWrite: true, namespaces: ['tasks'],
      policyIssuers: [deviceId],
      antiEntropy: { enabled: true, intervalMs: 60000, jitterRatio: 0.2 },
      ...sync,
    },
    ...(withJoin ? { joinService: { enabled: true, bind: '127.0.0.1', port: joinPort } } : {}),
    mcp: { http: { host: '127.0.0.1', port, auth: 'none' } },
  }, null, 2), { mode: 0o600 });
  const daemon = new Daemon(home, deviceId, mcp);
  return { home, port, joinPort, master, daemon, hasJoin: join };
}

/** 经守护 join 得委派链后，写 delegated home（不启动） */
async function onboardDelegated(ctx, inviter, deviceId, { peers = [], mcp = MCP } = {}) {
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
      autoSync: true, pushOnWrite: true, namespaces: ['tasks'],
      peerNamespacePolicy: { 'device-A': ['tasks'] },
      policyIssuers: ['device-A'],
      antiEntropy: { enabled: true, intervalMs: 60000, jitterRatio: 0.2 },
    },
    mcp: { http: { host: '127.0.0.1', port, auth: 'none' } },
  }, null, 2), { mode: 0o600 });
  return { home, port, daemon: new Daemon(home, deviceId, mcp) };
}

async function secondDialByKey(port, addr, key, csrfPort) {
  const headers = await csrfHeaders(csrfPort ?? port);
  return post(`http://127.0.0.1:${port}/admin/api/devices/${key}/connect`, { address: addr }, headers);
}

// ---------- 场景骨架 ----------

async function scenarioBase(name, fn) {
  if (ONLY && !ONLY.has(name)) return null;
  const ctx = { root: await mkdtemp(join(tmpdir(), `keying-matrix-${name}-`)) };
  const result = { name, ok: false, detail: {} };
  try {
    await fn(ctx, result);
    result.ok = true;
  } catch (error) {
    result.detail.error = String(error?.message ?? error);
  } finally {
    result.detail.sandbox = ctx.root;
    if (!KEEP) await rm(ctx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  if (KEEP && !result.ok) result.detail.kept = true;
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  [${name}]  ${JSON.stringify(result.detail)}`);
  return result;
}

/** 通用数据断言：delegated 写亲签 membership+记忆 → root 可见；root 写 → delegated 可见。 */
async function assertBothDirections({ delegatedPort, rootPort, delegatedHome, rootHome, label, detail }) {
  const bMember = await post(`http://127.0.0.1:${delegatedPort}/app/policy/member`, { member: 'device-B', namespace: 'tasks', active: true });
  const bNode = await post(`http://127.0.0.1:${delegatedPort}/app/nodes`, { type: 'cluster_note', namespace: 'tasks', content: { text: `from-B-${label}` } });
  const rootSeesB = await waitFor(async () => {
    const r = await getJson(`http://127.0.0.1:${rootPort}/app/nodes?namespace=tasks&limit=50`);
    return (r.json?.nodes ?? []).some((n) => n.content?.text === `from-B-${label}`);
  }, 30000);
  const rootStore = readStoreEvents(join(rootHome, 'store.jsonl'));
  const bStore = readStoreEvents(join(delegatedHome, 'store.jsonl'));
  const bEventIds = bStore.filter((e) => e.author === 'device-B').map((e) => e.id);
  const missing = bEventIds.filter((id) => !rootStore.some((e) => e.id === id));
  const aNode = await post(`http://127.0.0.1:${rootPort}/app/nodes`, { type: 'cluster_note', namespace: 'tasks', content: { text: `from-A-${label}` } });
  const bSeesA = await waitFor(async () => {
    const r = await getJson(`http://127.0.0.1:${delegatedPort}/app/nodes?namespace=tasks&limit=50`);
    return (r.json?.nodes ?? []).some((n) => n.content?.text === `from-A-${label}`);
  }, 30000);
  const membership = await getJson(`http://127.0.0.1:${rootPort}/app/policy/membership?namespace=tasks`);
  detail[`D1_B→A(${label})`] = { rootSeesB, missingBEvents: missing.length, bMemberStatus: bMember.status, bNodeStatus: bNode.status };
  detail[`D2_A→B(${label})`] = { bSeesA, aNodeStatus: aNode.status };
  detail[`D3_membership(${label})`] = membership.json?.members;
  if (!rootSeesB || missing.length > 0) throw new Error(`D1 失败：root 未见 delegated 的亲签记忆（missing=${missing.length}, bAuthored=${bEventIds.length}）`);
  if (!bSeesA) throw new Error('D2 失败：delegated 未见 root 的记忆');
}

async function getRootPreApproved(root, peerDeviceId = 'device-B') {
  // 现实姿态（对齐 verify-daemon-cluster 夹具与控制台"批准"流）：授权 + 双方在册。
  // 说明：M3 成员资格一旦在图上启用（存在成员记录），供给端裁剪链改用"对端成员资格"——
  // 所以 root 自身也必须在册，delegated 侧才会把 tasks 数据发给 root（本门禁与键控无关）。
  await post(`http://127.0.0.1:${root.port}/app/policy/grant`, { subject: peerDeviceId, namespaces: ['tasks'] });
  await post(`http://127.0.0.1:${root.port}/app/policy/member`, { member: 'device-A', namespace: 'tasks', active: true });
  await post(`http://127.0.0.1:${root.port}/app/policy/member`, { member: peerDeviceId, namespace: 'tasks', active: true });
  await waitFor(async () => {
    const m = await getJson(`http://127.0.0.1:${root.port}/app/policy/membership?namespace=tasks`);
    const members = m.json?.members ?? [];
    return members.includes('device-A') && members.includes(peerDeviceId);
  }, 15000);
}

// ---------- 场景实现 ----------

/** b2a：委派 B（启动拨号）↔ root A；可选第二键再拨 */
async function scenarioB2A(ctx, result, { redial } = {}) {
  const root = await bootRoot(ctx, 'device-A', { sync: { peerNamespacePolicy: { 'device-B': ['tasks'] } } });
  await root.daemon.start();
  const aAddr = (await root.daemon.net(root.port))?.multiaddrs?.find((m) => m.includes('/p2p/'));
  const b = await onboardDelegated(ctx, root, 'device-B', { peers: [{ device: 'device-A', addr: aAddr }] });
  await getRootPreApproved(root);
  await b.daemon.start();

  const connected = await waitFor(async () =>
    (await root.daemon.connectedPeers(root.port)).length >= 1 && (await b.daemon.connectedPeers(b.port)).length >= 1, 30000);
  result.detail.connected = connected;
  if (!connected) throw new Error('连接未建立');

  if (redial === 'hex') {
    const bIdentity = JSON.parse(readFileSync(`${join(b.home, 'store.jsonl')}.identity.json`, 'utf-8'));
    const aPubHex = bIdentity.certificateChain?.[1]?.devicePublicKey;
    const key = derivePeerIdHex(hexToBytes(aPubHex));
    const r = await secondDialByKey(b.port, aAddr, key, b.port);
    result.detail.redial = { key: 'derived-hex', status: r.status };
    await waitFor(async () => (await b.daemon.connectedPeers(b.port)).length >= 1, 15000);
  } else if (redial === 'device') {
    const r = await secondDialByKey(b.port, aAddr, 'device-A', b.port);
    result.detail.redial = { key: 'deviceId', status: r.status };
    await waitFor(async () => (await b.daemon.connectedPeers(b.port)).length >= 1, 15000);
  }
  await sleep(1000);

  await assertBothDirections({ delegatedPort: b.port, rootPort: root.port, delegatedHome: b.home, rootHome: root.home, label: redial ?? 'single', detail: result.detail });
  result.detail.rootOnline = (await root.daemon.connectedPeers(root.port)).map((p) => p.deviceId);
  result.detail.delegatedOnline = (await b.daemon.connectedPeers(b.port)).map((p) => p.deviceId);
  await root.daemon.stop(); await b.daemon.stop();
}

/** a2b：root A 启动拨号委派 B（B 无 peers）；可选 B 以派生 hex 反向再拨 */
async function scenarioA2B(ctx, result, { redial } = {}) {
  const root = await bootRoot(ctx, 'device-A', { sync: { peerNamespacePolicy: { 'device-B': ['tasks'] } } });
  await root.daemon.start();
  const b = await onboardDelegated(ctx, root, 'device-B');
  await getRootPreApproved(root);
  await b.daemon.start();
  const bAddr = (await b.daemon.net(b.port))?.multiaddrs?.find((m) => m.includes('/p2p/'));

  // A 以 B 的地址拨号（模拟控制台/发现路径）
  const headers = await csrfHeaders(root.port);
  const dial = await post(`http://127.0.0.1:${root.port}/admin/api/devices/device-B/connect`, { address: bAddr }, headers);
  result.detail.rootDial = { status: dial.status };
  const connected = await waitFor(async () => (await b.daemon.connectedPeers(b.port)).length >= 1, 30000);
  result.detail.connected = connected;
  if (!connected) throw new Error('A→B 连接未建立');

  if (redial === 'hex') {
    const bIdentity = JSON.parse(readFileSync(`${join(b.home, 'store.jsonl')}.identity.json`, 'utf-8'));
    const aPubHex = bIdentity.certificateChain?.[1]?.devicePublicKey;
    const key = derivePeerIdHex(hexToBytes(aPubHex));
    const aAddr = (await root.daemon.net(root.port))?.multiaddrs?.find((m) => m.includes('/p2p/'));
    const r = await secondDialByKey(b.port, aAddr, key, b.port);
    result.detail.redial = { key: 'derived-hex', status: r.status };
    await sleep(1200);
  }
  await sleep(500);
  await assertBothDirections({ delegatedPort: b.port, rootPort: root.port, delegatedHome: b.home, rootHome: root.home, label: `a2b-${redial ?? 'single'}`, detail: result.detail });
  result.detail.rootOnline = (await root.daemon.connectedPeers(root.port)).map((p) => p.deviceId);
  result.detail.delegatedOnline = (await b.daemon.connectedPeers(b.port)).map((p) => p.deviceId);
  await root.daemon.stop(); await b.daemon.stop();
}

/** pair：委派↔委派（同 root 下车，彼此直连；root 只做 join 后下线） */
async function scenarioPair(ctx, result, { redial } = {}) {
  const root = await bootRoot(ctx, 'device-R', { sync: { peerNamespacePolicy: { 'device-B': ['tasks'], 'device-C': ['tasks'] } } });
  await root.daemon.start();
  const b = await onboardDelegated(ctx, root, 'device-B');
  const c = await onboardDelegated(ctx, root, 'device-C');
  // 双方直连策略（onboard 默认只认识邀请方 device-A；此处指向对端 device-C/device-B）
  const patchDelegatedConfig = async (d, peersList, policyFor) => {
    const p = join(d.home, 'config.json');
    const cfg = JSON.parse(readFileSync(p, 'utf-8'));
    if (peersList) cfg.network.peers = peersList;
    cfg.sync.peerNamespacePolicy = { [policyFor]: ['tasks'] };
    cfg.sync.policyIssuers = ['device-R'];
    await writeFile(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  };
  await patchDelegatedConfig(b, null, 'device-C');
  // C 拨 B（C 配置 peers 指向 B）
  await b.daemon.start();
  const bAddr = (await b.daemon.net(b.port))?.multiaddrs?.find((m) => m.includes('/p2p/'));
  await patchDelegatedConfig(c, [{ device: 'device-B', addr: bAddr }], 'device-B');
  await c.daemon.start();
  await root.daemon.stop(); // root 不参与直连数据通路

  const connected = await waitFor(async () =>
    (await b.daemon.connectedPeers(b.port)).length >= 1 && (await c.daemon.connectedPeers(c.port)).length >= 1, 30000);
  result.detail.connected = connected;
  if (!connected) throw new Error('委派↔委派连接未建立');

  if (redial === 'hex') {
    // 第二键形态 = B 的派生 hex（sha256hex(B 设备公钥)；与 mDNS 通告/地址簿 hex 键同形态）
    const bIdentity = JSON.parse(readFileSync(`${join(b.home, 'store.jsonl')}.identity.json`, 'utf-8'));
    const key = derivePeerIdHex(hexToBytes(bIdentity.publicKeyHex));
    const r = await secondDialByKey(c.port, bAddr, key, c.port);
    result.detail.redial = { key: 'derived-hex', status: r.status };
    await sleep(1200);
  }

  // 订阅（成员资格）：双方各自声明在册。
  // 注意：`__policy__` 写入本身不触发 nudge（订阅门禁按对端声明的 namespaces 过滤，
  // 策略事件只在会话中随批送达）。因此先用一次 tasks 写入引发会话，让两份成员记录互见，
  // 再做正式的双向记忆断言（成员门禁届时才放行 tasks 数据）。
  await post(`http://127.0.0.1:${b.port}/app/policy/member`, { member: 'device-B', namespace: 'tasks', active: true });
  await post(`http://127.0.0.1:${c.port}/app/policy/member`, { member: 'device-C', namespace: 'tasks', active: true });
  await post(`http://127.0.0.1:${c.port}/app/nodes`, { type: 'cluster_note', namespace: 'tasks', content: { text: 'pair-trigger' } });
  const membershipsConverged = await waitFor(async () => {
    const mb = await getJson(`http://127.0.0.1:${b.port}/app/policy/membership?namespace=tasks`);
    const mc = await getJson(`http://127.0.0.1:${c.port}/app/policy/membership?namespace=tasks`);
    return (mb.json?.members ?? []).includes('device-C') && (mc.json?.members ?? []).includes('device-B');
  }, 30000);
  result.detail.membershipsConverged = membershipsConverged;
  if (!membershipsConverged) throw new Error('委派↔委派成员资格未收敛（各自声明未互见）');

  // 双向记忆断言
  const nB = await post(`http://127.0.0.1:${b.port}/app/nodes`, { type: 'cluster_note', namespace: 'tasks', content: { text: 'pair-from-B' } });
  const cSeesB = await waitFor(async () => {
    const r = await getJson(`http://127.0.0.1:${c.port}/app/nodes?namespace=tasks&limit=50`);
    return (r.json?.nodes ?? []).some((n) => n.content?.text === 'pair-from-B');
  }, 30000);
  const nC = await post(`http://127.0.0.1:${c.port}/app/nodes`, { type: 'cluster_note', namespace: 'tasks', content: { text: 'pair-from-C' } });
  const bSeesC = await waitFor(async () => {
    const r = await getJson(`http://127.0.0.1:${b.port}/app/nodes?namespace=tasks&limit=50`);
    return (r.json?.nodes ?? []).some((n) => n.content?.text === 'pair-from-C');
  }, 30000);
  result.detail['D1_B→C'] = { cSeesB, status: nB.status };
  result.detail['D2_C→B'] = { bSeesC, status: nC.status };
  if (!cSeesB || !bSeesC) throw new Error('委派↔委派双向断言失败');
  await b.daemon.stop(); await c.daemon.stop();
}

/** 重连竞态：重启拨号侧（B）或 被拨侧（A），断言自愈 + 掉线期间事件回填 */
async function scenarioReconnect(ctx, result, { restart }) {
  const root = await bootRoot(ctx, 'device-A', { sync: { peerNamespacePolicy: { 'device-B': ['tasks'] } } });
  await root.daemon.start();
  const aAddr = (await root.daemon.net(root.port))?.multiaddrs?.find((m) => m.includes('/p2p/'));
  const b = await onboardDelegated(ctx, root, 'device-B', { peers: [{ device: 'device-A', addr: aAddr }] });
  await getRootPreApproved(root);
  await b.daemon.start();
  const connected0 = await waitFor(async () => (await b.daemon.connectedPeers(b.port)).length >= 1, 30000);
  if (!connected0) throw new Error('初始连接未建立');

  let offlineText;
  if (restart === 'acceptor') {
    // 被拨侧重启：A 下线期间 B 写亲签事件（本地成功、远端未确认）→ A 回来重连后应全部回填
    await root.daemon.stop();
    offlineText = 'offline-while-root-down';
    const w = await post(`http://127.0.0.1:${b.port}/app/nodes`, { type: 'cluster_note', namespace: 'tasks', content: { text: offlineText } });
    result.detail.offlineWrite = { side: 'B', status: w.status };
    await root.daemon.start();
    // 重连驱动：真实环境由 mDNS 再发现/控制台触发；沙箱显式走同一条 connect 路径（B 拨 A）
    const aAddr2 = (await root.daemon.net(root.port))?.multiaddrs?.find((m) => m.includes('/p2p/'));
    const headersB = await csrfHeaders(b.port);
    const redial = await post(`http://127.0.0.1:${b.port}/admin/api/devices/device-A/connect`, { address: aAddr2 }, headersB);
    result.detail.redial = { status: redial.status };
  } else {
    // 拨号侧重启：B 下线期间 A 写（A→B 方向）；B 回来后重连并补收
    offlineText = 'offline-while-dialer-down';
    await b.daemon.stop();
    const w = await post(`http://127.0.0.1:${root.port}/app/nodes`, { type: 'cluster_note', namespace: 'tasks', content: { text: offlineText } });
    result.detail.offlineWrite = { side: 'A', status: w.status };
    await b.daemon.start();
  }
  const reconnected = await waitFor(async () =>
    (await root.daemon.connectedPeers(root.port)).length >= 1 && (await b.daemon.connectedPeers(b.port)).length >= 1, 45000);
  result.detail.reconnected = reconnected;
  if (!reconnected) throw new Error('重连后未收敛');

  // 掉线期间的事件在重连后自愈回填
  const healed = await waitFor(async () => {
    if (restart === 'acceptor') {
      const r = await getJson(`http://127.0.0.1:${root.port}/app/nodes?namespace=tasks&limit=50`);
      return (r.json?.nodes ?? []).some((x) => x.content?.text === offlineText);
    }
    const r = await getJson(`http://127.0.0.1:${b.port}/app/nodes?namespace=tasks&limit=50`);
    return (r.json?.nodes ?? []).some((x) => x.content?.text === offlineText);
  }, 45000);
  result.detail['丢件观察'] = { healed };

  // 双向继续可用
  await post(`http://127.0.0.1:${b.port}/app/nodes`, { type: 'cluster_note', namespace: 'tasks', content: { text: 'post-reconnect-from-B' } });
  const liveDelivered = await waitFor(async () => {
    const r = await getJson(`http://127.0.0.1:${root.port}/app/nodes?namespace=tasks&limit=50`);
    return (r.json?.nodes ?? []).some((x) => x.content?.text === 'post-reconnect-from-B');
  }, 30000);
  const bStore = readStoreEvents(join(b.home, 'store.jsonl'));
  const aStore = readStoreEvents(join(root.home, 'store.jsonl'));
  const missing = bStore.filter((e) => e.author === 'device-B').map((e) => e.id).filter((id) => !aStore.some((e) => e.id === id));
  result.detail.liveDelivered = liveDelivered;
  result.detail.missingBEvents = missing.length;
  if (!healed || !liveDelivered || missing.length > 0) {
    throw new Error(`重连后回填不完整（healed=${healed} live=${liveDelivered} missing=${missing.length}）——需回填方案（resetPeerWatermarks）`);
  }
  await root.daemon.stop(); await b.daemon.stop();
}

/** 对抗：同名异主（冒名）第二连接认证失败 → 旧连接继续正常服务 */
async function scenarioRogue(ctx, result) {
  const root = await bootRoot(ctx, 'device-A', { sync: { peerNamespacePolicy: { 'device-B': ['tasks'] } } });
  await root.daemon.start();
  const aAddr = (await root.daemon.net(root.port))?.multiaddrs?.find((m) => m.includes('/p2p/'));
  const b = await onboardDelegated(ctx, root, 'device-B', { peers: [{ device: 'device-A', addr: aAddr }] });
  await getRootPreApproved(root);
  await b.daemon.start();
  const connected0 = await waitFor(async () => (await root.daemon.connectedPeers(root.port)).length >= 1, 30000);
  if (!connected0) throw new Error('初始连接未建立');

  // 冒名者：设备名同为 device-B，但身份/证书来自另一个用户主密钥（root 侧验签必败）
  const rogueHome = join(ctx.root, 'rogue');
  await mkdir(rogueHome, { recursive: true });
  const im = new IdentityManager();
  const rogueMaster = await im.generateUserMasterKey();
  const rogueKey = await im.generateDeviceKey('device-B', 'rogue-B');
  const rogueCert = await im.issueDeviceCertificate('device-B');
  await writeFile(join(rogueHome, 'master-key.json'), JSON.stringify(masterKeyRecord(rogueMaster, await IdentityManager.exportPrivateKey(rogueMaster.privateKey)), null, 2), { mode: 0o600 });
  const roguePort = await freePort();
  await writeFile(`${join(rogueHome, 'store.jsonl')}.identity.json`, JSON.stringify({
    deviceId: 'device-B', deviceName: 'rogue-B', publicKeyHex: Buffer.from(rogueKey.publicKey).toString('hex'),
    certificate: rogueCert, certificateChain: [rogueCert], createdAt: Date.now(),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(rogueKey.privateKey),
  }, null, 2), { mode: 0o600 });
  await writeFile(join(rogueHome, 'user-master-key.json'), JSON.stringify({ publicKey: Buffer.from(rogueMaster.publicKey).toString('base64') }, null, 2), { mode: 0o600 });
  await writeFile(join(rogueHome, 'config.json'), JSON.stringify({
    storagePath: join(rogueHome, 'store.jsonl'), deviceId: 'device-B',
    identity: { mode: 'root' },
    encryption: { level: 'none', keyFile: join(rogueHome, 'master-key.json') },
    network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] }, peers: [{ device: 'device-A', addr: aAddr }] },
    sync: { autoSync: true, pushOnWrite: true, namespaces: ['tasks'], antiEntropy: { enabled: true, intervalMs: 60000 }, peerNamespacePolicy: { 'device-A': ['tasks'] }, policyIssuers: ['device-A'] },
    mcp: { http: { host: '127.0.0.1', port: roguePort, auth: 'none' } },
    // 注意：root 模式需要主私钥；这里给的 master-key.json 是冒名主密钥（root 本地初始化自签）
  }, null, 2), { mode: 0o600 });
  const rogue = new Daemon(rogueHome, 'rogue');
  await rogue.start();
  await sleep(3000); // 让冒名连接尝试并失败

  // root 侧不得出现未认证或同名第二认证对端；对真 B 的连接保持
  const rootPeers = await root.daemon.connectedPeers(root.port);
  result.detail.rootPeers = rootPeers.map((p) => ({ peerId: p.peerId, deviceId: p.deviceId }));
  const rogueAuthed = rootPeers.filter((p) => p.deviceId === 'device-B').length;
  result.detail.rogueAuthedAsB = rogueAuthed;

  // 旧连接继续服务：双向
  await assertBothDirections({ delegatedPort: b.port, rootPort: root.port, delegatedHome: b.home, rootHome: root.home, label: 'rogue', detail: result.detail });
  if (rogueAuthed > 1) throw new Error(`冒名者被错误接纳（device-B 认证对端数=${rogueAuthed}）`);
  await rogue.stop(); await root.daemon.stop(); await b.daemon.stop();
}

// ---------- 混合版本抽查 + #122 主网流程 ----------

/** 混合版本：旧端 ↔ 新端（双拨行为如实记录；不追求旧端完美——对齐 P2·C3 政策） */
async function scenarioMixed(ctx, result, { oldSide }) {
  if (!OLD_MCP) {
    result.detail.skipped = 'OLD_MCP 未设置（旧版构建的 mcp 入口路径）';
    return;
  }
  result.detail.oldMcp = OLD_MCP;
  result.detail.oldSide = oldSide;
  const rootMcp = oldSide === 'root' ? OLD_MCP : MCP;
  const delegatedMcp = oldSide === 'delegated' ? OLD_MCP : MCP;
  const root = await bootRoot(ctx, 'device-A', { sync: { peerNamespacePolicy: { 'device-B': ['tasks'] } }, mcp: rootMcp });
  await root.daemon.start();
  const aAddr = (await root.daemon.net(root.port))?.multiaddrs?.find((m) => m.includes('/p2p/'));
  const b = await onboardDelegated(ctx, root, 'device-B', { peers: [{ device: 'device-A', addr: aAddr }], mcp: delegatedMcp });
  await getRootPreApproved(root);
  await b.daemon.start();
  const connected = await waitFor(async () =>
    (await root.daemon.connectedPeers(root.port)).length >= 1 && (await b.daemon.connectedPeers(b.port)).length >= 1, 30000);
  result.detail.connected = connected;

  // 第二键再拨（hex）：旧端对新端的行为如实记录
  const bIdentity = JSON.parse(readFileSync(`${join(b.home, 'store.jsonl')}.identity.json`, 'utf-8'));
  const aPubHex = bIdentity.certificateChain?.[1]?.devicePublicKey;
  const key = derivePeerIdHex(hexToBytes(aPubHex));
  const redial = await secondDialByKey(b.port, aAddr, key, b.port);
  result.detail.redial = { key: 'derived-hex', status: redial.status };
  await sleep(3000);

  // 方向数据观测（记录，不强制断言——降级表现如实记录）
  try {
    const bStore0 = readStoreEvents(join(b.home, 'store.jsonl'));
    const n = await post(`http://127.0.0.1:${b.port}/app/nodes`, { type: 'cluster_note', namespace: 'tasks', content: { text: 'mixed-from-B' } });
    const rootSeesB = await waitFor(async () => {
      const r = await getJson(`http://127.0.0.1:${root.port}/app/nodes?namespace=tasks&limit=50`);
      return (r.json?.nodes ?? []).some((x) => x.content?.text === 'mixed-from-B');
    }, 20000);
    const a2b = await post(`http://127.0.0.1:${root.port}/app/nodes`, { type: 'cluster_note', namespace: 'tasks', content: { text: 'mixed-from-A' } });
    const bSeesA = await waitFor(async () => {
      const r = await getJson(`http://127.0.0.1:${b.port}/app/nodes?namespace=tasks&limit=50`);
      return (r.json?.nodes ?? []).some((x) => x.content?.text === 'mixed-from-A');
    }, 20000);
    const rootStore = readStoreEvents(join(root.home, 'store.jsonl'));
    const bStore = readStoreEvents(join(b.home, 'store.jsonl'));
    const missing = bStore.filter((e) => e.author === 'device-B').map((e) => e.id).filter((id) => !rootStore.some((e) => e.id === id));
    result.detail.observed = { rootSeesB, bSeesA, missingBEvents: missing.length, bEventsBefore: bStore0.length, statuses: [n.status, a2b.status] };
    result.detail.rootOnline = (await root.daemon.connectedPeers(root.port)).map((p) => p.deviceId);
    result.detail.delegatedOnline = (await b.daemon.connectedPeers(b.port)).map((p) => p.deviceId);
  } catch (error) {
    result.detail.observed = { error: String(error?.message ?? error) };
  }
  // 最低要求：连接建立（混合版本不倒退的连接面）；数据面如实记录
  if (!connected) throw new Error('混合版本连接未建立');
  await root.daemon.stop(); await b.daemon.stop();
}

/** #122 主网流程复验：委派侧订阅（未授权分区）→ 根侧自动签发触发 → 数据到位 */
async function scenarioAutoGrant(ctx, result) {
  const root = await bootRoot(ctx, 'device-A', {
    // root 订阅含 notes（数据通路的前提；授权仍由订阅驱动自动签发）
    sync: { peerNamespacePolicy: { 'device-B': ['tasks'] }, namespaces: ['tasks', 'notes'] },
  });
  await root.daemon.start();
  const aAddr = (await root.daemon.net(root.port))?.multiaddrs?.find((m) => m.includes('/p2p/'));
  const b = await onboardDelegated(ctx, root, 'device-B', { peers: [{ device: 'device-A', addr: aAddr }] });
  await getRootPreApproved(root); // tasks 已批准；'notes' 未授权——订阅驱动自动签发的作用面
  await b.daemon.start();
  const connected = await waitFor(async () => (await b.daemon.connectedPeers(b.port)).length >= 1, 30000);
  result.detail.connected = connected;
  if (!connected) throw new Error('连接未建立');

  // ① 委派侧订阅 notes（亲签 membership）+ 一次 tasks 触发会话（__policy__ 不单独 nudge）
  const member = await post(`http://127.0.0.1:${b.port}/app/policy/member`, { member: 'device-B', namespace: 'notes', active: true });
  await post(`http://127.0.0.1:${b.port}/app/nodes`, { type: 'cluster_note', namespace: 'tasks', content: { text: 'trigger-session' } });

  // ② 根侧应见委派侧亲签的订阅记录（键控修复的核心断言）
  const rootSeesSub = await waitFor(async () => {
    const m = await getJson(`http://127.0.0.1:${root.port}/app/policy/membership?namespace=notes`);
    return m.json?.active === true && (m.json?.members ?? []).includes('device-B');
  }, 30000);
  result.detail.subscriptionVisibleOnRoot = rootSeesSub;
  if (!rootSeesSub) throw new Error('委派侧订阅未在根侧可见（membership 未落根侧图）');

  // ③ 根侧自动签发（sync-completed 去抖 2s + 周期评估）
  const autoGranted = await waitFor(async () => {
    const store = readStoreEvents(join(root.home, 'store.jsonl'));
    return store.some((e) => e.type === 'namespace_grant' && e.author === 'device-A' && String(e.note ?? '').includes('auto-grant'));
  }, 60000, 500);
  const rootStore = readStoreEvents(join(root.home, 'store.jsonl'));
  const grants = rootStore.filter((e) => e.type === 'namespace_grant');
  result.detail.autoGrantVisible = autoGranted;
  result.detail.rootGrants = grants.map((e) => ({ author: e.author, subject: e.subject }));

  // ④ 自动放行后：根侧向委派侧推送 notes 数据到位
  await post(`http://127.0.0.1:${root.port}/app/nodes`, { type: 'cluster_note', namespace: 'notes', content: { text: 'notes-from-root' } });
  const dataArrived = await waitFor(async () => {
    const r = await getJson(`http://127.0.0.1:${b.port}/app/nodes?namespace=notes&limit=50`);
    return (r.json?.nodes ?? []).some((x) => x.content?.text === 'notes-from-root');
  }, 60000, 500);
  result.detail.notesDataArrived = dataArrived;
  if (!autoGranted || !dataArrived) {
    throw new Error(`#122 主网流程未全通（memberStatus=${member.status} autoGrant=${autoGranted} data=${dataArrived}）`);
  }
  await root.daemon.stop(); await b.daemon.stop();
}

// ---------- 运行矩阵 ----------

const SCENARIOS = [
  ['b2a-single', (ctx, r) => scenarioB2A(ctx, r, {})],
  ['b2a-redial-hex', (ctx, r) => scenarioB2A(ctx, r, { redial: 'hex' })],
  ['b2a-redial-device', (ctx, r) => scenarioB2A(ctx, r, { redial: 'device' })],
  ['a2b-single', (ctx, r) => scenarioA2B(ctx, r, {})],
  ['a2b-redial-hex', (ctx, r) => scenarioA2B(ctx, r, { redial: 'hex' })],
  ['pair-single', (ctx, r) => scenarioPair(ctx, r, {})],
  ['pair-redial-hex', (ctx, r) => scenarioPair(ctx, r, { redial: 'hex' })],
  ['reconnect-dialer', (ctx, r) => scenarioReconnect(ctx, r, { restart: 'dialer' })],
  ['reconnect-acceptor', (ctx, r) => scenarioReconnect(ctx, r, { restart: 'acceptor' })],
  ['rogue-second-auth-fails', (ctx, r) => scenarioRogue(ctx, r)],
  ['auto-grant-mainnet-flow', (ctx, r) => scenarioAutoGrant(ctx, r)],
  ['mixed-old-delegated', (ctx, r) => scenarioMixed(ctx, r, { oldSide: 'delegated' })],
  ['mixed-old-root', (ctx, r) => scenarioMixed(ctx, r, { oldSide: 'root' })],
];

const results = [];
for (const [name, fn] of SCENARIOS) {
  const result = await scenarioBase(name, fn);
  if (result) results.push(result);
}
const failed = results.filter((r) => !r.ok).map((r) => r.name);
console.log('== verify:keying:matrix ==');
console.log(`KEYING_MATRIX ${JSON.stringify({ total: results.length, passed: results.length - failed.length, failed, scenarios: results.map((r) => r.name) })}`);
process.exit(failed.length === 0 ? 0 : 1);
