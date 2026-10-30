// sidecar 本地层：目录/权限、Raw/Trace 路径、有界 outbox、TTL cache。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, stat } from 'node:fs/promises';
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

  it('初始化 memory-runtime/raw|cache|outbox|logs|tmp 目录，0700', async () => {
    const layer = new SidecarLocalLayer({ root, now: () => now });
    await layer.init();

    for (const dir of ['raw', 'cache', 'outbox', 'outbox/dead', 'logs', 'tmp', 'models']) {
      const info = await stat(join(root, dir));
      expect(info.isDirectory()).toBe(true);
      if (process.platform !== 'win32') {
        expect(info.mode & 0o777).toBe(0o700);
      }
    }
    expect(layer.store.root).toBe(root);
    expect(layer.store.rawPath).toBe(join(root, 'raw', 'chunks.jsonl'));
    expect(layer.store.tracesPath).toBe(join(root, 'traces.jsonl'));
  });

  it('Raw/Trace 写入 <root>/raw 与 <root>/traces.jsonl，文件 0600', async () => {
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
      expiresAt: now + 7 * 24 * 60 * 60 * 1000,
    };
    const stored = await layer.store.putRawChunk('cl_test', chunk);
    expect(stored.duplicate).toBe(false);
    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'raw', 'chunks.jsonl'))).mode & 0o777).toBe(0o600);
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
    expect(stats.rawChunks).toBe(1);
    expect(stats.traces).toBe(1);
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
});
