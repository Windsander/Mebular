#!/usr/bin/env node
// 安装 Mebular Skills 到常见 Skill 目录（G6.4 + R3）：**两个 skill 一起装**
//   · mebular-memory（记忆面：SKILL.md + MEMORY_POLICY.md + SETUP.md + mcp/ 片段）
//   · mebular-tasks （任务面：tasks/SKILL.md + SETUP.md）
//
// 用法：
//   node scripts/install.mjs                 # 探测并安装到 cwd 的 .agents/skills、.dsh/skills（及存在的 .opencode/skills）
//   node scripts/install.mjs --global        # 另装到**已检测到**客户端的全局 Skill 目录：
//                                            #   OpenCode/OpenChamber ~/.config/opencode/skills
//                                            #   Hermes ~/.hermes/skills
//                                            #   Claude Code ~/.claude/skills
//                                            #   Cursor ~/.cursor/skills
//                                            #   DSH ~/.agents/skills（检测到 ~/.dsh、~/.agents 或 cwd/.dsh）
//                                            # 未检测到的客户端不创建目录（Claude Desktop 无文件夹式目录）
//   node scripts/install.mjs --target <dir>  # 只装到指定目录（测试/自定义用）
//   node scripts/install.mjs --force         # 覆盖用户改过的 Skill（默认保留）
//
// 单一实现：仓库 / @mebular/core 布局下**委托** `packages/mcp/src/clients.mjs` 的
// `installSkillsToDir`（受管标记、mcp/ 片段、保留/覆盖语义都在那里）。
// 独立发布 @mebular/skill 时若没有 mcp 包，才使用下方最小回落（行为契约与主实现一致）。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
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
const home = homedir();

/**
 * 已检测到客户端的全局 Skill 目录（路径契约与 `packages/mcp/src/clients.mjs` 一致）。
 * 只看目录/配置文件是否存在；未检测到的客户端一律不创建目录。
 */
function detectedGlobalSkillDirs() {
  const dirs = [];
  // OpenChamber / OpenCode 共用 global 配置与 Skill 目录，只加入一次。
  const opencodeDir = join(home, '.config', 'opencode');
  if (existsSync(join(opencodeDir, 'opencode.json')) || existsSync(opencodeDir)) {
    dirs.push(join(opencodeDir, 'skills'));
  }
  if (existsSync(join(home, '.hermes'))) dirs.push(join(home, '.hermes', 'skills'));
  if (existsSync(join(home, '.claude')) || existsSync(join(home, '.claude.json'))) {
    dirs.push(join(home, '.claude', 'skills'));
  }
  if (existsSync(join(home, '.cursor'))) dirs.push(join(home, '.cursor', 'skills'));
  // DSH：全局目录是 ~/.agents/skills；DSH_HOME（~/.dsh）、~/.agents 或当前项目的 .dsh 都是检测信号。
  if (existsSync(join(home, '.dsh')) || existsSync(join(home, '.agents')) || existsSync(join(cwd, '.dsh'))) {
    dirs.push(join(home, '.agents', 'skills'));
  }
  return dirs;
}

const targets = [];
if (typeof flags.target === 'string') {
  targets.push(flags.target);
} else {
  targets.push(join(cwd, '.agents', 'skills'));
  targets.push(join(cwd, '.dsh', 'skills'));
  if (existsSync(join(cwd, '.opencode'))) targets.push(join(cwd, '.opencode', 'skills'));
  if (flags.global === true) targets.push(...detectedGlobalSkillDirs());
}

// 去重：同一目录（如 OpenChamber/OpenCode 共享的全局目录）只安装一次。
const uniqueTargets = [...new Set(targets)];
if (uniqueTargets.length === 0) {
  console.error('没有可安装的目标目录');
  process.exit(1);
}

const sharedClients = join(pkgRoot, '..', 'mcp', 'src', 'clients.mjs');
// 独立包没有 mcp 源码时自动回落；测试/诊断可强制走回落以验证“保留/force”契约。
const forceFallback = process.env.MEBULAR_SKILL_INSTALL_FALLBACK === '1';
const shared = !forceFallback && existsSync(sharedClients)
  ? await import(pathToFileURL(sharedClients).href).catch(() => null)
  : null;

const MARKER = '.mebular-skill.json';
const SOURCE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')).version ?? null;
  } catch {
    return null;
  }
})();
const FALLBACK_SPECS = [
  {
    name: SKILL_NAME,
    files: [
      ['SKILL.md', 'SKILL.md'],
      ['MEMORY_POLICY.md', 'MEMORY_POLICY.md'],
      ['SETUP.md', 'SETUP.md'],
    ],
    copyDirs: ['mcp'],
  },
  {
    name: TASK_SKILL_NAME,
    files: [
      ['tasks/SKILL.md', 'SKILL.md'],
      ['SETUP.md', 'SETUP.md'],
    ],
    copyDirs: [],
  },
];

// 与 clients.mjs#isSafeManagedRelPath 一致：拒绝绝对路径/盘符/反斜杠/空段/./..。
const safeRel = (rel) => {
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0') || rel.includes('\\')) return false;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
};

function listRelativeFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === MARKER || entry.name === '.DS_Store') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

