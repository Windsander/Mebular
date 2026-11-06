#!/usr/bin/env node
// v0.3.2 升级/回滚演练的版本内驱动。
//
// 该文件由 `run-upgrade-rollback.mjs` 复制到“旧版/当前版”各自的构建目录旁并执行；
// 它只通过该版本的 dist/源码启动真实 Mebular + 真实 capability HTTP + 真实 managed
// sidecar，不使用 fake capability、fake 图或产品代码替身。
//
// 环境变量：
//   BUILD_DIR       必填，构建目录（包含 dist/ 与 packages/）
//   MEBULAR_HOME    必填，临时 home（绝不指向真实用户 home）
//   STAGE           seed | upgrade | rollback
//   PREVIOUS_FILE   上一阶段结果 JSON（upgrade/rollback 必填）
//   RESULT_FILE     本阶段结果 JSON 输出路径
//   UPGRADE_RUN_ID  本次运行标识（由编排器生成）

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BUILD_DIR = process.env.BUILD_DIR;
const HOME = process.env.MEBULAR_HOME;
const STAGE = process.env.STAGE;
const PREVIOUS_FILE = process.env.PREVIOUS_FILE ?? null;
const RESULT_FILE = process.env.RESULT_FILE;
const RUN_ID = process.env.UPGRADE_RUN_ID;
const AGENT_ID = 'opencode';
const THREAD_ID = `thread-upgrade-${RUN_ID}`;

if (!BUILD_DIR || !HOME || !STAGE || !RESULT_FILE || !RUN_ID) {
  throw new Error('BUILD_DIR / MEBULAR_HOME / STAGE / RESULT_FILE / UPGRADE_RUN_ID 均为必填');
}
if (!['seed', 'upgrade', 'rollback'].includes(STAGE)) {
  throw new Error(`未知 STAGE：${STAGE}`);
}

const markers = {
  user: null,
  defaultNamespace: null,
  current: null,
  currentRaw: null,
  currentTool: null,
  currentDoc: null,
  recordTool: null,
  recordDoc: null,
  raw: null,
  tool: null,
  doc: null,
  defaultDetail: null,
  compactUser: null,
  compactDefault: null,
  compactCurrent: null,
  checkpointGoal: null,
  checkpointGoalV2: null,
  selfName: null,
  selfNameV2: null,
};

