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
  DEFAULT_LABEL_PREFIX,
  SERVICE_KINDS,
  defaultLabel,
  legacyLabel,
  systemdUnitFileName,
  unitText,
  type ServiceKind,
  type ServicePlatform,
  type UnitSpec,
} from './units.js';
import { describeJobOwner, jobBelongsToHome, parseLaunchdPrint, type LaunchdJob } from './launchd.js';
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

/** install 仪器化留痕：每条外部命令的 argv/rc/stdout/stderr/耗时（供 launchd 竞态诊断）。 */
export interface RunTraceEntry {
  at: string;
  cmd: string;
  args: string[];
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

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
  /** 仪器化：非空则对每条外部命令回调一条留痕（CLI 经 MEBULAR_SERVICE_TRACE 落 JSONL）。 */
  trace?: (entry: RunTraceEntry) => void;
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

/**
 * 构建 SHA 兜底 helper：env → 显式 cwd 的 git HEAD → `unknown`。
 * **本模块刻意不读 `import.meta` 与 `process.cwd()`**（F-INSTALL-1）：前者 ts-jest 以 CJS 加载 src 会编译失败；
 * 后者是「sha 随 cwd 漂移」的病灶。真正与 cwd 无关的解析（模块邻接 `version.json` → 模块所在仓库 git）
 * 在 ESM 入口边界完成并注入：`mebular service` 经 `packages/mcp/src/build-sha.mjs`、`fleet` 经 `cli.ts buildSha()`，
 * 再经 `runServiceCli({ sha })` / `installService({ sha })` 传入。
 */
export function resolveBuildSha(env: NodeJS.ProcessEnv = process.env, cwd?: string): string {
  const fromEnv = env.MEBULAR_BUILD_SHA ?? env.MEBULAR_SERVICE_SHA;
  if (fromEnv) return fromEnv;
  if (cwd !== undefined) {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      // 显式目录不在 git 仓库内 → unknown
    }
  }
  return 'unknown';
}

function readManifest(kind: ServiceKind, home: string): ServiceManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(kind, home), 'utf-8')) as ServiceManifest;
  } catch {
    return null;
  }
}

/**
 * 实例身份（**服务身份隔离的根**）：优先取描述符里的守护 home（`env.MEBULAR_HOME`，其次
 * `heartbeatDir`），最后退回服务包选项的 home。**必须与「plist/状态落盘位置」区分开**：
 * mcp CLI 的 `service install` 不传 `--home`（落盘仍用用户 home），但其 `MEBULAR_HOME`
 * 才是实例身份——用实例身份派生 label，沙箱 home 才不会与真实 home 撞标签。
 */
function instanceHomeOf(descriptor: ServiceDescriptor, home: string): string {
  const envHome = descriptor.env?.MEBULAR_HOME;
  if (typeof envHome === 'string' && envHome.length > 0) return envHome;
  if (descriptor.heartbeatDir.length > 0) return descriptor.heartbeatDir;
  return home;
}

