// Memory Runtime 运维诊断（MCP CLI / supervisor 侧）。
//
// 只读取 sidecar 自己写入的脱敏 JSONL 与 outbox 元数据；不读取 host/capability token，
// 不返回正文、prompt、真实 home 或绝对路径。CLI `memory-runtime logs|doctor|outbox`
// 与 supervisor 的崩溃/重启记录共用这里的格式与轮转规则。

import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 3;
const MAX_LINE_BYTES = 8 * 1024;
const MAX_STRING = 512;
const MAX_DEPTH = 4;
const OUTBOX_ITEM_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const OUTBOX_MAX_QUEUE_MS = 30 * 24 * 60 * 60 * 1000;
const SENSITIVE_KEY_RE = /^(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|credential|private[-_]?key|keyref|cookie)$/i;
const BODY_KEY_RE = /^(?:body|content|contents|text|prompt|prompts|response|responses|messages|message|chunks?|items?|payload|raw|detailtext)$/i;
const PATH_RE = /(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\Users\\)[^\s"'\\]*/g;
const SECRET_SHAPE_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|meb_[A-Za-z0-9]{16,})\b/g;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeString(value) {
  return String(value)
    .replace(SECRET_SHAPE_RE, '[redacted]')
    .replace(PATH_RE, '[path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, MAX_STRING);
}

function sanitizeValue(value, key, depth) {
  if (key && SENSITIVE_KEY_RE.test(key)) return '[redacted]';
  if (key && BODY_KEY_RE.test(key)) return '[omitted]';
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizeValue(entry, undefined, depth + 1));
  if (isObject(value)) {
    const out = {};
    let count = 0;
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (entryValue === undefined) continue;
      out[entryKey] = sanitizeValue(entryValue, entryKey, depth + 1);
      count += 1;
      if (count >= 40) break;
    }
    return out;
  }
  return '[truncated]';
}

export function sanitizeMemoryRuntimeEvent(event) {
  const source = isObject(event) ? event : {};
  const out = {
    ts: Number.isFinite(source.ts) ? Math.floor(source.ts) : Date.now(),
    level: source.level === 'warn' || source.level === 'error' ? source.level : 'info',
    event: sanitizeString(source.event ?? 'unknown'),
  };
  for (const [key, value] of Object.entries(source)) {
    if (key === 'ts' || key === 'level' || key === 'event') continue;
    out[key] = sanitizeValue(value, key, 0);
  }
  return out;
}

function logFiles(dataDir) {
  const dir = join(dataDir, 'logs');
  const current = join(dir, 'runtime.jsonl');
  return {
    dir,
    current,
    rotated: (index) => `${current}.${index}`,
    all: [current, `${current}.1`, `${current}.2`],
  };
}

