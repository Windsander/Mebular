#!/usr/bin/env node
// 测试夹具：读某设备在本地的**图上生效授权** `getEffectiveNamespaces(subject)`。
// 用途：证明「A 签发的 namespace_grant 已被 B 同步并采纳」——B 端对 device-B 未配置白名单，
// 若结果含 tasks，则只能来自图上 grant。只读，不改任何状态。
//
// 用法：node read-effective.mjs --dir <fleetdir> --subject <device>

import { Mebular } from '@mebular/core';
import {
  fleetConfigPath,
  loadFleetConfig,
  offlineMebularOptions,
  readMasterKeyFile,
} from '../../../packages/fleet/dist/index.js';

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
}

const config = await loadFleetConfig(fleetConfigPath(args.dir));
const encryption = await readMasterKeyFile(config.masterKeyFile);
const mebular = new Mebular(offlineMebularOptions(config, encryption));
await mebular.initialize();
try {
  const effective = await mebular.getEffectiveNamespaces(args.subject);
  process.stdout.write(`${JSON.stringify({ ok: true, subject: args.subject, effective })}\n`);
} finally {
  await mebular.shutdown();
}
