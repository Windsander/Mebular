#!/usr/bin/env node
// v0.3.2 10k 额外记录根因探针（只用于诊断，不修改产品代码）。
//
// 两个受控实验，均使用真实 MCP capability + 真实 GraphStore/MemoryService + 真实 sidecar：
// 1. concurrent-idempotency：两个并发 /write 使用同一个 Idempotency-Key/requestId 和同一批
//    item。capability 的 withIdempotency 没有 in-flight 去重，两个请求都会执行；如果图内
//    memoryRecords = 2 × 逻辑 item 数，说明同一幂等键并发时会重复写。
// 2. retry-timeout：把 sidecar capability.timeoutMs 降到 200ms，让真实 /ingest 的
//    /write 在客户端超时后重试；原请求仍在服务端执行。若 records > 逻辑条数而 details
//    仍等于逻辑条数，则复现 10k 失败签名（10023 records / 10000 details）。
//
// 用法：
//   node tests/integration/scale-bench/race-probe.mjs \
//     --out docs/quality/0.3.2-scale-benchmark-race-probe.json
//
// 说明：retry-timeout 是**受控放大**（默认 5s → 200ms），用于在小数据量下稳定复现
// timeout/retry 竞争；它不是 10k 基准本身，也不把该配置用于 10k 通过判断。

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCluster } from '../../acceptance/lib/cluster.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const DEFAULT_OUT = join(ROOT, 'docs/quality/0.3.2-scale-benchmark-race-probe.json');
const SCHEMA = 'mebular.scale-benchmark-race-probe/1';
const AGENT_ID = 'scale-bench';
const AGENT_NAME = 'Scale Benchmark';
const DOMAIN = `agent:${AGENT_ID}`;

