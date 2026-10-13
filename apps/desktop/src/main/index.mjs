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
  serviceEnabledFor, stopManaged, waitForDaemon, parseArgs,
} from './daemon.mjs';
import { buildHandlerTable, diagnostics } from './ipc.mjs';
import { iconDataUrl } from './tray-icons.mjs';

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
    await safeLoad(consoleUrl(http));
  } else {
    await safeLoad(loadingHtml('Mebular 未就绪：请查看日志，或点托盘「重启」重试。'));
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\/127\.0\.0\.1[:/]/.test(url)) return { action: 'allow' };
    return { action: 'deny' };
  });
}

// ---------- 托盘 ----------

function updateTray() {
  if (!tray) return;
  const state = healthy ? 'green' : daemonMode ? 'yellow' : 'red';
  tray.setImage(nativeImage.createFromDataURL(iconDataUrl(state)));
  tray.setToolTip(`Mebular · ${healthy ? '运行中' : daemonMode ? '启动中' : '未运行'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${healthy ? '●' : '○'} ${healthy ? '运行中' : daemonMode ? '启动中' : '未运行'}（${daemonMode ?? '—'}）`, enabled: false },
    { type: 'separator' },
    { label: '打开控制台', click: () => { win?.show(); win?.focus(); if (win && !win.isDestroyed()) void win.loadURL(consoleUrl(httpConf())); } },
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

// ---------- IPC（白名单） ----------

function registerIpc() {
  const table = buildHandlerTable({
    'daemon:status': async () => ({ mode: daemonMode, healthy, home, http: httpConf() }),
    'daemon:start': async () => { await ensure(); await showConsoleWithRetry(); return { mode: daemonMode }; },
    'daemon:stop': () => ({ stopped: stopManaged(daemonChild) }),
    'daemon:restart': async () => { await restart(); return { mode: daemonMode }; },
    'console:open': () => { win?.show(); win?.focus(); return { url: consoleUrl(httpConf()) }; },
    'logs:open': async () => { await shell.openPath(join(home, 'serve.log')); return { path: join(home, 'serve.log') }; },
    'app:diagnostics': () => diagnostics({ appVersion: APP_VERSION, electronVersion: process.versions.electron, mode: daemonMode, home, http: httpConf(), healthy }),
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
      await showConsoleWithRetry();
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
