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
  selectedNamespace: null,
  settings: null,
  rawConfig: null,
  cfgDraft: {},
  inviteToken: null,
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
    api('/admin/api/settings'),
    api('/admin/api/config'),
  ]);
  const [overview, devices, policy, namespaces, settings, configView] = results;
  let firstError = null;
  if (overview.status === 'fulfilled') state.overview = overview.value;
  else firstError = overview.reason;
  if (devices.status === 'fulfilled') state.devices = devices.value;
  else firstError = firstError ?? devices.reason;
  if (policy.status === 'fulfilled') state.policy = policy.value;
  if (namespaces.status === 'fulfilled') state.namespaces = namespaces.value;
  if (settings.status === 'fulfilled') state.settings = settings.value;
  if (configView.status === 'fulfilled') state.rawConfig = configView.value;
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
  const selectParam = new URLSearchParams(location.search).get('select');
  if (!state.selected && selectParam) {
    state.selected = state.devices.find((d) => d.deviceId === selectParam) ?? null;
  }
  renderTopbar();
  renderLegend();
  renderStageScene();
  renderDeviceCard();
  renderDomains();
  renderAudit();
  if (!$('#settings').hidden) renderSettings();
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
  const list = $('#domains-list');
  const detail = $('#domain-detail');
  const stats = $('#domains-stats');
  const items = state.namespaces ?? [];

  if (stats) {
    const memberEnabled = items.filter((n) => n.membershipEnabled).length;
    stats.innerHTML = `<span class="crt-tag">分区 ${items.length}</span><span class="crt-tag">成员制 ${memberEnabled}</span>`;
  }
  if (items.length === 0) {
    list.innerHTML = '<p class="muted" style="padding:8px">暂无分区记忆。</p>';
    detail.innerHTML = '';
    return;
  }
  // 选中保持：默认第一个；轮询刷新不丢选择
  if (!items.some((n) => n.namespace === state.selectedNamespace)) {
    state.selectedNamespace = items[0].namespace;
  }
  const selected = items.find((n) => n.namespace === state.selectedNamespace);
  const taskNs = state.settings?.fleet?.namespace ?? null;
  list.innerHTML = items.map((n) => {
    const active = n.namespace === state.selectedNamespace;
    const memberLabel = n.membershipEnabled ? `${n.effectiveMembers.length}/${n.members.length}` : '仅授权';
    const isTask = taskNs !== null && n.namespace === taskNs;
    return `<button class="sector-item${active ? ' is-active' : ''}" data-sector="${escapeHtml(n.namespace)}" type="button">
      <span class="sector-dot${n.membershipEnabled ? ' is-on' : ''}"></span>
      <span class="sector-name"><span class="ns-chip" style="background:${namespaceColor(n.namespace)}">${escapeHtml(n.namespace)}</span>
        <span class="sector-meta">${n.count} 条${n.rejoinReset ? ' · 待恢复' : ''}${isTask ? ' · 任务域' : ''}</span></span>
      <span class="sector-meta" title="生效/在册成员">${memberLabel}</span>
    </button>`;
  }).join('');
  renderDomainDetail(selected);

  list.querySelectorAll('[data-sector]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedNamespace = button.dataset.sector;
      renderDomains();
    });
  });
}

function renderDomainDetail(n) {
  const detail = $('#domain-detail');
  if (!n) {
    detail.innerHTML = '';
    return;
  }
  const writes = state.features.writes && !MOCK;
  const ns = n.namespace;

  const granted = (n.grantedTo ?? []).length
    ? n.grantedTo.map((g) => `<span class="member-chip" title="grantId=${escapeHtml(g.grantId)}">${escapeHtml(g.deviceId)}</span>`).join(' ')
    : '<span class="muted">—</span>';
  const members = n.membershipEnabled
    ? (n.members.length
      ? n.members.map((m) => {
        const eff = n.effectiveMembers.includes(m);
        const approve = !eff && writes
          ? `<button class="btn btn-small btn-crt" data-approve-member="${escapeHtml(m)}" data-ns="${escapeHtml(ns)}" title="批准准入：签发授权（已同步内容不回撤）">批准</button>`
          : '';
        return `<span class="member-chip ${eff ? 'is-effective' : ''}" title="${eff ? '在册且已授权（生效）' : '在册但缺授权（待批准）'}">${escapeHtml(m)}${eff ? ' ✓' : ''}</span>${approve}`;
      }).join(' ')
      : '<span class="muted">暂无在册成员</span>')
    : '<span class="muted">未启用成员制（只需授权）</span>';
  const rejoinTitle = !writes
    ? '只读模式'
    : n.selfAuthorized
      ? '清空本机该分区水位，请对端从 0 重发（或发初始快照）'
      : '需本机对该分区有生效授权（默认拒绝）';
  const rejoin = n.rejoinReset
    ? `<button class="btn btn-small btn-crt" data-rejoin="${escapeHtml(ns)}" ${(writes && n.selfAuthorized) ? '' : 'disabled'} title="${escapeHtml(rejoinTitle)}">重入恢复</button>`
    : '';

  const isTaskNs = (state.settings?.fleet?.namespace ?? null) === ns;
  detail.innerHTML = `<article class="sector-readout crt-surface crt-corners">
    <header class="readout-head">
      <span class="ns-chip" style="background:${namespaceColor(ns)}">${escapeHtml(ns)}</span>${isTaskNs ? '<span class="crt-tag">任务域</span>' : ''}
      <span class="readout-meta">${n.count} 条 · 最近更新 ${n.lastUpdatedAt ? formatTime(n.lastUpdatedAt) : '—'}</span>
      <span class="readout-meta">HASH ${n.stateHash ? escapeHtml(n.stateHash.slice(0, 10)) : '—'}</span>
      <span class="crt-tag${n.membershipEnabled ? '' : ' is-off'}">${n.membershipEnabled ? '成员制 ACTIVE' : '成员制 OFF'}</span>
      <span class="crt-tag${n.subscribed ? '' : ' is-off'}">${n.subscribed ? '本机关注' : '未关注'}</span>
      ${n.rejoinReset ? '<span class="crt-tag">待重入</span>' : ''}
    </header>
    ${isTaskNs ? '<p class="muted" style="font-size:11px;margin:6px 0 0">任务面：发起节点为根派发任务树，远端 Agent 执行后回传结果（有向无环）；成员/授权闸门同记忆域，但语义不是共享记忆池。</p>' : ''}
    <div class="readout-block"><span class="domain-label">AUTH →</span><div class="chip-wrap">${granted}</div></div>
    <div class="readout-block"><span class="domain-label">MEMBERS →</span><div class="chip-wrap">${members}<span class="muted" style="font-size:10.5px;margin-left:6px">在册 = 对端自声明；本机动作 = 批准准入</span></div></div>
    <div class="readout-block readout-actions">
      ${rejoin}
      <button class="btn btn-small btn-crt btn-crt-danger" data-handoff="${escapeHtml(ns)}" ${writes ? '' : 'disabled'} title="退订交接：继任者全量 ack 后才清理本机数据">退订交接…</button>
    </div>
  </article>`;

  bindDomainActions();
}

