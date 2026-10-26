// 共享 Runtime Supervisor（Phase 1）：profile/cloudRoot 解析、provider 发现、ensure/status。
//
// 目标边界：
//   - App 与 DSH Plugin 只 attach/ensure 同一个 runtime/daemon/service；
//   - 本模块放在 @mebular/mcp 内，不 import apps/desktop，也不复制 App 的业务状态机；
//   - 健康 daemon → attach；已注册 service → 启动/复用；provider → 启动；否则
//     `download_required`。Phase 1 **绝不下载、不安装、不升级**。
//
// 返回对象只含非敏感发现信息（profile/home/http/instance/version/provider/service），
// 不含令牌、主密钥或身份文件内容。CLI 用 `toPublicRuntimeResult` 去掉进程句柄。

import { accessSync, existsSync, readFileSync, statSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from './version.mjs';
import {
  cloudError,
  displayPath,
  homeKey,
  isHomeInRoot,
  pidAlive,
  profileHomeForEntry,
  profileIdForHome,
  readRegistry,
  resolveCloudRoot,
} from './profiles.mjs';
import { readRuntimeFile, runtimePath } from './runtime-file.mjs';
import {
  readRuntimeProviders,
  runtimeProviderId,
} from './runtime-providers.mjs';
import {
  publicRuntimeCurrent,
  readRuntimeCurrent,
} from './runtime-current.mjs';
import {
  RUNTIME_SERVICE_KIND,
  resolveRuntimeServiceSource,
  restartRuntimeService,
  runtimeServiceDescriptor,
  runtimeServiceStatus,
} from './runtime-service.mjs';

export const RUNTIME_DEFAULT_HOST = '127.0.0.1';
export const RUNTIME_DEFAULT_PORT = 7331;
export const RUNTIME_START_LOCK_FILE = 'runtime-start.lock';
export { RUNTIME_SERVICE_KIND };
export const RUNTIME_SERVICE_KIND_NAME = RUNTIME_SERVICE_KIND;
export const RUNTIME_PROVIDER_SOURCE_ORDER = Object.freeze({ current: -1, registry: 0, standard: 1, path: 2, self: 2 });
export const RUNTIME_PROVIDER_KIND_ORDER = Object.freeze({ app: 0, cli: 1, shared: 2 });

const HEALTH_TERMINAL_REASONS = new Set(['instance_mismatch', 'instance_missing', 'cloud_mismatch']);
const HEALTH_STATUS_TERMINAL_REASONS = new Set([...HEALTH_TERMINAL_REASONS, 'status']);

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export function runtimeStartLockPath(root) {
  return join(root, RUNTIME_START_LOCK_FILE);
}

export function resolveRuntimeServiceHome({ serviceHome, env = process.env } = {}) {
  return serviceHome ?? env.MEBULAR_SERVICE_UNIT_HOME ?? homedir();
}

/** 本 CLI 入口（provider 自身；不依赖 cwd）。 */
export function defaultSelfCliPath() {
  return fileURLToPath(new URL('../bin/mebular.mjs', import.meta.url));
}

async function readHomeConfig(home) {
  try {
    return JSON.parse(await readFile(join(home, 'config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

function pickPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** 守护 HTTP 目标：env > runtime.json（实际监听）> config.json > 默认。 */
export async function resolveRuntimeHttp(home, { env = process.env, runtime = null } = {}) {
  const config = await readHomeConfig(home);
  const configHttp = config?.mcp?.http ?? {};
  const runtimeHttp = runtime?.http ?? {};
  const rawHost = env.MEBULAR_HTTP_HOST
    ?? (typeof runtimeHttp.host === 'string' && runtimeHttp.host.length > 0 ? runtimeHttp.host : null)
    ?? (typeof configHttp.host === 'string' && configHttp.host.length > 0 ? configHttp.host : null)
    ?? RUNTIME_DEFAULT_HOST;
  const host = rawHost === '0.0.0.0' || rawHost === '::' ? RUNTIME_DEFAULT_HOST : rawHost;
  const port = pickPort(env.MEBULAR_HTTP_PORT)
    ?? pickPort(runtimeHttp.port)
    ?? pickPort(configHttp.port)
    ?? RUNTIME_DEFAULT_PORT;
  const tls = configHttp.tls === true || Boolean(configHttp.tlsKey && configHttp.tlsCert);
  const scheme = tls ? 'https' : 'http';
  return { host, port, scheme, url: `${scheme}://${host}:${port}/healthz` };
}

/**
 * 解析 runtime 所属的 cloudRoot/profile/home。
 *
 * 显式 home（App 传入 / 用户设置 MEBULAR_HOME）优先；未显式指定时跟随注册表 current，
 * 这样 Plugin/CLI 在默认 `~/.mebular` 下也能 attach 到 App 当前的非默认 profile。
 */
export async function resolveRuntimeContext({ home, env = process.env, userHome = homedir() } = {}) {
  const cloud = resolveCloudRoot({ home, env, userHome });
  if (!cloud.available) {
    return {
      ok: false,
      reason: cloud.reason ?? 'cloud_unavailable',
      cloudRoot: cloud.root,
      home: cloud.home,
      defaultHome: cloud.defaultHome,
    };
  }

  const state = await readRegistry(cloud.root);
  const explicitHome = home !== undefined
    || (typeof env.MEBULAR_HOME === 'string' && env.MEBULAR_HOME.trim().length > 0);
  const current = state.registry.current === null
    ? null
    : state.registry.profiles.find((entry) => entry.id === state.registry.current) ?? null;

  let profileId = null;
  let profile = null;
  if (explicitHome) {
    const candidateId = await profileIdForHome(cloud.root, cloud.home);
    const candidate = candidateId === null
      ? null
      : state.registry.profiles.find((entry) => entry.id === candidateId) ?? null;
    const explicitIsRoot = resolve(cloud.home) === resolve(cloud.root);
    // 显式 home 是默认 root 时仍跟随 current profile：Plugin/CLI 常继承 MEBULAR_HOME=~/.mebular，
    // 不能因此落到 default 而另起一张忆云。App 传入的是当前 profile home，不受影响。
    if (candidate !== null && !(explicitIsRoot && current !== null && current.id !== candidate.id)) {
      profileId = candidate.id;
      profile = candidate;
    } else if (explicitIsRoot && current !== null) {
      profileId = current.id;
      profile = current;
    } else if (candidate !== null) {
      profileId = candidate.id;
      profile = candidate;
    }
  } else {
    profileId = current?.id ?? null;
    profile = current;
  }

  const homePath = profile !== null
    ? profileHomeForEntry(cloud.root, profile)
    : (isHomeInRoot(cloud.root, cloud.home) ? cloud.home : cloud.root);
  const runtime = await readRuntimeFile(homePath);
  const http = await resolveRuntimeHttp(homePath, { env, runtime });

  return {
    ok: true,
    cloudRoot: cloud.root,
    cloudRootDisplay: displayPath(cloud.root, { userHome }),
    profileId,
    profile: profile === null
      ? null
      : { id: profile.id, name: profile.name, home: profile.home, kind: profile.kind },
    home: homePath,
    homeKey: homeKey(homePath),
    defaultHome: cloud.defaultHome,
    registrySource: state.source,
    warning: state.warning ?? null,
    runtime,
    runtimePath: runtime === null ? null : runtimePath(homePath),
    http,
  };
}

/** `<root>/active.lock`：root 级单活锁；损坏/不存在返回 null。 */
export function readActiveRuntimeLock(root) {
  if (typeof root !== 'string' || root.length === 0) return null;
  try {
    return JSON.parse(readFileSync(join(root, 'active.lock'), 'utf-8'));
  } catch {
    return null;
  }
}

export function activeLockConflict(active, home) {
  if (!active || !Number.isInteger(active.pid) || !pidAlive(active.pid)) return null;
  const heldHome = typeof active.home === 'string' && active.home.length > 0 ? resolve(active.home) : null;
  if (heldHome === null) return null;
  if (heldHome === resolve(home)) return null;
  return active;
}

/**
 * `/healthz` 探测详情（注入 fetch，便于单测）：
 *   200 但 instance/cloudId 不符 → 返回原因，调用方不得 reused / 不得继续启动。
 */
export async function probeRuntimeHealth(fetchImpl, http = { url: null }, options = {}) {
  const { timeoutMs = 1200, expectedInstance = null, cloudId = null } = options ?? {};
  const url = http.url ?? `${http.scheme ?? 'http'}://${http.host ?? RUNTIME_DEFAULT_HOST}:${http.port ?? RUNTIME_DEFAULT_PORT}/healthz`;
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, reason: 'unreachable', http, url, error: String(error?.message ?? error) };
  }
  if (!res?.ok) {
    return { ok: false, reason: 'status', http, url, status: res?.status ?? null };
  }
  let body = null;
  try {
    body = typeof res.json === 'function' ? await res.json() : null;
  } catch {
    body = null;
  }
  const instance = typeof body?.instance === 'string' ? body.instance : null;
  if (typeof expectedInstance === 'string' && expectedInstance.length > 0) {
    if (instance === null) return { ok: false, reason: 'instance_missing', http, url, body };
    if (instance !== expectedInstance) {
      return { ok: false, reason: 'instance_mismatch', http, url, instance, body };
    }
  }
  if (typeof cloudId === 'string' && cloudId.length > 0
    && typeof body?.cloudId === 'string' && body.cloudId !== cloudId) {
    return { ok: false, reason: 'cloud_mismatch', http, url, cloudId: body.cloudId, body };
  }
  return { ok: true, http, url, body, instance };
}

/** 等待守护就绪；instance/cloudId 不匹配与 HTTP 非 200 是终态（重试无意义）。 */
export async function waitForRuntime({
  fetchImpl,
  http,
  attempts = 40,
  intervalMs = 500,
  onTick,
  expectedInstance = null,
  cloudId = null,
  timeoutMs = 1200,
} = {}) {
  let last = null;
  for (let index = 0; index < attempts; index += 1) {
    last = await probeRuntimeHealth(fetchImpl, http, { timeoutMs, expectedInstance, cloudId });
    if (last.ok) return last;
    if (HEALTH_STATUS_TERMINAL_REASONS.has(last.reason)) return last;
    onTick?.(index);
    if (index + 1 < attempts) await sleep(intervalMs);
  }
  return last ?? { ok: false, reason: 'timeout', http };
}

/** 端口是否有进程监听（只做 connect 探测，不发数据）。 */
export function isPortOpen({ host = RUNTIME_DEFAULT_HOST, port } = {}, timeoutMs = 800) {
  return new Promise((resolvePromise) => {
    if (!Number.isInteger(port) || port <= 0) return resolvePromise(false);
    const socket = connect({ host, port });
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function standardAppProviderPaths({ platform = process.platform, env = process.env, userHome = homedir() } = {}) {
  const tail = ['node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs'];
  if (platform === 'darwin') {
    return [
      join('/Applications', 'Mebular.app', 'Contents', 'Resources', ...tail),
      join(userHome, 'Applications', 'Mebular.app', 'Contents', 'Resources', ...tail),
    ];
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(userHome, 'AppData', 'Local');
    return [
      join(local, 'Programs', 'Mebular', 'resources', ...tail),
      join(local, 'Mebular', 'resources', ...tail),
    ];
  }
  return [
    join('/opt', 'Mebular', 'resources', ...tail),
    join(userHome, '.local', 'share', 'Mebular', 'resources', ...tail),
  ];
}

function findExecutableOnPath(name, { env = process.env, platform = process.platform } = {}) {
  const pathEnv = env.PATH ?? env.Path ?? '';
  const dirs = pathEnv.split(delimiter).filter((dir) => dir.length > 0);
  const suffixes = platform === 'win32'
    ? ['', '.exe', '.cmd', '.bat', '.com']
    : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, `${name}${suffix}`);
      if (!existsSync(candidate)) continue;
      try {
        if (!statSync(candidate).isFile()) continue;
        if (platform !== 'win32') accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // 不可执行/无权限：继续找下一个
      }
    }
  }
  return null;
}

function providerPriority(provider) {
  return [
    RUNTIME_PROVIDER_KIND_ORDER[provider.kind] ?? 9,
    RUNTIME_PROVIDER_SOURCE_ORDER[provider.source] ?? 9,
    provider.path,
  ];
}

function compareProviders(a, b) {
  const left = providerPriority(a);
  const right = providerPriority(b);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

/**
 * 发现 provider：
 *   1. 注册表（App 注册的 kind:app / CLI kind:cli / shared）；
 *   2. 标准 App 安装路径（扩展点：打包布局变化只改这里）；
 *   3. PATH 上的 `mebular`；
 *   4. 当前 CLI 自身（调用 `mebular runtime` 时一定可用）。
 * 只返回已存在路径的 `available`；缺失路径留在 `entries` 供诊断，不参与启动。
 */
export async function discoverRuntimeProviders({
  root,
  env = process.env,
  platform = process.platform,
  userHome = homedir(),
  includeSelf = true,
  includeStandardApp = true,
  registryProviders = null,
  currentState: providedCurrentState = null,
  selfPath = defaultSelfCliPath(),
} = {}) {
  const warnings = [];
  let registry = [];
  if (Array.isArray(registryProviders)) {
    registry = registryProviders;
  } else if (typeof root === 'string' && root.length > 0) {
    const state = await readRuntimeProviders(root);
    registry = state.registry.providers;
    warnings.push(...state.warnings);
  }

  const currentState = providedCurrentState ?? (typeof root === 'string' && root.length > 0
    ? await readRuntimeCurrent(root, { userHome })
    : { current: null, usable: false, source: 'missing', warnings: [] });
  if (currentState?.source === 'invalid') {
    warnings.push(...(currentState.warnings ?? []));
  }

  const entries = [];
  if (currentState?.usable === true && currentState.current) {
    entries.push({
      id: runtimeProviderId('shared', currentState.current.cliPath),
      kind: 'shared',
      path: currentState.current.cliPath,
      version: currentState.current.version,
      runtimePath: currentState.current.runtimePath,
      capabilities: ['serve'],
      registeredAt: currentState.current.installedAt ?? null,
      updatedAt: currentState.current.installedAt ?? null,
      source: 'current',
      available: true,
    });
  }
  const invalidCurrentPath = currentState?.usable !== true && currentState?.current?.cliPath
    ? resolve(currentState.current.cliPath)
    : null;
  for (const provider of registry) {
    const unavailableCurrentTarget = provider.kind === 'shared'
      && invalidCurrentPath !== null
      && resolve(provider.path) === invalidCurrentPath;
    entries.push({
      ...provider,
      source: 'registry',
      available: !unavailableCurrentTarget && existsSync(provider.path),
    });
  }

  if (includeStandardApp) {
    for (const path of standardAppProviderPaths({ platform, env, userHome })) {
      if (!existsSync(path)) continue;
      entries.push({
        id: runtimeProviderId('app', path),
        kind: 'app',
        path,
        version: null,
        capabilities: ['serve'],
        registeredAt: null,
        updatedAt: null,
        source: 'standard',
        available: true,
      });
    }
  }

  const pathCli = findExecutableOnPath('mebular', { env, platform });
  if (pathCli !== null) {
    entries.push({
      id: runtimeProviderId('cli', pathCli),
      kind: 'cli',
      path: pathCli,
      version: null,
      capabilities: ['serve'],
      registeredAt: null,
      updatedAt: null,
      source: 'path',
      available: true,
    });
  }

  if (includeSelf && existsSync(selfPath)) {
    entries.push({
      id: runtimeProviderId('cli', selfPath),
      kind: 'cli',
      path: selfPath,
      version: APP_VERSION,
      capabilities: ['serve'],
      registeredAt: null,
      updatedAt: null,
      source: 'self',
      available: true,
    });
  }

  const deduped = new Map();
  for (const entry of entries) {
    const key = `${entry.kind}\n${entry.path}`;
    if (!deduped.has(key)) deduped.set(key, entry);
  }
  const sorted = [...deduped.values()].sort(compareProviders);
  const available = sorted.filter((entry) => entry.available);
  if (currentState?.usable !== true) {
    const shared = available.filter((entry) => entry.kind === 'shared');
    if (shared.length > 1) {
      warnings.push('存在多个 shared runtime，但 current 不可用：按现有 provider 路径/版本规则选择（建议运行 runtime status 修复 current）');
    }
  }
  return {
    root: typeof root === 'string' ? root : null,
    entries: sorted,
    available,
    selected: available[0] ?? null,
    current: publicRuntimeCurrent(currentState?.current ?? null),
    currentUsable: currentState?.usable === true,
    currentSource: currentState?.source ?? 'missing',
    warnings,
  };
}

/** provider 启动命令：JS 入口用当前 Node 运行时；可执行文件直接执行。 */
export function runtimeCommandForProvider(provider, { execPath = process.execPath } = {}) {
  if (!provider || typeof provider.path !== 'string' || provider.path.length === 0) {
    throw cloudError('RUNTIME_PROVIDER_INVALID', '缺少可启动的 runtime provider');
  }
  if (/\.(mjs|cjs|js)$/i.test(provider.path)) {
    return { execPath, args: [provider.path, 'serve'] };
  }
  return { execPath: provider.path, args: ['serve'] };
}

/** 默认 service 适配器：复用共享 service 层（current 优先）；状态失败不阻塞 attach/provider 兜底。 */
export function createRuntimeServiceAdapter({
  root,
  home,
  cliBin = defaultSelfCliPath(),
  serviceHome,
  env = process.env,
  currentState = null,
  fallbackProvider = null,
} = {}) {
  const resolvedServiceHome = resolveRuntimeServiceHome({ serviceHome, env });
  const fallback = fallbackProvider ?? {
    path: cliBin,
    kind: 'cli',
    owner: 'cli',
    version: APP_VERSION,
    execPath: process.execPath,
  };
  const source = resolveRuntimeServiceSource({ currentState, fallbackProvider: fallback });
  const descriptor = source.ok === true
    ? runtimeServiceDescriptor({ root, home, source })
    : null;
  return {
    descriptor,
    serviceHome: resolvedServiceHome,
    async status() {
      const status = await runtimeServiceStatus({
        root,
        home,
        serviceHome: resolvedServiceHome,
        currentState,
        fallbackProvider: fallback,
      });
      if (status.ok !== true) {
        return {
          ok: false,
          registered: false,
          running: false,
          label: null,
          autostart: null,
          foreign: false,
          unitPath: null,
          error: status.message ?? status.reason ?? 'service_unknown',
        };
      }
      return {
        ok: true,
        registered: status.registered === true,
        running: status.running === true,
        label: status.label ?? null,
        autostart: status.autostart ?? null,
        foreign: status.foreign === true,
        unitPath: status.unitPath ?? null,
        version: status.version ?? null,
        runtimePath: status.runtimePath ?? null,
        provider: status.provider ?? null,
        owner: status.owner ?? null,
        runtime: status.runtime ?? null,
        current: status.current ?? null,
        currentUsable: status.currentUsable === true,
      };
    },
    async restart() {
      const result = await restartRuntimeService({
        root,
        home,
        serviceHome: resolvedServiceHome,
        currentState,
        fallbackProvider: fallback,
      });
      if (result?.ok !== true) {
        throw cloudError(
          'RUNTIME_SERVICE_RESTART_FAILED',
          `常驻服务重启失败：${result?.manual ?? result?.message ?? '未知原因'}`,
          { result },
        );
      }
      return result;
    },
  };
}

/**
 * `<root>/runtime-start.lock`：跨入口启动互斥。
 * 持有者活着的 PID → 返回 acquired:false（调用方等待健康或返回 start_locked）；
 * 陈旧锁 → 回收后重试一次。
 */
export async function tryAcquireRuntimeStartLock({
  root,
  home,
  startedAt = new Date().toISOString(),
  pidAliveFn = pidAlive,
} = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    return { acquired: false, holder: null, path: null, reason: 'cloud_root_unavailable' };
  }
  await mkdir(root, { recursive: true });
  const path = runtimeStartLockPath(root);
  const payload = JSON.stringify({ pid: process.pid, home: resolve(home), startedAt });
  const acquire = () => writeFile(path, payload, { mode: 0o600, flag: 'wx' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await acquire();
      return {
        acquired: true,
        holder: null,
        path,
        async release() {
          try {
            const held = JSON.parse(await readFile(path, 'utf-8'));
            if (held?.pid === process.pid && held?.startedAt === startedAt) {
              await rm(path, { force: true });
            }
          } catch {
            // 已被回收/删除：无需处理
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let held = null;
      try {
        held = JSON.parse(await readFile(path, 'utf-8'));
      } catch {
        held = null;
      }
      if (held?.pid && pidAliveFn(held.pid)) {
        return { acquired: false, holder: held, path, reason: 'start_locked' };
      }
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
  return { acquired: false, holder: null, path, reason: 'start_locked' };
}

/** child 是否仍由本进程托管且存活。 */
export function isRuntimeChildAlive(child) {
  if (!child || child.killed === true) return false;
  const exitedBySignal = typeof child.signalCode === 'string' && child.signalCode.length > 0;
  return child.exitCode === null && !exitedBySignal;
}

/** 只停止本 supervisor 拉起的 child（不碰外部 daemon/service）。 */
export function stopRuntimeChild(child, { signal = 'SIGTERM' } = {}) {
  if (!isRuntimeChildAlive(child) || typeof child.kill !== 'function') return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function childExited(child) {
  if (!child) return true;
  if (typeof child.exitCode === 'number') return true;
  return typeof child.signalCode === 'string' && child.signalCode.length > 0;
}

function signalChild(child, signal) {
  if (!child || typeof child.kill !== 'function' || childExited(child)) return false;
  try {
    return child.kill(signal) !== false;
  } catch {
    return false;
  }
}

/** 等待 child 退出事件；无事件接口/超时返回 false。timeoutMs=null 表示无限等待。 */
function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  if (!child || typeof child.once !== 'function') return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    let timer = null;
    const remove = typeof child.removeListener === 'function'
      ? (event, listener) => child.removeListener(event, listener)
      : (event, listener) => child.off?.(event, listener);
    const done = (exited) => {
      if (timer !== null) clearTimeout(timer);
      remove('exit', onExit);
      resolvePromise(exited);
    };
    const onExit = () => done(true);
    child.once('exit', onExit);
    // 事件注册与退出可能竞态：注册后再检查一次。
    if (childExited(child)) {
      done(true);
      return;
    }
    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
    }
  });
}

/**
 * 优雅停止本 supervisor 拉起的 child：SIGTERM → graceMs → SIGKILL → 等待退出。
 * 返回 `{stopped, escalated, signal, termSent, killSent}`；只作用于传入的 child 句柄。
 */
export async function stopRuntimeChildGracefully(child, {
  graceMs = 2000,
  killWaitMs = 5000,
  graceSignal = 'SIGTERM',
  killSignal = 'SIGKILL',
} = {}) {
  if (!child || childExited(child)) {
    return { stopped: false, escalated: false, signal: null, termSent: false, killSent: false, reason: 'not_running' };
  }
  const termWait = waitForChildExit(child, graceMs);
  const termSent = signalChild(child, graceSignal);
  const exitedAfterTerm = termSent ? await termWait : childExited(child);
  if (exitedAfterTerm) {
    return { stopped: true, escalated: false, signal: graceSignal, termSent, killSent: false };
  }
  const killWait = waitForChildExit(child, killWaitMs);
  const killSent = signalChild(child, killSignal);
  const exitedAfterKill = killSent ? await killWait : childExited(child);
  return {
    stopped: exitedAfterKill,
    escalated: true,
    signal: killSignal,
    termSent,
    killSent,
  };
}

function writeRuntimeLine(stream, value) {
  if (stream && typeof stream.write === 'function') {
    stream.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}

/**
 * 长驻前台 supervisor（`mebular runtime supervise`）：
 *   - reused/service/download_required/conflict：输出一次稳定 JSON 后退出（0 / 2）；
 *   - child：以非 detached 方式启动 provider，输出 ready JSON 后保持存活；
 *   - SIGTERM/SIGINT：只优雅停止自己拉起的 child，然后退出；
 *   - startup 期间收到信号：abort ensure，停止已 spawn 的 child，输出 signal_during_start；
 *   - child 提前退出：返回明确的 child_exited 事件与退出码，不接管外部 daemon/service。
 *
 * 启动期间由 ensure 负责 child 清理（唯一 owner）；supervise 只在 ensure 已返回成功但仍有
 * 存活 child 的竞态窗口做安全兜底，不重复杀/等待。
 *
 * App 在 Phase 2 直接进程内调用 `ensureRuntime({ detached: false })` 并持有句柄；
 * Plugin 在 Phase 3 spawn 本命令，把 supervise 进程当作自己的 child。
 */
export async function superviseRuntime(options = {}) {
  const {
    stdout = process.stdout,
    stderr = process.stderr,
    signalSource = process,
    childStopGraceMs = 2000,
    childKillWaitMs = 5000,
    ...ensureOptions
  } = options;

  const controller = new AbortController();
  let phase = 'starting';
  let startupSignal = null;
  let startedChild = null;
  let settled = false;
  let resolveOutcome = null;
  const outcomePromise = new Promise((resolvePromise) => {
    resolveOutcome = resolvePromise;
  });
  const finish = (outcome) => {
    if (settled) return;
    settled = true;
    resolveOutcome(outcome);
  };

  const onSignal = (signal) => {
    if (phase === 'starting') {
      if (startupSignal === null) startupSignal = signal;
      controller.abort(signal);
      return;
    }
    if (phase === 'ready') {
      phase = 'stopping';
      stopRuntimeChildGracefully(startedChild, {
        graceMs: childStopGraceMs,
        killWaitMs: childKillWaitMs,
      })
        .then((stop) => finish({ kind: 'signal', signal, stop }))
        .catch((error) => finish({
          kind: 'signal',
          signal,
          stop: {
            stopped: false,
            escalated: false,
            signal: null,
            reason: 'stop_failed',
            error: String(error?.message ?? error),
          },
        }));
    }
  };
  const onSigterm = () => onSignal('SIGTERM');
  const onSigint = () => onSignal('SIGINT');
  const removeSignalHandlers = () => {
    signalSource?.removeListener?.('SIGTERM', onSigterm);
    signalSource?.removeListener?.('SIGINT', onSigint);
    signalSource?.off?.('SIGTERM', onSigterm);
    signalSource?.off?.('SIGINT', onSigint);
  };
  signalSource?.on?.('SIGTERM', onSigterm);
  signalSource?.on?.('SIGINT', onSigint);

  const handleStartupSignal = async (result) => {
    let stop = result?.cleanup ?? null;
    if (startedChild !== null && isRuntimeChildAlive(startedChild)) {
      // ensure 已尽力清理但 child 仍存活（极窄竞态）：supervise 兜底，仍只作用于自己的 child。
      stop = await stopRuntimeChildGracefully(startedChild, {
        graceMs: childStopGraceMs,
        killWaitMs: childKillWaitMs,
      });
    }
    const stopped = stop === null ? true : stop.stopped === true;
    writeRuntimeLine(stdout, {
      ok: stopped,
      mode: 'error',
      reason: 'signal_during_start',
      signal: startupSignal,
      stopped,
      ...(stop !== null ? { stop } : {}),
    });
    return stopped ? 0 : 1;
  };

  try {
    let result;
    try {
      result = await ensureRuntime({
        ...ensureOptions,
        childStopGraceMs,
        childKillWaitMs,
        detached: false,
        childStdio: ['ignore', 2, 2],
        abortSignal: controller.signal,
        onChildStarted: (child) => {
          startedChild = child;
        },
      });
    } catch (error) {
      let stop = null;
      if (startedChild !== null && isRuntimeChildAlive(startedChild)) {
        stop = await stopRuntimeChildGracefully(startedChild, {
          graceMs: childStopGraceMs,
          killWaitMs: childKillWaitMs,
        });
      }
      writeRuntimeLine(stderr, {
        ok: false,
        mode: 'error',
        reason: 'supervise_failed',
        message: String(error?.message ?? error),
        ...(stop !== null ? { stop } : {}),
      });
      return 2;
    }

    if (startupSignal !== null) return await handleStartupSignal(result);

    if (result.mode !== 'child' || !result.child) {
      writeRuntimeLine(stdout, toPublicRuntimeResult(result));
      return result.ok ? 0 : 2;
    }

    const child = result.child;
    startedChild = child;
    if (!isRuntimeChildAlive(child)) {
      writeRuntimeLine(stderr, {
        ok: false,
        mode: 'child',
        reason: 'child_exited',
        exitCode: typeof child.exitCode === 'number' ? child.exitCode : null,
        signal: typeof child.signalCode === 'string' ? child.signalCode : null,
      });
      return typeof child.exitCode === 'number' ? child.exitCode : 1;
    }

    phase = 'ready';
    if (startupSignal !== null) {
      // ensure 返回与 phase 切换之间的极窄竞态：仍按 startup 信号处理。
      phase = 'stopping';
      return await handleStartupSignal(result);
    }
    child.once?.('exit', (code, signal) => {
      if (phase !== 'ready') return;
      phase = 'exited';
      finish({
        kind: 'child_exit',
        exitCode: typeof code === 'number' ? code : 1,
        signal: typeof signal === 'string' ? signal : null,
      });
    });
    writeRuntimeLine(stdout, toPublicRuntimeResult(result));
    if (childExited(child) && phase === 'ready') {
      phase = 'exited';
      finish({
        kind: 'child_exit',
        exitCode: typeof child.exitCode === 'number' ? child.exitCode : 1,
        signal: typeof child.signalCode === 'string' ? child.signalCode : null,
      });
    }

    const outcome = await outcomePromise;
    if (outcome.kind === 'signal') {
      writeRuntimeLine(stderr, {
        ok: outcome.stop?.stopped === true,
        mode: 'child',
        reason: outcome.stop?.stopped === true ? 'stopped' : 'stop_failed',
        signal: outcome.signal,
        stop: outcome.stop,
      });
      return outcome.stop?.stopped === true ? 0 : 1;
    }

    writeRuntimeLine(stderr, {
      ok: false,
      mode: 'child',
      reason: 'child_exited',
      exitCode: outcome.exitCode,
      signal: outcome.signal,
    });
    return outcome.exitCode;
  } finally {
    removeSignalHandlers();
  }
}

function daemonFromHealth(health, http) {
  return {
    status: health?.ok === true ? 'up' : 'down',
    url: http.url,
    httpStatus: health?.status ?? null,
    reason: health?.ok === true ? null : (health?.reason ?? 'unreachable'),
    instance: health?.instance ?? health?.body?.instance ?? null,
    cloudId: health?.body?.cloudId ?? null,
    version: health?.body?.version ?? null,
    error: health?.error ?? null,
  };
}

function publicService(service) {
  if (!service) return null;
  return {
    ok: service.ok === true,
    registered: service.registered === true,
    running: service.running === true,
    label: service.label ?? null,
    autostart: service.autostart ?? null,
    foreign: service.foreign === true,
    unitPath: service.unitPath ?? null,
    version: service.version ?? null,
    runtimePath: service.runtimePath ?? null,
    provider: service.provider ?? null,
    owner: service.owner ?? null,
    runtime: service.runtime ?? null,
    ...(service.error ? { error: service.error } : {}),
  };
}

function baseResult(context, { http = null, checkedAt }) {
  return {
    ok: true,
    mode: null,
    reason: null,
    message: null,
    cloudRoot: context?.cloudRoot ?? null,
    cloudRootDisplay: context?.cloudRootDisplay ?? null,
    profileId: context?.profileId ?? null,
    profile: context?.profile ?? null,
    home: context?.home ?? null,
    homeKey: context?.homeKey ?? null,
    http,
    instance: null,
    version: null,
    runtimePath: context?.runtimePath ?? null,
    current: null,
    currentUsable: false,
    currentSource: 'missing',
    versionMismatch: false,
    runtimeFile: context?.runtime === null || context?.runtime === undefined
      ? null
      : {
        path: context.runtimePath ?? null,
        version: context.runtime.version ?? null,
        http: context.runtime.http ?? null,
      },
    provider: null,
    providers: null,
    service: null,
    activeLock: null,
    daemon: http === null ? null : daemonFromHealth({ ok: false, reason: 'unreachable' }, http),
    bootstrap: { state: 'error', allowDownload: false },
    download: null,
    warnings: Array.isArray(context?.warning) ? [...context.warning] : (context?.warning ? [context.warning] : []),
    checkedAt,
  };
}

function withPort(http, port) {
  const next = Number(port);
  if (!Number.isInteger(next) || next <= 0 || next > 65535) {
    throw cloudError('INVALID_PORT', `端口非法：${port}`);
  }
  return { ...http, port: next, url: `${http.scheme}://${http.host}:${next}/healthz` };
}

function errorResult(context, error, checkedAt, http = null) {
  const result = baseResult(context, { http, checkedAt });
  result.ok = false;
  result.mode = 'error';
  result.reason = error?.code ?? 'runtime_error';
  result.message = error?.message ?? String(error);
  result.bootstrap = { state: 'error', allowDownload: false };
  return result;
}

function abortError(signal) {
  const error = cloudError('RUNTIME_ABORTED', 'runtime ensure 在启动期间被终止');
  error.abortSignal = signal ?? null;
  return error;
}

/** 用 AbortSignal 中断 ensure 的等待；用于 supervise 在 startup 期间收到 SIGTERM/SIGINT。 */
function awaitWithAbort(promise, signal) {
  if (!signal || typeof signal.addEventListener !== 'function') return promise;
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError(signal.reason));
    };
    const cleanup = () => signal.removeEventListener?.('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolvePromise(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function abortedRuntimeResult(inspected, signal, cleanup = null) {
  const base = inspected ?? errorResult(
    null,
    cloudError('RUNTIME_ABORTED', 'runtime ensure 在启动期间被终止'),
    new Date().toISOString(),
  );
  return {
    ...base,
    ok: false,
    mode: 'error',
    reason: 'aborted',
    message: 'runtime ensure 在启动期间被终止',
    bootstrap: { state: 'error', allowDownload: false },
    aborted: true,
    abortSignal: signal ?? null,
    ...(cleanup !== null ? { cleanup } : {}),
  };
}

function providerPublic(provider) {
  if (!provider) return null;
  return {
    id: provider.id ?? null,
    kind: provider.kind,
    path: provider.path,
    version: provider.version ?? null,
    runtimePath: provider.runtimePath ?? null,
    capabilities: Array.isArray(provider.capabilities) ? [...provider.capabilities] : [],
    source: provider.source ?? null,
  };
}

function providersPublic(discovery) {
  if (!discovery) return null;
  return {
    root: discovery.root ?? null,
    entries: discovery.entries.map((entry) => ({
      ...providerPublic(entry),
      available: entry.available === true,
    })),
    available: discovery.available.map((entry) => providerPublic(entry)),
    selected: providerPublic(discovery.selected),
    current: discovery.current ?? null,
    currentUsable: discovery.currentUsable === true,
    currentSource: discovery.currentSource ?? 'missing',
    warnings: [...discovery.warnings],
  };
}

function bootstrapForMode(mode, { requested = false } = {}) {
  if (mode === 'reused') return { state: 'ready', allowDownload: false };
  if (mode === 'download_required') return { state: 'download_required', allowDownload: false, downloadRequested: requested };
  if (mode === 'conflict') return { state: 'conflict', allowDownload: false };
  if (mode === 'service' || mode === 'child') return { state: 'down', allowDownload: false };
  return { state: 'error', allowDownload: false };
}

function downloadInfo(requested) {
  return {
    required: true,
    allowed: false,
    requested: requested === true,
    reason: 'no_provider',
    // Phase 4 才实现；Phase 1 只给出手动安装引导，不下载、不启动安装器。
    next: ['open_mebular_app', 'install_cli'],
  };
}

/**
 * 只读检查：解析上下文 + 探测健康 + 读取 service/provider，给出下一动作（不 spawn/不重启）。
 */
async function inspectRuntime(options = {}) {
  const {
    env = process.env,
    userHome = homedir(),
    home: explicitHome,
    port: explicitPort,
    mode: requestedMode = 'auto',
    allowDownload = false,
    fetchImpl = fetch,
    probeHealthFn = null,
    probePortFn = isPortOpen,
    registryProviders = null,
    includeSelf = true,
    includeStandardApp = true,
    selfPath = defaultSelfCliPath(),
    service: injectedService = null,
    serviceHome,
    cliBin = selfPath,
    now = () => new Date().toISOString(),
  } = options;
  const checkedAt = now();

  if (!['auto', 'child', 'service'].includes(requestedMode)) {
    return errorResult(null, cloudError('INVALID_START_MODE', `未知启动模式：${requestedMode}`), checkedAt);
  }

  let context;
  try {
    context = await resolveRuntimeContext({ home: explicitHome, env, userHome });
  } catch (error) {
    return errorResult(null, error, checkedAt);
  }
  if (!context.ok) {
    const result = baseResult(context, { http: null, checkedAt });
    result.ok = false;
    result.mode = 'error';
    result.reason = context.reason ?? 'cloud_unavailable';
    result.message = `runtime 上下文不可用：${context.reason ?? 'cloud_unavailable'}`;
    result.bootstrap = { state: 'error', allowDownload: false };
    return result;
  }

  let http = context.http;
  if (explicitPort !== undefined && explicitPort !== null) {
    try {
      http = withPort(http, explicitPort);
    } catch (error) {
      return errorResult(context, error, checkedAt, context.http);
    }
  }

  const probeHealth = probeHealthFn
    ?? ((target, probeOptions) => probeRuntimeHealth(fetchImpl, target, probeOptions));
  let health;
  try {
    health = await probeHealth(http, { expectedInstance: context.homeKey, cloudId: context.profileId });
  } catch (error) {
    health = { ok: false, reason: 'probe_failed', error: String(error?.message ?? error), http };
  }

  const activeLock = readActiveRuntimeLock(context.cloudRoot);
  const currentState = await readRuntimeCurrent(context.cloudRoot, { userHome });
  const service = injectedService
    ?? createRuntimeServiceAdapter({
      root: context.cloudRoot,
      home: context.home,
      cliBin,
      serviceHome,
      env,
      currentState,
    });
  let serviceStatus;
  try {
    serviceStatus = await service.status();
  } catch (error) {
    serviceStatus = {
      ok: false,
      registered: false,
      running: false,
      label: null,
      autostart: null,
      foreign: false,
      unitPath: null,
      error: error?.message ?? String(error),
    };
  }
  if (!serviceStatus || typeof serviceStatus !== 'object') {
    serviceStatus = {
      ok: false,
      registered: false,
      running: false,
      label: null,
      autostart: null,
      foreign: false,
      unitPath: null,
      error: 'service status returned no object',
    };
  }

  const discovery = await discoverRuntimeProviders({
    root: context.cloudRoot,
    env,
    userHome,
    includeSelf,
    includeStandardApp,
    registryProviders,
    currentState,
    selfPath,
  });

  const result = baseResult(context, { http, checkedAt });
  result.daemon = daemonFromHealth(health, http);
  result.instance = health?.instance ?? health?.body?.instance ?? null;
  result.version = health?.body?.version ?? context.runtime?.version ?? null;
  result.current = publicRuntimeCurrent(currentState.current);
  result.currentUsable = currentState.usable === true;
  result.currentSource = currentState.source;
  result.service = publicService(serviceStatus);
  result.providers = providersPublic(discovery);
  const activeConflict = activeLockConflict(activeLock, context.home);
  result.activeLock = activeLock === null
    ? null
    : {
      pid: activeLock.pid ?? null,
      home: activeLock.home ?? null,
      profileId: activeLock.profileId ?? null,
      startedAt: activeLock.startedAt ?? null,
      conflict: activeConflict !== null,
    };
  result.versionMismatch = health?.ok === true
    && currentState.usable === true
    && typeof result.version === 'string'
    && result.version !== currentState.current.version;
  if (result.versionMismatch) {
    result.warnings.push(
      `运行中的 daemon 版本 ${result.version} 与 current ${currentState.current.version} 不一致：已 attach；升级需显式执行 runtime upgrade`,
    );
  }

  if (health?.ok === true) {
    result.mode = 'reused';
    result.bootstrap = bootstrapForMode('reused');
    result.warnings.push(...discovery.warnings);
    return result;
  }

  const healthReason = health?.reason ?? 'unreachable';
  if (HEALTH_TERMINAL_REASONS.has(healthReason)) {
    result.mode = 'conflict';
    result.reason = healthReason;
    result.message = healthReason === 'instance_mismatch'
      ? `端口 ${http.port} 上是另一张忆云（instance=${health.instance ?? '未知'}）`
      : healthReason === 'instance_missing'
        ? `端口 ${http.port} 上的守护没有 /healthz instance 身份，无法确认当前忆云`
        : `/healthz cloudId=${health.cloudId ?? '未知'} 与当前忆云不一致`;
    result.bootstrap = bootstrapForMode('conflict');
    result.warnings.push(...discovery.warnings);
    return result;
  }

  if (activeConflict !== null) {
    result.mode = 'conflict';
    result.reason = 'CLOUD_ALREADY_ACTIVE';
    result.message = `已有忆云守护在运行（pid ${activeConflict.pid}，home=${activeConflict.home ?? '未知'}）：请先停止它`;
    result.bootstrap = bootstrapForMode('conflict');
    result.warnings.push(...discovery.warnings);
    return result;
  }

  // service 状态未知时 fail-closed：不能因为探测失败就 fallback child，否则可能再起一个 daemon。
  if (serviceStatus.ok !== true) {
    result.mode = 'conflict';
    result.reason = 'service_unknown';
    result.message = `无法确认 mebular-serve 状态${serviceStatus.error ? `（${serviceStatus.error}）` : ''}：请检查/重试 service，不会启动第二个 daemon`;
    result.bootstrap = bootstrapForMode('conflict');
    result.warnings.push(...discovery.warnings);
    return result;
  }

  // 同 label 作业属于其他 home：绝不 restart/覆盖他人作业。
  if (serviceStatus.foreign === true) {
    result.mode = 'conflict';
    result.reason = 'service_foreign';
    result.message = 'mebular-serve label 被其他 home 的作业占用：不会重启/覆盖他人作业';
    result.bootstrap = bootstrapForMode('conflict');
    result.warnings.push(...discovery.warnings);
    return result;
  }

  if (serviceStatus.registered === true) {
    // 不变量：service 已注册即代表当前 home 的常驻所有权。任何入口/--start 都不能用 child 覆盖它，
    // 否则会再起一个 daemon，抢端口/存储锁。
    result.mode = 'service';
    result.bootstrap = bootstrapForMode('service');
    result.warnings.push(...discovery.warnings);
    return result;
  }

  if (requestedMode === 'service') {
    result.mode = 'error';
    result.reason = 'service_not_registered';
    result.message = '要求使用常驻服务，但当前 home 未注册 mebular-serve；Phase 1 不自动安装服务';
    result.bootstrap = { state: 'error', allowDownload: false };
    result.warnings.push(...discovery.warnings);
    return result;
  }

  let portOpen = false;
  try {
    portOpen = typeof probePortFn === 'function' ? await probePortFn(http) : false;
  } catch {
    portOpen = false;
  }
  if (portOpen) {
    result.mode = 'conflict';
    result.reason = 'port_in_use';
    result.message = `端口 ${http.port} 已被占用但不是健康的 Mebular 守护：请关闭占用程序或换端口`;
    result.bootstrap = bootstrapForMode('conflict');
    result.warnings.push(...discovery.warnings);
    return result;
  }

  const provider = discovery.selected;
  if (provider !== null) {
    result.mode = 'child';
    result.provider = providerPublic(provider);
    result.bootstrap = bootstrapForMode('child');
  } else {
    result.mode = 'download_required';
    result.reason = 'download_required';
    result.message = '没有可用的 Mebular runtime provider：请打开 Mebular App 或安装 CLI；Phase 1 不会自动下载';
    result.bootstrap = bootstrapForMode('download_required', { requested: allowDownload === true });
    result.download = downloadInfo(allowDownload);
  }
  result.warnings.push(...discovery.warnings);
  return result;
}

function waitOptionsFrom(result, options, overrides = {}) {
  return {
    attempts: options.waitAttempts ?? 40,
    intervalMs: options.waitIntervalMs ?? 500,
    expectedInstance: result.homeKey,
    cloudId: result.profileId,
    ...overrides,
  };
}

function waitForHealth(options, http, waitOptions) {
  if (typeof options.waitForHealthFn === 'function') {
    return options.waitForHealthFn(http, waitOptions);
  }
  return waitForRuntime({ fetchImpl: options.fetchImpl ?? fetch, http, ...waitOptions });
}

function probeHealth(options, http, probeOptions) {
  if (typeof options.probeHealthFn === 'function') {
    return options.probeHealthFn(http, probeOptions);
  }
  return probeRuntimeHealth(options.fetchImpl ?? fetch, http, probeOptions);
}

/**
 * 只读解析（不启动）：按当前状态给出 `reused|service|child|download_required|conflict|error`。
 */
export async function resolveRuntime(options = {}) {
  const inspected = await inspectRuntime(options);
  if (!inspected.ok) return inspected;
  return { ...inspected, ok: inspected.mode !== 'error' };
}

/**
 * 确保 runtime 可用：
 *   健康 daemon → attach；已注册 service → 重启/复用；provider → 启动 child；
 *   否则 → download_required（Phase 1 绝不下载）。
 *
 * 只停止本次自己拉起的 child；service/外部 daemon 不主动杀。
 */
export async function ensureRuntime(options = {}) {
  const { abortSignal = null, onChildStarted = null } = options;
  let inspected;
  try {
    inspected = await awaitWithAbort(inspectRuntime(options), abortSignal);
  } catch (error) {
    if (error?.code === 'RUNTIME_ABORTED') {
      return abortedRuntimeResult(null, error.abortSignal ?? abortSignal?.reason);
    }
    throw error;
  }
  if (abortSignal?.aborted) return abortedRuntimeResult(inspected, abortSignal.reason);
  if (!inspected.ok || inspected.mode === 'reused') {
    return { ...inspected, ok: inspected.ok === true && inspected.mode === 'reused' };
  }
  if (inspected.mode === 'download_required' || inspected.mode === 'conflict' || inspected.mode === 'error') {
    return { ...inspected, ok: false };
  }

  const {
    env = process.env,
    execPath = process.execPath,
    spawnFn = spawn,
    detached = false,
    childStdio = 'ignore',
    childStopGraceMs = 2000,
    childKillWaitMs = 5000,
    startLockWaitMs = 20_000,
    startLockIntervalMs = 250,
    service: injectedService = null,
    cliBin = defaultSelfCliPath(),
    serviceHome,
  } = options;

  const service = inspected.mode === 'service'
    ? (injectedService ?? createRuntimeServiceAdapter({
      root: inspected.cloudRoot,
      home: inspected.home,
      cliBin,
      serviceHome,
      env,
    }))
    : null;

  const lock = await tryAcquireRuntimeStartLock({
    root: inspected.cloudRoot,
    home: inspected.home,
    startedAt: inspected.checkedAt,
  });

  if (!lock.acquired) {
    // 另一个入口正在启动：等它健康后 attach，而不是再起一个 daemon。
    const attempts = Math.max(1, Math.ceil(startLockWaitMs / Math.max(1, startLockIntervalMs)));
    let waited;
    try {
      waited = await awaitWithAbort(waitForHealth(options, inspected.http, waitOptionsFrom(inspected, options, {
        attempts,
        intervalMs: startLockIntervalMs,
        onTick: undefined,
      })), abortSignal);
    } catch (error) {
      if (error?.code === 'RUNTIME_ABORTED') {
        return abortedRuntimeResult(inspected, error.abortSignal ?? abortSignal?.reason);
      }
      throw error;
    }
    if (waited.ok) {
      return {
        ...inspected,
        ok: true,
        mode: 'reused',
        instance: waited.instance ?? inspected.homeKey,
        version: waited.body?.version ?? inspected.version,
        daemon: daemonFromHealth(waited, inspected.http),
        bootstrap: bootstrapForMode('reused'),
        warnings: [...inspected.warnings, '另一个入口已启动 runtime，已 attach'],
      };
    }
    return {
      ...inspected,
      ok: false,
      mode: 'conflict',
      reason: 'start_locked',
      message: `另一个入口正在启动 runtime（pid ${lock.holder?.pid ?? '未知'}）；等待健康超时`,
      bootstrap: bootstrapForMode('conflict'),
    };
  }

  try {
    // 双重检查：拿到启动锁后可能已被另一个入口启动。
    let current;
    try {
      current = await awaitWithAbort(probeHealth(options, inspected.http, {
        expectedInstance: inspected.homeKey,
        cloudId: inspected.profileId,
      }), abortSignal);
    } catch (error) {
      if (error?.code === 'RUNTIME_ABORTED') {
        return abortedRuntimeResult(inspected, error.abortSignal ?? abortSignal?.reason);
      }
      throw error;
    }
    if (current.ok) {
      return {
        ...inspected,
        ok: true,
        mode: 'reused',
        instance: current.instance ?? inspected.homeKey,
        version: current.body?.version ?? inspected.version,
        daemon: daemonFromHealth(current, inspected.http),
        bootstrap: bootstrapForMode('reused'),
      };
    }

    if (inspected.mode === 'service') {
      if (abortSignal?.aborted) return abortedRuntimeResult(inspected, abortSignal.reason);
      try {
        await service.restart();
      } catch (error) {
        return {
          ...inspected,
          ok: false,
          mode: 'error',
          reason: error?.code ?? 'service_start_failed',
          message: error?.message ?? String(error),
          bootstrap: { state: 'error', allowDownload: false },
        };
      }
      let waited;
      try {
        waited = await awaitWithAbort(
          waitForHealth(options, inspected.http, waitOptionsFrom(inspected, options)),
          abortSignal,
        );
      } catch (error) {
        if (error?.code === 'RUNTIME_ABORTED') {
          return abortedRuntimeResult(inspected, error.abortSignal ?? abortSignal?.reason);
        }
        throw error;
      }
      if (!waited.ok) {
        return {
          ...inspected,
          ok: false,
          mode: 'error',
          reason: 'service_start_failed',
          message: `常驻服务已重启但健康校验失败（${waited.reason ?? 'timeout'}）`,
          daemon: daemonFromHealth(waited, inspected.http),
          bootstrap: { state: 'error', allowDownload: false },
        };
      }
      return {
        ...inspected,
        ok: true,
        mode: 'service',
        instance: waited.instance ?? inspected.homeKey,
        version: waited.body?.version ?? inspected.version,
        daemon: daemonFromHealth(waited, inspected.http),
        service: inspected.service === null ? null : { ...inspected.service, running: true, restarted: true },
        bootstrap: bootstrapForMode('reused'),
      };
    }

    const provider = inspected.providers?.selected ?? null;
    if (provider === null) {
      return {
        ...inspected,
        ok: false,
        mode: 'download_required',
        reason: 'download_required',
        bootstrap: bootstrapForMode('download_required', { requested: options.allowDownload === true }),
        download: downloadInfo(options.allowDownload === true),
      };
    }

    if (abortSignal?.aborted) return abortedRuntimeResult(inspected, abortSignal.reason);

    const command = runtimeCommandForProvider(provider, { execPath });
    const args = [...command.args, '--port', String(inspected.http.port)];
    let child;
    try {
      child = spawnFn(command.execPath, args, {
        env: {
          ...env,
          MEBULAR_HOME: inspected.home,
          MEBULAR_CLOUD_ROOT: inspected.cloudRoot,
          ELECTRON_RUN_AS_NODE: '1',
          MEBULAR_RUNTIME_PROVIDER: provider.kind,
          MEBULAR_RUNTIME_OWNER: provider.kind,
          ...(provider.version ? { MEBULAR_RUNTIME_VERSION: provider.version } : {}),
          ...(provider.path ? { MEBULAR_RUNTIME_PATH: provider.path } : {}),
          ...(provider.runtimePath ? { MEBULAR_RUNTIME_ROOT: provider.runtimePath } : {}),
        },
        stdio: childStdio,
        detached: detached === true,
      });
      if (detached === true && typeof child.unref === 'function') child.unref();
      if (typeof onChildStarted === 'function') onChildStarted(child);
    } catch (error) {
      if (child) {
        await stopRuntimeChildGracefully(child, {
          graceMs: childStopGraceMs,
          killWaitMs: childKillWaitMs,
        });
      }
      return {
        ...inspected,
        ok: false,
        mode: 'error',
        reason: 'spawn_failed',
        message: `启动 runtime provider 失败：${error?.message ?? error}`,
        bootstrap: { state: 'error', allowDownload: false },
      };
    }

    let waited;
    try {
      waited = await awaitWithAbort(
        waitForHealth(options, inspected.http, waitOptionsFrom(inspected, options)),
        abortSignal,
      );
    } catch (error) {
      const cleanup = await stopRuntimeChildGracefully(child, {
        graceMs: childStopGraceMs,
        killWaitMs: childKillWaitMs,
      });
      if (error?.code === 'RUNTIME_ABORTED') {
        return abortedRuntimeResult(inspected, error.abortSignal ?? abortSignal?.reason, cleanup);
      }
      return {
        ...inspected,
        ok: false,
        mode: 'error',
        reason: 'start_failed',
        message: `runtime child 启动等待失败：${error?.message ?? error}`,
        cleanup,
        bootstrap: { state: 'error', allowDownload: false },
      };
    }
    if (!waited.ok) {
      const cleanup = await stopRuntimeChildGracefully(child, {
        graceMs: childStopGraceMs,
        killWaitMs: childKillWaitMs,
      });
      const conflict = HEALTH_TERMINAL_REASONS.has(waited.reason);
      return {
        ...inspected,
        ok: false,
        mode: conflict ? 'conflict' : 'error',
        reason: conflict ? waited.reason : 'start_failed',
        message: conflict
          ? `启动后端口上的 instance 不匹配（${waited.reason}）`
          : `runtime child 启动后健康校验失败（${waited.reason ?? 'timeout'}）`,
        daemon: daemonFromHealth(waited, inspected.http),
        cleanup,
        bootstrap: conflict
          ? bootstrapForMode('conflict')
          : { state: 'error', allowDownload: false },
      };
    }

    return {
      ...inspected,
      ok: true,
      mode: 'child',
      child,
      instance: waited.instance ?? inspected.homeKey,
      version: waited.body?.version ?? inspected.version,
      daemon: daemonFromHealth(waited, inspected.http),
      bootstrap: bootstrapForMode('reused'),
    };
  } finally {
    await lock.release?.();
  }
}

/**
 * 只读状态：始终返回解析结果（daemon down 也是 status 成功），不启动/不重启。
 */
export async function runtimeStatus(options = {}) {
  const inspected = await inspectRuntime(options);
  if (!inspected.ok) return inspected;
  const up = inspected.daemon?.status === 'up';
  return {
    ...inspected,
    ok: true,
    mode: up ? 'reused' : 'down',
    reason: up ? null : (inspected.daemon?.reason ?? inspected.reason ?? 'unreachable'),
    bootstrap: up ? bootstrapForMode('reused') : inspected.bootstrap,
  };
}

/** 去掉不可序列化的 child 句柄（CLI 输出稳定 JSON 用）。 */
export function toPublicRuntimeResult(result) {
  if (!result || typeof result !== 'object') return result;
  const { child: _child, ...rest } = result;
  return rest;
}
