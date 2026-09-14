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

/** 连接并同步，直到 predicate 成立（重试并断开重连，规避会话半交换） */
async function connectUntil(dialer, listener, address, predicate, attempts = 4, timeoutMs = 15000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const dialerSynced = waitForSync(dialer, timeoutMs);
      const listenerSynced = waitForSync(listener, timeoutMs);
      await dialer.node.connectToPeer(listener.node.peerId, address);
      const [a, b] = await Promise.all([dialerSynced, listenerSynced]);
      if (await predicate()) return { dialer: a, listener: b };
    } catch {
      // 半交换/超时，重试
    }
    await dialer.node.disconnectPeer(listener.node.peerId).catch(() => undefined);
    await listener.node.disconnectPeer(dialer.node.peerId).catch(() => undefined);
    await sleep(500);
  }
  return null;
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
    const sync1 = await connectUntil(b, a, addressA, async () => memoryText(await b.graph.getNode(node.id)) === 'base-memory');
    if (!sync1) throw new Error('增量同步未收敛');
    evidence.phases.push({ phase: 'incremental-sync', bHasBase: true, ...sync1.dialer });
    await a.shutdown();
    await b.shutdown();

    a = await makeApp({ dir, deviceId: 'device-A', masterKeys, relayServers: mode === 'relay' ? [relayAddress] : null });
    b = await makeApp({ dir, deviceId: 'device-B', masterKeys, relayServers: mode === 'relay' ? [relayAddress] : null });
    const addressA2 = mode === 'relay' ? await waitForRelayReservation(a) : pickDirectAddress(a);
    await a.graph.updateNode(node.id, { content: { text: 'from-A' } });
    await b.graph.updateNode(node.id, { content: { text: 'from-B' } });
    const sync2 = await connectUntil(
      b, a, addressA2,
      async () => {
        const av = memoryText(await a.graph.getNode(node.id));
        const bv = memoryText(await b.graph.getNode(node.id));
        return av === bv && (av === 'from-A' || av === 'from-B');
      },
    );
    if (!sync2) throw new Error('冲突未收敛');
    const aWins = memoryText(await a.graph.getNode(node.id));
    const bWins = memoryText(await b.graph.getNode(node.id));
    evidence.phases.push({ phase: 'conflict-convergence', aResult: aWins, bResult: bWins, converged: true, ...sync2.dialer });
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

// ---------- 出口 IP 判据（P2-3：公网出口，非网卡接口） ----------

const DEFAULT_IP_ECHO = 'https://api.ipify.org?format=json';

