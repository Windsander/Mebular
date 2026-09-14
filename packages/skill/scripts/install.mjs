#!/usr/bin/env node
// 安装 Mebular Skill 到常见 Skill 目录（G6.4）。
//
// 用法：
//   node scripts/install.mjs                 # 探测并安装到 cwd 的 .agents/skills、.dsh/skills（及存在的 .opencode/skills）
//   node scripts/install.mjs --global        # 另装到 ~/.agents/skills
//   node scripts/install.mjs --target <dir>  # 只装到指定目录（<dir>/mebular-memory，测试/自定义用）

import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_NAME = 'mebular-memory';

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
const cwd = process.cwd();
const targets = [];
if (typeof flags.target === 'string') {
  targets.push(flags.target);
} else {
  targets.push(join(cwd, '.agents', 'skills'));
  targets.push(join(cwd, '.dsh', 'skills'));
  if (existsSync(join(cwd, '.opencode'))) targets.push(join(cwd, '.opencode', 'skills'));
  if (flags.global === true) targets.push(join(homedir(), '.agents', 'skills'));
}

const installed = [];
for (const target of targets) {
  const dest = join(target, SKILL_NAME);
  await mkdir(dest, { recursive: true });
  await cp(join(pkgRoot, 'SKILL.md'), join(dest, 'SKILL.md'));
  await cp(join(pkgRoot, 'MEMORY_POLICY.md'), join(dest, 'MEMORY_POLICY.md'));
  installed.push(dest);
  console.log(`installed ${dest}`);
}

if (installed.length === 0) {
  console.error('没有可安装的目标目录');
  process.exit(1);
}
console.log(JSON.stringify({ skill: SKILL_NAME, installed }, null, 2));
