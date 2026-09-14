#!/usr/bin/env node
// G6.6 跨网 e2e 门禁（E1，环境齐备时） + 本地双节点夹具（--selftest，non-evidence）
//
// 真实模式（默认）：
//   在两台不同公网网络的主机上：A/B 各跑 `mebular serve`（network.enabled，经 relay）；
//   本脚本在 B 运行，经 MCP 驱动：A memory_write → B memory_sync → B memory_query →
//   双端 memory_status（stateHash）→ 出口判据；产出 mcp-cross-evidence.json 并判定，退出码 0/1。
//   无环境时**退出码 1** 并打印所需 env（红门禁），绝不静默通过。
//
// 本地夹具（--selftest）：无真实公网时，起两个**独立进程/独立存储**的 `mebular serve`
//   （环回直连 libp2p、共享同一用户主密钥），走**同一条链**，验证判定逻辑：
//   链路断言（markerFound/stateMatches/identityShared/pendingPeers）全过，
//   且门禁因 `differentPublicNetwork !== true`（环回）而正确判**不达成**——仅作 non-evidence，
//   **绝不**冒充 G6.6 达成。
//
// 本脚本不入 CI（CI 无环境必红）；判定逻辑由 tests/wan/mcp-cross.test.mjs 覆盖。

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { preflightCross } from './wan-preflight.mjs';
import { lookupEgress, judgeDifferentNetwork } from './wan-egress.mjs';
import { checkCrossEnv, printCrossGuidance, judgeCrossEvidence, judgeSelftest } from './mcp-cross-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const bin = join(rootDir, 'packages', 'mcp', 'bin', 'mebular.mjs');
const SELFTEST = process.argv.includes('--selftest');

const log = (line) => console.log(line);
const structuredOf = (result) => {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  try {
    return JSON.parse(result?.content?.find((c) => c.type === 'text')?.text ?? '{}');
  } catch {
    return null;
  }
};

