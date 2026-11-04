#!/usr/bin/env node
// v0.3.2 WP6A 真实规模基准：真实 MCP capability + 真实 GraphStore/MemoryService + 真实 sidecar。
//
// 设计边界：
// - 只使用临时 home（mkdtemp），不读取也不写入用户真实 home。
// - 每个 seed 批次通过真实 sidecar `/ingest` 进入 WP1 路径：staging -> capability
//   `/write` -> capability `/detail` -> 权威回读 -> detail cache -> staging 清理。
// - capability 对端不是 fake：使用 packages/mcp/src/serve.mjs 启动真实图/事件日志；
//   sidecar 是 supervisor 拉起的真实 `mebular-memory-runtime` 进程。
// - 不启动真实宿主进程、真实模型或 P2P 同步；这些边界会写进 JSON 与报告。
//
// 用法：
//   npm run build
//   node tests/integration/scale-bench/run.mjs \
//     --records 1000 --details 1000 --batch-size 50 --queries 100 \
//     --label 1k-smoke --output docs/quality/0.3.2-scale-benchmark.json
//
// 10k full：
//   node tests/integration/scale-bench/run.mjs \
//     --records 10000 --details 10000 --batch-size 100 --queries 200 \
//     --label 10k-full --output docs/quality/0.3.2-scale-benchmark-10k.json

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createCluster } from '../../acceptance/lib/cluster.mjs';

const SCHEMA = 'mebular.scale-benchmark/1';
const AGENT_ID = 'scale-bench';
const AGENT_NAME = 'Scale Benchmark';
const DOMAIN = `agent:${AGENT_ID}`;
const RECORD_KIND = 'observation';

const DEFAULTS = {
  records: 10_000,
  details: 10_000,
  batchSize: 100,
  queries: 200,
  limit: 20,
  label: '10k-full',
  output: 'docs/quality/0.3.2-scale-benchmark.json',
  keep: false,
};

function usage() {
  return [
    '用法: node tests/integration/scale-bench/run.mjs [options]',
    '',
    '  --records <n>       MemoryRecord 数量，默认 10000',
    '  --details <n>       Detail 数量，默认 10000；必须与 --records 相等',
    '  --batch-size <n>    每个 sidecar ingest 批次的记录/详情数，1-100，默认 100',
    '  --queries <n>       查询/召回/上下文采样数，默认 200',
    '  --limit <n>         capability/sidecar 查询返回上限，10-50，默认 20',
    '  --label <text>      结果标签，例如 1k-smoke / 10k-full',
    '  --output <path>     机器可读 JSON 输出路径',
    '  --keep             保留临时 home（排障用；默认删除）',
    '  --help             显示本帮助',
  ].join('\n');
}

