#!/usr/bin/env node
// 测试夹具：以**指定 grantId** 重放一条 `namespace_grant`（唯一目的：验证 R-d —— 被撤销过的
// grantId 不能用来恢复授权）。只用于验收脚本，不进入 fleet 公共 API。
//
// 用法：node replay-grant.mjs --dir <fleetdir> --grant-id <id> --subject <device> [--namespace <ns>]

import { Mebular, POLICY_NAMESPACE } from '@mebular/core';
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
  const event = await mebular.eventLog.append({
    type: 'namespace_grant',
    data: {
      grant: {
        grantId: args['grant-id'],
        subject: args.subject,
        namespaces: (args.namespace ?? config.namespace).split(','),
        issuedAt: Date.now(),
      },
    },
    namespace: POLICY_NAMESPACE,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, grantId: args['grant-id'], eventId: event.id })}\n`);
} finally {
  await mebular.shutdown();
}
