// Mebular 桌面 App · 主进程（Electron 薄壳）
//
// 只做编排：单实例锁 → 解析 home/CLI/端口 → 确保守护（服务优先 / 子进程兜底）→ BrowserWindow
// 加载 127.0.0.1:<port>/console（引导态亦可）→ 托盘最小集 → IPC 白名单。
// 业务逻辑在 daemon.mjs / ipc.mjs（不 import electron，可单测）。

import { openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } from 'electron';
import {
  APP_VERSION, consoleUrl, ensureDaemon, resolveCliBin, resolveHome, resolveHttp,
  serviceEnabledFor, stopManaged, waitForDaemon, parseArgs, probeHealth, probeProvision, serviceDescriptorFor,
} from './daemon.mjs';
import { buildHandlerTable, diagnostics } from './ipc.mjs';
import { iconDataUrl } from './tray-icons.mjs';
import {
  computeWizardState, deepLinks, inviteText, inviteViaApi, isLoopbackUrl,
} from './wizard.mjs';
import { readDaemonLogs } from './logs.mjs';

const cliArgs = parseArgs(process.argv.slice(1));
const home = typeof cliArgs.home === 'string' ? cliArgs.home : resolveHome();
const cliBin = resolveCliBin();

let win = null;
let tray = null;
let daemonChild = null;
let daemonMode = null;
let healthy = false;

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

function httpConf() {
  const base = resolveHttp(readConfig());
  if (typeof cliArgs.port === 'string' || typeof cliArgs.port === 'number') {
    return { ...base, port: Number(cliArgs.port) };
  }
  return base;
}

async function loadServiceModule() {
  try {
    return await import(join(cliBin, '..', '..', '..', 'service', 'dist', 'index.js'));
  } catch {
    return null;
  }
}

async function probeService() {
  const service = await loadServiceModule();
  if (!service?.serviceStatus) return { available: false };
  try {
    const st = service.serviceStatus(serviceDescriptorFor({ home, cliBin, http: httpConf() }), { home });
    return { available: true, registered: st.registered, running: st.running, autostart: st.autostart, unitPath: st.unitPath ?? null };
  } catch (error) {
    return { available: true, error: String(error?.message ?? error) };
  }
}

/** 连接 AI 助手状态：回环 auth=none 直读；401 给**人话**且不阻断。 */
async function probeAssistants() {
  const http = httpConf();
  try {
    const res = await fetch(`http://${http.host}:${http.port}/admin/api/clients`, { signal: AbortSignal.timeout(2000) });
    if (res.status === 401) return { readError: '需要令牌（设置 MEBULAR_TOKEN 后重试）', connectedCount: 0, total: null };
    // W-1 小-6：409 = 控制台还在初始设置 → 人话（不抛黑话状态码）
    if (res.status === 409) return { readError: '先完成第①步（控制台还在初始设置）', connectedCount: 0, total: null };
    if (!res.ok) return { readError: `HTTP ${res.status}`, connectedCount: 0, total: null };
    const data = await res.json().catch(() => ({}));
    const clients = Array.isArray(data?.clients) ? data.clients : [];
    return { connectedCount: clients.filter((c) => c.connected).length, total: clients.length, needsManual: clients.filter((c) => c.needsManual).length };
  } catch (error) {
    return { readError: `无法读取（${error?.message ?? error}）`, connectedCount: 0, total: null };
  }
}

let lastInviteCreated = false;

async function wizardStateNow() {
  const healthy = await probeHealth(fetch, httpConf());
  // W-1 高-1：守护活着但处引导/待重启态 → 步骤①不算完成（404 = 正常态）
  const provision = await probeProvision(fetch, httpConf());
  const service = await probeService();
  const assistants = await probeAssistants();
  return computeWizardState({
    daemonHealthy: healthy,
    provisionRequired: provision.required,
    provisioned: provision.provisioned,
    service,
    assistants,
    invite: lastInviteCreated ? { created: true } : null,
  });
}

async function ensure() {
  const http = httpConf();
  const service = await loadServiceModule();
  const result = await ensureDaemon({
    home,
    http,
    cliBin,
    service: service ?? {},
    fetchImpl: fetch,
    spawnFn: (exec, args, opts) => spawnChild(exec, args, opts),
  });
  daemonMode = result.mode;
  daemonChild = result.child ?? null;
  console.log(`[desktop] 守护托管模式：${result.mode}（home=${home}, http=${http.host}:${http.port}）`);
  return result;
}

function spawnChild(exec, args, opts) {
  // 子进程输出落 <home>/serve.log（诊断 + 托盘「打开日志」）；App 自身也回显一行运行模式
  let stdio = ['ignore', 'pipe', 'pipe'];
  try {
    const fd = openSync(join(home, 'serve.log'), 'a');
    stdio = ['ignore', fd, fd];
  } catch {
    // 落盘失败不阻断；退回管道
  }
  const child = spawn(exec, args, { ...opts, stdio });
  child.on('exit', (code) => console.log(`[desktop] 子进程托管守护退出（code=${code}）—— 详情见 ${join(home, 'serve.log')}`));
  return child;
}

