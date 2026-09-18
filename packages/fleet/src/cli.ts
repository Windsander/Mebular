#!/usr/bin/env node
// fleet CLI（M2）：`fleet node`（任务板/发起端）、`fleet worker`（执行端）。
//
// 两个命令各自使用**独立 storage 路径 + 独立设备身份**，通过共享 spool 目录交换
// **显式状态事件**（本地最少形态；M3 换真实传输）。输出 JSON 事实供脚本断言。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import { echoResultFor, EchoExecutor, ExecutionLog } from './runtime/executor.js';
import { FleetNode } from './runtime/node.js';
import { FleetWorker } from './runtime/worker.js';
import { FileTaskEventStore } from './store/file-store.js';
import { MebularTaskEventStore } from './store/mebular-store.js';
import { NullTransport } from './transport/null.js';
import { SpoolTransport } from './transport/spool.js';
import { LocalQuota } from './quota.js';
import { fleetConfigPath, loadFleetConfig, parseAgentSpecs, readMasterKeyFile } from './config.js';
import { buildRegistry, doctor, grantNamespace, mebularOptions, onboardDevice, revokeNamespaceGrant } from './onboard.js';

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

/** `fleet --version`：打印包版本与**构建时的 commit SHA**（`dist/version.json`；缺失→unknown）。 */
function versionString(): string {
  try {
    const raw = readFileSync(new URL('./version.json', import.meta.url), 'utf-8');
    const v = JSON.parse(raw) as { version?: string; sha?: string };
    return `${v.version ?? '0.0.0'} (${v.sha ?? 'unknown'})`;
  } catch {
    return '0.0.0 (unknown)';
  }
}

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

function parseAgents(
  value: string | boolean | undefined,
  command: string | boolean | undefined,
  baseArgs: string | boolean | undefined,
): ReturnType<typeof parseAgentSpecs> | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const commandValue = typeof command === 'string' ? command : undefined;
  const baseArgsValue =
    typeof baseArgs === 'string' && baseArgs.length > 0
      ? baseArgs.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined;
  return parseAgentSpecs(value, {
    ...(commandValue !== undefined ? { command: commandValue } : {}),
    ...(baseArgsValue !== undefined ? { baseArgs: baseArgsValue } : {}),
  });
}

async function runOnboard(args: Args): Promise<number> {
  const dir = str(args.dir, './.fleet');
  const result = await onboardDevice({
    dir,
    device: str(args.device, ''),
    ...(typeof args['master-key'] === 'string' ? { masterKeyFile: args['master-key'] } : {}),
    ...(typeof args['peer-device'] === 'string' ? { peerDevice: args['peer-device'] } : {}),
    ...(typeof args['peer-addr'] === 'string' ? { peerAddr: args['peer-addr'] } : {}),
    ...(typeof args.namespace === 'string' ? { namespace: args.namespace } : {}),
    ...(typeof args.listen === 'string' ? { listen: args.listen } : {}),
    ...(typeof args['policy-issuer'] === 'string' ? { policyIssuers: args['policy-issuer'].split(',') } : {}),
    ...(parseAgents(args.agent, args['agent-command'], args['agent-base-args']) !== undefined
      ? { agents: parseAgents(args.agent, args['agent-command'], args['agent-base-args'])! }
      : {}),
    ...(args['no-config-grant'] === true ? { configGrant: false } : {}),
  });
  console.log(JSON.stringify({
    ok: true,
    role: 'onboard',
    device: result.config.device,
    dir: result.config.dir,
    alreadyOnboarded: result.alreadyOnboarded,
    masterKeyCreated: result.masterKeyCreated,
    masterKeyFingerprint: result.masterKeyFingerprint,
    next: [`fleet serve --dir ${result.config.dir}`, `fleet work --dir ${result.config.dir}`, `fleet doctor --dir ${result.config.dir}`],
  }, null, 2));
  return 0;
}

