// UX-2 补丁 3 增补 · 助手状态投影**单一真源**（纯函数，无 DOM/node 依赖）。
// 消费方：设置 · AI 助手（packages/console/assistants.js）与桌面向导（wizard-view.mjs
// 相对路径 import）——两面投影一致由快照断言守护（tests/）。
//
// 语义铁律（修复"服务端已接入、UI 永远待生效"的黏性态事故）：
//   1. 状态词永远跟**服务端真值**走：list state=connected → 「已接入 ✓」；
//      任何客户端"刚写入"记忆（reloadHint）**不得**把它覆盖成「待生效」。
//   2. 「待生效」唯一的正当来源 = 服务端 verify 结果 pending-restart
//      （配置已落面、运行时未生效——用户还没重载助手）。
//   3. 重载提醒走**提示层**（reloadHint=true → 调用方渲染小字/徽标），不进状态词。

/**
 * @param client 归一化或原始 list 项：{ id, state?, installed?, connected?, manual?/needsManual? }
 * @param ui 该行瞬时态：{ busy?: string|null, failed?: {kind:'connect'|'verify'}|null,
 *   verifyState?: 'connected'|'pending-restart'|'verify-failed'|null, reloadHint?: boolean }
 * @returns {{ key: string, label: string, tone: 'ok'|'todo'|'muted', busy?: boolean, reloadHint: boolean }}
 */
export function projectAssistantStatus(client = {}, ui = {}) {
  const noHint = { reloadHint: false };
  // 在途（写入中…/验证中…）最优先：操作进行时不展示任何其他态
  if (ui.busy) {
    return {
      key: 'busy',
      label: ui.busy === 'verify' || ui.busy === 'verify-confirm' ? '验证中…' : '写入中…',
      tone: 'todo',
      busy: true,
      ...noHint,
    };
  }
  // 失败态：接入失败 / 验证未过（绝不落入「待生效」）
  if (ui.failed) {
    return ui.failed.kind === 'verify'
      ? { key: 'verify-failed', label: '验证未过', tone: 'todo', ...noHint }
      : { key: 'connect-failed', label: '接入失败', tone: 'todo', ...noHint };
  }
  // 最近一次服务端 verify 真值
  if (ui.verifyState === 'verify-failed') {
    return { key: 'verify-failed', label: '验证未过', tone: 'todo', ...noHint };
  }
  if (ui.verifyState === 'pending-restart') {
    // 唯一正当的「待生效」：服务端 verify 判定配置在、运行时未生效
    return { key: 'pending-reload', label: '待生效', tone: 'todo', reloadHint: true };
  }
  // 服务端 list 真值
  const state = client.state ?? null;
  const manual = client.manual === true || client.needsManual === true || state === 'manual';
  const installed = state ? state !== 'not-installed' && state !== 'detect-failed' : Boolean(client.installed);
  const connected = state ? state === 'connected' : Boolean(client.installed && client.connected);
  if (state === 'detect-failed') return { key: 'detect-failed', label: '检测失败', tone: 'todo', ...noHint };
  // F-FIX-B（#116）：已写入但过时（stdio 形态）→ 需升级为 HTTP 直连（待处理黄色，非「未接入」）
  if (state === 'stale') return { key: 'stale', label: '已写入·需升级为直连', tone: 'todo', ...noHint };
  if (manual) return { key: 'manual', label: '需手动', tone: 'muted', ...noHint };
  if (!installed) return { key: 'not-installed', label: '未安装', tone: 'muted', ...noHint };
  if (connected) {
    // 已接入 ✓；刚写入未验证时 reloadHint=true（提示层：小字「已写入 · 请重载助手后生效」）
    return { key: 'connected', label: '已接入 ✓', tone: 'ok', reloadHint: Boolean(ui.reloadHint) };
  }
  return { key: 'not-connected', label: '未接入', tone: 'muted', ...noHint };
}

/**
 * 对账（每轮刷新后调用）：清掉与服务端真值矛盾的客户端残留。
 * 规则：list state=not-connected（配置已不在）→ 清 hint/verify/failed；
 *       verify 已确认 connected → 清 reloadHint（提醒完成使命）。
 * 直接改传进来的 maps（Set/Map/对象均可），返回是否有变更。
 */
export function reconcileAssistantUi(client, maps) {
  let changed = false;
  const id = client.id;
  const state = client.state ?? null;
  const connected = state ? state === 'connected' : Boolean(client.installed && client.connected);
  const gone = state ? state === 'not-connected' || state === 'not-installed' : !client.installed;
  const del = (m) => {
    if (!m) return;
    if (m instanceof Set || m instanceof Map) {
      if (m.has(id)) { m.delete(id); changed = true; }
    } else if (Object.prototype.hasOwnProperty.call(m, id)) {
      delete m[id];
      changed = true;
    }
  };
  if (gone) {
    for (const m of [maps.reloadHints, maps.verifyStates, maps.failed, maps.busy]) del(m);
  } else if (connected) {
    // 服务端 verify 确认运行时生效 → 重载提醒退场（verifyStates 值可为 'connected' 或 {state:'connected'}）
    const raw = maps.verifyStates instanceof Map ? maps.verifyStates.get(id) : maps.verifyStates?.[id];
    const vs = typeof raw === 'object' && raw !== null ? raw.state : raw;
    if (vs === 'connected') del(maps.reloadHints);
  }
  return changed;
}