// ---------- 窗口 ----------

/** R-1 高-4：壳加载控制台一律带 ?shell=desktop（控制台据此收编终端指令/显示返回向导）。 */
function shellConsoleUrl() {
  return `${consoleUrl(httpConf())}?shell=desktop`;
}

function shellDeepLink(url) {
  return `${url}${url.includes('?') ? '&' : '?'}shell=desktop`;
}

function loadingHtml(message) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><title>Mebular</title>
     <body style="margin:0;display:grid;place-items:center;height:100vh;background:#0b0f0d;color:#d7ffe9;font:14px -apple-system,system-ui,sans-serif">
     <div style="text-align:center"><div style="font-size:28px">⬡</div><p>${message}</p>
     <p style="opacity:.6;font-size:12px">守护 home：${home}</p></div></body>`,
  )}`;
}

let loadingSeq = 0;

async function safeLoad(url) {
  if (!win || win.isDestroyed()) return;
  // 安全红线：只允许回环、本地 data: 占位页、以及 **App 目录内**的本地页（向导，含缓存破坏参数）；拒绝外站
  const appDirUrl = new URL('../', import.meta.url).href;
  const allowed = isLoopbackUrl(url) || String(url).startsWith('data:text/html') || String(url).startsWith(appDirUrl);
  if (!allowed) {
    console.log(`[desktop] 拒绝非回环导航：${String(url).slice(0, 120)}`);
    return;
  }
  try {
    await win.loadURL(url);
  } catch (error) {
    // 并行/快速导航导致的 ERR_ABORTED 属预期（后一次导航已接管），不冒泡
    if (!/ERR_ABORTED|aborted/i.test(String(error?.message ?? error))) {
      console.log(`[desktop] 加载失败：${error?.message ?? error}`);
    }
  }
}

async function showConsoleWithRetry() {
  if (!win || win.isDestroyed()) return;
  const seq = ++loadingSeq;
  const http = httpConf();
  await safeLoad(loadingHtml('正在启动 Mebular…'));
  const ok = await waitForDaemon({ fetchImpl: fetch, http, attempts: 120, intervalMs: 500 });
  if (seq !== loadingSeq) return; // 已被更新的加载流程接管
  healthy = ok;
  updateTray();
  if (!win || win.isDestroyed()) return;
  if (ok) {
    await safeLoad(shellConsoleUrl());
  } else {
    await safeLoad(loadingHtml('Mebular 未就绪：请查看日志，或点托盘「重启」重试。'));
  }
}

function createWindow() {
  win = new BrowserWindow({
    // R-1 小-12：默认 1280（1180 顶栏临界拥挤）
    width: 1280,
    height: 760,
    title: 'Mebular',
    backgroundColor: '#0b0f0d',
    webPreferences: {
      preload: join(import.meta.dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => (isLoopbackUrl(url) ? { action: 'allow' } : { action: 'deny' }));
}

// ---------- 托盘 ----------

function updateTray() {
  if (!tray) return;
  const state = healthy ? 'green' : daemonMode ? 'yellow' : 'red';
  // 状态点绑定真实健康（healthy 由 probeHealth 决定；daemonMode 反映托管路径）
  tray.setImage(nativeImage.createFromDataURL(iconDataUrl(state)));
  tray.setToolTip(`Mebular · ${healthy ? '运行中' : daemonMode ? '启动中' : '未运行'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${healthy ? '●' : '○'} ${healthy ? '运行中' : daemonMode ? '启动中' : '未运行'}（${daemonMode ?? '—'}）`, enabled: false },
    { type: 'separator' },
    { label: '打开控制台', click: () => { win?.show(); win?.focus(); if (win && !win.isDestroyed()) void safeLoad(shellConsoleUrl()); } },
    { label: '连接 AI 助手', click: () => { win?.show(); win?.focus(); void safeLoad(shellDeepLink(deepLinks(httpConf()).assistants)); } },
    { label: '添加设备', click: () => { win?.show(); win?.focus(); void safeLoad(wizardViewUrl()); } },
    { label: '启动', click: () => { void ensure().then(() => showConsoleWithRetry()); } },
    { label: '停止', click: () => { stopManaged(daemonChild); daemonChild = null; healthy = false; updateTray(); } },
    { label: '重启', click: () => { void restart(); } },
    { label: '打开日志', click: () => { shell.openPath(join(home, 'serve.log')).catch(() => undefined); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } },
  ]));
}

