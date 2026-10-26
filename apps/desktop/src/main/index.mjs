// Mebular 桌面 App · 主进程（Electron 薄壳）
//
// 只做编排：单实例锁 → 解析 home/CLI/端口 → 确保守护（服务优先 / 子进程兜底）→ BrowserWindow
// 加载 127.0.0.1:<port>/console（引导态亦可）→ 托盘最小集 → IPC 白名单。
// 业务逻辑在 daemon.mjs / ipc.mjs（不 import electron，可单测）。

import { openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog, session, screen } from 'electron';
import {
  APP_VERSION, consoleUrl, ensureDaemon, resolveCliBin, resolveHome, resolveHttp,
  serviceEnabledFor, stopManaged, waitForDaemonDetail, parseArgs, probeHealthDetail, probeProvision,
  probeRuntimeIdentity, probeSecurityLevel, serviceDescriptorFor, homeKey, isPortOpen,
  reconcileManagedState, isManagedChildAlive, registerAppRuntimeProvider, resolveAppServiceRuntime,
  appServiceFallbackBlock, installLegacyAppService,
} from './daemon.mjs';
import {
  loadCloudModules, migrateLegacyService, performCloudSwitch, recoverSwitchIntent, appFallbackProvider,
} from './clouds.mjs';
import { buildHandlerTable, diagnostics } from './ipc.mjs';
import { iconDataUrl, iconDataUrl2x } from './tray-icons.mjs';
import {
  computeWizardState, deepLinks, inviteText, inviteViaApi, isLoopbackUrl,
  readDesktopState, writeDesktopState, clientsViaApi, clientActionViaApi, installDecision,
} from './wizard.mjs';
import { closeAction, quitConfirm, quitDecision, stopConfirm, trayMenuModel, trayStatusLine, LOGIN_ITEM_ID } from './lifecycle.mjs';
import { consoleNavSearch, consoleNavUrl, isConsoleUrl } from './console-nav.mjs';
import { readDaemonLogs } from './logs.mjs';
import { loadDesktopI18n, resolveLocalesDir } from './i18n.mjs';


const cliArgs = parseArgs(process.argv.slice(1));
// E2-B：home 是**可变运行时状态**（切换忆云时更新）；httpConf() 每次都从当前 home 读端口。
let home = typeof cliArgs.home === 'string' ? cliArgs.home : resolveHome();
const cliBin = resolveCliBin();
// @mebular/service 的落盘位置 = OS 用户 home（plist/manifest），不是忆云 home（profiles/<id>）。
const serviceHome = homedir();

// 壳层 i18n：语言偏好保存在 <home>/.desktop-state.json（Console 选择后由 preload 同步）；
// 默认 / 回退来自 locales/manifest.json（不在主进程硬编码语言集合）。
// 文案唯一真源 = locales/<locale>/desktop.json（随 extraResources 打包）。
let desktopI18n = loadDesktopI18n({
  localesDir: resolveLocalesDir(),
  locale: readDesktopState(home).locale || null,
});
const t = (key, vars) => desktopI18n.t(key, vars);

let win = null;
let tray = null;
let quitDialog = null;
let quitDialogReady = null;
let quitDialogSession = null;
let quitDialogIpcBound = false;
let daemonChild = null;
let daemonMode = null;
let healthy = false;
// S3：托盘只读安全等级（null = 未取到/旧版；显示 —，不猜测档位）
let securityLevel = null;
// E2-B：忆云上下文（root/current/name）。null = 自定义 home / 受限 env（功能不可用）。
let cloudModules = null;
let cloudRoot = null;
let cloudId = null;
let cloudName = null;
let cloudUnavailable = null;
let startupDiagnostic = null;
// 异步健康探测的世代号：显式改变托管状态（退出/停止/重启/切换）后，旧探测结果直接丢弃。
let trayStateEpoch = 0;

