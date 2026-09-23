#!/usr/bin/env node
// G6.2 stdio MCP 验证（真实 MCP client）
//
// 以真实 @modelcontextprotocol/client + StdioClientTransport 启动 `mebular mcp`，
// 断言 tools/list 为 27 个工具（记忆 11 + 任务 16）、逐个 tools/call、任务工具结构化错误信封、prompt memory_policy 存在。
// 干净环境退出码 0。前置：npm run build（core dist）。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const serverBin = join(rootDir, 'packages', 'mcp', 'bin', 'mebular.mjs');

// 统一入口 27：记忆 11（冻结面）+ 任务 16（fleet TASK_TOOLS）
const EXPECTED = [
  'memory_write',
  'memory_write_batch',
  'memory_query',
  'memory_search',
  'memory_profile',
  'memory_skills',
  'memory_history',
  'memory_graph',
  'memory_import',
  'memory_status',
  'memory_sync',
  // 任务面 16（复用 fleet TASK_TOOLS：同 handler 不复制）
  'task_submit', 'task_submit_batch', 'task_cancel', 'task_retry',
  'task_status', 'task_list', 'task_history', 'task_children', 'task_summarize',
  'task_subscribe', 'task_negotiate', 'chatter_send', 'chatter_inbox',
  'task_quota', 'task_targets', 'board_create',
];

let passed = true;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) passed = false;
};

function textOf(result) {
  const block = result?.content?.find((c) => c.type === 'text');
  return block?.text ?? '';
}
function structuredOf(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  try {
    return JSON.parse(textOf(result));
  } catch {
    return null;
  }
}

console.log('Mebular G6.2 stdio MCP 验证');
console.log('===========================');

const home = await mkdtemp(join(tmpdir(), 'mebular-mcp-stdio-'));
const client = new Client({ name: 'mebular-verify', version: '0.1.0' });
let transport = null;

