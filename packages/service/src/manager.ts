// 服务管理（install/uninstall/status/logs）与共用 CLI。
//
// 平台机制（D3）：
//  - darwin：launchd 用户级 LaunchAgent（launchctl bootstrap/bootout，KeepAlive 自拉）
//  - linux ：systemd --user（systemctl --user enable/start，Restart=on-failure）
//  - win32 ：Task Scheduler onlogon（schtasks，无需管理员；真 Windows Service 为后续可选项）
//
// 所有外部命令经可注入的 `RunCommand`，使 install/uninstall 的幂等逻辑可被 hermetic 测试。

import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  SERVICE_KINDS,
  defaultLabel,
  systemdUnitFileName,
  unitText,
  type ServiceKind,
  type ServicePlatform,
  type UnitSpec,
} from './units.js';
import {
  launchAgentsDir,
  manifestPath,
  serviceLogPaths,
  serviceLogsDir,
  serviceStateDir,
  systemdUserDir,
  unitFilePath,
  windowsTaskDir,
} from './paths.js';
import { isHeartbeatFresh, readHeartbeat } from './heartbeat.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type RunCommand = (cmd: string, args: readonly string[]) => RunResult;

export const defaultRun: RunCommand = (cmd, args) => {
  const res = spawnSync(cmd, [...args], { encoding: 'utf-8' });
  return { code: res.status ?? 1, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim() };
};

/** 单个常驻组件的宿主描述（由 fleet / mebular CLI 提供）。 */
export interface ServiceDescriptor {
  kind: ServiceKind;
  /** 解释器参数（不含 execPath），通常 `[cliJs, 'node'|'worker'|'serve', ...]` */
  args: readonly string[];
  /** 心跳/配置目录（`service.heartbeat` 落在这里） */
  heartbeatDir: string;
  execPath?: string;
  workingDir?: string;
  env?: Readonly<Record<string, string>>;
}

export interface ServiceOptions {
  platform?: ServicePlatform;
  home?: string;
  run?: RunCommand;
  now?: number;
  sha?: string;
}

export interface ServiceManifest {
  kind: ServiceKind;
  label: string;
  sha: string;
  autostart: boolean;
  args: string[];
  execPath: string;
  unitPath: string;
  installedAt: string;
}

const currentPlatform = (p?: ServicePlatform): ServicePlatform => p ?? (process.platform as ServicePlatform);
const uid = (): string => String(process.getuid?.() ?? 0);

/** 构建 SHA（复用现有 version 机制：env → git HEAD → unknown）。 */
export function resolveBuildSha(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const fromEnv = env.MEBULAR_BUILD_SHA ?? env.MEBULAR_SERVICE_SHA;
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function readManifest(kind: ServiceKind, home: string): ServiceManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(kind, home), 'utf-8')) as ServiceManifest;
  } catch {
    return null;
  }
}

function buildSpec(descriptor: ServiceDescriptor, opts: Required<Pick<ServiceOptions, 'home' | 'platform'>> & { label?: string; autostart: boolean; sha: string }): UnitSpec {
  const { stdoutLog, stderrLog } = serviceLogPaths(descriptor.kind, opts.home);
  return {
    kind: descriptor.kind,
    label: opts.label ?? defaultLabel(descriptor.kind),
    execPath: descriptor.execPath ?? process.execPath,
    args: descriptor.args,
    ...(descriptor.workingDir !== undefined ? { workingDir: descriptor.workingDir } : {}),
    env: { MEBULAR_SERVICE_KIND: descriptor.kind, MEBULAR_SERVICE_SHA: opts.sha, ...(descriptor.env ?? {}) },
    stdoutLog,
    stderrLog,
    sha: opts.sha,
    autostart: opts.autostart,
  };
}

