#!/usr/bin/env node
// 架构守卫（0.3.0 W1）
//
// 强制边界：
// 1. core（src/**）不得 import @mebular/memory-runtime，也不得 import
//    src/runtime 或 src/inference（包已迁出）。
// 2. core 根入口不得导出 runtime / inference。
// 3. memory-runtime 原型允许 import `@mebular/core` 包根公共 API，但不得
//    import core 子路径或逃逸到包外的相对路径。
//
// 只读源码文本，不执行构建产物；`npm run check:architecture` 与 Jest
// tests/architecture/boundaries.test.mjs 共用同一实现。

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SRC = join(ROOT, 'src');
const RUNTIME_SRC = join(ROOT, 'packages', 'memory-runtime', 'src');

const IMPORT_PATTERN = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

async function listSourceFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listSourceFiles(file));
    } else if (entry.isFile() && (file.endsWith('.ts') || file.endsWith('.mts'))) {
      out.push(file);
    }
  }
  return out;
}

function importSpecifiers(text) {
  const specs = [];
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const spec = match[1];
    if (spec) specs.push(spec);
  }
  return specs;
}

function relativeId(fromDir, absoluteTarget) {
  return relative(fromDir, absoluteTarget).split(sep).join('/');
}

async function checkCore(errors) {
  const indexFile = join(CORE_SRC, 'index.ts');
  const indexText = await readFile(indexFile, 'utf-8');
  for (const spec of importSpecifiers(indexText)) {
    if (/(^|\/)runtime(\/|$)/.test(spec) || /(^|\/)inference(\/|$)/.test(spec)) {
      errors.push(`src/index.ts 不得导出 runtime/inference：${spec}`);
    }
  }

  for (const file of await listSourceFiles(CORE_SRC)) {
    const text = await readFile(file, 'utf-8');
    const relFile = relativeId(ROOT, file);
    for (const spec of importSpecifiers(text)) {
      if (spec === '@mebular/memory-runtime' || spec.startsWith('@mebular/memory-runtime/')) {
        errors.push(`${relFile} 不得 import memory-runtime：${spec}`);
        continue;
      }
      if (spec.startsWith('src/runtime') || spec.startsWith('src/inference')) {
        errors.push(`${relFile} 不得 import core 内已迁出的模块：${spec}`);
        continue;
      }
      if (!spec.startsWith('.')) continue;
      const target = resolve(dirname(file), spec);
      const rel = relativeId(CORE_SRC, target);
      if (rel === '..' || rel.startsWith('../')) {
        errors.push(`${relFile} 的相对 import 逃逸出 src：${spec}`);
        continue;
      }
      if (rel === 'runtime' || rel.startsWith('runtime/')
        || rel === 'inference' || rel.startsWith('inference/')) {
        errors.push(`${relFile} 不得 import ../runtime 或 ../inference：${spec}`);
      }
    }
  }

  for (const moved of ['runtime', 'inference']) {
    if (existsSync(join(CORE_SRC, moved))) {
      errors.push(`src/${moved} 仍存在；core 不再包含 runtime/inference`);
    }
  }
}

async function checkRuntime(errors) {
  for (const file of await listSourceFiles(RUNTIME_SRC)) {
    const text = await readFile(file, 'utf-8');
    const relFile = relativeId(ROOT, file);
    for (const spec of importSpecifiers(text)) {
      if (spec.startsWith('@mebular/core/')) {
        errors.push(`${relFile} 不得 import core 子路径：${spec}（只能用 @mebular/core 包根）`);
        continue;
      }
      if (spec.startsWith('src/') || spec.startsWith('packages/')) {
        errors.push(`${relFile} 不得 import 仓库内部路径：${spec}`);
        continue;
      }
      if (!spec.startsWith('.')) continue;
      const target = resolve(dirname(file), spec);
      const rel = relativeId(RUNTIME_SRC, target);
      if (rel === '..' || rel.startsWith('../')) {
        errors.push(`${relFile} 的相对 import 逃逸出 memory-runtime/src：${spec}`);
      }
    }
  }
}

const SIDECAR_SRC = join(RUNTIME_SRC, 'sidecar');
const SIDECAR_FORBIDDEN_IMPORT = /(^|\/)(GraphStore|EventLog|SyncManager|MemoryService)(\/|$|\.)/;

/**
 * W4a 架构守卫：sidecar 只能通过 capability client 访问记忆。
 * 不得 import core / MCP 内部模块，也不得直接打开图/事件日志/同步服务。
 */
async function checkSidecar(errors) {
  for (const file of await listSourceFiles(SIDECAR_SRC)) {
    const text = await readFile(file, 'utf-8');
    const relFile = relativeId(ROOT, file);
    for (const spec of importSpecifiers(text)) {
      if (spec === '@mebular/core' || spec.startsWith('@mebular/core/')) {
        errors.push(`${relFile} 的 sidecar 不得 import @mebular/core：${spec}`);
        continue;
      }
      if (spec === '@mebular/mcp' || spec.startsWith('@mebular/mcp/')) {
        errors.push(`${relFile} 的 sidecar 不得 import @mebular/mcp：${spec}`);
        continue;
      }
      if (spec.includes('packages/mcp') || spec.startsWith('src/graph') || spec.startsWith('src/memory')) {
        errors.push(`${relFile} 的 sidecar 不得 import MCP/core 内部路径：${spec}`);
        continue;
      }
      if (SIDECAR_FORBIDDEN_IMPORT.test(spec)) {
        errors.push(`${relFile} 的 sidecar 不得 import 图/事件/同步/记忆服务：${spec}`);
      }
    }
  }
}

/** @returns {Promise<string[]>} 架构违规列表；空数组表示通过。 */
export async function checkArchitecture() {
  const errors = [];
  await checkCore(errors);
  await checkRuntime(errors);
  await checkSidecar(errors);
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = await checkArchitecture();
  if (errors.length > 0) {
    console.error('[check-architecture] 发现架构违规：');
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
  } else {
    console.error('[check-architecture] OK：core 无 runtime/inference 反向依赖');
  }
}
