#!/usr/bin/env node
// G3-R 广域网同步脚本（可复现）
//
// 子命令：
//   local            本机回归（loopback，非 G3-R 证据）
//   relay            独立中继（--port --unlimited [--capture <path>]）
//   user-keygen      生成共享用户主密钥文件（--out）
//   peer             单端两阶段角色（--role a --user-master-key-file ...）
//   cross            对端编排 + 自校验（--peer <A-multiaddr> --peer-id <A-deviceId> [--relay ...]）
//   selftest         本机编排自测（共享身份 + 两阶段 + relay 密文），明确 non-evidence
//
// 诚实边界：
//   - local/selftest 在 loopback 上验证协议与编排逻辑，**不是** G3-R 跨网证据；
//   - G3-R 证据只在两台不同公网主机上由 `cross` 采集（本环境不可得，见阻塞报告）。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const selfPath = fileURLToPath(import.meta.url);

const mebular = await import(join(rootDir, 'dist', 'index.js'));
const { Mebular, IdentityManager, Libp2pProvider } = mebular;

const TYPES = ['entity', 'fact', 'episode', 'skill', 'meta'];

// ---------- 参数 ----------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(token);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const command = typeof args._[0] === 'string' ? args._[0] : 'local';

const log = (line) => console.log(line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 基础工具 ----------

async function generateDeviceKey() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)),
    privateKey: kp.privateKey,
  };
}

function waitForSync(app, timeoutMs = 60000) {
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

async function waitForRelayReservation(app, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const addr = pickRelayAddress(app);
    if (addr) return addr;
    await sleep(200);
  }
  return null;
}

function peerIdFromString(id) {
  return { multihash: new Uint8Array(), pubKey: new Uint8Array(), id };
}

function memoryText(node) {
  const content = node?.content;
  return typeof content === 'object' && content !== null ? content.text : content;
}

function publicIPv4s() {
  const out = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), 'utf-8');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function waitForFile(path, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      // 等待写入完成（JSON 可解析）
      try {
        return await readJson(path);
      } catch {
        // 半写状态，继续等
      }
    }
    await sleep(150);
  }
  throw new Error(`等待文件超时：${path}`);
}

// ---------- 共享用户主密钥 ----------

async function loadMasterKeys(source) {
  const src = source ?? process.env.MEBULAR_USER_MASTER_KEY;
  if (!src) return null;
  const data = existsSync(src) ? JSON.parse(await readFile(src, 'utf-8')) : JSON.parse(src);
  const userMasterKey = new Uint8Array(Buffer.from(data.publicKey, 'base64'));
  const userMasterPrivateKey = await IdentityManager.importPrivateKey(data.privateKeyPkcs8);
  return { userMasterKey, userMasterPrivateKey };
}

async function resolveMasterKeys(source) {
  const loaded = await loadMasterKeys(source);
  if (loaded) return loaded;
  log('⚠ 未提供共享用户主密钥（--user-master-key-file / MEBULAR_USER_MASTER_KEY）：本端自生成，跨机握手将失败。');
  log('  先运行 `node scripts/wan-sync.mjs user-keygen --out key.json` 并分发到两台主机。');
  const m = await new IdentityManager().generateUserMasterKey();
  return { userMasterKey: m.publicKey, userMasterPrivateKey: m.privateKey };
}

function masterKeyArgs() {
  return typeof args['user-master-key-file'] === 'string' ? args['user-master-key-file'] : undefined;
}

async function runUserKeygen() {
  const out = typeof args.out === 'string' ? args.out : join(rootDir, '.wan-evidence', 'user-master-key.json');
  const master = await new IdentityManager().generateUserMasterKey();
  const record = {
    publicKey: Buffer.from(master.publicKey).toString('base64'),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
    createdAt: new Date().toISOString(),
  };
  await writeJson(out, record);
  await chmod(out, 0o600);
  log(`✓ 用户主密钥已生成：${out}（权限 0600）`);
  log(`  分发到两台主机，随后在 peer/cross 使用 --user-master-key-file <path>。`);
  log(`  主公钥(base64)：${record.publicKey}`);
  process.exit(0);
}

// ---------- 图状态哈希（排除证据 meta 节点） ----------

function isEvidenceNode(node) {
  return (
    node.type === 'meta' &&
    typeof node.content?.name === 'string' &&
    node.content.name.startsWith('wan-evidence-')
  );
}

