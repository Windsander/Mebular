// 0.3.0 性能/资源验收：100 次 ingest、50 次 recall、预算硬顶、
// outbox/trace/cache 有界与清理。全部使用 fake capability，不访问网络。
//
// 阈值按本机 fake 能力设定，刻意留出 CI 抖动余量；测试不依赖 sleep。

import { describe, it, expect, afterEach } from '@jest/globals';
import { performance } from 'node:perf_hooks';
import {
  ACCEPTANCE_THREAD,
  NOW,
  DAY_MS,
  acceptanceRecord,
  createAcceptanceHarness,
  type AcceptanceHarness,
} from './acceptance-fixtures.js';

const AGENT = 'opencode';
const harnesses: AcceptanceHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function portRecord() {
  return acceptanceRecord({
    id: '01JACCPERFPORT',
    type: 'fact',
    kind: 'fact',
    domain: 'agent:opencode',
    content: { subject: 'mebular', predicate: 'localPort', object: '7331', confidence: 0.9 },
    text: 'mebular 本地端口 localPort=7331',
    tags: ['端口', 'mebular'],
  });
}

function preferenceRecord() {
  return acceptanceRecord({
    id: '01JACCPERFPREF',
    type: 'fact',
    kind: 'preference',
    domain: 'user',
    content: { entity: 'user', preferenceType: 'theme', value: 'dark', confidence: 0.92 },
    text: '用户偏好：主题=dark',
    tags: ['偏好', '主题'],
  });
}

function longEpisodeRecord() {
  const content = [
    '部署失败复盘：迁移脚本先删除索引再重建，回滚步骤没有等待副本同步完成。',
    '发布窗口被锁住，回滚命令没有在副本健康检查通过后执行。',
    '最终决定把发布拆成预检、迁移、验证、回滚四步，并保留完整命令。',
  ].join('').repeat(60);
  return acceptanceRecord({
    id: '01JACCPERFLONG',
    type: 'episode',
    kind: 'episode',
    domain: 'agent:opencode',
    content: { episodeType: 'error', title: '部署失败复盘', content, startTime: NOW - DAY_MS },
    text: content,
    tags: ['部署', '为什么', '复盘'],
  });
}

