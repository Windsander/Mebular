#!/usr/bin/env node
// W2 守护验收：统一 home / 委派身份模式 / 本机 app 接口（loopback+token）/ 非回环 fail-closed / 单写者。
// 前置：npm run build（依赖 @mebular/core dist）。摘要行 FLEET_SUMMARY。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { Mebular, IdentityManager, verifyCertificateChain, hexToBytes } from '@mebular/core';
import * as fleetJt from '@mebular/fleet';
import * as mcpJt from '../packages/mcp/src/jointoken.mjs';

const BIN = fileURLToPath(new URL('../packages/mcp/bin/mebular.mjs', import.meta.url));
const FLEET_CLI = fileURLToPath(new URL('../packages/fleet/dist/cli.js', import.meta.url));
function runFleet(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FLEET_CLI, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
const results = [];
const skipped = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}
async function waitFor(fn, timeoutMs, pollMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}
function firstJson(text) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b < 0) return null;
  return JSON.parse(text.slice(a, b + 1));
}
function runCli(env, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}
function startCli(env, args) {
  const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { out: '', err: '' };
  child.stdout.on('data', (d) => (state.out += d));
  child.stderr.on('data', (d) => (state.err += d));
  return { child, state };
}

/** 造一台**委派身份**（无主私钥）的守护 home。 */
async function makeDelegatedHome(home, joinPort) {
  await mkdir(home, { recursive: true });
  const im = new IdentityManager();
  await im.generateUserMasterKey();
  const masterPub = im.getUserMasterPublicKey();
  await im.generateDeviceKey('device-X', 'X');
  await im.issueDeviceCertificate('device-X'); // 一级（主密钥直签）
  await im.generateDeviceKey('device-B', 'B');
  await im.issueDelegatedDeviceCertificate('device-B', 'device-X'); // 委派
  const b = im.getDeviceKey('device-B');
  const storagePath = join(home, 'store.jsonl');
  const identityRecord = {
    deviceId: 'device-B',
    deviceName: 'B',
    publicKeyHex: Buffer.from(b.publicKey).toString('hex'),
    certificate: b.certificate,
    certificateChain: b.certificateChain,
    createdAt: Date.now(),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(b.privateKey),
  };
  await writeFile(`${storagePath}.identity.json`, JSON.stringify(identityRecord, null, 2), { mode: 0o600 });
  // 主公钥文件（**无主私钥**）
  await writeFile(join(home, 'user-master-key.json'), JSON.stringify({ publicKey: Buffer.from(masterPub).toString('base64') }, null, 2), { mode: 0o600 });
  await writeFile(join(home, 'config.json'), JSON.stringify({
    storagePath,
    deviceId: 'device-B',
    identity: { mode: 'delegated' },
    encryption: { level: 'none', userMasterPublicKeyFile: join(home, 'user-master-key.json') },
    network: { enabled: false },
    sync: { autoSync: false, namespaces: ['tasks'], policyIssuers: ['device-B'] },
    mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
    joinService: { enabled: true, bind: '127.0.0.1', port: joinPort },
  }, null, 2), { mode: 0o600 });
  return { masterPub, storagePath };
}

