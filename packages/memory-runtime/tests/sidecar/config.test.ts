// sidecar 配置：路径固定、禁止 daemon runtime 目录、端口/loopback、旧键拒绝、
// capability URL/版本握手。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    expect(paths.rawDir).toBe(join(home, 'memory-runtime', 'raw'));
    expect(paths.tracesPath).toBe(join(home, 'memory-runtime', 'traces.jsonl'));
    expect(paths.cacheDir).toBe(join(home, 'memory-runtime', 'cache'));
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
    expect(defaults.capture).toBe('off');
    expect(defaults.trace).toBe('local');
    expect(defaults.retention.rawDays).toBe(7);
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
      http: { port: 0 },
      limits: { maxOutboxItems: 2 },
      capability: { url: 'http://127.0.0.1:7331/internal/memory/v1' },
    }), { mode: 0o600 });

    const loaded = await loadSidecarConfig({ paths, env: {}, overrides: { http: { port: 0 } } });
    expect(loaded.capture).toBe('local');
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
});