async function collectData(app) {
  const nodes = [];
  for (const type of TYPES) {
    for (const node of await app.graph.listNodes({ type })) nodes.push(node);
  }
  const edges = await app.graph.listEdges();
  return { nodes, edges };
}

function dataStateHash(nodes, edges) {
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const dataNodes = nodes.filter((n) => !isEvidenceNode(n));
  const canon = JSON.stringify({
    nodes: [...dataNodes].sort(byId).map((n) => ({ id: n.id, content: n.content, deletedAt: n.deletedAt ?? null })),
    edges: [...edges].sort(byId).map((e) => ({ id: e.id, source: e.source, target: e.target, relation: e.relation })),
  });
  return createHash('sha256').update(canon).digest('hex');
}

// ---------- App 工厂 ----------

async function makeApp({ dir, deviceId, masterKeys, relayServers, listen }) {
  const app = new Mebular({
    storagePath: join(dir, `${deviceId}.jsonl`),
    deviceId,
    encryption: masterKeys,
    network: {
      enabled: true,
      libp2p: {
        listen: listen ?? ['/ip4/127.0.0.1/tcp/0'],
        ...(relayServers?.length ? { relayServers } : {}),
      },
    },
    sync: { autoSync: true },
  });
  await app.initialize();
  return app;
}

// ---------- 阶段一：local 回归（loopback，非证据） ----------

async function connectAndSync(dialer, listener, address) {
  const dialerSynced = waitForSync(dialer);
  const listenerSynced = waitForSync(listener);
  await dialer.node.connectToPeer(listener.node.peerId, address);
  const [a, b] = await Promise.all([dialerSynced, listenerSynced]);
  return { dialer: a, listener: b };
}