async function restart() {
  if (daemonChild) { stopManaged(daemonChild); daemonChild = null; }
  healthy = false; daemonMode = null; updateTray();
  await new Promise((r) => setTimeout(r, 800));
  await ensure();
  await showConsoleWithRetry();
}

function createTray() {
  tray = new Tray(nativeImage.createFromDataURL(iconDataUrl('red')));
  updateTray();
}

// ---------- M2：服务直装 / 邀请 / 视图 ----------

function wizardFileUrl() {
  return new URL('../renderer/wizard.html', import.meta.url).href;
}

/** 带缓存破坏参数的向导 URL（渲染层不缓存旧脚本）。 */
function wizardViewUrl() {
  return `${wizardFileUrl()}?t=${Date.now()}`;
}

/** 审批走**主进程直调** @mebular/service（不经 HTTP 写端点，避免 CSRF/token 复杂度）。 */
async function installServiceDirect() {
  if (process.env.MEBULAR_DESKTOP_DRY_RUN === '1') {
    return { ok: true, dryRun: true, note: '（DRY_RUN）将调用 @mebular/service installService', home };
  }
  const service = await loadServiceModule();
  if (!service?.installService) return { ok: false, reason: '@mebular/service 不可用' };
  try {
    const res = service.installService(serviceDescriptorFor({ home, cliBin, http: httpConf() }), { home, autostart: true });
    return { ok: true, registered: true, unitPath: res?.unitPath ?? null };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/**
 * 邀请（R-1 中-8）：与控制台同源 `POST /admin/api/invite`（主进程直调，CSRF 头在 wizard.mjs 处理）。
 * 不再走 `fleet invite` CLI —— fresh home 无 fleet.config.json 时 CLI 必 ENOENT。
 */
async function createInvite() {
  const res = await inviteViaApi(fetch, httpConf());
  lastInviteCreated = Boolean(res.token);
  return { ...res, text: inviteText(res), raw: null };
}

// ---------- IPC（白名单） ----------

function registerIpc() {
  const table = buildHandlerTable({
    'daemon:status': async () => ({ mode: daemonMode, healthy, home, http: httpConf() }),
    'daemon:start': async () => { await ensure(); await showConsoleWithRetry(); return { mode: daemonMode }; },
    'daemon:stop': () => ({ stopped: stopManaged(daemonChild) }),
    'daemon:restart': async () => { await restart(); return { mode: daemonMode }; },
    'console:open': async () => { win?.show(); win?.focus(); await safeLoad(shellConsoleUrl()); return { url: shellConsoleUrl() }; },
    'logs:open': async () => { await shell.openPath(join(home, 'serve.log')); return { path: join(home, 'serve.log') }; },
    'app:diagnostics': () => diagnostics({ appVersion: APP_VERSION, electronVersion: process.versions.electron, mode: daemonMode, home, http: httpConf(), healthy }),
    // M2：向导 / 服务托管（主进程直调，不经 HTTP 写端点）/ 日志 / 邀请 / 深链
    'wizard:state': async () => wizardStateNow(),
    'wizard:step': async () => ({ step: (await wizardStateNow()).current }),
    'service:status': async () => probeService(),
    'service:install': async () => installServiceDirect(),
    'logs:read': async () => {
      const svc = await loadServiceModule();
      return readDaemonLogs({ home, service: svc, descriptor: serviceDescriptorFor({ home, cliBin, http: httpConf() }) });
    },
    'invite:create': async () => createInvite(),
    'deep:assistants': async () => { await safeLoad(shellDeepLink(deepLinks(httpConf()).assistants)); return { url: shellDeepLink(deepLinks(httpConf()).assistants) }; },
    'deep:device': async () => { await safeLoad(wizardViewUrl()); return { url: wizardFileUrl() }; },
  });
  for (const [channel, handler] of Object.entries(table)) ipcMain.handle(channel, handler);
}

// ---------- 生命周期（单实例 + 退出策略） ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });

  app.whenReady().then(async () => {
    registerIpc();
    createTray();
    createWindow();
    try {
      await ensure();
      const state = await wizardStateNow();
      if (state.complete) {
        await showConsoleWithRetry();
      } else {
        console.log(`[desktop] 未完成首次上手（待办：${state.current}）→ 打开向导`);
        await safeLoad(wizardFileUrl());
        healthy = await probeHealth(fetch, httpConf());
        updateTray();
      }
    } catch (error) {
      dialog.showErrorBox('Mebular 启动失败', String(error?.message ?? error));
      updateTray();
    }
  });

  app.on('window-all-closed', () => {
    // M1：App 退出即停**自己托管**的子进程；服务托管不动（常驻不受影响）
    const stopped = stopManaged(daemonChild);
    if (stopped) console.log('[desktop] 已停止子进程托管的守护（服务托管不受影响）');
    app.quit();
  });

  app.on('before-quit', () => {
    stopManaged(daemonChild);
  });
}

export { serviceEnabledFor };