async function rotateLogUnlocked(paths, extraBytes, maxBytes, maxFiles) {
  let size = 0;
  try {
    size = (await stat(paths.current)).size;
  } catch {
    size = 0;
  }
  if (size === 0 || size + extraBytes <= maxBytes) return;
  if (maxFiles === 1) {
    await rm(paths.current, { force: true }).catch(() => undefined);
    return;
  }
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const source = index === 1 ? paths.current : paths.rotated(index - 1);
    const target = paths.rotated(index);
    if (index === maxFiles - 1) await rm(target, { force: true }).catch(() => undefined);
    try {
      await rename(source, target);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export async function appendMemoryRuntimeLog(dataDir, event, {
  now = Date.now,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) return null;
  const paths = logFiles(dataDir);
  const sanitized = sanitizeMemoryRuntimeEvent({ ts: now(), ...event });
  let line = `${JSON.stringify(sanitized)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    line = `${JSON.stringify({
      ts: sanitized.ts,
      level: sanitized.level,
      event: sanitized.event,
      truncated: true,
    })}\n`;
  }
  try {
    await mkdir(paths.dir, { recursive: true, mode: 0o700 });
    await chmod(paths.dir, 0o700).catch(() => undefined);
    await rotateLogUnlocked(paths, Buffer.byteLength(line, 'utf8'), Math.max(256, maxBytes), Math.max(1, maxFiles));
    const handle = await open(paths.current, 'a', 0o600);
    try {
      await handle.write(line, null, 'utf8');
      await handle.chmod(0o600).catch(() => undefined);
    } finally {
      await handle.close().catch(() => undefined);
    }
    return sanitized;
  } catch {
    // 诊断日志失败不得影响主流程。
    return null;
  }
}

/** 同步版本：用于 child exit 等不能在异步写日志期间被测试清理打断的生命周期回调。 */
export function appendMemoryRuntimeLogSync(dataDir, event, {
  now = Date.now,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) return null;
  const paths = logFiles(dataDir);
  const sanitized = sanitizeMemoryRuntimeEvent({ ts: now(), ...event });
  let line = `${JSON.stringify(sanitized)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    line = `${JSON.stringify({
      ts: sanitized.ts,
      level: sanitized.level,
      event: sanitized.event,
      truncated: true,
    })}\n`;
  }
  try {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    chmodSync(paths.dir, 0o700);
    let size = 0;
    try {
      size = statSync(paths.current).size;
    } catch {
      size = 0;
    }
    const limit = Math.max(256, maxBytes);
    const files = Math.max(1, maxFiles);
    if (size > 0 && size + Buffer.byteLength(line, 'utf8') > limit) {
      if (files === 1) {
        try { rmSync(paths.current, { force: true }); } catch { /* ignore */ }
      } else {
        for (let index = files - 1; index >= 1; index -= 1) {
          const source = index === 1 ? paths.current : paths.rotated(index - 1);
          const target = paths.rotated(index);
          if (index === files - 1) {
            try { rmSync(target, { force: true }); } catch { /* ignore */ }
          }
          try { renameSync(source, target); } catch { /* ENOENT */ }
        }
      }
    }
    appendFileSync(paths.current, line, { mode: 0o600 });
    chmodSync(paths.current, 0o600);
    return sanitized;
  } catch {
    return null;
  }
}

export async function readMemoryRuntimeLogs(dataDir, { limit = 50, maxFiles = DEFAULT_MAX_FILES } = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) return [];
  const paths = logFiles(dataDir);
  const files = [paths.current];
  for (let index = 1; index < Math.max(1, maxFiles); index += 1) files.push(paths.rotated(index));
  const events = [];
  for (const file of files) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line);
        if (isObject(parsed) && typeof parsed.event === 'string') {
          events.push(sanitizeMemoryRuntimeEvent(parsed));
        }
      } catch {
        // 损坏行忽略。
      }
    }
  }
  events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return events.slice(-Math.max(1, Math.min(500, Math.floor(limit))));
}

export async function memoryRuntimeLogStatus(dataDir) {
  const paths = logFiles(dataDir);
  let files = 0;
  let bytes = 0;
  for (const file of paths.all) {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size === 0) continue;
      files += 1;
      bytes += info.size;
    } catch {
      // ignore
    }
  }
  const recent = await readMemoryRuntimeLogs(dataDir, { limit: 1 });
  return {
    files,
    bytes,
    latestAt: recent.length > 0 && typeof recent[0].ts === 'number' ? recent[0].ts : null,
  };
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

function operationOf(item) {
  const kind = item?.meta?.kind;
  if (kind === 'detail' || item?.endpoint === '/detail') return 'detail';
  if (kind === 'record' || item?.endpoint === '/write') return 'record';
  if (item?.endpoint === '/internal-object') {
    const bodyKind = isObject(item.body) && typeof item.body.kind === 'string' ? item.body.kind : '';
    if (bodyKind === 'compact') return 'compact';
    if (bodyKind === 'context_checkpoint') return 'checkpoint';
    if (bodyKind === 'self_record') return 'self';
  }
  return 'other';
}

function failureOf(item) {
  const failure = isObject(item?.lastFailure) ? item.lastFailure : null;
  if (failure && typeof failure.code === 'string') {
    return {
      code: failure.code,
      at: typeof failure.at === 'number' ? failure.at : (item.lastAttemptAt ?? item.createdAt ?? 0),
      ...(typeof failure.status === 'number' ? { status: failure.status } : {}),
      ...(typeof failure.stage === 'string' ? { stage: failure.stage } : {}),
      ...(typeof failure.disposition === 'string' ? { disposition: failure.disposition } : {}),
      ...(isObject(failure.details) ? { details: sanitizeValue(failure.details, undefined, 0) } : {}),
      ...(failure.possibleCommit === true ? { possibleCommit: true } : {}),
    };
  }
  const code = typeof item?.error === 'string' ? item.error : (typeof item?.lastError === 'string' ? item.lastError : null);
  if (!code) return null;
  return {
    code,
    at: item.lastAttemptAt ?? item.createdAt ?? 0,
    ...(typeof item.failureStage === 'string' ? { stage: item.failureStage } : {}),
  };
}

