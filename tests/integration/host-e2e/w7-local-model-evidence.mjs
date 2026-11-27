#!/usr/bin/env node
// 0.4.0 W7：真实 sidecar + 真实 Qwen3-4B + 真实 llama.cpp 的 local 预取证据。
//
// 只走真实 sidecar HTTP 与真实 capability；不启动宿主、不使用 fake 模型。
// 每个样本：第一轮种缓存（prefetched=false），随后同 cue 轮询直到消费预取
// plan（prefetched=true / resolvedSource=local），记录“从首轮到 plan 可用”的
// 时间上界（轮询间隔 1s）；最后发一条新 cue，断言 prefetched=false 的预期负向。
//
// 模型/引擎路径由环境变量覆盖；不存在时失败，不回退到其他来源。
//
// 用法：
//   node tests/integration/host-e2e/w7-local-model-evidence.mjs [--json out.json] [--keep]

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRealRuntime } from './lib/real-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const ENGINE_DIR = process.env.MEBULAR_W7_ENGINE_DIR
  || '/Users/sobertli/.mebular/memory-runtime/inference/engine/llama-b12017';
const MODEL_PATH = process.env.MEBULAR_W7_MODEL_PATH
  || '/Users/sobertli/.mebular/memory-runtime/models/qwen3-4b-instruct-q4_k_m/Qwen3-4B-Q4_K_M.gguf';
const SAMPLES = Number(process.env.MEBULAR_W7_SAMPLES ?? 5);
const jsonArg = process.argv.find((arg) => arg.startsWith('--json='));
const jsonOut = jsonArg ? jsonArg.slice('--json='.length) : null;
const keep = process.argv.includes('--keep');

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function stageEngine(runtimeRoot) {
  const engineHome = join(runtimeRoot, 'mebular-home', 'memory-runtime', 'inference', 'engine');
  await mkdir(join(engineHome, 'current'), { recursive: true });
  await cp(ENGINE_DIR, join(engineHome, 'current', 'llama-b12017'), { recursive: true });
  const now = Date.now();
  await writeFile(join(engineHome, 'state.json'), JSON.stringify({
    schema: 1,
    release: 'b12017',
    platform: 'darwin',
    arch: 'x64',
    asset: 'llama-b12017-bin-macos-x64.tar.gz',
    sha256: 'f51371545526a8655f30bdf2e2f157d00d7ed9bddf1939106b09ac76148e59e5',
    archiveType: 'tar.gz',
    binaryPath: 'llama-b12017/llama-server',
    binaryReady: true,
    installedAt: now,
    verifiedAt: now,
  }), { mode: 0o600 });
}

function metaOf(response) {
  return response?.data?.interventionMeta ?? response?.data?.decision?.planner ?? null;
}

