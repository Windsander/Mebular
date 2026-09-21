#!/usr/bin/env node
// C7 依赖政策门禁：
//  ① package.json 的 dependencies/optionalDependencies 每一项都必须在 THIRD-PARTY.md 中登记；
//  ② 清单内的「新增依赖」必须精确 pin（x.y.z）——legacy-range 需显式标注 legacy-range；
//  ③ 清单条目字段齐备（包名/版本/许可/用途/降级行为）。
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const doc = readFileSync(join(root, 'THIRD-PARTY.md'), 'utf-8');

let passed = 0;
const failed = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  if (ok) passed += 1;
  else failed.push(label);
};

// 「可选运行时导入（非 package.json 依赖）」小节中的条目不参与双向校验
const sections = doc.split(/^### /m);
const declaredSection = sections.find((sec) => sec.startsWith('可选运行时导入')) ?? '';
const rowsAll = doc.split('\n').filter((line) => line.startsWith('| `'));
const rows = rowsAll.filter((line) => !declaredSection.includes(line));

const runtime = Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) });
const missing = runtime.filter(([name]) => !doc.includes(`\`${name}\``));
check(`所有运行时依赖已在 THIRD-PARTY.md 登记（${runtime.length} 项）`, missing.length === 0, missing.map(([n]) => n).join(', '));

check('清单条目字段齐备（包名/版本/许可/用途/降级）', rows.length >= runtime.length && rows.every((line) => line.split('|').length >= 7));

// 精确 pin 规则：非 legacy-range 行必须为 x.y.z（无 ^ ~ *）
const unpinned = [];
for (const line of rows) {
  const cells = line.split('|').map((cell) => cell.trim());
  const nameCell = cells[1] ?? '';
  const versionCell = cells[2] ?? '';
  if (versionCell.includes('legacy-range')) continue;
  nameCell.replace(/`([^`]+)`/g, (_, name) => {
    const declared = (pkg.dependencies ?? {})[name] ?? (pkg.optionalDependencies ?? {})[name];
    if (declared && !/^\d+\.\d+\.\d+$/.test(declared)) unpinned.push(`${name}@${declared}`);
    return name;
  });
}
check('新增（非 legacy-range）依赖精确 pin（x.y.z，无 ^ ~ *）', unpinned.length === 0, unpinned.join(', '));

// 反向：清单里写了但 package.json 没有（防止幽灵登记）
const ghost = [];
for (const line of rows) {
  const name = /^\|\s*`([^`]+)`/.exec(line)?.[1];
  if (name && !(pkg.dependencies ?? {})[name] && !(pkg.optionalDependencies ?? {})[name] && !(pkg.devDependencies ?? {})[name]) {
    ghost.push(name);
  }
}
check('清单无幽灵依赖（均存在于 package.json）', ghost.length === 0, ghost.join(', '));

if (failed.length > 0) {
  console.error(`\n✗ check:deps 失败：${failed.join(' | ')}`);
  process.exit(1);
}
console.log(`\n== check:deps ==\nFLEET_SUMMARY ${JSON.stringify({ total: passed, passed, failed: [], skipped: [] })}`);
void readdirSync;
