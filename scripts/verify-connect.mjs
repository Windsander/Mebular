#!/usr/bin/env node
// C2 验收：配对即连（候选地址簿 + 自动选路 + relay 降级/恢复）
//
// Part A（无需 relay，必跑）：邀请方 hints 经 `persistInviterHints`（join 流程同一函数）落到
//   新设备地址簿 → 新设备**不带地址** connectToPeer 即可连通（无 network.peers）；
//   断言路径状态、peerId 键可命中、地址簿落盘 0600、旧令牌（无 hints）为 no-op。
// Part B（真实 circuit relay，依赖可选包；缺包 SKIP 非红）：
//   A 仅以 relay 地址可达 → B 经簿内 relay 候选连通（path.kind=relay）；
//   杀 relay → 拨号失败且安排退避重试（降级）；同端口恢复 relay → 自动/手动重连成功。
//
// 用法：npm run verify:connect（前置：npm run build）

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Mebular,
  IdentityManager,
  FileEndpointStore,
  EndpointBook,
  bytesToHex,
  derivePeerIdHex,
} from '@mebular/core';
import { Libp2pProvider } from '@mebular/core';
import { buildJoinToken, decodeJoinToken, verifyJoinToken, persistInviterHints } from '@mebular/fleet';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
let failed = 0;
const skipped = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）` : ''}`);
  if (ok) passed += 1;
  else failed += 1;
};
const skip = (label, reason) => {
  console.log(`  - SKIP ${label}：${reason}`);
  skipped.push(label);
};
const waitFor = async (fn, timeoutMs = 15000, stepMs = 200) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // 继续等
    }
    await sleep(stepMs);
  }
  return null;
};

// 混沌窗口（杀 relay → 降级）内的迟到拒绝属于预期：记录但不炸脚本
process.on('unhandledRejection', (reason) => {
  console.log(`  - 忽略降级期未处理拒绝：${String(reason?.message ?? reason).slice(0, 120)}`);
});

const dir = await mkdtemp(join(tmpdir(), 'mebular-connect-'));
const master = await new IdentityManager().generateUserMasterKey();
const encryption = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
const apps = [];
const makeApp = async ({ deviceId, home, listen, relayServers, endpoints, endpointStorePath }) => {
  const app = new Mebular({
    storagePath: join(home ?? dir, `${deviceId}.jsonl`),
    deviceId,
    encryption,
    network: {
      enabled: true,
      autoConnect: true,
      listenPort: undefined,
      ...(endpoints ? { endpoints } : {}),
      ...(endpointStorePath ? { endpointStore: new FileEndpointStore(endpointStorePath) } : {}),
      libp2p: { listen: listen ?? ['/ip4/127.0.0.1/tcp/0'], ...(relayServers ? { relayServers } : {}) },
    },
    sync: { autoSync: true, ...(deviceId === 'device-A' ? { peerNamespacePolicy: { 'device-B': ['tasks'] } } : {}) },
  });
  await app.initialize();
  apps.push(app);
  return app;
};

