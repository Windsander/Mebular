#!/usr/bin/env node
// W2 守护验收：统一 home / 委派身份模式 / 本机 app 接口（loopback+token）/ 非回环 fail-closed / 单写者。
// 前置：npm run build（依赖 @mebular/core dist）。摘要行 FLEET_SUMMARY。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdentityManager } from '@mebular/core';

const BIN = fileURLToPath(new URL('../packages/mcp/bin/mebular.mjs', import.meta.url));
const results = [];
const skipped = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
async function makeDelegatedHome(home) {
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
    sync: { autoSync: false },
    mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
  }, null, 2), { mode: 0o600 });
  return { masterPub, storagePath };
}

const root = await mkdtemp(join(tmpdir(), 'mebular-daemon-'));
const homeB = join(root, 'B');
let serve1 = null;
let serve2 = null;
try {
  console.log('== A1/A5 委派身份模式（无主私钥）==');
  await makeDelegatedHome(homeB);
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
  const ready = await waitFor(() => /SERVE_READY/.test(serve1.state.out), 15000);
  const readyLine = serve1.state.out.split('\n').find((l) => l.startsWith('SERVE_READY'));
  const port = readyLine ? JSON.parse(readyLine.slice('SERVE_READY '.length)).port : null;
  check('serve 就绪（loopback）', ready && typeof port === 'number', { port });
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
