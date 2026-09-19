#!/usr/bin/env node
// 仓库整洁性检查（确定性 · 离线 · 秒级）——防复发门禁
//
// 报错项（errors，退出码 1）：
//   1) 孤儿模块：src/**/*.ts 无任何入引用，且非入口 / ambient（*.d.ts）。
//   2) 失效引用：*.md 中出现 `docs.design/<path>`（该目录被 gitignore、不随仓库分发）。
//   3) src 内裸 `throw new Error(`（阶段 6.0 纪律；D6 后升为 error，须用类型化错误）。
// 警告项（warnings，不阻断）：
//   4) `@deprecated` 标记的符号在仓库内无调用者。
//
// 例外清单（见下 EXCEPTIONS / ENTRY_FILES）：只有明确列出的路径才豁免，避免误报。

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.github',
  'docs',
  'docs.design',
  'design-notes',
  '.opencode',
]);

/** 入口文件（不算孤儿）：包入口，由 package.json main/exports 指向 dist 对应源码。 */
const ENTRY_FILES = new Set(['src/index.ts']);

/** 显式例外（目前为空；如确需豁免在此登记并写明理由）。 */
const EXCEPTIONS = new Set();

const errors = [];
const warnings = [];

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

const allFiles = [];
walk(ROOT, allFiles);

const rel = (p) => relative(ROOT, p).split(sep).join('/');
const IMPORT_SPEC =
  /(?:from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"])/g;

/** 把相对 import 解析成真实存在的源码文件（兼容 ESM 的 .js → .ts）。 */
function resolveImport(importer, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(importer), spec);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    base.replace(/\.js$/, '.tsx'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const srcTs = allFiles.filter((f) => rel(f).startsWith('src/') && f.endsWith('.ts'));
const srcOrphans = [];
const referenced = new Set();

for (const file of allFiles) {
  if (!/\.(ts|mts|cts|mjs|js)$/.test(file)) continue;
  const text = readFileSync(file, 'utf-8');
  for (const m of text.matchAll(IMPORT_SPEC)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const target = resolveImport(file, spec);
    if (target) referenced.add(target);
  }
}

for (const file of srcTs) {
  const r = rel(file);
  if (r.endsWith('.d.ts')) continue;
  if (ENTRY_FILES.has(r) || EXCEPTIONS.has(r)) continue;
  if (!referenced.has(file)) srcOrphans.push(r);
}
for (const o of srcOrphans.sort()) errors.push(`孤儿模块（src 内零入引用）: ${o}`);

// 规则 2：*.md 中的 docs.design/<path> 失效引用
const DOCS_REF = /docs\.design\/[A-Za-z0-9._-]+/g;
for (const file of allFiles) {
  if (!file.endsWith('.md')) continue;
  const lines = readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(DOCS_REF)) {
      errors.push(`失效引用（gitignore 的 docs.design 路径）: ${rel(file)}:${i + 1} → ${m[0]}`);
    }
  });
}

// 规则 3：裸 throw new Error（报错；须用类型化错误，如 MebularError + ErrorCodes）
const BARE_THROW = /throw new Error\(/;
for (const file of srcTs) {
  const lines = readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    if (BARE_THROW.test(line)) errors.push(`裸 throw new Error（须用类型化错误）: ${rel(file)}:${i + 1}`);
  });
}

// 规则 4：@deprecated 无调用者（警告）
const DEPRECATED = /@deprecated/;
const SYMBOL_DECL =
  /(?:constructor|function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)|^\s*([A-Za-z_$][\w$]*)\s*[(<]/;
const sourceTexts = allFiles
  .filter((f) => /\.(ts|mts|cts|mjs|js)$/.test(f))
  .map((f) => ({ file: f, text: readFileSync(f, 'utf-8') }));

for (const file of srcTs) {
  const lines = readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    if (!DEPRECATED.test(line)) return;
    let symbol = null;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
      const m = SYMBOL_DECL.exec(lines[j]);
      if (m) {
        symbol = m[1] ?? m[2];
        break;
      }
    }
    if (!symbol) return;
    const word = new RegExp(`\\b${symbol}\\b`);
    const callers = sourceTexts.filter((s) => s.file !== file && word.test(s.text));
    if (callers.length === 0) {
      warnings.push(`@deprecated 无调用者: ${rel(file)}:${i + 1} → ${symbol}`);
    }
  });
}

for (const e of errors) console.log(`✗ ${e}`);
for (const w of warnings) console.log(`⚠ ${w}`);
console.log(
  `check-cleanliness: ${errors.length} 错误 / ${warnings.length} 警告` +
    `（孤儿 ${srcOrphans.length}；扫描 ${srcTs.length} 个 src .ts）`,
);
process.exit(errors.length === 0 ? 0 : 1);
