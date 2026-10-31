// 0.3.0 验收共用 fixture：临时 home、fake capability、Recall/Ingest 服务。
//
// 只服务 acceptance-*.test.ts；不启动真实 MCP/core、不访问网络、不下载模型。
// 每个 harness 独占 temp home，测试结束由调用方 close() 清理。

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityClient, type CapabilityClientOptions } from '../../src/sidecar/capability-client.js';
import { defaultSidecarConfig, type SidecarConfig } from '../../src/sidecar/config.js';
import { defaultSidecarPolicy, type SidecarPolicy } from '../../src/sidecar/domains.js';
import { IngestService } from '../../src/sidecar/ingest.js';
import { SidecarLocalLayer } from '../../src/sidecar/local-layer.js';
import { RecallService } from '../../src/sidecar/recall.js';
import {
  startFakeCapability,
  type FakeCapabilityServer,
  type FakeCompact,
  type FakeMemoryRecord,
} from './fake-capability.js';

export const NOW = 1_760_000_000_000;
export const DAY_MS = 86_400_000;
export const ACCEPTANCE_THREAD = 'th_acceptance';

export interface AcceptanceIdentity {
  cloudId: string;
  profileId: string;
  hostId: string;
  deviceId: string;
}

export interface AcceptanceHarness {
  home: string;
  local: SidecarLocalLayer;
  fake: FakeCapabilityServer;
  client: CapabilityClient;
  config: SidecarConfig;
  identity: AcceptanceIdentity;
  recall: RecallService;
  ingest: IngestService;
  close: () => Promise<void>;
}

export interface AcceptanceHarnessOptions {
  records?: FakeMemoryRecord[];
  compacts?: FakeCompact[];
  policy?: SidecarPolicy;
  cloudId?: string;
  deviceId?: string;
  traceMaxEntries?: number;
  maxOutboxItems?: number;
  maxOutboxBytes?: number;
  maxCacheEntries?: number;
  maxCacheBytes?: number;
  filterQuery?: boolean;
  capabilityToken?: string;
  client?: Partial<CapabilityClientOptions>;
  mutateConfig?: (config: SidecarConfig) => void;
}

/** 与 recall.test.ts 一致的记录默认值；场景只覆盖差异字段。 */
export function acceptanceRecord(
  partial: Partial<FakeMemoryRecord> & Pick<FakeMemoryRecord, 'id' | 'type' | 'domain'>,
): FakeMemoryRecord {
  const domain = partial.domain;
  return {
    ownerType: domain === 'user' ? 'user' : domain.startsWith('agent:') ? 'agent' : 'other',
    ownerId: domain === 'user' ? 'u_test' : domain.startsWith('agent:') ? domain.slice(6) : domain,
    namespace: domain,
    provenance: {
      source: 'runtime',
      writerType: 'agent',
      writerId: 'opencode',
      extractor: 'heuristic',
      model: null,
      version: '0.3.0',
      deviceId: 'device-local',
      hostId: 'h_accept',
      threadId: ACCEPTANCE_THREAD,
      agentId: 'opencode',
      agentName: 'OpenCode',
      confirmation: 'none',
      at: NOW - DAY_MS,
    },
    content: {},
    tags: [],
    validFrom: NOW - DAY_MS,
    validTo: null,
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - DAY_MS,
    detailAvailable: true,
    legacy: false,
    score: 0.9,
    why: 'vector+keyword',
    ...partial,
  };
}

export function acceptancePolicy(extraReadDomains: string[] = []): SidecarPolicy {
  return {
    schema: 1,
    agents: {
      opencode: {
        readDomains: ['user', 'default', 'agent:opencode', 'task:*', ...extraReadDomains],
        writeDomains: ['user', 'default', 'agent:opencode', 'task:*', 'shared'],
        userWriteConfirmation: true,
      },
    },
  };
}

export async function createAcceptanceHarness(
  options: AcceptanceHarnessOptions = {},
): Promise<AcceptanceHarness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-acceptance-'));
  const local = new SidecarLocalLayer({
    root: join(home, 'memory-runtime'),
    now: () => NOW,
    ...(options.traceMaxEntries !== undefined ? { traceMaxEntries: options.traceMaxEntries } : {}),
    ...(options.maxOutboxItems !== undefined ? { maxOutboxItems: options.maxOutboxItems } : {}),
    ...(options.maxOutboxBytes !== undefined ? { maxOutboxBytes: options.maxOutboxBytes } : {}),
    ...(options.maxCacheEntries !== undefined ? { maxCacheEntries: options.maxCacheEntries } : {}),
    ...(options.maxCacheBytes !== undefined ? { maxCacheBytes: options.maxCacheBytes } : {}),
  });
  await local.init();
  const fake = await startFakeCapability({ filterQuery: options.filterQuery === true });
  fake.setRecords(options.records ?? []);
  fake.setCompacts(options.compacts ?? []);
  const client = new CapabilityClient({
    baseUrl: fake.baseUrl,
    token: options.capabilityToken ?? 'cap-token',
    retries: 0,
    retryDelayMs: 0,
    ...options.client,
  });
  const config = defaultSidecarConfig();
  config.http.port = 0;
  options.mutateConfig?.(config);
  const identity: AcceptanceIdentity = {
    cloudId: options.cloudId ?? 'cl_acceptance',
    profileId: 'default',
    hostId: 'h_accept',
    deviceId: options.deviceId ?? 'device-local',
  };
  const policy = options.policy ?? defaultSidecarPolicy();
  const recall = new RecallService({
    config,
    local,
    client,
    identity,
    policy,
    now: () => NOW,
  });
  const ingest = new IngestService({
    config,
    local,
    client,
    identity,
    policy,
    now: () => NOW,
  });
  await ingest.init();

  return {
    home,
    local,
    fake,
    client,
    config,
    identity,
    recall,
    ingest,
    close: async () => {
      await fake.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** 读取 temp home 下所有文件文本，用于 token/正文泄漏扫描。 */
export async function readHomeFiles(home: string): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        out.push({ path, text: await readFile(path, 'utf8').catch(() => '') });
      }
    }
  };
  await walk(home);
  return out;
}
