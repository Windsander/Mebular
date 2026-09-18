// Mebular 控制台前端（vanilla ES module，零依赖）
//
// 三个视图：星图（Canvas2D）/ 域视图（表格）/ 审计时间线。
// 右侧设备卡；顶栏本机身份与连接对端（本机视角）。
// D1 只读；写交互由服务端 features.writes 开关控制（D2 打开）。
//
// `?mock=1` 使用内置演示数据，便于无网络验收。

import { StarStage, namespaceColor, shortId } from './starfield.js';
import { createWizardState, wizardReduce, selectedMemoryCount, WIZARD_STEPS } from './wizard.js';

const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const MOCK = params.get('mock') === '1';
const POLL_MS = 3000;

const ICONS = { online: '●', offline: '○', revoked: '⊘' };

const state = {
  view: 'map',
  overview: null,
  devices: [],
  policy: [],
  namespaces: [],
  selected: null,
  degraded: null,
  error: null,
  csrf: readCookie('mebular_csrf'),
  token: params.get('token') ?? localStorage.getItem('mebular_token') ?? null,
  features: { writes: false },
};

const stage = new StarStage($('#stage'));

// ---------- 网络 ----------

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function api(path, options = {}) {
  const headers = { accept: 'application/json', ...(options.headers ?? {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (options.method && options.method !== 'GET') {
    if (state.csrf) headers['x-mebular-csrf'] = state.csrf;
  }
  const res = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const csrfHeader = res.headers.get('x-mebular-csrf');
  if (csrfHeader) state.csrf = csrfHeader;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !state.token) {
      const token = window.prompt('serve 需要 bearer token（读需 memory.read，写需 memory.admin）：', '');
      if (token) {
        state.token = token.trim();
        localStorage.setItem('mebular_token', state.token);
        startEvents();
      }
    }
    const error = new Error(data?.message ?? data?.error ?? `HTTP ${res.status}`);
    error.status = res.status;
    error.payload = data;
    throw error;
  }
  return data;
}

async function refresh() {
  if (MOCK) {
    const mock = await mockData();
    state.overview = mock.overview;
    state.devices = mock.devices;
    state.policy = mock.policy;
    state.namespaces = mock.namespaces;
    state.features = { writes: false };
    state.error = null;
    state.degraded = mock.degraded;
    render();
    return;
  }
  const results = await Promise.allSettled([
    api('/admin/api/overview'),
    api('/admin/api/devices'),
    api('/admin/api/policy'),
    api('/admin/api/namespaces'),
  ]);
  const [overview, devices, policy, namespaces] = results;
  let firstError = null;
  if (overview.status === 'fulfilled') state.overview = overview.value;
  else firstError = overview.reason;
  if (devices.status === 'fulfilled') state.devices = devices.value;
  else firstError = firstError ?? devices.reason;
  if (policy.status === 'fulfilled') state.policy = policy.value;
  if (namespaces.status === 'fulfilled') state.namespaces = namespaces.value;
  state.features = { writes: Boolean(state.overview?.features?.writes) };
  state.error = firstError;
  state.degraded = computeDegraded();
  render();
}

function computeDegraded() {
  if (state.error) return `无法连接本机 serve：${state.error.message}`;
  const status = state.overview?.status;
  if (!status) return '尚未取得状态';
  if (!status.running) return '未启用 P2P：仅显示本机记忆与授权，连接与同步不可用';
  return null;
}

// ---------- 渲染 ----------

function render() {
  if (!state.selected && params.get('select')) {
    state.selected = state.devices.find((d) => d.deviceId === params.get('select')) ?? null;
  }
  renderTopbar();
  renderLegend();
  renderStageScene();
  renderDeviceCard();
  renderDomains();
  renderAudit();
  renderBanner();
  renderEmptyState();
}

function renderTopbar() {
  const status = state.overview?.status;
  const selfEl = $('#self-badge');
  const onlineEl = $('#online-badge');
  const memEl = $('#memory-badge');
  if (state.overview?.device) {
    selfEl.textContent = `本机 · ${state.overview.device.deviceId}`;
  } else {
    selfEl.textContent = '本机 · …';
  }
  const online = Boolean(status?.running);
  onlineEl.textContent = online ? `${ICONS.online} P2P 已启用` : `${ICONS.offline} P2P 未启用`;
  onlineEl.className = `badge ${online ? 'badge-ok' : 'badge-muted'}`;
  memEl.textContent = status ? `记忆 ${status.nodeCount}` : '记忆 …';
  memEl.className = 'badge badge-muted';
}

function allNamespaceNames() {
  const names = new Set();
  for (const entry of state.namespaces) names.add(entry.namespace);
  for (const device of state.devices) {
    for (const ns of [...device.grantedByMe, ...device.grantedToMe]) names.add(ns);
  }
  for (const event of state.policy) {
    for (const ns of event.namespaces ?? []) names.add(ns);
  }
  return [...names].sort();
}

function renderLegend() {
  const list = $('#namespace-legend');
  const names = allNamespaceNames();
  list.innerHTML = '';
  if (names.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '暂无分区';
    list.append(li);
    return;
  }
  for (const name of names) {
    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = 'legend-chip ns-chip';
    chip.style.background = namespaceColor(name);
    chip.textContent = '';
    const label = document.createElement('span');
    label.textContent = name;
    li.append(chip, label);
    list.append(li);
  }
}

function buildScene() {
  const selfId = state.overview?.device?.deviceId;
  if (!selfId) return { nodes: [], edges: [] };
  const nodes = [{
    id: selfId,
    label: '★ 本机',
    self: true,
    online: true,
    revoked: false,
  }];
  const edges = [];
  const revokedGrants = state.policy.filter((event) => event.type === 'namespace_grant' && !event.valid);

  for (const device of state.devices) {
    if (device.deviceId === selfId) continue;
    nodes.push({
      id: device.deviceId,
      label: shortId(device.deviceId),
      online: device.online,
      revoked: device.revoked,
      namespaces: [...device.grantedByMe, ...device.grantedToMe],
      pendingEventCount: device.pendingEventCount ?? 0,
    });
    const mineActive = device.grantedByMe.length > 0;
    const theirsActive = device.grantedToMe.length > 0;
    const mineRevoked = !mineActive && revokedGrants.some((e) => e.issuer === selfId && e.subject === device.deviceId);
    const theirsRevoked = !theirsActive && revokedGrants.some((e) => e.issuer === device.deviceId && e.subject === selfId);
    if (mineActive || mineRevoked) {
      edges.push({
        from: selfId,
        to: device.deviceId,
        kind: 'mine',
        online: device.online,
        revoked: mineRevoked,
        pending: mineRevoked ? 0 : device.pendingEventCount ?? 0,
      });
    }
    if (theirsActive || theirsRevoked) {
      edges.push({
        from: device.deviceId,
        to: selfId,
        kind: 'theirs',
        online: device.online,
        revoked: theirsRevoked,
        pending: 0,
      });
    }
  }
  return { nodes, edges };
}

function renderStageScene() {
  stage.setScene(buildScene());
  stage.setSelected(state.selected?.deviceId ?? null);
}

function renderBanner() {
  const banner = $('#banner');
  if (state.error) {
    banner.hidden = false;
    banner.className = 'banner is-error';
    banner.textContent = `无法连接本机 serve：${state.error.message}（保留上次数据）`;
    return;
  }
  if (state.degraded) {
    banner.hidden = false;
    banner.className = 'banner';
    banner.textContent = state.degraded;
    return;
  }
  banner.hidden = true;
}

function renderEmptyState() {
  const el = $('#empty-state');
  const show = state.view === 'map'
    && !state.error
    && state.devices.filter((d) => d.deviceId !== state.overview?.device?.deviceId).length === 0;
  el.hidden = !show;
  if (show) {
    el.innerHTML = '<strong>还没有其他设备</strong>'
      + '我的关系图目前只有本机。<br />'
      + '点击右上角「＋ 连接新对端」与对端建立连接；本视图只显示你与已知对端的关系。';
  }
}

function renderDomains() {
  const body = $('#domains-body');
  body.innerHTML = '';
  if (state.namespaces.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'muted';
    td.textContent = '暂无分区记忆。';
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const entry of state.namespaces) {
    const tr = document.createElement('tr');
    const ns = document.createElement('td');
    const chip = document.createElement('span');
    chip.className = 'ns-chip';
    chip.style.background = namespaceColor(entry.namespace);
    chip.textContent = entry.namespace;
    ns.append(chip);
    const count = document.createElement('td');
    count.textContent = String(entry.count);
    const updated = document.createElement('td');
    updated.textContent = entry.lastUpdatedAt ? formatTime(entry.lastUpdatedAt) : '—';
    const hash = document.createElement('td');
    hash.className = 'hash';
    hash.title = entry.stateHash ?? '';
    hash.textContent = entry.stateHash ? entry.stateHash.slice(0, 16) : '—';
    tr.append(ns, count, updated, hash);
    body.append(tr);
  }
}

function renderAudit() {
  const actionFilter = $('#audit-filter-action').value;
  const deviceFilter = $('#audit-filter-device').value;
  const nsFilter = $('#audit-filter-namespace').value;

  populateAuditFilters();

  const list = $('#audit-list');
  list.innerHTML = '';
  const events = state.policy.filter((event) => {
    if (actionFilter && event.type !== actionFilter) return false;
    if (deviceFilter && event.issuer !== deviceFilter && event.subject !== deviceFilter) return false;
    if (nsFilter && !(event.namespaces ?? []).includes(nsFilter)) return false;
    return true;
  });
  if (events.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '没有匹配的政策事件。';
    list.append(li);
    return;
  }
  for (const event of events) {
    const li = document.createElement('li');
    li.className = `audit-item${event.valid ? '' : ' invalid'}`;
    const time = document.createElement('span');
    time.className = 'audit-time';
    time.textContent = formatTime(event.at);
    const action = document.createElement('span');
    const actionClass = event.type === 'namespace_grant' ? 'grant'
      : event.type === 'namespace_revoke' ? 'revoke' : 'device';
    action.className = `audit-action ${actionClass}`;
    action.textContent = actionLabel(event.type);
    const detail = document.createElement('span');
    detail.className = 'audit-detail';
    detail.innerHTML = describeEvent(event);
    li.append(time, action, detail);
    list.append(li);
  }
}

function populateAuditFilters() {
  const deviceSelect = $('#audit-filter-device');
  const nsSelect = $('#audit-filter-namespace');
  if (deviceSelect.dataset.populated !== '1') {
    const ids = new Set();
    for (const d of state.devices) ids.add(d.deviceId);
    for (const e of state.policy) { ids.add(e.issuer); ids.add(e.subject); }
    for (const id of [...ids].filter(Boolean).sort()) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      deviceSelect.append(option);
    }
    deviceSelect.dataset.populated = '1';
  }
  if (nsSelect.dataset.populated !== '1') {
    for (const ns of allNamespaceNames()) {
      const option = document.createElement('option');
      option.value = ns;
      option.textContent = ns;
      nsSelect.append(option);
    }
    nsSelect.dataset.populated = '1';
  }
}