function buildSpec(descriptor: ServiceDescriptor, opts: Required<Pick<ServiceOptions, 'home' | 'platform'>> & { label?: string; autostart: boolean; sha: string }): UnitSpec {
  const { stdoutLog, stderrLog } = serviceLogPaths(descriptor.kind, opts.home);
  return {
    kind: descriptor.kind,
    // F-SVC-1：标签**含实例 home 维度**（`com.mebular.<kind>.<homeKey>`），不同 home 互不顶替。
    label: opts.label ?? defaultLabel(descriptor.kind, DEFAULT_LABEL_PREFIX, instanceHomeOf(descriptor, opts.home)),
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

interface LoadedJob {
  loaded: boolean;
  job: LaunchdJob | null;
}

/** 读取某 label 的加载态（`launchctl print` 失败 = 未加载）。 */
function readLoadedJob(label: string, run: RunCommand): LoadedJob {
  const res = run('launchctl', ['print', `gui/${uid()}/${label}`]);
  if (res.code !== 0) return { loaded: false, job: null };
  return { loaded: true, job: parseLaunchdPrint(res.stdout) };
}

interface RunningState {
  /** 加载中**且**归属本 home 才为 true。 */
  running: boolean;
  /** 有同 label 作业被加载但**不属于**本 home（跨 home 占用）。 */
  foreign: boolean;
}

/**
 * F-SVC-1：running 判定**校验作业归属**——`launchctl print` 只要 label 存在就返回 0，
 * 故必须解析其 ProgramArguments/MEBULAR_HOME/WorkingDirectory/plist 路径是否与本 home 匹配；
 * 不匹配（他人作业）→ running=false 且 foreign=true，**绝不算 running**。
 */
function runningState(platform: ServicePlatform, spec: UnitSpec, run: RunCommand, home: string): RunningState {
  if (platform === 'darwin') {
    const loaded = readLoadedJob(spec.label, run);
    const owned = loaded.loaded && jobBelongsToHome(loaded.job, home);
    return { running: owned, foreign: loaded.loaded && !owned };
  }
  if (platform === 'linux') {
    const active = run('systemctl', ['--user', 'is-active', systemdUnitFileName(spec.kind)]).stdout.trim() === 'active';
    return { running: active, foreign: false };
  }
  const queried = run('schtasks', ['/Query', '/TN', spec.kind]).code === 0;
  return { running: queried, foreign: false };
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
  /** started=false 时的真实原因（bootstrap 重试耗尽 / 终态校验超时等）；绝不谎报。 */
  startError?: string;
  /** 迁移：本次安装顺带卸下的旧（无 home 维度）作业 label。 */
  migratedFrom?: string;
  /** 同 label 被**他人**作业占用 → 已拒绝（绝不顶替/bootout）。 */
  foreign?: boolean;
  warning?: string;
  error?: string;
}

/** install 专属选项：时序旋钮全部有界且可注入（测试用小值；CLI 用默认）。 */
export interface InstallOptions extends ServiceOptions {
  autostart?: boolean;
  label?: string;
  /** bootout 后等待「作业确实卸载」的预算（默认 3000ms；轮询 print 直至查无此作业）。 */
  unloadTimeoutMs?: number;
  /** bootstrap 失败（如 launchd 收尾竞态 error 5）时的尝试次数（默认 4，含首次）。 */
  bootstrapAttempts?: number;
  /** bootstrap 相邻两次尝试间的退避（默认 750ms）。 */
  bootstrapBackoffMs?: number;
  /** 装载后「确认真的起来了」的校验预算（默认 8000ms；轮询新鲜心跳）。 */
  verifyTimeoutMs?: number;
  /** 校验轮询间隔（默认 250ms）。 */
  verifyIntervalMs?: number;
}

/** 同步睡眠（install 全程基于同步 RunCommand；Atomics.wait 不依赖事件循环）。 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** bootout 后**有界**等待作业真正卸载（bootout→bootstrap 收尾竞态的根治：未卸完不 bootstrap）。 */
function waitForUnloaded(label: string, run: RunCommand, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!readLoadedJob(label, run).loaded) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(150);
  }
}

/** bootstrap 有界退避重试（launchd 偶发 `Bootstrap failed: 5: Input/output error` 等暂态失败）。 */
function bootstrapWithRetry(unitPath: string, run: RunCommand, attempts: number, backoffMs: number): RunResult {
  let last: RunResult = { code: 1, stdout: '', stderr: 'not attempted' };
  for (let i = 0; i < Math.max(1, attempts); i++) {
    last = run('launchctl', ['bootstrap', `gui/${uid()}`, unitPath]);
    if (last.code === 0) return last;
    if (i + 1 < attempts) sleepSync(backoffMs);
  }
  return last;
}

/**
 * 装载后终态校验：在预算内等待「**比基线更新**的新鲜心跳」。基线 = 本次安装前的心跳 ts——
 * 没有它，上一次运行残留的陈旧心跳会让「装载即 SIGTERM」被误判成 started:true（谎报根因之一）。
 */
function verifyStartedFresh(
  descriptor: ServiceDescriptor,
  baselineTs: number,
  timeoutMs: number,
  intervalMs: number,
): { ok: boolean; reason?: string } {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hb = readHeartbeat(descriptor.heartbeatDir);
    if (hb !== null && hb.ts > baselineTs && isHeartbeatFresh(descriptor.heartbeatDir)) return { ok: true };
    if (Date.now() >= deadline) {
      const seen = hb === null ? '无心跳文件' : `心跳 ts=${hb.ts}（基线 ${baselineTs}，未见更新）`;
      return { ok: false, reason: `启动校验超时：${timeoutMs}ms 内未见新的新鲜心跳（${seen}；heartbeatDir=${descriptor.heartbeatDir}）` };
    }
    sleepSync(intervalMs);
  }
}

const summarizeRun = (r: RunResult): string => (r.stderr || r.stdout || `rc=${r.code}`).slice(0, 300);