function markTrayStateChanged() {
  trayStateEpoch += 1;
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

/** 应用壳层 locale：更新 translator / 托盘 / 窗口标题 / 退出确认窗口标题。 */
function applyDesktopLocale(raw, { persist = false } = {}) {
  const normalized = desktopI18n.setLocale(raw);
  if (persist) writeDesktopState(home, { locale: normalized });
  updateTray();
  setWindowTitle();
  if (quitDialog && !quitDialog.isDestroyed()) quitDialog.setTitle(t('quit.windowTitle'));
  return normalized;
}

/** home 切换（忆云）后重读该 home 的语言偏好。 */
function reloadDesktopLocale() {
  desktopI18n = loadDesktopI18n({
    localesDir: resolveLocalesDir(),
    locale: readDesktopState(home).locale || null,
  });
  updateTray();
  setWindowTitle();
}

const CJK_TEXT = /[\u3400-\u9fff]/;
const isChineseLocale = (code) => String(code ?? '').trim().toLowerCase().startsWith('zh');

/**
 * 壳层展示 core/daemon 给的诊断文本：中文 locale 保留原文；其他 locale 遇到中文原文
 * 改用 desktop pack 的翻译兜底（英文界面不出现中文兜底）。
 */
function shellMessage(raw, key, vars) {
  const text = typeof raw === 'string' && raw.trim() ? raw : null;
  if (!text) return t(key, vars);
  if (!isChineseLocale(desktopI18n.locale) && CJK_TEXT.test(text)) return t(key, vars);
  return text;
}

function errorTranslationKey(code) {
  const raw = typeof code === 'string' ? code.trim() : '';
  if (!raw) return null;
  if (raw.startsWith('errors.')) return raw;
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug ? `errors.${slug}` : null;
}

/**
 * 主进程展示给用户的错误：中文界面保留原文；英文界面优先错误码 → errors pack，
 * 非中文技术原文保留，未知中文错误退回本动作兜底（绝不把中文原文透到英文界面）。
 */
function localizeErrorDetail(error, fallbackKey = 'errors.unknown') {
  const message = String(typeof error === 'string'
    ? error
    : (error?.payload?.message ?? error?.message ?? ''))
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    .trim();
  const payload = error?.payload ?? null;
  const code = typeof payload?.errorKey === 'string' ? payload.errorKey
    : typeof payload?.error === 'string' ? payload.error
      : typeof error?.code === 'string' ? error.code : null;
  const key = errorTranslationKey(code);
  if (isChineseLocale(desktopI18n.locale)) return message || t(fallbackKey);
  const messageIsCode = typeof code === 'string' && message.toLowerCase() === code.toLowerCase();
  const genericHttp = /^HTTP\s+\d+$/i.test(message);
  if (message && !CJK_TEXT.test(message) && !messageIsCode && !genericHttp) return message;
  if (key && typeof t.has === 'function' && t.has(key)) return t(key);
  return t(fallbackKey);
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

async function loadRuntimeServiceModule() {
  try {
    return await import(join(dirname(cliBin), '..', 'src', 'runtime-service.mjs'));
  } catch {
    return null;
  }
}

async function probeService() {
  const service = await loadServiceModule();
  if (!service?.serviceStatus) return { available: false };
  const runtimeService = await loadRuntimeServiceModule();
  const appRuntime = await resolveAppServiceRuntime({ cliBin, cloudRoot });
  if (runtimeService?.runtimeServiceStatus && typeof cloudRoot === 'string' && cloudRoot.length > 0) {
    try {
      const status = await runtimeService.runtimeServiceStatus({
        root: cloudRoot,
        home,
        serviceHome,
        fallbackProvider: appRuntime.source,
        ...(service ? { serviceLib: service } : {}),
      });
      if (status.ok === true) {
        return {
          available: true,
          registered: status.registered,
          running: status.running,
          autostart: status.autostart,
          unitPath: status.unitPath ?? null,
          version: status.version ?? null,
          runtimePath: status.runtimePath ?? null,
          provider: status.provider ?? null,
          owner: status.owner ?? null,
          current: status.current ?? null,
          currentUsable: status.currentUsable === true,
        };
      }
      return { available: true, error: status.message ?? status.reason ?? 'service_unknown' };
    } catch (error) {
      return { available: true, error: String(error?.message ?? error) };
    }
  }
  try {
    const st = service.serviceStatus(
      serviceDescriptorFor({
        home,
        cliBin: appRuntime.source.cliPath,
        execPath: process.execPath,
        http: httpConf(),
        cloudRoot,
        runtime: appRuntime.source,
      }),
      { home: serviceHome },
    );
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
    if (res.status === 401) return { readError: t('wizard.error.needsToken'), connectedCount: 0, total: null };
    // W-1 小-6：409 = 控制台还在初始设置 → 人话（不抛黑话状态码）
    if (res.status === 409) return { readError: t('wizard.error.needsProvision'), connectedCount: 0, total: null };
    if (!res.ok) return { readError: `HTTP ${res.status}`, connectedCount: 0, total: null };
    const data = await res.json().catch(() => ({}));
    const clients = Array.isArray(data?.clients) ? data.clients : [];
    // 已装数：与向导列表可见集同一规则——state 优先、排除未安装/检测失败，且**排除 manual 兜底**（不显示就不计数）
    const installedCount = clients.filter((c) => {
      const state = c.state ?? null;
      const installed = state ? state !== 'not-installed' && state !== 'detect-failed' : Boolean(c.installed);
      return installed && state !== 'manual' && c.needsManual !== true;
    }).length;
    return { connectedCount: clients.filter((c) => c.connected).length, total: clients.length, installedCount, needsManual: clients.filter((c) => c.needsManual).length };
  } catch (error) {
    return { readError: t('wizard.error.readFailed', { error: localizeErrorDetail(error, 'errors.unknown') }), connectedCount: 0, total: null };
  }
}

let quitting = false;

async function wizardStateNow() {
  const healthy = (await probeHealthDetail(fetch, httpConf(), { expectedInstance: homeKey(home) })).ok;
  // P4：provision 仅作诊断（UNINITIALIZED 是正常引导阶段，不再阻塞步骤①完成）
  const provision = await probeProvision(fetch, httpConf());
  const service = await probeService();
  const assistants = await probeAssistants();
  const desktop = readDesktopState(home);
  return computeWizardState({
    daemonHealthy: healthy,
    provisionRequired: provision.required,
    provisioned: provision.provisioned,
    service,
    assistants,
    // UX-2：② 完成 = 用户显式「已完成」（assistantsAcked）；邀请不再参与完成推导
    wizard: { assistantsAcked: Boolean(desktop.assistantsAcked), skipped: Boolean(desktop.skipped) },
  });
}

async function ensure() {
  const http = httpConf();
  const service = await loadServiceModule();
  const result = await ensureDaemon({
    home,
    http,
    cliBin,
    cloudRoot,
    serviceHome,
    service: service ?? {},
    fetchImpl: fetch,
    spawnFn: (exec, args, opts) => spawnChild(exec, args, opts),
  });
  if (result.warning) console.log(`[desktop] ${result.warning}`);
  if (result.mode === 'conflict') {
    markTrayStateChanged();
    healthy = false;
    securityLevel = null;
    updateTray();
    console.log(`[desktop] 守护未启动（${result.reason}）：${result.message}`);
    return result;
  }
  // 首启自己 spawn 的 child 在后续 ensure 里会被判成 reused；只要它还活着就保留托管身份，
  // 不能把控制权改认成外部守护（否则托盘/退出确认/控制台状态互相矛盾）。
  const managed = reconcileManagedState({
    resultMode: result.mode,
    resultChild: result.child ?? null,
    existingChild: daemonChild,
  });
  markTrayStateChanged();
  daemonMode = managed.mode;
  daemonChild = managed.child;
  // reused 代表 ensureDaemon 已用实例身份探测过 /healthz：健康是确定的，可立即同步托盘。
  if (result.mode === 'reused') healthy = true;
  else if (result.mode === 'child' || result.mode === 'service') healthy = false;
  // spawn 后立即退出（CLI 报错等）时 exit 事件可能早于 daemonChild 赋值；这里补一次清理。
  if (daemonChild && !isManagedChildAlive(daemonChild)) {
    daemonChild = null;
    daemonMode = null;
    healthy = false;
    securityLevel = null;
  }
  const modeNote = managed.mode !== result.mode ? ` → ${managed.mode}（保留 App 托管的 child）` : '';
  const deadNote = !daemonChild && result.mode === 'child' ? '（child 已退出）' : '';
  console.log(`[desktop] 守护托管模式：${result.mode}${modeNote}${deadNote}（home=${home}, http=${http.host}:${http.port}）`);
  updateTray();
  return { ...result, mode: daemonMode, child: daemonChild };
}

function spawnChild(exec, args, opts) {
  // 子进程输出落**该子进程 home** 的 serve.log（切换新忆云时不能写进旧 home）。
  const childHome = typeof opts?.env?.MEBULAR_HOME === 'string' ? opts.env.MEBULAR_HOME : home;
  let stdio = ['ignore', 'pipe', 'pipe'];
  try {
    const fd = openSync(join(childHome, 'serve.log'), 'a');
    stdio = ['ignore', fd, fd];
  } catch {
    // 落盘失败不阻断；退回管道
  }
  const child = spawn(exec, args, { ...opts, stdio });
  child.on('exit', (code) => {
    console.log(`[desktop] 子进程托管守护退出（code=${code}）—— 详情见 ${join(childHome, 'serve.log')}`);
    // 只处理当前托管的 child；旧 child 的迟到 exit 不得清掉新 child 的状态。
    if (daemonChild !== child) return;
    markTrayStateChanged();
    daemonChild = null;
    daemonMode = null;
    healthy = false;
    securityLevel = null;
    updateTray();
  });
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

/** E2-B：端口 200 但身份不符时的人话（不冒充目标忆云）。 */
function healthMessage(health, http) {
  if (health?.reason === 'instance_mismatch') return t('loading.portMismatch', { port: http.port });
  if (health?.reason === 'instance_missing') return t('loading.instanceMissing', { port: http.port });
  return t('loading.notReady');
}

function loadingHtml(message) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><title>Mebular</title>
     <body style="margin:0;display:grid;place-items:center;height:100vh;background:#0b0f0d;color:#d7ffe9;font:14px -apple-system,system-ui,sans-serif">
     <div style="text-align:center"><div style="font-size:28px">⬡</div><p>${message}</p>
     <p style="opacity:.6;font-size:12px">${t('loading.home', { home })}</p></div></body>`,
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
  await safeLoad(loadingHtml(t('loading.starting')));
  const health = await waitForDaemonDetail({
    fetchImpl: fetch, http, attempts: 120, intervalMs: 500, expectedInstance: homeKey(home),
  });
  if (seq !== loadingSeq) return; // 已被更新的加载流程接管
  healthy = health.ok;
  updateTray();
  if (health.ok) void refreshTrayStatus();
  if (!win || win.isDestroyed()) return;
  if (health.ok) {
    await safeLoad(shellConsoleUrl());
  } else if (health.reason === 'instance_mismatch') {
    await safeLoad(loadingHtml(healthMessage(health, http)));
  } else {
    await safeLoad(loadingHtml(t('loading.notReady')));
  }
}

/** App 图标路径（Dock / 窗口 / 打包共用；与网页版 favicon 同源的 ✦ 星） */
function appIconPath() {
  return join(import.meta.dirname, '..', '..', 'resources', 'icon.png');
}
/** 菜单栏图标：18pt 品牌星章（模板图——深色菜单栏自动渲染白底镂空星）+ @2x 载荷 */
function trayImage() {
  const img = nativeImage.createFromDataURL(iconDataUrl());
  img.addRepresentation({ scaleFactor: 2, dataURL: iconDataUrl2x() });
  img.setTemplateImage(true);
  return img;
}

/** macOS Dock 图标：开发态（Electron 裸跑）也显示品牌图标；打包态与 bundle 图标一致 */
function applyAppIcon() {
  if (process.platform === 'darwin' && app.dock) {
    const img = nativeImage.createFromPath(appIconPath());
    if (!img.isEmpty()) app.dock.setIcon(img);
  }
}

function createWindow() {
  win = new BrowserWindow({
    // R-1 小-12：默认 1280（1180 顶栏临界拥挤）
    width: 1280,
    height: 760,
    title: t('app.windowTitle'),
    icon: appIconPath(), // Windows/Linux 窗口图标（macOS 走 Dock/bundle）
    backgroundColor: '#0b0f0d',
    // UX-2 补丁 4：macOS 交通灯内嵌（hiddenInset）——内容区与 CRT 风格连续；
    // Windows/Linux 保守默认 frame（系统标题栏保留，不冒险）
    // 走查修正（用户实拍：灯与顶栏内容不在一条线上）：hiddenInset 默认 margin (12,11)
    // 是 Electron ≤12 的旧布局（比官方 App 偏高）；顶栏 56px → 内容中线 28。
    // trafficLightPosition.y = 按钮 frame 顶距窗口顶；frame 高 14~16 → 取 20 使灯心 ≈27~28。
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 20 } } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => (isLoopbackUrl(url) ? { action: 'allow' } : { action: 'deny' }));
  // R-1 高-2：关窗 = 隐藏（守护不动）；真退出只走托盘「退出」（quitting 标志位）
  win.on('close', (event) => {
    if (closeAction({ quitting }) === 'hide') {
      event.preventDefault();
      win?.hide();
    }
  });
}

// ---------- 托盘 ----------

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

/**
 * 托盘控制台入口：已加载 /console → 只发导航事件（原地切视图/开弹层，不重建页面）；
 * 未加载（向导 / loading / 其他）→ 才加载一次。target 只接受 console-nav 的固定键。
 */
async function navigateConsole(target) {
  const base = consoleUrl(httpConf());
  const url = consoleNavUrl(base, target);
  if (!url) {
    console.log(`[desktop] 拒绝未知控制台导航：${String(target).slice(0, 60)}`);
    return;
  }
  showWindow();
  if (win && !win.isDestroyed() && isConsoleUrl(win.webContents.getURL(), base)) {
    win.webContents.send('console:navigate', { target, search: consoleNavSearch(target) });
    return;
  }
  await safeLoad(shellDeepLink(url));
}

/**
 * 应用内退出确认：应用启动时预热并复用独立无框窗口。
 *
 * 之前每次点「退出」才构造 BrowserWindow + loadFile，窗口首次出现要等页面加载；
 * 主窗口隐藏时也没有 parent，单靠 focus() 在 macOS 上无法稳定把 App 带到前台。
 * 这里在启动时预加载一次，展示时再显式解除隐藏、激活 App、切到当前 Space 并置顶。
 * 关闭、Esc、点取消都 resolve false；只有「退出」按钮 resolve true。
 */
function centerQuitDialog(dialogWin) {
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : null;
  const display = parent
    ? screen.getDisplayMatching(parent.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const [width, height] = dialogWin.getSize();
  dialogWin.setPosition(
    Math.round(area.x + (area.width - width) / 2),
    Math.round(area.y + (area.height - height) / 2),
    false,
  );
}

function bringQuitDialogToFront(dialogWin) {
  if (!dialogWin || dialogWin.isDestroyed()) return;
  if (dialogWin.isMinimized()) dialogWin.restore();
  // Cmd+H / app.hide() 之后仅 focus 不会自动解除隐藏；先 show App，再激活并聚焦窗口。
  if (process.platform === 'darwin' && app.isHidden()) app.show();
  dialogWin.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  dialogWin.moveTop();
  dialogWin.focus();
}

function onQuitDialogAnswer(event, confirmed) {
  if (!quitDialog || quitDialog.isDestroyed()) return;
  if (event.sender !== quitDialog.webContents) return;
  finishQuitDialog(confirmed === true);
}

function finishQuitDialog(confirmed) {
  const session = quitDialogSession;
  if (!session) return;
  quitDialogSession = null;
  if (quitDialog && !quitDialog.isDestroyed()) quitDialog.hide();
  session.resolve(confirmed === true);
}

function createQuitDialog() {
  const dialogWin = new BrowserWindow({
    width: 452,
    height: 296,
    title: t('quit.windowTitle'),
    icon: appIconPath(),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#05070f',
    webPreferences: {
      preload: join(import.meta.dirname, '..', 'preload', 'quit-confirm.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  quitDialog = dialogWin;
  if (process.platform === 'darwin') {
    dialogWin.setAlwaysOnTop(true, 'floating');
    // 应用在另一个 Space / 全屏应用后面时，退出确认也应出现在用户当前所在的 Space。
    dialogWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  dialogWin.on('close', (event) => {
    // 真退出时允许 close；其余时候关闭 = 取消，窗口保留给下一次复用。
    if (quitting) return;
    event.preventDefault();
    if (quitDialogSession) finishQuitDialog(false);
    else dialogWin.hide();
  });
  dialogWin.on('closed', () => {
    if (quitDialog !== dialogWin) return;
    quitDialog = null;
    quitDialogReady = null;
    if (quitDialogSession) finishQuitDialog(false);
  });
  dialogWin.webContents.on('render-process-gone', () => {
    if (quitDialog !== dialogWin) return;
    if (quitDialogSession) finishQuitDialog(false);
    if (!dialogWin.isDestroyed()) dialogWin.destroy();
  });
  dialogWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  dialogWin.webContents.on('will-navigate', (event) => event.preventDefault());
  if (!quitDialogIpcBound) {
    ipcMain.on('quit-confirm:answer', onQuitDialogAnswer);
    quitDialogIpcBound = true;
  }
  quitDialogReady = new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    dialogWin.once('ready-to-show', () => settle(dialogWin));
    dialogWin.loadFile(join(import.meta.dirname, '..', 'renderer', 'quit-confirm.html'))
      .then(() => settle(dialogWin))
      .catch((error) => {
        console.log(`[desktop] 退出确认页面加载失败：${error?.message ?? error}`);
        settle(null);
      });
  });
  return dialogWin;
}

function resetQuitDialog() {
  const dialogWin = quitDialog;
  quitDialog = null;
  quitDialogReady = null;
  if (dialogWin && !dialogWin.isDestroyed()) dialogWin.destroy();
}

function ensureQuitDialog() {
  if (quitDialog && !quitDialog.isDestroyed()) return quitDialog;
  return createQuitDialog();
}

function presentQuitDialog(dialogWin, plan) {
  if (!dialogWin || dialogWin.isDestroyed()) return;
  centerQuitDialog(dialogWin);
  if (!dialogWin.webContents.isDestroyed()) {
    if (typeof dialogWin.setTitle === 'function') dialogWin.setTitle(t('quit.windowTitle'));
    dialogWin.webContents.send('quit-confirm:plan', {
      locale: desktopI18n.locale,
      title: t('quit.title'),
      message: plan.message,
      buttons: plan.buttons,
      hint: t('quit.hint'),
      closeLabel: t('quit.closeAria'),
    });
  }
  bringQuitDialogToFront(dialogWin);
}

function showQuitConfirmation(plan) {
  return new Promise((resolve) => {
    if (quitDialogSession) {
      if (quitDialog && !quitDialog.isDestroyed() && quitDialog.isVisible()) bringQuitDialogToFront(quitDialog);
      resolve(false);
      return;
    }
    try {
      ensureQuitDialog();
    } catch (error) {
      console.log(`[desktop] 退出确认窗口创建失败：${error?.message ?? error}`);
      resolve(false);
      return;
    }
    const session = { resolve, plan };
    quitDialogSession = session;
    quitDialogReady.then((ready) => {
      if (quitDialogSession !== session) return;
      if (!ready || ready.isDestroyed()) {
        // 加载失败的窗口不可复用：清掉引用，下次退出时重新创建（自愈）。
        resetQuitDialog();
        finishQuitDialog(false);
        return;
      }
      presentQuitDialog(ready, plan);
    }).catch(() => finishQuitDialog(false));
  });
}

/** R-1 高-2：唯一真退出入口（托盘「退出」）；确认文案由 quitConfirm 按托管模式给出（不谎称停守护）。 */
async function confirmQuit() {
  const plan = quitConfirm({ daemonMode, hasManagedChild: Boolean(daemonChild) }, t);
  const confirmed = await showQuitConfirmation(plan);
  if (quitDecision({ confirmed }) !== 'quit') return;
  quitting = true;
  app.quit();
}

/** R-1 中-9：停止需确认；停止后窗口内横幅（守护已停止，托盘可重启）。 */
async function confirmStop() {
  const plan = stopConfirm({ daemonMode, hasManagedChild: Boolean(daemonChild) }, t);
  if (!plan.canStop) {
    await dialog.showMessageBox(win ?? undefined, { type: 'info', message: plan.message, buttons: [t('stop.ack')] });
    return;
  }
  const { response } = await dialog.showMessageBox(win ?? undefined, {
    type: 'warning', message: plan.message, buttons: [t('stop.cancel'), t('stop.confirm')], defaultId: 0, cancelId: 0,
  });
  if (response !== 1) return;
  stopManaged(daemonChild);
  markTrayStateChanged();
  daemonChild = null;
  daemonMode = null;
  healthy = false;
  securityLevel = null;
  updateTray();
  if (win && !win.isDestroyed() && win.isVisible()) {
    await safeLoad(loadingHtml(t('loading.stopped')));
  }
}

async function confirmRestart() {
  const { response } = await dialog.showMessageBox(win ?? undefined, {
    type: 'question', message: t('restart.message'), buttons: [t('restart.cancel'), t('restart.confirm')], defaultId: 0, cancelId: 0,
  });
  if (response !== 1) return;
  await restart();
  await showConsoleWithRetry(); // 托盘「重启」= 显式用户动作：维持旧行为，重启后落到控制台
}

/**
 * 只读刷新托盘健康 / 等级 / 运行期展示名（失败保持上一值；旧值不冒充新值）。
 * 每 20s 由定时器调用：先重新探测 /healthz（不能只在 healthy=true 时刷等级，
 * 否则 child 退出/外部守护停止后托盘会一直显示「运行中」）。
 * 瞬时网络失败容忍：连续 2 次失败才判定掉线；实例不匹配等终态立即生效。
 */
let healthProbeFailures = 0;
const HEALTH_PROBE_GRACE = 2;

async function refreshTrayStatus() {
  const epoch = trayStateEpoch;
  const health = await probeHealthDetail(fetch, httpConf(), { expectedInstance: homeKey(home) });
  if (epoch !== trayStateEpoch) return; // 探测期间托管状态已变（退出/停止/重启/切换）：丢弃过期结果
  if (!health.ok) {
    const terminal = ['instance_mismatch', 'instance_missing', 'cloud_mismatch'].includes(health.reason);
    if (healthy && !terminal) {
      healthProbeFailures += 1;
      if (healthProbeFailures < HEALTH_PROBE_GRACE) return; // 单次瞬时失败保留旧状态，避免托盘乱闪
    }
    healthProbeFailures = 0;
    const hadLevel = securityLevel !== null;
    const wasHealthy = healthy;
    healthy = false;
    securityLevel = null; // 不冒充旧档位；cloudName 保留，避免名字闪烁
    if (wasHealthy || hadLevel) updateTray();
    return;
  }
  healthProbeFailures = 0;
  let changed = false;
  if (!healthy) {
    healthy = true;
    changed = true;
  }
  const [level, runtimeIdentity] = await Promise.all([
    probeSecurityLevel(fetch, httpConf()),
    probeRuntimeIdentity(fetch, httpConf()),
  ]);
  if (epoch !== trayStateEpoch) return; // 等级/云名探测期间状态又变了：同样不覆盖新状态
  if (level !== null && level !== securityLevel) {
    securityLevel = level;
    changed = true;
  }
  if (runtimeIdentity?.cloudName && runtimeIdentity.cloudName !== cloudName) {
    cloudName = runtimeIdentity.cloudName;
    setWindowTitle();
    changed = true;
  }
  if (changed) updateTray();
}

function trayActions() {
  return {
    // R-1 高-4：壳内入口一律带 ?shell=desktop（控制台据此收编终端指令/显示返回向导）
    // 导航入口全部原地切换：console 已加载不再 loadURL（刷新会丢当前视图/弹层）。
    'open-console': () => { void navigateConsole('map'); },
    // E2-B：托盘「管理忆云…」→ 设置·忆云卡（MVP 不做二级菜单）
    'manage-clouds': () => { void navigateConsole('clouds'); },
    // S3：只读等级行 → 打开控制台安全卡（不做壳内写操作）
    'security-level': () => { void navigateConsole('security'); },
    'connect-assistants': () => { void navigateConsole('assistants'); },
    'add-device': () => { void navigateConsole('invite'); },
    'open-wizard': () => { showWindow(); void loadWizardView(); },
    'daemon-start': () => { void ensure().then(() => showConsoleWithRetry()); },
    'daemon-stop': () => { void confirmStop(); },
    'daemon-restart': () => { void confirmRestart(); },
    'open-logs': () => { shell.openPath(join(home, 'serve.log')).catch(() => undefined); },
    [LOGIN_ITEM_ID]: (item) => { app.setLoginItemSettings({ openAtLogin: Boolean(item.checked) }); updateTray(); },
    quit: () => { void confirmQuit(); },
  };
}

function updateTray() {
  if (!tray || (typeof tray.isDestroyed === 'function' && tray.isDestroyed())) return;
  // 图标 = 品牌星章（状态语义在 tooltip 与菜单；不再分色）
  tray.setImage(trayImage());
  const tooltip = t('tray.tooltip', { status: trayStatusLine({ healthy, daemonMode, cloudName }, t) });
  tray.setToolTip(tooltip);
  // R-1 中-9：分组菜单模型（lifecycle.mjs 纯数据）→ 绑定 click 后交给 Electron
  const actions = trayActions();
  const loginChecked = (() => { try { return Boolean(app.getLoginItemSettings().openAtLogin); } catch { return false; } })();
  const model = trayMenuModel({ healthy, daemonMode, loginOpenAtLogin: loginChecked, securityLevel, cloudName }, t);
  // 自动化/手工验收：仅在显式指定快照路径时落盘托盘真值（默认不写、不影响运行）。
  if (process.env.MEBULAR_TRAY_SNAPSHOT) {
    try {
      writeFileSync(process.env.MEBULAR_TRAY_SNAPSHOT, JSON.stringify({
        locale: desktopI18n.locale,
        tooltip,
        menu: model.map((item) => (item.type === 'separator'
          ? { type: 'separator' }
          : { id: item.id, label: item.label, type: item.type ?? 'normal', enabled: item.enabled !== false, checked: item.checked ?? null })),
        at: Date.now(),
      }, null, 2));
    } catch {
      // 快照写盘失败不阻断托盘刷新。
    }
  }
  const template = model.map((item) => {
    if (item.type === 'separator') return item;
    const { id, confirm: _confirm, ...rest } = item;
    return { ...rest, click: actions[id] ? (_menuItem) => actions[id](_menuItem) : undefined };
  });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

/** 重启守护本体（F1：不导航；托盘「重启」的导航由 confirmRestart 显式追加）。 */
async function restart() {
  if (daemonChild) { stopManaged(daemonChild); daemonChild = null; }
  markTrayStateChanged();
  healthy = false; daemonMode = null; securityLevel = null; updateTray();
  await new Promise((r) => setTimeout(r, 800));
  await ensure();
}

function createTray() {
  tray = new Tray(trayImage());
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

/** 打开向导页：先清渲染层磁盘缓存再加载。
 *  file:// 下 **ESM 模块也会进缓存**——页级 ?t= 只能防 HTML 复活，
 *  wizard.js / wizard-view.mjs 的 import URL 没有参数，必须清缓存才不回落旧版（走查事故：混合新旧渲染）。 */
async function loadWizardView() {
  try { await session.defaultSession.clearCache(); } catch { /* 清缓存失败不阻断加载 */ }
  await safeLoad(wizardViewUrl());
}

/** 审批走**主进程直调** @mebular/service（不经 HTTP 写端点，避免 CSRF/token 复杂度）。 */
async function installServiceDirect() {
  if (process.env.MEBULAR_DESKTOP_DRY_RUN === '1') {
    return { ok: true, dryRun: true, note: '（DRY_RUN）将调用 @mebular/service installService', home };
  }
  const appRuntime = await resolveAppServiceRuntime({ cliBin, cloudRoot });
  const runtimeService = await loadRuntimeServiceModule();
  const service = await loadServiceModule();
  if (runtimeService?.installRuntimeService && typeof cloudRoot === 'string' && cloudRoot.length > 0) {
    try {
      const status = await runtimeService.runtimeServiceStatus({
        root: cloudRoot,
        home,
        serviceHome,
        fallbackProvider: appRuntime.source,
        ...(service ? { serviceLib: service } : {}),
      });
      // F2b 幂等：已注册 → no-op（不重写 plist、不重启守护）。
      if (status.ok === true && installDecision(status).already) {
        return { ok: true, already: true, registered: true, running: Boolean(status.running), unitPath: status.unitPath ?? null };
      }
      const res = await runtimeService.installRuntimeService({
        root: cloudRoot,
        home,
        serviceHome,
        http: httpConf(),
        fallbackProvider: appRuntime.source,
        autostart: true,
        ...(service ? { serviceLib: service } : {}),
      });
      if (res?.ok !== true) {
        return { ok: false, reason: res?.message ?? res?.reason ?? 'service_install_failed', current: res?.current ?? null };
      }
      return {
        ok: true,
        already: res.already === true,
        registered: true,
        unitPath: res.unitPath ?? null,
        runtime: res.runtime ?? null,
        current: res.current ?? null,
      };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }
  // fail-safe：current 存在而 runtime-service 不可用时，绝不用 App descriptor 覆盖共享 service。
  const blocked = appServiceFallbackBlock({ cloudRoot, runtimeServiceAvailable: false });
  if (blocked !== null) return blocked;
  const fallbackService = await loadServiceModule();
  if (!fallbackService?.installService) return { ok: false, reason: '@mebular/service 不可用' };
  const descriptor = serviceDescriptorFor({
    home,
    cliBin: appRuntime.source.cliPath,
    execPath: process.execPath,
    http: httpConf(),
    cloudRoot,
    runtime: appRuntime.source,
  });
  try {
    // F2b 幂等：已注册 → no-op（不重写 plist、不重启守护——重装会把健康瞬断、① 翻回未完成）
    const status = fallbackService.serviceStatus?.(descriptor, { home: serviceHome });
    if (installDecision(status).already) {
      return { ok: true, already: true, registered: true, running: Boolean(status.running), unitPath: status.unitPath ?? null };
    }
    return await installLegacyAppService({
      service: fallbackService,
      descriptor,
      cloudRoot,
      serviceHome,
      autostart: true,
      runtimeServiceAvailable: false,
    });
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
  // UX-2：邀请不再驱动向导完成（移出引导）；仍留痕于壳层状态文件（事实记录，非配置）
  if (res.token) writeDesktopState(home, { inviteCreated: true, inviteCreatedAt: new Date().toISOString() });
  return { ...res, text: inviteText(res), raw: null };
}

// ---------- E2-B：忆云运行时 / 切换 / 深链 ----------

function cloudSettingsUrl() {
  return shellDeepLink(`${consoleUrl(httpConf())}?view=settings&focus=clouds`);
}

function setWindowTitle() {
  if (!win || win.isDestroyed()) return;
  win.setTitle(cloudName ? `${t('app.windowTitle')} · ${cloudName}` : t('app.windowTitle'));
}

/** 从注册表重读当前项，更新 home / id / name（切换成功的唯一真源是注册表 current）。 */
async function refreshCloudIdentity() {
  if (!cloudModules || !cloudRoot) return null;
  const state = await cloudModules.profiles.readRegistry(cloudRoot);
  const current = state.registry.profiles.find((profile) => profile.id === state.registry.current) ?? null;
  if (current) {
    home = cloudModules.profiles.profileHomeForEntry(cloudRoot, current);
    cloudId = current.id;
    cloudName = current.name;
  }
  return { state, current };
}

/** 启动时把旧单 home 服务单元迁到 OS home 归属（保留 autostart；current 可用时指向共享 runtime）。 */
async function migrateCurrentCloudService() {
  if (!cloudModules || !cloudRoot) return null;
  // 崩溃恢复刚拉起的 child 占着端口：先不迁移服务，避免两套守护抢同一端口。
  if (daemonChild) return null;
  const service = await loadServiceModule();
  if (!service?.serviceStatus) return null;
  try {
    const result = await migrateLegacyService({
      service,
      runtimeService: cloudModules.runtime ?? null,
      fallbackProvider: appFallbackProvider({ cliBin }),
      descriptor: serviceDescriptorFor({ home, cliBin, http: httpConf(), cloudRoot }),
      root: cloudRoot,
      cliBin,
      home,
      serviceHome,
      http: httpConf(),
      fetchImpl: fetch,
    });
    if (result.migrated) {
      console.log(`[desktop] 已迁移旧守护服务到 ${serviceHome}（autostart=${result.autostart}）`);
    }
    return result;
  } catch (error) {
    console.log(`[desktop] 旧守护服务迁移失败（继续用现有方式）：${error?.message ?? error}`);
    return { migrated: false, error: String(error?.message ?? error) };
  }
}

/**
 * 启动期：解析 root/current → 崩溃恢复 switch.intent → 迁移旧服务。
 * 外部自定义 home / 受限 env：cloudRoot=null，壳照常运行（忆云管理不可用）。
 */
async function initCloudState() {
  try {
    cloudModules = await loadCloudModules(cliBin);
  } catch (error) {
    cloudUnavailable = `忆云模块不可用：${error?.message ?? error}`;
    return;
  }
  let resolved = null;
  try {
    resolved = cloudModules.profiles.resolveCloudRoot({ home, env: process.env });
  } catch (error) {
    cloudUnavailable = `忆云根目录无法解析：${error?.message ?? error}`;
    return;
  }
  if (!resolved?.available) {
    cloudUnavailable = '当前为自定义 home 或受限环境，忆云管理不可用';
    return;
  }
  cloudRoot = resolved.root;
  // 共享 Runtime 发现：注册 kind:app provider（路径/版本/能力），供 CLI/Plugin 启动/attach；
  // 只告警不阻塞启动；自定义 home（cloudRoot 不可用）时不注册。
  const runtimeProvider = await registerAppRuntimeProvider({ cloudRoot, cliBin });
  if (!runtimeProvider.ok) {
    console.log(`[desktop] runtime provider 注册失败（不阻塞启动）：${runtimeProvider.error ?? runtimeProvider.reason ?? '未知原因'}`);
  }
  try {
    const state = await cloudModules.profiles.readRegistry(cloudRoot);
    const current = state.registry.profiles.find((profile) => profile.id === state.registry.current) ?? null;
    if (current) {
      home = cloudModules.profiles.profileHomeForEntry(cloudRoot, current);
      cloudId = current.id;
      cloudName = current.name;
    }
  } catch (error) {
    cloudUnavailable = `忆云注册表无法读取（${error?.code ?? 'ERROR'}）：${error?.message ?? error}`;
    return;
  }

  const service = (await loadServiceModule()) ?? {};
  try {
    const recovery = await recoverSwitchIntent({
      root: cloudRoot,
      cliBin,
      service,
      runtimeService: cloudModules.runtime ?? null,
      fallbackProvider: appFallbackProvider({ cliBin }),
      serviceHome,
      modules: cloudModules,
      fetchImpl: fetch,
      spawnFn: (exec, args, opts) => spawnChild(exec, args, opts),
      env: process.env,
    });
    if (recovery.recovered) {
      if (recovery.home) home = recovery.home;
      if (recovery.mode) daemonMode = recovery.mode;
      if (recovery.child) daemonChild = recovery.child;
      if (recovery.status === 'committed') {
        console.log('[desktop] 崩溃恢复：目标忆云已健康，切换按成功处理');
      } else if (recovery.status === 'rolled_back') {
        console.log('[desktop] 崩溃恢复：目标未就绪，已回到旧忆云');
      } else if (recovery.status === 'diagnostics') {
        startupDiagnostic = recovery.message;
        console.log(`[desktop] ${recovery.message}`);
      }
    }
  } catch (error) {
    console.log(`[desktop] 崩溃恢复失败（保留 intent/档案）：${error?.message ?? error}`);
  }

  await migrateCurrentCloudService();
  try {
    await refreshCloudIdentity();
  } catch {
    // 注册表刚恢复/损坏：沿用已有 home，后续列表会给出可读错误
  }
}

async function cloudListNow() {
  if (!cloudModules || !cloudRoot) {
    return {
      ok: false,
      available: false,
      error: 'CLOUD_UNAVAILABLE',
      message: cloudUnavailable ?? '忆云管理不可用；当前忆云未变',
    };
  }
  try {
    const state = await cloudModules.profiles.readRegistry(cloudRoot);
    const current = state.registry.current;
    return {
      ok: true,
      available: true,
      root: cloudRoot,
      current,
      profiles: state.registry.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        home: profile.home,
        kind: profile.kind,
        createdAt: profile.createdAt ?? null,
        lastUsedAt: profile.lastUsedAt ?? null,
        nameUpdatedAt: profile.nameUpdatedAt ?? null,
        masterFingerprint: profile.masterFingerprint ?? null,
        deviceId: profile.deviceId ?? null,
        current: profile.id === current,
      })),
      ...(state.warning ? { warning: state.warning } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      available: true,
      error: error?.code ?? 'CLOUD_LIST_FAILED',
      message: String(error?.message ?? error),
    };
  }
}

/** 控制台 A2 的 cloudSwitch 桥：主进程停旧/起新/校验/回滚，成功后重载控制台。 */
async function cloudSwitchNow(rawId) {
  const id = String(rawId ?? '');
  if (!cloudModules || !cloudRoot) {
    throw new Error(cloudUnavailable ?? '忆云管理不可用：当前为自定义 home 或受限环境');
  }
  if (!/^[a-z0-9_]+$/.test(id)) throw new Error('未找到这个忆云；列表可能已变化，请刷新后重试。');
  const service = (await loadServiceModule()) ?? {};
  let result;
  try {
    result = await performCloudSwitch({
      root: cloudRoot,
      id,
      home,
      cliBin,
      service,
      runtimeService: cloudModules.runtime ?? null,
      fallbackProvider: appFallbackProvider({ cliBin }),
      serviceHome,
      modules: cloudModules,
      fetchImpl: fetch,
      spawnFn: (exec, args, opts) => spawnChild(exec, args, opts),
      env: process.env,
      managedChild: daemonChild,
      probePort: (http) => isPortOpen(http),
    });
  } catch (error) {
    // 回滚成功时引擎会重新拉起旧守护：把返回的 child 收编，避免脱离 App 生命周期。
    if (Object.prototype.hasOwnProperty.call(error, 'child')) daemonChild = error.child;
    if (error.mode) daemonMode = error.mode;
    markTrayStateChanged();
    securityLevel = null;
    healthy = (await probeHealthDetail(fetch, httpConf(), { expectedInstance: homeKey(home) })).ok;
    try { await refreshCloudIdentity(); } catch { /* 保留旧值 */ }
    updateTray();
    setWindowTitle();
    if (healthy) {
      await showConsoleWithRetry();
    } else if (win && !win.isDestroyed()) {
      await safeLoad(loadingHtml(shellMessage(error?.message, 'loading.cloudSwitchFailed')));
    }
    throw error;
  }
  if (!result.changed) {
    // 当前忆云不可切换：不改 home/守护状态，也不重载控制台。
    return {
      ok: true,
      changed: false,
      current: result.current,
      previous: null,
      home,
      name: result.profile?.name ?? cloudName,
    };
  }
  home = result.home;
  await refreshCloudIdentity();
  if (result.profile?.name) cloudName = result.profile.name;
  reloadDesktopLocale();
  markTrayStateChanged();
  daemonChild = result.child ?? null;
  daemonMode = result.mode ?? (result.child ? 'child' : 'service');
  healthy = true;
  securityLevel = null;
  updateTray();
  setWindowTitle();
  // 切换成功：控制台必须重载到新 home 的端口；updateTray 已先刷新名称/状态。
  await showConsoleWithRetry();
  return {
    ok: true,
    changed: Boolean(result.changed),
    current: result.current,
    previous: result.previous ?? null,
    home: result.home,
    name: result.profile?.name ?? cloudName,
  };
}

// ---------- IPC（白名单） ----------

function registerIpc() {
  const table = buildHandlerTable({
    // 壳层 i18n：locale + catalogs（渲染层用同一套 shared/i18n-core 构造 translator）。
    'locale:get': () => ({
      locale: desktopI18n.locale,
      supportedLocales: desktopI18n.supportedLocales,
      defaultLocale: desktopI18n.defaultLocale,
      fallbackLocale: desktopI18n.fallbackLocale,
      catalogs: desktopI18n.exportCatalogs(),
    }),
    'locale:set': (locale) => ({ locale: applyDesktopLocale(locale, { persist: true }) }),
    'daemon:status': async () => ({
      mode: daemonMode,
      healthy,
      home,
      http: httpConf(),
      cloud: { root: cloudRoot, id: cloudId, name: cloudName, available: Boolean(cloudRoot) },
    }),
    'daemon:start': async () => { await ensure(); return { mode: daemonMode }; }, // F1：向导流水用——只启动，不导航（导航只保留显式 console:open）
    'daemon:stop': () => ({ stopped: stopManaged(daemonChild) }),
    'daemon:restart': async () => { await restart(); return { mode: daemonMode }; }, // F1：只重启，不导航
    'console:open': async () => { await navigateConsole('map'); return { url: shellConsoleUrl() }; },
    'logs:open': async () => { await shell.openPath(join(home, 'serve.log')); return { path: join(home, 'serve.log') }; },
    'app:diagnostics': () => diagnostics({ appVersion: APP_VERSION, electronVersion: process.versions.electron, mode: daemonMode, home, http: httpConf(), healthy }),
    // M2：向导 / 服务托管（主进程直调，不经 HTTP 写端点）/ 日志 / 邀请 / 深链
    'wizard:state': async () => wizardStateNow(),
    'wizard:step': async () => ({ step: (await wizardStateNow()).current }),
    // R-1 高-1：任何时候可「跳过，直接进入控制台」（持久化 skipped → 重启直达控制台）
    'wizard:skip': async () => {
      writeDesktopState(home, { skipped: true, skippedAt: new Date().toISOString() });
      showWindow();
      await safeLoad(consoleUrl(httpConf()));
      return { skipped: true };
    },
    'wizard:open': async () => { showWindow(); await loadWizardView(); return { url: wizardFileUrl() }; },
    // UX-2：段②「已完成」显式确认（持久化 assistantsAcked → 向导完成）
    'wizard:ack': async () => {
      writeDesktopState(home, { assistantsAcked: true, assistantsAckedAt: new Date().toISOString() });
      return { acked: true };
    },
    // UX-2：段②行级接入（主进程直调回环 admin API；id/action 服务端白名单校验）
    'clients:list': async () => clientsViaApi(fetch, httpConf()),
    'clients:action': async (id, action) => clientActionViaApi(fetch, httpConf(), id, action),
    'service:status': async () => probeService(),
    'service:install': async () => installServiceDirect(),
    'logs:read': async () => {
      const svc = await loadServiceModule();
      return readDaemonLogs({
        home,
        service: svc,
        serviceHome,
        descriptor: serviceDescriptorFor({ home, cliBin, http: httpConf(), cloudRoot }),
      });
    },
    'invite:create': async () => createInvite(),
    'deep:assistants': async () => { await navigateConsole('assistants'); return { url: shellDeepLink(deepLinks(httpConf()).assistants) }; },
    'deep:device': async () => { await navigateConsole('invite'); return { url: shellDeepLink(deepLinks(httpConf()).device) }; },
    // E2-B：忆云（列表 / 切换 / 管理深链）。不提供删除。
    'cloud:list': async () => cloudListNow(),
    'cloud:switch': async (id) => cloudSwitchNow(id),
    'cloud:manage': async () => {
      await navigateConsole('clouds');
      return { url: cloudSettingsUrl(), view: 'settings', focus: 'clouds' };
    },
  });
  for (const [channel, handler] of Object.entries(table)) ipcMain.handle(channel, handler);
}

// ---------- 生命周期（单实例 + 退出策略） ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { showWindow(); });

  // R-1 高-2：macOS Dock 点图标 / 重新激活 → 重建/显示窗口
  app.on('activate', () => { showWindow(); });

  app.whenReady().then(async () => {
    applyAppIcon();
    // E2-B：先解析忆云 root/current 并做崩溃恢复，再决定 home/端口与窗口内容。
    try {
      await initCloudState();
    } catch (error) {
      console.log(`[desktop] 忆云初始化失败（壳继续启动）：${error?.message ?? error}`);
    }
    reloadDesktopLocale();
    registerIpc();
    createTray();
    createWindow();
    // 预热退出确认页：首次托盘「退出」直接显示，不再等 BrowserWindow + loadFile。
    try {
      ensureQuitDialog();
    } catch (error) {
      console.log(`[desktop] 退出确认窗口预热失败：${error?.message ?? error}`);
    }
    setWindowTitle();
    // S3：托盘只读等级每 20s 刷新一次（轻量 GET；失败保持旧值，不阻断壳）
    const securityTimer = setInterval(() => { void refreshTrayStatus(); }, 20_000);
    securityTimer.unref?.();
    try {
      if (startupDiagnostic) {
        // 切换崩溃且两张忆云都不健康：只显示诊断，不删 intent/档案，也不猜要起哪张。
        updateTray();
        await safeLoad(loadingHtml(shellMessage(startupDiagnostic, 'loading.notReady')));
        return;
      }
      const ensured = await ensure();
      if (ensured.mode === 'conflict') {
        updateTray();
        await safeLoad(loadingHtml(shellMessage(ensured.message, 'loading.conflict')));
        return;
      }
      const state = await wizardStateNow();
      if (state.complete) {
        await showConsoleWithRetry();
      } else {
        console.log(`[desktop] 未完成首次上手（待办：${state.current}）→ 打开向导`);
        await loadWizardView(); // 清缓存 + 缓存破坏参数：HTML/ESM 双保险（走查事故：旧版向导复活）
        healthy = (await probeHealthDetail(fetch, httpConf(), { expectedInstance: homeKey(home) })).ok;
        updateTray();
        if (healthy) void refreshTrayStatus();
      }
    } catch (error) {
      dialog.showErrorBox(t('startup.error.title'), localizeErrorDetail(error, 'errors.unknown'));
      updateTray();
    }
  });

  app.on('window-all-closed', () => {
    // R-1 高-2：关窗 ≠ 退出。窗口 close 已被拦截为隐藏，这里不做任何事——
    // 守护（任何托管模式）与 App 进程都保持存活；真退出只走托盘「退出」。
  });

  app.on('before-quit', () => {
    if (quitDialog && !quitDialog.isDestroyed()) {
      quitDialog.destroy();
      quitDialog = null;
    }
    stopManaged(daemonChild);
  });
}

export { serviceEnabledFor };
