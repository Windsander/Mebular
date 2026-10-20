// 两守护真实 loopback：cloud_name / device_name 随 __policy__ 事件同步。
//
// 两台完整 Mebular 实例（真实 libp2p TCP 127.0.0.1）：
//   - A 改忆云名 → B 同步后显示；
//   - B 改设备名 → A 的设备名查询显示；
//   - 离线并发改名 → 重连后两端按同一确定性顺序收敛；
//   - B 被 A 移出后：B 本地改名被拒，绕过 API 直接写事件也不得在 A 生效。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { DEVICE_NAME_EVENT, POLICY_NAMESPACE } from '../../src/sync/grantPolicy.js';
import { useHeavyTimeout } from '../helpers/timeouts.js';

useHeavyTimeout();

function libp2pPackagesInstalled(): boolean {
  const specs = [
    'libp2p',
    '@libp2p/tcp',
    '@chainsafe/libp2p-noise',
    '@chainsafe/libp2p-yamux',
    '@libp2p/crypto',
    '@libp2p/peer-id',
    '@multiformats/multiaddr',
  ];
  return specs.every((spec) => existsSync(join(process.cwd(), 'node_modules', spec)));
}

const itIfLibp2p = libp2pPackagesInstalled() ? it : it.skip;

async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 75,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitForAsync timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function waitForAddrs(app: Mebular, timeoutMs = 10_000): Promise<string[]> {
  let addrs: string[] = [];
  await waitForAsync(async () => {
    addrs = (app.node?.getLocalMultiaddrs() ?? []).filter((addr) => addr.includes('127.0.0.1'));
    return addrs.length > 0;
  }, timeoutMs);
  return addrs;
}

describe('两守护真实 loopback · 展示名同步', () => {
  let dir: string;
  let master: { publicKey: Uint8Array; privateKey: CryptoKey };
  let a: Mebular;
  let b: Mebular;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-names-loopback-'));
    master = await new IdentityManager().generateUserMasterKey();
  });

  afterEach(async () => {
    for (const app of [a, b]) {
      if (app?.isInitialized()) await app.shutdown().catch(() => undefined);
    }
    await rm(dir, { recursive: true, force: true });
  });

  function makeApp(deviceId: string): Mebular {
    return new Mebular({
      storagePath: join(dir, `${deviceId}.jsonl`),
      deviceId,
      deviceName: `${deviceId} 初始名`,
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: {
        enabled: true,
        libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] },
        lan: { enabled: false },
        relayService: 'off',
      },
      sync: { autoSync: true, pushOnWrite: true, antiEntropy: { enabled: false } },
    });
  }

  itIfLibp2p('A 改忆云名/设备名，B 同步可见；离线并发收敛；被移出者改名无效', async () => {
    a = makeApp('device-A');
    b = makeApp('device-B');
    await a.initialize();
    await b.initialize();
    const addrs = await waitForAddrs(a);
    await a.setCloudName({ name: '实验室云' });
    await a.setDeviceName({ name: '主控笔记本' });

    const syncedA = new Promise((resolve) => a.sync.once('sync-completed', resolve));
    const syncedB = new Promise((resolve) => b.sync.once('sync-completed', resolve));
    await b.node!.connectToPeer(a.node!.peerId, addrs[0]);
    await Promise.all([syncedA, syncedB]);

    await waitForAsync(async () => (await b.getCloudName())?.name === '实验室云');
    await waitForAsync(async () => (await b.getDeviceName('device-A'))?.name === '主控笔记本');

    // B 本人改设备名 → A 可见
    await b.setDeviceName({ name: 'B 的台式机' });
    await a.sync.runAntiEntropyCycle().catch(() => undefined);
    await waitForAsync(async () => (await a.getDeviceName('device-B'))?.name === 'B 的台式机');

    // 离线并发改名：两端各写一笔不可比的事件，重连后收敛到同一结果
    await a.node!.disconnectPeer(b.node!.peerId).catch(() => undefined);
    await b.node!.disconnectPeer(a.node!.peerId).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await a.setCloudName({ name: '离线改名-A' });
    await b.setCloudName({ name: '离线改名-B' });
    await b.node!.connectToPeer(a.node!.peerId, addrs[0]);
    // 重连后主动驱动 anti-entropy（不依赖某一侧自动会话的触发时序）。
    await waitForAsync(async () => {
      await a.sync.runAntiEntropyCycle().catch(() => undefined);
      await b.sync.runAntiEntropyCycle().catch(() => undefined);
      const [nameA, nameB] = await Promise.all([a.getCloudName(), b.getCloudName()]);
      return Boolean(nameA?.name) && nameA?.name === nameB?.name;
    }, 12_000);
    const [afterA, afterB] = await Promise.all([a.getCloudName(), b.getCloudName()]);
    expect(afterA?.name).toMatch(/^离线改名-[AB]$/);
    expect(afterA?.name).toBe(afterB?.name);

    // A 移出 B：B 不能再改名；绕过 API 直接写事件也不得在 A 生效
    await a.revokeDevice({ subject: 'device-B' });
    await a.sync.runAntiEntropyCycle().catch(() => undefined);
    await waitForAsync(async () => (await b.getBlockedDevices()).includes('device-B'));
    await expect(b.setDeviceName({ name: '被移出后改名' })).rejects.toThrow(/不能改名/);
    await expect(b.setCloudName({ name: '被移出后改忆云名' })).rejects.toThrow(/不能改名/);

    await b.eventLog.append({
      type: DEVICE_NAME_EVENT,
      data: { deviceName: { v: 1, subject: 'device-B', name: '绕过 API 的名字', issuedAt: Date.now() } },
      namespace: POLICY_NAMESPACE,
    });
    await b.sync.runAntiEntropyCycle().catch(() => undefined);
    await a.sync.runAntiEntropyCycle().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await a.getDeviceName('device-B')).toBeNull();
  });
});
