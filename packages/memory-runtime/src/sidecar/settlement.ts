// 沉降编排门面：ingest + outbox 重放 + 本地策略 + 域视图。
//
// 这是 W4a 提供给 sidecar host API / main 的单一入口：
// - handleIngest / getExtraction / completeExtraction；
// - getNamespaces：capability `/namespaces` 的只读视图 + 本地 policy；
// - statusSnapshot：本地计数 + 沉降计数 + lastError（不包含 token）。
//
// 本模块不 import @mebular/core，也不打开图/事件日志。

import { readFile } from 'node:fs/promises';
import type { CapabilityClient } from './capability-client.js';
import type { SidecarConfig } from './config.js';
import type { DiagnosticLog } from './diagnostic-log.js';
import {
  agentDomain,
  canReadDomain,
  normalizeSidecarPolicy,
  policyAllows,
  policyForAgent,
  type SidecarPolicy,
} from './domains.js';
import {
  IngestService,
  type IngestExtractionResult,
  type IngestExtractionView,
  type IngestHttpResult,
  type IngestServiceOptions,
  type IngestStatsSnapshot,
} from './ingest.js';
import { MemoryObjectService } from './internal-objects.js';
import type { LifecycleGate } from './lifecycle-gate.js';
import type { SidecarLocalLayer } from './local-layer.js';
import type { OutboxItem } from './local-layer.js';
import type { SidecarInferenceProvider } from './inference-provider.js';
import { OutboxReplayer } from './outbox-replayer.js';
import {
  RecallService,
  type ContextResponse,
  type RecallHttpResult,
  type RecallResponse,
} from './recall.js';
import type { SidecarStatusDetails, SidecarStatusSnapshot } from './server.js';

export interface SettlementIdentity {
  cloudId: string | null;
  profileId: string | null;
  hostId: string | null;
  userId?: string | null;
}

