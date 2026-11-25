// 0.4.0 Phase 0/2 性能证据：/context 在 off 与 heuristic 下的 p50/p95。
//
// 使用与 acceptance-performance 相同的本地 fake capability（真实 HTTP 往返），
// 但直接调用 RecallService.handleContext，测量介入决策 + write-behind 策略统计
// 的额外开销。跑 3 轮取 p95 overhead 中位数：目标 <5ms，CI 噪声下断言 <10ms；
// 保留绝对 p95 上限兜底。

import { describe, it, expect } from '@jest/globals';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityClient } from '../../src/sidecar/capability-client.js';
import { defaultSidecarConfig } from '../../src/sidecar/config.js';
import { defaultSidecarPolicy } from '../../src/sidecar/domains.js';
import { SidecarLocalLayer } from '../../src/sidecar/local-layer.js';
import { SettlementRuntime } from '../../src/sidecar/settlement.js';
import { startFakeCapability, type FakeCapabilityServer, type FakeMemoryRecord } from './fake-capability.js';

const NOW = 1_760_000_000_000;
const WARMUP = 5;
const SAMPLES = 40;

interface PerfHarness {
  home: string;
  fake: FakeCapabilityServer;
  runtime: SettlementRuntime;
}

function preference(): FakeMemoryRecord {
  return {
    id: '01JPERFPREF1',
    type: 'fact',
    kind: 'preference',
    domain: 'user',
    namespace: 'user',
    ownerType: 'user',
    ownerId: 'u_perf',
    content: { entity: 'user', preferenceType: 'theme', value: 'dark', confidence: 0.92 },
    text: '用户偏好：theme=dark',
    tags: ['preference'],
    provenance: {
      source: 'runtime',
      extractor: 'host',
      deviceId: 'device-local',
      hostId: 'h_perf',
      threadId: 'th_perf_intervention',
      agentId: 'opencode',
      confirmation: 'explicit',
      at: NOW - 86_400_000,
    },
    validFrom: NOW - 86_400_000,
    validTo: null,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    detailAvailable: true,
    legacy: false,
    score: 0.9,
  };
}

async function createHarness(mode: 'off' | 'heuristic'): Promise<PerfHarness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-intervention-perf-'));
  const local = new SidecarLocalLayer({ root: join(home, 'memory-runtime'), now: () => NOW });
  await local.init();
  const fake = await startFakeCapability({ now: () => NOW });
  fake.setRecords([preference()]);
  const client = new CapabilityClient({ baseUrl: fake.baseUrl, token: 'cap-token', retries: 0, retryDelayMs: 0 });
  const config = defaultSidecarConfig();
  config.intervention.mode = mode;
  config.intervention.explorationRate = 0;
  const runtime = new SettlementRuntime({
    config,
    local,
    client,
    identity: { cloudId: 'cl_perf', profileId: 'default', hostId: 'h_perf' },
    policy: defaultSidecarPolicy(),
    policyStatePath: join(home, 'memory-runtime', 'policy', 'state.json'),
    autoStartReplayer: false,
    now: () => NOW,
  });
  await runtime.init();
  return { home, fake, runtime };
}

async function context(harness: PerfHarness, index: number, prefix: string): Promise<void> {
  const result = await harness.runtime.recall.handleContext({
    agentId: 'opencode',
    threadId: 'th_perf_intervention',
    turnId: `turn_${prefix}_${index}`,
    turnKind: 'human',
    query: '你记得我的喜好吗？',
    maxFragments: 2,
  });
  if (result.data.blocks.length === 0) throw new Error('unexpected silence in performance fixture');
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index]!;
}

describe('intervention /context performance', () => {
  it('off 与 heuristic 的 /context p95；heuristic 额外开销有界', async () => {
    const off = await createHarness('off');
    const heuristic = await createHarness('heuristic');
    try {
      for (let index = 0; index < WARMUP; index += 1) {
        await context(off, index, 'warm_off');
        await context(heuristic, index, 'warm_heuristic');
      }

      const ROUNDS = 3;
      const rounds: Array<{ offP50: number; offP95: number; heuristicP50: number; heuristicP95: number; overhead: number }> = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        const offTimes: number[] = [];
        const heuristicTimes: number[] = [];
        for (let index = 0; index < SAMPLES; index += 1) {
          let started = performance.now();
          await context(off, index, `off_r${round}`);
          offTimes.push(performance.now() - started);

          started = performance.now();
          await context(heuristic, index, `heuristic_r${round}`);
          heuristicTimes.push(performance.now() - started);
        }
        const offP50 = percentile(offTimes, 0.5);
        const offP95 = percentile(offTimes, 0.95);
        const heuristicP50 = percentile(heuristicTimes, 0.5);
        const heuristicP95 = percentile(heuristicTimes, 0.95);
        rounds.push({
          offP50,
          offP95,
          heuristicP50,
          heuristicP95,
          overhead: heuristicP95 - offP95,
        });
        console.log(
          `[perf][intervention] round=${round + 1} `
          + `off p50=${offP50.toFixed(2)}ms p95=${offP95.toFixed(2)}ms; `
          + `heuristic p50=${heuristicP50.toFixed(2)}ms p95=${heuristicP95.toFixed(2)}ms; `
          + `p95 overhead=${(heuristicP95 - offP95).toFixed(2)}ms`,
        );
      }

      // 取 3 轮 p95 overhead 的中位数，避免单轮抖动。
      const overheadMedian = [...rounds.map((round) => round.overhead)].sort((a, b) => a - b)[1]!;
      console.log(
        `[perf][intervention] p95 overhead median=${overheadMedian.toFixed(2)}ms `
        + `(rounds=${rounds.map((round) => round.overhead.toFixed(2)).join(',')})`,
      );

      // 绝对上限兜底；相对开销目标仍是计划里的 <5ms，CI 噪声下放宽到 10ms。
      for (const round of rounds) {
        expect(round.offP95).toBeLessThan(500);
        expect(round.heuristicP95).toBeLessThan(500);
      }
      expect(overheadMedian).toBeLessThan(10);
    } finally {
      await off.runtime.stop();
      await heuristic.runtime.stop();
      await off.fake.close();
      await heuristic.fake.close();
      await rm(off.home, { recursive: true, force: true });
      await rm(heuristic.home, { recursive: true, force: true });
    }
  }, 120_000);
});
