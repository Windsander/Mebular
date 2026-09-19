#!/usr/bin/env node
// 一键上车 + 信任模型 v2 验收：quickstart（含 join 服务 + 令牌）→ join --token（不复制主密钥）→
// pending → approve → 双向派活 → 两端 doctor 全绿；另含令牌一次性/版本核对（legacy）负例。
//
// 全程 temp 目录 + 真实 libp2p loopback + loopback HTTP join 端点；确定性 fake agent。
// 摘要行：`FLEET_SUMMARY {...}`，供 verify:fleet:all 汇总。前置：npm run build。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../packages/fleet/dist/cli.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../tests/fleet/fixtures/fake-agent.mjs', import.meta.url));
const IS_WIN = process.platform === 'win32';

const results = [];
const skipped = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}
function skip(name, reason) {
  skipped.push({ name, reason });
  console.log(`SKIP  ${name}  ${reason}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, pollMs = 60) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}
function firstJson(text) {
  const at = text.indexOf('{');
  if (at < 0) return null;
  try {
    return JSON.parse(text.slice(at));
  } catch {
    return null;
  }
}
function lastJsonLine(text) {
  let last = null;
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      last = JSON.parse(line);
    } catch {
      /* skip */
    }
  }
  return last;
}
function runCli(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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
const children = [];
function startCli(args) {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { out: '', err: '' };
  child.stdout.on('data', (d) => (state.out += d));
  child.stderr.on('data', (d) => (state.err += d));
  const ctx = { child, state };
  children.push(ctx);
  return ctx;
}
function killAll() {
  for (const c of children.splice(0)) {
    try {
      c.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}
function waitExit(ctx, timeoutMs) {
  return new Promise((resolve) => {
    if (ctx.child.exitCode !== null) return resolve(ctx.child.exitCode);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    ctx.child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
function eventLine(ctx, event) {
  for (const line of ctx.state.out.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const j = JSON.parse(line);
      if (j.event === event) return j;
    } catch {
      /* skip */
    }
  }
  return null;
}
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
function tamperSha(codeText, sha) {
  const json = Buffer.from(codeText.trim(), 'base64').toString('utf-8');
  const obj = JSON.parse(json);
  obj.sha = sha;
  return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64');
}

const root = await mkdtemp(join(tmpdir(), 'fleet-qs2-verify-'));
const A = join(root, 'A');
const B = join(root, 'B');
const B2 = join(root, 'B2');
const B3 = join(root, 'B3');
const codePath = join(root, 'code.txt');
const agentArgs = ['--agent', 'fake:command', '--agent-command', process.execPath, '--agent-base-args', FIXTURE];

try {
  const P = await freePort();
  const Q = await freePort();
  const J = await freePort();

  console.log('== quickstart（令牌路径 + join 服务） ==');
  const qs = await runCli([
    'quickstart', '--dir', A, '--device', 'device-A',
    '--listen', `/ip4/127.0.0.1/tcp/${P}`,
    '--join-port', String(J), '--join-host', '127.0.0.1',
    '--code-file', codePath, '--no-service', ...agentArgs,
  ]);
  const qsJson = firstJson(qs.out);
  check('quickstart 成功（exit 0）', qs.code === 0 && qsJson?.ok === true, { code: qs.code });
  check('quickstart 产出加入令牌（不含主密钥）', typeof qsJson?.inviteToken === 'string' && qsJson.inviteToken.length > 100, { len: qsJson?.inviteToken?.length });
  check('quickstart 产出 join 端点', qsJson?.joinEndpoint === `http://127.0.0.1:${J}`, { joinEndpoint: qsJson?.joinEndpoint });
  check('quickstart 启用 join 服务并保留跨网回退 multiaddr', Array.isArray(qsJson?.multiaddrs) && qsJson.multiaddrs.length > 0, {});
  check('agent 探测结果落盘（本机 fake:command）', JSON.stringify((qsJson?.agents ?? []).map((a) => [a.name, a.kind])) === JSON.stringify([['fake', 'command']]), {});
  if (IS_WIN) skip('code-file 权限 0600', 'Windows 无 POSIX mode 语义');
  else check('code-file 权限 0600', (statSync(codePath).mode & 0o777) === 0o600, { mode: (statSync(codePath).mode & 0o777).toString(8) });

  // 启动 A：node 同时提供 libp2p 同步与 join 服务
  const anode1 = startCli(['node', '--dir', A, '--run-forever']);
  await waitFor(async () => eventLine(anode1, 'listening') !== null && eventLine(anode1, 'join-service') !== null, 30000);
  const aAddr = eventLine(anode1, 'listening')?.multiaddr;
  const jsvc = eventLine(anode1, 'join-service');
  check('A 已监听（libp2p + join 服务）', typeof aAddr === 'string' && jsvc?.port === J, { aAddr, jsvc });

  console.log('== join --token（B 一条命令，不复制主密钥） ==');
  const j1 = await runCli(['join', '--token', qsJson.inviteToken, '--dir', B, '--device', 'device-B', '--listen', `/ip4/127.0.0.1/tcp/${Q}`, '--no-service', ...agentArgs]);
  const j1Json = firstJson(j1.out);
  check('join --token 成功并等待批准', j1.code === 0 && j1Json?.ok === true && j1Json?.awaitingApproval === true, { code: j1.code, awaitingApproval: j1Json?.awaitingApproval });
  const bMaster = JSON.parse(readFileSync(join(B, 'master-key.json'), 'utf-8'));
  check('B 未持有主密钥私钥（master-key.json 无 privateKeyPkcs8）', bMaster.privateKeyPkcs8 === undefined, { keys: Object.keys(bMaster) });
  const bId = JSON.parse(readFileSync(join(B, 'store.jsonl.identity.json'), 'utf-8'));
  check('B 持有委派证书链（长度 2；issuer=device-A）', bId.certificateChain?.length === 2 && bId.certificate?.issuer?.deviceId === 'device-A', { chainLen: bId.certificateChain?.length, issuer: bId.certificate?.issuer?.deviceId });

  // 令牌一次性：同令牌再 join 到新目录 → 服务端 403 used
  const jReuse = await runCli(['join', '--token', qsJson.inviteToken, '--dir', B3, '--device', 'device-B3', '--listen', '/ip4/127.0.0.1/tcp/0', '--no-service', ...agentArgs]);
  check('令牌一次性：重复使用被拒', jReuse.code !== 0 && /used|令牌不可用/.test(jReuse.err + jReuse.out) && !existsSync(join(B3, 'fleet.config.json')), { code: jReuse.code });

  // legacy：旧共享主密钥 code 仍可用，且版本不符被拒
  const legacy = await runCli(['join', '--code-file', codePath, '--dir', B2, '--device', 'device-B2', '--listen', '/ip4/127.0.0.1/tcp/0', '--no-service', ...agentArgs]);
  const legacyJson = firstJson(legacy.out);
  check('legacy --code（共享主密钥）仍可用', legacy.code === 0 && legacyJson?.ok === true, { code: legacy.code });
  const badCodePath = join(root, 'code-bad.txt');
  writeFileSync(badCodePath, tamperSha(readFileSync(codePath, 'utf-8'), 'deadbeefdeadbeef'), { mode: 0o600 });
  const jBad = await runCli(['join', '--code-file', badCodePath, '--dir', join(root, 'B4'), '--device', 'device-B4', '--no-service', ...agentArgs]);
  check('legacy 版本不符被拒（不落地）', jBad.code !== 0 && /版本不一致/.test(jBad.err + jBad.out) && !existsSync(join(root, 'B4', 'fleet.config.json')), { code: jBad.code });

  console.log('== 首次连接：A 侧 pending 发现 B ==');
  const bwork1 = startCli(['worker', '--dir', B, '--run-forever', '--print-listen']);
  await waitFor(async () => eventLine(bwork1, 'listening') !== null, 30000);
  const bAddr = eventLine(bwork1, 'listening')?.multiaddrs?.[0];
  check('B 已监听（worker --print-listen）', typeof bAddr === 'string' && bAddr.includes('/p2p/'), { bAddr });
  const seen = await waitFor(async () => {
    const p = await runCli(['pending', '--dir', A]);
    const j = firstJson(p.out);
    return Array.isArray(j?.pending) && j.pending.includes('device-B');
  }, 45000);
  check('A pending 列出待批准的 device-B', seen, {});
  anode1.child.kill('SIGKILL');
  bwork1.child.kill('SIGKILL');

  console.log('== approve（A 批准） ==');
  const ap = await runCli(['approve', '--dir', A, '--device', 'device-B', '--addr', bAddr]);
  const apJson = firstJson(ap.out);
  check('approve 发出图上 grant 并登记对端地址', ap.code === 0 && apJson?.ok === true && typeof apJson?.grantId === 'string' && apJson?.peerRegistered === true, { grantId: apJson?.grantId });

  console.log('== 双向派活（真实 libp2p loopback） ==');
  const anode2 = startCli(['node', '--dir', A, '--submit', '2', '--target-agent', 'fake', '--expect-prefix', 'FAKE:', '--wait-sync-ms', '30000', '--timeout-ms', '40000', '--linger-ms', '3000']);
  await waitFor(async () => eventLine(anode2, 'listening') !== null, 30000);
  const bwork2 = startCli(['worker', '--dir', B, '--run-forever']);
  await waitExit(anode2, 60000);
  const a2 = lastJsonLine(anode2.state.out);
  check('A→B：2/2 完成且结果前缀匹配', a2?.submitted === 2 && a2?.done === 2 && a2?.resultsMatch === true, a2 ?? { stderr: anode2.state.err.slice(-200) });
  bwork2.child.kill('SIGKILL');

  const bnode = startCli(['node', '--dir', B, '--submit', '2', '--target-agent', 'fake', '--expect-prefix', 'FAKE:', '--wait-sync-ms', '30000', '--timeout-ms', '40000', '--linger-ms', '3000']);
  await waitFor(async () => eventLine(bnode, 'listening') !== null, 30000);
  const awork = startCli(['worker', '--dir', A, '--run-forever']);
  await waitExit(bnode, 60000);
  const b2 = lastJsonLine(bnode.state.out);
  check('B→A：2/2 完成且结果前缀匹配', b2?.submitted === 2 && b2?.done === 2 && b2?.resultsMatch === true, b2 ?? {});
  awork.child.kill('SIGKILL');

  console.log('== 两端 doctor 全绿 ==');
  const anode3 = startCli(['node', '--dir', A, '--run-forever']);
  const bnode3 = startCli(['node', '--dir', B, '--run-forever']);
  await waitFor(async () => eventLine(anode3, 'listening') !== null && eventLine(bnode3, 'listening') !== null, 30000);
  await sleep(4000);
  const docA = await runCli(['doctor', '--dir', A, '--json']);
  const docB = await runCli(['doctor', '--dir', B, '--json']);
  const dA = firstJson(docA.out);
  const dB = firstJson(docB.out);
  check('doctor(A) 无 FAIL', docA.code === 0 && dA?.ok === true, { failed: (dA?.checks ?? []).filter((c) => c.status === 'FAIL').map((c) => c.name) });
  check('doctor(B) 无 FAIL', docB.code === 0 && dB?.ok === true, { failed: (dB?.checks ?? []).filter((c) => c.status === 'FAIL').map((c) => c.name) });
  anode3.child.kill('SIGKILL');
  bnode3.child.kill('SIGKILL');

  console.log('== 密钥卫生 ==');
  const aMaster = JSON.parse(readFileSync(join(A, 'master-key.json'), 'utf-8'));
  const secret = aMaster.privateKeyPkcs8;
  const haystack = [qs.out, j1.out, j1.err, jReuse.out, jReuse.err, legacy.out, jBad.out, ap.out, docA.out, docB.out, anode1.state.out, bwork1.state.out, anode2.state.out, bnode.state.out].join('\n');
  check('主密钥私钥不出现在 B 侧/医生/命令输出', typeof secret === 'string' && secret.length > 0 && !haystack.includes(secret), {});
  check('B 的 doctor/身份不含主密钥私钥', !JSON.stringify(bMaster).includes(secret ?? '@@'), {});
} finally {
  killAll();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).map((r) => r.name);
console.log('== verify:fleet:quickstart ==');
console.log(`FLEET_SUMMARY ${JSON.stringify({ total: results.length, passed, failed, skipped })}`);
process.exit(failed.length === 0 ? 0 : 1);
