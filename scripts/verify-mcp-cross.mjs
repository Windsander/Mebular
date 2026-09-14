#!/usr/bin/env node
// G6.6 跨网 e2e 门禁（E1，环境齐备时）
//
// 在两台不同公网网络的主机上：A/B 各跑 `mebular serve`（network.enabled，经 relay）；
// 本脚本在 B 运行，经 MCP 驱动：
//   A: memory_write 标记 → A/B: memory_status（取 peerId/stateHash）
//   B: memory_sync { peerId:A-deviceId, address:A-multiaddr } → B: memory_query 命中
// 产出机器可读证据 JSON，并以 judgeCrossEvidence 判定，退出码 0/1。
//
// 无环境时**退出码 1** 并打印所需环境（红门禁），绝不静默通过。
// 注意：本门禁需真实两机，不纳入 CI（CI 无环境必红）；其判定逻辑由 tests/wan/mcp-cross.test.mjs 覆盖。

import { writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { preflightCross } from './wan-preflight.mjs';
import { lookupEgress, judgeDifferentNetwork } from './wan-egress.mjs';
import { checkCrossEnv, printCrossGuidance, judgeCrossEvidence } from './mcp-cross-lib.mjs';

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

log('Mebular G6.6 跨网 e2e 门禁');
log('=========================');

const env = checkCrossEnv(process.env);
if (!env.ok) {
  log(`✗ 缺少跨网环境（${env.missing.join(', ')}）；未开始同步，退出码 1（红）。`);
  printCrossGuidance(log);
  process.exit(1);
}

const { config } = env;
const evidence = {
  generatedAt: new Date().toISOString(),
  coordination: 'stable-address+out-of-band',
  peer: config.peer,
  peerId: config.peerId,
  relay: config.relay,
  mcpA: config.mcpA,
  mcpB: config.mcpB,
};

let clientA = null;
let clientB = null;
try {
  // 1) 前置预检（A 的 p2p 地址与 relay 的 TCP 可达性）
  const pre = await preflightCross({ peer: config.peer, peerId: config.peerId, relay: config.relay, log });
  if (!pre) {
    log('✗ 前置预检未通过，判失败（红）。');
    process.exit(1);
  }

  // 2) 连接双端 MCP
  clientA = await connect(config.mcpA, config.tokenA);
  clientB = await connect(config.mcpB, config.tokenB);

  // 3) A 基线状态：核对 deviceId 与网络运行
  const statusA0 = structuredOf(await clientA.callTool({ name: 'memory_status', arguments: {} }));
  const A = { deviceId: statusA0?.deviceId, peerId: statusA0?.peerId, listenAddrs: statusA0?.listenAddrs, relays: statusA0?.relays };
  evidence.A = { ...A, nodeCount: statusA0?.nodeCount, stateHash: statusA0?.stateHash };
  if (statusA0?.running !== true) {
    log('✗ A 机 libp2p 未运行（network.enabled=false？），判失败（红）。');
    process.exit(1);
  }
  if (statusA0?.deviceId !== config.peerId) {
    log(`✗ A 机 deviceId=${statusA0?.deviceId} 与 MEBULAR_WAN_PEER_ID=${config.peerId} 不符，判失败（红）。`);
    process.exit(1);
  }

  // 4) A 写入唯一标记
  const marker = `g6.6-cross-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const markerHash = createHash('sha256').update(marker).digest('hex').slice(0, 12);
  await clientA.callTool({ name: 'memory_write', arguments: { items: [{ type: 'fact', content: marker, metadata: { g66: markerHash } }] } });
  evidence.marker = marker;

  // 5) B 基线状态 + 触发同步
  const statusB0 = structuredOf(await clientB.callTool({ name: 'memory_status', arguments: {} }));
  evidence.B = { deviceId: statusB0?.deviceId, peerId: statusB0?.peerId, listenAddrs: statusB0?.listenAddrs, relays: statusB0?.relays, nodeCountBefore: statusB0?.nodeCount };
  let syncError = null;
  try {
    const sync = structuredOf(await clientB.callTool({ name: 'memory_sync', arguments: { peerId: config.peerId, address: config.peer } }));
    evidence.sync = sync ?? null;
  } catch (error) {
    syncError = String(error?.message ?? error);
  }

  // 6) B 复查：召回 + 状态
  const q = structuredOf(await clientB.callTool({ name: 'memory_query', arguments: { query: marker } }));
  const statusB1 = structuredOf(await clientB.callTool({ name: 'memory_status', arguments: {} }));
  evidence.markerFound = (q?.totalMatches ?? 0) >= 1;

  // 7) A 复查状态
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

  // 8) 公网出口判据（本地实测 + A 机实测值）
  const localEgress = await lookupEgress();
  evidence.localEgress = localEgress;
  evidence.peerEgress = { ip: config.peerEgress, source: process.env.MEBULAR_WAN_IP_ECHO ?? 'env:MEBULAR_WAN_PEER_EGRESS' };
  evidence.egressService = localEgress.source;
  const judge = judgeDifferentNetwork(localEgress.ip, config.peerEgress);
  evidence.differentPublicNetwork = judge.value;
  evidence.differentPublicNetworkBasis = judge.basis;

  // 9) 判定 + 证据落盘
  const verdict = judgeCrossEvidence(evidence);
  evidence.passed = verdict.passed;
  evidence.failures = verdict.failures;
  await writeFile(config.out, `${JSON.stringify(evidence, null, 2)}\n`, 'utf-8');

  log(`  A deviceId=${evidence.A.deviceId} nodeCount=${evidence.A.nodeCount} stateHash=${evidence.A.stateHash}`);
  log(`  B nodeCount=${evidence.B.nodeCount} stateHash=${evidence.B.stateHash} pendingPeers=${evidence.B.pendingPeers}`);
  log(`  markerFound=${evidence.markerFound} stateMatches=${evidence.stateMatches} identityShared=${evidence.identityShared}`);
  log(`  egress(local/peer)=${localEgress.ip ?? 'unknown'}/${config.peerEgress ?? 'unset'} basis=${judge.basis}`);
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
} finally {
  await clientA?.close().catch(() => undefined);
  await clientB?.close().catch(() => undefined);
}
