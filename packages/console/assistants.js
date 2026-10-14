// UX-2 · 设置 · AI 助手专区 + 首屏叠加层（纯字符串构建器，无 DOM 依赖，可单测）。
// 与 console.js 的约定：console.js 负责取数/动作/事件，本模块负责
//   归一化（容忍轮 A 新字段：state/evidence/hasVerify/activation，未知字段不炸）、
//   单列表 HTML、常驻运行行、重启向导行、「需要注意」条目推导。

const esc = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** 归一化客户端条目：轮 A 新形状优先，旧形状（installed/connected）推导，未知字段容忍。 */
export function normalizeClient(c = {}) {
  const installed = c.state
    ? c.state !== 'not-installed' && c.state !== 'detect-failed'
    : Boolean(c.installed);
  const connected = c.state ? c.state === 'connected' : Boolean(c.installed && c.connected);
  return {
    id: String(c.id ?? ''),
    name: String(c.name ?? c.id ?? ''),
    kind: c.kind ?? (c.needsManual || c.format === 'generic' ? 'snippet' : 'file'),
    manual: Boolean(c.needsManual) || c.kind === 'snippet' || c.format === 'generic',
    state: c.state ?? null,              // 轮 A：not-installed/not-connected/pending-reload/verify-failed/detect-failed/connected
    installed,
    connected,
    evidence: c.evidence ?? null,
    hasVerify: Boolean(c.hasVerify),
    activation: c.activation ?? null,    // { kind: 'hot' | 'user-reload' }
    configPath: c.configPath ?? null,
    note: c.note ?? null,
    snippet: c.snippet ?? '',
    skillsDirs: c.skillsDirs ?? [],
    skillsInstalled: Boolean(c.skillsInstalled),
  };
}

/** 状态词（与引导同语言；`ui.clientRestart[id]` 表示已写入待重载）。 */
export function assistantStatus(client, ui = {}) {
  if (client.state === 'detect-failed') return { key: 'detect-failed', label: '检测失败', tone: 'todo' };
  if (client.manual) return { key: 'manual', label: '需手动', tone: 'muted' };
  if (!client.installed) return { key: 'not-installed', label: '未安装', tone: 'muted' };
  if (client.state === 'verify-failed') return { key: 'verify-failed', label: '验证未过', tone: 'todo' };
  if (ui.clientRestart?.[client.id] || client.state === 'pending-reload') return { key: 'pending-reload', label: '待生效', tone: 'todo' };
  if (client.connected) return { key: 'connected', label: '已接入 ✓', tone: 'ok' };
  return { key: 'not-connected', label: '未接入', tone: 'muted' };
}

/** 排序：需处理优先（未接入/验证未过/待生效/检测失败 → 需手动 → 已接入）；未安装单独进底部折叠。 */
export function sortClients(clients) {
  const rank = { 'not-connected': 0, 'verify-failed': 0, 'pending-reload': 0, 'detect-failed': 0, manual: 1, connected: 2 };
  const actionable = [], missing = [];
  for (const c of clients) (c.installed ? actionable : missing).push(c);
  actionable.sort((a, b) => (rank[assistantStatus(a).key] ?? 9) - (rank[assistantStatus(b).key] ?? 9));
  return { actionable, missing };
}

