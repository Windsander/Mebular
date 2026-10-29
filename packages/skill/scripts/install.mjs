#!/usr/bin/env node
// 安装 Mebular Skills 到常见 Skill 目录（G6.4 + R3）：**两个 skill 一起装**
//   · mebular-memory（记忆面：SKILL.md + MEMORY_POLICY.md + SETUP.md + mcp/ 片段）
//   · mebular-tasks （任务面：tasks/SKILL.md + SETUP.md）
//
// 用法：
//   node scripts/install.mjs                 # 探测并安装到 cwd 的 .agents/skills、.dsh/skills（及存在的 .opencode/skills）
//   node scripts/install.mjs --global        # 另装到 ~/.agents/skills；OpenCode/OpenChamber 已存在时也装 ~/.config/opencode/skills
//   node scripts/install.mjs --target <dir>  # 只装到指定目录（测试/自定义用）
//   node scripts/install.mjs --force         # 覆盖用户改过的 Skill（默认保留）
//
// 单一实现：仓库 / @mebular/core 布局下**委托** `packages/mcp/src/clients.mjs` 的
// `installSkillsToDir`（受管标记、mcp/ 片段、保留/覆盖语义都在那里）。
// 独立发布 @mebular/skill 时若没有 mcp 包，才使用下方最小回落（行为契约与主实现一致）。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_NAME = 'mebular-memory';
const TASK_SKILL_NAME = 'mebular-tasks';

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    }
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
const force = flags.force === true || flags.force === 'true';
const cwd = process.cwd();
const targets = [];
if (typeof flags.target === 'string') {
  targets.push(flags.target);
} else {
  targets.push(join(cwd, '.agents', 'skills'));
  targets.push(join(cwd, '.dsh', 'skills'));
  if (existsSync(join(cwd, '.opencode'))) targets.push(join(cwd, '.opencode', 'skills'));
  if (flags.global === true) {
    targets.push(join(homedir(), '.agents', 'skills'));
    // OpenChamber / OpenCode 共用 global 配置；只有客户端已存在时才写它的 Skill 目录。
    const opencodeDir = join(homedir(), '.config', 'opencode');
    if (existsSync(join(opencodeDir, 'opencode.json')) || existsSync(opencodeDir)) {
      targets.push(join(opencodeDir, 'skills'));
    }
  }
}

if (targets.length === 0) {
  console.error('没有可安装的目标目录');
  process.exit(1);
}

const sharedClients = join(pkgRoot, '..', 'mcp', 'src', 'clients.mjs');
const shared = existsSync(sharedClients)
  ? await import(pathToFileURL(sharedClients).href).catch(() => null)
  : null;

/** 独立 @mebular/skill 回落：只复制已知文件；标记/保留语义从简但同契约。 */
async function fallbackInstall(target) {
  const mem = join(target, SKILL_NAME);
  const tasks = join(target, TASK_SKILL_NAME);
  await mkdir(mem, { recursive: true });
  await mkdir(tasks, { recursive: true });
  for (const [from, to] of [
    [join(pkgRoot, 'SKILL.md'), join(mem, 'SKILL.md')],
    [join(pkgRoot, 'MEMORY_POLICY.md'), join(mem, 'MEMORY_POLICY.md')],
    [join(pkgRoot, 'SETUP.md'), join(mem, 'SETUP.md')],
    [join(pkgRoot, 'tasks', 'SKILL.md'), join(tasks, 'SKILL.md')],
    [join(pkgRoot, 'SETUP.md'), join(tasks, 'SETUP.md')],
  ]) {
    if (!existsSync(from)) throw new Error(`Skill 源缺少 ${from}`);
    await cp(from, to, { force: true });
  }
  await cp(join(pkgRoot, 'mcp'), join(mem, 'mcp'), { recursive: true, force: true });
  const version = (() => {
    try {
      return JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')).version ?? null;
    } catch {
      return null;
    }
  })();
  const installedAt = new Date().toISOString();
  const hashDir = (root) => {
    const out = {};
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '.mebular-skill.json') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else if (entry.isFile()) out[rel] = createHash('sha256').update(readFileSync(join(dir, entry.name))).digest('hex');
      }
    };
    walk(root, '');
    return out;
  };
  for (const [name, dir] of [[SKILL_NAME, mem], [TASK_SKILL_NAME, tasks]]) {
    await writeFile(join(dir, '.mebular-skill.json'), `${JSON.stringify({
      schema: 1,
      managedBy: 'mebular',
      skill: name,
      version,
      installedAt,
      source: 'mebular',
      files: hashDir(dir),
    }, null, 2)}\n`, 'utf-8');
  }
  return { ok: true, installed: [mem, tasks], updated: [], kept: [], unchanged: [] };
}

const installed = [];
let failed = false;
for (const target of targets) {
  try {
    const result = shared?.installSkillsToDir
      ? await shared.installSkillsToDir(target, { skillRoot: pkgRoot, force })
      : await fallbackInstall(target);
    if (result.ok === false) {
      failed = true;
      console.error(`✗ ${target}：${result.reason ?? '安装失败'}`);
      continue;
    }
    for (const dir of [...(result.installed ?? []), ...(result.updated ?? [])]) {
      installed.push(dir);
      console.log(`installed ${dir}`);
    }
    for (const dir of result.kept ?? []) {
      console.log(`kept ${dir}（用户修改过或非受管，未覆盖）`);
    }
  } catch (error) {
    failed = true;
    console.error(`✗ ${target}：${error?.message ?? error}`);
  }
}

if (installed.length === 0 && !failed) {
  console.log('所有目标均已是最新（或保留了用户版本）');
}
console.log(JSON.stringify({ skill: SKILL_NAME, installed }, null, 2));
if (failed) process.exit(1);
