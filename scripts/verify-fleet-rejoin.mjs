#!/usr/bin/env node
// 2c 验收：重订阅恢复（显式降水位）。
//
// CLI 跨端：A/B 派活（B 持全量历史）→ A leave（清理）→ A rejoin（reset）→ A/B 再同步 →
// A 历史完整拉回；B 数据不变；无 tombstone；__policy__ 保留。未授权重入 → 显式失败。
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
const lastJson = (t) => {
  const at = t.indexOf('{');
  if (at < 0) return null;
  try {
    return JSON.parse(t.slice(at));
  } catch {
    return null;
  }
};
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
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const lineCount = (p) => (existsSync(p) ? readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim()).length : 0);
/** 当前存活事件数（重放 putEvent/deleteEvent）。 */
function eventCount(storePath, ns) {
  if (!existsSync(storePath)) return 0;
  const live = new Map();
  for (const line of readFileSync(storePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const event = rec.value ?? rec;
      if (rec.op === 'deleteEvent') live.delete(rec.id ?? event.id);
      else if ((rec.op === 'putEvent' || (rec.op === undefined && event?.author)) && typeof event?.id === 'string') live.set(event.id, event.namespace);
    } catch {
      /* ignore */
    }
  }
  let n = 0;
  for (const v of live.values()) if (v === ns) n += 1;
  return n;
}
const hasTombstone = (storePath) =>
  existsSync(storePath) && readFileSync(storePath, 'utf-8').split('\n').some((l) => l.trim() && /tombstone/i.test(l));

const root = await mkdtemp(join(tmpdir(), 'fleet-rejoin-verify-'));
const agentArgs = ['--agent', 'fake:command', '--agent-command', process.execPath, '--agent-base-args', FIXTURE];

try {
  console.log('== 2c：重订阅恢复（跨端 CLI） ==');
  const A = join(root, 'A');
  const B = join(root, 'B');
  const N = 3;
  const storeA = join(A, 'store.jsonl');
  const storeB = join(B, 'store.jsonl');
  const execB = join(B, 'exec.jsonl');
  const port = await freePort();

  await runCli(['onboard', '--dir', A, '--device', 'device-A', '--peer-device', 'device-B', '--listen', `/ip4/127.0.0.1/tcp/${port}`, '--no-config-grant', '--policy-issuer', 'device-A', ...agentArgs]);
  await runCli(['grant', '--dir', A, '--to', 'device-B']);
  await runCli(['member', '--dir', A, '--to', 'device-A']);
  await runCli(['member', '--dir', A, '--to', 'device-B']);

  const node1 = startCli(['node', '--dir', A, '--submit', String(N), '--target-agent', 'fake', '--wait-sync-ms', '45000', '--timeout-ms', '45000', '--expect-prefix', 'FAKE:']);
  await waitFor(() => /listening/.test(node1.state.out), 15000);
  const addr = lastJson(node1.state.out.match(/\{[^\n]*listening[^\n]*\}/)?.[0] ?? '')?.multiaddr;
  check('A 已监听（multiaddr）', typeof addr === 'string' && addr.length > 0, { addr });

  await runCli(['onboard', '--dir', B, '--device', 'device-B', '--peer-device', 'device-A', '--peer-addr', addr, '--master-key', join(A, 'master-key.json'), ...agentArgs]);
  await runCli(['member', '--dir', B, '--to', 'device-B']);
  await runCli(['member', '--dir', B, '--to', 'device-A']);
  // B 授权 A（供 A 重入准入：A 需对 tasks 有生效授权）；B 因 A 的 grant 而被授权，可转授
  await runCli(['grant', '--dir', B, '--to', 'device-A']);
  const worker1 = startCli(['worker', '--dir', B, '--timeout-ms', '45000', '--interval-ms', '10']);
  const executed = await waitFor(() => lineCount(execB) >= N, 45000);
  await waitFor(() => /"submitted":\s*3/.test(node1.state.out), 45000);
  check('前置：B 已接收并执行 N 次', !!executed && lineCount(execB) === N, { lines: lineCount(execB) });
  node1.child.kill('SIGKILL');
  worker1.child.kill('SIGKILL');
  await sleep(200);

  const nsFull = eventCount(storeA, 'tasks');
  check('前置：A 持有该分区全量历史', nsFull >= N, { nsFull });

  // A 退订清理
  const leave = lastJson((await runCli(['leave', '--dir', A, '--successor', 'device-B'])).out);
  check('① A leave 成功且本分区清空（__policy__ 保留）', leave?.ok === true && eventCount(storeA, 'tasks') === 0 && eventCount(storeA, '__policy__') > 0, { deleted: leave?.deleted });

  // A rejoin（reset）
  const rejoin = lastJson((await runCli(['rejoin', '--dir', A, '--namespace', 'tasks'])).out);
  check('① A rejoin 成功（reset，准入通过）', rejoin?.ok === true && rejoin?.reset === true && rejoin?.authorized === true, rejoin);

  // A/B 再同步：B 向下修正并从头重发 → A 历史拉回
  const node2 = startCli(['node', '--dir', A, '--timeout-ms', '12000']);
  await waitFor(() => /listening/.test(node2.state.out), 15000);
  const worker2 = startCli(['worker', '--dir', B, '--timeout-ms', '12000', '--interval-ms', '10']);
  const restored = await waitFor(() => eventCount(storeA, 'tasks') >= nsFull, 25000);
  check('① A 历史完整拉回（与清理前一致）', !!restored && eventCount(storeA, 'tasks') === nsFull, { before: nsFull, after: eventCount(storeA, 'tasks') });
  check('① B 数据不受影响', lineCount(execB) === N && eventCount(storeB, 'tasks') >= nsFull, { execB: lineCount(execB), bTasks: eventCount(storeB, 'tasks') });
  check('① 无 tombstone + __policy__ 保留', !hasTombstone(storeA) && eventCount(storeA, '__policy__') > 0, {});
  node2.child.kill('SIGKILL');
  worker2.child.kill('SIGKILL');
  await sleep(100);

  // 未授权重入 → 显式失败
  const A2 = join(root, 'A2');
  await runCli(['onboard', '--dir', A2, '--device', 'device-A2', '--peer-device', 'device-B2', ...agentArgs]);
  const denied = lastJson((await runCli(['rejoin', '--dir', A2, '--namespace', 'tasks'])).out);
  check('② 未授权重入 → ok=false, reason=not-authorized（显式）', denied?.ok === false && denied?.reason === 'not-authorized', { reason: denied?.reason });
  check('② 无 reset 标记（失败不留痕）', !existsSync(`${join(A2, 'store.jsonl')}.rejoin.tasks.json`), {});
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

const failed = results.filter((r) => !r.ok);
console.log('== 摘要 ==');
const summary = { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name), skipped };
console.log(JSON.stringify(summary, null, 2));
console.log(`FLEET_SUMMARY ${JSON.stringify(summary)}`);
process.exit(failed.length === 0 ? 0 : 1);
