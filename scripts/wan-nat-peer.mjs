#!/usr/bin/env node
// L2 容器角色：NAT 后的 peer（A 驱动 / B 响应）。文件协议与宿主脚本协调（phase.json / <role>.json）。
// A 在 net-a、B 在 net-b，**无入站端口、无对方直连地址** → 只能经 relay（/p2p-circuit）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Mebular } from '../dist/index.js';

const role = process.argv[2] === 'B' ? 'B' : 'A';
const state = process.env.WAN_NAT_STATE ?? '/app/.wan-nat';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v), { mode: 0o600 });
const writeState = (patch) => writeJson(join(state, `${role}.json`), { ...(readJson(join(state, `${role}.json`), {}) ?? {}), ...patch });
const waitFor = async (fn, ms, poll = 100) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(poll); } return fn(); };

const relay = await waitFor(() => readJson(join(state, 'relay.json')), 60000);
if (!relay) { console.error(`[${role}] relay.json 缺失`); process.exit(2); }
const master = readJson(join(state, 'master-key.json'));
if (!master) { console.error(`[${role}] master-key.json 缺失`); process.exit(2); }
const userMasterKey = new Uint8Array(Buffer.from(master.publicKey, 'base64'));
const userMasterPrivateKey = await crypto.subtle.importKey('pkcs8', Buffer.from(master.privateKeyPkcs8, 'base64'), { name: 'Ed25519' }, true, ['sign']);

const deviceId = role === 'A' ? 'device-A' : 'device-B';
const partner = role === 'A' ? 'device-B' : 'device-A';
const mebular = new Mebular({
  storagePath: join(state, `${role}.jsonl`),
  deviceId,
  encryption: { userMasterKey, userMasterPrivateKey },
  network: { enabled: true, libp2p: { listen: ['/ip4/0.0.0.0/tcp/0'], relayServers: [relay.addr] } },
  sync: { autoSync: true, peerNamespacePolicy: { [partner]: ['default'] } },
});
await mebular.initialize();
writeState({ role, deviceId, ready: true, peerId: mebular.node.peerId.id });
console.log(`WAN_PEER ${JSON.stringify({ role, deviceId, peerId: mebular.node.peerId.id })}`);

const peerIdObj = (id) => ({ id, multihash: new Uint8Array(), pubKey: new Uint8Array() });
const hasText = async (text) => (await mebular.graph.listNodes()).some((n) => n.content?.text === text);
const nsCount = async (ns) => (await mebular.graph.listNodes()).filter((n) => n.namespace === ns).length;

if (role === 'A') {
  const circuit = await waitFor(() => (mebular.node.getLocalMultiaddrs() ?? []).find((a) => a.includes('/p2p-circuit')), 30000);
  writeState({ circuit: circuit ?? null });
} else {
  const a = await waitFor(() => readJson(join(state, 'A.json')), 60000);
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
        const saw = await waitFor(() => hasText('reply-from-B'), 30000);
        writeState({ phase: 'sync', sawReply: !!saw });
      } else {
        const sawA = await waitFor(() => hasText('from-A'), 30000);
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