function bindDomainActions() {
  const detail = $('#domain-detail');
  detail.querySelectorAll('[data-approve-member]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (MOCK) {
        window.alert('mock 模式不执行写操作。');
        return;
      }
      button.disabled = true;
      try {
        await api('/admin/api/grants', { method: 'POST', body: { subject: button.dataset.approveMember, namespaces: [button.dataset.ns] } });
        showToast(`已批准 ${button.dataset.approveMember} 在「${button.dataset.ns}」的准入`);
        await refresh();
      } catch (error) {
        window.alert(`操作失败：${error.message}`);
        button.disabled = false;
      }
    });
  });
  detail.querySelectorAll('[data-rejoin]').forEach((button) => {
    button.addEventListener('click', () => doRejoin(button.dataset.rejoin));
  });
  detail.querySelectorAll('[data-handoff]').forEach((button) => {
    button.addEventListener('click', () => openHandoff(button.dataset.handoff));
  });
}

async function doRejoin(ns) {
  if (MOCK) {
    window.alert('mock 模式不执行写操作。');
    return;
  }
  const ok = await confirmModal({
    title: `重入恢复 ${ns}`,
    body: `将对「${ns}」声明重入：清空本机该分区水位，对端会从 0 重发（或发初始快照）。前提：本机对该分区有生效授权且重新在册。确定继续？`,
    confirmLabel: '重入恢复',
  });
  if (!ok) return;
  try {
    const result = await api(`/admin/api/namespaces/${encodeURIComponent(ns)}/rejoin`, { method: 'POST', body: {} });
    if (result?.ok) showToast(`已重入「${ns}」`);
    else showToast(`重入失败：${result?.reason ?? '条件不满足'}`);
    await refresh();
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
  }
}

// ---------- 退订交接（plan 预检 + 强确认；force 不提供） ----------

let handoffNs = null;

function openHandoff(ns) {
  handoffNs = ns;
  $('#handoff-title').textContent = `退订交接 · ${ns}`;
  $('#handoff-desc').textContent =
    '退订 = 成员退出 + 本机彻底清理该分区数据与水位（无 tombstone；__policy__ 保留）。清理前必须继任者全量 ack；门禁不过则中止。重入需满足「本机有生效授权 + 重新在册」。';
  $('#handoff-successor').value = '';
  $('#handoff-result').hidden = true;
  $('#handoff-result').textContent = '';
  $('#handoff-confirm').disabled = true;
  $('#handoff').hidden = false;
}

async function runHandoffPlan() {
  const ns = handoffNs;
  const successor = ($('#handoff-successor').value ?? '').trim();
  if (!ns || !successor) return;
  const pre = $('#handoff-result');
  try {
    const plan = await api(`/admin/api/namespaces/${encodeURIComponent(ns)}/handoff-plan?successor=${encodeURIComponent(successor)}`);
    pre.hidden = false;
    pre.textContent = JSON.stringify(plan, null, 2);
    $('#handoff-confirm').disabled = plan?.ok !== true;
  } catch (error) {
    pre.hidden = false;
    pre.textContent = `预检失败：${error.message}`;
    $('#handoff-confirm').disabled = true;
  }
}

async function confirmHandoff() {
  const ns = handoffNs;
  const successor = ($('#handoff-successor').value ?? '').trim();
  if (!ns || !successor) return;
  const ok = await confirmModal({
    title: `退订交接 ${ns}`,
    body: `将把「${ns}」交接给 ${successor}，并从本机彻底清理该分区数据（不可撤销）。确定继续？`,
    confirmLabel: '退订并清理',
  });
  if (!ok) return;
  try {
    const result = await api(`/admin/api/namespaces/${encodeURIComponent(ns)}/leave`, { method: 'POST', body: { successor } });
    showToast(result?.ok ? `已退订并清理「${ns}」` : `交接中止：${result?.reason ?? '未满足门禁'}`);
    $('#handoff').hidden = true;
    await refresh();
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
  }
}

// ---------- 设置卡（本机；运行时 vs 需改配置重启） ----------

// ---------- 设置卡：常用配置编辑器（curated；保存写入 config.json，需重启生效） ----------

const CONFIG_EDITOR = [
  { group: '记忆同步（M 数据域）', path: 'sync.autoSync', label: '自动同步', type: 'bool', help: '连接建立或事件到达时自动触发一次收敛' },
  { path: 'sync.pushOnWrite', label: '写入即推送', type: 'bool', help: '本机写入后即时推给对端（常驻模式默认开）' },
  { path: 'sync.namespaces', label: '订阅数据域（M）', type: 'list', placeholder: 'default, notes', help: '订阅即承担数据义务：接收该域，并同步本机新增记忆。留空 = 参与全部。生效共享 = 对端授权 ∩ 对端在册（启用成员制时）∩ 本机订阅' },
  { path: 'sync.peerWhitelist', label: '对端白名单', type: 'list', placeholder: 'device-B, device-C', help: '记忆通道的传输闸门：仅与列出的 deviceId 建立会话；留空 = 不启用（按授权 / 成员制判定）' },
  { path: 'sync.antiEntropy.enabled', label: '周期反熵', type: 'bool', help: '周期性对账，弥补推送丢失' },
  { path: 'sync.antiEntropy.intervalMs', label: '反熵间隔（分钟）', type: 'minutes', help: '默认 10 分钟（±20% 抖动）' },
  { path: 'sync.antiEntropy.jitterRatio', label: '反熵抖动比例', type: 'number', step: 0.05, min: 0, max: 1, help: '0 ~ 1，默认 0.2' },
  { path: 'sync.snapshotThreshold', label: '快照阈值（事件数）', type: 'number', min: 1, placeholder: '留空 = 不启用', help: '对端空时钟且缺失事件数 ≥ 阈值时改用物化快照' },
  { path: 'sync.policyIssuers', label: '引导签发者（配置）', type: 'list', placeholder: 'device-A', help: '可签发任意分区的引导设备；留空 = 仅图上声明' },
  { group: '语义召回', path: 'semantic.enabled', label: '启用语义召回', type: 'bool', help: '需要本地 embedding 模型（可选依赖）' },
  { path: 'semantic.minScore', label: '召回阈值', type: 'number', step: 0.05, min: 0, max: 1, help: '0 ~ 1，默认 0.2' },
  { group: '网络', path: 'network.enabled', label: '启用 P2P', type: 'bool', help: '关闭后仅本机离线使用' },
  { path: 'network.libp2p.listen', label: '监听地址', type: 'list', placeholder: '/ip4/127.0.0.1/tcp/14001', help: 'multiaddr 列表；留空 = 默认监听' },
  { path: 'network.libp2p.relayServers', label: 'Relay 服务器', type: 'list', placeholder: '/ip4/<relay>/tcp/4001/p2p/<ID>', help: 'circuit relay，纯传输、可自托管' },
  { path: 'network.libp2p.relayUnlimited', label: 'Relay 不做限额', type: 'bool', warn: '仅可信自托管 relay；公网暴露有风险' },
  { group: '设备接入（邀请新设备）', path: 'joinService.enabled', label: '启用加入服务', type: 'bool', help: '开启后可由「＋ 邀请新设备」签发一次性令牌（需重启）' },
  { path: 'joinService.bind', label: '绑定地址', type: 'text', placeholder: '127.0.0.1', help: '令牌 join 端点绑定；仅可信 LAN 使用 0.0.0.0' },
  { path: 'joinService.port', label: '端口', type: 'number', min: 0, max: 65535, help: '默认 4002' },
  { group: 'MCP 接入', path: 'mcp.http.host', label: '监听地址', type: 'text', placeholder: '127.0.0.1' },
  { path: 'mcp.http.port', label: '端口', type: 'number', min: 0, max: 65535 },
  { path: 'mcp.http.auth', label: '鉴权模式', type: 'select', options: [['none', 'none（仅回环）'], ['bearer', 'bearer（token）'], ['oauth', 'oauth']] },
  { path: 'mcp.http.tls', label: '启用 TLS', type: 'bool', help: '非回环监听必须 TLS + 非 none 鉴权' },
];

