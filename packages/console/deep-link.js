// 控制台深链解析（纯函数，无 DOM 依赖）：?view= / ?step=device / ?shell=desktop
// console.js 启动时消费；单测直接覆盖映射表（R-1 高-3/高-4）。
// UX-2：连接页收编进「设置 · AI 助手」，`?view=connect` 保留为**别名重定向**（打开设置弹层助手页）。

/** 合法视图（唯一真源；与 setView 的面板一一对应）。 */
export const CONSOLE_VIEWS = Object.freeze(['map', 'domains', 'audit', 'memories']);

/**
 * 从 location.search 解析初始视图、设置弹层目标与壳标志。
 * @returns {{ view: string|null, openSettings: string|null, openInvite: boolean, focusSecurity: boolean, focusClouds: boolean, shellDesktop: boolean }}
 *   view 为 null 表示回退默认（map）；openSettings='assistants' 表示启动后打开设置弹层 AI 助手页
 *   （?view=connect 的别名重定向）；?view=settings 打开设置（常用），focusSecurity 直达安全卡，
 *   focusClouds 滚到「忆云」卡（托盘「管理忆云…」入口）；openInvite=true 表示随后自动开「邀请设备」。
 */
export function initialViewFromSearch(search) {
  const params = new URLSearchParams(String(search ?? ''));
  const view = params.get('view');
  const stepDevice = view === 'connect' && params.get('step') === 'device';
  const settingsView = view === 'settings';
  const tab = params.get('tab');
  const focus = params.get('focus');
  const focusSecurity = settingsView && focus === 'security';
  const focusClouds = settingsView && focus === 'clouds';
  return {
    view: CONSOLE_VIEWS.includes(view) ? view : null,
    // ?view=connect → 设置 · AI 助手；带 step=device 则直达「邀请设备」单动作弹层（不开设置）
    // ?view=settings → 设置（默认常用；focus=security 直达「安全」tab / focus=clouds 滚到忆云卡）
    openSettings: settingsView
      ? (focusSecurity ? 'security' : (tab === 'assistants' || tab === 'advanced' || tab === 'mcp' ? tab : 'common'))
      : view === 'connect' && !stepDevice ? 'assistants' : null,
    openInvite: stepDevice,
    focusSecurity,
    focusClouds,
    shellDesktop: params.get('shell') === 'desktop',
  };
}
