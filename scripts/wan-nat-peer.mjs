#!/usr/bin/env node
// L2 容器角色：NAT 后的 peer（A 驱动 / B 响应）。文件协议与宿主脚本协调（phase.json / <role>.json）。
// A 在 net-a、B 在 net-b，**无入站端口、无对方直连地址** → 只能经 relay（/p2p-circuit）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import dns from 'node:dns';
import { Mebular } from '../dist/index.js';

const role = process.argv[2] === 'B' ? 'B' : 'A';
const state = process.env.WAN_NAT_STATE ?? '/app/.wan-nat';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v), { mode: 0o644 });
const writeState = (patch) => writeJson(join(state, `${role}.json`), { ...(readJson(join(state, `${role}.json`), {}) ?? {}), ...patch });
const waitFor = async (fn, ms, poll = 100) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(poll); } return fn(); };

const relay = await waitFor(() => readJson(join(state, 'relay.json')), 60000);
if (!relay) { console.error(`[${role}] relay.json 缺失`); process.exit(2); }
const master = readJson(join(state, 'master-key.json'));
if (!master) { console.error(`[${role}] master-key.json 缺失`); process.exit(2); }
const userMasterKey = new Uint8Array(Buffer.from(master.publicKey, 'base64'));
const userMasterPrivateKey = await crypto.subtle.importKey('pkcs8', Buffer.from(master.privateKeyPkcs8, 'base64'), { name: 'Ed25519' }, true, ['sign']);
const relayIp = (await dns.promises.lookup('relay', { family: 4 })).address;
const relayAddr = `/ip4/${relayIp}/tcp/4001/p2p/${relay.peerId}`;
console.log(`WAN_RELAYADDR ${JSON.stringify({ role, relayIp, relayAddr })}`);

const deviceId = role === 'A' ? 'device-A' : 'device-B';
const partner = role === 'A' ? 'device-B' : 'device-A';
const storagePath = join(state, `${role}.jsonl`);
const pickCircuit = (m) => (m.node.getLocalMultiaddrs() ?? []).find((a) => a.includes('/p2p-circuit'));

// 预约 best-effort：容器启动次序可能使首次拨号 relay 失败 → 重试
let mebular = null;
let circuit = null;
for (let attempt = 1; attempt <= 4 && !circuit; attempt++) {
  if (mebular) await mebular.shutdown().catch(() => undefined);
  mebular = new Mebular({
    storagePath,
    deviceId,
    encryption: { userMasterKey, userMasterPrivateKey },
    network: { enabled: true, libp2p: { listen: ['/ip4/0.0.0.0/tcp/0'], relayServers: [relayAddr] } },
    sync: { autoSync: true, peerNamespacePolicy: { [partner]: ['default'] } },
  });
  await mebular.initialize();
  circuit = await waitFor(() => pickCircuit(mebular), 10000);
  console.log(`WAN_ATTEMPT ${JSON.stringify({ role, attempt, circuit: !!circuit })}`);
}
writeState({ role, deviceId, ready: true, peerId: mebular.node.peerId.id, relayAddr, circuit: circuit ?? null });
console.log(`WAN_PEER ${JSON.stringify({ role, deviceId, peerId: mebular.node.peerId.id, circuit: !!circuit })}`);

const peerIdObj = (id) => ({ id, multihash: new Uint8Array(), pubKey: new Uint8Array() });
const hasText = async (text) => (await mebular.graph.listNodes()).some((n) => n.content?.text === text);
const nsCount = async (ns) => (await mebular.graph.listNodes()).filter((n) => n.namespace === ns).length;

if (role === 'B') {
  const a = await waitFor(() => readJson(join(state, 'A.json')), 90000);
  if (a?.circuit && a?.peerId) {
    await mebular.node.connectToPeer(peerIdObj(a.peerId), a.circuit).catch((e) => console.error(`[B] connect: ${e.message}`));
    writeState({ dialed: true, aCircuit: a.circuit });
  }
}

let lastEpoch = -1;
let createdA = false;
let createdSecret = false;
for (;;) {
  const phase = readJson(join(state, 'phase.json'), { epoch: 0, phase: 'idle' });
  if (phase.epoch > lastEpoch) {
    lastEpoch = phase.epoch;
    if (phase.phase === 'sync') {
      if (role === 'A') {
        if (!createdA) { await mebular.graph.createNode('fact', { text: 'from-A' }, [], { namespace: 'default' }); createdA = true; }
        const saw = await waitFor(() => hasText('reply-from-B'), 40000);
        writeState({ phase: 'sync', sawReply: !!saw });
      } else {
        const sawA = await waitFor(() => hasText('from-A'), 40000);
        if (sawA) await mebular.graph.createNode('fact', { text: 'reply-from-B' }, [], { namespace: 'default' });
        writeState({ phase: 'sync', sawA: !!sawA });
      }
    } else if (phase.phase === 'authneg') {
      if (role === 'A') {
        if (!createdSecret) { await mebular.graph.createNode('fact', { text: 'secret' }, [], { namespace: 'secret' }); createdSecret = true; }
        writeState({ phase: 'authneg', secretCreated: true });
      } else {
        await sleep(3000);
        writeState({ phase: 'authneg', secretCount: await nsCount('secret') });
      }
    }
  }
  await sleep(80);
}
