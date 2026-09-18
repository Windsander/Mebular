#!/usr/bin/env node
// L2 容器角色：public relay（circuit relay v2）。写 `<state>/relay.json`（供对端构造 /dns4/relay）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Libp2pProvider } from '../dist/index.js';

const state = process.env.WAN_NAT_STATE ?? '/app/.wan-nat';
mkdirSync(state, { recursive: true });
const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const deviceKey = { publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)), privateKey: kp.privateKey };
const provider = await Libp2pProvider.create({ deviceKey, listen: ['/ip4/0.0.0.0/tcp/4001'], relayServer: true, relayUnlimited: true });
await provider.start();
const peerId = provider.peerId.id;
writeFileSync(join(state, 'relay.json'), JSON.stringify({ peerId, addr: `/dns4/relay/tcp/4001/p2p/${peerId}` }));
console.log(`WAN_RELAY ${JSON.stringify({ peerId, addr: `/dns4/relay/tcp/4001/p2p/${peerId}` })}`);
setInterval(() => {}, 1 << 30);
