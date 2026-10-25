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
import { fileURLToPath } from 'node:url';

export const APP_VERSION = '0.1.2';
export const SERVICE_KIND = 'mebular-serve';

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
export function serviceDescriptorFor({ home, cliBin, execPath, http, cloudRoot = null }) {
  const listenArgs = Number.isInteger(http?.port) && http.port > 0 ? ['--port', String(http.port)] : [];
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
    },
  };
}

/**
 * 确保守护在跑（**默认优先服务**）：
 *   1. 已有实例健康（lock + /healthz 200）→ 复用，不重复启动；
 *   2. 服务托管已登记 → `@mebular/service` 重启它；
 *   3. 兜底 → 子进程 `spawn(execPath, [cliBin, 'serve'], { MEBULAR_HOME })`。
 * 返回 { mode: 'reused' | 'service' | 'child', home, child? }。
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
