// Fleet 订阅语义（库级）：onboard 自订阅 / subscribe / unsubscribe / subscribers / 建域 / 恢复。
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import {
  namespaceSubscribers,
  namespaceSubscriptions,
  onboardDevice,
  offlineMebularOptions,
  doctor,
  saveFleetConfig,
  planHandoff,
  leaveNamespace,
  rejoinNamespace,
  rejoinReset,
  readMasterKeyFile,
  restoreDevice,
  subscribeNamespace,
  loadFleetConfig,
  fleetConfigPath,
} from '../../packages/fleet/src/index.js';

const AGENTS = [{ name: 'echo', kind: 'echo' as const }];

describe('fleet 订阅语义', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fleet-sub-'));
    await onboardDevice({ dir, device: 'device-A', agents: AGENTS });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  async function open(): Promise<Mebular> {
    const config = await loadFleetConfig(fleetConfigPath(dir));
    const encryption = await readMasterKeyFile(config.masterKeyFile);
    const app = new Mebular(offlineMebularOptions(config, encryption) as never);
    await app.initialize();
    return app;
  }

  it('onboard 即自订阅默认域', async () => {
    const app = await open();
    try {
      expect((await app.getNamespaceSubscriptions('tasks')).subscribers).toContain('device-A');
    } finally {
      await app.shutdown();
    }
  });

  it('subscribe 新域 → subscribers 查询可见', async () => {
    const app = await open();
    try {
      await subscribeNamespace(dir, { namespace: 'notes' });
      expect(await namespaceSubscribers(dir, 'notes')).toContain('device-A');
      expect((await namespaceSubscriptions(dir, 'notes')).active).toBe(true);
    } finally {
      await app.shutdown();
    }
  });

  it('unsubscribe → active=false 但保留记录', async () => {
    const app = await open();
    try {
      await subscribeNamespace(dir, { namespace: 'notes' });
      await subscribeNamespace(dir, { namespace: 'notes', active: false });
      const view = await namespaceSubscriptions(dir, 'notes');
      expect(view.active).toBe(true); // 有记录 = 权威模式
      expect(view.subscribers).not.toContain('device-A');
    } finally {
      await app.shutdown();
    }
  });

  it('重复 subscribe 幂等（最新 active 胜出）', async () => {
    const app = await open();
    try {
      await subscribeNamespace(dir, { namespace: 'notes' });
      await subscribeNamespace(dir, { namespace: 'notes' });
      expect(await namespaceSubscribers(dir, 'notes')).toContain('device-A');
    } finally {
      await app.shutdown();
    }
  });

  it('建域零门槛（公告进入目录）', async () => {
    const app = await open();
    try {
      await app.declareNamespace({ namespace: 'ledger', note: 'test' });
      expect(await app.getNamespaceDeclarations()).toContain('ledger');
      expect(await app.getNamespaceDirectory()).toContain('ledger');
    } finally {
      await app.shutdown();
    }
  });

  it('restoreDevice 对未移出设备是 no-op', async () => {
    const app = await open();
    try {
      const event = await restoreDevice(dir, { subject: 'device-B' });
      expect(event.subject).toBe('device-B');
      expect(await app.getBlockedDevices()).not.toContain('device-B');
    } finally {
      await app.shutdown();
    }
  });

  it('移出 → 恢复：blocked 清空且写入 restore 记录', async () => {
    const config = await loadFleetConfig(fleetConfigPath(dir));
    const encryption = await readMasterKeyFile(config.masterKeyFile);
    const app = new Mebular(offlineMebularOptions(config, encryption) as never);
    await app.initialize();
    try {
      await app.revokeDevice({ subject: 'device-B' });
      expect(await app.getBlockedDevices()).toContain('device-B');
      await app.restoreDevice({ subject: 'device-B' });
      expect(await app.getBlockedDevices()).not.toContain('device-B');
    } finally {
      await app.shutdown();
    }
  });

  it('rejoin/rejoinReset 包装器：曾订阅 → 可重入并落 reset 标记', async () => {
    const app = await open();
    await app.shutdown();
    const rejoin = await rejoinNamespace(dir, { namespace: 'tasks' });
    expect(rejoin).toMatchObject({ ok: true, namespace: 'tasks', reset: true, subscribed: true });
    expect(await rejoinReset(dir, 'tasks')).toBe(true);
  });

  it('planHandoff/leaveNamespace 包装器：force 清理并写交接记录', async () => {
    const plan = await planHandoff(dir, { namespace: 'tasks', successor: 'device-B' });
    expect(plan.namespace).toBe('tasks');
    expect(plan.successorSubscribed).toBe(false);
    const left = await leaveNamespace(dir, { namespace: 'tasks', successor: 'device-B', force: true, note: 'test' });
    expect(left).toMatchObject({ ok: true, namespace: 'tasks', forced: true });
    expect(await rejoinReset(dir, 'tasks')).toBe(false);
  });

  it('doctor 分支：无法解析监听 / 守护不可达 / 未完成交接 / 心跳新鲜', async () => {
    const config = await loadFleetConfig(fleetConfigPath(dir));
    await saveFleetConfig(fleetConfigPath(dir), {
      ...config,
      listen: 'not-a-multiaddr',
      daemon: { endpoint: 'http://127.0.0.1:1' },
    });
    await writeFile(`${config.storagePath}.handoff.json`, JSON.stringify({ namespace: 'tasks' }));
    await writeFile(join(dir, 'service.heartbeat'), JSON.stringify({ ts: Date.now(), role: 'fleet-node', pid: 1, sha: 'test' }));
    const report = await doctor(dir);
    const byName = new Map(report.checks.map((check) => [check.name, check]));
    expect(byName.get('监听地址')?.status).toBe('SKIP');
    expect(byName.get('守护')?.status).toBe('FAIL');
    expect(byName.get('交接状态')?.status).toBe('FAIL');
    expect(byName.get('心跳新鲜')?.status).toBe('PASS');
  });

  it('订阅只能改自己：member 恒为本机', async () => {
    const app = await open();
    try {
      const event = await app.subscribeNamespace('notes');
      expect((event.data as { subscription: { member: string } }).subscription.member).toBe(app.deviceId);
    } finally {
      await app.shutdown();
    }
  });
});
