// Skill 部署产物：ensure / 受管旧版 / 用户修改保留 / force / mcp 片段。
//
// 全部使用临时用户主目录；不触碰真实 ~/.config/opencode/skills。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SKILL_MANIFEST_FILE,
  autoEnsureSkills,
  connectClient,
  ensureSkills,
  installSkillsToDir,
} from '../../packages/mcp/src/clients.mjs';

jest.setTimeout(20_000);

const MANIFEST = SKILL_MANIFEST_FILE;

describe('Skill ensure：受管版本 / 用户修改 / force', () => {
  let root;
  let home;
  let userHome;
  let skillRoot;
  const opts = (extra = {}) => ({
    home,
    userHome,
    cwd: userHome,
    platform: 'darwin',
    env: {},
    run: () => ({ ok: false, code: 1, stdout: '', stderr: '' }),
    processList: '',
    ...extra,
  });
  const skillsDir = () => join(userHome, '.config', 'opencode', 'skills');
  const memDir = () => join(skillsDir(), 'mebular-memory');
  const taskDir = () => join(skillsDir(), 'mebular-tasks');

  async function writeSource({ skill = 'S1', version = '9.9.9' } = {}) {
    await mkdir(join(skillRoot, 'mcp'), { recursive: true });
    await mkdir(join(skillRoot, 'tasks'), { recursive: true });
    await writeFile(join(skillRoot, 'SKILL.md'), skill, 'utf-8');
    await writeFile(join(skillRoot, 'MEMORY_POLICY.md'), 'M1', 'utf-8');
    await writeFile(join(skillRoot, 'SETUP.md'), 'U1', 'utf-8');
    await writeFile(join(skillRoot, 'tasks', 'SKILL.md'), 'T1', 'utf-8');
    await writeFile(join(skillRoot, 'mcp', 'opencode.json'), '{"mcp":{"servers":{}}}', 'utf-8');
    await writeFile(join(skillRoot, 'package.json'), JSON.stringify({ name: 'fake-skill', version }), 'utf-8');
  }

  async function detectOpencode() {
    await mkdir(join(userHome, '.config', 'opencode'), { recursive: true });
    await writeFile(join(userHome, '.config', 'opencode', 'opencode.json'), '{}', 'utf-8');
  }

  const openchamberResult = (out) => out.clients.find((c) => c.id === 'openchamber');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skills-ensure-'));
    home = join(root, '.mebular');
    userHome = join(root, 'user');
    skillRoot = join(root, 'source');
    await mkdir(home, { recursive: true });
    await mkdir(userHome, { recursive: true });
    await writeSource();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('缺失 → 安装 mebular-memory + mebular-tasks + mcp/ 片段 + 受管标记', async () => {
    await detectOpencode();
    const out = await ensureSkills(opts({ skillRoot }));
    expect(out.ok).toBe(true);
    const result = openchamberResult(out);
    expect(result.detected).toBe(true);
    expect(result.status).toBe('installed');
    expect(await readFile(join(memDir(), 'SKILL.md'), 'utf-8')).toBe('S1');
    expect(await readFile(join(memDir(), 'MEMORY_POLICY.md'), 'utf-8')).toBe('M1');
    expect(await readFile(join(memDir(), 'SETUP.md'), 'utf-8')).toBe('U1');
    expect(await readFile(join(memDir(), 'mcp', 'opencode.json'), 'utf-8')).toContain('mcp');
    expect(await readFile(join(taskDir(), 'SKILL.md'), 'utf-8')).toBe('T1');
    const marker = JSON.parse(await readFile(join(memDir(), MANIFEST), 'utf-8'));
    expect(marker.managedBy).toBe('mebular');
    expect(marker.version).toBe('9.9.9');
    expect(marker.skill).toBe('mebular-memory');
    expect(typeof marker.installedAt).toBe('string');
    expect(marker.source).toBe('mebular');
    expect(marker.files['mcp/opencode.json']).toMatch(/^[0-9a-f]{64}$/);
    // OpenCode 与 OpenChamber 共享目录：只处理一次，不重复安装
    const opencode = out.clients.find((c) => c.id === 'opencode');
    expect(opencode.status).toBe('skipped');
    expect(opencode.reason).toMatch(/共享/);
  });

  it('受管旧版本 → 更新（保留用户额外文件）', async () => {
    await detectOpencode();
    await ensureSkills(opts({ skillRoot }));
    const markerPath = join(memDir(), MANIFEST);
    const marker = JSON.parse(await readFile(markerPath, 'utf-8'));
    await writeFile(markerPath, JSON.stringify({ ...marker, version: '0.0.1' }, null, 2), 'utf-8');
    await writeFile(join(memDir(), 'EXTRA.md'), 'keep me', 'utf-8');

    await writeSource({ skill: 'S2', version: '9.9.9' });
    const out = await ensureSkills(opts({ skillRoot }));
    expect(openchamberResult(out).status).toBe('updated');
    expect(openchamberResult(out).skills.find((s) => s.name === 'mebular-memory').status).toBe('updated');
    expect(await readFile(join(memDir(), 'SKILL.md'), 'utf-8')).toBe('S2');
    expect(await readFile(join(memDir(), 'EXTRA.md'), 'utf-8')).toBe('keep me');
    expect(JSON.parse(await readFile(markerPath, 'utf-8')).version).toBe('9.9.9');
  });

  it('用户修改受管 Skill → 默认保留，不覆盖', async () => {
    await detectOpencode();
    await ensureSkills(opts({ skillRoot }));
    await writeFile(join(memDir(), 'SKILL.md'), 'USER EDITED', 'utf-8');

    const out = await ensureSkills(opts({ skillRoot }));
    const result = openchamberResult(out);
    expect(result.status).toBe('kept');
    expect(result.kept).toContain(memDir());
    expect(result.skills.find((s) => s.name === 'mebular-memory').reason).toMatch(/用户修改/);
    expect(await readFile(join(memDir(), 'SKILL.md'), 'utf-8')).toBe('USER EDITED');
    // 未修改的 tasks 仍是受管且最新 → unchanged
    expect(result.skills.find((s) => s.name === 'mebular-tasks').status).toBe('unchanged');
  });

  it('无受管标记（用户自定义）→ 保留，不覆盖', async () => {
    await detectOpencode();
    await mkdir(memDir(), { recursive: true });
    await writeFile(join(memDir(), 'SKILL.md'), 'CUSTOM', 'utf-8');
    const out = await ensureSkills(opts({ skillRoot }));
    const mem = openchamberResult(out).skills.find((s) => s.name === 'mebular-memory');
    expect(mem.status).toBe('kept');
    expect(mem.reason).toMatch(/无受管标记/);
    expect(await readFile(join(memDir(), 'SKILL.md'), 'utf-8')).toBe('CUSTOM');
  });

  it('force → 完整覆盖用户修改', async () => {
    await detectOpencode();
    await ensureSkills(opts({ skillRoot }));
    await writeFile(join(memDir(), 'SKILL.md'), 'USER EDITED', 'utf-8');
    await writeFile(join(memDir(), 'LOCAL.md'), 'extra', 'utf-8');

    const out = await ensureSkills(opts({ skillRoot, force: true }));
    const result = openchamberResult(out);
    expect(result.status).toBe('updated');
    expect(await readFile(join(memDir(), 'SKILL.md'), 'utf-8')).toBe('S1');
    // force 只覆盖已知 Skill 文件，不删除用户额外文件
    expect(await readFile(join(memDir(), 'LOCAL.md'), 'utf-8')).toBe('extra');
  });

  it('只处理已检测到的客户端：未检测到时不创建任何 Skill 目录', async () => {
    // Hermes 只有配置路径 / CLI / PATH 三类探针，临时 userHome 下必定未检测到；
    // （OpenChamber 的 /Applications/OpenChamber.app 探针在真实机器上可能命中，不能当“未检测”样本。）
    const out = await ensureSkills(opts({ skillRoot, clientIds: ['hermes'] }));
    expect(out.ok).toBe(true);
    const hermes = out.clients.find((c) => c.id === 'hermes');
    expect(hermes.status).toBe('skipped');
    expect(hermes.detected).toBe(false);
    expect(existsSync(join(userHome, '.agents', 'skills'))).toBe(false);
  });

  it('目标固定为 descriptor 首个目录：cwd 里已有 .opencode/skills 也不写入项目', async () => {
    await detectOpencode();
    const project = join(root, 'project');
    await mkdir(join(project, '.opencode', 'skills'), { recursive: true });
    const out = await ensureSkills(opts({ skillRoot, cwd: project }));
    const result = openchamberResult(out);
    expect(result.targetDir).toBe(skillsDir());
    expect(await readdir(join(project, '.opencode', 'skills'))).toEqual([]);
  });

  it('installSkillsToDir：显式目标也写受管标记与 mcp/ 片段', async () => {
    const target = join(root, 'explicit-skills');
    const out = await installSkillsToDir(target, { skillRoot });
    expect(out.ok).toBe(true);
    expect(out.installed).toHaveLength(2);
    expect((await readdir(target)).sort()).toEqual(['mebular-memory', 'mebular-tasks']);
    expect(existsSync(join(target, 'mebular-memory', 'mcp', 'opencode.json'))).toBe(true);
    expect(existsSync(join(target, 'mebular-memory', MANIFEST))).toBe(true);
  });

  it('autoEnsureSkills：测试环境默认跳过；MEBULAR_SKILL_AUTOWIRE=1 时安装', async () => {
    await detectOpencode();
    const previous = process.env.MEBULAR_SKILL_AUTOWIRE;
    try {
      delete process.env.MEBULAR_SKILL_AUTOWIRE;
      const skipped = await autoEnsureSkills(opts({ skillRoot }));
      expect(skipped.skipped).toBe(true);
      expect(existsSync(skillsDir())).toBe(false);

      process.env.MEBULAR_SKILL_AUTOWIRE = '1';
      const installed = await autoEnsureSkills(opts({ skillRoot }));
      expect(installed.skipped).not.toBe(true);
      expect(installed.ok).toBe(true);
      expect(openchamberResult(installed).status).toBe('installed');
      expect(await readFile(join(memDir(), 'SKILL.md'), 'utf-8')).toBe('S1');
    } finally {
      if (previous === undefined) delete process.env.MEBULAR_SKILL_AUTOWIRE;
      else process.env.MEBULAR_SKILL_AUTOWIRE = previous;
    }
  });

  it('connectClient 成功后自动安装该客户端 Skill；再次接入保留用户修改', async () => {
    await detectOpencode();
    const first = await connectClient('opencode', opts({ skillRoot }));
    expect(first.ok).toBe(true);
    expect(first.skills).toMatchObject({ ok: true, status: 'installed' });
    expect(await readFile(join(memDir(), 'SKILL.md'), 'utf-8')).toBe('S1');

    await writeFile(join(memDir(), 'SKILL.md'), 'USER EDITED', 'utf-8');
    const second = await connectClient('opencode', opts({ skillRoot }));
    expect(second.ok).toBe(true);
    expect(second.skills).toMatchObject({ ok: true, status: 'kept' });
    expect(await readFile(join(memDir(), 'SKILL.md'), 'utf-8')).toBe('USER EDITED');
  });

  it('Skill 安装失败不阻断 MCP connect（结果只记录 skills.ok=false）', async () => {
    await detectOpencode();
    // 有 SKILL.md（源可解析）但缺 mcp/ 片段 → Skill 安装失败；MCP 接入必须仍然成功。
    const brokenRoot = join(root, 'broken-skill');
    await mkdir(join(brokenRoot, 'tasks'), { recursive: true });
    await writeFile(join(brokenRoot, 'SKILL.md'), 'S', 'utf-8');
    await writeFile(join(brokenRoot, 'MEMORY_POLICY.md'), 'M', 'utf-8');
    await writeFile(join(brokenRoot, 'SETUP.md'), 'U', 'utf-8');
    await writeFile(join(brokenRoot, 'tasks', 'SKILL.md'), 'T', 'utf-8');
    const res = await connectClient('opencode', opts({ skillRoot: brokenRoot }));
    expect(res.ok).toBe(true);
    expect(res.skills?.ok).toBe(false);
    expect(res.skills?.reason).toMatch(/mcp/);
    const cfg = JSON.parse(await readFile(join(userHome, '.config', 'opencode', 'opencode.json'), 'utf-8'));
    expect(cfg.mcp.servers.mebular).toBeTruthy();
  });
});
