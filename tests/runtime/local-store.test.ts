// Runtime 本地存储：0600、幂等去重、内容冲突、过期清理、崩溃半行恢复、Trace 环形保留。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeLocalStore,
  RuntimeLocalStoreError,
  newRawChunkId,
  newRecallTraceId,
  sha256Hex,
  type RawChunk,
  type RecallTrace,
} from '../../src/runtime/index.js';

describe('RuntimeLocalStore', () => {
  let dir: string;
  let now: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-runtime-local-'));
    now = Date.UTC(2026, 0, 1, 12, 0, 0);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const store = (options: { traceMaxEntries?: number; traceRetentionDays?: number } = {}) => new RuntimeLocalStore({
    root: dir,
    now: () => now,
    ...options,
  });

  function raw(text: string, options: { id?: string; expiresAt?: number; chunkIndex?: number } = {}): RawChunk {
    return {
      schema: 1,
      id: options.id ?? newRawChunkId(),
      threadId: 'th_1',
      agentId: 'opencode',
      hostId: 'h_test',
      role: 'user',
      text,
      mime: 'text/plain',
      at: now,
      ...(options.chunkIndex !== undefined ? { chunkIndex: options.chunkIndex } : {}),
      contentHash: sha256Hex(text),
      redaction: { applied: false, rules: [] },
      expiresAt: options.expiresAt ?? now + 7 * 86_400_000,
    };
  }

  function trace(id = newRecallTraceId(), at = now): RecallTrace {
    return {
      schema: 1,
      id,
      cloudId: 'cl_test',
      agentId: 'opencode',
      hostId: 'h_test',
      threadId: 'th_1',
      at,
      queryHash: sha256Hex('主题'),
      queryPreview: '主题',
      namespaces: ['default'],
      hits: [{ id: 'n1', type: 'fact', rank: 1 }],
      model: { query: 'heuristic' },
      tookMs: 3,
      degraded: false,
    };
  }

  it('RawChunk 幂等：同键返回已有 id + duplicate=true；同键不同文本拒绝', async () => {
    const local = store();
    const chunk = raw('以后默认用深色主题');

    const first = await local.putRawChunk('cl_test', chunk);
    expect(first.duplicate).toBe(false);
    expect(first.chunk.id).toBe(chunk.id);

    const second = await local.putRawChunk('cl_test', { ...chunk, id: newRawChunkId() });
    expect(second.duplicate).toBe(true);
    expect(second.chunk.id).toBe(chunk.id);
    expect(await local.countRawChunks()).toBe(1);

    const conflicting: RawChunk = {
      ...chunk,
      id: newRawChunkId(),
      text: '不同文本但相同哈希键',
    };
    await expect(local.putRawChunk('cl_test', conflicting)).rejects.toMatchObject({
      code: 'content_hash_mismatch',
    });
    expect(await local.countRawChunks()).toBe(1);

    const otherCloud = await local.putRawChunk('cl_other', chunk);
    expect(otherCloud.duplicate).toBe(false);
    expect(await local.countRawChunks()).toBe(2);
  });

  it('文件与目录权限：runtime/ 0700、JSONL 0600', async () => {
    // Windows has no POSIX mode bits; ACLs are enforced by the OS profile.
    if (process.platform === 'win32') return;
    const local = store();
    await local.putRawChunk('cl_test', raw('权限测试'));
    await local.putTrace(trace());

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'raw'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'raw', 'chunks.jsonl'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'traces.jsonl'))).mode & 0o777).toBe(0o600);
  });

  it('过期清理：启动/显式 cleanup 删除 Raw，清理后同内容可重新写入', async () => {
    const local = store();
    const chunk = raw('短期内容', { expiresAt: now + 1000 });
    await local.putRawChunk('cl_test', chunk);
    expect(await local.countRawChunks()).toBe(1);

    now += 2000;
    const cleaned = await local.cleanup();
    expect(cleaned.rawChunks).toBe(0);
    expect(await local.countRawChunks()).toBe(0);
    expect(await local.getRawChunk(chunk.id)).toBeNull();

    const rewritten = await local.putRawChunk('cl_test', { ...chunk, expiresAt: now + 1000 });
    expect(rewritten.duplicate).toBe(false);
    expect(await local.countRawChunks()).toBe(1);

    const onDisk = await readFile(join(dir, 'raw', 'chunks.jsonl'), 'utf8');
    expect(onDisk.trim().split('\n')).toHaveLength(1);
  });

  it('崩溃恢复：损坏/半行 JSONL 被丢弃并原子重写，不粘连下一条', async () => {
    const local = store();
    const first = raw('第一条');
    await local.putRawChunk('cl_test', first);
    await appendFile(join(dir, 'raw', 'chunks.jsonl'), '{"cloudId":"cl_test","chunk":');

    const recovered = store();
    await recovered.init();
    expect(await recovered.countRawChunks()).toBe(1);
    expect((await recovered.listRawChunks())[0]!.id).toBe(first.id);

    const second = raw('第二条');
    await recovered.putRawChunk('cl_test', second);
    expect(await recovered.countRawChunks()).toBe(2);
    const text = await readFile(join(dir, 'raw', 'chunks.jsonl'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    for (const line of text.trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('缺少结尾换行的有效 JSONL 会先重写，再安全追加', async () => {
    const local = store();
    const first = raw('无换行');
    await local.putRawChunk('cl_test', first);
    const path = join(dir, 'raw', 'chunks.jsonl');
    const current = await readFile(path, 'utf8');
    await appendFile(path, JSON.stringify({ cloudId: 'cl_test', chunk: raw('手工记录') }).trim());
    expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(false);
    expect(current.length).toBeGreaterThan(0);

    const recovered = store();
    await recovered.init();
    expect(await recovered.countRawChunks()).toBe(2);
    await recovered.putRawChunk('cl_test', raw('后续'));
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => Boolean(JSON.parse(line)))).toBe(true);
  });

  it('Trace：环形保留 + feedback 原子更新持久化', async () => {
    const local = store({ traceMaxEntries: 2, traceRetentionDays: 7 });
    const first = trace(newRecallTraceId(), now - 3000);
    const second = trace(newRecallTraceId(), now - 2000);
    const third = trace(newRecallTraceId(), now - 1000);
    await local.putTrace(first);
    await local.putTrace(second);
    await local.putTrace(third);

    const kept = await local.listTraces();
    expect(kept.map((entry) => entry.id)).toEqual([third.id, second.id]);
    expect(await local.getTrace(first.id)).toBeNull();

    const updated = await local.updateTraceFeedback(third.id, { useful: true, at: now });
    expect(updated?.feedback?.useful).toBe(true);

    const reopened = store({ traceMaxEntries: 2, traceRetentionDays: 7 });
    await reopened.init();
    expect((await reopened.getTrace(third.id))?.feedback?.useful).toBe(true);
  });

  it('Trace 过期清理与 preview 截断', async () => {
    const local = store({ traceRetentionDays: 1 });
    const old = trace(newRecallTraceId(), now - 2 * 86_400_000);
    const fresh = trace(newRecallTraceId(), now);
    fresh.queryPreview = 'x'.repeat(500);
    await local.putTrace(old);
    await local.putTrace(fresh);
    expect(await local.listTraces()).toHaveLength(1);
    expect((await local.listTraces())[0]!.queryPreview).toHaveLength(200);

    now += 2 * 86_400_000;
    const cleaned = await local.cleanup();
    expect(cleaned.traces).toBe(0);
    expect(await local.listTraces()).toHaveLength(0);
  });

  it('错误码：空 id / 非法 expiresAt / 重复 trace id', async () => {
    const local = store();
    await expect(local.putRawChunk('cl_test', raw('x', { id: '' }))).rejects.toBeInstanceOf(RuntimeLocalStoreError);
    await expect(local.putRawChunk('cl_test', raw('x', { expiresAt: Number.NaN }))).rejects.toMatchObject({
      code: 'invalid_raw_chunk',
    });
    const t = trace();
    await local.putTrace(t);
    await expect(local.putTrace(t)).rejects.toMatchObject({ code: 'invalid_trace' });
  });
});