export interface SettlementRuntimeOptions {
  config: SidecarConfig;
  local: SidecarLocalLayer;
  client: CapabilityClient | null;
  identity: SettlementIdentity;
  policy?: SidecarPolicy | null;
  inference?: SidecarInferenceProvider | null;
  policyPath?: string;
  lifecycle?: LifecycleGate | null;
  /** WP5：脱敏运行日志；状态只暴露计数/最近错误，不返回日志正文路径。 */
  diagnostics?: DiagnosticLog | null;
  /** 重启/启动原因；来自 supervisor 或 CLI，不包含真实 home。 */
  restartReason?: string | null;
  now?: () => number;
  replayerIntervalMs?: number;
  autoStartReplayer?: boolean;
  localMaintenanceIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface NamespaceDomainView {
  domain: string;
  ownerType?: string;
  ownerId?: string;
  namespace?: string;
  count?: number;
  memoryRecords?: number;
  internalObjects?: number;
  subscribed?: boolean;
  lastUpdatedAt?: number;
  readable: boolean;
  writable: boolean;
  crossAgent: boolean;
  [key: string]: unknown;
}

export interface NamespacesView {
  agentId: string | null;
  capabilityAvailable: boolean;
  domains: NamespaceDomainView[];
  subscriptions: unknown;
  legacyNamespaces: unknown;
  policyDomain: string;
  policy: {
    agentId: string;
    readDomains: string[];
    writeDomains: string[];
    userWriteConfirmation: boolean;
  } | null;
  degraded: boolean;
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function loadSidecarPolicy(path: string | null | undefined): Promise<{ policy: SidecarPolicy; warnings: string[] }> {
  if (!path) return { policy: { schema: 1, agents: {} }, warnings: [] };
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { policy: { schema: 1, agents: {} }, warnings: [] };
    }
    return { policy: { schema: 1, agents: {} }, warnings: ['policy_unreadable'] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { policy: { schema: 1, agents: {} }, warnings: ['policy_invalid'] };
  }
  return normalizeSidecarPolicy(raw);
}

function writableFor(policy: SidecarPolicy, agentId: string, domain: string): boolean {
  const entry = policyForAgent(policy, agentId);
  if (domain === 'system') return false;
  if (domain === 'user') return policyAllows(entry.writeDomains, 'user');
  if (domain.startsWith('agent:')) {
    return domain === agentDomain(agentId) && policyAllows(entry.writeDomains, domain);
  }
  if (domain.startsWith('task:')) {
    return policyAllows(entry.writeDomains, domain, { threadId: domain.slice('task:'.length) });
  }
  return policyAllows(entry.writeDomains, domain);
}

function readableFor(policy: SidecarPolicy, agentId: string, domain: string): boolean {
  if (domain.startsWith('task:')) {
    return canReadDomain(policy, agentId, domain, { threadId: domain.slice('task:'.length) });
  }
  return canReadDomain(policy, agentId, domain);
}

export type OutboxOperationName = 'detail' | 'record' | 'compact' | 'checkpoint' | 'self' | 'other';

export function outboxOperationOf(item: OutboxItem): OutboxOperationName {
  const kind = item.meta?.kind;
  if (kind === 'detail' || item.endpoint === '/detail') return 'detail';
  if (kind === 'record' || item.endpoint === '/write') return 'record';
  if (item.endpoint === '/internal-object') {
    const bodyKind = isObject(item.body) && typeof item.body.kind === 'string' ? item.body.kind : '';
    if (bodyKind === 'compact') return 'compact';
    if (bodyKind === 'context_checkpoint') return 'checkpoint';
    if (bodyKind === 'self_record') return 'self';
  }
  return 'other';
}

function itemFailure(item: OutboxItem): {
  code: string;
  at: number;
  status?: number;
  stage?: string;
  disposition?: string;
  details?: Record<string, string | number | boolean>;
  possibleCommit?: boolean;
} | null {
  const failure = item.lastFailure;
  if (failure && typeof failure.code === 'string') {
    return {
      code: failure.code,
      at: typeof failure.at === 'number' ? failure.at : item.lastAttemptAt ?? item.createdAt,
      ...(typeof failure.status === 'number' ? { status: failure.status } : {}),
      ...(failure.stage ? { stage: failure.stage } : {}),
      ...(failure.disposition ? { disposition: failure.disposition } : {}),
      ...(failure.details ? { details: failure.details } : {}),
      ...(failure.possibleCommit ? { possibleCommit: true } : {}),
    };
  }
  const code = typeof item.error === 'string' ? item.error : item.lastError;
  if (!code) return null;
  return {
    code,
    at: item.lastAttemptAt ?? item.createdAt,
    ...(item.failureStage ? { stage: item.failureStage } : {}),
  };
}

function operationRows(
  items: readonly OutboxItem[],
  dead: readonly OutboxItem[],
  now: number,
  keyOf: (item: OutboxItem) => string,
): Array<{
  operation: string;
  endpoint: string;
  active: number;
  dead: number;
  oldestAgeMs: number | null;
  deadOldestAgeMs: number | null;
  lastFailure: { code: string; at: number; stage?: string; disposition?: string } | null;
}> {
  const rows = new Map<string, {
    operation: string;
    endpoint: string;
    active: number;
    dead: number;
    oldestAt: number | null;
    deadOldestAt: number | null;
    lastFailure: { code: string; at: number; stage?: string; disposition?: string } | null;
  }>();
  const apply = (item: OutboxItem, isDead: boolean) => {
    const operation = outboxOperationOf(item);
    const key = keyOf(item);
    const row = rows.get(key) ?? {
      operation,
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
    const failure = itemFailure(item);
    if (failure && (!row.lastFailure || failure.at >= row.lastFailure.at)) {
      row.lastFailure = {
        code: failure.code,
        at: failure.at,
        ...(failure.stage ? { stage: failure.stage } : {}),
        ...(failure.disposition ? { disposition: failure.disposition } : {}),
      };
    }
    rows.set(key, row);
  };
  for (const item of items) apply(item, false);
  for (const item of dead) apply(item, true);
  return [...rows.values()]
    .map((row) => ({
      operation: row.operation,
      endpoint: row.endpoint,
      active: row.active,
      dead: row.dead,
      oldestAgeMs: row.oldestAt === null ? null : Math.max(0, now - row.oldestAt),
      deadOldestAgeMs: row.deadOldestAt === null ? null : Math.max(0, now - row.deadOldestAt),
      lastFailure: row.lastFailure,
    }))
    .sort((a, b) => (a.operation.localeCompare(b.operation) || a.endpoint.localeCompare(b.endpoint)));
}

/** 供 `/status` 与 CLI doctor 共用的 outbox 脱敏聚合；不读取正文。 */
export function aggregateOutboxDiagnostics(
  items: readonly OutboxItem[],
  dead: readonly OutboxItem[],
  now: number,
): {
  active: number;
  dead: number;
  oldestAgeMs: number | null;
  deadOldestAgeMs: number | null;
  byOperation: ReturnType<typeof operationRows>;
  byEndpoint: ReturnType<typeof operationRows>;
  deadReasons: Array<{ reason: string; count: number }>;
  lastConflict: {
    code: string;
    at: number;
    endpoint: string;
    operation: string;
    requestId: string;
    status?: number;
    stage?: string;
    currentRevision?: number;
    expectedRevision?: number;
    hostId?: string;
    until?: number;
  } | null;
  ambiguous: Array<{
    requestId: string;
    endpoint: string;
    operation: string;
    stage?: string;
    reason: string;
    at: number;
    ageMs: number;
    possiblyCommitted: true;
    hint: 'may_have_been_committed';
    reconciliation: 'read_authoritative_objects';
    committedObjects?: { records: string[]; details: string[]; objects: string[] };
  }>;
} {
  const activeOldest = items.reduce<number | null>((oldest, item) => (
    oldest === null ? item.createdAt : Math.min(oldest, item.createdAt)
  ), null);
  const deadOldest = dead.reduce<number | null>((oldest, item) => {
    const at = typeof item.deadAt === 'number' ? item.deadAt : item.createdAt;
    return oldest === null ? at : Math.min(oldest, at);
  }, null);
  const reasons = new Map<string, number>();
  for (const item of dead) {
    const reason = typeof item.error === 'string' && item.error.length > 0
      ? item.error
      : item.lastFailure?.code ?? 'unknown';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const conflicts = [...items, ...dead]
    .map((item) => ({ item, failure: itemFailure(item) }))
    .filter((entry): entry is { item: OutboxItem; failure: NonNullable<ReturnType<typeof itemFailure>> } => (
      entry.failure !== null
      && (entry.failure.disposition === 'conflict'
        || entry.failure.code === 'revision_mismatch'
        || entry.failure.code === 'checkpoint_lease_held')
    ));
  conflicts.sort((left, right) => right.failure.at - left.failure.at);
  const latestConflict = conflicts[0];
  const ambiguous = [...items, ...dead]
    .map((item) => ({ item, failure: itemFailure(item) }))
    .filter((entry): entry is { item: OutboxItem; failure: NonNullable<ReturnType<typeof itemFailure>> } => (
      entry.failure !== null
      && (entry.failure.possibleCommit === true
        || entry.failure.code === 'timeout'
        || entry.failure.code === 'network_error'
        || entry.failure.code === 'partial_failure')
    ))
    .map(({ item, failure }) => {
      const committed = item.committed;
      const committedObjects = committed
        ? {
          records: (committed.records ?? []).map((entry) => entry.id),
          details: (committed.details ?? []).map((entry) => entry.id),
          objects: (committed.objects ?? []).map((entry) => entry.id),
        }
        : undefined;
      return {
        requestId: item.requestId,
        endpoint: item.endpoint,
        operation: outboxOperationOf(item),
        ...(failure.stage ? { stage: failure.stage } : {}),
        reason: failure.code,
        at: failure.at,
        ageMs: Math.max(0, now - failure.at),
        possiblyCommitted: true as const,
        hint: 'may_have_been_committed' as const,
        reconciliation: 'read_authoritative_objects' as const,
        ...(committedObjects ? { committedObjects } : {}),
      };
    })
    .sort((a, b) => b.at - a.at);
  return {
    active: items.length,
    dead: dead.length,
    oldestAgeMs: activeOldest === null ? null : Math.max(0, now - activeOldest),
    deadOldestAgeMs: deadOldest === null ? null : Math.max(0, now - deadOldest),
    byOperation: operationRows(items, dead, now, (item) => outboxOperationOf(item)),
    byEndpoint: operationRows(items, dead, now, (item) => item.endpoint),
    deadReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    lastConflict: latestConflict
      ? {
        code: latestConflict.failure.code,
        at: latestConflict.failure.at,
        endpoint: latestConflict.item.endpoint,
        operation: outboxOperationOf(latestConflict.item),
        requestId: latestConflict.item.requestId,
        ...(typeof latestConflict.failure.status === 'number' ? { status: latestConflict.failure.status } : {}),
        ...(typeof latestConflict.failure.details?.currentRevision === 'number'
          ? { currentRevision: latestConflict.failure.details.currentRevision }
          : {}),
        ...(typeof latestConflict.failure.details?.expectedRevision === 'number'
          ? { expectedRevision: latestConflict.failure.details.expectedRevision }
          : isObject(latestConflict.item.body) && typeof latestConflict.item.body.expectedRevision === 'number'
            ? { expectedRevision: latestConflict.item.body.expectedRevision }
            : {}),
        ...(typeof latestConflict.failure.details?.hostId === 'string'
          ? { hostId: latestConflict.failure.details.hostId }
          : {}),
        ...(typeof latestConflict.failure.details?.until === 'number'
          ? { until: latestConflict.failure.details.until }
          : {}),
        ...(latestConflict.failure.stage ? { stage: latestConflict.failure.stage } : {}),
      }
      : null,
    ambiguous,
  };
}

export class SettlementRuntime {
  readonly config: SidecarConfig;
  readonly local: SidecarLocalLayer;
  readonly identity: SettlementIdentity;
  readonly ingest: IngestService;
  readonly replayer: OutboxReplayer;
  readonly recall: RecallService;
  readonly objects: MemoryObjectService;

  private readonly client: CapabilityClient | null;
  private readonly inference: SidecarInferenceProvider | null;
  private policy: SidecarPolicy;
  private readonly policyPath?: string;
  private readonly localMaintenanceIntervalMs?: number;
  private readonly setIntervalFn?: typeof setInterval;
  private readonly clearIntervalFn?: typeof clearInterval;
  private readonly diagnostics: DiagnosticLog | null;
  private readonly restartReason: string | null;
  private readonly now: () => number;

  constructor(options: SettlementRuntimeOptions) {
    this.config = options.config;
    this.local = options.local;
    this.identity = options.identity;
    this.client = options.client;
    this.inference = options.inference ?? null;
    this.policy = options.policy ?? { schema: 1, agents: {} };
    this.policyPath = options.policyPath;
    this.localMaintenanceIntervalMs = options.localMaintenanceIntervalMs;
    this.setIntervalFn = options.setIntervalFn;
    this.clearIntervalFn = options.clearIntervalFn;
    this.diagnostics = options.diagnostics ?? null;
    this.restartReason = options.restartReason ?? null;
    this.now = options.now ?? Date.now;
    const ingestOptions: IngestServiceOptions = {
      config: options.config,
      local: options.local,
      client: options.client,
      identity: {
        cloudId: options.identity.cloudId,
        profileId: options.identity.profileId,
        hostId: options.identity.hostId,
        ...(options.identity.userId !== undefined ? { userId: options.identity.userId } : {}),
      },
      policy: this.policy,
      ...(this.inference ? { inference: this.inference } : {}),
      ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
      ...(options.now ? { now: options.now } : {}),
    };
    this.ingest = new IngestService(ingestOptions);
    this.objects = new MemoryObjectService({
      config: options.config,
      local: options.local,
      client: options.client,
      identity: {
        cloudId: options.identity.cloudId,
        profileId: options.identity.profileId,
        hostId: options.identity.hostId,
        ...(options.identity.userId !== undefined ? { userId: options.identity.userId } : {}),
      },
      policy: this.policy,
      ...(this.inference ? { inference: this.inference } : {}),
      ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.recall = new RecallService({
      config: options.config,
      local: options.local,
      client: options.client,
      identity: {
        cloudId: options.identity.cloudId,
        profileId: options.identity.profileId,
        hostId: options.identity.hostId,
        ...(options.identity.userId !== undefined ? { userId: options.identity.userId } : {}),
      },
      policy: this.policy,
      getPolicy: () => this.policy,
      checkpointSource: this.objects,
      ...(this.inference ? { inference: this.inference } : {}),
      ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    // 非 replayer 的 dead-letter 路径（Ttl/启动清理/配额等）也必须清理对象 pending。
    this.local.setDeadLetterHandler(async (item) => {
      void this.diagnostics?.append('error', 'outbox_dead', {
        requestId: item.requestId,
        endpoint: item.endpoint,
        operation: outboxOperationOf(item),
        reason: typeof item.error === 'string' ? item.error : item.lastFailure?.code ?? 'dead',
        stage: item.failureStage ?? 'cleanup',
      }).catch(() => undefined);
      await this.objects.applyReplayComplete(item, 'dead');
      await this.ingest.finalizeReplayedOutbox(item, 'dead');
    });
    this.replayer = new OutboxReplayer({
      outbox: options.local.outbox,
      client: options.client,
      ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.replayerIntervalMs !== undefined ? { intervalMs: options.replayerIntervalMs } : {}),
      onSummary: (summary) => {
        this.ingest.applyReplaySummary(summary);
        this.objects.applyReplaySummary(summary);
        if (summary.errors.length > 0) {
          const last = summary.errors[summary.errors.length - 1]! as {
            code: string;
            message: string;
            at: number;
            stage?: string;
            disposition?: string;
            possibleCommit?: boolean;
            details?: Record<string, string | number | boolean>;
          };
          void this.diagnostics?.append('warn', 'outbox_replay_error', {
            code: last.code,
            stage: last.stage ?? 'replay',
            disposition: last.disposition ?? null,
            possibleCommit: last.possibleCommit === true,
            retried: summary.retried,
            dead: summary.dead,
            remaining: summary.remaining,
            ...(last.details ?? {}),
          }).catch(() => undefined);
        } else if (summary.settled > 0 || summary.dead > 0) {
          void this.diagnostics?.append('info', 'outbox_replay', {
            settled: summary.settled,
            retried: summary.retried,
            dead: summary.dead,
            remaining: summary.remaining,
          }).catch(() => undefined);
        }
      },
      onSettled: (item, data) => (item.endpoint === '/detail' || item.meta?.kind === 'record'
        ? this.ingest.applyReplayedOutbox(item, data)
        : this.objects.applyReplayedItem(item, data)),
      onComplete: async (item, outcome) => {
        if (outcome === 'dead') {
          void this.diagnostics?.append('error', 'outbox_dead', {
            requestId: item.requestId,
            endpoint: item.endpoint,
            operation: outboxOperationOf(item),
            reason: typeof item.error === 'string' ? item.error : item.lastFailure?.code ?? 'dead',
            stage: item.failureStage ?? item.lastFailure?.stage ?? 'finalize',
            ...(item.lastFailure?.details ?? {}),
          }).catch(() => undefined);
        }
        await this.objects.applyReplayComplete(item, outcome);
        await this.ingest.finalizeReplayedOutbox(item, outcome);
      },
    });
    if (options.autoStartReplayer !== false) {
      this.replayer.start();
    }
  }

  async init(): Promise<void> {
    if (this.policyPath) {
      try {
        this.applyLoadedPolicy(await loadSidecarPolicy(this.policyPath));
      } catch {
        // 策略文件不可读时保留安全默认，不阻塞 sidecar 启动。
        this.policy = { schema: 1, agents: {} };
        this.ingest.setPolicy(this.policy);
        this.recall.setPolicy(this.policy);
      }
    }
    await this.ingest.init();
    const beforeStagingCleanup = (ids: readonly string[]) => this.ingest.expireStagingDependencies(ids);
    this.local.setMaintenanceDependencyHandler(beforeStagingCleanup);
    await this.local.runMaintenance({ beforeStagingCleanup }).catch(() => null);
    this.local.startMaintenance({
      ...(this.localMaintenanceIntervalMs !== undefined
        ? { intervalMs: this.localMaintenanceIntervalMs }
        : {}),
      ...(this.setIntervalFn ? { setIntervalFn: this.setIntervalFn } : {}),
      ...(this.clearIntervalFn ? { clearIntervalFn: this.clearIntervalFn } : {}),
      beforeStagingCleanup,
    });
  }

  async stop(): Promise<void> {
    this.local.stopMaintenance();
    // 先让 replayer 在 finalize 仍可用时完成有界 flush，再关闭收口入口。
    await this.replayer.stop({ flushMs: 2000 });
    this.ingest.stop();
  }

  get degraded(): boolean {
    return this.ingest.isDegraded
      || this.recall.isDegraded
      || this.objects.isDegraded
      || this.inference?.currentStatus().degraded === true;
  }

  get stats(): IngestStatsSnapshot {
    return this.ingest.stats();
  }

  handleCompact(request: unknown) {
    return this.objects.handleCompact(request);
  }

  getCompact(id: string) {
    return this.objects.getCompact(id);
  }

  putCheckpoint(threadId: string, request: unknown) {
    return this.objects.putCheckpoint(threadId, request);
  }

  getCheckpoint(threadId: string, options: { agentId?: string | null; sync?: string | null } = {}) {
    return this.objects.getCheckpoint(threadId, options);
  }

  deleteCheckpoint(threadId: string, options: { agentId?: string | null; sync?: string | null } = {}) {
    return this.objects.deleteCheckpoint(threadId, options);
  }

  putSelf(agentId: string, request: unknown) {
    return this.objects.putSelf(agentId, request);
  }

  getSelf(agentId: string) {
    return this.objects.getSelf(agentId);
  }

  async handleIngest(
    request: unknown,
    options: { idempotencyKey?: string | null } = {},
  ): Promise<IngestHttpResult> {
    await this.reloadPolicy().catch(() => []);
    return this.ingest.ingest(request, options);
  }

  getExtraction(id: string): Promise<IngestExtractionView | null> {
    return this.ingest.getExtraction(id);
  }

  async completeExtraction(id: string, candidates: unknown): Promise<IngestExtractionResult> {
    await this.reloadPolicy().catch(() => []);
    return this.ingest.completeExtraction(id, candidates);
  }

  async handleRecall(request: unknown): Promise<RecallHttpResult<RecallResponse>> {
    await this.reloadPolicy().catch(() => []);
    return this.recall.handleRecall(request);
  }

  async handleContext(request: unknown): Promise<RecallHttpResult<ContextResponse>> {
    await this.reloadPolicy().catch(() => []);
    return this.recall.handleContext(request);
  }

  expandRecall(recallId: string, request: unknown) {
    return this.recall.expandRecall(recallId, request);
  }

  getDetail(id: string) {
    return this.recall.getDetail(id);
  }

  getTraces(query: {
    limit?: number | string | null;
    agentId?: string | null;
    threadId?: string | null;
  } = {}) {
    return this.recall.getTraces(query);
  }

  getTrace(id: string) {
    return this.recall.getTrace(id);
  }

  submitFeedback(traceId: string, body: unknown) {
    return this.recall.submitFeedback(traceId, body);
  }

  async reloadPolicy(): Promise<string[]> {
    if (!this.policyPath) return [];
    const loaded = await loadSidecarPolicy(this.policyPath);
    this.applyLoadedPolicy(loaded);
    return loaded.warnings;
  }

  /** 非法整体/条目保留旧策略，避免一次坏文件放宽权限。 */
  private applyLoadedPolicy(loaded: { policy: SidecarPolicy; warnings: string[] }): void {
    if (loaded.warnings.includes('policy_invalid') || loaded.warnings.includes('policy_unreadable')) {
      return;
    }
    const next: SidecarPolicy = { schema: 1, agents: { ...loaded.policy.agents } };
    for (const warning of loaded.warnings) {
      const match = /^policy_agent_invalid:(.+)$/.exec(warning);
      if (!match) continue;
      const agentId = match[1]!;
      const previous = this.policy.agents[agentId];
      if (previous) next.agents[agentId] = previous;
    }
    this.policy = next;
    this.ingest.setPolicy(next);
    this.recall.setPolicy(next);
    this.objects.setPolicy(next);
  }

  /**
   * 只读域视图：capability `/namespaces` + 本地 policy。
   * capability 不可用时失败开放：返回本地策略与 degraded，不伪造域。
   */
  async getNamespaces(agentId: string | null): Promise<NamespacesView> {
    const policyWarnings = agentId ? await this.reloadPolicy() : [];
    const actor = agentId
      ? { type: 'agent', agentId }
      : { type: 'user' };
    const policyView = agentId
      ? (() => {
        const entry = policyForAgent(this.policy, agentId);
        return {
          agentId,
          readDomains: [...entry.readDomains],
          writeDomains: [...entry.writeDomains],
          userWriteConfirmation: entry.userWriteConfirmation,
        };
      })()
      : null;

    try {
      if (!this.client) throw new Error('capability_unavailable');
      const response = await this.client.getNamespaces({
        actor: JSON.stringify(actor),
        includeCounts: 'true',
      });
      const data = isObject(response.data) ? response.data : {};
      const rawDomains = Array.isArray(data.domains) ? data.domains : [];
      const domains: NamespaceDomainView[] = [];
      for (const entry of rawDomains) {
        if (!isObject(entry) || typeof entry.domain !== 'string') continue;
        const domain = entry.domain;
        const crossAgent = domain.startsWith('agent:')
          && agentId !== null
          && domain !== agentDomain(agentId);
        domains.push({
          ...entry,
          domain,
          readable: agentId ? readableFor(this.policy, agentId, domain) : true,
          writable: agentId ? writableFor(this.policy, agentId, domain) : false,
          crossAgent,
        });
      }
      return {
        agentId,
        capabilityAvailable: true,
        domains,
        subscriptions: data.subscriptions ?? null,
        legacyNamespaces: data.legacyNamespaces ?? [],
        policyDomain: typeof data.policyDomain === 'string' ? data.policyDomain : '__policy__',
        policy: policyView,
        degraded: response.degraded,
        warnings: [...policyWarnings, ...response.warnings],
      };
    } catch (error) {
      const code = isObject(error) && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'capability_unavailable';
      return {
        agentId,
        capabilityAvailable: false,
        domains: [],
        subscriptions: null,
        legacyNamespaces: [],
        policyDomain: '__policy__',
        policy: policyView,
        degraded: true,
        warnings: [...policyWarnings, code],
      };
    }
  }

  /** `/status` 的计数与 lastError；base 由 main 提供 capability/model/limits。 */
  async statusSnapshot(base: Omit<SidecarStatusSnapshot, 'counts' | 'outbox' | 'details' | 'lastError'> & {
    counts?: Partial<SidecarStatusSnapshot['counts']>;
    outbox?: Partial<SidecarStatusSnapshot['outbox']>;
    details?: Partial<SidecarStatusDetails>;
    lastError?: SidecarStatusSnapshot['lastError'];
  }): Promise<SidecarStatusSnapshot> {
    const [stats, outbox, activeItems, deadItems, logStats] = await Promise.all([
      this.local.stats(),
      this.local.outbox.stats(),
      this.local.outbox.list(),
      this.local.outbox.listDead(),
      this.diagnostics?.stats().catch(() => null) ?? Promise.resolve(null),
    ]);
    const ingest = this.ingest.stats();
    const recall = this.recall.stats();
    const objects = this.objects.stats();
    const outboxDiagnostics = aggregateOutboxDiagnostics(activeItems, deadItems, this.now());
    const errors = [ingest.lastError, recall.lastError, objects.lastError]
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    errors.sort((a, b) => b.at - a.at);
    const lastError = base.lastError ?? errors[0] ?? null;
    const maintenance = this.local.maintenanceStatus();
    const logs = {
      files: logStats?.files ?? 0,
      bytes: logStats?.bytes ?? 0,
      latestAt: logStats?.latestAt ?? null,
    };
    const disk = {
      stagingBytes: stats.stagingBytes,
      traceBytes: stats.traceBytes,
      cacheBytes: stats.cacheBytes,
      detailCacheBytes: stats.detailCacheBytes,
      outboxBytes: stats.outboxBytes,
      deadBytes: stats.deadLetterBytes,
      logsBytes: logs.bytes,
      totalBytes: stats.stagingBytes + stats.traceBytes + stats.cacheBytes
        + stats.detailCacheBytes + stats.outboxBytes + stats.deadLetterBytes + logs.bytes,
    };
    const diagnostics = {
      logs,
      disk,
      outbox: {
        active: outboxDiagnostics.active,
        dead: outboxDiagnostics.dead,
        oldestAgeMs: outboxDiagnostics.oldestAgeMs,
        deadOldestAgeMs: outboxDiagnostics.deadOldestAgeMs,
        byOperation: outboxDiagnostics.byOperation,
        deadReasons: outboxDiagnostics.deadReasons,
        lastConflict: outboxDiagnostics.lastConflict,
        ambiguous: outboxDiagnostics.ambiguous,
      },
      ...(this.restartReason ? { restartReason: this.restartReason } : {}),
    };
    const details: SidecarStatusDetails & { maintenance: typeof maintenance } = {
      available: true,
      staging: {
        chunks: stats.stagingChunks,
        hours: this.config.detail.stagingHours,
        maxBytes: this.config.detail.stagingBytes,
      },
      cache: {
        entries: stats.detailCacheEntries,
        bytes: stats.detailCacheBytes,
        days: this.config.detail.cacheDays,
        maxBytes: this.config.detail.cacheBytes,
      },
      outbox: { items: outbox.items, bytes: outbox.bytes },
      quota: {
        bytesPerDomain: this.config.detail.quotaBytesPerDomain,
        bytesCloud: this.config.detail.quotaBytesCloud,
        usedBytes: null,
        bytes: null,
      },
      retentionDays: { conversation: 30, tool_output: 7, document_slice: 90 },
      maintenance,
      diagnostics,
      ...base.details,
    };
    const outboxView: SidecarStatusSnapshot['outbox'] = {
      items: outbox.items,
      bytes: outbox.bytes,
      oldestAt: outbox.oldestAt,
      oldestAgeMs: outboxDiagnostics.oldestAgeMs,
      deadItems: stats.deadLetter,
      deadBytes: stats.deadLetterBytes,
      deadOldestAt: stats.deadLetterOldestAt,
      deadOldestAgeMs: outboxDiagnostics.deadOldestAgeMs,
      byOperation: outboxDiagnostics.byOperation,
      byEndpoint: outboxDiagnostics.byEndpoint,
      deadReasons: outboxDiagnostics.deadReasons,
      lastConflict: outboxDiagnostics.lastConflict,
      ambiguous: outboxDiagnostics.ambiguous,
      ...base.outbox,
    };
    return {
      ...base,
      counts: {
        stagingChunks: stats.stagingChunks,
        localStagingChunks: stats.stagingChunks,
        traces: stats.traces,
        localTraces: stats.traces,
        cachedRecords: stats.cacheEntries,
        detailCacheEntries: stats.detailCacheEntries,
        detailCacheBytes: stats.detailCacheBytes,
        outbox: stats.outboxItems,
        deadLetter: stats.deadLetter,
        ingested: ingest.ingested,
        settled: ingest.settled,
        recalls: recall.recalls,
        contexts: recall.contexts,
        feedback: recall.feedback,
        recallSilent: recall.silent,
        compacts: objects.compacts,
        checkpoints: objects.checkpoints,
        selfRecords: objects.selfRecords,
        objectWritesQueued: objects.queued,
        objectWritesFailed: objects.failed,
        ...base.counts,
      },
      outbox: outboxView,
      details,
      lastError: lastError ?? ingest.lastError,
    };
  }
}
