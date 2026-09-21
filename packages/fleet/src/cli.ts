#!/usr/bin/env node
// fleet CLI（M2）：`fleet node`（任务板/发起端）、`fleet worker`（执行端）。
//
// 两个命令各自使用**独立 storage 路径 + 独立设备身份**，通过共享 spool 目录交换
// **显式状态事件**（本地最少形态；M3 换真实传输）。输出 JSON 事实供脚本断言。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mebular } from '@mebular/core';
import {
  installService,
  runServiceCli,
  resolveBuildSha,
  startHeartbeat,
  type ServiceDescriptor,
  type ServicePlatform,
} from '@mebular/service';
import { echoResultFor, EchoExecutor, ExecutionLog } from './runtime/executor.js';
import { FleetNode } from './runtime/node.js';
import { FleetWorker } from './runtime/worker.js';
import { FileTaskEventStore } from './store/file-store.js';
import { MebularTaskEventStore } from './store/mebular-store.js';
import { DaemonTaskEventStore } from './store/daemon-store.js';
import type { TaskEventStore } from './store/file-store.js';
import { NullTransport } from './transport/null.js';
import { SpoolTransport } from './transport/spool.js';
import { LocalQuota } from './quota.js';
import { fleetConfigPath, loadFleetConfig, parseAgentSpecs, readMasterKeyFile, type FleetConfig } from './config.js';
import {
  buildRegistry,
  declarePolicyIssuer,
  doctor,
  grantNamespace,
  mebularOptions,
  namespaceMembers,
  namespaceMembership,
  leaveNamespace,
  offlineMebularOptions,
  planHandoff,
  rejoinNamespace,
  onboardDevice,
  revokeNamespaceGrant,
  setNamespaceMembership,
  type DoctorReport,
} from './onboard.js';
import {
  approveDevice,
  autoApproveOnce,
  defaultDeviceName,
  defaultFleetDir,
  joinFleet,
  pendingDevices,
  pickLanHost,
  agentMcpConfig,
  quickstart,
  readJoinCode,
  writeJoinCodeFile,
  type ServiceInstaller,
} from './quickstart.js';
import { buildJoinToken, startJoinService, DEFAULT_GRANT_TTL_MS, type JoinService } from './jointoken.js';
import { renderTerminalQr, renderSvgQr } from './qr.js';
import { createRequire } from 'node:module';
import { joinWithToken } from './join.js';
import { toolByCli, toolCliTable } from './surface.js';
import { runFleetMcp } from './mcp.js';

interface Args {
  [key: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { command: string | undefined; args: Args; positionals: string[] } {
  const args: Args = {};
  const positionals: string[] = [];
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
    } else {
      positionals.push(token);
    }
  }
  return { command, args, positionals };
}

const DEFAULT_JOIN_PORT_FALLBACK = 4002;
const str = (v: string | boolean | undefined, fallback: string): string =>
  typeof v === 'string' ? v : fallback;