function cfgGet(obj, path) {
  return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), obj);
}

function cfgSet(root, path, value) {
  const keys = path.split('.');
  let node = root;
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function currentConfigFile() {
  return state.rawConfig?.config ?? {};
}

// 未在 config.json 中设置时的生效默认（取自运行快照；未列出的项显示为空 + 默认标记）
const CONFIG_EFFECTIVE = {
  'sync.autoSync': (s) => s.sync.autoSync,
  'sync.pushOnWrite': (s) => s.sync.pushOnWrite,
  'sync.namespaces': (s) => s.sync.subscriptions,
  'sync.peerWhitelist': (s) => s.sync.peerWhitelist,
  'sync.antiEntropy.enabled': (s) => s.sync.antiEntropy.enabled,
  'sync.antiEntropy.intervalMs': (s) => s.sync.antiEntropy.intervalMs,
  'sync.antiEntropy.jitterRatio': (s) => s.sync.antiEntropy.jitterRatio,
  'sync.snapshotThreshold': (s) => s.sync.snapshotThreshold,
  'sync.policyIssuers': (s) => s.sync.configPolicyIssuers,
  'semantic.enabled': (s) => s.semantic.enabled,
  'semantic.minScore': (s) => s.semantic.minScore,
  'network.enabled': (s) => s.network.enabled,
  'network.libp2p.relayUnlimited': (s) => s.network.relayUnlimited,
  'mcp.http.host': (s) => s.mcp.host,
  'mcp.http.port': (s) => s.mcp.port,
  'mcp.http.auth': (s) => s.mcp.auth,
  'mcp.http.tls': (s) => s.mcp.tls,
  'joinService.enabled': (s) => s.join?.enabled,
  'joinService.bind': (s) => s.join?.bind,
  'joinService.port': (s) => s.join?.port,
};

function fieldInitial(field) {
  const raw = cfgGet(currentConfigFile(), field.path);
  if (raw !== undefined) return { value: raw, isDefault: false };
  const effective = state.settings ? CONFIG_EFFECTIVE[field.path]?.(state.settings) : undefined;
  return { value: effective, isDefault: true };
}

function fieldValue(field) {
  const v = fieldInitial(field).value;
  if (field.type === 'bool') return Boolean(v);
  if (field.type === 'minutes') return typeof v === 'number' ? Math.round((v / 60000) * 100) / 100 : '';
  if (field.type === 'number') return typeof v === 'number' ? v : '';
  if (field.type === 'list') return Array.isArray(v) ? v.join(', ') : '';
  if (field.type === 'select') return typeof v === 'string' ? v : field.options[0][0];
  return typeof v === 'string' ? v : '';
}

function fieldToConfig(field, formValue) {
  if (field.type === 'bool') return Boolean(formValue);
  if (field.type === 'minutes') {
    const n = Number(formValue);
    return formValue === '' || !Number.isFinite(n) || n <= 0 ? null : Math.round(n * 60000);
  }
  if (field.type === 'number') {
    const n = Number(formValue);
    return formValue === '' || !Number.isFinite(n) ? null : n;
  }
  if (field.type === 'list') {
    return String(formValue ?? '').split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
  }
  if (field.type === 'select') return String(formValue);
  return String(formValue ?? '').trim();
}

function normalizedFieldValue(field) {
  const v = fieldInitial(field).value;
  if (field.type === 'bool') return Boolean(v);
  if (field.type === 'minutes') return typeof v === 'number' ? v : null;
  if (field.type === 'number') return typeof v === 'number' ? v : null;
  if (field.type === 'list') return Array.isArray(v) ? v : [];
  if (field.type === 'select') return typeof v === 'string' ? v : field.options[0][0];
  return typeof v === 'string' ? v : '';
}

function collectConfigChanges(root) {
  const changes = [];
  for (const field of CONFIG_EDITOR) {
    const el = root.querySelector(`[data-cfg-path="${CSS.escape(field.path)}"]`);
    if (!el) continue;
    const next = fieldToConfig(field, field.type === 'bool' ? el.checked : el.value);
    const current = normalizedFieldValue(field);
    if (JSON.stringify(next) === JSON.stringify(current)) continue;
    changes.push({ path: field.path, value: next });
  }
  return changes;
}

function collectConfigPatch(root) {
  const patch = {};
  for (const change of collectConfigChanges(root)) cfgSet(patch, change.path, change.value);
  return patch;
}

function renderCfgField(field) {
  const initial = fieldInitial(field);
  const value = Object.prototype.hasOwnProperty.call(state.cfgDraft, field.path)
    ? state.cfgDraft[field.path]
    : (field.type === 'bool' ? Boolean(initial.value)
      : field.type === 'minutes' ? (typeof initial.value === 'number' ? Math.round((initial.value / 60000) * 100) / 100 : '')
      : field.type === 'number' ? (typeof initial.value === 'number' ? initial.value : '')
      : field.type === 'list' ? (Array.isArray(initial.value) ? initial.value.join(', ') : '')
      : field.type === 'select' ? (typeof initial.value === 'string' ? initial.value : field.options[0][0])
      : (typeof initial.value === 'string' ? initial.value : ''));
  const id = `cfg-${field.path.replace(/\./g, '-')}`;
  let control;
  if (field.type === 'bool') {
    control = `<label class="toggle cfg-toggle"><input id="${id}" type="checkbox" data-cfg-path="${escapeHtml(field.path)}" ${value ? 'checked' : ''}><span class="slider"></span></label>`;
  } else if (field.type === 'select') {
    control = `<select id="${id}" class="crt-input" data-cfg-path="${escapeHtml(field.path)}">`
      + field.options.map(([v, label]) => `<option value="${escapeHtml(v)}" ${v === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')
      + '</select>';
  } else {
    const type = field.type === 'number' || field.type === 'minutes' ? 'number' : 'text';
    const attrs = [
      field.type === 'number' || field.type === 'minutes' ? `step="${field.step ?? 1}"` : '',
      field.min !== undefined ? `min="${field.min}"` : '',
      field.max !== undefined ? `max="${field.max}"` : '',
      field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : '',
    ].filter(Boolean).join(' ');
    control = `<input id="${id}" class="crt-input cfg-input" type="${type}" data-cfg-path="${escapeHtml(field.path)}" value="${escapeHtml(String(value))}" ${attrs} />`;
  }
  const defaultTag = initial.isDefault ? '<span class="cfg-default">默认</span>' : '';
  return `<div class="cfg-row">
    <label class="cfg-label" for="${id}">${escapeHtml(field.label)}${defaultTag}</label>
    <div class="cfg-control">${control}</div>
    <p class="cfg-help muted">${escapeHtml(field.help ?? '')}${field.warn ? ` <span class="cfg-warn">⚠ ${escapeHtml(field.warn)}</span>` : ''}</p>
  </div>`;
}

function renderConfigEditor() {
  const groups = [];
  for (const field of CONFIG_EDITOR) {
    if (field.group) groups.push({ name: field.group, fields: [] });
    groups[groups.length - 1].fields.push(field);
  }
  return groups.map((g) => `<div class="cfg-group"><h4>${escapeHtml(g.name)}</h4>${g.fields.map(renderCfgField).join('')}</div>`).join('');
}

function renderSettings() {
  const body = $('#settings-body');
  const prevActive = document.activeElement;
  const prevPath = prevActive?.dataset?.cfgPath ?? null;
  const prevStart = prevActive?.selectionStart ?? null;
  const prevEnd = prevActive?.selectionEnd ?? null;
  const s = state.settings;
  if (!s) {
    body.innerHTML = '<p class="muted">设置加载中…（若持续如此，检查 serve 是否运行）</p>';
    return;
  }
  const self = s.identity.deviceId;
  const isIssuer = Array.isArray(s.policyIssuers) && s.policyIssuers.includes(self);
  const kv = (pairs) => `<dl class="settings-kv">${pairs.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const copyRow = (label, value) => [label, `<div class="copyable"><code>${escapeHtml(value)}</code><button class="btn btn-small btn-crt" data-copy="${escapeHtml(value)}">复制</button></div>`];

  const listenAlarm = (s.network.listen ?? []).filter((addr) => {
    const m = addr.match(/\/(ip4|ip6|dns4|dns6|dns)\/([^/]+)/);
    if (!m) return false;
    return !['127.0.0.1', '::1', 'localhost'].includes(m[2]);
  });
  const addrRows = s.identity.multiaddrs.length
    ? s.identity.multiaddrs.map((a) => copyRow('multiaddr', a))
    : [['multiaddr', '<span class="muted">（未启用 P2P，无监听地址）</span>']];
  const configPath = state.rawConfig?.path ?? 'config.json';

  body.innerHTML = `
    <section class="settings-section">
      <h3>常用配置 <span class="badge badge-muted">保存后需重启</span><span id="cfg-state" class="cfg-state"></span></h3>
      <p class="cfg-path muted">修改写入 <code>${escapeHtml(configPath)}</code>（自动保留 .bak 备份）；设备身份 / 存储 / 加密等敏感项请手工编辑。</p>
      <div id="cfg-editor">${renderConfigEditor()}</div>
      <div class="domain-actions">
        <button id="cfg-save" class="btn btn-small btn-crt" disabled>保存配置</button>
        <button id="cfg-reset" class="btn btn-small btn-crt" disabled>撤销修改</button>
      </div>
      <p class="muted" style="font-size:11px">重启生效：重新运行 <code>mebular serve</code>；若已注册服务：<code>mebular service restart</code>。</p>
    </section>

    <section class="settings-section">
      <h3>身份与存储 <span class="badge badge-muted">只读</span></h3>
      ${kv([
        copyRow('deviceId', s.identity.deviceId),
        ...(s.identity.name ? [['名称', escapeHtml(s.identity.name)]] : []),
        ['身份模式', s.identity.mode === 'delegated'
          ? 'delegated（委派证书链，无主私钥）'
          : 'root（持有用户主密钥，可签发任意设备）'],
        ...(s.identity.peerId ? [copyRow('peerId', s.identity.peerId)] : []),
        ...addrRows,
        copyRow('storagePath', s.storage.path ?? '—'),
        ['storageAdapter', escapeHtml(s.storage.adapter)],
        ['加密级别', `${escapeHtml(s.encryption.level)}${s.encryption.atRest ? '（静态加密生效）' : ''}`],
      ])}
    </section>

    <section class="settings-section">
      <h3>引导签发者（策略权威）<span class="badge ${isIssuer ? 'badge-issuer' : 'badge-muted'}">${isIssuer ? '本机已生效' : '本机未声明'}</span></h3>
      ${kv([
        ['生效集合', escapeHtml(s.policyIssuers.join(', ') || '—')],
        ['配置 bootstrap', escapeHtml(s.sync.configPolicyIssuers.join(', ') || '—')],
      ])}
      <div class="domain-actions">
        <button id="declare-issuer" class="btn btn-small btn-crt" ${state.features.writes && !isIssuer && !MOCK ? '' : 'disabled'}>声明本机为引导签发者</button>
      </div>
      <p class="muted" style="font-size:11px">图上声明（签名事件，随 __policy__ 同步；受 device_revoke 排斥）。</p>
    </section>

    <section class="settings-section">
      <h3>实际运行状态 <span class="badge badge-muted">只读</span>${listenAlarm.length ? '<span class="crt-tag crt-tag-warn">公网监听</span>' : ''}</h3>
      ${kv([
        ['P2P', s.network.enabled ? '已启用' : '未启用'],
        ['实际监听', escapeHtml(s.network.listen.join(', ') || '—')],
        ['生效白名单', (s.sync.peerWhitelist ?? []).length ? escapeHtml(s.sync.peerWhitelist.join(', ')) : '未启用（按授权 / 成员制判定）'],
        ['MCP 监听', `${escapeHtml(s.mcp.host)}:${s.mcp.port} · auth=${escapeHtml(s.mcp.auth)}${s.mcp.tls ? ' · TLS' : ''}`],
        ['语义召回', `${s.semantic.enabled ? '已启用' : '未启用'}（minScore ${s.semantic.minScore}）`],
        ['兼容白名单', s.sync.legacyPeerAllowList.length ? escapeHtml(s.sync.legacyPeerAllowList.join(', ')) : '空（建议迁移到图上授权）'],
      ])}
      ${listenAlarm.length ? `<p class="crt-warn">⚠ 监听地址含非回环（${escapeHtml(listenAlarm.join(', '))}）：建议改绑回环 / LAN，或经 relay 并仅以防火墙放行已授权对端。</p>` : ''}
    </section>

    <section class="settings-section">
      <h3>任务与舰队（Fleet） <span class="badge badge-muted">只读</span></h3>
      ${s.fleet?.configured
        ? kv([
          ['任务域', s.fleet.namespace ? `<code>${escapeHtml(s.fleet.namespace)}</code>` : '(未设置)'],
          ['已登记对端', String(s.fleet.peers ?? 0)],
          ['本机 Agent', String(s.fleet.agents ?? 0)],
          ['配置', escapeHtml(s.fleet.path ?? 'fleet.config.json')],
        ])
        : '<p class="muted" style="font-size:11px">尚未配置舰队。任务面与记忆订阅是两套机制：</p>'}
      <p class="muted" style="font-size:11px">任务 ≠ 记忆订阅：任务树以发起节点为根派发，远端 Agent 执行后回传结果（有向无环树；经记忆通道传输，但不是共享记忆池）。任务配置由 <code>fleet</code> CLI 管理（<code>fleet.config.json</code>）。${s.fleet?.configured ? '' : ' 上车：<code>fleet quickstart --daemon --dir ~/.mebular --device &lt;ID&gt;</code>'}</p>
    </section>

    <section class="settings-section">
      <h3>可用能力 <span class="badge badge-muted">MCP = CLI 同名</span></h3>
      <p class="muted" style="font-size:11px;margin:0 0 8px">Agent 经 MCP、人类经 <code>mebular &lt;name&gt;</code> 调用同一套 handler；GUI 只做守护与参与配置，不新增操作。</p>
      <div class="chip-wrap">${(s.tools ?? []).map((t) => `<span class="crt-tag">${escapeHtml(t)}</span>`).join(' ')}</div>
    </section>

    <section class="settings-section">
      <h3>完整配置 <span class="badge badge-muted">只读</span></h3>
      <p class="muted" style="font-size:11px">${escapeHtml(configPath)}${state.rawConfig?.parseError ? `（解析失败：${escapeHtml(state.rawConfig.parseError)}）` : ''}</p>
      <details class="cfg-raw">
        <summary>展开 / 收起</summary>
        <pre class="snippet">${escapeHtml(JSON.stringify(currentConfigFile(), null, 2))}</pre>
      </details>
      <div class="domain-actions">
        <button id="cfg-copy-all" class="btn btn-small btn-crt" type="button">复制完整配置</button>
      </div>
    </section>
  `;

  body.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => copyText(button.dataset.copy, button));
  });
  const declare = $('#declare-issuer');
  if (declare) declare.addEventListener('click', declareIssuer);
  bindConfigEditor();
  if (prevPath) {
    const el = body.querySelector(`[data-cfg-path="${CSS.escape(prevPath)}"]`);
    if (el && typeof el.focus === 'function') {
      el.focus();
      if (prevStart !== null && typeof el.setSelectionRange === 'function' && el.type === 'text') {
        try { el.setSelectionRange(prevStart, prevEnd ?? prevStart); } catch { /* 忽略 */ }
      }
    }
  }
}

function bindConfigEditor() {
  const editor = $('#cfg-editor');
  if (!editor) return;
  const saveBtn = $('#cfg-save');
  const resetBtn = $('#cfg-reset');
  const stateEl = $('#cfg-state');
  const update = () => {
    const dirty = collectConfigChanges(editor).map((c) => c.path);
    saveBtn.disabled = dirty.length === 0;
    resetBtn.disabled = dirty.length === 0;
    stateEl.textContent = dirty.length === 0 ? '' : `未保存修改：${dirty.length} 项`;
    stateEl.title = dirty.join('\n');
  };
  editor.querySelectorAll('[data-cfg-path]').forEach((el) => {
    const record = () => {
      state.cfgDraft[el.dataset.cfgPath] = el.type === 'checkbox' ? el.checked : el.value;
      update();
    };
    el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', record);
  });
  saveBtn.addEventListener('click', saveConfigEditor);
  resetBtn.addEventListener('click', () => {
    state.cfgDraft = {};
    renderSettings();
  });
  const copyAll = $('#cfg-copy-all');
  if (copyAll) copyAll.addEventListener('click', () => copyText(JSON.stringify(currentConfigFile(), null, 2), copyAll));
  update();
}

async function saveConfigEditor() {
  if (MOCK) {
    window.alert('mock 模式不执行写操作。');
    return;
  }
  const patch = collectConfigPatch($('#cfg-editor'));
  if (Object.keys(patch).length === 0) return;
  const saveBtn = $('#cfg-save');
  saveBtn.disabled = true;
  try {
    const res = await api('/admin/api/config', { method: 'POST', body: { patch } });
    state.rawConfig = { path: res.path, exists: true, parseError: null, config: res.config };
    state.cfgDraft = {};
    showToast(`已写入 ${res.path}${res.backup ? '（旧文件已备份为 .bak）' : ''}；重启 serve 后生效`);
    await refresh();
    renderSettings();
  } catch (error) {
    window.alert(`保存失败：${error.message}`);
    saveBtn.disabled = false;
  }
}

async function declareIssuer() {
  if (MOCK) {
    window.alert('mock 模式不执行写操作。');
    return;
  }
  const self = state.overview?.device?.deviceId;
  if (!self) return;
  const ok = await confirmModal({
    title: '声明引导签发者',
    body: `将把本机（${self}）声明为引导签发者：该声明为图上签名事件，随 __policy__ 同步到各端；可被 device_revoke 排斥。确定？`,
    confirmLabel: '声明',
  });
  if (!ok) return;
  try {
    await api('/admin/api/policy-issuers', { method: 'POST', body: { subject: self } });
    showToast('已声明本机为引导签发者');
    await refresh();
    renderSettings();
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
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
    const actionClass = {
      namespace_grant: 'grant',
      namespace_revoke: 'revoke',
      device_revoke: 'device',
      policy_issuer_declare: 'declare',
      namespace_membership: 'membership',
      namespace_handoff: 'handoff',
    }[event.type] ?? 'device';
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
  const asideEl = document.querySelector('.aside');
  if (asideEl) asideEl.classList.toggle('is-open', Boolean(state.selected) && state.view === 'map');
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
  const status = isSelf
    ? { text: `${ICONS.online} 本机`, cls: 'is-ok' }
    : device.revoked
      ? { text: `${ICONS.revoked} 已屏蔽`, cls: 'is-danger' }
      : device.online
        ? { text: `${ICONS.online} 在线`, cls: 'is-ok' }
        : { text: `${ICONS.offline} 离线`, cls: 'is-off' };
  const shortTime = (at) => {
    const d = new Date(at);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  const metaParts = [];
  if (!isSelf && device.pendingEventCount) metaParts.push(`待发 ${device.pendingEventCount}`);
  if (!isSelf && device.lastSyncAt) metaParts.push(`最近同步 ${shortTime(device.lastSyncAt)}`);
  if (device.declaredIssuer) metaParts.push('◈ 引导签发者');

  const allNamespaces = allNamespaceNames();
  const writes = state.features.writes && !MOCK;
  const peerWrites = writes && !isSelf;

  // 头部标签：对端显示「目标锁定」；本机卡已有状态标签，隐藏避免重复
  const headTag = document.querySelector('#device-card .card-head .crt-tag');
  if (headTag) {
    headTag.hidden = isSelf;
    headTag.innerHTML = '<span class="crt-tag-dot"></span>目标锁定';
  }
  const selfRow = state.devices.find((d) => d.deviceId === state.overview?.device?.deviceId);
  const selfFollowSet = new Set((selfRow?.memberships ?? []).map((m) => m.namespace));
  const subs = state.settings?.sync?.subscriptions ?? [];
  const subscribedTo = (ns) => subs.length === 0 || subs.includes(ns);
  const iFollow = (ns) => subscribedTo(ns) || selfFollowSet.has(ns);

  // 本机：关注开关（图上在册；订阅声明决定传输层）
  const followRows = allNamespaces.length === 0
    ? '<li class="muted">暂无已知分区</li>'
    : allNamespaces.map((ns) => {
      const following = Boolean((device.memberships ?? []).find((m) => m.namespace === ns));
      const declared = subscribedTo(ns);
      const hint = following
        ? (declared ? '关注中' : '在册 · 订阅声明未含（重启后收发）')
        : (declared ? '订阅声明含 · 未在册' : '未关注');
      return `<li>
        <span><span class="ns-chip" style="background:${namespaceColor(ns)}">${escapeHtml(ns)}</span>
          <span class="muted" style="margin-left:6px">${hint}</span></span>
        <label class="toggle" title="关注 = 接收该域对端新记忆，并把本机该域新记忆同步到其他端（订阅即数据义务）">
          <input type="checkbox" data-follow="${escapeHtml(ns)}" aria-label="关注数据域 ${escapeHtml(ns)}（当前${following ? '关注中' : '未关注'}）" ${following ? 'checked' : ''} ${writes ? '' : 'disabled'}>
          <span class="slider"></span>
        </label>
      </li>`;
    }).join('');

  // 对端：它关注的域（对端从自身出发声明的图上在册，只读）
  const peerFollowRows = (device.memberships ?? []).length
    ? device.memberships.map((m) => `<li>
        <span><span class="ns-chip" style="background:${namespaceColor(m.namespace)}">${escapeHtml(m.namespace)}</span>
          <span class="muted" style="margin-left:6px">${m.effective ? '在册 · 生效' : '在册 · 待你批准准入'}</span></span>
      </li>`).join('')
    : '<li class="muted">对端尚未声明关注任何域</li>';

  // 对端：互通状态 = 你关注 ∩ 它关注 ∩ 它已获授权（默认拒绝的准入）
  const authorizedSet = new Set(device.authorizedFor ?? []);
  const peerFollowSet = new Set((device.memberships ?? []).map((m) => m.namespace));
  const domains = [...new Set([...allNamespaces, ...peerFollowSet, ...authorizedSet])].sort();
  const interop = domains.map((ns) => {
    const peerFollows = peerFollowSet.has(ns);
    const authorized = authorizedSet.has(ns);
    const mutual = peerFollows && authorized && iFollow(ns);
    const state = mutual ? '✓ 可互通'
      : peerFollows && !authorized ? '待你批准'
        : !peerFollows && authorized ? '已授权 · 待对端关注'
          : '未互通';
    const action = peerFollows && !authorized
      ? `<button class="btn btn-small btn-crt" data-approve="${escapeHtml(ns)}" ${writes ? '' : 'disabled'} title="批准对端准入：签发授权（已同步内容不回撤）">批准</button>`
      : authorized
        ? `<button class="btn btn-small btn-crt btn-crt-danger" data-revoke-ns="${escapeHtml(ns)}" ${writes ? '' : 'disabled'} title="撤回该域的授权">撤回</button>`
        : '';
    return { ns, state, action };
  });
  const visibleInterop = interop.filter((row) => row.state !== '未互通');
  const hiddenCount = interop.length - visibleInterop.length;
  const interopRows = (visibleInterop.length > 0
    ? visibleInterop.map((row) => `<li>
        <span><span class="ns-chip" style="background:${namespaceColor(row.ns)}">${escapeHtml(row.ns)}</span>
          <span class="muted" style="margin-left:6px">${row.state}</span></span>
        ${row.action}
      </li>`).join('')
    : '<li class="muted">暂无需处理的域</li>')
    + (hiddenCount > 0 ? `<li class="muted">另有 ${hiddenCount} 个域未互通（双方均未关注/授权）</li>` : '');

  const actions = isSelf ? '' : `
    <div class="card-actions">
      <button class="btn btn-small btn-crt" data-action="sync" ${writes && device.online ? '' : 'disabled'}>立即同步</button>
      ${device.online
        ? `<button class="btn btn-small btn-crt" data-action="disconnect" ${writes ? '' : 'disabled'}>断开连接</button>`
        : `<button class="btn btn-small btn-crt" data-action="connect" ${writes ? '' : 'disabled'}>连接</button>`}
    </div>
    <details class="card-advanced">
      <summary>更多操作</summary>
      <div class="card-actions">
        <button class="btn btn-small btn-crt" data-action="reset-watermarks" ${writes ? '' : 'disabled'}>重置水位</button>
        <button class="btn btn-small btn-crt btn-crt-danger" data-action="revoke-device" ${writes ? '' : 'disabled'}>屏蔽该设备</button>
      </div>
    </details>
    ${writes ? '' : '<p class="muted" style="margin-top:10px">当前为只读模式（写操作需 memory.admin + CSRF）。</p>'}`;

  body.innerHTML = `
    <div class="card-identity">
      <span class="card-id">${escapeHtml(device.deviceId)}</span>
      <span class="crt-tag card-status ${status.cls}">${status.text}</span>
    </div>
    ${metaParts.length > 0 ? `<p class="card-meta muted">${escapeHtml(metaParts.join(' · '))}</p>` : '<p class="card-meta muted"></p>'}
    ${isSelf ? `
    <h3>我关注的域 <span class="h3-note">M 记忆域 · 订阅即数据义务</span></h3>
    <p class="card-help muted">关注后①有权接收该域对端变更；②本机该域新记忆同步给在册成员 / 已授权且关注的对端。图上在册即时生效；订阅声明需重启传输层。</p>
    <ul class="chip-list">${followRows}</ul>
    ` : `
    <h3>它关注的域 <span class="h3-note">对端自声明</span></h3>
    <ul class="chip-list">${peerFollowRows}</ul>
    <h3>互通状态 <span class="h3-note">需你关注 + 它关注 + 已获授权</span></h3>
    <ul class="chip-list">${interopRows}</ul>
    `}
    ${actions}
  `;

  body.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => handleDeviceAction(button.dataset.action, device));
  });
  body.querySelectorAll('[data-approve]').forEach((button) => {
    button.addEventListener('click', () => handleApprove(device, button.dataset.approve, button));
  });
  body.querySelectorAll('[data-revoke-ns]').forEach((button) => {
    button.addEventListener('click', () => handleRevokeNamespace(device, button.dataset.revokeNs, button));
  });
}

