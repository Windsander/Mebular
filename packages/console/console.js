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
  memberDraft: '',
  settings: null,
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
  ]);
  const [overview, devices, policy, namespaces, settings] = results;
  let firstError = null;
  if (overview.status === 'fulfilled') state.overview = overview.value;
  else firstError = overview.reason;
  if (devices.status === 'fulfilled') state.devices = devices.value;
  else firstError = firstError ?? devices.reason;
  if (policy.status === 'fulfilled') state.policy = policy.value;
  if (namespaces.status === 'fulfilled') state.namespaces = namespaces.value;
  if (settings.status === 'fulfilled') state.settings = settings.value;
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
    state.memberDraft = '';
  }
  const selected = items.find((n) => n.namespace === state.selectedNamespace);
  list.innerHTML = items.map((n) => {
    const active = n.namespace === state.selectedNamespace;
    const memberLabel = n.membershipEnabled ? `${n.effectiveMembers.length}/${n.members.length}` : '仅授权';
    return `<button class="sector-item${active ? ' is-active' : ''}" data-sector="${escapeHtml(n.namespace)}" type="button">
      <span class="sector-dot${n.membershipEnabled ? ' is-on' : ''}"></span>
      <span class="sector-name"><span class="ns-chip" style="background:${namespaceColor(n.namespace)}">${escapeHtml(n.namespace)}</span>
        <span class="sector-meta">${n.count} 条${n.rejoinReset ? ' · 待恢复' : ''}</span></span>
      <span class="sector-meta" title="生效/在册成员">${memberLabel}</span>
    </button>`;
  }).join('');
  renderDomainDetail(selected);

  list.querySelectorAll('[data-sector]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedNamespace = button.dataset.sector;
      state.memberDraft = '';
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
  const focused = document.activeElement?.dataset?.memberInput === ns;
  const draft = focused ? document.activeElement.value : state.memberDraft;

  const granted = (n.grantedTo ?? []).length
    ? n.grantedTo.map((g) => `<span class="member-chip" title="grantId=${escapeHtml(g.grantId)}">${escapeHtml(g.deviceId)}</span>`).join(' ')
    : '<span class="muted">—</span>';
  const members = n.membershipEnabled
    ? (n.members.length
      ? n.members.map((m) => {
        const eff = n.effectiveMembers.includes(m);
        const remove = writes
          ? `<button class="chip-x" data-member-remove="${escapeHtml(m)}" data-ns="${escapeHtml(ns)}" title="移出成员（不清理数据）">×</button>`
          : '';
        return `<span class="member-chip ${eff ? 'is-effective' : ''}" title="${eff ? '在册且已授权（生效）' : '在册但缺授权（不生效）'}">${escapeHtml(m)}${eff ? ' ✓' : ''}${remove}</span>`;
      }).join(' ')
      : '<span class="muted">暂无在册成员</span>')
      + (writes
        ? `<input class="member-input crt-input" data-member-input="${escapeHtml(ns)}" placeholder="deviceId" aria-label="添加成员" /><button class="btn btn-small btn-crt" data-member-add="${escapeHtml(ns)}">添加</button>`
        : '')
    : '<span class="muted">未启用成员制（只需授权）</span>';
  const rejoinTitle = !writes
    ? '只读模式'
    : n.selfAuthorized
      ? '清空本机该分区水位，请对端从 0 重发（或发初始快照）'
      : '需本机对该分区有生效授权（默认拒绝）';
  const rejoin = n.rejoinReset
    ? `<button class="btn btn-small btn-crt" data-rejoin="${escapeHtml(ns)}" ${(writes && n.selfAuthorized) ? '' : 'disabled'} title="${escapeHtml(rejoinTitle)}">重入恢复</button>`
    : '';

  detail.innerHTML = `<article class="sector-readout crt-surface crt-corners">
    <header class="readout-head">
      <span class="ns-chip" style="background:${namespaceColor(ns)}">${escapeHtml(ns)}</span>
      <span class="readout-meta">${n.count} 条 · 最近更新 ${n.lastUpdatedAt ? formatTime(n.lastUpdatedAt) : '—'}</span>
      <span class="readout-meta">HASH ${n.stateHash ? escapeHtml(n.stateHash.slice(0, 10)) : '—'}</span>
      <span class="crt-tag${n.membershipEnabled ? '' : ' is-off'}">${n.membershipEnabled ? '成员制 ACTIVE' : '成员制 OFF'}</span>
      <span class="crt-tag${n.subscribed ? '' : ' is-off'}">${n.subscribed ? '已订阅' : '未订阅'}</span>
      ${n.rejoinReset ? '<span class="crt-tag">待重入</span>' : ''}
    </header>
    <div class="readout-block"><span class="domain-label">AUTH →</span><div class="chip-wrap">${granted}</div></div>
    <div class="readout-block"><span class="domain-label">MEMBERS →</span><div class="chip-wrap">${members}</div></div>
    <div class="readout-block readout-actions">
      ${rejoin}
      <button class="btn btn-small btn-crt btn-crt-danger" data-handoff="${escapeHtml(ns)}" ${writes ? '' : 'disabled'} title="退订交接：继任者全量 ack 后才清理本机数据">退订交接…</button>
    </div>
  </article>`;

  const input = detail.querySelector(`[data-member-input="${CSS.escape(ns)}"]`);
  if (input) {
    input.value = draft;
    input.addEventListener('input', () => { state.memberDraft = input.value; });
    if (focused) {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
  }
  bindDomainActions();
}

function bindDomainActions() {
  const detail = $('#domain-detail');
  detail.querySelectorAll('[data-member-add]').forEach((button) => {
    button.addEventListener('click', () => {
      const ns = button.dataset.memberAdd;
      const input = detail.querySelector(`[data-member-input="${CSS.escape(ns)}"]`);
      const member = (input?.value ?? '').trim();
      if (!member) return;
      state.memberDraft = '';
      declareMembership(member, ns, true);
    });
  });
  detail.querySelectorAll('[data-member-remove]').forEach((button) => {
    button.addEventListener('click', () => declareMembership(button.dataset.memberRemove, button.dataset.ns, false));
  });
  detail.querySelectorAll('[data-rejoin]').forEach((button) => {
    button.addEventListener('click', () => doRejoin(button.dataset.rejoin));
  });
  detail.querySelectorAll('[data-handoff]').forEach((button) => {
    button.addEventListener('click', () => openHandoff(button.dataset.handoff));
  });
}

async function declareMembership(member, ns, active) {
  if (MOCK) {
    window.alert('mock 模式不执行写操作。');
    return;
  }
  try {
    await api('/admin/api/memberships', { method: 'POST', body: { member, namespace: ns, active } });
    showToast(active ? `已将 ${member} 加入「${ns}」成员` : `已将 ${member} 移出「${ns}」成员`);
    await refresh();
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
  }
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

function renderSettings() {
  const body = $('#settings-body');
  const s = state.settings;
  if (!s) {
    body.innerHTML = '<p class="muted">设置加载中…（若持续如此，检查 serve 是否运行）</p>';
    return;
  }
  const self = s.identity.deviceId;
  const isIssuer = Array.isArray(s.policyIssuers) && s.policyIssuers.includes(self);
  const kv = (pairs) => `<dl class="settings-kv">${pairs.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const copyRow = (label, value) => [label, `<div class="copyable"><code>${escapeHtml(value)}</code><button class="btn btn-small btn-crt" data-copy="${escapeHtml(value)}">复制</button></div>`];
  const snippet = (obj) => `<pre class="snippet">${escapeHtml(JSON.stringify(obj, null, 2))}</pre>`;

  const addrRows = s.identity.multiaddrs.length
    ? s.identity.multiaddrs.map((a) => copyRow('multiaddr', a))
    : [['multiaddr', '<span class="muted">（未启用 P2P，无监听地址）</span>']];

  body.innerHTML = `
    <section class="settings-section">
      <h3>身份与存储 <span class="badge badge-muted">只读</span></h3>
      ${kv([
        copyRow('deviceId', s.identity.deviceId),
        ...(s.identity.name ? [['名称', escapeHtml(s.identity.name)]] : []),
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
      <p class="muted" style="font-size:11px">图上声明（签名事件，随 __policy__ 同步；受 device_revoke 排斥）。需改配置并重启的等价片段：</p>
      ${snippet({ sync: { policyIssuers: [self] } })}
    </section>

    <section class="settings-section">
      <h3>分区订阅 <span class="badge badge-muted">需改配置并重启</span></h3>
      ${kv([
        ['当前订阅', s.sync.subscriptions.length ? escapeHtml(s.sync.subscriptions.join(', ')) : '全部（空 = 参与全部）'],
        ['本机视角', '裁剪链第三项：本机订阅声明'],
      ])}
      ${snippet({ sync: { namespaces: s.sync.subscriptions } })}
    </section>

    <section class="settings-section">
      <h3>同步与实时 <span class="badge badge-muted">需改配置并重启</span></h3>
      ${kv([
        ['autoSync', String(s.sync.autoSync)],
        ['pushOnWrite', `${s.sync.pushOnWrite}（常驻默认开；节流 ${s.sync.pushOnWriteThrottleMs}ms）`],
        ['antiEntropy', `${s.sync.antiEntropy.enabled}（间隔 ${Math.round((s.sync.antiEntropy.intervalMs ?? 600000) / 1000)}s · jitter ${s.sync.antiEntropy.jitterRatio ?? 0.2}）`],
        ['snapshotThreshold', s.sync.snapshotThreshold === null ? '未启用' : String(s.sync.snapshotThreshold)],
        ['兼容白名单', s.sync.legacyPeerAllowList.length ? escapeHtml(s.sync.legacyPeerAllowList.join(', ')) : '空（建议迁移到图上授权）'],
      ])}
      ${snippet({ sync: { autoSync: s.sync.autoSync, pushOnWrite: s.sync.pushOnWrite, antiEntropy: s.sync.antiEntropy, ...(s.sync.snapshotThreshold !== null ? { snapshotThreshold: s.sync.snapshotThreshold } : {}) } })}
    </section>

    <section class="settings-section">
      <h3>网络与接入 <span class="badge badge-muted">需改配置并重启</span></h3>
      ${kv([
        ['P2P', s.network.enabled ? '已启用' : '未启用'],
        ['relayUnlimited', String(s.network.relayUnlimited)],
        ['MCP 监听', `${escapeHtml(s.mcp.host)}:${s.mcp.port} · auth=${escapeHtml(s.mcp.auth)}${s.mcp.tls ? ' · TLS' : ''}`],
        ['语义召回', `${s.semantic.enabled ? '已启用' : '未启用'}（minScore ${s.semantic.minScore}）`],
      ])}
      ${snippet({ network: { enabled: s.network.enabled, libp2p: { listen: s.network.listen, relayServers: s.network.relays, relayUnlimited: s.network.relayUnlimited } } })}
    </section>
  `;

  body.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => copyText(button.dataset.copy, button));
  });
  const declare = $('#declare-issuer');
  if (declare) declare.addEventListener('click', declareIssuer);
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
  const statusChips = [];
  statusChips.push(device.revoked ? `${ICONS.revoked} 已被我屏蔽` : (device.online ? `${ICONS.online} 与我连接中` : `${ICONS.offline} 未连接`));
  if (device.pendingEventCount !== null && device.pendingEventCount !== undefined) {
    statusChips.push(`待发 ${device.pendingEventCount}`);
  }
  if (device.lastSyncAt) statusChips.push(`最近同步 ${formatTime(device.lastSyncAt)}`);
  if (device.declaredIssuer) statusChips.push('◈ 引导签发者');

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

  const membershipNs = (state.namespaces ?? []).filter((n) => n.membershipEnabled);
  const membershipRows = membershipNs.map((n) => {
    const mine = (device.memberships ?? []).find((m) => m.namespace === n.namespace) ?? null;
    const on = Boolean(mine);
    const hint = !mine ? '未在册' : mine.effective ? '在册 · 已生效' : '在册 · 未生效（缺授权）';
    return `<li>
      <span><span class="ns-chip" style="background:${namespaceColor(n.namespace)}">${escapeHtml(n.namespace)}</span>
        <span class="muted" style="margin-left:6px">${hint}</span></span>
      <label class="toggle" title="${on ? '移出该分区成员（不清理数据）' : '加入该分区成员（仍需授权才生效）'}">
        <input type="checkbox" data-membership="${escapeHtml(n.namespace)}" aria-label="成员资格 ${escapeHtml(n.namespace)}（当前${on ? '在册' : '未在册'}）" ${on ? 'checked' : ''} ${writes ? '' : 'disabled'}>
        <span class="slider"></span>
      </label>
    </li>`;
  }).join('');

  const actions = isSelf ? '' : `
    <div class="card-actions">
      <button class="btn btn-small btn-crt" data-action="sync" ${writes && device.online ? '' : 'disabled'}>立即同步</button>
      <button class="btn btn-small btn-crt" data-action="connect" ${writes && !device.online ? '' : 'disabled'}>连接</button>
      <button class="btn btn-small btn-crt" data-action="disconnect" ${writes && device.online ? '' : 'disabled'}>断开连接</button>
      <button class="btn btn-small btn-crt" data-action="reset-watermarks" ${writes ? '' : 'disabled'}>重置水位</button>
      <button class="btn btn-small btn-crt btn-crt-danger" data-action="revoke-device" ${writes ? '' : 'disabled'}>屏蔽该设备</button>
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
    <h3>成员资格（分区协作）</h3>
    ${membershipNs.length > 0
      ? `<ul class="chip-list">${membershipRows}</ul>`
      : '<p class="muted">当前没有启用成员制的分区（仅授权生效）。</p>'}
    ${actions}
  `;

  body.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => handleDeviceAction(button.dataset.action, device));
  });
  body.querySelectorAll('input[data-ns]').forEach((input) => {
    input.addEventListener('change', () => handleDomainToggle(device, input.dataset.ns, input.checked, input));
  });
  body.querySelectorAll('input[data-membership]').forEach((input) => {
    input.addEventListener('change', () => handleMembershipToggle(device, input.dataset.membership, input.checked, input));
  });
}

async function handleMembershipToggle(device, ns, on, input) {
  input.disabled = true;
  try {
    if (MOCK) {
      window.alert('mock 模式不执行写操作。');
      input.checked = !on;
      return;
    }
    await api('/admin/api/memberships', { method: 'POST', body: { member: device.deviceId, namespace: ns, active: on } });
    showToast(on ? `已将 ${device.deviceId} 加入「${ns}」成员` : `已将 ${device.deviceId} 移出「${ns}」成员`);
    await refresh();
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
    input.checked = !on;
  } finally {
    input.disabled = false;
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

  // 连线：准星边缘 → 折点 → 面板左上角（HUD 直角引线；斜段 + 短水平段入角）
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

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.setLineDash([4, 4]);
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    if (routed) ctx.lineTo(bendX, cornerY);
    ctx.lineTo(cornerX, cornerY);
    ctx.stroke();
  };
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

  // 折点节点 + 面板左上角菱形接线端子（静态）
  ctx.save();
  ctx.fillStyle = 'rgba(160, 255, 205, 0.9)';
  ctx.shadowColor = 'rgba(80, 255, 170, 0.85)';
  ctx.shadowBlur = 7;
  if (routed) {
    ctx.beginPath();
    ctx.arc(bendX, cornerY, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.translate(cornerX, cornerY);
  ctx.rotate(Math.PI / 4);
  ctx.fillRect(-2.8, -2.8, 5.6, 5.6);
  ctx.restore();
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
