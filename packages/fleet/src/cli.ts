#!/usr/bin/env node
// fleet CLI（M2）：`fleet node`（任务板/发起端）、`fleet worker`（执行端）。
//
// 两个命令各自使用**独立 storage 路径 + 独立设备身份**，通过共享 spool 目录交换
// **显式状态事件**（本地最少形态；M3 换真实传输）。输出 JSON 事实供脚本断言。

import { echoResultFor, EchoExecutor, ExecutionLog } from './runtime/executor.js';
import { FleetNode } from './runtime/node.js';
import { FleetWorker } from './runtime/worker.js';
import { FileTaskEventStore } from './store/file-store.js';
import { SpoolTransport } from './transport/spool.js';
import { LocalQuota } from './quota.js';

interface Args {
  [key: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { command: string | undefined; args: Args } {
  const args: Args = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else if (command === undefined) {
      command = token;
    }
  }
  return { command, args };
}

const str = (v: string | boolean | undefined, fallback: string): string =>
  typeof v === 'string' ? v : fallback;
const num = (v: string | boolean | undefined, fallback: number): number => {
  if (typeof v !== 'string') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function runNode(args: Args): Promise<number> {
  const device = str(args.device, 'device-A');
  const spool = str(args.spool, './.fleet/spool');
  const storage = str(args.storage, `./.fleet/${device}.jsonl`);
  const n = num(args.submit, 0);
  const targetDevice = str(args['target-device'], 'device-B');
  const targetAgent = str(args['target-agent'], '*');
  const quotaLimit = num(args['quota-limit'], 1_000_000);
  const quotaMode = str(args['quota-mode'], 'queue') === 'reject' ? 'reject' : 'queue';
  const expires = num(args.expires, 0);
  const duplicateEvery = num(args['duplicate-every'], 1);
  const timeoutMs = num(args['timeout-ms'], 60_000);

  const store = await FileTaskEventStore.open(storage);
  const transport = new SpoolTransport(spool);
  const node = new FleetNode({
    device,
    store,
    transport,
    quota: new LocalQuota({ limitPerDevice: quotaLimit, onOverflow: quotaMode }),
  });

  const decisions = { accepted: 0, queued: 0, rejected: 0 };
  const taskIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const deliveries = duplicateEvery > 1 && i % duplicateEvery === 0 ? 2 : 1;
    const request: Parameters<FleetNode['submit']>[0] = {
      intent: `t-${i}`,
      to: { device: targetDevice, agent: targetAgent },
      deliveries,
    };
    if (i < expires) request.expiresAt = Date.now() - 1_000; // 已过期（本机展示用）
    const { taskId, decision } = await node.submit(request);
    decisions[decision] += 1;
    if (taskId !== null) taskIds.push(taskId);
  }

  const allTerminal = await node.waitForTerminal(taskIds, { timeoutMs });
  const states = (await node.states()).filter((s) => taskIds.includes(s.taskId));
  const byId = new Map(states.map((s) => [s.taskId, s]));
  const done = states.filter((s) => s.status === 'done');
  const failed = states.filter((s) => s.status === 'failed');
  const resultsMatch = taskIds.every((id) => {
    const s = byId.get(id);
    return s?.status === 'done' && s.resultRef === echoResultFor(s.intent);
  });
  const expiredSubmitted = states.filter((s) => s.expiresAt !== undefined).length;
  const expiredCompleted = states.filter((s) => s.expiresAt !== undefined && s.status === 'done').length;

  const facts = {
    role: 'node',
    device,
    submitted: taskIds.length,
    decisions,
    done: done.length,
    failed: failed.length,
    resultsMatch,
    expiredSubmitted,
    expiredCompleted,
    allTerminal,
    taskIds,
  };
  const ok = allTerminal && done.length === n && failed.length === 0 && resultsMatch;
  console.log(JSON.stringify(facts, null, 2));
  await node.close();
  return ok ? 0 : 1;
}

async function runWorker(args: Args): Promise<number> {
  const device = str(args.device, 'device-B');
  const agent = str(args.agent, 'echo');
  const spool = str(args.spool, './.fleet/spool');
  const storage = str(args.storage, `./.fleet/${device}.jsonl`);
  const execLogPath = str(args['exec-log'], `${storage}.exec.jsonl`);
  const timeoutMs = num(args['timeout-ms'], 60_000);
  const exitAfter = num(args['exit-after'], 0);
  const maxPerPoll = num(args['max-per-poll'], 0);
  const intervalMs = num(args['interval-ms'], 5);

  const store = await FileTaskEventStore.open(storage);
  const transport = new SpoolTransport(spool);
  const log = await ExecutionLog.open(execLogPath);
  const worker = new FleetWorker({ device, agent, store, transport, executor: new EchoExecutor(), log });

  await worker.reconcile();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await worker.pollOnce(maxPerPoll > 0 ? maxPerPoll : Number.POSITIVE_INFINITY);
    if (exitAfter > 0 && log.size() >= exitAfter) break;
    await sleep(intervalMs);
  }
  const facts = { role: 'worker', device, agent, executed: log.size(), execLog: execLogPath, taskIds: log.all().map((e) => e.taskId) };
  console.log(JSON.stringify(facts, null, 2));
  await worker.close();
  return 0;
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));
  let code = 2;
  if (command === 'node') code = await runNode(args);
  else if (command === 'worker') code = await runWorker(args);
  else {
    console.error('用法：fleet node … | fleet worker …');
    code = 2;
  }
  process.exit(code);
}

await main();
