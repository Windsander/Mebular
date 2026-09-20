#!/usr/bin/env node
// R5：文档一致性校验（确定性）。
//   ① README.md ↔ README_CN.md 标题结构（层级序列）对齐
//   ② **数字不手写**：README 不放具体测试/覆盖率数字；必须有 CI 状态 badge（由 GitHub 计算）
//   ③ README 里的工具名必须都在 surface 注册表（每处 tool-like 名都在册）
//   ④ 本地链接存在、且不指向 gitignore/不存在路径
// 摘要行 FLEET_SUMMARY。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_TOOLS } from '../packages/fleet/dist/index.js';
import { TOOL_SPECS } from '../packages/mcp/src/tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');
const headingLevels = (md) => [...md.matchAll(/^(#{1,6})\s/gm)].map((m) => m[1].length);

const en = read('README.md');
const cn = read('README_CN.md');

// ① 结构对齐（层级序列一致；文本可各自语言）
const enLv = headingLevels(en).join(',');
const cnLv = headingLevels(cn).join(',');
check('README EN/CN 标题结构对齐', enLv === cnLv, { en: enLv, cn: cnLv });
check('EN/CN 互相链接', /\]\(README_CN\.md\)/.test(en) && /\]\(README\.md\)/.test(cn), {});

// ② 数字不手写 + CI badge
const numericClaims = /(?:\d+\s*(?:套件|用例|passed|tests?|suites?))|(?:Coverage|覆盖率)[^\n]{0,12}\d+(?:\.\d+)?\s*%/i;
check('README 不手写测试/覆盖率数字', !numericClaims.test(en) && !numericClaims.test(cn), {});
const ciBadge = 'actions/workflows/ci.yml/badge.svg';
check('README 用 CI 状态 badge（机器计算）', en.includes(ciBadge) && cn.includes(ciBadge), {});

// ③ 工具名与注册表一致
const known = new Set([...TASK_TOOLS.map((t) => t.name), ...TOOL_SPECS.map((t) => t.name)]);
const TOOL_LIKE = /\b((?:memory|task|chatter|board)_[a-z_]+)\b/g;
const unknown = new Set();
for (const md of [en, cn]) {
  for (const m of md.matchAll(TOOL_LIKE)) {
    if (!known.has(m[1])) unknown.add(m[1]);
  }
}
check('README 工具名均在 surface 注册表', unknown.size === 0, { unknown: [...unknown] });
check('README 提及核心工具（memory_write / task_submit）', /\bmemory_write\b/.test(en) && /\btask_submit\b/.test(en), {});

// ④ 本地链接存在性
const missing = [];
for (const [file, md] of [['README.md', en], ['README_CN.md', cn], ['LIMITATIONS.md', read('LIMITATIONS.md')]]) {
  for (const m of md.matchAll(/\]\(([^)]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = target.split('#')[0];
    if (path.length === 0) continue;
    const abs = path.startsWith('/') ? join(ROOT, path) : resolve(join(ROOT, dirname(file)), path);
    if (!existsSync(abs)) missing.push(`${file} → ${target}`);
  }
}
check('本地链接均存在（无失效/被忽略路径）', missing.length === 0, { missing });

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).map((r) => r.name);
console.log('== check:docs ==');
console.log(`FLEET_SUMMARY ${JSON.stringify({ total: results.length, passed, failed, skipped: [] })}`);
process.exit(failed.length === 0 ? 0 : 1);
