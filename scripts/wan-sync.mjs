#!/usr/bin/env node
// G3 广域网同步脚本（可复现）
//
// 目标：把「两主机端到端增量同步 + 冲突收敛」的步骤脚本化，并接上 relay
// 降级路径——有 circuit relay 走 relay，缺包/缺环境则诚实降级到手动 multiaddr。
//
// 子命令：
//   local  （默认）本机复现：两个真实 libp2p 节点经真实 TCP 完成增量同步与
//           并发冲突收敛。可用 --relay 走内嵌 circuit relay（circuit 地址）。
//   relay  启动独立中继节点（跨机场景），打印 multiaddr，Ctrl-C 退出。
//   host   单节点角色（跨机场景）：--role a 监听等待；--role b --peer <multiaddr>
//           拨号同步。两边都可用 --write 先写入一条记忆。
//
// 依赖：npm run build；libp2p 可选依赖；relay 需 @libp2p/circuit-relay-v2 + @libp2p/identify。
//
// 诚实边界（脚本会在证据文件与 stdout 中重申）：
//   - local 模式在单机 loopback 上验证协议语义，**不等于**跨 NAT 实测；
//   - relay 模式在单机内嵌 relay 上验证 circuit 链路，**不等于**真实公网 relay；
//   - 跨网段实测需 host 模式 + 两台真实主机 + 可达 relay/地址，结果需回填文档。

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const mebular = await import(join(rootDir, 'dist', 'index.js'));
const { Mebular, IdentityManager, Libp2pProvider } = mebular;

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const command = typeof args._[0] === 'string' ? args._[0] : 'local';

const LIMITATIONS = [
  'local 模式：单机 loopback 真实 TCP，验证协议语义，非跨 NAT 实测。',
  'relay 模式：单机内嵌 circuit relay，验证 circuit 链路，非真实公网 relay。',
  '跨网段实测需 host 模式 + 两台真实主机 + 可达 relay / 手动地址；当前环境不可得，结果未回填。',
  '内嵌 relay 以 applyDefaultLimit:false 运行（允许任意协议），v0.1 未做 relay 限额。',
];

// ---------- 工具 ----------

async function generateDeviceKey() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)),
    privateKey: kp.privateKey,
  };
}