/** 本机关注（= 图上在册）＋ 需要时同步订阅声明（构造期配置，重启后传输层生效） */
async function handleFollowToggle(device, ns, on, input) {
  input.disabled = true;
  try {
    if (MOCK) {
      window.alert('mock 模式不执行写操作。');
      input.checked = !on;
      return;
    }
    await api('/admin/api/memberships', { method: 'POST', body: { member: device.deviceId, namespace: ns, active: on } });
    const subs = state.settings?.sync?.subscriptions ?? [];
    let patched = false;
    let hint = '';
    if (on && subs.length > 0 && !subs.includes(ns)) {
      await api('/admin/api/config', { method: 'POST', body: { patch: { sync: { namespaces: [...subs, ns] } } } });
      patched = true;
    } else if (!on && subs.includes(ns)) {
      const next = subs.filter((x) => x !== ns);
      if (next.length > 0) {
        await api('/admin/api/config', { method: 'POST', body: { patch: { sync: { namespaces: next } } } });
        patched = true;
      } else {
        hint = '；订阅声明为空 = 参与全部，如需排除请手工编辑';
      }
    } else if (!on && subs.length === 0) {
      hint = '；订阅声明为「全部」，传输层仍会接收，如需排除请编辑订阅声明并重启';
    }
    showToast(on
      ? `已关注「${ns}」${patched ? '：订阅声明已更新，重启 serve 后传输层生效' : ''}`
      : `已取消关注「${ns}」${patched ? '：订阅声明已更新，重启 serve 后传输层生效' : ''}${hint}`);
    await refresh();
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
    input.checked = !on;
  } finally {
    input.disabled = false;
  }
}

