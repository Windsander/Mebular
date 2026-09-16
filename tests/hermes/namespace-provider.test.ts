// Hermes Provider 可选 namespace 参数（向后兼容）。
//
// storeMemory 的 metadata.namespace 生效；retrieveMemory 可按 namespace 过滤；
// 不传 namespace 时行为与改动前一致。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { HermesMemoryProvider } from '../../src/hermes/HermesMemoryProvider.js';

describe('HermesMemoryProvider namespace（可选参数）', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-provider-ns-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('metadata.namespace 生效；可按分区过滤；不传则不过滤', async () => {
    const app = new Mebular({
      storagePath: join(dir, 'a.jsonl'),
      deviceId: 'device-A',
      encryption: masterKeys,
      sync: { autoSync: false },
    });
    await app.initialize();
    const provider = new HermesMemoryProvider(app);

    const alpha = await provider.storeMemory({
      type: 'fact',
      content: 'alpha 记忆',
      metadata: { namespace: 'alpha' },
    });
    await provider.storeMemory({
      type: 'fact',
      content: 'beta 记忆',
      metadata: { namespace: 'beta' },
    });
    await provider.storeMemory({ type: 'fact', content: '默认记忆' });

    const alphaOnly = await provider.retrieveMemory({ filters: { namespace: 'alpha' } });
    expect(alphaOnly.memories.map((m) => m.id)).toEqual([alpha.id]);
    expect(alphaOnly.memories[0]!.metadata.namespace).toBe('alpha');

    const all = await provider.retrieveMemory({});
    expect(all.memories).toHaveLength(3);

    await app.shutdown();
  });
});
