#!/usr/bin/env node
// P1·A1 键控缺陷复现（红样本）—— 沙箱 daemon×daemon：
//   A = root 守护（主密钥/签发方）；B = delegated 守护（无主私钥），默认 B 主动拨 A。
//   B 写「亲签 membership + 记忆」→ 断言其落 A 图（预期红 = 缺陷复现）。
// 分层探针（脚本级 preload、不改产品代码）：
//   L1 连接层：/admin/api/overview + [KP] auth/connmgr 打点
//   L2 会话层：/admin/events SSE + [KP] sm.*（角色/触发/nudge/信任）
//   L3 事件层：两侧 store.jsonl（事件 id/author/type/ns）逐条比对
//   L4 图层：两侧 /app/nodes、/app/policy/membership
// 变体开关（env）：
//   DIAL=b2a|a2b   谁拨谁（默认 b2a：B 主动拨 A）
//   A_PUSH=0/1 B_PUSH=0/1   两侧 pushOnWrite（默认 1；0=只留 antiEntropy 兜底）
//   A_ANTI_MS / B_ANTI_MS   两侧 antiEntropy 间隔（默认 60000）
//   ORDER=a-first|b-first   先写对照还是先写 B（默认 a-first）
// 前置：npm run build。摘要行 KEYING_SUMMARY。全沙箱（显式 MEBULAR_HOME/MEBULAR_USER_HOME）。KEEP=1 保留沙箱。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdentityManager, verifyCertificateChain, hexToBytes, derivePeerIdHex } from '@mebular/core';