async function lookupEgress(timeoutMs = 4000) {
  const source = process.env.MEBULAR_WAN_IP_ECHO || DEFAULT_IP_ECHO;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(source, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).trim();
    let ip = null;
    let org = null;
    try {
      const j = JSON.parse(text);
      ip = typeof j.ip === 'string' ? j.ip : null;
      org = typeof j.org === 'string' ? j.org : null;
    } catch {
      ip = text;
    }
    if (!ip || !/^[0-9a-fA-F:.]+$/.test(ip)) throw new Error('unexpected egress payload');
    return { ip, org, asn: org ? org.split(/\s+/)[0] : null, source, error: null };
  } catch (error) {
    return { ip: null, org: null, asn: null, source, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

function isPrivateIp(ip) {
  if (!ip) return true;
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return true; // 非 IPv4 且非已知公网 v6 → 保守判私网/未知
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/** 出口 IP 判据：任一未知/私网 → false/未知；均公网且不同 → true（绝不基于接口 IP） */
function judgeDifferentNetwork(localIp, peerIp) {
  if (!localIp || !peerIp) return { value: null, basis: 'egress-unknown' };
  if (isPrivateIp(localIp) || isPrivateIp(peerIp)) return { value: false, basis: 'private-or-loopback' };
  if (localIp === peerIp) return { value: false, basis: 'same-egress-ip' };
  return { value: true, basis: 'distinct-public-egress' };
}

// ---------- peer：单端三阶段（稳定地址，无共享文件） ----------

function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function startWithRetry(start, attempts = 12) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await start();
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw lastError ?? new Error('startWithRetry 失败');
}

async function runPeer() {
  const role = typeof args.role === 'string' ? args.role : 'a';
  const runId = typeof args['run-id'] === 'string' ? args['run-id'] : `run-${Date.now().toString(36)}`;
  const masterKeys = await resolveMasterKeys(masterKeyArgs());
  const storageDir = typeof args.dir === 'string' ? args.dir : await mkdtemp(join(tmpdir(), 'mebular-peer-'));
  const relayServers = typeof args.relay === 'string' ? [args.relay] : null;
  const timeout = Number(args.timeout ?? 60000);
  const bind = typeof args.bind === 'string' ? args.bind : '/ip4/0.0.0.0/tcp/4001';
  const start = () => makeApp({ dir: storageDir, deviceId: `device-${role.toUpperCase()}`, masterKeys, relayServers, listen: [bind] });
  const egress = await lookupEgress();

  let app = null;
  let baseId = null;
  try {
    // 阶段 1
    app = await startWithRetry(start);
    const base = await app.graph.createNode('fact', { text: `base-${runId}` });
    baseId = base.id;
    const stableAddress = pickRelayAddress(app) ?? pickDirectAddress(app);
    log(`PEER_READY ${JSON.stringify({ role, runId, deviceId: app.node.peerId.id, multiaddrs: app.node.getLocalMultiaddrs(), stableAddress, bind, at: new Date().toISOString() })}`);
    await waitForSync(app, timeout);
    log('[phase1] 增量同步完成');
    await app.shutdown();
    app = null;

    // 阶段 2
    app = await startWithRetry(start);
    await app.graph.updateNode(baseId, { content: { text: `${role.toUpperCase()}-offline` } });
    log('PEER_PHASE 2');
    await waitForSync(app, timeout);
    const data = await collectData(app);
    const dataHash = dataStateHash(data.nodes, data.edges);
    log(`[phase2] 收敛 dataHash=${dataHash}`);
    await app.shutdown();
    app = null;

    // 阶段 3
    app = await startWithRetry(start);
    const evidence = {
      kind: 'wan-peer-evidence',
      role,
      runId,
      deviceId: app.node.peerId.id,
      userMasterPublicKey: b64(masterKeys.userMasterKey),
      egress: { ip: egress.ip, asn: egress.asn, org: egress.org, source: egress.source, error: egress.error },
      interfaceIPv4s: publicIPv4s(),
      multiaddrs: app.node.getLocalMultiaddrs(),
      baseNodeId: baseId,
      baseValue: memoryText(await app.graph.getNode(baseId)),
      dataHash,
      publishedAt: new Date().toISOString(),
    };
    await app.graph.createNode('meta', { metaType: 'other', name: `wan-evidence-${runId}`, value: JSON.stringify(evidence) });
    log('PEER_PHASE 3');
    await waitForSync(app, timeout);
    if (typeof args['evidence-out'] === 'string') await writeJson(args['evidence-out'], { ...evidence, syncSessions: 3 });
    log('✓ peer 三阶段完成（两阶段 + 证据交换）');
    await app.shutdown();
    process.exit(0);
  } catch (error) {
    log(`✗ peer 失败：${error?.message ?? error}`);
    if (app) await app.shutdown().catch(() => undefined);
    process.exit(1);
  }
}

// ---------- cross：稳定地址编排 + 自校验（无共享文件） ----------

async function tryPhase(app, remote, addr, predicate, attempts, timeoutMs, gapMs = 800) {
  for (let i = 0; i < attempts; i++) {
    try {
      await app.node.disconnectPeer(remote).catch(() => undefined);
      const synced = waitForSync(app, timeoutMs);
      await app.node.connectToPeer(remote, addr);
      const result = await synced;
      if (await predicate()) return result;
    } catch {
      // 对端阶段未就绪或图上状态不符，重试
    }
    await sleep(gapMs);
  }
  return null;
}

// ---------- 跨机前置预检（缺配置/不可达时立即报错，不跑到中途才失败） ----------

function parseTcpTarget(multiaddr) {
  if (typeof multiaddr !== 'string') return null;
  const m = /(?:\/ip4\/([^/]+)|\/ip6\/([^/]+)|\/dns4\/([^/]+)|\/dns6\/([^/]+))\/tcp\/(\d+)/.exec(multiaddr);
  if (!m) return null;
  return { host: m[1] ?? m[2] ?? m[3] ?? m[4], port: Number(m[5]) };
}

function probeTcp(host, port, timeoutMs) {
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

function printCrossGuidance() {
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

async function preflightCross({ peer, peerId, relay }) {
  const problems = [];
  if (!peer) problems.push('缺少 HOST_A 地址（--peer 或 MEBULAR_WAN_PEER）');
  if (!peerId) problems.push('缺少 HOST_A deviceId（--peer-id 或 MEBULAR_WAN_PEER_ID）');
  const peerTarget = peer ? parseTcpTarget(peer) : null;
  if (peer && !peerTarget) problems.push(`HOST_A 地址解析不出 TCP 目标：${peer}`);
  const relayTarget = relay ? parseTcpTarget(relay) : null;
  if (relay && !relayTarget) problems.push(`RELAY 地址解析不出 TCP 目标：${relay}`);

  if (problems.length === 0) {
    const timeoutMs = Number(process.env.MEBULAR_WAN_PREFLIGHT_TIMEOUT_MS ?? 3000);
    const targets = [{ name: 'HOST_A', target: peerTarget }];
    if (relayTarget) targets.push({ name: 'RELAY', target: relayTarget });
    for (const { name, target } of targets) {
      const r = await probeTcp(target.host, target.port, timeoutMs);
      if (!r.ok) problems.push(`${name} 不可达：${target.host}:${target.port}（${r.error}）`);
    }
  }

  if (problems.length > 0) {
    log('✗ G3-R 跨机前置预检未通过（尚未开始同步）：');
    for (const p of problems) log(`  - ${p}`);
    printCrossGuidance();
    return false;
  }
  log(`[preflight] 通过：HOST_A=${peerTarget.host}:${peerTarget.port}${relayTarget ? `  RELAY=${relayTarget.host}:${relayTarget.port}` : ''}`);
  return true;
}

async function runCross() {
  const peer = typeof args.peer === 'string' ? args.peer : process.env.MEBULAR_WAN_PEER;
  const peerId = typeof args['peer-id'] === 'string' ? args['peer-id'] : process.env.MEBULAR_WAN_PEER_ID;
  const relay = typeof args.relay === 'string' ? args.relay : process.env.MEBULAR_WAN_RELAY;

  // 前置预检：缺配置/不可达直接明确报错并给指引，不跑到中途才失败
  if (!(await preflightCross({ peer, peerId, relay }))) {
    process.exit(1);
  }

  const allowSameNetwork = args['allow-same-network'] === true;
  const masterKeys = await resolveMasterKeys(masterKeyArgs());
  const storageDir = await mkdtemp(join(tmpdir(), 'mebular-cross-'));
  const timeout = Number(args.timeout ?? 60000);
  const attempts = Number(args['phase-attempts'] ?? 30);
  const listen = typeof args.bind === 'string' ? [args.bind] : ['/ip4/0.0.0.0/tcp/0'];
  const deviceId = `device-B-${process.pid}`;
  const start = () => makeApp({ dir: storageDir, deviceId, masterKeys, relayServers: relay ? [relay] : null, listen });
  const egress = await lookupEgress();
  const remote = peerIdFromString(peerId);
  const startedAt = new Date().toISOString();

  let app = null;
  try {
    app = await start();

    // 阶段 1：增量同步
    const r1 = await tryPhase(
      app, remote, peer,
      async () => (await app.graph.listNodes({ type: 'fact' })).some((n) => String(n.content?.text ?? '').startsWith('base-')),
      attempts, timeout,
    );
    if (!r1) throw new Error('阶段 1 未完成（增量同步）');
    const base = (await app.graph.listNodes({ type: 'fact' })).find((n) => String(n.content?.text ?? '').startsWith('base-'));
    const runId = String(base.content.text).slice('base-'.length);
    log(`[phase1] 增量同步完成（base=${base.id}）`);

    // 阶段 2：离线并发写 → 重连收敛
    await app.graph.updateNode(base.id, { content: { text: 'B-offline' } });
    const r2 = await tryPhase(
      app, remote, peer,
      async () => {
        const t = memoryText(await app.graph.getNode(base.id));
        return t === 'A-offline' || t === 'B-offline';
      },
      attempts, timeout,
    );
    if (!r2) throw new Error('阶段 2 未完成（冲突收敛）');
    const converged = memoryText(await app.graph.getNode(base.id));
    log(`[phase2] 收敛=${converged}`);

    // 阶段 3：拉取对端证据 meta
    const r3 = await tryPhase(
      app, remote, peer,
      async () => (await app.graph.listNodes({ type: 'meta' })).some((n) => String(n.content?.name ?? '') === `wan-evidence-${runId}`),
      attempts, timeout,
    );
    if (!r3) throw new Error('阶段 3 未完成（证据交换）');
    const evNode = (await app.graph.listNodes({ type: 'meta' })).find((n) => String(n.content?.name ?? '') === `wan-evidence-${runId}`);
    const peerEvidence = JSON.parse(String(evNode.content.value));

    const local = await collectData(app);
    const localHash = dataStateHash(local.nodes, local.edges);
    const judge = judgeDifferentNetwork(egress.ip, peerEvidence?.egress?.ip ?? null);
    const stateMatches = peerEvidence?.dataHash === localHash;
    const identityShared = peerEvidence?.userMasterPublicKey === b64(masterKeys.userMasterKey);
    const sameAsn = egress.asn && peerEvidence?.egress?.asn ? egress.asn === peerEvidence.egress.asn : null;

    const evidence = {
      mode: 'cross',
      evidenceLevel: allowSameNetwork
        ? 'non-evidence (loopback orchestration; --allow-same-network)'
        : 'evidence (requires two hosts on different public networks)',
      coordination: 'stable-address + graph-state phase check (no shared filesystem)',
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      localEgress: { ip: egress.ip, asn: egress.asn, org: egress.org, source: egress.source, error: egress.error },
      peerEgress: peerEvidence?.egress ?? null,
      interfaceIPv4s: publicIPv4s(),
      peerDeviceId: peerId,
      relay: relay ?? null,
      identityShared,
      phases: {
        incrementalSync: { sentEvents: r1.sentEvents, receivedEvents: r1.receivedEvents },
        conflictConvergence: { value: converged },
        evidenceExchange: true,
      },
      convergedValue: converged,
      nodeCount: local.nodes.length,
      stateHash: localHash,
      peerStateHash: peerEvidence?.dataHash ?? null,
      stateMatches,
      differentPublicNetwork: judge.value,
      differentPublicNetworkBasis: judge.basis,
      egressService: egress.source,
      sameAsn,
      ok: stateMatches && identityShared && !!converged && (allowSameNetwork || judge.value === true),
    };
    const outPath = typeof args.out === 'string' ? args.out : join(rootDir, '.wan-evidence', `wan-cross-${Date.now()}.json`);
    await writeJson(outPath, evidence);
    log(`stateMatches=${stateMatches} differentPublicNetwork=${judge.value} (${judge.basis}) identityShared=${identityShared}`);
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

// ---------- selftest：独立进程 + 独立存储 + 无共享路径（non-evidence） ----------

function spawnChild(extraArgs, extraEnv = {}) {
  const child = spawn(process.execPath, [selfPath, ...extraArgs], {
    cwd: rootDir,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let lineBuf = '';
  const waiters = [];
  const feed = (line) => {
    out += line + '\n';
    for (const w of [...waiters]) {
      if (line.includes(w.marker)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(line);
      }
    }
  };
  child.stdout.on('data', (d) => {
    lineBuf += d.toString();
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      feed(lineBuf.slice(0, idx));
      lineBuf = lineBuf.slice(idx + 1);
    }
  });
  child.stderr.on('data', (d) => {
    err += d.toString();
  });
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
  const waitLine = (marker, timeoutMs) => {
    const existing = out.split('\n').find((l) => l.includes(marker));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待子进程输出「${marker}」超时`)), timeoutMs);
      waiters.push({ marker, resolve: (line) => { clearTimeout(timer); resolve(line); } });
    });
  };
  return { child, done, waitLine };
}

async function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function collectCaptureMarker(buf, marker) {
  const latin = buf.toString('latin1');
  const markerLatin = Buffer.from(marker, 'utf-8').toString('latin1');
  return latin.includes(marker) || latin.includes(markerLatin);
}

async function relayCipherSelfCheck(keySource, dir) {
  const masterKeys = await resolveMasterKeys(keySource);
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
  const outDir = await mkdtemp(join(tmpdir(), 'mebular-selftest-'));
  const runId = `selftest-${Date.now().toString(36)}`;
  const master = await new IdentityManager().generateUserMasterKey();
  const keyJson = JSON.stringify({
    publicKey: b64(master.publicKey),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
  });
  const env = { MEBULAR_USER_MASTER_KEY: keyJson };
  const port = await freeTcpPort();
  const result = {
    mode: 'selftest',
    evidenceLevel: 'non-evidence (loopback; two independent processes/storage, no shared path)',
    startedAt: new Date().toISOString(),
  };
  try {
    log('[selftest] 启动 A（独立进程/独立存储，稳定地址，无共享文件）…');
    const a = spawnChild(
      ['peer', '--role', 'a', '--run-id', runId, '--bind', `/ip4/127.0.0.1/tcp/${port}`, '--timeout', '60000'],
      env,
    );
    const readyLine = await a.waitLine('PEER_READY', 30000);
    const ready = JSON.parse(readyLine.slice(readyLine.indexOf('PEER_READY') + 'PEER_READY'.length).trim());
    const peerAddr = ready.multiaddrs.find((x) => x.includes('/ip4/127.0.0.1/')) ?? ready.stableAddress;
    log(`[selftest] A ready：${ready.deviceId} @ ${peerAddr}`);

    log('[selftest] 启动 B（独立进程/独立存储，无共享路径）…');
    const bEvidence = join(outDir, 'b-evidence.json'); // 父↔B，A 不接触
    const b = spawnChild(
      ['cross', '--peer', peerAddr, '--peer-id', ready.deviceId, '--out', bEvidence, '--allow-same-network', '--timeout', '60000'],
      env,
    );
    const [aRes, bRes] = await Promise.all([a.done, b.done]);
    if (bRes.code !== 0) {
      log(bRes.out);
      log(bRes.err);
      throw new Error(`cross 退出码 ${bRes.code}`);
    }
    if (aRes.code !== 0) throw new Error(`peer 退出码 ${aRes.code}`);

    const evidence = await readJson(bEvidence);
    result.orchestration = {
      crossExitCode: bRes.code,
      peerExitCode: aRes.code,
      stateMatches: evidence.stateMatches,
      identityShared: evidence.identityShared,
      convergedValue: evidence.convergedValue,
      differentPublicNetwork: evidence.differentPublicNetwork,
      differentPublicNetworkBasis: evidence.differentPublicNetworkBasis,
      localEgress: evidence.localEgress,
      peerEgress: evidence.peerEgress,
      coordination: evidence.coordination,
      note: '同机：出口 IP 相同/私网 → differentPublicNetwork 预期 false；跨网判定不在此自测范围',
    };
    if (!evidence.stateMatches) throw new Error('双端 dataHash 不一致');
    if (!evidence.identityShared) throw new Error('共享用户身份未生效');
    if (evidence.convergedValue !== 'A-offline' && evidence.convergedValue !== 'B-offline') {
      throw new Error(`两阶段未收敛：${evidence.convergedValue}`);
    }

    log('[selftest] relay 密文自检…');
    result.relayCipher = await relayCipherSelfCheck(keyJson, outDir);
    if (!result.relayCipher.ok) throw new Error('relay 密文自检失败（捕获到明文或未捕获流量）');

    result.ok = true;
    result.completedAt = new Date().toISOString();
    log('✓ G3-P2 selftest 通过（non-evidence；两独立进程/存储，无共享路径）');
    log(`  stateMatches=${evidence.stateMatches} identityShared=${evidence.identityShared} converged=${evidence.convergedValue}`);
    log(`  egress(local/peer)=${evidence.localEgress?.ip ?? 'unknown'}/${evidence.peerEgress?.ip ?? 'unknown'} basis=${evidence.differentPublicNetworkBasis}`);
    log(`  relayCipher.capturedBytes=${result.relayCipher.capturedBytes} plaintextMarkerFound=${result.relayCipher.plaintextMarkerFound}`);
  } catch (error) {
    result.ok = false;
    result.error = String(error?.stack ?? error);
    log(`✗ selftest 失败：${error?.message ?? error}`);
  } finally {
    const outPath = join(rootDir, '.wan-evidence', `wan-selftest-${Date.now()}.json`);
    await writeJson(outPath, result).catch(() => undefined);
    log(`证据（non-evidence）：${outPath}`);
    if (!args.keep) await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
  }
  process.exit(result.ok ? 0 : 1);
}

// ---------- 分发 ----------

if (command === 'relay') await runRelay();
else if (command === 'user-keygen') await runUserKeygen();
else if (command === 'peer') await runPeer();
else if (command === 'cross') await runCross();
else if (command === 'selftest') await runSelftest();
else if (command === 'selftest-isolated') await runSelftest();
else if (command === 'local') await runLocal();
else {
  console.log(`未知子命令：${command}（支持 local | relay | user-keygen | peer | cross | selftest | selftest-isolated）`);
  process.exit(1);
}