async function connect(base, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const transport = new StreamableHTTPClientTransport(new URL(`${String(base).replace(/\/$/, '')}/mcp`), {
    requestInit: { headers },
  });
  const client = new Client({ name: 'mebular-mcp-cross', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

/**
 * 走完整链路（真实与夹具共用）。cfg.peer/peerId 缺省时用 A 的 memory_status 值（夹具）。
 * @returns {Promise<object>} evidence
 */
async function runChain(cfg, { requirePeerMatch = false } = {}) {
  const evidence = {
    generatedAt: new Date().toISOString(),
    coordination: 'stable-address+out-of-band',
  };
  let clientA = null;
  let clientB = null;
  try {
    clientA = await connect(cfg.mcpA, cfg.tokenA);
    clientB = await connect(cfg.mcpB, cfg.tokenB);

    const statusA0 = structuredOf(await clientA.callTool({ name: 'memory_status', arguments: {} }));
    if (statusA0?.running !== true) throw new Error('A 机 libp2p 未运行（network.enabled=false？）');
    if (requirePeerMatch && statusA0?.deviceId !== cfg.peerId) {
      throw new Error(`A 机 deviceId=${statusA0?.deviceId} 与 MEBULAR_WAN_PEER_ID=${cfg.peerId} 不符`);
    }
    const peerId = cfg.peerId ?? statusA0?.deviceId;
    const peer = cfg.peer ?? (statusA0?.listenAddrs ?? []).find((a) => a.includes('/tcp/')) ?? null;
    if (!peer) throw new Error('A 机无可拨 multiaddr（listenAddrs 为空；检查 network.libp2p.listen）');
    evidence.peer = peer;
    evidence.peerId = peerId;
    evidence.relay = cfg.relay ?? null;
    evidence.mcpA = cfg.mcpA;
    evidence.mcpB = cfg.mcpB;
    evidence.A = { deviceId: statusA0?.deviceId, peerId: statusA0?.peerId, listenAddrs: statusA0?.listenAddrs, relays: statusA0?.relays, nodeCount: statusA0?.nodeCount, stateHash: statusA0?.stateHash };

    // A 写入唯一标记
    const marker = `g6.6-cross-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    evidence.marker = marker;
    await clientA.callTool({
      name: 'memory_write',
      arguments: { items: [{ type: 'fact', content: marker, metadata: { g66: createHash('sha256').update(marker).digest('hex').slice(0, 12) } }] },
    });

    // B 基线 + 触发同步
    const statusB0 = structuredOf(await clientB.callTool({ name: 'memory_status', arguments: {} }));
    evidence.B = { deviceId: statusB0?.deviceId, peerId: statusB0?.peerId, listenAddrs: statusB0?.listenAddrs, relays: statusB0?.relays, nodeCountBefore: statusB0?.nodeCount };
    let syncError = null;
    try {
      const sync = structuredOf(await clientB.callTool({ name: 'memory_sync', arguments: { peerId, address: peer } }));
      evidence.sync = sync ?? null;
    } catch (error) {
      syncError = String(error?.message ?? error);
    }

    // B 复查：召回 + 状态
    const q = structuredOf(await clientB.callTool({ name: 'memory_query', arguments: { query: marker } }));
    const statusB1 = structuredOf(await clientB.callTool({ name: 'memory_status', arguments: {} }));
    evidence.markerFound = (q?.totalMatches ?? 0) >= 1;

    // A 复查状态
    const statusA1 = structuredOf(await clientA.callTool({ name: 'memory_status', arguments: {} }));
    evidence.A.nodeCount = statusA1?.nodeCount;
    evidence.A.stateHash = statusA1?.stateHash;
    evidence.B.nodeCount = statusB1?.nodeCount;
    evidence.B.stateHash = statusB1?.stateHash;
    evidence.B.pendingPeers = statusB1?.pendingPeers;
    evidence.pendingPeers = statusB1?.pendingPeers;
    evidence.stateMatches = Boolean(statusA1?.stateHash) && statusA1?.stateHash === statusB1?.stateHash;
    evidence.identityShared = syncError === null && evidence.markerFound === true;
    if (syncError) evidence.syncError = syncError;

    // 公网出口判据
    const localEgress = await lookupEgress();
    evidence.localEgress = localEgress;
    evidence.peerEgress = { ip: cfg.peerEgress ?? null, source: process.env.MEBULAR_WAN_IP_ECHO ?? 'env:MEBULAR_WAN_PEER_EGRESS' };
    evidence.egressService = localEgress.source;
    const judge = judgeDifferentNetwork(localEgress.ip, cfg.peerEgress ?? null);
    evidence.differentPublicNetwork = judge.value;
    evidence.differentPublicNetworkBasis = judge.basis;
    return evidence;
  } finally {
    await clientA?.close().catch(() => undefined);
    await clientB?.close().catch(() => undefined);
  }
}

// ---------- 真实模式 ----------

async function runReal() {
  log('Mebular G6.6 跨网 e2e 门禁');
  log('=========================');
  const env = checkCrossEnv(process.env);
  if (!env.ok) {
    log(`✗ 缺少跨网环境（${env.missing.join(', ')}）；未开始同步，退出码 1（红）。`);
    printCrossGuidance(log);
    process.exit(1);
  }
  const { config } = env;
  try {
    const pre = await preflightCross({ peer: config.peer, peerId: config.peerId, relay: config.relay, log });
    if (!pre) {
      log('✗ 前置预检未通过，判失败（红）。');
      process.exit(1);
    }
    const evidence = await runChain(config, { requirePeerMatch: true });
    const verdict = judgeCrossEvidence(evidence);
    evidence.passed = verdict.passed;
    evidence.failures = verdict.failures;
    evidence.evidenceLevel = 'evidence (requires two hosts on different public networks)';
    await writeFile(config.out, `${JSON.stringify(evidence, null, 2)}\n`, 'utf-8');

    log(`  A deviceId=${evidence.A.deviceId} nodeCount=${evidence.A.nodeCount} stateHash=${evidence.A.stateHash}`);
    log(`  B nodeCount=${evidence.B.nodeCount} stateHash=${evidence.B.stateHash} pendingPeers=${evidence.B.pendingPeers}`);
    log(`  markerFound=${evidence.markerFound} stateMatches=${evidence.stateMatches} identityShared=${evidence.identityShared}`);
    log(`  egress(local/peer)=${evidence.localEgress.ip ?? 'unknown'}/${config.peerEgress ?? 'unset'} basis=${evidence.differentPublicNetworkBasis}`);
    log(`  证据写入 ${config.out}`);
    if (verdict.passed) {
      log('✓ G6.6 跨网 e2e 达成（E1）：证据齐备且断言全过。');
      process.exit(0);
    }
    log('✗ G6.6 未达成：');
    for (const f of verdict.failures) log(`  - ${f}`);
    process.exit(1);
  } catch (error) {
    log(`✗ G6.6 执行失败：${String(error?.message ?? error)}`);
    process.exit(1);
  }
}

// ---------- 本地双节点夹具（non-evidence） ----------

function spawnServe(home, extraEnv) {
  const proc = spawn(process.execPath, [bin, 'serve', '--port', '0', '--auth', 'none'], {
    env: { ...process.env, MEBULAR_HOME: home, MEBULAR_STORAGE_PATH: join(home, 'store.jsonl'), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });
  return { proc, getOut: () => out, getErr: () => err };
}

function waitReady(handle, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const m = handle.getOut().match(/SERVE_READY (\{.*\})/);
      if (m) { clearInterval(timer); resolve(JSON.parse(m[1])); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`serve 未就绪：${handle.getErr()}`)); }
    }, 100);
  });
}

async function stopServe(handle) {
  if (handle?.proc && handle.proc.exitCode === null) {
    handle.proc.kill('SIGTERM');
    await new Promise((r) => handle.proc.on('exit', r));
  }
}

async function runSelftest() {
  log('Mebular G6.6 本地双节点夹具（non-evidence；不冒充跨网达成）');
  log('======================================================');
  const dir = await mkdtemp(join(tmpdir(), 'mebular-mcp-cross-selftest-'));
  const homeA = join(dir, 'a');
  const homeB = join(dir, 'b');
  const keyFile = join(dir, 'key.json');
  let a = null;
  let b = null;
  try {
    // 共享用户主密钥（两节点同一把 → 握手互验）
    execFileSync(process.execPath, [bin, 'keygen', '--out', keyFile], { env: { ...process.env, MEBULAR_HOME: homeA }, stdio: ['ignore', 'ignore', 'ignore'] });
    const sharedEnv = { MEBULAR_USER_MASTER_KEY_FILE: keyFile, MEBULAR_NETWORK_ENABLED: 'true' };
    const writes = [
      [homeA, 'device-A-local'],
      [homeB, 'device-B-local'],
    ];
    for (const [home, deviceId] of writes) {
      await mkdir(home, { recursive: true });
      await writeFile(
        join(home, 'config.json'),
        JSON.stringify(
          {
            storagePath: join(home, 'store.jsonl'),
            deviceId,
            encryption: { level: 'none', keyFile },
            network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] } },
          },
          null,
          2,
        ),
        'utf-8',
      );
    }

    log('  · 启动 A/B 两个独立 serve（独立存储、环回 libp2p、共享主密钥）…');
    a = spawnServe(homeA, { ...sharedEnv, MEBULAR_DEVICE_ID: 'device-A-local' });
    b = spawnServe(homeB, { ...sharedEnv, MEBULAR_DEVICE_ID: 'device-B-local' });
    const [readyA, readyB] = await Promise.all([waitReady(a), waitReady(b)]);

    const cfg = {
      mcpA: `http://127.0.0.1:${readyA.port}`,
      tokenA: null,
      mcpB: `http://127.0.0.1:${readyB.port}`,
      tokenB: null,
      peer: null,
      peerId: null,
      relay: null,
      peerEgress: null,
    };
    const evidence = await runChain(cfg, { requirePeerMatch: false });
    const gate = judgeCrossEvidence(evidence);
    const verdict = judgeSelftest(evidence);
    evidence.evidenceLevel = 'non-evidence (loopback dual-node fixture; not G6.6 achievement)';
    evidence.selftest = true;
    evidence.gatePassed = gate.passed;
    evidence.gateFailures = gate.failures;
    evidence.passed = verdict.ok;
    const out = join(rootDir, '.wan-evidence', `mcp-cross-selftest-${Date.now()}.json`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`, 'utf-8');

    log(`  A deviceId=${evidence.A.deviceId} nodeCount=${evidence.A.nodeCount} stateHash=${evidence.A.stateHash}`);
    log(`  B nodeCount=${evidence.B.nodeCount} stateHash=${evidence.B.stateHash} pendingPeers=${evidence.B.pendingPeers}`);
    log(`  markerFound=${evidence.markerFound} stateMatches=${evidence.stateMatches} identityShared=${evidence.identityShared}`);
    log(`  differentPublicNetwork=${evidence.differentPublicNetwork}（${evidence.differentPublicNetworkBasis}；环回预期不为 true）`);
    log(`  门禁判定 gatePassed=${gate.passed}（因无真实异网出口，应对 G6.6 判不达成）`);
    log(`  证据（non-evidence）：${out}`);

    if (verdict.ok) {
      log('✓ 本地夹具通过（non-evidence）：完整链路与判定逻辑均正确；G6.6 仍需真实两机方可达成。');
      process.exit(0);
    }
    log('✗ 本地夹具失败：');
    for (const f of verdict.chainFailures) log(`  - 链路断言未过：${f}`);
    if (evidence.differentPublicNetwork === true) log('  - 环回却判 differentPublicNetwork=true（判定逻辑错误）');
    if (gate.passed === true) log('  - 门禁在无真实异网时错误判为达成');
    process.exit(1);
  } catch (error) {
    log(`✗ 本地夹具执行失败：${String(error?.message ?? error)}`);
    process.exit(1);
  } finally {
    await stopServe(a);
    await stopServe(b);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (SELFTEST) await runSelftest();
else await runReal();