const num = (v: string | boolean | undefined, fallback: number): number => {
  if (typeof v !== 'string') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 默认设备目录：`--dir` → `FLEET_DIR` → `~/.fleet`。 */
function fleetDirFrom(args: Args): string {
  return str(args.dir, defaultFleetDir());
}
/** 默认设备名：`--device` → `FLEET_DEVICE` → 主机名（清洗）。 */
function fleetDeviceFrom(args: Args): string {
  return str(args.device, process.env.FLEET_DEVICE ?? defaultDeviceName());
}
/** 医生报告的**脱敏摘要**（只含状态与检查名，不含任何材料）。 */
function summarizeDoctor(report: DoctorReport): Record<string, unknown> {
  return {
    ok: report.ok,
    skipped: report.skipped,
    failed: report.checks.filter((c) => c.status === 'FAIL').map((c) => c.name),
    warn: report.checks.filter((c) => c.status === 'WARN').map((c) => c.name),
  };
}
/** 服务安装器：安装 `fleet-node`（监听方/任务板），失败不致命（doctor 会明列 SKIP/FAIL）。 */
function fleetNodeInstaller(): ServiceInstaller {
  return async (dir: string) => {
    try {
      const node = fleetServiceDescriptors(dir).find((d) => d.kind === 'fleet-node');
      if (!node) return { installed: false, note: '无 fleet-node 描述子' };
      const result = installService(node, { sha: buildSha() });
      return result.ok ? { installed: true } : { installed: false, note: 'install 返回非 ok' };
    } catch (error) {
      return { installed: false, note: (error as Error).message };
    }
  };
}

/** 构建 SHA（心跳/服务单元用）：version.json → env → git → unknown。 */
function buildSha(): string {
  try {
    const v = JSON.parse(readFileSync(new URL('./version.json', import.meta.url), 'utf-8')) as { sha?: string };
    if (v.sha && v.sha !== 'unknown') return v.sha;
  } catch {
    // fall through
  }
  return resolveBuildSha();
}

/** 常驻模式（`--run-forever`）：注册终止信号，返回 `isStopping` 与注销函数。 */
function installShutdownHandlers(): { isStopping: () => boolean; dispose: () => void } {
  let stopping = false;
  const onSignal = (): void => {
    stopping = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGBREAK', onSignal);
  return {
    isStopping: () => stopping,
    dispose: () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('SIGBREAK', onSignal);
    },
  };
}

/** 服务描述子（fleet-node / fleet-worker），供 `fleet service` 与单元生成复用。 */
function fleetServiceDescriptors(dir: string): ServiceDescriptor[] {
  const cliPath = fileURLToPath(import.meta.url);
  const common = { execPath: process.execPath, heartbeatDir: dir, workingDir: dir, env: { MEBULAR_FLEET_DIR: dir } };
  return [
    { kind: 'fleet-node', args: [cliPath, 'node', '--dir', dir, '--run-forever'], ...common },
    { kind: 'fleet-worker', args: [cliPath, 'worker', '--dir', dir, '--run-forever'], ...common },
  ];
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : undefined;
}

/** `fleet service …`：raw argv（保留 service 自身 flags，如 --no-autostart/--label/--extra）。 */
function runFleetService(argv: readonly string[]): number {
  const dir = flagValue(argv, '--dir') ?? defaultFleetDir();
  return runServiceCli({
    descriptors: fleetServiceDescriptors(dir),
    argv,
    ...(flagValue(argv, '--home') !== undefined ? { home: flagValue(argv, '--home')! } : {}),
    ...(flagValue(argv, '--platform') !== undefined
      ? { platform: flagValue(argv, '--platform')! as ServicePlatform }
      : {}),
  });
}

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
  const dir = fleetDirFrom(args);
  const result = await onboardDevice({
    dir,
    device: fleetDeviceFrom(args),
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
    next: [`fleet node --dir ${result.config.dir}`, `fleet worker --dir ${result.config.dir}`, `fleet doctor --dir ${result.config.dir}`],
  }, null, 2));
  return 0;
}

async function runGrant(args: Args): Promise<number> {
  const dir = fleetDirFrom(args);
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
  const dir = fleetDirFrom(args);
  const result = await revokeNamespaceGrant(dir, {
    grantId: str(args['grant-id'], ''),
    ...(typeof args.subject === 'string' ? { subject: args.subject } : {}),
    ...(typeof args.note === 'string' ? { note: args.note } : {}),
  });
  console.log(JSON.stringify({ ok: true, role: 'revoke', ...result }, null, 2));
  return 0;
}

async function runDeclareIssuer(args: Args): Promise<number> {
  const dir = fleetDirFrom(args);
  const result = await declarePolicyIssuer(dir, {
    to: str(args.to, ''),
    ...(typeof args.note === 'string' ? { note: args.note } : {}),
  });
  console.log(JSON.stringify({ ok: true, role: 'declare-issuer', ...result }, null, 2));
  return 0;
}

async function runMember(args: Args): Promise<number> {
  const dir = fleetDirFrom(args);
  const result = await setNamespaceMembership(dir, {
    to: str(args.to, ''),
    ...(typeof args.namespace === 'string' ? { namespace: args.namespace } : {}),
    active: args.leave === true ? false : true,
    ...(typeof args.note === 'string' ? { note: args.note } : {}),
  });
  console.log(JSON.stringify({ ok: true, role: 'member', ...result }, null, 2));
  return 0;
}

