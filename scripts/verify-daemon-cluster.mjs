#!/usr/bin/env node
// W2 C3② 双机 loopback（daemon 形态）：两台守护各自持身份/存储/网络；令牌加入（B 委派身份）；
// 记忆经守护同步；成员表每机只占一条。摘要行 FLEET_SUMMARY。
// 前置：npm run build。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdentityManager, verifyCertificateChain, hexToBytes } from '@mebular/core';

const MCP = fileURLToPath(new URL('../packages/mcp/bin/mebular.mjs', import.meta.url));
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}
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
function startServe(home) {
  const child = spawn(process.execPath, [MCP, 'serve'], { env: { ...process.env, MEBULAR_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { out: '', err: '' };
  child.stdout.on('data', (d) => (state.out += d));
  child.stderr.on('data', (d) => (state.err += d));
  return { child, state };
}
async function getJson(url, opts) {
  const res = await fetch(url, opts);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const root = await mkdtemp(join(tmpdir(), 'daemon-cluster-'));
let serveA = null;
let serveB = null;
try {
  const homeA = join(root, 'A');
  const homeB = join(root, 'B');
  await mkdir(homeA, { recursive: true });
  const portA = await freePort();
  const portB = await freePort();
  const joinPort = await freePort();

  // A：root 身份 + 主密钥
  const imA = new IdentityManager();
  const master = await imA.generateUserMasterKey();
  await imA.generateDeviceKey('device-A', 'A');
  await imA.issueDeviceCertificate('device-A');
  await writeFile(join(homeA, 'master-key.json'), JSON.stringify({
    publicKey: Buffer.from(master.publicKey).toString('base64'),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
  }, null, 2), { mode: 0o600 });
  await writeFile(join(homeA, 'config.json'), JSON.stringify({
    storagePath: join(homeA, 'store.jsonl'), deviceId: 'device-A',
    identity: { mode: 'root' },
    encryption: { level: 'none', keyFile: join(homeA, 'master-key.json') },
    network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] } },
    sync: { autoSync: true, pushOnWrite: true, namespaces: ['tasks'], peerNamespacePolicy: { 'device-B': ['tasks'] }, policyIssuers: ['device-A'], antiEntropy: { enabled: true, intervalMs: 60000, jitterRatio: 0.2 } },
    joinService: { enabled: true, bind: '127.0.0.1', port: joinPort },
    mcp: { http: { host: '127.0.0.1', port: portA, auth: 'none' } },
  }, null, 2), { mode: 0o600 });

  serveA = startServe(homeA);
  const aReady = await waitFor(() => /SERVE_READY/.test(serveA.state.out), 20000);
  const aNet = await getJson(`http://127.0.0.1:${portA}/app/network`);
  const aAddr = aNet.json?.multiaddrs?.[0];
  check('A 守护就绪（root）并暴露网络地址', aReady && typeof aAddr === 'string' && aAddr.includes('/p2p/'), { aAddr });

  // A invite → B join（B 委派身份，无主密钥）
  const invite = await getJson(`http://127.0.0.1:${portA}/app/join/invite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ namespace: 'tasks', ttlMs: 120000 }) });
  const imB = new IdentityManager();
  const bKey = await imB.generateDeviceKey('device-B', 'B');
  const joined = await getJson(`http://127.0.0.1:${joinPort}/mebular/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: invite.json.token, deviceId: 'device-B', devicePublicKey: Buffer.from(bKey.publicKey).toString('hex') }) });
  const bChain = joined.json?.chain ?? [];
  const masterPubB64 = JSON.parse(readFileSync(join(homeA, 'master-key.json'), 'utf-8')).publicKey;
  const chainOk = await verifyCertificateChain(bChain, hexToBytes(Buffer.from(masterPubB64, 'base64').toString('hex')), { subjectDeviceId: 'device-B' });
  check('B 经守护 join 得委派链（B←A）', joined.status === 200 && bChain.length === 2 && chainOk, { chainLen: bChain.length, chainOk });

  // B：delegated 守护 home（无主私钥），主动拨 A
  await mkdir(homeB, { recursive: true });
  await writeFile(`${join(homeB, 'store.jsonl')}.identity.json`, JSON.stringify({
    deviceId: 'device-B', deviceName: 'B', publicKeyHex: Buffer.from(bKey.publicKey).toString('hex'),
    certificate: joined.json.certificate, certificateChain: bChain, createdAt: Date.now(),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(bKey.privateKey),
  }, null, 2), { mode: 0o600 });
  await writeFile(join(homeB, 'user-master-key.json'), JSON.stringify({ publicKey: masterPubB64 }, null, 2), { mode: 0o600 });
  await writeFile(join(homeB, 'config.json'), JSON.stringify({
    storagePath: join(homeB, 'store.jsonl'), deviceId: 'device-B',
    identity: { mode: 'delegated' },
    encryption: { level: 'none', userMasterPublicKeyFile: join(homeB, 'user-master-key.json') },
    network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] }, peers: [{ device: 'device-A', addr: aAddr }] },
    sync: { autoSync: true, pushOnWrite: true, namespaces: ['tasks'], peerNamespacePolicy: { 'device-A': ['tasks'] }, policyIssuers: ['device-A'], antiEntropy: { enabled: true, intervalMs: 60000, jitterRatio: 0.2 } },
    mcp: { http: { host: '127.0.0.1', port: portB, auth: 'none' } },
  }, null, 2), { mode: 0o600 });
  serveB = startServe(homeB);
  const bReady = await waitFor(() => /SERVE_READY/.test(serveB.state.out), 20000);
  check('B 守护就绪（delegated，无主私钥）', bReady && existsSync(join(homeB, 'config.json')) && JSON.parse(readFileSync(join(homeB, 'user-master-key.json'), 'utf-8')).privateKeyPkcs8 === undefined, {});

  // A 授权 B + 成员在册（每机只占一条）
  await getJson(`http://127.0.0.1:${portA}/app/policy/grant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'device-B', namespaces: ['tasks'] }) });
  await getJson(`http://127.0.0.1:${portA}/app/policy/member`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ member: 'device-B', namespace: 'tasks', active: true }) });
  await getJson(`http://127.0.0.1:${portA}/app/policy/member`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ member: 'device-A', namespace: 'tasks', active: true }) });
  const membership = await getJson(`http://127.0.0.1:${portA}/app/policy/membership?namespace=tasks`);
  const members = membership.json?.members ?? [];
  check('成员表每机只占一条（去重、含 A/B）', new Set(members).size === members.length && members.includes('device-A') && members.includes('device-B'), { members });

  // 记忆经守护同步（A 写 → B 读）
  await getJson(`http://127.0.0.1:${portA}/app/nodes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'cluster_note', namespace: 'tasks', content: { text: 'from-A' } }) });
  const synced = await waitFor(async () => {
    const r = await getJson(`http://127.0.0.1:${portB}/app/nodes?namespace=tasks&limit=10`);
    return (r.json?.nodes ?? []).some((n) => n.content?.text === 'from-A');
  }, 45000);
  check('记忆经守护同步（A→B）', synced, {});
  const bNs = await getJson(`http://127.0.0.1:${portB}/app/namespaces`);
  check('B 域名录含 tasks', (bNs.json?.namespaces ?? []).includes('tasks'), bNs.json);
} finally {
  for (const s of [serveA, serveB]) {
    if (s) { try { s.child.kill('SIGKILL'); } catch { /* ignore */ } }
  }
  await sleep(200);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).map((r) => r.name);
console.log('== verify:daemon:cluster ==');
console.log(`FLEET_SUMMARY ${JSON.stringify({ total: results.length, passed, failed, skipped: [] })}`);
process.exit(failed.length === 0 ? 0 : 1);
