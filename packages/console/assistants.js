// UX-2 · 设置 · AI 助手专区 + 首屏叠加层（纯字符串构建器，无 DOM 依赖，可单测）。
// 与 console.js 的约定：console.js 负责取数/动作/事件，本模块负责
//   归一化（轮 A 注册表形状优先：state/evidence/hasVerify/activation/kind；旧形状 installed/connected 兜底）、
//   单列表 HTML、行内 verify 步骤、自定义助手 CRUD 表单、常驻运行行、重启向导行、「需要注意」条目推导。
// 状态词投影唯一真源 = ./assistant-status.js 的 projectAssistantStatus（向导/设置页共用，快照断言守护一致）。
//
// i18n：用户可见文案走 console pack（t）；catalog 未加载（单测 / 静态兜底）时回退本文件的中文字面量。

import { projectAssistantStatus } from './assistant-status.js';
import { t, interpolate } from './i18n.mjs';

const esc = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** 文案：key 命中 catalog 用译文，否则回退中文兜底（单测无 catalog 时保持原有断言）。 */
const tr = (key, fallback, vars) => (t.has(key) ? t(key, vars) : interpolate(fallback, vars));

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

/** 状态词本地化：key 命中用译文，否则用 assistant-status.js 的中文投影。 */
function statusLabel(status) {
  return status.labelKey ? tr(status.labelKey, status.label) : status.label;
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
    // 验证失败但命令没有 stdout/stderr 时也要给出一行可诊断原因：
    // 否则界面只有“未通过（rc=…）”，用户看不到为什么，验收也无法确认输出区存在。
    const out = typeof s.output === 'string' && s.output.trim().length > 0
      ? `<pre class="connect-diff asst-output" data-asst-output>${esc(s.output)}</pre>`
      : (!s.ok ? `<pre class="connect-diff asst-output" data-asst-output>${esc(tr('assistants.verify.noOutput', '（验证命令没有返回输出；{detail}）', {
        detail: s.detail ?? tr('assistants.verify.notPassed', '未通过'),
      }))}</pre>` : '');
    return `<p class="asst-line ${cls}">${icon} ${esc(s.label ?? s.name ?? '')}：${esc(s.detail ?? '')}</p>${out}`;
  }).join('');
  let stateLine = '';
  if (verify.state === 'pending-restart') {
    stateLine = client.activation?.note
      ? `<p class="asst-line todo">${esc(tr('assistants.verify.pendingWithNote', '已接好——重启 {name} 这个软件后生效（{note}）', { name: client.name, note: client.activation.note }))}</p>`
      : `<p class="asst-line todo">${esc(tr('assistants.verify.pending', '已接好——重启 {name} 这个软件后生效', { name: client.name }))}</p>`;
  } else if (verify.state === 'connected') {
    stateLine = `<p class="asst-line ok">${esc(tr('assistants.verify.ok', '验证通过，已接入 ✓'))}</p>`;
  } else if (verify.state === 'verify-failed') {
    stateLine = `<p class="asst-line todo">${esc(tr('assistants.verify.failed', '验证未过：按上面失败步骤处理后可「重新验证」。'))}</p>`;
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
  if (status.key === 'busy') action = `<button class="btn btn-small btn-crt" type="button" disabled>${esc(statusLabel(status))}</button>`;
  else if (status.key === 'connected') action = `<button class="btn btn-small" type="button" data-cli-action="details" data-cli-id="${id}">${esc(tr('assistants.action.details', '详情 ›'))}</button>`;
  else if (status.key === 'manual') action = `<button class="btn btn-small" type="button" data-cli-action="details" data-cli-id="${id}">${esc(tr('assistants.action.snippet', '查看片段 ›'))}</button>`;
  else if (status.key === 'not-installed') action = `<button class="btn btn-small" type="button" data-cli-action="details" data-cli-id="${id}">${esc(tr('assistants.action.install', '怎么装 ›'))}</button>`;
  else if (pending) {
    action = client.hasVerify
      ? `<button class="btn btn-small btn-crt" type="button" data-cli-action="verify-confirm" data-cli-id="${id}">${esc(tr('assistants.action.verifyAfterReload', '我已重载，验证'))}</button>`
      : `<button class="btn btn-small btn-crt" type="button" data-cli-action="recheck" data-cli-id="${id}">${esc(tr('assistants.action.verifyAfterReload', '我已重载，验证'))}</button>`;
  } else if (status.key === 'verify-failed') action = `<button class="btn btn-small btn-crt" type="button" data-cli-action="verify" data-cli-id="${id}">${esc(tr('assistants.action.reverify', '重新验证'))}</button>`;
  else if (status.key === 'connect-failed') action = `<button class="btn btn-small btn-crt" type="button" data-cli-action="connect" data-cli-id="${id}">${esc(tr('assistants.action.retry', '重试'))}</button>\n      <button class="btn btn-small" type="button" data-cli-action="details" data-cli-id="${id}">${esc(tr('assistants.action.details', '详情 ›'))}</button>`;
  else if (status.key === 'detect-failed') action = `<button class="btn btn-small btn-crt" type="button" data-cli-action="recheck" data-cli-id="${id}">${esc(tr('assistants.action.recheck', '重新检测'))}</button>`;
  else action = `<button class="btn btn-small btn-crt" type="button" data-cli-action="connect" data-cli-id="${id}">${esc(tr('assistants.action.connect', '接入'))}</button>\n      <button class="btn btn-small" type="button" data-cli-action="details" data-cli-id="${id}">${esc(tr('assistants.action.details', '详情 ›'))}</button>`;

  // 行内展开（默认收起；有消息/失败/重载提醒/待生效/验证结果/打开详情时展开）
  const reloadHint = status.reloadHint === true;
  const open = Boolean(msg) || Boolean(failed) || reloadHint || pending || Boolean(verify) || ui.clientOpen?.[client.id];
  const detailBits = [];
  // 补丁 3 增补：提示层与状态层分离——「已写入 · 请重载」小字提醒不覆盖「已接入 ✓」
  if (reloadHint && (status.key === 'connected' || pending)) {
    detailBits.push(`<p class="asst-line muted">${esc(tr('assistants.reloadHintPrefix', '已写入 · 重启 {name} 这个软件后生效 · ', { name: client.name }))}<button class="btn btn-small" type="button" data-cli-action="${client.hasVerify ? 'verify-confirm' : 'recheck'}" data-cli-id="${id}">${esc(tr('assistants.action.verifyAfterReload', '我已重载，验证'))}</button></p>`);
  }
  // 补丁 3：接入失败反馈——一行原因（人话/脱敏）+ rolledBack 明示「已自动还原原配置」+ 查看详情（备份/命令摘要）
  if (failed) {
    detailBits.push(`<p class="asst-line todo">${esc(failed.reason ?? tr('assistants.failed.label', '接入失败'))}</p>`);
    if (failed.rolledBack) {
      const cmds = Array.isArray(failed.commands) && failed.commands.length > 0
        ? `<br />${esc(tr('assistants.failed.commands', '命令摘要：{commands}', {
          commands: failed.commands
            .map((c) => tr('assistants.failed.commandItem', '{cmd}（rc={code}）', { cmd: c.cmd, code: c.code }))
            .join('；'),
        }))}`
        : '';
      detailBits.push(`<p class="asst-line">${esc(tr('assistants.failed.rolledBack', '已自动还原原配置。备份：{backup}', {
        backup: failed.backupPath ?? '—',
      }))}${cmds}</p>`);
    }
  }
  if (verify) {
    detailBits.push(verifyBlockHtml(client, verify));
  } else if (pending) {
    detailBits.push(`<p class="asst-line todo">${esc(tr('assistants.verify.pending', '已接好——重启 {name} 这个软件后生效', { name: client.name }))}</p>
      <p class="asst-line muted">${tr('assistants.verify.pendingSteps', '① 完全退出该软件（退出进程，不是只关窗口）② 重新打开 ③ 工具列表应出现 <code>mebular</code>。我们不会替你重启它。')}</p>`);
  } else if (msg) {
    detailBits.push(`<p class="asst-line${status.tone === 'todo' ? ' todo' : ''}">${esc(msg)}</p>`);
  }
  if (msg && verify) detailBits.push(`<p class="asst-line">${esc(msg)}</p>`);
  if (diff) detailBits.push(`<pre class="connect-diff" data-cli-diff="${id}">${esc(diff)}</pre>`);
  if (ui.clientOpen?.[client.id] || pending) {
    const bits = [];
    if (client.configPath) bits.push(tr('assistants.detail.criteria', '判据/落面：{path}', { path: `<code>${esc(client.configPath)}</code>` }));
    if (Array.isArray(client.evidence) && client.evidence.length > 0) {
      bits.push(client.evidence.map((e) => esc(`${e?.kind ?? ''}: ${e?.detail ?? ''}`)).join('；'));
    } else if (client.evidence) {
      bits.push(esc(typeof client.evidence === 'string' ? client.evidence : JSON.stringify(client.evidence)));
    }
    if (!client.hasVerify && status.key === 'connected') bits.push(esc(tr('assistants.detail.configOnly', '仅配置级验证（该助手未提供验证命令）')));
    const customActions = client.custom
      ? `<button class="btn btn-small" type="button" data-asst-edit="${id}">${esc(tr('assistants.action.edit', '编辑'))}</button>
         <button class="btn btn-small" type="button" data-asst-remove="${id}">${esc(tr('assistants.action.remove', '移除'))}</button>`
      : '';
    detailBits.push(`<div class="asst-detail-panel" data-asst-detail="${id}">
      <p class="muted">${bits.join(' · ') || esc(tr('assistants.detail.none', '（无判据明细）'))}</p>
      <div class="asst-detail-actions">
        ${client.hasVerify ? `<button class="btn btn-small btn-crt" type="button" data-cli-action="verify" data-cli-id="${id}">${esc(tr('assistants.action.verify', '验证'))}</button>` : ''}
        ${client.manual ? '' : `<button class="btn btn-small" type="button" data-cli-action="preview" data-cli-id="${id}">${esc(tr('assistants.action.preview', '查看改动'))}</button>
        <button class="btn btn-small" type="button" data-cli-action="rollback" data-cli-id="${id}">${esc(tr('assistants.action.rollback', '回滚'))}</button>`}
        ${(client.skillsDirs ?? []).length > 0 ? `<button class="btn btn-small" type="button" data-cli-action="skills" data-cli-id="${id}">${esc(tr('assistants.action.skills', '安装 Skill'))}</button>` : ''}
        <button class="btn btn-small" type="button" data-cli-action="copy" data-cli-id="${id}">${esc(tr('assistants.action.copySnippet', '复制片段'))}</button>
        <button class="btn btn-small" type="button" data-cli-action="recheck" data-cli-id="${id}">${esc(tr('assistants.action.recheck', '重新检测'))}</button>
        ${customActions}
      </div></div>`);
  }
  const customTag = client.custom ? `<span class="asst-tag">${esc(tr('assistants.tag.custom', '自定义'))}</span>` : '';
  return `<div class="asst-row" data-asst-row="${id}">
      <span class="asst-name">${esc(client.name)}${customTag}</span>
      <span class="asst-st${status.tone === 'ok' ? ' ok' : status.tone === 'todo' ? ' todo' : ''}">${esc(statusLabel(status))}</span>
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
      <p class="asst-line">${esc(edit
        ? tr('assistants.form.editTitle', '编辑自定义助手「{name}」', { name: e.name ?? e.id })
        : tr('assistants.form.addTitle', '登记一个我们还不认识的 AI 助手：给一个它的 MCP 配置文件，或粘一段配置片段。'))}</p>
      <div class="asst-form-modes" role="radiogroup" aria-label="${esc(tr('assistants.form.modesAria', '登记方式'))}">
        <label class="asst-mode"><input type="radio" name="asst-mode" value="file"${mode === 'file' ? ' checked' : ''} /> ${esc(tr('assistants.form.modeFile', '选文件（自动合并写入，写前备份）'))}</label>
        <label class="asst-mode"><input type="radio" name="asst-mode" value="snippet"${mode === 'snippet' ? ' checked' : ''} /> ${esc(tr('assistants.form.modeSnippet', '粘片段（只生成片段，手动合并）'))}</label>
      </div>
      <div class="asst-form-grid">
        <label>${esc(tr('assistants.form.name', '名称'))} <input id="asst-add-name" class="crt-input" type="text" placeholder="${esc(tr('assistants.form.namePlaceholder', '我的助手'))}" value="${esc(e.name ?? '')}" /></label>
        <label>${esc(tr('assistants.form.id', '标识（小写 kebab）'))} <input id="asst-add-id" class="crt-input" type="text" placeholder="my-assistant" value="${esc(e.id ?? '')}"${edit ? ' disabled' : ''} /></label>
        <label class="asst-mode-file"${mode === 'snippet' ? ' hidden' : ''}>${esc(tr('assistants.form.path', '配置文件路径'))} <input id="asst-add-path" class="crt-input" type="text" placeholder="~/.config/my-assistant/mcp.json" value="${esc(e.landing?.primaryPath ?? '')}" /></label>
        <label class="asst-mode-file"${mode === 'snippet' ? ' hidden' : ''}>${esc(tr('assistants.form.format', '配置格式'))}
          <select id="asst-add-format" class="crt-input">
            ${['mcpServers', 'opencode', 'dsh'].map((f) => `<option value="${f}"${(e.landing?.format ?? 'mcpServers') === f ? ' selected' : ''}>${f}</option>`).join('')}
          </select>
        </label>
      </div>
      <p class="asst-line muted asst-mode-snippet"${mode === 'snippet' ? '' : ' hidden'}>${esc(tr('assistants.form.snippetNote', '粘片段模式：登记后该行永远显示「需手动」，详情里给可复制片段——不会出现自动写「接入」。'))}</p>
      <p class="asst-line todo" id="asst-add-error"${error ? '' : ' hidden'}>${esc(error)}</p>
      <div class="asst-detail-actions">
        <button class="btn btn-small btn-crt" type="button" id="asst-add-submit">${esc(edit ? tr('assistants.form.save', '保存修改') : tr('assistants.form.submit', '登记'))}</button>
        <button class="btn btn-small" type="button" id="asst-add-cancel">${esc(tr('assistants.form.cancel', '取消'))}</button>
      </div>
    </div>`;
}

