#!/usr/bin/env node
// W4：控制台演示种子（确定性、可重复、仅本机）：
//   在指定 home 生成 root 身份 + 配置 + 若干 __policy__ 事件（授权/成员/签发者）+ 跨域记忆节点，
//   并打印「如何起 serve + 打开控制台」的下一步。仅用于演示/人工验收，不清除既有数据（幂等追加）。
//
// 用法：node packages/console/scripts/seed-demo.mjs --home /tmp/mebular-demo
// 前置：npm run build。

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Mebular, IdentityManager, MemoryService } from '@mebular/core';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const home = resolve(flag('home', join(process.cwd(), 'console-demo')));
const device = flag('device', 'device-console');
const port = Number(flag('port', '7331'));
const self = device;

await mkdir(join(home, 'auth'), { recursive: true });
const storagePath = join(home, 'store.jsonl');
const keyFile = join(home, 'master-key.json');
const cfgFile = join(home, 'config.json');

// 1) 主密钥（0600；已存在则复用，保证可重复运行）
if (!existsSync(keyFile)) {
  const master = await new IdentityManager().generateUserMasterKey();
  await writeFile(keyFile, JSON.stringify({
    publicKey: Buffer.from(master.publicKey).toString('base64'),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
  }, null, 2), { mode: 0o600 });
}

// 2) config（root 身份；joinService 开启便于演示「邀请新设备」；仅回环）
if (!existsSync(cfgFile)) {
  await writeFile(cfgFile, JSON.stringify({
    storagePath,
    deviceId: device,
    encryption: { level: 'none', keyFile },
    identity: { mode: 'root' },
    network: { enabled: false, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] } },
    sync: {
      autoSync: true,
      pushOnWrite: true,
      namespaces: ['notes', 'work', 'tasks'],
      policyIssuers: [device],
      antiEntropy: { enabled: true, intervalMs: 600000, jitterRatio: 0.2 },
    },
    semantic: { enabled: false, minScore: 0.2 },
    joinService: { enabled: true, bind: '127.0.0.1', port: 4002 },
    mcp: { http: { host: '127.0.0.1', port, auth: 'none' } },
  }, null, 2), { mode: 0o600 });
}

// 3) 图上策略 + 跨域记忆（幂等：事件内容寻址，重复运行不会重复入库）
const master = JSON.parse(await readFile(keyFile, 'utf-8'));
const encryption = {
  userMasterKey: new Uint8Array(Buffer.from(master.publicKey, 'base64')),
  userMasterPrivateKey: await IdentityManager.importPrivateKey(master.privateKeyPkcs8),
};
const config = JSON.parse(await readFile(cfgFile, 'utf-8'));
const app = new Mebular({
  storagePath: config.storagePath,
  deviceId: config.deviceId,
  encryption,
  network: { enabled: false },
  sync: { policyIssuers: config.sync?.policyIssuers ?? [] },
});
await app.initialize();
try {
  await app.declarePolicyIssuer({ subject: self, note: 'console demo seed' });
  const peer = 'device-peer';
  await app.declareNamespaceMembership({ member: self, namespace: 'notes', active: true, note: 'seed' });
  await app.declareNamespaceMembership({ member: peer, namespace: 'notes', active: true, note: 'seed' });
  await app.grantNamespaces({ subject: peer, namespaces: ['notes'], note: 'seed' });
  const service = new MemoryService(app);
  await service.write([
    { type: 'preference', content: '深色主题', metadata: { preferenceType: 'theme', confidence: 0.9, namespace: 'notes' } },
    { type: 'fact', content: 'Mebular 控制台是本机只读星图', metadata: { namespace: 'notes', tags: ['console'] } },
    { type: 'episode', content: '演示：用户打开了控制台', metadata: { namespace: 'work', episodeType: 'observation' } },
    { type: 'skill', content: 'seed-demo', metadata: { namespace: 'work', category: 'demo' } },
    { type: 'fact', content: '任务面与记忆面逐字同名（task_submit / memory_write）', metadata: { namespace: 'tasks' } },
  ]);
} finally {
  await app.shutdown();
}

console.log(JSON.stringify({ ok: true, home, storagePath, device, port, next: [
  `MEBULAR_HOME=${home} node packages/mcp/bin/mebular.mjs serve --port ${port}`,
  `打开 http://127.0.0.1:${port}/console   （只读；写需在「设置」开启或 MEMBULAR_CONSOLE_WRITES≠0）`,
  '演示重置：删除 home 目录后重跑本脚本',
] }, null, 2));
