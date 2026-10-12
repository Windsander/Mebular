// H-1 · 「连接我的 AI 助手」单元测试（侦测 / 合并 / 幂等 / 备份 / 回滚 / 解析失败不写）
//
// 全部在临时 home 中进行（不触碰真实用户目录）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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

describe('H-1 clients：侦测与合并写入', () => {
  let home;
  const opts = () => ({ home, cwd: home, platform: 'darwin', env: {} });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'h1-clients-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('mergeJsonEntry：只并 mebular，保留其他键；结构/解析异常退回 error', () => {
    const r = mergeJsonEntry('{"theme":"dark","mcp":{"other":{"x":1}}}', { format: 'opencode', entry: { type: 'local', command: ['mebular', 'mcp'] } });
    expect(r.changed).toBe(true);
    const parsed = JSON.parse(r.text);
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcp.other).toEqual({ x: 1 });
    expect(parsed.mcp.mebular).toEqual({ type: 'local', command: ['mebular', 'mcp'] });
    expect(mergeJsonEntry('{ not json', { format: 'opencode', entry: {} }).error).toMatch(/不是合法 JSON/);
    expect(mergeJsonEntry('[]', { format: 'opencode', entry: {} }).error).toMatch(/顶层不是对象/);
    expect(mergeJsonEntry('{"mcp": 5}', { format: 'opencode', entry: {} }).error).toMatch(/mcp 结构未知/);
  });

  it('侦测：未接入 → 接入（备份 + 合并）→ 幂等（不再改/不再备份）→ 回滚', async () => {
    const cfgDir = join(home, '.config', 'opencode');
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
    expect(parsed.mcp.mebular).toEqual({ type: 'local', command: ['mebular', 'mcp'] });

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
    expect(after.mcp?.mebular).toBeUndefined();
    expect(after.theme).toBe('dark');
  });

  it('解析失败 → 不写（needsManual + 片段），文件保持原样', async () => {
    const dir = join(home, '.cursor');
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
    const dshDir = join(home, '.dsh');
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

  it('Skill 安装：把 mebular-memory/mebular-tasks 装到首个 skill 目录（源缺失给 human 错误）', async () => {
    const noSrc = await installSkills('opencode', { ...opts(), repoRoot: join(home, 'nope') });
    expect(noSrc.ok).toBe(false);
    expect(noSrc.reason).toMatch(/未找到 Skill 源/);
    const repoRoot = process.cwd();
    const ok = await installSkills('opencode', { ...opts(), repoRoot });
    expect(ok.ok).toBe(true);
    expect(ok.installed.length).toBe(2);
    const skillDir = join(home, '.config', 'opencode', 'skills');
    expect((await readdir(skillDir)).sort()).toEqual(['mebular-memory', 'mebular-tasks']);
  });
});