async function main() {
  const modelSha = await sha256File(MODEL_PATH);
  const root = await mkdtemp(join(tmpdir(), 'mebular-w7-local-model-'));
  await stageEngine(root);
  const runtime = await startRealRuntime({
    root,
    memoryRuntime: { enabled: true },
    sidecarConfig: {
      schema: 1,
      trace: 'local',
      model: { source: 'local', local: { path: MODEL_PATH, threads: 8 } },
      intervention: { minConfidence: 0.3, maxSilentStreak: 99, explorationRate: 0, modelTimeoutMs: 2000 },
      context: { deadlineMs: 1500 },
      http: { host: '127.0.0.1', port: 0 },
    },
  });
  const result = {
    evidenceLevel: 'R-SM',
    host: 'none (real sidecar HTTP; adapter dedupe blocks host two-round)',
    model: { id: 'Qwen3-4B-Q4_K_M.gguf', sha256: modelSha, engine: 'llama.cpp b12017' },
    samples: [],
    freshCue: null,
    summary: null,
  };
  let failed = 0;
  try {
    await runtime.waitForSidecar({ timeoutMs: 60000 });
    for (let i = 0; i < SAMPLES; i += 1) {
      const threadId = `th_w7_local_${i}`;
      const token = `W7LOCAL${i}`;
      const seeded = await runtime.seedMemory({
        text: `以后 deepwork 主题统一用深色主题，标记 ${token}`,
        namespace: 'default',
        agentId: 'opencode',
        threadId,
      });
      if (seeded.accepted.records !== 1) {
        failed += 1;
        result.samples.push({ sample: i, error: 'seed_failed' });
        continue;
      }
      const body = (turnId) => ({
        agentId: 'opencode', threadId, turnId, query: 'deepwork',
        maxFragments: 3, allowRemote: false, hostApp: 'opencode',
      });
      const seedStarted = Date.now();
      const first = await runtime.sidecarContext(body(`turn_seed_${i}`));
      const firstLatencyMs = Date.now() - seedStarted;
      const firstMeta = metaOf(first);
      let hit = null;
      let hitLatencyMs = null;
      const waitStarted = Date.now();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
        const started = Date.now();
        const response = await runtime.sidecarContext(body(`turn_hit_${i}_${attempt}`));
        const meta = metaOf(response);
        if (meta?.prefetched === true && meta?.resolvedSource === 'local') {
          hit = { response, meta };
          hitLatencyMs = Date.now() - started;
          break;
        }
      }
      const prefetchReadyMs = hit ? Date.now() - waitStarted : null;
      const ok = Boolean(hit)
        && firstMeta?.prefetched === false
        && firstLatencyMs <= 1500
        && (hitLatencyMs ?? 99999) <= 1500;
      if (!ok) failed += 1;
      result.samples.push({
        sample: i,
        threadId,
        seed: seeded.accepted,
        first: { latencyMs: firstLatencyMs, meta: firstMeta },
        hit: hit ? {
          latencyMs: hitLatencyMs,
          meta: hit.meta,
          decision: hit.response.data?.decision ?? null,
          traceId: hit.response.data?.traceId ?? null,
        } : null,
        prefetchReadyMs,
        ok,
      });
      console.log(`sample ${i + 1}/${SAMPLES}: first=${firstLatencyMs}ms prefetchReady=${prefetchReadyMs ?? '-'}ms hit=${hitLatencyMs ?? '-'}ms ok=${ok}`);
    }

    const freshThread = 'th_w7_local_fresh';
    await runtime.seedMemory({
      text: '以后 deepwork 主题统一用深色主题，标记 W7LOCALFRESH',
      namespace: 'default', agentId: 'opencode', threadId: freshThread,
    });
    const fresh = await runtime.sidecarContext({
      agentId: 'opencode', threadId: freshThread, turnId: 'turn_fresh',
      query: '下周旅行预算怎么安排', maxFragments: 3, allowRemote: false, hostApp: 'opencode',
    });
    const freshMeta = metaOf(fresh);
    const freshOk = freshMeta?.prefetched === false;
    if (!freshOk) failed += 1;
    result.freshCue = { ok: freshOk, meta: freshMeta };

    const readyValues = result.samples.map((sample) => sample.prefetchReadyMs).filter((value) => typeof value === 'number');
    result.summary = {
      samples: result.samples.length,
      passed: result.samples.filter((sample) => sample.ok).length,
      failed,
      prefetchReadyP50Ms: percentile(readyValues, 50),
      prefetchReadyP95Ms: percentile(readyValues, 95),
      firstContextP95Ms: percentile(result.samples.map((sample) => sample.first?.latencyMs).filter((value) => typeof value === 'number'), 95),
      hitContextP95Ms: percentile(result.samples.map((sample) => sample.hit?.latencyMs).filter((value) => typeof value === 'number'), 95),
    };
    console.log(JSON.stringify(result.summary));
  } finally {
    await runtime.close().catch(() => undefined);
    if (keep) {
      result.runRoot = root;
      console.log(`KEEP run root: ${root}`);
    } else {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (jsonOut) {
    await writeFile(jsonOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`JSON written: ${jsonOut}`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