/** 专区主体：注脚 + ＋新增助手 + 单列表 + 底部「未安装（n）›」折叠。 */
export function assistantsPanelHtml({ clients, ui = {} } = {}) {
  if (!clients) return `<p class="muted">${esc(tr('assistants.loading', 'AI 助手列表加载中…'))}</p>`;
  const norm = clients.map(normalizeClient);
  const { actionable, missing } = sortClients(norm);
  const rows = actionable.map((c) => rowHtml(c, ui, assistantStatus(c, ui))).join('');
  const missingRows = missing.map((c) => rowHtml(c, ui, assistantStatus(c, ui))).join('');
  return `
    <div class="asst-head">
      <p class="muted">${esc(tr('assistants.head.note', '接入只改助手的一条配置，写前自动备份；重启对应软件后生效。'))}</p>
      <button class="btn btn-small btn-crt" type="button" id="asst-add">${esc(tr('assistants.add', '＋ 新增助手'))}</button>
    </div>
    <div class="asst-xp" id="asst-add-flow"${ui.addForm ? '' : ' hidden'}>${ui.addForm ?? ''}</div>
    <div id="assistants-list">${rows || `<p class="muted">${esc(tr('assistants.empty', '还没有登记任何助手：点「＋ 新增助手」开始。'))}</p>`}</div>
    ${missing.length > 0 ? `
      <div class="asst-row asst-fold"><span class="asst-name muted">${esc(tr('assistants.missing', '未安装（{count}）', { count: missing.length }))}</span><span class="asst-sp"></span>
        <button class="btn btn-small" type="button" id="asst-missing-toggle">${esc(tr('assistants.missing.expand', '展开 ›'))}</button></div>
      <div class="asst-xp" id="asst-missing" hidden>${missingRows}</div>` : ''}`;
}