function actionLabel(type) {
  if (type === 'namespace_grant') return '授权';
  if (type === 'namespace_revoke') return '撤销域';
  if (type === 'device_revoke') return '屏蔽设备';
  if (type === 'policy_issuer_declare') return '声明签发者';
  if (type === 'namespace_membership') return '成员变更';
  if (type === 'namespace_handoff') return '退订交接';
  return type;
}

function describeEvent(event) {
  if (event.type === 'namespace_grant') {
    const namespaces = (event.namespaces ?? []).map((ns) => `<span class="ns-chip" style="background:${namespaceColor(ns)}">${escapeHtml(ns)}</span>`).join(' ');
    return `签发者 <b>${escapeHtml(event.issuer)}</b> → <b>${escapeHtml(event.subject)}</b> ${namespaces} `
      + `<span class="muted">grantId=${escapeHtml(event.grantId ?? '')}${event.valid ? '' : ' · 已失效'}</span>`;
  }
  if (event.type === 'namespace_revoke') {
    return `签发者 <b>${escapeHtml(event.issuer)}</b> 撤销 grantId=${escapeHtml(event.grantId ?? '')}`
      + `${event.subject ? `（对象 ${escapeHtml(event.subject)}）` : ''}`;
  }
  if (event.type === 'device_revoke') {
    return `签发者 <b>${escapeHtml(event.issuer)}</b> 屏蔽设备 <b>${escapeHtml(event.subject)}</b>（本机不再采纳其政策记录）`
      + `${event.valid ? '' : ' · 已不再屏蔽'}`;
  }
  if (event.type === 'policy_issuer_declare') {
    return `签发者 <b>${escapeHtml(event.issuer)}</b> 在图上声明 <b>${escapeHtml(event.subject)}</b> 为引导签发者`
      + `<span class="muted">${event.valid ? '' : ' · 已不再生效'}</span>`;
  }
  if (event.type === 'namespace_membership') {
    const ns = `<span class="ns-chip" style="background:${namespaceColor(event.namespace ?? 'default')}">${escapeHtml(event.namespace ?? 'default')}</span>`;
    return `签发者 <b>${escapeHtml(event.issuer)}</b> 将 <b>${escapeHtml(event.subject)}</b> ${event.active === false ? '移出' : '加入'} ${ns} 成员`
      + `<span class="muted">${event.valid ? '' : ' · 已不再生效'}</span>`;
  }
  if (event.type === 'namespace_handoff') {
    const ns = `<span class="ns-chip" style="background:${namespaceColor(event.namespace ?? 'default')}">${escapeHtml(event.namespace ?? 'default')}</span>`;
    return `签发者 <b>${escapeHtml(event.issuer)}</b> 将 ${ns} 交接给 <b>${escapeHtml(event.subject ?? '—')}</b>`
      + `<span class="muted">${event.forced ? ' · forced' : ''} · 未覆盖 ${event.pendingCount ?? 0}</span>`;
  }
  return '';
}

