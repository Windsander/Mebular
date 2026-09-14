// 跨机前置预检（G3-P2）
//
// 独立成模块以便单元测试：`preflightCross` 的 `probe` 与 `log` 可注入，
// 从而覆盖「探测超时 / relay 不可达 / 只给 relay 不给 peer」等分支，
// 不依赖真实网络。

import net from 'node:net';

/** 从 multiaddr 解析出 TCP 目标（circuit 地址取第一个 /tcp/，即 relay 侧） */
export function parseTcpTarget(multiaddr) {
  if (typeof multiaddr !== 'string') return null;
  const m = /(?:\/ip4\/([^/]+)|\/ip6\/([^/]+)|\/dns4\/([^/]+)|\/dns6\/([^/]+))\/tcp\/(\d+)/.exec(multiaddr);
  if (!m) return null;
  return { host: m[1] ?? m[2] ?? m[3] ?? m[4], port: Number(m[5]) };
}

/** 默认探测实现：TCP 连接，超时返回 { ok:false, error } */
export function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, error: error ? String(error.message ?? error) : null });
    };
    const timer = setTimeout(() => finish(false, new Error(`TCP 连接超时 ${timeoutMs}ms`)), timeoutMs);
    socket.on('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      finish(false, e);
    });
  });
}

/** 补齐指引（可用 log 注入以便测试捕获） */
export function printCrossGuidance(log = console.log) {
  log('');
  log('补齐指引：');
  log('  1) 生成并分发用户主密钥（两机同一把）：node scripts/wan-sync.mjs user-keygen --out key.json');
  log('  2) A 机：node scripts/wan-sync.mjs peer --role a --user-master-key-file key.json \\');
  log('             --bind /ip4/0.0.0.0/tcp/4001 [--relay <relay-multiaddr>]   # 启动后打印 PEER_READY');
  log('  3) 可选 relay：node scripts/wan-sync.mjs relay --port 4000 --unlimited   # 打印 relay multiaddr');
  log('  4) B 机：node scripts/wan-sync.mjs cross --user-master-key-file key.json \\');
  log('             --peer <A 稳定 multiaddr> --peer-id <A deviceId> [--relay <relay-multiaddr>] --out B-evidence.json');
  log('  或经 env：MEBULAR_WAN_PEER / MEBULAR_WAN_PEER_ID / MEBULAR_WAN_RELAY');
  log('  不可达常见原因：地址/端口填错、防火墙/NAT 未放行、relay 未以 --unlimited 运行、A 未先启动。');
  log('  预检超时可用 MEBULAR_WAN_PREFLIGHT_TIMEOUT_MS 调整（默认 3000ms）。');
}

/**
 * 前置预检：缺配置 → 直接列出；否则 TCP 探测 HOST_A（及 RELAY）。
 * @param {{peer?: string, peerId?: string, relay?: string,
 *          probe?: (host: string, port: number, timeoutMs: number) => Promise<{ok: boolean, error: string|null}>,
 *          log?: (line: string) => void, timeoutMs?: number}} options
 * @returns {Promise<boolean>}
 */
export async function preflightCross(options = {}) {
  const { peer, peerId, relay } = options;
  const probe = options.probe ?? probeTcp;
  const log = options.log ?? console.log;
  const timeoutMs = options.timeoutMs ?? Number(process.env.MEBULAR_WAN_PREFLIGHT_TIMEOUT_MS ?? 3000);
  const problems = [];

  if (!peer) problems.push('缺少 HOST_A 地址（--peer 或 MEBULAR_WAN_PEER）');
  if (!peerId) problems.push('缺少 HOST_A deviceId（--peer-id 或 MEBULAR_WAN_PEER_ID）');
  const peerTarget = peer ? parseTcpTarget(peer) : null;
  if (peer && !peerTarget) problems.push(`HOST_A 地址解析不出 TCP 目标：${peer}`);
  const relayTarget = relay ? parseTcpTarget(relay) : null;
  if (relay && !relayTarget) problems.push(`RELAY 地址解析不出 TCP 目标：${relay}`);

  if (problems.length === 0) {
    const targets = [{ name: 'HOST_A', target: peerTarget }];
    if (relayTarget) targets.push({ name: 'RELAY', target: relayTarget });
    for (const { name, target } of targets) {
      const r = await probe(target.host, target.port, timeoutMs);
      if (!r.ok) problems.push(`${name} 不可达：${target.host}:${target.port}（${r.error}）`);
    }
  }

  if (problems.length > 0) {
    log('✗ G3-R 跨机前置预检未通过（尚未开始同步）：');
    for (const p of problems) log(`  - ${p}`);
    printCrossGuidance(log);
    return false;
  }
  log(
    `[preflight] 通过：HOST_A=${peerTarget.host}:${peerTarget.port}` +
      `${relayTarget ? `  RELAY=${relayTarget.host}:${relayTarget.port}` : ''}`,
  );
  return true;
}
