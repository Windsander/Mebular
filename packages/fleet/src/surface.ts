// W1 Agent 任务面：**单一工具注册表**（MCP 与 CLI 共用同一 handler，能力完全一致）。
//
// 域 = 记忆数据通道（数据义务）；任务 = 树/DAG；派发三层 L1 传输授权 / L2 任务树 / L3 本地执行。
// 本模块只消费 `@mebular/core` 公共 API；工具输出为**结构化 JSON**。

import { Mebular } from '@mebular/core';
import {
  loadToolConfig,
  readMasterKeyFile,
} from './config.js';
import { declareNamespace, offlineMebularOptions, subscribeNamespace } from './onboard.js';
import { MebularTaskEventStore } from './store/mebular-store.js';
import { negotiationMessageStore, type NegotiationMessage } from './collab/negotiation.js';
import { chatterMessageStore, FleetChatter } from './collab/chatter.js';
import { FleetNode } from './runtime/node.js';
import { NullTransport } from './transport/null.js';
import { LocalQuota } from './quota.js';
import { deriveEdges } from './collab/dag.js';
import { reduceTaskEvents, type TaskState } from './model.js';
import { agentDirectoryStore, expandTargets } from './agentdir.js';
import type { TaskEvent, TaskEventType } from './protocol/events.js';
import { EVENT_TO_STATUS } from './protocol/events.js';
import { DEFAULT_ROOT_BUDGET, type TaskBudget, type TaskDispatch } from './protocol/envelope.js';

export interface ToolContext {
  dir: string;
  namespace?: string;
  agent?: string;
  /**
   * 运行中 daemon 的 live app（由 MCP server 注入）。
   *
   * 提供时 **复用它**：不 `initialize`、不 `shutdown`、不新建第二个离线 Mebular。
   * 这样任务事件写入的是 daemon 自己的 EventLog —— 本地 append / push-on-write / SSE 都能感知；
   * 若另开离线实例写同一 JSONL，daemon 的 EventLog 不感知 append，远端与 SSE 都收不到。
   *
   * 缺省（CLI / stdio 离线路径）：维持原有行为，按 `dir` 新建并关闭一个离线实例。
   */
  mebular?: Mebular;
}

export interface TaskTool {
  name: string;
  /** 等价 CLI 子命令（`fleet <cli>`） */
  cli: string;
  /**
   * R1.3 / 评审 H1：OAuth scope **逐工具显式声明**（禁止按名字推断——`board_create` 曾因归入
   * 只读组而被 `task.read`-only 令牌越权调用）。两轴：task.read（只读）/ task.write（写与授权）。
   */
  scope: 'task.read' | 'task.write';
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

interface Session {
  mebular: Mebular;
  store: MebularTaskEventStore;
  node: FleetNode;
  device: string;
  agent: string;
  namespace: string;
  close: () => Promise<void>;
}

async function openSession(ctx: ToolContext): Promise<Session> {
  // F-UNI：fleet home（fleet.config.json）或守护 home（config.json）都可作为工具上下文
  const config = await loadToolConfig(ctx.dir);
  const namespace = ctx.namespace ?? config.namespace;
  const agent = ctx.agent ?? 'board';
  const live = ctx.mebular;
  let mebular: Mebular;
  if (live !== undefined) {
    // 运行中 daemon：复用 live app（同一实例 / 同一 EventLog）——写入即本地 append，推送与 SSE 正常。
    mebular = live;
  } else {
    const encryption = await readMasterKeyFile(config.masterKeyFile);
    mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
    await mebular.initialize();
  }
  const ownsMebular = live === undefined;
  const device = live?.deviceId ?? config.device;
  const store = new MebularTaskEventStore(mebular, { namespace });
  const node = new FleetNode({
    device,
    agent,
    store,
    transport: new NullTransport(),
    quota: new LocalQuota({ limitPerDevice: config.quotaLimitPerDevice ?? 1_000_000 }),
  });
  return {
    mebular,
    store,
    node,
    device,
    agent,
    namespace,
    close: async () => {
      // live app 的生命周期归 daemon（MCP serve）所有：工具调用只结束会话，不关闭它。
      if (ownsMebular) await mebular.shutdown();
    },
  };
}

function strInput(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function requiredString(input: Record<string, unknown>, key: string): string {
  const v = strInput(input, key);
  if (v === undefined) throw new Error(`${key} 必填（非空字符串）`);
  return v;
}

async function statesOf(store: MebularTaskEventStore): Promise<TaskState[]> {
  const byTask = new Map<string, TaskEvent[]>();
  for (const e of await store.all()) {
    const list = byTask.get(e.taskId);
    if (list) list.push(e);
    else byTask.set(e.taskId, [e]);
  }
  return [...byTask.keys()].sort().map((id) => reduceTaskEvents(byTask.get(id)!)).filter((s): s is TaskState => s !== null);
}

function summarizeState(s: TaskState): Record<string, unknown> {
  return {
    taskId: s.taskId,
    status: s.status,
    from: s.from,
    to: s.to,
    intent: s.intent,
    attempts: s.attempts,
    trace: s.trace,
    lastEventId: s.lastEventId,
    ...(s.resultRef !== undefined ? { resultRef: s.resultRef } : {}),
    ...(s.reason !== undefined ? { reason: s.reason } : {}),
    ...(s.budget !== undefined ? { budget: s.budget } : {}),
    ...(s.dispatch !== undefined ? { dispatch: s.dispatch } : {}),
  };
}

function budgetInput(input: Record<string, unknown>): TaskBudget | undefined {
  const b = input.budget;
  if (b === undefined) return undefined;
  if (typeof b !== 'object' || b === null) throw new Error('budget 必须为对象');
  const r = b as Record<string, unknown>;
  const norm = (k: string, d: number): number => (r[k] === undefined ? d : Number(r[k]));
  const budget: TaskBudget = { maxDepth: norm('maxDepth', DEFAULT_ROOT_BUDGET.maxDepth), maxChildren: norm('maxChildren', DEFAULT_ROOT_BUDGET.maxChildren), maxTasks: norm('maxTasks', DEFAULT_ROOT_BUDGET.maxTasks) };
  for (const [k, v] of Object.entries(budget)) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`budget.${k} 必须为非负整数`);
  }
  return budget;
}
function dispatchInput(input: Record<string, unknown>): TaskDispatch | undefined {
  const d = input.dispatch;
  if (d === undefined) return undefined;
  if (d !== 'children-ok' && d !== 'root-only') throw new Error('dispatch 必须为 children-ok|root-only');
  return d;
}