function renderDeviceCard() {
  const empty = $('#device-card-empty');
  const body = $('#device-card-body');
  if (!state.selected) {
    empty.hidden = false;
    body.hidden = true;
    return;
  }
  empty.hidden = true;
  body.hidden = false;
  const device = state.devices.find((d) => d.deviceId === state.selected.deviceId) ?? state.selected;
  const isSelf = device.deviceId === state.overview?.device?.deviceId;
  const statusChips = [];
  statusChips.push(device.revoked ? `${ICONS.revoked} 已被我屏蔽` : (device.online ? `${ICONS.online} 与我连接中` : `${ICONS.offline} 未连接`));
  if (device.pendingEventCount !== null && device.pendingEventCount !== undefined) {
    statusChips.push(`待发 ${device.pendingEventCount}`);
  }
  if (device.lastSyncAt) statusChips.push(`最近同步 ${formatTime(device.lastSyncAt)}`);

  const allNamespaces = allNamespaceNames();
  const writes = state.features.writes && !isSelf && !MOCK;
  const rows = allNamespaces.length === 0
    ? '<li class="muted">暂无已知分区</li>'
    : allNamespaces.map((ns) => {
      const mineOn = device.grantedByMe.includes(ns);
      const theirsOn = device.grantedToMe.includes(ns);
      return `<li>
        <span><span class="ns-chip" style="background:${namespaceColor(ns)}">${escapeHtml(ns)}</span>
          ${theirsOn && !mineOn ? '<span class="muted" style="margin-left:6px">它授权我</span>' : ''}</span>
        <label class="toggle" title="${mineOn ? '关闭：撤销我对该域的授权' : '打开：签发新授权'}">
          <input type="checkbox" data-ns="${escapeHtml(ns)}" aria-label="共享域 ${escapeHtml(ns)}（当前${mineOn ? '已授权' : '未授权'}）" ${mineOn ? 'checked' : ''} ${writes ? '' : 'disabled'}>
          <span class="slider"></span>
        </label>
      </li>`;
    }).join('');

  const actions = isSelf ? '' : `
    <div class="card-actions">
      <button class="btn btn-small" data-action="sync" ${writes && device.online ? '' : 'disabled'}>立即同步</button>
      <button class="btn btn-small" data-action="connect" ${writes && !device.online ? '' : 'disabled'}>连接</button>
      <button class="btn btn-small" data-action="disconnect" ${writes && device.online ? '' : 'disabled'}>断开连接</button>
      <button class="btn btn-small" data-action="reset-watermarks" ${writes ? '' : 'disabled'}>重置水位</button>
      <button class="btn btn-small btn-danger" data-action="revoke-device" ${writes ? '' : 'disabled'}>屏蔽该设备</button>
    </div>
    ${writes ? '' : '<p class="muted" style="margin-top:10px">当前为只读模式（写操作需 memory.admin + CSRF）。</p>'}`;

  body.innerHTML = `
    <dl class="kv">
      <dt>deviceId</dt><dd>${escapeHtml(device.deviceId)}</dd>
      <dt>状态</dt><dd>${escapeHtml(statusChips.join(' · '))}</dd>
      <dt>我授权它</dt><dd>${escapeHtml(device.grantedByMe.join(', ') || '—')}</dd>
      <dt>它授权我</dt><dd>${escapeHtml(device.grantedToMe.join(', ') || '—')}</dd>
      <dt>最近同步</dt><dd>${device.lastSyncAt ? formatTime(device.lastSyncAt) : '—'}</dd>
      <dt>待发事件</dt><dd>${device.pendingEventCount ?? '—'}</dd>
    </dl>
    <h3>我授权的域</h3>
    <ul class="chip-list">${rows}</ul>
    ${actions}
  `;

  body.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => handleDeviceAction(button.dataset.action, device));
  });
  body.querySelectorAll('input[data-ns]').forEach((input) => {
    input.addEventListener('change', () => handleDomainToggle(device, input.dataset.ns, input.checked, input));
  });
}

