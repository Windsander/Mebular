#!/usr/bin/env node
// 一键上车（Stage 1）验收：quickstart（A 一条命令）→ join（B 一条命令）→ pending → approve → 双向派活 → 两端 doctor。
//
// 全程 temp 目录 + 真实 libp2p loopback（127.0.0.1）；确定性 fake agent（禁用真实 bridge/Hermes）。
// 摘要行：`FLEET_SUMMARY {...}`，供 verify:fleet:all 汇总。前置：npm run build。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
/** 取最后一行可解析的 JSON（node 会先打 listening、后打 result）。 */
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
/** 取本机监听 multiaddr（node → `multiaddr`；worker --print-listen → `multiaddrs[]`）。 */
function listeningAddr(ctx) {
  for (const line of ctx.state.out.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const j = JSON.parse(line);
      if (j.event !== 'listening') continue;
      if (typeof j.multiaddr === 'string') return j.multiaddr;
      if (Array.isArray(j.multiaddrs) && j.multiaddrs.length > 0) return j.multiaddrs[0];
    } catch {
      /* not json */
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

const root = await mkdtemp(join(tmpdir(), 'fleet-quickstart-verify-'));
const A = join(root, 'A');
const B = join(root, 'B');
const B2 = join(root, 'B2');
const agentArgs = ['--agent', 'fake:command', '--agent-command', process.execPath, '--agent-base-args', FIXTURE];

try {
  const P = await freePort();
  const Q = await freePort();
  const codePath = join(root, 'code.txt');

  console.log('== quickstart（A 一条命令） ==');
  const qs = await runCli([
    'quickstart', '--dir', A, '--device', 'device-A',
    '--listen', `/ip4/127.0.0.1/tcp/${P}`,
    '--code-file', codePath, '--no-service', ...agentArgs,
  ]);
  const qsJson = firstJson(qs.out);
  check('quickstart 成功（exit 0）', qs.code === 0 && qsJson?.ok === true, { code: qs.code });
  check('quickstart 产出加入码（内联 base64）', typeof qsJson?.code === 'string' && qsJson.code.length > 100, { len: qsJson?.code?.length });
  check('quickstart 产出可达 multiaddr', Array.isArray(qsJson?.multiaddrs) && qsJson.multiaddrs.length > 0, { multiaddrs: qsJson?.multiaddrs });
  check('quickstart 未启用配置授权（默认拒绝，走图上 grant）', (() => {
    const cfg = JSON.parse(readFileSync(join(A, 'fleet.config.json'), 'utf-8'));
    return JSON.stringify(cfg.peerNamespacePolicy) === '{}';
  })(), {});
  check('quickstart 默认设备目录/主机名默认未强依赖（显式给出即用）', existsSync(join(A, 'fleet.config.json')), {});
  check('agent 探测结果落盘（本机 fake:command）', JSON.stringify((qsJson?.agents ?? []).map((a) => [a.name, a.kind])) === JSON.stringify([['fake', 'command']]), { agents: (qsJson?.agents ?? []).map((a) => `${a.name}:${a.kind}`) });
  if (IS_WIN) skip('code-file 权限 0600', 'Windows 无 POSIX mode 语义');
  else {
    const mode = statSync(codePath).mode & 0o777;
    check('code-file 权限 0600', mode === 0o600, { mode: mode.toString(8) });
  }

  console.log('== join（B 一条命令） ==');
  const j1 = await runCli(['join', '--dir', B, '--code-file', codePath, '--device', 'device-B', '--listen', `/ip4/127.0.0.1/tcp/${Q}`, '--no-service', ...agentArgs]);
  const j1Json = firstJson(j1.out);
  check('join 成功并等待批准', j1.code === 0 && j1Json?.ok === true && j1Json?.awaitingApproval === true, { code: j1.code, awaitingApproval: j1Json?.awaitingApproval });
  check('join 首次 not alreadyJoined', j1Json?.alreadyJoined === false, { alreadyJoined: j1Json?.alreadyJoined });
  check('join 导入对端地址（跨网回退）', (() => {
    const cfg = JSON.parse(readFileSync(join(B, 'fleet.config.json'), 'utf-8'));
    return cfg.peers?.length === 1 && cfg.peers[0].device === 'device-A' && typeof cfg.peers[0].addr === 'string';
  })(), {});

  // join 幂等（红→绿点 1：若 onboard 覆盖身份/重复报错则此处红）
  const j2 = await runCli(['join', '--dir', B, '--code-file', codePath, '--device', 'device-B', '--listen', `/ip4/127.0.0.1/tcp/${Q}`, '--no-service', ...agentArgs]);
  const j2Json = firstJson(j2.out);
  check('join 幂等重跑（alreadyJoined=true，身份不被破坏）', j2.code === 0 && j2Json?.alreadyJoined === true, { code: j2.code, alreadyJoined: j2Json?.alreadyJoined });

  // 版本核对（红→绿点 2：若移除 SHA 校验则此处红）
  const badCodePath = join(root, 'code-bad.txt');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(badCodePath, tamperSha(readFileSync(codePath, 'utf-8'), 'deadbeefdeadbeef'), { mode: 0o600 });
  const jBad = await runCli(['join', '--dir', B2, '--code-file', badCodePath, '--device', 'device-B2', '--no-service', ...agentArgs]);
  check('版本不符的加入码被拒（不落地）', jBad.code !== 0 && /版本不一致/.test(jBad.err + jBad.out) && !existsSync(join(B2, 'fleet.config.json')), { code: jBad.code });

  console.log('== 首次连接：A 侧 pending 发现 B ==');
  const anode1 = startCli(['node', '--dir', A, '--run-forever']);
  await waitFor(async () => listeningAddr(anode1) !== null, 30000);
  const bwork1 = startCli(['worker', '--dir', B, '--run-forever', '--print-listen']);
  await waitFor(async () => listeningAddr(bwork1) !== null, 30000);
  const bAddr = listeningAddr(bwork1);
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
  check('approve 发出图上 grant 并登记对端地址', ap.code === 0 && apJson?.ok === true && typeof apJson?.grantId === 'string' && apJson?.peerRegistered === true, {
    code: ap.code, grantId: apJson?.grantId, peerRegistered: apJson?.peerRegistered,
  });

  console.log('== 双向派活（A→B，真实 libp2p loopback） ==');
  const anode2 = startCli([
    'node', '--dir', A, '--submit', '2', '--target-agent', 'fake', '--expect-prefix', 'FAKE:',
    '--wait-sync-ms', '30000', '--timeout-ms', '40000', '--linger-ms', '3000',
  ]);
  await waitFor(async () => listeningAddr(anode2) !== null, 30000);
  const bwork2 = startCli(['worker', '--dir', B, '--run-forever']);
  await waitExit(anode2, 60000);
  const a2 = lastJsonLine(anode2.state.out);
  check('A→B：2/2 完成且结果前缀匹配', a2?.submitted === 2 && a2?.done === 2 && a2?.resultsMatch === true, a2 ?? { stderr: anode2.state.err.slice(-300) });
  bwork2.child.kill('SIGKILL');

  console.log('== 双向派活（B→A） ==');
  const bnode = startCli([
    'node', '--dir', B, '--submit', '2', '--target-agent', 'fake', '--expect-prefix', 'FAKE:',
    '--wait-sync-ms', '30000', '--timeout-ms', '40000', '--linger-ms', '3000',
  ]);
  await waitFor(async () => listeningAddr(bnode) !== null, 30000);
  const awork = startCli(['worker', '--dir', A, '--run-forever']);
  await waitExit(bnode, 60000);
  const b2 = lastJsonLine(bnode.state.out);
  check('B→A：2/2 完成且结果前缀匹配', b2?.submitted === 2 && b2?.done === 2 && b2?.resultsMatch === true, b2 ?? {});
  awork.child.kill('SIGKILL');

  console.log('== 两端 doctor 全绿 ==');
  const anode3 = startCli(['node', '--dir', A, '--run-forever']);
  const bnode3 = startCli(['node', '--dir', B, '--run-forever']);
  await waitFor(async () => listeningAddr(anode3) !== null && listeningAddr(bnode3) !== null, 30000);
  await sleep(4000); // 让最近事件/授权收敛
  const docA = await runCli(['doctor', '--dir', A, '--json']);
  const docB = await runCli(['doctor', '--dir', B, '--json']);
  const dA = firstJson(docA.out);
  const dB = firstJson(docB.out);
  check('doctor(A) 无 FAIL', docA.code === 0 && dA?.ok === true, { code: docA.code, failed: (dA?.checks ?? []).filter((c) => c.status === 'FAIL').map((c) => `${c.name}:${c.detail}`) });
  check('doctor(B) 无 FAIL', docB.code === 0 && dB?.ok === true, { code: docB.code, failed: (dB?.checks ?? []).filter((c) => c.status === 'FAIL').map((c) => `${c.name}:${c.detail}`) });
  anode3.child.kill('SIGKILL');
  bnode3.child.kill('SIGKILL');

  console.log('== 密钥卫生：明文私钥不落日志 ==');
  const bMaster = JSON.parse(readFileSync(join(B, 'master-key.json'), 'utf-8'));
  const secret = bMaster.privateKeyPkcs8;
  const haystack = [
    qs.out, j1.out, j1.err, j2.out, j2.err, jBad.out, jBad.err, ap.out, ap.err,
    docA.out, docA.err, docB.out, docB.err, anode1.state.out, anode1.state.err,
    bwork1.state.out, bwork1.state.err, anode2.state.out, bnode.state.out, awork.state.out,
  ].join('\n');
  check('明文主密钥私钥不出现在任何命令输出', typeof secret === 'string' && secret.length > 0 && !haystack.includes(secret), {});

  console.log('== 停止条件之外的旁证 ==');
  check('quickstart 未创建配置授权（默认拒绝不变）', (() => {
    const cfg = JSON.parse(readFileSync(join(A, 'fleet.config.json'), 'utf-8'));
    return JSON.stringify(cfg.peerNamespacePolicy) === '{}';
  })(), {});
} finally {
  killAll();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).map((r) => r.name);
console.log('== verify:fleet:quickstart ==');
console.log(`FLEET_SUMMARY ${JSON.stringify({ total: results.length, passed, failed, skipped })}`);
process.exit(failed.length === 0 ? 0 : 1);
