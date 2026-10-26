// 共享 Runtime 安装器（Phase 4a/5a）：把固定版本的 `@mebular/core` 安装到
// `<cloudRoot>/runtime/<version>/`，注册 `kind:shared` provider，并写 current 指针。
//
// 边界（本阶段）：
//   - 只安装文件 + provider + current；不停止/重启正在运行的 daemon/service；
//   - service 生命周期在 runtime-service.mjs，受控升级在 runtime-upgrade.mjs；
//   - 来源固定 npm registry 的 `@mebular/core@<version>`，不接受 URL/tarball；
//   - 全流程离线可测：npm spawn / 时钟 / PID 存活 / provider 注册均可注入。
//
// 失败映射（稳定 reason）：offline / registry_unreachable / http_error /
// integrity_mismatch / disk_full / permission_denied / npm_missing /
// unsupported_version / cancelled；另有 install_locked、provider_registration_failed
// 与兜底 install_failed。日志/错误只返回脱敏后的片段，不含 token。

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { APP_VERSION } from './version.mjs';
import { cloudError, pidAlive, resolveCloudRoot } from './profiles.mjs';
import { registerExclusiveRuntimeProvider } from './runtime-providers.mjs';
import {
  RUNTIME_CLI_RELATIVE,
  RUNTIME_PACKAGE_NAME,
  RUNTIME_PACKAGE_RELATIVE,
  assertRuntimeVersion,
  manualRuntimeInstallCommand,
  runtimeRootPath,
  runtimeVersionPath,
  sharedRuntimeCliPath,
} from './runtime-layout.mjs';
import { readRuntimeCurrent, writeRuntimeCurrent } from './runtime-current.mjs';

export {
  RUNTIME_CLI_RELATIVE,
  RUNTIME_DIR,
  RUNTIME_PACKAGE_NAME,
  RUNTIME_PACKAGE_RELATIVE,
  assertRuntimeVersion,
  manualRuntimeInstallCommand,
  runtimeRootPath,
  runtimeVersionPath,
  sharedRuntimeCliPath,
} from './runtime-layout.mjs';

export const RUNTIME_INSTALL_LOCK_FILE = 'install.lock';
export const RUNTIME_INSTALL_TIMEOUT_MS = 10 * 60_000;
export const RUNTIME_KILL_GRACE_MS = 500;
export const RUNTIME_SHARED_CAPABILITIES = Object.freeze(['serve']);
export const RUNTIME_STAGING_PREFIX = '.tmp-install-';
export const RUNTIME_BACKUP_PREFIX = '.backup-';

export const RUNTIME_INSTALL_REASONS = Object.freeze([
  'offline',
  'registry_unreachable',
  'http_error',
  'integrity_mismatch',
  'disk_full',
  'permission_denied',
  'npm_missing',
  'unsupported_version',
  'cancelled',
]);

const INSTALL_REASON_SET = new Set(RUNTIME_INSTALL_REASONS);
const MAX_VERSION_LENGTH = 128;
const MAX_LOG_BYTES = 64 * 1024;

export function runtimeInstallLockPath(root) {
  return join(runtimeRootPath(root), RUNTIME_INSTALL_LOCK_FILE);
}

function safeRequestedVersion(value) {
  if (typeof value !== 'string') return value === undefined || value === null ? null : String(value).slice(0, MAX_VERSION_LENGTH);
  return value.trim().slice(0, MAX_VERSION_LENGTH);
}

function timestampId(now) {
  const raw = typeof now === 'string' ? now : new Date().toISOString();
  return raw.replace(/[^0-9A-Za-z_-]/g, '-');
}

function randomSuffix() {
  return randomBytes(6).toString('hex');
}

/**
 * 固定 npm 安装命令：`npm install --prefix <temp> --ignore-scripts --no-audit --no-fund
 * @mebular/core@<version>`。只有 Windows 的 npm.cmd 允许 shell；参数全部由本模块构造。
 */