function outboxMetadata(item, { dead = false } = {}) {
  const body = isObject(item?.body) ? item.body : {};
  const failure = failureOf(item);
  const committed = isObject(item?.committed) ? item.committed : null;
  const committedObjects = committed
    ? {
      records: Array.isArray(committed.records) ? committed.records.map((entry) => entry?.id).filter((id) => typeof id === 'string') : [],
      details: Array.isArray(committed.details) ? committed.details.map((entry) => entry?.id).filter((id) => typeof id === 'string') : [],
      objects: Array.isArray(committed.objects) ? committed.objects.map((entry) => entry?.id).filter((id) => typeof id === 'string') : [],
    }
    : null;
  return {
    id: item.id,
    requestId: item.requestId,
    endpoint: item.endpoint,
    operation: operationOf(item),
    createdAt: item.createdAt,
    attempts: item.attempts,
    lastAttemptAt: item.lastAttemptAt ?? null,
    revision: typeof body.expectedRevision === 'number' ? body.expectedRevision : null,
    ...(typeof item.failureStage === 'string' ? { failureStage: item.failureStage } : {}),
    ...(dead && typeof item.deadAt === 'number' ? { deadAt: item.deadAt } : {}),
    ...(dead && typeof item.error === 'string' ? { reason: item.error } : {}),
    ...(failure ? { lastFailure: failure } : {}),
    ...(committedObjects ? { committedObjects } : {}),
  };
}

async function readOutboxDir(root) {
  const items = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return items;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const item = await readJson(join(root, entry.name));
    if (isObject(item) && item.version === 1 && typeof item.id === 'string') items.push(item);
  }
  items.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)));
  return items;
}