/** 工具描述首行 = 首要路由信号「何时用」；原始语义/约束保留在第二行。 */
const when = (whenToUse: string, description: string): string => `何时用：${whenToUse}\n${description}`;

export const TASK_TOOLS: TaskTool[] = [
  {
    name: 'task_submit',
    cli: 'task_submit',
    scope: 'task.write',
    description: when('要把任务派给其他设备/Agent 时；先 task_targets 确认可派对象，再提交。', '提交任务（root 或 child）；root 可带预算与派发策略。**非幂等**：重试 = 新任务（需要关联请用 causedBy/chain）'),
    inputSchema: {
      type: 'object',
      required: ['intent', 'to'],
      properties: {
        intent: { type: 'string' },
        to: { type: 'object', properties: { device: { type: 'string' }, agent: { type: 'string' } } },
        payloadRef: { type: 'string' },
        expiresAt: { type: 'number' },
        causedBy: { type: 'string' },
        chain: { type: 'array', items: { type: 'string' } },
        budget: { type: 'object' },
        dispatch: { type: 'string', enum: ['children-ok', 'root-only'] },
      },
    },
    handler: async (input, ctx) => {
      const session = await openSession(ctx);
      try {
        const to = (input.to ?? {}) as { device?: string; agent?: string };
        const causedBy = strInput(input, 'causedBy');
        const chain = Array.isArray(input.chain) ? (input.chain as string[]) : [];
        const budget = budgetInput(input);
        const dispatch = dispatchInput(input);
        const result = await session.node.submit({
          intent: requiredString(input, 'intent'),
          to: { device: requiredString(to as Record<string, unknown>, 'device'), agent: requiredString(to as Record<string, unknown>, 'agent') },
          ...(strInput(input, 'payloadRef') !== undefined ? { payloadRef: strInput(input, 'payloadRef')! } : {}),
          ...(typeof input.expiresAt === 'number' ? { expiresAt: input.expiresAt } : {}),
          ...(causedBy !== undefined ? { trace: { causedBy, chain: [...chain, causedBy] } } : { trace: { chain } }),
          ...(budget !== undefined ? { budget } : {}),
          ...(dispatch !== undefined ? { dispatch } : {}),
        });
        const state = result.taskId !== null ? reduceTaskEvents(await session.store.byTask(result.taskId)) : null;
        return { ok: result.taskId !== null, taskId: result.taskId, decision: result.decision, from: { device: session.device, agent: session.agent }, ...(state ? { state: summarizeState(state) } : {}) };
      } finally {
        await session.close();
      }
    },
  },
  {
    name: 'task_submit_batch',
    cli: 'task_submit_batch',
    scope: 'task.write',
    description: when('一次要派发多个同 root 语义的任务时。', '批量提交任务（同 root 语义）'),
    inputSchema: { type: 'object', required: ['tasks'], properties: { tasks: { type: 'array' } } },
    handler: async (input, ctx) => {
      const tasks = input.tasks;
      if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('tasks 必须为非空数组');
      const results = [];
      for (const t of tasks as Array<Record<string, unknown>>) {
        results.push(await TASK_TOOLS.find((x) => x.name === 'task_submit')!.handler(t, ctx));
      }
      return { ok: results.every((r) => (r as { ok: boolean }).ok), count: results.length, results };
    },
  },
  {
    name: 'task_cancel',
    cli: 'task_cancel',
    scope: 'task.write',
    description: when('任务尚未终态且需要终止时；已终态返回 already-terminal。', '取消未终态任务（写 failed，reason=CANCELLED）'),
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' }, reason: { type: 'string' } } },
    handler: async (input, ctx) => {
      const session = await openSession(ctx);
      try {
        const taskId = requiredString(input, 'taskId');
        const state = reduceTaskEvents(await session.store.byTask(taskId));
        if (state === null) throw new Error(`任务不存在：${taskId}`);
        if (state.terminal) return { ok: false, taskId, reason: 'already-terminal', status: state.status };
        const reason = strInput(input, 'reason') ?? 'CANCELLED';
        const event: TaskEvent = {
          v: 1,
          eventId: `${taskId}#failed@${session.device}`,
          taskId,
          type: 'failed',
          actor: { device: session.device, agent: session.agent },
          at: Date.now(),
          toStatus: 'failed',
          trace: state.trace,
          reason,
        };
        await session.store.append(event);
        return { ok: true, taskId, status: 'failed', reason };
      } finally {
        await session.close();
      }
    },
  },
  {
    name: 'task_retry',
    cli: 'task_retry',
    scope: 'task.write',
    description: when('任务失败/需要重跑且要保留因果链时。', '以新任务重试（链表达：新任务 causedBy 原任务）'),
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
    handler: async (input, ctx) => {
      const session = await openSession(ctx);
      try {
        const taskId = requiredString(input, 'taskId');
        const state = reduceTaskEvents(await session.store.byTask(taskId));
        if (state === null) throw new Error(`任务不存在：${taskId}`);
        const result = await session.node.submit({
          intent: state.intent,
          to: state.to,
          ...(state.payloadRef !== undefined ? { payloadRef: state.payloadRef } : {}),
          trace: { causedBy: taskId, chain: [...state.trace.chain, taskId] },
        });
        return { ok: result.taskId !== null, taskId: result.taskId, retryOf: taskId, decision: result.decision };
      } finally {
        await session.close();
      }
    },
  },
  {
    name: 'task_status',
    cli: 'task_status',
    scope: 'task.read',
    description: when('需要单任务的权威状态/进度时。', '查询单任务权威状态'),
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
    handler: async (input, ctx) => {
      const session = await openSession(ctx);
      try {
        const taskId = requiredString(input, 'taskId');
        const state = reduceTaskEvents(await session.store.byTask(taskId));
        return state === null ? { ok: false, taskId, state: null } : { ok: true, taskId, state: summarizeState(state) };
      } finally {
        await session.close();
      }
    },
  },
  {
    name: 'task_list',
    cli: 'task_list',
    scope: 'task.read',
    description: when('需要总览任务，或按状态/来源筛选时。', '列出任务（可按 status/from 过滤）'),
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, fromDevice: { type: 'string' } } },
    handler: async (input, ctx) => {
      const session = await openSession(ctx);
      try {
        let states = await statesOf(session.store);
        const status = strInput(input, 'status');
        const fromDevice = strInput(input, 'fromDevice');
        if (status !== undefined) states = states.filter((s) => s.status === status);
        if (fromDevice !== undefined) states = states.filter((s) => s.from.device === fromDevice);
        return { ok: true, count: states.length, tasks: states.map(summarizeState) };
      } finally {
        await session.close();
      }
    },
  },
  {
    name: 'task_history',
    cli: 'task_history',
    scope: 'task.read',
    description: when('需要审计单任务全部事件或定位失败原因时。', '任务的全部事件（确定序）'),
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
    handler: async (input, ctx) => {
      const session = await openSession(ctx);
      try {
        const taskId = requiredString(input, 'taskId');
        const events = (await session.store.byTask(taskId)).sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
        return { ok: true, taskId, events };
      } finally {
        await session.close();
      }
    },
  },
  {
    name: 'task_children',
    cli: 'task_children',
    scope: 'task.read',
    description: when('需要展开某任务的直接子任务时。', '任务的直接子任务（trace.causedBy）'),
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
    handler: async (input, ctx) => {
      const session = await openSession(ctx);
      try {
        const taskId = requiredString(input, 'taskId');
        const states = await statesOf(session.store);
        const children = deriveEdges(states).filter((e) => e.parent === taskId).map((e) => e.child).sort();
        return { ok: true, taskId, children };
      } finally {
        await session.close();
      }
    },
  },
  {
    name: 'task_summarize',
    cli: 'task_summarize',
    scope: 'task.read',
    description: when('需要从 root 汇总整棵 DAG/整体进度时。', '从 root 可达子图的汇总（复用 summarizeDag）'),
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } },
    handler: async (input, ctx) => {
      const session = await openSession(ctx);
      try {
        const taskId = requiredString(input, 'taskId');
        return { ok: true, ...(await session.node.summarizeDag(taskId)) };
      } finally {
        await session.close();
      }
    },
  },
  {
    name: 'task_subscribe',
    cli: 'task_subscribe',
    scope: 'task.write',
    description: when('需要增量轮询任务变化（cursor）时；单次返回，CLI --watch 轮询。', '变化订阅：返回自 cursor 起有变化的任务（单次）；CLI --watch 轮询'),
    inputSchema: { type: 'object', properties: { cursor: { type: 'object' } } },
    handler: async (input, ctx) => {
      const session = await openSession(ctx);
      try {
        const cursor = (input.cursor ?? {}) as Record<string, string>;
        const states = await statesOf(session.store);
        const changed = states.filter((s) => cursor[s.taskId] !== s.lastEventId).map(summarizeState);
        const nextCursor = Object.fromEntries(states.map((s) => [s.taskId, s.lastEventId]));
        return { ok: true, changed, cursor: nextCursor };
      } finally {
        await session.close();
      }
    },
  },
  {
    name: 'task_negotiate',
    cli: 'task_negotiate',
    scope: 'task.write',
    description: when('接收方需要澄清/还价/接受/拒绝任务时；messageId 幂等。', '发送协商消息（clarify/counter/accept/reject；messageId 幂等）'),
    inputSchema: { type: 'object', required: ['taskId', 'kind', 'round'], properties: { taskId: { type: 'string' }, kind: { type: 'string' }, round: { type: 'number' }, text: { type: 'string' } } },
    handler: async (input, ctx) => {
      const session = await openSession(ctx);
      try {
        const taskId = requiredString(input, 'taskId');
        const kind = requiredString(input, 'kind');
        if (!['clarify', 'counter', 'accept', 'reject'].includes(kind)) throw new Error('kind 非法');
        const round = Number(input.round);
        if (!Number.isInteger(round) || round < 0) throw new Error('round 必须为非负整数');
        const store = negotiationMessageStore(session.mebular, session.namespace);
        const message: NegotiationMessage = {
          v: 1,
          messageId: `${taskId}#neg#${round}@${session.device}`,
          taskId,
          round,
          from: { device: session.device, agent: session.agent },
          kind: kind as NegotiationMessage['kind'],
          ...(strInput(input, 'text') !== undefined ? { text: strInput(input, 'text')! } : {}),
        };
        const appended = await store.append(message);
        return { ok: true, appended, messageId: message.messageId };
      } finally {
        await session.close();
      }
    },
  },
  {
    name: 'chatter_send',
    cli: 'chatter_send',
    scope: 'task.write',
    description: when('需要非任务型协作闲聊/状态同步，且接受本地配额记账时。', '配额制闲聊发送（本地配额记账）'),
    inputSchema: { type: 'object', required: ['topic', 'text'], properties: { topic: { type: 'string' }, text: { type: 'string' }, messageId: { type: 'string' } } },
    handler: async (input, ctx) => {
      const session = await openSession(ctx);
      try {
        const quota = new LocalQuota({ limitPerDevice: 1000 });
        const chatter = new FleetChatter({ device: session.device, quota, store: chatterMessageStore(session.mebular, session.namespace) });
        const messageId = strInput(input, 'messageId') ?? `${session.device}-${Date.now().toString(36)}`;
        const decision = await chatter.send({
          v: 1,
          messageId,
          from: { device: session.device, agent: session.agent },
          topic: requiredString(input, 'topic'),
          text: requiredString(input, 'text'),
        });
        return { ok: decision === 'accepted', decision, messageId };
      } finally {
        await session.close();
      }
    },
  },
  {
    name: 'chatter_inbox',
    cli: 'chatter_inbox',
    scope: 'task.write',
    description: when('需要读取本机闲聊收件箱时（幂等去重、确定序）。', '闲聊收件箱（幂等去重、确定序）'),
    inputSchema: { type: 'object', properties: {} },
    handler: async (_input, ctx) => {
      const session = await openSession(ctx);
      try {
        const chatter = new FleetChatter({ device: session.device, quota: new LocalQuota({ limitPerDevice: 1000 }), store: chatterMessageStore(session.mebular, session.namespace) });
        const inbox = await chatter.inbox();
        return { ok: true, count: inbox.length, messages: inbox };
      } finally {
        await session.close();
      }
    },
  },
  {
    name: 'task_quota',
    cli: 'task_quota',
    scope: 'task.read',
    description: when('派发前确认本机配额、避免超限时。', '本机配额状态（每设备对自己发出本地记账；无全局账本）'),
    inputSchema: { type: 'object', properties: {} },
    handler: async (_input, ctx) => {
      const config = await loadToolConfig(ctx.dir);
      return { ok: true, device: config.device, limitPerDevice: config.quotaLimitPerDevice ?? 1_000_000, note: '本地记账，无全局账本；墙钟不参与一致性判定' };
    },
  },
  {
    name: 'task_targets',
    cli: 'task_targets',
    scope: 'task.read',
    description: when('派发前先查“我能派给谁”（订阅任务域 ∩ Agent 目录）。', '我能派给谁：订阅任务域的对端 ∩ 其 Agent 目录（device, agent）'),
    inputSchema: { type: 'object', properties: {} },
    handler: async (_input, ctx) => {
      const session = await openSession(ctx);
      try {
        const config = await loadToolConfig(ctx.dir);
        const subscribed: string[] = [];
        for (const peer of config.peers) {
          const namespaces = await session.mebular.getSubscriptions(peer.device);
          if (namespaces.includes(session.namespace)) subscribed.push(peer.device);
        }
        const entries = await agentDirectoryStore(session.mebular, 'agents').all();
        const targets = expandTargets(entries, subscribed);
        return { ok: true, namespace: session.namespace, subscribed, targets };
      } finally {
        await session.close();
      }
    },
  },
  {
    name: 'board_create',
    cli: 'board_create',
    scope: 'task.write',
    description: when('需要开新任务板/域并邀请成员时。', '建板（= 建域 + 本机订阅 + 邀请成员）；域是板的薄封装'),
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, with: { type: 'array', items: { type: 'string' } } } },
    handler: async (input, ctx) => {
      const name = requiredString(input, 'name');
      const withDevices = Array.isArray(input.with) ? (input.with as string[]) : [];
      const config = await loadToolConfig(ctx.dir);
      const live = ctx.mebular !== undefined ? { mebular: ctx.mebular } : {};
      // 建域 = 公告（零门槛）+ 本机订阅；其他设备自行订阅（不能代订）。
      // 运行中 daemon 注入 live app 时复用同一 EventLog（不另开离线写者）。
      const declaration = await declareNamespace(ctx.dir, { namespace: name, note: `board ${name}`, ...live });
      const subscription = await subscribeNamespace(ctx.dir, { namespace: name, note: `board ${name}`, ...live });
      return {
        ok: true,
        namespace: name,
        declaredBy: config.device,
        declarationEventId: declaration.eventId,
        subscribedBy: [config.device],
        subscriptionEventId: subscription.eventId,
        invited: withDevices,
        note: '其他设备需自行订阅该域（订阅零门槛；不能替他人订阅）',
      };
    },
  },
];

/** 工具名 → handler（MCP tools/call 用）。 */
export function toolByName(name: string): TaskTool | undefined {
  return TASK_TOOLS.find((t) => t.name === name);
}
/** CLI 子命令 → handler。 */
export function toolByCli(cli: string): TaskTool | undefined {
  return TASK_TOOLS.find((t) => t.cli === cli);
}
/** 工具 ↔ CLI 对照表（文档/测试用）。 */
export function toolCliTable(): Array<{ tool: string; cli: string }> {
  return TASK_TOOLS.map((t) => ({ tool: t.name, cli: t.cli }));
}

/** 事件类型 → 状态（供表面工具/测试复用，避免硬编码）。 */
export function statusOfEventType(type: TaskEventType): string {
  return EVENT_TO_STATUS[type];
}