describe('0.3.0 acceptance: performance and resource budgets', () => {
  it('100 次 ingest 总耗时/单次上限；50 次 recall 的 p50/p95 上限', async () => {
    const harness = await createAcceptanceHarness({ filterQuery: true });
    harnesses.push(harness);

    // 预热一次，避免把首次目录创建算进 100 次稳定态；不是 sleep。
    await harness.ingest.ingest({
      requestId: 'req_perf_warmup',
      agentId: AGENT,
      threadId: 'th_perf',
      chunks: [{ role: 'user', text: '我喜欢预热主题', messageId: 'm_perf_warmup', chunkIndex: 0 }],
    });

    const ingestTimes: number[] = [];
    const ingestStarted = performance.now();
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      const result = await harness.ingest.ingest({
        requestId: `req_perf_${index}`,
        agentId: AGENT,
        threadId: 'th_perf',
          chunks: [{
          role: 'user',
          text: `我喜欢性能测试主题 ${index}`,
          messageId: `m_perf_${index}`,
          chunkIndex: 0,
        }],
      });
      ingestTimes.push(performance.now() - started);
      expect(result.data.records.length).toBeGreaterThan(0);
      expect(result.data.degraded).toBe(false);
    }
    const ingestTotal = performance.now() - ingestStarted;
    const ingestP50 = percentile(ingestTimes, 0.5);
    const ingestP95 = percentile(ingestTimes, 0.95);
    const ingestMax = Math.max(...ingestTimes);
    console.log(`[perf] ingest n=100 total=${ingestTotal.toFixed(1)}ms p50=${ingestP50.toFixed(2)}ms p95=${ingestP95.toFixed(2)}ms max=${ingestMax.toFixed(2)}ms`);

    expect(ingestTotal).toBeLessThan(30_000);
    expect(ingestP95).toBeLessThan(1_000);
    expect(ingestMax).toBeLessThan(3_000);
    expect(harness.fake.nodes).toHaveLength(101);

    // 50 次 recall/context，混合宽泛与精确意图。
    harness.fake.setRecords([portRecord(), preferenceRecord()]);
    const recallTimes: number[] = [];
    for (let index = 0; index < 50; index += 1) {
      const exact = index % 2 === 0;
      const started = performance.now();
      const result = await harness.recall.handleContext({
        agentId: AGENT,
        threadId: ACCEPTANCE_THREAD,
        turnId: `turn_perf_${index}`,
        turnKind: 'human',
        query: exact ? '本地端口是多少？' : '你记得我的喜好吗？',
        maxFragments: 2,
      });
      recallTimes.push(performance.now() - started);
      expect(result.data.blocks.length).toBeGreaterThan(0);
      expect(result.data.degraded).toBe(false);
    }
    const recallP50 = percentile(recallTimes, 0.5);
    const recallP95 = percentile(recallTimes, 0.95);
    const recallMax = Math.max(...recallTimes);
    console.log(`[perf] recall n=50 p50=${recallP50.toFixed(2)}ms p95=${recallP95.toFixed(2)}ms max=${recallMax.toFixed(2)}ms`);

    expect(recallP50).toBeLessThan(250);
    expect(recallP95).toBeLessThan(500);
    expect(recallMax).toBeLessThan(1_000);
  }, 60_000);

  it('fragment/字节/token/outbox/trace/cache 预算与环形保留', async () => {
    const harness = await createAcceptanceHarness({
      records: [longEpisodeRecord()],
      filterQuery: true,
      traceMaxEntries: 12,
      maxOutboxItems: 3,
      maxOutboxBytes: 4_096,
      maxCacheEntries: 5,
      maxCacheBytes: 64_000,
    });
    harnesses.push(harness);

    // 请求值超过硬顶：服务端必须夹紧到 3 / 8192 / 2000。
    const clamped = await harness.recall.handleContext({
      agentId: AGENT,
      threadId: ACCEPTANCE_THREAD,
      turnId: 'turn_budget_clamped',
      turnKind: 'human',
      query: '上次部署为什么失败？',
      maxFragments: 99,
      maxBytes: 60_000,
      tokenBudget: 99_999,
    });
    expect(clamped.data.fragments.length).toBeGreaterThanOrEqual(1);
    expect(clamped.data.fragments.length).toBeLessThanOrEqual(3);
    expect(clamped.data.estimatedBytes).toBeLessThanOrEqual(8_192);
    expect(clamped.data.estimatedTokens).toBeLessThanOrEqual(2_000);
    expect(clamped.data.blocks.reduce((sum, block) => sum + block.bytes, 0)).toBeLessThanOrEqual(8_192);

    const small = await harness.recall.handleContext({
      agentId: AGENT,
      threadId: ACCEPTANCE_THREAD,
      turnId: 'turn_budget_small',
      turnKind: 'human',
      query: '上次部署为什么失败？',
      maxFragments: 1,
      maxBytes: 512,
      tokenBudget: 300,
    });
    expect(small.data.fragments.length).toBeLessThanOrEqual(1);
    expect(small.data.estimatedBytes).toBeLessThanOrEqual(512);
    expect(small.data.estimatedTokens).toBeLessThanOrEqual(300);
    expect(small.data.truncated).toBe(true);
    expect(small.data.blocks[0]?.citations.length).toBeGreaterThan(0);
    expect(small.data.blocks[0]?.owner.domain).toBe('agent:opencode');

    // outbox 条数上限。
    let outboxFull = 0;
    for (let index = 0; index < 10; index += 1) {
      try {
        await harness.local.outbox.enqueue({
          id: `ob_perf_${index}`,
          requestId: `req_ob_perf_${index}`,
          endpoint: '/write',
          body: { index, text: `outbox item ${index}` },
          createdAt: NOW + index,
        });
      } catch (error) {
        expect((error as { code?: string }).code).toBe('outbox_full');
        outboxFull += 1;
      }
    }
    expect(outboxFull).toBeGreaterThan(0);
    const outboxStats = await harness.local.outbox.stats();
    expect(outboxStats.items).toBeLessThanOrEqual(3);
    expect(outboxStats.bytes).toBeLessThanOrEqual(4_096);

    // cache 条数上限。
    for (let index = 0; index < 20; index += 1) {
      await harness.local.cache.set(`perf-cache-${index}`, { index }, { ttlMs: 60_000 });
    }
    const cacheStats = await harness.local.cache.stats();
    expect(cacheStats.entries).toBeLessThanOrEqual(5);
    expect(cacheStats.bytes).toBeLessThanOrEqual(64_000);

    // trace 环形保留：100 次召回后仍不超过 12 条。
    harness.fake.setRecords([preferenceRecord()]);
    for (let index = 0; index < 100; index += 1) {
      const result = await harness.recall.handleContext({
        agentId: AGENT,
        threadId: ACCEPTANCE_THREAD,
        turnId: `turn_trace_ring_${index}`,
        turnKind: 'human',
        query: '你记得我的喜好吗？',
        maxFragments: 1,
      });
      expect(result.data.degraded).toBe(false);
    }
    const traces = await harness.local.store.listTraces({ limit: 200 });
    const statsAfter = await harness.local.stats();
    const outboxAfter = await harness.local.outbox.stats();
    console.log(`[perf] budgets traces=${statsAfter.traces} outbox=${outboxAfter.items}/${outboxAfter.bytes}B cache=${cacheStats.entries}`);
    expect(traces.length).toBeLessThanOrEqual(12);
    expect(statsAfter.traces).toBeLessThanOrEqual(12);
    expect(statsAfter.stagingChunks).toBe(0);
    expect(outboxAfter.items).toBeLessThanOrEqual(3);
    expect(outboxAfter.bytes).toBeLessThanOrEqual(4_096);
    expect(cacheStats.entries).toBeLessThanOrEqual(5);
  }, 60_000);

  it('outbox 字节上限独立生效', async () => {
    const harness = await createAcceptanceHarness({
      maxOutboxItems: 1_000,
      maxOutboxBytes: 700,
    });
    harnesses.push(harness);
    let full = 0;
    for (let index = 0; index < 20; index += 1) {
      try {
        await harness.local.outbox.enqueue({
          id: `ob_bytes_${index}`,
          requestId: `req_ob_bytes_${index}`,
          endpoint: '/write',
          body: { index, payload: 'x'.repeat(120) },
          createdAt: NOW + index,
        });
      } catch (error) {
        expect((error as { code?: string }).code).toBe('outbox_full');
        full += 1;
      }
    }
    const stats = await harness.local.outbox.stats();
    console.log(`[perf] outbox bytes cap items=${stats.items} bytes=${stats.bytes}`);
    expect(full).toBeGreaterThan(0);
    expect(stats.items).toBeLessThanOrEqual(1_000);
    expect(stats.bytes).toBeLessThanOrEqual(700);
  }, 60_000);
});