function hashDir(root) {
  return Object.fromEntries(listRelativeFiles(root).map((rel) => [
    rel,
    createHash('sha256').update(readFileSync(join(root, ...rel.split('/')))).digest('hex'),
  ]));
}

function readMarker(dir) {
  try {
    const data = JSON.parse(readFileSync(join(dir, MARKER), 'utf-8'));
    if (data?.schema !== 1 || data?.managedBy !== 'mebular') return null;
    if (data.files === null || typeof data.files !== 'object' || Array.isArray(data.files)) return null;
    return data;
  } catch {
    return null;
  }
}

function sourcePairs(spec) {
  const pairs = [];
  for (const [src, rel] of spec.files) {
    const abs = join(pkgRoot, ...src.split('/'));
    if (!existsSync(abs)) throw new Error(`Skill 源缺少 ${src}`);
    pairs.push([abs, rel]);
  }
  for (const srcDir of spec.copyDirs) {
    const absDir = join(pkgRoot, srcDir);
    if (!existsSync(absDir)) throw new Error(`Skill 源缺少 ${srcDir}/`);
    for (const rel of listRelativeFiles(absDir)) {
      pairs.push([join(absDir, ...rel.split('/')), `${srcDir}/${rel}`]);
    }
  }
  return pairs;
}

async function writeSkill(dir, pairs, marker, spec) {
  for (const [abs, rel] of pairs) {
    const dest = join(dir, ...rel.split('/'));
    await mkdir(dirname(dest), { recursive: true });
    await cp(abs, dest, { force: true });
  }
  if (marker) {
    const keep = new Set(pairs.map(([, rel]) => rel));
    for (const rel of Object.keys(marker.files ?? {})) {
      if (!keep.has(rel) && safeRel(rel)) await rm(join(dir, ...rel.split('/')), { force: true });
    }
  }
  const files = Object.fromEntries(pairs.map(([abs, rel]) => [
    rel,
    createHash('sha256').update(readFileSync(abs)).digest('hex'),
  ]));
  await writeFile(join(dir, MARKER), `${JSON.stringify({
    schema: 1,
    managedBy: 'mebular',
    skill: spec.name,
    version: SOURCE_VERSION,
    installedAt: new Date().toISOString(),
    source: 'mebular',
    files,
  }, null, 2)}\n`, 'utf-8');
  return files;
}

async function installFallbackSpec(target, spec, force) {
  const dir = join(target, spec.name);
  const existed = existsSync(join(dir, 'SKILL.md'));
  const marker = existed ? readMarker(dir) : null;
  const current = existed ? hashDir(dir) : {};
  const pairs = sourcePairs(spec);
  const sourceHashes = Object.fromEntries(pairs.map(([abs, rel]) => [
    rel,
    createHash('sha256').update(readFileSync(abs)).digest('hex'),
  ]));

  if (existed && force !== true) {
    if (!marker) return { name: spec.name, status: 'kept', dir, reason: '无受管标记（用户自定义），未覆盖' };
    const managedUnchanged = Object.entries(marker.files).every(([rel, hash]) => current[rel] === hash);
    if (!managedUnchanged) return { name: spec.name, status: 'kept', dir, reason: '文件与受管标记不一致（用户修改过），未覆盖' };
    const sourceCurrent = Object.entries(sourceHashes).every(([rel, hash]) => marker.files[rel] === hash);
    if (marker.version === SOURCE_VERSION && sourceCurrent) {
      return { name: spec.name, status: 'unchanged', dir, version: SOURCE_VERSION };
    }
  }

  await writeSkill(dir, pairs, marker, spec);
  return { name: spec.name, status: existed ? 'updated' : 'installed', dir, version: SOURCE_VERSION };
}

/** 独立 @mebular/skill 回落：与主实现同契约——默认保留用户修改，force 才覆盖。 */
async function fallbackInstall(target, force = false) {
  const results = [];
  for (const spec of FALLBACK_SPECS) {
    try {
      results.push(await installFallbackSpec(target, spec, force));
    } catch (error) {
      results.push({ name: spec.name, status: 'failed', dir: join(target, spec.name), reason: String(error?.message ?? error) });
    }
  }
  const failed = results.filter((r) => r.status === 'failed');
  const by = (status) => results.filter((r) => r.status === status).map((r) => r.dir);
  let status = 'unchanged';
  if (failed.length > 0) status = 'failed';
  else if (results.some((r) => r.status === 'installed')) status = 'installed';
  else if (results.some((r) => r.status === 'updated')) status = 'updated';
  else if (results.some((r) => r.status === 'kept')) status = 'kept';
  return {
    ok: failed.length === 0,
    status,
    targetDir: target,
    version: SOURCE_VERSION,
    source: 'mebular',
    installed: by('installed'),
    updated: by('updated'),
    kept: by('kept'),
    unchanged: by('unchanged'),
    skills: results,
    ...(failed.length > 0 ? { reason: failed.map((r) => `${r.name}: ${r.reason}`).join('；') } : {}),
  };
}

const installed = [];
let failed = false;
for (const target of uniqueTargets) {
  try {
    const result = shared?.installSkillsToDir
      ? await shared.installSkillsToDir(target, { skillRoot: pkgRoot, force })
      : await fallbackInstall(target, force);
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
