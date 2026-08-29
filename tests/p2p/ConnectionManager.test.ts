// 连接管理器单元测试

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ConnectionManager } from '../../src/p2p/connection/ConnectionManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type { Connection } from '../../src/p2p/P2PNetwork.js';
import { createTestIdentity, type TestIdentity } from './helpers.js';

describe('ConnectionManager', () => {
  let hub: InMemoryHub;
  let local: TestIdentity;
  let peers: TestIdentity[];
  let manager: ConnectionManager;

  beforeEach(async () => {
    hub = new InMemoryHub();
    local = await createTestIdentity('device-local');
    peers = await Promise.all([
      createTestIdentity('device-r1'),
      createTestIdentity('device-r2'),
      createTestIdentity('device-r3'),
    ]);
    for (const peer of peers) {
      hub.register(peer.peerId);
    }

    manager = new ConnectionManager({
      maxConnections: 2,
      connectTimeout: 1000,
      keepAliveInterval: 60000,
      heartbeatTimeout: 60000,
    });
    manager.setConnectionProvider(hub.forPeer(local.peerId));
    await manager.start();
  });

  afterEach(async () => {
    if (manager.isRunning()) {
      await manager.stop();
    }
  });

  it('通过 provider 拨号并登记连接', async () => {
    const connection = await manager.connect(peers[0]!.peerId);
    expect(connection).toBeDefined();
    expect(connection.peerId.id).toBe(peers[0]!.peerId.id);
    expect(manager.getConnection(peers[0]!.peerId)).toBe(connection);
    expect(manager.getConnectionCount()).toBe(1);
  });

  it('并发拨同一对端时共享同一条连接', async () => {
    const [c1, c2] = await Promise.all([
      manager.connect(peers[0]!.peerId),
      manager.connect(peers[0]!.peerId),
    ]);
    expect(c1).toBe(c2);
    expect(manager.getConnectionCount()).toBe(1);
  });

  it('超出最大连接数时拒绝新连接', async () => {
    await manager.connect(peers[0]!.peerId);
    await manager.connect(peers[1]!.peerId);
    await expect(manager.connect(peers[2]!.peerId)).rejects.toThrow('Max connections reached');
  });

  it('断开连接并触发事件', async () => {
    const onClosed = jest.fn();
    manager.on('connection-closed', onClosed);

    await manager.connect(peers[0]!.peerId);
    await manager.disconnect(peers[0]!.peerId);

    expect(manager.getConnection(peers[0]!.peerId)).toBeNull();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('未配置 provider 时拨号报错', async () => {
    const bare = new ConnectionManager({ keepAliveInterval: 60000, heartbeatTimeout: 60000 });
    await bare.start();
    try {
      await expect(bare.connect(peers[0]!.peerId)).rejects.toThrow('Connection provider not set');
    } finally {
      await bare.stop();
    }
  });

  it('对端不可达时拨号失败', async () => {
    const ghost = await createTestIdentity('device-ghost'); // 未注册到 hub
    await expect(manager.connect(ghost.peerId)).rejects.toThrow('not reachable');
  });

  it('stop 清理所有连接', async () => {
    await manager.connect(peers[0]!.peerId);
    await manager.connect(peers[1]!.peerId);
    await manager.stop();

    expect(manager.isRunning()).toBe(false);
    expect(manager.getConnectionCount()).toBe(0);
  });

  // ---------- Phase 6.2 覆盖补强 ----------

  it('重复启动抛 NETWORK_ALREADY_RUNNING', async () => {
    await expect(manager.start()).rejects.toThrow('already running');
  });

  it('未启动时 stop/connect/disconnect 抛 NETWORK_NOT_RUNNING', async () => {
    const bare = new ConnectionManager({ keepAliveInterval: 60000, heartbeatTimeout: 60000 });
    await expect(bare.stop()).rejects.toThrow('not running');
    await expect(bare.connect(peers[0]!.peerId)).rejects.toThrow('not running');
    await expect(bare.disconnect(peers[0]!.peerId)).rejects.toThrow('not running');
  });

  it('顺序重拨同一对端复用既有连接', async () => {
    const c1 = await manager.connect(peers[0]!.peerId);
    const c2 = await manager.connect(peers[0]!.peerId);
    expect(c2).toBe(c1);
    expect(manager.getConnectionCount()).toBe(1);
  });

  it('拨号超时诚实失败', async () => {
    const slow = new ConnectionManager({ connectTimeout: 30, keepAliveInterval: 60000, heartbeatTimeout: 60000 });
    slow.setConnectionProvider({
      dial: () => new Promise<never>(() => undefined),
      onIncomingConnection: () => undefined,
    });
    await slow.start();
    try {
      await expect(slow.connect(peers[0]!.peerId)).rejects.toThrow('timed out');
    } finally {
      await slow.stop();
    }
  });

  it('挂起连接的断开会真正关闭底层连接', async () => {
    const closeFn = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const pending = {
      peerId: peers[0]!.peerId,
      state: 'connecting',
      remoteAddress: 'memory://pending',
      send: async () => undefined,
      receive: (async function* () {})(),
      close: closeFn,
      authenticate: async () => false,
      isAuthenticated: () => false,
    } as unknown as Connection;
    manager.setPendingConnection(peers[0]!.peerId, pending);

    await manager.disconnect(peers[0]!.peerId);

    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(manager.getPendingConnection(peers[0]!.peerId)).toBeNull();
  });

  it('挂起连接登记/复用/转正/移除链路', async () => {
    const conn = {
      peerId: peers[0]!.peerId,
      state: 'connected',
      remoteAddress: 'memory://x',
      send: async () => undefined,
      receive: (async function* () {})(),
      close: async () => undefined,
      authenticate: async () => true,
      isAuthenticated: () => true,
    } as unknown as Connection;

    manager.setPendingConnection(peers[0]!.peerId, conn);
    expect(manager.getPendingConnection(peers[0]!.peerId)).toBe(conn);
    expect(manager.getPendingConnectionCount()).toBe(1);

    // connect 命中挂起表：直接复用，不拨号（也不消费挂起表——其生命周期归 P2PNode）
    expect(await manager.connect(peers[0]!.peerId)).toBe(conn);
    expect(manager.removePendingConnection(peers[0]!.peerId)).toBe(conn);
    expect(manager.getPendingConnectionCount()).toBe(0);

    // 转正后进入正式连接表
    manager.setPendingConnection(peers[1]!.peerId, conn);
    const moved = manager.movePendingToConnected(peers[1]!.peerId);
    expect(moved).toBe(conn);
    expect(manager.getConnection(peers[1]!.peerId)).toBe(conn);
    expect(manager.getPendingConnectionCount()).toBe(0);

    // 空表移除/转正是安全 no-op
    expect(manager.removePendingConnection(peers[2]!.peerId)).toBeUndefined();
    expect(manager.movePendingToConnected(peers[2]!.peerId)).toBeUndefined();
  });
});