function parseInteger(name, raw) {
  if (!/^\d+$/.test(String(raw))) throw new Error(`${name} 必须是正整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === '--keep') {
      options.keep = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
    const name = arg.slice(2);
    const raw = argv[index + 1];
    if (raw === undefined || raw.startsWith('--')) throw new Error(`${arg} 缺少值`);
    index += 1;
    if (name === 'records') options.records = parseInteger('--records', raw);
    else if (name === 'details') options.details = parseInteger('--details', raw);
    else if (name === 'batch-size') options.batchSize = parseInteger('--batch-size', raw);
    else if (name === 'queries') options.queries = parseInteger('--queries', raw);
    else if (name === 'limit') options.limit = parseInteger('--limit', raw);
    else if (name === 'label') options.label = String(raw).trim();
    else if (name === 'output') options.output = String(raw).trim();
    else throw new Error(`未知参数: ${arg}`);
  }
  if (options.records !== options.details) {
    throw new Error('--records 与 --details 必须相等：本基准每个 ingest 项固定产生 1 条记录 + 1 条详情');
  }
  if (options.batchSize > 100) throw new Error('--batch-size 不能超过 100（sidecar/capability 批次上限）');
  if (options.limit < 10 || options.limit > 50) throw new Error('--limit 必须在 10-50 之间');
  if (options.label.length === 0) throw new Error('--label 不能为空');
  if (options.output.length === 0) throw new Error('--output 不能为空');
  return options;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function gitInfo() {
  try {
    const sha = run('git', ['rev-parse', 'HEAD']);
    const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = run('git', ['status', '--porcelain']);
    const dirtyFiles = status === '' ? [] : status.split('\n').filter(Boolean);
    return {
      sha,
      shortSha: sha.slice(0, 12),
      branch,
      dirty: dirtyFiles.length > 0,
      dirtyFileCount: dirtyFiles.length,
    };
  } catch {
    return { sha: null, shortSha: null, branch: null, dirty: null, dirtyFileCount: null };
  }
}

function environmentInfo() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    node: process.version,
    v8: process.versions.v8,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    ci: process.env.CI === 'true' || process.env.CI === '1',
  };
}

function nowIso() {
  return new Date().toISOString();
}

function elapsedMs(startedAt) {
  return Number((performance.now() - startedAt).toFixed(3));
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

function latencySummary(values) {
  if (values.length === 0) {
    return { samples: 0, minMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null, meanMs: null };
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    samples: values.length,
    minMs: Number(Math.min(...values).toFixed(3)),
    p50Ms: Number(percentile(values, 50).toFixed(3)),
    p95Ms: Number(percentile(values, 95).toFixed(3)),
    p99Ms: Number(percentile(values, 99).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3)),
    meanMs: Number((sum / values.length).toFixed(3)),
  };
}

function hitRate(hits, samples) {
  return samples === 0 ? null : Number((hits / samples).toFixed(4));
}

function markerFor(runToken, index) {
  // 4 位数字片段让 recall 的 cue 进入 exact/expand 意图，从而真实展开 Detail。
  const numeric = 1000 + (index % 9000);
  return `SCALEBENCH-${runToken}-${String(index).padStart(6, '0')}-${numeric}`;
}

function textFor(marker, index) {
  return [
    marker,
    `Synthetic scale benchmark record ${index}.`,
    'This text is generated for reproducible local measurement only;',
    'it contains no user data, credentials, host tokens, or secrets.',
    'alpha beta gamma delta epsilon zeta eta theta.',
  ].join(' ');
}

function shapeFor(index) {
  const bucket = index % 100;
  if (bucket < 80) return { role: 'user', detailKind: 'raw_chunk', bucket: 'conversation-user' };
  if (bucket < 90) return { role: 'assistant', detailKind: 'raw_chunk', bucket: 'conversation-assistant' };
  if (bucket < 96) return { role: 'tool', detailKind: 'tool_output', bucket: 'tool_output' };
  return { role: 'user', detailKind: 'document_slice', bucket: 'document_slice' };
}

function markerVisible(payload, marker) {
  return JSON.stringify(payload ?? '').includes(marker);
}

async function pathBytes(path) {
  try {
    const info = await stat(path);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;
    const entries = await readdir(path, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      total += await pathBytes(join(path, entry.name));
    }
    return total;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function diskSnapshot(home) {
  const paths = {
    'device.jsonl': 'device.jsonl',
    'memory-runtime': 'memory-runtime',
    'memory-runtime/staging': 'memory-runtime/staging',
    'memory-runtime/traces.jsonl': 'memory-runtime/traces.jsonl',
    'memory-runtime/cache': 'memory-runtime/cache',
    'memory-runtime/cache/details': 'memory-runtime/cache/details',
    'memory-runtime/outbox': 'memory-runtime/outbox',
    'memory-runtime/outbox/dead': 'memory-runtime/outbox/dead',
    'memory-runtime/capability-idempotency.json': 'memory-runtime/capability-idempotency.json',
  };
  const byPath = {};
  for (const [label, relative] of Object.entries(paths)) {
    byPath[label] = await pathBytes(join(home, relative));
  }
  const logicalBytes = await pathBytes(home);
  let allocatedBytes = null;
  try {
    const output = run('du', ['-sk', home]);
    const kb = Number(output.split(/\s+/)[0]);
    if (Number.isFinite(kb)) allocatedBytes = kb * 1024;
  } catch {
    allocatedBytes = null;
  }
  return { logicalBytes, allocatedBytes, byPath };
}

function sidecarRssBytes(pid) {
  if (!pid) return null;
  try {
    const output = run('ps', ['-o', 'rss=', '-p', String(pid)]);
    const kb = Number(output);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

function hostMemory() {
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapTotalBytes: usage.heapTotal,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
}

function compactSidecarStatus(status) {
  return {
    state: status?.state ?? null,
    degraded: status?.degraded === true,
    counts: status?.counts ?? null,
    details: status?.details ?? null,
    outbox: status?.outbox ?? null,
    limits: status?.limits ?? null,
    warnings: Array.isArray(status?.warnings) ? status.warnings : [],
  };
}

function compactCapabilityStatus(data) {
  return {
    counts: data?.counts ?? null,
    detailQuota: data?.detailQuota ?? null,
    detailRetentionDays: data?.detailRetentionDays ?? null,
    limits: data?.limits ?? null,
  };
}

async function ledgerEntries(home) {
  try {
    const raw = JSON.parse(await readFile(
      join(home, 'memory-runtime', 'capability-idempotency.json'),
      'utf8',
    ));
    return Array.isArray(raw?.entries) ? raw.entries.length : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    return null;
  }
}

async function snapshot({ phase, home, sidecar, sidecarVersion, capability, sidecarPid }) {
  const [disk, status, capStatus, ledgerCount] = await Promise.all([
    diskSnapshot(home),
    sidecar.status(),
    capability.status(AGENT_ID),
    ledgerEntries(home),
  ]);
  return {
    phase,
    at: nowIso(),
    host: hostMemory(),
    sidecar: {
      pid: sidecarPid,
      rssBytes: sidecarRssBytes(sidecarPid),
      runtimeVersion: sidecarVersion ?? null,
    },
    disk,
    idempotencyLedgerEntries: ledgerCount,
    sidecarStatus: compactSidecarStatus(status),
    capabilityStatus: compactCapabilityStatus(capStatus),
  };
}

function parseDiscovery(discovery) {
  return {
    runtimeVersion: discovery?.runtimeVersion ?? null,
    apiVersion: discovery?.apiVersion ?? null,
    capabilityApiVersion: discovery?.capabilityApiVersion ?? null,
    state: discovery?.state ?? null,
    mode: discovery?.mode ?? null,
    capabilities: discovery?.capabilities ?? null,
  };
}

async function seedDataset({ device, options, runToken, onProgress }) {
  const { records, batchSize } = options;
  const latencies = [];
  const startedAt = performance.now();
  let writtenRecords = 0;
  let writtenDetails = 0;
  const kindCounts = {};
  const batches = [];

  for (let offset = 0; offset < records; offset += batchSize) {
    const count = Math.min(batchSize, records - offset);
    const chunks = [];
    const candidates = [];
    for (let local = 0; local < count; local += 1) {
      const index = offset + local;
      const marker = markerFor(runToken, index);
      const text = textFor(marker, index);
      const shape = shapeFor(index);
      const messageId = `msg_${runToken}_${String(index).padStart(6, '0')}`;
      kindCounts[shape.bucket] = (kindCounts[shape.bucket] ?? 0) + 1;
      chunks.push({
        role: shape.role,
        detailKind: shape.detailKind,
        text,
        messageId,
      });
      candidates.push({
        kind: RECORD_KIND,
        content: { content: text },
        sourceMessageIds: [messageId],
        tags: ['scale-bench', shape.bucket],
      });
    }

    const batchIndex = offset / batchSize;
    const requestId = `req_${runToken}_${String(batchIndex).padStart(4, '0')}`;
    const batchStartedAt = performance.now();
    const response = await device.sidecar.ingest({
      requestId,
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      extractor: 'host',
      chunks,
      candidates,
    });
    const latency = elapsedMs(batchStartedAt);
    latencies.push(latency);
    batches.push({ index: batchIndex, count, latencyMs: latency, status: response.status });

    if (response.status !== 200) {
      throw new Error(`seed 批次 ${batchIndex} 失败：HTTP ${response.status} ${JSON.stringify(response.body)}`);
    }
    const data = response.body?.data;
    if (!data || data.queued === true) {
      throw new Error(`seed 批次 ${batchIndex} 未 committed：${JSON.stringify(data)}`);
    }
    if (data.records?.length !== count) {
      throw new Error(`seed 批次 ${batchIndex} 记录数不符：期望 ${count}，实际 ${data.records?.length}`);
    }
    if (data.detail?.ids?.length !== count || data.detail?.failed !== 0 || data.detail?.queued !== 0) {
      throw new Error(`seed 批次 ${batchIndex} 详情数不符：${JSON.stringify(data.detail)}`);
    }
    writtenRecords += data.records.length;
    writtenDetails += data.detail.ids.length;
    onProgress?.({
      batches: Math.ceil(records / batchSize),
      completed: batchIndex + 1,
      records: writtenRecords,
      details: writtenDetails,
    });
  }

  const wallMs = elapsedMs(startedAt);
  const perRecordLatencies = batches.map((batch) => batch.latencyMs / batch.count);
  return {
    requestedRecords: records,
    requestedDetails: options.details,
    writtenRecords,
    writtenDetails,
    batches: batches.length,
    batchSize,
    kindCounts,
    wallMs: Number(wallMs.toFixed(3)),
    throughput: {
      recordsPerSec: Number((writtenRecords / (wallMs / 1000)).toFixed(2)),
      detailsPerSec: Number((writtenDetails / (wallMs / 1000)).toFixed(2)),
      batchesPerSec: Number((batches.length / (wallMs / 1000)).toFixed(2)),
    },
    latency: latencySummary(latencies),
    perRecordLatencyMs: latencySummary(perRecordLatencies),
    batchLatenciesMs: latencies.map((value) => Number(value.toFixed(3))),
    errors: 0,
  };
}

function sampleIndices(records, queries) {
  const count = Math.min(records, queries);
  const step = records / count;
  const indices = [];
  for (let index = 0; index < count; index += 1) {
    indices.push(Math.min(records - 1, Math.floor(step * index + step / 2)));
  }
  return [...new Set(indices)];
}

async function benchmarkReads({ device, options, runToken }) {
  const indices = sampleIndices(options.records, options.queries);
  const capabilityQueryMs = [];
  const recallMs = [];
  const contextMs = [];
  const detailExpandMs = [];
  const recallInternalExpandMs = [];
  const recallInternalTotalMs = [];
  const expandSources = new Map();
  let capabilityHits = 0;
  let recallHits = 0;
  let contextHits = 0;
  let expandHits = 0;
  let expandAttempts = 0;
  let degradedRecalls = 0;
  let degradedContexts = 0;
  const failures = [];

  for (const [position, index] of indices.entries()) {
    const marker = markerFor(runToken, index);

    const capabilityStartedAt = performance.now();
    const capabilityResponse = await device.capability.query({
      query: marker,
      agentId: AGENT_ID,
      domains: [DOMAIN],
      limit: options.limit,
    });
    capabilityQueryMs.push(elapsedMs(capabilityStartedAt));
    if (capabilityResponse.status !== 200 || capabilityResponse.body?.ok !== true) {
      failures.push({ phase: 'capability_query', index, status: capabilityResponse.status });
    } else if (markerVisible(capabilityResponse.body?.data?.records, marker)) {
      capabilityHits += 1;
    }

    const recallStartedAt = performance.now();
    const recallResponse = await device.sidecar.recall({
      agentId: AGENT_ID,
      query: marker,
      domains: [DOMAIN],
      limit: options.limit,
    });
    recallMs.push(elapsedMs(recallStartedAt));
    const recallData = recallResponse.body?.data;
    if (recallResponse.status !== 200 || recallResponse.body?.ok !== true) {
      failures.push({ phase: 'recall', index, status: recallResponse.status });
    } else {
      if (recallData?.degraded === true) degradedRecalls += 1;
      if (markerVisible(recallData?.fragments, marker) || markerVisible(recallData?.records, marker)) {
        recallHits += 1;
      }
      if (typeof recallData?.timing?.expandMs === 'number') {
        recallInternalExpandMs.push(recallData.timing.expandMs);
      }
      if (typeof recallData?.timing?.totalMs === 'number') {
        recallInternalTotalMs.push(recallData.timing.totalMs);
      }
    }

    const contextStartedAt = performance.now();
    const contextResponse = await device.sidecar.context({
      agentId: AGENT_ID,
      query: marker,
      domains: [DOMAIN],
      limit: options.limit,
    });
    contextMs.push(elapsedMs(contextStartedAt));
    const contextData = contextResponse.body?.data;
    if (contextResponse.status !== 200 || contextResponse.body?.ok !== true) {
      failures.push({ phase: 'context', index, status: contextResponse.status });
    } else {
      if (contextData?.degraded === true) degradedContexts += 1;
      if (markerVisible(contextData?.blocks, marker) || markerVisible(contextData?.fragments, marker)) {
        contextHits += 1;
      }
    }

    const fragment = Array.isArray(recallData?.fragments)
      ? recallData.fragments.find((entry) => Array.isArray(entry?.detailIds) && entry.detailIds.length > 0)
      : null;
    if (fragment && recallData?.recallId) {
      expandAttempts += 1;
      const expandStartedAt = performance.now();
      const expandResponse = await device.sidecar.expand(recallData.recallId, {
        agentId: AGENT_ID,
        fragmentId: fragment.id,
      });
      detailExpandMs.push(elapsedMs(expandStartedAt));
      const expandData = expandResponse.body?.data;
      if (expandResponse.status !== 200 || expandResponse.body?.ok !== true) {
        failures.push({ phase: 'detail_expand', index, status: expandResponse.status });
      } else {
        const source = expandData?.detail?.source ?? 'missing';
        const list = expandSources.get(source) ?? [];
        list.push(detailExpandMs[detailExpandMs.length - 1]);
        expandSources.set(source, list);
        if (markerVisible(expandData?.detail?.text, marker)) expandHits += 1;
      }
    }

    if (position > 0 && position % 25 === 0) {
      process.stderr.write(`[scale-bench] read samples ${position}/${indices.length}\n`);
    }
  }

  const bySource = {};
  for (const [source, values] of [...expandSources.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    bySource[source] = latencySummary(values);
  }

  return {
    samples: indices.length,
    queryLimit: options.limit,
    hitRate: {
      capabilityQuery: hitRate(capabilityHits, indices.length),
      sidecarRecall: hitRate(recallHits, indices.length),
      sidecarContext: hitRate(contextHits, indices.length),
      detailExpand: hitRate(expandHits, expandAttempts),
    },
    degraded: {
      recalls: degradedRecalls,
      contexts: degradedContexts,
    },
    failures,
    latency: {
      capabilityQuery: latencySummary(capabilityQueryMs),
      sidecarRecall: latencySummary(recallMs),
      sidecarContext: latencySummary(contextMs),
      detailExpand: latencySummary(detailExpandMs),
    },
    recallInternalTiming: {
      expandMs: latencySummary(recallInternalExpandMs),
      totalMs: latencySummary(recallInternalTotalMs),
    },
    detailExpandBySource: bySource,
  };
}

async function ensureSidecarStopped(pid, timeoutMs = 5_000) {
  if (!pid) return { stopped: true, forced: false };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return { stopped: true, forced: false };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  let forced = false;
  try {
    process.kill(pid, 'SIGTERM');
    forced = true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  } catch {
    // 进程已退出。
  }
  try {
    process.kill(pid, 0);
    return { stopped: false, forced };
  } catch {
    return { stopped: true, forced };
  }
}

async function runBenchmark(options) {
  const startedAt = nowIso();
  const runToken = randomUUID().replace(/-/g, '').slice(0, 8);
  const result = {
    schema: SCHEMA,
    label: options.label,
    runToken,
    startedAt,
    finishedAt: null,
    status: 'running',
    command: ['node', 'tests/integration/scale-bench/run.mjs', ...process.argv.slice(2)].join(' '),
    git: gitInfo(),
    environment: environmentInfo(),
    options: {
      records: options.records,
      details: options.details,
      batchSize: options.batchSize,
      queries: options.queries,
      limit: options.limit,
      keep: options.keep,
    },
    realBoundary: {
      realComponents: [
        'MCP capability HTTP server (packages/mcp/src/serve.mjs)',
        'GraphStore + MemoryService + event log (Mebular app)',
        'managed Memory Runtime sidecar process (mebular-memory-runtime)',
        'sidecar -> capability HTTP path (/write, /detail, /query, /recall)',
        'local filesystem in a temporary home',
      ],
      fakeOrStub: [],
      notExercised: [
        'real host process (DSH/Hermes/OpenCode/OpenChamber)',
        'real model or model pack',
        'P2P/remote sync peer',
        'Console UI',
      ],
    },
    seed: null,
    reads: null,
    snapshots: {},
    cleanup: null,
    error: null,
  };

  let cluster = null;
  let sidecarPid = null;
  try {
    cluster = await createCluster({ deviceCount: 1 });
    const device = cluster.a;
    const discovery = await device.sidecar.discovery();
    sidecarPid = discovery?.pid ?? null;
    const discoveryView = parseDiscovery(discovery);
    const capabilityVersion = await device.capability.version();
    result.components = {
      sidecar: discoveryView,
      capability: {
        mcpVersion: capabilityVersion?.mcpVersion ?? null,
        coreVersion: capabilityVersion?.coreVersion ?? null,
        capabilityApiVersion: capabilityVersion?.capabilityApiVersion ?? null,
        features: capabilityVersion?.features ?? null,
      },
    };
    result.snapshots.beforeSeed = await snapshot({
      phase: 'before-seed',
      home: device.home,
      sidecar: device.sidecar,
      sidecarVersion: discoveryView.runtimeVersion,
      capability: device.capability,
      sidecarPid,
    });

    result.seed = await seedDataset({
      device,
      options,
      runToken,
      onProgress: (progress) => {
        if (progress.completed === progress.batches || progress.completed % 10 === 0) {
          process.stderr.write(
            `[scale-bench] seed ${progress.completed}/${progress.batches} batches `
            + `(${progress.records} records, ${progress.details} details)\n`,
          );
        }
      },
    });

    const postSeedStatus = await device.capability.status(AGENT_ID);
    const counts = postSeedStatus?.counts ?? {};
    if (counts.memoryRecords !== options.records || counts.details !== options.details) {
      throw new Error(
        `量级校验失败：期望 ${options.records} records/${options.details} details，`
        + `实际 ${counts.memoryRecords} records/${counts.details} details`,
      );
    }
    result.snapshots.afterSeed = await snapshot({
      phase: 'after-seed',
      home: device.home,
      sidecar: device.sidecar,
      sidecarVersion: discoveryView.runtimeVersion,
      capability: device.capability,
      sidecarPid,
    });

    result.reads = await benchmarkReads({ device, options, runToken });
    result.snapshots.afterReads = await snapshot({
      phase: 'after-reads',
      home: device.home,
      sidecar: device.sidecar,
      sidecarVersion: discoveryView.runtimeVersion,
      capability: device.capability,
      sidecarPid,
    });

    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    const rawMessage = String(error?.message ?? error);
    result.error = {
      name: error?.name ?? 'Error',
      message: cluster?.root ? rawMessage.split(cluster.root).join('<temp-home>') : rawMessage,
    };
    throw error;
  } finally {
    if (cluster) {
      const tempRoot = cluster.root;
      if (options.keep) {
        for (const device of cluster.devices.slice().reverse()) {
          await device.close().catch(() => undefined);
        }
        result.cleanup = {
          cleaned: false,
          tempHomeRemoved: false,
          tempRoot: '<kept-temp-home>',
        };
      } else {
        await cluster.cleanup().then(() => {
          result.cleanup = { cleaned: true };
        }).catch((error) => {
          const message = String(error?.message ?? error);
          result.cleanup = {
            cleaned: false,
            error: tempRoot ? message.split(tempRoot).join('<temp-home>') : message,
          };
        });
      }
      const stopped = await ensureSidecarStopped(sidecarPid);
      result.cleanup = {
        ...(result.cleanup ?? {}),
        tempHomeRemoved: options.keep ? false : true,
        tempRoot: '<temp-home>',
        sidecarProcessStopped: stopped.stopped,
        sidecarProcessForcedStop: stopped.forced,
      };
      if (options.keep) {
        process.stderr.write(`[scale-bench] 保留临时 home：${tempRoot}\n`);
      }
    }
    result.finishedAt = nowIso();
  }
  return result;
}

async function writeResult(path, result) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let result = null;
  try {
    result = await runBenchmark(options);
    await writeResult(options.output, result);
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      label: result.label,
      git: result.git,
      seed: result.seed,
      reads: result.reads,
      resources: {
        afterSeed: result.snapshots.afterSeed
          ? {
            hostRssBytes: result.snapshots.afterSeed.host.rssBytes,
            sidecarRssBytes: result.snapshots.afterSeed.sidecar.rssBytes,
            disk: result.snapshots.afterSeed.disk,
            counts: result.snapshots.afterSeed.sidecarStatus.counts,
            details: result.snapshots.afterSeed.sidecarStatus.details,
            idempotencyLedgerEntries: result.snapshots.afterSeed.idempotencyLedgerEntries,
          }
          : null,
        afterReads: result.snapshots.afterReads
          ? {
            hostRssBytes: result.snapshots.afterReads.host.rssBytes,
            sidecarRssBytes: result.snapshots.afterReads.sidecar.rssBytes,
            disk: result.snapshots.afterReads.disk,
            counts: result.snapshots.afterReads.sidecarStatus.counts,
            details: result.snapshots.afterReads.sidecarStatus.details,
            idempotencyLedgerEntries: result.snapshots.afterReads.idempotencyLedgerEntries,
          }
          : null,
      },
      cleanup: result.cleanup,
      output: options.output,
    }, null, 2)}\n`);
  } catch (error) {
    if (result) {
      await writeResult(options.output, result).catch(() => undefined);
    }
    process.stderr.write(`[scale-bench] 失败：${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}

await main();
