// Mebular 桌面 App · 主进程逻辑（**不 import electron**，可被 node/jest 直接加载与单测）
//
// 职责：解析 App 运行所需路径、守护托管两路径（服务优先 / 子进程兜底）、健康探测与复用判定、
// 退出策略。Electron 相关（BrowserWindow/Tray/ipcMain）在 index.mjs，薄壳委托到这里。
//
// 复用既有纪律：MEBULAR_HOME 显式传入（禁止 cwd）；服务托管复用 @mebular/service；零新增 daemon 配置。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const APP_VERSION = '0.1.2';
export const SERVICE_KIND = 'mebular-serve';
/** App 注册到 <cloudRoot>/runtime-providers.json 的能力（只写发现信息，不写 token/身份）。 */
export const APP_RUNTIME_PROVIDER_CAPABILITIES = Object.freeze(['serve']);

/** 仓库根（apps/desktop/src/main → 上溯 4 层）；打包态由 resources 决定。 */
export function repoRootFromModule() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

/**
 * 内置 CLI（`mebular serve` 入口）。
 *   打包态（R1）：<resources>/node_modules/@mebular/core/packages/mcp/bin/mebular.mjs
 *                （runtime 由发布 tarball 安装，extraResources 原样复制 node_modules）；
 *   旧 M1 布局：<resources>/packages/mcp/bin（保留兼容）；
 *   开发态：仓库 packages/mcp/bin/mebular.mjs。
 * app.asar 内没有 packages，所以不能只依赖 module 相对路径。
 */
export function resolveCliBin(root = repoRootFromModule(), { resourcesPath = process.resourcesPath } = {}) {
  const candidates = [];
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    candidates.push(join(resourcesPath, 'node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs'));
    candidates.push(join(resourcesPath, 'packages', 'mcp', 'bin', 'mebular.mjs'));
  }
  candidates.push(join(root, 'packages', 'mcp', 'bin', 'mebular.mjs'));
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function resolveHome(env = process.env) {
  return env.MEBULAR_HOME ?? join(homedir(), '.mebular');
}

export function resolveHttp(config = {}, env = process.env) {
  const host = env.MEBULAR_HTTP_HOST ?? config?.mcp?.http?.host ?? '127.0.0.1';
  const port = Number(env.MEBULAR_HTTP_PORT ?? config?.mcp?.http?.port ?? 7331);
  return { host, port };
}

export function healthUrl({ host = '127.0.0.1', port = 7331 } = {}) {
  return `http://${host}:${port}/healthz`;
}

export function consoleUrl({ host = '127.0.0.1', port = 7331 } = {}) {
  return `http://${host}:${port}/console`;
}

/** 解析：`--home=/x` / `--home /x` / `--port 7331`（最小集，供 dev/smoke 复用）。 */
export function parseArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i]);
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || String(next).startsWith('--')) out[body] = true;
    else { out[body] = String(next); i++; }
  }
  return out;
}