export function buildNpmInstallCommand({
  version,
  prefix,
  platform = process.platform,
  npmPath = null,
} = {}) {
  const safeVersion = assertRuntimeVersion(version);
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw cloudError('install_failed', '缺少 npm 安装 prefix');
  }

  let command;
  let leading = [];
  let shell = false;
  const rawPath = typeof npmPath === 'string' && npmPath.trim().length > 0 ? npmPath.trim() : null;

  if (rawPath !== null) {
    const name = platform === 'win32'
      ? (rawPath.split(/[\\/]/).pop() ?? rawPath)
      : basename(rawPath);
    if (/\.(mjs|cjs|js)$/i.test(name)) {
      command = process.execPath;
      leading = [rawPath];
    } else if (platform === 'win32' && (/\.(cmd|bat)$/i.test(name) || name === 'npm')) {
      command = /\.(cmd|bat)$/i.test(name) ? rawPath : `${rawPath}.cmd`;
      shell = true;
    } else {
      command = rawPath;
    }
  } else if (platform === 'win32') {
    // Windows 固定走 npm.cmd + shell；不依赖 npm_execpath（可能是 .js，也可能来自其他包管理器）。
    command = 'npm.cmd';
    shell = true;
  } else {
    command = 'npm';
  }

  const args = [
    ...leading,
    'install',
    '--prefix',
    prefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    `${RUNTIME_PACKAGE_NAME}@${safeVersion}`,
  ];

  // shell=true（仅 Windows npm.cmd）时 Node 只做空格拼接：含空格的 path/参数必须自行加引号。
  const cmdQuote = (value) => (/[\s&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const spawnArgs = shell ? args.map((entry) => cmdQuote(String(entry))) : args;
  const spawnCommand = shell && /\s/.test(command) ? `"${command}"` : command;

  return {
    command: spawnCommand,
    args: spawnArgs,
    shell,
    version: safeVersion,
    display: `npm install --prefix ${prefix} --ignore-scripts --no-audit --no-fund ${RUNTIME_PACKAGE_NAME}@${safeVersion}`,
  };
}

/** 脱敏 npm 输出：去掉 registry 凭据、token/password/auth 赋值与 URL userinfo。 */
export function sanitizeRuntimeInstallLog(value) {
  return String(value ?? '')
    .replace(/(_authToken|_auth|password|passwd|secret|authorization|bearer|token)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/(^|\s)\/\/[^:\s/]+:[^@\s]+@/g, '$1//[redacted]@');
}

function firstUsefulLine(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line === undefined ? null : sanitizeRuntimeInstallLog(line).slice(0, 300);
}

function statusFromText(text) {
  const explicit = /\b(?:E|HTTP\s*)([45]\d{2})\b/i.exec(text);
  if (explicit) return Number(explicit[1]);
  const plain = /(?:^|\s)([45]\d{2})(?:\s|$)/m.exec(text);
  return plain ? Number(plain[1]) : null;
}

/**
 * 从 spawn 错误 / 退出码 / npm stderr 稳定分类。
 * 返回 `{ reason, status?, detail? }`；detail 已脱敏。
 */
export function classifyNpmInstallFailure({ spawnError = null, exitCode = null, stdout = '', stderr = '' } = {}) {
  const text = `${stderr}\n${stdout}`;
  const lower = text.toLowerCase();
  const spawnCode = typeof spawnError?.code === 'string' ? spawnError.code.toUpperCase() : '';

  const result = (reason, extra = {}) => ({
    reason,
    detail: firstUsefulLine(text) ?? (spawnError?.message ? sanitizeRuntimeInstallLog(spawnError.message).slice(0, 300) : null),
    ...extra,
  });

  if (spawnError) {
    if (spawnCode === 'ENOENT') return result('npm_missing');
    if (spawnCode === 'EACCES' || spawnCode === 'EPERM') return result('permission_denied');
    if (spawnCode === 'ENOSPC') return result('disk_full');
    if (spawnCode === 'ETIMEDOUT') return result('registry_unreachable');
    if (spawnCode === 'ECONNREFUSED' || spawnCode === 'ECONNRESET') {
      return result('registry_unreachable');
    }
    if (spawnCode === 'ENOTFOUND' || spawnCode === 'EAI_AGAIN'
      || spawnCode === 'ENETUNREACH' || spawnCode === 'EHOSTUNREACH') {
      return result('offline');
    }
  }

  if (/eintegrity|integrity checksum|integrity.*(?:fail|mismatch)|shasum|checksum.*(?:fail|mismatch)/i.test(text)) {
    return result('integrity_mismatch');
  }
  if (/enospc|no space left on device|disk (?:is )?full|not enough space/i.test(text)) {
    return result('disk_full');
  }
  if (/eacces|eperm|permission denied|operation not permitted|access is denied/i.test(text)) {
    return result('permission_denied');
  }
  if (exitCode === 127 || /npm: command not found|npm: not found|'npm' is not recognized|not recognized as an internal/i.test(text)) {
    return result('npm_missing');
  }

  const status = statusFromText(text);
  if (/etarget|no matching version|version not found/i.test(text)) {
    return result('unsupported_version', { status: 404 });
  }
  if (/e404|404 not found|not in this registry/i.test(text)) {
    return result('http_error', { status: 404 });
  }
  if (/e401|401 unauthorized|e403|403 forbidden|unauthorized|forbidden/i.test(text)) {
    return result('http_error', { status: status ?? (/401/.test(text) ? 401 : 403) });
  }
  if (status !== null || /http error|response code|bad gateway|service unavailable|internal server error/i.test(text)) {
    return result('http_error', { status });
  }

  if (/enotfound|eai_again|eai_fail|getaddrinfo|enotreach|network is unreachable|offline|dns lookup/i.test(lower)) {
    return result('offline');
  }
  if (/econnrefused|econnreset|etimedout|esockettimedout|socket hang up|network request.*failed|request to .* failed|registry.*unreachable/i.test(lower)) {
    return result('registry_unreachable');
  }

  // npm 非零退出但无法进一步分类：归入 registry/http 失败，仍给出稳定 reason。
  return result(exitCode === 0 ? 'install_failed' : 'http_error', { status });
}

function classifyFsError(error) {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  if (code === 'ENOSPC') return 'disk_full';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'permission_denied';
  return 'install_failed';
}

function failureError(reason, message, extra = {}) {
  return cloudError(INSTALL_REASON_SET.has(reason) || reason === 'install_locked' || reason === 'install_failed'
    ? reason
    : 'install_failed', message, extra);
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

function readJsonFileSync(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** 检查一个 npm prefix 是否就是目标共享 runtime（版本 + CLI 路径存在）。 */
export async function inspectInstalledRuntime(directory, version) {
  const packagePath = join(directory, RUNTIME_PACKAGE_RELATIVE);
  const cliPath = join(directory, RUNTIME_CLI_RELATIVE);
  let raw;
  try {
    raw = await readFile(packagePath, 'utf-8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, reason: 'missing', detail: 'package_json_missing', runtimePath: directory, cliPath };
    }
    return {
      ok: false,
      reason: classifyFsError(error),
      detail: `package_json_unreadable:${error?.code ?? 'error'}`,
      runtimePath: directory,
      cliPath,
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'integrity_mismatch', detail: 'package_json_invalid', runtimePath: directory, cliPath };
  }
  if (manifest?.name !== undefined && manifest.name !== RUNTIME_PACKAGE_NAME) {
    return {
      ok: false,
      reason: 'integrity_mismatch',
      detail: 'package_name_mismatch',
      installedName: typeof manifest.name === 'string' ? manifest.name.slice(0, 80) : null,
      runtimePath: directory,
      cliPath,
    };
  }
  if (manifest?.version !== version) {
    return {
      ok: false,
      reason: 'integrity_mismatch',
      detail: 'version_mismatch',
      installedVersion: typeof manifest.version === 'string' ? manifest.version.slice(0, MAX_VERSION_LENGTH) : null,
      runtimePath: directory,
      cliPath,
    };
  }

  try {
    const info = await stat(cliPath);
    if (!info.isFile()) {
      return { ok: false, reason: 'integrity_mismatch', detail: 'cli_not_file', runtimePath: directory, cliPath };
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, reason: 'integrity_mismatch', detail: 'cli_missing', runtimePath: directory, cliPath };
    }
    return {
      ok: false,
      reason: classifyFsError(error),
      detail: `cli_unreadable:${error?.code ?? 'error'}`,
      runtimePath: directory,
      cliPath,
    };
  }

  return { ok: true, packageVersion: manifest.version, runtimePath: directory, cliPath };
}

async function acquireInstallLock({ root, version, reinstall, now, pidAliveFn }) {
  const runtimeDir = runtimeRootPath(root);
  await mkdir(runtimeDir, { recursive: true });
  const path = runtimeInstallLockPath(root);
  const startedAt = now();
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt,
    version,
    mode: reinstall ? 'reinstall' : 'install',
  });
  const acquire = () => writeFile(path, payload, { mode: 0o600, flag: 'wx' });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await acquire();
      return {
        path,
        startedAt,
        async release() {
          try {
            const held = await readJsonFile(path);
            if (held?.pid === process.pid && held?.startedAt === startedAt) {
              await rm(path, { force: true });
            }
          } catch {
            // 已释放/被回收
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const held = await readJsonFile(path);
      const holderPid = Number(held?.pid);
      if (Number.isInteger(holderPid) && holderPid > 0 && pidAliveFn(holderPid)) {
        throw failureError('install_locked', `另一个进程正在安装 runtime（pid ${holderPid}）；请稍后重试`, {
          holderPid,
          lockPath: path,
        });
      }
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
  throw failureError('install_locked', 'runtime 安装锁被占用；请稍后重试', { lockPath: path });
}

async function removeStaleStaging(runtimeDir) {
  let entries;
  try {
    entries = await readdir(runtimeDir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((entry) => entry.name.startsWith(RUNTIME_STAGING_PREFIX))
    .map((entry) => rm(join(runtimeDir, entry.name), { recursive: true, force: true }).catch(() => undefined)));
}

function installExitCleanup(state) {
  const onExit = () => {
    if (state.tempPath) {
      try { rmSync(state.tempPath, { recursive: true, force: true }); } catch { /* 进程退出清理尽力而为 */ }
    }
    const lockPath = state.lockPath ?? (state.root ? runtimeInstallLockPath(state.root) : null);
    if (lockPath) {
      try {
        const held = readJsonFileSync(lockPath);
        // 本进程是唯一可能持有该 PID 的安装者；进程退出时直接回收自己的锁。
        if (Number(held?.pid) === process.pid) rmSync(lockPath, { force: true });
      } catch {
        // 已释放/被回收
      }
    }
  };
  process.once('exit', onExit);
  return () => process.removeListener('exit', onExit);
}

function runNpmInstall({
  command,
  args,
  shell,
  cwd,
  env,
  timeoutMs,
  killGraceMs,
  signal,
  spawnFn,
}) {
  return new Promise((resolvePromise) => {
    let child = null;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer = null;
    let killTimer = null;
    let forceTimer = null;
    let exitTimer = null;
    let aborted = false;
    let timedOut = false;
    let killSignals = [];

    const append = (current, chunk) => (current + String(chunk)).slice(-MAX_LOG_BYTES);
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (forceTimer !== null) clearTimeout(forceTimer);
      if (exitTimer !== null) clearTimeout(exitTimer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ stdout, stderr, aborted, timedOut, killSignals, ...result });
    };
    const killChild = (name) => {
      if (!child || typeof child.kill !== 'function') return;
      killSignals = [...killSignals, name];
      try { child.kill(name); } catch { /* 已退出 */ }
    };
    const terminate = () => {
      killChild('SIGTERM');
      if (killTimer === null) {
        killTimer = setTimeout(() => killChild('SIGKILL'), Math.max(0, killGraceMs));
      }
      if (forceTimer === null) {
        forceTimer = setTimeout(() => finish({ exitCode: null, signal: null, forced: true }), Math.max(0, killGraceMs) + 500);
      }
    };
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      terminate();
    };

    if (signal?.aborted) {
      aborted = true;
      finish({ exitCode: null, signal: null });
      return;
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      child = spawnFn(command, args, {
        cwd,
        env,
        shell: shell === true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish({ spawnError: error, exitCode: null, signal: null });
      return;
    }

    const listen = (emitter, event, handler) => {
      if (typeof emitter?.once === 'function') emitter.once(event, handler);
      else if (typeof emitter?.on === 'function') emitter.on(event, handler);
    };
    child.stdout?.on?.('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on?.('data', (chunk) => { stderr = append(stderr, chunk); });
    listen(child, 'error', (error) => finish({ spawnError: error, exitCode: null, signal: null }));
    listen(child, 'close', (code, name) => finish({ exitCode: code, signal: name }));
    listen(child, 'exit', (code, name) => {
      if (!child.stdout && !child.stderr) {
        finish({ exitCode: code, signal: name });
        return;
      }
      // 真实 child 随后会发 close；假 child/异常平台只发 exit 时也给一个短暂兜底。
      if (exitTimer === null) {
        exitTimer = setTimeout(() => finish({ exitCode: code, signal: name }), 100);
      }
    });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
    }
  });
}

async function detectRunning({ root, home, pidAliveFn }) {
  const active = readJsonFileSync(join(root, 'active.lock'));
  const activePid = Number(active?.pid);
  const activeAlive = Number.isInteger(activePid) && activePid > 0 && pidAliveFn(activePid);
  const homeLock = readJsonFileSync(join(home, 'lock'));
  const homePid = Number(homeLock?.pid);
  const homeAlive = Number.isInteger(homePid) && homePid > 0 && pidAliveFn(homePid);
  const runtime = readJsonFileSync(join(home, 'runtime.json'));
  const runtimePid = Number(runtime?.pid);
  const runtimeAlive = Number.isInteger(runtimePid) && runtimePid > 0 && pidAliveFn(runtimePid);
  return {
    daemonRunning: activeAlive || homeAlive || runtimeAlive,
    serviceRunning: null,
    runningDetected: activeAlive || homeAlive || runtimeAlive,
    pid: runtimeAlive ? runtimePid : (homeAlive ? homePid : (activeAlive ? activePid : null)),
    version: typeof runtime?.version === 'string' ? runtime.version : null,
  };
}

function publicProvider(provider, meta = {}) {
  if (!provider) return null;
  return {
    id: provider.id ?? null,
    kind: provider.kind,
    path: provider.path,
    version: provider.version ?? null,
    capabilities: Array.isArray(provider.capabilities) ? [...provider.capabilities] : [],
    ...meta,
  };
}

function successResult(context, fields = {}) {
  return {
    ok: true,
    code: null,
    reason: null,
    message: null,
    command: context.command,
    root: context.root,
    cloudRoot: context.root,
    runtimeRoot: context.runtimeRoot,
    version: context.version,
    runtimePath: context.runtimePath,
    cliPath: context.cliPath,
    manualCommand: context.manualCommand,
    reinstall: context.reinstall,
    reused: false,
    changed: true,
    previous: null,
    backupPath: null,
    runtimeInstalled: true,
    providerRegistered: false,
    provider: null,
    current: null,
    restartRequired: false,
    running: null,
    note: null,
    warnings: [],
    checkedAt: context.checkedAt,
    ...fields,
  };
}

function failureResult(context, error, fields = {}) {
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'install_failed';
  return {
    ok: false,
    code,
    reason: code,
    message: sanitizeRuntimeInstallLog(fields.message ?? error?.message ?? String(error)).slice(0, 600),
    command: context.command,
    root: context.root,
    cloudRoot: context.root,
    runtimeRoot: context.runtimeRoot,
    version: context.version,
    requestedVersion: context.requestedVersion,
    runtimePath: context.runtimePath,
    cliPath: context.cliPath,
    manualCommand: context.manualCommand,
    reinstall: context.reinstall,
    reused: false,
    changed: false,
    previous: fields.previous ?? null,
    backupPath: fields.backupPath ?? null,
    runtimeInstalled: fields.runtimeInstalled === true,
    providerRegistered: fields.providerRegistered === true,
    provider: fields.provider ?? null,
    current: fields.current ?? null,
    targetPreserved: fields.targetPreserved === true,
    restartRequired: false,
    running: fields.running ?? null,
    detail: fields.detail ?? error?.detail ?? null,
    status: fields.status ?? error?.status ?? null,
    installedVersion: fields.installedVersion ?? error?.installedVersion ?? null,
    logTail: fields.logTail ?? error?.logTail ?? null,
    timedOut: fields.timedOut === true,
    providerErrorCode: fields.providerErrorCode ?? null,
    currentWriteFailed: fields.currentWriteFailed === true,
    holderPid: fields.holderPid ?? error?.holderPid ?? null,
    previousPreserved: fields.previousPreserved ?? error?.previousPreserved ?? null,
    warnings: fields.warnings ?? [],
    checkedAt: context.checkedAt,
  };
}

/**
 * 安装/重装共享 runtime。
 *
 * `reinstall: true` 时即使目标版本已存在也会重新下载/校验/原子替换，并把旧目录
 * rename 为 backup 保留；失败时旧目录/旧 provider 保持不变。
 */
export async function installRuntime(options = {}) {
  const {
    version: requestedVersion = APP_VERSION,
    reinstall = false,
    root: explicitRoot,
    home: explicitHome,
    env = process.env,
    userHome = homedir(),
    platform = process.platform,
    npmPath = null,
    spawnFn = spawn,
    timeoutMs = RUNTIME_INSTALL_TIMEOUT_MS,
    killGraceMs = RUNTIME_KILL_GRACE_MS,
    signal = null,
    pidAliveFn = pidAlive,
    registerProviderFn = registerExclusiveRuntimeProvider,
    detectRunningFn = null,
    now = () => new Date().toISOString(),
  } = options;

  const command = reinstall ? 'reinstall' : 'install';
  const checkedAt = now();
  const context = {
    command,
    root: null,
    runtimeRoot: null,
    version: null,
    requestedVersion: safeRequestedVersion(requestedVersion),
    runtimePath: null,
    cliPath: null,
    manualCommand: null,
    reinstall: reinstall === true,
    checkedAt,
  };

  try {
    context.version = assertRuntimeVersion(requestedVersion);
    context.manualCommand = manualRuntimeInstallCommand(context.version);
  } catch (error) {
    context.version = context.requestedVersion;
    return failureResult(context, error, { targetPreserved: false });
  }

  let cloud;
  try {
    if (typeof explicitRoot === 'string' && explicitRoot.trim().length > 0) {
      cloud = { available: true, root: resolve(explicitRoot.trim()) };
    } else {
      cloud = resolveCloudRoot({ env, userHome });
    }
    if (!cloud.available) {
      throw failureError('install_failed', `runtime 上下文不可用（${cloud.reason ?? 'cloud_unavailable'}）`);
    }
  } catch (error) {
    return failureResult(context, error, { targetPreserved: false });
  }

  const root = cloud.root;
  const home = typeof explicitHome === 'string' && explicitHome.trim().length > 0 ? resolve(explicitHome) : root;
  const runtimeDir = runtimeRootPath(root);
  const targetPath = runtimeVersionPath(root, context.version);
  const cliPath = sharedRuntimeCliPath(root, context.version);
  context.root = root;
  context.runtimeRoot = runtimeDir;
  context.runtimePath = targetPath;
  context.cliPath = cliPath;

  const state = { root, tempPath: null, lockPath: null, startedAt: null };
  let lock = null;
  let removeExitCleanup = null;
  let backupPath = null;
  let previous = null;
  let runtimeInstalled = false;

  const detect = async () => {
    if (typeof detectRunningFn === 'function') return detectRunningFn({ root, home, pidAliveFn });
    return detectRunning({ root, home, pidAliveFn });
  };
  const detectSafe = async () => {
    try {
      return await detect();
    } catch (error) {
      return {
        daemonRunning: null,
        serviceRunning: null,
        runningDetected: false,
        error: sanitizeRuntimeInstallLog(error?.message ?? error).slice(0, 300),
      };
    }
  };

  const registerProvider = async () => {
    try {
      const registration = await registerProviderFn(root, {
        kind: 'shared',
        path: cliPath,
        version: context.version,
        capabilities: RUNTIME_SHARED_CAPABILITIES,
      }, { now: now() });
      return {
        ok: true,
        registration,
        provider: publicProvider(registration?.provider, {
          created: registration?.created === true,
          unchanged: registration?.unchanged === true,
          replaced: Array.isArray(registration?.replaced)
            ? registration.replaced.map((entry) => ({ kind: entry.kind, path: entry.path, version: entry.version ?? null }))
            : [],
        }),
      };
    } catch (error) {
      return { ok: false, error };
    }
  };

  // 4a/4b 共用语义：安装成功后写 current。已存在的同路径/同版本 current 保留 installedAt，
  // 避免幂等 install 每次刷新“安装时间”；新安装使用本次 checkedAt。
  const persistCurrent = async () => {
    try {
      const previous = await readRuntimeCurrent(root);
      const installedAt = previous.usable
        && previous.current?.runtimePath === targetPath
        && previous.current?.version === context.version
        ? previous.current.installedAt
        : checkedAt;
      const current = await writeRuntimeCurrent(root, {
        version: context.version,
        runtimePath: targetPath,
        cliPath,
        provider: 'shared',
        owner: 'shared',
        installedAt,
      }, { now: checkedAt });
      return { ok: true, current };
    } catch (error) {
      return { ok: false, error };
    }
  };

  try {
    removeExitCleanup = installExitCleanup(state);
    lock = await acquireInstallLock({
      root,
      version: context.version,
      reinstall: reinstall === true,
      now,
      pidAliveFn,
    });
    state.lockPath = lock.path;
    state.startedAt = lock.startedAt;

    await removeStaleStaging(runtimeDir);

    const targetExistsBeforeInstall = existsSync(targetPath);
    const existing = await inspectInstalledRuntime(targetPath, context.version);
    if (existing.ok) {
      previous = { version: existing.packageVersion, runtimePath: targetPath, valid: true };
    } else if (targetExistsBeforeInstall) {
      previous = { version: null, runtimePath: targetPath, valid: false };
    }

    // install 对已存在且完整的同版本是幂等的；reinstall 明确覆盖。
    if (!reinstall && existing.ok) {
      const registration = await registerProvider();
      if (!registration.ok) {
        const error = cloudError(
          'provider_registration_failed',
          'runtime 已存在且可用，但 provider 注册失败；请修复 runtime-providers.json 后重试',
          { detail: sanitizeRuntimeInstallLog(registration.error?.message ?? registration.error).slice(0, 300) },
        );
        return failureResult(context, error, {
          runtimeInstalled: true,
          providerRegistered: false,
          targetPreserved: true,
          previous: null,
          backupPath: null,
          providerErrorCode: registration.error?.code ?? null,
        });
      }
      const running = await detectSafe();
      const current = await persistCurrent();
      if (!current.ok) {
        return failureResult(context, cloudError(
          'install_failed',
          '共享 runtime 已存在，但 current 指针写入失败；现有 runtime/provider 未被删除',
          { detail: sanitizeRuntimeInstallLog(current.error?.message ?? current.error).slice(0, 300), currentWriteFailed: true },
        ), {
          runtimeInstalled: true,
          providerRegistered: true,
          targetPreserved: true,
          previous: null,
          backupPath: null,
        });
      }
      return successResult(context, {
        reused: true,
        changed: false,
        previous: null,
        backupPath: null,
        providerRegistered: true,
        provider: registration.provider,
        current: current.current,
        restartRequired: running.runningDetected === true,
        running,
        note: running.runningDetected
          ? '共享 runtime 已存在；正在运行的 daemon/service 未停止，重启后使用该版本'
          : '共享 runtime 已存在；可使用 mebular runtime ensure 启动',
      });
    }

    const tempPath = join(runtimeDir, `${RUNTIME_STAGING_PREFIX}${context.version}-${process.pid}-${randomSuffix()}`);
    state.tempPath = tempPath;
    await mkdir(tempPath, { recursive: true });

    const invocation = buildNpmInstallCommand({
      version: context.version,
      prefix: tempPath,
      platform,
      npmPath,
    });
    const childEnv = { ...env };
    delete childEnv.npm_config_global;
    delete childEnv.npm_config_argv;
    delete childEnv.npm_config_prefix;

    const run = await runNpmInstall({
      command: invocation.command,
      args: invocation.args,
      shell: invocation.shell,
      cwd: tempPath,
      env: childEnv,
      timeoutMs,
      killGraceMs,
      signal,
      spawnFn,
    });

    if (run.aborted) {
      throw failureError('cancelled', 'runtime 安装已取消', { detail: 'aborted' });
    }
    if (run.timedOut) {
      throw failureError('cancelled', `runtime 安装超时（${timeoutMs}ms）`, { detail: 'timeout', timedOut: true });
    }
    if (run.spawnError || run.exitCode !== 0) {
      const classified = classifyNpmInstallFailure({
        spawnError: run.spawnError,
        exitCode: run.exitCode,
        stdout: run.stdout,
        stderr: run.stderr,
      });
      throw failureError(classified.reason, `runtime 安装失败（${classified.reason}）`, {
        detail: classified.detail,
        status: classified.status,
        logTail: sanitizeRuntimeInstallLog(`${run.stderr}\n${run.stdout}`).slice(-4000) || null,
      });
    }

    const installed = await inspectInstalledRuntime(tempPath, context.version);
    if (!installed.ok) {
      const reason = installed.reason === 'missing' ? 'integrity_mismatch' : installed.reason;
      throw failureError(reason, 'runtime 安装校验失败（包版本或 CLI 路径不匹配）', {
        detail: installed.detail ?? installed.reason,
        installedVersion: installed.installedVersion ?? null,
        logTail: null,
      });
    }

    // 先备份旧目录，再原子换入新目录；任何一步失败都恢复旧目录。
    if (existsSync(targetPath)) {
      backupPath = join(runtimeDir, `${RUNTIME_BACKUP_PREFIX}${context.version}-${timestampId(now())}-${randomSuffix()}`);
      await rename(targetPath, backupPath);
    }
    try {
      await rename(tempPath, targetPath);
      state.tempPath = null;
    } catch (error) {
      if (backupPath !== null) {
        try {
          await rename(backupPath, targetPath);
          backupPath = null;
        } catch (restoreError) {
          throw failureError('permission_denied', `换入新 runtime 失败且无法恢复旧目录：${restoreError?.message ?? restoreError}`, {
            detail: 'swap_restore_failed',
            backupPath,
          });
        }
      }
      throw failureError(classifyFsError(error), `换入 runtime 目录失败（${error?.code ?? 'error'}）`, {
        detail: 'swap_failed',
        backupPath,
      });
    }

    const finalCheck = await inspectInstalledRuntime(targetPath, context.version);
    if (!finalCheck.ok) {
      const failedPath = join(runtimeDir, `${RUNTIME_STAGING_PREFIX}failed-${context.version}-${randomSuffix()}`);
      await rename(targetPath, failedPath).catch(() => undefined);
      await rm(failedPath, { recursive: true, force: true }).catch(() => undefined);
      let restored = false;
      if (backupPath !== null) {
        try {
          await rename(backupPath, targetPath);
          backupPath = null;
          restored = true;
        } catch {
          restored = false;
        }
      }
      throw failureError('integrity_mismatch', 'runtime 原子换入后校验失败', {
        detail: finalCheck.detail ?? 'final_validation_failed',
        previousPreserved: restored,
      });
    }

    runtimeInstalled = true;

    const registration = await registerProvider();
    if (!registration.ok) {
      const error = cloudError(
        'provider_registration_failed',
        'runtime 已安装，但 provider 注册失败；新 runtime 保留，现有 provider 未被覆盖',
        { detail: sanitizeRuntimeInstallLog(registration.error?.message ?? registration.error).slice(0, 300) },
      );
      return failureResult(context, error, {
        runtimeInstalled: true,
        providerRegistered: false,
        targetPreserved: true,
        previous,
        backupPath,
        providerErrorCode: registration.error?.code ?? null,
      });
    }

    const running = await detectSafe();
    const current = await persistCurrent();
    if (!current.ok) {
      return failureResult(context, cloudError(
        'install_failed',
        'runtime 已安装，但 current 指针写入失败；现有 runtime/provider 未被删除',
        { detail: sanitizeRuntimeInstallLog(current.error?.message ?? current.error).slice(0, 300), currentWriteFailed: true },
      ), {
        runtimeInstalled: true,
        providerRegistered: true,
        targetPreserved: true,
        previous,
        backupPath,
        provider: registration.provider,
      });
    }
    return successResult(context, {
      reused: false,
      changed: true,
      previous,
      backupPath,
      providerRegistered: true,
      provider: registration.provider,
      current: current.current,
      restartRequired: running.runningDetected === true,
      running,
      note: running.runningDetected
        ? '共享 runtime 已安装；正在运行的 daemon/service 未停止，重启后使用新版本（Phase 5）'
        : '共享 runtime 已安装；可使用 mebular runtime ensure 启动',
    });
  } catch (error) {
    const fsReason = classifyFsError(error);
    const domainCode = typeof error?.code === 'string'
      && (INSTALL_REASON_SET.has(error.code) || error.code === 'install_locked' || error.code === 'install_failed');
    const normalized = fsReason !== 'install_failed'
      ? failureError(fsReason, `runtime 安装失败（${fsReason}）`, {
        detail: `fs:${error?.code ?? 'error'}`,
        logTail: null,
      })
      : (domainCode
        ? error
        : failureError('install_failed', error?.message ?? String(error), {
          detail: `fs:${error?.code ?? 'error'}`,
          logTail: null,
        }));
    return failureResult(context, normalized, {
      runtimeInstalled,
      providerRegistered: false,
      targetPreserved: existsSync(targetPath),
      previous,
      backupPath,
      detail: normalized?.detail ?? error?.detail ?? null,
      logTail: normalized?.logTail ?? error?.logTail ?? null,
      timedOut: normalized?.timedOut === true,
      holderPid: normalized?.holderPid ?? error?.holderPid ?? null,
    });
  } finally {
    if (state.tempPath) {
      await rm(state.tempPath, { recursive: true, force: true }).catch(() => undefined);
    }
    removeExitCleanup?.();
    await lock?.release?.();
  }
}

/** 语义包装：明确覆盖/保留旧版本。 */
export async function reinstallRuntime(options = {}) {
  return installRuntime({ ...options, reinstall: true });
}