function aggregate(items, dead, now) {
  const rows = new Map();
  const reasons = new Map();
  const apply = (item, isDead, keyOf) => {
    const key = keyOf(item);
    const row = rows.get(key) ?? {
      operation: operationOf(item),
      endpoint: item.endpoint,
      active: 0,
      dead: 0,
      oldestAt: null,
      deadOldestAt: null,
      lastFailure: null,
    };
    if (isDead) {
      row.dead += 1;
      const at = typeof item.deadAt === 'number' ? item.deadAt : item.createdAt;
      row.deadOldestAt = row.deadOldestAt === null ? at : Math.min(row.deadOldestAt, at);
    } else {
      row.active += 1;
      row.oldestAt = row.oldestAt === null ? item.createdAt : Math.min(row.oldestAt, item.createdAt);
    }
    const failure = failureOf(item);
    if (failure && (!row.lastFailure || failure.at >= row.lastFailure.at)) row.lastFailure = failure;
    rows.set(key, row);
  };
  for (const item of items) apply(item, false, (entry) => operationOf(entry));
  for (const item of dead) apply(item, true, (entry) => operationOf(entry));
  const byOperation = [...rows.values()].map((row) => ({
    operation: row.operation,
    endpoint: row.endpoint,
    active: row.active,
    dead: row.dead,
    oldestAgeMs: row.oldestAt === null ? null : Math.max(0, now - row.oldestAt),
    deadOldestAgeMs: row.deadOldestAt === null ? null : Math.max(0, now - row.deadOldestAt),
    lastFailure: row.lastFailure
      ? {
        code: row.lastFailure.code,
        at: row.lastFailure.at,
        ...(row.lastFailure.stage ? { stage: row.lastFailure.stage } : {}),
        ...(row.lastFailure.disposition ? { disposition: row.lastFailure.disposition } : {}),
      }
      : null,
  })).sort((a, b) => a.operation.localeCompare(b.operation));
  const endpoints = new Map();
  for (const item of items) {
    const row = endpoints.get(item.endpoint) ?? { endpoint: item.endpoint, active: 0, dead: 0 };
    row.active += 1;
    endpoints.set(item.endpoint, row);
  }
  for (const item of dead) {
    const row = endpoints.get(item.endpoint) ?? { endpoint: item.endpoint, active: 0, dead: 0 };
    row.dead += 1;
    endpoints.set(item.endpoint, row);
  }
  const byEndpoint = [...endpoints.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  for (const item of dead) {
    const reason = typeof item.error === 'string' && item.error.length > 0
      ? item.error
      : (item.lastFailure?.code ?? 'unknown');
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const all = [...items.map((item) => ({ item, failure: failureOf(item) })),
    ...dead.map((item) => ({ item, failure: failureOf(item) }))];
  const conflicts = all
    .filter((entry) => entry.failure && (entry.failure.disposition === 'conflict'
      || entry.failure.code === 'revision_mismatch'
      || entry.failure.code === 'checkpoint_lease_held'))
    .sort((a, b) => b.failure.at - a.failure.at);
  const latest = conflicts[0];
  const ambiguous = all
    .filter((entry) => entry.failure && (entry.failure.possibleCommit === true
      || entry.failure.code === 'timeout'
      || entry.failure.code === 'network_error'
      || entry.failure.code === 'partial_failure'))
    .map(({ item, failure }) => ({
      requestId: item.requestId,
      endpoint: item.endpoint,
      operation: operationOf(item),
      ...(failure.stage ? { stage: failure.stage } : {}),
      reason: failure.code,
      at: failure.at,
      ageMs: Math.max(0, now - failure.at),
      possiblyCommitted: true,
      hint: 'may_have_been_committed',
      reconciliation: 'read_authoritative_objects',
      ...(isObject(item.committed) ? {
        committedObjects: {
          records: Array.isArray(item.committed.records) ? item.committed.records.map((entry) => entry?.id).filter((id) => typeof id === 'string') : [],
          details: Array.isArray(item.committed.details) ? item.committed.details.map((entry) => entry?.id).filter((id) => typeof id === 'string') : [],
          objects: Array.isArray(item.committed.objects) ? item.committed.objects.map((entry) => entry?.id).filter((id) => typeof id === 'string') : [],
        },
      } : {}),
    }))
    .sort((a, b) => b.at - a.at);
  return {
    active: items.length,
    dead: dead.length,
    byOperation,
    byEndpoint,
    deadReasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    lastConflict: latest
      ? {
        code: latest.failure.code,
        at: latest.failure.at,
        endpoint: latest.item.endpoint,
        operation: operationOf(latest.item),
        requestId: latest.item.requestId,
        ...(typeof latest.failure.status === 'number' ? { status: latest.failure.status } : {}),
        ...(typeof latest.failure.details?.currentRevision === 'number'
          ? { currentRevision: latest.failure.details.currentRevision } : {}),
        ...(typeof latest.failure.details?.expectedRevision === 'number'
          ? { expectedRevision: latest.failure.details.expectedRevision }
          : isObject(latest.item.body) && typeof latest.item.body.expectedRevision === 'number'
            ? { expectedRevision: latest.item.body.expectedRevision } : {}),
        ...(typeof latest.failure.details?.hostId === 'string'
          ? { hostId: latest.failure.details.hostId } : {}),
        ...(typeof latest.failure.details?.until === 'number'
          ? { until: latest.failure.details.until } : {}),
        ...(latest.failure.stage ? { stage: latest.failure.stage } : {}),
      }
      : null,
    ambiguous,
  };
}

export async function inspectMemoryRuntimeOutbox(dataDir, { now = Date.now(), includeItems = false } = {}) {
  const active = await readOutboxDir(join(dataDir, 'outbox'));
  const dead = await readOutboxDir(join(dataDir, 'outbox', 'dead'));
  const summary = aggregate(active, dead, now);
  const oldestAt = active.reduce((oldest, item) => oldest === null ? item.createdAt : Math.min(oldest, item.createdAt), null);
  const deadOldestAt = dead.reduce((oldest, item) => {
    const at = typeof item.deadAt === 'number' ? item.deadAt : item.createdAt;
    return oldest === null ? at : Math.min(oldest, at);
  }, null);
  return {
    ...summary,
    oldestAgeMs: oldestAt === null ? null : Math.max(0, now - oldestAt),
    deadOldestAgeMs: deadOldestAt === null ? null : Math.max(0, now - deadOldestAt),
    ...(includeItems ? {
      items: [
        ...active.map((item) => outboxMetadata(item)),
        ...dead.map((item) => outboxMetadata(item, { dead: true })),
      ],
    } : {}),
  };
}

export async function rebuildMemoryRuntimeOutboxItem(dataDir, id, {
  expectedRevision,
  now = Date.now(),
} = {}) {
  if (typeof id !== 'string' || !OUTBOX_ITEM_RE.test(id)) {
    const error = new Error('outbox id 格式非法');
    error.code = 'invalid_outbox_item';
    throw error;
  }
  const activePath = join(dataDir, 'outbox', `${id}.json`);
  const deadPath = join(dataDir, 'outbox', 'dead', `${id}.json`);
  const active = await readJson(activePath);
  const dead = await readJson(deadPath);
  const source = isObject(active) && active.version === 1 ? active : (isObject(dead) && dead.version === 1 ? dead : null);
  if (!source) {
    const error = new Error('outbox 项不存在');
    error.code = 'outbox_not_found';
    throw error;
  }
  const body = isObject(source.body) ? JSON.parse(JSON.stringify(source.body)) : {};
  if (expectedRevision !== undefined) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      const error = new Error('--expected-revision 必须是非负整数');
      error.code = 'usage';
      throw error;
    }
    body.expectedRevision = expectedRevision;
  }
  const rebuilt = {
    ...source,
    body,
    createdAt: now,
    expiresAt: now + OUTBOX_MAX_QUEUE_MS,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    nextAttemptAt: undefined,
    replayLeaseUntil: undefined,
    replayLeaseOwner: undefined,
    replayLeaseMs: undefined,
    replayLeaseGeneration: undefined,
    meta: {
      ...(isObject(source.meta) ? source.meta : {}),
      manualRebuild: true,
      rebuiltAt: now,
      ...(expectedRevision !== undefined ? { manualExpectedRevision: expectedRevision } : {}),
    },
  };
  delete rebuilt.deadAt;
  delete rebuilt.error;
  delete rebuilt.lastFailure;
  delete rebuilt.failureStage;
  await mkdir(join(dataDir, 'outbox'), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(activePath, rebuilt);
  await rm(deadPath, { force: true });
  return outboxMetadata(rebuilt);
}

export async function purgeMemoryRuntimeOutboxItem(dataDir, id) {
  if (typeof id !== 'string' || !OUTBOX_ITEM_RE.test(id)) {
    const error = new Error('outbox id 格式非法');
    error.code = 'invalid_outbox_item';
    throw error;
  }
  const paths = [
    join(dataDir, 'outbox', `${id}.json`),
    join(dataDir, 'outbox', 'dead', `${id}.json`),
    join(dataDir, 'outbox', 'reconcile', `${id}.json`),
  ];
  let removed = 0;
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      await rm(path);
      removed += 1;
    } catch {
      // 不存在即未删除。
    }
  }
  return { id, removed };
}

