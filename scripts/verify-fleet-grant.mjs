#!/usr/bin/env node
// G1 验收：把「配置白名单授权」升级为「图上授权为主」——A 只靠 namespace_grant（无配置白名单）
// 仍能派活给 B；签 namespace_revoke 后 B 拿不到新事件；两者皆无 → 未授权。
// 失败矩阵新增：未授权设备自授不生效（R-a）；撤销后复用旧 grantId 不恢复（R-d）。
//
// 全程 temp 目录、确定性 fake agent；摘要行 `FLEET_SUMMARY {...}`（含 skipped）。
// 前置：npm run build。

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../packages/fleet/dist/cli.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../tests/fleet/fixtures/fake-agent.mjs', import.meta.url));
const REPLAY = fileURLToPath(new URL('../tests/fleet/fixtures/replay-grant.mjs', import.meta.url));
chmodSync(FIXTURE, 0o755);

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
if (process.platform === 'win32') {
  // fake-agent 依赖 POSIX shebang 可执行位；Windows 见 ONBOARDING.md caveat。
  skip('fake-agent 可执行位', 'Windows 无 shebang 可执行位；改用 command=node + baseArgs（见 ONBOARDING.md）');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, pollMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}
function lastJson(text) {
  const at = text.indexOf('{');
  if (at < 0) return null;
  try {
    return JSON.parse(text.slice(at));
  } catch {
    return null;
  }
}
function runCli(args, timeoutMs = 60000) {
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
function startCli(args) {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { out: '', err: '' };
  child.stdout.on('data', (d) => (state.out += d));
  child.stderr.on('data', (d) => (state.err += d));
  return { child, state };
}
async function freePort() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = server.address().port;
  await new Promise((r) => server.close(() => r()));
  return port;
}
function tcpOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(300);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const root = await mkdtemp(join(tmpdir(), 'fleet-grant-verify-'));
const agentArgs = ['--agent', 'fake:command', '--agent-command', FIXTURE];

