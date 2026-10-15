#!/usr/bin/env node
// 守护层自动签发（订阅驱动授权）真机对抗验收：真实守护（供给端，dist 全栈）× in-process 订阅端。
//
// 四项（批准版提案 ④）：
//   ①【红线·第一优先】屏蔽(revokeDevice) → 订阅(membership 落图) → 仍被拒：
//     零自动签发、吊销保持、屏蔽后新数据不到达；
//   ② 订阅 → 自动放行 → 数据到位（note='auto-grant' 留证 + 幂等：记录恰一条）；
//   ③ kill-switch：sync.autoGrant.enabled=false → 回默认拒绝（CLI 兜底可用）；
//   ④ 混合版本走查：老订阅端（只 hello、不写 membership）→ 中性态 + CLI 兜底；
//     老供给端行为 ≍ 开关关闭（同一断言面）。
//
// 形态说明（重要）：订阅端用 **in-process Mebular 门面**（真 libp2p / 真签名 / 真存储）拨守护。
//   不跑 daemon×daemon 的原因：**前存缺陷**（origin/main 已复现，非本分支引入）——delegated
//   守护 → root 守护的设备自签事件不落图（C 以拨号地址的 libp2p id 键控对端，A 以握手呈现的
//   hex id 键控，nudge/帧路由静默失配；verify-daemon-cluster 只覆盖 A→B 方向故从未暴露）。
//   本脚本的供给端（自动签发的全部机制所在）一律为**真实守护**；订阅端门面与真实守护的差异
//   仅是进程形态，签名/存储/网络栈全真。缺陷清单见 PR 描述。
//
// 前置：npm run build。摘要行 FLEET_SUMMARY。全沙箱（显式 MEBULAR_HOME/MEBULAR_USER_HOME）。

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdentityManager, Mebular } from '@mebular/core';

