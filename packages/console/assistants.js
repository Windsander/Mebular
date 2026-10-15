// UX-2 · 设置 · AI 助手专区 + 首屏叠加层（纯字符串构建器，无 DOM 依赖，可单测）。
// 与 console.js 的约定：console.js 负责取数/动作/事件，本模块负责
//   归一化（轮 A 注册表形状优先：state/evidence/hasVerify/activation/kind；旧形状 installed/connected 兜底）、
//   单列表 HTML、行内 verify 步骤、自定义助手 CRUD 表单、常驻运行行、重启向导行、「需要注意」条目推导。
// 状态词投影唯一真源 = ./assistant-status.js 的 projectAssistantStatus（向导/设置页共用，快照断言守护一致）。

import { projectAssistantStatus } from './assistant-status.js';

const esc = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** 归一化客户端条目：轮 A 新形状优先，旧形状推导，未知字段容忍。 */
export function normalizeClient(c = {}) {
  const manual = c.state === 'manual'
    || c.type === 'snippet'
    || c.writer?.strategy === 'manual'
    || Boolean(c.needsManual)
    || c.format === 'generic';
  const installed = c.state
    ? c.state !== 'not-installed' && c.state !== 'detect-failed'
    : Boolean(c.installed);
  const connected = c.state ? c.state === 'connected' : Boolean(c.installed && c.connected);
  return {
    id: String(c.id ?? ''),
    name: String(c.name ?? c.id ?? ''),
    custom: (c.kind ?? c.registryKind) === 'custom',
    builtin: (c.kind ?? c.registryKind ?? 'builtin') === 'builtin',
    manual,
    state: c.state ?? null,              // not-installed/not-connected/connected/manual/detect-failed
    installed,
    connected,
    evidence: c.evidence ?? null,
    hasVerify: Boolean(c.hasVerify),
    activation: c.activation ?? null,    // { kind: 'hot' | 'user-reload', note? }
    configPath: c.configPath ?? c.landing?.primaryPath ?? null,
    note: c.note ?? null,
    snippet: c.snippet ?? '',
    skillsDirs: c.skillsDirs ?? [],
    skillsInstalled: Boolean(c.skillsInstalled),
  };
}

/** 状态词投影（共享 helper 薄封装；clientRestart 语义 = reloadHint 提示层，不再驱动「待生效」）。 */
export function assistantStatus(client, ui = {}) {
  return projectAssistantStatus(client, {
    busy: ui.clientBusy?.[client.id] ?? null,
    failed: ui.clientFailed?.[client.id] ?? null,
    verifyState: ui.clientVerify?.[client.id]?.state ?? null,
    reloadHint: Boolean(ui.clientRestart?.[client.id]),
  });
}

/** 排序：需处理优先（未接入/接入失败/验证未过/待生效/检测失败 → 需手动 → 已接入）；未安装单独进底部折叠。 */
export function sortClients(clients) {
  const rank = { 'not-connected': 0, 'connect-failed': 0, 'verify-failed': 0, busy: 0, 'pending-reload': 0, 'detect-failed': 0, manual: 1, connected: 2 };
  const actionable = [], missing = [];
  for (const c of clients) (c.installed ? actionable : missing).push(c);
  actionable.sort((a, b) => (rank[assistantStatus(a).key] ?? 9) - (rank[assistantStatus(b).key] ?? 9));
  return { actionable, missing };
}

