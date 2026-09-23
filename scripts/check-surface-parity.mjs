#!/usr/bin/env node
// W3 S3：表面一致性校验（确定性，无需守护）。
//   ① 每个 MCP 工具（任务 16 + 记忆 11）都有**逐字同名**的 CLI 命令
//   ② 无孤儿工具类命令（源码/帮助里的 tool-like 命令必须都在注册表内）
//   ③ 统一工具表：`fleet tools` / `mebular tools` 与注册表一致
// 摘要行 FLEET_SUMMARY。前置：npm run build。

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_TOOLS } from '../packages/fleet/dist/index.js';
import { TOOL_SPECS, TASK_TOOL_SPECS, ALL_TOOL_SPECS } from '../packages/mcp/src/tools.mjs';

const FLEET_CLI = fileURLToPath(new URL('../packages/fleet/dist/cli.js', import.meta.url));
const MCP_BIN = fileURLToPath(new URL('../packages/mcp/bin/mebular.mjs', import.meta.url));

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}
function runJson(bin, args) {
  const res = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf-8' });
  try {
    return JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
  } catch {
    return null;
  }
}

// ① 注册表自洽：CLI 名 === 工具名（逐字同名）
const fleetReg = TASK_TOOLS.map((t) => ({ tool: t.name, cli: t.cli }));
check('任务工具 16 项且 CLI 逐字同名', fleetReg.length === 16 && new Set(fleetReg.map((t) => t.tool)).size === 16 && fleetReg.every((t) => t.cli === t.tool), { count: fleetReg.length });
const mcpReg = TOOL_SPECS.map((t) => ({ tool: t.name, cli: t.name }));
check('记忆工具 11 项且 CLI 逐字同名', mcpReg.length === 11 && new Set(mcpReg.map((t) => t.tool)).size === 11, { count: mcpReg.length });
const overlap = fleetReg.filter((t) => mcpReg.some((m) => m.tool === t.tool));
check('任务面与记忆面工具名不冲突', overlap.length === 0, { overlap });

// ③ 统一工具表（真实 CLI 输出）
const fleetTools = runJson(FLEET_CLI, ['tools']);
check('`fleet tools` 与任务注册表一致', fleetTools?.tools?.length === 16 && fleetTools.tools.every((t) => t.cli === t.tool) && fleetTools.tools.map((t) => t.tool).sort().join() === fleetReg.map((t) => t.tool).sort().join(), { count: fleetTools?.tools?.length });
const mcpTools = runJson(MCP_BIN, ['tools']);
// 记忆面断言：注册表 11 项（输出面向统一入口 27，见下方「统一注册表」检查）
check('`mebular tools` 输出包含全部记忆工具', mcpReg.every((t) => (mcpTools?.tools ?? []).some((x) => x.tool === t.tool)), { count: mcpTools?.tools?.length });

// R1：唯一 MCP 入口（27 = 记忆 11 + 任务 16）
const unified = ALL_TOOL_SPECS.map((t) => t.name);
check(
  '唯一入口：mebular 侧统一注册表 = 27（记忆 11 ∪ 任务 16，无重复）',
  TOOL_SPECS.length === 11 && TASK_TOOL_SPECS.length === 16 && unified.length === 27 && new Set(unified).size === 27
    && TASK_TOOL_SPECS.every((t) => t.name === TASK_TOOLS.find((x) => x.name === t.name)?.name),
  { unified: unified.length, memory: TOOL_SPECS.length, task: TASK_TOOL_SPECS.length },
);
check(
  '`mebular tools` 与统一注册表一致（27）',
  mcpTools?.tools?.length === 27 && mcpTools.tools.map((t) => t.tool).sort().join() === [...unified].sort().join(),
  { count: mcpTools?.tools?.length },
);
// 全仓只有一个 MCP 注册点：fleet 侧不得再有 MCP server（`fleet mcp` 已删除）
const fleetSrc = readFileSync('packages/fleet/src/cli.ts', 'utf-8');
const fleetHasMcpServer = existsSync('packages/fleet/src/mcp.ts');
check(
  '唯一入口：`fleet mcp` 已不存在（无第二个 MCP server 注册点）',
  !fleetHasMcpServer && !/runFleetMcp|command === 'mcp'/.test(fleetSrc) && !/\|mcp\|/.test(fleetSrc),
  { mcpTs: fleetHasMcpServer },
);

