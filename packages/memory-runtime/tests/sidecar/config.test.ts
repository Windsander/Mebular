// sidecar 配置：路径固定、禁止 daemon runtime 目录、端口/loopback、旧键拒绝、
// capability URL/版本握手。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertSafeDataDir,
  defaultSidecarConfig,
  isCapabilityVersionCompatible,
  isMcpVersionCompatible,
  loadSidecarConfig,
  normalizeSidecarConfig,
  normalizeCapabilityBaseUrl,
  resolveCapabilityBaseUrl,
  resolveSidecarPaths,
  SidecarConfigError,
} from '../../src/sidecar/config.js';

describe('sidecar config', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mebular-memory-runtime-config-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('数据目录固定为 <home>/memory-runtime，发现文件为 <home>/memory-runtime.json', () => {
    const paths = resolveSidecarPaths({ home, env: {} });
    expect(paths.home).toBe(home);
    expect(paths.dataDir).toBe(join(home, 'memory-runtime'));
    expect(paths.discoveryPath).toBe(join(home, 'memory-runtime.json'));
    expect(paths.stagingDir).toBe(join(home, 'memory-runtime', 'staging'));
    expect(paths.policyDir).toBe(join(home, 'memory-runtime', 'policy'));
    expect(paths.policyStatePath).toBe(join(home, 'memory-runtime', 'policy', 'state.json'));
    expect(paths.tracesPath).toBe(join(home, 'memory-runtime', 'traces.jsonl'));
    expect(paths.cacheDir).toBe(join(home, 'memory-runtime', 'cache'));
    expect(paths.detailCacheDir).toBe(join(home, 'memory-runtime', 'cache', 'details'));
    expect(paths.outboxDir).toBe(join(home, 'memory-runtime', 'outbox'));
    expect(paths.hostTokenPath).toBe(join(home, 'memory-runtime', 'host-token'));
    expect(paths.capabilityTokenPath).toBe(join(home, 'memory-runtime', 'capability-token'));
  });

  it('拒绝把数据目录指向 <home>/runtime 或 <cloudRoot>/runtime/<version>', () => {
    expect(() => assertSafeDataDir(join(home, 'runtime'), home)).toThrow(SidecarConfigError);
    expect(() => assertSafeDataDir(join(home, 'runtime', '0.3.0'), home)).toThrow(SidecarConfigError);
    expect(() => assertSafeDataDir(join(home, 'cloud', 'runtime'), home)).toThrow(SidecarConfigError);
    expect(() => assertSafeDataDir(join(home, 'cloud', 'runtime', '0.3.0'), home)).toThrow(SidecarConfigError);
    expect(() => assertSafeDataDir(join(home, 'memory-runtime'), home)).not.toThrow();
    expect(() => resolveSidecarPaths({
      home,
      env: { MEBULAR_MEMORY_RUNTIME_HOME: join(home, 'runtime') },
    })).toThrow(SidecarConfigError);
  });

  it('默认端口 7341、host 127.0.0.1；允许 port=0 临时端口', () => {
    const defaults = defaultSidecarConfig();
    expect(defaults.http).toEqual({ host: '127.0.0.1', port: 7341 });
    expect(defaults.trace).toBe('local');
    expect(defaults.intervention).toMatchObject({
      mode: 'off',
      legacyModePresent: false,
      diagnosticShadow: false,
      minConfidence: 0.55,
      maxSilentStreak: 3,
      explorationRate: 0.05,
      outcomeWindowMs: 120_000,
      policyTtlDays: 30,
      modelTimeoutMs: 1500,
    });
    expect(defaults.detail.stagingHours).toBe(24);
    expect(defaults.detail.stagingBytes).toBe(268_435_456);
    expect(defaults.detail.quotaBytesPerDomain).toBe(268_435_456);
    expect(defaults.detail.quotaBytesCloud).toBe(1_073_741_824);
    expect(defaults.limits.maxOutboxItems).toBe(1000);
    expect(normalizeSidecarConfig({ http: { port: 0 } }).http.port).toBe(0);
    expect(normalizeSidecarConfig({ http: { port: 0 } }).http.host).toBe('127.0.0.1');
  });

  it('拒绝非 loopback 绑定', () => {
    expect(() => normalizeSidecarConfig({ http: { host: '0.0.0.0' } })).toThrow(SidecarConfigError);
    expect(() => normalizeSidecarConfig({ http: { host: '192.168.1.2' } })).toThrow(SidecarConfigError);
    expect(normalizeSidecarConfig({ http: { host: '::1' } }).http.host).toBe('::1');
    expect(normalizeSidecarConfig({ http: { host: 'localhost' } }).http.host).toBe('localhost');
  });

  it('detail 配置：stagingHours/stagingBytes/cacheDays 生效，旧 capture 不控制行为', () => {
    const normalized = normalizeSidecarConfig({
      capture: 'off',
      detail: { stagingHours: 6, stagingBytes: 1024, cacheDays: 3, cacheBytes: 4096, cacheMaxEntries: 7 },
    });
    expect(normalized.detail).toMatchObject({
      stagingHours: 6,
      stagingBytes: 1024,
      cacheDays: 3,
      cacheBytes: 4096,
      cacheMaxEntries: 7,
    });
    expect((normalized as unknown as Record<string, unknown>).capture).toBeUndefined();
    expect(() => normalizeSidecarConfig({ detail: { stagingHours: 0 } })).toThrow(SidecarConfigError);
  });

  it('intervention 配置：默认 off；严格校验；旧配置兼容', () => {
    // 旧配置（无 intervention）保持默认 off。
    expect(normalizeSidecarConfig({ schema: 1 }).intervention.mode).toBe('off');
    expect(normalizeSidecarConfig({
      intervention: {
        mode: 'heuristic',
        minConfidence: 0.62,
        maxSilentStreak: 5,
        explorationRate: 0.1,
        outcomeWindowMs: 60_000,
        policyTtlDays: 7,
        modelTimeoutMs: 800,
      },
    }).intervention).toEqual({
      mode: 'heuristic',
      legacyModePresent: true,
      diagnosticShadow: false,
      minConfidence: 0.62,
      maxSilentStreak: 5,
      explorationRate: 0.1,
      outcomeWindowMs: 60_000,
      policyTtlDays: 7,
      modelTimeoutMs: 800,
    });
    // 缺省（含默认 off）不能误报为“旧字段显式存在”。
    const missingMode = normalizeSidecarConfig({ intervention: { minConfidence: 0.6 } }).intervention;
    expect(missingMode.mode).toBe('off');
    expect(missingMode.legacyModePresent).toBe(false);
    expect(normalizeSidecarConfig({ intervention: { mode: 'off' } }).intervention.legacyModePresent).toBe(true);
    expect(normalizeSidecarConfig({ intervention: { diagnosticShadow: true } }).intervention.diagnosticShadow).toBe(true);
    expect(() => normalizeSidecarConfig({ intervention: { diagnosticShadow: 'yes' } })).toThrow(SidecarConfigError);

    for (const bad of [
      { mode: 'always' },
      { minConfidence: 1.5 },
      { minConfidence: '0.5' },
      { maxSilentStreak: 0 },
      { explorationRate: -0.1 },
      { outcomeWindowMs: 0 },
      { policyTtlDays: 1.5 },
      { modelTimeoutMs: 0 },
    ]) {
      expect(() => normalizeSidecarConfig({ intervention: bad })).toThrow(SidecarConfigError);
    }
  });

  it('拒绝旧原型/已删除配置键', () => {
    const cloud = 'cloud';
    expect(() => normalizeSidecarConfig({ runtime: {} })).toThrow(/runtime/);
    expect(() => normalizeSidecarConfig({ sync: cloud })).toThrow(SidecarConfigError);
    expect(() => normalizeSidecarConfig({ checkpoint: { sync: cloud } })).toThrow(SidecarConfigError);
    expect(() => normalizeSidecarConfig({ self: { sync: cloud } })).toThrow(SidecarConfigError);
    try {
      normalizeSidecarConfig({ self: { sync: cloud } });
    } catch (error) {
      expect((error as SidecarConfigError).code).toBe('legacy_config_unsupported');
    }
  });

  it('读取 config.json 并合并调用方覆盖；非法 JSON 拒绝', async () => {
    const paths = resolveSidecarPaths({ home, env: {} });
    await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.configPath, JSON.stringify({
      schema: 1,
      capture: 'local',
      retention: { rawDays: 7 },
      http: { port: 0 },
      limits: { maxOutboxItems: 2 },
      capability: { url: 'http://127.0.0.1:7331/internal/memory/v1' },
    }), { mode: 0o600 });

    const warnings: string[] = [];
    const loaded = await loadSidecarConfig({
      paths,
      env: {},
      overrides: { http: { port: 0 } },
      warnings,
    });
    expect(warnings).toEqual(expect.arrayContaining([
      'legacy_capture_ignored',
      'legacy_retention_raw_days_ignored',
    ]));
    expect((loaded as unknown as Record<string, unknown>).capture).toBeUndefined();
    expect((loaded.retention as unknown as Record<string, unknown>).rawDays).toBeUndefined();
    expect(loaded.detail.stagingHours).toBe(24);
    expect(loaded.http.port).toBe(0);
    expect(loaded.limits.maxOutboxItems).toBe(2);
    expect(loaded.capability.url).toBe('http://127.0.0.1:7331/internal/memory/v1');

    await writeFile(paths.configPath, '{ not json', { mode: 0o600 });
    await expect(loadSidecarConfig({ paths, env: {} })).rejects.toMatchObject({ code: 'config_invalid' });
  });

  it('capability URL 只允许 loopback，并可从 env/runtime.json/默认值解析', async () => {
    expect(normalizeCapabilityBaseUrl('http://127.0.0.1:7331')).toBe('http://127.0.0.1:7331/internal/memory/v1');
    expect(normalizeCapabilityBaseUrl('http://127.0.0.1:7331/internal/memory/v1/'))
      .toBe('http://127.0.0.1:7331/internal/memory/v1');
    expect(() => normalizeCapabilityBaseUrl('http://192.168.1.2:7331')).toThrow(SidecarConfigError);
    expect(() => normalizeCapabilityBaseUrl('ftp://127.0.0.1:7331')).toThrow(SidecarConfigError);
    expect(() => normalizeCapabilityBaseUrl('http://user:pass@127.0.0.1:7331')).toThrow(SidecarConfigError);

    const fromEnv = await resolveCapabilityBaseUrl({
      home,
      env: { MEBULAR_CAPABILITY_URL: 'http://127.0.0.1:7444/internal/memory/v1' },
    });
    expect(fromEnv).toBe('http://127.0.0.1:7444/internal/memory/v1');

    const fromMcp = await resolveCapabilityBaseUrl({
      home,
      env: { MEBULAR_MCP_URL: 'http://127.0.0.1:7331' },
    });
    expect(fromMcp).toBe('http://127.0.0.1:7331/internal/memory/v1');

    await writeFile(join(home, 'runtime.json'), JSON.stringify({ http: { host: '0.0.0.0', port: 7331 } }), { mode: 0o600 });
    expect(await resolveCapabilityBaseUrl({ home, env: {} })).toBe('http://127.0.0.1:7331/internal/memory/v1');

    await rm(join(home, 'runtime.json'), { force: true });
    expect(await resolveCapabilityBaseUrl({ home, env: {} })).toBe('http://127.0.0.1:7331/internal/memory/v1');
  });

  it('版本握手只接受 capability major/schema 1 与 0.3.x MCP', () => {
    expect(isCapabilityVersionCompatible({ capabilityApiVersion: 1, schemaVersion: 1, mcpVersion: '0.3.0' })).toBe(true);
    expect(isCapabilityVersionCompatible({ capabilityApiVersion: 1, schemaVersion: 1, mcpVersion: '0.3.9' })).toBe(true);
    expect(isCapabilityVersionCompatible({ capabilityApiVersion: 2, schemaVersion: 1, mcpVersion: '0.3.0' })).toBe(false);
    expect(isCapabilityVersionCompatible({ capabilityApiVersion: 1, schemaVersion: 2, mcpVersion: '0.3.0' })).toBe(false);
    expect(isCapabilityVersionCompatible({ capabilityApiVersion: 1, schemaVersion: 1, mcpVersion: '0.2.9' })).toBe(false);
    expect(isCapabilityVersionCompatible({ capabilityApiVersion: 1, schemaVersion: 1, mcpVersion: '0.4.0' })).toBe(false);
    expect(isCapabilityVersionCompatible({ capabilityApiVersion: 1, schemaVersion: 1 })).toBe(false);
    expect(isMcpVersionCompatible('0.3.1')).toBe(true);
    expect(isMcpVersionCompatible('0.4.0')).toBe(false);
  });

  it('模型配置按设备解析：local.enginePath、api keyRef 只允许引用、recall.queryPlan', () => {
    const normalized = normalizeSidecarConfig({
      model: {
        source: 'local',
        local: { pack: 'qwen-9b', threads: 6, enginePath: '/opt/llama-server' },
        api: { keyRef: 'env:MODEL_KEY', allowRemote: true, timeoutMs: 2500 },
      },
      recall: { queryPlan: 'model' },
    });
    expect(normalized.model.local).toEqual({
      pack: 'qwen-9b',
      path: null,
      threads: 6,
      enginePath: '/opt/llama-server',
    });
    // missing source 与显式 heuristic 必须可区分（W1a B1）。
    expect(defaultSidecarConfig().model.sourcePresent).toBe(false);
    expect(normalizeSidecarConfig({}).model.sourcePresent).toBe(false);
    expect(normalizeSidecarConfig({ model: { source: 'heuristic' } }).model.sourcePresent).toBe(true);
    expect(normalizeSidecarConfig({ model: { source: null } }).model.sourcePresent).toBe(false);
    expect(normalized.model.api.keyRef).toBe('env:MODEL_KEY');
    expect(normalized.recall.queryPlan).toBe('model');

    expect(normalizeSidecarConfig({ model: { api: { keyRef: 'file:secrets/runtime-model.key' } } })
      .model.api.keyRef).toBe('file:secrets/runtime-model.key');
    expect(normalizeSidecarConfig({ model: { api: { keyRef: 'keychain:mebular-runtime/cl_test' } } })
      .model.api.keyRef).toBe('keychain:mebular-runtime/cl_test');

    expect(() => normalizeSidecarConfig({ model: { api: { keyRef: 'sk-plaintext-secret' } } }))
      .toThrow(SidecarConfigError);
    expect(() => normalizeSidecarConfig({ model: { api: { keyRef: 'file:../outside.key' } } }))
      .toThrow(SidecarConfigError);
    expect(() => normalizeSidecarConfig({ model: { api: { keyRef: 'env:' } } }))
      .toThrow(SidecarConfigError);
    expect(() => normalizeSidecarConfig({ model: { source: 'other' } })).toThrow(SidecarConfigError);
    expect(() => normalizeSidecarConfig({ recall: { queryPlan: 'always' } })).toThrow(SidecarConfigError);
  });

  it('旧 intervention.mode 逐字保留，加载不重写文件', async () => {
    const paths = resolveSidecarPaths({ home, env: {} });
    await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
    const original = JSON.stringify({
      schema: 1,
      model: { source: 'heuristic' },
      intervention: { mode: 'model' },
    }, null, 2);
    await writeFile(paths.configPath, original, { mode: 0o600 });

    const loaded = await loadSidecarConfig({ paths, env: {} });
    expect(loaded.intervention.mode).toBe('model');
    expect(loaded.intervention.legacyModePresent).toBe(true);
    expect(loaded.model.source).toBe('heuristic');
    // 不迁移、不删除、不补字段。
    expect(await readFile(paths.configPath, 'utf8')).toBe(original);
  });
});