function waitForSync(app, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`同步超时（${timeoutMs}ms）`)), timeoutMs);
    app.sync.once('sync-completed', (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function pickDirectAddress(app) {
  return app.node.getLocalMultiaddrs().find((a) => a.includes('/tcp/') && !a.includes('p2p-circuit'));
}

function pickRelayAddress(app) {
  return app.node.getLocalMultiaddrs().find((a) => a.includes('p2p-circuit'));
}

async function waitForRelayReservation(app, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const addr = pickRelayAddress(app);
    if (addr) return addr;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function connectAndSync(dialer, listener, address) {
  const dialerSynced = waitForSync(dialer);
  const listenerSynced = waitForSync(listener);
  await dialer.node.connectToPeer(listener.node.peerId, address);
  const [a, b] = await Promise.all([dialerSynced, listenerSynced]);
  return { dialer: a, listener: b };
}

function peerIdFromString(id) {
  return { multihash: new Uint8Array(), pubKey: new Uint8Array(), id };
}

async function makeApp({ dir, deviceId, masterKeys, relayServers }) {
  const app = new Mebular({
    storagePath: join(dir, `${deviceId}.jsonl`),
    deviceId,
    encryption: masterKeys,
    network: {
      enabled: true,
      libp2p: {
        listen: ['/ip4/127.0.0.1/tcp/0'],
        ...(relayServers?.length ? { relayServers } : {}),
      },
    },
    sync: { autoSync: true },
  });
  await app.initialize();
  return app;
}

function memoryText(node) {
  const content = node?.content;
  return typeof content === 'object' && content !== null ? content.text : content;
}

async function writeEvidence(evidence) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(rootDir, '.wan-evidence');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `wan-sync-${evidence.mode}-${stamp}.json`);
  await writeFile(outPath, JSON.stringify(evidence, null, 2), 'utf-8');
  return outPath;
}

function log(line) {
  console.log(line);
}

// ---------- local：单机复现直连/中继 + 冲突收敛 ----------

async function runLocal() {
  const useRelay = args.relay === true;
  const dir = await mkdtemp(join(tmpdir(), 'mebular-wan-'));
  const master = await new IdentityManager().generateUserMasterKey();
  const masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };

  let relayProvider = null;
  let relayAddress = null;
  let relayDegraded = false;
  let mode = 'direct';

  if (useRelay) {
    log('[relay] 尝试启动内嵌 circuit relay …');
    try {
      relayProvider = await Libp2pProvider.create({
        deviceKey: await generateDeviceKey(),
        listen: ['/ip4/127.0.0.1/tcp/0'],
        relayServer: true,
      });
      await relayProvider.start();
      relayAddress = relayProvider.getMultiaddrs().find((a) => a.includes('/tcp/'));
      mode = 'relay';
      log(`[relay] 已启动：${relayAddress}`);
    } catch (error) {
      // 降级路径：relay 可选依赖缺失时退回手动 multiaddr 直连
      relayProvider = null;
      relayDegraded = true;
      mode = 'direct-degraded';
      log(`[relay] 不可用（${error?.code ?? error?.message}）→ 降级为手动 multiaddr 直连`);
    }
  }

  const evidence = {
    mode,
    requestedRelay: useRelay,
    relayDegraded,
    relayAddress,
    startedAt: new Date().toISOString(),
    phases: [],
    limitations: LIMITATIONS,
    nodeCount: 2,
  };

  try {
    // 阶段 1：增量同步（A 写、B 收）
    let a = await makeApp({ dir, deviceId: 'device-A', masterKeys, relayServers: mode === 'relay' ? [relayAddress] : null });
    let b = await makeApp({ dir, deviceId: 'device-B', masterKeys, relayServers: mode === 'relay' ? [relayAddress] : null });
    const addressA = mode === 'relay' ? await waitForRelayReservation(a) : pickDirectAddress(a);
    if (!addressA) throw new Error('A 未暴露可拨地址');
    log(`[phase1] A 可拨地址：${addressA}`);
    log(`[phase1] relay 地址：${mode === 'relay' ? pickRelayAddress(a) : '（无）'}`);

    const node = await a.graph.createNode('fact', { text: 'base-memory' });
    const sync1 = await connectAndSync(b, a, addressA);
    const bGotBase = memoryText(await b.graph.getNode(node.id));
    evidence.phases.push({
      phase: 'incremental-sync',
      aAddress: addressA,
      aRelayAddress: pickRelayAddress(a) ?? null,
      sentEvents: sync1.dialer.sentEvents,
      receivedEvents: sync1.dialer.receivedEvents,
      bHasBase: bGotBase === 'base-memory',
      timestamp: new Date().toISOString(),
    });
    log(`[phase1] B 收到 A 的节点：${bGotBase === 'base-memory' ? '✓' : '✗'}（node=${node.id}）`);
    if (bGotBase !== 'base-memory') throw new Error('增量同步未收敛');

    await a.shutdown();
    await b.shutdown();

    // 阶段 2：离线并发冲突 → 重连收敛
    a = await makeApp({ dir, deviceId: 'device-A', masterKeys, relayServers: mode === 'relay' ? [relayAddress] : null });
    b = await makeApp({ dir, deviceId: 'device-B', masterKeys, relayServers: mode === 'relay' ? [relayAddress] : null });
    const addressA2 = mode === 'relay' ? await waitForRelayReservation(a) : pickDirectAddress(a);
    if (!addressA2) throw new Error('A（阶段 2）未暴露可拨地址');

    await a.graph.updateNode(node.id, { content: { text: 'from-A' } });
    await b.graph.updateNode(node.id, { content: { text: 'from-B' } });
    log('[phase2] A、B 各自离线写入冲突更新（from-A / from-B）');

    const sync2 = await connectAndSync(b, a, addressA2);
    const aWins = memoryText(await a.graph.getNode(node.id));
    const bWins = memoryText(await b.graph.getNode(node.id));
    const converged = aWins === bWins && (aWins === 'from-A' || aWins === 'from-B');
    evidence.phases.push({
      phase: 'conflict-convergence',
      aAddress: addressA2,
      aResult: aWins,
      bResult: bWins,
      converged,
      sentEvents: sync2.dialer.sentEvents,
      receivedEvents: sync2.dialer.receivedEvents,
      timestamp: new Date().toISOString(),
    });
    log(`[phase2] 收敛结果：A=${aWins} B=${bWins} → ${converged ? '✓ 一致' : '✗ 不一致'}`);
    if (!converged) throw new Error('冲突未收敛');

    await a.shutdown();
    await b.shutdown();
    evidence.completedAt = new Date().toISOString();
    evidence.ok = true;
  } catch (error) {
    evidence.ok = false;
    evidence.error = String(error?.stack ?? error);
    log(`✗ 失败：${error?.message ?? error}`);
  } finally {
    if (relayProvider) await relayProvider.stop().catch(() => undefined);
    const outPath = await writeEvidence(evidence);
    log(`证据写入：${outPath}`);
    if (!args.keep) await rm(dir, { recursive: true, force: true });
  }

  log(evidence.ok ? '✓ G3 local 同步验证通过' : '✗ G3 local 同步验证失败');
  process.exit(evidence.ok ? 0 : 1);
}