/** 常驻运行行（归设置 · 常用；状态行 + 按状态唯一主操作，次级入详情）。 */
export function serviceRowHtml(service, serviceMsg = '') {
  if (!service) return `<p class="muted">${esc(tr('settings.service.loading', '常驻状态加载中…'))}</p>`;
  const registered = Boolean(service.registered);
  const badge = registered
    ? tr(service.running ? 'settings.service.badge.running' : 'settings.service.badge.registered',
      service.running ? '已常驻·运行中' : '已常驻·未运行')
    : tr('settings.service.badge.temporary', '未常驻（临时运行）');
  return `<div class="asst-row">
      <span class="asst-name">${esc(tr('settings.service.title', '常驻运行'))}</span>
      <span class="asst-st">${esc(badge)}</span>
      <span class="asst-sp"></span>
      ${registered
        ? `<button class="btn btn-small" type="button" data-svc-action="recheck">${esc(tr('settings.service.recheck', '重新检测'))}</button>`
        : `<button class="btn btn-small btn-crt" type="button" data-svc-action="install">${esc(tr('settings.service.install', '让 Mebular 常驻'))}</button>`}
    </div>
    <div class="asst-xp asst-service-xp">
      <p class="muted">${tr('settings.service.note', '开机自启、崩溃自动拉起。家目录 {home}（服务文件路径见「关于本机」）。', {
        home: `<code>${esc(service.home ?? '—')}</code>`,
      })}</p>
      <div class="asst-detail-actions">
        <button class="btn btn-small" type="button" data-svc-action="restart">${esc(tr('settings.service.restart', '立即重启'))}</button>
        <button class="btn btn-small" type="button" data-svc-action="recheck">${esc(tr('settings.service.recheck', '重新检测'))}</button>
        <button class="btn btn-small" type="button" data-svc-action="uninstall" ${registered ? '' : 'disabled'}>${esc(tr('settings.service.uninstall', '取消常驻'))}</button>
      </div>
      <p class="asst-line" id="service-msg">${esc(serviceMsg)}</p>
    </div>`;
}

