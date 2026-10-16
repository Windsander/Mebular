// P1·B2 · N4 判别性集成：会话串行化按**连接**粒度。
//
// 拓扑：A < B < C（deviceId 字典序）。B 是 A 的响应方（常驻 hello 等待），
// 同时是 C 的发起方。旧实现把会话串行化做成「每 SyncManager 全局队列」，
// 常驻响应方会话无限等待 hello 时独占队列 → B→C 的会话排队永不启动。
//
// 红锚点（N4 前）：B 写 → C 收不到（B 的推会话被 A 的常驻 responder 饿死）；
// 本用例在新实现下通过（每连接队列：互不阻塞）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { useHeavyTimeout } from '../helpers/timeouts.js';

useHeavyTimeout();

describe('N4 · 会话队列按连接隔离（多对端不互相饿死）', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-queue-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function makeFacade(deviceId: string, hub: InMemoryHub): Mebular {
    const all = ['device-A', 'device-B', 'device-C'];
    return new Mebular({
      storagePath: join(dir, `${deviceId}.jsonl`),
      deviceId,
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: {
        autoSync: true,
        pushOnWrite: true,
        pushOnWriteThrottleMs: 20,
        peerNamespacePolicy: Object.fromEntries(all.map((d) => [d, ['task']])),
      },
    });
  }

  async function connectAndSettle(dialer: Mebular, target: Mebular): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const both = new Promise<void>((resolve, reject) => {
      let count = 0;
      const onDone = (): void => {
        count += 1;
        if (count === 2) resolve();
      };
      dialer.sync.on('sync-completed', onDone);
      target.sync.on('sync-completed', onDone);
      timer = setTimeout(() => reject(new Error('首次同步超时')), 8000);
    });
    try {
      await dialer.node!.connectToPeer(target.node!.peerId);
      await both;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  it('A 的常驻响应方会话不阻塞 B→C 的推送', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub);
    const b = makeFacade('device-B', hub);
    const c = makeFacade('device-C', hub);
    await a.initialize();
    await b.initialize();
    await c.initialize();

    // ① B ↔ A：A<B → B 是响应方（常驻 hello 等待）
    await connectAndSettle(b, a);
    // ② C ↔ B：B<C → B 是发起方（推会话需要进 B 的会话队列）
    await connectAndSettle(c, b);

    // B 写入：C 应即时收到（不得被 A 的常驻 responder 饿死）
    const node = await b.graph.createNode('fact', { text: 'push-to-C' }, [], { namespace: 'task' });
    const deadline = Date.now() + 5000;
    let received = null;
    while (Date.now() < deadline) {
      received = await c.graph.getNode(node.id);
      if (received) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(received).not.toBeNull();

    // A 方向（nudge 触发）也最终收敛
    const deadlineA = Date.now() + 5000;
    let receivedA = null;
    while (Date.now() < deadlineA) {
      receivedA = await a.graph.getNode(node.id);
      if (receivedA) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(receivedA).not.toBeNull();

    await a.shutdown();
    await b.shutdown();
    await c.shutdown();
  });
});
