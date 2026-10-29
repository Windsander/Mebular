// 文件夹式 Skill 目标矩阵：所有受支持的 Agent 都必须自动准备 Skill。
//
// 全局目录契约（与 packages/mcp/src/clients.mjs / install.mjs --global 同源）：
//   OpenCode / OpenChamber ~/.config/opencode/skills
//   Hermes                ~/.hermes/skills
//   Claude Code           ~/.claude/skills
//   Cursor                ~/.cursor/skills
//   DeepSeek Harness      ~/.agents/skills（全局优先，不回落到 App cwd）
//   Claude Desktop / Generic 无文件夹式自动目录（不伪造支持）
//
// 全部使用临时 userHome / cwd；不触碰真实用户目录。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SKILL_MANIFEST_FILE,
  builtinAssistants,
  connectClient,
  ensureSkills,
  installSkills,
  repairClients,
} from '../../packages/mcp/src/clients.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SKILL_ROOT = join(ROOT, 'packages', 'skill');
const INSTALL_SCRIPT = join(SKILL_ROOT, 'scripts', 'install.mjs');

jest.setTimeout(30_000);

describe('文件夹式 Skill 目标矩阵', () => {
  let root;
  let home;
  let userHome;
  let cwd;

  const opts = (extra = {}) => ({
    home,
    userHome,
    cwd,
    platform: 'darwin',
    env: {},
    run: () => ({ ok: false, code: 1, stdout: '', stderr: '' }),
    processList: '',
    skillRoot: SKILL_ROOT,
    ...extra,
  });

  const byId = (list) => Object.fromEntries(list.map((entry) => [entry.id, entry]));
  const globalOpencodeSkills = () => join(userHome, '.config', 'opencode', 'skills');
  const globalHermesSkills = () => join(userHome, '.hermes', 'skills');
  const globalClaudeSkills = () => join(userHome, '.claude', 'skills');
  const globalCursorSkills = () => join(userHome, '.cursor', 'skills');
  const globalDshSkills = () => join(userHome, '.agents', 'skills');

  async function writeClientFile(rel, body = '{}') {
    const path = join(userHome, ...rel.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, 'utf-8');
    return path;
  }

  async function detectClients() {
    await writeClientFile('.config/opencode/opencode.json');
    await writeClientFile('.hermes/config.yaml', 'mcp_servers: {}\n');
    await writeClientFile('.claude.json');
    await writeClientFile('.cursor/mcp.json');
    // DSH 的项目级检测信号在当前 cwd（全局 Skill 目录仍是 ~/.agents/skills）。
    await mkdir(join(cwd, '.dsh'), { recursive: true });
    await writeFile(join(cwd, '.dsh', 'cordis.yml'), '', 'utf-8');
  }

  function expectInstalledFiles(target) {
    expect(existsSync(join(target, 'mebular-memory', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, 'mebular-memory', 'MEMORY_POLICY.md'))).toBe(true);
    expect(existsSync(join(target, 'mebular-memory', 'mcp', 'opencode.json'))).toBe(true);
    expect(existsSync(join(target, 'mebular-memory', SKILL_MANIFEST_FILE))).toBe(true);
    expect(existsSync(join(target, 'mebular-tasks', 'SKILL.md'))).toBe(true);
  }

  function runGlobalInstall(homeDir, projectDir) {
    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      NODE_NO_WARNINGS: '1',
    };
    delete env.MEBULAR_SKILL_INSTALL_FALLBACK;
    return spawnSync(process.execPath, [INSTALL_SCRIPT, '--global'], {
      cwd: projectDir,
      encoding: 'utf-8',
      env,
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-targets-'));
    home = join(root, '.mebular');
    userHome = join(root, 'user');
    cwd = join(root, 'project');
    await mkdir(home, { recursive: true });
    await mkdir(userHome, { recursive: true });
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('ensureSkills：5 类文件夹式 Agent 各写自己的全局目录（OpenCode 共享目录只装一次）', async () => {
    await detectClients();
    const out = await ensureSkills(opts());
    expect(out.ok).toBe(true);
    const clients = byId(out.clients);

    expect(clients.openchamber).toMatchObject({
      detected: true, status: 'installed', targetDir: globalOpencodeSkills(),
    });
    expect(clients.hermes).toMatchObject({
      detected: true, status: 'installed', targetDir: globalHermesSkills(),
    });
    expect(clients['claude-code']).toMatchObject({
      detected: true, status: 'installed', targetDir: globalClaudeSkills(),
    });
    expect(clients.cursor).toMatchObject({
      detected: true, status: 'installed', targetDir: globalCursorSkills(),
    });
    expect(clients.dsh).toMatchObject({
      detected: true, status: 'installed', targetDir: globalDshSkills(),
    });

    for (const target of [
      globalOpencodeSkills(),
      globalHermesSkills(),
      globalClaudeSkills(),
      globalCursorSkills(),
      globalDshSkills(),
    ]) {
      expectInstalledFiles(target);
    }

    // OpenChamber / OpenCode 共享同一个全局目录：只由前者安装一次。
    expect(clients.opencode).toMatchObject({
      detected: true, status: 'skipped', targetDir: globalOpencodeSkills(),
    });
    expect(clients.opencode.reason).toMatch(/共享/);
    expect(out.summary.installed).toBe(5);

    // DSH 自动路径必须写 ~/.agents/skills，不再写 App cwd 的 .dsh/skills。
    expect(existsSync(join(cwd, '.dsh', 'skills'))).toBe(false);

    // Claude Desktop / Generic 没有文件夹式自动目录。
    expect(clients['claude-desktop'].status).toBe('skipped');
    expect(clients['claude-desktop'].reason).toMatch(/没有已知的 Skill 目录/);
    expect(clients.generic.status).toBe('skipped');
    expect(clients.generic.reason).toMatch(/没有已知的 Skill 目录/);
  });

  it('descriptor 目录矩阵：全局优先；Claude Desktop / Generic 不伪造 skillsDirs', () => {
    const list = byId(builtinAssistants(opts()));

    expect(list.openchamber.skillsDirs).toEqual([
      globalOpencodeSkills(),
      join(cwd, '.opencode', 'skills'),
    ]);
    expect(list.opencode.skillsDirs).toEqual([
      globalOpencodeSkills(),
      join(cwd, '.opencode', 'skills'),
    ]);
    expect(list.hermes.skillsDirs).toEqual([globalHermesSkills()]);
    expect(list['claude-code'].skillsDirs).toEqual([
      globalClaudeSkills(),
      join(cwd, '.claude', 'skills'),
    ]);
    expect(list.cursor.skillsDirs).toEqual([
      globalCursorSkills(),
      join(cwd, '.cursor', 'skills'),
    ]);
    expect(list.dsh.skillsDirs).toEqual([
      globalDshSkills(),
      join(cwd, '.dsh', 'skills'),
    ]);

    // 不再把 ~/.agents 当成 Hermes / Claude Code / OpenCode 的 Skill 目录。
    for (const id of ['openchamber', 'opencode', 'hermes', 'claude-code']) {
      expect(list[id].skillsDirs).not.toContain(join(userHome, '.agents', 'skills'));
    }

    expect(list['claude-desktop'].skillsDirs).toEqual([]);
    expect(list.generic.skillsDirs).toEqual([]);
  });

  it('installSkills：显式客户端使用第一个（全局）目录，DSH 不写 cwd', async () => {
    const dsh = await installSkills('dsh', opts());
    expect(dsh.ok).toBe(true);
    expect(dsh.targetDir).toBe(globalDshSkills());
    expectInstalledFiles(globalDshSkills());
    expect(existsSync(join(cwd, '.dsh', 'skills'))).toBe(false);

    const claude = await installSkills('claude-code', opts());
    expect(claude.ok).toBe(true);
    expect(claude.targetDir).toBe(globalClaudeSkills());
    expectInstalledFiles(globalClaudeSkills());

    const desktop = await installSkills('claude-desktop', opts());
    expect(desktop.ok).toBe(false);
    expect(desktop.reason).toMatch(/没有已知的 Skill 目录/);

    const generic = await installSkills('generic', opts());
    expect(generic.ok).toBe(false);
    expect(generic.reason).toMatch(/没有已知的 Skill 目录/);
  });

  it('connectClient 自动路径同样使用全局目录（Hermes / Claude Code / Cursor / DSH）', async () => {
    const mcpUrl = 'http://127.0.0.1:7331/mcp';
    const hermesRun = (cmd) => (cmd.startsWith('hermes config get')
      ? { ok: true, code: 0, stdout: 'mebular:\n  url: http://127.0.0.1:7331/mcp\n', stderr: '' }
      : { ok: true, code: 0, stdout: '', stderr: '' });

    await writeClientFile('.hermes/config.yaml', 'mcp_servers: {}\n');
    await writeClientFile('.claude.json');
    await writeClientFile('.cursor/mcp.json');
    await mkdir(join(cwd, '.dsh'), { recursive: true });
    await writeFile(join(cwd, '.dsh', 'cordis.yml'), '', 'utf-8');

    const hermes = await connectClient('hermes', opts({ run: hermesRun, mcpUrl }));
    expect(hermes.ok).toBe(true);
    expect(hermes.skills).toMatchObject({ ok: true, targetDir: globalHermesSkills() });
    expectInstalledFiles(globalHermesSkills());

    const claude = await connectClient('claude-code', opts({ mcpUrl }));
    expect(claude.ok).toBe(true);
    expect(claude.skills).toMatchObject({ ok: true, targetDir: globalClaudeSkills() });
    expectInstalledFiles(globalClaudeSkills());

    const cursor = await connectClient('cursor', opts({ mcpUrl }));
    expect(cursor.ok).toBe(true);
    expect(cursor.skills).toMatchObject({ ok: true, targetDir: globalCursorSkills() });
    expectInstalledFiles(globalCursorSkills());

    const dsh = await connectClient('dsh', opts({ mcpUrl }));
    expect(dsh.ok).toBe(true);
    expect(dsh.skills).toMatchObject({ ok: true, targetDir: globalDshSkills() });
    expectInstalledFiles(globalDshSkills());
    expect(existsSync(join(cwd, '.dsh', 'skills'))).toBe(false);
  });

  it('repairClients：共享全局目录只 force 安装一次，DSH 写全局', async () => {
    await detectClients();
    const out = await repairClients(opts({ mcpUrl: 'http://127.0.0.1:7331/mcp' }));
    const clients = byId(out.clients);

    expect(clients.openchamber.skills).toMatchObject({
      ok: true, targetDir: globalOpencodeSkills(),
    });
    expect(clients.opencode.skills).toMatchObject({
      ok: true, skipped: true, targetDir: globalOpencodeSkills(),
    });
    expect(clients.opencode.skills.reason).toMatch(/共享/);
    expect(clients.dsh.skills).toMatchObject({
      ok: true, targetDir: globalDshSkills(),
    });
    expectInstalledFiles(globalOpencodeSkills());
    expectInstalledFiles(globalDshSkills());
    expect(existsSync(join(cwd, '.dsh', 'skills'))).toBe(false);
  });

  it('install.mjs --global：覆盖已检测的 5 类客户端；未检测的客户端不创建目录', async () => {
    // 已检测：OpenCode/OpenChamber、Hermes、Claude Code、Cursor、DSH。
    await writeClientFile('.config/opencode/opencode.json');
    await writeClientFile('.hermes/config.yaml', 'mcp_servers: {}\n');
    await writeClientFile('.claude.json');
    await writeClientFile('.cursor/mcp.json');
    await mkdir(join(userHome, '.dsh'), { recursive: true });

    const project = join(root, 'project-detected');
    await mkdir(project, { recursive: true });
    const detected = runGlobalInstall(userHome, project);
    expect(detected.status).toBe(0);

    for (const target of [
      globalOpencodeSkills(),
      globalHermesSkills(),
      globalClaudeSkills(),
      globalCursorSkills(),
      globalDshSkills(),
    ]) {
      expectInstalledFiles(target);
    }

    const installed = JSON.parse(detected.stdout.slice(detected.stdout.lastIndexOf('{'))).installed;
    expect(installed.filter((dir) => dir === join(globalOpencodeSkills(), 'mebular-memory'))).toHaveLength(1);

    // 第二个 HOME 只检测 Hermes：其余全局目录不得被创建。
    const bareHome = join(root, 'bare-home');
    const bareProject = join(root, 'bare-project');
    await mkdir(join(bareHome, '.hermes'), { recursive: true });
    await writeFile(join(bareHome, '.hermes', 'config.yaml'), 'mcp_servers: {}\n', 'utf-8');
    await mkdir(bareProject, { recursive: true });
    const bare = runGlobalInstall(bareHome, bareProject);
    expect(bare.status).toBe(0);

    expect(existsSync(join(bareHome, '.hermes', 'skills', 'mebular-memory', 'SKILL.md'))).toBe(true);
    for (const rel of [
      ['.config', 'opencode', 'skills'],
      ['.claude', 'skills'],
      ['.cursor', 'skills'],
      ['.agents', 'skills'],
    ]) {
      expect(existsSync(join(bareHome, ...rel))).toBe(false);
    }
  });
});
