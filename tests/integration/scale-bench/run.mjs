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
// - 失败、超时、SIGINT/SIGTERM 都会落盘 partial JSON；运行期间按批次/样本 checkpoint。
//
// 用法：
//   npm run build
//   node tests/integration/scale-bench/run.mjs \
//     --records 1000 --details 1000 --batch-size 50 --queries 100 \
//     --label 1k-smoke --output docs/quality/0.3.2-scale-benchmark.json
//
// 10k full（显式允许大规模 + 长超时）：
//   node tests/integration/scale-bench/run.mjs \
//     --records 10000 --details 10000 --batch-size 100 --queries 200 \
//     --allow-large --max-records 10000 --timeout-ms 14400000 \
//     --label 10k-full --output docs/quality/0.3.2-scale-benchmark-10k.json

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createCluster, readSidecarDiscovery } from '../../acceptance/lib/cluster.mjs';

const SCHEMA = 'mebular.scale-benchmark/2';
const AGENT_ID = 'scale-bench';
const AGENT_NAME = 'Scale Benchmark';
const DOMAIN = `agent:${AGENT_ID}`;
const RECORD_KIND = 'observation';
const MB = 1024 * 1024;
const HARD_MAX_RECORDS = 100_000;
const HARD_MAX_QUERIES = 2_000;
const READ_CHECKPOINT_EVERY = 5;
const MAX_CONSECUTIVE_READ_FAILURES = 5;
const DIST_FILES = [
  'dist/index.js',
  'packages/memory-runtime/dist/index.js',
  'packages/service/dist/index.js',
  'packages/service/dist/version.json',
  'packages/fleet/dist/version.json',
  'packages/mcp/src/serve.mjs',
  'packages/mcp/src/memory-capability.mjs',
  'packages/memory-runtime/bin/mebular-memory-runtime.mjs',
];

const DEFAULTS = {
  records: 1_000,
  details: 1_000,
  batchSize: 50,
  queries: 100,
  limit: 20,
  maxRecords: 2_000,
  maxQueries: 500,
  timeoutMs: 30 * 60 * 1000,
  requestTimeoutMs: 120 * 1000,
  label: '1k-smoke',
  output: 'docs/quality/0.3.2-scale-benchmark.json',
  keep: false,
  allowLarge: false,
  failAfterBatches: null,
  failAfterReadSamples: null,
  killSidecarAfterBatches: null,
  freezeSidecarAfterBatches: null,
};

function usage() {
  return [
    '用法: node tests/integration/scale-bench/run.mjs [options]',
    '',
    '  --records <n>            MemoryRecord 数量，默认 1000',
    '  --details <n>            Detail 数量，默认 1000；必须与 --records 相等',
    '  --batch-size <n>         每个 sidecar ingest 批次的记录/详情数，1-100，默认 50',
    '  --queries <n>            查询/召回/上下文采样数，默认 100',
    '  --limit <n>              capability/sidecar 查询返回上限，10-50，默认 20',
    '  --max-records <n>        未显式 --allow-large 时的 records 上限，默认 2000',
    '  --max-queries <n>        未显式 --allow-large 时的 queries 上限，默认 500',
    '  --allow-large            显式允许超过默认上限（硬上限 100000 records / 2000 queries）',
    '  --timeout-ms <n>         整体超时，默认 1800000；0 表示禁用',
    '  --request-timeout-ms <n> 单次 HTTP 请求超时，默认 120000',
    '  --label <text>           结果标签，例如 1k-smoke / 10k-full',
    '  --output <path>          机器可读 JSON 输出路径',
    '  --keep                   保留临时 home（排障用；默认删除）',
    '',
    '故障注入（仅测试/证据使用）：',
    '  --fail-after-batches <n>       完成 n 个 seed 批次后抛出注入失败',
    '  --fail-after-read-samples <n>  完成 n 个 read 样本后抛出注入失败',
    '  --kill-sidecar-after-batches <n> 完成 n 个 seed 批次后 SIGKILL sidecar',
    '  --freeze-sidecar-after-batches <n> 完成 n 个 seed 批次后 SIGSTOP sidecar（验证清理 SIGKILL 升级）',
    '',
    '  --help                   显示本帮助',
  ].join('\n');
}

