// Mebular 桌面 App · preload（contextIsolation + sandbox；只暴露固定白名单方法）
//
// 安全红线：不透传任意 channel / 参数；renderer 只能调用下列方法。

const { contextBridge, ipcRenderer } = require('electron');

// 主进程 → 控制台原地导航：固定单通道，只接收 query（不接受 URL）。
// 页面脚本注册回调前到达的导航先缓冲一次，避免控制台刚加载时的点击丢失。
let consoleNavCallback = null;
let pendingConsoleNavSearch = null;
ipcRenderer.on('console:navigate', (_event, payload) => {
  const search = typeof payload?.search === 'string' && payload.search.startsWith('?') ? payload.search : null;
  if (!search) return;
  if (consoleNavCallback) consoleNavCallback(search);
  else pendingConsoleNavSearch = search;
});

contextBridge.exposeInMainWorld('mebularDesktop', {
  // UX-2 补丁 4：平台标识（渲染层据此避让 macOS 交通灯安全区；静态值，非函数）
  platform: process.platform,
  status: () => ipcRenderer.invoke('daemon:status'),
  start: () => ipcRenderer.invoke('daemon:start'),
  stop: () => ipcRenderer.invoke('daemon:stop'),
  restart: () => ipcRenderer.invoke('daemon:restart'),
  openConsole: () => ipcRenderer.invoke('console:open'),
  // 托盘原地导航（固定通道；主进程只发已知 query，控制台复用启动深链的应用函数）
  onConsoleNavigate: (callback) => {
    if (typeof callback !== 'function') return () => {};
    consoleNavCallback = callback;
    if (pendingConsoleNavSearch) {
      const search = pendingConsoleNavSearch;
      pendingConsoleNavSearch = null;
      queueMicrotask(() => callback(search));
    }
    return () => {
      if (consoleNavCallback === callback) consoleNavCallback = null;
    };
  },
  openLogs: () => ipcRenderer.invoke('logs:open'),
  diagnostics: () => ipcRenderer.invoke('app:diagnostics'),
  // M2：三步向导 / 服务托管 / 日志页 / 邀请（全部固定方法，不透传任意通道）
  wizardState: () => ipcRenderer.invoke('wizard:state'),
  wizardStep: (step) => ipcRenderer.invoke('wizard:step', String(step ?? '')),
  // R-1：跳过向导直达控制台（持久化）/ 返回向导
  skipWizard: () => ipcRenderer.invoke('wizard:skip'),
  openWizard: () => ipcRenderer.invoke('wizard:open'),
  // UX-2：段②「已完成」确认 / 行级接入（助手列表 + 接入动作；id/action 主进程强转字符串、服务端白名单校验）
  ackAssistants: () => ipcRenderer.invoke('wizard:ack'),
  clientsList: () => ipcRenderer.invoke('clients:list'),
  clientsAction: (id, action) => ipcRenderer.invoke('clients:action', String(id ?? ''), String(action ?? '')),
  serviceStatus: () => ipcRenderer.invoke('service:status'),
  serviceInstall: () => ipcRenderer.invoke('service:install'),
  readLogs: () => ipcRenderer.invoke('logs:read'),
  createInvite: () => ipcRenderer.invoke('invite:create'),
  deepAssistants: () => ipcRenderer.invoke('deep:assistants'),
  deepDevice: () => ipcRenderer.invoke('deep:device'),
  // E2-B：忆云（列表只读 / 切换由主进程停旧起新 / 管理深链到设置·忆云卡）
  cloudList: () => ipcRenderer.invoke('cloud:list'),
  cloudSwitch: (id) => ipcRenderer.invoke('cloud:switch', String(id ?? '')),
  cloudManage: () => ipcRenderer.invoke('cloud:manage'),
});