// ---------- 交互 ----------

stage.onHover = (node, x, y) => {
  const tooltip = $('#tooltip');
  if (!node) {
    tooltip.hidden = true;
    return;
  }
  const device = state.devices.find((d) => d.deviceId === node.id);
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(x + 14, stage.width - 290)}px`;
  tooltip.style.top = `${Math.min(y + 14, Math.max(0, stage.height - 120))}px`;
  tooltip.innerHTML = `
    <div class="tt-title">${escapeHtml(node.self ? '本机' : node.id)}</div>
    <div class="tt-row">${node.revoked ? '已被我屏蔽' : node.online ? '与我连接中' : '未连接'}</div>
    ${device && (device.grantedByMe.length || device.grantedToMe.length)
      ? `<div class="tt-row">我授权：${escapeHtml(device.grantedByMe.join(', ') || '—')}</div>
         <div class="tt-row">授权我：${escapeHtml(device.grantedToMe.join(', ') || '—')}</div>`
      : ''}
  `;
};

stage.onSelect = (node) => {
  if (!node) return;
  const device = state.devices.find((d) => d.deviceId === node.id);
  state.selected = device ?? {
    deviceId: node.id,
    online: node.online,
    revoked: node.revoked,
    grantedByMe: [],
    grantedToMe: [],
    pendingEventCount: null,
  };
  renderStageScene();
  renderDeviceCard();
};

$('#view-nav').addEventListener('click', (event) => {
  const button = event.target.closest('.view-btn');
  if (!button) return;
  setView(button.dataset.view);
});

function setView(view) {
  state.view = view;
  document.querySelectorAll('.view-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.view === view);
  });
  $('#domains-view').hidden = view !== 'domains';
  $('#audit-view').hidden = view !== 'audit';
  $('#stage').style.visibility = view === 'map' ? 'visible' : 'hidden';
  $('#empty-state').hidden = true;
  renderEmptyState();
}

$('#audit-filter-action').addEventListener('change', renderAudit);
$('#audit-filter-device').addEventListener('change', renderAudit);
$('#audit-filter-namespace').addEventListener('change', renderAudit);

$('#audit-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.policy, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `mebular-policy-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

