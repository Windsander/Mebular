// Mebular 桌面 App · IPC 白名单（**不 import electron**，纯逻辑可单测）
//
// 安全红线：renderer 只能调用这里列出的通道；preload 用 contextBridge 暴露固定方法，
// 不透传任意 channel/参数。所有 handler 由 index.mjs 绑定到真实实现。

/** 允许的通道（唯一真源）。 */
export const IPC_CHANNELS = Object.freeze([
  'daemon:status',
  'daemon:start',
  'daemon:stop',
  'daemon:restart',
  'console:open',
  'logs:open',
  'app:diagnostics',
  // M2：三步向导 / 服务托管（主进程直调，不经 HTTP 写端点）/ 日志页 / 邀请
  'wizard:state',
  'wizard:step',
  'service:status',
  'service:install',
  'logs:read',
  'invite:create',
  'deep:assistants',
  'deep:device',
]);

export function isAllowedChannel(channel) {
  return typeof channel === 'string' && IPC_CHANNELS.includes(channel);
}

/** 只允许无参调用（防止 renderer 传任意载荷进主进程）。 */
export function sanitizeArgs(args) {
  return Array.isArray(args) && args.length === 0 ? [] : [];
}

/**
 * 把实现绑定为可注册的 handler 表；只注册白名单内的通道。
 * handlers: { 'daemon:status': fn, ... }
 */
export function buildHandlerTable(handlers = {}) {
  const table = {};
  for (const channel of IPC_CHANNELS) {
    const fn = handlers[channel];
    if (typeof fn === 'function') table[channel] = (event, ...args) => fn(...sanitizeArgs(args));
  }
  return table;
}

/** 诊断信息（本地日志用；不采集遥测、不外联）。 */
export function diagnostics({ appVersion, electronVersion, mode, home, http, healthy }) {
  return {
    app: `@mebular/desktop@${appVersion}`,
    electron: electronVersion ?? null,
    node: process.versions?.node ?? null,
    platform: process.platform,
    arch: process.arch,
    daemon: { mode: mode ?? null, home: home ?? null, http: http ?? null, healthy: Boolean(healthy) },
    at: new Date().toISOString(),
  };
}