function isRunning(platform: ServicePlatform, spec: UnitSpec, run: RunCommand): boolean {
  if (platform === 'darwin') return run('launchctl', ['print', `gui/${uid()}/${spec.label}`]).code === 0;
  if (platform === 'linux') return run('systemctl', ['--user', 'is-active', systemdUnitFileName(spec.kind)]).stdout.trim() === 'active';
  return run('schtasks', ['/Query', '/TN', spec.kind]).code === 0;
}

function ensureDirs(platform: ServicePlatform, home: string): void {
  fs.mkdirSync(serviceStateDir(home), { recursive: true });
  fs.mkdirSync(serviceLogsDir(home), { recursive: true });
  const unitDir = platform === 'darwin' ? launchAgentsDir(home) : platform === 'linux' ? systemdUserDir(home) : windowsTaskDir(home);
  fs.mkdirSync(unitDir, { recursive: true });
}

export interface InstallResult {
  ok: boolean;
  action: 'install';
  kind: ServiceKind;
  label: string;
  sha: string;
  unitPath: string;
  manifestPath: string;
  autostart: boolean;
  started: boolean;
}

export function installService(
  descriptor: ServiceDescriptor,
  options: ServiceOptions & { autostart?: boolean; label?: string } = {},
): InstallResult {
  const platform = currentPlatform(options.platform);
  const home = options.home ?? os.homedir();
  const run = options.run ?? defaultRun;
  const sha = options.sha ?? resolveBuildSha();
  const autostart = options.autostart ?? true;
  const spec = buildSpec(descriptor, { home, platform, autostart, sha, ...(options.label !== undefined ? { label: options.label } : {}) });

  ensureDirs(platform, home);
  const unitPath = unitFilePath(platform, spec, home);
  fs.writeFileSync(unitPath, unitText(platform, spec), { mode: 0o644 });

  const manifest: ServiceManifest = {
    kind: spec.kind,
    label: spec.label,
    sha,
    autostart,
    args: [...descriptor.args],
    execPath: spec.execPath,
    unitPath,
    installedAt: new Date(options.now ?? Date.now()).toISOString(),
  };
  fs.writeFileSync(manifestPath(spec.kind, home), JSON.stringify(manifest, null, 2), { mode: 0o600 });

  let started = false;
  if (platform === 'darwin') {
    run('launchctl', ['bootout', `gui/${uid()}/${spec.label}`]); // 幂等：先卸旧（忽略失败）
    const boot = run('launchctl', ['bootstrap', `gui/${uid()}`, unitPath]);
    if (boot.code !== 0) run('launchctl', ['load', unitPath]); // 旧系统回退
    if (!autostart) {
      // RunAtLoad=false：显式拉起一次，确保 install 后即在跑
      started = run('launchctl', ['kickstart', `gui/${uid()}/${spec.label}`]).code === 0;
    } else {
      started = isRunning(platform, spec, run);
    }
  } else if (platform === 'linux') {
    run('systemctl', ['--user', 'daemon-reload']);
    started = run('systemctl', ['--user', autostart ? 'enable' : 'start', '--now', systemdUnitFileName(spec.kind)]).code === 0;
  } else {
    const xml = unitFilePath(platform, spec, home);
    const created = run('schtasks', ['/Create', '/TN', spec.kind, '/XML', xml, '/F']);
    started = created.code === 0 && run('schtasks', ['/Run', '/TN', spec.kind]).code === 0;
    if (!autostart) run('schtasks', ['/End', '/TN', spec.kind]); // 仅安装不自启：注册后停止
  }

  return { ok: true, action: 'install', kind: spec.kind, label: spec.label, sha, unitPath, manifestPath: manifestPath(spec.kind, home), autostart, started };
}

export interface UninstallResult {
  ok: boolean;
  action: 'uninstall';
  kind: ServiceKind;
  removed: boolean;
  note?: string;
}