// ---------- 写操作（D2；features.writes 打开后可用） ----------

function grantsCovering(deviceId, ns) {
  const selfId = state.overview?.device?.deviceId;
  return state.policy
    .filter((event) => event.type === 'namespace_grant'
      && event.valid
      && event.issuer === selfId
      && event.subject === deviceId
      && (event.namespaces ?? []).includes(ns))
    .map((event) => event.grantId);
}

async function handleDomainToggle(device, ns, on, input) {
  input.disabled = true;
  try {
    if (MOCK) {
      window.alert('mock 模式不执行写操作。');
      input.checked = !on;
      return;
    }
    if (on) {
      await api('/admin/api/grants', { method: 'POST', body: { subject: device.deviceId, namespaces: [ns] } });
      showToast(`已授权「${ns}」给 ${device.deviceId}`);
      await refresh();
    } else {
      const ok = await confirmModal({
        title: `撤销域 ${ns}`,
        body: `${device.deviceId} 不会再收到关于「${ns}」的新记忆；已同步内容不会撤回；可用新授权恢复。`,
        confirmLabel: '撤销授权',
      });
      if (!ok) {
        input.checked = true;
        return;
      }
      const grantIds = grantsCovering(device.deviceId, ns);
      for (const grantId of grantIds) {
        await api(`/admin/api/grants/${encodeURIComponent(grantId)}/revoke`, { method: 'POST', body: {} });
      }
      showToast(grantIds.length > 0 ? `已撤销「${ns}」` : `「${ns}」没有可撤销的授权`);
      await refresh();
    }
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
    input.checked = !on;
  } finally {
    input.disabled = false;
  }
}

