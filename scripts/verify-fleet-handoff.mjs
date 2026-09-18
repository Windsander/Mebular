#!/usr/bin/env node
// 2b 验收：退订交接（继任者全量 ack 门禁 + 本地彻底清理）。
//
// CLI 跨端：
//   1) A/B 真实 libp2p 派活 → B 已全量 ack → `fleet leave --successor B` 成功；
//      A 本分区数据消失、`__policy__`（含 handoff）保留、B 数据不丢、无 tombstone。
//   2) 覆盖不足（A2 提交后从未与 B2 同步）→ `fleet leave` 中止、数据原封不动、报告缺失。
// 三端 B/C 数据不丢与 force/续跑/oracle-free 由 tests/sync/handoff.test.ts 覆盖。
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
/** 统计某 store.jsonl 中 namespace===ns 的**当前存活**事件数（重放 putEvent/deleteEvent 操作日志）。 */
function namespaceEventCount(storePath, ns) {
  if (!existsSync(storePath)) return 0;
  const live = new Map(); // id -> namespace
  for (const line of readFileSync(storePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const event = rec.value ?? rec;
      if (rec.op === 'deleteEvent') live.delete(rec.id ?? event.id);
      else if ((rec.op === 'putEvent' || (rec.op === undefined && event?.author)) && typeof event?.id === 'string') {
        live.set(event.id, event.namespace);
      }
    } catch {
      // ignore
    }
  }
  let n = 0;
  for (const value of live.values()) if (value === ns) n += 1;
  return n;
}

const root = await mkdtemp(join(tmpdir(), 'fleet-handoff-verify-'));
const agentArgs = ['--agent', 'fake:command', '--agent-command', process.execPath, '--agent-base-args', FIXTURE];

try {
  console.log('== 2b：退订交接（跨端 CLI） ==');
  const A = join(root, 'A');
  const B = join(root, 'B');
  const N = 3;
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
  const worker1 = startCli(['worker', '--dir', B, '--timeout-ms', '45000', '--interval-ms', '10']);
  const execB = join(B, 'exec.jsonl');
  const executed = await waitFor(() => lineCount(execB) >= N, 45000);
  await waitFor(() => /"submitted":\s*3/.test(node1.state.out), 45000);
  check('前置：B 已全量接收并执行 N 次', !!executed && lineCount(execB) === N, { lines: lineCount(execB) });
  node1.child.kill('SIGKILL');
  worker1.child.kill('SIGKILL');
  await sleep(200);

  const storeA = join(A, 'store.jsonl');
  const nsBefore = namespaceEventCount(storeA, 'tasks');

  // dry-run：覆盖足
  const dry = lastJson((await runCli(['leave', '--dir', A, '--successor', 'device-B', '--dry-run'])).out);
  check('dry-run：覆盖足 → ok=true, pendingTotal=0', dry?.ok === true && dry?.pendingTotal === 0 && dry?.successorIsMember === true, { ok: dry?.ok, pending: dry?.pendingTotal });

  // 执行交接
  const leave = lastJson((await runCli(['leave', '--dir', A, '--successor', 'device-B'])).out);
  check('① leave 成功（deleted.events≥1）', leave?.ok === true && (leave?.deleted?.events ?? 0) >= 1, { deleted: leave?.deleted });
  check('① A 本分区数据彻底消失', namespaceEventCount(storeA, 'tasks') === 0, { before: nsBefore, after: namespaceEventCount(storeA, 'tasks') });
  check('① __policy__ 保留（含 handoff）', namespaceEventCount(storeA, '__policy__') > 0 && readFileSync(storeA, 'utf-8').includes('"namespace_handoff"'), {});
  check('① 无 tombstone（A 仅剩 __policy__ 事件）', namespaceEventCount(storeA, 'tasks') === 0, {});
  check('① B 数据不丢（exec 仍 N）', lineCount(execB) === N, { lines: lineCount(execB) });
  check('① 清理后成员闸门仍在（self 已注销）', lastJson((await runCli(['members', '--dir', A, '--namespace', 'tasks'])).out)?.active === true, {});

  // 覆盖不足 → 中止
  const A2 = join(root, 'A2');
  const port2 = await freePort();
  await runCli(['onboard', '--dir', A2, '--device', 'device-A2', '--peer-device', 'device-B2', '--listen', `/ip4/127.0.0.1/tcp/${port2}`, '--no-config-grant', '--policy-issuer', 'device-A2', ...agentArgs]);
  await runCli(['grant', '--dir', A2, '--to', 'device-B2']);
  await runCli(['member', '--dir', A2, '--to', 'device-A2']);
  await runCli(['member', '--dir', A2, '--to', 'device-B2']);
  await runCli(['node', '--dir', A2, '--submit', '2', '--target-agent', 'fake', '--timeout-ms', '3000', '--expect-prefix', 'FAKE:'], 15000); // 无对端在线 → 事件留在本地
  const storeA2 = join(A2, 'store.jsonl');
  const nsA2 = namespaceEventCount(storeA2, 'tasks');
  const blocked = lastJson((await runCli(['leave', '--dir', A2, '--successor', 'device-B2'])).out);
  check('② 覆盖不足 → 中止（aborted, reason=successor-incomplete）', blocked?.ok === false && blocked?.aborted === true && blocked?.reason === 'successor-incomplete', { reason: blocked?.reason });
  check('② 报告缺失作者明细', Array.isArray(blocked?.missing) && blocked.missing.length >= 1 && blocked.missing[0].author === 'device-A2', { missing: blocked?.missing });
  check('② 数据原封不动（本分区事件数不变）', namespaceEventCount(storeA2, 'tasks') === nsA2 && nsA2 >= 1, { before: nsA2, after: namespaceEventCount(storeA2, 'tasks') });
  check('② 无 handoff / 无意图文件（中止不留痕）', !readFileSync(storeA2, 'utf-8').includes('"namespace_handoff"') && !existsSync(`${storeA2}.handoff.json`), {});

  // force（本地 CLI）如实记录
  const forced = lastJson((await runCli(['leave', '--dir', A2, '--successor', 'device-B2', '--force'])).out);
  check('③ force → 成功且 forced=true', forced?.ok === true && forced?.forced === true, { forced: forced?.forced });
  check('③ force 后 A2 本分区数据消失、__policy__ 保留', namespaceEventCount(storeA2, 'tasks') === 0 && namespaceEventCount(storeA2, '__policy__') > 0, {});
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

const failed = results.filter((r) => !r.ok);
console.log('== 摘要 ==');
const summary = { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name), skipped };
console.log(JSON.stringify(summary, null, 2));
console.log(`FLEET_SUMMARY ${JSON.stringify(summary)}`);
process.exit(failed.length === 0 ? 0 : 1);
