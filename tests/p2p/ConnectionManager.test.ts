// 连接管理器单元测试

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ConnectionManager } from '../../src/p2p/connection/ConnectionManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
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
});