/** 批准对端准入：签发授权（默认拒绝下的准入动作，对应 fleet approve） */
async function handleApprove(device, ns, button) {
  if (MOCK) {
    window.alert('mock 模式不执行写操作。');
    return;
  }
  button.disabled = true;
  try {
    await api('/admin/api/grants', { method: 'POST', body: { subject: device.deviceId, namespaces: [ns] } });
    showToast(`已批准 ${device.deviceId} 在「${ns}」的准入（签发授权）`);
    await refresh();
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
    button.disabled = false;
  }
}

/** 撤回某域授权（已同步内容不回撤） */
async function handleRevokeNamespace(device, ns, button) {
  if (MOCK) {
    window.alert('mock 模式不执行写操作。');
    return;
  }
  const ok = await confirmModal({
    title: `撤回授权 ${ns}`,
    body: `${device.deviceId} 不会再收到关于「${ns}」的新记忆；已同步内容不会撤回；可用重新批准恢复。`,
    confirmLabel: '撤回授权',
  });
  if (!ok) return;
  button.disabled = true;
  try {
    const grantIds = grantsCovering(device.deviceId, ns);
    for (const grantId of grantIds) {
      await api(`/admin/api/grants/${encodeURIComponent(grantId)}/revoke`, { method: 'POST', body: {} });
    }
    showToast(grantIds.length > 0 ? `已撤回「${ns}」的授权` : `「${ns}」没有可撤回的授权`);
    await refresh();
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
    button.disabled = false;
  }
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
  // 选中/取消时收起悬浮提示（避免被设备卡擦写边缘切断），移动鼠标后会重新出现
  $('#tooltip').hidden = true;
  if (!node) {
    // 点击星图空白 → 取消选中，设备卡（绿色显示框）收起
    if (!state.selected) return;
    state.selected = null;
    const url = new URL(location.href);
    url.searchParams.delete('select');
    history.replaceState(null, '', url);
    renderStageScene();
    renderDeviceCard();
    stage.redraw();
    return;
  }
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
  stage.redraw();
};