try {
  console.log('== G1：图上授权为主（仅 grant / 撤销） ==');
  const A = join(root, 'A');
  const B = join(root, 'B');
  const N = 3;
  const port = await freePort();
  const listen = `/ip4/127.0.0.1/tcp/${port}`;

  // A：登记对端 B 的地址路径，但**不给配置白名单**；A 自任 bootstrap 签发者（配置白名单=bootstrap）。
  const onboardA = await runCli([
    'onboard', '--dir', A, '--device', 'device-A', '--peer-device', 'device-B',
    '--listen', listen, '--no-config-grant', '--policy-issuer', 'device-A', ...agentArgs,
  ]);
  const cfgA = JSON.parse(readFileSync(join(A, 'fleet.config.json'), 'utf-8'));
  check(
    'onboard A：登记对端 B 但无配置白名单（peerNamespacePolicy={}）',
    onboardA.code === 0 && cfgA.peers?.[0]?.device === 'device-B' && Object.keys(cfgA.peerNamespacePolicy ?? {}).length === 0,
    { peers: cfgA.peers?.map((p) => p.device), policy: cfgA.peerNamespacePolicy },
  );
  check('主密钥/配置权限 0600', mode(join(A, 'master-key.json')) === 0o600 && mode(join(A, 'fleet.config.json')) === 0o600, {});

  // 默认拒绝：无 grant 前 doctor namespace FAIL
  const pre = lastJson((await runCli(['doctor', '--dir', A, '--json'])).out);
  check('仅登记、无 grant/白名单 → doctor namespace FAIL（默认拒绝）', pre?.ok === false && pre?.checks?.some((c) => c.name === 'namespace 已授权' && c.status === 'FAIL'), {});

  // A 签 grant（图上授权）
  const g = await runCli(['grant', '--dir', A, '--to', 'device-B']);
  const gFacts = lastJson(g.out);
  check('A 签发 namespace_grant 成功（得到 grantId）', g.code === 0 && typeof gFacts?.grantId === 'string' && gFacts.grantId.length > 0, { grantId: gFacts?.grantId });

  // 仅图上 grant → doctor namespace PASS（且 peer 可达 SKIP 因未提供 addr）
  const d1 = lastJson((await runCli(['doctor', '--dir', A, '--json'])).out);
  const ns1 = d1?.checks?.find((c) => c.name === 'namespace 已授权');
  check('仅图上 grant（无配置白名单）→ doctor namespace PASS', ns1?.status === 'PASS' && /device-B:ok/.test(ns1?.detail ?? ''), { detail: ns1?.detail, skipped: d1?.skipped });
  check('doctor skipped 明列 peer 可达（无 addr）', Array.isArray(d1?.skipped) && d1.skipped.includes('peer 可达'), { skipped: d1?.skipped });

  // 启动 A serve（图上授权应让 B 收到任务）
  const serveA = startCli(['serve', '--dir', A, '--submit', String(N), '--target-agent', 'fake', '--wait-sync-ms', '30000', '--timeout-ms', '40000', '--linger-ms', '30000', '--expect-prefix', 'FAKE:']);
  await waitFor(async () => /listening/.test(serveA.state.out), 15000);
  const addr = lastJson(serveA.state.out.match(/\{[^\n]*listening[^\n]*\}/)?.[0] ?? '')?.multiaddr;
  check('A 已监听（multiaddr）', typeof addr === 'string' && addr.length > 0, { addr });

  const onboardB = await runCli(['onboard', '--dir', B, '--device', 'device-B', '--peer-device', 'device-A', '--peer-addr', addr, '--master-key', join(A, 'master-key.json'), ...agentArgs]);
  check('onboard B（导入同一主密钥）成功', onboardB.code === 0 && lastJson(onboardB.out)?.ok === true, {});

  const workB = startCli(['work', '--dir', B, '--timeout-ms', '30000', '--interval-ms', '10']);
  const execLog = join(B, 'exec.jsonl');
  const gotN = await waitFor(async () => existsSync(execLog) && lineCount(execLog) >= N, 25000);
  const aDone = await waitFor(async () => /"submitted":\s*3/.test(serveA.state.out), 25000);
  check('仅图上 grant：B 收到并执行 N 次（fake agent）', gotN && lineCount(execLog) === N, { lines: existsSync(execLog) ? lineCount(execLog) : 0 });
  check('仅图上 grant：A 收齐结果 resultsMatch', aDone && /"done":\s*3/.test(serveA.state.out) && /"resultsMatch":\s*true/.test(serveA.state.out), {});

  // S7：日志脱敏
  const secret = JSON.parse(readFileSync(join(A, 'master-key.json'), 'utf-8')).privateKeyPkcs8;
  const haystack = serveA.state.out + serveA.state.err + workB.state.out + workB.state.err + g.out + onboardA.out + onboardB.out;
  check('日志不含主密钥私钥材料（脱敏）', !haystack.includes(secret), {});

  serveA.child.kill('SIGKILL');
  workB.child.kill('SIGKILL');
  await waitFor(async () => !(await tcpOpen(port)), 5000);

  // 撤销（A 离线执行；R-d 恢复必须用新 grantId）
  const beforeRevoke = lineCount(execLog);
  const rv = await runCli(['revoke', '--dir', A, '--grant-id', gFacts.grantId]);
  check('A 签发 namespace_revoke 成功', rv.code === 0 && lastJson(rv.out)?.grantId === gFacts.grantId, {});

  const d2 = lastJson((await runCli(['doctor', '--dir', A, '--json'])).out);
  const ns2 = d2?.checks?.find((c) => c.name === 'namespace 已授权');
  check('撤销后 → doctor namespace FAIL 且 hint 指向新 grantId（R-d）', ns2?.status === 'FAIL' && /新 grantId|R-d/.test(ns2?.hint ?? ''), { hint: ns2?.hint });

  // 第二轮回合：A 再派活，B 在线也拿不到新事件
  const workB2 = startCli(['work', '--dir', B, '--timeout-ms', '12000', '--interval-ms', '10']);
  const serveA2 = startCli(['serve', '--dir', A, '--submit', '2', '--target-agent', 'fake', '--wait-sync-ms', '5000', '--timeout-ms', '6000', '--expect-prefix', 'FAKE:']);
  await waitFor(async () => /listening/.test(serveA2.state.out), 15000);
  await sleep(9000);
  const afterRevoke = lineCount(execLog);
  check('撤销后：B 拿不到新事件（exec 数不增）', afterRevoke === beforeRevoke, { before: beforeRevoke, after: afterRevoke });
  serveA2.child.kill('SIGKILL');
  workB2.child.kill('SIGKILL');
  await sleep(50);

  // 失败矩阵 G-F1：未授权设备自授不生效（R-a）
  const C = join(root, 'C');
  await runCli(['onboard', '--dir', C, '--device', 'device-C', '--peer-device', 'device-A', '--no-config-grant', '--master-key', join(A, 'master-key.json'), ...agentArgs]);
  const cg = await runCli(['grant', '--dir', C, '--to', 'device-A']);
  const dc = lastJson((await runCli(['doctor', '--dir', C, '--json'])).out);
  check(
    'G-F1 未授权设备自授不生效（R-a）：grant 已签发但不被采纳 → namespace FAIL',
    cg.code === 0 && typeof lastJson(cg.out)?.grantId === 'string' && dc?.checks?.some((c) => c.name === 'namespace 已授权' && c.status === 'FAIL'),
    {},
  );

  // 失败矩阵 G-F2：撤销后复用旧 grantId 不恢复（R-d）——用夹具以旧 grantId 重放一条 grant
  const replayRun = await new Promise((resolve) => {
    const child = spawn(process.execPath, [REPLAY, '--dir', A, '--grant-id', gFacts.grantId, '--subject', 'device-B'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
  const d3 = lastJson((await runCli(['doctor', '--dir', A, '--json'])).out);
  const ns3 = d3?.checks?.find((c) => c.name === 'namespace 已授权');
  check(
    'G-F2 撤销后复用旧 grantId 重新授予 → 不恢复（R-d）',
    replayRun.code === 0 && lastJson(replayRun.out)?.grantId === gFacts.grantId && ns3?.status === 'FAIL',
    { replay: lastJson(replayRun.out)?.grantId, status: ns3?.status },
  );
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

const failed = results.filter((r) => !r.ok);
console.log('== 摘要 ==');
const summary = { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name), skipped };
console.log(JSON.stringify(summary, null, 2));
console.log(`FLEET_SUMMARY ${JSON.stringify(summary)}`);
process.exit(failed.length === 0 ? 0 : 1);

function mode(path) {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return -1;
  }
}
function lineCount(path) {
  try {
    return readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim() !== '').length;
  } catch {
    return 0;
  }
}
