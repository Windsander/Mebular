// 心跳收割覆盖面回归测试（Phase 6.1）
//
// 缺陷：心跳超时断开仅对暴露 lastActivityAt 的连接生效；
//       ping 探活失败被静默吞掉；已关闭连接永不收割。
// 修复：ping 失败收割 + 关闭态收割 + 幂等 reap。

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { ConnectionManager } from '../../src/p2p/connection/ConnectionManager.js';
import type { Connection, PeerId } from '../../src/p2p/P2PNetwork.js';
import { createTestIdentity, waitFor } from './helpers.js';

function fakeConnection(
  peerId: PeerId,
  extras: Record<string, unknown> = {},
): Connection {
  const base = {
    peerId,
    state: 'connected',
    remoteAddress: 'memory://fake',
    async send() {},
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async *receive() {},
    async close() {},
    async authenticate() {
      return true;
    },
    isAuthenticated() {
      return true;
    },
  };
  return Object.assign(base, extras) as unknown as Connection;
}

describe('心跳收割覆盖面', () => {
  let manager: ConnectionManager;

  afterEach(async () => {
    if (manager?.isRunning()) {
      await manager.stop();
    }
  });

  it('ping 探活失败的连接被收割并广播事件', async () => {
    manager = new ConnectionManager({ keepAliveInterval: 20, heartbeatTimeout: 60000 });
    await manager.start();

    const peer = await createTestIdentity('dead-ping');
    manager.setConnection(peer.peerId, fakeConnection(peer.peerId, {
      ping: async () => {
        throw new Error('link dead');
      },
    }));

    const onClosed = jest.fn();
    const onTimeout = jest.fn();
    manager.on('connection-closed', onClosed);
    manager.on('connection-timeout', onTimeout);

    await waitFor(() => manager.getConnectionCount() === 0);
    expect(onTimeout).toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalled();
  });

  it('ping 正常的连接不被误收割', async () => {
    manager = new ConnectionManager({ keepAliveInterval: 20, heartbeatTimeout: 60000 });
    await manager.start();

    const peer = await createTestIdentity('alive-ping');
    manager.setConnection(peer.peerId, fakeConnection(peer.peerId, {
      ping: async () => undefined,
    }));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(manager.getConnectionCount()).toBe(1);
  });

  it('状态为 closed 的无活动追踪连接被收割', async () => {
    manager = new ConnectionManager({ keepAliveInterval: 60000, heartbeatTimeout: 20 });
    await manager.start();

    const peer = await createTestIdentity('closed-conn');
    manager.setConnection(peer.peerId, fakeConnection(peer.peerId, { state: 'closed' }));

    await waitFor(() => manager.getConnectionCount() === 0);
  });

  it('lastActivityAt 过期的连接超时收割（不回退）', async () => {
    manager = new ConnectionManager({ keepAliveInterval: 60000, heartbeatTimeout: 20 });
    await manager.start();

    const peer = await createTestIdentity('stale-activity');
    manager.setConnection(peer.peerId, fakeConnection(peer.peerId, {
      lastActivityAt: Date.now() - 10000,
    }));

    await waitFor(() => manager.getConnectionCount() === 0);
  });

  it('lastActivityAt 新鲜的连接不被收割（不回退）', async () => {
    manager = new ConnectionManager({ keepAliveInterval: 60000, heartbeatTimeout: 40 });
    await manager.start();

    const peer = await createTestIdentity('fresh-activity');
    // 注意：getter 必须用 defineProperty 挂到连接上（Object.assign 会把 getter 求值成固定值）
    const conn = fakeConnection(peer.peerId);
    Object.defineProperty(conn, 'lastActivityAt', { get: () => Date.now() });
    manager.setConnection(peer.peerId, conn);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(manager.getConnectionCount()).toBe(1);
  });
});
