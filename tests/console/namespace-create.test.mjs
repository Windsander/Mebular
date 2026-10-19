// W-B 补充：共享页「新建记忆域」的接口契约
// - 0 条记忆 / 0 台对端：GET /admin/api/namespaces 仍返回该域（declared=true, count=0）；
// - 创建后默认自订阅；
// - 写一条记忆后 count=1，重开存储后仍在。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular, MemoryService } from '@mebular/core';
import { buildNamespaces } from '../../packages/mcp/src/admin.mjs';

const service = { status: async () => ({ stateHashByNamespace: {} }) };

describe('共享页新建记忆域（0 记忆 / 0 对端）', () => {
  let dir;
  let storagePath;
  let app;
  let masterKeys;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'console-new-ns-'));
    storagePath = join(dir, 'store.jsonl');
    const master = await Mebular.generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
    app = new Mebular({
      storagePath,
      deviceId: 'device-A',
      encryption: masterKeys,
      network: { enabled: false },
      sync: { namespaces: ['ledger'] },
    });
    await app.initialize();
  });

  afterEach(async () => {
    await app?.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  it('建域 + 自订阅：空域也出现在目录且 selfSubscribed=true', async () => {
    await app.declareNamespace({ namespace: 'ledger' });
    await app.subscribeNamespace('ledger');
    const rows = await buildNamespaces({ app, service, config: { sync: { namespaces: ['ledger'] } } });
    const ledger = rows.find((row) => row.namespace === 'ledger');
    expect(ledger).toMatchObject({ namespace: 'ledger', count: 0, declared: true, subscribed: true, selfSubscribed: true });
    expect((await app.getNamespaceSubscriptions('ledger')).subscribers).toContain('device-A');
  });

  it('写入一条记忆后 count=1；重开存储后仍在', async () => {
    await app.declareNamespace({ namespace: 'ledger' });
    await app.subscribeNamespace('ledger');
    const memories = new MemoryService(app);
    await memories.write([{ type: 'fact', content: 'first', metadata: { namespace: 'ledger' } }]);

    const rows = await buildNamespaces({ app, service, config: { sync: { namespaces: ['ledger'] } } });
    expect(rows.find((row) => row.namespace === 'ledger')?.count).toBe(1);

    await app.shutdown();
    const master = await Mebular.generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
    app = new Mebular({
      storagePath,
      deviceId: 'device-A',
      encryption: masterKeys,
      network: { enabled: false },
      sync: { namespaces: ['ledger'] },
    });
    await app.initialize();
    const again = await buildNamespaces({ app, service, config: { sync: { namespaces: ['ledger'] } } });
    expect(again.find((row) => row.namespace === 'ledger')?.count).toBe(1);
    expect(again.find((row) => row.namespace === 'ledger')?.declared).toBe(true);
  });
});