const MCP = fileURLToPath(new URL('../packages/mcp/bin/mebular.mjs', import.meta.url));
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 45000, pollMs = 250) {
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
function startServe(home) {
  const child = spawn(process.execPath, [MCP, 'serve'], {
    env: { ...process.env, MEBULAR_HOME: home, MEBULAR_USER_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { out: '', err: '' };
  child.stdout.on('data', (d) => (state.out += d));
  child.stderr.on('data', (d) => (state.err += d));
  return { child, state };
}
async function getJson(url, opts) {
  const res = await fetch(url, opts);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const post = (url, body, headers = {}) =>
  getJson(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function csrfHeaders(port) {
  const pre = await fetch(`http://127.0.0.1:${port}/console/`);
  const token = pre.headers.get('x-mebular-csrf');
  const cookie = (pre.headers.get('set-cookie') ?? '').split(';')[0];
  return token && cookie ? { 'x-mebular-csrf': token, cookie } : {};
}
async function policyEvents(storePath, type) {
  const lines = (await readFile(storePath, 'utf-8')).split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      const v = e.value ?? e; // 信封 {"op":"putEvent","value":{...}}
      if (v.type === type) out.push(v);
    } catch { /* 非事件行 */ }
  }
  return out;
}
const grantsFor = async (storePath, subject) =>
  (await policyEvents(storePath, 'namespace_grant')).filter((e) => e.data?.grant?.subject === subject);
const AUTO_NOTE = 'auto-grant: subscription-driven';

const root = await mkdtemp(join(tmpdir(), 'auto-grant-accept-'));
const serves = [];
const facades = [];
try {
  // ---------- 共享主密钥（同一用户的两台 root 守护：A 默认开、A2 开关关） ----------
  const imMaster = new IdentityManager();
  const master = await imMaster.generateUserMasterKey();
  const masterKeyFile = join(root, 'master-key.json');
  await writeFile(masterKeyFile, JSON.stringify({
    publicKey: Buffer.from(master.publicKey).toString('base64'),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
  }, null, 2), { mode: 0o600 });
  const masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };

  /** 一台 root 守护（供给端；autoGrant 省略 = 验收守护默认开）。 */
  async function bootRoot(deviceId, port, autoGrant) {
    const home = join(root, deviceId);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), JSON.stringify({
      storagePath: join(home, 'store.jsonl'), deviceId,
      identity: { mode: 'root' },
      encryption: { level: 'none', keyFile: masterKeyFile },
      network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] } },
      sync: {
        autoSync: true, pushOnWrite: true,
        namespaces: ['notes', 'work', 'legacy-ns'],
        policyIssuers: [deviceId],
        antiEntropy: { enabled: true, intervalMs: 3000, jitterRatio: 0.2 },
        ...(autoGrant !== undefined ? { autoGrant } : {}),
      },
      mcp: { http: { host: '127.0.0.1', port, auth: 'none' } },
    }, null, 2), { mode: 0o600 });
    const serve = startServe(home);
    serves.push(serve);
    const ready = await waitFor(async () => {
      if (!/SERVE_READY/.test(serve.state.out)) return false;
      const r = await getJson(`http://127.0.0.1:${port}/app/network`).catch(() => null);
      return typeof r?.json?.multiaddrs?.[0] === 'string';
    }, 25000, 300);
    const addr = (await getJson(`http://127.0.0.1:${port}/app/network`)).json?.multiaddrs?.[0];
    return { home, port, addr, ready, storePath: join(home, 'store.jsonl') };
  }

  /** 一个 in-process 订阅端门面（真 libp2p/签名/存储），拨指定守护。 */
  async function bootFacade(deviceId, namespaces) {
    const m = new Mebular({
      storagePath: join(root, `${deviceId}.jsonl`),
      deviceId,
      encryption: masterKeys,
      network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] } },
      sync: { autoSync: true, pushOnWrite: true, namespaces, policyIssuers: ['device-A', 'device-A2'] },
    });
    facades.push(m);
    await m.initialize();
    return m;
  }
  /** 门面 ↔ 守护 同步一轮（先断开保证新会话）。 */
  async function syncFacadeTo(facade, daemonAddr) {
    const peerId = /\/p2p\/([^/]+)$/.exec(daemonAddr)?.[1] ?? '';
    await facade.node.disconnectPeer({ id: peerId, multihash: new Uint8Array(), pubKey: new Uint8Array() }).catch(() => undefined);
    const done = new Promise((resolve) => facade.sync.once('sync-completed', resolve));
    await facade.node.connectToPeer({ id: peerId, multihash: new Uint8Array(), pubKey: new Uint8Array() }, daemonAddr);
    return done;
  }
  const facadeHas = async (facade, ns, text) =>
    (await facade.graph.listNodes({ namespace: ns })).some((n) => n.content?.text === text || JSON.stringify(n.content ?? {}).includes(text));

  // ========== pair1：A（默认开） ==========
  const portA = await freePort();
  const A = await bootRoot('device-A', portA, undefined);
  check('A 守护就绪（root；autoGrant 配置省略=默认开）', A.ready && typeof A.addr === 'string', {});
  await post(`http://127.0.0.1:${portA}/app/nodes`, { type: 'note', namespace: 'notes', content: { text: 'A-notes' } });
  await post(`http://127.0.0.1:${portA}/app/nodes`, { type: 'note', namespace: 'work', content: { text: 'A-work' } });
  await post(`http://127.0.0.1:${portA}/app/nodes`, { type: 'note', namespace: 'legacy-ns', content: { text: 'A-legacy' } });

  // ---------- ①【红线·第一优先】屏蔽 → 订阅 → 仍被拒 ----------
  const B = await bootFacade('device-B', ['notes']);
  await syncFacadeTo(B, A.addr); // 先建立会话（A↔B 互认）
  const csrfA = await csrfHeaders(portA);
  const revoke = await post(`http://127.0.0.1:${portA}/admin/api/devices/device-B/revoke`, { note: 'block' }, csrfA);
  check('① A 屏蔽 B（revokeDevice）', revoke.status === 200 && revoke.json?.ok === true, { status: revoke.status });
  await post(`http://127.0.0.1:${portA}/app/nodes`, { type: 'note', namespace: 'notes', content: { text: 'A-notes-post-block' } });
  await B.declareNamespaceMembership({ member: 'device-B', namespace: 'notes', active: true }); // B 订阅（自签落图）
  await syncFacadeTo(B, A.addr); // membership 送达 A
  await sleep(4000); // 事件去抖 2s + 评估窗口
  const grantsB = await grantsFor(A.storePath, 'device-B');
  check('①【红线】屏蔽后订阅 → 零 grant（含零 auto-grant）', grantsB.length === 0, { grants: grantsB.length });
  const effB = await getJson(`http://127.0.0.1:${portA}/app/policy/effective?device=device-B`);
  check('① 吊销保持：B 生效授权仍 []（R-d 未被解除）', (effB.json?.namespaces ?? []).length === 0, effB.json);
  await syncFacadeTo(B, A.addr);
  check('① 屏蔽后新数据不到达（post-block 节点）', !(await facadeHas(B, 'notes', 'A-notes-post-block')), {});

  // ---------- ② 订阅 → 自动放行 → 数据到位 ----------
  const C = await bootFacade('device-C', ['notes', 'work']);
  await C.declareNamespaceMembership({ member: 'device-C', namespace: 'work', active: true });
  await syncFacadeTo(C, A.addr); // membership 送达 A → 守护自动签发
  const autoGranted = await waitFor(async () =>
    (await grantsFor(A.storePath, 'device-C')).some((e) =>
      e.data?.grant?.note === AUTO_NOTE && (e.data?.grant?.namespaces ?? []).includes('work')), 30000);
  check('② A 自动签发 work grant（note=auto-grant 留证）', autoGranted, {});
  const autoRecord = (await grantsFor(A.storePath, 'device-C')).find((e) => e.data?.grant?.note === AUTO_NOTE);
  console.log('    留证 auto-grant 记录:', JSON.stringify(autoRecord?.data?.grant ?? null));
  const dataArrived = await waitFor(async () => {
    await syncFacadeTo(C, A.addr);
    return facadeHas(C, 'work', 'A-work');
  }, 30000, 2000);
  check('② 数据到位：C 收到 work 数据（订阅 → 自动放行）', dataArrived, {});
  await sleep(5000); // 再经若干评估窗口
  const autoCountC = (await grantsFor(A.storePath, 'device-C')).filter((e) => e.data?.grant?.note === AUTO_NOTE).length;
  check('② 幂等：auto-grant 记录恰一条', autoCountC === 1, { autoCount: autoCountC });

  // ---------- ④a 混合版本：老订阅端（只 hello、不写 membership）→ 中性态 + CLI 兜底 ----------
  const D = await bootFacade('device-D', ['legacy-ns']); // 仅 hello 声明，不写 membership
  await syncFacadeTo(D, A.addr);
  await sleep(4000);
  const grantsD = await grantsFor(A.storePath, 'device-D');
  check('④a 中性态：legacy-ns 无 membership 记录 → 不自动签发',
    !grantsD.some((e) => (e.data?.grant?.namespaces ?? []).includes('legacy-ns')), { grants: grantsD.length });
  check('④a 默认拒绝保持：D 看不到 legacy-ns 数据', !(await facadeHas(D, 'legacy-ns', 'A-legacy')), {});
  await post(`http://127.0.0.1:${portA}/app/policy/grant`, { subject: 'device-D', namespaces: ['legacy-ns'], note: 'manual-cli-fallback' });
  const dFixed = await waitFor(async () => {
    await syncFacadeTo(D, A.addr);
    return facadeHas(D, 'legacy-ns', 'A-legacy');
  }, 30000, 2000);
  check('④a CLI 兜底：手工 grant 后 D 收到 legacy-ns 数据', dFixed, {});

  // ========== pair2：A2（sync.autoGrant.enabled=false） ==========
  const portA2 = await freePort();
  const A2 = await bootRoot('device-A2', portA2, { enabled: false });
  check('③/④b A2 守护就绪（autoGrant.enabled=false）', A2.ready && typeof A2.addr === 'string', {});
  await post(`http://127.0.0.1:${portA2}/app/nodes`, { type: 'note', namespace: 'work', content: { text: 'A2-work' } });
  const E = await bootFacade('device-E', ['notes', 'work']);
  await E.declareNamespaceMembership({ member: 'device-E', namespace: 'work', active: true });
  await syncFacadeTo(E, A2.addr);
  await sleep(4000);
  const grantsE = await grantsFor(A2.storePath, 'device-E');
  check('③ kill-switch：开关关 → 零自动签发（回默认拒绝）',
    !grantsE.some((e) => e.data?.grant?.note === AUTO_NOTE), { grants: grantsE.length });
  check('③ 数据不放行：E 看不到 work 数据', !(await facadeHas(E, 'work', 'A2-work')), {});
  await post(`http://127.0.0.1:${portA2}/app/policy/grant`, { subject: 'device-E', namespaces: ['work'], note: 'manual-cli-fallback' });
  const eFixed = await waitFor(async () => {
    await syncFacadeTo(E, A2.addr);
    return facadeHas(E, 'work', 'A2-work');
  }, 30000, 2000);
  check('③ CLI 兜底：手工 grant 后 E 收到 work 数据', eFixed, {});
} finally {
  for (const f of facades) { try { await f.shutdown(); } catch { /* ignore */ } }
  for (const s of serves) { try { s.child.kill('SIGKILL'); } catch { /* ignore */ } }
  await sleep(300);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).map((r) => r.name);
console.log('== accept:auto-grant ==');
console.log(`FLEET_SUMMARY ${JSON.stringify({ total: results.length, passed, failed, skipped: [] })}`);
process.exit(failed.length === 0 ? 0 : 1);