export function uninstallService(descriptor: ServiceDescriptor, options: ServiceOptions = {}): UninstallResult {
  const platform = currentPlatform(options.platform);
  const home = options.home ?? os.homedir();
  const run = options.run ?? defaultRun;
  const manifest = readManifest(descriptor.kind, home);
  const spec: UnitSpec = buildSpec(descriptor, {
    home,
    platform,
    autostart: manifest?.autostart ?? true,
    sha: manifest?.sha ?? 'unknown',
    ...(manifest?.label !== undefined ? { label: manifest.label } : {}),
  });
  const unitPath = unitFilePath(platform, spec, home);
  const isInstalled = fs.existsSync(unitPath) || manifest !== null;
  if (!isInstalled) {
    return { ok: true, action: 'uninstall', kind: descriptor.kind, removed: false, note: `未安装（${unitPath} 不存在）` };
  }

  if (platform === 'darwin') {
    run('launchctl', ['bootout', `gui/${uid()}/${spec.label}`]);
  } else if (platform === 'linux') {
    run('systemctl', ['--user', 'disable', '--now', systemdUnitFileName(descriptor.kind)]);
  } else {
    run('schtasks', ['/End', '/TN', descriptor.kind]);
    run('schtasks', ['/Delete', '/TN', descriptor.kind, '/F']);
  }
  for (const file of [unitPath, manifestPath(descriptor.kind, home)]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
  return { ok: true, action: 'uninstall', kind: descriptor.kind, removed: true };
}

/**
 * 某配置目录是否已被常驻服务接管（读 manifest，`args` 含该目录）。dir-scoped：
 * 在 temp 设备目录上恒为 `[]`（除非确有针对它的服务），使 doctor 可复现。
 */
export function registeredServicesForDir(dir: string, options: { home?: string } = {}): ServiceKind[] {
  const home = options.home ?? os.homedir();
  const found: ServiceKind[] = [];
  for (const kind of SERVICE_KINDS) {
    const manifest = readManifest(kind, home);
    if (manifest && manifest.args.includes(dir)) found.push(kind);
  }
  return found;
}

export interface ServiceStatusEntry {
  kind: ServiceKind;
  label: string;
  registered: boolean;
  running: boolean;
  unitPath: string;
  sha: string | null;
  autostart: boolean | null;
  heartbeat: { present: boolean; fresh: boolean; ageMs: number | null; pid: number | null; sha: string | null; role: string | null };
}

export function serviceStatus(descriptor: ServiceDescriptor, options: ServiceOptions = {}): ServiceStatusEntry {
  const platform = currentPlatform(options.platform);
  const home = options.home ?? os.homedir();
  const run = options.run ?? defaultRun;
  const now = options.now ?? Date.now();
  const manifest = readManifest(descriptor.kind, home);
  const spec: UnitSpec = buildSpec(descriptor, {
    home,
    platform,
    autostart: manifest?.autostart ?? true,
    sha: manifest?.sha ?? options.sha ?? 'unknown',
    ...(manifest?.label !== undefined ? { label: manifest.label } : {}),
  });
  const unitPath = unitFilePath(platform, spec, home);
  const hb = readHeartbeat(descriptor.heartbeatDir);
  const fresh = isHeartbeatFresh(descriptor.heartbeatDir, undefined, now);
  return {
    kind: descriptor.kind,
    label: spec.label,
    registered: fs.existsSync(unitPath) || manifest !== null,
    running: isRunning(platform, spec, run),
    unitPath,
    sha: manifest?.sha ?? null,
    autostart: manifest?.autostart ?? null,
    heartbeat: {
      present: hb !== null,
      fresh,
      ageMs: hb === null ? null : Math.max(0, now - hb.ts),
      pid: hb?.pid ?? null,
      sha: hb?.sha ?? null,
      role: hb?.role ?? null,
    },
  };
}

/** 一键重启：平台命令（**纯函数**，不执行；未注册为服务时给手动指引）。 */
export interface RestartPlan {
  kind: ServiceKind;
  label: string;
  registered: boolean;
  /** 需按序执行的命令（每项 = [cmd, ...args]）；未注册时为空数组 */
  commands: string[][];
  /** 未注册/不可托管时的手动重启指引 */
  manual?: string;
}

/**
 * 构造重启命令（不执行）：
 *  - darwin：`launchctl kickstart -k gui/<uid>/<label>`（-k 先杀再拉起，KeepAlive 兜底）
 *  - linux ：`systemctl --user restart <unit>`（Restart=on-failure 兜底）
 *  - win32 ：`schtasks /End` + `schtasks /Run`（计划任务无 restart，退化为停+起）
 * 未注册（单元文件与 manifest 都不存在）→ 只给手动指引，绝不盲发 kickstart。
 */
export function restartPlanFor(descriptor: ServiceDescriptor, options: ServiceOptions = {}): RestartPlan {
  const platform = currentPlatform(options.platform);
  const home = options.home ?? os.homedir();
  const manifest = readManifest(descriptor.kind, home);
  const spec: UnitSpec = buildSpec(descriptor, {
    home,
    platform,
    autostart: manifest?.autostart ?? true,
    sha: manifest?.sha ?? options.sha ?? 'unknown',
    ...(manifest?.label !== undefined ? { label: manifest.label } : {}),
  });
  const unitPath = unitFilePath(platform, spec, home);
  const registered = fs.existsSync(unitPath) || manifest !== null;
  const manual = '未注册为服务：请手动重启（nohup mebular serve > ~/.mebular/serve.log 2>&1 &）';
  if (!registered) return { kind: descriptor.kind, label: spec.label, registered: false, commands: [], manual };
  if (platform === 'darwin') {
    return { kind: descriptor.kind, label: spec.label, registered: true, commands: [['launchctl', 'kickstart', '-k', `gui/${uid()}/${spec.label}`]] };
  }
  if (platform === 'linux') {
    return { kind: descriptor.kind, label: spec.label, registered: true, commands: [['systemctl', '--user', 'restart', systemdUnitFileName(spec.kind)]] };
  }
  return {
    kind: descriptor.kind,
    label: spec.label,
    registered: true,
    commands: [['schtasks', '/End', '/TN', spec.kind], ['schtasks', '/Run', '/TN', spec.kind]],
  };
}

export interface RestartResult {
  ok: boolean;
  action: 'restart';
  kind: ServiceKind;
  label: string;
  registered: boolean;
  commands: string[][];
  executed: boolean;
  manual?: string;
}

/** 执行重启（命令可注入，便于 hermetic 测试）。未注册 → executed:false + 手动指引。 */
export function restartService(descriptor: ServiceDescriptor, options: ServiceOptions = {}): RestartResult {
  const run = options.run ?? defaultRun;
  const plan = restartPlanFor(descriptor, options);
  if (!plan.registered) {
    return { ok: false, action: 'restart', kind: plan.kind, label: plan.label, registered: false, commands: [], executed: false, ...(plan.manual !== undefined ? { manual: plan.manual } : {}) };
  }
  let ok = true;
  for (const command of plan.commands) {
    const cmd = command[0];
    if (cmd === undefined) continue;
    if (run(cmd, command.slice(1)).code !== 0) ok = false;
  }
  return { ok, action: 'restart', kind: plan.kind, label: plan.label, registered: true, commands: plan.commands, executed: true };
}

export interface LogsResult {
  kind: ServiceKind;
  stdoutLog: string;
  stderrLog: string;
  stdout: string[];
  stderr: string[];
}

export function serviceLogs(descriptor: ServiceDescriptor, options: ServiceOptions & { tail?: number } = {}): LogsResult {
  const home = options.home ?? os.homedir();
  const { stdoutLog, stderrLog } = serviceLogPaths(descriptor.kind, home);
  const tail = Math.max(0, options.tail ?? 50);
  const readTail = (file: string): string[] => {
    try {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return tail === 0 ? [] : lines.slice(-tail);
    } catch {
      return [];
    }
  };
  return { kind: descriptor.kind, stdoutLog, stderrLog, stdout: readTail(stdoutLog), stderr: readTail(stderrLog) };
}