// ---------- relay：独立中继节点（跨机用） ----------

async function runRelay() {
  const port = Number(args.port ?? 4000);
  const provider = await Libp2pProvider.create({
    deviceKey: await generateDeviceKey(),
    listen: [`/ip4/0.0.0.0/tcp/${port}`],
    relayServer: true,
  });
  try {
    await provider.start();
  } catch (error) {
    log(`✗ relay 启动失败（${error?.code ?? error?.message}）。安装：npm i @libp2p/circuit-relay-v2 @libp2p/identify`);
    process.exit(1);
  }
  log('中继节点已启动。把下列 multiaddr 作为 relayServers 交给两端主机：');
  for (const addr of provider.getMultiaddrs()) {
    log(`  ${addr}`);
  }
  log('（Ctrl-C 退出）');
  const shutdown = async () => {
    await provider.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ---------- host：单节点角色（跨机用） ----------

async function runHost() {
  const role = typeof args.role === 'string' ? args.role : 'a';
  const dir = typeof args.dir === 'string' ? args.dir : await mkdtemp(join(tmpdir(), 'mebular-host-'));
  const master = await new IdentityManager().generateUserMasterKey();
  const masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  const relayServers = typeof args.relay === 'string' ? [args.relay] : null;

  const app = await makeApp({ dir, deviceId: `device-${role.toUpperCase()}`, masterKeys, relayServers });
  const nodeId = app.node.peerId.id;

  if (typeof args.write === 'string') {
    const written = await app.graph.createNode('fact', { text: args.write });
    log(`已写入：${written.id} = ${args.write}`);
  }

  if (typeof args.peer === 'string') {
    const remoteId = typeof args['peer-id'] === 'string' ? args['peer-id'] : 'device-A';
    log(`拨号 ${args.peer} …`);
    const synced = waitForSync(app, Number(args.timeout ?? 30000));
    await app.node.connectToPeer(peerIdFromString(remoteId), args.peer);
    const result = await synced;
    log(`同步完成：sent=${result.sentEvents} received=${result.receivedEvents}`);
  } else {
    log(`本机 deviceId：${nodeId}`);
    log('本机 multiaddr（把它交给对端作为 --peer）：');
    for (const addr of app.node.getLocalMultiaddrs()) log(`  ${addr}`);
    const waitMs = Number(args.wait ?? 120000);
    log(`等待对端接入（最多 ${waitMs}ms）…`);
    try {
      const result = await waitForSync(app, waitMs);
      log(`同步完成：sent=${result.sentEvents} received=${result.receivedEvents}`);
    } catch {
      log('等待超时（未发生同步）');
    }
  }

  for (const type of ['entity', 'fact', 'episode', 'skill', 'meta']) {
    for (const node of await app.graph.listNodes({ type })) {
      log(`  [${type}] ${JSON.stringify(node.content)}`);
    }
  }
  await app.shutdown();
  if (typeof args.dir !== 'string' && !args.keep) {
    await rm(dir, { recursive: true, force: true });
  }
  process.exit(0);
}

// ---------- 分发 ----------

if (command === 'relay') {
  await runRelay();
} else if (command === 'host') {
  await runHost();
} else if (command === 'local') {
  await runLocal();
} else {
  console.log(`未知子命令：${command}（支持 local | relay | host）`);
  process.exit(1);
}
