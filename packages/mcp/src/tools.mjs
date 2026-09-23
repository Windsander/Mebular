// MCP 工具面（G6.2 / D35 + R1 统一入口）：**27 个** agent 中立工具 = 记忆 11（薄壳委托 MemoryService）
// + 任务 16（复用 @mebular/fleet 的 TASK_TOOLS handler；同 handler 不复制）。
//
// 钳制：limit ≤ 50（默认 10）、depth ≤ 5、batch ≤ 100。
// 输出：content:[{type:'text'}] + structuredContent（同一对象）。
//
// W3 表面一致性：抽出 `TOOL_SPECS`（单一 handler 注册表），MCP 适配器与 `mebular memory_*` CLI 共用。

import { z } from 'zod';
import { json, fail } from './tool-envelope.mjs';
import { TASK_TOOL_SPECS, TASK_TOOL_SCOPES } from './task-tools.mjs';

export { TASK_TOOL_SPECS } from './task-tools.mjs';

export { json, fail } from './tool-envelope.mjs';

/** 每个工具所需的 OAuth scope（D36） */
export const TOOL_SCOPES = {
  memory_write: 'memory.write',
  memory_write_batch: 'memory.write',
  memory_query: 'memory.read',
  memory_search: 'memory.read',
  memory_profile: 'memory.read',
  memory_skills: 'memory.read',
  memory_history: 'memory.read',
  memory_graph: 'memory.read',
  memory_import: 'memory.admin',
  memory_status: 'memory.read',
  memory_sync: 'memory.admin',
};

/** 记忆面工具名（11）。 */
export const MEMORY_TOOL_NAMES = [
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
];

/** 任务面工具名（16，来自 fleet 的 TASK_TOOLS）。 */
export const TASK_TOOL_NAMES = TASK_TOOL_SPECS.map((spec) => spec.name);

const MAX_BATCH = 100;
const MAX_LIMIT = 50;
const MAX_DEPTH = 5;

export function clampLimit(value, fallback = 10) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}
export function clampDepth(value, fallback = 1) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(n, 0), MAX_DEPTH);
}

const memoryInputSchema = z.object({
  type: z.enum(['fact', 'episode', 'skill', 'preference', 'observation']),
  content: z.string(),
  metadata: z
    .object({
      source: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      tags: z.array(z.string()).optional(),
      relatedTo: z.array(z.string()).optional(),
      expiresAt: z.number().optional(),
      episodeType: z.enum(['conversation', 'task', 'decision', 'error', 'observation', 'other']).optional(),
      category: z.string().optional(),
      name: z.string().optional(),
      preferenceType: z.string().optional(),
      namespace: z.string().optional(),
    })
    .optional(),
});

/** namespace 过滤：单分区或分区列表，均可选（缺省不过滤） */
const namespaceFilter = z.union([z.string(), z.array(z.string())]).optional();

const internalTypes = z.array(z.enum(['fact', 'episode', 'skill', 'preference', 'observation']));