/** 行内 verify 步骤（回读校验 → CLI 验证 → 待生效/已接入；失败黄态一行 + 详情含输出）。 */
function verifyBlockHtml(client, verify) {
  if (!verify) return '';
  const steps = Array.isArray(verify.steps) ? verify.steps : [];
  const rows = steps.map((s) => {
    const icon = s.ok ? '✓' : '✗';
    const cls = s.ok ? 'ok' : 'todo';
    const out = typeof s.output === 'string' && s.output.trim().length > 0
      ? `<details class="asst-detail"><summary>输出</summary><pre class="connect-diff">${esc(s.output)}</pre></details>`
      : '';
    return `<p class="asst-line ${cls}">${icon} ${esc(s.label ?? s.name ?? '')}：${esc(s.detail ?? '')}</p>${out}`;
  }).join('');
  let stateLine = '';
  if (verify.state === 'pending-restart') {
    stateLine = `<p class="asst-line todo">已接好——重启 ${esc(client.name)} 这个软件后生效${client.activation?.note ? `（${esc(client.activation.note)}）` : ''}</p>`;
  } else if (verify.state === 'connected') {
    stateLine = '<p class="asst-line ok">验证通过，已接入 ✓</p>';
  } else if (verify.state === 'verify-failed') {
    stateLine = '<p class="asst-line todo">验证未过：按上面失败步骤处理后可「重新验证」。</p>';
  }
  return `<div class="asst-verify" data-asst-verify="${esc(client.id)}">${rows}${stateLine}</div>`;
}

