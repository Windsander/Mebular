#!/usr/bin/env node
// W3 S3：表面一致性校验（确定性，无需守护）。
//   ① 每个 MCP 工具（任务 16 + 记忆 11）都有**逐字同名**的 CLI 命令
//   ② 无孤儿工具类命令（源码/帮助里的 tool-like 命令必须都在注册表内）
//   ③ 统一工具表：`fleet tools` / `mebular tools` 与注册表一致
// 摘要行 FLEET_SUMMARY。前置：npm run build。

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TASK_TOOLS } from '../packages/fleet/dist/index.js';
import { TOOL_SPECS } from '../packages/mcp/src/tools.mjs';

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
check('`mebular tools` 与记忆注册表一致', mcpTools?.tools?.length === 11 && mcpTools.tools.map((t) => t.tool).sort().join() === mcpReg.map((t) => t.tool).sort().join(), { count: mcpTools?.tools?.length });

// ② 孤儿检测：源码/帮助文本里的 tool-like 命令必须都在注册表内
const known = new Set([...fleetReg.map((t) => t.tool), ...mcpReg.map((t) => t.tool)].concat(['tools']));
const TOOL_LIKE = /(?:^|[\s|'`(])((?:task|chatter|board|memory)_[a-z_]+)/g;
const orphans = new Set();
for (const file of ['packages/fleet/src/cli.ts', 'packages/mcp/bin/mebular.mjs']) {
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