async function directoryBytes(root) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(path);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += (await stat(path)).size;
    } catch {
      // ignore
    }
  }
  return total;
}

export async function memoryRuntimeDiskUsage(dataDir) {
  const [staging, cache, outbox, logs, models] = await Promise.all([
    directoryBytes(join(dataDir, 'staging')),
    directoryBytes(join(dataDir, 'cache')),
    directoryBytes(join(dataDir, 'outbox')),
    directoryBytes(join(dataDir, 'logs')),
    directoryBytes(join(dataDir, 'models')),
  ]);
  const traceBytes = await stat(join(dataDir, 'traces.jsonl')).then((info) => info.size).catch(() => 0);
  return {
    stagingBytes: staging,
    traceBytes,
    cacheBytes: cache,
    outboxBytes: outbox,
    logsBytes: logs,
    modelsBytes: models,
    totalBytes: staging + traceBytes + cache + outbox + logs + models,
  };
}

async function countJsonFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    count += 1;
  }
  return count;
}

async function countJsonlLines(file) {
  try {
    const text = await readFile(file, 'utf8');
    return text.split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

export async function inspectMemoryRuntimeLocalCounts(dataDir) {
  const [stagingChunks, traces, cacheEntries, detailCacheEntries, outbox, dead] = await Promise.all([
    countJsonlLines(join(dataDir, 'staging', 'chunks.jsonl')),
    countJsonlLines(join(dataDir, 'traces.jsonl')),
    countJsonFiles(join(dataDir, 'cache')),
    countJsonFiles(join(dataDir, 'cache', 'details')),
    countJsonFiles(join(dataDir, 'outbox')),
    countJsonFiles(join(dataDir, 'outbox', 'dead')),
  ]);
  return {
    stagingChunks,
    traces,
    cacheEntries,
    detailCacheEntries,
    outboxItems: outbox,
    deadItems: dead,
  };
}

