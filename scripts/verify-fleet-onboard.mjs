#!/usr/bin/env node
// Step 1b 验收：设备上车（onboard → 双节点派活回传 → doctor 全绿）+ 失败矩阵。
//
// 全程 temp 目录、不写用户真实 home；用确定性 fake agent 可执行文件（禁用真实 bridge/OpenChamber/Hermes）。
// 摘要行：`FLEET_SUMMARY {...}`（含 skipped），供 verify:fleet:all 汇总。
//
// 前置：npm run build。

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onboardAgentDone } from './lib/acceptance-conditions.mjs';

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
if (IS_WIN) {
  skip('F2 0o644→FAIL 锚点', 'Windows 无 POSIX mode 语义；改为断言 doctor「主密钥权限」SKIP（见 ONBOARDING Windows）');
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
  // 脚本的 JSON 输出是**整段**对象（doctor/onboard/serve 行）；从头解析。
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

const root = await mkdtemp(join(tmpdir(), 'fleet-onboard-verify-'));

// 长驻进程（serve/worker）由脚本显式回收：即便断言抛错也不留下孤儿、不拖住 temp 目录清理。
let serveA = null;
let workB = null;
const killLongRunning = () => {
  for (const p of [serveA, workB]) {
    if (p?.child.exitCode === null && p?.child.signalCode === null) p.child.kill('SIGKILL');
  }
};

try {
  console.log('== Step 1b：onboard → 双节点派活 → doctor ==');
  const A = join(root, 'A');
  const B = join(root, 'B');
  const N = 3;
  // fake agent 一律经 process.execPath 调用（不依赖 shebang/可执行位，Windows 亦然）。
  const agentArgs = ['--agent', 'fake:command', '--agent-command', process.execPath, '--agent-base-args', FIXTURE];

  // --- happy path ---
  const onboardA = await runCli(['onboard', '--dir', A, '--device', 'device-A', '--peer-device', 'device-B', '--namespace', 'tasks', ...agentArgs]);
  const factsA = lastJson(onboardA.out);
  check('onboard A 成功且未创建过', onboardA.code === 0 && factsA?.ok === true && factsA?.alreadyOnboarded === false, { code: onboardA.code });
  if (IS_WIN) {
    check('主密钥/配置存在（Windows：ACL 边界，无 POSIX mode）', existsSync(join(A, 'master-key.json')) && existsSync(join(A, 'fleet.config.json')), {
      key: mode(join(A, 'master-key.json'))?.toString(8), config: mode(join(A, 'fleet.config.json'))?.toString(8),
    });
  } else {
    check('主密钥/配置权限 0600', mode(join(A, 'master-key.json')) === 0o600 && mode(join(A, 'fleet.config.json')) === 0o600, {
      key: mode(join(A, 'master-key.json'))?.toString(8), config: mode(join(A, 'fleet.config.json'))?.toString(8),
    });
  }

  // CI 稳定性：旧窗口是 timeout 40s / linger 30s。慢机上 3 个任务的「同步 → 执行 → 回传」可能逼近 40s，
  // 且 linger 结束后 A 会退出，doctor(B) 的「peer 可达 / 同步已收敛」就会把正常收尾误判成不可达。
  // 这里放宽到 timeout 60s / linger 90s：60s 给执行回传更宽的预算；linger 覆盖 doctor 自身的 60s 上限
  // 再加余量。脚本在 doctor 完成后立即 kill，所以正常与失败路径都不会因此变长。
  serveA = startCli(['node', '--dir', A, '--submit', String(N), '--target-agent', 'fake', '--wait-sync-ms', '30000', '--timeout-ms', '60000', '--linger-ms', '90000', '--expect-prefix', 'FAKE:']);
  await waitFor(async () => /listening/.test(serveA.state.out), 45000);
  const listen = lastJson(serveA.state.out.match(/\{[^\n]*listening[^\n]*\}/)?.[0] ?? '');
  const addr = listen?.multiaddr;
  check('A 已监听（打印 multiaddr）', typeof addr === 'string' && addr.length > 0, { addr });

  const onboardB = await runCli(['onboard', '--dir', B, '--device', 'device-B', '--peer-device', 'device-A', '--peer-addr', addr, '--master-key', join(A, 'master-key.json'), ...agentArgs]);
  check('onboard B（导入同一主密钥）成功', onboardB.code === 0 && lastJson(onboardB.out)?.ok === true, { code: onboardB.code });

  // CI 稳定性：worker 原先 `--timeout-ms 30000` 定时退出。CI 慢时它会在 A 收齐结果前退出：
  //   · done 事件只回传了一部分 → A 永远等不到 3/3 terminal；
  //   · 心跳停在退出时刻，doctor 随后看到 age≈45s 判「心跳陈旧 / peer 不可达」。
  // 改为 `--run-forever`：执行与回传期间心跳持续刷新，由本脚本在 doctor 完成后显式 kill。
  workB = startCli(['worker', '--dir', B, '--run-forever', '--interval-ms', '10']);
  const execLog = join(B, 'exec.jsonl');
  const executed = await waitFor(async () => existsSync(execLog) && lineCount(execLog) >= N, 75000);
  // F-FLAKE-1：等**完整断言条件**（submitted+done+resultsMatch 三者同时成立），而非只等 submitted
  const aDone = await waitFor(async () => onboardAgentDone(serveA.state.out), 75000);
  check('B 执行 N 次（fake agent）', executed && lineCount(execLog) === N, { lines: existsSync(execLog) ? lineCount(execLog) : 0 });

  // 先等 worker 心跳确实新鲜（判定阈值 15s，这里留 5s 余量到 10s），再跑 doctor：
  // doctor 在 worker 存活期间检查「心跳新鲜 / peer 可达 / 同步已收敛」，而不是等它退出后读陈旧文件。
  // 这里只等待前置条件，不放宽 doctor 的任何断言；等不到仍会让 doctor 如实 FAIL。
  const heartbeatFresh = await waitForFreshHeartbeat(B, 30000);
  const doctorB = await runCli(['doctor', '--dir', B, '--json']);
  const report = lastJson(doctorB.out);
  check('doctor(B) 全绿', doctorB.code === 0 && report?.ok === true, {
    ok: report?.ok,
    heartbeatFresh,
    skipped: report?.skipped,
    failed: (report?.checks ?? []).filter((c) => c.status === 'FAIL').map((c) => `${c.name}:${c.detail}`),
  });
  const KNOWN_SKIPS = ['config 权限', '主密钥权限', '服务已注册', '心跳新鲜', '对端订阅', 'peer 可达', '同步已收敛'];
  check(
    'doctor(B) skipped 无未知项，且「服务已注册」按 dir 明列 SKIP',
    (report?.skipped ?? []).every((s) => KNOWN_SKIPS.includes(s)) && (report?.skipped ?? []).includes('服务已注册'),
    { skipped: report?.skipped },
  );
  check('A 全部完成且结果前缀匹配', aDone && onboardAgentDone(serveA.state.out), {
    tail: serveA.state.out.split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 400),
  });

  // S7 密钥卫生：日志里搜不到主密钥私钥材料
  const key = JSON.parse(readFileSync(join(A, 'master-key.json'), 'utf-8'));
  const secret = key.privateKeyPkcs8;
  const haystack = serveA.state.out + serveA.state.err + workB.state.out + workB.state.err + doctorB.out + onboardA.out + onboardB.out;
  check('日志不含主密钥私钥材料（脱敏）', !haystack.includes(secret), {});

  // doctor 与日志检查都已结束（worker 全程存活）→ 这里才回收长驻进程。
  killLongRunning();
  await sleep(50);

  // --- 失败矩阵（每条附期望错误语义） ---
  console.log('== 失败矩阵 ==');

  // F1 主密钥文件缺失
  const F1 = join(root, 'F1');
  const f1 = await runCli(['onboard', '--dir', F1, '--device', 'device-X', '--master-key', join(root, 'nope.json')]);
  check('F1 主密钥文件缺失 → 非零退出 + 清晰错误', f1.code !== 0 && /master key|ENOENT|no such file/i.test(f1.err + f1.out), { code: f1.code });

  // F2 主密钥权限过宽
  const F2 = join(root, 'F2');
  await runCli(['onboard', '--dir', F2, '--device', 'device-Y', ...agentArgs]);
  chmodSync(join(F2, 'master-key.json'), 0o644);
  const f2 = await runCli(['doctor', '--dir', F2, '--json']);
  const f2r = lastJson(f2.out);
  if (IS_WIN) {
    check('F2 主密钥权限：Windows → SKIP（不假 FAIL）', f2r?.checks?.some((c) => c.name === '主密钥权限' && c.status === 'SKIP'), { code: f2.code });
  } else {
    check('F2 主密钥权限过宽 → doctor FAIL(主密钥权限) + hint', f2.code !== 0 && f2r?.checks?.some((c) => c.name === '主密钥权限' && c.status === 'FAIL' && /chmod 600/.test(c.hint ?? '')), { code: f2.code });
  }

  // F3 主密钥文件损坏
  const F3 = join(root, 'F3');
  const badKey = join(root, 'bad-key.json');
  writeFileSync(badKey, '{ not a key', { mode: 0o600 });
  const f3 = await runCli(['onboard', '--dir', F3, '--device', 'device-Z', '--master-key', badKey]);
  check('F3 主密钥文件损坏 → 非零退出 + 清晰错误', f3.code !== 0 && /invalid|JSON|形状|parse/i.test(f3.err + f3.out), { code: f3.code });

  // F4 上车即自订阅（零门槛）
  const F4 = join(root, 'F4');
  await runCli(['onboard', '--dir', F4, '--device', 'device-Q', ...agentArgs]);
  const f4 = await runCli(['doctor', '--dir', F4, '--json']);
  const f4r = lastJson(f4.out);
  check('F4 上车即订阅 → doctor PASS(namespace 订阅)', f4.code === 0 && f4r?.checks?.some((c) => c.name === 'namespace 订阅' && c.status === 'PASS'), { code: f4.code });

  // F5 peer 不可达
  const F5 = join(root, 'F5');
  await runCli(['onboard', '--dir', F5, '--device', 'device-R', '--peer-device', 'device-S', '--peer-addr', '/ip4/127.0.0.1/tcp/1/p2p/12D3KooWDummy', ...agentArgs]);
  const f5 = await runCli(['doctor', '--dir', F5, '--json'], 20000);
  const f5r = lastJson(f5.out);
  check('F5 peer 不可达 → doctor FAIL(peer 可达)', f5.code !== 0 && f5r?.checks?.some((c) => c.name.startsWith('peer 可达') && c.status === 'FAIL'), { code: f5.code });

  // F6 端口占用
  const holder = net.createServer();
  await new Promise((r) => holder.listen(0, '127.0.0.1', () => r()));
  const heldPort = holder.address().port;
  const F6 = join(root, 'F6');
  await runCli(['onboard', '--dir', F6, '--device', 'device-T', '--listen', `/ip4/127.0.0.1/tcp/${heldPort}`, ...agentArgs]);
  const f6 = await runCli(['node', '--dir', F6, '--timeout-ms', '3000'], 20000);
  check('F6 端口占用 → serve 非零退出 + 错误', f6.code !== 0 && (f6.err + f6.out).length > 0, { code: f6.code });
  await new Promise((r) => holder.close(() => r()));

  // F7 配置损坏
  const F7 = join(root, 'F7');
  mkdirSync(F7, { recursive: true });
  writeFileSync(join(F7, 'fleet.config.json'), '{ broken', { mode: 0o600 });
  const f7 = await runCli(['doctor', '--dir', F7, '--json']);
  const f7r = lastJson(f7.out);
  check('F7 配置损坏 → doctor FAIL(config)', f7.code !== 0 && f7r?.checks?.[0]?.name === 'config' && f7r.checks[0].status === 'FAIL', { code: f7.code });
} finally {
  killLongRunning();
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
  return readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim() !== '').length;
}
/**
 * 等常驻 worker 的心跳落到「明显新鲜」区间再跑 doctor。
 * `service/dist` 的判定阈值是 15s（`HEARTBEAT_DEFAULT_MAX_AGE_MS`），心跳每 5s 刷新一次；
 * 这里要求 age ≤ 10s，留 5s 余量吸收 CI 的调度抖动，但不改变 doctor 自身的判定。
 */
async function waitForFreshHeartbeat(dir, timeoutMs = 30000) {
  const heartbeatFile = join(dir, 'service.heartbeat');
  return waitFor(() => {
    try {
      const record = JSON.parse(readFileSync(heartbeatFile, 'utf-8'));
      return typeof record.ts === 'number' && Date.now() - record.ts <= 10000;
    } catch {
      return false;
    }
  }, timeoutMs);
}