export function installService(
  descriptor: ServiceDescriptor,
  options: InstallOptions = {},
): InstallResult {
  const platform = currentPlatform(options.platform);
  const home = options.home ?? os.homedir();
  const rawRun = options.run ?? defaultRun;
  const trace = options.trace;
  // 仪器化：每条外部命令（含重试/轮询）都留痕——launchd 竞态只能靠命令级时序定位。
  const run: RunCommand = trace === undefined
    ? rawRun
    : (cmd, args) => {
        const t0 = Date.now();
        const r = rawRun(cmd, args);
        trace({
          at: new Date(t0).toISOString(),
          cmd,
          args: [...args],
          code: r.code,
          stdout: r.stdout.slice(0, 4000),
          stderr: r.stderr.slice(0, 4000),
          durationMs: Date.now() - t0,
        });
        return r;
      };
  const sha = options.sha ?? resolveBuildSha();
  const autostart = options.autostart ?? true;
  const unloadTimeoutMs = options.unloadTimeoutMs ?? 3000;
  const bootstrapAttempts = options.bootstrapAttempts ?? 4;
  const bootstrapBackoffMs = options.bootstrapBackoffMs ?? 750;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? 8000;
  const verifyIntervalMs = options.verifyIntervalMs ?? 250;
  const instanceHome = instanceHomeOf(descriptor, home);
  const spec = buildSpec(descriptor, { home, platform, autostart, sha, ...(options.label !== undefined ? { label: options.label } : {}) });
  const unitPath = unitFilePath(platform, spec, home);

  // F-SVC-1 护栏（darwin）：安装前先判「同 label 是否被**他人**作业占用」。
  //  - 本 home 新标签被他人占用 → 拒绝（绝不 bootout 他人）；
  //  - 旧全局标签被他人占用 → 保留不 bootout，只装本 home 专属标签并警告；
  //  - 旧全局标签属于本 home → 记录待迁移（bootout 旧 + 装新，保留 KeepAlive/RunAtLoad）。
  let migratedFrom: string | undefined;
  let foreignWarning: string | undefined;
  if (platform === 'darwin') {
    const own = readLoadedJob(spec.label, run);
    if (own.loaded && !jobBelongsToHome(own.job, instanceHome)) {
      return {
        ok: false,
        action: 'install',
        kind: spec.kind,
        label: spec.label,
        sha,
        unitPath,
        manifestPath: manifestPath(spec.kind, home),
        autostart,
        started: false,
        foreign: true,
        error: 'foreign_job',
        warning: `标签 ${spec.label} 已被另一 home 的作业占用（占用者：${describeJobOwner(own.job) ?? '未知'}）→ 拒绝安装（绝不顶替他人）`,
      };
    }
    const legacy = legacyLabel(spec.kind);
    if (legacy !== spec.label) {
      const legacyJob = readLoadedJob(legacy, run);
      if (legacyJob.loaded) {
        if (jobBelongsToHome(legacyJob.job, instanceHome)) {
          migratedFrom = legacy;
        } else {
          foreignWarning = `旧标签 ${legacy} 由另一 home 的作业占用（占用者：${describeJobOwner(legacyJob.job) ?? '未知'}）→ 未 bootout 他人；仅安装本 home 专属标签 ${spec.label}`;
        }
      }
    }
  }

  ensureDirs(platform, home);
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
  let startError: string | undefined;
  if (platform === 'darwin') {
    if (migratedFrom !== undefined) {
      // 仅当旧标签确属本 home 才卸载（上面已校验）；并清掉本 home 的旧 plist。
      run('launchctl', ['bootout', `gui/${uid()}/${migratedFrom}`]);
      waitForUnloaded(migratedFrom, run, unloadTimeoutMs);
      const legacyUnit = unitFilePath('darwin', { kind: spec.kind, label: migratedFrom }, home);
      try {
        fs.rmSync(legacyUnit, { force: true });
      } catch {
        // ignore
      }
    }
    run('launchctl', ['bootout', `gui/${uid()}/${spec.label}`]); // 幂等：先卸本 home 自个儿的旧作业（忽略失败）
    // bootout 是异步生效的：不等待卸载完成就 bootstrap 会撞 `Bootstrap failed: 5`（收尾竞态）。
    waitForUnloaded(spec.label, run, unloadTimeoutMs);
    // 基线心跳：之后只认「比它新」的心跳，杜绝陈旧心跳造成的 started 假阳性。
    const baselineHbTs = readHeartbeat(descriptor.heartbeatDir)?.ts ?? 0;
    const boot = bootstrapWithRetry(unitPath, run, bootstrapAttempts, bootstrapBackoffMs);
    let loadedUnit = boot.code === 0;
    if (!loadedUnit) {
      const legacy = run('launchctl', ['load', unitPath]); // 旧系统回退
      loadedUnit = legacy.code === 0;
      if (!loadedUnit) {
        startError = `bootstrap 失败（${bootstrapAttempts} 次有界重试）：${summarizeRun(boot)}；load 回退亦失败：${summarizeRun(legacy)}`;
      }
    }
    if (loadedUnit) {
      if (!autostart) {
        // RunAtLoad=false：显式拉起一次，确保 install 后即在跑
        run('launchctl', ['kickstart', `gui/${uid()}/${spec.label}`]);
      }
      // 终态校验：装载成功 ≠ 进程活着。只有新的新鲜心跳才允许报 started:true。
      const verify = verifyStartedFresh(descriptor, baselineHbTs, verifyTimeoutMs, verifyIntervalMs);
      started = verify.ok;
      if (!verify.ok) startError = verify.reason;
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

  return {
    ok: true,
    action: 'install',
    kind: spec.kind,
    label: spec.label,
    sha,
    unitPath,
    manifestPath: manifestPath(spec.kind, home),
    autostart,
    started,
    ...(startError !== undefined ? { startError } : {}),
    ...(migratedFrom !== undefined ? { migratedFrom } : {}),
    ...(foreignWarning !== undefined ? { warning: foreignWarning } : {}),
  };
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
  const instanceHome = instanceHomeOf(descriptor, home);
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
    // F-SVC-1：只卸**属于本 home** 的作业（含迁移期遗留的旧全局标签）；绝不 bootout 他人。
    for (const candidate of [spec.label, legacyLabel(spec.kind)]) {
      const loaded = readLoadedJob(candidate, run);
      if (loaded.loaded && jobBelongsToHome(loaded.job, instanceHome)) {
        run('launchctl', ['bootout', `gui/${uid()}/${candidate}`]);
      }
    }
  } else if (platform === 'linux') {
    run('systemctl', ['--user', 'disable', '--now', systemdUnitFileName(descriptor.kind)]);
  } else {
    run('schtasks', ['/End', '/TN', descriptor.kind]);
    run('schtasks', ['/Delete', '/TN', descriptor.kind, '/F']);
  }
  const legacyUnitPath = unitFilePath('darwin', { kind: descriptor.kind, label: legacyLabel(descriptor.kind) }, home);
  const files = platform === 'darwin' ? [unitPath, legacyUnitPath, manifestPath(descriptor.kind, home)] : [unitPath, manifestPath(descriptor.kind, home)];
  for (const file of files) {
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
  /** F-SVC-1：存在同 label（或旧全局 label）的**他人**作业 → 跨 home 占用（running 必为 false）。 */
  foreign: boolean;
  /** 跨 home 占用者的 home/路径提示（无则 null）。 */
  foreignOwner: string | null;
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
  const instanceHome = instanceHomeOf(descriptor, home);
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

  // F-SVC-1：running 必须校验**作业归属**；并额外揭露「旧全局 label 被他人占用」这一假阳性来源。
  const state = runningState(platform, spec, run, instanceHome);
  let foreign = state.foreign;
  let foreignOwner: string | null = null;
  if (platform === 'darwin') {
    if (state.foreign) foreignOwner = describeJobOwner(readLoadedJob(spec.label, run).job);
    const legacy = legacyLabel(spec.kind);
    if (legacy !== spec.label) {
      const legacyLoaded = readLoadedJob(legacy, run);
      if (legacyLoaded.loaded && !jobBelongsToHome(legacyLoaded.job, instanceHome)) {
        foreign = true;
        foreignOwner = foreignOwner ?? describeJobOwner(legacyLoaded.job);
      }
    }
  }

  return {
    kind: descriptor.kind,
    label: spec.label,
    registered: fs.existsSync(unitPath) || manifest !== null,
    running: state.running,
    foreign,
    foreignOwner,
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
  const run = options.run ?? defaultRun;
  const instanceHome = instanceHomeOf(descriptor, home);
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
    // F-SVC-1：绝不 kickstart 他人作业——加载中的同 label 作业必须归属本 home。
    const state = runningState(platform, spec, run, instanceHome);
    if (state.foreign) {
      const owner = describeJobOwner(readLoadedJob(spec.label, run).job);
      return {
        kind: descriptor.kind,
        label: spec.label,
        registered: false,
        commands: [],
        manual: `标签 ${spec.label} 被另一 home 的作业占用（占用者：${owner ?? '未知'}）→ 不 kickstart 他人；请确认该作业归属后重试`,
      };
    }
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