function rowHtml(client, ui, status) {
  const id = esc(client.id);
  const msg = ui.clientMsg?.[client.id] ?? '';
  const diff = ui.clientDiff?.[client.id] ?? '';
  const verify = ui.clientVerify?.[client.id] ?? null;
  const failed = ui.clientFailed?.[client.id] ?? null;
  const pending = status.key === 'pending-reload';
  let action;
  if (status.key === 'busy') action = `<button class="btn btn-small btn-crt" type="button" disabled>${esc(status.label)}</button>`;
  else if (status.key === 'connected') action = `<button class="btn btn-small" type="button" data-cli-action="details" data-cli-id="${id}">详情 ›</button>`;
  else if (status.key === 'manual') action = `<button class="btn btn-small" type="button" data-cli-action="details" data-cli-id="${id}">查看片段 ›</button>`;
  else if (status.key === 'not-installed') action = `<button class="btn btn-small" type="button" data-cli-action="details" data-cli-id="${id}">怎么装 ›</button>`;
  else if (pending) {
    action = client.hasVerify
      ? `<button class="btn btn-small btn-crt" type="button" data-cli-action="verify-confirm" data-cli-id="${id}">我已重载，验证</button>`
      : `<button class="btn btn-small btn-crt" type="button" data-cli-action="recheck" data-cli-id="${id}">我已重载，验证</button>`;
  } else if (status.key === 'verify-failed') action = `<button class="btn btn-small btn-crt" type="button" data-cli-action="verify" data-cli-id="${id}">重新验证</button>`;
  else if (status.key === 'connect-failed') action = `<button class="btn btn-small btn-crt" type="button" data-cli-action="connect" data-cli-id="${id}">重试</button>\n      <button class="btn btn-small" type="button" data-cli-action="details" data-cli-id="${id}">详情 ›</button>`;
  else if (status.key === 'detect-failed') action = `<button class="btn btn-small btn-crt" type="button" data-cli-action="recheck" data-cli-id="${id}">重试检测</button>`;
  else action = `<button class="btn btn-small btn-crt" type="button" data-cli-action="connect" data-cli-id="${id}">接入</button>\n      <button class="btn btn-small" type="button" data-cli-action="details" data-cli-id="${id}">详情 ›</button>`;

  // 行内展开（默认收起；有消息/失败/重载提醒/待生效/验证结果/打开详情时展开）
  const reloadHint = status.reloadHint === true;
  const open = Boolean(msg) || Boolean(failed) || reloadHint || pending || Boolean(verify) || ui.clientOpen?.[client.id];
  const detailBits = [];
  // 补丁 3 增补：提示层与状态层分离——「已写入 · 请重载」小字提醒不覆盖「已接入 ✓」
  if (reloadHint && (status.key === 'connected' || pending)) {
    detailBits.push(`<p class="asst-line muted">已写入 · 重启 ${esc(client.name)} 这个软件后生效 · <button class="btn btn-small" type="button" data-cli-action="${client.hasVerify ? 'verify-confirm' : 'recheck'}" data-cli-id="${id}">我已重载，验证</button></p>`);
  }
  // 补丁 3：接入失败反馈——一行原因（人话/脱敏）+ rolledBack 明示「已自动还原原配置」+ 查看详情（备份/命令摘要）
  if (failed) {
    detailBits.push(`<p class="asst-line todo">${esc(failed.reason ?? '接入失败')}</p>`);
    if (failed.rolledBack) {
      const cmds = Array.isArray(failed.commands) && failed.commands.length > 0
        ? `<br />命令摘要：${esc(failed.commands.map((c) => `${c.cmd}（rc=${c.code}）`).join('；'))}`
        : '';
      detailBits.push(`<p class="asst-line">已自动还原原配置。
        <details class="asst-detail"><summary>查看详情</summary><p class="muted">备份：<code>${esc(failed.backupPath ?? '—')}</code>${cmds}</p></details></p>`);
    }
  }
  if (verify) {
    detailBits.push(verifyBlockHtml(client, verify));
  } else if (pending) {
    detailBits.push(`<p class="asst-line todo">已接好——重启 ${esc(client.name)} 这个软件后生效</p>
      <details class="asst-detail"><summary>详情</summary><p class="muted">① 完全退出该软件（退出进程，不是只关窗口）② 重新打开 ③ 工具列表应出现 <code>mebular</code>。我们不会替你重启它。</p></details>`);
  } else if (msg) {
    detailBits.push(`<p class="asst-line${status.tone === 'todo' ? ' todo' : ''}">${esc(msg)}</p>`);
  }
  if (msg && verify) detailBits.push(`<p class="asst-line">${esc(msg)}</p>`);
  if (diff) detailBits.push(`<pre class="connect-diff" data-cli-diff="${id}">${esc(diff)}</pre>`);
  if (ui.clientOpen?.[client.id] || pending) {
    const bits = [];
    if (client.configPath) bits.push(`判据/落面：<code>${esc(client.configPath)}</code>`);
    if (Array.isArray(client.evidence) && client.evidence.length > 0) {
      bits.push(client.evidence.map((e) => esc(`${e?.kind ?? ''}: ${e?.detail ?? ''}`)).join('；'));
    } else if (client.evidence) {
      bits.push(esc(typeof client.evidence === 'string' ? client.evidence : JSON.stringify(client.evidence)));
    }
    if (!client.hasVerify && status.key === 'connected') bits.push('仅配置级验证（该助手未提供验证命令）');
    const customActions = client.custom
      ? `<button class="btn btn-small" type="button" data-asst-edit="${id}">编辑</button>
         <button class="btn btn-small" type="button" data-asst-remove="${id}">移除</button>`
      : '';
    detailBits.push(`<details class="asst-detail"${ui.clientOpen?.[client.id] ? ' open' : ''}><summary>详情</summary>
      <p class="muted">${bits.join(' · ') || '（无判据明细）'}</p>
      <div class="asst-detail-actions">
        ${client.hasVerify ? `<button class="btn btn-small btn-crt" type="button" data-cli-action="verify" data-cli-id="${id}">验证</button>` : ''}
        ${client.manual ? '' : `<button class="btn btn-small" type="button" data-cli-action="preview" data-cli-id="${id}">查看改动</button>
        <button class="btn btn-small" type="button" data-cli-action="rollback" data-cli-id="${id}">回滚</button>`}
        ${(client.skillsDirs ?? []).length > 0 ? `<button class="btn btn-small" type="button" data-cli-action="skills" data-cli-id="${id}">安装 Skill</button>` : ''}
        <button class="btn btn-small" type="button" data-cli-action="copy" data-cli-id="${id}">复制片段</button>
        <button class="btn btn-small" type="button" data-cli-action="recheck" data-cli-id="${id}">重新检测</button>
        ${customActions}
      </div></details>`);
  }
  const customTag = client.custom ? '<span class="asst-tag">自定义</span>' : '';
  return `<div class="asst-row" data-asst-row="${id}">
      <span class="asst-name">${esc(client.name)}${customTag}</span>
      <span class="asst-st${status.tone === 'ok' ? ' ok' : status.tone === 'todo' ? ' todo' : ''}">${esc(status.label)}</span>
      <span class="asst-sp"></span>${action}
    </div>
    <div class="asst-xp"${open ? '' : ' hidden'} data-asst-xp="${id}">${detailBits.join('')}</div>`;
}