async function runGrant(args: Args): Promise<number> {
  const dir = str(args.dir, './.fleet');
  const namespaces = str(args.namespace, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const result = await grantNamespace(dir, {
    to: str(args.to, ''),
    ...(namespaces.length > 0 ? { namespaces } : {}),
    ...(typeof args['expires-at'] === 'string' ? { expiresAt: num(args['expires-at'], 0) } : {}),
    ...(typeof args.note === 'string' ? { note: args.note } : {}),
  });
  console.log(JSON.stringify({ ok: true, role: 'grant', ...result }, null, 2));
  return 0;
}

async function runRevoke(args: Args): Promise<number> {
  const dir = str(args.dir, './.fleet');
  const result = await revokeNamespaceGrant(dir, {
    grantId: str(args['grant-id'], ''),
    ...(typeof args.subject === 'string' ? { subject: args.subject } : {}),
    ...(typeof args.note === 'string' ? { note: args.note } : {}),
  });
  console.log(JSON.stringify({ ok: true, role: 'revoke', ...result }, null, 2));
  return 0;
}

async function runDoctor(args: Args): Promise<number> {
  const report = await doctor(str(args.dir, './.fleet'));
  if (args.json === true) console.log(JSON.stringify(report, null, 2));
  else {
    for (const c of report.checks) {
      const hint = c.status === 'FAIL' && c.hint ? `  → ${c.hint}` : '';
      console.log(`${c.status}  ${c.name}  ${c.detail}${hint}`);
    }
    console.log(`summary: ok=${report.ok} skipped=[${report.skipped.join(', ')}]`);
  }
  return report.ok ? 0 : 1;
}

async function runServe(args: Args): Promise<number> {
  const dir = str(args.dir, './.fleet');
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const mebular = new Mebular(mebularOptions(config, encryption) as never);
  await mebular.initialize();
  console.log(JSON.stringify({
    role: 'serve', event: 'listening', device: config.device,
    multiaddr: mebular.node!.getLocalMultiaddrs()[0] ?? null, peerId: mebular.node!.peerId.id,
  }));
  const store = new MebularTaskEventStore(mebular);
  const node = new FleetNode({ device: config.device, store, transport: new NullTransport(), quota: new LocalQuota({ limitPerDevice: config.quotaLimitPerDevice ?? 1_000_000 }) });
  const submit = num(args.submit, 0);
  if (submit > 0) {
    // 先等首轮同步（对端连入）再提交，避免在无连接时提交导致事件丢失触发。
    const waitSyncMs = num(args['wait-sync-ms'], 0);
    if (waitSyncMs > 0) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, waitSyncMs);
        mebular.sync.once('sync-completed', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        });
      });
    }
    const target = config.peers[0];
    const ids: string[] = [];
    for (let i = 0; i < submit; i++) {
      const { taskId } = await node.submit({ intent: `t-${i}`, to: { device: target?.device ?? 'device-B', agent: str(args['target-agent'], 'echo') } });
      if (taskId !== null) ids.push(taskId);
    }
    const ok = await node.waitForTerminal(ids, { timeoutMs: num(args['timeout-ms'], 60_000) });
    const states = (await node.states()).filter((s) => ids.includes(s.taskId));
    const done = states.filter((s) => s.status === 'done');
    const expectPrefix = str(args['expect-prefix'], '');
    const resultsMatch = states.every((s) =>
      s.status === 'done' && (expectPrefix.length > 0 ? (s.resultRef ?? '').startsWith(expectPrefix) : (s.resultRef ?? '').length > 0),
    );
    console.log(JSON.stringify({ role: 'serve', submitted: ids.length, done: done.length, allTerminal: ok, resultsMatch }));
    const lingerMs = num(args['linger-ms'], 0);
    if (lingerMs > 0) await sleep(lingerMs); // 保持在线，便于对端 doctor 看到可达/已收敛
    await mebular.shutdown();
    return ok && done.length === ids.length && resultsMatch ? 0 : 1;
  }
  await sleep(num(args['timeout-ms'], 60_000));
  await mebular.shutdown();
  return 0;
}

async function runWork(args: Args): Promise<number> {
  const dir = str(args.dir, './.fleet');
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const mebular = new Mebular(mebularOptions(config, encryption) as never);
  await mebular.initialize();
  for (const peer of config.peers) {
    if (peer.addr === undefined) continue;
    const id = /\/p2p\/([^/]+)/.exec(peer.addr)?.[1] ?? peer.device;
    try {
      await mebular.node!.connectToPeer({ id, multihash: new Uint8Array(), pubKey: new Uint8Array() }, peer.addr);
    } catch {
      // 连接失败由后续收敛/doctor 暴露
    }
  }
  const store = new MebularTaskEventStore(mebular);
  const log = await ExecutionLog.open(str(args['exec-log'], join(dir, 'exec.jsonl')));
  const worker = new FleetWorker({ device: config.device, agent: str(args.agent, 'worker'), store, transport: new NullTransport(), registry: buildRegistry(config.agents), log });
  await worker.reconcile();
  const deadline = Date.now() + num(args['timeout-ms'], 60_000);
  while (Date.now() < deadline) {
    await worker.pollOnce();
    await sleep(num(args['interval-ms'], 10));
  }
  console.log(JSON.stringify({ role: 'work', device: config.device, executed: log.size() }));
  await mebular.shutdown();
  return 0;
}

async function main(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));
  let code = 2;
  if (args.version === true) {
    console.log(`@mebular/fleet ${versionString()}`);
    process.exit(0);
  }
  try {
  if (command === 'node') code = await runNode(args);
  else if (command === 'worker') code = await runWorker(args);
  else if (command === 'onboard') code = await runOnboard(args);
  else if (command === 'doctor') code = await runDoctor(args);
  else if (command === 'grant') code = await runGrant(args);
  else if (command === 'revoke') code = await runRevoke(args);
  else if (command === 'serve') code = await runServe(args);
  else if (command === 'work') code = await runWork(args);
  else {
    console.error('用法：fleet onboard|doctor|grant|revoke|serve|work|node|worker … | fleet --version');
    code = 2;
  }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: (error as Error).message }));
    process.exit(1);
  }
  process.exit(code);
}

await main();