/** 工具注册表：handler(service, args) → MCP 结果对象（CLI 直接取 `structuredContent`）。 */
export const TOOL_SPECS = [
  {
    name: 'memory_write',
    title: '写入记忆',
    description: '写入单条记忆（fact/episode/skill/preference/observation）',
    inputSchema: z.object({ items: z.array(memoryInputSchema).min(1) }),
    handler: async (service, { items }) => {
      try {
        return json({ stored: await service.write(items) });
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    },
  },
  {
    name: 'memory_write_batch',
    title: '批量写入记忆',
    description: `批量写入记忆（最多 ${MAX_BATCH} 条）`,
    inputSchema: z.object({ items: z.array(memoryInputSchema).min(1) }),
    handler: async (service, { items }) => {
      if (items.length > MAX_BATCH) return fail(`批量写入超过上限：${items.length} > ${MAX_BATCH}`);
      try {
        return json({ stored: await service.write(items) });
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    },
  },
  {
    name: 'memory_query',
    title: '查询记忆',
    description: '语义/关键词召回（配置向量索引时走语义）',
    inputSchema: z.object({
      query: z.string().optional(),
      types: internalTypes.optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
      includeHistory: z.boolean().optional(),
      filters: z
        .object({
          tags: z.array(z.string()).optional(),
          createdAfter: z.number().optional(),
          createdBefore: z.number().optional(),
          entity: z.string().optional(),
          minConfidence: z.number().optional(),
          namespace: namespaceFilter,
        })
        .optional(),
    }),
    handler: async (service, args) => {
      try {
        return json(await service.query({
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(args.types ? { types: args.types } : {}),
          limit: clampLimit(args.limit),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.includeHistory !== undefined ? { includeHistory: args.includeHistory } : {}),
          ...(args.filters ? { filters: args.filters } : {}),
        }));
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    },
  },
  {
    name: 'memory_search',
    title: '关键词搜索',
    description: '关键词检索基线，可选一跳关系',
    inputSchema: z.object({
      query: z.string(),
      types: z.array(z.string()).optional(),
      limit: z.number().optional(),
      includeRelations: z.boolean().optional(),
      filters: z
        .object({
          tags: z.array(z.string()).optional(),
          createdAfter: z.number().optional(),
          createdBefore: z.number().optional(),
          namespace: namespaceFilter,
        })
        .optional(),
    }),
    handler: async (service, args) => {
      try {
        return json(await service.search({
          query: args.query,
          ...(args.types ? { types: args.types } : {}),
          limit: clampLimit(args.limit),
          ...(args.includeRelations !== undefined ? { includeRelations: args.includeRelations } : {}),
          ...(args.filters ? { filters: args.filters } : {}),
        }));
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    },
  },
  {
    name: 'memory_profile',
    title: '用户画像',
    description: '返回用户偏好与属性',
    inputSchema: z.object({}),
    handler: async (service) => {
      try {
        return json(await service.profile());
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    },
  },
  {
    name: 'memory_skills',
    title: '技能列表',
    description: '按分类/关键词/标签筛选技能',
    inputSchema: z.object({ category: z.string().optional(), search: z.string().optional(), tags: z.array(z.string()).optional() }),
    handler: async (service, args) => {
      try {
        const skills = await service.skills({
          ...(args.category ? { category: args.category } : {}),
          ...(args.search ? { search: args.search } : {}),
          ...(args.tags ? { tags: args.tags } : {}),
        });
        return json({ skills });
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    },
  },
  {
    name: 'memory_history',
    title: '会话历史',
    description: '按会话/时间/主题筛选会话情节',
    inputSchema: z.object({
      sessionIds: z.array(z.string()).optional(),
      startTime: z.number().optional(),
      endTime: z.number().optional(),
      topic: z.string().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    }),
    handler: async (service, args) => {
      try {
        return json(await service.history({
          ...(args.sessionIds ? { sessionIds: args.sessionIds } : {}),
          ...(args.startTime !== undefined ? { startTime: args.startTime } : {}),
          ...(args.endTime !== undefined ? { endTime: args.endTime } : {}),
          ...(args.topic ? { topic: args.topic } : {}),
          ...(args.limit !== undefined ? { limit: clampLimit(args.limit) } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
        }));
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    },
  },
  {
    name: 'memory_graph',
    title: '图遍历',
    description: `从起点遍历（深度 ≤ ${MAX_DEPTH}）`,
    inputSchema: z.object({
      startId: z.string(),
      direction: z.enum(['outgoing', 'incoming', 'both']).optional(),
      maxDepth: z.number().optional(),
      edgeTypes: z.array(z.string()).optional(),
      namespace: namespaceFilter,
    }),
    handler: async (service, args) => {
      try {
        return json(await service.graph(args.startId, {
          ...(args.direction ? { direction: args.direction } : {}),
          maxDepth: clampDepth(args.maxDepth),
          ...(args.edgeTypes ? { edgeTypes: args.edgeTypes } : {}),
          ...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
        }));
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    },
  },
  {
    name: 'memory_import',
    title: '导入记忆',
    description: '经适配器导入异构来源（kv/markdown/…）',
    inputSchema: z.object({ kind: z.string().optional(), data: z.unknown(), origin: z.string().optional() }),
    handler: async (service, args) => {
      try {
        return json(await service.import({
          ...(args.kind ? { kind: args.kind } : {}),
          data: args.data,
          ...(args.origin ? { origin: args.origin } : {}),
        }));
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    },
  },
  {
    name: 'memory_status',
    title: '记忆状态',
    description: '返回设备/网络/计数/状态哈希/开关',
    inputSchema: z.object({}),
    handler: async (service) => {
      try {
        return json(await service.status());
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    },
  },
  {
    name: 'memory_sync',
    title: '同步对端',
    description: '连接对端并等待一次双向同步（network.enabled 需为 true）',
    inputSchema: z.object({ peerId: z.string(), address: z.string().optional() }),
    handler: async (service, args) => {
      try {
        return json(await service.sync(args.peerId, args.address));
      } catch (error) {
        return fail(String(error?.message ?? error));
      }
    },
  },
];

/** 统一工具注册表（记忆 11 + 任务 16 = 27）：`mebular mcp`（stdio）与 HTTP `/mcp` 都注册这一份。 */
export const ALL_TOOL_SPECS = [...TOOL_SPECS, ...TASK_TOOL_SPECS];

/** 统一工具名（27）——控制台「能力清单」与 CLI `mebular tools` 同源。 */
export const TOOL_NAMES = ALL_TOOL_SPECS.map((spec) => spec.name);

/** 统一 scope 表（记忆 + 任务，27）。 */
export const TOOL_ALL_SCOPES = { ...TOOL_SCOPES, ...TASK_TOOL_SCOPES };

/** 工具名 → spec（记忆 + 任务；CLI 与 MCP 同 handler）。 */
export function toolByName(name) {
  return ALL_TOOL_SPECS.find((t) => t.name === name) ?? null;
}

/** 把工具注册到 McpServer；service 为 MemoryService 实例 */
export function registerTools(server, service) {
  for (const spec of ALL_TOOL_SPECS) {
    server.registerTool(
      spec.name,
      { title: spec.title, description: spec.description, inputSchema: spec.inputSchema },
      (args) => spec.handler(service, args),
    );
  }
}
