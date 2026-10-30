// C1b：详情过期维护调度（启动一次 + 每 24h）与 MCP 生命周期接入。
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityManager, Mebular, MemoryService } from '@mebular/core';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';
import {
  createDetailMaintenance,
  DETAIL_MAINTENANCE_INTERVAL_MS,
} from '../../packages/mcp/src/detail-maintenance.mjs';

const DAY = 24 * 60 * 60 * 1000;
const cleanups = [];
const savedCloudRoot = process.env.MEBULAR_CLOUD_ROOT;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
  if (savedCloudRoot === undefined) delete process.env.MEBULAR_CLOUD_ROOT;
  else process.env.MEBULAR_CLOUD_ROOT = savedCloudRoot;
});

function fakeTimer() {
  const timer = { unref: jest.fn() };
  return timer;
}

function waitFor(check, timeoutMs = 2_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        if (check()) {
          resolve();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('waitFor 超时'));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe('createDetailMaintenance', () => {
  it('service 就绪后启动一次，注册 24h timer 并 unref；定时器触发再次扫描', async () => {
    let now = Date.UTC(2026, 0, 1, 9, 0, 0);
    const service = { pruneExpiredDetails: jest.fn(async () => ['detail-1']) };
    let callback = null;
    const timer = fakeTimer();
    const setIntervalFn = jest.fn((fn, ms) => {
      callback = fn;
      expect(ms).toBe(DETAIL_MAINTENANCE_INTERVAL_MS);
      return timer;
    });
    const clearIntervalFn = jest.fn();
    const maintenance = createDetailMaintenance({
      getService: () => service,
      now: () => now,
      setIntervalFn,
      clearIntervalFn,
      logger: { error: jest.fn() },
    });

    maintenance.start();
    await maintenance.idle();
    expect(service.pruneExpiredDetails).toHaveBeenCalledTimes(1);
    expect(service.pruneExpiredDetails).toHaveBeenCalledWith({ now });
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(timer.unref).toHaveBeenCalledTimes(1);
    expect(maintenance.status()).toMatchObject({
      running: true,
      lastSuccessAt: now,
      lastSuccessDay: '2026-1-1',
      lastResult: { reason: 'startup', pruned: 1, at: now },
      lastError: null,
    });

    now += DAY;
    callback();
    await maintenance.idle();
    expect(service.pruneExpiredDetails).toHaveBeenCalledTimes(2);
    expect(service.pruneExpiredDetails).toHaveBeenLastCalledWith({ now });
  });

  it('service 未就绪时不建 timer；热切换后就绪再启动，当天已成功则跳过重复扫描', async () => {
    let now = Date.UTC(2026, 0, 2, 8, 0, 0);
    let service = null;
    const prune = jest.fn(async () => []);
    const timer = fakeTimer();
    const setIntervalFn = jest.fn(() => timer);
    const maintenance = createDetailMaintenance({
      getService: () => service,
      now: () => now,
      setIntervalFn,
      clearIntervalFn: jest.fn(),
      logger: { error: jest.fn() },
    });

    maintenance.start();
    await maintenance.idle();
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();

    service = { pruneExpiredDetails: prune };
    maintenance.start();
    await maintenance.idle();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledTimes(1);

    // 同一进程内再次热切换：复用 timer，不重复扫描。
    maintenance.start();
    await maintenance.idle();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledTimes(1);

    // 下一次 24h 周期照常执行。
    now += DAY;
    await maintenance.runOnce({ reason: 'interval' });
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('扫描失败只记录 status 与日志，不抛出，也不影响下一次定时扫描', async () => {
    const now = Date.UTC(2026, 0, 3, 8, 0, 0);
    const failure = Object.assign(new Error('disk unavailable'), { code: 'EIO' });
    const service = {
      pruneExpiredDetails: jest.fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(['detail-2']),
    };
    let callback = null;
    const timer = fakeTimer();
    const logger = { error: jest.fn() };
    const maintenance = createDetailMaintenance({
      getService: () => service,
      now: () => now,
      setIntervalFn: jest.fn((fn) => {
        callback = fn;
        return timer;
      }),
      clearIntervalFn: jest.fn(),
      logger,
    });

    maintenance.start();
    await expect(maintenance.idle()).resolves.toMatchObject({ code: 'EIO' });
    expect(maintenance.status()).toMatchObject({
      running: true,
      lastError: { reason: 'startup', code: 'EIO', message: 'disk unavailable', at: now },
    });
    expect(logger.error).toHaveBeenCalledWith('DETAIL_MAINTENANCE_FAILED EIO disk unavailable');

    callback();
    await maintenance.idle();
    expect(service.pruneExpiredDetails).toHaveBeenCalledTimes(2);
    expect(maintenance.status()).toMatchObject({
      lastSuccessAt: now,
      lastResult: { reason: 'interval', pruned: 1, at: now },
      lastError: null,
    });
  });

  it('stop 清理 timer 和回调，不再执行扫描', async () => {
    const service = { pruneExpiredDetails: jest.fn(async () => []) };
    let callback = null;
    const timer = fakeTimer();
    const clearIntervalFn = jest.fn();
    const maintenance = createDetailMaintenance({
      getService: () => service,
      now: () => Date.UTC(2026, 0, 4),
      setIntervalFn: jest.fn((fn) => {
        callback = fn;
        return timer;
      }),
      clearIntervalFn,
      logger: { error: jest.fn() },
    });

    maintenance.start();
    await maintenance.idle();
    expect(maintenance.stop()).toMatchObject({ running: false });
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);

    callback();
    await maintenance.idle();
    expect(service.pruneExpiredDetails).toHaveBeenCalledTimes(1);
    expect(maintenance.status().running).toBe(false);
  });
});

describe('MCP daemon 详情维护生命周期', () => {
  it('启动即墓碑过期详情；不触碰 record.updatedAt；close 清理 timer', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mebular-detail-maintenance-'));
    process.env.MEBULAR_CLOUD_ROOT = join(home, 'cloud');
    const master = await new IdentityManager().generateUserMasterKey();
    const app = new Mebular({
      storagePath: join(home, 'store.jsonl'),
      deviceId: 'device-detail-maintenance',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      sync: { autoSync: false },
    });
    await app.initialize();
    cleanups.push(async () => {
      await app.shutdown().catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    });
    const service = new MemoryService(app);
    const [record] = await service.write([{
      type: 'observation',
      content: 'maintenance record',
      metadata: { namespace: 'agent:maintenance' },
    }]);
    const recordBefore = await app.graph.getNode(record.id);
    const written = await service.writeDetails([{
      domain: 'agent:maintenance',
      detailKind: 'raw_chunk',
      role: 'user',
      text: 'expired detail',
      recordIds: [record.id],
      expiresAt: Date.now() - 1_000,
      provenance: { source: 'runtime', writerType: 'system', writerId: 'system', at: Date.now() },
    }]);
    const detailId = written.results[0].id;

    const server = await startHttpServer({
      home,
      app,
      service,
      config: { deviceId: 'device-detail-maintenance', sync: { namespaces: [] } },
      buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
      host: '127.0.0.1',
      port: 0,
      auth: 'none',
    });
    cleanups.push(async () => { await server.close(); });

    await waitFor(() => server.getState().detailMaintenance.lastSuccessAt !== null);
    const state = server.getState();
    expect(state.detailMaintenance).toMatchObject({ running: true, lastError: null });
    expect(state.detailMaintenance.lastResult.pruned).toBe(1);

    const detail = await app.graph.getNode(detailId);
    expect(detail.deletedAt).toBeGreaterThan(0);
    expect(detail.metadata.deletedReason).toBe('retention_expired');
    const recordAfter = await app.graph.getNode(record.id);
    expect(recordAfter.updatedAt).toBe(recordBefore.updatedAt);
    expect(recordAfter.metadata?.detailAvailable).toBeUndefined();
    expect(await service.detailAvailabilityForRecords([record.id]))
      .toEqual(new Map([[record.id, false]]));

    await server.close();
    expect(server.getState().detailMaintenance.running).toBe(false);
  }, 15_000);
});
