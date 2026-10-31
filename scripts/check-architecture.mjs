#!/usr/bin/env node
// 架构守卫（0.3.0 W1）
//
// 强制边界：
// 1. core（src/**）不得 import @mebular/memory-runtime，也不得 import
//    src/runtime 或 src/inference（包已迁出）。
// 2. core / memory-runtime 根入口不得导出废弃的 RuntimeService。
// 3. memory-runtime 原型允许 import `@mebular/core` 包根公共 API，但不得
//    import core 子路径或逃逸到包外的相对路径。
// 4. 产品源码不得再出现 0.3 原型路径 `/runtime/v1`（docs/design 历史文档除外）。
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

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs', '.cjs'];
const PRODUCT_SKIP_DIRS = new Set(['node_modules', 'dist', 'tests', 'test', 'fixtures', 'scripts']);

async function listSourceFiles(dir, { product = false } = {}) {
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
      if (product && PRODUCT_SKIP_DIRS.has(entry.name)) continue;
      out.push(...await listSourceFiles(file, { product }));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension))) {
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
  if (indexText.includes('RuntimeService')) {
    errors.push('src/index.ts 不得导出废弃的 RuntimeService');
  }
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
  const indexFile = join(RUNTIME_SRC, 'index.ts');
  const indexText = await readFile(indexFile, 'utf-8');
  if (indexText.includes('RuntimeService')) {
    errors.push('packages/memory-runtime/src/index.ts 不得导出废弃的 RuntimeService');
  }
  if (existsSync(join(RUNTIME_SRC, 'runtime', 'RuntimeService.ts'))) {
    errors.push('packages/memory-runtime/src/runtime/RuntimeService.ts 应已删除');
  }

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

const LEGACY_RUNTIME_PATH = '/runtime/v1';

const CAPABILITY_FILE = join(ROOT, 'packages', 'mcp', 'src', 'memory-capability.mjs');

/**
 * W10d 守卫：普通 MemoryRecord 的 capability 路径只能委托 MemoryService。
 * 只有 `internal-object` 区段（compact/self_record/context_checkpoint）允许直接
 * GraphStore 写入；区域由源码标记显式圈定。
 */
async function checkMemoryCapabilityWritePath(errors) {
  const text = await readFile(CAPABILITY_FILE, 'utf-8');
  const start = text.indexOf('[internal-object-write]');
  const end = text.indexOf('[/internal-object-write]');
  if (start === -1 || end === -1 || end <= start) {
    errors.push('packages/mcp/src/memory-capability.mjs 缺少 internal-object 写入区段标记');
    return;
  }
  const pattern = /\.graph\.(createNode|updateNode|deleteNode)\s*\(/g;
  for (const match of text.matchAll(pattern)) {
    if (match.index >= start && match.index < end) continue;
    const line = text.slice(0, match.index).split('\n').length;
    errors.push(
      `packages/mcp/src/memory-capability.mjs:${line} 普通 MemoryRecord 路径不得直接 GraphStore.${match[1]}`,
    );
  }
  if (!text.includes('currentService.writeRecords(')) {
    errors.push('packages/mcp/src/memory-capability.mjs 的 /write 必须委托 MemoryService.writeRecords');
  }
  if (!text.includes('currentService.updateRecord(')) {
    errors.push('packages/mcp/src/memory-capability.mjs 的 /update 必须委托 MemoryService.updateRecord');
  }
}

/**
 * W10c 守卫：任务 handler 只有 @mebular/fleet 一份。
 * - MCP 只能适配 fleet 根入口的 TASK_TOOLS，不得 import fleet 内部 store/runtime；
 * - sidecar 本次不暴露任务，不得 import fleet；
 * - TASK_TOOLS 定义全仓唯一，且必须在 packages/fleet/src/surface.ts。
 */
async function checkTaskSurface(errors) {
  const sources = [
    ...await listSourceFiles(join(ROOT, 'packages', 'mcp', 'src')),
    ...await listSourceFiles(SIDECAR_SRC),
  ];
  for (const file of sources) {
    const text = await readFile(file, 'utf-8');
    const relFile = relativeId(ROOT, file);
    const sidecar = file.startsWith(SIDECAR_SRC);
    for (const spec of importSpecifiers(text)) {
      if (sidecar && (spec === '@mebular/fleet' || spec.startsWith('@mebular/fleet/') || /(^|\/)fleet(\/|$)/.test(spec))) {
        errors.push(`${relFile} 的 sidecar 不得 import fleet：${spec}（任务端点本次不实现）`);
        continue;
      }
      if (!sidecar && (spec.includes('packages/fleet/src') || /fleet\/(?:dist|src)\/(?:store|runtime|collab|protocol)(\/|\.|$)/.test(spec))) {
        errors.push(`${relFile} 不得 import fleet 内部 store/runtime：${spec}（只允许 TASK_TOOLS 根入口）`);
      }
    }
    if (!sidecar && /MebularTaskEventStore|reduceTaskEvents|FleetNode/.test(text)) {
      errors.push(`${relFile} 不得复制/直接使用 fleet 任务实现（只允许 TASK_TOOLS 适配）`);
    }
  }

  const taskToolSources = [
    ...await listSourceFiles(join(ROOT, 'packages', 'fleet', 'src')),
    ...await listSourceFiles(join(ROOT, 'packages', 'mcp', 'src')),
    ...await listSourceFiles(SIDECAR_SRC),
  ];
  const definitions = [];
  for (const file of taskToolSources) {
    const text = await readFile(file, 'utf-8');
    if (/export const TASK_TOOLS\b/.test(text)) definitions.push(relativeId(ROOT, file));
  }
  if (definitions.length !== 1 || definitions[0] !== 'packages/fleet/src/surface.ts') {
    errors.push(`TASK_TOOLS 定义必须全仓唯一且在 packages/fleet/src/surface.ts：${definitions.join(', ') || 'none'}`);
  }
  const adapter = await readFile(join(ROOT, 'packages', 'mcp', 'src', 'task-tools.mjs'), 'utf-8');
  if (!adapter.includes('tool.handler(')) {
    errors.push('packages/mcp/src/task-tools.mjs 必须直接调用 fleet TASK_TOOLS 的 handler');
  }
}

const ADMIN_SOURCE = join(ROOT, 'packages', 'mcp', 'src', 'admin.mjs');
const SERVE_SOURCE = join(ROOT, 'packages', 'mcp', 'src', 'serve.mjs');
const RAW_GRAPH_DEBUG_MARKER = '[raw-graph-debug]';

/**
 * W10b 守卫：Console 管理读面必须走 MemoryService 统一读接口。
 * `admin.mjs` 不得再直接 listNodes 做记忆列表/域统计；原始图调试端点
 * （serve.mjs `/app/nodes`）保留，但必须显式标注 `[raw-graph-debug]`。
 */
async function checkAdminMemoryReadPath(errors) {
  const adminText = await readFile(ADMIN_SOURCE, 'utf-8');
  for (const match of adminText.matchAll(/\.(?:storage|graph)\.listNodes\s*\(/g)) {
    const line = adminText.slice(0, match.index).split('\n').length;
    errors.push(
      `packages/mcp/src/admin.mjs:${line} 记忆列表/域统计必须走 MemoryService.listRecords/namespaceStats，不得直接 listNodes`,
    );
  }
  if (!/service\.listRecords\s*\(/.test(adminText)) {
    errors.push('packages/mcp/src/admin.mjs 的 buildMemories 必须委托 MemoryService.listRecords');
  }
  if (!/service\.namespaceStats\s*\(/.test(adminText)) {
    errors.push('packages/mcp/src/admin.mjs 的 buildNamespaces 必须委托 MemoryService.namespaceStats');
  }

  const serveText = await readFile(SERVE_SOURCE, 'utf-8');
  if (/\.(?:storage|graph)\.listNodes\s*\(/.test(serveText)
    && !serveText.includes(RAW_GRAPH_DEBUG_MARKER)) {
    errors.push(
      `packages/mcp/src/serve.mjs 原始图 listNodes 必须标注 ${RAW_GRAPH_DEBUG_MARKER}（调试例外，不是普通记忆读路径）`,
    );
  }
}

/**
 * A8：产品源码不得再提供 0.3 原型 `/runtime/v1`。
 * 只扫产品目录；docs/design、tests、验证脚本和构建产物不在范围内。
 */
async function checkLegacyRuntimePath(errors) {
  for (const file of await listSourceFiles(CORE_SRC, { product: true })) {
    const text = await readFile(file, 'utf-8');
    if (text.includes(LEGACY_RUNTIME_PATH)) {
      errors.push(`${relativeId(ROOT, file)} 不得出现旧路径 ${LEGACY_RUNTIME_PATH}`);
    }
  }
  for (const file of await listSourceFiles(join(ROOT, 'packages'), { product: true })) {
    const text = await readFile(file, 'utf-8');
    if (text.includes(LEGACY_RUNTIME_PATH)) {
      errors.push(`${relativeId(ROOT, file)} 不得出现旧路径 ${LEGACY_RUNTIME_PATH}`);
    }
  }
}

/** @returns {Promise<string[]>} 架构违规列表；空数组表示通过。 */
export async function checkArchitecture() {
  const errors = [];
  await checkCore(errors);
  await checkRuntime(errors);
  await checkSidecar(errors);
  await checkMemoryCapabilityWritePath(errors);
  await checkTaskSurface(errors);
  await checkAdminMemoryReadPath(errors);
  await checkLegacyRuntimePath(errors);
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = await checkArchitecture();
  if (errors.length > 0) {
    console.error('[check-architecture] 发现架构违规：');
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
  } else {
    console.error('[check-architecture] OK：core 无 runtime/inference 反向依赖，旧 /runtime/v1 已退场');
  }
}