try {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverBin, 'mcp'],
    env: {
      ...process.env,
      MEBULAR_HOME: home,
      MEBULAR_STORAGE_PATH: join(home, 'store.jsonl'),
      MEBULAR_DEVICE_ID: 'device-mcp-smoke',
    },
    stderr: 'pipe',
  });
  await client.connect(transport);
  check('真实 MCP client 连接 stdio server', true);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check('tools/list 返回 27 个工具（记忆 11 + 任务 16）', tools.length === 27, `count=${tools.length}`);
  check(
    '工具名与统一入口冻结面一致',
    JSON.stringify(names) === JSON.stringify([...EXPECTED].sort()),
    names.join(','),
  );
  check(
    '任务工具也在统一入口（tools/list 含 task_submit 与 task_status）',
    names.includes('task_submit') && names.includes('task_status'),
  );

  // 写入（单 + 批）
  const w = structuredOf(await client.callTool({ name: 'memory_write', arguments: { items: [{ type: 'fact', content: 'mcp-smoke-memory' }] } }));
  const idFromWrite = w?.stored?.[0]?.id;
  check('memory_write 落图', Array.isArray(w?.stored) && w.stored.length === 1 && typeof idFromWrite === 'string');

  const wb = structuredOf(await client.callTool({ name: 'memory_write_batch', arguments: { items: [{ type: 'preference', content: '深色主题', metadata: { preferenceType: 'theme' } }] } }));
  check('memory_write_batch 落图', Array.isArray(wb?.stored) && wb.stored.length === 1);

  // 查询 / 搜索
  const q = structuredOf(await client.callTool({ name: 'memory_query', arguments: { query: 'mcp-smoke-memory' } }));
  check('memory_query 命中', (q?.totalMatches ?? 0) >= 1, `totalMatches=${q?.totalMatches}`);

  const s = structuredOf(await client.callTool({ name: 'memory_search', arguments: { query: 'mcp-smoke-memory', includeRelations: true } }));
  check('memory_search 命中且含 relations', (s?.memories?.length ?? 0) >= 1 && Array.isArray(s?.relations));

  // 画像 / 技能 / 历史
  const p = structuredOf(await client.callTool({ name: 'memory_profile', arguments: {} }));
  check('memory_profile 有偏好', (p?.preferences?.length ?? 0) >= 1, `prefs=${p?.preferences?.length}`);

  const sk = structuredOf(await client.callTool({ name: 'memory_skills', arguments: {} }));
  check('memory_skills 返回数组', Array.isArray(sk?.skills));

  const h = structuredOf(await client.callTool({ name: 'memory_history', arguments: {} }));
  check('memory_history 返回 totalCount', typeof h?.totalCount === 'number');

  // R3.3：任务工具经统一入口返回**结构化错误信封**（此 home 无 fleet/守护 config → E_NOT_FOUND）
  const taskFail = await client.callTool({ name: 'task_status', arguments: {} });
  check(
    '任务工具错误信封：isError + structuredContent.error{code,message}',
    taskFail?.isError === true && typeof taskFail?.structuredContent?.error?.code === 'string'
      && taskFail.structuredContent.error.code === 'E_NOT_FOUND' && typeof taskFail.structuredContent.error.message === 'string',
    `code=${taskFail?.structuredContent?.error?.code}`,
  );

  // 图
  const g = structuredOf(await client.callTool({ name: 'memory_graph', arguments: { startId: idFromWrite, maxDepth: 1 } }));
  check('memory_graph 遍历', Array.isArray(g?.visitedNodes) && g.visitedNodes.length >= 1);

  // 导入
  const im = structuredOf(await client.callTool({ name: 'memory_import', arguments: { kind: 'kv', data: { k1: 'v1' }, origin: 'stdio-smoke' } }));
  check('memory_import 落图', (im?.nodesCreated ?? 0) >= 1, `nodesCreated=${im?.nodesCreated}`);

  // 状态
  const st = structuredOf(await client.callTool({ name: 'memory_status', arguments: {} }));
  check('memory_status 出 deviceId/stateHash', st?.deviceId === 'device-mcp-smoke' && /^[0-9a-f]{64}$/.test(st?.stateHash ?? ''));

  // 同步：网络未启用 → 诚实失败（降级/失败路径）
  let syncFailed = false;
  try {
    const r = await client.callTool({ name: 'memory_sync', arguments: { peerId: 'device-none' } });
    syncFailed = r?.isError === true;
  } catch {
    syncFailed = true;
  }
  check('memory_sync 网络未启用时诚实失败', syncFailed);

  // 参数钳制：depth 超限被钳（不报错）；batch >100 被拒
  const g2 = structuredOf(await client.callTool({ name: 'memory_graph', arguments: { startId: idFromWrite, maxDepth: 99 } }));
  check('memory_graph depth 超限被钳制（不报错）', Array.isArray(g2?.visitedNodes));

  let batchRejected = false;
  try {
    const big = await client.callTool({ name: 'memory_write_batch', arguments: { items: Array.from({ length: 101 }, () => ({ type: 'fact', content: 'x' })) } });
    batchRejected = big?.isError === true;
  } catch {
    batchRejected = true;
  }
  check('memory_write_batch >100 被拒', batchRejected);

  // prompt
  const prompts = await client.listPrompts();
  check('prompt memory_policy 已注册', prompts.prompts.some((p) => p.name === 'memory_policy'));
  const prompt = await client.getPrompt({ name: 'memory_policy', arguments: {} });
  check('getPrompt(memory_policy) 返回文本', (prompt?.messages?.length ?? 0) >= 1);
} catch (error) {
  check('stdio MCP 端到端', false, String(error?.message ?? error).substring(0, 300));
  if (transport?.stderr) {
    // 打印子进程 stderr 辅助定位（仅失败时）
  }
} finally {
  await client.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

console.log('===========================');
if (passed) {
  console.log('✓ G6.2 stdio MCP 验证通过');
  process.exit(0);
} else {
  console.log('✗ G6.2 stdio MCP 验证失败');
  process.exit(1);
}