async function handleDeviceAction(action, device) {
  if (action === 'sync') {
    const self = state.overview?.device?.deviceId;
    if (self) stage.launchFleet(self, device.deviceId, { kind: 'mine', ships: 3 });
    await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/sync`, {}, '已触发同步（有 pending 时立即开会话）');
  } else if (action === 'connect') {
    const address = window.prompt('对方的 multiaddr（含 /p2p/…）：', '');
    if (!address) return;
    await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/connect`, { address }, '已发起连接');
  } else if (action === 'disconnect') {
    await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/disconnect`, {}, '已断开');
  } else if (action === 'reset-watermarks') {
    const ok = await confirmModal({
      title: '重置同步水位',
      body: `将清除与 ${device.deviceId} 的本机同步水位。已同步内容不会撤回；最多导致已确认事件冗余重发一次。`,
      confirmLabel: '重置',
    });
    if (ok) await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/reset-watermarks`, {}, '水位已重置');
  } else if (action === 'revoke-device') {
    const ok = await confirmModal({
      title: `屏蔽设备 ${device.deviceId}`,
      body: `${device.deviceId} 签发的政策记录将不再被本机采纳，本机也不再向它发送数据；已同步数据不回撤；可重新授权恢复。`,
      confirmLabel: '屏蔽该设备',
    });
    if (ok) await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/revoke`, {}, '已在本地屏蔽该设备');
  }
}

async function runWrite(path, body, successMessage) {
  if (MOCK) {
    window.alert('mock 模式不执行写操作。');
    return;
  }
  try {
    const result = await api(path, { method: 'POST', body });
    await refresh();
    showToast(`${successMessage}${result?.grantId ? `（grantId=${result.grantId}）` : ''}`);
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
  }
}

function showToast(message) {
  const banner = $('#banner');
  banner.hidden = false;
  banner.className = 'banner';
  banner.textContent = message;
  setTimeout(renderBanner, 2500);
}

// ---------- 模态 ----------

let modalResolve = null;
function confirmModal({ title, body, confirmLabel }) {
  $('#modal-title').textContent = title;
  $('#modal-body').textContent = body;
  $('#modal-confirm').textContent = confirmLabel ?? '确认';
  $('#modal').hidden = false;
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

$('#modal-cancel').addEventListener('click', () => {
  $('#modal').hidden = true;
  if (modalResolve) modalResolve(false);
  modalResolve = null;
});
$('#modal-confirm').addEventListener('click', () => {
  $('#modal').hidden = true;
  if (modalResolve) modalResolve(true);
  modalResolve = null;
});

$('#add-device').addEventListener('click', openWizard);
$('#wizard-close').addEventListener('click', closeWizard);
$('#wizard-back').addEventListener('click', () => wizardSet({ type: 'BACK' }));
$('#wizard-next').addEventListener('click', wizardNext);

// ---------- 连接新对端向导 ----------

const STEP_LABELS = {
  local: '① 本机信息 / 对端地址',
  connect: '② 建立连接',
  domains: '③ 选择共享域',
  done: '④ 完成',
};

let wizardState = createWizardState();

function openWizard() {
  wizardState = createWizardState();
  $('#wizard').hidden = false;
  renderWizard();
}

function closeWizard() {
  $('#wizard').hidden = true;
}

function wizardSet(action) {
  wizardState = wizardReduce(wizardState, action);
  renderWizard();
}

function renderWizard() {
  const order = [...WIZARD_STEPS, 'done'];
  const index = order.indexOf(wizardState.step);
  $('#wizard-steps').innerHTML = order
    .map((step, i) => `<span class="${i === index ? 'active' : ''}">${STEP_LABELS[step]}</span>`)
    .join(' › ');
  const error = $('#wizard-error');
  error.hidden = !wizardState.error;
  error.textContent = wizardState.error ?? '';
  const body = $('#wizard-body');
  const next = $('#wizard-next');
  const back = $('#wizard-back');

  if (wizardState.step === 'local') {
    const device = state.overview?.device ?? {};
    const multiaddrs = device.multiaddrs ?? [];
    body.innerHTML = `
      <p class="wizard-note">把本机地址给对面，并粘贴对面的 deviceId 与 multiaddr。</p>
      <div class="field"><label>本机 deviceId</label><div class="copyable"><code>${escapeHtml(device.deviceId ?? '—')}</code><button class="btn btn-small" data-copy="${escapeHtml(device.deviceId ?? '')}">复制</button></div></div>
      <div class="field"><label>本机 peerId</label><div class="copyable"><code>${escapeHtml(device.peerId ?? '—')}</code>${device.peerId ? `<button class="btn btn-small" data-copy="${escapeHtml(device.peerId)}">复制</button>` : ''}</div></div>
      <div class="field"><label>本机 multiaddrs</label>${multiaddrs.length
        ? multiaddrs.map((addr) => `<div class="copyable"><code>${escapeHtml(addr)}</code><button class="btn btn-small" data-copy="${escapeHtml(addr)}">复制</button></div>`).join('')
        : '<code class="muted">（未启用 P2P，无监听地址）</code>'}</div>
      <div class="field"><label>relay（可选）</label><code>${escapeHtml((device.relays ?? []).join(', ') || '—')}</code></div>
      <div class="field"><label>对方 deviceId</label><input id="wizard-device" type="text" value="${escapeHtml(wizardState.deviceId)}" placeholder="device-B" /></div>
      <div class="field"><label>对方 multiaddr</label><textarea id="wizard-address" placeholder="/ip4/…/tcp/…/p2p/…">${escapeHtml(wizardState.address)}</textarea></div>
    `;
    next.textContent = '连接';
    next.disabled = false;
    back.disabled = true;
    bindWizardFields();
  } else if (wizardState.step === 'connect') {
    const status = wizardState.connection === 'connected'
      ? '● 已连接并完成认证'
      : wizardState.connection === 'connecting'
        ? '◌ 连接中…'
        : wizardState.connection === 'failed' ? '✗ 连接失败' : '○ 待连接';
    body.innerHTML = `
      <p class="wizard-note">目标：<code>${escapeHtml(wizardState.deviceId)}</code> @ <code>${escapeHtml(wizardState.address)}</code></p>
      <p><b>${status}</b></p>
      ${wizardState.connection === 'failed'
        ? '<p class="wizard-note">可行动建议：确认对面已运行 serve、multiaddr 含 /p2p/&lt;peerId&gt;、端口可达；修正后重试。</p>'
        : ''}
    `;
    next.textContent = wizardState.connection === 'connected' ? '下一步' : '重试';
    next.disabled = wizardState.connection === 'connecting';
    back.disabled = wizardState.connection === 'connecting';
  } else if (wizardState.step === 'domains') {
    const entries = state.namespaces;
    body.innerHTML = `
      <p class="wizard-note">选择要共享给 <code>${escapeHtml(wizardState.deviceId)}</code> 的域（默认全不选）。将共享约 ${selectedMemoryCount(entries, wizardState.selected)} 条记忆。</p>
      <ul class="wizard-list">${entries.length
        ? entries.map((entry) => {
          const checked = wizardState.selected.includes(entry.namespace);
          return `<li><label><input type="checkbox" data-wizard-ns="${escapeHtml(entry.namespace)}" ${checked ? 'checked' : ''}> <span class="ns-chip" style="background:${namespaceColor(entry.namespace)}">${escapeHtml(entry.namespace)}</span> <span class="muted">${entry.count} 条</span></label></li>`;
        }).join('')
        : '<li class="muted">暂无分区</li>'}</ul>
    `;
    next.textContent = wizardState.granting ? '签发中…' : '签发授权';
    next.disabled = wizardState.granting || wizardState.selected.length === 0;
    back.disabled = wizardState.granting;
    body.querySelectorAll('input[data-wizard-ns]').forEach((input) => {
      input.addEventListener('change', () => wizardSet({ type: 'TOGGLE_NAMESPACE', namespace: input.dataset.wizardNs }));
    });
  } else if (wizardState.step === 'done') {
    body.innerHTML = `
      <p class="wizard-note">已向 <code>${escapeHtml(wizardState.deviceId)}</code> 签发授权。</p>
      <div class="field"><label>grantId</label><div class="copyable"><code>${escapeHtml(wizardState.grantId ?? '')}</code><button class="btn btn-small" data-copy="${escapeHtml(wizardState.grantId ?? '')}">复制</button></div></div>
      <p class="wizard-note">之后可在设备卡继续调整域开关。</p>
    `;
    next.textContent = '完成';
    next.disabled = false;
    back.disabled = true;
  }
  body.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => copyText(button.dataset.copy, button));
  });
}

function bindWizardFields() {
  const deviceInput = $('#wizard-device');
  const addressInput = $('#wizard-address');
  if (deviceInput) deviceInput.addEventListener('input', () => {
    wizardState = wizardReduce(wizardState, { type: 'PEER_INPUT', deviceId: deviceInput.value });
  });
  if (addressInput) addressInput.addEventListener('input', () => {
    wizardState = wizardReduce(wizardState, { type: 'PEER_INPUT', address: addressInput.value });
  });
}

async function copyText(text, button) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const old = button.textContent;
      button.textContent = '已复制';
      setTimeout(() => { button.textContent = old; }, 1200);
    }
  } catch {
    window.prompt('复制：', text);
  }
}

async function doWizardConnect() {
  if (MOCK) {
    wizardSet({ type: 'CONNECT_FAILURE', message: 'mock 模式不执行连接' });
    return;
  }
  try {
    await api(`/admin/api/devices/${encodeURIComponent(wizardState.deviceId)}/connect`, {
      method: 'POST',
      body: { address: wizardState.address },
    });
    wizardSet({ type: 'CONNECT_SUCCESS' });
    await refresh();
  } catch (error) {
    wizardSet({ type: 'CONNECT_FAILURE', message: error.message });
  }
}

async function wizardNext() {
  if (wizardState.step === 'local') {
    wizardState = wizardReduce(wizardState, { type: 'GO_CONNECT' });
    renderWizard();
    if (wizardState.step !== 'connect') return;
    await doWizardConnect();
  } else if (wizardState.step === 'connect') {
    if (wizardState.connection === 'connected') wizardSet({ type: 'GO_DOMAINS' });
    else await doWizardConnect();
  } else if (wizardState.step === 'domains') {
    wizardState = wizardReduce(wizardState, { type: 'GRANT_START' });
    renderWizard();
    if (wizardState.granting !== true) return;
    if (MOCK) {
      wizardSet({ type: 'GRANT_FAILURE', message: 'mock 模式不执行签发' });
      return;
    }
    try {
      const result = await api('/admin/api/grants', {
        method: 'POST',
        body: { subject: wizardState.deviceId, namespaces: wizardState.selected },
      });
      wizardSet({ type: 'GRANT_SUCCESS', grantId: result.grantId });
      await refresh();
    } catch (error) {
      wizardSet({ type: 'GRANT_FAILURE', message: error.message });
    }
  } else if (wizardState.step === 'done') {
    closeWizard();
  }
}

// ---------- 工具 ----------

function formatTime(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(ts);
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

// ---------- mock 数据 ----------

async function mockData() {
  const now = Date.now();
  return {
    overview: {
      device: { deviceId: 'device-A', name: 'device-A', peerId: 'peer-a', multiaddrs: ['/ip4/127.0.0.1/tcp/4001/p2p/peer-a'], relays: [] },
      status: {
        deviceId: 'device-A', peerId: 'peer-a', running: true, listenAddrs: ['/ip4/127.0.0.1/tcp/4001/p2p/peer-a'],
        relays: [], nodeCount: 128, edgeCount: 64, stateHash: 'demo', stateHashByNamespace: { notes: 'h1', work: 'h2', default: 'h3' },
        atRest: false, semantic: false, pendingEventCount: 3,
      },
      onlinePeers: [{ peerId: 'peer-b', deviceId: 'device-B', remoteAddress: '/ip4/127.0.0.1/tcp/4011', state: 'connected', authenticated: true }],
      revokedCount: 1,
      features: { writes: false },
    },
    devices: [
      { deviceId: 'device-A', online: true, grantedByMe: ['notes', 'work'], grantedToMe: [], revoked: false, pendingEventCount: 0 },
      { deviceId: 'device-B', online: true, peerId: 'peer-b', addrs: ['/ip4/127.0.0.1/tcp/4011'], lastSyncAt: now - 65_000, grantedByMe: ['notes'], grantedToMe: ['work'], revoked: false, pendingEventCount: 3 },
      { deviceId: 'device-C', online: false, grantedByMe: ['work'], grantedToMe: [], revoked: false, pendingEventCount: 1 },
      { deviceId: 'device-D', online: false, grantedByMe: [], grantedToMe: [], revoked: true },
    ],
    namespaces: [
      { namespace: 'notes', count: 42, lastUpdatedAt: now - 120_000, stateHash: 'h1' },
      { namespace: 'work', count: 70, lastUpdatedAt: now - 300_000, stateHash: 'h2' },
      { namespace: 'default', count: 16, lastUpdatedAt: now - 900_000, stateHash: 'h3' },
    ],
    policy: [
      { eventId: 'e5', type: 'namespace_grant', issuer: 'device-A', subject: 'device-C', namespaces: ['work'], grantId: 'g-c', at: now - 300_000, valid: true },
      { eventId: 'e3', type: 'namespace_revoke', issuer: 'device-A', subject: 'device-D', grantId: 'g-d', at: now - 600_000, valid: true },
      { eventId: 'e2', type: 'device_revoke', issuer: 'device-A', subject: 'device-D', at: now - 700_000, valid: true },
      { eventId: 'e0', type: 'namespace_grant', issuer: 'device-A', subject: 'device-D', namespaces: ['work'], grantId: 'g-d', at: now - 800_000, valid: false },
      { eventId: 'e1', type: 'namespace_grant', issuer: 'device-A', subject: 'device-B', namespaces: ['notes'], grantId: 'g-b', at: now - 900_000, valid: true },
    ],
    degraded: null,
  };
}

// ---------- 启动 ----------

let eventSource = null;
let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, 700);
}

function startEvents() {
  if (MOCK || typeof window.EventSource === 'undefined') return;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  const tokenParam = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
  try {
    eventSource = new EventSource(`/admin/events${tokenParam}`);
  } catch {
    return;
  }
  const onPulse = () => {
    stage.pulse();
    scheduleRefresh();
  };
  // 同步完成 → 按数据流方向让舰队沿航道出航（发/收可各自成队）
  const onSyncPulse = (event) => {
    onPulse();
    try {
      const data = JSON.parse(event?.data ?? '{}');
      const self = state.overview?.device?.deviceId;
      const peer = data.peerDeviceId;
      if (!self || !peer || self === peer) return;
      const sent = Number(data.sentEvents ?? 0);
      const received = Number(data.receivedEvents ?? 0);
      if (sent > 0) stage.launchFleet(self, peer, { kind: 'mine', ships: Math.min(5, 2 + sent) });
      if (received > 0) stage.launchFleet(peer, self, { kind: 'theirs', ships: Math.min(5, 2 + received) });
      if (sent === 0 && received === 0) stage.launchFleet(self, peer, { kind: 'mine', ships: 2 });
    } catch {
      // 非 JSON 负载：仅做脉冲
    }
  };
  eventSource.addEventListener('status', onPulse);
  eventSource.addEventListener('sync', onSyncPulse);
  eventSource.addEventListener('sync-failed', onPulse);
  eventSource.onerror = () => {
    // EventSource 会自动重连；网络关闭时保持静默
  };
}

stage.start();
setView('map');
refresh();
startEvents();
setInterval(refresh, POLL_MS);
