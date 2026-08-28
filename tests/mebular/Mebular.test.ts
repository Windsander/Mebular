// Mebular 门面类测试（phase-4-plan 4.0）
//
// 覆盖：生命周期（initialize/shutdown 幂等与顺序）、身份文件的创建与恢复、
// 错误路径（缺主私钥/身份文件不匹配/未初始化访问）、事件化接线生效、
// 以及 network.enabled 时双门面实例经 InMemoryHub 的自动同步。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { IdentityError, MebularError, ErrorCodes } from '../../src/errors.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { bytesToHex } from '../../src/p2p/handshake/AuthenticationHandshake.js';
import type { SyncResult } from '../../src/sync/syncmgr/SyncManager.js';

describe('Mebular 门面', () => {
  let dir: string;
  let storagePath: string;
  let master: { publicKey: Uint8Array; privateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-facade-'));
    storagePath = join(dir, 'store.jsonl');
    master = await new IdentityManager().generateUserMasterKey();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('initialize 后子系统就绪，重复 initialize 幂等', async () => {
    const m = new Mebular({
      storagePath,
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    });

    await m.initialize();
    expect(m.isInitialized()).toBe(true);
    expect(m.graph).toBeDefined();
    expect(m.eventLog).toBeDefined();
    expect(m.sync).toBeDefined();
    expect(m.node).toBeNull(); // 未启用网络

    await m.initialize(); // 幂等
    expect(m.isInitialized()).toBe(true);
    await m.shutdown();
  });

  it('首次初始化签发证书并落身份文件；重启恢复同一身份且不再需要主私钥', async () => {
    const first = new Mebular({
      storagePath,
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    });
    await first.initialize();
    const firstKey = first.identity.getDeviceKey('device-A')!;
    // 证书由用户主私钥签发（与握手层同一路径，可验证）
    await expect(first.identity.verifyDeviceCertificate(firstKey.certificate!)).resolves.toBe(true);
    const identityFile = JSON.parse(await readFile(`${storagePath}.identity.json`, 'utf-8'));
    expect(identityFile.deviceId).toBe('device-A');
    await first.shutdown();

    // 重启：新实例、只给主公钥（验对端证书用），身份从文件恢复
    const second = new Mebular({
      storagePath,
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey },
    });
    await second.initialize();
    const secondKey = second.identity.getDeviceKey('device-A')!;
    expect(bytesToHex(secondKey.publicKey)).toBe(bytesToHex(firstKey.publicKey));
    expect(secondKey.certificate?.signature).toBe(firstKey.certificate?.signature);
    await second.shutdown();
  });

  it('重启后事件时钟连续：计数器不回退', async () => {
    const first = new Mebular({
      storagePath,
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    });
    await first.initialize();
    await first.graph.createNode('fact', { text: 'x' });
    await first.graph.createNode('fact', { text: 'y' });
    await first.shutdown();

    const second = new Mebular({
      storagePath,
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey },
    });
    await second.initialize();
    const node = await second.graph.createNode('fact', { text: 'z' });
    expect(node.vectorClock?.['device-A']).toBe(3); // 事件时钟驱动（D10 收口）
    await second.shutdown();
  });

  it('首次初始化缺主私钥报 IdentityError；身份文件与 deviceId 不匹配也报错', async () => {
    const noKey = new Mebular({ storagePath, deviceId: 'device-A' });
    await expect(noKey.initialize()).rejects.toThrow(IdentityError);
    await expect(noKey.initialize()).rejects.toMatchObject({ code: ErrorCodes.IDENTITY_NOT_INITIALIZED });

    const seeded = new Mebular({
      storagePath,
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    });
    await seeded.initialize();
    await seeded.shutdown();

    const mismatched = new Mebular({ storagePath, deviceId: 'device-B' });
    await expect(mismatched.initialize()).rejects.toThrow(/不匹配/);
  });

  it('未初始化访问子系统抛 MebularError；shutdown 幂等', async () => {
    const m = new Mebular({ storagePath, deviceId: 'device-A' });
    expect(() => m.graph).toThrow(MebularError);
    await m.shutdown(); // 未初始化时 shutdown 幂等
  });

  it('图变更经门面接线产出签名事件', async () => {
    const m = new Mebular({
      storagePath,
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    });
    await m.initialize();

    await m.graph.createNode('fact', { text: 'hello' });
    const events = await m.eventLog.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('node_created');
    expect(events[0]!.id).toMatch(/^sha256:/);
    expect(events[0]!.signature).not.toBe('');

    const deviceKey = m.identity.getDeviceKey('device-A')!;
    const { EventLog } = await import('../../src/eventlog/EventLog.js');
    await expect(EventLog.verifyEvent(events[0]!, deviceKey.publicKey)).resolves.toBe(true);
    await m.shutdown();
  });

  it('network.enabled 的双门面实例经 InMemoryHub 完成自动同步', async () => {
    const hub = new InMemoryHub();
    const pathA = join(dir, 'a.jsonl');
    const pathB = join(dir, 'b.jsonl');

    const a = new Mebular({
      storagePath: pathA,
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: { enabled: true, provider: hub },
      sync: { autoSync: true },
    });
    const b = new Mebular({
      storagePath: pathB,
      deviceId: 'device-B',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: { enabled: true, provider: hub },
      sync: { autoSync: true },
    });

    // 离线写入（网络未启动）
    await a.initialize();
    await b.initialize();
    const n1 = await a.graph.createNode('fact', { text: 'from-A' });

    const syncedA = new Promise<SyncResult>((resolve) => a.sync.once('sync-completed', resolve));
    const syncedB = new Promise<SyncResult>((resolve) => b.sync.once('sync-completed', resolve));

    await b.node!.connectToPeer(a.node!.peerId);
    await Promise.all([syncedA, syncedB]);

    expect((await b.graph.getNode(n1.id))?.content).toEqual({ text: 'from-A' });

    await a.shutdown();
    await b.shutdown();
  });

  it('配置 libp2p 时真实装配真实网络栈（Phase 5 起；缺包才抛 NETWORK_LIBP2P_NOT_AVAILABLE）', async () => {
    const m = new Mebular({
      storagePath,
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] } },
    });
    try {
      await m.initialize();
      expect(m.node?.isRunning()).toBe(true);
    } finally {
      await m.shutdown();
    }
  });

  it('initialize 中途失败回滚：资源收拢、实例可安全 shutdown，修正配置后新实例可重试', async () => {
    // 注入一个在 onIncomingConnection 抛错的 provider，让网络装配阶段必然失败
    const brokenProvider = {
      dial: async () => {
        throw new Error('unreachable');
      },
      onIncomingConnection: () => {
        throw new Error('provider registration boom');
      },
    };
    const failing = new Mebular({
      storagePath,
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: { enabled: true, provider: brokenProvider },
    });

    await expect(failing.initialize()).rejects.toThrow('boom');
    expect(failing.isInitialized()).toBe(false);
    // 回滚后子系统仍不可访问；shutdown 幂等不抛
    expect(() => failing.graph).toThrow(MebularError);
    await failing.shutdown();

    // 同一存储路径换新实例（正常 provider）可干净初始化——证明存储已被回滚收拢
    const retry = new Mebular({
      storagePath,
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: { enabled: true, provider: new InMemoryHub() },
    });
    await retry.initialize();
    expect(retry.isInitialized()).toBe(true);
    expect(retry.node?.isRunning()).toBe(true);
    await retry.shutdown();
  });

  it('身份文件权限收紧为 0600（仅属主可读写）', async () => {
    const m = new Mebular({
      storagePath,
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    });
    await m.initialize();
    const mode = (await stat(`${storagePath}.identity.json`)).mode & 0o777;
    expect(mode).toBe(0o600);
    await m.shutdown();
  });
});
