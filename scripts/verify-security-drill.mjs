#!/usr/bin/env node
// S2 恢复演练（SPEC §4.4 D-1…D-4）：全部沙箱 home，纯本地，无公网。
//
// 前置：npm run build（使用 packages/fleet/dist/cli.js 与 dist/index.js）。
// 输出摘要行 SECURITY_DRILL_SUMMARY {...}；失败退出 1。
//
// D-1 备份往返 + 证书链 + 两机 __policy__ 对账
// D-2 错码/篡改 → 失败且无半成品
// D-3 break-glass：生成→消费（nonce 一次）→重放拒绝；S1 未合并时只做 proof 级断言并 SKIP 全网采纳
// D-4 轮换：旧码新签名不再采纳、新码可用；S1 未合并时同上

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI = fileURLToPath(new URL('../packages/fleet/dist/cli.js', import.meta.url));
const FLEET_ENTRY = pathToFileURL(fileURLToPath(new URL('../packages/fleet/dist/index.js', import.meta.url))).href;
const CORE_ENTRY = pathToFileURL(fileURLToPath(new URL('../dist/index.js', import.meta.url))).href;

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 30_000, pollMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return Boolean(await fn());
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
function runCli(args, { timeoutMs = 90_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
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
function startCli(args, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const state = { out: '', err: '' };
  child.stdout.on('data', (d) => (state.out += d));
  child.stderr.on('data', (d) => (state.err += d));
  return { child, state, stop: () => child.kill('SIGKILL') };
}
const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
const listeningAddr = (text) => {
  const match = text.match(/\{[^\n]*"event":"listening"[^\n]*\}/);
  if (!match) return null;
  const payload = lastJson(match[0]);
  return payload?.multiaddr ?? payload?.multiaddrs?.[0] ?? null;
};

/** 读 store.jsonl 里的 `__policy__` 事件 id 集合（容忍 putEvent 包装/直接事件）。 */
function policyIds(dir) {
  const path = join(dir, 'store.jsonl');
  if (!existsSync(path)) return new Set();
  const ids = new Set();
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.op === 'deleteEvent') {
      ids.delete(record.id ?? record.value?.id);
      continue;
    }
    const event = record.value ?? record;
    if (event?.id && event?.namespace === '__policy__') ids.add(event.id);
  }
  return ids;
}
function hasPolicyType(dir, type) {
  const path = join(dir, 'store.jsonl');
  if (!existsSync(path)) return false;
  return readFileSync(path, 'utf-8').split('\n').some((line) => {
    if (!line.trim()) return false;
    try {
      const record = JSON.parse(line);
      const event = record.value ?? record;
      return event?.type === type;
    } catch {
      return false;
    }
  });
}
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}
function sameMasterPublicKey(a, b) {
  return readJson(join(a, 'master-key.json')).publicKey === readJson(join(b, 'master-key.json')).publicKey;
}
function modeOf(path) {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

const IS_WIN = process.platform === 'win32';
const sandboxBase = process.env.MEBULAR_USER_HOME ?? null;
if (sandboxBase !== null) await mkdir(sandboxBase, { recursive: true });
const root = sandboxBase !== null
  ? await mkdtemp(join(sandboxBase, 'security-drill-'))
  : await mkdtemp(join(tmpdir(), 'security-drill-'));
const env = { MEBULAR_USER_HOME: root };

try {
  console.log('== D-1 备份往返 + 证书链 + 两机 __policy__ 对账 ==');
  const A = join(root, 'A');
  const B = join(root, 'B');
  const A2 = join(root, 'A2');
  const portA = await freePort();

  const onboardA = await runCli([
    'onboard', '--dir', A, '--device', 'device-A',
    '--listen', `/ip4/127.0.0.1/tcp/${portA}`,
  ], { env });
  check('D-1 前置：A onboard', onboardA.code === 0, { code: onboardA.code });
  const subA = await runCli(['subscribers', '--dir', A, '--namespace', 'tasks'], { env });
  check('D-1 前置：A 已声明本机订阅', subA.code === 0 && (lastJson(subA.out)?.subscribers ?? []).includes('device-A'), {});

  const nodeA = startCli(['node', '--dir', A, '--timeout-ms', '60000'], env);
  const aUp = await waitFor(() => listeningAddr(nodeA.state.out) !== null, 20_000);
  const addrA = listeningAddr(nodeA.state.out);
  check('D-1 前置：A 监听（multiaddr）', aUp && typeof addrA === 'string', { addrA });

  const onboardB = await runCli([
    'onboard', '--dir', B, '--device', 'device-B',
    '--peer-device', 'device-A', '--peer-addr', String(addrA),
    '--master-key', join(A, 'master-key.json'),
  ], { env });
  check('D-1 前置：B 用 A 的主密钥 onboard（root 直签）', onboardB.code === 0, { code: onboardB.code });

  const workerB = startCli(['worker', '--dir', B, '--print-listen', '--timeout-ms', '60000', '--interval-ms', '50'], env);
  const bUp = await waitFor(() => listeningAddr(workerB.state.out) !== null, 20_000);
  const addrB = listeningAddr(workerB.state.out);
  check('D-1 前置：B 监听（multiaddr）', bUp && typeof addrB === 'string', { addrB });
  const aPolicy = policyIds(A);
  const synced = await waitFor(() => [...aPolicy].every((id) => policyIds(B).has(id)), 25_000);
  check('D-1 前置：B 已同步 A 的 __policy__ 事件', synced, { a: aPolicy.size, b: policyIds(B).size });

  const exportRes = await runCli(['security', 'backup', 'export', '--dir', A, '--out', join(root, 'A-backup.json')], { env });
  const exported = lastJson(exportRes.out);
  check('D-1 A 导出备份（root）', exportRes.code === 0 && exported?.ok === true && typeof exported?.code === 'string', { code: exportRes.code });
  if (exported?.code) {
    const restoreRes = await runCli([
      'security', 'backup', 'restore', '--file', join(root, 'A-backup.json'),
      '--code', exported.code, '--dir', A2, '--device', 'device-A2',
      '--listen', `/ip4/127.0.0.1/tcp/${await freePort()}`,
    ], { env });
    const restored = lastJson(restoreRes.out);
    check('D-1 新 home A\' 从文件+码恢复', restoreRes.code === 0 && restored?.ok === true, { code: restoreRes.code, err: restoreRes.err.slice(0, 200) });
    check('D-1 主公钥指纹一致（A = A\'）', sameMasterPublicKey(A, A2), {});

    // 证书链有效（core 公共 API）
    try {
      const identity = readJson(join(A2, 'store.jsonl.identity.json'));
      const masterPublic = Buffer.from(readJson(join(A2, 'master-key.json')).publicKey, 'base64');
      const { IdentityManager } = await import(CORE_ENTRY);
      const manager = new IdentityManager();
      manager.setUserMasterPublicKey(new Uint8Array(masterPublic));
      const chain = identity.certificateChain ?? (identity.certificate ? [identity.certificate] : []);
      const chainOk = await manager.verifyDeviceCertificateChain(chain, identity.deviceId);
      check('D-1 A\' 证书链有效（锚定主公钥）', chainOk === true, { deviceId: identity.deviceId, hops: chain.length });
    } catch (error) {
      check('D-1 A\' 证书链有效（锚定主公钥）', false, { error: String(error?.message ?? error) });
    }

    // A' 与 B 直连同步（__policy__ 对账）
    const onboardA2 = await runCli([
      'onboard', '--dir', A2, '--device', 'device-A2',
      '--master-key', join(A2, 'master-key.json'),
      '--peer-device', 'device-B', '--peer-addr', String(addrB),
    ], { env });
    check('D-1 前置：A\' 登记 B 地址', onboardA2.code === 0, { code: onboardA2.code });
    const nodeA2 = startCli(['worker', '--dir', A2, '--print-listen', '--timeout-ms', '40000', '--interval-ms', '50'], env);
    const bPolicy = policyIds(B);
    const a2Synced = await waitFor(() => {
      const p = policyIds(A2);
      return [...bPolicy].every((id) => p.has(id)) && p.size > 0;
    }, 25_000);
    check('D-1 A\' 与 B 直连同步绿（__policy__ 对账一致）', a2Synced, { b: bPolicy.size, a2: policyIds(A2).size });
    nodeA2.stop();
  } else {
    skip('D-1 恢复/联调', '导出未返回备份码');
  }
  nodeA.stop();
  workerB.stop();

  console.log('== D-2 错误输入：错码/篡改 → 明确失败、无半成品 ==');
  if (!existsSync(join(root, 'A-backup.json'))) {
    skip('D-2', '缺少 D-1 备份文件');
  } else {
    const backup = readJson(join(root, 'A-backup.json'));
    const wrongDir = join(root, 'wrong-code');
    const wrong = await runCli([
      'security', 'backup', 'restore', '--file', join(root, 'A-backup.json'),
      '--code', '0000-0000-0000-0000-0000-0000-0000-0000-00', '--dir', wrongDir,
    ], { env });
    check('D-2 错码 → 非零退出且可读失败', wrong.code !== 0 && /恢复码|备份码错误|篡改/.test(`${wrong.out}${wrong.err}`), { code: wrong.code });
    check('D-2 错码 → 无半成品残留', !existsSync(join(wrongDir, 'master-key.json')) && !existsSync(join(wrongDir, 'user-master-key.json')) && !existsSync(join(wrongDir, 'fleet.config.json')), {});

    const tampered = JSON.parse(JSON.stringify(backup));
    const rawCipher = Buffer.from(tampered.cipher.ciphertext, 'base64');
    rawCipher[0] = rawCipher[0] ^ 0xff;
    tampered.cipher.ciphertext = rawCipher.toString('base64');
    const tamperedPath = join(root, 'tampered.json');
    writeFileSync(tamperedPath, JSON.stringify(tampered), { mode: 0o600 });
    const tamperedDir = join(root, 'tampered-home');
    const bad = await runCli([
      'security', 'backup', 'restore', '--file', tamperedPath,
      '--code', exported?.code ?? 'x',
      '--dir', tamperedDir,
    ], { env });
    check('D-2 篡改文件 → 非零退出且可读失败', bad.code !== 0 && /备份码错误|篡改/.test(`${bad.out}${bad.err}`), { code: bad.code });
    check('D-2 篡改文件 → 无半成品残留', !existsSync(join(tamperedDir, 'master-key.json')) && !existsSync(join(tamperedDir, 'user-master-key.json')) && !existsSync(join(tamperedDir, 'fleet.config.json')), {});
    if (!IS_WIN) {
      check('D-2 备份文件 0600', modeOf(join(root, 'A-backup.json')) === 0o600, { mode: modeOf(join(root, 'A-backup.json'))?.toString(8) });
    }
  }

  console.log('== D-3 break-glass：生成 / 消费 / nonce 一次 ==');
  const D = join(root, 'D');
  const onboardD = await runCli(['onboard', '--dir', D, '--device', 'device-D', ], { env });
  check('D-3 前置：D onboard', onboardD.code === 0, {});
  const gen = await runCli(['security', 'recovery', 'generate', '--dir', D], { env });
  const generated = lastJson(gen.out);
  check('D-3 生成恢复码（显示一次 + keyId）', gen.code === 0 && generated?.ok === true && typeof generated?.code === 'string' && generated?.shownOnce === true, { keyId: generated?.keyId });
  check('D-3 security_recovery(set) 记录已落图', hasPolicyType(D, 'security_recovery'), {});

  const fleet = await import(FLEET_ENTRY);
  const eventsD = readJsonLinesPolicy(D);
  const registry = fleet.collectRecoveryRegistry(eventsD);
  check('D-3 恢复码登记被本地注册表识别', registry.currentKeyId === generated?.keyId, { current: registry.currentKeyId });

  if (generated?.code) {
    const proof = fleet.signBreakGlass({
      code: generated.code,
      op: 'kick',
      initiator: 'device-D',
      subject: 'device-B',
    });
    const verify = fleet.verifyBreakGlassProof(proof.proof, {
      publicKeyHex: generated.keyId === registry.currentKeyId ? registry.keys[generated.keyId]?.publicKeyHex : '',
      expectedDigest: proof.digest,
      currentKeyId: registry.currentKeyId,
      usedNonces: registry.usedNonces,
    });
    check('D-3 恢复码签名/摘要可验（kick）', verify.ok === true, verify);
    const replay = fleet.verifyBreakGlassProof(proof.proof, {
      publicKeyHex: registry.keys[generated.keyId]?.publicKeyHex ?? '',
      currentKeyId: registry.currentKeyId,
      usedNonces: new Set([proof.proof.nonce]),
    });
    check('D-3 同一 nonce 二次使用被拒', replay.ok === false && replay.reason === 'stale-or-replayed-nonce', replay);

    // S1 未合并：全网采纳无法断言 → 明确 SKIP；合并后同一脚本自动进入下方分支。
    const core = await import(CORE_ENTRY);
    if (typeof core.Mebular?.prototype?.getSecurityTier !== 'function') {
      skip('D-3 全网采纳（踢人记录 + 审计标注）', 'S1 未合并：core 无 getSecurityTier()/setSecurityTier()；本轮仅 proof 级断言');
    } else {
      const config = await fleet.loadFleetConfig(join(D, 'fleet.config.json'));
      const encryption = await fleet.readMasterKeyFile(config.masterKeyFile);
      const app = new core.Mebular(fleet.offlineMebularOptions(config, encryption));
      await app.initialize();
      try {
        await app.setSecurityTier({ level: 'high', note: 'drill' });
        const write = await fleet.writeDeviceRevoke(app, { subject: 'device-B', breakGlass: proof.proof, note: 'drill break-glass kick' });
        const revoked = await app.getBlockedDevices();
        check('D-3 恢复码踢人记录被全网采纳（revoked 含 subject）', revoked.includes('device-B'), { revoked });
        check('D-3 审计记录携带 breakGlass（恢复码标注来源）', hasPolicyType(D, 'device_revoke'), { eventId: write.id });
        // 重放：同一 nonce 用于**不同动作**（subject C；digest 不同）→ core 的 consumeNonce
        // 判为 stale-or-replayed-nonce。注意：同 subject + 不同 note 的 digest 相同，core 按
        // 「同一动作重复 = 幂等」处理（不产出 rejection），因此不能用它测重放拒绝。
        const replayProof = fleet.signBreakGlass({
          code: generated.code,
          op: 'kick',
          initiator: 'device-D',
          subject: 'device-C',
          nonce: proof.proof.nonce,
        });
        const replayWrite = await fleet.writeDeviceRevoke(app, { subject: 'device-C', breakGlass: replayProof.proof, note: 'drill replay' });
        const state = await app.getSecurityTier();
        check(
          'D-3 重放 nonce 被 core 拒绝且可见',
          (state.rejections ?? []).some((r) => r.eventId === replayWrite.id && r.reason === 'stale-or-replayed-nonce'),
          { rejections: state.rejections, replayEventId: replayWrite.id },
        );
      } finally {
        await app.shutdown();
      }
    }
  } else {
    skip('D-3 消费/重放', '未生成恢复码');
  }

  console.log('== D-4 轮换：旧码新签名不采纳、新码可用 ==');
  if (generated?.code) {
    const rotate = await runCli(['security', 'recovery', 'rotate', '--dir', D, '--old-code', generated.code], { env });
    const rotated = lastJson(rotate.out);
    check('D-4 轮换成功（新 keyId）', rotate.code === 0 && rotated?.ok === true && rotated?.keyId !== generated.keyId, { old: generated.keyId, new: rotated?.keyId });
    check('D-4 security_recovery(rotate) 记录已落图', hasPolicyType(D, 'security_recovery'), {});
    const registry2 = fleet.collectRecoveryRegistry(readJsonLinesPolicy(D));
    check('D-4 本地注册表当前 keyId 前移', registry2.currentKeyId === rotated?.keyId, { current: registry2.currentKeyId });
    if (rotated?.code) {
      const oldProof = fleet.signBreakGlass({ code: generated.code, op: 'kick', initiator: 'device-D', subject: 'device-X' });
      const oldCheck = fleet.verifyBreakGlassProof(oldProof.proof, {
        publicKeyHex: registry2.keys[generated.keyId]?.publicKeyHex ?? '',
        currentKeyId: registry2.currentKeyId,
      });
      check('D-4 旧码新签名不再被采纳', oldCheck.ok === false, oldCheck);
      const newProof = fleet.signBreakGlass({ code: rotated.code, op: 'kick', initiator: 'device-D', subject: 'device-X' });
      const newCheck = fleet.verifyBreakGlassProof(newProof.proof, {
        publicKeyHex: registry2.keys[rotated.keyId]?.publicKeyHex ?? '',
        currentKeyId: registry2.currentKeyId,
        usedNonces: registry2.usedNonces,
      });
      check('D-4 新码可用', newCheck.ok === true, newCheck);

      const core = await import(CORE_ENTRY);
      if (typeof core.Mebular?.prototype?.getSecurityTier !== 'function') {
        skip('D-4 core 采纳（旧码拒绝/新码接受）', 'S1 未合并：仅本地 preflight 断言');
      } else {
        const config = await fleet.loadFleetConfig(join(D, 'fleet.config.json'));
        const encryption = await fleet.readMasterKeyFile(config.masterKeyFile);
        const app = new core.Mebular(fleet.offlineMebularOptions(config, encryption));
        await app.initialize();
        try {
          await app.setSecurityTier({ level: 'high', note: 'drill' });
          const oldWrite = await fleet.writeDeviceRevoke(app, { subject: 'device-X', breakGlass: oldProof.proof, note: 'old key' });
          const afterOld = await app.getBlockedDevices();
          const stateAfterOld = await app.getSecurityTier();
          const oldRejected = (stateAfterOld.rejections ?? []).some(
            (r) => r.eventId === oldWrite.id && r.reason === 'invalid-proof',
          );
          check(
            'D-4 core：旧码签名不采纳（X 未进 revoked；reason=invalid-proof）',
            !afterOld.includes('device-X') && oldRejected,
            { revoked: afterOld, rejections: stateAfterOld.rejections, oldEventId: oldWrite.id },
          );
          await fleet.writeDeviceRevoke(app, { subject: 'device-X', breakGlass: newProof.proof, note: 'new key' });
          const afterNew = await app.getBlockedDevices();
          check('D-4 core：新码签名可用（X 进 revoked）', afterNew.includes('device-X'), { revoked: afterNew });
        } finally {
          await app.shutdown();
        }
      }
    }
  } else {
    skip('D-4 轮换', '未生成恢复码');
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

const failed = results.filter((r) => !r.ok);
const summary = {
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.map((r) => r.name),
  skipped: skipped.map((s) => s.name),
  skippedReasons: skipped,
};
console.log('== 摘要 ==');
console.log(JSON.stringify(summary, null, 2));
console.log(`SECURITY_DRILL_SUMMARY ${JSON.stringify(summary)}`);
process.exit(failed.length === 0 ? 0 : 1);

/** 读 `__policy__` 事件（供 fleet 安全模块的本地注册表/verifier 预检）。 */
function readJsonLinesPolicy(dir) {
  const path = join(dir, 'store.jsonl');
  if (!existsSync(path)) return [];
  const events = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const event = record.value ?? record;
      if (event?.id && event?.namespace === '__policy__') events.push(event);
    } catch {
      /* ignore */
    }
  }
  return events;
}