function rowHtml(client, ui, status) {
  const id = esc(client.id);
  const msg = ui.clientMsg?.[client.id] ?? '';
  const diff = ui.clientDiff?.[client.id] ?? '';
  const pending = status.key === 'pending-reload';
  let action;
  if (status.key === 'connected') action = `<button class="btn btn-small" type="button" data-cli-action="details" data-cli-id="${id}">详情 ›</button>`;
  else if (status.key === 'manual') action = `<button class="btn btn-small" type="button" data-cli-action="details" data-cli-id="${id}">查看片段 ›</button>`;
  else if (status.key === 'not-installed') action = `<button class="btn btn-small" type="button" data-cli-action="details" data-cli-id="${id}">怎么装 ›</button>`;
  else if (pending) action = `<button class="btn btn-small btn-crt" type="button" data-cli-action="recheck" data-cli-id="${id}">我已重载，重新验证</button>`;
  else if (status.key === 'verify-failed') action = `<button class="btn btn-small btn-crt" type="button" data-cli-action="recheck" data-cli-id="${id}">重新验证</button>`;
  else if (status.key === 'detect-failed') action = `<button class="btn btn-small btn-crt" type="button" data-cli-action="recheck" data-cli-id="${id}">重试检测</button>`;
  else action = `<button class="btn btn-small btn-crt" type="button" data-cli-action="connect" data-cli-id="${id}">接入</button>`;

  // 行内展开（默认收起；有消息/待生效/打开详情时展开）
  const open = Boolean(msg) || pending || ui.clientOpen?.[client.id];
  const detailBits = [];
  if (pending) {
    detailBits.push(`<p class="asst-line todo">已接好，重载 ${esc(client.name)} 后生效</p>
      <details class="asst-detail"><summary>详情</summary><p class="muted">① 完全退出（退出进程，不是关窗口）或在 App 内重载 ② 重新打开 ③ 工具列表应出现 <code>mebular</code>。我们不会替你发 reload。</p></details>`);
  } else if (msg) {
    detailBits.push(`<p class="asst-line${status.tone === 'todo' ? ' todo' : ''}">${esc(msg)}</p>`);
  }
  if (diff) detailBits.push(`<pre class="connect-diff" data-cli-diff="${id}">${esc(diff)}</pre>`);
  if (ui.clientOpen?.[client.id] || pending) {
    const bits = [];
    if (client.configPath) bits.push(`判据/落面：<code>${esc(client.configPath)}</code>`);
    if (client.evidence) bits.push(esc(typeof client.evidence === 'string' ? client.evidence : JSON.stringify(client.evidence)));
    if (!client.hasVerify && status.key === 'connected') bits.push('仅配置级验证（该助手未提供验证命令）');
    detailBits.push(`<details class="asst-detail"${ui.clientOpen?.[client.id] ? ' open' : ''}><summary>详情</summary>
      <p class="muted">${bits.join(' · ') || '（轮 A 注册表接入后展示判据明细）'}</p>
      <div class="asst-detail-actions">
        <button class="btn btn-small" type="button" data-cli-action="preview" data-cli-id="${id}">查看改动</button>
        <button class="btn btn-small" type="button" data-cli-action="rollback" data-cli-id="${id}">回滚</button>
        ${(client.skillsDirs ?? []).length > 0 ? `<button class="btn btn-small" type="button" data-cli-action="skills" data-cli-id="${id}">安装 Skill</button>` : ''}
        <button class="btn btn-small" type="button" data-cli-action="copy" data-cli-id="${id}">复制片段</button>
        <button class="btn btn-small" type="button" data-cli-action="recheck" data-cli-id="${id}">重新检测</button>
      </div></details>`);
  }
  return `<div class="asst-row" data-asst-row="${id}">
      <span class="asst-name">${esc(client.name)}</span>
      <span class="asst-st${status.tone === 'ok' ? ' ok' : status.tone === 'todo' ? ' todo' : ''}">${esc(status.label)}</span>
      <span class="asst-sp"></span>${action}
    </div>
    <div class="asst-xp"${open ? '' : ' hidden'} data-asst-xp="${id}">${detailBits.join('')}</div>`;
}

/** 专区主体：注脚 + ＋新增助手 + 单列表 + 底部「未安装（n）›」折叠。 */
export function assistantsPanelHtml({ clients, ui = {} } = {}) {
  if (!clients) return '<p class="muted">AI 助手列表加载中…</p>';
  const norm = clients.map(normalizeClient);
  const { actionable, missing } = sortClients(norm.map((c) => ({ ...c, __st: assistantStatus(c, ui) })));
  const rows = actionable.map((c) => rowHtml(c, ui, assistantStatus(c, ui))).join('');
  const missingRows = missing.map((c) => rowHtml(c, ui, assistantStatus(c, ui))).join('');
  return `
    <div class="asst-head">
      <p class="muted">接入只改助手的一条配置，写前自动备份；重载对应助手后生效。</p>
      <button class="btn btn-small btn-crt" type="button" id="asst-add">＋ 新增助手</button>
    </div>
    <div class="asst-xp" id="asst-add-flow" hidden>
      <p class="muted">自定义登记由注册表轮（轮 A）提供接口；联调期可用 <code>?mock=1</code>。入口已预留，未知字段一律容忍。</p>
    </div>
    <div id="assistants-list">${rows || '<p class="muted">还没有登记任何助手：点「＋ 新增助手」开始。</p>'}</div>
    ${missing.length > 0 ? `
      <div class="asst-row asst-fold"><span class="asst-name muted">未安装（${missing.length}）</span><span class="asst-sp"></span>
        <button class="btn btn-small" type="button" id="asst-missing-toggle">展开 ›</button></div>
      <div class="asst-xp" id="asst-missing" hidden>${missingRows}</div>` : ''}`;
}