function parseArgs(argv) {
  const options = {
    out: DEFAULT_OUT,
    records: 100,
    timeoutMs: 200,
    waitMs: 3_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        '用法: node tests/integration/scale-bench/race-probe.mjs '
        + '[--out <path>] [--records <n>] [--timeout-ms <n>] [--wait-ms <n>]\n',
      );
      process.exit(0);
    }
    const raw = argv[index + 1];
    if (raw === undefined || raw.startsWith('--')) throw new Error(`${arg} 缺少值`);
    index += 1;
    if (arg === '--out') options.out = resolve(raw);
    else if (arg === '--records') options.records = positiveInteger('--records', raw);
    else if (arg === '--timeout-ms') options.timeoutMs = positiveInteger('--timeout-ms', raw);
    else if (arg === '--wait-ms') options.waitMs = positiveInteger('--wait-ms', raw);
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function positiveInteger(name, raw) {
  if (!/^\d+$/.test(String(raw))) throw new Error(`${name} 必须是正整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitInfo() {
  try {
    const sha = run('git', ['rev-parse', 'HEAD']);
    const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = run('git', ['status', '--porcelain']);
    return {
      sha,
      shortSha: sha.slice(0, 12),
      branch,
      dirty: status.length > 0,
      dirtyFileCount: status === '' ? 0 : status.split('\n').filter(Boolean).length,
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
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function sanitize(value, tempRoot) {
  return tempRoot ? String(value).split(tempRoot).join('<temp-home>') : String(value);
}

function records(count) {
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const text = `RACE-PROBE-${String(index).padStart(4, '0')} synthetic only`;
    const messageId = `msg_race_${String(index).padStart(4, '0')}`;
    items.push({ index, text, messageId });
  }
  return items;
}

function writeBody(requestId, items) {
  return JSON.stringify({
    requestId,
    actor: { type: 'agent', agentId: AGENT_ID },
    items: items.map((item) => ({
      clientItemId: `cand_race_${String(item.index).padStart(4, '0')}`,
      domain: DOMAIN,
      kind: 'observation',
      content: { content: item.text },
      tags: ['scale-bench'],
      provenance: {
        source: 'host',
        extractor: 'host',
        model: 'host-provided',
        messageIds: [item.messageId],
        confirmation: 'none',
      },
    })),
  });
}

function responseSummary(response) {
  return {
    status: response.status,
    ok: response.body?.ok === true,
    created: response.body?.data?.created ?? null,
    duplicates: response.body?.data?.duplicates ?? null,
    failed: response.body?.data?.failed ?? null,
    replayed: response.body?.data?.replayed ?? null,
    resultIds: (response.body?.data?.results ?? []).slice(0, 3).map((entry) => entry?.id ?? null),
  };
}

async function concurrentIdempotencyProbe(options) {
  const cluster = await createCluster({ deviceCount: 1 });
  const startedAt = nowIso();
  try {
    const device = cluster.a;
    const requestId = 'req_race_probe_concurrent_0001';
    const items = records(options.records);
    const body = writeBody(requestId, items);
    const send = () => device.capability.request('/write', {
      method: 'POST',
      body,
      headers: { 'idempotency-key': requestId },
    });
    const [first, second] = await Promise.all([send(), send()]);
    const counts = (await device.capability.status(AGENT_ID)).counts;
    return {
      name: 'concurrent-idempotency',
      startedAt,
      finishedAt: nowIso(),
      requestId,
      logicalRecords: items.length,
      responses: [responseSummary(first), responseSummary(second)],
      counts,
      duplicated: typeof counts?.memoryRecords === 'number'
        ? Math.max(0, counts.memoryRecords - items.length)
        : null,
      reproduced: typeof counts?.memoryRecords === 'number'
        && counts.memoryRecords > items.length,
    };
  } finally {
    await cluster.cleanup().catch(() => undefined);
  }
}

async function retryTimeoutProbe(options) {
  const cluster = await createCluster({
    deviceCount: 1,
    a: { sidecarConfig: { capability: { timeoutMs: options.timeoutMs } } },
  });
  const startedAt = nowIso();
  try {
    const device = cluster.a;
    const items = records(options.records);
    const chunks = items.map((item) => ({
      role: 'user',
      detailKind: 'raw_chunk',
      text: item.text,
      messageId: item.messageId,
    }));
    const candidates = items.map((item) => ({
      kind: 'observation',
      content: { content: item.text },
      sourceMessageIds: [item.messageId],
      tags: ['scale-bench'],
    }));
    const response = await device.sidecar.ingest({
      requestId: 'req_race_probe_retry_0001',
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      extractor: 'host',
      chunks,
      candidates,
    });
    const before = (await device.capability.status(AGENT_ID)).counts;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, options.waitMs));
    const after = (await device.capability.status(AGENT_ID)).counts;
    const data = response.body?.data;
    return {
      name: 'retry-timeout',
      startedAt,
      finishedAt: nowIso(),
      capabilityTimeoutMs: options.timeoutMs,
      logicalRecords: items.length,
      ingestHttpStatus: response.status,
      queued: data?.queued ?? null,
      recordsReturned: data?.records?.length ?? null,
      detailsReturned: data?.detail?.ids?.length ?? null,
      warnings: response.body?.warnings ?? null,
      countsBeforeWait: before,
      countsAfterWait: after,
      duplicated: typeof after?.memoryRecords === 'number'
        ? Math.max(0, after.memoryRecords - items.length)
        : null,
      sameSignatureAs10k: typeof after?.memoryRecords === 'number'
        && typeof after?.details === 'number'
        && after.memoryRecords > items.length
        && after.details === items.length,
    };
  } finally {
    await cluster.cleanup().catch(() => undefined);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = {
    schema: SCHEMA,
    status: 'running',
    startedAt: nowIso(),
    finishedAt: null,
    command: ['node', 'tests/integration/scale-bench/race-probe.mjs', ...process.argv.slice(2)].join(' '),
    git: gitInfo(),
    environment: environmentInfo(),
    options,
    realBoundary: {
      realComponents: [
        'MCP capability HTTP server (packages/mcp/src/serve.mjs)',
        'GraphStore + MemoryService + event log (Mebular app)',
        'managed Memory Runtime sidecar process (mebular-memory-runtime)',
        'sidecar -> capability HTTP path (/ingest, /write, /detail, /status)',
      ],
      fakeOrStub: [],
      controlledInputs: [
        'concurrent-idempotency: two /write requests with identical Idempotency-Key/requestId',
        'retry-timeout: sidecar capability.timeoutMs lowered to 200ms (default 5000ms)',
      ],
    },
    probes: [],
    cleanup: null,
    error: null,
  };
  try {
    result.probes.push(await concurrentIdempotencyProbe(options));
    result.probes.push(await retryTimeoutProbe(options));
    result.status = result.probes.every((probe) => probe.reproduced || probe.sameSignatureAs10k)
      ? 'reproduced'
      : 'not-reproduced';
  } catch (error) {
    result.status = 'failed';
    result.error = { name: error?.name ?? 'Error', message: sanitize(error?.message ?? error) };
  } finally {
    result.finishedAt = nowIso();
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  }
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    probes: result.probes.map((probe) => ({
      name: probe.name,
      logicalRecords: probe.logicalRecords,
      memoryRecords: probe.countsAfterWait?.memoryRecords ?? probe.counts?.memoryRecords ?? null,
      details: probe.countsAfterWait?.details ?? probe.counts?.details ?? null,
      duplicated: probe.duplicated,
      reproduced: probe.reproduced ?? null,
      sameSignatureAs10k: probe.sameSignatureAs10k ?? null,
    })),
    out: options.out,
  }, null, 2)}\n`);
  if (result.status === 'failed') process.exitCode = 1;
}

void main();
