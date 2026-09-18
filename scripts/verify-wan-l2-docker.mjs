#!/usr/bin/env node
// L2 · NAT 隔离（docker-compose 三容器）：relay 公开；peerA/peerB 各自隔离网络、无入站端口。
// 断言：relay-only 连通 + 同步收敛 + 授权负例（未授权分区不可见）。无 docker → SKIP（明列原因）。
// relay 重启/IP 变更恢复见 `verify:wan:l2`（本机 relay-only 仿真，同一 libp2p relay 代码路径）。
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mebular } from '../dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = join(root, 'docker-compose.wan.yml');
const state = join(root, '.wan-nat');
const results = [];
const skipped = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
const skip = (name, reason) => { skipped.push({ name, reason }); console.log(`SKIP  ${name}  ${reason}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const waitFor = async (fn, ms, poll = 300) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(poll); } return fn(); };
const compose = (args, opts = {}) => spawnSync('docker', ['compose', '-f', composeFile, ...args], { encoding: 'utf8', cwd: root, ...opts });

const hasDocker = (() => { try { return compose(['version']).status === 0; } catch { return false; } })();

if (!hasDocker) {
  skip('L2 docker NAT 隔离', '本机/CI 无 `docker compose`（可用性优先以 CI ubuntu 为准）；relay-only 断言由 verify:wan:l2 本机仿真覆盖');
} else {
  rmSync(state, { recursive: true, force: true });
  mkdirSync(state, { recursive: true });
  try {
    const master = await Mebular.generateUserMasterKey();
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', master.privateKey));
    writeFileSync(join(state, 'master-key.json'), JSON.stringify({ v: 1, alg: 'Ed25519', publicKey: Buffer.from(master.publicKey).toString('base64'), privateKeyPkcs8: Buffer.from(pkcs8).toString('base64') }), { mode: 0o600 });

    const up = compose(['up', '-d', '--force-recreate']);
    check('docker compose up（relay + peera + peerb）', up.status === 0, { stderr: (up.stderr || '').slice(-200) });

    const a = await waitFor(() => readJson(join(state, 'A.json')), 60000);
    check('A 在隔离网络中经 relay 预留（/p2p-circuit）', typeof a?.circuit === 'string' && a.circuit.includes('/p2p-circuit'), { circuit: a?.circuit?.includes('/p2p-circuit') });

    writeFileSync(join(state, 'phase.json'), JSON.stringify({ epoch: 1, phase: 'sync' }));
    const synced = await waitFor(() => {
      const sa = readJson(join(state, 'A.json'));
      const sb = readJson(join(state, 'B.json'));
      return sa?.sawReply === true && sb?.sawA === true;
    }, 90000);
    check('① relay-only 收敛（A→B→A 往返）', !!synced, { a: readJson(join(state, 'A.json')), b: readJson(join(state, 'B.json')) });

    writeFileSync(join(state, 'phase.json'), JSON.stringify({ epoch: 2, phase: 'authneg' }));
    const authneg = await waitFor(() => {
      const sa = readJson(join(state, 'A.json'));
      const sb = readJson(join(state, 'B.json'));
      return sa?.secretCreated === true && typeof sb?.secretCount === 'number';
    }, 30000);
    const b = readJson(join(state, 'B.json'));
    check('② 授权负例：未授权分区对隔离网络中的对端不可见', !!authneg && b?.secretCount === 0, { secretCount: b?.secretCount });
  } catch (error) {
    check('verify:wan:l2:docker 未抛异常', false, { error: error?.message || String(error) });
  } finally {
    const logs = compose(['logs', '--tail', '60']);
    if (results.some((r) => !r.ok)) console.error(logs.stdout || logs.stderr || '');
    compose(['down', '-v', '--remove-orphans']);
    rmSync(state, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok);
console.log('== 摘要 ==');
const summary = { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name), skipped };
console.log(JSON.stringify(summary, null, 2));
console.log(`FLEET_SUMMARY ${JSON.stringify(summary)}`);
process.exit(failed.length === 0 ? 0 : 1);