const root = await mkdtemp(join(tmpdir(), 'mebular-daemon-'));
const homeB = join(root, 'B');
let serve1 = null;
let serve2 = null;
try {
  console.log('== A1/A5 委派身份模式（无主私钥）==');
  const joinPort = await freePort();
  await makeDelegatedHome(homeB, joinPort);
  // W2 跨包一致性：fleet ↔ daemon 令牌格式双向互验（防线格式漂移）
  {
    const masterPub = new Uint8Array(Buffer.from(JSON.parse(readFileSync(join(homeB, 'user-master-key.json'), 'utf-8')).publicKey, 'base64'));
    const m = new Mebular({ storagePath: join(homeB, 'store.jsonl'), deviceId: 'device-B', encryption: { userMasterKey: masterPub }, network: { enabled: false } });
    await m.initialize();
    try {
      const base = { mebular: m, deviceId: 'device-B', namespace: 'tasks', endpoint: 'http://127.0.0.1:1', now: 1000, ttlMs: 60000 };
      const tFleet = await fleetJt.buildJoinToken({ ...base, nonce: 'nf' });
      const fleetInMcp = await mcpJt.verifyJoinToken(tFleet, { now: 2000 });
      const tMcp = await mcpJt.buildJoinToken({ ...base, nonce: 'nd' });
      const mcpInFleet = await fleetJt.verifyJoinToken(tMcp, { now: 2000 });
      const same = mcpJt.canonicalJoinTokenData(tFleet) === fleetJt.canonicalJoinTokenData(tFleet);
      check('令牌跨包互验（fleet↔daemon）+ canonical 一致', fleetInMcp.ok === true && mcpInFleet.ok === true && same, { fleetInMcp, mcpInFleet, same });
    } finally {
      await m.shutdown();
    }
  }
  // S5：**隐式**身份模式判定（无 identity.mode 字段）
  const homeI = join(root, 'I');
  await mkdir(homeI, { recursive: true });
  const cfgI = JSON.parse(readFileSync(join(homeB, 'config.json'), 'utf-8'));
  delete cfgI.identity; // 去掉显式 mode → 走隐式判定
  cfgI.storagePath = join(homeI, 'store.jsonl');
  await writeFile(join(homeI, 'config.json'), JSON.stringify(cfgI, null, 2), { mode: 0o600 });
  await writeFile(`${join(homeI, 'store.jsonl')}.identity.json`, readFileSync(`${join(homeB, 'store.jsonl')}.identity.json`), { mode: 0o600 });
  await writeFile(join(homeI, 'user-master-key.json'), readFileSync(join(homeB, 'user-master-key.json')), { mode: 0o600 });
  const stI = await runCli({ ...process.env, MEBULAR_HOME: homeI }, ['status']);
  const stIJson = firstJson(stI.out) ?? {};
  check('隐式委派：无 identity.mode + 身份文件 + 无主私钥 → delegated', stI.code === 0 && stIJson.identityMode === 'delegated', { identityMode: stIJson.identityMode });
  const homeRr = join(root, 'R');
  await mkdir(homeRr, { recursive: true });
  const imR = new IdentityManager();
  const mr = await imR.generateUserMasterKey();
  await writeFile(join(homeRr, 'master-key.json'), JSON.stringify({ publicKey: Buffer.from(mr.publicKey).toString('base64'), privateKeyPkcs8: await IdentityManager.exportPrivateKey(mr.privateKey) }, null, 2), { mode: 0o600 });
  await writeFile(join(homeRr, 'config.json'), JSON.stringify({ storagePath: join(homeRr, 'store.jsonl'), deviceId: 'device-R', encryption: { level: 'none', keyFile: join(homeRr, 'master-key.json') }, network: { enabled: false }, sync: { autoSync: false } }, null, 2), { mode: 0o600 });
  const stR = await runCli({ ...process.env, MEBULAR_HOME: homeRr }, ['status']);
  const stRJson = firstJson(stR.out) ?? {};
  check('隐式 root：有主私钥且无身份文件 → root', stR.code === 0 && stRJson.identityMode === 'root', { identityMode: stRJson.identityMode });

  const envB = { ...process.env, MEBULAR_HOME: homeB };
  const st = await runCli(envB, ['status']);
  const stJson = firstJson(st.out) ?? {};
  check('status 报告 identityMode=delegated', st.code === 0 && stJson.identityMode === 'delegated', { code: st.code, identityMode: stJson.identityMode, err: (st.err ?? '').trim().slice(0, 120) });
  const masterRec = existsSync(join(homeB, 'user-master-key.json')) ? JSON.parse(readFileSync(join(homeB, 'user-master-key.json'), 'utf-8')) : {};
  check('委派模式：主密钥文件**无 privateKeyPkcs8**', masterRec.privateKeyPkcs8 === undefined, { keys: Object.keys(masterRec) });
  check('status 暴露 网络/锁/域/join 可观测项', stJson.network !== undefined && 'storeLock' in stJson && Array.isArray(stJson.namespaces) && 'joinService' in stJson, {});

  console.log('== A3 本机 app 接口（loopback + bearer）==');
  const tokensFile = join(homeB, 'auth', 'tokens.json');
  const grant = await runCli(envB, ['token', 'grant', '--scope', 'memory.read,memory.write', '--tokens-file', tokensFile]);
  const token = firstJson(grant.out).token;
  check('token grant 成功', typeof token === 'string' && token.length > 10, {});
  serve1 = startCli(envB, ['serve', '--host', '127.0.0.1', '--port', '0', '--auth', 'bearer', '--tokens-file', tokensFile]);
  const ready = await waitFor(() => /SERVE_READY/.test(serve1.state.out), 60000, 250);
  const readyLine = serve1.state.out.split('\n').find((l) => l.startsWith('SERVE_READY'));
  const port = readyLine ? JSON.parse(readyLine.slice('SERVE_READY '.length)).port : null;
  check('serve 就绪（loopback）', ready && typeof port === 'number', { port, err: serve1.state.err.trim().slice(-200) });
  if (typeof port !== 'number') throw new Error(`serve 未就绪：out=${serve1.state.out.slice(-200)} err=${serve1.state.err.slice(-300)}`);
  const base = `http://127.0.0.1:${port}`;
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const created = await fetch(`${base}/app/nodes`, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'app_note', namespace: 'team', content: { text: 'hello' } }) });
  const createdJson = await created.json();
  check('POST /app/nodes 建节点（Bearer）', created.status === 200 && createdJson.ok === true && createdJson.node.namespace === 'team', createdJson);
  const listed = await fetch(`${base}/app/nodes?namespace=team&limit=10`, { headers: auth });
  const listedJson = await listed.json();
  check('GET /app/nodes 按域列出', listed.status === 200 && listedJson.count === 1, { count: listedJson.count });
  const ns = await fetch(`${base}/app/namespaces`, { headers: auth });
  const nsJson = await ns.json();
  check('GET /app/namespaces', ns.status === 200 && nsJson.namespaces.includes('team'), nsJson);
  const noauth = await fetch(`${base}/app/nodes?namespace=team`, {});
  check('无 token → 401（fail-closed 鉴权）', noauth.status === 401, { status: noauth.status });

  console.log('== 红→绿②：非回环 fail-closed ==');
  // 用独立 home（root 身份）避免与 serve1 的 store 锁冲突
  const homeBad = join(root, 'bad');
  await mkdir(homeBad, { recursive: true });
  await writeFile(join(homeBad, 'config.json'), JSON.stringify({ storagePath: join(homeBad, 'store.jsonl'), deviceId: 'device-x', encryption: { level: 'none' }, network: { enabled: false }, sync: { autoSync: false } }, null, 2), { mode: 0o600 });
  const bad = await runCli({ ...process.env, MEBULAR_HOME: homeBad }, ['serve', '--host', '0.0.0.0', '--port', '0', '--auth', 'none']);
  check('非回环 + auth=none → 拒绝启动', bad.code !== 0 && /fail closed/.test(bad.out + bad.err), { code: bad.code, err: (bad.out + bad.err).trim().slice(0, 120) });

  console.log('== 红→绿③：单写者（第二个写者被拒）==');
  serve2 = startCli(envB, ['serve', '--host', '127.0.0.1', '--port', '0', '--auth', 'bearer', '--tokens-file', tokensFile]);
  const dead = await waitFor(() => serve2.child.exitCode !== null, 15000) || serve2.child.exitCode !== null;
  const locked = /MCP_STORAGE_LOCKED|存储已被占用/.test(serve2.state.err + serve2.state.out);
  check('第二写者被明确拒绝（MCP_STORAGE_LOCKED）', dead && locked, { err: serve2.state.err.trim().slice(0, 120) });

  console.log('== A4 join 迁回守护 + 策略 app 路由 ==');
  const invite = await fetch(`${base}/app/join/invite`, { method: 'POST', headers: auth, body: JSON.stringify({ namespace: 'tasks', ttlMs: 120000 }) });
  const inviteJson = await invite.json();
  check('守护托管 invite（/app/join/invite 出令牌）', invite.status === 200 && typeof inviteJson.token === 'string' && inviteJson.endpoint === `http://127.0.0.1:${joinPort}`, { endpoint: inviteJson.endpoint });
  // C 生成设备钥 → 直接向守护 join 端点请求委派证书（链应为 C←B←A）
  const imC = new IdentityManager();
  const cKey = await imC.generateDeviceKey('device-C', 'C');
  const joined = await fetch(`http://127.0.0.1:${joinPort}/mebular/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: inviteJson.token, deviceId: 'device-C', devicePublicKey: Buffer.from(cKey.publicKey).toString('hex') }),
  });
  const joinedJson = await joined.json();
  const chain = joinedJson.chain ?? [];
  check('委派签发：C 证书链长度 3（C←B←A）且锚定主密钥', joined.status === 200 && chain.length === 3 && (await verifyCertificateChain(chain, hexToBytes(Buffer.from(JSON.parse(readFileSync(join(homeB, 'user-master-key.json'), 'utf-8')).publicKey, 'base64').toString('hex')), { subjectDeviceId: 'device-C' })), { chainLen: chain.length });
  // 策略 app 路由：grant + effective
  const grantRes = await fetch(`${base}/app/policy/grant`, { method: 'POST', headers: auth, body: JSON.stringify({ subject: 'device-C', namespaces: ['tasks'] }) });
  const grantJson = await grantRes.json();
  const effRes = await fetch(`${base}/app/policy/effective?device=device-C`, { headers: auth });
  const effJson = await effRes.json();
  check('策略 app 路由：grant + effective 生效', grantRes.status === 200 && grantJson.ok === true && effJson.namespaces?.includes('tasks'), { namespaces: effJson.namespaces });

  console.log('== C3③ 委派加入的设备能跑守护（无主密钥）==');
  const homeC = join(root, 'C');
  await mkdir(homeC, { recursive: true });
  const cStorage = join(homeC, 'store.jsonl');
  await writeFile(`${cStorage}.identity.json`, JSON.stringify({
    deviceId: 'device-C', deviceName: 'C',
    publicKeyHex: Buffer.from(cKey.publicKey).toString('hex'),
    certificate: joinedJson.certificate, certificateChain: chain, createdAt: Date.now(),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(cKey.privateKey),
  }, null, 2), { mode: 0o600 });
  // C 的主公钥（继承同一用户主密钥；公开信息）
  await writeFile(join(homeC, 'user-master-key.json'), readFileSync(join(homeB, 'user-master-key.json')), { mode: 0o600 });
  await writeFile(join(homeC, 'config.json'), JSON.stringify({
    storagePath: cStorage, deviceId: 'device-C', identity: { mode: 'delegated' },
    encryption: { level: 'none', userMasterPublicKeyFile: join(homeC, 'user-master-key.json') },
    network: { enabled: false }, sync: { autoSync: false },
  }, null, 2), { mode: 0o600 });
  const cStatus = await runCli({ ...process.env, MEBULAR_HOME: homeC }, ['status']);
  const cJson = firstJson(cStatus.out) ?? {};
  check('委派设备（C）能跑守护且 identityMode=delegated', cStatus.code === 0 && cJson.identityMode === 'delegated', { code: cStatus.code, identityMode: cJson.identityMode });

  console.log('== B2 fleet join --daemon（B 一条命令 → 完整 delegated 节点）==');
  const invite2 = await fetch(`${base}/app/join/invite`, { method: 'POST', headers: auth, body: JSON.stringify({ namespace: 'tasks', ttlMs: 120000 }) });
  const invite2Json = await invite2.json();
  const homeE = join(root, 'E');
  const portE = await freePort();
  const joinPortE = await freePort();
  const joinRes = await runFleet(['join', '--token', invite2Json.token, '--dir', homeE, '--device', 'device-E', '--daemon', '--daemon-port', String(portE), '--join-port', String(joinPortE), '--no-service', '--agent', 'echo']);
  const joinOut = firstJson(joinRes.out) ?? {};
  const eDaemonCfg = JSON.parse(readFileSync(join(homeE, 'config.json'), 'utf-8'));
  const eFleetCfg = JSON.parse(readFileSync(join(homeE, 'fleet.config.json'), 'utf-8'));
  const eStatus = await runCli({ ...process.env, MEBULAR_HOME: homeE }, ['status']);
  const eStatusJson = firstJson(eStatus.out) ?? {};
  check('join --daemon：delegated 守护 home + fleet daemon 客户端 + 令牌', joinRes.code === 0 && eDaemonCfg.identity?.mode === 'delegated' && eFleetCfg.store === 'daemon' && typeof eFleetCfg.daemon?.token === 'string', { identity: eDaemonCfg.identity?.mode, store: eFleetCfg.store, endpoint: joinOut.daemon?.endpoint });
  check('join --daemon：B 无主私钥且守护可跑（identityMode=delegated）', eStatus.code === 0 && eStatusJson.identityMode === 'delegated' && JSON.parse(readFileSync(join(homeE, 'user-master-key.json'), 'utf-8')).privateKeyPkcs8 === undefined, { identityMode: eStatusJson.identityMode });
  check('join --daemon：输出 Agent MCP 配置片段', joinOut.agentMcp?.mcp?.mebular?.command?.[0] === 'mebular', { agentMcp: joinOut.agentMcp });

  console.log('== B2 上车统一：quickstart --daemon 写守护 home + fleet 客户端 ==');
  const homeD = join(root, 'D');
  const daemonPort = await freePort();
  const joinPort2 = await freePort();
  const qs = await new Promise((resolve) => {
    const child = spawn(process.execPath, [FLEET_CLI, 'quickstart', '--dir', homeD, '--device', 'device-D', '--listen', '/ip4/127.0.0.1/tcp/0', '--no-service', '--daemon', '--daemon-port', String(daemonPort), '--join-port', String(joinPort2), '--agent', 'echo'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
  const fleetCfg = JSON.parse(readFileSync(join(homeD, 'fleet.config.json'), 'utf-8'));
  const daemonCfg = JSON.parse(readFileSync(join(homeD, 'config.json'), 'utf-8'));
  check('quickstart --daemon：fleet 走 daemon 客户端', qs.code === 0 && fleetCfg.store === 'daemon' && fleetCfg.daemon?.endpoint === `http://127.0.0.1:${daemonPort}`, { store: fleetCfg.store, endpoint: fleetCfg.daemon?.endpoint });
  check('quickstart --daemon：守护 home 配置（root 身份 + joinService + policyIssuers）', daemonCfg.identity?.mode === 'root' && daemonCfg.joinService?.enabled === true && Array.isArray(daemonCfg.sync?.policyIssuers), { identity: daemonCfg.identity, joinService: daemonCfg.joinService });
  // 用写好的 config.json 默认值启动守护（host/port/auth/tokensFile 来自配置）
  const dserve = startCli({ ...process.env, MEBULAR_HOME: homeD }, ['serve']);
  const dready = await waitFor(() => /SERVE_READY/.test(dserve.state.out) || /JOIN_READY/.test(dserve.state.err + dserve.state.out), 15000);
  const dToken = fleetCfg.daemon.token;
  const dcall = await fetch(`http://127.0.0.1:${daemonPort}/app/nodes`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${dToken}` }, body: JSON.stringify({ type: 'app_note', namespace: 'tasks', content: { text: 'unified' } }) }).catch(() => ({ status: 0 }));
  check('写好的守护 home 可 serve（配置默认 port/auth）+ app 调用通', dready && dcall.status === 200, { ready: dready, status: dcall.status });
  dserve.child.kill('SIGKILL');

  console.log('== C3① 单机：守护 + fleet 客户端（daemon 模式）+ 任务往返 ==');
  const homeFleet = join(root, 'fleet');
  await mkdir(homeFleet, { recursive: true });
  await writeFile(join(homeFleet, 'fleet.config.json'), JSON.stringify({
    v: 1,
    device: 'device-F',
    dir: homeFleet,
    storagePath: join(homeFleet, 'store.jsonl'),
    masterKeyFile: join(homeFleet, 'master-key.json'),
    namespace: 'tasks',
    listen: '/ip4/127.0.0.1/tcp/0',
    peers: [{ device: 'device-F' }],
    policyIssuers: ['device-F'],
    agents: [{ name: 'echo', kind: 'echo' }],
    store: 'daemon',
    daemon: { endpoint: base, token },
  }, null, 2), { mode: 0o600 });
  const work = runFleet(['worker', '--dir', homeFleet, '--store', 'daemon', '--timeout-ms', '20000']);
  await sleep(300);
  const nodeRes = await runFleet(['node', '--dir', homeFleet, '--store', 'daemon', '--submit', '2', '--target-agent', 'echo', '--expect-prefix', 'echo:', '--timeout-ms', '20000']);
  await work;
  const lastLine = nodeRes.out.split('\n').reverse().find((l) => l.startsWith('{') && l.includes('submitted'));
  const summary = lastLine ? JSON.parse(lastLine) : null;
  check('fleet node/worker daemon 模式任务往返（2/2）', summary?.submitted === 2 && summary?.done === 2 && summary?.resultsMatch === true, summary ?? { err: nodeRes.err.slice(-160) });
  check('daemon 模式：node 不监听 libp2p（mode=daemon）', /"mode":"daemon"/.test(nodeRes.out), { listening: nodeRes.out.split('\n').find((l) => l.includes('listening')) ?? null });
} finally {
  for (const s of [serve1, serve2]) {
    if (s) {
      try {
        s.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
  await sleep(200);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).map((r) => r.name);
console.log('== verify:daemon ==');
console.log(`FLEET_SUMMARY ${JSON.stringify({ total: results.length, passed, failed, skipped })}`);
process.exit(failed.length === 0 ? 0 : 1);
