#!/usr/bin/env node
// 服务化验收：`fleet service`（D1–D4）+ 改名（D5）。
//
// - hermetic：status/logs/uninstall-未安装 的 CLI 契约（各平台可跑）。
// - macOS 真机 E2E：安装 fleet-node/fleet-worker 测试标签服务 → 心跳 → doctor → 派发任务成功 → 卸载。
// - 失败矩阵：坏配置启动失败 · 重复 install · 卸载未安装 · kill -9 后自拉 + 心跳陈旧可报告。
// 非 macOS：真机部分 SKIP（明列原因），hermetic 仍全跑。摘要行 FLEET_SUMMARY 含 skipped。
//
// 前置：npm run build。

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../packages/fleet/dist/cli.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../tests/fleet/fixtures/fake-agent.mjs', import.meta.url));
chmodSync(FIXTURE, 0o755);
const IS_DARWIN = process.platform === 'darwin';
const UID = String(process.getuid?.() ?? 0);

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
async function waitFor(fn, timeoutMs = 20000, pollMs = 100) {
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
function runCli(args, timeoutMs = 60000, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
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
function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
const readJsonSafe = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
};
const readTextSafe = (file) => {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
};
async function heartbeatOf(dir) {
  return readJsonSafe(join(dir, 'service.heartbeat'));
}
async function freshHeartbeat(dir, maxAge = 15000) {
  const hb = await heartbeatOf(dir);
  return hb && Date.now() - hb.ts <= maxAge ? hb : null;
}
const agentArgs = ['--agent', 'fake:command', '--agent-command', process.execPath, '--agent-base-args', FIXTURE];

const root = await mkdtemp(join(tmpdir(), 'fleet-service-'));
const svcEnv = { MEBULAR_SERVICE_HOME: join(root, 'home', '.mebular', 'services') };
const runSvc = (args, t = 60000) => runCli(args, t, svcEnv);

// F-HYGIENE-1：异常/信号退出清理（此前只删 temp，**从不 bootout**，故 macOS 上会残留
// `com.mebular.fleet-node/worker.test-*` 作业与 $TMPDIR/fleet-service-*）。
// 白名单：只认本脚本创建的测试标签；**绝不触碰真实作业**（如 com.mebular.mebular-serve*）。
const TEST_LABEL_RE = /^com\.mebular\.(fleet-node|fleet-worker)\.test-[0-9a-z]+(-bad)?$/;
const createdLabels = new Set();
function registerLabel(label) {
  if (TEST_LABEL_RE.test(label)) createdLabels.add(label);
  return label;
}
/** 同步有界等待（Node 主线程可用）：用于 bootout 后的收尾窗口。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeRoot() {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/** 白名单作业是否仍被 launchd 加载（单次 `launchctl list`，供有界轮询）。 */
function anyLabelLoaded(labels) {
  if (labels.length === 0) return false;
  const out = spawnSync('launchctl', ['list'], { encoding: 'utf-8' }).stdout ?? '';
  return labels.some((label) => out.includes(label));
}

/**
 * F-HYGIENE-1 跟补：删 temp 的**有界收敛**（总预算 ≤~3s，绝不无限等待）。
 * 被 bootout 的服务进程收尾时仍会写最后一笔心跳（如 `<root>/A/service.heartbeat`），
 * 因此「bootout → 立即 rmSync」会被**写回**而残留。做法：在固定预算内反复
 * 「删除 → 短暂等待 → 复查」，**仅当白名单作业已从 launchd 退场（写者已死）且
 * temp 未再重现**才提前收敛；预算耗尽则做最后一次删除。正常退出与
 * SIGINT/SIGTERM/SIGHUP 共用本函数，行为一致。
 */
function settleRemoveRoot(labels) {
  if (!IS_DARWIN) {
    removeRoot(); // 非 launchd：无被托管进程写回，一次删除即可
    return;
  }
  const watched = labels.filter((label) => TEST_LABEL_RE.test(label));
  const start = Date.now();
  const deadline = start + 3000;
  let stable = 0;
  while (Date.now() < deadline) {
    removeRoot();
    sleepSync(300);
    stable = existsSync(root) ? 0 : stable + 1;
    if (stable >= 1 && !anyLabelLoaded(watched)) break;
  }
  removeRoot(); // 最终删除（提前收敛或预算耗尽均执行）
}

/** 同步清理：kill→bootout 白名单内的测试标签 + 收敛删除 temp。任何分支都不抛。 */
function cleanupSync() {
  const labels = [...createdLabels];
  if (IS_DARWIN) {
    for (const label of labels) {
      if (!TEST_LABEL_RE.test(label)) continue; // 双保险：白名单外一律不 bootout/kill
      // 先 SIGKILL（经 launchd 按标签投递，无 PID 复用风险）——进程立即死亡，不会再写心跳；
      // 否则被 bootout 的进程收尾时仍会写最后一笔 `A/service.heartbeat`（有界窗口内追不上）。
      try {
        spawnSync('launchctl', ['kill', '9', `gui/${UID}/${label}`], { stdio: 'ignore' });
      } catch {
        // ignore
      }
      try {
        spawnSync('launchctl', ['bootout', `gui/${UID}/${label}`], { stdio: 'ignore' });
      } catch {
        // ignore
      }
    }
  }
  createdLabels.clear();
  settleRemoveRoot(labels);
}
let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  cleanupSync();
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    try {
      cleanupSync();
    } finally {
      process.exit(130);
    }
  });
}