/** 重启向导行（设置 · 常用；web 无 preload 桥时隐藏）。 */
export function wizardRowHtml(hasBridge) {
  if (!hasBridge) return '';
  return `<div class="asst-row">
    <span class="asst-name">${esc(tr('settings.wizard.title', '重启向导'))}</span>
    <span class="asst-st">${esc(tr('settings.wizard.note', '重新走一遍首次设置（不动已有配置）'))}</span>
    <span class="asst-sp"></span>
    <button class="btn btn-small" type="button" id="settings-open-wizard">${esc(tr('settings.wizard.action', '重启向导 ›'))}</button>
  </div>`;
}

/** 首屏状态总览条（纯只读；对端计数不含本机）。 */
export function statusPillHtml({ service, devices, memoryCount, selfId = null } = {}) {
  const daemon = service
    ? (service.running
      ? (service.registered
        ? tr('statusPill.daemonRunningRegistered', '运行中 · 常驻')
        : tr('statusPill.daemonRunningTemporary', '运行中 · 临时'))
      : tr('statusPill.daemonStopped', '未运行'))
    : '—';
  const peers = (Array.isArray(devices) ? devices : []).filter((d) => d.deviceId && d.deviceId !== selfId);
  const online = peers.filter((d) => d.connected || d.online).length;
  return `<span>${esc(tr('statusPill.daemon', '守护'))} <b>${esc(daemon)}</b></span><span class="dotsep"></span>
    <span>${tr('statusPill.peers', '对端 <b>{online}</b>/{total} 已连', { online, total: peers.length })}</span><span class="dotsep"></span>
    <span>${tr('statusPill.memory', '记忆 <b>{count}</b>', { count: memoryCount ?? '—' })}</span>`;
}