/** ＋新增助手表单（选文件 = merge-key 自动写；粘片段 = manual 只给片段，绝不出现「接入」）。 */
export function assistantAddFormHtml({ edit = null, error = '' } = {}) {
  const e = edit ?? {};
  const mode = e.writer?.strategy === 'manual' ? 'snippet' : 'file';
  return `
    <div class="asst-form" id="asst-add-form" data-edit-id="${esc(e.id ?? '')}">
      <p class="asst-line">${edit ? `编辑自定义助手「${esc(e.name ?? e.id)}」` : '登记一个我们还不认识的 AI 助手：给一个它的 MCP 配置文件，或粘一段配置片段。'}</p>
      <div class="asst-form-modes" role="radiogroup" aria-label="登记方式">
        <label class="asst-mode"><input type="radio" name="asst-mode" value="file"${mode === 'file' ? ' checked' : ''} /> 选文件（自动合并写入，写前备份）</label>
        <label class="asst-mode"><input type="radio" name="asst-mode" value="snippet"${mode === 'snippet' ? ' checked' : ''} /> 粘片段（只生成片段，手动合并）</label>
      </div>
      <div class="asst-form-grid">
        <label>名称 <input id="asst-add-name" class="crt-input" type="text" placeholder="我的助手" value="${esc(e.name ?? '')}" /></label>
        <label>标识（小写 kebab） <input id="asst-add-id" class="crt-input" type="text" placeholder="my-assistant" value="${esc(e.id ?? '')}"${edit ? ' disabled' : ''} /></label>
        <label class="asst-mode-file"${mode === 'snippet' ? ' hidden' : ''}>配置文件路径 <input id="asst-add-path" class="crt-input" type="text" placeholder="~/.config/my-assistant/mcp.json" value="${esc(e.landing?.primaryPath ?? '')}" /></label>
        <label class="asst-mode-file"${mode === 'snippet' ? ' hidden' : ''}>配置格式
          <select id="asst-add-format" class="crt-input">
            ${['mcpServers', 'opencode', 'dsh'].map((f) => `<option value="${f}"${(e.landing?.format ?? 'mcpServers') === f ? ' selected' : ''}>${f}</option>`).join('')}
          </select>
        </label>
      </div>
      <p class="asst-line muted asst-mode-snippet"${mode === 'snippet' ? '' : ' hidden'}>粘片段模式：登记后该行永远显示「需手动」，详情里给可复制片段——不会出现自动写「接入」。</p>
      <p class="asst-line todo" id="asst-add-error"${error ? '' : ' hidden'}>${esc(error)}</p>
      <div class="asst-detail-actions">
        <button class="btn btn-small btn-crt" type="button" id="asst-add-submit">${edit ? '保存修改' : '登记'}</button>
        <button class="btn btn-small" type="button" id="asst-add-cancel">取消</button>
      </div>
    </div>`;
}

/** 专区主体：注脚 + ＋新增助手 + 单列表 + 底部「未安装（n）›」折叠。 */
export function assistantsPanelHtml({ clients, ui = {} } = {}) {
  if (!clients) return '<p class="muted">AI 助手列表加载中…</p>';
  const norm = clients.map(normalizeClient);
  const { actionable, missing } = sortClients(norm);
  const rows = actionable.map((c) => rowHtml(c, ui, assistantStatus(c, ui))).join('');
  const missingRows = missing.map((c) => rowHtml(c, ui, assistantStatus(c, ui))).join('');
  return `
    <div class="asst-head">
      <p class="muted">接入只改助手的一条配置，写前自动备份；重启对应软件后生效。</p>
      <button class="btn btn-small btn-crt" type="button" id="asst-add">＋ 新增助手</button>
    </div>
    <div class="asst-xp" id="asst-add-flow"${ui.addForm ? '' : ' hidden'}>${ui.addForm ?? ''}</div>
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