try {
  console.log('== hermetic：service CLI 契约 ==');
  const H = join(root, 'home');
  await mkdir(H, { recursive: true });

  const st = lastJson((await runCli(['service', 'status', '--dir', join(root, 'nope'), '--home', H])).out);
  check(
    'service status 输出 {ok,services[]} 且含 fleet-node/fleet-worker（未注册）',
    st?.ok === true && st?.services?.map((s) => s.kind).join(',') === 'fleet-node,fleet-worker' && st.services.every((s) => s.registered === false),
    { kinds: st?.services?.map((s) => s.kind), registered: st?.services?.map((s) => s.registered) },
  );

  const logs = lastJson((await runCli(['service', 'logs', 'fleet-node', '--home', H, '--tail', '3'])).out);
  check('service logs 返回日志路径', typeof logs?.stdoutLog === 'string' && logs.stdoutLog.includes('fleet-node.out.log'), { stdoutLog: logs?.stdoutLog });

  const un = lastJson((await runCli(['service', 'uninstall', 'fleet-node', '--home', H])).out);
  check('uninstall 未安装 → 清晰提示（removed=false）', un?.ok === true && un?.removed === false && /未安装/.test(un?.note ?? ''), { note: un?.note });

  if (!IS_DARWIN) {
    skip('macOS 真机服务 E2E', `当前平台 ${process.platform}：真实服务管理不在本机跑（Linux/Windows 单元由 golden 测试覆盖；CI ubuntu 的运行器无 systemd --user）`);
    skip('失败矩阵（坏配置/kill -9 自拉）', '依赖真实服务管理器；golden + 幂等单测已覆盖命令序列');
  } else {
    // ---------------- macOS 真机 E2E ----------------
    console.log('== macOS 真机：fleet-node/fleet-worker 服务 ==');
    const A = join(root, 'A');
    const B = join(root, 'B');
    const labelNode = registerLabel(`com.mebular.fleet-node.test-${Date.now().toString(36)}`);
    const labelWorker = registerLabel(`com.mebular.fleet-worker.test-${Date.now().toString(36)}`);
    registerLabel(`${labelNode}-bad`); // 坏配置用例的标签（同样纳入白名单清理）
    const port = await freePort();
    const listen = `/ip4/127.0.0.1/tcp/${port}`;

    await runCli(['onboard', '--dir', A, '--device', 'device-A', '--peer-device', 'device-B', '--listen', listen, ...agentArgs]);

    // 1) 安装 fleet-node 服务：带 --submit + 长 wait-sync → 等 B 连入后派发（避免重装打断 B 的连接）
    const instNode = lastJson(
      (await runSvc(['service', 'install', 'fleet-node', '--dir', A, '--label', labelNode, '--sha', 'e2e-sha', '--home', H, '--extra', '--submit 1 --target-agent fake --expect-prefix FAKE: --wait-sync-ms 60000 --timeout-ms 45000'])).out,
    );
    check('install fleet-node：ok + 单元落盘 + SHA', instNode?.ok === true && instNode?.sha === 'e2e-sha' && existsSync(instNode.unitPath), { unitPath: instNode?.unitPath, sha: instNode?.sha });

    const hbA = await waitFor(() => freshHeartbeat(A), 20000);
    check('fleet-node 启动并写心跳（fresh）', !!hbA && hbA.role === 'node', { hb: hbA });

    const statusA = lastJson((await runSvc(['service', 'status', 'fleet-node', '--dir', A, '--home', H])).out)?.services?.[0];
    check('service status：registered + running + heartbeat.fresh + SHA', statusA?.registered === true && statusA?.running === true && statusA?.heartbeat?.fresh === true && statusA?.sha === 'e2e-sha', statusA);

    const doctorA = lastJson((await runSvc(['doctor', '--dir', A, '--json'])).out);
    check(
      'doctor：服务已注册 PASS + 心跳新鲜 PASS',
      doctorA?.checks?.some((c) => c.name === '服务已注册' && c.status === 'PASS') && doctorA?.checks?.some((c) => c.name === '心跳新鲜' && c.status === 'PASS'),
      { service: doctorA?.checks?.find((c) => c.name === '服务已注册'), heartbeat: doctorA?.checks?.find((c) => c.name === '心跳新鲜') },
    );

    // 读 A 服务日志拿 multiaddr → onboard B → 装 worker 服务
    const nodeLog = lastJson((await runSvc(['service', 'logs', 'fleet-node', '--tail', '20', '--home', H])).out);
    const addrMatch = /"multiaddr":"([^"]+)"/.exec((nodeLog?.stdout ?? []).join('\n'));
    const addr = addrMatch?.[1];
    check('A 服务已监听（从服务日志读到 multiaddr）', typeof addr === 'string' && addr.length > 0, { addr });

    if (addr) {
      await runCli(['onboard', '--dir', B, '--device', 'device-B', '--peer-device', 'device-A', '--peer-addr', addr, '--master-key', join(A, 'master-key.json'), ...agentArgs]);
      const instWorker = lastJson((await runSvc(['service', 'install', 'fleet-worker', '--dir', B, '--label', labelWorker, '--sha', 'e2e-sha', '--home', H])).out);
      check('install fleet-worker：ok + 单元落盘', instWorker?.ok === true && existsSync(instWorker.unitPath), { unitPath: instWorker?.unitPath });
      const hbB = await waitFor(() => freshHeartbeat(B), 20000);
      check('fleet-worker 启动并写心跳（fresh，role=worker）', !!hbB && hbB.role === 'worker', { hb: hbB });

      const execLog = join(B, 'exec.jsonl');
      const executed = await waitFor(() => existsSync(execLog) && readFileSync(execLog, 'utf-8').split('\n').filter((l) => l.trim()).length >= 1, 30000);
      check('派发任务成功：worker 执行 ≥1（fake agent）', !!executed, { executed });

      let aStdout = [];
      const doneLog = await waitFor(async () => {
        const l = lastJson((await runSvc(['service', 'logs', 'fleet-node', '--tail', '50', '--home', H])).out);
        aStdout = l?.stdout ?? [];
        return /"resultsMatch":true|"done":1/.test(aStdout.join('\n')) ? true : null;
      }, 60000);
      check('A 服务日志出现 done/resultsMatch（node 服务完成派发）', !!doneLog, { tail: aStdout.slice(-4) });

      // 重复 install（worker，幂等更新）——放在派发完成后，避免重启打断 in-flight 同步
      const reWorker = lastJson(
        (await runSvc(['service', 'install', 'fleet-worker', '--dir', B, '--label', labelWorker, '--sha', 'e2e-sha', '--home', H])).out,
      );
      check('重复 install：ok 且同 label（幂等更新）', reWorker?.ok === true && reWorker?.label === labelWorker, { label: reWorker?.label });

      // 失败矩阵：kill -9 → KeepAlive 自拉（新 pid + fresh）
      const beforePid = (await heartbeatOf(A))?.pid;
      try {
        if (beforePid) process.kill(beforePid, 'SIGKILL');
      } catch {
        // 心跳可能指向已退出进程；忽略
      }
      const restarted = await waitFor(async () => {
        const hb = await heartbeatOf(A);
        return hb && hb.pid !== beforePid && Date.now() - hb.ts < 15000 ? hb : null;
      }, 30000);
      check('kill -9 后服务被自拉（心跳 pid 变更且 fresh）', !!restarted, { beforePid, afterPid: restarted?.pid });

      // 失败矩阵：心跳陈旧被正确报告
      await writeFile(join(A, 'service.heartbeat'), JSON.stringify({ pid: 999999, ts: Date.now() - 60_000, role: 'node', sha: 'e2e-sha' }), { mode: 0o600 });
      const staleStatus = lastJson((await runSvc(['service', 'status', 'fleet-node', '--dir', A, '--home', H])).out)?.services?.[0];
      const staleDoctor = lastJson((await runSvc(['doctor', '--dir', A, '--json'])).out);
      check(
        '心跳陈旧：status.fresh=false 且 doctor 心跳新鲜 FAIL',
        staleStatus?.heartbeat?.fresh === false && staleDoctor?.checks?.some((c) => c.name === '心跳新鲜' && c.status === 'FAIL'),
        { fresh: staleStatus?.heartbeat?.fresh },
      );

      // 卸载（幂等 + 清除）
      const unNode = lastJson((await runSvc(['service', 'uninstall', 'fleet-node', '--home', H])).out);
      const unWorker = lastJson((await runSvc(['service', 'uninstall', 'fleet-worker', '--home', H])).out);
      check('uninstall：fleet-node/fleet-worker 均 removed=true', unNode?.removed === true && unWorker?.removed === true, { unNode, unWorker });
      await sleep(800);
      const gone = lastJson((await runSvc(['service', 'status', 'fleet-node', '--dir', A, '--home', H])).out)?.services?.[0];
      check('卸载后 status.registered=false', gone?.registered === false, { registered: gone?.registered });

      // 失败矩阵：坏配置启动失败（日志可查）——放在卸载之后，避免同 kind manifest 互相覆盖
      const badDir = join(root, 'bad');
      await mkdir(badDir, { recursive: true });
      await writeFile(join(badDir, 'fleet.config.json'), '{ broken', { mode: 0o600 });
      const instBad = lastJson((await runSvc(['service', 'install', 'fleet-node', '--dir', badDir, '--label', `${labelNode}-bad`, '--sha', 'e2e-sha', '--home', H])).out);
      const badErr = await waitFor(() => /config 非法|无法加载|error|Unexpected/i.test(readTextSafe(join(H, '.mebular', 'services', 'logs', 'fleet-node.err.log'))), 15000);
      check('坏配置：服务启动失败且 stderr 日志可查', instBad?.ok === true && !!badErr, { badErr });
      lastJson((await runSvc(['service', 'uninstall', 'fleet-node', '--home', H])).out);
    } else {
      check('A 服务监听（multiaddr）', false, { reason: 'no multiaddr in service log' });
    }
  }
} catch (error) {
  check('verify:fleet:service 未抛异常', false, { error: error?.message || String(error) });
} finally {
  // F-HYGIENE-1：bootout 本脚本创建的测试标签（白名单，绝不触碰真实作业）+ 删 temp。
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log('== 摘要 ==');
const summary = { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name), skipped };
console.log(JSON.stringify(summary, null, 2));
console.log(`FLEET_SUMMARY ${JSON.stringify(summary)}`);
process.exit(failed.length === 0 ? 0 : 1);