/** 实例身份：home 的 sha256 前 12 hex（必须与 @mebular/service / profiles.mjs 同定义）。 */
export function homeKey(home) {
  const normalized = resolve(home).replace(/[/\\]+$/, '') || resolve(home);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/**
 * /healthz 探测详情（注入 fetch，便于单测）。
 *
 * E2-B：端口 200 不再等于「就是我要的忆云」——必须核对 A1 的 `instance`（homeKey）。
 *   - 200 但 instance 不匹配/缺失 → 返回原因，调用方不得 reused / 不得继续切换；
 *   - 旧测试的 `{ok:true}` 无 json 方法：视为无身份信息（仅无 expectedInstance 时可用）。
 */
export async function probeHealthDetail(fetchImpl, http = { host: '127.0.0.1', port: 7331 }, options = {}) {
  const { timeoutMs = 1200, expectedInstance = null, cloudId = null } = typeof options === 'number'
    ? { timeoutMs: options }
    : (options ?? {});
  let res;
  try {
    res = await fetchImpl(healthUrl(http), { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, reason: 'unreachable', http, error: String(error?.message ?? error) };
  }
  if (!res?.ok) return { ok: false, reason: 'status', status: res?.status ?? null, http };
  let body = null;
  try {
    body = typeof res.json === 'function' ? await res.json() : null;
  } catch {
    body = null;
  }
  const instance = typeof body?.instance === 'string' ? body.instance : null;
  if (typeof expectedInstance === 'string' && expectedInstance.length > 0) {
    if (instance === null) return { ok: false, reason: 'instance_missing', body, http };
    if (instance !== expectedInstance) return { ok: false, reason: 'instance_mismatch', instance, body, http };
  }
  if (typeof cloudId === 'string' && cloudId.length > 0
    && typeof body?.cloudId === 'string' && body.cloudId !== cloudId) {
    return { ok: false, reason: 'cloud_mismatch', cloudId: body.cloudId, body, http };
  }
  return { ok: true, body, instance, http };
}

/**
 * /healthz 探测布尔壳（保留旧签名；需要原因时用 probeHealthDetail）。
 * 第三参数兼容旧 `timeoutMs`，或 `{ timeoutMs, expectedInstance, cloudId }`（E2-B 身份校验）。
 */
export async function probeHealth(fetchImpl, http = { host: '127.0.0.1', port: 7331 }, options = 1200) {
  return (await probeHealthDetail(fetchImpl, http, options)).ok;
}

/** root 级单活锁（A1）：`<root>/active.lock`。损坏/不存在 → null。 */
export function readActiveLock(root) {
  if (typeof root !== 'string' || root.length === 0) return null;
  try {
    return JSON.parse(readFileSync(join(root, 'active.lock'), 'utf-8'));
  } catch {
    return null;
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * S3：只读安全等级探测（GET /admin/api/security）。
 * 401/409/旧版守护/网络错误 → null（托盘显示 —，不显示假档位，也不阻断壳）。
 */
export async function probeSecurityLevel(fetchImpl, http = { host: '127.0.0.1', port: 7331 }, timeoutMs = 1500) {
  try {
    const res = await fetchImpl(`http://${http.host}:${http.port}/admin/api/security`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res?.ok) return null;
    const data = await res.json().catch(() => null);
    return ['low', 'medium', 'high'].includes(data?.level) ? data.level : null;
  } catch {
    return null;
  }
}

/**
 * 运行期展示名探测（托盘/窗口标题）：GET /admin/api/overview。
 * 忆云名以网络派生为准（另一台设备改名同步后，本机 registry 可能仍是旧名）。
 * 失败返回 null（调用方保留上一值，不冒充新值）。
 */
export async function probeRuntimeIdentity(fetchImpl, http = { host: '127.0.0.1', port: 7331 }, timeoutMs = 1500) {
  try {
    const res = await fetchImpl(`http://${http.host}:${http.port}/admin/api/overview`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res?.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    return {
      cloudName: typeof data.cloud?.name === 'string' && data.cloud.name.trim().length > 0
        ? data.cloud.name
        : null,
      deviceName: typeof data.device?.name === 'string' && data.device.name.trim().length > 0
        ? data.device.name
        : null,
    };
  } catch {
    return null;
  }
}

/**
 * 引导/待重启探测（W-1 高-1 钩子）：GET /app/provision/status
 *   200 且 provision===true → 引导态（provisioned:false＝待建新/加入；true＝已初始化待重启）
 *   404 → 正常态（接口不挂载）；其他/异常 → 不阻断（守护健康探测另有 probeHealth）
 */
export async function probeProvision(fetchImpl, http = { host: '127.0.0.1', port: 7331 }, timeoutMs = 1200) {
  try {
    const res = await fetchImpl(`http://${http.host}:${http.port}/app/provision/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res?.ok) return { required: false, provisioned: null };
    const data = await res.json().catch(() => null);
    if (data?.provision === true) return { required: true, provisioned: Boolean(data.provisioned) };
    return { required: false, provisioned: null };
  } catch {
    return { required: false, provisioned: null };
  }
}

/** 服务托管是否已登记（复用 @mebular/service 的注册判定）。 */
export function serviceEnabledFor(service, home, serviceHome = homedir()) {
  try {
    return service.registeredServicesForDir(home, { home: serviceHome }).includes(SERVICE_KIND);
  } catch {
    return false;
  }
}

/**
 * 服务描述符：实例身份 = MEBULAR_HOME（home），root 由 MEBULAR_CLOUD_ROOT 显式携带。
 * `ServiceOptions.home` 是「plist/manifest 落在哪个 OS 用户目录」，由调用方另传
 * （App 必须传 OS home，而不是忆云 home——否则单元会写进 profiles/<id> 内）。
 */
export function serviceDescriptorFor({ home, cliBin, execPath, http, cloudRoot = null, runtime = null }) {
  const listenArgs = Number.isInteger(http?.port) && http.port > 0 ? ['--port', String(http.port)] : [];
  const runtimeInfo = runtime ?? {
    version: APP_VERSION,
    runtimePath: null,
    cliPath: cliBin,
    provider: 'app',
    owner: 'app',
    execPath,
    electron: true,
    cloudRoot: typeof cloudRoot === 'string' && cloudRoot.length > 0 ? cloudRoot : null,
    home,
  };
  return {
    kind: SERVICE_KIND,
    args: [cliBin, 'serve', ...listenArgs],
    heartbeatDir: home,
    workingDir: home,
    execPath,
    env: {
      MEBULAR_HOME: home,
      ...(typeof cloudRoot === 'string' && cloudRoot.length > 0 ? { MEBULAR_CLOUD_ROOT: cloudRoot } : {}),
      // 打包态 execPath = Electron 本体；显式以 Node 运行时启动 CLI（否则会再开一个 App）。
      ELECTRON_RUN_AS_NODE: '1',
      MEBULAR_RUNTIME_PROVIDER: runtimeInfo.provider ?? 'app',
      MEBULAR_RUNTIME_OWNER: runtimeInfo.owner ?? 'app',
      ...(runtimeInfo.version ? { MEBULAR_RUNTIME_VERSION: runtimeInfo.version } : {}),
      ...(runtimeInfo.cliPath ? { MEBULAR_RUNTIME_PATH: runtimeInfo.cliPath } : {}),
    },
    runtime: runtimeInfo,
  };
}

/**
 * 从 CLI 入口动态加载同仓库的共享 runtime 模块（开发态/打包 extraResources 同构）。
 * 与 loadServiceModule/loadCloudModules 一样不新增打包依赖；加载失败由调用方决定兜底。
 */
async function importRuntimeSource(cliBin, file) {
  const src = join(dirname(cliBin), '..', 'src');
  return import(pathToFileURL(join(src, file)).href);
}

async function loadRuntimeSupervisor(cliBin) {
  if (typeof cliBin !== 'string' || cliBin.length === 0) {
    return { module: null, error: '缺少 cliBin' };
  }
  try {
    return { module: await importRuntimeSource(cliBin, 'runtime-supervisor.mjs'), error: null };
  } catch (error) {
    return { module: null, error: String(error?.message ?? error) };
  }
}

async function loadRuntimeProviders(cliBin) {
  if (typeof cliBin !== 'string' || cliBin.length === 0) {
    return { module: null, error: '缺少 cliBin' };
  }
  try {
    return { module: await importRuntimeSource(cliBin, 'runtime-providers.mjs'), error: null };
  } catch (error) {
    return { module: null, error: String(error?.message ?? error) };
  }
}

async function loadRuntimeCurrent(cliBin) {
  if (typeof cliBin !== 'string' || cliBin.length === 0) {
    return { module: null, error: '缺少 cliBin' };
  }
  try {
    return { module: await importRuntimeSource(cliBin, 'runtime-current.mjs'), error: null };
  } catch (error) {
    return { module: null, error: String(error?.message ?? error) };
  }
}

/**
 * App service 来源：共享 current 可用 → 指向 current CLI（owner/shared），
 * 否则保留 App 现有 provider（owner/app，指向 App bundle CLI）。**绝不下载**。
 *
 * execPath/ELECTRON_RUN_AS_NODE/port/cloudRoot 仍由 App 描述符决定；只是把 args 的 CLI
 * 从 App bundle 切到共享 runtime，从而满足“service 指向共享 runtime”的所有权边界。
 */
export async function resolveAppServiceRuntime({
  cliBin,
  cloudRoot = null,
  version = APP_VERSION,
  currentModule = null,
} = {}) {
  const fallback = {
    version,
    runtimePath: null,
    cliPath: cliBin,
    provider: 'app',
    owner: 'app',
    execPath: process.execPath,
    electron: true,
    cloudRoot: typeof cloudRoot === 'string' && cloudRoot.length > 0 ? cloudRoot : null,
  };
  if (typeof cloudRoot !== 'string' || cloudRoot.length === 0) {
    return { source: fallback, current: null, currentUsable: false, warning: null };
  }
  const loaded = currentModule !== null
    ? { module: currentModule, error: null }
    : await loadRuntimeCurrent(cliBin);
  if (typeof loaded.module?.readRuntimeCurrent !== 'function') {
    return {
      source: fallback,
      current: null,
      currentUsable: false,
      warning: `共享 runtime current 模块不可用，保留 App provider${loaded.error ? `（${loaded.error}）` : ''}`,
    };
  }
  try {
    const state = await loaded.module.readRuntimeCurrent(cloudRoot);
    if (state.usable === true && state.current) {
      return {
        source: {
          version: state.current.version,
          runtimePath: state.current.runtimePath,
          cliPath: state.current.cliPath,
          provider: 'shared',
          owner: 'shared',
          execPath: process.execPath,
          electron: true,
          cloudRoot,
        },
        current: loaded.module.publicRuntimeCurrent(state.current),
        currentUsable: true,
        warning: null,
      };
    }
    return {
      source: fallback,
      current: loaded.module.publicRuntimeCurrent(state.current),
      currentUsable: false,
      warning: state.warnings?.[0] ?? null,
    };
  } catch (error) {
    return {
      source: fallback,
      current: null,
      currentUsable: false,
      warning: `共享 runtime current 读取失败，保留 App provider（${error?.message ?? error}）`,
    };
  }
}

function runtimeError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/** shared runtime current 是否存在（只读文件存在性，不读秘密/配置）。 */
export function sharedRuntimeCurrentPresent(cloudRoot) {
  if (typeof cloudRoot !== 'string' || cloudRoot.length === 0) return false;
  return existsSync(join(cloudRoot, 'runtime', 'current.json'));
}

/**
 * App service fallback 的 fail-safe：current 存在但 runtime-service 不可用时，
 * 不允许用 App descriptor 覆盖共享 mebular-serve。
 */
export function appServiceFallbackBlock({ cloudRoot = null, runtimeServiceAvailable = false } = {}) {
  if (runtimeServiceAvailable === true) return null;
  if (!sharedRuntimeCurrentPresent(cloudRoot)) return null;
  return {
    ok: false,
    reason: 'RUNTIME_SERVICE_UNAVAILABLE',
    message: '共享 runtime current 存在，但 runtime-service 不可用：拒绝用 App descriptor 覆盖共享 service',
  };
}

/** legacy App service 安装（仅在无 shared current 或 runtime-service 可用时由调用方进入）。 */
export async function installLegacyAppService({
  service = null,
  descriptor,
  cloudRoot = null,
  serviceHome = homedir(),
  autostart = true,
  runtimeServiceAvailable = false,
} = {}) {
  const blocked = appServiceFallbackBlock({ cloudRoot, runtimeServiceAvailable });
  if (blocked !== null) return blocked;
  if (typeof service?.installService !== 'function') {
    return { ok: false, reason: '@mebular/service 不可用' };
  }
  try {
    const result = service.installService(descriptor, { home: serviceHome, autostart });
    return {
      ok: true,
      already: false,
      registered: true,
      unitPath: result?.unitPath ?? null,
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/**
 * App 专属 service adapter：描述符必须保留 App 现有行为（args 带 --port、execPath、ELECTRON_RUN_AS_NODE、
 * MEBULAR_HOME/MEBULAR_CLOUD_ROOT），serviceHome 仍是 OS 用户 home。
 *
 * 契约：
 *   - serviceStatus 抛错 → ok:false（supervisor fail-closed：不 restart、不 fallback child）；
 *   - foreign 原样上报（supervisor 拒绝对他人作业 restart/spawn）；
 *   - 完全没有 @mebular/service（自定义安装/测试替身）→ ok:true、未登记：保留 App 既有 child 兜底；
 *   - restart 失败保留 App 现有中文错误信息（supervisor 映射为 error，App 显示为不可用提示）。
 */
export function createAppServiceAdapter({
  service = {},
  home,
  cliBin,
  execPath = process.execPath,
  http,
  cloudRoot = null,
  serviceHome = homedir(),
  runtimeSource = null,
  current = null,
  currentUsable = false,
} = {}) {
  const effectiveRuntime = runtimeSource === null
    ? null
    : { ...runtimeSource, execPath };
  const descriptor = serviceDescriptorFor({
    home,
    cliBin: effectiveRuntime?.cliPath ?? cliBin,
    execPath,
    http,
    cloudRoot,
    runtime: effectiveRuntime,
  });
  return {
    descriptor,
    runtimeSource: effectiveRuntime,
    current,
    currentUsable,
    async status() {
      if (typeof service?.serviceStatus === 'function') {
        try {
          const status = service.serviceStatus(descriptor, { home: serviceHome });
          return {
            ok: true,
            registered: status?.registered === true,
            running: status?.running === true,
            label: status?.label ?? null,
            autostart: status?.autostart ?? null,
            foreign: status?.foreign === true,
            unitPath: status?.unitPath ?? null,
            version: status?.runtime?.version ?? effectiveRuntime?.version ?? null,
            runtimePath: status?.runtime?.runtimePath ?? effectiveRuntime?.runtimePath ?? null,
            provider: status?.runtime?.provider ?? effectiveRuntime?.provider ?? null,
            owner: status?.runtime?.owner ?? effectiveRuntime?.owner ?? null,
            runtime: status?.runtime ?? effectiveRuntime ?? null,
            current,
            currentUsable,
          };
        } catch (error) {
          return {
            ok: false,
            registered: false,
            running: false,
            label: null,
            autostart: null,
            foreign: false,
            unitPath: null,
            error: String(error?.message ?? error),
          };
        }
      }
      if (typeof service?.registeredServicesForDir === 'function') {
        // 旧注入形状（测试/旧调用方）：只给「是否登记」，状态未知时仍视为可探测。
        try {
          const registered = service.registeredServicesForDir(home, { home: serviceHome }).includes(SERVICE_KIND);
          return {
            ok: true,
            registered,
            running: null,
            label: null,
            autostart: null,
            foreign: false,
            unitPath: null,
          };
        } catch (error) {
          return {
            ok: false,
            registered: false,
            running: false,
            label: null,
            autostart: null,
            foreign: false,
            unitPath: null,
            error: String(error?.message ?? error),
          };
        }
      }
      // 模块不可用：App 旧行为就是「未登记 → child」。这里不伪造已登记，也不假装探测成功。
      return {
        ok: true,
        registered: false,
        running: false,
        label: null,
        autostart: null,
        foreign: false,
        unitPath: null,
        available: false,
      };
    },
    async restart() {
      if (typeof service?.restartService !== 'function') {
        throw runtimeError('RUNTIME_SERVICE_RESTART_FAILED', '常驻服务重启失败：@mebular/service 不可用');
      }
      const result = service.restartService(descriptor, { home: serviceHome });
      if (result && result.ok === false) {
        throw runtimeError(
          'RUNTIME_SERVICE_RESTART_FAILED',
          `常驻服务重启失败：${result.manual ?? result.error ?? result.message ?? '未知原因'}`,
          { result },
        );
      }
      return result ?? { ok: true };
    },
  };
}

/** App 在共享 provider 注册表中的记录（只含 kind/path/version/capabilities）。 */
export function appRuntimeProvider({ cliBin, version = APP_VERSION } = {}) {
  return {
    kind: 'app',
    path: cliBin,
    version,
    capabilities: [...APP_RUNTIME_PROVIDER_CAPABILITIES],
  };
}

/**
 * 启动时注册/更新 `kind:app` provider（供 Plugin/CLI 发现 App runtime）。
 *
 * App 是单入口：调用 runtime-providers 的 `registerExclusiveRuntimeProvider`，在同一把写锁内
 * 原子替换所有 kind:app 记录；路径变化不会留下旧 App runtime，版本变化保留 registeredAt。
 * 只影响 kind:app，CLI/shared 不动。失败只返回结果、不抛出：注册失败不得阻塞 App。
 */
export async function registerAppRuntimeProvider({
  cloudRoot,
  cliBin,
  version = APP_VERSION,
  providers = null,
} = {}) {
  if (typeof cloudRoot !== 'string' || cloudRoot.length === 0) {
    return { ok: false, skipped: true, reason: 'cloud_unavailable' };
  }
  if (typeof cliBin !== 'string' || cliBin.length === 0) {
    return { ok: false, skipped: true, reason: 'cli_unavailable' };
  }
  const loaded = providers !== null
    ? { module: providers, error: null }
    : await loadRuntimeProviders(cliBin);
  if (typeof loaded.module?.registerExclusiveRuntimeProvider !== 'function') {
    return { ok: false, skipped: true, reason: 'providers_unavailable', error: loaded.error ?? null };
  }
  const record = appRuntimeProvider({ cliBin, version });
  try {
    const result = await loaded.module.registerExclusiveRuntimeProvider(cloudRoot, record);
    return {
      ok: true,
      created: result.created === true,
      unchanged: result.unchanged === true,
      replaced: Array.isArray(result.replaced) ? result.replaced : [],
      provider: result.provider,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 确保守护在跑（**默认优先服务**）：
 *   - 正常路径：委托共享 Runtime Supervisor（健康 attach / service / App provider child）；
 *   - 自定义 home（cloudRoot 不可用）：保留 App 原有路径（不改变受限环境行为）。
 *
 * 返回 { mode: 'reused' | 'service' | 'child' | 'conflict', home, child?, reason?, message? }。
 */
export async function ensureDaemon({
  home,
  service,
  spawnFn,
  fetchImpl,
  cliBin,
  execPath = process.execPath,
  http = { host: '127.0.0.1', port: 7331 },
  env = process.env,
  cloudRoot = null,
  serviceHome = homedir(),
  supervisor = null,
  probeHealthFn,
  waitForHealthFn,
  probePortFn,
  waitAttempts,
  waitIntervalMs,
  now,
} = {}) {
  const root = typeof cloudRoot === 'string' && cloudRoot.length > 0 ? cloudRoot : null;
  // 显式注入 supervisor 时（测试/诊断）也走共享路径；生产态只有 cloudRoot 可用才委托，
  // 自定义 home / 受限 env 保持 App 既有行为。
  const delegate = supervisor !== null || root !== null;
  if (!delegate) {
    return { ...(await legacyEnsureDaemon({ home, service, spawnFn, fetchImpl, cliBin, execPath, http, env, cloudRoot, serviceHome })), adapter: 'legacy' };
  }

  const loaded = supervisor !== null ? { module: supervisor, error: null } : await loadRuntimeSupervisor(cliBin);
  if (!loaded.module?.ensureRuntime) {
    const result = await legacyEnsureDaemon({ home, service, spawnFn, fetchImpl, cliBin, execPath, http, env, cloudRoot, serviceHome });
    return {
      ...result,
      adapter: 'legacy',
      warning: `共享 Runtime Supervisor 不可用，已使用 App 原有启动路径${loaded.error ? `（${loaded.error}）` : ''}`,
    };
  }

  const appServiceRuntime = await resolveAppServiceRuntime({ cliBin, cloudRoot: root });
  const adapter = createAppServiceAdapter({
    service,
    home,
    cliBin,
    execPath,
    http,
    cloudRoot: root,
    serviceHome,
    runtimeSource: appServiceRuntime.source,
    current: appServiceRuntime.current,
    currentUsable: appServiceRuntime.currentUsable,
  });
  const runtimeEnv = root === null ? env : { ...env, MEBULAR_CLOUD_ROOT: root };
  const port = Number(http?.port);
  const result = await loaded.module.ensureRuntime({
    home,
    ...(Number.isInteger(port) && port > 0 ? { port } : {}),
    env: runtimeEnv,
    execPath,
    // App 进程内持有 child 句柄：不 detach；supervisor 只返回本次拉起的 child，App 退出只停它。
    detached: false,
    service: adapter,
    serviceHome,
    cliBin,
    fetchImpl,
    spawnFn,
    registryProviders: typeof cliBin === 'string' && cliBin.length > 0 ? [appRuntimeProvider({ cliBin })] : [],
    includeSelf: false,
    includeStandardApp: false,
    ...(typeof probeHealthFn === 'function' ? { probeHealthFn } : {}),
    ...(typeof waitForHealthFn === 'function' ? { waitForHealthFn } : {}),
    ...(typeof probePortFn === 'function' ? { probePortFn } : {}),
    ...(typeof waitAttempts === 'number' ? { waitAttempts } : {}),
    ...(typeof waitIntervalMs === 'number' ? { waitIntervalMs } : {}),
    ...(typeof now === 'function' ? { now } : {}),
  });
  const mapped = mapSupervisorResult(result, { home, http });
  return appServiceRuntime.warning
    ? { ...mapped, warning: appServiceRuntime.warning }
    : mapped;
}

/** supervisor 结果 → App 既有模式；download_required/error 只映射为不可用/冲突提示，绝不下载。 */
function mapSupervisorResult(result, { home, http }) {
  const mode = result?.mode ?? 'error';
  if (mode === 'reused' || mode === 'service') {
    return { mode, home, child: null, adapter: 'supervisor' };
  }
  if (mode === 'child') {
    return { mode: 'child', home, child: result?.child ?? null, adapter: 'supervisor' };
  }
  const reason = result?.reason ?? (mode === 'download_required' ? 'download_required' : 'runtime_error');
  const message = appRuntimeMessage(result, { home, http, reason });
  return {
    mode: 'conflict',
    reason,
    message,
    home,
    child: null,
    adapter: 'supervisor',
    ...(typeof result?.instance === 'string' ? { instance: result.instance } : {}),
  };
}

/** App 可理解的人话：保留原有 instance/端口/常驻提示语义。 */
function appRuntimeMessage(result, { http, reason }) {
  const port = Number.isInteger(http?.port) ? http.port : (result?.http?.port ?? 7331);
  if (reason === 'instance_mismatch') return `端口 ${port} 上是另一张忆云，请先停止它`;
  if (reason === 'instance_missing') return `端口 ${port} 上的守护没有 /healthz instance 身份，无法确认是当前忆云`;
  if (reason === 'port_in_use') {
    return `端口 ${port} 已被占用但不是 Mebular 守护：请关闭占用该端口的程序，或在启动参数里换一个端口（--port <n>）。`;
  }
  if (typeof result?.message === 'string' && result.message.trim().length > 0) return result.message;
  if (result?.mode === 'download_required') {
    return '没有可用的 Mebular runtime provider：请打开 Mebular App 或安装 CLI；本版本不会自动下载。';
  }
  return `Mebular 守护不可用（${reason}）`;
}

/** App 原有 ensureDaemon 实现（自定义 home / supervisor 不可用时的保留路径）。 */
async function legacyEnsureDaemon({
  home,
  service,
  spawnFn,
  fetchImpl,
  cliBin,
  execPath = process.execPath,
  http = { host: '127.0.0.1', port: 7331 },
  env = process.env,
  cloudRoot = null,
  serviceHome = homedir(),
} = {}) {
  const expectedInstance = homeKey(home);
  const health = await probeHealthDetail(fetchImpl, http, { expectedInstance });
  if (health.ok) return { mode: 'reused', home, child: null };
  if (health.reason === 'instance_mismatch' || health.reason === 'instance_missing') {
    const message = health.reason === 'instance_mismatch'
      ? `端口 ${http.port} 上是另一张忆云，请先停止它`
      : `端口 ${http.port} 上的守护没有 /healthz instance 身份，无法确认是当前忆云`;
    return { mode: 'conflict', reason: health.reason, instance: health.instance ?? null, home, child: null, message };
  }
  // root 级单活：另一张忆云的活 PID 占着 root → 拒绝再起（CL-02）。
  const active = readActiveLock(cloudRoot);
  if (active && pidAlive(active.pid) && resolve(String(active.home ?? '')) !== resolve(home)) {
    return {
      mode: 'conflict',
      reason: 'CLOUD_ALREADY_ACTIVE',
      home,
      child: null,
      message: `已有忆云守护在运行（pid ${active.pid}，home=${active.home ?? '未知'}）：请先停止它`,
    };
  }
  const desc = serviceDescriptorFor({ home, cliBin, execPath, http, cloudRoot });
  if (serviceEnabledFor(service, home, serviceHome)) {
    service.restartService(desc, { home: serviceHome });
    return { mode: 'service', home, child: null };
  }
  // Electron 作为 Node 运行时：ELECTRON_RUN_AS_NODE=1（在 Electron 内有效；纯 node 下无害）
  // 端口显式传给子进程（与 App 探测/加载的端口一致；否则子进程用默认端口 → 探测不匹配）
  const listenArgs = Number.isInteger(http?.port) && http.port > 0 ? ['--port', String(http.port)] : [];
  const child = spawnFn(execPath, [cliBin, 'serve', ...listenArgs], {
    env: {
      ...env,
      MEBULAR_HOME: home,
      ...(typeof cloudRoot === 'string' && cloudRoot.length > 0 ? { MEBULAR_CLOUD_ROOT: cloudRoot } : {}),
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { mode: 'child', home, child };
}

/** child 是否仍由本 App 托管且存活（exitCode 为 null 且未发过 kill；被信号杀死也算已退出）。 */
export function isManagedChildAlive(child) {
  if (!child || child.killed === true) return false;
  // Node：进程被信号杀死时 exitCode 仍为 null，signalCode 才有值。
  const exitedBySignal = typeof child.signalCode === 'string' && child.signalCode.length > 0;
  return child.exitCode === null && !exitedBySignal;
}

/**
 * 合并「本次 ensure 结果」与「App 已托管的 child」。
 *
 * 背景：首启时 ensureDaemon 由 App 自己 spawn child；用户随后再点部署，ensureDaemon
 * 看到这个 child 已健康 → 返回 reused。若直接采用 reused，App 会丢掉 child 身份
 * （托盘误报「已有守护」、控制台仍显示临时运行、退出确认不停止自己的子进程）。
 *
 * 规则：
 *   - ensureDaemon 新拉起的 child → child（托管身份以本次结果为准）；
 *   - reused/service 但现有 child 仍存活 → 保留 child（它是 App 拉起的，不能改认外部守护）；
 *   - 现有 child 已退出/已 kill → 接受 reused/service。
 *
 * @param {{ resultMode?: string|null, resultChild?: object|null, existingChild?: object|null }} input
 * @returns {{ mode: string|null, child: object|null }}
 */
export function reconcileManagedState({ resultMode = null, resultChild = null, existingChild = null } = {}) {
  if (resultMode === 'child') return { mode: 'child', child: resultChild ?? existingChild ?? null };
  if (isManagedChildAlive(existingChild)) return { mode: 'child', child: existingChild };
  return { mode: resultMode, child: resultChild ?? null };
}

/**
 * 退出策略（M1）：仅停止**子进程托管**的守护；服务托管不动（App 退出不影响常驻）。
 * 返回 true 表示停了自己托管的子进程。
 */
export function stopManaged(child) {
  if (!child || typeof child.kill !== 'function') return false;
  try {
    child.kill('SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/** 端口是否有进程监听（只做 connect 探测，不发数据）。 */
export function isPortOpen({ host = '127.0.0.1', port } = {}, timeoutMs = 800) {
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

/**
 * 端口冲突的人话处置：/healthz 不通且默认端口被占用时给出可读建议（不新增配置概念）。
 */
export async function diagnosePort({ http, fetchImpl, probePort }) {
  const healthy = await probeHealth(fetchImpl, http);
  if (healthy) return null;
  const busy = typeof probePort === 'function' ? await probePort(http) : false;
  if (!busy) return null;
  return `端口 ${http.port} 已被占用但不是 Mebular 守护：请关闭占用该端口的程序，或在启动参数里换一个端口（--port <n>）。`;
}

/**
 * 等待目标守护就绪（E2-B：带实例身份）。
 * instance 不匹配/缺失 / cloudId 不匹配是**终态**：端口上是别的忆云，重试没有意义。
 */
export async function waitForDaemonDetail({
  fetchImpl,
  http,
  attempts = 60,
  intervalMs = 500,
  onTick,
  expectedInstance = null,
  cloudId = null,
} = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await probeHealthDetail(fetchImpl, http, { expectedInstance, cloudId });
    if (last.ok) return last;
    if (['instance_mismatch', 'instance_missing', 'cloud_mismatch'].includes(last.reason)) return last;
    onTick?.(i);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last ?? { ok: false, reason: 'timeout', http };
}

/** 引导态/正常态都可加载控制台：/healthz 200 且实例匹配即可显示。 */
export async function waitForDaemon({ fetchImpl, http, attempts = 60, intervalMs = 500, onTick, expectedInstance = null, cloudId = null } = {}) {
  return (await waitForDaemonDetail({ fetchImpl, http, attempts, intervalMs, onTick, expectedInstance, cloudId })).ok;
}

export { existsSync };