// R2：join 令牌关键符号全仓**定义数 = 1**（防「双实现」漂移）
// 评审：全仓定义数 = 1（含 joinWithToken/startJoinService 等；createJoinServer 是 mcp 侧别名 → 查 startJoinService）
const TOKEN_SYMBOLS = ['encodeJoinToken', 'decodeJoinToken', 'describeJoinToken', 'buildJoinToken', 'verifyJoinToken',
  'applyJoinGrant', 'sweepAutoGrantRevokes', 'joinWithToken', 'requestJoin', 'startJoinService'];
const TOKEN_DEF = (name) => new RegExp(`export (?:async )?function ${name}\\b|export const ${name}\\b`, 'g');
const tokenDefs = [];
{
  const srcFiles = [];
  const walkSrc = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walkSrc(full);
      else if (/\.(ts|mjs)$/.test(name) && !name.endsWith('.d.ts')) srcFiles.push(full);
    }
  };
  for (const pkg of ['packages/fleet/src', 'packages/mcp/src']) walkSrc(pkg);
  for (const file of srcFiles) {
    const text = readFileSync(file, 'utf-8');
    for (const symbol of TOKEN_SYMBOLS) {
      const count = (text.match(TOKEN_DEF(symbol)) ?? []).length;
      for (let i = 0; i < count; i += 1) tokenDefs.push({ symbol, file, count });
    }
  }
}
check(
  'R2 令牌/join 全仓定义数 = 1（单一实现，另一侧只薄 re-export）',
  TOKEN_SYMBOLS.every((symbol) => tokenDefs.filter((d) => d.symbol === symbol).length === 1)
    && tokenDefs.every((d) => d.file.startsWith('packages/fleet/src/')),
  { defs: tokenDefs.map((d) => `${d.symbol}@${d.file.split('/').slice(-1)}:${d.count}`) },
);

// 评审 H1：有副作用的工具必须 task.write（scope 逐工具显式声明，禁止名字推断漂移）
const WRITE_TOOLS = ['task_submit', 'task_submit_batch', 'task_cancel', 'task_retry', 'task_subscribe', 'task_negotiate', 'chatter_send', 'chatter_inbox', 'board_create'];
const declared = Object.fromEntries(TASK_TOOLS.map((t) => [t.name, t.scope]));
check(
  'R1.3 scope 显式声明：有副作用的工具必须 task.write（board_create 越权回归）',
  WRITE_TOOLS.every((n) => declared[n] === 'task.write')
    && Object.keys(declared).length === 16
    && TASK_TOOLS.every((t) => t.scope === 'task.read' || t.scope === 'task.write')
    && TASK_TOOLS.filter((t) => t.scope === 'task.read').every((t) => !/^task_(submit|cancel|retry|subscribe|negotiate)|chatter_send|board_create/.test(t.name)),
  { write: WRITE_TOOLS.filter((n) => declared[n] !== 'task.write').join(',') || '全部正确' },
);

// ② 孤儿检测：源码/帮助文本里的 tool-like 命令必须都在注册表内
const known = new Set([...fleetReg.map((t) => t.tool), ...mcpReg.map((t) => t.tool)].concat(['tools']));
const TOOL_LIKE = /(?:^|[\s|'`(])((?:task|chatter|board|memory)_[a-z_]+)/g;
const orphans = new Set();
// H5：第三表面——控制台脚本与 docs/console 里的 tool-like 名也必须在注册表
const extraFiles = [];
{
  const walk = (dir, filter) => {
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        if (statSync(full).isDirectory()) walk(full, filter);
        else if (filter(name)) extraFiles.push(full);
      } catch { /* ignore */ }
    }
  };
  walk('packages/console', (n) => n.endsWith('.js'));
  walk('docs/console', (n) => n.endsWith('.md'));
}
for (const file of ['packages/fleet/src/cli.ts', 'packages/mcp/bin/mebular.mjs', ...extraFiles]) {
  const text = readFileSync(file, 'utf-8');
  for (const m of text.matchAll(TOOL_LIKE)) {
    if (!known.has(m[1])) orphans.add(`${file}:${m[1]}`);
  }
}
check('无孤儿工具类命令（帮助/分发中的 tool-like 名均在注册表）', orphans.size === 0, { orphans: [...orphans] });

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).map((r) => r.name);
console.log('== check:surface-parity ==');
console.log(`FLEET_SUMMARY ${JSON.stringify({ total: results.length, passed, failed, skipped: [] })}`);
process.exit(failed.length === 0 ? 0 : 1);
