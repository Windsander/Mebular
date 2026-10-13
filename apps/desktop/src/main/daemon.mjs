// Mebular 桌面 App · 主进程逻辑（**不 import electron**，可被 node/jest 直接加载与单测）
//
// 职责：解析 App 运行所需路径、守护托管两路径（服务优先 / 子进程兜底）、健康探测与复用判定、
// 退出策略。Electron 相关（BrowserWindow/Tray/ipcMain）在 index.mjs，薄壳委托到这里。
//
// 复用既有纪律：MEBULAR_HOME 显式传入（禁止 cwd）；服务托管复用 @mebular/service；零新增 daemon 配置。

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_VERSION = '0.1.0';
export const SERVICE_KIND = 'mebular-serve';

/** 仓库根（apps/desktop/src/main → 上溯 4 层）；打包态由 resources 决定。 */
export function repoRootFromModule() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

/** 内置 CLI（`mebular serve` 入口）。开发态取仓库 packages/mcp/bin/mebular.mjs。 */
export function resolveCliBin(root = repoRootFromModule()) {
  return join(root, 'packages', 'mcp', 'bin', 'mebular.mjs');
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

/** /healthz 探测（注入 fetch，便于单测）。 */
export async function probeHealth(fetchImpl, http = { host: '127.0.0.1', port: 7331 }, timeoutMs = 1200) {
  try {
    const res = await fetchImpl(healthUrl(http), { signal: AbortSignal.timeout(timeoutMs) });
    return Boolean(res?.ok);
  } catch {
    return false;
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
export function serviceEnabledFor(service, home) {
  try {
    return service.registeredServicesForDir(home, { home }).includes(SERVICE_KIND);
  } catch {
    return false;
  }
}

export function serviceDescriptorFor({ home, cliBin, execPath, http }) {
  const listenArgs = Number.isInteger(http?.port) && http.port > 0 ? ['--port', String(http.port)] : [];
  return {
    kind: SERVICE_KIND,
    args: [cliBin, 'serve', ...listenArgs],
    heartbeatDir: home,
    workingDir: home,
    execPath,
    env: { MEBULAR_HOME: home },
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
} = {}) {
  if (await probeHealth(fetchImpl, http)) return { mode: 'reused', home, child: null };
  const desc = serviceDescriptorFor({ home, cliBin, execPath, http });
  if (serviceEnabledFor(service, home)) {
    service.restartService(desc, { home });
    return { mode: 'service', home, child: null };
  }
  // Electron 作为 Node 运行时：ELECTRON_RUN_AS_NODE=1（在 Electron 内有效；纯 node 下无害）
  // 端口显式传给子进程（与 App 探测/加载的端口一致；否则子进程用默认端口 → 探测不匹配）
  const listenArgs = Number.isInteger(http?.port) && http.port > 0 ? ['--port', String(http.port)] : [];
  const child = spawnFn(execPath, [cliBin, 'serve', ...listenArgs], {
    env: { ...env, MEBULAR_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { mode: 'child', home, child };
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

/** 引导态/正常态都可加载控制台：/healthz 200 即认为可显示（引导态同样服务 /healthz）。 */
export async function waitForDaemon({ fetchImpl, http, attempts = 60, intervalMs = 500, onTick } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await probeHealth(fetchImpl, http)) return true;
    onTick?.(i);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export { existsSync };
