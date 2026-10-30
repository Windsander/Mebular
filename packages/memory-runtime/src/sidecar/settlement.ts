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
import type { SidecarLocalLayer } from './local-layer.js';
import { OutboxReplayer } from './outbox-replayer.js';
import {
  RecallService,
  type ContextResponse,
  type RecallHttpResult,
  type RecallResponse,
} from './recall.js';
import type { SidecarStatusSnapshot } from './server.js';

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
  policyPath?: string;
  now?: () => number;
  replayerIntervalMs?: number;
  autoStartReplayer?: boolean;
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

export class SettlementRuntime {
  readonly config: SidecarConfig;
  readonly local: SidecarLocalLayer;
  readonly identity: SettlementIdentity;
  readonly ingest: IngestService;
  readonly replayer: OutboxReplayer;
  readonly recall: RecallService;
  readonly objects: MemoryObjectService;

  private readonly client: CapabilityClient | null;
  private policy: SidecarPolicy;
  private readonly policyPath?: string;

  constructor(options: SettlementRuntimeOptions) {
    this.config = options.config;
    this.local = options.local;
    this.identity = options.identity;
    this.client = options.client;
    this.policy = options.policy ?? { schema: 1, agents: {} };
    this.policyPath = options.policyPath;
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
      ...(options.now ? { now: options.now } : {}),
    };
    this.ingest = new IngestService(ingestOptions);
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
      ...(options.now ? { now: options.now } : {}),
    });
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
      ...(options.now ? { now: options.now } : {}),
    });
    this.replayer = new OutboxReplayer({
      outbox: options.local.outbox,
      client: options.client,
      ...(options.now ? { now: options.now } : {}),
      ...(options.replayerIntervalMs !== undefined ? { intervalMs: options.replayerIntervalMs } : {}),
      onSummary: (summary) => {
        this.ingest.applyReplaySummary(summary);
        this.objects.applyReplaySummary(summary);
      },
      onSettled: (item, data) => this.objects.applyReplayedItem(item, data),
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
    // 本地过程数据：dead letter 只保留 30 天。
    await this.local.outbox.cleanupDead(Date.now(), 30).catch(() => 0);
  }

  async stop(): Promise<void> {
    await this.replayer.stop({ flushMs: 2000 });
  }

  get degraded(): boolean {
    return this.ingest.isDegraded || this.recall.isDegraded || this.objects.isDegraded;
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
  async statusSnapshot(base: Omit<SidecarStatusSnapshot, 'counts' | 'outbox' | 'lastError'> & {
    counts?: Partial<SidecarStatusSnapshot['counts']>;
    outbox?: Partial<SidecarStatusSnapshot['outbox']>;
    lastError?: SidecarStatusSnapshot['lastError'];
  }): Promise<SidecarStatusSnapshot> {
    const [stats, outbox] = await Promise.all([this.local.stats(), this.local.outbox.stats()]);
    const ingest = this.ingest.stats();
    const recall = this.recall.stats();
    const objects = this.objects.stats();
    const errors = [ingest.lastError, recall.lastError, objects.lastError]
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    errors.sort((a, b) => b.at - a.at);
    const lastError = base.lastError ?? errors[0] ?? null;
    return {
      ...base,
      counts: {
        rawChunks: stats.rawChunks,
        traces: stats.traces,
        cachedRecords: stats.cacheEntries,
        outbox: stats.outboxItems,
        deadLetter: stats.deadLetter,
        localRawChunks: stats.rawChunks,
        localTraces: stats.traces,
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
      outbox: {
        items: outbox.items,
        bytes: outbox.bytes,
        oldestAt: outbox.oldestAt,
        ...base.outbox,
      },
      lastError: lastError ?? ingest.lastError,
    };
  }
}