/** 「需要注意」条目（条件渲染，无事不出现；本机不计入对端未连接）。
 *  S3：安全项 = medium 未导入动态码种子 / 待批准（他机发起）/ 验收拒绝（rejections）。 */
export function attentionItems({ clients, ui = {}, devices, selfId = null, security = null } = {}) {
  const items = [];
  for (const raw of clients ?? []) {
    const c = normalizeClient(raw);
    const st = assistantStatus(c, ui);
    if (st.key === 'pending-reload') items.push({ id: `asst-${c.id}`, label: tr('attention.asstPendingReload', '{name} 待生效', { name: c.name }), action: 'assistants' });
    if (st.key === 'verify-failed') items.push({ id: `asst-${c.id}`, label: tr('attention.asstVerifyFailed', '{name} 验证未过', { name: c.name }), action: 'assistants' });
  }
  if (security !== null && security !== undefined) {
    if (security.level === 'medium' && security.totp?.imported !== true) {
      items.push({ id: 'security-totp', label: tr('attention.securityTotp', '动态码种子未导入'), action: 'security' });
    }
    const pending = (security.pendingApprovals ?? []).filter((a) => a?.initiator !== selfId);
    if (pending.length > 0) {
      items.push({ id: 'security-approvals', label: tr('attention.securityApprovals', '待批准 {count} 项', { count: pending.length }), action: 'security-approvals' });
    }
    const rejected = (security.rejections ?? []).length;
    if (rejected > 0) {
      items.push({ id: 'security-rejections', label: tr('attention.securityRejections', '{count} 条安全操作被拒绝', { count: rejected }), action: 'security' });
    }
  }
  for (const d of devices ?? []) {
    if (!d.deviceId || d.deviceId === selfId) continue;
    const online = d.connected || d.online;
    if (online === false) items.push({ id: `dev-${d.deviceId}`, label: tr('attention.deviceOffline', '{device} 未连接', { device: d.deviceId }), action: 'device' });
  }
  return items;
}
