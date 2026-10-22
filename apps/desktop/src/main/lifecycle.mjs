// R-1 · 壳层生命周期纯逻辑（**不 import electron**，可单测）：
// 关窗决策 / 退出确认文案 / 托盘菜单模型。index.mjs（薄壳）把模型绑定到真实 Electron API。
//
// i18n：所有面向用户的文案来自 locales/<locale>/desktop.json，由调用方传入 translator（t）。
// 本模块不内置中文替换表；未传 t 时回退 key（测试 / 新调用方必须显式传 zh 或 en translator）。

/** 托盘「登录时启动」项 id（index.mjs 据此绑定 app.setLoginItemSettings）。 */
export const LOGIN_ITEM_ID = 'login-open-at-login';

const keyOnly = (key) => String(key);

/**
 * 关窗决策（高-2）：点红叉 = 隐藏窗口（守护不动）；只有托盘「退出」走完确认才真退。
 * @returns {'hide' | 'quit'}
 */
export function closeAction({ quitting } = {}) {
  return quitting ? 'quit' : 'hide';
}

/** 退出确认结果 → 动作：只有明确确认（true）才 quit；取消 / 关闭 / 无结果都留在 App。 */
export function quitDecision({ confirmed } = {}) {
  return confirmed === true ? 'quit' : 'cancel';
}

/**
 * 退出确认文案（高-2）：**仅当壳确实托管守护**（child 子进程模式）才声明
 * 「将停止本机 Mebular 守护」；reused（外部已跑）/ service（launchd 常驻）退出不影响守护，不得谎称。
 */
export function quitConfirm({ daemonMode, hasManagedChild } = {}, t = keyOnly) {
  const stopsDaemon = daemonMode === 'child' && Boolean(hasManagedChild);
  return {
    stopsDaemon,
    message: stopsDaemon
      ? t('quit.message.stopsDaemon')
      : t('quit.message.keepsDaemon'),
    buttons: [t('quit.cancel'), t('quit.confirm')],
    confirmIndex: 1,
  };
}

/** 停止/重启确认文案（中-9）：同样只在 child 托管时才声明停守护。 */
export function stopConfirm({ daemonMode, hasManagedChild } = {}, t = keyOnly) {
  const stopsDaemon = daemonMode === 'child' && Boolean(hasManagedChild);
  return {
    stopsDaemon,
    message: stopsDaemon
      ? t('stop.message.stopsDaemon')
      : t('stop.message.external'),
    canStop: stopsDaemon,
  };
}

/** daemonMode → 人话（托盘不得展示裸 child/reused/service）。 */
export function daemonModeLabel(mode, t = keyOnly) {
  switch (mode) {
    case 'child': return t('tray.mode.child');
    case 'service': return t('tray.mode.service');
    case 'reused': return t('tray.mode.reused');
    default: return t('tray.mode.none');
  }
}

/** 状态行：圆点 + 运行/启动/未运行语义 + 人话托管方式 + 忆云名（菜单与 tooltip 共用）。 */
export function trayStatusLine({ healthy = false, daemonMode = null, cloudName = null } = {}, t = keyOnly) {
  const state = healthy
    ? t('tray.status.running')
    : daemonMode ? t('tray.status.starting') : t('tray.status.stopped');
  const label = daemonModeLabel(daemonMode, t);
  const mode = daemonMode && label !== t('tray.mode.none') ? ` · ${label}` : '';
  return `${healthy ? '●' : '○'} ${state}${mode}${cloudName ? ` · ${cloudName}` : ''}`;
}

/**
 * 托盘菜单模型（中-9 分组：导航 / 守护控制 / 诊断 / 登录时启动 / 退出）。
 * 返回纯数据模板；index.mjs 按 id 绑定 click，再交给 Menu.buildFromTemplate。
 */
export function trayMenuModel({
  healthy, daemonMode, loginOpenAtLogin, securityLevel = null, cloudName = null,
} = {}, t = keyOnly) {
  const statusLabel = trayStatusLine({ healthy, daemonMode, cloudName }, t);
  const levelLabel = securityLevel === 'high'
    ? t('tray.security.level.high')
    : securityLevel === 'medium'
      ? t('tray.security.level.medium')
      : securityLevel === 'low'
        ? t('tray.security.level.low')
        : t('tray.security.level.unknown');
  return [
    { id: 'status', label: statusLabel, enabled: false },
    // S3：只读等级行；点击只打开控制台安全卡（壳内不做任何安全写操作）
    { id: 'security-level', label: t('tray.security.label', { level: levelLabel }), enabled: securityLevel !== null },
    { type: 'separator' },
    { id: 'open-console', label: t('tray.menu.openConsole') },
    // E2-B：MVP 不做二级菜单；跳设置·忆云卡（归档/切换都在控制台完成）
    { id: 'manage-clouds', label: t('tray.menu.manageClouds') },
    { id: 'connect-assistants', label: t('tray.menu.connectAssistants') },
    { id: 'add-device', label: t('tray.menu.addDevice') },
    { id: 'open-wizard', label: t('tray.menu.openWizard') },
    { type: 'separator' },
    { id: 'daemon-start', label: t('tray.menu.start'), enabled: !healthy },
    { id: 'daemon-stop', label: t('tray.menu.stop'), enabled: healthy, confirm: true },
    { id: 'daemon-restart', label: t('tray.menu.restart'), confirm: true },
    { type: 'separator' },
    { id: 'open-logs', label: t('tray.menu.openLogs') },
    { type: 'separator' },
    { id: LOGIN_ITEM_ID, label: t('tray.menu.loginAtLogin'), type: 'checkbox', checked: Boolean(loginOpenAtLogin) },
    { type: 'separator' },
    { id: 'quit', label: t('tray.menu.quit') },
  ];
}
