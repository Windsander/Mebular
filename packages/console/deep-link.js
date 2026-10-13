// 控制台深链解析（纯函数，无 DOM 依赖）：?view= / ?step=device / ?shell=desktop
// console.js 启动时消费；单测直接覆盖映射表（R-1 高-3/高-4）。

/** 合法视图（唯一真源；与 setView 的面板一一对应）。 */
export const CONSOLE_VIEWS = Object.freeze(['map', 'domains', 'audit', 'memories', 'connect']);

/**
 * 从 location.search 解析初始视图与壳标志。
 * @returns {{ view: string|null, openInvite: boolean, shellDesktop: boolean }}
 *   view 为 null 表示回退默认（map）；openInvite=true 表示进入连接页后自动开「邀请新设备」。
 */
export function initialViewFromSearch(search) {
  const params = new URLSearchParams(String(search ?? ''));
  const view = params.get('view');
  return {
    view: CONSOLE_VIEWS.includes(view) ? view : null,
    openInvite: params.get('view') === 'connect' && params.get('step') === 'device',
    shellDesktop: params.get('shell') === 'desktop',
  };
}
