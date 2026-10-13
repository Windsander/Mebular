// Mebular 桌面 App · preload（contextIsolation + sandbox；只暴露固定白名单方法）
//
// 安全红线：不透传任意 channel / 参数；renderer 只能调用下列方法。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mebularDesktop', {
  status: () => ipcRenderer.invoke('daemon:status'),
  start: () => ipcRenderer.invoke('daemon:start'),
  stop: () => ipcRenderer.invoke('daemon:stop'),
  restart: () => ipcRenderer.invoke('daemon:restart'),
  openConsole: () => ipcRenderer.invoke('console:open'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  diagnostics: () => ipcRenderer.invoke('app:diagnostics'),
});
