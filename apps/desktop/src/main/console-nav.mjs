// 控制台原地导航（纯逻辑，不 import electron）：托盘点击只允许落到固定目标，
// 已加载控制台时由主进程发 IPC、控制台自己切视图/开弹层；未加载时才真正 loadURL。
// 安全红线：目标键固定，不接受调用方传入任意 URL / query。

/** 托盘可导航的控制台目标（唯一真源；与 console.js 的 deep-link 语义一一对应）。 */
export const CONSOLE_NAV_TARGETS = Object.freeze({
  map: Object.freeze({ view: 'map' }),
  clouds: Object.freeze({ view: 'settings', focus: 'clouds' }),
  security: Object.freeze({ view: 'settings', focus: 'security' }),
  assistants: Object.freeze({ view: 'connect' }),
  invite: Object.freeze({ view: 'connect', step: 'device' }),
});

/** 目标 → 控制台 query（含前导 `?`）；未知目标返回 null。 */
export function consoleNavSearch(target) {
  const spec = Object.prototype.hasOwnProperty.call(CONSOLE_NAV_TARGETS, target)
    ? CONSOLE_NAV_TARGETS[target]
    : null;
  if (!spec) return null;
  const params = new URLSearchParams();
  params.set('view', spec.view);
  if (spec.focus) params.set('focus', spec.focus);
  if (spec.step) params.set('step', spec.step);
  return `?${params.toString()}`;
}

/** 目标 → 完整控制台 URL；未知目标返回 null。 */
export function consoleNavUrl(baseUrl, target) {
  const search = consoleNavSearch(target);
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  return search && base ? `${base}${search}` : null;
}

/**
 * 当前 webContents 是否已经停在控制台页（同 origin + /console 路径）。
 * 是 → 只发导航事件；否（向导 / loading / 其他）→ 才允许 loadURL 一次。
 */
export function isConsoleUrl(pageUrl, baseUrl) {
  try {
    const page = new URL(String(pageUrl));
    const base = new URL(String(baseUrl));
    if (page.origin !== base.origin) return false;
    return page.pathname === '/console' || page.pathname === '/console/';
  } catch {
    return false;
  }
}
