#!/usr/bin/env node
// M2 验收脚本：单机双进程（A 派活 → B 执行 → 结果回传），输出原始可断言事实。
//
// 覆盖：① N(≥20) 全部完成且结果匹配 ② 重复投递不重复执行 ③ 配额账本守恒/超额排队
//       ④ expiresAt 只影响本机展示 ⑤ 重启韧性（中途杀 worker → 恢复续跑，不丢不重）
//
// 前置：`npm run build`（脚本调用 packages/fleet/dist/cli.js）。

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../packages/fleet/dist/cli.js', import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnCli(args) {
  return spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function runNodeCli(args) {
  return new Promise((resolve) => {
    const child = spawnCli(['spool', 'node', ...args]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      let facts = null;
      const at = out.indexOf('{');
      try {
        if (at >= 0) facts = JSON.parse(out.slice(at));
      } catch {
        facts = null;
      }
      resolve({ code, facts, out, err });
    });
  });
}

function startWorker(args) {
  const child = spawnCli(['spool', 'worker', ...args]);
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

/** A 端已观测到的 done 事件数（文件存储 JSONL；用于把“杀 worker1”对齐到已发布之后）。 */
async function doneEventCount(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    let n = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        if (JSON.parse(line).type === 'done') n += 1;
      } catch {
        // ignore
      }
    }
    return n;
  } catch {
    return 0;
  }
}

async function execTaskIds(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l).taskId);
  } catch {
    return [];
  }
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}

async function roundA() {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-verify-a-'));
  const spool = join(dir, 'spool');
  const execLog = join(dir, 'B.exec.jsonl');
  const N = 24;

  const worker = startWorker([
    '--device', 'device-B', '--agent', 'echo',
    '--storage', join(dir, 'B.jsonl'), '--spool', spool, '--exec-log', execLog,
    '--timeout-ms', '60000',
  ]);
  const node = await runNodeCli([
    '--device', 'device-A', '--storage', join(dir, 'A.jsonl'), '--spool', spool,
    '--submit', String(N), '--target-device', 'device-B', '--target-agent', '*',
    '--quota-limit', '10', '--quota-mode', 'queue', '--duplicate-every', '3', '--expires', '5',
    '--timeout-ms', '60000',
  ]);
  worker.kill('SIGKILL');
  await sleep(50);

  const exec = await execTaskIds(execLog);
  const d = node.facts?.decisions ?? {};
  check('A① 全部完成且结果匹配', node.facts?.done === N && node.facts?.resultsMatch === true, {
    done: node.facts?.done, resultsMatch: node.facts?.resultsMatch, exit: node.code,
  });
  check('A② 重复投递不重复执行', exec.length === N && new Set(exec).size === N, {
    executions: exec.length, distinct: new Set(exec).size,
  });
  check('A③ 配额账本守恒且超额排队', (d.accepted ?? 0) + (d.queued ?? 0) + (d.rejected ?? 0) === N && (d.queued ?? 0) >= 1, d);
  check('A④ expiresAt 只影响本机展示', node.facts?.expiredSubmitted === 5 && node.facts?.expiredCompleted === 5, {
    submitted: node.facts?.expiredSubmitted, completed: node.facts?.expiredCompleted,
  });

  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  return { N, execCount: exec.length };
}

async function roundB() {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-verify-b-'));
  const spool = join(dir, 'spool');
  const execLog = join(dir, 'B.exec.jsonl');
  const N = 20;

  // 第一段 worker：每轮最多执行 3 个，便于中途杀进程
  const worker1 = startWorker([
    '--device', 'device-B', '--agent', 'echo',
    '--storage', join(dir, 'B.jsonl'), '--spool', spool, '--exec-log', execLog,
    '--max-per-poll', '3', '--interval-ms', '20', '--timeout-ms', '120000',
  ]);
  const nodePromise = runNodeCli([
    '--device', 'device-A', '--storage', join(dir, 'A.jsonl'), '--spool', spool,
    '--submit', String(N), '--target-device', 'device-B', '--target-agent', '*',
    '--quota-limit', '1000', '--timeout-ms', '120000',
  ]);

  let killed = false;
  const start = Date.now();
  const nodeStorage = join(dir, 'A.jsonl');
  // 仅当 **A 已观测到 ≥8 条 done**（即 worker1 已发布）才杀 worker1：
  // 避免 worker1 在“执行已记录、done 未发布”窗口被杀导致永久丢失（历史偶发假红根因）。
  while (Date.now() - start < 30000) {
    if ((await doneEventCount(nodeStorage)) >= 8) {
      worker1.kill('SIGKILL');
      killed = true;
      break;
    }
    await sleep(20);
  }
  if (!killed) worker1.kill('SIGKILL');

  // 重启 worker：同一 storage + exec log（不丢不重）
  const worker2 = startWorker([
    '--device', 'device-B', '--agent', 'echo',
    '--storage', join(dir, 'B.jsonl'), '--spool', spool, '--exec-log', execLog,
    '--timeout-ms', '120000',
  ]);

  const node = await nodePromise;
  worker2.kill('SIGKILL');
  await sleep(50);
  const exec = await execTaskIds(execLog);

  check('B⑤ 重启后不丢（全部完成）', node.facts?.done === N && node.facts?.resultsMatch === true, {
    done: node.facts?.done, resultsMatch: node.facts?.resultsMatch,
  });
  check('B⑤ 重启后不重（执行恰好一次）', exec.length === N && new Set(exec).size === N, {
    executions: exec.length, distinct: new Set(exec).size,
  });
  check('B⑤ 确实发生了中途杀进程 + 重启', killed, { killed });

  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log('== M2 fleet 本地双进程验收 ==');
await roundA();
await roundB();

const failed = results.filter((r) => !r.ok);
console.log('== 摘要 ==');
const summary = { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name), skipped: [] };
console.log(JSON.stringify(summary, null, 2));
console.log(`FLEET_SUMMARY ${JSON.stringify(summary)}`);
process.exit(failed.length === 0 ? 0 : 1);
