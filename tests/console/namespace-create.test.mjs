// W-B 补充：共享页「新建记忆域」的接口契约（原生 Node 子进程）
//
// 与 tests/mcp/security-gate.test.mjs 同策略：Jest coverage 的 ESM 图下，
// `@mebular/core` 桶可能触发 `EndpointBook` 命名导出链接错误。用子进程跑真实
// dist 入口 + admin handler，避免把 @mebular/core 拉进 coverage 模块图。

import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const HARNESS = String.raw`
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.WB_ROOT;
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { Mebular, MemoryService } = await load('dist/index.js');
const { buildNamespaces } = await load('packages/mcp/src/admin.mjs');

const dir = await mkdtemp(join(tmpdir(), 'console-new-ns-'));
const storagePath = join(dir, 'store.jsonl');
const master = await Mebular.generateUserMasterKey();
const encryption = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };

const open = () => new Mebular({
  storagePath,
  deviceId: 'device-A',
  encryption,
  network: { enabled: false },
  sync: { namespaces: ['ledger'] },
});

let app = open();
let service;
try {
  await app.initialize();
  service = new MemoryService(app);
  await app.declareNamespace({ namespace: 'ledger' });
  await app.subscribeNamespace('ledger');
  const rows = await buildNamespaces({ app, service, config: { sync: { namespaces: ['ledger'] } } });
  const empty = rows.find((row) => row.namespace === 'ledger');

  await service.write([{ type: 'fact', content: 'first', metadata: { namespace: 'ledger' } }]);
  const afterRows = await buildNamespaces({ app, service, config: { sync: { namespaces: ['ledger'] } } });
  const after = afterRows.find((row) => row.namespace === 'ledger');

  await app.shutdown();
  app = open();
  await app.initialize();
  service = new MemoryService(app);
  const reopenedRows = await buildNamespaces({ app, service, config: { sync: { namespaces: ['ledger'] } } });
  const reopened = reopenedRows.find((row) => row.namespace === 'ledger');

  const subscription = await app.getNamespaceSubscriptions('ledger');
  console.log(JSON.stringify({
    empty: {
      declared: empty?.declared,
      count: empty?.count,
      subscribed: empty?.selfSubscribed,
      subscribers: subscription.subscribers,
    },
    after: { count: after?.count, declared: after?.declared },
    reopened: { count: reopened?.count, declared: reopened?.declared, selfSubscribed: reopened?.selfSubscribed },
  }));
} finally {
  await app.shutdown().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}
`;

describe('共享页新建记忆域（0 记忆 / 0 对端）', () => {
  it('建域 + 默认自订阅：空域可见；写入后计数=1；重开存储仍在', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', HARNESS], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...process.env, WB_ROOT: ROOT, NODE_NO_WARNINGS: '1' },
    });
    if (result.status !== 0) {
      throw new Error(`namespace-create harness failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`);
    }
    const line = String(result.stdout).split('\n').filter((entry) => entry.trim().startsWith('{')).pop();
    if (!line) throw new Error(`namespace-create harness produced no JSON:\n${result.stdout}\n${result.stderr}`);
    const summary = JSON.parse(line);
    expect(summary.empty).toEqual({
      declared: true,
      count: 0,
      subscribed: true,
      subscribers: ['device-A'],
    });
    expect(summary.after).toEqual({ count: 1, declared: true });
    expect(summary.reopened).toEqual({ count: 1, declared: true, selfSubscribed: true });
  }, 30_000);
});