/** 常驻运行行（归设置 · 常用；状态行 + 按状态唯一主操作，次级入详情）。 */
export function serviceRowHtml(service, serviceMsg = '') {
  if (!service) return '<p class="muted">常驻状态加载中…</p>';
  const registered = Boolean(service.registered);
  const badge = registered ? (service.running ? '已常驻·运行中' : '已常驻·未运行') : '未常驻（临时运行）';
  return `<div class="asst-row">
      <span class="asst-name">常驻运行</span>
      <span class="asst-st">${esc(badge)}</span>
      <span class="asst-sp"></span>
      ${registered
        ? '<button class="btn btn-small" type="button" data-svc-action="recheck">重新检测</button>'
        : '<button class="btn btn-small btn-crt" type="button" data-svc-action="install">让 Mebular 常驻</button>'}
    </div>
    <div class="asst-xp">
      <details class="asst-detail"><summary>详情</summary>
        <p class="muted">开机自启、崩溃自动拉起。家目录 <code>${esc(service.home ?? '—')}</code>（服务文件路径见「关于本机」）。</p>
        <div class="asst-detail-actions">
          <button class="btn btn-small" type="button" data-svc-action="restart">立即重启</button>
          <button class="btn btn-small" type="button" data-svc-action="recheck">重新检测</button>
          <button class="btn btn-small" type="button" data-svc-action="uninstall" ${registered ? '' : 'disabled'}>取消常驻</button>
        </div>
      </details>
      <p class="asst-line" id="service-msg">${esc(serviceMsg)}</p>
    </div>`;
}

/** 重启向导行（设置 · 常用；web 无 preload 桥时隐藏）。 */
export function wizardRowHtml(hasBridge) {
  if (!hasBridge) return '';
  return `<div class="asst-row">
    <span class="asst-name">重启向导</span>
    <span class="asst-st">重新走一遍首次设置（不动已有配置）</span>
    <span class="asst-sp"></span>
    <button class="btn btn-small" type="button" id="settings-open-wizard">重启向导 ›</button>
  </div>`;
}

/** 首屏状态总览条（纯只读；对端计数不含本机）。 */
export function statusPillHtml({ service, devices, memoryCount, selfId = null } = {}) {
  const daemon = service
    ? (service.running ? `运行中 · ${service.registered ? '常驻' : '临时'}` : '未运行')
    : '—';
  const peers = (Array.isArray(devices) ? devices : []).filter((d) => d.deviceId && d.deviceId !== selfId);
  const online = peers.filter((d) => d.connected || d.online).length;
  return `<span>守护 <b>${esc(daemon)}</b></span><span class="dotsep"></span>
    <span>对端 <b>${online}</b>/${peers.length} 已连</span><span class="dotsep"></span>
    <span>记忆 <b>${memoryCount ?? '—'}</b></span>`;
}

/** 「需要注意」条目（条件渲染，无事不出现；本机不计入对端未连接）。 */
export function attentionItems({ clients, ui = {}, devices, selfId = null } = {}) {
  const items = [];
  for (const raw of clients ?? []) {
    const c = normalizeClient(raw);
    const st = assistantStatus(c, ui);
    if (st.key === 'pending-reload') items.push({ id: `asst-${c.id}`, label: `${c.name} 待生效`, action: 'assistants' });
    if (st.key === 'verify-failed') items.push({ id: `asst-${c.id}`, label: `${c.name} 验证未过`, action: 'assistants' });
  }
  for (const d of devices ?? []) {
    if (!d.deviceId || d.deviceId === selfId) continue;
    const online = d.connected || d.online;
    if (online === false) items.push({ id: `dev-${d.deviceId}`, label: `${d.deviceId} 未连接`, action: 'device' });
  }
  return items;
}
