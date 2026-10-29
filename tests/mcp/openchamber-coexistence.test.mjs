// OpenChamber 轻量接入 + 原生 memory 共存守卫。
//
// 覆盖：
// - descriptor 落面 = ~/.config/opencode/opencode.json 的 mcp.servers.mebular；managed config 禁写；
// - remote 条目 oauth:false / codemode:false；已有 Mebular 字段（headers/timeout/protocol）保留；
// - 其他配置键（mcp.servers.other / plugin / permission）字节不变；原子写、备份、幂等；
// - 原生 memory 只读探测（env / settings / memory.json 存在性），不读 entries、不写、内存文件 hash/mtime 不变。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  addCustomAssistant,
  assistantState,
  clearAssistantsCache,
  connectClient,
  descriptorFor,
  detectOpenChamberNativeMemory,
  listAssistants,
  verifyAssistant,
} from '../../packages/mcp/src/clients.mjs';

jest.setTimeout(process.platform === 'win32' ? 30_000 : 15_000);

const CURRENT = 'http://127.0.0.1:7331/mcp';
const OLD = 'http://127.0.0.1:56007/mcp';

describe('OpenChamber 轻量接入 / 原生 memory 共存', () => {
  let root;
  let home;      // Mebular home
  let userHome;  // 用户主目录（assistant 落面基）
  const opts = (extra = {}) => ({ home, userHome, cwd: userHome, platform: 'darwin', env: {}, ...extra });
  const opencodeCfg = () => join(userHome, '.config', 'opencode', 'opencode.json');
  const managedConfig = () => join(userHome, '.config', 'openchamber', 'opencode.managed.json');
  const runManagedConfig = () => join(userHome, '.config', 'openchamber', 'run', 'instances', 'inst-1', 'opencode.managed.json');

  beforeEach(async () => {
    clearAssistantsCache();
    root = await mkdtemp(join(tmpdir(), 'oc-coexist-'));
    home = join(root, '.mebular');
    userHome = join(root, 'user');
    await mkdir(home, { recursive: true });
    await mkdir(userHome, { recursive: true });
  });
  afterEach(async () => {
    clearAssistantsCache();
    await rm(root, { recursive: true, force: true });
  });

  it('descriptor：正确落面/键位/禁写 managed，remote 条目固定 oauth:false + codemode:false', () => {
    const a = descriptorFor('openchamber', opts());
    expect(a.landing.primaryPath).toBe(opencodeCfg());
    expect(a.landing.keyPath).toBe('mcp.servers.mebular');
    expect(a.landing.forbiddenPaths).toContain(managedConfig());
    expect(a.landing.forbiddenBasenames).toContain('opencode.managed.json');
    expect(a.landing.forbiddenRoots).toContain(join(userHome, '.config', 'openchamber', 'run', 'instances'));
    expect(a.landing.entryDefaults).toMatchObject({ oauth: false, codemode: false });
    expect(a.nativeMemoryProbe).toBe('openchamber');
    expect(a.coexistence.nativeMemory).toMatchObject({
      readOnly: true,
      neverImport: true,
      neverReplace: true,
      neverWrite: true,
      neverRegisterTool: true,
    });
    expect(a.coexistence.immersive).toMatchObject({ defaultMode: 'tool-only', requiresExplicitOptIn: true });

    const item = listAssistants(opts({ mcpUrl: CURRENT })).assistants.find((x) => x.id === 'openchamber');
    expect(JSON.parse(item.snippet).mcp.servers.mebular).toEqual({
      type: 'remote', url: CURRENT, oauth: false, codemode: false,
    });
    expect(item.nativeMemory).toMatchObject({ readOnly: true, enabled: false });
    expect(item.coexistence.immersive).toMatchObject({
      defaultMode: 'tool-only', requiresExplicitOptIn: true, nativeMemoryActive: false,
    });
  });

  it('已有 mcp.servers/plugins/permissions：只新增/修正 mebular，其他键字节不变；managed config 不动', async () => {
    const original = [
      '{',
      '  "$schema": "https://opencode.ai/config.json",',
      '  "theme": "dark",',
      '  "plugin": ["@openchamber/foo@1"],',
      '  "plugins": ["legacy-plugin"],',
      '  "permission": {"edit": "ask", "bash": "allow"},',
      '  "permissions": {"network": "deny"},',
      '  "mcp": {',
      '    "servers": {',
      '      "other": {"type": "remote", "url": "https://example.com/mcp"},',
      `      "mebular": {"type": "remote", "url": "${OLD}", "headers": {"Authorization": "Bearer keep-me"}, "timeout": 1200, "protocol": "legacy"}`,
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    await mkdir(dirname(opencodeCfg()), { recursive: true });
    await writeFile(opencodeCfg(), original, 'utf-8');
    const managed = '{"plugins":["@openchamber/foo@1"]}\n';
    await mkdir(dirname(managedConfig()), { recursive: true });
    await writeFile(managedConfig(), managed, 'utf-8');
    await mkdir(dirname(runManagedConfig()), { recursive: true });
    await writeFile(runManagedConfig(), managed, 'utf-8');

    const first = await connectClient('openchamber', opts({ mcpUrl: CURRENT, skipSkills: true }));
    expect(first.ok).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.configPath).toBe(opencodeCfg());
    expect(first.backupPath).toBeTruthy();
    expect(await readFile(first.backupPath, 'utf-8')).toBe(original); // 字节级备份

    const text = await readFile(opencodeCfg(), 'utf-8');
    // 其他配置键的原始文本片段保持不变（区间替换，不整体重排）。
    for (const segment of [
      '"plugin": ["@openchamber/foo@1"]',
      '"plugins": ["legacy-plugin"]',
      '"permission": {"edit": "ask", "bash": "allow"}',
      '"permissions": {"network": "deny"}',
      '"other": {"type": "remote", "url": "https://example.com/mcp"}',
    ]) {
      expect(text).toContain(segment);
    }
    const written = JSON.parse(text);
    expect(written.mcp.mebular).toBeUndefined();
    expect(written.mcp.servers.other).toEqual({ type: 'remote', url: 'https://example.com/mcp' });
    expect(written.mcp.servers.mebular).toEqual({
      type: 'remote',
      url: CURRENT,
      headers: { Authorization: 'Bearer keep-me' },
      timeout: 1200,
      protocol: 'legacy',
      oauth: false,
      codemode: false,
    });

    // App 私有 managed config（含 run/instances/*）字节不变。
    expect(await readFile(managedConfig(), 'utf-8')).toBe(managed);
    expect(await readFile(runManagedConfig(), 'utf-8')).toBe(managed);

    // 幂等：不写、不新增备份。
    const second = await connectClient('openchamber', opts({ mcpUrl: CURRENT, skipSkills: true }));
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeNull();
    expect((await readdir(dirname(opencodeCfg()))).filter((f) => f.includes('.bak-'))).toHaveLength(1);
    expect(await readFile(opencodeCfg(), 'utf-8')).toBe(text);
  });

  it('mcp.servers 缺失时补齐中间键，plugin/permission 仍字节不变', async () => {
    const original = [
      '{',
      '  "theme": "dark",',
      '  "plugin": ["@openchamber/foo@1"],',
      '  "permission": {"edit": "ask"}',
      '}',
      '',
    ].join('\n');
    await mkdir(dirname(opencodeCfg()), { recursive: true });
    await writeFile(opencodeCfg(), original, 'utf-8');

    const res = await connectClient('openchamber', opts({ mcpUrl: CURRENT, skipSkills: true }));
    expect(res.ok).toBe(true);
    const text = await readFile(opencodeCfg(), 'utf-8');
    expect(text).toContain('"plugin": ["@openchamber/foo@1"]');
    expect(text).toContain('"permission": {"edit": "ask"}');
    expect(JSON.parse(text).mcp.servers.mebular).toEqual({
      type: 'remote', url: CURRENT, oauth: false, codemode: false,
    });
  });

  it('run/instances/*/opencode.managed.json 即使被自定义条目指向也拒绝写入', async () => {
    const target = runManagedConfig();
    const added = await addCustomAssistant({
      id: 'evil-managed', name: 'Evil Managed', kind: 'file',
      landing: {
        primaryPath: target,
        keyPath: 'mcp.servers.mebular',
        forbiddenPaths: [target],
        forbiddenBasenames: ['opencode.managed.json'],
        format: 'opencode-json',
      },
      probe: { signals: [{ kind: 'config-path', paths: [target] }] },
      writer: { strategy: 'merge-key', command: null, backup: 'byte-level', atomic: true },
      verify: { configReadback: true },
      activation: { kind: 'user-reload', note: '' },
    }, opts());
    expect(added.ok).toBe(true);

    const res = await connectClient('evil-managed', opts({ mcpUrl: CURRENT }));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/禁写路径/);
    expect(existsSync(target)).toBe(false);
  });

  it('MCP list 形状：mcp.servers.mebular 为 remote/http 直连，verify 通过', async () => {
    await mkdir(dirname(opencodeCfg()), { recursive: true });
    await writeFile(opencodeCfg(), JSON.stringify({
      theme: 'dark',
      plugin: ['@openchamber/foo@1'],
      permission: { edit: 'ask' },
      mcp: { servers: { other: { keep: 1 } } },
    }, null, 2));

    const connected = await connectClient('openchamber', opts({ mcpUrl: CURRENT, skipSkills: true }));
    expect(connected.ok).toBe(true);
    const cfg = JSON.parse(await readFile(opencodeCfg(), 'utf-8'));
    expect(cfg.mcp.servers.mebular).toEqual({ type: 'remote', url: CURRENT, oauth: false, codemode: false });
    expect(cfg.mcp.mebular).toBeUndefined();
    expect(cfg.mcpServers).toBeUndefined();

    const runAsync = async (cmd) => (cmd === 'opencode mcp list'
      ? { ok: true, code: 0, stdout: `mebular ${CURRENT} (remote)\n`, stderr: '' }
      : { ok: false, code: 1, stdout: '', stderr: '' });
    const verified = await verifyAssistant('openchamber', opts({ mcpUrl: CURRENT, runAsync, userConfirmedReload: true }));
    expect(verified.ok).toBe(true);
    expect(verified.state).toBe('connected');
    expect(verified.steps.find((step) => step.name === 'readback')?.ok).toBe(true);
    expect(verified.steps.find((step) => step.name === 'cli')?.ok).toBe(true);
  });

  it('原生 memory 只读探测：enabled 状态诚实；memory/settings 文件 hash+mtime 不变，不读 entries', async () => {
    const dataDir = join(userHome, '.config', 'openchamber');
    const settingsPath = join(dataDir, 'settings.json');
    const globalMemory = join(dataDir, 'memory.json');
    const projectMemory = join(dataDir, 'projects', 'p1', 'memory.json');
    await mkdir(dirname(projectMemory), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ agentMemoryToolEnabled: true, theme: 'dark' }, null, 2));
    // 故意写成非法 JSON：探测若读取/解析 entries 就会失败；我们只 stat 存在性。
    const secret = 'DO-NOT-READ-ENTRIES-7f3c';
    await writeFile(globalMemory, `not-json ${secret}\n`);
    await writeFile(projectMemory, `not-json ${secret}\n`);

    const snapshot = async (path) => {
      const [buffer, info] = await Promise.all([readFile(path), stat(path)]);
      return { hash: createHash('sha256').update(buffer).digest('hex'), mtimeMs: info.mtimeMs, size: info.size };
    };
    const before = {
      settings: await snapshot(settingsPath),
      global: await snapshot(globalMemory),
      project: await snapshot(projectMemory),
    };

    const env = { OPENCHAMBER_MEMORY_ENABLE: '1', OPENCHAMBER_DATA_DIR: dataDir };
    const detection = detectOpenChamberNativeMemory(opts({ env }));
    expect(detection).toMatchObject({
      readOnly: true,
      featureEnabled: true,
      toolEnabled: true,
      settingsRead: true,
      memoryFileExists: true,
      enabled: true,
      active: true,
      immersiveDefault: 'tool-only',
      requiresExplicitOptIn: true,
      memoryFiles: { global: true, projects: 1 },
    });
    expect(detection.summary).toMatch(/原生 memory 已开启/);
    expect(detection.summary).toMatch(/tool-only/);
    expect(detection.summary).toMatch(/显式 opt-in/);

    const state = assistantState(descriptorFor('openchamber', opts()), opts({ env, mcpUrl: CURRENT }));
    expect(state.nativeMemory.enabled).toBe(true);
    expect(state.coexistence.nativeMemory.enabled).toBe(true);
    expect(state.coexistence.immersive.nativeMemoryActive).toBe(true);
    expect(state.coexistence.immersive).toMatchObject({ defaultMode: 'tool-only', requiresExplicitOptIn: true });

    // 列表与接入都不得改动原生 memory（或 settings）文件。
    await mkdir(dirname(opencodeCfg()), { recursive: true });
    await writeFile(opencodeCfg(), JSON.stringify({ theme: 'dark', mcp: { servers: {} } }, null, 2));
    listAssistants(opts({ env, mcpUrl: CURRENT }));
    const connected = await connectClient('openchamber', opts({ env, mcpUrl: CURRENT, skipSkills: true }));
    expect(connected.ok).toBe(true);

    expect(await snapshot(settingsPath)).toEqual(before.settings);
    expect(await snapshot(globalMemory)).toEqual(before.global);
    expect(await snapshot(projectMemory)).toEqual(before.project);
  });

  it('原生 memory 未开启但残留 memory.json：状态如实标注，不删除/不改写', async () => {
    const dataDir = join(userHome, '.config', 'openchamber');
    const globalMemory = join(dataDir, 'memory.json');
    await mkdir(dirname(globalMemory), { recursive: true });
    await writeFile(globalMemory, '{"entries":[]}\n');
    const before = await readFile(globalMemory, 'utf-8');

    const detection = detectOpenChamberNativeMemory(opts({ env: { OPENCHAMBER_DATA_DIR: dataDir } }));
    expect(detection).toMatchObject({ featureEnabled: false, toolEnabled: false, memoryFileExists: true, enabled: false });
    expect(detection.summary).toMatch(/未完全开启/);
    expect(detection.summary).toMatch(/不写入原生 memory/);
    expect(await readFile(globalMemory, 'utf-8')).toBe(before);
  });
});
