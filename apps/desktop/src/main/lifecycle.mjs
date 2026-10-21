// R-1 · 壳层生命周期纯逻辑（**不 import electron**，可单测）：
// 关窗决策 / 退出确认文案 / 托盘菜单模型。index.mjs（薄壳）把模型绑定到真实 Electron API。

/** 托盘「登录时启动」项 id（index.mjs 据此绑定 app.setLoginItemSettings）。 */
export const LOGIN_ITEM_ID = 'login-open-at-login';

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
export function quitConfirm({ daemonMode, hasManagedChild } = {}) {
  const stopsDaemon = daemonMode === 'child' && Boolean(hasManagedChild);
  return {
    stopsDaemon,
    message: stopsDaemon
      ? '退出 Mebular 将停止本机 Mebular 守护（由本 App 拉起的临时进程）。常驻服务/外部守护不受影响。'
      : '退出 Mebular 桌面壳。本机守护不由本 App 托管，退出后照常运行。',
    buttons: ['取消', '退出'],
    confirmIndex: 1,
  };
}

/** 停止/重启确认文案（中-9）：同样只在 child 托管时才声明停守护。 */
export function stopConfirm({ daemonMode, hasManagedChild } = {}) {
  const stopsDaemon = daemonMode === 'child' && Boolean(hasManagedChild);
  return {
    stopsDaemon,
    message: stopsDaemon
      ? '停止本机 Mebular 守护（由本 App 拉起的临时进程）？控制台将不可用，托盘可重启。'
      : '当前守护由服务/外部托管，本 App 无法停止；如需停止请用系统服务管理器。',
    canStop: stopsDaemon,
  };
}

/** daemonMode → 人话（托盘不得展示裸 child/reused/service）。 */
export function daemonModeLabel(mode) {
  switch (mode) {
    case 'child': return '临时运行（App 托管）';
    case 'service': return '常驻服务';
    case 'reused': return '已有守护';
    default: return '未运行';
  }
}

/** 状态行：圆点 + 运行/启动/未运行语义 + 人话托管方式 + 忆云名（菜单与 tooltip 共用）。 */
export function trayStatusLine({ healthy = false, daemonMode = null, cloudName = null } = {}) {
  const state = healthy ? '运行中' : daemonMode ? '启动中' : '未运行';
  const label = daemonModeLabel(daemonMode);
  const mode = daemonMode && label !== '未运行' ? ` · ${label}` : '';
  return `${healthy ? '●' : '○'} ${state}${mode}${cloudName ? ` · ${cloudName}` : ''}`;
}

/**
 * 托盘菜单模型（中-9 分组：导航 / 守护控制 / 诊断 / 登录时启动 / 退出）。
 * 返回纯数据模板；index.mjs 按 id 绑定 click，再交给 Menu.buildFromTemplate。
 */
export function trayMenuModel({ healthy, daemonMode, loginOpenAtLogin, securityLevel = null, cloudName = null } = {}) {
  const statusLabel = trayStatusLine({ healthy, daemonMode, cloudName });
  const levelLabel = securityLevel === 'high' ? '高' : securityLevel === 'medium' ? '中' : securityLevel === 'low' ? '低' : '—';
  return [
    { id: 'status', label: statusLabel, enabled: false },
    // S3：只读等级行；点击只打开控制台安全卡（壳内不做任何安全写操作）
    { id: 'security-level', label: `安全等级：${levelLabel}`, enabled: securityLevel !== null },
    { type: 'separator' },
    { id: 'open-console', label: '打开控制台' },
    // E2-B：MVP 不做二级菜单；跳设置·忆云卡（归档/切换都在控制台完成）
    { id: 'manage-clouds', label: '管理忆云…' },
    { id: 'connect-assistants', label: '连接 AI 助手' },
    { id: 'add-device', label: '邀请设备' },
    { id: 'open-wizard', label: '重启向导' },
    { type: 'separator' },
    { id: 'daemon-start', label: '启动', enabled: !healthy },
    { id: 'daemon-stop', label: '停止', enabled: healthy, confirm: true },
    { id: 'daemon-restart', label: '重启', confirm: true },
    { type: 'separator' },
    { id: 'open-logs', label: '打开日志' },
    { type: 'separator' },
    { id: LOGIN_ITEM_ID, label: '登录时启动', type: 'checkbox', checked: Boolean(loginOpenAtLogin) },
    { type: 'separator' },
    { id: 'quit', label: '退出 Mebular' },
  ];
}