const MCP = fileURLToPath(new URL('../packages/mcp/bin/mebular.mjs', import.meta.url));
const PRELOAD = fileURLToPath(new URL('./keying-preload.mjs', import.meta.url));
const KEEP = process.env.KEEP === '1';
const CFG = {
  dial: process.env.DIAL ?? 'b2a',
  aPush: process.env.A_PUSH ?? '1',
  bPush: process.env.B_PUSH ?? '1',
  aAntiMs: Number(process.env.A_ANTI_MS ?? '60000'),
  bAntiMs: Number(process.env.B_ANTI_MS ?? '60000'),
  order: process.env.ORDER ?? 'a-first',
  preseed: process.env.PRESEED ?? '1',
  aPolicy: process.env.A_POLICY ?? '1',
  bPolicy: process.env.B_POLICY ?? '1',
  extraDial: process.env.EXTRA_DIAL ?? '0', // 0|hex|device：连接建立后 B 对 A 再拨一次（模拟 join hints + mDNS 自动再拨）
};
const label = `${CFG.dial}|pushA${CFG.aPush}B${CFG.bPush}|antiA${CFG.aAntiMs}B${CFG.bAntiMs}|${CFG.order}|pre${CFG.preseed}|polA${CFG.aPolicy}B${CFG.bPolicy}|x${CFG.extraDial}`;
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, pollMs = 250) {
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
function startServe(home, sideLabel) {
  const child = spawn(process.execPath, [MCP, 'serve'], {
    env: {
      ...process.env,
      MEBULAR_HOME: home,
      MEBULAR_USER_HOME: home,
      MEBULAR_KEYING_SIDE: sideLabel,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${PRELOAD}`.trim(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { out: '', err: '', lines: [] };
  const eat = (d, isErr) => {
    const text = d.toString();
    if (isErr) state.err += text;
    else state.out += text;
    for (const line of text.split('\n')) {
      if (line.trim()) state.lines.push(`${isErr ? 'E' : 'O'} ${line.trim()}`);
    }
  };
  child.stdout.on('data', (d) => eat(d, false));
  child.stderr.on('data', (d) => eat(d, true));
  return { child, state };
}
async function getJson(url, opts) {
  const res = await fetch(url, opts);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const post = (url, body, headers = {}) => getJson(url, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
/** admin 写端点需要 CSRF：GET /console/ 取 header 与 cookie。 */
async function csrfHeaders(port) {
  const pre = await fetch(`http://127.0.0.1:${port}/console/`, { headers: { accept: 'text/html' } });
  const token = pre.headers.get('x-mebular-csrf');
  const cookie = (pre.headers.get('set-cookie') ?? '').split(';')[0];
  await pre.arrayBuffer().catch(() => undefined);
  return token && cookie ? { 'x-mebular-csrf': token, cookie } : {};
}
function subscribeEvents(port, label2, sink) {
  const ctrl = new AbortController();
  void (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin/events`, { signal: ctrl.signal });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const ev = /^event: (.+)$/m.exec(part)?.[1] ?? '?';
          const data = /^data: (.+)$/m.exec(part)?.[1] ?? '';
          if (ev === 'hello' || ev === 'status') continue;
          sink.push({ at: Date.now(), side: label2, event: ev, data });
        }
      }
    } catch { /* 关闭 */ }
  })();
  return () => ctrl.abort();
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
          ...(v.data?.membership?.member ? { member: v.data.membership.member, active: v.data.membership.active } : {}),
        });
      }
    } catch { /* 跳过 */ }
  }
  return out;
}
function readJsonFile(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}
function markersOf(state) {
  return state.lines.filter((l) => l.includes('[KP]'));
}

const root = await mkdtemp(join(tmpdir(), 'keying-repro-'));
let serveA = null;
let serveB = null;
let unsubA = null;
let unsubB = null;
const sse = [];
try {
  const homeA = join(root, 'A');
  const homeB = join(root, 'B');
  await mkdir(homeA, { recursive: true });
  const portA = await freePort();
  const portB = await freePort();
  const joinPort = await freePort();

  // ---- A：root 身份 + 主密钥（同 verify-daemon-cluster 夹具）----
  const imA = new IdentityManager();
  const master = await imA.generateUserMasterKey();
  await imA.generateDeviceKey('device-A', 'A');
  await imA.issueDeviceCertificate('device-A');
  await writeFile(join(homeA, 'master-key.json'), JSON.stringify({
    publicKey: Buffer.from(master.publicKey).toString('base64'),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
  }, null, 2), { mode: 0o600 });
  const mkConfigA = (peerEntries) => ({
    storagePath: join(homeA, 'store.jsonl'), deviceId: 'device-A',
    identity: { mode: 'root' },
    encryption: { level: 'none', keyFile: join(homeA, 'master-key.json') },
    network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] }, ...(peerEntries.length > 0 ? { peers: peerEntries } : {}) },
    sync: {
      autoSync: true, pushOnWrite: CFG.aPush === '1', namespaces: ['tasks'],
      ...(CFG.aPolicy === '1' ? { peerNamespacePolicy: { 'device-B': ['tasks'] } } : {}),
      policyIssuers: ['device-A'],
      antiEntropy: { enabled: true, intervalMs: CFG.aAntiMs, jitterRatio: 0.2 },
    },
    joinService: { enabled: true, bind: '127.0.0.1', port: joinPort },
    mcp: { http: { host: '127.0.0.1', port: portA, auth: 'none' } },
  });

  const mkConfigB = (aAddr) => ({
    storagePath: join(homeB, 'store.jsonl'), deviceId: 'device-B',
    identity: { mode: 'delegated' },
    encryption: { level: 'none', userMasterPublicKeyFile: join(homeB, 'user-master-key.json') },
    network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] }, ...(aAddr ? { peers: [{ device: 'device-A', addr: aAddr }] } : {}) },
    sync: {
      autoSync: true, pushOnWrite: CFG.bPush === '1', namespaces: ['tasks'],
      ...(CFG.bPolicy === '1' ? { peerNamespacePolicy: { 'device-A': ['tasks'] } } : {}),
      policyIssuers: ['device-A'],
      antiEntropy: { enabled: true, intervalMs: CFG.bAntiMs, jitterRatio: 0.2 },
    },
    mcp: { http: { host: '127.0.0.1', port: portB, auth: 'none' } },
  });

  // a2b：先起 B（无 peers），拿地址后再起 A（带 peers 拨 B）；b2a：先起 A。
  let aAddr = null;
  let bAddr = null;
  if (CFG.dial === 'a2b') {
    await mkdir(homeB, { recursive: true });
    // B join 需要 A 的 join 服务 → 先起 A（不拨号），join 后再重启 A 带 peers。
    await writeFile(join(homeA, 'config.json'), JSON.stringify(mkConfigA([]), null, 2), { mode: 0o600 });
    serveA = startServe(homeA, 'A');
    const aReady0 = await waitFor(() => /SERVE_READY/.test(serveA.state.out), 20000);
    aAddr = (await getJson(`http://127.0.0.1:${portA}/app/network`)).json?.multiaddrs?.find((m) => m.includes('/p2p/')) ?? null;
    check('L0 A 守护就绪（root）+ 网络地址', aReady0 && typeof aAddr === 'string' && aAddr.includes('/p2p/'), { aAddr });

    const invite = await post(`http://127.0.0.1:${portA}/app/join/invite`, { namespace: 'tasks', ttlMs: 120000 });
    const imB = new IdentityManager();
    const bKey = await imB.generateDeviceKey('device-B', 'B');
    const joined = await getJson(`http://127.0.0.1:${joinPort}/mebular/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: invite.json.token, deviceId: 'device-B', devicePublicKey: Buffer.from(bKey.publicKey).toString('hex') }),
    });
    const bChain = joined.json?.chain ?? [];
    const masterPubB64 = JSON.parse(readFileSync(join(homeA, 'master-key.json'), 'utf-8')).publicKey;
    const chainOk = await verifyCertificateChain(bChain, hexToBytes(Buffer.from(masterPubB64, 'base64').toString('hex')), { subjectDeviceId: 'device-B' });
    check('L0 B 经守护 join 得委派链（B←A）', joined.status === 200 && bChain.length === 2 && chainOk, { chainLen: bChain.length });
    await writeFile(`${join(homeB, 'store.jsonl')}.identity.json`, JSON.stringify({
      deviceId: 'device-B', deviceName: 'B', publicKeyHex: Buffer.from(bKey.publicKey).toString('hex'),
      certificate: joined.json.certificate, certificateChain: bChain, createdAt: Date.now(),
      privateKeyPkcs8: await IdentityManager.exportPrivateKey(bKey.privateKey),
    }, null, 2), { mode: 0o600 });
    await writeFile(join(homeB, 'user-master-key.json'), JSON.stringify({ publicKey: masterPubB64 }, null, 2), { mode: 0o600 });
    await writeFile(join(homeB, 'config.json'), JSON.stringify(mkConfigB(null), null, 2), { mode: 0o600 });
    serveB = startServe(homeB, 'B');
    const bReady = await waitFor(() => /SERVE_READY/.test(serveB.state.out), 20000);
    bAddr = (await getJson(`http://127.0.0.1:${portB}/app/network`)).json?.multiaddrs?.find((m) => m.includes('/p2p/')) ?? null;
    check('L0 B 守护就绪（delegated）+ 网络地址', bReady && typeof bAddr === 'string' && bAddr.includes('/p2p/'), { bAddr });
    // 重启 A：本次带 peers 拨 B
    serveA.child.kill('SIGKILL');
    await sleep(300);
    await writeFile(join(homeA, 'config.json'), JSON.stringify(mkConfigA([{ device: 'device-B', addr: bAddr }]), null, 2), { mode: 0o600 });
    serveA = startServe(homeA, 'A');
    const aReady = await waitFor(() => /SERVE_READY/.test(serveA.state.out), 20000);
    aAddr = (await getJson(`http://127.0.0.1:${portA}/app/network`)).json?.multiaddrs?.find((m) => m.includes('/p2p/')) ?? null;
    check('L0 A 守护重启（root，带 peers 拨 B）', aReady && typeof aAddr === 'string', { aAddr });
  } else {
    // b2a（默认）：按计划夹具
    await writeFile(join(homeA, 'config.json'), JSON.stringify(mkConfigA([]), null, 2), { mode: 0o600 });
    serveA = startServe(homeA, 'A');
    const aReady = await waitFor(() => /SERVE_READY/.test(serveA.state.out), 20000);
    const aNet = await getJson(`http://127.0.0.1:${portA}/app/network`);
    aAddr = aNet.json?.multiaddrs?.find((m) => m.includes('/p2p/')) ?? aNet.json?.multiaddrs?.[0];
    check('L0 A 守护就绪（root）+ 网络地址', aReady && typeof aAddr === 'string' && aAddr.includes('/p2p/'), { aAddr });

    const invite = await post(`http://127.0.0.1:${portA}/app/join/invite`, { namespace: 'tasks', ttlMs: 120000 });
    const imB = new IdentityManager();
    const bKey = await imB.generateDeviceKey('device-B', 'B');
    const joined = await getJson(`http://127.0.0.1:${joinPort}/mebular/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: invite.json.token, deviceId: 'device-B', devicePublicKey: Buffer.from(bKey.publicKey).toString('hex') }),
    });
    const bChain = joined.json?.chain ?? [];
    const masterPubB64 = JSON.parse(readFileSync(join(homeA, 'master-key.json'), 'utf-8')).publicKey;
    const chainOk = await verifyCertificateChain(bChain, hexToBytes(Buffer.from(masterPubB64, 'base64').toString('hex')), { subjectDeviceId: 'device-B' });
    check('L0 B 经守护 join 得委派链（B←A）', joined.status === 200 && bChain.length === 2 && chainOk, { chainLen: bChain.length });

    await mkdir(homeB, { recursive: true });
    await writeFile(`${join(homeB, 'store.jsonl')}.identity.json`, JSON.stringify({
      deviceId: 'device-B', deviceName: 'B', publicKeyHex: Buffer.from(bKey.publicKey).toString('hex'),
      certificate: joined.json.certificate, certificateChain: bChain, createdAt: Date.now(),
      privateKeyPkcs8: await IdentityManager.exportPrivateKey(bKey.privateKey),
    }, null, 2), { mode: 0o600 });
    await writeFile(join(homeB, 'user-master-key.json'), JSON.stringify({ publicKey: masterPubB64 }, null, 2), { mode: 0o600 });
    await writeFile(join(homeB, 'config.json'), JSON.stringify(mkConfigB(aAddr), null, 2), { mode: 0o600 });
    serveB = startServe(homeB, 'B');
    const bReady = await waitFor(() => /SERVE_READY/.test(serveB.state.out), 20000);
    check('L0 B 守护就绪（delegated，主动拨 A）', bReady, {});
  }

  // ---- A 授权 B + 成员在册（PRESEED=1 时的预置；PRESEED=0 = 真实默认拒绝姿态）----
  if (CFG.preseed === '1') {
    await post(`http://127.0.0.1:${portA}/app/policy/grant`, { subject: 'device-B', namespaces: ['tasks'] });
    await post(`http://127.0.0.1:${portA}/app/policy/member`, { member: 'device-B', namespace: 'tasks', active: true });
    await post(`http://127.0.0.1:${portA}/app/policy/member`, { member: 'device-A', namespace: 'tasks', active: true });
  }

  // ---- L1：连接建立 ----
  const connectedA = await waitFor(async () => {
    const r = await getJson(`http://127.0.0.1:${portA}/admin/api/overview`);
    return (r.json?.onlinePeers ?? []).some((p) => p.authenticated);
  }, 30000);
  const connectedB = await waitFor(async () => {
    const r = await getJson(`http://127.0.0.1:${portB}/admin/api/overview`);
    return (r.json?.onlinePeers ?? []).some((p) => p.authenticated);
  }, 30000);
  const ovA1 = (await getJson(`http://127.0.0.1:${portA}/admin/api/overview`)).json;
  const ovB1 = (await getJson(`http://127.0.0.1:${portB}/admin/api/overview`)).json;
  check('L1 连接建立：两侧在线对端均认证通过', connectedA && connectedB, {
    A_peers: (ovA1?.onlinePeers ?? []).map((p) => ({ peerId: p.peerId, deviceId: p.deviceId })),
    B_peers: (ovB1?.onlinePeers ?? []).map((p) => ({ peerId: p.peerId, deviceId: p.deviceId })),
  });

  // ---- 变体：连接建立后，B 对 A 再拨一次（不同键）——模拟真实 join hints + mDNS 自动再拨 ----
  let extraDial = null;
  if (CFG.extraDial === 'hex' || CFG.extraDial === 'device') {
    const bIdentity = readJsonFile(join(homeB, 'store.jsonl.identity.json')) ?? {};
    const aPubHex = (bIdentity.certificateChain ?? [])[1]?.devicePublicKey ?? null; // 链=叶B→根A
    let dialKey = 'device-A';
    if (CFG.extraDial === 'hex') {
      if (!aPubHex) { check('X1 二次拨号需 A 设备公钥', false, {}); }
      else dialKey = derivePeerIdHex(hexToBytes(aPubHex));
    }
    const ch = await csrfHeaders(portB);
    extraDial = await post(`http://127.0.0.1:${portB}/admin/api/devices/${dialKey}/connect`, { address: aAddr }, ch);
    const twoConnsB = await waitFor(async () => {
      const r = await getJson(`http://127.0.0.1:${portB}/admin/api/overview`);
      return (r.json?.onlinePeers ?? []).filter((p) => p.deviceId === 'device-A').length >= 2;
    }, 20000);
    const twoConnsA = await waitFor(async () => {
      const r = await getJson(`http://127.0.0.1:${portA}/admin/api/overview`);
      return (r.json?.onlinePeers ?? []).filter((p) => p.deviceId === 'device-B').length >= 2;
    }, 20000);
    const ovB2 = (await getJson(`http://127.0.0.1:${portB}/admin/api/overview`)).json;
    const ovA2 = (await getJson(`http://127.0.0.1:${portA}/admin/api/overview`)).json;
    check(`X1 二次拨号（key=${CFG.extraDial === 'hex' ? 'derived-hex' : 'deviceId'}）建立第二条连接`, extraDial?.status === 200, {
      status: extraDial?.status, resp: extraDial?.json,
      B_peers: (ovB2?.onlinePeers ?? []).map((p) => ({ peerId: p.peerId, deviceId: p.deviceId })),
      A_peers: (ovA2?.onlinePeers ?? []).map((p) => ({ peerId: p.peerId, deviceId: p.deviceId })),
      twoConnsB, twoConnsA,
    });
  }

  unsubA = subscribeEvents(portA, 'A', sse);
  unsubB = subscribeEvents(portB, 'B', sse);
  await sleep(500);

  const writeB = async () => {
    const bMember = await post(`http://127.0.0.1:${portB}/app/policy/member`, { member: 'device-B', namespace: 'tasks', active: true });
    const bNode = await post(`http://127.0.0.1:${portB}/app/nodes`, { type: 'cluster_note', namespace: 'tasks', content: { text: 'from-B' } });
    return { bMember, bNode };
  };
  const writeA = async () => post(`http://127.0.0.1:${portA}/app/nodes`, { type: 'cluster_note', namespace: 'tasks', content: { text: 'from-A' } });

  let aToB = null;
  let bMember = null;
  let bNode = null;
  if (CFG.order === 'b-first') {
    // B 先写（紧接连接建立后），再对照 A 写
    ({ bMember, bNode } = await writeB());
    const bSeenByA1 = await waitFor(async () => {
      const r = await getJson(`http://127.0.0.1:${portA}/app/nodes?namespace=tasks&limit=50`);
      return (r.json?.nodes ?? []).some((n) => n.content?.text === 'from-B');
    }, 30000);
    await writeA();
    aToB = await waitFor(async () => {
      const r = await getJson(`http://127.0.0.1:${portB}/app/nodes?namespace=tasks&limit=20`);
      return (r.json?.nodes ?? []).some((n) => n.content?.text === 'from-A');
    }, 30000);
    check('CTRL 反向对照：A 写记忆 → B 可见（预期绿）', aToB, { expected: 'green' });
    check('DEFECT 等待 30s：B 写记忆 → A 可见（预期红）', bSeenByA1, { expected: 'red', captured: bSeenByA1 });
  } else {
    await writeA();
    aToB = await waitFor(async () => {
      const r = await getJson(`http://127.0.0.1:${portB}/app/nodes?namespace=tasks&limit=20`);
      return (r.json?.nodes ?? []).some((n) => n.content?.text === 'from-A');
    }, 30000);
    check('CTRL 正向对照：A 写记忆 → B 可见（预期绿）', aToB, { expected: 'green' });
    ({ bMember, bNode } = await writeB());
  }

  const bMemberId = bMember?.json?.eventId ?? null;
  const bStore1 = readStoreEvents(join(homeB, 'store.jsonl'));
  const bHasMember = bStore1.some((e) => e.id === bMemberId);
  const bHasNode = bStore1.some((e) => e.author === 'device-B' && e.type === 'node_created');
  check('PREP B 亲签事件已写入 B 本地日志（membership + 记忆）', bHasMember && bHasNode, {
    bMemberId, bMemberStatus: bMember?.status, bNodeStatus: bNode?.status, bAuthors: [...new Set(bStore1.map((e) => e.author))],
  });

  const aSeesBNode1 = CFG.order === 'b-first' ? null : await waitFor(async () => {
    const r = await getJson(`http://127.0.0.1:${portA}/app/nodes?namespace=tasks&limit=50`);
    return (r.json?.nodes ?? []).some((n) => n.content?.text === 'from-B');
  }, 30000);
  const aMember1 = await getJson(`http://127.0.0.1:${portA}/app/policy/membership?namespace=tasks`);

  await sleep(CFG.order === 'b-first' ? 15000 : 13000); // 再观察一个 antiEntropy 兜底后的窗口

  const aStore = readStoreEvents(join(homeA, 'store.jsonl'));
  const aEventIds = new Set(aStore.map((e) => e.id));
  const bAuthored = bStore1.filter((e) => e.author === 'device-B');
  const bAuthoredInA = bAuthored.filter((e) => aEventIds.has(e.id));
  const aSeesBNode2 = (await getJson(`http://127.0.0.1:${portA}/app/nodes?namespace=tasks&limit=50`)).json?.nodes ?? [];
  const aMember2 = await getJson(`http://127.0.0.1:${portA}/app/policy/membership?namespace=tasks`);
  const bStore2 = readStoreEvents(join(homeB, 'store.jsonl'));

  check('L3 [缺陷向] B 亲签事件出现在 A 事件日志（预期红）', bAuthoredInA.length === bAuthored.length && bAuthored.length >= 2, {
    expected: 'red', bAuthoredCount: bAuthored.length, inA: bAuthoredInA.length,
    bAuthored: bAuthored.map((e) => ({ id: e.id.slice(0, 16), type: e.type, ns: e.ns })),
  });
  check('L4 [缺陷向] A 图含 B 写的记忆（from-B）（预期红）', aSeesBNode2.some((n) => n.content?.text === 'from-B'), {
    expected: 'red', waited30s: aSeesBNode1,
  });
  check('L4 [缺陷向] A membership 采纳 B 的亲签成员记录（预期红）', (aMember2.json?.members ?? []).includes('device-B'), {
    expected: 'red', A_membership: aMember2.json?.members, waited30s_members: aMember1.json?.members,
  });

  const evidence = {
    variant: label, sandbox: root,
    sse: { total: sse.length, events: sse },
    A_overview: (await getJson(`http://127.0.0.1:${portA}/admin/api/overview`)).json?.onlinePeers,
    B_overview: (await getJson(`http://127.0.0.1:${portB}/admin/api/overview`)).json?.onlinePeers,
    A_events: aStore, B_events: bStore2,
    A_syncState: readJsonFile(join(homeA, 'store.jsonl.sync-state.json')),
    B_syncState: readJsonFile(join(homeB, 'store.jsonl.sync-state.json')),
    B_authored_events_in_A: bAuthoredInA.length,
    A_membership: aMember2.json,
    A_nodes: aSeesBNode2.map((n) => n.content),
  };
  console.log('==== 原始证据 ====');
  console.log(JSON.stringify(evidence, null, 2));
  console.log('==== 分层探针（[KP] 全量） ====');
  for (const line of markersOf(serveA.state)) console.log(`A ${line.replace(/^[EO] /, '')}`);
  for (const line of markersOf(serveB.state)) console.log(`B ${line.replace(/^[EO] /, '')}`);

  const controlOk = (CFG.order === 'b-first' ? aToB : aToB && bHasMember && bHasNode);
  const defectRed = bAuthored.length >= 2 && bAuthoredInA.length === 0 && !aSeesBNode2.some((n) => n.content?.text === 'from-B');
  console.log('== keying-repro ==');
  console.log(`KEYING_SUMMARY ${JSON.stringify({ variant: label, total: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.name), controlOk, defectRed, sandbox: root })}`);
  if (KEEP) console.log(`KEEP=1 → 沙箱保留：${root}`);
  process.exitCode = 0; // 复现工具：结果见 KEYING_SUMMARY（defectRed=true 即红样本成立）
} finally {
  unsubA?.();
  unsubB?.();
  for (const s of [serveA, serveB]) {
    if (s) { try { s.child.kill('SIGKILL'); } catch { /* ignore */ } }
  }
  if (!KEEP && serveA && serveB) {
    // 保留沙箱当且仅当 KEEP=1；否则清理
    await sleep(200);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } else if (serveA && serveB) {
    await sleep(200);
  }
}