async function runMembers(args: Args): Promise<number> {
  const dir = fleetDirFrom(args);
  const namespace = typeof args.namespace === 'string' ? args.namespace : undefined;
  const membership = await namespaceMembership(dir, namespace);
  const members = await namespaceMembers(dir, namespace);
  console.log(
    JSON.stringify(
      { ok: true, role: 'members', namespace: namespace ?? '(config default)', active: membership.active, members, onRecord: membership.members },
      null,
      2,
    ),
  );
  return 0;
}

async function runLeave(args: Args): Promise<number> {
  const dir = fleetDirFrom(args);
  const namespace = typeof args.namespace === 'string' ? args.namespace : undefined;
  const successor = str(args.successor, '');
  if (args['dry-run'] === true) {
    const plan = await planHandoff(dir, { successor, ...(namespace !== undefined ? { namespace } : {}) });
    console.log(JSON.stringify({ role: 'leave', dryRun: true, ...plan }, null, 2));
    return plan.ok ? 0 : 1;
  }
  const result = await leaveNamespace(dir, {
    successor,
    ...(namespace !== undefined ? { namespace } : {}),
    ...(args.force === true ? { force: true } : {}),
    ...(typeof args.note === 'string' ? { note: args.note } : {}),
  });
  console.log(JSON.stringify({ role: 'leave', ...result }, null, 2));
  return result.ok ? 0 : 1;
}

async function runRejoin(args: Args): Promise<number> {
  const dir = fleetDirFrom(args);
  const result = await rejoinNamespace(dir, typeof args.namespace === 'string' ? { namespace: args.namespace } : {});
  console.log(JSON.stringify({ role: 'rejoin', ...result }, null, 2));
  return result.ok ? 0 : 1;
}

async function runDoctor(args: Args): Promise<number> {
  const report = await doctor(fleetDirFrom(args));
  if (args.json === true) console.log(JSON.stringify(report, null, 2));
  else {
    for (const c of report.checks) {
      const hint = (c.status === 'FAIL' || c.status === 'WARN') && c.hint ? `  → ${c.hint}` : '';
      console.log(`${c.status}  ${c.name}  ${c.detail}${hint}`);
    }
    console.log(`summary: ok=${report.ok} skipped=[${report.skipped.join(', ')}]`);
  }
  return report.ok ? 0 : 1;
}


/** W2：存储模式（`--store` 覆盖 config.store；缺省 embedded 以保持既有验收）。 */
function storeMode(config: FleetConfig, args: Args): 'daemon' | 'embedded' {
  const flag = str(args.store, '');
  if (flag === 'daemon' || flag === 'embedded') return flag;
  return config.store ?? 'embedded';
}

/**
 * W2：打开任务存储。`daemon` 模式走守护 app 接口（fleet 客户端化：**不监听 libp2p、不托管 join**）；
 * `embedded` 模式保留本地 Mebular（**测试/CI**）。
 */
async function openTaskStore(config: FleetConfig, args: Args): Promise<{ store: TaskEventStore; mebular: Mebular | null }> {
  if (storeMode(config, args) === 'daemon') {
    if (config.daemon?.endpoint === undefined) {
      throw new Error('daemon 模式需要 config.daemon.endpoint（请用统一上车 quickstart/join 配置守护）');
    }
    return {
      store: new DaemonTaskEventStore({
        endpoint: config.daemon.endpoint,
        namespace: config.namespace,
        ...(config.daemon.token !== undefined ? { token: config.daemon.token } : {}),
        ...(config.daemon.tokenFile !== undefined ? { tokenFile: config.daemon.tokenFile } : {}),
      }),
      mebular: null,
    };
  }
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const mebular = new Mebular(mebularOptions(config, encryption) as never);
  await mebular.initialize();
  return { store: new MebularTaskEventStore(mebular), mebular };
}

/**
 * `fleet node`（任务板/发起端）。
 * `--run-forever`：常驻（服务模式），直到收到 SIGINT/SIGTERM；写 `service.heartbeat`（role=node）。
 */
