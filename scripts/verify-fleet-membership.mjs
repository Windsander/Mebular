#!/usr/bin/env node
// M1–M3 验收：订阅 = 成员资格（图上持久记录 + 裁剪链 + 注销）。
//
// 跨端 E2E（真实 libp2p loopback + fake agent）：
//   ① 成员 ∧ 授权 → B 接到任务并回传；
//   ④ A 注销 B → B 不再拿到**新**事件（旧数据清理属 2b，本轮不声称实现）。
// 失败矩阵/显式拒绝/伪造在 core jest 与 verify 脚本中覆盖。
//
// 前置：npm run build。摘要行 FLEET_SUMMARY（含 skipped）。

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../packages/fleet/dist/cli.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../tests/fleet/fixtures/fake-agent.mjs', import.meta.url));
chmodSync(FIXTURE, 0o755);

const results = [];
const skipped = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 30000, pollMs = 50) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
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
const lineCount = (p) => (existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim()).length : 0);

const root = await mkdtemp(join(tmpdir(), 'fleet-membership-verify-'));
const agentArgs = ['--agent', 'fake:command', '--agent-command', process.execPath, '--agent-base-args', FIXTURE];

try {
  console.log('== M1–M3：成员资格（跨端） ==');
  const A = join(root, 'A');
  const B = join(root, 'B');
  const N = 3;
  const execB = join(B, 'exec.jsonl');
  const port = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });

  await runCli(['onboard', '--dir', A, '--device', 'device-A', '--peer-device', 'device-B', '--listen', `/ip4/127.0.0.1/tcp/${port}`, '--no-config-grant', '--policy-issuer', 'device-A', ...agentArgs]);
  await runCli(['grant', '--dir', A, '--to', 'device-B']);
  // 成员：A 视图 B 在册（可发）+ A 自证在册（doctor）；B 侧对称
  const mA1 = lastJson((await runCli(['member', '--dir', A, '--to', 'device-A'])).out);
  const mA2 = lastJson((await runCli(['member', '--dir', A, '--to', 'device-B'])).out);
  check('A 声明成员（自证 + B）', mA1?.ok === true && mA2?.ok === true && mA2.active === true, { a: mA1?.active, b: mA2?.active });
  const membersA = lastJson((await runCli(['members', '--dir', A, '--namespace', 'tasks'])).out);
  check('members 查询：生效成员（∩ 授权）含 device-B', membersA?.active === true && (membersA?.members ?? []).includes('device-B'), { members: membersA?.members });
  const doctorA = lastJson((await runCli(['doctor', '--dir', A, '--json'])).out);
  check('doctor：namespace 成员资格 PASS（本机在册）', doctorA?.checks?.some((c) => c.name === 'namespace 成员资格' && c.status === 'PASS'), {
    membership: doctorA?.checks?.find((c) => c.name === 'namespace 成员资格'),
  });

  // A 起服务（等待 B 连入后派发）
  const node1 = startCli(['node', '--dir', A, '--submit', String(N), '--target-agent', 'fake', '--wait-sync-ms', '45000', '--timeout-ms', '45000', '--expect-prefix', 'FAKE:']);
  await waitFor(() => /listening/.test(node1.state.out), 15000);
  const addr = lastJson(node1.state.out.match(/\{[^\n]*listening[^\n]*\}/)?.[0] ?? '')?.multiaddr;
  check('A 已监听（multiaddr）', typeof addr === 'string' && addr.length > 0, { addr });
  if (!addr) throw new Error('no multiaddr');

  await runCli(['onboard', '--dir', B, '--device', 'device-B', '--peer-device', 'device-A', '--peer-addr', addr, '--master-key', join(A, 'master-key.json'), ...agentArgs]);
  await runCli(['member', '--dir', B, '--to', 'device-B']);
  await runCli(['member', '--dir', B, '--to', 'device-A']);

  const worker1 = startCli(['worker', '--dir', B, '--timeout-ms', '40000', '--interval-ms', '10']);
  const executed = await waitFor(() => lineCount(execB) >= N, 45000);
  const aDone = await waitFor(() => /"submitted":\s*3/.test(node1.state.out), 45000);
  check('① 成员 ∧ 授权 → B 执行 N 次', !!executed && lineCount(execB) === N, { lines: lineCount(execB) });
  check('① A 收齐结果 resultsMatch', aDone && /"done":\s*3/.test(node1.state.out) && /"resultsMatch":\s*true/.test(node1.state.out), {});
  node1.child.kill('SIGKILL');
  worker1.child.kill('SIGKILL');
  await sleep(150);

  // 回合 2：A 注销 B → 新事件不再到达
  const before = lineCount(execB);
  const leave = lastJson((await runCli(['member', '--dir', A, '--to', 'device-B', '--leave'])).out);
  check('④ A 注销 device-B', leave?.ok === true && leave.active === false, { active: leave?.active });
  const membersAfter = lastJson((await runCli(['members', '--dir', A, '--namespace', 'tasks'])).out);
  check('④ 注销后 members 不再含 device-B', membersAfter?.active === true && !(membersAfter?.members ?? []).includes('device-B'), { members: membersAfter?.members });

  // 回合 2 让 A 真正在线（换端口重挂载），确保「不收到」是**成员资格**导致的，而非 A 没起来
  const port2 = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const pr = srv.address().port;
      srv.close(() => resolve(pr));
    });
  });
  await runCli(['onboard', '--dir', A, '--device', 'device-A', '--peer-device', 'device-B', '--listen', `/ip4/127.0.0.1/tcp/${port2}`, '--no-config-grant', '--policy-issuer', 'device-A', ...agentArgs]);
  const node2 = startCli(['node', '--dir', A, '--submit', '2', '--target-agent', 'fake', '--wait-sync-ms', '20000', '--timeout-ms', '10000', '--expect-prefix', 'FAKE:']);
  await waitFor(() => /listening/.test(node2.state.out), 15000);
  const addr2 = lastJson(node2.state.out.match(/\{[^\n]*listening[^\n]*\}/)?.[0] ?? '')?.multiaddr;
  check('④ A 重新在线（新 multiaddr）', typeof addr2 === 'string' && addr2.length > 0, { addr2 });
  if (addr2) {
    await runCli(['onboard', '--dir', B, '--device', 'device-B', '--peer-device', 'device-A', '--peer-addr', addr2, '--master-key', join(A, 'master-key.json'), ...agentArgs]);
  }
  const worker2 = startCli(['worker', '--dir', B, '--timeout-ms', '20000', '--interval-ms', '10']);
  const aReported = await waitFor(() => /"submitted":\s*2/.test(node2.state.out), 30000);
  await sleep(3000);
  check('④ 注销后：A 在线且已完成派发等待，但 B 未收到新事件（exec 不增）', aReported && lineCount(execB) === before, { before, after: lineCount(execB), aReported });
  node2.child.kill('SIGKILL');
  worker2.child.kill('SIGKILL');
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

const failed = results.filter((r) => !r.ok);
console.log('== 摘要 ==');
const summary = { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name), skipped };
console.log(JSON.stringify(summary, null, 2));
console.log(`FLEET_SUMMARY ${JSON.stringify(summary)}`);
process.exit(failed.length === 0 ? 0 : 1);
