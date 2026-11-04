// sidecar 本地层：目录/权限、staging/Trace 路径、有界 outbox、TTL cache、
// 详情只读 cache 与 staging 配额。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SidecarLocalLayer,
  BoundedOutbox,
  JsonCache,
  LocalLayerError,
} from '../../src/sidecar/local-layer.js';
import {
  newRawChunkId,
  newRecallTraceId,
  sha256Hex,
} from '../../src/runtime/local-store.js';

describe('SidecarLocalLayer', () => {
  let home: string;
  let root: string;
  let now: number;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mebular-memory-runtime-local-'));
    root = join(home, 'memory-runtime');
    now = Date.UTC(2026, 0, 1, 12, 0, 0);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('初始化 memory-runtime/staging|cache|outbox|logs|tmp 目录，0700', async () => {
    const layer = new SidecarLocalLayer({ root, now: () => now });
    await layer.init();

    for (const dir of ['staging', 'cache', 'cache/details', 'outbox', 'outbox/dead', 'logs', 'tmp', 'models']) {
      const info = await stat(join(root, dir));
      expect(info.isDirectory()).toBe(true);
      if (process.platform !== 'win32') {
        expect(info.mode & 0o777).toBe(0o700);
      }
    }
    expect(layer.store.root).toBe(root);
    expect(layer.store.stagingPath).toBe(join(root, 'staging', 'chunks.jsonl'));
    expect(layer.store.tracesPath).toBe(join(root, 'traces.jsonl'));
  });

  it('staging/Trace 写入 <root>/staging 与 <root>/traces.jsonl，文件 0600', async () => {
    const layer = new SidecarLocalLayer({ root, now: () => now });
    await layer.init();

    const text = '用户偏好深色主题';
    const chunk = {
      schema: 1 as const,
      id: newRawChunkId(),
      threadId: 'th_1',
      agentId: 'agent:test',
      hostId: 'h_test',
      role: 'user' as const,
      text,
      mime: 'text/plain' as const,
      at: now,
      contentHash: sha256Hex(text),
      redaction: { applied: false, rules: [] },
      expiresAt: now + 24 * 60 * 60 * 1000,
    };
    const stored = await layer.store.putStagingChunk('cl_test', chunk);
    expect(stored.duplicate).toBe(false);
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'staging', 'chunks.jsonl'))).mode & 0o777).toBe(0o600);
    }

    const trace = {
      schema: 1 as const,
      id: newRecallTraceId(),
      cloudId: 'cl_test',
      agentId: 'agent:test',
      hostId: 'h_test',
      threadId: 'th_1',
      at: now,
      queryHash: sha256Hex('query'),
      queryPreview: 'query',
      namespaces: ['agent:test'],
      hits: [],
      model: { extractor: 'heuristic' },
      tookMs: 3,
      degraded: false,
    };
    await layer.store.putTrace(trace);
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'traces.jsonl'))).mode & 0o777).toBe(0o600);
    }

    const stats = await layer.stats();
    expect(stats.stagingChunks).toBe(1);
    expect(stats.traces).toBe(1);

    expect(await layer.clearStaging([chunk.id])).toBe(1);
    expect((await layer.stats()).stagingChunks).toBe(0);
  });

  it('staging 超过字节上限时淘汰最旧 chunk', async () => {
    let clock = now;
    const layer = new SidecarLocalLayer({ root, stagingBytes: 8, now: () => clock });
    await layer.init();

    const make = (id: string, text: string) => ({
      schema: 1 as const,
      id,
      threadId: 'th_1',
      agentId: 'agent:test',
      hostId: 'h_test',
      role: 'user' as const,
      text,
      mime: 'text/plain' as const,
      at: clock,
      contentHash: sha256Hex(text),
      redaction: { applied: false, rules: [] },
      expiresAt: now + 24 * 60 * 60 * 1000,
    });
    await layer.store.putStagingChunk('cl_test', make('rc_old_0001', '1111'));
    clock += 1;
    await layer.store.putStagingChunk('cl_test', make('rc_new_0002', '2222'));
    clock += 1;
    await layer.store.putStagingChunk('cl_test', make('rc_new_0003', '3333'));

    const chunks = await layer.store.listStagingChunks();
    expect(chunks.map((chunk) => chunk.id)).toEqual(['rc_new_0002', 'rc_new_0003']);
  });

  it('详情只读 cache 独立于通用 cache，可失效', async () => {
    const layer = new SidecarLocalLayer({ root, now: () => now });
    await layer.init();
    await layer.putCachedDetail('01DETAIL', { detail: { text: '原文' } });
    expect(await layer.getCachedDetail('01DETAIL')).toMatchObject({ detail: { text: '原文' } });
    expect((await layer.stats()).detailCacheEntries).toBe(1);
    expect(await layer.invalidateCachedDetail('01DETAIL')).toBe(true);
    expect(await layer.getCachedDetail('01DETAIL')).toBeNull();
  });

  it('重启后 staging 与 outbox 可从磁盘恢复；成功重放即删', async () => {
    const first = new SidecarLocalLayer({ root, now: () => now });
    await first.init();
    const text = 'staging 恢复';
    await first.store.putStagingChunk('cl_test', {
      schema: 1,
      id: 'rc_restart_0001',
      threadId: 'th_restart',
      agentId: 'opencode',
      hostId: 'h_test',
      role: 'user',
      text,
      mime: 'text/plain',
      at: now,
      contentHash: sha256Hex(text),
      redaction: { applied: false, rules: [] },
      expiresAt: now + 86_400_000,
    });
    await first.outbox.enqueue({
      id: 'ob_restart_1',
      requestId: 'req_restart_1',
      endpoint: '/detail',
      body: { op: 'write', items: [] },
      meta: { kind: 'detail', stagingChunkIds: ['rc_restart_0001'] },
      createdAt: now,
    });

    const second = new SidecarLocalLayer({ root, now: () => now + 1_000 });
    await second.init();
    expect((await second.stats()).stagingChunks).toBe(1);
    const outbox = await second.outbox.list();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.endpoint).toBe('/detail');
    expect(outbox[0]?.meta?.stagingChunkIds).toEqual(['rc_restart_0001']);

    expect(await second.clearStaging(['rc_restart_0001'])).toBe(1);
    expect(await second.outbox.remove('ob_restart_1')).toBe(true);
  });

  it('outbox 有界、幂等入队、删除与 dead letter', async () => {
    const outbox = new BoundedOutbox({
      root: join(root, 'outbox'),
      deadRoot: join(root, 'outbox', 'dead'),
      maxItems: 2,
      maxBytes: 1024 * 1024,
      now: () => now,
    });
    await outbox.init();

    const first = await outbox.enqueue({
      id: 'ob_1',
      requestId: 'req_1',
      endpoint: '/write',
      body: { items: [] },
    });
    expect(first.duplicate).toBe(false);
    expect(first.item).toMatchObject({ id: 'ob_1', method: 'POST', attempts: 0 });

    const duplicate = await outbox.enqueue({
      id: 'ob_1',
      requestId: 'req_1',
      endpoint: '/write',
      body: { items: [] },
    });
    expect(duplicate.duplicate).toBe(true);

    await outbox.enqueue({ id: 'ob_2', requestId: 'req_2', endpoint: '/update', body: {} });
    await expect(outbox.enqueue({ id: 'ob_3', requestId: 'req_3', endpoint: '/delete', body: {} }))
      .rejects.toMatchObject({ code: 'outbox_full' });

    expect((await outbox.stats()).items).toBe(2);
    expect((await outbox.list()).map((item) => item.id)).toEqual(['ob_1', 'ob_2']);

    expect(await outbox.deadLetter('ob_2', 'domain_write_forbidden')).toBe(true);
    expect(await outbox.deadCount()).toBe(1);
    expect((await outbox.stats()).items).toBe(1);
    expect(await outbox.remove('ob_1')).toBe(true);
    expect((await outbox.stats()).items).toBe(0);
  });

  it('outbox 字节上限也会拒绝新写', async () => {
    const outbox = new BoundedOutbox({
      root: join(root, 'outbox'),
      deadRoot: join(root, 'outbox', 'dead'),
      maxItems: 100,
      maxBytes: 10,
      now: () => now,
    });
    await outbox.init();
    await expect(outbox.enqueue({ id: 'ob_big', endpoint: '/write', body: { text: '0123456789' } }))
      .rejects.toBeInstanceOf(LocalLayerError);
  });

  it('cache 支持 TTL、删除、容量淘汰', async () => {
    let clock = now;
    const cache = new JsonCache({
      root: join(root, 'cache'),
      maxEntries: 2,
      maxBytes: 1024 * 1024,
      now: () => clock,
    });
    await cache.init();

    await cache.set('a', { value: 1 }, { ttlMs: 10 });
    expect(await cache.get('a')).toEqual({ value: 1 });

    clock = now + 20;
    expect(await cache.get('a')).toBeNull();

    clock = now;
    await cache.set('b', 1);
    await cache.set('c', 2);
    await cache.set('d', 3);
    const stats = await cache.stats();
    expect(stats.entries).toBe(2);
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('c')).toBe(2);
    expect(await cache.get('d')).toBe(3);
    expect(await cache.delete('c')).toBe(true);
    expect(await cache.get('c')).toBeNull();
    expect(await cache.clear()).toBe(1);
    expect((await cache.stats()).entries).toBe(0);
  });

  it('零请求/不重启推进完整间隔：物理清理 staging/trace/cache/outbox 依赖与 dead，诊断无正文', async () => {
    let callback: (() => void) | null = null;
    const timer = { unref: jest.fn() };
    const layer = new SidecarLocalLayer({
      root,
      stagingHours: 1,
      traceRetentionDays: 1,
      now: () => now,
    });
    await layer.init();
    const text = 'idle staging';
    const chunk = {
      schema: 1 as const,
      id: 'rc_idle_expiry',
      threadId: 'th_idle',
      agentId: 'opencode',
      hostId: 'h_test',
      role: 'user' as const,
      text,
      mime: 'text/plain' as const,
      at: now,
      contentHash: sha256Hex(text),
      redaction: { applied: false, rules: [] },
      expiresAt: now + 1_000,
    };
    await layer.putStagingChunk('cl_test', chunk);
    await layer.store.putTrace({
      schema: 1,
      id: 'tr_idle_expiry',
      cloudId: 'cl_test',
      agentId: 'opencode',
      hostId: 'h_test',
      at: now,
      queryHash: sha256Hex('idle'),
      queryPreview: '',
      namespaces: [],
      hits: [],
      model: {},
      tookMs: 0,
      degraded: false,
    });
    await layer.cache.set('idle-cache', { value: 1 }, { ttlMs: 1_000 });
    await layer.putCachedDetail('detail-idle', {
      detail: { text: 'cached', expiresAt: now + 1_000, availability: ['available'] },
    });
    const sentinel = 'sk-idle-outbox-never-persist-123456';
    await layer.outbox.enqueue({
      id: 'ob_idle_dependency',
      requestId: 'req_idle_dependency',
      endpoint: '/detail',
      body: { text: `api_key=${sentinel}` },
      meta: { kind: 'detail', stagingChunkIds: [chunk.id] },
      createdAt: now,
    });
    const activePath = join(root, 'outbox', 'ob_idle_dependency.json');
    expect(await readFile(activePath, 'utf8')).not.toContain(sentinel);

    const setIntervalFn = jest.fn((fn: () => void) => {
      callback = fn;
      return timer;
    });
    layer.startMaintenance({
      intervalMs: 1_000,
      setIntervalFn: setIntervalFn as unknown as typeof setInterval,
      clearIntervalFn: jest.fn() as unknown as typeof clearInterval,
    });
    expect(callback).not.toBeNull();
    expect(timer.unref).toHaveBeenCalledTimes(1);

    now += 24 * 60 * 60 * 1000 + 1;
    callback!();
    await layer.idleMaintenance();
    const afterIdle = await layer.stats();
    expect(afterIdle).toMatchObject({
      stagingChunks: 0,
      traces: 0,
      cacheEntries: 0,
      detailCacheEntries: 0,
      outboxItems: 0,
      deadLetter: 1,
    });
    expect(await readFile(join(root, 'staging', 'chunks.jsonl'), 'utf8')).toBe('');
    expect(await readFile(join(root, 'traces.jsonl'), 'utf8')).toBe('');
    const dead = await readFile(join(root, 'outbox', 'dead', 'ob_idle_dependency.json'), 'utf8');
    expect(dead).toContain('retention_expired');
    expect(dead).not.toContain(sentinel);
    const diagnostics = JSON.stringify(layer.maintenanceStatus());
    expect(diagnostics).not.toContain(sentinel);
    expect(diagnostics).not.toContain('idle staging');
    expect(layer.maintenanceStatus().lastResult).toMatchObject({
      cacheRemoved: 1,
      detailCacheRemoved: 1,
      outboxExpired: 0,
      deadRemoved: 0,
    });
    expect(layer.maintenanceStatus().lastResult?.bytes).toBeGreaterThan(0);

    now += 30 * 24 * 60 * 60 * 1000;
    callback!();
    await layer.idleMaintenance();
    expect((await layer.stats()).deadLetter).toBe(0);
    expect(layer.maintenanceStatus().lastResult?.deadRemoved).toBe(1);
    layer.stopMaintenance();
  });

  it('D2：active 最长 30 天或更早 deadline，dead 再保留 30 天', async () => {
    const outbox = new BoundedOutbox({
      root: join(root, 'outbox'),
      deadRoot: join(root, 'outbox', 'dead'),
      now: () => now,
    });
    await outbox.init();
    await outbox.enqueue({
      id: 'ob_thirty_days',
      requestId: 'req_thirty_days',
      endpoint: '/write',
      body: { items: [] },
      createdAt: now,
    });
    await outbox.enqueue({
      id: 'ob_earlier_deadline',
      requestId: 'req_earlier_deadline',
      endpoint: '/write',
      body: { items: [] },
      createdAt: now,
      expiresAt: now + 500,
    });

    now += 500;
    expect(await outbox.cleanup(now)).toEqual({ expired: 1, deadRemoved: 0 });
    now += 30 * 24 * 60 * 60 * 1000 - 500;
    expect(await outbox.cleanup(now)).toEqual({ expired: 1, deadRemoved: 0 });
    expect((await outbox.deadStats()).items).toBe(2);
    const dead = await readFile(join(root, 'outbox', 'dead', 'ob_thirty_days.json'), 'utf8');
    expect(dead).toContain('retention_expired');

    now += 30 * 24 * 60 * 60 * 1000;
    expect(await outbox.cleanup(now)).toEqual({ expired: 0, deadRemoved: 2 });
    expect((await outbox.deadStats()).items).toBe(0);
  });

  it('Detail cache 在物理维护前也按实际 expiresAt/deletedAt 失效', async () => {
    const layer = new SidecarLocalLayer({ root, now: () => now });
    await layer.init();
    await layer.putCachedDetail('detail-expiry', {
      detail: { text: 'not-after-expiry', expiresAt: now + 10, availability: ['available'] },
    });
    now += 10;
    expect(await layer.getCachedDetail('detail-expiry')).toBeNull();
    expect((await layer.stats()).detailCacheEntries).toBe(0);

    await layer.putCachedDetail('detail-deleted', {
      detail: { text: 'deleted', expiresAt: 0, deletedAt: now, availability: ['deleted'] },
    });
    expect(await layer.getCachedDetail('detail-deleted')).toBeNull();
  });
});