async function runFleetNode(args: Args): Promise<number> {
  const dir = fleetDirFrom(args);
  const runForever = args['run-forever'] === true;
  const config = await loadFleetConfig(fleetConfigPath(dir));
  if (storeMode(config, args) === 'embedded') {
    console.error('[embedded] 本地 Mebular 模式（test/dev only；生产请用 --store daemon + mebular serve 守护）');
  }
  const { store, mebular } = await openTaskStore(config, args);
  const stopHeartbeat = startHeartbeat(dir, { role: 'node', sha: buildSha() });
  const shutdown = installShutdownHandlers();
  if (mebular !== null) {
    console.log(JSON.stringify({
      role: 'node', event: 'listening', device: config.device, mode: 'embedded',
      multiaddr: mebular.node!.getLocalMultiaddrs()[0] ?? null, peerId: mebular.node!.peerId.id,
    }));
  } else {
    console.log(JSON.stringify({ role: 'node', event: 'listening', device: config.device, mode: 'daemon', daemon: config.daemon?.endpoint ?? null }));
  }
  // T2：join 服务（令牌 → 委派证书）。默认由 config.joinService 控制，可用 --join-serve 临时开启。
  // W2：daemon 模式下 join 由**守护**托管（此处不启动）。
  let joinService: JoinService | null = null;
  if (mebular !== null && (config.joinService?.enabled === true || args['join-serve'] === true)) {
    const port = num(args['join-port'], config.joinService?.port ?? 4002);
    const bind = str(args['join-bind'], config.joinService?.bind ?? '0.0.0.0');
    joinService = await startJoinService({
      mebular, deviceId: config.device, storagePath: config.storagePath, bind, port,
      log: (m) => console.error(m),
    });
    console.log(JSON.stringify({ role: 'node', event: 'join-service', endpoint: `http://${bind}:${joinService.port}`, port: joinService.port }));
  }
  const node = new FleetNode({ device: config.device, store, transport: new NullTransport(), quota: new LocalQuota({ limitPerDevice: config.quotaLimitPerDevice ?? 1_000_000 }) });
  const submit = num(args.submit, 0);
  const autoApprove = config.autoApprove === true;
  let lastAutoApprove = 0;
  const tickAutoApprove = async (): Promise<void> => {
    if (!autoApprove) return;
    const now = Date.now();
    if (now - lastAutoApprove < 2000) return;
    lastAutoApprove = now;
    if (mebular === null) return;
    try {
      await autoApproveOnce(mebular, config.device, config.namespace);
    } catch {
      // 下轮重试；doctor 会暴露未授权项
    }
  };
  let code = 0;
  if (submit > 0) {
    // 先等首轮同步（对端连入）再提交，避免在无连接时提交导致事件丢失触发。
    const waitSyncMs = num(args['wait-sync-ms'], 0);
    if (waitSyncMs > 0 && mebular !== null) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, waitSyncMs);
        mebular!.sync.once('sync-completed', () => {
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
    console.log(JSON.stringify({ role: 'node', submitted: ids.length, done: done.length, allTerminal: ok, resultsMatch }));
    code = ok && done.length === ids.length && resultsMatch ? 0 : 1;
    if (runForever) {
      while (!shutdown.isStopping()) {
        await tickAutoApprove();
        await sleep(200); // 常驻：保持在线供对端同步
      }
    } else {
      const lingerMs = num(args['linger-ms'], 0);
      if (lingerMs > 0) await sleep(lingerMs);
    }
  } else if (runForever) {
    while (!shutdown.isStopping()) {
      await tickAutoApprove();
      await sleep(200);
    }
  } else {
    await sleep(num(args['timeout-ms'], 60_000));
  }
  if (joinService !== null) await joinService.close();
  stopHeartbeat();
  shutdown.dispose();
  await mebular?.shutdown();
  return code;
}

/**
 * `fleet worker`（执行端）。
 * `--run-forever`：常驻（服务模式）；写 `service.heartbeat`（role=worker）。
 */
async function runFleetWorker(args: Args): Promise<number> {
  const dir = fleetDirFrom(args);
  const runForever = args['run-forever'] === true;
  const config = await loadFleetConfig(fleetConfigPath(dir));
  if (storeMode(config, args) === 'embedded') {
    console.error('[embedded] 本地 Mebular 模式（test/dev only；生产请用 --store daemon + mebular serve 守护）');
  }
  const { store, mebular } = await openTaskStore(config, args);
  const stopHeartbeat = startHeartbeat(dir, { role: 'worker', sha: buildSha() });
  if (args['print-listen'] === true && mebular !== null) {
    console.log(JSON.stringify({ role: 'worker', event: 'listening', device: config.device, multiaddrs: mebular.node!.getLocalMultiaddrs() }));
  }
  const shutdown = installShutdownHandlers();
  if (mebular !== null) {
    for (const peer of config.peers) {
      if (peer.addr === undefined) continue;
      const id = /\/p2p\/([^/]+)/.exec(peer.addr)?.[1] ?? peer.device;
      try {
        await mebular.node!.connectToPeer({ id, multihash: new Uint8Array(), pubKey: new Uint8Array() }, peer.addr);
      } catch {
        // 连接失败由后续收敛/doctor 暴露
      }
    }
  }
  const log = await ExecutionLog.open(str(args['exec-log'], join(dir, 'exec.jsonl')));
  const worker = new FleetWorker({ device: config.device, agent: str(args.agent, 'worker'), store, transport: new NullTransport(), registry: buildRegistry(config.agents), log });
  await worker.reconcile();
  const deadline = Date.now() + num(args['timeout-ms'], 60_000);
  while (runForever ? !shutdown.isStopping() : Date.now() < deadline) {
    await worker.pollOnce();
    await sleep(num(args['interval-ms'], 10));
  }
  console.log(JSON.stringify({ role: 'worker', device: config.device, executed: log.size() }));
  stopHeartbeat();
  shutdown.dispose();
  await mebular?.shutdown();
  return 0;
}

/** W2 B2：守护服务安装器（`mebular-serve`，同一 home）。 */
function daemonInstaller(): ServiceInstaller {
  return async (dir: string) => {
    try {
      const require = createRequire(import.meta.url);
      const mcpPkg = require.resolve('@mebular/mcp/package.json');
      const mcpBin = join(dirname(mcpPkg), 'bin', 'mebular.mjs');
      const descriptor: ServiceDescriptor = {
        kind: 'mebular-serve',
        args: [mcpBin, 'serve'],
        heartbeatDir: dir,
        workingDir: dir,
        env: { MEBULAR_HOME: dir },
      };
      const result = installService(descriptor, { sha: buildSha() });
      return result.ok ? { installed: true } : { installed: false, note: 'install 返回非 ok' };
    } catch (error) {
      return { installed: false, note: (error as Error).message };
    }
  };
}

/** `fleet quickstart`：A 一条命令上车（onboard + 声明签发者/成员/自授权 + 加入码 + 服务 + doctor）。 */
async function runQuickstart(args: Args): Promise<number> {
  const dir = fleetDirFrom(args);
  const noService = args['no-service'] === true;
  const agents = parseAgents(args.agent, args['agent-command'], args['agent-base-args']);
  const result = await quickstart({
    dir,
    device: fleetDeviceFrom(args),
    buildSha: buildSha(),
    ...(typeof args.namespace === 'string' ? { namespace: args.namespace } : {}),
    ...(typeof args.listen === 'string' ? { listen: args.listen } : {}),
    ...(typeof args['code-file'] === 'string' ? { codeFile: args['code-file'] } : {}),
    ...(typeof args['join-port'] === 'string' ? { joinPort: num(args['join-port'], DEFAULT_JOIN_PORT_FALLBACK) } : {}),
    ...(typeof args['join-host'] === 'string' ? { joinHost: args['join-host'] } : {}),
    ...(agents !== undefined ? { agents } : {}),
    ...(args['auto-approve'] === true ? { autoApprove: true } : {}),
    ...(args.daemon === true ? { daemon: true } : {}),
    ...(typeof args['daemon-port'] === 'string' ? { daemonPort: num(args['daemon-port'], 7331) } : {}),
    ...(args.daemon === true && !noService ? { installDaemon: daemonInstaller() } : {}),
    ...(noService ? {} : { installService: fleetNodeInstaller() }),
  });
  const report = await doctor(dir);
  console.log(JSON.stringify({
    ok: true,
    role: 'quickstart',
    device: result.device,
    dir: result.dir,
    namespace: result.namespace,
    fingerprint: result.fingerprint,
    multiaddrs: result.multiaddrs,
    agents: result.agents,
    agentSources: result.agentSources,
    serviceInstalled: result.serviceInstalled,
    ...(result.serviceNote !== undefined ? { serviceNote: result.serviceNote } : {}),
    autoApprove: result.autoApprove,
    code: result.code,
    ...(result.codeFile !== undefined ? { codeFile: result.codeFile } : {}),
    inviteToken: result.inviteToken,
    joinEndpoint: result.joinEndpoint,
    joinPort: result.joinPort,
    ...(result.daemon !== undefined ? { daemon: result.daemon } : {}),
    agentMcp: agentMcpConfig(),
    warnings: result.warnings,
    doctor: summarizeDoctor(report),
    next: [...result.joinNext, `fleet node --dir ${dir} --run-forever`],
  }, null, 2));
  return 0;
}

/** `fleet join`：B 一条命令上车（版本核对 + 导入信任材料/地址 + onboard + 声明成员 + 服务 + doctor）。 */
async function runJoin(args: Args): Promise<number> {
  const dir = fleetDirFrom(args);
  const noService = args['no-service'] === true;
  const agents = parseAgents(args.agent, args['agent-command'], args['agent-base-args']);
  // T2：令牌加入（推荐；主密钥不复制）
  // C7：`--qr <字符串>` 与 `--token` **完全等价**（QR 内容就是内联令牌文本本身）
  if (typeof args.qr === 'string') args.token = args.qr.trim();
  if (typeof args.token === 'string' || typeof args['token-file'] === 'string') {
    const tokenText = await readJoinCode({
      ...(typeof args.token === 'string' ? { code: args.token } : {}),
      ...(typeof args['token-file'] === 'string' ? { codeFile: args['token-file'] } : {}),
    });
    const result = await joinWithToken({
      dir,
      token: tokenText,
      device: fleetDeviceFrom(args),
      agents: agents ?? [{ name: 'echo', kind: 'echo' }],
      ...(typeof args.namespace === 'string' ? { namespace: args.namespace } : {}),
      ...(typeof args.listen === 'string' ? { listen: args.listen } : {}),
      ...(args.daemon === true ? { daemon: true } : {}),
      ...(typeof args['daemon-port'] === 'string' ? { daemonPort: num(args['daemon-port'], 7331) } : {}),
      ...(typeof args['join-port'] === 'string' ? { joinPort: num(args['join-port'], 4002) } : {}),
      ...(args.daemon === true && noService !== true ? { installDaemon: daemonInstaller() } : {}),
    });
    const report = await doctor(dir);
    console.log(JSON.stringify({
      ok: true,
      role: 'join',
      mode: 'token',
      device: result.device,
      dir: result.dir,
      peer: result.peer,
      namespace: result.namespace,
      fingerprint: result.fingerprint,
      alreadyJoined: result.alreadyJoined,
      awaitingApproval: result.awaitingApproval,
      inviterDeviceId: result.inviterDeviceId,
      ...(result.daemon !== undefined ? { daemon: result.daemon } : {}),
      agentMcp: result.agentMcp,
      doctor: summarizeDoctor(report),
      next: result.next,
    }, null, 2));
    return 0;
  }
  const code = await readJoinCode({
    ...(typeof args.code === 'string' ? { code: args.code } : {}),
    ...(typeof args['code-file'] === 'string' ? { codeFile: args['code-file'] } : {}),
  });
  const result = await joinFleet({
    dir,
    code,
    device: fleetDeviceFrom(args),
    buildSha: buildSha(),
    ...(typeof args.namespace === 'string' ? { namespace: args.namespace } : {}),
    ...(typeof args.listen === 'string' ? { listen: args.listen } : {}),
    ...(agents !== undefined ? { agents } : {}),
    ...(noService ? {} : { installService: fleetNodeInstaller() }),
  });
  const report = await doctor(dir);
  console.log(JSON.stringify({
    ok: true,
    role: 'join',
    device: result.device,
    dir: result.dir,
    peer: result.peer,
    namespace: result.namespace,
    fingerprint: result.fingerprint,
    alreadyJoined: result.alreadyJoined,
    awaitingApproval: result.awaitingApproval,
    serviceInstalled: result.serviceInstalled,
    ...(result.serviceNote !== undefined ? { serviceNote: result.serviceNote } : {}),
    agents: result.agents,
    agentSources: result.agentSources,
    doctor: summarizeDoctor(report),
    next: result.next,
  }, null, 2));
  return 0;
}

/** `fleet pending`：A 侧列出在册但未授权的设备（待批准）。 */
async function runPending(args: Args): Promise<number> {
  const result = await pendingDevices(fleetDirFrom(args), typeof args.namespace === 'string' ? args.namespace : undefined);
  console.log(JSON.stringify({ ok: true, role: 'pending', ...result }, null, 2));
  return 0;
}

/** `fleet approve <deviceId>`：A 侧图上门授权 + 成员在册（+ 登记地址）。 */
async function runApprove(args: Args): Promise<number> {
  const dir = fleetDirFrom(args);
  const device = str(args.device, '');
  if (device.length === 0) throw new Error('approve 需要 --device <deviceId>');
  const result = await approveDevice(dir, {
    device,
    ...(typeof args.namespace === 'string' ? { namespace: args.namespace } : {}),
    ...(typeof args.addr === 'string' ? { addr: args.addr } : {}),
  });
  const report = await doctor(dir);
  console.log(JSON.stringify({ ok: true, role: 'approve', ...result, doctor: summarizeDoctor(report) }, null, 2));
  return 0;
}

/** `fleet invite`：任一在册设备生成**加入令牌**（T2；主密钥不出本机，任意设备均可）。 */
async function runInvite(args: Args): Promise<number> {
  const dir = fleetDirFrom(args);
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    const port = num(args['join-port'], config.joinService?.port ?? 4002);
    const endpoint = str(args.endpoint, `http://${pickLanHost()}:${port}`);
    const ttlMs = typeof args.ttl === 'string' ? num(args.ttl, 900) * 1000 : 900_000;
    const token = await buildJoinToken({
      mebular,
      deviceId: config.device,
      namespace: str(args.namespace, config.namespace),
      endpoint,
      ttlMs,
      // C7：自动授权（默认 true；`--no-grant` 关闭）+ 授权 TTL（默认 24h，`--grant-ttl <小时>`）
      ...(str(args['grant'], 'on') === 'off' || args['no-grant'] === true ? { grantOnJoin: false } : {}),
      ...(typeof args['grant-ttl'] === 'string' ? { grantTtlMs: Math.max(0, num(args['grant-ttl'], 24) * 3600_000) } : {}),
    });
    const inline = Buffer.from(JSON.stringify(token), 'utf-8').toString('base64');
    if (typeof args['token-file'] === 'string') await writeJoinCodeFile(args['token-file'], inline);

    // C7：二维码 + 文本一起提供（二维码内容 = 内联令牌文本；缺可选依赖则只给文本，不报错）
    const warnings: string[] = [];
    const terminalQr = args['no-qr'] === true ? null : await renderTerminalQr(inline, { onWarn: (m) => warnings.push(m) });
    const svgQr = args['no-qr'] === true ? null : await renderSvgQr(inline, { onWarn: (m) => warnings.push(m) });
    if (terminalQr) console.log(terminalQr.value);

    const grantTtlMs = token.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
    console.log(JSON.stringify({
      ok: true,
      role: 'invite',
      inviter: config.device,
      endpoint,
      namespace: token.namespace,
      nonce: token.nonce,
      expiresAt: token.expiresAt,
      token: inline,
      grantOnJoin: token.grantOnJoin !== false,
      grantTtlMs: token.grantOnJoin === false ? null : grantTtlMs,
      qr: terminalQr ? { kind: terminalQr.kind, value: terminalQr.value } : null,
      qrSvg: svgQr ? svgQr.value : null,
      ...(typeof args['token-file'] === 'string' ? { tokenFile: args['token-file'] } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      next: [
        '把二维码或令牌安全传给新设备（QR 内容即令牌文本）',
        '新设备运行：fleet join --qr \'<二维码内容>\' 或 fleet join --token <内联|文件>',
      ],
    }, null, 2));
  } finally {
    await mebular.shutdown();
  }
  return 0;
}

/** 工具面 CLI：`fleet <tool-cli> --input '<json>'`（与 MCP `tools/call` 同一 handler）。 */
async function runTaskTool(cliName: string, args: Args): Promise<number> {
  const tool = toolByCli(cliName);
  if (tool === undefined) throw new Error(`未知工具子命令：${cliName}`);
  let input: Record<string, unknown> = {};
  if (typeof args.input === 'string') {
    const parsed: unknown = JSON.parse(args.input);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('--input 必须是 JSON 对象');
    input = parsed as Record<string, unknown>;
  }
  const reserved = new Set(['input', 'dir', 'namespace', 'agent', 'version']);
  for (const [key, value] of Object.entries(args)) {
    if (reserved.has(key) || value === undefined) continue;
    if (key === 'budget' || key === 'to' || key === 'cursor') {
      input[key] = typeof value === 'string' ? JSON.parse(value) : value;
    } else if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) {
      input[key] = Number(value);
    } else {
      input[key] = value;
    }
  }
  const ctx = {
    dir: fleetDirFrom(args),
    ...(typeof args.namespace === 'string' ? { namespace: args.namespace } : {}),
    ...(typeof args.agent === 'string' ? { agent: args.agent } : {}),
  };
  const result = await tool.handler(input, ctx);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

/** `fleet tools`：打印工具 ↔ CLI 对照表（供 A2 核对）。 */
function runTools(): number {
  console.log(JSON.stringify({ ok: true, tools: toolCliTable() }, null, 2));
  return 0;
}

/** `fleet mcp`：stdio MCP 任务面（与 CLI 同一 handler）。 */
async function runMcpCommand(args: Args): Promise<number> {
  await runFleetMcp({
    dir: fleetDirFrom(args),
    ...(typeof args.namespace === 'string' ? { namespace: args.namespace } : {}),
    ...(typeof args.agent === 'string' ? { agent: args.agent } : {}),
  });
  return 0;
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  // `service` 有自身 flags（--no-autostart/--label/--extra），走 raw argv，不经通用解析。
  if (raw[0] === 'service') {
    process.exit(runFleetService(raw.slice(1)));
  }
  const { command, args, positionals } = parseArgs(raw);
  let code = 2;
  if (args.version === true) {
    console.log(`@mebular/fleet ${versionString()}`);
    process.exit(0);
  }
  try {
  if (command === 'spool') {
    const sub = positionals[0];
    if (sub === 'node') code = await runNode(args);
    else if (sub === 'worker') code = await runWorker(args);
    else {
      console.error('用法：fleet spool node|worker …（M2 单机双进程，spool 传输）');
      code = 2;
    }
  }
  else if (command === 'node') code = await runFleetNode(args);
  else if (command === 'worker') code = await runFleetWorker(args);
  else if (command === 'onboard') code = await runOnboard(args);
  else if (command === 'quickstart') code = await runQuickstart(args);
  else if (command === 'join') code = await runJoin(args);
  else if (command === 'invite') code = await runInvite(args);
  else if (command === 'tools') code = runTools();
  else if (command === 'mcp') code = await runMcpCommand(args);
  else if (command !== undefined && toolByCli(command) !== undefined) code = await runTaskTool(command, args);
  else if (command === 'pending') code = await runPending(args);
  else if (command === 'approve') code = await runApprove(args);
  else if (command === 'doctor') code = await runDoctor(args);
  else if (command === 'grant') code = await runGrant(args);
  else if (command === 'revoke') code = await runRevoke(args);
  else if (command === 'declare-issuer') code = await runDeclareIssuer(args);
  else if (command === 'member') code = await runMember(args);
  else if (command === 'members') code = await runMembers(args);
  else if (command === 'leave') code = await runLeave(args);
  else if (command === 'rejoin') code = await runRejoin(args);
  else {
    console.error('用法：fleet quickstart|join|invite|pending|approve|tools|mcp|task_submit|task_submit_batch|task_cancel|task_retry|task_status|task_list|task_history|task_children|task_summarize|task_subscribe|task_negotiate|chatter_send|chatter_inbox|task_quota|task_targets|board_create|onboard|doctor|grant|revoke|declare-issuer|member|members|leave|rejoin|node|worker|service|spool … | fleet --version');
    code = 2;
  }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: (error as Error).message }));
    process.exit(1);
  }
  process.exit(code);
}

await main();