// 选中节点的军事扫描仪准星 + 绿色虚线荧光条（星体 → 设备卡左边框）
const reticleState = { id: null, lockAt: 0 };
stage.onOverlay = (ctx) => {
  if (!state.selected || state.view !== 'map') return;
  const asideEl = document.querySelector('.aside');
  const cardEl = $('#device-card');
  if (!asideEl || !cardEl || !asideEl.classList.contains('is-open')) return;
  const node = stage.screen?.get(state.selected.deviceId);
  if (!node) return;
  const time = performance.now() / 1000;
  if (reticleState.id !== state.selected.deviceId) {
    reticleState.id = state.selected.deviceId;
    reticleState.lockAt = time;
  }
  const elapsed = time - reticleState.lockAt;
  const r = node.r ?? 8;
  // 锁定收缩：准星从远处收拢到星体（0.55s），到位后轻微呼吸
  const lockT = Math.min(1, elapsed / 0.55);
  const ease = 1 - Math.pow(1 - lockT, 3);
  const focus = r * 2.6 * (1 + (1 - ease) * 1.1);
  const alpha = (0.32 + 0.48 * ease) * (0.85 + 0.15 * Math.sin(time * 2.4));

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  // 中心磷光晕
  const bloom = ctx.createRadialGradient(node.x, node.y, r * 0.4, node.x, node.y, focus * 1.7);
  bloom.addColorStop(0, `rgba(80, 255, 170, ${(0.10 * ease).toFixed(3)})`);
  bloom.addColorStop(1, 'rgba(80, 255, 170, 0)');
  ctx.fillStyle = bloom;
  ctx.beginPath();
  ctx.arc(node.x, node.y, focus * 1.7, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = `rgba(120, 255, 185, ${alpha.toFixed(3)})`;
  ctx.shadowColor = 'rgba(70, 255, 160, 0.8)';
  ctx.shadowBlur = 6;
  ctx.lineWidth = 1;
  const rot = time * 0.85;
  const gap = Math.PI / 4.5;
  // 外锁定环（旋转双弧）
  ctx.beginPath();
  ctx.arc(node.x, node.y, focus, rot, rot + Math.PI - gap);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(node.x, node.y, focus, rot + Math.PI, rot + 2 * Math.PI - gap);
  ctx.stroke();
  // 内虚环（反向旋转）
  ctx.setLineDash([3, 5]);
  ctx.lineDashOffset = time * 9;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.arc(node.x, node.y, r * 1.45, -time * 1.2, -time * 1.2 + Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  // 雷达扫线
  const ray = rot + Math.PI * 0.75;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(node.x + Math.cos(ray) * focus * 0.35, node.y + Math.sin(ray) * focus * 0.35);
  ctx.lineTo(node.x + Math.cos(ray) * focus, node.y + Math.sin(ray) * focus);
  ctx.stroke();
  ctx.globalAlpha = 1;
  // 四角括线
  const tick = Math.max(5, focus * 0.34);
  ctx.lineWidth = 1.6;
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const cx = node.x + sx * focus;
    const cy = node.y + sy * focus;
    ctx.beginPath();
    ctx.moveTo(cx - sx * tick, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy - sy * tick);
    ctx.stroke();
  }
  // 锁定脉冲环
  if (elapsed < 0.85) {
    const ping = elapsed / 0.85;
    ctx.globalAlpha = 0.55 * (1 - ping);
    ctx.beginPath();
    ctx.arc(node.x, node.y, r + ping * r * 3.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // 连线：准星边缘 → 折点 → 面板左上角（渐次绘制；到达后角端闪点）
  const LINK_START = 0.06;
  const LINK_DUR = 0.26;
  const LINK_DONE = LINK_START + LINK_DUR;
  const drawT = Math.min(1, Math.max(0, (elapsed - LINK_START) / LINK_DUR));
  const drawEase = 1 - Math.pow(1 - drawT, 2);
  const canvasRect = stage.canvas.getBoundingClientRect();
  const cardRect = cardEl.getBoundingClientRect();
  const cornerX = cardRect.left - canvasRect.left;
  const cornerY = cardRect.top - canvasRect.top + 1;
  const bendX = cornerX - 56;
  const routed = node.x < bendX - 8;
  const firstX = routed ? bendX : cornerX;
  const dx = firstX - node.x;
  const dy = cornerY - node.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const sx = node.x + ux * (focus + 4);
  const sy = node.y + uy * (focus + 4);
  const pts = routed
    ? [{ x: sx, y: sy }, { x: bendX, y: cornerY }, { x: cornerX, y: cornerY }]
    : [{ x: sx, y: sy }, { x: cornerX, y: cornerY }];
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const segLen = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segs.push({ a: pts[i], b: pts[i + 1], len: segLen });
    total += segLen;
  }
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    let remaining = total * drawEase;
    for (const seg of segs) {
      if (remaining <= 0) break;
      const t = Math.min(1, remaining / seg.len);
      ctx.lineTo(seg.a.x + (seg.b.x - seg.a.x) * t, seg.a.y + (seg.b.y - seg.a.y) * t);
      remaining -= seg.len;
    }
    ctx.stroke();
  };

  if (drawT > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(70, 255, 160, 0.10)';
    ctx.shadowColor = 'rgba(70, 255, 160, 0.65)';
    ctx.shadowBlur = 6;
    trace();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(150, 255, 200, 0.85)';
    ctx.shadowBlur = 3;
    trace();
    ctx.restore();

    // 折点节点
    if (routed && drawEase * total > Math.hypot(bendX - sx, cornerY - sy)) {
      ctx.save();
      ctx.fillStyle = 'rgba(160, 255, 205, 0.9)';
      ctx.shadowColor = 'rgba(80, 255, 170, 0.85)';
      ctx.shadowBlur = 7;
      ctx.beginPath();
      ctx.arc(bendX, cornerY, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // 角端接线端子 + 到位闪光
    if (drawT >= 1) {
      const arrive = elapsed - LINK_DONE;
      ctx.save();
      ctx.fillStyle = 'rgba(160, 255, 205, 0.9)';
      ctx.shadowColor = 'rgba(80, 255, 170, 0.85)';
      ctx.shadowBlur = 7;
      ctx.translate(cornerX, cornerY);
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-2.8, -2.8, 5.6, 5.6);
      ctx.restore();
      if (arrive < 0.34) {
        const k = arrive / 0.34;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(170, 255, 215, ${(0.7 * (1 - k)).toFixed(3)})`;
        ctx.shadowColor = 'rgba(80, 255, 170, 0.9)';
        ctx.shadowBlur = 12;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(cornerX, cornerY, 3 + k * 22, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }
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
  // 图例只属于星图视图：域/审计视图隐藏，避免遮挡卡片操作
  document.querySelector('.sidebar')?.classList.toggle('is-map', view === 'map');
  $('#domains-view').hidden = view !== 'domains';
  $('#audit-view').hidden = view !== 'audit';
  $('#stage').style.visibility = view === 'map' ? 'visible' : 'hidden';
  $('#empty-state').hidden = true;
  const asideEl = document.querySelector('.aside');
  if (asideEl) asideEl.classList.toggle('is-open', view === 'map' && Boolean(state.selected));
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
$('#open-settings').addEventListener('click', () => {
  $('#settings').hidden = false;
  renderSettings();
});
$('#settings-close').addEventListener('click', () => {
  $('#settings').hidden = true;
});
$('#handoff-close').addEventListener('click', () => {
  $('#handoff').hidden = true;
});
$('#handoff-plan').addEventListener('click', runHandoffPlan);
$('#handoff-confirm').addEventListener('click', confirmHandoff);

// ---------- 邀请新设备（T2 令牌加入：主密钥不复制） ----------

async function openInvite() {
  $('#invite').hidden = false;
  await renderInvite();
}

async function renderInvite() {
  const body = $('#invite-body');
  const regenerate = $('#invite-regenerate');
  const toSettings = $('#invite-to-settings');
  regenerate.hidden = true;
  toSettings.hidden = true;
  body.innerHTML = '<p class="muted">正在签发令牌…</p>';
  try {
    const res = await api('/admin/api/invite', { method: 'POST', body: {} });
    state.inviteToken = res;
    // 令牌很长：显示截断，复制按钮携带完整值
    const shortToken = res.token.length > 56 ? `${res.token.slice(0, 42)}…${res.token.slice(-12)}` : res.token;
    const cmd = `fleet join --token ${res.token} --daemon --dir ~/.mebular --device <新设备ID>`;
    const shortCmd = `fleet join --token ${shortToken} --daemon --dir ~/.mebular --device <新设备ID>`;
    body.innerHTML = `
      <dl class="settings-kv">
        <dt>join 端点</dt><dd><code>${escapeHtml(res.endpoint)}</code></dd>
        <dt>默认成员分区</dt><dd><code>${escapeHtml(res.namespace)}</code></dd>
        <dt>有效期至</dt><dd>${escapeHtml(formatTime(res.expiresAt))}（一次性）</dd>
      </dl>
      <div class="readout-block">
        <span class="domain-label">令牌</span>
        <div class="copyable"><code>${escapeHtml(shortToken)}</code><button class="btn btn-small btn-crt" data-copy="${escapeHtml(res.token)}">复制</button></div>
      </div>
      <div class="readout-block">
        <span class="domain-label">新设备</span>
        <div class="copyable"><code>${escapeHtml(shortCmd)}</code><button class="btn btn-small btn-crt" data-copy="${escapeHtml(cmd)}">复制命令</button></div>
      </div>
      <div class="readout-block">
        <span class="domain-label">本机批准</span>
        <div class="copyable"><code>fleet approve --dir ~/.mebular --device &lt;新设备ID&gt; --addr &lt;其 multiaddr&gt;</code><button class="btn btn-small btn-crt" data-copy="fleet approve --dir ~/.mebular --device &lt;新设备ID&gt; --addr &lt;其 multiaddr&gt;">复制</button></div>
      </div>
      <div class="readout-block">
        <span class="domain-label">查看待批</span>
        <div class="copyable"><code>fleet pending --dir ~/.mebular</code><button class="btn btn-small btn-crt" data-copy="fleet pending --dir ~/.mebular">复制</button></div>
      </div>
      <p class="crt-warn">⚠ 令牌即入网权限：一次性、短时效（默认 15 分钟），仅经可信 LAN 使用，请勿写入工单或公开日志。</p>
    `;
    body.querySelectorAll('[data-copy]').forEach((button) => {
      button.addEventListener('click', () => copyText(button.dataset.copy, button));
    });
    regenerate.hidden = false;
  } catch (error) {
    state.inviteToken = null;
    if (error.payload?.error === 'join_disabled' || error.status === 409) {
      toSettings.hidden = false;
      body.innerHTML = `
        <p class="modal-note muted">加入服务未启用：开启后即可在新设备上用一条命令入网（主密钥不复制，令牌一次性、默认 15 分钟有效）。</p>
        <p class="cfg-path muted">在「设置 → 常用配置 → 设备接入」勾选 <code>joinService.enabled</code> 并保存，重启 serve 后生效。</p>
      `;
    } else {
      body.innerHTML = `<p class="crt-warn">签发失败：${escapeHtml(error.message)}</p>`;
    }
  }
}

$('#invite-device').addEventListener('click', openInvite);
$('#invite-close').addEventListener('click', () => {
  $('#invite').hidden = true;
});
$('#invite-regenerate').addEventListener('click', renderInvite);
$('#invite-to-settings').addEventListener('click', () => {
  $('#invite').hidden = true;
  $('#settings').hidden = false;
  renderSettings();
});

$('#device-card-close').addEventListener('click', () => {
  state.selected = null;
  const url = new URL(location.href);
  url.searchParams.delete('select');
  history.replaceState(null, '', url);
  render();
  stage.redraw();
});

// 图例展开/折叠：首次进入展示后自动收纳；用户手动切换后尊重其选择
{
  const panel = $('#legend-panel');
  const toggle = $('#legend-toggle');
  const apply = (collapsed) => {
    panel.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
  };
  const stored = localStorage.getItem('mebular_legend_collapsed');
  apply(stored === '1');
  let autoTimer = 0;
  const cancelAuto = () => {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = 0;
    }
  };
  if (stored === null) {
    // 首次进入：展示一小段时间后自动收纳（悬停阅读则取消）
    autoTimer = window.setTimeout(() => apply(true), 7000);
  }
  panel.addEventListener('pointerenter', cancelAuto);
  toggle.addEventListener('click', () => {
    cancelAuto();
    const next = !panel.classList.contains('is-collapsed');
    localStorage.setItem('mebular_legend_collapsed', next ? '1' : '0');
    apply(next);
  });
}
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
