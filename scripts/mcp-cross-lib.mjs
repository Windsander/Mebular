// G6.6 跨网 e2e 门禁：需求检查与证据判定（纯函数，可单测）
//
// 与 `verify-mcp-cross.mjs` 分离，使「红/绿判定逻辑」可在无两台主机时被单元测试覆盖；
// 真实跨网执行仍只在环境齐备时由 verify-mcp-cross.mjs 驱动。

export const REQUIRED_ENV = [
  ['MEBULAR_WAN_PEER', 'A 机可达 libp2p multiaddr（含 relay circuit），用作 memory_sync.address'],
  ['MEBULAR_WAN_PEER_ID', 'A 机 deviceId，用作 memory_sync.peerId 并做身份核对'],
  ['MEBULAR_WAN_MCP_A', 'A 机 serve base URL（非环回须 TLS + auth != none，D45），如 https://A.example:7331'],
  ['MEBULAR_WAN_MCP_A_TOKEN', '访问 A 机 /mcp 的 bearer/oauth 令牌'],
];

export const OPTIONAL_ENV = [
  ['MEBULAR_WAN_MCP_B', 'B 机 serve base（默认 http://127.0.0.1:7331）'],
  ['MEBULAR_WAN_MCP_B_TOKEN', 'B 机 /mcp 令牌（环回 auth=none 时可省）'],
  ['MEBULAR_WAN_RELAY', 'relay multiaddr（预检其 TCP 可达性）'],
  ['MEBULAR_WAN_PEER_EGRESS', 'A 机实测公网出口 IP（用于 differentPublicNetwork；缺省则判据为 null → 失败）'],
  ['MEBULAR_MCP_CROSS_OUT', '证据 JSON 输出路径（默认 mcp-cross-evidence.json）'],
];

/** 检查跨网门禁所需 env；缺失即返回 ok:false 并列出 missing。 */
export function checkCrossEnv(env = process.env) {
  const missing = REQUIRED_ENV.filter(([k]) => !env[k]).map(([k]) => k);
  return {
    ok: missing.length === 0,
    missing,
    config: {
      peer: env.MEBULAR_WAN_PEER ?? null,
      peerId: env.MEBULAR_WAN_PEER_ID ?? null,
      mcpA: env.MEBULAR_WAN_MCP_A ?? null,
      tokenA: env.MEBULAR_WAN_MCP_A_TOKEN ?? null,
      mcpB: env.MEBULAR_WAN_MCP_B ?? 'http://127.0.0.1:7331',
      tokenB: env.MEBULAR_WAN_MCP_B_TOKEN ?? null,
      relay: env.MEBULAR_WAN_RELAY ?? null,
      peerEgress: env.MEBULAR_WAN_PEER_EGRESS ?? null,
      out: env.MEBULAR_MCP_CROSS_OUT ?? 'mcp-cross-evidence.json',
    },
  };
}

export function printCrossGuidance(log = console.log) {
  log('');
  log('G6.6 跨网 e2e 所需环境（真实两台不同公网主机 + 公网可达 relay）：');
  log('  必需：');
  for (const [k, d] of REQUIRED_ENV) log(`    ${k} — ${d}`);
  log('  可选：');
  for (const [k, d] of OPTIONAL_ENV) log(`    ${k} — ${d}`);
  log('  另需：');
  log('    · A/B 两机各跑 `mebular serve`：.mebular/config.json 设 network.enabled=true、');
  log('      network.libp2p.listen 与 relayServers（该 relay）、relayUnlimited=true。');
  log('    · A 机 serve 若供网络访问，须 TLS 且 auth != none（D45 fail-closed）。');
  log('    · 带外交换 A 的 deviceId 与可达 multiaddr（无共享文件）。');
  log('  执行清单：见 README「跨机 / 公网」与 packages/fleet/RELAY-OPS.md。');
  log('  门禁：本脚本无上述环境时退出码 1（红），环境齐备且断言全过才退出码 0。');
}

/**
 * 一致性判据（①）：优先用**共同授权域**的哈希（`stateMatchesCommon`）；旧证据无该
 * 字段时回退到全局 `stateMatches`。两端合法持有不同分区集合时，全局哈希天然不同。
 */
function stateConsistent(evidence) {
  if (evidence?.stateMatchesCommon !== undefined) return evidence.stateMatchesCommon === true;
  return evidence?.stateMatches === true;
}

/**
 * 判定跨网证据是否达成 G6.6（四项全 true 才算通过）。
 * 注：`MemoryStatus.pendingEventCount` 为 SyncManager 的**待发事件数**（原字段名 `pendingPeers`
 * 语义误导，已更名），成功同步后不保证为 0，故**不作为**达成判据，仅在证据里记录。
 */
export function judgeCrossEvidence(evidence) {
  const failures = [];
  if (evidence?.markerFound !== true) failures.push('markerFound !== true（B 未召回 A 的写入）');
  if (!stateConsistent(evidence)) failures.push('共同域 stateHash 不一致（stateMatchesCommon/stateMatches !== true）');
  if (evidence?.identityShared !== true) failures.push('identityShared !== true（未以同一主密钥完成握手同步）');
  if (evidence?.differentPublicNetwork !== true) {
    failures.push(`differentPublicNetwork !== true（${evidence?.differentPublicNetworkBasis ?? 'unknown'}）`);
  }
  return { passed: failures.length === 0, failures };
}

/**
 * 本地双节点夹具（non-evidence）判定：链路断言必须全过，且门禁必须因缺少真实异网出口
 * （`differentPublicNetwork !== true`）而**正确地不通过**——否则说明判定逻辑有误。
 */
export function judgeSelftest(evidence) {
  const chainFailures = [];
  if (evidence?.markerFound !== true) chainFailures.push('markerFound');
  if (!stateConsistent(evidence)) chainFailures.push('stateMatches');
  if (evidence?.identityShared !== true) chainFailures.push('identityShared');
  const gate = judgeCrossEvidence(evidence);
  const blockedByEgress = evidence?.differentPublicNetwork !== true;
  return {
    ok: chainFailures.length === 0 && blockedByEgress && gate.passed === false,
    chainFailures,
    blockedByEgress,
    gatePassed: gate.passed,
    gateFailures: gate.failures,
  };
}
