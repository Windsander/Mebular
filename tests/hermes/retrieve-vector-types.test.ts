// retrieveMemory 向量路径 types 收窄回归测试（Phase 6.1）
//
// 缺陷：向量检索路径不按 query.types 收窄（关键词路径会），
//       向量索引缺省关闭使该缺陷潜伏；用假 VectorIndex 暴露。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { HermesMemoryProvider } from '../../src/hermes/HermesMemoryProvider.js';
import type { VectorIndex } from '../../src/memory/VectorIndex.js';

describe('retrieveMemory 向量路径', () => {
  let dir: string;
  let mebular: Mebular;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-vec-'));
    const master = await new IdentityManager().generateUserMasterKey();
    mebular = new Mebular({
      storagePath: join(dir, 'store.jsonl'),
      deviceId: 'device-V',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    });
    await mebular.initialize();
  });

  afterEach(async () => {
    await mebular.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it('向量命中按 query.types 收窄', async () => {
    const setup = new HermesMemoryProvider(mebular, { userId: 'u' });
    const fact = await setup.storeMemory({ type: 'fact', content: '喜欢浅烘焙咖啡' });
    const episode = await setup.storeMemory({
      type: 'episode',
      content: '讨论了咖啡烘焙',
      metadata: { episodeType: 'conversation' },
    });

    // 假索引：两种类型的命中都返回
    const fakeIndex: VectorIndex = {
      async index() {},
      async remove() {},
      async query() {
        return [
          { nodeId: fact.id, score: 0.9 },
          { nodeId: episode.id, score: 0.8 },
        ];
      },
    };
    const provider = new HermesMemoryProvider(mebular, { userId: 'u', vectorIndex: fakeIndex });

    const result = await provider.retrieveMemory({ query: '咖啡', types: ['fact'] });
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories.every((m) => m.type === 'fact')).toBe(true);
    expect(result.memories.map((m) => m.id)).not.toContain(episode.id);
  });
});
