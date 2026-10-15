// H-1 · 「连接我的 AI 助手」单元测试（侦测 / 合并 / 幂等 / 备份 / 回滚 / 解析失败不写）
//
// 全部在临时 home 中进行（不触碰真实用户目录）。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clientDescriptors,
  detectClients,
  connectClient,
  rollbackClient,
  previewClient,
  mergeJsonEntry,
  installSkills,
} from '../../packages/mcp/src/clients.mjs';

// F-HYGIENE-1/F-FIX-A：本夹具含真实 fs + 合并/回滚往返，全量并行下会超默认 5s；给显式有界预算。
jest.setTimeout(process.platform === 'win32' ? 30_000 : 15_000);

describe('H-1 clients：侦测与合并写入', () => {
  let root;
  let home;      // Mebular home（自有文件：assistants.custom.json 等）
  let userHome;  // 用户主目录（assistant 落面基）——F-FIX-A：两者**必须**不同，否则伪绿
  const opts = () => ({ home, userHome, cwd: userHome, platform: 'darwin', env: {} });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'h1-clients-'));
    home = join(root, '.mebular');
    userHome = join(root, 'user');
    await mkdir(home, { recursive: true });
    await mkdir(userHome, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('mergeJsonEntry：只并 mebular（A-17 键位 mcp.servers.mebular），保留其他键；结构/解析异常退回 error', () => {
    const r = mergeJsonEntry('{"theme":"dark","mcp":{"other":{"x":1}}}', { format: 'opencode', entry: { type: 'local', command: ['mebular', 'mcp'] } });
    expect(r.changed).toBe(true);
    const parsed = JSON.parse(r.text);
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcp.other).toEqual({ x: 1 });
    expect(parsed.mcp.servers.mebular).toEqual({ type: 'local', command: ['mebular', 'mcp'] });
    expect(parsed.mcp.mebular).toBeUndefined(); // A-17：不得写成旧形状
    expect(mergeJsonEntry('{ not json', { format: 'opencode', entry: {} }).error).toMatch(/不是合法 JSON/);
    expect(mergeJsonEntry('[]', { format: 'opencode', entry: {} }).error).toMatch(/顶层不是对象/);
    expect(mergeJsonEntry('{"mcp": 5}', { format: 'opencode', entry: {} }).error).toMatch(/mcp 结构未知/);
  });

  it('侦测：未接入 → 接入（备份 + 合并）→ 幂等（不再改/不再备份）→ 回滚', async () => {
    const cfgDir = join(userHome, '.config', 'opencode');
    await mkdir(cfgDir, { recursive: true });
    const cfg = join(cfgDir, 'opencode.json');
    await writeFile(cfg, JSON.stringify({ $schema: 'x', theme: 'dark' }, null, 2));

    const before = detectClients(opts()).find((c) => c.id === 'opencode');
    expect(before.installed).toBe(true);
    expect(before.connected).toBe(false);

    const pv = previewClient('opencode', opts());
    expect(pv.changed).toBe(true);
    expect(pv.preview).toMatch(/\+.*mebular/);

    const first = await connectClient('opencode', opts());
    expect(first.ok).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.backupPath).toBeTruthy();
    const parsed = JSON.parse(await readFile(cfg, 'utf-8'));
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcp.servers.mebular).toEqual({ type: 'local', command: ['mebular', 'mcp'] });

    const backups = (await readdir(cfgDir)).filter((f) => f.includes('.bak-'));
    expect(backups).toHaveLength(1);

    const second = await connectClient('opencode', opts());
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeNull();
    expect((await readdir(cfgDir)).filter((f) => f.includes('.bak-'))).toHaveLength(1);

    const roll = await rollbackClient('opencode', opts());
    expect(roll.ok).toBe(true);
    const after = JSON.parse(await readFile(cfg, 'utf-8'));
    expect(after.mcp?.servers?.mebular).toBeUndefined();
    expect(after.mcp?.mebular).toBeUndefined();
    expect(after.theme).toBe('dark');
  });

  it('解析失败 → 不写（needsManual + 片段），文件保持原样', async () => {
    const dir = join(userHome, '.cursor');
    await mkdir(dir, { recursive: true });
    const cfg = join(dir, 'mcp.json');
    await writeFile(cfg, '{ not json');
    const res = await connectClient('cursor', opts());
    expect(res.ok).toBe(false);
    expect(res.needsManual).toBe(true);
    expect(res.snippet).toMatch(/mcpServers/);
    expect(await readFile(cfg, 'utf-8')).toBe('{ not json');
  });

  it('OpenChamber 复用 opencode 配置（同一路径）', () => {
    const desc = clientDescriptors(opts());
    const oc = desc.find((d) => d.id === 'opencode');
    const chamber = desc.find((d) => d.id === 'openchamber');
    expect(chamber.configPath).toBe(oc.configPath);
    expect(chamber.reuseOf).toBe('opencode');
  });

  it('DSH(YAML)：空文件写片段；已含则幂等；结构未知不写', async () => {
    const dshDir = join(userHome, '.dsh');
    await mkdir(dshDir, { recursive: true });
    const cfg = join(dshDir, 'cordis.yml');
    const first = await connectClient('dsh', opts());
    expect(first.changed).toBe(true);
    expect(await readFile(cfg, 'utf-8')).toMatch(/serverName: mebular/);
    const second = await connectClient('dsh', opts());
    expect(second.changed).toBe(false);
    await writeFile(cfg, 'plugins:\n  - name: other\n');
    const third = await connectClient('dsh', opts());
    expect(third.ok).toBe(false);
    expect(third.needsManual).toBe(true);
  });

  it('generic：无配置路径 → needsManual + 片段', async () => {
    const res = await connectClient('generic', opts());
    expect(res.ok).toBe(false);
    expect(res.needsManual).toBe(true);
    expect(res.snippet).toMatch(/mcpServers/);
  });

  it('Skill 安装：显式 skillRoot 注入优先；默认装到首个 skill 目录', async () => {
    const fakeRoot = join(home, 'fake-skill');
    await mkdir(join(fakeRoot, 'tasks'), { recursive: true });
    await writeFile(join(fakeRoot, 'SKILL.md'), 'S', 'utf-8');
    await writeFile(join(fakeRoot, 'MEMORY_POLICY.md'), 'M', 'utf-8');
    await writeFile(join(fakeRoot, 'SETUP.md'), 'U', 'utf-8');
    await writeFile(join(fakeRoot, 'tasks', 'SKILL.md'), 'T', 'utf-8');
    const injected = await installSkills('opencode', { ...opts(), skillRoot: fakeRoot });
    expect(injected.ok).toBe(true);
    expect(injected.installed.length).toBe(2);
    const mem = join(userHome, '.config', 'opencode', 'skills', 'mebular-memory', 'SKILL.md');
    expect(await readFile(mem, 'utf-8')).toBe('S');

    const ok = await installSkills('opencode', { ...opts() });
    expect(ok.ok).toBe(true);
    const skillDir = join(userHome, '.config', 'opencode', 'skills');
    expect((await readdir(skillDir)).sort()).toEqual(['mebular-memory', 'mebular-tasks']);
  });

  it('安装态（cwd=临时目录、未给 skillRoot）也能找到 Skill 源（模块相对解析）', async () => {
    const prev = process.cwd();
    process.chdir(home); // 模拟服务托管/安装态：cwd=守护 home（非仓库）
    try {
      const ok = await installSkills('opencode', { ...opts() }); // 不给 skillRoot / repoRoot
      expect(ok.ok).toBe(true);
      expect(ok.installed.length).toBe(2);
      const skillDir = join(userHome, '.config', 'opencode', 'skills');
      expect((await readdir(skillDir)).sort()).toEqual(['mebular-memory', 'mebular-tasks']);
    } finally {
      process.chdir(prev);
    }
  });
});