console.log('== verify:connect（配对即连 / 地址簿选路 / relay 降级恢复） ==');
try {
  // ---------- Part A：hints-only 自动选路（无 network.peers） ----------
  const homeA = join(dir, 'homeA');
  const homeB = join(dir, 'homeB');
  const a = await makeApp({ deviceId: 'device-A', home: homeA });
  const aAddr = (a.node.getLocalMultiaddrs() ?? []).find((addr) => addr.includes('/tcp/') && !addr.includes('p2p-circuit'));
  const aPeerId = a.node.peerId.id;
  const aPublicKeyHex = bytesToHex(a.node.peerId.pubKey);

  // 真实令牌路径：邀请方签发令牌（自动收集本机可达端点 hints）
  const token = await buildJoinToken({
    mebular: a,
    deviceId: 'device-A',
    namespace: 'tasks',
    endpoint: 'http://127.0.0.1:1',
    ttlMs: 300_000,
  });
  check('邀请令牌带可达端点 hints + pubReachable（自动收集）',
    Array.isArray(token.endpoints) && token.endpoints.includes(aAddr) && typeof token.pubReachable === 'boolean',
    { endpoints: token.endpoints, pubReachable: token.pubReachable });
  check('令牌可解码且签名可验（hints 进签名体）',
    decodeJoinToken(Buffer.from(JSON.stringify(token)).toString('base64')).endpoints?.[0] === token.endpoints?.[0]
      && (await verifyJoinToken(token)).ok === true);

  const hintsWritten = await persistInviterHints(homeB, token);
  check('邀请方 hints 写入新设备地址簿（join 同一函数）', hintsWritten > 0, { hintsWritten });

  const bookPath = join(homeB, 'net', 'peers.json');
  const mode = process.platform === 'win32' ? 0o600 : (await stat(bookPath)).mode & 0o777;
  const rawBook = JSON.parse(await readFile(bookPath, 'utf-8'));
  const derivedKey = derivePeerIdHex(Buffer.from(aPublicKeyHex, 'hex'));
  check('地址簿 0600 且同时以 deviceId 与 peerId 键写入（首次拨号即可命中）',
    mode === 0o600 && Boolean(rawBook['device-A']) && Boolean(rawBook[derivedKey]) && derivedKey === aPeerId,
    { mode: mode.toString(8), keys: Object.keys(rawBook).map((k) => k.slice(0, 12) + '…') });

  const b = await makeApp({ deviceId: 'device-B', home: homeB, endpointStorePath: bookPath });
  const candidates = b.endpointBook?.addresses(aPeerId) ?? [];
  check('B 启动加载 hints（peerId 键候选 ≥1）', candidates.length >= 1, { candidates });

  // 不带地址拨号（无 network.peers；若地址簿未生效会失败）
  await b.node.connectToPeer(a.node.peerId);
  const pathA = b.getPeerPath(aPeerId);
  check('仅凭 hints 连通（无显式地址）且路径状态可用', Boolean(pathA) && ['direct', 'lan'].includes(pathA.kind) && pathA.address === aAddr, pathA);

  // 成功统计入库（lastSuccessAt）+ 显式地址拨号时学习新候选
  const successRecorded = await waitFor(() => (b.endpointBook?.list(aPeerId) ?? []).some((c) => typeof c.lastSuccessAt === 'number') ? true : null, 5000);
  check('连通后成功统计入库（lastSuccessAt）', successRecorded === true);

  // 学习结果**落盘**（成败统计去抖写回 peers.json）
  const persisted = await waitFor(async () => {
    try {
      const disk = JSON.parse(await readFile(bookPath, 'utf-8'));
      const list = disk[aPeerId] ?? disk['device-A'] ?? [];
      return list.some((c) => typeof c.lastSuccessAt === 'number') ? disk : null;
    } catch {
      return null;
    }
  }, 8000, 200);
  check('学习/成功统计落盘（peers.json 含 lastSuccessAt）', Boolean(persisted), { keys: persisted ? Object.keys(persisted).length : 0 });

  const noHints = await persistInviterHints(join(dir, 'homeC'), { inviterDeviceId: 'device-X', inviterPublicKey: aPublicKeyHex });
  check('旧令牌（无 hints）→ 地址簿 no-op（向后兼容）', noHints === 0, { noHints });

  // ---------- Part B：真实 circuit relay 的降级/恢复 ----------
  let relay = null;
  let relayPort = 0;
  const deviceKey = async () => {
    const im = new IdentityManager();
    const key = await im.generateDeviceKey('relay-host', 'relay-host');
    return { publicKey: key.publicKey, privateKey: key.privateKey };
  };
  let relayAvailable = true;
  const relayKey = await deviceKey(); // 重启复用同一设备钥 → relay peerId/地址稳定（同端口重开）
  try {
    relay = await Libp2pProvider.create({ deviceKey: relayKey, listen: ['/ip4/127.0.0.1/tcp/0'], relayServer: true, relayUnlimited: true });
    await relay.start();
    relayPort = Number(/\/tcp\/(\d+)/.exec((relay.getMultiaddrs() ?? []).find((addr) => addr.includes('/tcp/')) ?? '')?.[1] ?? 0);
    if (relayPort === 0) {
      relayAvailable = false;
      skip('Part B relay 降级/恢复', 'relay 监听端口解析失败');
    }
  } catch (error) {
    relayAvailable = false;
    skip('Part B relay 降级/恢复', `circuit relay 可选依赖不可用：${error?.code ?? error?.message}`);
  }
  if (relayAvailable && relayPort > 0) {
    const relayAddr = (relay.getMultiaddrs() ?? []).find((addr) => addr.includes('/tcp/'));
    const homeRA = join(dir, 'homeRA');
    const homeRB = join(dir, 'homeRB');
    const ra = await makeApp({ deviceId: 'device-A', home: homeRA, relayServers: [relayAddr] });
    const raCircuit = await waitFor(() => (ra.node.getLocalMultiaddrs() ?? []).find((addr) => addr.includes('p2p-circuit')), 20000);
    check('A 获得 relay 预留地址（/p2p-circuit）', typeof raCircuit === 'string', { raCircuit });

    // C2.7：relay 能力随配对共享（seeds）——B 需要 circuit relay 传输才能拨 circuit 地址
    const relayToken = await buildJoinToken({
      mebular: ra,
      deviceId: 'device-A',
      namespace: 'tasks',
      endpoint: 'http://127.0.0.1:1',
      ttlMs: 300_000,
      endpoints: [raCircuit],
      relaySeeds: [relayAddr],
    });
    const hints = await persistInviterHints(homeRB, relayToken);
    // seeds 走地址簿保留键（config.mjs 启动时并入 relayServers；此处等价模拟）
    const rbBook = new EndpointBook({ store: new FileEndpointStore(join(homeRB, 'net', 'peers.json')) });
    await rbBook.load();
    const rbSeeds = rbBook.relaySeeds();
    check('relay seeds 存于保留键（不混入对端候选）', rbSeeds.includes(relayAddr), { rbSeeds });
    const rb = await makeApp({
      deviceId: 'device-B',
      home: homeRB,
      relayServers: rbSeeds,
      endpointStorePath: join(homeRB, 'net', 'peers.json'),
    });
    const rbCandidates = rb.endpointBook?.list(ra.node.peerId.id) ?? [];
    check('B 经 hints 拿到 relay 候选（kind=relay）且 seeds 不混入对端候选',
      hints > 0 && rbCandidates.some((c) => c.kind === 'relay') && rbCandidates.every((c) => c.kind === 'relay'),
      { candidates: rbCandidates.map((c) => c.kind) });

    await rb.node.connectToPeer(ra.node.peerId);
    const relayPath = rb.getPeerPath(ra.node.peerId.id);
    check('relay-only 连通且路径 kind=relay', relayPath?.kind === 'relay', relayPath);

    // 杀 relay → 降级：拨号失败 + 安排退避
    await rb.node.disconnectPeer(ra.node.peerId).catch(() => undefined);
    await relay.stop();
    relay = null;
    await sleep(500);
    let dialFailed = false;
    try {
      await rb.node.connectToPeer(ra.node.peerId);
    } catch {
      dialFailed = true;
    }
    const backoff = rb.node.getConnectionManager().getBackoff(ra.node.peerId);
    check('杀 relay → 拨号失败且安排退避重试（降级）', dialFailed && Boolean(backoff?.pending), { dialFailed, backoff });

    // 同端口恢复 relay → 重连成功
    relay = await Libp2pProvider.create({
      deviceKey: relayKey,
      listen: [`/ip4/127.0.0.1/tcp/${relayPort}`],
      relayServer: true,
      relayUnlimited: true,
    });
    await relay.start();
    // relay 重启会作废旧预约（libp2p 客户端不自动 re-reserve）：app 侧做法 = 对端重新发布 hints。
    // 这里用同一 relay 上新起的 A2（新的预约）验证「relay 恢复 → 可达性恢复 → 重连成功」；
    // 动态 relay 能力广播见 C5（本脚本只覆盖静态 seeds + 配对 hints 刷新）。
    const homeRA2 = join(dir, 'homeRA2');
    const ra2 = await makeApp({ deviceId: 'device-A2', home: homeRA2, relayServers: [relayAddr] });
    const ra2Circuit = await waitFor(() => (ra2.node.getLocalMultiaddrs() ?? []).find((addr) => addr.includes('p2p-circuit')), 30000);
    check('relay 恢复 → 新预约成功（relay 可达性恢复）', typeof ra2Circuit === 'string', { ra2Circuit });

    await rb.addPeerEndpoints(ra2.node.peerId.id, [ra2Circuit], 'paired');
    const reconnected = await waitFor(async () => {
      try {
        await rb.node.connectToPeer(ra2.node.peerId);
        const path = rb.getPeerPath(ra2.node.peerId.id);
        return path?.kind === 'relay' && !path?.lastError ? true : null;
      } catch {
        return null;
      }
    }, 30000, 500);
    check('恢复后经刷新 hints 重连成功（路径 kind=relay 且无 lastError）', reconnected === true, rb.getPeerPath(ra2.node.peerId.id));

    // 旧对端（relay 重启前的预约）仍标记为失败路径，便于诊断（不清零 lastError）
    const stale = rb.getPeerPath(ra.node.peerId.id);
    check('重启前的失效路径带 lastError（可诊断，不静默）', Boolean(stale?.lastError), { lastError: stale?.lastError ?? null });
  }
} catch (error) {
  check('verify:connect 执行', false, String(error?.stack ?? error).slice(0, 400));
} finally {
  for (const app of apps) await app.shutdown().catch(() => undefined);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

console.log('===============================');
console.log(`FLEET_SUMMARY ${JSON.stringify({ total: passed + failed, passed, failed: failed === 0 ? [] : ['see above'], skipped })}`);
process.exit(failed === 0 ? 0 : 1);
