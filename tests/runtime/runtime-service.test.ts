// RuntimeService 最小底座：status 骨架、mode 切换不迁移、配置归一化、未实现接口显式失败。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { MemoryService } from '../../src/memory/MemoryService.js';
import {
  RuntimeModeError,
  RuntimeNotImplementedError,
  RuntimeService,
  createCompactNode,
  defaultRuntimeSettings,
  normalizeRuntimeSettings,
  type Compact,
  type RuntimeEnvelope,
  type RuntimeMode,
} from '../../src/runtime/index.js';

describe('RuntimeService (G0/G1)', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };
  let app: Mebular;
  let memory: MemoryService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-runtime-service-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
    app = new Mebular({
      storagePath: join(dir, 'device.jsonl'),
      deviceId: 'device-A',
      encryption: masterKeys,
      sync: { autoSync: false },
    });
    await app.initialize();
    memory = new MemoryService(app);
  });

  afterEach(async () => {
    await app.shutdown().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it('默认配置：mcp / capture=off / trace=local / checkpoint=local / self=cloud', () => {
    const defaults = defaultRuntimeSettings();
    expect(defaults.mode).toBe('mcp');
    expect(defaults.capture).toBe('off');
    expect(defaults.trace).toBe('local');
    expect(defaults.checkpoint.sync).toBe('local');
    expect(defaults.self.sync).toBe('cloud');
    expect(defaults.limits.maxChunkBytes).toBe(262144);

    const normalized = normalizeRuntimeSettings({
      mode: 'immersive',
      capture: 'local',
      retention: { rawDays: 3 },
      limits: { maxRecall: 10 },
    });
    expect(normalized.mode).toBe('immersive');
    expect(normalized.capture).toBe('local');
    expect(normalized.retention.rawDays).toBe(3);
    expect(normalized.retention.traceDays).toBe(7);
    expect(normalized.limits.maxRecall).toBe(10);
    expect(normalized.limits.maxContextTokens).toBe(12000);

    expect(normalizeRuntimeSettings({ mode: 'bogus', capture: 'cloud' })).toMatchObject({
      mode: 'mcp',
      capture: 'off',
    });
  });

  it('status：身份派生、能力/计数骨架与不泄露密钥', async () => {
    await memory.write([
      { type: 'fact', content: '状态计数事实' },
      { type: 'preference', content: '状态计数偏好', metadata: { preferenceType: 'theme' } },
    ]);
    const compact = await createCompactNode(app.graph, compactContent(), envelope('compact'), { namespace: 'default' });
    const runtime = new RuntimeService(app, {
      runtime: {
        capture: 'local',
        trace: 'local',
        model: { api: { keyRef: 'env:MEBULAR_RUNTIME_TEST_KEY' } },
      },
      runtimeDir: join(dir, 'runtime'),
      hostKey: 'home-test',
      profileId: 'default',
      agentId: 'opencode',
      version: '0.3.0-test',
    });

    const status = await runtime.status();
    const expectedDigest = createHash('sha256').update(masterKeys.userMasterKey).digest('hex');
    expect(status.version).toBe('0.3.0-test');
    expect(status.initialized).toBe(true);
    expect(status.mode).toBe('mcp');
    expect(status.identity).toMatchObject({
      cloudId: `cl_${expectedDigest.slice(0, 32)}`,
      userId: `u_${expectedDigest.slice(0, 16)}`,
      profileId: 'default',
      deviceId: 'device-A',
      agentId: 'opencode',
    });
    expect(status.identity.hostId).toMatch(/^h_[0-9a-f]{16}$/);
    expect(status.capabilities).toMatchObject({
      mcpTools: true,
      ingest: false,
      recall: false,
      context: false,
      checkpoint: false,
      compact: false,
      rawCapture: 'local',
      trace: 'local',
      modelSources: ['heuristic'],
    });
    expect(status.counts.memoryRecords).toBe(2);
    expect(status.counts.compacts).toBe(1);
    expect(status.counts.localRawChunks).toBe(0);
    expect(status.limits).toEqual({ maxChunkBytes: 262144, maxContextTokens: 12000, maxRecall: 50 });
    expect(status.warnings).toContain('rawCaptureUnencrypted');
    expect(JSON.stringify(status)).not.toContain('MEBULAR_RUNTIME_TEST_KEY');
    expect(status.model.credential).toEqual({ configured: true, source: 'env' });

    // compact 节点存在，但 memoryRecords 不把内部对象算进去。
    expect(await app.graph.getNode(compact.id)).not.toBeNull();
  });

  it('mode 切换：立即生效、requiresRestart=false、不迁移/不重写任何节点', async () => {
    const [written] = await memory.write([{ type: 'fact', content: '模式切换前的事实' }]);
    const compact = await createCompactNode(app.graph, compactContent(), envelope('compact'), { namespace: 'default' });
    const before = await app.storage.listNodes();
    const beforeById = new Map(before.map((node) => [node.id, JSON.stringify(node)]));
    const persisted: RuntimeMode[] = [];

    const runtime = new RuntimeService(app, {
      hostKey: 'home-test',
      persistMode: async (mode) => { persisted.push(mode); },
    });

    expect(runtime.getMode()).toBe('mcp');
    const switched = await runtime.setMode('immersive');
    expect(switched).toEqual({
      mode: 'immersive',
      changed: true,
      requiresRestart: false,
      capabilities: {
        ingest: false,
        recall: false,
        context: false,
        checkpoint: false,
        compact: false,
      },
    });
    expect(persisted).toEqual(['immersive']);
    expect((await runtime.status()).mode).toBe('immersive');

    // 既有节点 id/内容/createdAt/tags/namespace 完全不变；没有复制或转换。
    const after = await app.storage.listNodes();
    expect(after.map((node) => node.id).sort()).toEqual(before.map((node) => node.id).sort());
    for (const node of after) {
      expect(JSON.stringify(node)).toBe(beforeById.get(node.id));
    }
    expect(await app.graph.getNode(written!.id)).not.toBeNull();
    expect(await app.graph.getNode(compact.id)).not.toBeNull();

    const back = await runtime.setMode('mcp');
    expect(back.changed).toBe(true);
    expect(back.mode).toBe('mcp');
    expect((await runtime.status()).counts.memoryRecords).toBe(1);

    const noop = await runtime.setMode('mcp');
    expect(noop.changed).toBe(false);
    expect(persisted).toEqual(['immersive', 'mcp']);

    await expect(runtime.setMode('turbo' as RuntimeMode)).rejects.toBeInstanceOf(RuntimeModeError);
  });

  it('未实现业务接口显式抛 runtime_not_implemented，不静默假成功', async () => {
    const runtime = new RuntimeService(app, { hostKey: 'home-test' });
    await expect(runtime.ingest({ agentId: 'opencode' })).rejects.toBeInstanceOf(RuntimeNotImplementedError);
    await expect(runtime.recall({ query: 'x', agentId: 'opencode' })).rejects.toMatchObject({
      code: 'runtime_not_implemented',
    });
    await expect(runtime.context({ agentId: 'opencode' })).rejects.toMatchObject({
      code: 'runtime_not_implemented',
    });
    await expect(runtime.getCheckpoint('th_1', 'opencode')).rejects.toMatchObject({
      code: 'runtime_not_implemented',
    });
  });
});

function envelope(kind: RuntimeEnvelope['kind']): RuntimeEnvelope {
  const at = Date.now();
  return {
    schema: 1,
    kind,
    id: 'ignored',
    cloudId: 'cl_test',
    userId: 'u_test',
    agentId: 'opencode',
    namespace: 'default',
    visibility: 'user',
    sync: 'cloud',
    internal: true,
    provenance: { source: 'runtime', extractor: 'heuristic', at },
    createdAt: at,
    updatedAt: at,
  };
}

function compactContent(): Compact {
  return {
    schema: 1,
    summary: '摘要',
    sourceIds: [],
    sourceHashes: [],
    strategy: 'summary',
    model: { extractor: 'heuristic' },
    tokenCount: 3,
    stale: false,
  };
}