async function runLocal() {
  const useRelay = args.relay === true;
  const dir = await mkdtemp(join(tmpdir(), 'mebular-wan-'));
  const masterKeys = await resolveMasterKeys(masterKeyArgs());
  let relayProvider = null;
  let relayAddress = null;
  let mode = 'direct';

  if (useRelay) {
    try {
      relayProvider = await Libp2pProvider.create({
        deviceKey: await generateDeviceKey(),
        listen: ['/ip4/127.0.0.1/tcp/0'],
        relayServer: true,
        relayUnlimited: true,
      });
      await relayProvider.start();
      relayAddress = relayProvider.getMultiaddrs().find((a) => a.includes('/tcp/'));
      mode = 'relay';
    } catch (error) {
      mode = 'direct-degraded';
      log(`[relay] 不可用（${error?.code ?? error?.message}）→ 降级手动 multiaddr`);
    }
  }

  const evidence = {
    mode,
    evidenceLevel: 'non-evidence (loopback regression)',
    startedAt: new Date().toISOString(),
    phases: [],
    limitations: ['loopback 非跨 NAT 实测；不得作为 G3-R 证据'],
  };

  try {
    let a = await makeApp({ dir, deviceId: 'device-A', masterKeys, relayServers: mode === 'relay' ? [relayAddress] : null });
    let b = await makeApp({ dir, deviceId: 'device-B', masterKeys, relayServers: mode === 'relay' ? [relayAddress] : null });
    const addressA = mode === 'relay' ? await waitForRelayReservation(a) : pickDirectAddress(a);
    const node = await a.graph.createNode('fact', { text: 'base-memory' });
    const sync1 = await connectAndSync(b, a, addressA);
    const bGotBase = memoryText(await b.graph.getNode(node.id));
    evidence.phases.push({ phase: 'incremental-sync', bHasBase: bGotBase === 'base-memory', ...sync1.dialer });
    if (bGotBase !== 'base-memory') throw new Error('增量同步未收敛');
    await a.shutdown();
    await b.shutdown();

    a = await makeApp({ dir, deviceId: 'device-A', masterKeys, relayServers: mode === 'relay' ? [relayAddress] : null });
    b = await makeApp({ dir, deviceId: 'device-B', masterKeys, relayServers: mode === 'relay' ? [relayAddress] : null });
    const addressA2 = mode === 'relay' ? await waitForRelayReservation(a) : pickDirectAddress(a);
    await a.graph.updateNode(node.id, { content: { text: 'from-A' } });
    await b.graph.updateNode(node.id, { content: { text: 'from-B' } });
    const sync2 = await connectAndSync(b, a, addressA2);
    const aWins = memoryText(await a.graph.getNode(node.id));
    const bWins = memoryText(await b.graph.getNode(node.id));
    const converged = aWins === bWins;
    evidence.phases.push({ phase: 'conflict-convergence', aResult: aWins, bResult: bWins, converged, ...sync2.dialer });
    if (!converged) throw new Error('冲突未收敛');
    await a.shutdown();
    await b.shutdown();
    evidence.ok = true;
  } catch (error) {
    evidence.ok = false;
    evidence.error = String(error?.stack ?? error);
    log(`✗ 失败：${error?.message ?? error}`);
  } finally {
    if (relayProvider) await relayProvider.stop().catch(() => undefined);
    const outPath = join(rootDir, '.wan-evidence', `wan-local-${Date.now()}.json`);
    await writeJson(outPath, evidence);
    log(`证据（non-evidence）：${outPath}`);
    if (!args.keep) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  log(evidence.ok ? '✓ G3 local 回归通过（非证据）' : '✗ G3 local 回归失败');
  process.exit(evidence.ok ? 0 : 1);
}

// ---------- relay 独立节点（可选流量捕获） ----------

function createCapture() {
  const chunks = [];
  let bytes = 0;
  const cap = 8 * 1024 * 1024;
  return {
    record(_dir, chunk) {
      bytes += chunk.length;
      if (bytes <= cap) chunks.push(Buffer.from(chunk));
    },
    get bytes() {
      return bytes;
    },
    buffer() {
      return Buffer.concat(chunks);
    },
    sha256() {
      return createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
    },
  };
}

function createCaptureProxy(targetPort, capture) {
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(targetPort, '127.0.0.1');
      client.on('data', (chunk) => {
        capture.record('client->relay', chunk);
        upstream.write(chunk);
      });
      upstream.on('data', (chunk) => {
        capture.record('relay->client', chunk);
        client.write(chunk);
      });
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', close);
      upstream.on('error', close);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function runRelay() {
  const port = Number(args.port ?? 4000);
  const unlimited = args.unlimited === true;
  const provider = await Libp2pProvider.create({
    deviceKey: await generateDeviceKey(),
    listen: [`/ip4/0.0.0.0/tcp/${port}`],
    relayServer: true,
    relayUnlimited: unlimited,
  });
  try {
    await provider.start();
  } catch (error) {
    log(`✗ relay 启动失败（${error?.code ?? error?.message}）。安装：npm i @libp2p/circuit-relay-v2 @libp2p/identify`);
    process.exit(1);
  }

  let proxy = null;
  let capture = null;
  if (typeof args.capture === 'string') {
    const relayInternal = provider.getMultiaddrs().find((a) => a.includes('/tcp/'));
    const relayPort = Number(relayInternal.match(/tcp\/(\d+)/)[1]);
    const relayPeerId = relayInternal.match(/\/p2p\/([^/]+)/)[1];
    capture = createCapture();
    proxy = await createCaptureProxy(relayPort, capture);
    const proxyAddr = `/ip4/0.0.0.0/tcp/${proxy.port}/p2p/${relayPeerId}`;
    log(`relay 流量捕获已启用 → ${args.capture}（proxy 端口 ${proxy.port}）`);
    log('relay multiaddr（用 proxy 地址）：');
    log(`  ${proxyAddr}`);
  } else {
    log(`relay 已启动（${unlimited ? 'UNLIMITED（允许任意协议，风险自担）' : 'LIMITED（默认限额）'}）。`);
    for (const addr of provider.getMultiaddrs()) log(`  ${addr}`);
  }
  log('（Ctrl-C 退出）');

  const shutdown = async () => {
    if (capture && typeof args.capture === 'string') {
      const evidence = {
        mode: 'relay-capture',
        capturedBytes: capture.bytes,
        capturedSha256: capture.sha256(),
        containsPlaintextMarker: null,
        note: '由 verify:wan:cross:selftest 断言不含明文记忆内容',
      };
      await writeJson(args.capture, evidence);
      log(`捕获证据写入：${args.capture}（${capture.bytes} 字节）`);
    }
    if (proxy) proxy.server.close();
    await provider.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ---------- peer：单端两阶段（role a：监听方，阶段间重启以模拟离线） ----------

function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function readyRecord(role, runId, app, baseNodeId, phase, masterKeys) {
  return {
    role,
    runId,
    phase,
    deviceId: app.node.peerId.id,
    userMasterPublicKey: b64(masterKeys.userMasterKey),
    multiaddrs: app.node.getLocalMultiaddrs(),
    baseNodeId,
    publicIPs: publicIPv4s(),
    at: new Date().toISOString(),
  };
}

function dialable(ready) {
  return (
    ready.multiaddrs?.find((a) => a.includes('/ip4/127.0.0.1/')) ??
    ready.multiaddrs?.find((a) => a.includes('/tcp/'))
  );
}

async function readReadyPhase(path, phase, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        const data = JSON.parse(await readFile(path, 'utf-8'));
        if (data.phase === phase) return data;
      } catch {
        // 半写状态，继续等
      }
    }
    await sleep(150);
  }
  throw new Error(`等待对端 ready phase=${phase} 超时：${path}`);
}

async function runPeer() {
  const role = typeof args.role === 'string' ? args.role : 'a';
  const runId = typeof args['run-id'] === 'string' ? args['run-id'] : `run-${Date.now().toString(36)}`;
  const masterKeys = await resolveMasterKeys(masterKeyArgs());
  const storageDir = typeof args.dir === 'string' ? args.dir : await mkdtemp(join(tmpdir(), 'mebular-peer-'));
  const relayServers = typeof args.relay === 'string' ? [args.relay] : null;
  const timeout = Number(args.timeout ?? 60000);
  const listen = typeof args.bind === 'string' ? [args.bind] : ['/ip4/0.0.0.0/tcp/0'];
  const readyOut = typeof args['ready-out'] === 'string' ? args['ready-out'] : null;
  const evidenceOut = typeof args['evidence-out'] === 'string' ? args['evidence-out'] : null;
  const start = () => makeApp({ dir: storageDir, deviceId: `device-${role.toUpperCase()}`, masterKeys, relayServers, listen });

  let app = null;
  let baseId = null;
  try {
    // 阶段 1：写入 base，等待对端首次同步
    app = await start();
    const base = await app.graph.createNode('fact', { text: `base-${runId}` });
    baseId = base.id;
    const s1 = waitForSync(app, timeout);
    if (readyOut) await writeJson(readyOut, readyRecord(role, runId, app, baseId, 1, masterKeys));
    await s1;
    log('[phase1] 增量同步完成');
    await app.shutdown();

    // 阶段 2：重启（离线）后并发写，等待对端第二次同步
    app = await start();
    await app.graph.updateNode(baseId, { content: { text: `${role.toUpperCase()}-offline` } });
    const s2 = waitForSync(app, timeout);
    if (readyOut) await writeJson(readyOut, readyRecord(role, runId, app, baseId, 2, masterKeys));
    await s2;
    const data = await collectData(app);
    const dataHash = dataStateHash(data.nodes, data.edges);
    log(`[phase2] 收敛 dataHash=${dataHash}`);
    await app.shutdown();

    // 阶段 3：重启后发布证据 meta，等待对端拉取
    app = await start();
    const evidence = {
      kind: 'wan-peer-evidence',
      role,
      runId,
      deviceId: app.node.peerId.id,
      userMasterPublicKey: b64(masterKeys.userMasterKey),
      publicIPs: publicIPv4s(),
      multiaddrs: app.node.getLocalMultiaddrs(),
      baseNodeId: baseId,
      baseValue: memoryText(await app.graph.getNode(baseId)),
      dataHash,
      publishedAt: new Date().toISOString(),
    };
    await app.graph.createNode('meta', {
      metaType: 'other',
      name: `wan-evidence-${runId}`,
      value: JSON.stringify(evidence),
    });
    const s3 = waitForSync(app, timeout);
    if (readyOut) await writeJson(readyOut, readyRecord(role, runId, app, baseId, 3, masterKeys));
    await s3;
    if (evidenceOut) await writeJson(evidenceOut, { ...evidence, syncSessions: 3 });
    log('✓ peer 三阶段完成（两阶段 + 证据交换）');
    await app.shutdown();
    process.exit(0);
  } catch (error) {
    log(`✗ peer 失败：${error?.message ?? error}`);
    if (app) await app.shutdown().catch(() => undefined);
    process.exit(1);
  }
}

// ---------- cross：对端编排 + 自校验（阶段间重启，地址经 ready 文件刷新） ----------

async function runCross() {
  const peerReady = typeof args['peer-ready'] === 'string' ? args['peer-ready'] : null;
  const relay = typeof args.relay === 'string' ? args.relay : process.env.MEBULAR_WAN_RELAY;
  if (!peerReady) {
    log('✗ G3-R 跨机两阶段编排需要 --peer-ready <对端持续刷新的 ready.json>（两端共享该文件）。');
    log('  对端（A）：node scripts/wan-sync.mjs peer --role a --user-master-key-file key.json --ready-out <共享路径>/A-ready.json --bind /ip4/0.0.0.0/tcp/0');
    log('  本机（B）：node scripts/wan-sync.mjs cross --user-master-key-file key.json --peer-ready <共享路径>/A-ready.json --out <共享路径>/B-evidence.json');
    log('  可选：--relay <relay multiaddr>（relay 需 --unlimited）。当前环境无两主机，判为阻塞（见 docs.design/g3r-blocker）。');
    process.exit(1);
  }

  const allowSameNetwork = args['allow-same-network'] === true;
  const masterKeys = await resolveMasterKeys(masterKeyArgs());
  const storageDir = await mkdtemp(join(tmpdir(), 'mebular-cross-'));
  const timeout = Number(args.timeout ?? 60000);
  const listen = typeof args.bind === 'string' ? [args.bind] : ['/ip4/0.0.0.0/tcp/0'];
  const deviceId = `device-B-${process.pid}`;
  const start = () => makeApp({ dir: storageDir, deviceId, masterKeys, relayServers: relay ? [relay] : null, listen });

  let app = null;
  const startedAt = new Date().toISOString();
  try {
    // 阶段 1：增量同步
    const r1 = await readReadyPhase(peerReady, 1, timeout);
    const runId = r1.runId;
    app = await start();
    let synced = waitForSync(app, timeout);
    await app.node.connectToPeer(peerIdFromString(r1.deviceId), dialable(r1));
    const s1 = await synced;
    const base = (await app.graph.listNodes({ type: 'fact' })).find((n) =>
      String(n.content?.text ?? '').startsWith('base-'),
    );
    if (!base) throw new Error('未在同步结果中找到 base 节点');
    await app.shutdown();
    log(`[phase1] 增量同步完成（base=${base.id}）`);

    // 阶段 2：离线并发写 → 重连收敛
    const r2 = await readReadyPhase(peerReady, 2, timeout);
    app = await start();
    await app.graph.updateNode(base.id, { content: { text: 'B-offline' } });
    synced = waitForSync(app, timeout);
    await app.node.connectToPeer(peerIdFromString(r2.deviceId), dialable(r2));
    await synced;
    const converged = memoryText(await app.graph.getNode(base.id));
    const local = await collectData(app);
    const localHash = dataStateHash(local.nodes, local.edges);
    await app.shutdown();
    log(`[phase2] 收敛=${converged} dataHash=${localHash}`);

    // 阶段 3：拉取对端证据 meta 并自校验
    const r3 = await readReadyPhase(peerReady, 3, timeout);
    app = await start();
    synced = waitForSync(app, timeout);
    await app.node.connectToPeer(peerIdFromString(r3.deviceId), dialable(r3));
    await synced;
    const evNode = (await app.graph.listNodes({ type: 'meta' })).find(
      (n) => String(n.content?.name ?? '') === `wan-evidence-${runId}`,
    );
    const peerEvidence = evNode ? JSON.parse(String(evNode.content.value)) : null;

    const myIPs = publicIPv4s();
    const peerIPs = peerEvidence?.publicIPs ?? [];
    const differentNetwork =
      myIPs.length > 0 && peerIPs.length > 0 && !peerIPs.some((ip) => myIPs.includes(ip));
    const stateMatches = peerEvidence?.dataHash === localHash;
    const identityShared = peerEvidence?.userMasterPublicKey === b64(masterKeys.userMasterKey);

    const evidence = {
      mode: 'cross',
      evidenceLevel: allowSameNetwork
        ? 'non-evidence (loopback orchestration; --allow-same-network)'
        : 'evidence (requires two hosts on different public networks)',
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      localPublicIPs: myIPs,
      peerPublicIPs: peerIPs,
      peerDeviceId: r3.deviceId,
      relay: relay ?? null,
      identityShared,
      phases: {
        incrementalSync: { sentEvents: s1.sentEvents, receivedEvents: s1.receivedEvents },
        conflictConvergence: { value: converged },
        evidenceExchange: true,
      },
      convergedValue: converged,
      nodeCount: local.nodes.length,
      stateHash: localHash,
      peerStateHash: peerEvidence?.dataHash ?? null,
      stateMatches,
      differentPublicNetwork: differentNetwork,
      ok: stateMatches && identityShared && !!converged && (differentNetwork || allowSameNetwork),
    };
    const outPath =
      typeof args.out === 'string' ? args.out : join(rootDir, '.wan-evidence', `wan-cross-${Date.now()}.json`);
    await writeJson(outPath, evidence);
    log(`stateMatches=${stateMatches} differentPublicNetwork=${differentNetwork} identityShared=${identityShared}`);
    log(`证据写入：${outPath}`);
    await app.shutdown();
    process.exit(evidence.ok ? 0 : 1);
  } catch (error) {
    const evidence = { mode: 'cross', startedAt, completedAt: new Date().toISOString(), ok: false, error: String(error?.stack ?? error) };
    const outPath = typeof args.out === 'string' ? args.out : join(rootDir, '.wan-evidence', `wan-cross-${Date.now()}.json`);
    await writeJson(outPath, evidence).catch(() => undefined);
    log(`✗ cross 失败：${error?.message ?? error}`);
    if (app) await app.shutdown().catch(() => undefined);
    process.exit(1);
  }
}

// ---------- selftest：本机编排自测（non-evidence） ----------

function runChild(extraArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [selfPath, ...extraArgs], { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function collectCaptureMarker(buf, marker) {
  const latin = buf.toString('latin1');
  const markerLatin = Buffer.from(marker, 'utf-8').toString('latin1');
  return latin.includes(marker) || latin.includes(markerLatin);
}

async function relayCipherSelfCheck(keyFile, dir) {
  const masterKeys = await resolveMasterKeys(keyFile);
  const relay = await Libp2pProvider.create({
    deviceKey: await generateDeviceKey(),
    listen: ['/ip4/127.0.0.1/tcp/0'],
    relayServer: true,
    relayUnlimited: true,
  });
  await relay.start();
  const relayInternal = relay.getMultiaddrs().find((a) => a.includes('/tcp/'));
  const relayPort = Number(relayInternal.match(/tcp\/(\d+)/)[1]);
  const relayPeerId = relayInternal.match(/\/p2p\/([^/]+)/)[1];
  const capture = createCapture();
  const proxy = await createCaptureProxy(relayPort, capture);
  const proxyAddr = `/ip4/127.0.0.1/tcp/${proxy.port}/p2p/${relayPeerId}`;

  const marker = `RELAY-CIPHER-MARKER-${crypto.randomUUID()}`;
  const a = await makeApp({ dir, deviceId: 'device-CA', masterKeys, relayServers: [proxyAddr] });
  const b = await makeApp({ dir, deviceId: 'device-CB', masterKeys, relayServers: [proxyAddr] });
  try {
    const circuitA = await waitForRelayReservation(a);
    if (!circuitA) throw new Error('A 未取得 circuit 预约');
    await a.graph.createNode('fact', { text: marker });
    const sA = waitForSync(a);
    const sB = waitForSync(b);
    await b.node.connectToPeer(a.node.peerId, circuitA);
    await Promise.all([sA, sB]);
    const buf = capture.buffer();
    const found = collectCaptureMarker(buf, marker);
    return {
      ok: !found && capture.bytes > 0,
      capturedBytes: capture.bytes,
      capturedSha256: capture.sha256(),
      plaintextMarkerFound: found,
      note: 'Noise 传输 + SecureChannel E2E 加密；relay 侧线上字节不含明文记忆',
    };
  } finally {
    proxy.server.close();
    await a.shutdown().catch(() => undefined);
    await b.shutdown().catch(() => undefined);
    await relay.stop().catch(() => undefined);
  }
}

async function runSelftest() {
  const dir = await mkdtemp(join(tmpdir(), 'mebular-selftest-'));
  const keyFile = join(dir, 'user-master-key.json');
  const aReady = join(dir, 'a-ready.json');
  const bEvidence = join(dir, 'b-evidence.json');
  const runId = `selftest-${Date.now().toString(36)}`;
  const master = await new IdentityManager().generateUserMasterKey();
  await writeJson(keyFile, {
    publicKey: Buffer.from(master.publicKey).toString('base64'),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
  });

  const result = { mode: 'selftest', evidenceLevel: 'non-evidence (loopback orchestration)', startedAt: new Date().toISOString() };
  try {
    log('[selftest] 启动 A（peer 两阶段）…');
    const aProc = runChild([
      'peer',
      '--role',
      'a',
      '--run-id',
      runId,
      '--user-master-key-file',
      keyFile,
      '--ready-out',
      aReady,
      '--bind',
      '/ip4/127.0.0.1/tcp/0',
      '--timeout',
      '60000',
    ]);
    const ready = await waitForFile(aReady, 30000);
    log(`[selftest] A ready：${ready.deviceId} @ ${ready.multiaddrs?.[0]}`);

    log('[selftest] 启动 B（cross 编排）…');
    const bProc = await runChild([
      'cross',
      '--user-master-key-file',
      keyFile,
      '--peer-ready',
      aReady,
      '--out',
      bEvidence,
      '--allow-same-network',
      '--timeout',
      '60000',
    ]);
    const a = await aProc;
    if (bProc.code !== 0) {
      log(bProc.out);
      log(bProc.err);
      throw new Error(`cross 退出码 ${bProc.code}`);
    }
    if (a.code !== 0) throw new Error(`peer 退出码 ${a.code}`);

    const evidence = await readJson(bEvidence);
    result.orchestration = {
      crossExitCode: bProc.code,
      peerExitCode: a.code,
      stateMatches: evidence.stateMatches,
      identityShared: evidence.identityShared,
      convergedValue: evidence.convergedValue,
      phases: evidence.phases,
      peerPublicIPs: evidence.peerPublicIPs,
      localPublicIPs: evidence.localPublicIPs,
      differentPublicNetwork: evidence.differentPublicNetwork,
      note: 'loopback：differentPublicNetwork=false 属预期；跨网判定不在此自测范围',
    };
    if (!evidence.stateMatches) throw new Error('双端 dataHash 不一致');
    if (!evidence.identityShared) throw new Error('共享用户身份未生效');
    if (evidence.convergedValue !== 'from-A' && evidence.convergedValue !== 'B-offline') {
      throw new Error(`两阶段未收敛：${evidence.convergedValue}`);
    }

    log('[selftest] relay 密文自检…');
    result.relayCipher = await relayCipherSelfCheck(keyFile, dir);
    if (!result.relayCipher.ok) throw new Error('relay 密文自检失败（捕获到明文或未捕获流量）');

    result.ok = true;
    result.completedAt = new Date().toISOString();
    log('✓ G3-P selftest 通过（non-evidence）');
    log(`  orchestration.stateMatches=${evidence.stateMatches} identityShared=${evidence.identityShared} converged=${evidence.convergedValue}`);
    log(`  relayCipher.capturedBytes=${result.relayCipher.capturedBytes} plaintextMarkerFound=${result.relayCipher.plaintextMarkerFound}`);
  } catch (error) {
    result.ok = false;
    result.error = String(error?.stack ?? error);
    log(`✗ selftest 失败：${error?.message ?? error}`);
  } finally {
    const outPath = join(rootDir, '.wan-evidence', `wan-selftest-${Date.now()}.json`);
    await writeJson(outPath, result).catch(() => undefined);
    log(`证据（non-evidence）：${outPath}`);
    if (!args.keep) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  process.exit(result.ok ? 0 : 1);
}

// ---------- 分发 ----------

if (command === 'relay') await runRelay();
else if (command === 'user-keygen') await runUserKeygen();
else if (command === 'peer') await runPeer();
else if (command === 'cross') await runCross();
else if (command === 'selftest') await runSelftest();
else if (command === 'local') await runLocal();
else {
  console.log(`未知子命令：${command}（支持 local | relay | user-keygen | peer | cross | selftest）`);
  process.exit(1);
}