function parseInteger(name, raw) {
  if (!/^\d+$/.test(String(raw))) throw new Error(`${name} 必须是正整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

function parseNonNegativeInteger(name, raw) {
  if (!/^\d+$/.test(String(raw))) throw new Error(`${name} 必须是非负整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`);
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
    if (arg === '--allow-large') {
      options.allowLarge = true;
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
    else if (name === 'max-records') options.maxRecords = parseInteger('--max-records', raw);
    else if (name === 'max-queries') options.maxQueries = parseInteger('--max-queries', raw);
    else if (name === 'timeout-ms') options.timeoutMs = parseNonNegativeInteger('--timeout-ms', raw);
    else if (name === 'request-timeout-ms') options.requestTimeoutMs = parseInteger('--request-timeout-ms', raw);
    else if (name === 'fail-after-batches') options.failAfterBatches = parseInteger('--fail-after-batches', raw);
    else if (name === 'fail-after-read-samples') {
      options.failAfterReadSamples = parseInteger('--fail-after-read-samples', raw);
    } else if (name === 'kill-sidecar-after-batches') {
      options.killSidecarAfterBatches = parseInteger('--kill-sidecar-after-batches', raw);
    } else if (name === 'freeze-sidecar-after-batches') {
      options.freezeSidecarAfterBatches = parseInteger('--freeze-sidecar-after-batches', raw);
    } else if (name === 'label') options.label = String(raw).trim();
    else if (name === 'output') options.output = String(raw).trim();
    else throw new Error(`未知参数: ${arg}`);
  }
  if (options.records !== options.details) {
    throw new Error('--records 与 --details 必须相等：本基准每个 ingest 项固定产生 1 条记录 + 1 条详情');
  }
  if (options.records > HARD_MAX_RECORDS) throw new Error(`--records 不能超过硬上限 ${HARD_MAX_RECORDS}`);
  if (options.queries > HARD_MAX_QUERIES) throw new Error(`--queries 不能超过硬上限 ${HARD_MAX_QUERIES}`);
  if (options.records > options.maxRecords && !options.allowLarge) {
    throw new Error(
      `--records ${options.records} 超过 --max-records ${options.maxRecords}；`
      + '如确实要跑大规模，请显式加 --allow-large 或提高 --max-records',
    );
  }
  if (options.queries > options.maxQueries && !options.allowLarge) {
    throw new Error(
      `--queries ${options.queries} 超过 --max-queries ${options.maxQueries}；`
      + '如确实要跑大规模，请显式加 --allow-large 或提高 --max-queries',
    );
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

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function distInfo() {
  const files = [];
  const missing = [];
  for (const path of DIST_FILES) {
    try {
      const info = await stat(path);
      files.push({
        path,
        sha256: await sha256File(path),
        sizeBytes: info.size,
        mtimeMs: info.mtimeMs,
      });
    } catch {
      missing.push(path);
    }
  }
  const aggregateSha256 = createHash('sha256')
    .update(files.map((file) => `${file.path}\0${file.sha256}`).join('\n'))
    .digest('hex');
  const mtimes = files.map((file) => file.mtimeMs);
  const newestMtimeMs = mtimes.length > 0 ? Math.max(...mtimes) : null;
  const oldestMtimeMs = mtimes.length > 0 ? Math.min(...mtimes) : null;
  return {
    files,
    missing,
    aggregateSha256,
    newestMtimeMs,
    oldestMtimeMs,
    newestAt: newestMtimeMs === null ? null : new Date(newestMtimeMs).toISOString(),
    oldestAt: oldestMtimeMs === null ? null : new Date(oldestMtimeMs).toISOString(),
  };
}

async function buildInfo(gitSha) {
  const result = { files: [], sha: null, builtAt: null, version: null, matchesGit: null, warnings: [] };
  for (const [name, path] of Object.entries({
    service: 'packages/service/dist/version.json',
    fleet: 'packages/fleet/dist/version.json',
  })) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      result.files.push({
        name,
        path,
        version: parsed?.version ?? null,
        sha: typeof parsed?.sha === 'string' ? parsed.sha : null,
        builtAt: typeof parsed?.builtAt === 'string' ? parsed.builtAt : null,
      });
    } catch (error) {
      result.warnings.push(`build_metadata_unavailable:${name}:${error?.code ?? error?.name ?? 'error'}`);
    }
  }
  const buildShas = [...new Set(result.files.map((file) => file.sha).filter(Boolean))];
  result.sha = buildShas.length === 1 ? buildShas[0] : null;
  const buildTimes = result.files.map((file) => file.builtAt).filter(Boolean).sort();
  result.builtAt = buildTimes.length > 0 ? buildTimes.at(-1) : null;
  const versions = [...new Set(result.files.map((file) => file.version).filter(Boolean))];
  result.version = versions.length === 1 ? versions[0] : null;
  if (buildShas.length > 1) result.warnings.push('build_sha_mismatch_between_packages');
  result.matchesGit = result.sha !== null && gitSha !== null ? result.sha === gitSha : null;
  if (result.matchesGit === false) result.warnings.push('build_sha_differs_from_git_head');
  return result;
}

async function preflightCheck(options) {
  let freeDiskBytes = null;
  let diskCheck = 'ok';
  try {
    const stats = await statfs(os.tmpdir());
    freeDiskBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch (error) {
    diskCheck = 'unavailable';
    freeDiskBytes = null;
  }
  const availableMemorySource = typeof process.availableMemory === 'function'
    ? 'process.availableMemory'
    : 'os.freemem';
  const freeMemoryBytes = availableMemorySource === 'process.availableMemory'
    ? process.availableMemory()
    : os.freemem();
  const totalMemoryBytes = os.totalmem();
  const requiredDiskBytes = Math.max(256 * MB, options.records * 64 * 1024);
  const requiredMemoryBytes = Math.max(
    96 * MB,
    Math.min(totalMemoryBytes * 0.25, 96 * MB + options.records * 64 * 1024),
  );
  const diskOk = freeDiskBytes === null ? true : freeDiskBytes >= requiredDiskBytes;
  const memoryOk = freeMemoryBytes >= requiredMemoryBytes;
  return {
    ok: diskOk && memoryOk,
    tempDir: '<temp-dir>',
    diskCheck,
    freeDiskBytes,
    requiredDiskBytes,
    freeMemoryBytes,
    requiredMemoryBytes,
    totalMemoryBytes,
    availableMemorySource,
    warnings: freeDiskBytes === null ? ['disk_preflight_unavailable'] : [],
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

function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs) return promise;
  let timer = null;
  const timeout = new Promise((resolvePromise, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 (${timeoutMs}ms)`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function abortError(reason) {
  const error = new Error(`运行被中止：${reason}`);
  error.name = 'AbortError';
  error.code = reason;
  return error;
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

function sanitizeMessage(value, tempRoot) {
  const message = String(value ?? '');
  return tempRoot ? message.split(tempRoot).join('<temp-home>') : message;
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

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
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
  for (const [label, relativePath] of Object.entries(paths)) {
    byPath[label] = await pathBytes(join(home, relativePath));
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

function makePidTracker() {
  const pids = new Set();
  const events = [];
  return {
    add(pid, source) {
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return;
      if (!pids.has(pid)) {
        pids.add(pid);
        events.push({ pid, source, at: nowIso() });
      }
    },
    current() {
      return [...pids].at(-1) ?? null;
    },
    list() {
      return [...pids];
    },
    events() {
      return [...events];
    },
  };
}

async function refreshSidecarPid(device, tracker, source) {
  if (!device) return null;
  const discovery = await readSidecarDiscovery(device.home).catch(() => null);
  if (discovery?.pid) tracker.add(discovery.pid, source);
  return discovery;
}

function emptySeedState(options) {
  return {
    status: 'not-started',
    requestedRecords: options.records,
    requestedDetails: options.details,
    writtenRecords: 0,
    writtenDetails: 0,
    batchesCompleted: 0,
    batchesTotal: Math.ceil(options.records / options.batchSize),
    batchSize: options.batchSize,
    kindCounts: {},
    latencyRaw: [],
    perRecordLatencyRaw: [],
    batchLatenciesMs: [],
    latency: latencySummary([]),
    perRecordLatencyMs: latencySummary([]),
    throughput: { recordsPerSec: 0, detailsPerSec: 0, batchesPerSec: 0 },
    wallMs: 0,
    startedAt: null,
    finishedAt: null,
    failedBatch: null,
    faultInjection: null,
    error: null,
  };
}

function updateSeedSummary(state, startedPerf) {
  state.wallMs = startedPerf === null ? state.wallMs : Number(elapsedMs(startedPerf).toFixed(3));
  state.latency = latencySummary(state.latencyRaw);
  state.perRecordLatencyMs = latencySummary(state.perRecordLatencyRaw);
  const seconds = state.wallMs / 1000;
  state.throughput = {
    recordsPerSec: seconds > 0 ? Number((state.writtenRecords / seconds).toFixed(2)) : 0,
    detailsPerSec: seconds > 0 ? Number((state.writtenDetails / seconds).toFixed(2)) : 0,
    batchesPerSec: seconds > 0 ? Number((state.batchesCompleted / seconds).toFixed(2)) : 0,
  };
}

function emptyReadsState(options) {
  return {
    status: 'not-started',
    samplesRequested: options.queries,
    samplesCompleted: 0,
    samples: 0,
    queryLimit: options.limit,
    sampling: 'stratified by index % 100 detail-kind bucket; equal samples per bucket',
    counters: {
      capabilityHits: 0,
      recallHits: 0,
      contextHits: 0,
      expandHits: 0,
      expandAttempts: 0,
      degradedCapabilityQueries: 0,
      degradedRecalls: 0,
      degradedContexts: 0,
      degradedExpands: 0,
      warningCounts: {
        capabilityQuery: 0,
        recall: 0,
        context: 0,
        expand: 0,
      },
      warningCodes: {
        capabilityQuery: [],
        recall: [],
        context: [],
        expand: [],
      },
    },
    latencyRaw: {
      capabilityQuery: [],
      sidecarRecall: [],
      sidecarContext: [],
      detailExpand: [],
      recallInternalExpand: [],
      recallInternalTotal: [],
    },
    detailExpandBySourceRaw: {},
    kindStats: {},
    failures: [],
    consecutiveFailures: 0,
    aborted: false,
    abortReason: null,
    hitRate: {},
    detailCoverage: null,
    latency: {},
    recallInternalTiming: {},
    detailExpandBySource: {},
    degraded: {},
    warnings: {},
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

function ensureKindStat(state, kind) {
  const existing = state.kindStats[kind] ?? {
    kind,
    samples: 0,
    expandAttempts: 0,
    expandHits: 0,
    missingDetail: 0,
  };
  state.kindStats[kind] = existing;
  return existing;
}

function recordWarning(state, phase, body) {
  const warnings = Array.isArray(body?.warnings) ? body.warnings : [];
  state.counters.warningCounts[phase] += warnings.length;
  for (const warning of warnings) {
    const code = typeof warning === 'string'
      ? warning
      : (warning && typeof warning.code === 'string' ? warning.code : 'unknown');
    const codes = state.counters.warningCodes[phase];
    if (!codes.includes(code) && codes.length < 20) codes.push(code);
  }
  if (body?.degraded === true) {
    if (phase === 'capabilityQuery') state.counters.degradedCapabilityQueries += 1;
    else if (phase === 'recall') state.counters.degradedRecalls += 1;
    else if (phase === 'context') state.counters.degradedContexts += 1;
    else if (phase === 'expand') state.counters.degradedExpands += 1;
  }
}

function updateReadsSummary(state) {
  const counters = state.counters;
  const samples = state.samplesCompleted;
  const expandAttempts = counters.expandAttempts;
  const coverageRate = hitRate(expandAttempts, samples);
  const bySource = {};
  for (const [source, values] of Object.entries(state.detailExpandBySourceRaw).sort(([a], [b]) => a.localeCompare(b))) {
    bySource[source] = latencySummary(values);
  }
  const byKind = Object.values(state.kindStats)
    .sort((a, b) => a.kind.localeCompare(b.kind))
    .map((entry) => ({
      ...entry,
      coverage: hitRate(entry.expandAttempts, entry.samples),
      hitRate: hitRate(entry.expandHits, entry.expandAttempts),
    }));
  state.samples = samples;
  // detailExpand 的总体命中率只在每个样本都实际发起展开时才有效；否则置 null，
  // 由 detailExpandCoverage / detailCoverage 单独表达覆盖率，避免机器消费者误读。
  state.hitRate = {
    capabilityQuery: hitRate(counters.capabilityHits, samples),
    sidecarRecall: hitRate(counters.recallHits, samples),
    sidecarContext: hitRate(counters.contextHits, samples),
    detailExpand: coverageRate === 1 ? hitRate(counters.expandHits, expandAttempts) : null,
    detailExpandCoverage: coverageRate,
  };
  state.detailCoverage = {
    samples,
    expandAttempts,
    missingDetail: samples - expandAttempts,
    coverageRate,
    hitRate: hitRate(counters.expandHits, expandAttempts),
    byKind,
  };
  state.latency = Object.fromEntries(
    Object.entries(state.latencyRaw).map(([key, values]) => [key, latencySummary(values)]),
  );
  state.recallInternalTiming = {
    expandMs: latencySummary(state.latencyRaw.recallInternalExpand),
    totalMs: latencySummary(state.latencyRaw.recallInternalTotal),
  };
  state.detailExpandBySource = bySource;
  state.degraded = {
    capabilityQueries: counters.degradedCapabilityQueries,
    recalls: counters.degradedRecalls,
    contexts: counters.degradedContexts,
    expands: counters.degradedExpands,
  };
  state.warnings = {
    counts: { ...counters.warningCounts },
    codes: {
      capabilityQuery: [...counters.warningCodes.capabilityQuery],
      recall: [...counters.warningCodes.recall],
      context: [...counters.warningCodes.context],
      expand: [...counters.warningCodes.expand],
    },
  };
}

async function seedDataset({
  device,
  options,
  runToken,
  state,
  tracker,
  onProgress,
  onCheckpoint,
  control,
  requestTimeoutMs,
}) {
  const { records, batchSize } = options;
  const startedPerf = performance.now();
  state.status = 'running';
  state.startedAt = nowIso();
  updateSeedSummary(state, startedPerf);

  try {
    for (let offset = 0; offset < records; offset += batchSize) {
      if (control.abort.requested) throw abortError(control.abort.reason);
      const count = Math.min(batchSize, records - offset);
      const chunks = [];
      const candidates = [];
      for (let local = 0; local < count; local += 1) {
        const index = offset + local;
        const marker = markerFor(runToken, index);
        const text = textFor(marker, index);
        const shape = shapeFor(index);
        const messageId = `msg_${runToken}_${String(index).padStart(6, '0')}`;
        state.kindCounts[shape.bucket] = (state.kindCounts[shape.bucket] ?? 0) + 1;
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
      let response;
      try {
        response = await withTimeout(
          device.sidecar.ingest({
            requestId,
            agentId: AGENT_ID,
            agentName: AGENT_NAME,
            extractor: 'host',
            chunks,
            candidates,
          }),
          requestTimeoutMs,
          `seed 批次 ${batchIndex}`,
        );
      } catch (error) {
        state.status = 'failed';
        state.failedBatch = { index: batchIndex, count, error: { name: error?.name ?? 'Error', message: String(error?.message ?? error) } };
        state.error = state.failedBatch.error;
        state.finishedAt = nowIso();
        updateSeedSummary(state, startedPerf);
        await onCheckpoint?.('seed-error');
        throw error;
      }

      const latency = elapsedMs(batchStartedAt);
      if (response.status !== 200) {
        const code = response.body?.error?.code ?? 'unknown';
        const error = new Error(`seed 批次 ${batchIndex} 失败：HTTP ${response.status} code=${code}`);
        state.status = 'failed';
        state.failedBatch = { index: batchIndex, count, error: { name: error.name, message: error.message } };
        state.error = state.failedBatch.error;
        state.finishedAt = nowIso();
        updateSeedSummary(state, startedPerf);
        await onCheckpoint?.('seed-error');
        throw error;
      }
      const data = response.body?.data;
      if (!data || data.queued === true) {
        const error = new Error(`seed 批次 ${batchIndex} 未 committed`);
        state.status = 'failed';
        state.failedBatch = { index: batchIndex, count, error: { name: error.name, message: error.message } };
        state.error = state.failedBatch.error;
        state.finishedAt = nowIso();
        updateSeedSummary(state, startedPerf);
        await onCheckpoint?.('seed-error');
        throw error;
      }
      if (data.records?.length !== count) {
        const error = new Error(`seed 批次 ${batchIndex} 记录数不符：期望 ${count}，实际 ${data.records?.length}`);
        state.status = 'failed';
        state.failedBatch = { index: batchIndex, count, error: { name: error.name, message: error.message } };
        state.error = state.failedBatch.error;
        state.finishedAt = nowIso();
        updateSeedSummary(state, startedPerf);
        await onCheckpoint?.('seed-error');
        throw error;
      }
      if (data.detail?.ids?.length !== count || data.detail?.failed !== 0 || data.detail?.queued !== 0) {
        const error = new Error(`seed 批次 ${batchIndex} 详情数不符`);
        state.status = 'failed';
        state.failedBatch = { index: batchIndex, count, error: { name: error.name, message: error.message } };
        state.error = state.failedBatch.error;
        state.finishedAt = nowIso();
        updateSeedSummary(state, startedPerf);
        await onCheckpoint?.('seed-error');
        throw error;
      }

      state.latencyRaw.push(latency);
      state.perRecordLatencyRaw.push(Number((latency / count).toFixed(3)));
      state.batchLatenciesMs.push(Number(latency.toFixed(3)));
      state.batchesCompleted += 1;
      state.writtenRecords += data.records.length;
      state.writtenDetails += data.detail.ids.length;
      state.progress = {
        phase: 'seed',
        completed: state.batchesCompleted,
        total: state.batchesTotal,
        records: state.writtenRecords,
        details: state.writtenDetails,
        updatedAt: nowIso(),
      };
      updateSeedSummary(state, startedPerf);
      onProgress?.({
        batches: state.batchesTotal,
        completed: state.batchesCompleted,
        records: state.writtenRecords,
        details: state.writtenDetails,
      });

      if (options.failAfterBatches !== null && state.batchesCompleted >= options.failAfterBatches) {
        const error = new Error(`fault_injection: seed stopped after ${state.batchesCompleted} completed batches`);
        error.code = 'fault_injection';
        state.status = 'failed';
        state.faultInjection = { type: 'seed_fail_after_batches', atBatch: state.batchesCompleted };
        state.error = { name: error.name, message: error.message };
        state.finishedAt = nowIso();
        updateSeedSummary(state, startedPerf);
        await onCheckpoint?.('fault-injection-seed');
        throw error;
      }

      if (options.killSidecarAfterBatches !== null
        && state.batchesCompleted >= options.killSidecarAfterBatches
        && state.faultInjection === null) {
        const discovery = await refreshSidecarPid(device, tracker, 'fault-injection-kill');
        if (discovery?.pid) {
          try {
            process.kill(discovery.pid, 'SIGKILL');
            state.faultInjection = { type: 'sidecar_sigkill', atBatch: state.batchesCompleted, pid: discovery.pid };
          } catch (error) {
            state.faultInjection = {
              type: 'sidecar_sigkill_failed',
              atBatch: state.batchesCompleted,
              error: String(error?.message ?? error),
            };
          }
        }
      }

      if (options.freezeSidecarAfterBatches !== null
        && state.batchesCompleted >= options.freezeSidecarAfterBatches
        && state.faultInjection === null) {
        const discovery = await refreshSidecarPid(device, tracker, 'fault-injection-freeze');
        if (discovery?.pid) {
          process.kill(discovery.pid, 'SIGSTOP');
          const error = new Error(`fault_injection: sidecar frozen after ${state.batchesCompleted} batches`);
          error.code = 'fault_injection';
          state.status = 'failed';
          state.faultInjection = { type: 'sidecar_sigstop', atBatch: state.batchesCompleted, pid: discovery.pid };
          state.error = { name: error.name, message: error.message };
          state.finishedAt = nowIso();
          updateSeedSummary(state, startedPerf);
          await onCheckpoint?.('fault-injection-freeze');
          throw error;
        }
      }

      await onCheckpoint?.('seed-batch');
    }
  } catch (error) {
    if (state.status !== 'failed') {
      state.status = control.abort.requested ? 'interrupted' : 'failed';
      state.error = { name: error?.name ?? 'Error', message: String(error?.message ?? error) };
      state.finishedAt = nowIso();
      updateSeedSummary(state, startedPerf);
      await onCheckpoint?.('seed-error');
    }
    throw error;
  }

  state.status = 'completed';
  state.finishedAt = nowIso();
  updateSeedSummary(state, startedPerf);
  return state;
}

function sampleIndices(records, queries) {
  const count = Math.min(records, queries);
  const buckets = Math.min(100, records);
  const perBucket = Math.floor(count / buckets);
  const extra = count % buckets;
  const indices = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const pool = [];
    for (let index = bucket; index < records; index += 100) pool.push(index);
    const take = Math.min(pool.length, perBucket + (bucket < extra ? 1 : 0));
    const stride = Math.max(1, Math.floor(pool.length / Math.max(1, take)));
    const base = (bucket * 7) % pool.length;
    for (let slot = 0; slot < take; slot += 1) {
      indices.push(pool[(base + slot * stride) % pool.length]);
    }
  }
  if (indices.length < count) {
    const step = records / (count - indices.length + 1);
    for (let index = indices.length; index < count; index += 1) {
      indices.push(Math.min(records - 1, Math.floor(step * (index + 1))));
    }
  }
  return [...new Set(indices)].sort((a, b) => a - b);
}

async function benchmarkReads({ device, options, runToken, state, onCheckpoint, control, requestTimeoutMs }) {
  const indices = sampleIndices(options.records, options.queries);
  state.status = 'running';
  state.startedAt = nowIso();
  const counters = state.counters;
  let sampleFailed = false;
  const recordFailure = (phase, index, error) => {
    sampleFailed = true;
    state.consecutiveFailures += 1;
    state.failures.push({
      phase,
      index,
      at: nowIso(),
      error: {
        name: error?.name ?? 'Error',
        code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 500),
      },
    });
  };

  try {
    for (const [position, index] of indices.entries()) {
      if (control.abort.requested) throw abortError(control.abort.reason);
      sampleFailed = false;
      const marker = markerFor(runToken, index);
      const sampleKind = shapeFor(index).bucket;
      const kindStat = ensureKindStat(state, sampleKind);
      kindStat.samples += 1;
      let recallData = null;

      try {
        const started = performance.now();
        const response = await withTimeout(device.capability.query({
          query: marker,
          agentId: AGENT_ID,
          domains: [DOMAIN],
          limit: options.limit,
        }), requestTimeoutMs, `capability query ${index}`);
        state.latencyRaw.capabilityQuery.push(elapsedMs(started));
        if (response.status !== 200 || response.body?.ok !== true) {
          recordFailure('capability_query', index, new Error(`HTTP ${response.status}`));
        } else {
          recordWarning(state, 'capabilityQuery', response.body);
          if (markerVisible(response.body?.data?.records, marker)) counters.capabilityHits += 1;
        }
      } catch (error) {
        recordFailure('capability_query', index, error);
      }
      if (state.consecutiveFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
        state.aborted = true;
        state.abortReason = 'consecutive_read_failures';
        break;
      }

      try {
        const started = performance.now();
        const response = await withTimeout(device.sidecar.recall({
          agentId: AGENT_ID,
          query: marker,
          domains: [DOMAIN],
          limit: options.limit,
        }), requestTimeoutMs, `recall ${index}`);
        state.latencyRaw.sidecarRecall.push(elapsedMs(started));
        recallData = response.body?.data;
        if (response.status !== 200 || response.body?.ok !== true) {
          recordFailure('recall', index, new Error(`HTTP ${response.status}`));
        } else {
          recordWarning(state, 'recall', response.body);
          if (markerVisible(recallData?.fragments, marker) || markerVisible(recallData?.records, marker)) {
            counters.recallHits += 1;
          }
          if (typeof recallData?.timing?.expandMs === 'number') {
            state.latencyRaw.recallInternalExpand.push(recallData.timing.expandMs);
          }
          if (typeof recallData?.timing?.totalMs === 'number') {
            state.latencyRaw.recallInternalTotal.push(recallData.timing.totalMs);
          }
        }
      } catch (error) {
        recordFailure('recall', index, error);
      }
      if (state.consecutiveFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
        state.aborted = true;
        state.abortReason = 'consecutive_read_failures';
        break;
      }

      try {
        const started = performance.now();
        const response = await withTimeout(device.sidecar.context({
          agentId: AGENT_ID,
          query: marker,
          domains: [DOMAIN],
          limit: options.limit,
        }), requestTimeoutMs, `context ${index}`);
        state.latencyRaw.sidecarContext.push(elapsedMs(started));
        if (response.status !== 200 || response.body?.ok !== true) {
          recordFailure('context', index, new Error(`HTTP ${response.status}`));
        } else {
          recordWarning(state, 'context', response.body);
          if (markerVisible(response.body?.data?.blocks, marker)
            || markerVisible(response.body?.data?.fragments, marker)) {
            counters.contextHits += 1;
          }
        }
      } catch (error) {
        recordFailure('context', index, error);
      }
      if (state.consecutiveFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
        state.aborted = true;
        state.abortReason = 'consecutive_read_failures';
        break;
      }

      const fragment = Array.isArray(recallData?.fragments)
        ? recallData.fragments.find((entry) => Array.isArray(entry?.detailIds) && entry.detailIds.length > 0)
        : null;
      if (fragment && recallData?.recallId) {
        counters.expandAttempts += 1;
        kindStat.expandAttempts += 1;
        try {
          const started = performance.now();
          const response = await withTimeout(device.sidecar.expand(recallData.recallId, {
            agentId: AGENT_ID,
            fragmentId: fragment.id,
          }), requestTimeoutMs, `expand ${index}`);
          const latency = elapsedMs(started);
          state.latencyRaw.detailExpand.push(latency);
          if (response.status !== 200 || response.body?.ok !== true) {
            recordFailure('detail_expand', index, new Error(`HTTP ${response.status}`));
          } else {
            const expandData = response.body?.data;
            recordWarning(state, 'expand', response.body);
            const source = expandData?.detail?.source ?? 'missing';
            const raw = state.detailExpandBySourceRaw[source] ?? [];
            raw.push(latency);
            state.detailExpandBySourceRaw[source] = raw;
            if (markerVisible(expandData?.detail?.text, marker)) {
              counters.expandHits += 1;
              kindStat.expandHits += 1;
            }
          }
        } catch (error) {
          recordFailure('detail_expand', index, error);
        }
      } else {
        kindStat.missingDetail += 1;
      }

      state.samplesCompleted += 1;
      if (!sampleFailed) state.consecutiveFailures = 0;
      state.progress = {
        phase: 'reads',
        completed: state.samplesCompleted,
        total: indices.length,
        updatedAt: nowIso(),
      };
      updateReadsSummary(state);
      if (position % READ_CHECKPOINT_EVERY === 0) await onCheckpoint?.('reads');
      if (state.consecutiveFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
        state.aborted = true;
        state.abortReason = 'consecutive_read_failures';
        break;
      }
      if (options.failAfterReadSamples !== null
        && state.samplesCompleted >= options.failAfterReadSamples) {
        const error = new Error(`fault_injection: reads stopped after ${state.samplesCompleted} samples`);
        error.code = 'fault_injection';
        state.status = 'failed';
        state.faultInjection = { type: 'reads_fail_after_samples', atSample: state.samplesCompleted };
        state.error = { name: error.name, message: error.message };
        state.finishedAt = nowIso();
        updateReadsSummary(state);
        await onCheckpoint?.('fault-injection-reads');
        throw error;
      }
      if (position > 0 && position % 25 === 0) {
        process.stderr.write(`[scale-bench] read samples ${position}/${indices.length}\n`);
      }
    }
  } catch (error) {
    if (state.status !== 'failed') {
      state.status = control.abort.requested ? 'interrupted' : 'failed';
      state.error = { name: error?.name ?? 'Error', message: String(error?.message ?? error) };
    }
    state.finishedAt = nowIso();
    updateReadsSummary(state);
    await onCheckpoint?.('reads-error');
    throw error;
  }

  state.status = state.aborted ? 'aborted' : 'completed';
  state.finishedAt = nowIso();
  updateReadsSummary(state);
  return state;
}

async function verifyStorageDetailKinds({ device, runToken, records, requestTimeoutMs }) {
  const probes = [
    { index: 0, expectedKind: 'raw_chunk', bucket: 'conversation-user' },
    { index: 80, expectedKind: 'raw_chunk', bucket: 'conversation-assistant' },
    { index: 90, expectedKind: 'tool_output', bucket: 'tool_output' },
    { index: 96, expectedKind: 'document_slice', bucket: 'document_slice' },
  ].filter((probe) => probe.index < records);
  const results = [];
  for (const probe of probes) {
    const marker = markerFor(runToken, probe.index);
    try {
      const query = await withTimeout(device.capability.query({
        query: marker,
        agentId: AGENT_ID,
        domains: [DOMAIN],
        limit: 5,
      }), requestTimeoutMs, `storage kind query ${probe.index}`);
      const record = query.body?.data?.records?.find((entry) => markerVisible(entry, marker));
      if (!record?.id) throw new Error('record not found for marker');
      const list = await withTimeout(device.capability.request('/detail', {
        method: 'POST',
        body: JSON.stringify({
          actor: { type: 'agent', agentId: AGENT_ID },
          op: 'list',
          domains: [DOMAIN],
          recordIds: [record.id],
          limit: 5,
          includeText: false,
        }),
      }), requestTimeoutMs, `storage kind detailList ${probe.index}`);
      if (list.status !== 200 || list.body?.ok !== true) {
        throw new Error(`detail list HTTP ${list.status}`);
      }
      const details = Array.isArray(list.body?.data?.details) ? list.body.data.details : [];
      const foundKinds = [...new Set(details.map((detail) => detail?.detailKind).filter(Boolean))];
      results.push({
        index: probe.index,
        bucket: probe.bucket,
        expectedKind: probe.expectedKind,
        recordId: record.id,
        foundKinds,
        ok: details.some((detail) => detail?.detailKind === probe.expectedKind),
        error: null,
      });
    } catch (error) {
      results.push({
        index: probe.index,
        bucket: probe.bucket,
        expectedKind: probe.expectedKind,
        recordId: null,
        foundKinds: [],
        ok: false,
        error: String(error?.message ?? error),
      });
    }
  }
  const requiredKinds = new Set(probes.map((probe) => probe.expectedKind));
  const coveredKinds = [...new Set(results.filter((result) => result.ok).map((result) => result.expectedKind))];
  return {
    ok: results.every((result) => result.ok),
    probes: results,
    requiredKinds: [...requiredKinds],
    coveredKinds,
    missingKinds: [...requiredKinds].filter((kind) => !coveredKinds.includes(kind)),
  };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isOurSidecar(pid) {
  if (!pid) return false;
  try {
    const command = run('ps', ['-o', 'command=', '-p', String(pid)]);
    return command.includes('mebular-memory-runtime') && command.includes(`--parent-pid ${process.pid}`);
  } catch {
    return false;
  }
}

async function waitUntil(probe, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  return false;
}

async function ensureProcessStopped(pid, { graceMs = 5_000, killWaitMs = 2_000 } = {}) {
  if (!pid) return { pid, stopped: true, escalation: null, skipped: true };
  if (!(await isOurSidecar(pid))) {
    return { pid, stopped: !pidAlive(pid), escalation: null, skipped: true };
  }
  if (!pidAlive(pid)) return { pid, stopped: true, escalation: null, skipped: false };
  let escalation = null;
  try {
    process.kill(pid, 'SIGTERM');
    escalation = 'SIGTERM';
  } catch {
    return { pid, stopped: !pidAlive(pid), escalation: null, skipped: false };
  }
  if (!(await waitUntil(() => !pidAlive(pid), graceMs))) {
    try {
      process.kill(pid, 'SIGKILL');
      escalation = 'SIGKILL';
    } catch {
      // 已退出或无权发送；由最终 pidAlive 判定。
    }
    await waitUntil(() => !pidAlive(pid), killWaitMs);
  }
  return { pid, stopped: !pidAlive(pid), escalation, skipped: false };
}

async function scanResidualSidecars() {
  try {
    const output = run('ps', ['-axo', 'pid=,command=']);
    const pids = [];
    for (const line of output.split('\n')) {
      if (!line.includes('mebular-memory-runtime')) continue;
      if (!line.includes(`--parent-pid ${process.pid}`)) continue;
      const match = line.trim().match(/^(\d+)/);
      if (match) pids.push(Number(match[1]));
    }
    return pids;
  } catch {
    return null;
  }
}

async function cleanupRun({ cluster, options, result, tracker, tempRoot }) {
  const errors = [];
  const devices = cluster?.devices ?? [];
  // 先停 tracked sidecar：frozen/失去响应的进程会在这里触发 SIGTERM -> SIGKILL 升级，
  // 也避免删除 temp home 时仍有进程写入。
  const sidecarStop = [];
  for (const pid of tracker.list()) {
    sidecarStop.push(await ensureProcessStopped(pid).catch((error) => ({
      pid,
      stopped: false,
      escalation: null,
      error: String(error?.message ?? error),
    })));
  }

  if (options.keep) {
    for (const device of devices.slice().reverse()) {
      await device.close().catch((error) => errors.push(sanitizeMessage(error?.message ?? error, tempRoot)));
    }
  } else if (cluster) {
    try {
      await cluster.cleanup();
    } catch (error) {
      errors.push(sanitizeMessage(error?.message ?? error, tempRoot));
      for (const device of devices.slice().reverse()) {
        await device.close().catch((closeError) => errors.push(
          sanitizeMessage(closeError?.message ?? closeError, tempRoot),
        ));
      }
    }
  }

  let tempHomeRemoved = options.keep || !tempRoot
    ? !tempRoot
    : !(await pathExists(tempRoot).catch(() => true));
  if (!options.keep && tempRoot && !tempHomeRemoved) {
    try {
      await rm(tempRoot, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      if (error?.code !== 'ENOENT') errors.push(sanitizeMessage(error?.message ?? error, tempRoot));
    }
    tempHomeRemoved = !(await pathExists(tempRoot).catch(() => true));
  }

  let residualPids = await scanResidualSidecars();
  if (Array.isArray(residualPids) && residualPids.length > 0) {
    for (const pid of residualPids) {
      sidecarStop.push(await ensureProcessStopped(pid).catch((error) => ({
        pid,
        stopped: false,
        escalation: null,
        error: String(error?.message ?? error),
      })));
    }
    residualPids = await scanResidualSidecars();
  }
  const allStopped = sidecarStop.every((entry) => entry.stopped);
  const noResidual = residualPids !== null && residualPids.length === 0;
  const cleaned = !options.keep && errors.length === 0 && tempHomeRemoved && allStopped && noResidual;
  const cleanup = {
    cleaned,
    kept: options.keep,
    tempHomeRemoved,
    tempRoot: '<temp-home>',
    sidecarPids: tracker.list(),
    sidecarStop,
    residualPids,
    residualScanAvailable: residualPids !== null,
    errors,
  };
  result.cleanup = cleanup;
  return cleanup;
}

function createResult(options, control) {
  return {
    schema: SCHEMA,
    label: options.label,
    runToken: randomUUID().replace(/-/g, '').slice(0, 8),
    startedAt: nowIso(),
    finishedAt: null,
    status: 'running',
    phase: 'init',
    command: ['node', 'tests/integration/scale-bench/run.mjs', ...process.argv.slice(2)].join(' '),
    git: gitInfo(),
    environment: environmentInfo(),
    options: {
      records: options.records,
      details: options.details,
      batchSize: options.batchSize,
      queries: options.queries,
      limit: options.limit,
      maxRecords: options.maxRecords,
      maxQueries: options.maxQueries,
      timeoutMs: options.timeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      allowLarge: options.allowLarge,
      keep: options.keep,
      failAfterBatches: options.failAfterBatches,
      failAfterReadSamples: options.failAfterReadSamples,
      killSidecarAfterBatches: options.killSidecarAfterBatches,
      freezeSidecarAfterBatches: options.freezeSidecarAfterBatches,
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
    dist: null,
    build: null,
    preflight: null,
    storageVerification: null,
    detailExpandCoverage: null,
    seed: emptySeedState(options),
    reads: emptyReadsState(options),
    snapshots: {},
    sidecarPids: [],
    sidecarPidEvents: [],
    progress: {
      phase: 'init',
      completed: 0,
      total: options.records,
      updatedAt: nowIso(),
    },
    checkpoints: {
      count: 0,
      lastAt: null,
      lastReason: null,
      errors: [],
    },
    abort: {
      requested: control.abort.requested,
      reason: control.abort.reason,
      at: control.abort.at,
    },
    cleanup: null,
    error: null,
  };
}

async function writeResultAtomic(path, result) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await writeFile(tempPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  await rename(tempPath, path);
}

function writeResultSync(path, result) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
}

async function checkpointResult(path, result, reason) {
  result.checkpoints.count += 1;
  result.checkpoints.lastAt = nowIso();
  result.checkpoints.lastReason = reason;
  result.progress = { ...result.progress, updatedAt: nowIso() };
  try {
    await writeResultAtomic(path, result);
  } catch (error) {
    result.checkpoints.errors.push({
      at: nowIso(),
      reason,
      error: { name: error?.name ?? 'Error', message: String(error?.message ?? error) },
    });
  }
}

async function runBenchmark(options, control) {
  const result = createResult(options, control);
  control.result = result;
  let cluster = null;
  let device = null;
  let tempRoot = null;
  const tracker = makePidTracker();
  control.tracker = tracker;
  const timeoutTimer = options.timeoutMs > 0
    ? setTimeout(() => control.requestStop('timeout'), options.timeoutMs)
    : null;
  timeoutTimer?.unref?.();

  const checkpoint = async (reason) => {
    if (device) await refreshSidecarPid(device, tracker, `checkpoint:${reason}`);
    result.sidecarPids = tracker.list();
    result.sidecarPidEvents = tracker.events();
    await checkpointResult(options.output, result, reason);
  };
  control.checkpoint = checkpoint;

  try {
    result.phase = 'preflight';
    result.progress = { phase: 'preflight', completed: 0, total: options.records, updatedAt: nowIso() };
    await checkpoint('preflight-start');
    result.dist = await distInfo();
    result.build = await buildInfo(result.git.sha);
    if (result.dist.missing.length > 0) {
      throw new Error(`构建产物缺失：${result.dist.missing.join(', ')}；请先 npm run build`);
    }
    result.preflight = await preflightCheck(options);
    if (!result.preflight.ok) {
      throw new Error(
        `preflight 失败：freeDisk=${result.preflight.freeDiskBytes} requiredDisk=${result.preflight.requiredDiskBytes} `
        + `freeMemory=${result.preflight.freeMemoryBytes} requiredMemory=${result.preflight.requiredMemoryBytes}`,
      );
    }
    await checkpoint('preflight-done');

    result.phase = 'cluster';
    cluster = await createCluster({ deviceCount: 1 });
    device = cluster.a;
    tempRoot = cluster.root;
    const discovery = await device.sidecar.waitForReady();
    if (discovery?.pid) tracker.add(discovery.pid, 'cluster-start');
    const sidecarPid = discovery?.pid ?? tracker.current();
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
    await checkpoint('before-seed');

    result.phase = 'seed';
    result.progress = {
      phase: 'seed',
      completed: 0,
      total: Math.ceil(options.records / options.batchSize),
      records: 0,
      details: 0,
      updatedAt: nowIso(),
    };
    await seedDataset({
      device,
      options,
      runToken: result.runToken,
      state: result.seed,
      tracker,
      control,
      requestTimeoutMs: options.requestTimeoutMs,
      onProgress: (progress) => {
        if (progress.completed === progress.batches || progress.completed % 10 === 0) {
          process.stderr.write(
            `[scale-bench] seed ${progress.completed}/${progress.batches} batches `
            + `(${progress.records} records, ${progress.details} details)\n`,
          );
        }
      },
      onCheckpoint: checkpoint,
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
      sidecarPid: tracker.current() ?? sidecarPid,
    });
    await checkpoint('after-seed');

    result.phase = 'storage-verification';
    result.storageVerification = await verifyStorageDetailKinds({
      device,
      runToken: result.runToken,
      records: options.records,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    if (!result.storageVerification.ok) {
      const failed = result.storageVerification.probes.filter((probe) => !probe.ok);
      throw new Error(`Detail 存储侧 kind 断言失败：${JSON.stringify(failed)}`);
    }
    await checkpoint('storage-verification');

    result.phase = 'reads';
    await benchmarkReads({
      device,
      options,
      runToken: result.runToken,
      state: result.reads,
      control,
      requestTimeoutMs: options.requestTimeoutMs,
      onCheckpoint: checkpoint,
    });
    if (result.reads.status !== 'completed' || result.reads.failures.length > 0) {
      throw new Error(
        `read benchmark 未完整通过：status=${result.reads.status} failures=${result.reads.failures.length}`,
      );
    }
    result.detailExpandCoverage = result.reads.detailCoverage;
    result.snapshots.afterReads = await snapshot({
      phase: 'after-reads',
      home: device.home,
      sidecar: device.sidecar,
      sidecarVersion: discoveryView.runtimeVersion,
      capability: device.capability,
      sidecarPid: tracker.current() ?? sidecarPid,
    });
    await checkpoint('after-reads');

    result.status = 'passed';
    result.phase = 'done';
  } catch (error) {
    const interrupted = control.abort.requested;
    result.status = interrupted
      ? (control.abort.reason === 'timeout' ? 'timeout' : 'interrupted')
      : 'failed';
    result.abort = {
      requested: control.abort.requested,
      reason: control.abort.reason,
      at: control.abort.at,
    };
    result.error = {
      name: error?.name ?? 'Error',
      code: error?.code ?? null,
      message: sanitizeMessage(error?.message ?? error, tempRoot),
    };
    if (result.seed.status === 'running' || result.seed.status === 'not-started') {
      result.seed.status = interrupted ? 'interrupted' : 'failed';
      result.seed.error = result.seed.error ?? { name: result.error.name, message: result.error.message };
      result.seed.finishedAt = nowIso();
    }
    if (result.reads.status === 'running' || result.reads.status === 'not-started') {
      result.reads.status = interrupted ? 'interrupted' : 'failed';
      result.reads.error = result.reads.error ?? { name: result.error.name, message: result.error.message };
      result.reads.finishedAt = nowIso();
      updateReadsSummary(result.reads);
    }
    await checkpoint(result.status === 'interrupted' || result.status === 'timeout' ? 'interrupted' : 'failed');
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    result.phase = 'cleanup';
    try {
      await cleanupRun({ cluster, options, result, tracker, tempRoot });
    } catch (error) {
      result.cleanup = {
        cleaned: false,
        kept: options.keep,
        tempHomeRemoved: false,
        tempRoot: '<temp-home>',
        sidecarPids: tracker.list(),
        errors: [sanitizeMessage(error?.message ?? error, tempRoot)],
      };
    }
    result.detailExpandCoverage = result.reads?.detailCoverage ?? result.detailExpandCoverage;
    if (!options.keep && result.status === 'passed' && result.cleanup?.cleaned !== true) {
      result.status = 'failed';
      result.error = {
        name: 'CleanupError',
        code: 'cleanup_incomplete',
        message: '运行本身完成，但临时 home 或 sidecar 清理未通过',
      };
    }
    result.sidecarPids = tracker.list();
    result.sidecarPidEvents = tracker.events();
    result.phase = 'finished';
    result.finishedAt = nowIso();
    result.progress = { ...result.progress, phase: 'finished', updatedAt: nowIso() };
    control.active = false;
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const control = {
    abort: { requested: false, reason: null, at: null },
    result: null,
    checkpoint: null,
    tracker: null,
    active: true,
    requestStop: null,
  };
  let emergencyTimer = null;
  let forcedExit = false;

  const requestStop = (reason) => {
    if (control.abort.requested) return;
    control.abort = { requested: true, reason, at: nowIso() };
    if (control.result) {
      control.result.abort = { ...control.abort };
      control.result.status = reason === 'timeout' ? 'timeout' : 'interrupted';
    }
    process.stderr.write(`[scale-bench] 收到 ${reason}，写入 partial JSON 并清理...\n`);
    void control.checkpoint?.(`stop:${reason}`);
  };
  control.requestStop = requestStop;

  const emergencyExit = (reason) => {
    if (forcedExit) return;
    forcedExit = true;
    if (control.result) {
      control.result.status = reason === 'timeout' ? 'timeout' : 'interrupted';
      control.result.abort = { requested: true, reason, at: nowIso() };
      control.result.cleanup = {
        ...(control.result.cleanup ?? {}),
        cleaned: false,
        emergency: true,
        errors: [...(control.result.cleanup?.errors ?? []), `emergency_exit:${reason}`],
      };
      control.result.finishedAt = nowIso();
      try {
        writeResultSync(options.output, control.result);
      } catch {
        // 最后的落盘也失败；只能退出。
      }
    }
    for (const pid of control.tracker?.list() ?? []) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已退出。
      }
    }
    process.exit(reason === 'SIGINT' ? 130 : reason === 'SIGTERM' ? 143 : 124);
  };

  const onSignal = (signal) => {
    if (control.abort.requested) {
      emergencyExit(signal);
      return;
    }
    requestStop(signal);
    emergencyTimer = setTimeout(() => emergencyExit(signal), 20_000);
    emergencyTimer.unref?.();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let result = null;
  let writeError = null;
  try {
    result = await runBenchmark(options, control);
  } catch (error) {
    // runBenchmark 设计上返回 partial result；这里只兜底未预期的实现异常。
    if (!result) {
      result = control.result;
      if (!result) {
        result = {
          schema: SCHEMA,
          label: options.label,
          status: 'failed',
          startedAt: nowIso(),
          finishedAt: nowIso(),
          command: ['node', 'tests/integration/scale-bench/run.mjs', ...process.argv.slice(2)].join(' '),
          git: gitInfo(),
          environment: environmentInfo(),
          options,
          error: { name: error?.name ?? 'Error', message: String(error?.message ?? error) },
          seed: emptySeedState(options),
          reads: emptyReadsState(options),
          cleanup: null,
        };
      }
    }
    result.status = control.abort.requested
      ? (control.abort.reason === 'timeout' ? 'timeout' : 'interrupted')
      : 'failed';
    result.error = result.error ?? {
      name: error?.name ?? 'Error',
      message: String(error?.message ?? error),
    };
  }

  try {
    await writeResultAtomic(options.output, result);
  } catch (error) {
    writeError = error;
    process.stderr.write(`[scale-bench] 最终 JSON 写入失败：${error?.message ?? error}\n`);
  }
  if (emergencyTimer) clearTimeout(emergencyTimer);
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);

  const exitCode = writeError
    ? 1
    : result.status === 'passed'
      ? 0
      : result.status === 'interrupted'
        ? (control.abort.reason === 'SIGINT' ? 130 : 143)
        : result.status === 'timeout'
          ? 124
          : 1;
  if (exitCode !== 0) process.exitCode = exitCode;

  const summary = {
    status: result.status,
    label: result.label,
    git: result.git,
    dist: result.dist
      ? { aggregateSha256: result.dist.aggregateSha256, newestAt: result.dist.newestAt, missing: result.dist.missing }
      : null,
    build: result.build,
    preflight: result.preflight,
    seed: result.seed,
    reads: result.reads,
    detailExpandCoverage: result.detailExpandCoverage ?? result.reads?.detailCoverage ?? null,
    storageVerification: result.storageVerification,
    resources: {
      afterSeed: result.snapshots?.afterSeed
        ? {
          hostRssBytes: result.snapshots.afterSeed.host.rssBytes,
          sidecarRssBytes: result.snapshots.afterSeed.sidecar.rssBytes,
          disk: result.snapshots.afterSeed.disk,
          counts: result.snapshots.afterSeed.sidecarStatus.counts,
          details: result.snapshots.afterSeed.sidecarStatus.details,
          idempotencyLedgerEntries: result.snapshots.afterSeed.idempotencyLedgerEntries,
        }
        : null,
      afterReads: result.snapshots?.afterReads
        ? {
          hostRssBytes: result.snapshots.afterReads.host.rssBytes,
          sidecarRssBytes: result.snapshots.afterReads.sidecar?.rssBytes ?? null,
          disk: result.snapshots.afterReads.disk,
          counts: result.snapshots.afterReads.sidecarStatus.counts,
          details: result.snapshots.afterReads.sidecarStatus.details,
          idempotencyLedgerEntries: result.snapshots.afterReads.idempotencyLedgerEntries,
        }
        : null,
    },
    cleanup: result.cleanup,
    checkpoints: result.checkpoints,
    error: result.error,
    output: options.output,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

await main();