const buildImport = (rel) => import(pathToFileURL(join(BUILD_DIR, rel)).href);
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// 每个对象使用独立的不可预测 marker，避免 recall 把 compact 摘要当成来源记录。
for (const [label, key] of Object.entries({
  user: 'user',
  defaultNamespace: 'default',
  current: 'current',
  currentRaw: 'current-raw',
  currentTool: 'current-tool',
  currentDoc: 'current-doc',
  recordTool: 'record-tool',
  recordDoc: 'record-doc',
  raw: 'detail-raw',
  tool: 'detail-tool',
  doc: 'detail-doc',
  defaultDetail: 'detail-default',
  compactUser: 'compact-user',
  compactDefault: 'compact-default',
  compactCurrent: 'compact-current',
  checkpointGoal: 'checkpoint',
  checkpointGoalV2: 'checkpoint-v2',
  selfName: 'self',
  selfNameV2: 'self-v2',
})) {
  markers[label] = `${key[0]}${sha256(`${RUN_ID}:${key}`).slice(0, 23)}`;
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stable(entry)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function safeMessage(error) {
  return String(error?.message ?? error).replaceAll(HOME, '<temp-home>');
}

async function fileInfo(file) {
  try {
    const info = await stat(file);
    const bytes = await readFile(file);
    return { exists: true, bytes: info.size, sha256: sha256(bytes), mtimeMs: info.mtimeMs };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

const { IdentityManager, Mebular, MemoryService } = await buildImport('dist/index.js');
const { startHttpServer } = await buildImport('packages/mcp/src/serve.mjs');
const { buildServer } = await buildImport('packages/mcp/src/server.mjs');
const { readCapabilityToken } = await buildImport('packages/mcp/src/memory-runtime-token.mjs');
const { Client, StreamableHTTPClientTransport } = await import(
  pathToFileURL(join(BUILD_DIR, 'node_modules/@modelcontextprotocol/client/dist/index.mjs')).href
);

const result = {
  stage: STAGE,
  ok: false,
  startedAt: new Date().toISOString(),
  runId: RUN_ID,
  build: null,
  markers,
  identity: null,
  mcp: null,
  cli: null,
  checks: {},
  objects: {},
  snapshotBefore: null,
  snapshotAfter: null,
  fileAfterClose: null,
  errors: [],
};
let fatal = null;
let app = null;
let service = null;
let server = null;
let mcp = null;
let capabilityToken = null;
let discovery = null;
const checksFailed = [];

function recordCheck(name, ok, actual = undefined, { informational = false } = {}) {
  result.checks[name] = {
    ok: Boolean(ok),
    ...(informational ? { informational: true } : {}),
    ...(actual === undefined ? {} : { actual }),
  };
  if (!ok && !informational) checksFailed.push(name);
  return Boolean(ok);
}

async function softCheck(name, run, options = {}) {
  try {
    return await run();
  } catch (error) {
    recordCheck(name, false, { error: safeMessage(error) }, options);
    return null;
  }
}

function hardCheck(name, ok, actual = undefined) {
  if (!recordCheck(name, ok, actual)) throw new Error(`${name}: ${JSON.stringify(actual)}`);
}

async function capability(path, { method = 'POST', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}/internal/memory/v1${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${capabilityToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok || parsed?.ok !== true) {
    const code = parsed?.error?.code ?? `http_${response.status}`;
    const message = parsed?.error?.message ?? text.slice(0, 200);
    throw new Error(`${path} ${response.status} ${code}: ${message}`);
  }
  return parsed.data;
}

async function sidecarRequest(path, { method = 'GET', body } = {}) {
  const token = await readSidecarToken(discovery);
  const response = await fetch(`${discovery.url}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok || parsed?.ok !== true) {
    const code = parsed?.error?.code ?? `http_${response.status}`;
    const message = parsed?.error?.message ?? text.slice(0, 200);
    throw new Error(`${path} ${response.status} ${code}: ${message}`);
  }
  return parsed.data;
}

async function readSidecarToken(record) {
  if (typeof record?.tokenFile !== 'string' || record.tokenFile.length === 0) return '';
  const raw = String(await readFile(record.tokenFile, 'utf8')).trim();
  if (raw.length === 0) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === 'string') return parsed.token.trim();
  } catch {
    // 裸 token 文件。
  }
  return raw;
}

async function mcpCall(name, args) {
  const response = await mcp.callTool({ name, arguments: args });
  const structured = response?.structuredContent ?? (() => {
    const text = response?.content?.find((entry) => entry.type === 'text')?.text ?? '';
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  if (response?.isError === true) {
    throw new Error(`${name} 返回错误：${JSON.stringify(structured).slice(0, 300)}`);
  }
  if (structured === null) throw new Error(`${name} 无结构化结果`);
  return structured;
}

async function waitForSidecar() {
  const deadline = Date.now() + 40_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(await readFile(join(HOME, 'memory-runtime.json'), 'utf8'));
      if (record.state === 'ready' && typeof record.url === 'string') {
        const health = await fetch(`${record.url}/health`, { signal: AbortSignal.timeout(2000) });
        const body = await health.json().catch(() => null);
        if (health.ok && body?.ready === true) return record;
      }
      last = record;
    } catch (error) {
      last = { error: safeMessage(error) };
    }
    await sleep(150);
  }
  throw new Error(`sidecar 未就绪：${JSON.stringify(last)}`);
}

async function mkdirHome() {
  await mkdir(HOME, { recursive: true });
  const keyFile = join(HOME, 'user-master-key.json');
  let master;
  if (existsSync(keyFile)) {
    const saved = await readJson(keyFile);
    master = {
      publicKey: Buffer.from(saved.publicKey, 'base64'),
      privateKey: await IdentityManager.importPrivateKey(saved.privateKeyPkcs8),
    };
  } else {
    master = await new IdentityManager().generateUserMasterKey();
    await writeFile(keyFile, JSON.stringify({
      publicKey: Buffer.from(master.publicKey).toString('base64'),
      privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
      createdAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
  }
  const dataDir = join(HOME, 'memory-runtime');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const homeConfig = join(HOME, 'config.json');
  if (!existsSync(homeConfig)) {
    await writeFile(homeConfig, JSON.stringify({
      storagePath: join(HOME, 'device.jsonl'),
      storageAdapter: 'json',
      deviceId: 'device-upgrade-rollback',
      encryption: { level: 'none' },
      memoryRuntime: { enabled: true, startTimeoutMs: 20_000 },
      mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none', tls: false } },
      network: { enabled: false },
      sync: { autoSync: false },
    }, null, 2), { mode: 0o600 });
  }
  const configFile = join(dataDir, 'config.json');
  if (!existsSync(configFile)) {
    await writeFile(configFile, JSON.stringify({
      schema: 1,
      http: { host: '127.0.0.1', port: 0 },
    }, null, 2), { mode: 0o600 });
  }
  return master;
}

async function start() {
  const master = await mkdirHome();
  process.env.MEBULAR_CLOUD_ROOT = join(HOME, 'cloud');
  process.env.MEBULAR_HOME = HOME;
  app = new Mebular({
    storagePath: join(HOME, 'device.jsonl'),
    deviceId: 'device-upgrade-rollback',
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    network: { enabled: false },
    sync: { autoSync: false },
  });
  await app.initialize();
  service = new MemoryService(app);
  server = await startHttpServer({
    home: HOME,
    app,
    service,
    buildServer,
    config: { memoryRuntime: { enabled: true, startTimeoutMs: 20_000 } },
    host: '127.0.0.1',
    port: 0,
    auth: 'none',
    manageMemoryRuntime: true,
  });
  discovery = await waitForSidecar();
  capabilityToken = (await readCapabilityToken({ home: HOME }))?.token;
  if (typeof capabilityToken !== 'string' || capabilityToken.length === 0) {
    throw new Error('capability token 缺失');
  }
  mcp = new Client({ name: 'mebular-upgrade-rollback', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
}

async function snapshot() {
  const nodes = await app.graph.listNodes();
  const events = await app.eventLog.listEvents();
  const status = await service.status();
  const capStatus = await capability('/status?actor=user', { method: 'GET' });
  const nodeViews = nodes.map((node) => ({
    id: node.id,
    type: node.type,
    namespace: node.namespace ?? 'default',
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null,
    deletedAt: node.deletedAt ?? null,
    contentHash: sha256(stable(node.content ?? null)),
    internalKind: node.metadata?.internalObject?.kind ?? null,
    internalRevision: node.metadata?.internalObject?.revision ?? null,
  })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const eventViews = events.map((event) => ({
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    namespace: event.namespace ?? 'default',
    author: event.author,
    dataHash: sha256(stable(event.data ?? null)),
  }));
  return {
    at: new Date().toISOString(),
    status: {
      deviceId: status.deviceId,
      nodeCount: status.nodeCount,
      edgeCount: status.edgeCount,
      stateHash: status.stateHash,
      stateHashByNamespace: status.stateHashByNamespace,
      pendingEventCount: status.pendingEventCount,
    },
    identity: {
      userId: capStatus.identity?.userId ?? null,
      deviceId: capStatus.identity?.deviceId ?? null,
      cloudId: capStatus.identity?.cloudId ?? null,
      profileId: capStatus.identity?.profileId ?? null,
      hostId: capStatus.identity?.hostId ?? null,
    },
    counts: capStatus.counts ?? null,
    nodes: nodeViews,
    events: eventViews,
    sidecarConfig: await fileInfo(join(HOME, 'memory-runtime', 'config.json')),
  };
}

async function cliProbes() {
  const cliBin = join(BUILD_DIR, 'packages/mcp/bin/mebular.mjs');
  const env = { ...process.env, MEBULAR_HOME: HOME };
  let version;
  try {
    version = {
      supported: true,
      output: execFileSync(process.execPath, [cliBin, '--version'], {
        env,
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    };
  } catch (error) {
    version = {
      supported: false,
      output: String(error?.stderr ?? error?.message ?? error).trim().slice(0, 200),
    };
  }
  const statusRaw = execFileSync(process.execPath, [cliBin, 'memory-runtime', 'status', '--json', '--home', HOME], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
  const status = JSON.parse(statusRaw);
  return {
    version,
    memoryRuntime: {
      ok: status.ok,
      enabled: status.enabled,
      state: status.state,
      available: status.available,
      managed: status.managed,
      runtimeVersion: status.runtimeVersion ?? null,
      apiVersion: status.apiVersion ?? null,
      installed: status.installed,
    },
  };
}

async function writeDetail(recordId, domain, detailKind, role, text) {
  const data = await capability('/detail', {
    body: {
      actor: { type: 'user' },
      op: 'write',
      items: [{
        domain,
        detailKind,
        role,
        recordIds: [recordId],
        text,
        provenance: { source: 'runtime', extractor: 'host' },
      }],
    },
  });
  const entry = data.results?.[0];
  if (!entry || entry.status === 'failed' || typeof entry.id !== 'string') {
    throw new Error(`detail 写入失败：${JSON.stringify(entry)}`);
  }
  return entry.id;
}

async function listDetails(recordId) {
  const data = await capability('/detail', {
    body: { actor: { type: 'user' }, op: 'list', recordIds: [recordId], limit: 20 },
  });
  return data.details ?? [];
}

async function getDetail(id) {
  const data = await capability('/detail', {
    body: { actor: { type: 'user' }, op: 'get', id, includeText: true },
  });
  return data.detail;
}

async function upsertCompact(domain, sourceIds, summary) {
  const data = await capability('/internal-object', {
    body: {
      actor: { type: 'user' },
      kind: 'compact',
      op: 'upsert',
      domain,
      sourceIds,
      summary,
      strategy: 'summary',
      tokenCount: 42,
    },
  });
  return data.object;
}

async function upsertCheckpoint({ expectedRevision, goal, recordId, detailId }) {
  const data = await capability('/internal-object', {
    body: {
      actor: { type: 'user' },
      kind: 'context_checkpoint',
      op: 'upsert',
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      domain: 'default',
      expectedRevision,
      state: {
        schema: 2,
        contentMode: 'structured',
        task: { key: 'default', threadId: THREAD_ID, fleetTaskId: null },
        goal,
        constraints: [],
        decisions: [],
        progress: { done: [], doing: [], blocked: [] },
        nextSteps: [{ id: 'n1', text: 'verify upgrade/rollback' }],
        files: [],
        openQuestions: [],
        references: {
          recordIds: recordId ? [recordId] : [],
          detailIds: detailId ? [detailId] : [],
          messageIds: [],
          fleetTaskId: null,
          urls: [],
        },
      },
      summary: goal,
      leaseMs: 60_000,
    },
  });
  return data.object;
}

async function upsertSelf({ expectedRevision, name }) {
  const data = await capability('/internal-object', {
    body: {
      actor: { type: 'user' },
      kind: 'self_record',
      op: 'upsert',
      agentId: AGENT_ID,
      expectedRevision,
      record: {
        displayName: name,
        goals: ['preserve upgrade/rollback data'],
        traits: ['careful'],
        preferences: { tone: 'direct' },
        capabilities: ['code'],
        boundaries: ['no secrets'],
      },
    },
  });
  return data.object;
}

async function getInternal(kind, extra) {
  const data = await capability('/internal-object', {
    body: { actor: { type: 'user' }, kind, op: 'get', ...extra },
  });
  return data.object;
}

async function queryMarker(marker) {
  const data = await mcpCall('memory_query', { query: marker, limit: 10 });
  return data.memories ?? [];
}

async function recallAndExpand(marker) {
  const recall = await sidecarRequest('/recall', {
    method: 'POST',
    body: { agentId: AGENT_ID, query: marker, domains: ['user', 'default'] },
  });
  const fragment = (recall.fragments ?? []).find((entry) => {
    const haystack = `${entry.gist ?? ''} ${entry.summary ?? ''}`;
    return haystack.includes(marker);
  }) ?? (recall.fragments ?? [])[0] ?? null;
  if (!fragment) {
    return { fragment: false, expanded: false, warnings: recall.warnings ?? [], recallId: recall.recallId ?? null };
  }
  const expanded = await sidecarRequest(`/recall/${encodeURIComponent(recall.recallId)}/expand`, {
    method: 'POST',
    body: { agentId: AGENT_ID, fragmentId: fragment.id, maxBytes: 4096 },
  });
  return {
    fragment: true,
    fragmentId: fragment.id,
    detailAvailable: fragment.detailAvailable ?? null,
    detailKinds: fragment.detailKinds ?? [],
    expanded: Boolean(expanded.detail),
    detailKind: expanded.detail?.detailKind ?? null,
    text: expanded.detail?.text ?? null,
    source: expanded.detail?.source ?? null,
    stale: expanded.detail?.stale ?? null,
    warnings: [...(recall.warnings ?? []), ...(expanded.warnings ?? [])],
  };
}

function detailSummary(details) {
  return details.map((detail) => ({
    id: detail.id,
    detailKind: detail.detailKind,
    retentionClass: detail.retentionClass,
    expiresAt: detail.expiresAt,
    availability: detail.availability,
    text: detail.text,
    recordIds: detail.recordIds,
  }));
}

async function seedStage() {
  const user = await mcpCall('memory_write', {
    items: [{ type: 'fact', content: markers.user, metadata: { namespace: 'user' } }],
  });
  const userRecordId = user.stored?.[0]?.id;
  hardCheck('seed.userRecordCreated', typeof userRecordId === 'string', { id: userRecordId ?? null });

  const toolRecord = await mcpCall('memory_write', {
    items: [{ type: 'fact', content: markers.recordTool, metadata: { namespace: 'user' } }],
  });
  const toolRecordId = toolRecord.stored?.[0]?.id;
  hardCheck('seed.toolRecordCreated', typeof toolRecordId === 'string', { id: toolRecordId ?? null });

  const docRecord = await mcpCall('memory_write', {
    items: [{ type: 'fact', content: markers.recordDoc, metadata: { namespace: 'user' } }],
  });
  const docRecordId = docRecord.stored?.[0]?.id;
  hardCheck('seed.docRecordCreated', typeof docRecordId === 'string', { id: docRecordId ?? null });

  const defaultRecord = await mcpCall('memory_write', {
    items: [{ type: 'fact', content: markers.defaultNamespace }],
  });
  const defaultRecordId = defaultRecord.stored?.[0]?.id;
  hardCheck('seed.defaultRecordCreated', typeof defaultRecordId === 'string', { id: defaultRecordId ?? null });

  const rawId = await writeDetail(userRecordId, 'user', 'raw_chunk', 'user', markers.raw);
  const toolId = await writeDetail(toolRecordId, 'user', 'tool_output', 'tool', markers.tool);
  const docId = await writeDetail(docRecordId, 'user', 'document_slice', 'user', markers.doc);
  const defaultDetailId = await writeDetail(defaultRecordId, 'default', 'raw_chunk', 'user', markers.defaultDetail);
  hardCheck('seed.detailsCreated', [rawId, toolId, docId, defaultDetailId].every((id) => typeof id === 'string'), {
    rawId,
    toolId,
    docId,
    defaultDetailId,
  });

  const compactUser = await upsertCompact('user', [userRecordId, toolRecordId, docRecordId], `${markers.compactUser}: user-domain summary`);
  const compactDefault = await upsertCompact('default', [defaultRecordId], `${markers.compactDefault}: default-domain summary`);
  hardCheck('seed.compactsCreated', Boolean(compactUser?.id && compactDefault?.id), {
    user: compactUser?.id ?? null,
    default: compactDefault?.id ?? null,
  });

  const checkpoint = await upsertCheckpoint({
    expectedRevision: 0,
    goal: markers.checkpointGoal,
    recordId: defaultRecordId,
    detailId: defaultDetailId,
  });
  const self = await upsertSelf({ expectedRevision: 0, name: markers.selfName });
  hardCheck('seed.checkpointCreated', Boolean(checkpoint?.id), { id: checkpoint?.id ?? null, revision: checkpoint?.revision ?? null });
  hardCheck('seed.selfCreated', Boolean(self?.id), { id: self?.id ?? null, revision: self?.revision ?? null });

  const details = {
    user: await listDetails(userRecordId),
    tool: await listDetails(toolRecordId),
    doc: await listDetails(docRecordId),
    default: await listDetails(defaultRecordId),
  };
  hardCheck('seed.detailList', Object.values(details).every((entries) => entries.length === 1), {
    user: detailSummary(details.user),
    tool: detailSummary(details.tool),
    doc: detailSummary(details.doc),
    default: detailSummary(details.default),
  });

  result.objects = {
    recordUser: userRecordId,
    recordTool: toolRecordId,
    recordDoc: docRecordId,
    recordDefault: defaultRecordId,
    detailRaw: rawId,
    detailTool: toolId,
    detailDoc: docId,
    detailDefault: defaultDetailId,
    compactUser: compactUser.id,
    compactDefault: compactDefault.id,
    checkpoint: checkpoint.id,
    checkpointThreadId: THREAD_ID,
    self: self.id,
    selfAgentId: AGENT_ID,
    details: Object.fromEntries(Object.entries(details).map(([key, entries]) => [key, detailSummary(entries)])),
  };
}

async function upgradeStage() {
  const seed = await readJson(PREVIOUS_FILE);
  const ids = seed.objects;
  hardCheck('upgrade.previousStageOk', seed.ok === true);

  const userMatches = await queryMarker(markers.user);
  const defaultMatches = await queryMarker(markers.defaultNamespace);
  hardCheck('upgrade.oldUserRecordReadable', userMatches.some((entry) => entry.id === ids.recordUser), {
    ids: userMatches.map((entry) => entry.id),
  });
  hardCheck('upgrade.oldDefaultRecordReadable', defaultMatches.some((entry) => entry.id === ids.recordDefault), {
    ids: defaultMatches.map((entry) => entry.id),
  });

  const recordMarkers = {
    user: markers.user,
    tool: markers.recordTool,
    doc: markers.recordDoc,
    default: markers.defaultNamespace,
  };
  const recordIds = {
    user: ids.recordUser,
    tool: ids.recordTool,
    doc: ids.recordDoc,
    default: ids.recordDefault,
  };
  const details = {};
  for (const [name, marker] of Object.entries(recordMarkers)) {
    const matches = await queryMarker(marker);
    hardCheck(`upgrade.oldRecordReadable.${name}`, matches.some((entry) => entry.id === recordIds[name]), {
      ids: matches.map((entry) => entry.id),
    });
    details[name] = await listDetails(recordIds[name]);
    hardCheck(`upgrade.oldDetailReadable.${name}`, details[name].length === 1, {
      details: detailSummary(details[name]),
    });
  }
  const kinds = Object.values(details).map((entries) => entries[0]?.detailKind).sort();
  hardCheck('upgrade.detailKindsPreserved', JSON.stringify(kinds) === JSON.stringify(['document_slice', 'raw_chunk', 'raw_chunk', 'tool_output']), {
    kinds,
  });

  const rawDetail = await getDetail(ids.detailRaw);
  const toolDetail = await getDetail(ids.detailTool);
  const docDetail = await getDetail(ids.detailDoc);
  const defaultDetail = await getDetail(ids.detailDefault);
  const retention = {
    raw: rawDetail.retentionClass,
    tool: toolDetail.retentionClass,
    doc: docDetail.retentionClass,
    default: defaultDetail.retentionClass,
  };
  const seedRetention = Object.fromEntries(
    ['user', 'tool', 'doc', 'default'].flatMap((name) => (seed.objects.details?.[name] ?? []).map((detail) => [detail.id, detail.retentionClass])),
  );
  recordCheck('upgrade.oldDetailRetentionPreserved',
    retention.raw === (seedRetention[ids.detailRaw] ?? 'conversation')
    && retention.tool === (seedRetention[ids.detailTool] ?? 'conversation')
    && retention.doc === (seedRetention[ids.detailDoc] ?? 'conversation')
    && retention.default === (seedRetention[ids.detailDefault] ?? 'conversation'), retention);
  result.observations = { oldDetailRetentionClasses: retention };
  const now = Date.now();
  const days = (detail) => Math.round(((detail.expiresAt - now) / 86_400_000) * 10) / 10;
  result.observations.oldDetailRetentionDays = {
    raw: days(rawDetail),
    tool: days(toolDetail),
    doc: days(docDetail),
    default: days(defaultDetail),
  };

  const rawExpand = await softCheck('upgrade.expand.raw', () => recallAndExpand(markers.user));
  const toolExpand = await softCheck('upgrade.expand.tool', () => recallAndExpand(markers.recordTool), { informational: true });
  const docExpand = await softCheck('upgrade.expand.doc', () => recallAndExpand(markers.recordDoc), { informational: true });
  const defaultExpand = await softCheck('upgrade.expand.default', () => recallAndExpand(markers.defaultNamespace));
  if (rawExpand !== null) recordCheck('upgrade.expand.raw', Boolean(rawExpand.expanded && rawExpand.text?.includes(markers.raw)), rawExpand);
  if (toolExpand !== null) recordCheck('upgrade.expand.tool', Boolean(toolExpand.expanded && toolExpand.text?.includes(markers.tool)), toolExpand, { informational: true });
  if (docExpand !== null) recordCheck('upgrade.expand.doc', Boolean(docExpand.expanded && docExpand.text?.includes(markers.doc)), docExpand, { informational: true });
  if (defaultExpand !== null) recordCheck('upgrade.expand.default', Boolean(defaultExpand.expanded && defaultExpand.text?.includes(markers.defaultDetail)), defaultExpand);

  const checkpoint = await getInternal('context_checkpoint', { agentId: AGENT_ID, threadId: THREAD_ID, domain: 'default' });
  const self = await getInternal('self_record', { agentId: AGENT_ID });
  const compactUser = await getInternal('compact', { id: ids.compactUser });
  hardCheck('upgrade.oldCheckpointReadable', checkpoint?.id === ids.checkpoint, { id: checkpoint?.id ?? null, revision: checkpoint?.revision ?? null });
  hardCheck('upgrade.oldSelfReadable', self?.id === ids.self && self?.revision === 1, { id: self?.id ?? null, revision: self?.revision ?? null });
  hardCheck('upgrade.oldCompactReadable', compactUser?.id === ids.compactUser, { id: compactUser?.id ?? null });

  const sidecarCheckpoint = await softCheck('upgrade.sidecar.checkpoint', () => sidecarRequest(
    `/checkpoints/${encodeURIComponent(THREAD_ID)}?agentId=${encodeURIComponent(AGENT_ID)}`,
  ));
  const sidecarSelf = await softCheck('upgrade.sidecar.self', () => sidecarRequest(`/self/${encodeURIComponent(AGENT_ID)}`));
  if (sidecarCheckpoint !== null) recordCheck('upgrade.sidecar.checkpoint', sidecarCheckpoint?.checkpoint?.id === ids.checkpoint, {
    id: sidecarCheckpoint?.checkpoint?.id ?? null,
    revision: sidecarCheckpoint?.checkpoint?.revision ?? null,
  });
  if (sidecarSelf !== null) recordCheck('upgrade.sidecar.self', sidecarSelf?.selfRecord?.id === ids.self, {
    id: sidecarSelf?.selfRecord?.id ?? null,
    revision: sidecarSelf?.selfRecord?.revision ?? null,
  });

  const hiddenQueries = {
    compactUser: await queryMarker(markers.compactUser),
    compactDefault: await queryMarker(markers.compactDefault),
    checkpoint: await queryMarker(markers.checkpointGoal),
    self: await queryMarker(markers.selfName),
  };
  const internalIds = new Set([ids.compactUser, ids.compactDefault, ids.checkpoint, ids.self]);
  const leaked = Object.entries(hiddenQueries).flatMap(([name, entries]) => entries
    .filter((entry) => internalIds.has(entry.id) || ['compact', 'self_record', 'context_checkpoint', 'detail_record'].includes(entry.type))
    .map((entry) => ({ name, id: entry.id, type: entry.type })));
  hardCheck('upgrade.internalObjectsHiddenFromMcp', leaked.length === 0, { leaked });

  const graphInternal = await (async () => {
    try {
      return { blocked: false, result: await mcpCall('memory_graph', { startId: ids.compactUser, depth: 1 }) };
    } catch (error) {
      return { blocked: true, error: safeMessage(error) };
    }
  })();
  recordCheck('upgrade.memoryGraphInternalHidden',
    graphInternal.blocked === true || JSON.stringify(graphInternal.result ?? {}).includes(ids.compactUser) === false,
    graphInternal);

  const currentRecord = await mcpCall('memory_write', {
    items: [{ type: 'fact', content: markers.current, metadata: { namespace: 'user' } }],
  });
  const currentRecordId = currentRecord.stored?.[0]?.id;
  hardCheck('upgrade.currentRecordCreated', typeof currentRecordId === 'string', { id: currentRecordId ?? null });
  const currentDetailId = await writeDetail(currentRecordId, 'user', 'raw_chunk', 'user', markers.currentRaw);
  const currentToolDetailId = await writeDetail(currentRecordId, 'user', 'tool_output', 'tool', markers.currentTool);
  const currentDocDetailId = await writeDetail(currentRecordId, 'user', 'document_slice', 'user', markers.currentDoc);
  const currentDetails = await listDetails(currentRecordId);
  const currentRetention = Object.fromEntries(currentDetails.map((detail) => [detail.detailKind, {
    retentionClass: detail.retentionClass,
    days: Math.round(((detail.expiresAt - Date.now()) / 86_400_000) * 10) / 10,
  }]));
  hardCheck('upgrade.currentDetailRetentionClasses',
    currentRetention.raw_chunk?.retentionClass === 'conversation'
    && currentRetention.tool_output?.retentionClass === 'tool_output'
    && currentRetention.document_slice?.retentionClass === 'document_slice', currentRetention);
  hardCheck('upgrade.currentDetailRetentionWindows',
    Math.abs(currentRetention.raw_chunk.days - 30) < 1
    && Math.abs(currentRetention.tool_output.days - 7) < 1
    && Math.abs(currentRetention.document_slice.days - 90) < 1, currentRetention);
  const compactCurrent = await upsertCompact('user', [ids.recordUser, currentRecordId], `${markers.compactCurrent}: current-domain summary`);
  const checkpointV2 = await upsertCheckpoint({
    expectedRevision: 1,
    goal: markers.checkpointGoalV2,
    recordId: ids.recordDefault,
    detailId: ids.detailDefault,
  });
  const selfV2 = await upsertSelf({ expectedRevision: 1, name: markers.selfNameV2 });
  hardCheck('upgrade.currentInternalCreated', Boolean(compactCurrent?.id && checkpointV2?.id && selfV2?.id), {
    compact: compactCurrent?.id ?? null,
    checkpoint: checkpointV2?.id ?? null,
    checkpointRevision: checkpointV2?.revision ?? null,
    self: selfV2?.id ?? null,
    selfRevision: selfV2?.revision ?? null,
  });

  result.objects = {
    ...ids,
    recordCurrent: currentRecordId,
    detailCurrent: currentDetailId,
    detailCurrentTool: currentToolDetailId,
    detailCurrentDoc: currentDocDetailId,
    compactCurrent: compactCurrent.id,
    checkpointV2: checkpointV2.id,
    checkpointRevision: checkpointV2.revision,
    selfV2: selfV2.id,
    selfRevision: selfV2.revision,
  };
}

async function rollbackStage() {
  const previous = await readJson(PREVIOUS_FILE);
  const ids = previous.objects;
  hardCheck('rollback.previousStageOk', previous.ok === true);

  const userMatches = await queryMarker(markers.user);
  const defaultMatches = await queryMarker(markers.defaultNamespace);
  const currentMatches = await queryMarker(markers.current);
  hardCheck('rollback.oldUserRecordReadable', userMatches.some((entry) => entry.id === ids.recordUser), {
    ids: userMatches.map((entry) => entry.id),
  });
  hardCheck('rollback.oldDefaultRecordReadable', defaultMatches.some((entry) => entry.id === ids.recordDefault), {
    ids: defaultMatches.map((entry) => entry.id),
  });
  hardCheck('rollback.currentRecordReadable', currentMatches.some((entry) => entry.id === ids.recordCurrent), {
    ids: currentMatches.map((entry) => entry.id),
  });

  const recordMarkers = {
    user: markers.user,
    tool: markers.recordTool,
    doc: markers.recordDoc,
    default: markers.defaultNamespace,
  };
  const recordIds = {
    user: ids.recordUser,
    tool: ids.recordTool,
    doc: ids.recordDoc,
    default: ids.recordDefault,
  };
  const details = {};
  for (const [name, marker] of Object.entries(recordMarkers)) {
    const matches = await queryMarker(marker);
    hardCheck(`rollback.oldRecordReadable.${name}`, matches.some((entry) => entry.id === recordIds[name]), {
      ids: matches.map((entry) => entry.id),
    });
    details[name] = await listDetails(recordIds[name]);
    hardCheck(`rollback.oldDetailReadable.${name}`, details[name].length === 1, {
      details: detailSummary(details[name]),
    });
  }
  const currentDetails = await listDetails(ids.recordCurrent);
  hardCheck('rollback.currentDetailsReadable', currentDetails.length === 3, {
    current: detailSummary(currentDetails),
  });

  const rawDetail = await getDetail(ids.detailRaw);
  const toolDetail = await getDetail(ids.detailTool);
  const docDetail = await getDetail(ids.detailDoc);
  hardCheck('rollback.detailTextsIntact', rawDetail.text === markers.raw
    && toolDetail.text === markers.tool
    && docDetail.text === markers.doc, {
    raw: rawDetail.text,
    tool: toolDetail.text,
    doc: docDetail.text,
  });

  const rawExpand = await softCheck('rollback.expand.raw', () => recallAndExpand(markers.user));
  const toolExpand = await softCheck('rollback.expand.tool', () => recallAndExpand(markers.recordTool), { informational: true });
  const docExpand = await softCheck('rollback.expand.doc', () => recallAndExpand(markers.recordDoc), { informational: true });
  if (rawExpand !== null) recordCheck('rollback.expand.raw', Boolean(rawExpand.expanded && rawExpand.text?.includes(markers.raw)), rawExpand);
  if (toolExpand !== null) recordCheck('rollback.expand.tool', Boolean(toolExpand.expanded && toolExpand.text?.includes(markers.tool)), toolExpand, { informational: true });
  if (docExpand !== null) recordCheck('rollback.expand.doc', Boolean(docExpand.expanded && docExpand.text?.includes(markers.doc)), docExpand, { informational: true });

  const oldCheckpoint = await getInternal('context_checkpoint', { agentId: AGENT_ID, threadId: THREAD_ID, domain: 'default' });
  const oldSelf = await getInternal('self_record', { agentId: AGENT_ID });
  const oldCompact = await getInternal('compact', { id: ids.compactUser });
  hardCheck('rollback.latestCheckpointReadable', oldCheckpoint?.revision === ids.checkpointRevision && oldCheckpoint?.id === ids.checkpointV2, {
    id: oldCheckpoint?.id ?? null,
    revision: oldCheckpoint?.revision ?? null,
  });
  hardCheck('rollback.oldCheckpointRevisionPresent', Boolean(await app.graph.getNode(ids.checkpoint)), {
    id: ids.checkpoint,
  });
  hardCheck('rollback.oldSelfRevisionPresent', Boolean(await app.graph.getNode(ids.self)), {
    id: ids.self,
  });
  hardCheck('rollback.oldCompactReadable', oldCompact?.id === ids.compactUser, { id: oldCompact?.id ?? null });
  hardCheck('rollback.latestSelfReadable', oldSelf?.revision === ids.selfRevision, {
    id: oldSelf?.id ?? null,
    revision: oldSelf?.revision ?? null,
    expectedRevision: ids.selfRevision,
  });

  const compatibility = {};
  compatibility.currentCompact = await softCheck('rollback.currentCompactReadable', async () => {
    const object = await getInternal('compact', { id: ids.compactCurrent });
    return object?.id === ids.compactCurrent;
  });
  compatibility.currentCheckpoint = await softCheck('rollback.currentCheckpointReadable', async () => {
    const object = await getInternal('context_checkpoint', { agentId: AGENT_ID, threadId: THREAD_ID, domain: 'default' });
    return object?.revision === ids.checkpointRevision && object?.id === ids.checkpointV2;
  });
  compatibility.currentSelf = await softCheck('rollback.currentSelfReadable', async () => {
    const object = await getInternal('self_record', { agentId: AGENT_ID });
    return object?.revision === ids.selfRevision && object?.id === ids.selfV2;
  });
  result.compatibility = {
    oldReadsCurrentCompact: compatibility.currentCompact === true,
    oldReadsCurrentCheckpoint: compatibility.currentCheckpoint === true,
    oldReadsCurrentSelf: compatibility.currentSelf === true,
  };

  const sidecarCheckpoint = await softCheck('rollback.sidecar.checkpoint', () => sidecarRequest(
    `/checkpoints/${encodeURIComponent(THREAD_ID)}?agentId=${encodeURIComponent(AGENT_ID)}`,
  ));
  const sidecarSelf = await softCheck('rollback.sidecar.self', () => sidecarRequest(`/self/${encodeURIComponent(AGENT_ID)}`));
  if (sidecarCheckpoint !== null) recordCheck('rollback.sidecar.checkpoint', sidecarCheckpoint?.checkpoint?.revision === ids.checkpointRevision, {
    id: sidecarCheckpoint?.checkpoint?.id ?? null,
    revision: sidecarCheckpoint?.checkpoint?.revision ?? null,
  });
  if (sidecarSelf !== null) recordCheck('rollback.sidecar.self', sidecarSelf?.selfRecord?.revision === ids.selfRevision, {
    id: sidecarSelf?.selfRecord?.id ?? null,
    revision: sidecarSelf?.selfRecord?.revision ?? null,
  });

  const hiddenQueries = {
    compactCurrent: await queryMarker(markers.compactCurrent),
    checkpointV2: await queryMarker(markers.checkpointGoalV2),
    selfV2: await queryMarker(markers.selfNameV2),
  };
  const internalIds = new Set([ids.compactCurrent, ids.checkpointV2, ids.selfV2]);
  const leaked = Object.entries(hiddenQueries).flatMap(([name, entries]) => entries
    .filter((entry) => internalIds.has(entry.id) || ['compact', 'self_record', 'context_checkpoint', 'detail_record'].includes(entry.type))
    .map((entry) => ({ name, id: entry.id, type: entry.type })));
  hardCheck('rollback.currentInternalObjectsHiddenFromMcp', leaked.length === 0, { leaked });
}

async function main() {
  try {
    await start();
    result.build = {
      dir: BUILD_DIR,
      serviceVersion: await readJson(join(BUILD_DIR, 'packages/service/dist/version.json')),
      packageVersion: (await readJson(join(BUILD_DIR, 'package.json'))).version,
    };
    result.mcp = {
      toolCount: (await mcp.listTools()).tools.length,
    };
    result.cli = await softCheck('cli.probes', cliProbes);
    if (result.cli === null) {
      throw new Error('CLI 探测失败');
    }
    recordCheck('cli.memoryRuntime', result.cli.memoryRuntime?.available === true, result.cli.memoryRuntime);
    result.checks['cli.versionCommand'] = {
      ok: true,
      actual: result.cli.version,
      informational: true,
    };

    result.snapshotBefore = await snapshot();
    result.identity = result.snapshotBefore.identity;

    if (STAGE === 'seed') await seedStage();
    else if (STAGE === 'upgrade') await upgradeStage();
    else await rollbackStage();

    result.snapshotAfter = await snapshot();
  } catch (error) {
    fatal = error;
    result.errors.push(safeMessage(error));
  } finally {
    try {
      if (mcp) await mcp.close();
    } catch (error) {
      result.errors.push(`mcp.close: ${safeMessage(error)}`);
    }
    try {
      if (server) await server.close();
    } catch (error) {
      result.errors.push(`server.close: ${safeMessage(error)}`);
    }
    try {
      if (app) await app.shutdown();
    } catch (error) {
      result.errors.push(`app.shutdown: ${safeMessage(error)}`);
    }
    result.fileAfterClose = await fileInfo(join(HOME, 'device.jsonl'));
    const discoveryAfter = await (async () => {
      try {
        return await readJson(join(HOME, 'memory-runtime.json'));
      } catch {
        return null;
      }
    })();
    const sidecarPid = discovery?.pid ?? null;
    let pidAlive = false;
    if (Number.isInteger(sidecarPid)) {
      try {
        process.kill(sidecarPid, 0);
        pidAlive = true;
      } catch {
        pidAlive = false;
      }
    }
    result.sidecarAfterClose = {
      pid: sidecarPid,
      pidAlive,
      discoveryPresent: discoveryAfter !== null,
      state: discoveryAfter?.state ?? null,
    };
    result.finishedAt = new Date().toISOString();
    result.ok = fatal === null && checksFailed.length === 0;
    result.failedChecks = [...new Set(checksFailed)];
    await mkdir(dirname(RESULT_FILE), { recursive: true }).catch(() => undefined);
    await writeFile(RESULT_FILE, JSON.stringify(result, null, 2), 'utf8');
  }
}

await main();

if (fatal) {
  process.stderr.write(`[${STAGE}] 失败：${safeMessage(fatal)}\n`);
  process.exitCode = 1;
} else if (!result.ok) {
  process.stderr.write(`[${STAGE}] 检查未通过：${result.failedChecks.join(', ')}\n`);
  process.exitCode = 1;
} else {
  process.stderr.write(`[${STAGE}] OK\n`);
}
