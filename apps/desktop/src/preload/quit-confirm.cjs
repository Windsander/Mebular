// 退出确认窗口 · preload（contextIsolation + sandbox；只暴露两个固定动作）
//
// 安全红线：不透传任意 channel / 参数。renderer 只能接收主进程给的确认文案，
// 并回答「确认退出 / 取消」；回答值在主进程再强转布尔。

const { contextBridge, ipcRenderer } = require('electron');

let planCallback = null;
let pendingPlan = null;
ipcRenderer.on('quit-confirm:plan', (_event, plan) => {
  if (!plan || typeof plan !== 'object') return;
  if (planCallback) planCallback(plan);
  else pendingPlan = plan;
});

contextBridge.exposeInMainWorld('mebularQuit', {
  onPlan: (callback) => {
    if (typeof callback !== 'function') return;
    planCallback = callback;
    if (pendingPlan) {
      const plan = pendingPlan;
      pendingPlan = null;
      queueMicrotask(() => callback(plan));
    }
  },
  answer: (confirmed) => ipcRenderer.send('quit-confirm:answer', confirmed === true),
});
