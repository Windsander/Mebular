// Mebular 控制台前端（vanilla ES module，零依赖）
//
// 三个视图：星图（Canvas2D）/ 域视图（表格）/ 审计时间线。
// 右侧设备卡；顶栏本机身份与连接对端（本机视角）。
// D1 只读；写交互由服务端 features.writes 开关控制（D2 打开）。
//
// `?mock=1` 使用内置演示数据，便于无网络验收。

import { StarStage, namespaceColor, shortId } from './starfield.js';
import { initialViewFromSearch } from './deep-link.js';
import { createWizardState, wizardReduce, WIZARD_STEPS } from './wizard.js';
import { IA_TABS, IA_ADVANCED_SECTIONS, IA_MCP_SECTIONS, IA_FIELD_COPY, IA_SETTINGS_EXTRA, IA_SETTINGS_FOLDS, IA_SECURITY_SECTIONS, IA_MCP_DANGER_LINES, INVITE_TTL_OPTIONS, INVITE_TTL_DEFAULT_MS, SECURITY_LEVEL_LABEL, SECURITY_LEVEL_TITLE, SECURITY_LEVEL_NOTE, SECURITY_BOUNDARY, SECURITY_TOTP_FOOT, refreshCsrfToken, withCsrfRetry } from './settings-ia.js';
import { assistantsPanelHtml, serviceRowHtml, wizardRowHtml, statusPillHtml, attentionItems, assistantAddFormHtml } from './assistants.js';
import { reconcileAssistantUi } from './assistant-status.js';
import { t, getLocale, setLocale, onLocaleChange, applyStaticI18n, languageSettingsRowHtml, isI18nReady, formatTime as formatLocaleTime, formatDateTime as formatLocaleDateTime } from './i18n.mjs';

const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const MOCK = params.get('mock') === '1';
const POLL_MS = 3000;

const ICONS = { online: '●', offline: '○', revoked: '⊘' };

/** 折叠标题单一真源（IA_SETTINGS_FOLDS）；缺失时回退 id 便于定位。 */
const foldLabel = (id) => IA_SETTINGS_FOLDS.find((fold) => fold.id === id)?.label ?? id;

const state = {
  view: 'map',
  // P3：无 current 时主控制台保持可见但锁定（共享/记忆/审计/设备卡/数据操作禁用）。
  locked: false,
  provision: null,
  overview: null,
  devices: [],
  policy: [],
  namespaces: [],
  selectedNamespace: null,
  // G-ML-1：记忆生命周期视图（动作式；默认过滤已删除/已归档）
  memories: null,
  memoryFilters: { archived: false, deleted: false, namespace: '' },
  settings: null,
  // E2-A2：忆云列表/卡片与加入弹层（clouds 端点旧守护可能没有 → 卡片显示升级提示）
  clouds: null,
  cloudsError: null,
  cloudRename: null,
  cloudRenameError: '',
  // 本机设备名编辑（关于本机 → 身份与存储）
  deviceRename: null,
  deviceRenameError: '',
  cloudJoinInspect: null,
  cloudJoinResult: null,
  cloudJoinNameAuto: true,
  // S3：安全三档只读状态（GET /admin/api/security）+ 活动流（写操作弹层）
  security: null,
  securityFlow: null,
  healthz: null,
  settingsTab: 'common',
  rawConfig: null,
  cfgDraft: {},
  inviteToken: null,
  inviteTtlMs: INVITE_TTL_DEFAULT_MS,
  selected: null,
  degraded: null,
  error: null,
  clientRestart: {},
  clientOpen: {},
  clientVerify: {},
  clientBusy: {},
  clientFailed: {},
  addForm: null,
  csrf: readCookie('mebular_csrf'),
  token: params.get('token') ?? localStorage.getItem('mebular_token') ?? null,
  features: { writes: false },
  // H-1：常驻运行 + AI 助手接入
  service: null,
  clients: null,
  serviceMsg: '',
  clientMsg: {},
  clientDiff: {},
};

const stage = new StarStage($('#stage'));

// i18n foundation：首帧同步静态顶栏/导航；语言变化时重渲染当前页与已开设置/关于弹层（不 reload）。
// catalog 未就绪时强制停留在 zh-CN（即使系统语言是英文），避免普通用户看到半套英文；
// ?lang= / ?i18n=1 / 桌面壳 i18nReady 会打开就绪开关，此时才采用系统语言。
if (!isI18nReady() && getLocale() !== 'zh-CN') setLocale('zh-CN', { persist: false });
applyStaticI18n(document);
onLocaleChange(() => {
  applyStaticI18n(document);
  lastSettingsSignature = null;
  lastAboutSignature = null;
  render();
});

// ---------- 网络 ----------

function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// refresh 代际号（并发刷新丢弃过期完成；见 refresh()）
let refreshSeq = 0;
// refresh 单飞承诺（在途刷新未完结时复用，防请求雪崩堆叠——serve 变慢时系统仍能收敛）
let refreshPromise = null;

// ---------- bearer 令牌（App 内输入；Electron 不支持 window.prompt） ----------
let authTokenPromise = null;
let authTokenResolve = null;

function requestAuthToken() {
  if (authTokenPromise) return authTokenPromise;
  const modal = $('#auth-token');
  const input = $('#auth-token-input');
  const error = $('#auth-token-error');
  const help = $('#auth-token-help');
  if (!modal || !input) return Promise.resolve(null);
  input.value = '';
  if (error) { error.hidden = true; error.textContent = ''; }
  if (help) help.innerHTML = '在终端运行 <code>mebular token grant --scope memory.read,memory.admin</code> 生成。';
  modal.hidden = false;
  setTimeout(() => input.focus(), 0);
  authTokenPromise = new Promise((resolve) => { authTokenResolve = resolve; });
  return authTokenPromise;
}

function settleAuthToken(value) {
  const modal = $('#auth-token');
  if (modal) modal.hidden = true;
  if (authTokenResolve) authTokenResolve(value);
  authTokenResolve = null;
  authTokenPromise = null;
}

function submitAuthToken() {
  const value = $('#auth-token-input')?.value?.trim() ?? '';
  if (!value) {
    const error = $('#auth-token-error');
    if (error) { error.textContent = '请粘贴访问令牌。'; error.hidden = false; }
    return;
  }
  settleAuthToken(value);
}

async function api(path, options = {}) {
  const send = async () => {
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
      // 有界等待：serve 事件循环被同步探针占住时，慢请求到点中止——
      // allSettled 得以完结、连接池得以释放（否则刷新永远等不到全部响应，控制台永久卡死）
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 12000),
    });
    const csrfHeader = res.headers.get('x-mebular-csrf');
    if (csrfHeader) state.csrf = csrfHeader;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && !state.token) {
        const token = await requestAuthToken();
        if (token) {
          state.token = token;
          localStorage.setItem('mebular_token', token);
          startEvents();
        }
      }
      const error = new Error(data?.message ?? data?.error ?? `HTTP ${res.status}`);
      error.status = res.status;
      error.payload = data;
      throw error;
    }
    return data;
  };
  // CSRF 403（长开页面 / 守护重启后旧 token）→ 重取一次 token，原样重试一次。
  // 不刷新页面、不动表单；仍失败由 settings-ia.js 的共享 helper 给统一友好文案。
  return withCsrfRetry(send, async () => {
    const token = await refreshCsrfToken({ readCookie });
    if (token) state.csrf = token;
    return token;
  });
}

function refresh() {
  // 单飞：在途刷新未完结 → 复用同一承诺（调用方拿到同一份结果；轮询不再堆叠请求批次）
  refreshPromise ??= refreshOnce().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function refreshOnce() {
  // P3：锁定态不触碰 admin 数据面（除 /admin/api/clients 外的端点均 409 provision_required）。
  // 解锁时 enterNormalConsole() 会显式刷新一次。
  if (state.locked) return;
  // 代际号：并发刷新（3s 轮询 vs 动作后即时刷新）时，丢弃先发出后完成的旧数据，防旧列表覆盖新状态
  const seq = ++refreshSeq;
  if (MOCK) {
    const mock = await mockData();
    state.overview = mock.overview;
    state.devices = mock.devices;
    state.policy = mock.policy;
    state.namespaces = mock.namespaces;
    state.memories = mock.memories;
    state.security = mock.security ?? null;
    state.clouds = mock.clouds ?? null;
    state.cloudsError = null;
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
    api(`/admin/api/memories${memQuery()}`),
    api('/admin/api/service'),
    api('/admin/api/clients'),
    api('/healthz'),
    api('/admin/api/security'),
    api('/admin/api/clouds'),
  ]);
  const [overview, devices, policy, namespaces, settings, configView, memories, serviceView, clientsView, healthz, securityView, cloudsView] = results;
  if (seq !== refreshSeq) return; // 已有更新的刷新在途/完成：本轮数据过期，整体丢弃
  if (healthz && healthz.status === 'fulfilled') state.healthz = healthz.value;
  let firstError = null;
  if (overview.status === 'fulfilled') state.overview = overview.value;
  else firstError = overview.reason;
  if (devices.status === 'fulfilled') state.devices = devices.value;
  else firstError = firstError ?? devices.reason;
  if (policy.status === 'fulfilled') state.policy = policy.value;
  if (namespaces.status === 'fulfilled') state.namespaces = namespaces.value;
  if (settings.status === 'fulfilled') state.settings = settings.value;
  if (configView.status === 'fulfilled') state.rawConfig = configView.value;
  if (memories.status === 'fulfilled') state.memories = memories.value;
  if (serviceView.status === 'fulfilled') state.service = serviceView.value;
  if (clientsView.status === 'fulfilled') state.clients = clientsView.value.clients ?? [];
  // S3：安全状态只读；旧版 serve（无端点）→ null（徽章显示 —，不阻塞控制台）
  if (securityView.status === 'fulfilled') state.security = securityView.value;
  // E2-A2：忆云列表只读；失败不阻塞总览（旧守护 404 / 自定义 home 403 → 卡片给可读说明）
  if (cloudsView.status === 'fulfilled') {
    state.clouds = cloudsView.value;
    state.cloudsError = null;
  } else {
    state.clouds = null;
    const payload = cloudsView.reason?.payload ?? null;
    state.cloudsError = {
      code: payload?.error ?? (cloudsView.reason?.status === 404 ? 'CLOUD_UNSUPPORTED' : 'CLOUD_LIST_FAILED'),
      message: payload?.message ?? cloudsView.reason?.message ?? '忆云列表不可用',
    };
  }
  // 补丁 3 增补 · 对账：每轮刷新清掉与服务端真值矛盾的客户端残留
  // （配置不在了 → 清提示/verify/失败残留；verify 确认 connected → 重载提醒退场）
  for (const c of state.clients ?? []) {
    reconcileAssistantUi(c, {
      reloadHints: state.clientRestart,
      verifyStates: state.clientVerify,
      failed: state.clientFailed,
      busy: state.clientBusy,
    });
  }
  state.features = { writes: Boolean(state.overview?.features?.writes) };
  state.error = firstError;
  state.degraded = computeDegraded();
  // 若加入弹层在首轮数据到达前已打开：补齐当前忆云名与默认名字（不覆盖用户已输入内容）。
  syncCloudJoinMeta();
  render();
}

function computeDegraded() {
  if (state.error) return `无法连接本机 serve：${state.error.message}`;
  const status = state.overview?.status;
  if (!status) return '尚未取得状态';
  if (!status.running) return '未启用 P2P：仅显示本机记忆与订阅，连接与同步不可用';
  return null;
}

// ---------- 渲染 ----------

function render() {
  if (state.locked) {
    // 锁定态：只渲染壳与星图（背景 + 本机 ghost 地球仪）；不渲染任何依赖 admin 数据面的内容。
    renderTopbar();
    renderLockedChrome();
    renderLegend();
    renderStageScene();
    renderDeviceCard();
    renderOverlays();
    if (!$('#settings').hidden) renderSettings();
    if (!$('#about').hidden) renderAbout();
    renderBanner();
    return;
  }
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
  renderMemories();
  renderOverlays();
  if (!$('#settings').hidden) renderSettings();
  if (!$('#about').hidden) renderAbout();
  renderBanner();
}

/** P3：锁定主控制台的静态外壳（导航禁用 / 顶栏入口切换 / 视觉标记）。 */
function renderLockedChrome() {
  document.body.classList.add('is-locked');
  const app = $('#app');
  if (app) app.dataset.locked = 'true';
  document.querySelectorAll('#view-nav .view-btn').forEach((button) => {
    const disabled = button.dataset.view !== 'map';
    button.classList.toggle('is-locked', disabled);
    if (disabled) {
      button.setAttribute('aria-disabled', 'true');
      button.title = '新建或加入忆云后可用';
    } else {
      button.removeAttribute('aria-disabled');
      button.removeAttribute('title');
    }
  });
  const create = $('#create-cloud');
  const invite = $('#invite-device');
  const join = $('#join-cloud');
  if (create) create.hidden = false;
  if (invite) invite.hidden = true;
  if (join) join.hidden = false;
  create?.classList.add('is-onboarding');
  join?.classList.add('is-onboarding');
  create?.removeAttribute('aria-disabled');
  join?.removeAttribute('aria-disabled');
}

function clearLockedChrome() {
  state.locked = false;
  document.body.classList.remove('is-locked');
  const app = $('#app');
  if (app) delete app.dataset.locked;
  document.querySelectorAll('#view-nav .view-btn').forEach((button) => {
    button.classList.remove('is-locked');
    button.removeAttribute('aria-disabled');
    button.removeAttribute('title');
  });
  const create = $('#create-cloud');
  const invite = $('#invite-device');
  const join = $('#join-cloud');
  if (create) create.hidden = true;
  if (invite) invite.hidden = false;
  if (join) join.hidden = false;
  create?.classList.remove('is-onboarding');
  join?.classList.remove('is-onboarding');
}

function renderTopbar() {
  const status = state.overview?.status;
  const selfEl = $('#self-badge');
  const onlineEl = $('#online-badge');
  const memEl = $('#memory-badge');
  if (state.locked) {
    // 锁定态只显示「未初始化」真值，不显示任何猜测的设备/记忆数据。
    const cloudEl = $('#cloud-badge');
    if (cloudEl) { cloudEl.hidden = true; cloudEl.textContent = ''; }
    selfEl.textContent = '本机 · 未初始化';
    selfEl.title = '打开「关于本机」';
    onlineEl.textContent = `${ICONS.offline} 未初始化`;
    onlineEl.className = 'badge badge-muted';
    memEl.textContent = '记忆 —';
    memEl.className = 'badge badge-muted';
    const secEl = $('#security-badge');
    if (secEl) {
      secEl.textContent = '🛡 安全：—';
      secEl.className = 'badge badge-button badge-muted';
      secEl.title = '新建或加入忆云后可用';
    }
    const pendingBadge = $('#settings-pending-badge');
    if (pendingBadge) pendingBadge.hidden = true;
    renderLockedChrome();
    return;
  }
  // E2-A2：忆云名只取 overview.cloud.name；旧守护没有该字段 → 徽章隐藏（绝不用端口/目录猜）。
  const cloudEl = $('#cloud-badge');
  if (cloudEl) {
    const cloud = state.overview?.cloud ?? null;
    if (typeof cloud?.name === 'string' && cloud.name.trim().length > 0) {
      const currentConflict = state.clouds?.nameConflicts?.currentDuplicate === true
        || (state.clouds?.profiles ?? []).some((profile) => profile.current && profile.duplicateName);
      cloudEl.hidden = false;
      cloudEl.innerHTML = `<svg class="cloud-mark" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.6 12.2h6.9a2.7 2.7 0 0 0 .4-5.37A4.2 4.2 0 0 0 3.4 7.1a2.6 2.6 0 0 0 1.2 5.1Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="cloud-name">${escapeHtml(cloud.name)}</span>${currentConflict ? '<span class="cloud-warning-dot" title="本机有同名忆云，建议改名" aria-label="重名警告"></span>' : ''}`;
      cloudEl.title = currentConflict
        ? `当前忆云：${cloud.name}（有同名忆云，建议改名；点击打开设置 · 忆云）`
        : `当前忆云：${cloud.name}（点击打开设置 · 忆云）`;
      cloudEl.setAttribute('aria-label', currentConflict
        ? `当前忆云：${cloud.name}；有同名忆云警告；打开设置 · 忆云`
        : `当前忆云：${cloud.name}；打开设置 · 忆云`);
    } else {
      cloudEl.hidden = true;
      cloudEl.textContent = '';
    }
  }
  if (state.overview?.device) {
    selfEl.textContent = `本机 · ${state.overview.device.deviceId}`;
    selfEl.title = `打开「关于本机」（${state.overview.device.deviceId}）`;
  } else {
    selfEl.textContent = '本机 · …';
    selfEl.title = '打开「关于本机」';
  }
  const online = Boolean(status?.running);
  onlineEl.textContent = online ? `${ICONS.online} P2P 已启用` : `${ICONS.offline} P2P 未启用`;
  onlineEl.className = `badge ${online ? 'badge-ok' : 'badge-muted'}`;
  memEl.textContent = status ? `记忆 ${status.nodeCount ?? '—'}` : '记忆 …';
  memEl.className = 'badge badge-muted';
  // S3：只读安全徽章（点击 = 打开安全卡；不做写操作）
  const secEl = $('#security-badge');
  if (secEl) {
    const level = state.security?.level ?? null;
    secEl.textContent = level ? `🛡 安全：${securityLevelLabel(level)}` : '🛡 安全：—';
    secEl.className = `badge badge-button ${level === 'high' ? 'badge-ok' : level === 'medium' ? 'badge-warn' : 'badge-muted'}`;
    const pending = (state.security?.pendingApprovals ?? []).filter((a) => a?.initiator !== state.overview?.device?.deviceId).length;
    const rejected = (state.security?.rejections ?? []).length;
    secEl.title = level
      ? `安全等级：${securityLevelLabel(level)}${pending ? ` · 待批准 ${pending} 项` : ''}${rejected ? ` · ${rejected} 条被拒绝` : ''}（点击打开安全卡）`
      : '安全状态不可用（旧版守护 / 读取失败）';
  }
  const pendingBadge = $('#settings-pending-badge');
  if (pendingBadge) {
    const count = pendingRestartItems().length;
    pendingBadge.hidden = count === 0;
    pendingBadge.textContent = count > 0 ? `待重启 ${count} 项` : '';
  }
}

function allNamespaceNames() {
  const names = new Set();
  for (const entry of state.namespaces) names.add(entry.namespace);
  for (const device of state.devices) {
    for (const ns of device.subscriptions ?? []) names.add(ns);
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
    li.textContent = '暂无记忆域';
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
  if (state.locked) {
    // P6A：锁定态保留星图背景，用一个 CRT 虚影地球仪占住「本机」位置；
    // 只表达「本机尚未初始化」，不映射成任何设备/记忆数据。
    return {
      nodes: [{
        id: 'local-ghost',
        label: '本机 · 未初始化',
        self: true,
        ghost: true,
        online: false,
        blocked: false,
      }],
      edges: [],
    };
  }
  const selfId = state.overview?.device?.deviceId;
  if (!selfId) return { nodes: [], edges: [] };
  const nodes = [{
    id: selfId,
    label: '★ 本机',
    self: true,
    online: true,
    blocked: false,
  }];
  const edges = [];
  for (const device of state.devices) {
    if (device.deviceId === selfId) continue;
    const shared = device.sharesWithMe ?? [];
    nodes.push({
      id: device.deviceId,
      label: shortId(device.deviceId),
      online: device.online,
      blocked: device.blocked === true,
      namespaces: device.subscriptions ?? [],
      pendingEventCount: device.pendingEventCount ?? 0,
    });
    if (shared.length > 0) {
      edges.push({
        from: selfId,
        to: device.deviceId,
        kind: 'mine',
        online: device.online,
        revoked: false,
        pending: device.pendingEventCount ?? 0,
      });
      edges.push({
        from: device.deviceId,
        to: selfId,
        kind: 'theirs',
        online: device.online,
        revoked: false,
        pending: 0,
      });
    } else if (device.blocked === true) {
      edges.push({
        from: selfId,
        to: device.deviceId,
        kind: 'mine',
        online: device.online,
        revoked: true,
        pending: 0,
      });
    }
  }
  return { nodes, edges };
}

function renderStageScene() {
  stage.setScene(buildScene());
  stage.setSelected(state.selected?.deviceId ?? null);
  const canvas = $('#stage');
  if (canvas) {
    // 验收/辅助技术可读的诚实标记；视觉本体仍由 Canvas 绘制。
    canvas.dataset.scene = state.locked ? 'locked-ghost' : 'ready';
    canvas.setAttribute('aria-label', state.locked ? '本机星图：本机尚未初始化' : '对端关系星图（本机视角）');
  }
}

function renderBanner() {
  const banner = $('#banner');
  // 常驻横幅可见时给 .stage-wrap 打标——窄屏下面板视图据此让位，不被横幅压住标题/统计
  const wrap = document.querySelector('.stage-wrap');
  if (state.locked) {
    banner.hidden = false;
    banner.className = 'banner is-locked';
    banner.textContent = '忆云尚未初始化：新建或加入后解锁共享、记忆、审计与设备卡。';
    wrap?.classList.add('has-banner');
    return;
  }
  if (state.error) {
    banner.hidden = false;
    banner.className = 'banner is-error';
    banner.textContent = `无法连接本机 serve：${state.error.message}（保留上次数据）`;
    wrap?.classList.add('has-banner');
    return;
  }
  if (state.degraded) {
    banner.hidden = false;
    banner.className = 'banner';
    banner.textContent = state.degraded;
    wrap?.classList.add('has-banner');
    return;
  }
  banner.hidden = true;
  wrap?.classList.remove('has-banner');
}

function renderDomains() {
  const list = $('#domains-list');
  const detail = $('#domain-detail');
  const stats = $('#domains-stats');
  const layout = $('#domains-layout');
  const empty = $('#domains-empty');
  const note = $('#domains-note');
  const items = state.namespaces ?? [];

  if (stats) {
    if (items.length === 0) {
      stats.innerHTML = '<span class="crt-tag">本机视角</span>';
    } else {
      const subscribed = items.filter((n) => n.subscribed).length;
      stats.innerHTML = `<span class="crt-tag">记忆域 ${items.length}</span>`
        + (subscribed > 0 ? `<span class="crt-tag">已订阅 ${subscribed}</span>` : '');
    }
  }
  if (items.length === 0) {
    state.selectedNamespace = null;
    list.innerHTML = '';
    detail.innerHTML = '';
    if (layout) layout.hidden = true;
    if (empty) empty.hidden = false;
    if (note) note.hidden = false;
    return;
  }
  if (layout) layout.hidden = false;
  if (empty) empty.hidden = true;
  if (note) note.hidden = false;
  if (!items.some((n) => n.namespace === state.selectedNamespace)) {
    state.selectedNamespace = items[0].namespace;
  }
  const selected = items.find((n) => n.namespace === state.selectedNamespace);
  const taskNs = state.settings?.fleet?.namespace ?? null;
  list.innerHTML = items.map((n) => {
    const active = n.namespace === state.selectedNamespace;
    const isTask = taskNs !== null && n.namespace === taskNs;
    const meta = `${n.count} 条${n.subscribed ? '' : ' · 未订阅'}${isTask ? ' · 任务域' : ''}`;
    return `<div class="sector-item${active ? ' is-active' : ''}">
      <button class="sector-main" data-sector="${escapeHtml(n.namespace)}" type="button">
        <span class="sector-dot${n.subscribed ? ' is-on' : ''}"></span>
        <span class="sector-name"><span class="ns-chip" style="background:${namespaceColor(n.namespace)}">${escapeHtml(n.namespace)}</span></span>
        <span class="sector-meta${n.subscribed ? '' : ' off'}">${meta}</span>
      </button>
      <button class="sector-more" type="button" data-domain-menu="${escapeHtml(n.namespace)}" title="更多" aria-label="更多操作">⋯</button>
    </div>`;
  }).join('');
  renderDomainDetail(selected);

  list.querySelectorAll('[data-sector]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedNamespace = button.dataset.sector;
      renderDomains();
    });
  });
  list.querySelectorAll('[data-domain-menu]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openHandoff(button.dataset.domainMenu);
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
  const selfId = state.overview?.device?.deviceId ?? null;
  const subscribers = Array.isArray(n.subscribers) ? n.subscribers : [];
  const others = subscribers.filter((m) => m !== selfId);
  const othersText = others.slice(0, 4).map((m) => escapeHtml(m)).join('、')
    + (others.length > 4 ? ` 等 ${others.length} 台设备` : '');
  const relation = others.length === 0 ? '没有其他设备订阅这个域' : `${othersText} 也在订阅这个域`;
  const ordered = [...subscribers].sort((a, b) => (a === selfId ? -1 : 0) - (b === selfId ? -1 : 0));
  const subscriberChips = subscribers.length
    ? ordered.map((m) => `<span class="member-chip is-effective">${m === selfId ? '本机' : escapeHtml(m)}</span>`).join(' ')
    : '<span class="muted">暂无订阅记录（订阅是每台设备自己的决定）</span>';

  const rejoin = n.rejoinReset
    ? `<div class="ctx-row">
        <span>⟳ 上次退出后本机水位已清空：重新同步后，对端会从头重发这个记忆域（或发初始快照）</span>
        <button class="link-btn" type="button" data-rejoin="${escapeHtml(ns)}" ${writes ? '' : 'disabled'} title="${writes ? '对端将从头重发这个记忆域' : '只读模式'}">重新同步…</button>
      </div>`
    : '';

  const isTaskNs = (state.settings?.fleet?.namespace ?? null) === ns;
  detail.innerHTML = `<article class="sector-readout crt-surface crt-corners">
    <header class="readout-head">
      <span class="ns-chip" style="background:${namespaceColor(ns)}">${escapeHtml(ns)}</span>${isTaskNs ? '<span class="crt-tag">任务域</span>' : ''}
      <span class="readout-meta">${n.count} 条 · 最近更新 ${n.lastUpdatedAt ? formatTime(n.lastUpdatedAt) : '—'}</span>
      <span class="ns-subscribe"><label class="toggle" title="订阅 = 接收这个记忆域的全部更新，并把本机的新增同步给其他订阅设备"><input id="ns-subscribe" type="checkbox" data-ns-subscribe="${escapeHtml(ns)}" aria-label="订阅这个记忆域（当前${n.subscribed ? '已订阅' : '未订阅'}）" ${n.subscribed ? 'checked' : ''} ${writes ? '' : 'disabled'}><span class="slider"></span></label><span class="readout-meta">${n.subscribed ? '已订阅' : '未订阅'}</span></span>
    </header>
    ${isTaskNs ? '<p class="muted" style="font-size:11px;margin:6px 0 0">任务面：发起节点为根派发任务树，远端 Agent 执行后回传结果（有向无环）；订阅即可收发该任务域。</p>' : ''}
    <p class="relation">${relation}</p>
    <p class="subscribe-note">订阅 = 接收这个记忆域的全部更新；本机新增也同步给其他订阅设备（阅读权 + 维持义务）。</p>
    <details class="share" open>
      <summary>订阅的设备</summary>
      <div class="share-row"><span class="lbl">已订阅</span><div class="chip-wrap">${subscriberChips}</div></div>
      <div class="share-row"><span class="lbl"></span><span class="share-hint">订阅是每台设备自己的决定；图上记录，本机视角。</span></div>
    </details>
    ${rejoin}
    <div class="danger-zone">
      <button class="danger-link" type="button" data-handoff="${escapeHtml(ns)}" ${writes ? '' : 'disabled'}>退出并交接这个域…</button>
      <span class="hint">仅清本机数据与水位，需继任者 ack · 已同步给别人的不回撤</span>
    </div>
  </article>`;

  bindDomainActions();
}

function bindDomainActions() {
  const detail = $('#domain-detail');
  detail.querySelectorAll('[data-ns-subscribe]').forEach((el) => {
    el.addEventListener('change', () => {
      const ns = el.dataset.nsSubscribe;
      const on = el.checked;
      const current = Array.isArray(state.settings?.sync?.subscriptions) ? state.settings.sync.subscriptions : [];
      const all = (state.namespaces ?? []).map((x) => x.namespace).filter((x) => x !== ns);
      const next = on
        ? (current.length === 0 ? [] : [...new Set([...current, ns])])
        : (current.length === 0 ? all : current.filter((x) => x !== ns));
      if (!on && current.length === 0) {
        void (async () => {
          const ok = await confirmModal({
            title: '改为只订阅部分记忆域',
            body: `当前本机订阅全部记忆域。退订「${ns}」后，将改为只订阅其余 ${all.length} 个记忆域；之后新出现的记忆域默认不再订阅。`,
            confirmLabel: '确认',
          });
          if (!ok) {
            el.checked = true;
            return;
          }
          void applySubscription(ns, false, next);
        })();
        return;
      }
      void applySubscription(ns, on, next);
    });
  });
  detail.querySelectorAll('[data-rejoin]').forEach((button) => {
    button.addEventListener('click', () => doRejoin(button.dataset.rejoin));
  });
  detail.querySelectorAll('[data-handoff]').forEach((button) => {
    button.addEventListener('click', () => openHandoff(button.dataset.handoff));
  });
}

async function applySubscription(ns, active, nextNamespaces) {
  if (MOCK) {
    window.alert('mock 模式不执行写操作。');
    return;
  }
  try {
    await api('/admin/api/subscriptions', {
      method: 'POST',
      body: { namespace: ns, active, ...(nextNamespaces !== undefined ? { nextNamespaces } : {}) },
    });
    showToast(active ? `已订阅「${ns}」` : `已退订「${ns}」`);
    await refresh();
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
    await refresh();
  }
}

function openNamespaceNew() {
  if (MOCK) {
    window.alert('mock 模式不执行写操作。');
    return;
  }
  const modal = $('#namespace-new-modal');
  const input = $('#namespace-new-name');
  const error = $('#namespace-new-error');
  if (!modal || !input) return;
  if (error) { error.hidden = true; error.textContent = ''; }
  input.value = '';
  modal.hidden = false;
  setTimeout(() => input.focus(), 0);
}

function closeNamespaceNew() {
  const modal = $('#namespace-new-modal');
  if (modal) modal.hidden = true;
}

async function createNamespace(rawName) {
  if (MOCK) {
    window.alert('mock 模式不执行写操作。');
    return;
  }
  const namespace = String(rawName ?? '').trim();
  const error = $('#namespace-new-error');
  const showError = (message) => {
    if (!error) return;
    error.textContent = message;
    error.hidden = false;
  };
  if (namespace.length === 0) {
    showError('请先填写记忆域名称。');
    return;
  }
  try {
    // 服务端默认自订阅（active:true）：创建完就能写；用户仍可随时退订。
    await api('/admin/api/namespaces', { method: 'POST', body: { namespace, subscribe: true } });
    state.selectedNamespace = namespace;
    closeNamespaceNew();
    await refresh();
    showToast(`已创建并订阅「${namespace}」；本机即可开始记录`);
  } catch (err) {
    showError(`创建失败：${err.message}`);
  }
}

function submitNamespaceNew() {
  void createNamespace($('#namespace-new-name')?.value ?? '');
}

async function doRejoin(ns) {
  if (MOCK) {
    window.alert('mock 模式不执行写操作。');
    return;
  }
  const ok = await confirmModal({
    title: `重新同步 ${ns}`,
    body: `将对「${ns}」声明重置：清空本机水位，对端会从头重发这个记忆域（或发初始快照）。本机未订阅该记忆域时会被拒绝。确定继续？`,
    confirmLabel: '重新同步',
  });
  if (!ok) return;
  try {
    const result = await api(`/admin/api/namespaces/${encodeURIComponent(ns)}/rejoin`, { method: 'POST', body: {} });
    if (result?.ok) showToast(`已重新同步「${ns}」`);
    else showToast(`重新同步失败：${result?.reason ?? '条件不满足'}`);
    await refresh();
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
  }
}

// ---------- 退出并交接（plan 预检 + 强确认；force 不提供） ----------

let handoffNs = null;

function openHandoff(ns) {
  handoffNs = ns;
  $('#handoff-title').textContent = `退出并交接 · ${ns}`;
  $('#handoff-desc').textContent =
    '退出并交接：本机彻底清理该记忆域数据与水位（无 tombstone；__policy__ 保留）。清理前必须继任者全量 ack；门禁不过则中止。如需再次订阅并从头重发，需本机重新订阅该记忆域。';
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
    title: `退出并交接 ${ns}`,
    body: `将把「${ns}」交接给 ${successor}，并从本机彻底清理该记忆域数据（不可撤销）；已同步给别人的不回撤。确定继续？`,
    confirmLabel: '退出并清理',
  });
  if (!ok) return;
  try {
    const result = await api(`/admin/api/namespaces/${encodeURIComponent(ns)}/leave`, { method: 'POST', body: { successor } });
    showToast(result?.ok ? `已退出并清理「${ns}」` : `交接中止：${result?.reason ?? '未满足门禁'}`);
    $('#handoff').hidden = true;
    await refresh();
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
  }
}

// ---------- 设置卡（本机；运行时 vs 需改配置重启） ----------

// ---------- 设置卡：常用配置编辑器（curated；保存写入 config.json，需重启生效） ----------

// A：编辑器字段元数据来自**服务端单一真源**（config-schema.mjs → /admin/api/settings.configSchema）；
// 控制台不再重复声明字段（曾散在 serve/admin/console/settings-ia 四处 → 漂移）。
// 曝光面：editable 渲染编辑器；status-only 只读展示（自动池 / 推导状态）；internal 不出现在 GUI。

let CONFIG_FIELDS_BY_PATH = new Map();

function rebuildConfigFields() {
  const list = Array.isArray(state.settings?.configSchema) ? state.settings.configSchema : [];
  CONFIG_FIELDS_BY_PATH = new Map(list.map((entry) => [entry.path, {
    path: entry.path,
    kind: entry.kind,
    requiresRestart: entry.requiresRestart !== false,
    ...(entry.ui ?? {}),
    // 展示层覆盖：短帮助/统一词；校验、默认值与写入行为仍由服务端 schema 决定。
    ...(IA_FIELD_COPY[entry.path] ?? {}),
  }]));
}

function configFields() {
  return [...CONFIG_FIELDS_BY_PATH.values()];
}

// D：服务端三元组（已配置 / 实际 / 未生效原因）按 path 索引——原因由服务端计算，前端只渲染。
function effectiveRowOf(path) {
  const rows = Array.isArray(state.settings?.effective) ? state.settings.effective : [];
  return rows.find((row) => row.path === path) ?? null;
}

function statusRows() {
  const schema = Array.isArray(state.settings?.statusSchema) ? state.settings.statusSchema : [];
  return schema.map((entry) => ({ ...entry, ...(effectiveRowOf(entry.path) ?? {}) }));
}
// ---------- 待重启（pendingRestart）：配置已保存，但当前实例尚未重启 ----------
// 服务端 settings.pendingRestart 列出「磁盘值与启动快照不一致」的 curated 配置项（形如 { path, file, running }）。

const RESTART_LABELS = {
  'sync.autoSync': '自动同步',
  'sync.pushOnWrite': '写入即推送',
};

function pendingRestartItems() {
  return Array.isArray(state.settings?.pendingRestart) ? state.settings.pendingRestart : [];
}

function restartLabel(path) {
  return CONFIG_FIELDS_BY_PATH.get(path)?.label ?? RESTART_LABELS[path] ?? path;
}

// 服务由 launchd/systemd/计划任务拉起（注入 MEBULAR_SERVICE_KIND/SHA）→ service restart；否则给 nohup 启动命令。
// R-1 高-4：路径不写死 ~/.mebular——优先用服务端上报的真实 home（state.service.home）。
function restartCommand() {
  const home = state.service?.home;
  return state.settings?.restart?.serviceManaged
    ? 'mebular service restart'
    : `nohup mebular serve > ${home ?? '<MEBULAR_HOME>'}/serve.log 2>&1 &`;
}

function formatRestartValue(value) {
  if (value === null || value === undefined) return '未设置';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '未设置';
  if (typeof value === 'boolean') return value ? '启用' : '未启用';
  return String(value);
}

/** G：最近一次「保存即生效」结果横幅（绿=已生效 / 红=未按预期生效 / 红=已回滚）。
 *  - in-progress：重启中（页面已在等待恢复）
 *  - applied 且 verify 全 ok：绿色「已生效（字段清单）」
 *  - applied 但有 verify.ok===false：红色「未按预期生效：<字段>（已配置 X / 实际 Y）」
 *  - rolled-back / rollback-failed：红色「未按预期生效（原因：…）：已回滚」
 */
function applyResultBanner() {
  const apply = state.settings?.lastApply;
  if (!apply || typeof apply.status !== 'string') return '';
  const labelOf = (path) => CONFIG_FIELDS_BY_PATH.get(path)?.label ?? path;
  const fields = Array.isArray(apply.fields) ? apply.fields : [];
  const fieldText = fields.length ? fields.map(labelOf).join('、') : '（无字段记录）';
  if (apply.status === 'in-progress') {
    return `<div class="pending-restart" data-apply-result="in-progress">
      <div class="pending-restart-head"><span class="crt-tag crt-tag-warn">正在重启…重连中…</span><span class="muted">让已保存的配置生效</span></div>
      <p class="muted pending-restart-note">守护正在重启（fields=${escapeHtml(fields.join(', '))}）；恢复后本横幅会显示「已生效」或回滚结果。</p>
    </div>`;
  }
  if (apply.status === 'applied') {
    const verify = Array.isArray(apply.verify) ? apply.verify : [];
    const failed = verify.filter((row) => row.ok === false);
    if (failed.length > 0) {
      const detail = failed.map((row) => `<li><b>${escapeHtml(labelOf(row.path))}</b> <code>${escapeHtml(row.path)}</code>`
        + `<span class="muted">：已配置 ${escapeHtml(formatRestartValue(row.configured))} / 实际 ${escapeHtml(formatRestartValue(row.actual))}</span>`
        + (row.reason ? `<span class="pending-restart-reason">原因：${escapeHtml(String(row.reason))}</span>` : '')
        + '</li>').join('');
      return `<div class="pending-restart is-error" data-apply-result="mismatch">
        <div class="pending-restart-head"><span class="crt-tag crt-tag-error">未按预期生效</span><span class="muted">重启后 ${failed.length} 项与保存值不一致</span></div>
        <ul class="pending-restart-list">${detail}</ul>
      </div>`;
    }
    return `<div class="pending-restart is-ok" data-apply-result="applied">
      <div class="pending-restart-head"><span class="crt-tag crt-tag-ok">已生效</span><span class="muted">${escapeHtml(fieldText)}</span></div>
      <p class="muted pending-restart-note">已按保存值生效（${escapeHtml(String(apply.at ?? ''))}）；待重启清单已清空。</p>
    </div>`;
  }
  if (apply.status === 'rolled-back' || apply.status === 'rollback-failed' || apply.status === 'failed') {
    const rolled = apply.status === 'rolled-back';
    return `<div class="pending-restart is-error" data-apply-result="${escapeHtml(apply.status)}">
      <div class="pending-restart-head"><span class="crt-tag crt-tag-error">新配置未生效</span><span class="muted">${rolled ? '已回滚到上一次可用配置' : '回滚失败：请手动恢复'}</span></div>
      <p class="muted pending-restart-note">原因：${escapeHtml(String(apply.reason ?? '未知'))}</p>
      <p class="muted pending-restart-note">涉及字段（${escapeHtml(fieldText)}）${apply.backup ? `；备份：<code>${escapeHtml(String(apply.backup))}</code>` : ''}</p>
    </div>`;
  }
  return '';
}

function pendingRestartBadge() {
  const count = pendingRestartItems().length;
  return count > 0 ? `<span class="crt-tag crt-tag-warn">待重启 ${count} 项</span>` : '';
}

function pendingRestartBanner() {
  const items = pendingRestartItems();
  if (items.length === 0) return '';
  const envOverrides = Array.isArray(state.settings?.pendingRestartEnvOverrides) ? state.settings.pendingRestartEnvOverrides : [];
  const cmd = restartCommand();
  const managed = state.settings?.restart?.serviceManaged === true;
  const rows = items.map((item) => `<li><b>${escapeHtml(item.label ?? restartLabel(item.path))}</b>`
    + ` <code>${escapeHtml(item.path)}</code>`
    + `<span class="muted">：已配置 ${escapeHtml(formatRestartValue(item.file))} / 实际 ${escapeHtml(formatRestartValue(item.running))}</span>`
    + `<span class="pending-restart-reason">未生效原因：${escapeHtml(String(item.reason ?? '待重启：已保存的值将在重启后生效'))}</span></li>`).join('');
  return `<div class="pending-restart" data-pending-restart="1">
    <div class="pending-restart-head">
      <span class="crt-tag crt-tag-warn">待重启 ${items.length} 项</span>
      <span class="muted">配置已保存，当前实例仍按上次启动的配置工作</span>
    </div>
    <p class="muted pending-restart-note">守护只在启动时读取配置；保存后当前实例仍按上次启动的配置工作，重启后生效。${envOverrides.length > 0 ? `环境变量优先时以环境变量为准（当前：${escapeHtml(envOverrides.join(', '))}）。` : ''}</p>
    <ul class="pending-restart-list">${rows}</ul>
    <div class="pending-restart-cmd">
      <button class="btn btn-small btn-crt" type="button" data-cfg-action="restart" ${state.features?.writes && !MOCK ? '' : 'disabled'}>一键重启</button>
      <code>${escapeHtml(cmd)}</code>
      <button class="btn btn-small btn-crt" type="button" data-copy="${escapeHtml(cmd)}">复制重启命令</button>
      <span class="cfg-restart-state muted"></span>
    </div>
    ${managed ? '' : '<p class="muted" style="font-size:11px">未以服务方式运行（前台 nohup）：一键重启不可用，请按上方命令手动重启。</p>'}
  </div>`;
}

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

function formatRuntimeValue(value) {
  if (value === undefined || value === null) return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '（空 = 默认）';
  if (typeof value === 'boolean') return value ? '启用' : '未启用';
  return String(value);
}

function fieldInitial(field) {
  const raw = cfgGet(currentConfigFile(), field.path);
  if (raw !== undefined) return { value: raw, isDefault: false };
  // 未写入 config.json：用服务端三元组的「实际」值（= 运行时生效值）作为初值，避免卡片失真
  const row = effectiveRowOf(field.path);
  if (row) return { value: row.actual ?? field.default ?? null, isDefault: true };
  return { value: field.default ?? null, isDefault: true };
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
  if (field.type === 'select') return typeof v === 'string' ? v : (field.options?.[0]?.[0] ?? '');
  return typeof v === 'string' ? v : '';
}

function collectConfigChanges(root) {
  const changes = [];
  for (const field of configFields()) {
    const el = root.querySelector(`[data-cfg-path="${CSS.escape(field.path)}"]`);
    if (!el) continue;
    const next = fieldToConfig(field, field.type === 'bool' ? el.checked : el.value);
    const current = normalizedFieldValue(field);
    if (JSON.stringify(next) === JSON.stringify(current)) continue;
    changes.push({ path: field.path, value: next });
  }
  return changes;
}

/**
 * D：三元组渲染（已配置 X / 实际 Y / **未生效原因**）。
 * configured/actual/reason 均由服务端 /admin/api/settings.effective 计算（单一真源，前端不推导）。
 * 轮 C · 呈现分级：三元组相等（且无异常原因）时收成一行「生效中」；异常才完整呈现。
 */
function reasonIsFatal(reason) {
  return /(失败|被占|占用|未生效|无法|拒绝|EADDRINUSE|缺证书|MCP_INSECURE_CONFIG)/i.test(String(reason ?? ''));
}

function runtimeCompareLine(field) {
  const row = effectiveRowOf(field.path);
  if (!row) return '';
  const configured = row.configured;
  const actual = row.actual;
  const mismatch = configured !== null && configured !== undefined
    && JSON.stringify(configured ?? null) !== JSON.stringify(actual ?? null);
  const reason = typeof row.reason === 'string' && row.reason.length > 0 ? row.reason : '';
  // 「已生效：… / 已装配：…」是生效说明，不是未生效原因；其它原因才作为异常自动出现。
  // 布尔开关本就关闭时（如语义召回未启用），原因属于「为什么没开」的说明 → 收进详情，不占常显。
  const infoReason = reason.length > 0 && /^(已生效|已装配)/.test(reason);
  const boolOff = field.type === 'bool' && configured !== true && actual !== true && !reasonIsFatal(reason);
  const showReason = reason.length > 0 && !infoReason && !boolOff;
  const pendingItem = pendingRestartItems().find((item) => item.path === field.path) ?? null;
  const normal = !mismatch && !showReason && !pendingItem;
  // 常态不占行：没有异常就是生效；只有待重启/不一致/未生效时才在字段下展开。
  if (normal) return '';
  return `<p class="cfg-effective${mismatch ? ' is-mismatch' : ''}" data-cfg-state="exception">`
    + `<span><span class="cfg-eff-key">已配置</span> ${escapeHtml(formatRuntimeValue(configured))}</span>`
    + '<span>/</span>'
    + `<span><span class="cfg-eff-key">实际</span> ${escapeHtml(formatRuntimeValue(actual))}</span>`
    + (pendingItem ? `<span class="cfg-pending"><span class="cfg-eff-key">待重启</span> 已保存 ${escapeHtml(formatRestartValue(pendingItem.file))} / 当前 ${escapeHtml(formatRestartValue(pendingItem.running))}</span>` : '')
    + (showReason ? `<span class="cfg-reason"><span class="cfg-eff-key">未生效原因</span> ${escapeHtml(reason)}</span>` : '')
    + (mismatch && !showReason ? '<span class="cfg-warn">⚠ 不一致：写入值未生效，实际以运行时为准</span>' : '')
    + '</p>';
}

/** 收进「详情」的原因（仅布尔开关关闭时的说明；异常原因仍走常显三元组）。 */
function runtimeFoldedReason(field) {
  if (field.type !== 'bool' || field.hideStatusReason) return '';
  const row = effectiveRowOf(field.path);
  if (!row) return '';
  const configured = row.configured;
  const actual = row.actual;
  if (configured === true || actual === true) return '';
  const reason = typeof row.reason === 'string' ? row.reason.trim() : '';
  if (!reason || /^(已生效|已装配)/.test(reason) || reasonIsFatal(reason)) return '';
  return reason;
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
  const helpTitle = [field.help, field.warn].filter(Boolean).join(' ');
  const controlTitle = helpTitle ? ` title="${escapeHtml(helpTitle)}"` : '';
  // 空输入时把「默认值 / 短提示」收进 placeholder；有值时 placeholder 不显示，帮助在聚焦时展开。
  const defaultHint = initial.isDefault && field.default !== null && field.default !== undefined
    ? `默认 ${field.default}` : '';
  const placeholderText = field.placeholder || defaultHint || field.help || '';
  let control;
  if (field.type === 'bool') {
    control = `<label class="toggle cfg-toggle"${controlTitle}><input id="${id}" type="checkbox" data-cfg-path="${escapeHtml(field.path)}" ${value ? 'checked' : ''}><span class="slider"></span></label>`;
  } else if (field.type === 'select') {
    control = `<select id="${id}" class="crt-input" data-cfg-path="${escapeHtml(field.path)}"${controlTitle}>`
      + field.options.map(([v, label]) => `<option value="${escapeHtml(v)}" ${v === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')
      + '</select>';
  } else {
    const type = field.type === 'number' || field.type === 'minutes' ? 'number' : 'text';
    const attrs = [
      field.type === 'number' || field.type === 'minutes' ? `step="${field.step ?? 1}"` : '',
      field.min !== undefined ? `min="${field.min}"` : '',
      field.max !== undefined ? `max="${field.max}"` : '',
      placeholderText ? `placeholder="${escapeHtml(placeholderText)}"` : '',
      controlTitle,
    ].filter(Boolean).join(' ');
    control = `<input id="${id}" class="crt-input cfg-input" type="${type}" data-cfg-path="${escapeHtml(field.path)}" value="${escapeHtml(String(value))}" ${attrs} />`;
  }
  const hasDefault = field.default !== null && field.default !== undefined && field.default !== '';
  const defaultTag = initial.isDefault && hasDefault ? '<span class="cfg-default">默认</span>' : '';
  const warnMark = field.warn ? '<span class="cfg-warn-mark" title="风险说明" aria-label="有风险说明">⚠</span>' : '';
  const foldedReason = runtimeFoldedReason(field);
  const helpBits = [
    field.help ? `<p class="cfg-help muted">${escapeHtml(field.help)}</p>` : '',
    foldedReason ? `<p class="cfg-help muted">${escapeHtml(foldedReason)}</p>` : '',
    field.warn ? `<p class="cfg-help cfg-warn">⚠ ${escapeHtml(field.warn)}</p>` : '',
  ].filter(Boolean);
  return `<div class="cfg-row">
    <label class="cfg-label" for="${id}">${escapeHtml(field.label)}${defaultTag}${warnMark}</label>
    <div class="cfg-control">${control}
      ${runtimeCompareLine(field)}
      ${helpBits.join('')}
    </div>
  </div>`;
}

// 单一行模板：label | value | action 三列固定（动作列不撑高行；空值统一 muted 占位）
function kvRow(label, value, copyPayload = null) {
  return { label, value, copyPayload };
}

function copyRowOf(label, value) {
  return kvRow(label, `<code>${escapeHtml(value)}</code>`, value);
}

function emptyRowOf(label, text) {
  return kvRow(label, `<span class="kv-empty">${escapeHtml(text)}</span>`, null);
}

function kvRows(rows) {
  const cells = rows.map((row) => `<dt>${escapeHtml(row.label)}</dt>`
    + `<dd class="kv-value">${row.value}</dd>`
    + `<dd class="kv-action">${row.copyPayload === null || row.copyPayload === undefined
      ? ''
      : `<button class="btn btn-small btn-crt" type="button" data-copy="${escapeHtml(row.copyPayload)}">复制</button>`}</dd>`).join('');
  return `<dl class="settings-kv">${cells}</dl>`;
}

// 主值 + 次行（已配置 / 实际）；一致=暗色，不一致=警示色；长值换行悬挂在值列
function valueWithEffective(mainHtml, { configured, effective }) {
  const mismatch = configured !== undefined && JSON.stringify(configured ?? null) !== JSON.stringify(effective ?? null);
  return `<span class="kv-main">${mainHtml}</span>`
    + `<span class="kv-sub${mismatch ? ' is-mismatch' : ''}">`
    + `<span>已配置 ${escapeHtml(formatRuntimeValue(configured))}</span>`
    + `<span>/</span>`
    + `<span>实际 ${escapeHtml(formatRuntimeValue(effective))}</span>`
    + (mismatch ? '<span class="cfg-warn">⚠ 不一致：写入值未生效，实际以运行时为准</span>' : '')
    + '</span>';
}

function fieldOf(path) {
  const field = CONFIG_FIELDS_BY_PATH.get(path);
  // 容错：schema 缺项（旧服务端 / 载荷异常）时退化为文本行，不整页崩
  if (!field) return { path, type: 'text', label: path, help: '（该字段未在 schema 中声明）' };
  return field;
}

function renderEditor(paths) {
  return `<div class="cfg-editor">${paths.map((path) => renderCfgField(fieldOf(path))).join('')}</div>`;
}

/** 统一 section：标题 + 一行说明 + 字段行（设置内唯一版式，不再卡片套卡片）。 */
function settingsSectionHtml({ id, title, desc = '', chip = '', body = '', foot = '' }) {
  return `
    <section class="settings-section" data-settings-section="${escapeHtml(id)}">
      <h3>${escapeHtml(title)}${chip}</h3>
      ${desc ? `<p class="settings-section-desc muted">${escapeHtml(desc)}</p>` : ''}
      ${body}
      ${foot ? `<p class="settings-section-foot muted">${escapeHtml(foot)}</p>` : ''}
    </section>`;
}

function renderAdvancedSections() {
  return IA_ADVANCED_SECTIONS.map((section) => settingsSectionHtml({
    id: section.id,
    title: section.title,
    desc: section.desc,
    body: renderEditor(section.fields),
  })).join('');
}

function renderMcpSections() {
  return IA_MCP_SECTIONS.map((section) => settingsSectionHtml({
    id: section.id,
    title: section.title,
    desc: section.desc,
    body: renderEditor(section.fields),
  })).join('');
}

/**
 * P3：锁定态设置页 = 排错入口（不请求 admin 数据面，不白屏）。
 * 给出状态真值 + 两个入口；可复制诊断信息给支持人员。
 */
function renderLockedSettings(body) {
  if (!body) return;
  const status = state.provision ?? {};
  body.innerHTML = `
    <div class="settings-scroll">
      <section class="settings-section" data-locked-settings>
        <h3>忆云尚未初始化 <span class="crt-tag crt-tag-warn">锁定</span></h3>
        <p class="settings-section-desc muted">主控制台已锁定：共享、记忆、审计、设备卡与数据操作在新建或加入忆云后才可用。初始化在当前进程内完成，无需重启。</p>
        <div class="locked-settings-actions">
          <button class="btn btn-primary" type="button" data-locked-action="create">新建忆云</button>
          <button class="btn btn-crt" type="button" data-locked-action="join">加入忆云</button>
        </div>
      </section>
      <section class="settings-section" data-locked-diagnostics>
        <h3>诊断信息 <span class="badge badge-muted">只读</span></h3>
        ${kvRows([
          kvRow('阶段', escapeHtml(String(status.phase ?? 'UNINITIALIZED'))),
          kvRow('家目录', `<code>${escapeHtml(String(status.home ?? '—'))}</code>`),
          kvRow('默认设备名', escapeHtml(String(status.defaultDeviceName ?? status.hostname ?? '—'))),
          kvRow('本机端口', escapeHtml(String(status.mcpPort ?? '—'))),
        ])}
        <p class="settings-section-foot muted">若已用命令行初始化但仍显示锁定，请重启守护让当前进程加载新配置。</p>
        <button class="btn btn-small btn-crt" type="button" id="settings-locked-copy">复制诊断信息</button>
      </section>
    </div>
  `;
  body.querySelectorAll('[data-locked-action]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.lockedAction === 'create') openOnboardCreate();
      else openOnboardJoin();
    });
  });
  body.querySelector('#settings-locked-copy')?.addEventListener('click', (event) => {
    const payload = {
      phase: status.phase ?? 'UNINITIALIZED',
      home: status.home ?? null,
      deviceName: status.defaultDeviceName ?? status.hostname ?? null,
      mcpPort: status.mcpPort ?? null,
      href: location.href,
      userAgent: navigator.userAgent,
    };
    void copyText(JSON.stringify(payload, null, 2), event.currentTarget);
  });
}

let lastSettingsSignature = null;

// render() 每 3s 轮询会调用 renderSettings；内容签名用于判断是否真的需要重建 DOM。
// 覆盖渲染依赖：activeTab（即 settingsTab）、settings、rawConfig、writes、healthz、本机 deviceId、
// AI 助手专区依赖（clients / service / 行内动作消息与展开态）。
function settingsSignature(activeTab) {
  return JSON.stringify([
    activeTab,
    getLocale(),
    state.settings ?? null,
    state.security ?? null,
    state.rawConfig ?? null,
    state.features?.writes ?? null,
    state.healthz ?? null,
    state.overview?.device?.deviceId ?? null,
    // E2-A2：忆云卡随轮询更新名字/当前项；改名编辑态也纳入签名（输入值只放 state，不触发每键重建）
    state.clouds ?? null,
    state.cloudsError ?? null,
    state.cloudRename?.id ?? null,
    state.cloudRenameError ?? '',
    // AI 助手专区依赖：只取稳定投影（整对象序列化会因服务端易变字段导致每 3s 重建）
    (state.clients ?? null) && (state.clients ?? []).map((c) => [c.id, Boolean(c.installed), Boolean(c.connected), c.state ?? null]),
    state.service ? [Boolean(state.service.registered), Boolean(state.service.running)] : null,
    state.serviceMsg ?? '',
    state.clientMsg ?? null,
    state.clientDiff ?? null,
    state.clientRestart ?? null,
    state.clientOpen ?? null,
    state.clientVerify ?? null,
    state.clientBusy ?? null,
    state.clientFailed ?? null,
    state.addForm ?? null,
    // 诊断 · 状态指纹（来自记忆域的 stateHash；轮询内变化时重建）
    (state.namespaces ?? []).map((n) => [n.namespace, n.stateHash ?? null]),
  ]);
}

/** 设置页折叠块稳定键（跨轮询保留展开态；设置内只保留白名单折叠）。 */
function settingsFoldKey(el) {
  const key = el.dataset?.settingsFold;
  return key ?? null;
}

function renderSettings(activeTab = state.settingsTab ?? 'common') {
  const prevTab = state.settingsTab ?? 'common';
  state.settingsTab = activeTab;
  const body = $('#settings-body');
  if (state.locked) {
    renderLockedSettings(body);
    return;
  }
  // 轮询时内容未变则跳过重建，避免原生 <select> 弹层/焦点/选择被销毁
  const signature = settingsSignature(activeTab);
  if (signature === lastSettingsSignature && body.childElementCount > 0) return;
  lastSettingsSignature = signature;
  const prevActive = document.activeElement;
  const prevPath = prevActive?.dataset?.cfgPath ?? null;
  const prevStart = prevActive?.selectionStart ?? null;
  const prevEnd = prevActive?.selectionEnd ?? null;
  // 轮 C/U-3：只有提示下划线以下的内容滚动；重建时保留同一 Tab 的滚动位与折叠展开态
  const sameTab = prevTab === activeTab;
  const prevScroller = body.querySelector('.settings-scroll') ?? null;
  const prevScrollTop = sameTab ? (prevScroller?.scrollTop ?? 0) : 0;
  const openFolds = sameTab
    ? new Set([...body.querySelectorAll('details[open]')].map(settingsFoldKey).filter(Boolean))
    : new Set();
  const s = state.settings;
  const tabLabel = (tab) => {
    const key = `settings.tab.${tab.id}`;
    const label = t(key);
    return label === key ? tab.label : label;
  };
  const tabButton = (tab) => `<button id="settings-tab-${tab.id}" class="settings-tab${tab.id === activeTab ? ' is-active' : ''}"`
    + ` data-settings-tab="${tab.id}" type="button" role="tab" aria-selected="${tab.id === activeTab}" aria-controls="settings-panel-${tab.id}">${escapeHtml(tabLabel(tab))}</button>`;
  const panel = (id, inner) => `<section id="settings-panel-${id}" class="settings-panel" data-settings-panel="${id}" role="tabpanel"`
    + ` aria-labelledby="settings-tab-${id}"${id === activeTab ? '' : ' hidden'}>${inner}</section>`;
  if (!s) {
    // ?mock=1 无 settings 载荷：仍渲染五页签与安全卡（无网络验收路径；其余设置保持加载态）
    if (MOCK && state.security) {
      body.innerHTML = `
        <div class="settings-tabs" role="tablist" aria-label="设置页签" data-i18n-aria-label="settings.tabsAria">${IA_TABS.map(tabButton).join('')}${
          IA_SETTINGS_EXTRA.map((item) => `<button class="settings-tab settings-tab-extra" type="button" data-settings-extra="${escapeHtml(item.opens)}">${escapeHtml(item.label)}</button>`).join('')
        }</div>
        <div class="settings-scroll">
          ${panel('common', '<section class="settings-section" data-settings-common-status><h3>本机状态 <span class="badge badge-muted">只读</span></h3><p class="muted">?mock=1 仅提供安全卡与只读演示；可编辑设置需连接真实守护。</p></section>')}
          ${panel('security', `<section id="settings-security-slot" class="settings-slot" data-settings-slot="security" data-security-level="${escapeHtml(state.security?.level ?? 'low')}" tabindex="-1">${securityCardHtml()}</section>`)}
          ${panel('assistants', '<p class="muted">?mock=1 不提供 AI 助手演示数据。</p>')}
          ${panel('mcp', '<p class="muted">?mock=1 不提供可编辑配置。</p>')}
          ${panel('advanced', '<p class="muted">?mock=1 不提供可编辑配置。</p>')}
        </div>
      `;
      bindSecurityCard(body);
      return;
    }
    body.innerHTML = '<p class="muted">设置加载中…（若持续如此，检查 serve 是否运行）</p>';
    return;
  }
  rebuildConfigFields();
  const securityLevel = state.security?.level ?? null;

  body.innerHTML = `
    ${pendingRestartBanner()}
    ${applyResultBanner()}
    <div class="settings-tabs" role="tablist" aria-label="设置页签" data-i18n-aria-label="settings.tabsAria">${IA_TABS.map(tabButton).join('')}${
      IA_SETTINGS_EXTRA.map((item) => `<button class="settings-tab settings-tab-extra" type="button" data-settings-extra="${escapeHtml(item.opens)}">${escapeHtml(item.label)}</button>`).join('')
    }</div>
    <div class="settings-scroll">
    ${panel('common', `
      ${languageSettingsRowHtml()}
      <div class="settings-resident" id="settings-resident">${serviceRowHtml(state.service, state.serviceMsg)}</div>
      ${wizardRowHtml(typeof window.mebularDesktop?.openWizard === 'function')}
      <section class="settings-section" data-settings-common-status>
        <h3>本机状态 <span class="badge badge-muted">只读</span></h3>
        ${kvRows([
          kvRow('P2P', s.network.enabled ? '已启用' : '未启用'),
          kvRow('邀请服务', s.join?.enabled ? '已启用' : '未启用（点顶栏「邀请设备」就地启用）'),
          kvRow('安全等级', securityLevel ? securityLevelLabel(securityLevel) : '—'),
        ])}
        <p class="settings-note muted">可编辑配置在「高级」与「MCP 接入」；安全动作在「安全」。</p>
      </section>
      ${cloudCardHtml()}
    `)}
    ${panel('security', `<section id="settings-security-slot" class="settings-slot" data-settings-slot="security" data-security-level="${escapeHtml(state.security?.level ?? 'low')}" tabindex="-1">${securityCardHtml()}</section>`)}
    ${panel('assistants', `<div id="assistants-panel">${assistantsPanelHtml({ clients: state.clients, ui: { ...state, addForm: state.addForm ? assistantAddFormHtml(state.addForm) : '' } })}</div>`)}
    ${panel('mcp', `
      ${renderMcpSections()}
      <details class="settings-fold" id="mcp-danger-fold" data-settings-fold="mcp-danger">
        <summary>${escapeHtml(foldLabel('mcp-danger'))}</summary>
        ${IA_MCP_DANGER_LINES.map((line) => `<p class="muted">${escapeHtml(line)}</p>`).join('')}
      </details>
    `)}
    ${panel('advanced', `
      ${renderAdvancedSections()}
      <details class="settings-fold" id="diag-fold" data-settings-fold="diagnostics">
        <summary>${escapeHtml(foldLabel('diagnostics'))}</summary>
        ${renderDiagnostics()}
      </details>
    `)}
    </div>
  `;

  // 恢复折叠展开态（仅设置页的字段/卡片/机制折叠）
  body.querySelectorAll('details').forEach((el) => {
    const key = settingsFoldKey(el);
    if (key && openFolds.has(key)) el.open = true;
  });

  body.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => copyText(button.dataset.copy, button));
  });
  bindSecurityCard(body);
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
  const nextScroller = body.querySelector('.settings-scroll');
  if (nextScroller && prevScrollTop > 0) nextScroller.scrollTop = prevScrollTop;
}

// ---------- S3 · 安全三档（安全卡 / 三操作改道 / 批准侧 / 恢复码） ----------

const SECURITY_LEVEL_ORDER = { low: 0, medium: 1, high: 2 };
const SECURITY_REJECTION_LABEL = {
  'missing-proof': '缺少会签证明',
  'invalid-proof': '证明无效',
  'approval-missing-or-not-causal': '批准不存在或晚于动作',
  'approval-approver-revoked-at-its-order': '批准人当时已被移出',
  'approver-not-admitted-at-approval': '批准设备当时尚未准入',
  'approver-equals-author': '批准人 = 发起人',
  'approver-equals-subject': '批准人 = 被操作设备',
  'stale-or-replayed-nonce': '随机数已重放',
};

function securityLevelLabel(level) {
  return SECURITY_LEVEL_LABEL[level] ?? '—';
}

function securityLevelTag(level) {
  return level === 'high' ? 'crt-tag-ok' : level === 'medium' ? 'crt-tag-warn' : 'crt-tag';
}

function securityReasonLabel(reason) {
  return SECURITY_REJECTION_LABEL[reason] ?? String(reason ?? '未知原因');
}

function securityOpText(record) {
  if (record?.op === 'kick') return `移出设备 ${record.target ?? '—'}`;
  if (record?.op === 'restore') return `恢复设备 ${record.target ?? '—'}`;
  if (record?.op === 'join') return `加入忆云${record.namespace ? `（${record.namespace}）` : ''}`;
  if (record?.op === 'tier') return `安全等级 → ${securityLevelLabel(record.level)}`;
  return record?.op ?? '—';
}

function inviteNamespace() {
  const configured = state.settings?.sync?.subscriptions;
  return Array.isArray(configured) && configured.length > 0 ? configured[0] : 'tasks';
}

function securitySelfId() {
  return state.overview?.device?.deviceId ?? state.settings?.identity?.deviceId ?? null;
}

/** 安全 tab：等级 / 动态码种子 / 恢复码（三段式；风险短句内联，不藏折叠）。 */
function securityCardHtml() {
  const sec = state.security;
  if (!sec) {
    return settingsSectionHtml({
      id: 'security-level',
      title: IA_SECURITY_SECTIONS.level.title,
      desc: IA_SECURITY_SECTIONS.level.desc,
      body: '<p class="muted sec-loading">安全状态加载中…（旧版守护或读取失败时显示 —，不影响其他设置）</p>',
    });
  }
  const level = sec.level ?? 'low';
  const selfId = securitySelfId();
  const writes = Boolean(state.features?.writes) && !MOCK;
  const isRoot = state.settings?.identity?.mode === 'root';
  const pending = Array.isArray(sec.pendingApprovals) ? sec.pendingApprovals : [];
  const incoming = pending.filter((a) => a?.initiator !== selfId);
  const outgoing = pending.filter((a) => a?.initiator === selfId);
  const rejections = Array.isArray(sec.rejections) ? sec.rejections : [];
  const totp = sec.totp ?? { imported: false };
  const recovery = sec.recovery ?? { registered: false };
  const admitted = Array.isArray(sec.admitted) ? sec.admitted : [];
  const fps = [...new Set((state.policy ?? [])
    .filter((event) => event.type === 'security_totp' && typeof event.fingerprint === 'string')
    .map((event) => event.fingerprint))];
  const mismatch = totp.imported === true && fps.some((fp) => fp !== totp.fingerprint);

  const ladder = ['low', 'medium', 'high'].map((tier) => {
    const current = tier === level;
    const canUpgrade = SECURITY_LEVEL_ORDER[tier] > SECURITY_LEVEL_ORDER[level];
    const action = canUpgrade
      ? `<button class="btn btn-small btn-crt" type="button" data-security-action="upgrade" data-level="${tier}" ${writes ? '' : 'disabled'}>升级到${securityLevelLabel(tier)} ›</button>`
      : current ? `<span class="crt-tag ${securityLevelTag(level)}" data-security-current>当前</span>` : '';
    return `<li class="sec-tier${current ? ' is-current' : ''}" data-security-tier="${tier}">
      <div class="sec-tier-main">
        <div class="sec-tier-head"><span class="sec-tier-title">${escapeHtml(SECURITY_LEVEL_TITLE[tier])}</span></div>
        <p class="sec-tier-note muted">${escapeHtml(SECURITY_LEVEL_NOTE[tier])}</p>
      </div>
      <div class="sec-tier-action">${action}</div>
    </li>`;
  }).join('');

  const fingerprint = totp.fingerprint ?? null;
  const totpStatus = totp.imported === true
    ? `<span class="sec-ok">已导入 ✓</span> <code>${escapeHtml(fingerprint ?? '—')}</code>`
    : '<span class="crt-warn">未导入</span> <span class="muted">中档敏感操作会被拒绝</span>';
  const totpActions = `${totp.imported === true
    ? `<button class="btn btn-small btn-crt" type="button" data-security-action="totp-show" ${writes ? '' : 'disabled'}>显示种子</button>`
    : ''}
    <button class="btn btn-small btn-crt" type="button" data-security-action="totp-import" ${writes ? '' : 'disabled'}>导入种子</button>
    ${totp.imported !== true && isRoot
      ? `<button class="btn btn-small btn-crt" type="button" data-security-action="totp-generate" ${writes ? '' : 'disabled'}>生成共享种子</button>`
      : ''}`;

  const recoveryStatus = recovery.registered === true
    ? `<span class="sec-ok">已生成</span> <code>${escapeHtml(String(recovery.keyId ?? '').slice(0, 8))}</code>
       <span class="muted">${recovery.mode === 'rotate' ? '最近轮换' : '登记'} ${escapeHtml(formatTime(recovery.createdAt))}</span>
       ${recovery.lastUsedAt ? `<span class="muted">· 最近使用 ${escapeHtml(formatTime(recovery.lastUsedAt))}</span>` : ''}
       ${recovery.current === false ? '<span class="crt-tag crt-tag-warn">keyId 不一致</span>' : ''}`
    : '<span class="muted">未生成（升到高档时生成）</span>';
  const recoveryActions = recovery.registered === true
    ? `<button class="btn btn-small btn-crt" type="button" data-security-action="recovery-rotate" ${writes ? '' : 'disabled'}>轮换恢复码</button>`
    : level === 'high'
      ? `<button class="btn btn-small btn-crt" type="button" data-security-action="recovery-generate" ${writes ? '' : 'disabled'}>生成恢复码</button>`
      : '';

  const incomingRows = incoming.map((a) => `
    <li class="sec-approval-row" data-approval-id="${escapeHtml(a.approvalId)}">
      <div class="sec-approval-head">
        <b>${escapeHtml(securityOpText(a))}</b>
        <span class="muted">来自 ${escapeHtml(a.initiator ?? '—')}</span>
      </div>
      <div class="sec-approval-inline">
        <span class="sec-pairing" data-security-pairing aria-live="polite">${escapeHtml(a.pairingCode ?? '—')}</span>
        <span class="sec-approval-meta muted">与另一台设备逐位核对 · 有效至 ${escapeHtml(formatTime(a.expiresAt))}</span>
        <button class="btn btn-small btn-crt" type="button" data-security-approve="${escapeHtml(a.approvalId)}" ${writes ? '' : 'disabled'}>配对号一致，批准</button>
        <button class="btn btn-small btn-crt btn-crt-danger" type="button" data-security-deny="${escapeHtml(a.approvalId)}" ${writes ? '' : 'disabled'}>拒绝</button>
      </div>
    </li>`).join('');
  const outgoingRows = outgoing.length > 0
    ? `<p class="sec-outgoing muted">等待另一台设备批准：${outgoing.map((a) => `${escapeHtml(securityOpText(a))}（配对号 <span class="sec-pairing-inline">${escapeHtml(a.pairingCode ?? '—')}</span>）`).join('、')}</p>`
    : '';
  const pendingBlock = incoming.length > 0 || outgoing.length > 0
    ? `<div class="sec-pending sec-pending-top" data-security-pending>
        ${incoming.length > 0 ? `<div class="sec-pending-head"><b>待批准</b><span class="crt-tag crt-tag-warn">${incoming.length} 项</span></div>` : ''}
        ${incomingRows ? `<ul class="sec-approval-list">${incomingRows}</ul>` : ''}
        ${outgoingRows}
      </div>`
    : '';

  const rejectionReasons = [...new Set(rejections.map((r) => securityReasonLabel(r.reason)))];
  const rejectionBlock = rejections.length > 0
    ? `<p class="crt-warn sec-rejections" data-security-rejections>${rejections.length} 条安全操作被拒绝：${escapeHtml(rejectionReasons.slice(0, 3).join('、'))}${rejectionReasons.length > 3 ? ' 等' : ''}（详见审计）</p>`
    : '';

  const admittedLine = admitted.length > 0
    ? `<p class="settings-section-foot muted" data-security-admitted>可会签设备 ${admitted.length} 台：${escapeHtml(admitted.join(' · '))}。</p>`
    : '';

  const lowerTiers = ['low', 'medium', 'high'].filter((tier) => SECURITY_LEVEL_ORDER[tier] < SECURITY_LEVEL_ORDER[level]);
  const downgrade = lowerTiers.length > 0
    ? `<div class="sec-downgrade sec-downgrade-inline">
        <span class="sec-downgrade-label muted">降级</span>
        ${lowerTiers.map((tier) => `<button class="btn btn-small btn-crt btn-crt-danger" type="button" data-security-action="downgrade" data-level="${tier}" ${writes ? '' : 'disabled'}>降到${securityLevelLabel(tier)}</button>`).join('')}
        <span class="muted">${level === 'high' ? '需另一台设备会签或恢复码。' : '需本机 6 位动态码。'}</span>
      </div>`
    : '';

  const mismatchLine = mismatch
    ? '<p class="crt-warn sec-anomaly">请从持有同一颗种子的设备重新导入；不一致的种子会被拒绝。</p>'
    : '';

  return `
    ${settingsSectionHtml({
      id: 'security-level',
      title: IA_SECURITY_SECTIONS.level.title,
      desc: IA_SECURITY_SECTIONS.level.desc,
      body: `${pendingBlock}<ol class="sec-ladder" aria-label="安全等级三档">${ladder}</ol>
        ${admittedLine}
        <p class="settings-section-foot muted" data-security-boundary>${escapeHtml(SECURITY_BOUNDARY)}</p>
        ${downgrade}${rejectionBlock}`,
    })}
    ${settingsSectionHtml({
      id: 'security-totp',
      title: IA_SECURITY_SECTIONS.totp.title,
      desc: IA_SECURITY_SECTIONS.totp.desc,
      chip: mismatch ? '<span class="crt-tag crt-tag-error">种子不一致</span>' : '',
      body: `${mismatchLine}
        <dl class="settings-kv sec-kv">
          <dt>状态</dt><dd class="kv-value">${totpStatus}</dd><dd class="kv-action sec-actions">${totpActions}</dd>
        </dl>`,
      foot: SECURITY_TOTP_FOOT,
    })}
    ${settingsSectionHtml({
      id: 'security-recovery',
      title: IA_SECURITY_SECTIONS.recovery.title,
      desc: IA_SECURITY_SECTIONS.recovery.desc,
      body: `<dl class="settings-kv sec-kv">
          <dt>状态</dt><dd class="kv-value">${recoveryStatus}</dd><dd class="kv-action sec-actions">${recoveryActions}</dd>
        </dl>`,
    })}
  `;
}

/** 安全卡事件（settings 每次重建都重新绑定；全部委托在本节点内）。 */
function bindSecurityCard(root) {
  root.querySelectorAll('[data-security-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.securityAction;
      const level = button.dataset.level;
      if (action === 'upgrade') void securityStartLevelChange(level);
      else if (action === 'downgrade') void securityStartLevelChange(level);
      else if (action === 'totp-import') securityTotpImport();
      else if (action === 'totp-show') void securityTotpShow();
      else if (action === 'totp-generate') void securityTotpGenerate();
      else if (action === 'recovery-rotate') void securityRecoveryRotate();
      else if (action === 'recovery-generate') void securityRecoveryGenerate();
    });
  });
  root.querySelectorAll('[data-security-approve]').forEach((button) => {
    button.addEventListener('click', () => void securityApprove(button.dataset.securityApprove));
  });
  root.querySelectorAll('[data-security-deny]').forEach((button) => {
    button.addEventListener('click', () => void securityDeny(button.dataset.securityDeny));
  });
}

function securitySetError(message) {
  const el = $('#security-action-error');
  if (!el) return;
  el.hidden = !message;
  el.textContent = message ?? '';
}

function stopSecurityPoll() {
  if (state.securityFlow?.timer) clearTimeout(state.securityFlow.timer);
  if (state.securityFlow) state.securityFlow.timer = null;
}

function closeSecurityAction({ silent = false } = {}) {
  const opener = state.securityFlow?.opener ?? null;
  stopSecurityPoll();
  state.securityFlow = null;
  const modal = $('#security-action');
  if (modal) modal.hidden = true;
  const body = $('#security-action-body');
  if (body) body.innerHTML = '';
  securitySetError('');
  if (opener && typeof opener.focus === 'function' && !silent) {
    try { opener.focus(); } catch { /* 已卸载 */ }
  }
}

function securityModalConfig({ title, body, confirmLabel = '确认', onConfirm = null, hideClose = false, blockClose = false, recovery = null } = {}) {
  stopSecurityPoll();
  state.securityFlow = {
    ...(state.securityFlow ?? {}),
    opener: state.securityFlow?.opener ?? document.activeElement,
    onConfirm,
    blockClose,
    recovery,
    timer: null,
  };
  $('#security-action-title').textContent = title;
  $('#security-action-body').innerHTML = body;
  securitySetError('');
  const confirm = $('#security-action-confirm');
  confirm.hidden = typeof onConfirm !== 'function';
  confirm.disabled = false;
  confirm.textContent = confirmLabel;
  $('#security-action-close').hidden = hideClose;
  $('#security-action').hidden = false;
  return $('#security-action-body');
}

async function securityConfirmHandler() {
  const flow = state.securityFlow;
  if (!flow?.onConfirm) return;
  const confirm = $('#security-action-confirm');
  const label = confirm.textContent;
  confirm.disabled = true;
  confirm.textContent = '处理中…';
  securitySetError('');
  try {
    await flow.onConfirm();
  } catch (error) {
    securitySetError(error?.message ?? String(error));
  } finally {
    if (state.securityFlow) {
      confirm.disabled = false;
      confirm.textContent = label;
    }
  }
}

function securityCodeModal({ title, intro, confirmLabel = '验证', onSubmit }) {
  securityModalConfig({
    title,
    body: `<p class="muted">${escapeHtml(intro)}</p>
      <div class="field"><label for="security-code">6 位动态码</label>
      <input id="security-code" class="crt-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" aria-describedby="security-code-help" /></div>
      <p id="security-code-help" class="cfg-help muted">打开认证器 App 读取当前 6 位数字；同一码不能用两次。</p>`,
    confirmLabel,
    onConfirm: async () => {
      const code = $('#security-code')?.value?.trim() ?? '';
      if (!/^\d{6}$/.test(code)) {
        securitySetError('请输入 6 位动态码（只含数字）。');
        return;
      }
      await onSubmit(code);
    },
  });
  setTimeout(() => $('#security-code')?.focus(), 0);
}

async function securityPostTier(level, extra = {}) {
  const result = await api('/admin/api/security/tier', { method: 'POST', body: { level, ...extra } });
  await refresh();
  if (result?.recoveryCode) {
    securityShowRecoveryOnce(result.recoveryCodeFormatted ?? result.recoveryCode, {
      title: '升级到高 · 离线恢复码（只显示这一次）',
      intro: '已启用「高 · 设备会签」。恢复码是另一台设备不在场时的离线钥匙。',
    });
  } else {
    showToast(`安全等级已设为「${securityLevelLabel(level)}」`);
    closeSecurityAction();
  }
  return result;
}

async function securityStartLevelChange(targetLevel) {
  const current = state.security?.level ?? 'low';
  if (targetLevel === current) return;
  const targetLabel = securityLevelLabel(targetLevel);
  try {
    if (SECURITY_LEVEL_ORDER[targetLevel] > SECURITY_LEVEL_ORDER[current]) {
      if (current === 'medium') {
        securityCodeModal({
          title: `升级到${targetLabel}`,
          intro: '输入本机 6 位动态码。',
          confirmLabel: `升级到${targetLabel}`,
          onSubmit: async (code) => {
            closeSecurityAction();
            await securityPostTier(targetLevel, { code });
          },
        });
        return;
      }
      const ok = await confirmModal({
        title: `升级到${targetLabel}`,
        body: targetLevel === 'high'
          ? '之后加入、移出与降级都需要另一台已准入设备核对配对号；本机会生成一次性恢复码。'
          : '之后加入、移出与降级需要本机 6 位动态码；它挡顺手，不挡设备被拿走。',
        confirmLabel: `升级到${targetLabel}`,
      });
      if (!ok) return;
      await securityPostTier(targetLevel);
      return;
    }
    // 降级
    if (current === 'high') {
      await securityStartApproval({
        title: `降级到${targetLabel} · 设备会签`,
        op: 'tier',
        level: targetLevel,
        intro: '高档降级需要另一台已准入设备会签（或恢复码）。',
        onApproved: async (approvalId) => {
          const result = await api('/admin/api/security/tier', { method: 'POST', body: { level: targetLevel, approvalId } });
          closeSecurityAction();
          await refresh();
          showToast(`安全等级已设为「${targetLabel}」${result?.ok ? '' : ''}`);
        },
        recovery: () => securityTierViaRecovery(targetLevel),
      });
      return;
    }
    securityCodeModal({
      title: `降级到${targetLabel}`,
      intro: '中档降级需要本机 6 位动态码。',
      confirmLabel: `降到${targetLabel}`,
      onSubmit: async (code) => {
        closeSecurityAction();
        await securityPostTier(targetLevel, { code });
      },
    });
  } catch (error) {
    window.alert(`安全等级变更失败：${error.message}`);
  }
}

/** 发起会签请求 → 展示配对号 → 轮询批准/拒绝/过期 → 自动执行最终动作。 */
async function securityStartApproval({ title, op, target, level, intro, onApproved, recovery = null }) {
  const payload = {
    op,
    ...(op === 'kick' || op === 'restore' ? { target } : {}),
    ...(op === 'join' ? { namespace: inviteNamespace() } : {}),
    ...(op === 'tier' ? { level } : {}),
  };
  const request = await api('/admin/api/security/approvals', { method: 'POST', body: payload });
  const self = securitySelfId();
  const admitted = state.security?.admitted ?? [];
  securityModalConfig({
    title,
    hideClose: false,
    body: `<p class="muted">${escapeHtml(intro ?? '')}</p>
      <div class="sec-pairing sec-pairing-lg" data-security-pairing aria-live="polite">${escapeHtml(request.pairingCode ?? '—')}</div>
      <p class="cfg-help muted">在另一台已准入设备上打开「设置 → 安全 → 安全等级」，核对同一配对号后点「配对号一致，批准」。</p>
      ${kvRows([
        kvRow('动作', escapeHtml(securityOpText(request))),
        kvRow('发起设备', `<code>${escapeHtml(self ?? '—')}</code>`),
        kvRow('有效至', escapeHtml(formatTime(request.expiresAt))),
        kvRow('有资格的设备', admitted.length ? escapeHtml(admitted.join(' · ')) : '<span class="muted">（尚未取得 admitted 列表）</span>'),
      ])}
      <p class="sec-wait" id="security-wait-status" aria-live="polite"><span class="sec-wait-dot" aria-hidden="true"></span>等待另一台设备批准…</p>
      <p class="cfg-help muted">配对号不经过任何通道传输：两台设备各自从动作摘要算出，人眼比对即可。</p>
      ${typeof recovery === 'function'
        ? `<div class="domain-actions"><button class="btn btn-small btn-crt" type="button" data-security-recovery-switch>另一台设备不在？用恢复码执行</button></div>
           <p class="cfg-help muted">切到恢复码后，这次会签请求会留待过期；恢复码只在本次本机签名时使用。</p>`
        : ''}`,
    recovery,
  });
  const started = Date.now();
  const tick = async () => {
    if (state.securityFlow === null || $('#security-action')?.hidden !== false) return;
    try {
      const sec = await api('/admin/api/security', { timeoutMs: 8000 });
      const records = Array.isArray(sec?.recentApprovals) ? sec.recentApprovals : [];
      const decided = records.find((r) => r?.approvalId === request.approvalId && r?.decision !== 'request');
      if (decided?.decision === 'approve') {
        stopSecurityPoll();
        const status = $('#security-wait-status');
        if (status) status.innerHTML = '<span class="sec-ok">✓ 已批准，正在执行…</span>';
        try {
          await onApproved(request.approvalId, decided);
        } catch (error) {
          if (status) status.innerHTML = `<span class="crt-warn">已批准，但执行失败：${escapeHtml(error.message)}</span>`;
          securitySetError(`执行失败：${error.message}`);
        }
        return;
      }
      if (decided?.decision === 'deny') {
        stopSecurityPoll();
        const status = $('#security-wait-status');
        if (status) {
          status.innerHTML = '<span class="crt-warn">已被拒绝</span> <span class="muted">（发起设备可见；本版本拒绝记录不附文字理由）</span>';
          status.dataset.securityDenied = '1';
        }
        void refresh();
        return;
      }
      const expired = typeof request.expiresAt === 'number' && Date.now() > request.expiresAt;
      if (expired) {
        stopSecurityPoll();
        const status = $('#security-wait-status');
        if (status) status.innerHTML = '<span class="crt-warn">请求已过期</span> <span class="muted">请关闭后重新发起。</span>';
        return;
      }
      const status = $('#security-wait-status');
      if (status) {
        const left = Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000));
        status.innerHTML = `<span class="sec-wait-dot" aria-hidden="true"></span>等待另一台设备批准… <span class="muted">（剩余 ${left}s）</span>`;
      }
    } catch {
      // 轮询失败保持等待，下轮再试（不把瞬时网络错误当拒绝）
    }
    if (state.securityFlow?.timer !== null) {
      state.securityFlow.timer = setTimeout(tick, Math.max(500, 2500 - ((Date.now() - started) % 500)));
    }
  };
  state.securityFlow.timer = setTimeout(tick, 500);
}

async function securityApprove(approvalId) {
  const record = (state.security?.pendingApprovals ?? []).find((a) => a?.approvalId === approvalId);
  if (!record) return;
  const ok = await confirmModal({
    title: `批准：${securityOpText(record)}`,
    body: `发起设备：${record.initiator}\n配对号：${record.pairingCode}\n有效至：${formatTime(record.expiresAt)}\n\n请在另一台设备屏幕上核对配对号，完全一致再批准。`,
    confirmLabel: '配对号一致，批准',
  });
  if (!ok) return;
  try {
    await api(`/admin/api/security/approvals/${encodeURIComponent(approvalId)}/approve`, { method: 'POST', body: {} });
    await refresh();
    showToast('已批准；发起设备会自动继续');
  } catch (error) {
    window.alert(`批准失败：${error.message}`);
  }
}

async function securityDeny(approvalId) {
  const record = (state.security?.pendingApprovals ?? []).find((a) => a?.approvalId === approvalId);
  if (!record) return;
  const ok = await confirmModal({
    title: '拒绝这次请求？',
    body: `动作：${securityOpText(record)}\n发起设备：${record.initiator}\n\n发起设备会看到「已被拒绝」。本版本拒绝记录不附文字理由。`,
    confirmLabel: '拒绝',
  });
  if (!ok) return;
  try {
    await api(`/admin/api/security/approvals/${encodeURIComponent(approvalId)}/deny`, { method: 'POST', body: {} });
    await refresh();
    showToast('已拒绝该请求');
  } catch (error) {
    window.alert(`拒绝失败：${error.message}`);
  }
}

function securityTotpImport() {
  securityModalConfig({
    title: '导入动态码种子',
    body: `<p class="muted">从持有种子的另一台设备「显示种子」处，粘贴分组文本或 <code>otpauth://</code> URI。种子绝不经过忆云。</p>
      <div class="field"><label for="security-totp-secret">种子（分组文本 / otpauth URI）</label>
      <textarea id="security-totp-secret" class="crt-input" rows="3" spellcheck="false" placeholder="ABCD EFGH IJKL … 或 otpauth://totp/…"></textarea></div>
      <div class="field"><label for="security-totp-fingerprint">期望 fingerprint（可选，8 hex）</label>
      <input id="security-totp-fingerprint" class="crt-input" type="text" maxlength="16" placeholder="a1b2c3d4" /></div>
      <p class="cfg-help muted">导入前请与另一台设备上的 fingerprint 对账；不一致会拒绝导入。</p>`,
    confirmLabel: '导入',
    onConfirm: async () => {
      const secret = $('#security-totp-secret')?.value?.trim() ?? '';
      if (!secret) {
        securitySetError('请粘贴种子文本或 otpauth URI。');
        return;
      }
      const expectedFingerprint = $('#security-totp-fingerprint')?.value?.trim() ?? '';
      const result = await api('/admin/api/security/totp/import', {
        method: 'POST',
        body: { secret, ...(expectedFingerprint ? { expectedFingerprint } : {}) },
      });
      await refresh();
      closeSecurityAction();
      showToast(`动态码种子已导入（fingerprint ${result.fingerprint}）`);
    },
  });
  setTimeout(() => $('#security-totp-secret')?.focus(), 0);
}

function securitySeedDisplay(seed, { generated = false } = {}) {
  const groupText = Array.isArray(seed.groups)
    ? seed.groups.join(' ')
    : String(seed.groups ?? seed.secret ?? '');
  const qr = typeof seed.qrSvg === 'string' && seed.qrSvg.length > 0
    ? `<div class="readout-block qr-block"><span class="domain-label">扫码导入（内容 = otpauth URI）</span>
       <img class="qr-img" alt="动态码种子二维码" src="data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(seed.qrSvg)))}" /></div>`
    : '<p class="cfg-help muted">二维码不可用（生成失败）：请使用下方分组文本。</p>';
  securityModalConfig({
    title: generated ? '共享动态码种子（只显示这一次）' : '动态码种子',
    hideClose: false,
    body: `<div id="totp-seed-display" class="sec-seed" tabindex="-1">
        <p class="crt-warn">${escapeHtml(seed.warning ?? '种子等于这一档的钥匙：谁看到它，谁就能过这档的码。只在两台你自己的设备之间当面出示。')}</p>
        ${qr}
        <div class="readout-block"><span class="domain-label">分组文本</span><code class="sec-seed-groups">${escapeHtml(groupText)}</code></div>
        <div class="readout-block"><span class="domain-label">otpauth URI</span><code class="sec-seed-uri">${escapeHtml(seed.otpauth ?? '')}</code></div>
        <p class="muted">fingerprint：<code>${escapeHtml(seed.fingerprint ?? '—')}</code>（可与另一台设备对账；不含种子本身）</p>
        <p class="cfg-help muted">不要截图、不要发聊天工具；当面出示后即可关闭。</p>
      </div>`,
  });
  setTimeout(() => { $('#totp-seed-display')?.focus(); }, 0);
}

async function securityTotpShow() {
  securityCodeModal({
    title: '显示动态码种子',
    intro: '显示种子前先输入一次本机动态码（防顺手窥屏）。',
    confirmLabel: '验证并显示',
    onSubmit: async (code) => {
      const seed = await api('/admin/api/security/totp/show', { method: 'POST', body: { code } });
      securitySeedDisplay(seed);
    },
  });
}

async function securityTotpGenerate() {
  const ok = await confirmModal({
    title: '生成共享动态码种子？',
    body: '仅 root 可生成。新种子会写在本机，并需要你在其他设备上「导入种子」后，中档门槛才在各设备一致生效。',
    confirmLabel: '生成',
  });
  if (!ok) return;
  try {
    const seed = await api('/admin/api/security/totp/show', { method: 'POST', body: { generate: true } });
    await refresh();
    securitySeedDisplay(seed, { generated: true });
  } catch (error) {
    window.alert(`生成失败：${error.message}`);
  }
}

function securityShowRecoveryOnce(codeFormatted, { title, intro = '' } = {}) {
  securityModalConfig({
    title,
    hideClose: true,
    blockClose: true,
    body: `<p class="muted">${escapeHtml(intro)}</p>
      <div id="security-recovery-once" class="sec-once-code" data-security-once tabindex="-1" aria-live="polite">${escapeHtml(codeFormatted)}</div>
      <p class="crt-warn">恢复码只在屏幕上出现这一次：请抄写到离线介质（纸/金属/密码器），与主密钥备份分开存放。不要截图、不要发聊天工具。丢失只能轮换。</p>
      <p class="muted">抄写完成后点下方按钮继续；页面销毁后无法再次显示。</p>
      <div class="domain-actions"><button class="btn btn-crt" type="button" data-security-ack>我已抄写，继续</button></div>`,
  });
  setTimeout(() => {
    const once = $('#security-recovery-once');
    if (once) once.focus();
  }, 0);
}

async function securityRecoveryRotate() {
  securityModalConfig({
    title: '轮换恢复码',
    body: `<p class="muted">用当前恢复码签名换一张新码。旧码的新签名立即失效（已采纳的历史不回撤）。</p>
      <div class="field"><label for="security-recovery-old">当前恢复码</label>
      <input id="security-recovery-old" class="crt-input" type="text" autocomplete="off" spellcheck="false" placeholder="XXXX XXXX …" /></div>
      <p class="cfg-help muted">新码只显示一次；请准备好离线介质。</p>`,
    confirmLabel: '轮换',
    onConfirm: async () => {
      const oldCode = $('#security-recovery-old')?.value?.trim() ?? '';
      if (!oldCode) {
        securitySetError('请输入当前恢复码。');
        return;
      }
      const result = await api('/admin/api/security/recovery/rotate', { method: 'POST', body: { oldCode } });
      await refresh();
      securityShowRecoveryOnce(result.codeFormatted ?? result.code, {
        title: '新恢复码（只显示这一次）',
        intro: `旧 keyId ${String(result.oldKeyId ?? '').slice(0, 8)} 已轮换；旧码的新签名不再被采纳。`,
      });
    },
  });
  setTimeout(() => $('#security-recovery-old')?.focus(), 0);
}

async function securityRecoveryGenerate() {
  const ok = await confirmModal({
    title: '生成恢复码？',
    body: '恢复码用于高档下「另一台设备不在场」时替代会签。只在屏幕上出现一次；请准备离线介质抄写。',
    confirmLabel: '生成',
  });
  if (!ok) return;
  try {
    const result = await api('/admin/api/security/recovery/generate', { method: 'POST', body: {} });
    await refresh();
    securityShowRecoveryOnce(result.codeFormatted ?? result.code, { title: '离线恢复码（只显示这一次）' });
  } catch (error) {
    window.alert(`生成失败：${error.message}`);
  }
}

const SECURITY_RECOVERY_ERROR_TEXT = {
  recovery_mismatch: '恢复码不匹配当前 keyId（可能已被轮换）：请使用最新恢复码。',
  recovery_missing: '尚未生成恢复码：请先在安全卡生成/轮换恢复码。',
  recovery_invalid: '恢复码格式不正确：请完整输入 34 位（连字符可省略）。',
  recovery_not_applicable: '当前不是高档：恢复码只用于替代高档会签，无需输入。',
  recovery_sign_failed: '恢复码签名校验失败：请重试；若持续失败请轮换恢复码。',
};

function securityRecoveryErrorText(error) {
  return SECURITY_RECOVERY_ERROR_TEXT[error?.payload?.error] ?? error?.message ?? '恢复码执行失败';
}

/** 恢复码输入（高档「另一台设备不在」路径）：只用于本次签名，不回显、不进 localStorage。 */
function securityRecoveryCodeModal({ title, intro, confirmLabel = '用恢复码执行', onSubmit }) {
  securityModalConfig({
    title,
    body: `<p class="muted">${escapeHtml(intro)}</p>
      <div class="field"><label for="security-recovery-code">恢复码</label>
      <input id="security-recovery-code" class="crt-input" type="password" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-…" aria-describedby="security-recovery-help" /></div>
      <p id="security-recovery-help" class="cfg-help muted">离线保存的 34 位码；只在本机用于签名，不上传、不写入浏览器存储，提交后输入框即清空。</p>`,
    confirmLabel,
    onConfirm: async () => {
      const input = $('#security-recovery-code');
      const code = input?.value?.trim() ?? '';
      if (!code) {
        securitySetError('请输入离线恢复码。');
        return;
      }
      if (input) input.value = '';
      try {
        await onSubmit(code);
      } catch (error) {
        error.message = securityRecoveryErrorText(error);
        throw error;
      }
    },
  });
  setTimeout(() => $('#security-recovery-code')?.focus(), 0);
}

async function securityRevokeViaRecovery(device) {
  securityRecoveryCodeModal({
    title: `移出设备 · 恢复码`,
    intro: '当前为高 · 设备会签。用离线恢复码在本机签名后立即写入移出记录；恢复码不经过忆云。',
    onSubmit: async (code) => {
      await api(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/revoke`, {
        method: 'POST',
        body: { recoveryCode: code },
      });
      closeSecurityAction();
      await refresh();
      showToast('已在本地移出该设备（恢复码）');
    },
  });
}

async function securityTierViaRecovery(targetLevel) {
  const targetLabel = securityLevelLabel(targetLevel);
  securityRecoveryCodeModal({
    title: `降级到${targetLabel} · 恢复码`,
    intro: '当前为高 · 设备会签。用离线恢复码签署本次降档；恢复码不经过忆云。',
    onSubmit: async (code) => {
      await api('/admin/api/security/tier', { method: 'POST', body: { level: targetLevel, recoveryCode: code } });
      closeSecurityAction();
      await refresh();
      showToast(`安全等级已设为「${targetLabel}」（恢复码）`);
    },
  });
}

/** 移出改道（SPEC §5.2）：low 直接确认；medium 要码；high 会签或恢复码。 */
async function securityRevokeFlow(device) {
  const level = state.security?.level ?? 'low';
  const ok = await confirmModal({
    title: '移出设备',
    body: `${device.deviceId} 署名的政策记录将不再被本机采纳，本机也不再向它发送数据；已同步的数据不回收；可由其他设备恢复。\n\n`
      + (level === 'high'
        ? '当前为高 · 设备会签：需要另一台已准入设备核对配对号并批准，批准后本机自动完成移出。'
        : level === 'medium'
          ? '当前为中 · 动态码：下一步需要输入本机 6 位动态码。'
          : '当前为低（默认）：无额外门槛。'),
    confirmLabel: '移出设备',
  });
  if (!ok) return;
  if (level === 'high') {
    try {
      await securityStartApproval({
        title: `移出设备 · 设备会签`,
        op: 'kick',
        target: device.deviceId,
        intro: `${device.deviceId} 署名的政策记录将不再被本机采纳；会签批准后自动执行。`,
        onApproved: async (approvalId) => {
          await api(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/revoke`, { method: 'POST', body: { approvalId } });
          closeSecurityAction();
          await refresh();
          showToast(`已在本地移出该设备（会签）`);
        },
        recovery: () => securityRevokeViaRecovery(device),
      });
    } catch (error) {
      window.alert(`发起会签失败：${error.message}`);
    }
    return;
  }
  if (level === 'medium') {
    securityCodeModal({
      title: `移出设备 · 动态码`,
      intro: '输入本机 6 位动态码后写入移出记录。',
      confirmLabel: '移出设备',
      onSubmit: async (code) => {
        await api(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/revoke`, { method: 'POST', body: { code } });
        closeSecurityAction();
        await refresh();
        showToast('已在本地移出该设备');
      },
    });
    return;
  }
  await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/revoke`, {}, '已在本地移出该设备');
}

/** 恢复改道：low 直接确认；medium 要码；high 会签或恢复码。 */
async function securityRestoreFlow(device) {
  const level = state.security?.level ?? 'low';
  const ok = await confirmModal({
    title: '恢复设备',
    body: `${device.deviceId} 将重新被本机接受。恢复建立新的纪元：该设备在恢复前署名的订阅/移出等策略记录不复活，需要它重新声明订阅。\n\n`
      + (level === 'high'
        ? '当前为高 · 设备会签：需要另一台已准入设备核对配对号并批准，批准后本机自动完成恢复。'
        : level === 'medium'
          ? '当前为中 · 动态码：下一步需要输入本机 6 位动态码。'
          : '当前为低（默认）：无额外门槛。'),
    confirmLabel: '恢复设备',
  });
  if (!ok) return;
  if (level === 'high') {
    await securityStartApproval({
      title: '恢复设备 · 设备会签',
      op: 'restore',
      target: device.deviceId,
      intro: `${device.deviceId} 将被恢复；旧纪元策略记录不复活。`,
      onApproved: async (approvalId) => {
        await api(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/restore`, { method: 'POST', body: { approvalId } });
        closeSecurityAction();
        await refresh();
        showToast('已恢复该设备（会签）');
      },
      recovery: async () => {
        securityRecoveryCodeModal({
          title: '恢复设备 · 恢复码',
          intro: '用离线恢复码在本机签名后立即写入恢复记录；恢复码不经过忆云。',
          onSubmit: async (code) => {
            await api(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/restore`, {
              method: 'POST',
              body: { recoveryCode: code },
            });
            closeSecurityAction();
            await refresh();
            showToast('已恢复该设备（恢复码）');
          },
        });
      },
    });
    return;
  }
  if (level === 'medium') {
    securityCodeModal({
      title: '恢复设备 · 动态码',
      intro: '输入本机 6 位动态码后写入恢复记录。',
      confirmLabel: '恢复设备',
      onSubmit: async (code) => {
        await api(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/restore`, { method: 'POST', body: { code } });
        closeSecurityAction();
        await refresh();
        showToast('已恢复该设备');
      },
    });
    return;
  }
  await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/restore`, {}, '已恢复该设备');
}

function diagBlock(id, title, body, { chip = '' } = {}) {
  return `<section class="settings-diag-block" data-info-block="${escapeHtml(id)}">
    <h4>${escapeHtml(title)}${chip}</h4>
    ${body}
  </section>`;
}

function renderDiagnostics() {
  const s = state.settings;
  const configPath = state.rawConfig?.path ?? 'config.json';
  const health = state.healthz ?? null;
  const apply = state.settings?.lastApply;
  const applyBody = (() => {
    if (!apply) return '<p class="muted">本次进程内尚无「保存即生效」记录。</p>';
    const statusText = {
      applied: '已生效', 'in-progress': '重启中', mismatch: '未按预期生效',
      'rolled-back': '新配置未生效：已回滚', 'rollback-failed': '回滚失败（需手动恢复）', failed: '应用失败',
    }[apply.status] ?? String(apply.status);
    const verify = Array.isArray(apply.verify) ? apply.verify : [];
    return kvRows([
      kvRow('状态', escapeHtml(statusText)),
      kvRow('时间', escapeHtml(String(apply.at ?? '—'))),
      kvRow('字段', escapeHtml((apply.fields ?? []).join(', ') || '—')),
      ...(apply.reason ? [kvRow('原因', escapeHtml(String(apply.reason)))] : []),
      ...(apply.backup ? [copyRowOf('备份', String(apply.backup))] : []),
      ...(verify.length ? [kvRow('逐项校验', verify.map((row) => `${escapeHtml(row.path)}：${row.ok === true ? '✓' : row.ok === false ? '✗' : '—'}`).join(' · '))] : []),
    ]);
  })();

  return `
    ${diagBlock('version', '版本与服务状态', kvRows([
      kvRow('serve', health ? escapeHtml(`${health.name ?? 'mebular'} @ ${health.version ?? '—'}`) : '（未取到 /healthz）'),
      kvRow('服务状态', health?.status ? escapeHtml(String(health.status)) : '—'),
      kvRow('MCP 监听', `${escapeHtml(s.mcp.host)}:${escapeHtml(String(s.mcp.port))} · auth=${escapeHtml(s.mcp.auth)}`),
      kvRow('TLS', s.mcp.tls ? '已启用' : '未启用（明文 HTTP）'),
      kvRow('控制台写入', state.features.writes ? '可写（需 memory.admin + CSRF）' : '只读（D1 / MEBULAR_CONSOLE_WRITES=0）'),
      kvRow('P2P', s.network.enabled ? '已启用' : '未启用'),
      kvRow('状态指纹', (state.namespaces ?? []).filter((n) => n.stateHash).length
        ? escapeHtml((state.namespaces ?? []).filter((n) => n.stateHash).map((n) => `${n.namespace} ${String(n.stateHash).slice(0, 10)}`).join(' · '))
        : '—'),
    ]), { chip: '<span class="badge badge-muted">只读</span>' })}

    ${diagBlock('rawConfig', '完整配置', `
      <p class="muted cfg-diag-path">${escapeHtml(configPath)}${state.rawConfig?.parseError ? `（解析失败：${escapeHtml(state.rawConfig.parseError)}）` : ''}</p>
      <div class="cfg-raw-block"><pre class="snippet">${escapeHtml(JSON.stringify(currentConfigFile(), null, 2))}</pre></div>
      <div class="domain-actions">
        <button id="cfg-copy-all" class="btn btn-small btn-crt" type="button">复制完整配置</button>
        <button id="cfg-download" class="btn btn-small btn-crt" type="button">下载 config.json</button>
      </div>`, { chip: '<span class="badge badge-muted">只读</span>' })}

    ${diagBlock('lastApply', '最近一次应用结果', applyBody, { chip: '<span class="badge badge-muted">只读</span>' })}

    ${diagBlock('connectionRepair', '手动连接', `
      <p class="muted">同忆云设备一直未连接时，粘贴对方 multiaddr 建立传输；不改变入网信任与订阅。</p>
      <div class="domain-actions"><button id="diag-open-wizard" class="btn btn-small btn-crt" type="button" ${state.features.writes && !MOCK ? '' : 'disabled'}>手动连接已知设备…</button></div>`)}

    ${diagBlock('recovery', '恢复指引', kvRows([
      kvRow('auth 误切', '<b>bearer</b>：粘贴 <code>mebular token grant --scope memory.read,memory.admin</code> 的 token 自救；<b>oauth</b>：静态 token 401 invalid token、<code>/register</code> 默认 404（缺 <code>MEBULAR_OAUTH_ADMIN_SECRET</code> / <code>MEBULAR_OAUTH_REGISTER_SECRET</code>）——编辑 <code>config.json</code> 把 <code>mcp.http.auth</code> 改回 <code>none</code>（仅回环），重启 <code>mebular serve</code>。'),
      kvRow('host 误设', '非回环必须 <code>auth≠none</code> + TLS + 证书，否则 serve 拒绝启动；改回 <code>127.0.0.1</code>，或补齐三件套后重启。'),
      kvRow('缺证书', '<code>tls=true</code> 但缺 <code>tlsKey</code>/<code>tlsCert</code> → 启动报 <code>MCP_INSECURE_CONFIG</code>（不静默降级）：补路径或关闭 tls。'),
      kvRow('控制台打不开', '看 <code>mebular status</code> 与 serve 日志：<code>MCP_STORAGE_LOCKED</code> = 已有实例持锁；<code>MCP_INSECURE_CONFIG</code> = host/auth/tls 组合非法。'),
    ]), { chip: '<span class="crt-tag">手改 config.json 后重启</span>' })}
  `;
}

let lastAboutSignature = null;

/** 本机设备名编辑（关于本机 → 身份与存储）。 */
function startDeviceRename() {
  state.deviceRename = { name: state.settings?.identity?.name ?? '' };
  state.deviceRenameError = '';
  renderAbout();
  setTimeout(() => {
    const input = document.querySelector('[data-device-rename-input]');
    if (!input) return;
    input.focus?.();
    input.select?.();
  }, 0);
}

async function saveDeviceRename() {
  if (!state.deviceRename) return;
  const name = String(state.deviceRename.name ?? '').trim();
  if (name.length === 0) {
    state.deviceRenameError = '设备名不能为空。';
    renderAbout();
    return;
  }
  state.deviceRenameError = '';
  renderAbout();
  try {
    await api('/admin/api/devices/self/name', { method: 'POST', body: { name } });
    state.deviceRename = null;
    await refresh();
    renderAbout();
    showToast(`设备名已改为「${name}」；会同步到同一忆云的其他设备。`);
  } catch (error) {
    state.deviceRenameError = error?.payload?.message ?? error?.message ?? String(error);
    renderAbout();
  }
}

function renderAbout() {
  const body = $('#about-body');
  if (state.locked) {
    lastAboutSignature = null;
    const status = state.provision ?? {};
    body.innerHTML = `
      <section class="settings-section" data-info-block="locked">
        <h3>本机尚未初始化 <span class="badge badge-muted">锁定</span></h3>
        <p class="muted" style="font-size:12px;line-height:1.7;margin:0 0 8px">新建或加入忆云后，这里会显示身份、存储与运行状态；当前不展示任何猜测数据。</p>
        ${kvRows([
          kvRow('阶段', escapeHtml(String(status.phase ?? 'UNINITIALIZED'))),
          kvRow('家目录', `<code>${escapeHtml(String(status.home ?? '—'))}</code>`),
          kvRow('默认设备名', escapeHtml(String(status.defaultDeviceName ?? status.hostname ?? '—'))),
        ])}
      </section>
    `;
    return;
  }
  // 同一类轮询重建保护：内容未变则跳过，避免滚动位置/文本选择被冲掉
  const signature = JSON.stringify([
    getLocale(),
    state.settings ?? null,
    state.rawConfig ?? null,
    state.healthz ?? null,
    state.features?.writes ?? null,
    state.overview?.device?.deviceId ?? null,
    state.overview?.device?.name ?? null,
    state.service?.unitPath ?? null,
    state.overview?.convergence ?? null,
    (state.devices ?? []).map((d) => [d.deviceId, d.name ?? null, d.convergence ?? null]),
    state.deviceRename ? 'editing' : null,
    state.deviceRenameError,
  ]);
  if (signature === lastAboutSignature && body.childElementCount > 0) return;
  lastAboutSignature = signature;
  const s = state.settings;
  if (!s) {
    body.innerHTML = '<p class="muted">关于本机加载中…（若持续如此，检查 serve 是否运行）</p>';
    return;
  }
  rebuildConfigFields();
  const configPath = state.rawConfig?.path ?? 'config.json';
  const listenAlarm = (s.network.listen ?? []).filter((addr) => {
    const m = addr.match(/\/(ip4|ip6|dns4|dns6|dns)\/([^/]+)/);
    if (!m) return false;
    return !['127.0.0.1', '::1', 'localhost'].includes(m[2]);
  });
  const addrRows = s.identity.multiaddrs.length
    ? s.identity.multiaddrs.map((a) => copyRowOf('multiaddr', a))
    : [emptyRowOf('multiaddr', '（未启用 P2P，无监听地址）')];
  const writes = state.features.writes && !MOCK;
  const renamingDevice = state.deviceRename !== null;
  const deviceName = s.identity.name ?? '';
  const deviceNameRow = renamingDevice
    ? kvRow('设备名', `<span class="device-rename-inline">
        <input class="crt-input device-rename-input" data-device-rename-input type="text" maxlength="24"
          value="${escapeHtml(state.deviceRename?.name ?? deviceName)}" aria-label="设备名" />
        <button class="btn btn-small btn-crt" data-device-rename-save type="button" ${writes ? '' : 'disabled'}>保存</button>
        <button class="btn btn-small" data-device-rename-cancel type="button">取消</button>
      </span>${state.deviceRenameError ? `<span class="crt-warn device-rename-error" role="alert">${escapeHtml(state.deviceRenameError)}</span>` : ''}`)
    : kvRow('设备名', `${deviceName
      ? `<span class="device-name-value">${escapeHtml(deviceName)}</span>`
      : '<span class="kv-empty">未设置（列表按 deviceId 显示）</span>'}
      <button class="btn btn-small btn-crt" data-device-rename type="button" ${writes ? '' : 'disabled'}>改名</button>
      <span class="cfg-help muted">只有本人可改；会同步到同一忆云的其他设备，不重签证书。</span>`);
  body.innerHTML = `
    <section class="settings-section" data-info-block="identity">
      <h3>身份与存储 <span class="badge badge-muted">身份只读 · 设备名可改</span></h3>
      ${kvRows([
        copyRowOf('deviceId', s.identity.deviceId),
        deviceNameRow,
        kvRow('身份模式', s.identity.mode === 'delegated'
          ? 'delegated（委派证书链，无主私钥）'
          : 'root（持有用户主密钥，可为任意设备颁发证书）'),
        ...(s.identity.peerId ? [copyRowOf('peerId', s.identity.peerId)] : []),
        ...addrRows,
        copyRowOf('storagePath', s.storage.path ?? '—'),
        copyRowOf('配置文件', configPath),
        kvRow('写盘备份', `<code>${escapeHtml(configPath)}.bak</code><span class="muted">（每次写入前自动保留）</span>`),
        kvRow('storageAdapter', escapeHtml(s.storage.adapter)),
        kvRow('加密级别', `${escapeHtml(s.encryption.level)}${s.encryption.atRest ? '（静态加密生效）' : ''}`),
      ])}
    </section>

    ${convergenceAboutSection()}

    <details class="settings-fold fold-about-runtime" id="about-runtime-fold" data-settings-fold="about-runtime">
      <summary>${escapeHtml(foldLabel('about-runtime'))}</summary>
      <div class="settings-fold-body">
    <section class="settings-section" data-info-block="syncRate">
      <h3>同步节奏 <span class="badge badge-muted">只读 · 默认常开，不建议关闭</span></h3>
      ${kvRows(statusRows().filter((row) => row.path === 'sync.autoSync' || row.path === 'sync.pushOnWrite').map((row) => kvRow(
        row.label ?? row.path,
        valueWithEffective(escapeHtml(formatRuntimeValue(row.actual)), {
          configured: row.configured,
          effective: row.actual,
          reason: row.reason,
        }),
      )))}
      <p class="muted" style="font-size:11px">默认常开，不建议关闭；如需改动请手工编辑 config.json 的 <code>sync.autoSync</code> / <code>sync.pushOnWrite</code>。</p>
    </section>

    <section class="settings-section" data-info-block="statusOnly">
      <h3>只读状态（自动推导） <span class="badge badge-muted">只读</span></h3>
      <p class="muted" style="font-size:11px;margin:0 0 8px">这些项由运行时自动决定（relay 池 / LAN 发现 / 桥 / 打洞 / 广播 / join / TLS）：控制台只展示真值与原因，不提供编辑。</p>
      ${kvRows(statusRows().filter((row) => row.path !== 'sync.autoSync' && row.path !== 'sync.pushOnWrite').map((row) => kvRow(
        row.label ?? row.path,
        `${escapeHtml(formatRuntimeValue(row.actual))}${row.reason && row.reason !== '已生效' ? `<span class="cfg-reason"><span class="cfg-eff-key">未生效原因</span> ${escapeHtml(row.reason)}</span>` : ''}`,
      )))}
    </section>

    <section class="settings-section" data-info-block="runtime">
      <h3>运行状态 <span class="badge badge-muted">只读</span>${pendingRestartBadge()}${listenAlarm.length ? '<span class="crt-tag crt-tag-warn">公网监听</span>' : ''}</h3>
      ${kvRows([
        ...(pendingRestartItems().length > 0
          ? [kvRow('待重启', `${pendingRestartItems().length} 项配置改动已保存但未生效（当前实例按上次启动配置工作，重启后生效）`)]
          : []),
        kvRow('P2P', s.network.enabled ? '已启用' : '未启用'),
        kvRow('实际监听', escapeHtml(s.network.listen.join(', ') || '—')),
        kvRow('MCP 监听', `${escapeHtml(s.mcp.host)}:${escapeHtml(String(s.mcp.port))} · auth=${escapeHtml(s.mcp.auth)}`),
        // R-1 中-5：常驻 plist 全路径从连接页卡片收编到这里
        ...(state.service?.unitPath ? [kvRow('常驻服务文件', `<code>${escapeHtml(state.service.unitPath)}</code>`)] : []),
        kvRow('TLS', s.mcp.tls ? `已启用（key=${s.mcp.tlsKeyConfigured ? '有' : '缺'} / cert=${s.mcp.tlsCertConfigured ? '有' : '缺'}）` : '未启用（明文 HTTP）'),
        kvRow('加入服务', s.join?.enabled ? `已启用 · ${escapeHtml(String(s.join.bind))}:${escapeHtml(String(s.join.port))}` : '未启用'),
        kvRow('语义召回', `${s.semantic.enabled ? '已启用' : '未启用'}（minScore ${s.semantic.minScore}）`),
        // C6：内建 relay 角色（只读；桥的选举自动完成，此处仅展示）
        kvRow('本机当桥', s.relay ? `${s.relay.serving ? '开' : '关'}（${escapeHtml(String(s.relay.reason ?? '—'))}）` : '—'),
        kvRow('当前经桥', s.relay?.bridge
          ? `<code>${escapeHtml(String(s.relay.bridge.address))}</code> <span class="muted">· ${escapeHtml(String(s.relay.bridge.peer))}</span>`
          : '未经桥（直连 / LAN）'),
        kvRow('桥白名单', s.relay ? `${s.relay.allowedClients ?? 0} 个已配对对端` : '—'),
        // C5：地址自动广播（只读；提示类信息，不影响订阅）
        kvRow('地址广播', s.net
          ? `${s.net.enabled ? `${escapeHtml(String(s.net.mode))} 档` : '未开启（opt-in：把 __net__ 加入 sync.namespaces 或配置 network.broadcast）'} · 已发布 ${s.net.published} · 已采用 ${s.net.applied}`
          : '—'),
        // C4：NAT 穿透（只读）
        kvRow('NAT 打洞', s.nat
          ? `${s.nat.dcutrEnabled ? 'DCUtR 开' : 'DCUtR 关'} · ${s.nat.autonatEnabled ? 'AutoNAT 开' : 'AutoNAT 关'} · 直连升级 ${s.nat.directUpgrades ?? 0} 次${s.nat.loadError ? ` ⚠ ${escapeHtml(String(s.nat.loadError))}` : ''}`
          : '未启用（libp2p 未装配）'),
        kvRow('广播忽略', s.net && Object.values(s.net.ignored ?? {}).some((v) => v > 0)
          ? escapeHtml(Object.entries(s.net.ignored).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(' / '))
          : '无'),
      ])}
      ${listenAlarm.length ? `<p class="crt-warn">⚠ 监听地址含非回环（${escapeHtml(listenAlarm.join(', '))}）：建议改绑回环 / LAN，或经 relay 并仅以防火墙放行已入网设备。</p>` : ''}
    </section>

    <section class="settings-section" data-info-block="paths">
      <h3>对端连接路径 <span class="badge badge-muted">只读 · core 地址簿</span></h3>
      ${(() => {
        const peers = s.peers ?? { enabled: false, paths: [] };
        if (!peers.enabled) return '<p class="muted" style="font-size:11px">地址簿未启用（network.autoConnect=false 或 network.enabled=false）。</p>';
        if (peers.paths.length === 0) return '<p class="muted" style="font-size:11px">地址簿暂无记录：等待配对 hints（邀请令牌）或对端首次连通。</p>';
        return `<ul class="path-list">${peers.paths.map((p) => `<li class="path-row">
          <span class="path-key"><code>${escapeHtml(p.key)}</code></span>
          <span class="path-value">${p.connected
            ? `<span class="path-kind path-kind-${escapeHtml(String(p.kind ?? 'unknown'))}">${escapeHtml(String(p.kind ?? '未知'))}</span> <code>${escapeHtml(String(p.address ?? '—'))}</code> <span class="muted">${p.since ? `最近切换 ${formatTime(p.since)}` : ''}</span>`
            : `<span class="muted">未连接</span>${p.lastError ? ` <span class="crt-warn">⚠ ${escapeHtml(String(p.lastError))}</span>` : ''}`} <span class="muted">· 候选 ${p.candidates}</span></span>
        </li>`).join('')}</ul>`;
      })()}
      <p class="muted" style="font-size:11px">路径由 core 候选地址簿维护（direct &gt; lan &gt; relay，失败自动换候选并退避重试）；此处仅展示，不改变订阅。</p>
    </section>

    <section class="settings-section" data-info-block="fleet">
      <h3>舰队摘要（Fleet） <span class="badge badge-muted">只读</span></h3>
      ${s.fleet?.configured
        ? kvRows([
          kvRow('任务域', s.fleet.namespace ? `<code>${escapeHtml(s.fleet.namespace)}</code>` : '(未设置)'),
          kvRow('已登记对端', String(s.fleet.peers ?? 0)),
          kvRow('本机 Agent', String(s.fleet.agents ?? 0)),
          kvRow('配置', escapeHtml(s.fleet.path ?? 'fleet.config.json')),
        ])
        : '<p class="muted" style="font-size:11px">尚未配置舰队。</p>'}
      <p class="muted" style="font-size:11px">任务面 ≠ 记忆域：任务树以发起节点为根派发，远端 Agent 执行后回传结果（有向无环树；经记忆通道传输，但不是共享记忆池）。任务配置由 <code>fleet</code> CLI 管理（<code>fleet.config.json</code>）。${s.fleet?.configured ? '' : ' 上车：<code>fleet quickstart --daemon --dir ~/.mebular --device &lt;ID&gt;</code>'}</p>
    </section>

    <section class="settings-section" data-info-block="tools">
      <h3>能力清单 <span class="badge badge-muted">${(s.tools ?? []).length} 工具 · MCP = CLI 同名</span></h3>
      <p class="muted" style="font-size:11px;margin:0 0 8px">Agent 经 MCP、人类经 <code>mebular &lt;name&gt;</code> 调用同一套 handler；GUI 只做守护与订阅配置，不新增操作。</p>
      <div class="chip-wrap">${(s.tools ?? []).map((t) => `<span class="crt-tag">${escapeHtml(t)}</span>`).join(' ')}</div>
    </section>
      </div>
    </details>
  `;
  body.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => copyText(button.dataset.copy, button));
  });
}

/** 简化轮 · 即时生效：字段变更即写入（勾选/选择立即、文本/数字失焦）；无草稿态。 */
function bindConfigEditor() {
  for (const editor of document.querySelectorAll('.cfg-editor')) {
    for (const el of editor.querySelectorAll('[data-cfg-path]')) {
      el.addEventListener('change', () => {
        const field = fieldOf(el.dataset.cfgPath);
        const next = fieldToConfig(field, el.type === 'checkbox' ? el.checked : el.value);
        void applyConfigField(field, next);
      });
    }
  }
  for (const btn of document.querySelectorAll('[data-cfg-action="restart"]')) {
    btn.addEventListener('click', (event) => { void restartServeFromUi(event); });
  }
  const copyAll = $('#cfg-copy-all');
  if (copyAll) copyAll.addEventListener('click', () => copyText(JSON.stringify(currentConfigFile(), null, 2), copyAll));
  const download = $('#cfg-download');
  if (download) download.addEventListener('click', downloadConfig);
}

function downloadConfig() {
  const blob = new Blob([JSON.stringify(currentConfigFile(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'config.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** 写配置补丁（共用核心：G4 自锁 409 二次确认 → 写入 → 自动重启/即时生效分支）。 */
async function submitConfigPatch(patch, warning = '') {
  const submit = (confirm) => api('/admin/api/config', { method: 'POST', body: confirm ? { patch, confirm: true } : { patch } });
  try {
    return await submit(false);
  } catch (error) {
    // G4：自锁防护（auth/host/tls）→ 服务端要求二次确认（品牌确认卡，不发系统弹窗）
    if (error?.status === 409 && error?.payload?.needsConfirmation) {
      const lockPaths = Array.isArray(error.payload.paths) ? error.payload.paths : [];
      const warnText = typeof warning === 'string' && warning.trim().length > 0
        ? `\n\n风险说明：${warning.trim()}`
        : '';
      const ok = await confirmModal({
        title: '写入并重启（可能失联）',
        body: `${error.payload.message ?? ''}${warnText}\n\n命中：${lockPaths.join(', ')}\n如重启后控制台打不开，请手工编辑 config.json 改回并重启。确定继续？`,
        confirmLabel: '确认并重启',
      });
      if (!ok) {
        const cancel = new Error('已取消（未写入）');
        cancel.uiHandled = true;
        throw cancel;
      }
      return submit(true);
    }
    throw error;
  }
}

/** 写入成功后的生效分支（自动重启等待 / 即时生效 / 前台手动指引）。 */
async function onConfigSaved(res) {
  state.rawConfig = { path: res.path, exists: true, parseError: null, config: res.config };
  lastSettingsSignature = null;
  if (res.restarting) {
    showToast('正在自动重启使配置生效…');
    await refresh().catch(() => undefined);
    renderSettings();
    await waitForServeBack();
    await refresh();
    lastSettingsSignature = null;
    lastAboutSignature = null;
    renderSettings();
    renderAbout();
    const applied = state.settings?.lastApply?.status;
    showToast(applied === 'rolled-back' || applied === 'rollback-failed'
      ? '新配置未生效：已回滚（详见横幅 / 高级 · 诊断）'
      : '已生效');
  } else if (res.effectiveImmediately) {
    showToast('已生效（即时生效项）');
    await refresh();
    renderSettings();
    renderAbout();
  } else {
    // 前台模式：手动指引
    const cmd = res.restart?.command ?? restartCommand();
    showToast(`已写入 ${res.path}${res.backup ? '（.bak 已备份）' : ''}；请手动重启：${cmd}`);
    await refresh();
    renderSettings();
  }
}

/** 单字段即时写入（值与当前不同才写；被自锁确认取消则静默回读）。 */
async function applyConfigField(field, next) {
  const current = normalizedFieldValue(field);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  if (MOCK) { showToast('mock 模式不执行写操作。'); return; }
  const patch = {};
  cfgSet(patch, field.path, next);
  try {
    const res = await submitConfigPatch(patch, field.warn ?? '');
    await onConfigSaved(res);
  } catch (error) {
    if (!error?.uiHandled) showToast(`没保存成功：${error.message}`);
  } finally {
    lastSettingsSignature = null;
    renderSettings();
  }
}

/**
 * C：一键重启——让「待重启」的配置立即生效。
 * POST /admin/api/restart（memory.admin + CSRF + 二次确认）；守护先回 202 再重启，
 * 之后轮询 /healthz 等它回来；未以服务方式运行 → 409 + 手动指引。
 */
async function restartServeFromUi(event) {
  if (MOCK) {
    window.alert('mock 模式不执行写操作。');
    return;
  }
  const stateEl = document.querySelector('.cfg-restart-state');
  const btn = event?.currentTarget ?? null;
  const ok = await confirmModal({
    title: '一键重启守护',
    body: '将重启本机守护（mebular serve），让已保存但「待重启」的配置生效。期间控制台短暂不可用，恢复后页面自动刷新。确定？',
    confirmLabel: '重启',
  });
  if (!ok) return;
  if (btn) btn.disabled = true;
  if (stateEl) stateEl.textContent = '正在重启…';
  try {
    const res = await api('/admin/api/restart', { method: 'POST', body: { confirm: true } });
    if (res?.dryRun) {
      if (stateEl) stateEl.textContent = `已排程（dry-run，未真正执行）：${res.command ?? ''}`;
      if (btn) btn.disabled = false;
      return;
    }
    if (stateEl) stateEl.textContent = '已触发重启，等待守护恢复…';
    showToast('已触发重启；等待守护恢复…');
    await waitForServeBack();
    lastSettingsSignature = null;
    lastAboutSignature = null;
    await refresh();
    renderSettings();
    if (stateEl) stateEl.textContent = '';
    showToast('守护已恢复');
  } catch (error) {
    const manual = error?.payload?.manual ?? null;
    if (stateEl) stateEl.textContent = manual ?? `重启失败：${error.message}`;
    if (btn) btn.disabled = false;
    if (manual) window.alert(`一键重启不可用：${manual}`);
    else window.alert(`重启失败：${error.message}`);
  }
}

/** 等待守护回来（最多 90s；每 1.5s 探一次 /healthz）。 */
async function waitForServeBack() {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const res = await fetch('/healthz', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (res.ok) return true;
    } catch {
      // 守护重启中：继续等
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

// ---------- G-ML-1：记忆生命周期（动作式：归档/解除归档/删除；默认过滤已删除与已归档） ----------

function memQuery() {
  const f = state.memoryFilters;
  const params = new URLSearchParams();
  if (f.archived) params.set('includeArchived', '1');
  if (f.deleted) params.set('includeDeleted', '1');
  if (f.namespace) params.set('namespace', f.namespace);
  const query = params.toString();
  return query ? `?${query}` : '';
}

function memActionLabel(action) {
  return { archive: '归档', unarchive: '解除归档', delete: '删除' }[action] ?? action;
}

async function memAction(id, action) {
  if (MOCK) {
    window.alert('mock 模式不执行写操作。');
    return;
  }
  if (action === 'delete') {
    const ok = await confirmModal({
      title: '删除记忆（不可逆）',
      body: `将删除 ${id}：写墓碑并随图同步，删除后默认不再召回。\n注意：对端已拷贝的旧快照无法强制回收。确定？`,
      confirmLabel: '删除',
    });
    if (!ok) return;
  }
  try {
    await api(`/admin/api/memories/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
    showToast(action === 'delete' ? `已删除 ${id}` : action === 'archive' ? `已归档 ${id}` : `已解除归档 ${id}`);
    await refresh();
  } catch (error) {
    window.alert(`操作失败：${error.message}`);
  }
}

function populateMemFilters() {
  const select = $('#mem-filter-namespace');
  if (!select) return;
  const current = state.memoryFilters.namespace;
  const names = [...new Set((state.namespaces ?? []).map((n) => n.namespace))].sort();
  select.innerHTML = '<option value="">全部域</option>'
    + names.map((name) => `<option value="${escapeHtml(name)}"${name === current ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('');
}

function renderMemories() {
  const list = $('#memories-list');
  if (!list) return;
  const archivedBox = $('#mem-filter-archived');
  const deletedBox = $('#mem-filter-deleted');
  if (archivedBox) archivedBox.checked = state.memoryFilters.archived;
  if (deletedBox) deletedBox.checked = state.memoryFilters.deleted;
  populateMemFilters();
  const data = state.memories;
  if (!data) {
    list.innerHTML = '<p class="muted">记忆加载中…</p>';
    return;
  }
  if (data.memories.length === 0) {
    list.innerHTML = `<p class="muted">没有匹配的记忆（默认不显示已删除/已归档；共 ${data.total} 条）。</p>`;
    return;
  }
  list.innerHTML = data.memories.map((memory) => {
    const badges = [
      memory.archived ? '<span class="crt-tag crt-tag-warn">已归档</span>' : '',
      memory.deleted ? '<span class="crt-tag crt-tag-error">已删除</span>' : '',
    ].filter(Boolean).join(' ');
    const canArchive = state.features.writes && !memory.deleted;
    const actions = [
      canArchive
        ? `<button class="btn btn-small btn-crt" type="button" data-mem-action="${memory.archived ? 'unarchive' : 'archive'}" data-mem-id="${escapeHtml(memory.id)}">${memory.archived ? '解除归档' : '归档'}</button>`
        : '',
      !memory.deleted && state.features.writes
        ? `<button class="btn btn-small btn-crt" type="button" data-mem-action="delete" data-mem-id="${escapeHtml(memory.id)}">删除</button>`
        : '',
    ].filter(Boolean).join(' ');
    return `<article class="mem-row crt-surface" data-mem-row="${escapeHtml(memory.id)}">
      <div class="mem-main">
        <div class="mem-head">
          <span class="crt-tag">${escapeHtml(String(memory.type))}</span>
          <span class="crt-tag">${escapeHtml(String(memory.namespace))}</span>
          ${badges}
          <code class="mem-id">${escapeHtml(memory.id)}</code>
        </div>
        <p class="mem-preview">${escapeHtml(memory.preview || '（空）')}</p>
        <p class="muted mem-meta">创建 ${formatTime(memory.createdAt)}${memory.archivedAt ? ` · 归档 ${formatTime(memory.archivedAt)}` : ''}${memory.deletedAt ? ` · 删除 ${formatTime(memory.deletedAt)}` : ''}</p>
      </div>
      <div class="mem-actions">${actions}</div>
    </article>`;
  }).join('');
}

// ---------- H-1/UX-2：设置 · AI 助手专区（单列表）+ 首屏只读叠加层 ----------
// 连接页已收编进「设置 · AI 助手」（?view=connect 为别名重定向）；构建器见 assistants.js。

/** 行内动作后的重绘：设置弹层开着就强刷设置（签名已含 clients/service/消息态），叠加层永远刷新。 */
function rerenderAssistants() {
  if (!$('#settings')?.hidden) { lastSettingsSignature = null; renderSettings(state.settingsTab ?? 'common'); }
  renderOverlays();
}

/** UX-2 首屏叠加层：状态总览条（纯只读）+「需要注意」条件浮卡（无事不出现）；只在星图视图出现，星图本体不改。 */
function renderOverlays() {
  const pill = $('#status-pill');
  const card = $('#attention-card');
  if (!pill || !card) return;
  if (state.locked) {
    // 锁定态没有守护/对端/记忆真值：隐藏总览条与注意卡，避免看起来像有数据。
    pill.hidden = true;
    pill.innerHTML = '';
    card.hidden = true;
    card.innerHTML = '';
    return;
  }
  const onMap = state.view === 'map';
  const selfId = state.overview?.device?.deviceId ?? null;
  pill.hidden = !onMap;
  if (onMap) {
    pill.innerHTML = statusPillHtml({
      service: state.service,
      devices: state.devices,
      memoryCount: state.overview?.status?.nodeCount ?? null,
      selfId,
    });
  }
  const items = attentionItems({ clients: state.clients, ui: state, devices: state.devices, selfId, security: state.security });
  card.hidden = !onMap || items.length === 0;
  if (onMap && items.length > 0) {
    card.innerHTML = `<h3>需要注意</h3><ul>${items.map((it) =>
      `<li><button class="attention-item" type="button" data-attention-action="${escapeHtml(it.action)}" data-attention-id="${escapeHtml(it.id)}">${escapeHtml(it.label)} ›</button></li>`).join('')}</ul>`;
  } else {
    // 注意项退场时同步清空隐藏卡：hidden 只负责视觉，残留文案仍会被读屏/验收读到。
    card.innerHTML = '';
  }
}

async function serviceAction(action) {
  const say = (t) => { state.serviceMsg = t; rerenderAssistants(); };
  try {
    if (action === 'recheck') { await refresh(); say('已刷新'); return; }
    if (action === 'restart') {
      await api('/admin/api/restart', { method: 'POST', body: {} });
      say('已请求重启；稍后本页会自动恢复。');
      return;
    }
    const res = await api(`/admin/api/service/${action}`, { method: 'POST', body: {}, timeoutMs: 30000 }); // launchd 安装/重启可能较慢
    if (res?.dryRun) {
      const cmds = (res.commands ?? []).map((c) => c.join(' ')).join('；');
      say(`（试运行）将执行：${cmds}`);
    } else {
      say(action === 'install' ? '已开启常驻运行。' : '已取消常驻运行。');
    }
    await refresh();
  } catch (error) {
    say(`没能完成：${error.message}。可点「重新检测」或复制诊断。`);
  }
}

async function clientAction(id, action) {
  const say = (t) => { state.clientMsg[id] = t; rerenderAssistants(); };
  const showDiff = (t) => { state.clientDiff[id] = t; rerenderAssistants(); };
  const busyActions = ['connect', 'verify', 'verify-confirm', 'recheck', 'rollback', 'skills'];
  if (busyActions.includes(action)) { state.clientBusy[id] = action; rerenderAssistants(); } // 补丁 3：在途禁用 + 「写入中…/验证中…」
  try {
    // UX-2：「详情 ›」= 行内展开/收起（判据/路径/次级动作）
    if (action === 'details') { state.clientOpen[id] = !state.clientOpen[id]; rerenderAssistants(); return; }
    // UX-2 行内 verify（轮 A）：hasVerify → steps[]（回读 → CLI 验证 → 待生效/已接入；失败黄态 + 输出）
    if (action === 'verify' || action === 'verify-confirm') {
      const res = await api(`/admin/api/clients/${id}/verify`, {
        method: 'POST',
        body: action === 'verify-confirm' ? { userConfirmedReload: true } : {},
        timeoutMs: 40000, // 服务端 verify CLI 最长 30s（hermes mcp test）
      });
      state.clientVerify[id] = res;
      if (res?.state === 'connected') { state.clientRestart[id] = false; say('验证通过，已接入 ✓'); }
      else if (res?.state === 'pending-restart') say('配置已就绪——重启该软件后生效；好了点「我已重载，验证」。');
      else say('验证未过：展开看失败步骤与输出。');
      return;
    }
    if (action === 'recheck') { state.clientRestart[id] = false; state.clientVerify[id] = null; delete state.clientFailed[id]; await refresh(); say('已重新检测'); return; }
    if (action === 'copy') {
      const client = (state.clients ?? []).find((c) => c.id === id);
      await navigator.clipboard.writeText(client?.snippet ?? '');
      say('片段已复制，粘贴到该助手的 MCP 配置即可。');
      return;
    }
    if (action === 'preview') {
      const res = await api(`/admin/api/clients/${id}/preview`, { method: 'POST', body: {} });
      showDiff(res.preview || '（与当前一致，无需改动）');
      say(res.needsManual ? `需要你手动合并：${res.reason ?? ''}` : '');
      return;
    }
    // R-1 小-11：回滚是不可逆方向的操作 → 应用内二次确认（取消 / Esc / 点空白 = 不执行）
    if (action === 'rollback') {
      const ok = await confirmModal({
        title: '回滚助手配置？',
        body: '将把该助手的配置还原到接入前（使用自动备份）。回滚会覆盖接入后写入的 Mebular 条目。',
        confirmLabel: '回滚',
      });
      if (!ok) return;
    }
    const res = await api(`/admin/api/clients/${id}/${action}`, { method: 'POST', body: {}, timeoutMs: 20000 }); // 写入/CLI 动作给足余量
    if (typeof res.preview === 'string' && res.preview.length > 0) showDiff(res.preview);
    if (!res.ok) { say(`需要你手动处理：${res.reason ?? '请看片段'}`); return; }
    delete state.clientFailed[id]; // 成功/重试成功 → 清失败态
    say(action === 'connect'
      ? (res.changed ? '接入完成（已备份原配置）。重启该助手后生效。' : '已接入（无需改动）。')
      : action === 'rollback' ? '已还原到接入前。' : '已安装。');
    // R-1 中-6 → UX-2 行内闭环：接入成功后挂重载提醒，「我已重载，验证」可消
    if (action === 'connect' && res.changed) { state.clientRestart[id] = true; state.clientVerify[id] = null; }
    await refresh();
  } catch (error) {
    // 补丁 3：接入失败反馈语义——「接入失败」+ 一行原因（人话/脱敏）+ rolledBack 明示还原；绝不落入「待生效」
    if (action === 'connect') {
      const p = error?.payload ?? {};
      state.clientFailed[id] = {
        kind: 'connect',
        at: Date.now(),
        reason: p.reason ?? error.message,
        rolledBack: p.rolledBack === true,
        backupPath: typeof p.backupPath === 'string' ? p.backupPath : null,
        commands: Array.isArray(p.commands) ? p.commands : null,
      };
      state.clientRestart[id] = false;
      rerenderAssistants();
    } else {
      say(`没能完成：${error.message}`);
    }
  } finally {
    delete state.clientBusy[id];
    rerenderAssistants();
  }
}

// ---------- UX-2 自定义助手 CRUD（轮 A 注册表端点；选文件=merge-key 自动写 / 粘片段=manual 只给片段） ----------

/** 从 #asst-add-form 读表单并构造 descriptor（服务端 validateAssistant 会再校验一次）。 */
function readAssistantForm() {
  const root = $('#asst-add-form');
  if (!root) return null;
  const mode = root.querySelector('input[name="asst-mode"]:checked')?.value ?? 'file';
  const id = $('#asst-add-id')?.value?.trim() ?? '';
  const name = $('#asst-add-name')?.value?.trim() ?? '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return { error: '标识需为小写 kebab-case（如 my-assistant）' };
  if (name === '') return { error: '名称必填' };
  if (mode === 'snippet') {
    return {
      editId: root.dataset.editId || null,
      descriptor: {
        id, name,
        landing: { format: 'generic', primaryPath: null },
        probe: { signals: [{ kind: 'always', reason: '手动条目（粘片段接入）' }] },
        writer: { strategy: 'manual' },
        verify: { configReadback: true },
        activation: { kind: 'user-reload' },
      },
    };
  }
  const primaryPath = $('#asst-add-path')?.value?.trim() ?? '';
  if (primaryPath === '') return { error: '配置文件路径必填（选文件模式）' };
  const format = $('#asst-add-format')?.value ?? 'mcpServers';
  return {
    editId: root.dataset.editId || null,
    descriptor: {
      id, name,
      landing: { format, primaryPath },
      probe: { signals: [{ kind: 'config-path', paths: [primaryPath] }] },
      writer: { strategy: 'merge-key', backup: 'byte-level' },
      verify: { configReadback: true },
      activation: { kind: 'user-reload' },
    },
  };
}

async function assistantSubmitForm() {
  const read = readAssistantForm();
  if (!read) return;
  if (read.error) { state.addForm = { ...(state.addForm ?? {}), error: read.error }; rerenderAssistants(); return; }
  try {
    const res = read.editId
      ? await api(`/admin/api/assistants/${encodeURIComponent(read.editId)}`, { method: 'PUT', body: read.descriptor })
      : await api('/admin/api/assistants', { method: 'POST', body: read.descriptor });
    if (!res?.ok) { state.addForm = { ...(state.addForm ?? {}), error: res?.reason ?? '登记失败' }; rerenderAssistants(); return; }
    state.addForm = null;
    await refresh();
    if ($('#settings') && !$('#settings').hidden) { lastSettingsSignature = null; renderSettings('assistants'); }
  } catch (error) {
    state.addForm = { ...(state.addForm ?? {}), error: `没能完成：${error.message}` };
    rerenderAssistants();
  }
}

function assistantStartEdit(id) {
  const client = (state.clients ?? []).find((c) => c.id === id);
  if (!client) return;
  state.addForm = {
    edit: {
      id: client.id,
      name: client.name,
      landing: { format: client.landing?.format ?? client.format ?? 'mcpServers', primaryPath: client.landing?.primaryPath ?? client.configPath ?? '' },
      writer: { strategy: client.writer?.strategy ?? (client.needsManual ? 'manual' : 'merge-key') },
    },
  };
  rerenderAssistants();
}

async function assistantRemove(id) {
  // 移除自定义条目不可恢复 → 应用内二次确认
  const ok = await confirmModal({
    title: '移除自定义助手？',
    body: `将移除「${id}」的登记；它已有的配置文件不改动。重新登记后可再次接入。`,
    confirmLabel: '移除',
  });
  if (!ok) return;
  try {
    const res = await api(`/admin/api/assistants/${encodeURIComponent(id)}/remove`, { method: 'POST', body: {} });
    if (!res?.ok) { state.clientMsg[id] = res?.reason ?? '移除失败'; rerenderAssistants(); return; }
    await refresh();
    if ($('#settings') && !$('#settings').hidden) { lastSettingsSignature = null; renderSettings('assistants'); }
  } catch (error) {
    state.clientMsg[id] = `没能完成：${error.message}`;
    rerenderAssistants();
  }
}

function renderAudit() {
  const actionFilter = $('#audit-filter-action').value;
  const deviceFilter = $('#audit-filter-device').value;
  const nsFilter = $('#audit-filter-namespace').value;
  const timeFilter = Number($('#audit-filter-time')?.value ?? '') || 0;
  const since = timeFilter > 0 ? Date.now() - timeFilter : 0;

  populateAuditFilters();

  const list = $('#audit-list');
  const events = state.policy.filter((event) => {
    if (actionFilter && event.type !== actionFilter) return false;
    if (deviceFilter && event.issuer !== deviceFilter && event.subject !== deviceFilter) return false;
    if (nsFilter && !(event.namespaces ?? []).includes(nsFilter)) return false;
    if (since > 0 && (event.at ?? 0) < since) return false;
    return true;
  });
  if (events.length === 0) {
    list.innerHTML = '<li class="muted">没有匹配的政策事件。</li>';
    return;
  }
  list.innerHTML = events.map((event) => auditItemHtml(event)).join('');
}

function auditItemHtml(event) {
  const actionClass = {
    namespace_subscription: 'membership',
    namespace_declare: 'declare',
    device_revoke: 'device',
    device_restore: 'device',
    namespace_handoff: 'handoff',
    security_tier: 'security',
    security_approval: 'security',
    security_recovery: 'recovery',
    security_totp: 'security',
  }[event.type] ?? 'device';
  return `<li class="audit-item${event.valid ? '' : ' invalid'}">
    <span class="audit-time">${escapeHtml(formatTime(event.at))}</span>
    <span class="audit-action ${actionClass}">${escapeHtml(actionLabel(event.type))}</span>
    <span class="audit-detail">${describeEvent(event)}${event.rejectReason ? ` · <span class="crt-warn">被拒绝：${escapeHtml(securityReasonLabel(event.rejectReason))}</span>` : ''}</span>
  </li>`;
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
  if (type === 'namespace_subscription') return '订阅变更';
  if (type === 'namespace_declare') return '域公告';
  if (type === 'device_revoke') return '移出设备';
  if (type === 'device_restore') return '恢复设备';
  if (type === 'namespace_handoff') return '退出并交接';
  if (type === 'security_tier') return '安全等级变更';
  if (type === 'security_approval') return '设备会签';
  if (type === 'security_recovery') return '恢复码';
  if (type === 'security_totp') return '动态码';
  return type;
}

function describeEvent(event) {
  if (event.type === 'namespace_subscription') {
    const ns = `<span class="ns-chip" style="background:${namespaceColor(event.namespace ?? 'default')}">${escapeHtml(event.namespace ?? 'default')}</span>`;
    return `<b>${escapeHtml(event.issuer === event.subject ? '本机' : event.subject)}</b> ${event.active === false ? '退订' : '订阅'} ${ns}`
      + `${event.cosignApprover ? ` · 会签：<b>${escapeHtml(event.cosignApprover)}</b>` : ''}`
      + `${event.valid ? '' : ' · 未生效'}`;
  }
  if (event.type === 'namespace_declare') {
    const ns = `<span class="ns-chip" style="background:${namespaceColor(event.namespace ?? 'default')}">${escapeHtml(event.namespace ?? 'default')}</span>`;
    return `声明者 <b>${escapeHtml(event.issuer)}</b> 公告记忆域 ${ns}`;
  }
  if (event.type === 'device_restore') {
    return `记录者 <b>${escapeHtml(event.issuer)}</b> 恢复设备 <b>${escapeHtml(event.subject)}</b>（旧纪元策略记录不复活）`
      + `${event.cosignApprover ? ` · 会签：<b>${escapeHtml(event.cosignApprover)}</b>` : ''}`
      + `${event.breakGlassKeyId ? ` · <span class="crt-warn">恢复码 ${escapeHtml(String(event.breakGlassKeyId).slice(0, 8))}</span>` : ''}`
      + `${event.valid ? '' : ' · 未生效'}`;
  }
  if (event.type === 'device_revoke') {
    return `记录者 <b>${escapeHtml(event.issuer)}</b> 移出设备 <b>${escapeHtml(event.subject)}</b>（本机不再采纳其政策记录）`
      + `${event.cosignApprover ? ` · 会签：<b>${escapeHtml(event.cosignApprover)}</b>` : ''}`
      + `${event.breakGlassKeyId ? ` · <span class="crt-warn">恢复码 ${escapeHtml(String(event.breakGlassKeyId).slice(0, 8))}</span>` : ''}`
      + `${event.valid ? '' : ' · 未生效'}`;
  }
  if (event.type === 'security_tier') {
    const from = event.fromLevel ? securityLevelLabel(event.fromLevel) : '—';
    const to = securityLevelLabel(event.level);
    return `记录者 <b>${escapeHtml(event.issuer)}</b> 将安全等级 <b>${escapeHtml(from)} → ${escapeHtml(to)}</b>`
      + `${event.cosignApprover ? ` · 会签：<b>${escapeHtml(event.cosignApprover)}</b>` : ''}`
      + `${event.breakGlassKeyId ? ` · <span class="crt-warn">恢复码 ${escapeHtml(String(event.breakGlassKeyId).slice(0, 8))}</span>` : ''}`;
  }
  if (event.type === 'security_approval') {
    const decision = event.decision === 'approve' ? '批准' : event.decision === 'deny' ? '拒绝' : '请求';
    const pair = event.pairingCode ? ` · 配对号 <code>${escapeHtml(event.pairingCode)}</code>` : '';
    if (event.decision === 'deny') {
      return `设备会签：<b>${escapeHtml(securityOpText(event))}</b> 已被拒绝${pair}`;
    }
    if (event.decision === 'approve') {
      return `设备会签：批准设备 <b>${escapeHtml(event.issuer)}</b> ${decision} <b>${escapeHtml(securityOpText(event))}</b>${pair}`;
    }
    return `设备会签：发起设备 <b>${escapeHtml(event.initiator)}</b> 请求 <b>${escapeHtml(securityOpText(event))}</b>${pair}`
      + `${event.expiresAt ? ` · 有效至 ${escapeHtml(formatTime(event.expiresAt))}` : ''}`;
  }
  if (event.type === 'security_recovery') {
    return `恢复码${event.mode === 'rotate' ? '轮换' : '登记'}：<code>${escapeHtml(String(event.keyId ?? '').slice(0, 8))}</code>`
      + `${event.breakGlassKeyId ? ` · 旧码签名 ${escapeHtml(String(event.breakGlassKeyId).slice(0, 8))}` : ''}`
      + `${event.cosignApprover ? ` · 会签：${escapeHtml(event.cosignApprover)}` : ''}`;
  }
  if (event.type === 'security_totp') {
    const action = /show/i.test(String(event.note ?? '')) ? '展示' : '导入';
    return `设备 <b>${escapeHtml(event.device ?? event.issuer)}</b> ${action}动态码种子 · fingerprint <code>${escapeHtml(event.fingerprint ?? '—')}</code>`;
  }
  if (event.type === 'namespace_handoff') {
    const ns = `<span class="ns-chip" style="background:${namespaceColor(event.namespace ?? 'default')}">${escapeHtml(event.namespace ?? 'default')}</span>`;
    return `记录者 <b>${escapeHtml(event.issuer)}</b> 将 ${ns} 交接给 <b>${escapeHtml(event.subject ?? '—')}</b>`
      + `<span class="muted">${event.forced ? ' · forced' : ''} · 未覆盖 ${event.pendingCount ?? 0}</span>`;
  }
  return '';
}

let lastCardSignature = null;

/** C2：某设备的当前连接路径（只读；来自 settings.peers.paths，按 deviceId / 地址匹配）。 */
function peerPathFor(device) {
  const paths = state.settings?.peers?.paths ?? [];
  if (paths.length === 0) return null;
  const peerId = device.peerId;
  return paths.find((p) => p.key === device.deviceId)
    ?? (peerId ? paths.find((p) => typeof p.address === 'string' && p.address.includes(peerId)) : null)
    ?? (device.addrs ?? [])
      .map((addr) => paths.find((p) => p.address === addr))
      .find(Boolean)
    ?? null;
}

// ---------- P3 · 收敛健康（只读；状态来自 /admin/api/devices.convergence） ----------

const CONVERGENCE_STATE_META = {
  ok: { text: '已收敛', cls: 'crt-tag-ok' },
  stalled: { text: '停滞', cls: 'crt-tag-error' },
  diverged: { text: '未收敛', cls: 'crt-tag-error' },
  unverifiable: { text: '未对账', cls: 'crt-tag-warn' },
  syncing: { text: '同步中', cls: 'crt-tag-warn' },
  offline: { text: '未连接', cls: 'is-off' },
};

function fmtClock(at) {
  const d = new Date(at);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** P3：收敛原因 → 人话（与 src/sync/convergence.ts 的 reason code 对齐；只读展示） */
function convergenceReasonText(reason) {
  const domains = Array.isArray(reason?.domains) ? reason.domains.join('、') : '';
  switch (reason?.code) {
    case 'fingerprint-mismatch':
      return reason.detail === '策略视图指纹不一致'
        ? '策略视图指纹不一致'
        : `${domains || '共同'}的记忆域状态指纹不一致`;
    case 'session-failures': return `会话连续失败 ${reason.count ?? ''} 次`;
    case 'no-ack-progress': return '已发出的数据一直未被确认';
    case 'backlog-mismatch': return `${reason.count ?? 0} 条已发出但水位记账认为无需发送`;
    case 'keying-drop': return '键控异常（身份缺失的帧被丢弃）';
    case 'keying-drops': return `键控告警（nudge/stale 丢弃 ${reason.count ?? ''}）`;
    case 'probe-ineffective': return '自动探测多轮仍未恢复';
    case 'peer-claims-ahead': return '对端自报超前（本机记账落后，提示）';
    case 'peer-state-loss': return `对端状态反复回退 ${reason.count ?? ''} 次（提示）`;
    case 'unknown-event-types': return `收到未知事件类型 ${reason.count ?? ''} 条（日志有、图无）`;
    case 'no-fingerprints': return '对端未提供状态指纹（旧版本 / 未启用）';
    case 'awaiting-session': return '尚未完成首轮对账';
    case 'expected-yet-unverifiable': return `期望订阅${domains ? `「${domains}」` : ''}，但无法跨端自证`;
    default: return String(reason?.code ?? '');
  }
}

function convergencePrimaryText(conv) {
  const reason = (conv?.reasons ?? []).find((r) => r && r.code !== 'awaiting-session');
  return reason ? convergenceReasonText(reason) : '';
}

/** 设备卡（对端）：状态 chip 一行 + 至多两条人话原因（只读；不设第二套开关） */
function convergenceChipRows(conv, shortTimeFn) {
  const meta = CONVERGENCE_STATE_META[conv?.state] ?? { text: String(conv?.state ?? '—'), cls: 'is-off' };
  const when = conv?.state === 'ok' && conv.lastConvergedAt
    ? `<span class="muted" style="margin-left:6px">${shortTimeFn(conv.lastConvergedAt)} 对账</span>`
    : '';
  const rows = [`<li><span class="crt-tag ${meta.cls}">${meta.text}</span>${when}</li>`];
  for (const reason of (conv?.reasons ?? []).slice(0, 2)) {
    rows.push(`<li><span class="muted">${escapeHtml(convergenceReasonText(reason))}</span></li>`);
  }
  return rows.join('');
}

/** 「关于本机」：收敛健康汇总段（对端各自一句话；未启用 = 说明 + 关掉入口） */
function convergenceAboutSection() {
  const peers = (state.devices ?? [])
    .filter((d) => d.deviceId !== state.overview?.device?.deviceId && d.convergence)
    .sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1));
  const s = state.overview?.convergence?.summary;
  if (!s && peers.length === 0) {
    return `
    <section class="settings-section" data-info-block="convergence">
      <h3>收敛健康 <span class="badge badge-muted">只读</span></h3>
      <p class="muted" style="font-size:11px;margin:0">未启用（config.json 置 <code>sync.convergence.enabled</code> 后重启）。</p>
    </section>`;
  }
  const summary = s
    ? `对端 ${s.peers} 个 · 已收敛 ${s.ok} · 停滞 ${s.stalled} · 未收敛 ${s.diverged} · 未对账 ${s.unverifiable} · 未连接 ${s.offline}`
    : '';
  const rows = peers.map((d) => {
    const conv = d.convergence;
    const meta = CONVERGENCE_STATE_META[conv.state] ?? { text: String(conv.state), cls: 'is-off' };
    const detail = [convergencePrimaryText(conv), conv.state === 'ok' && conv.lastConvergedAt ? `${fmtClock(conv.lastConvergedAt)} 对账` : '']
      .filter(Boolean)
      .join(' · ');
    return kvRow(d.deviceId, `<span class="crt-tag ${meta.cls}">${meta.text}</span>${detail ? ` <span class="muted">${escapeHtml(detail)}</span>` : ''}`);
  });
  return `
    <section class="settings-section" data-info-block="convergence">
      <h3>收敛健康 <span class="badge badge-muted">只读 · 本机视角</span></h3>
      ${summary ? `<p class="muted" style="font-size:11px;margin:0 0 8px">${escapeHtml(summary)}</p>` : ''}
      ${peers.length ? kvRows(rows) : '<p class="muted" style="font-size:11px;margin:0">暂无对端对账记录</p>'}
      <p class="muted" style="font-size:11px;margin:8px 0 0">「状态指纹」对账得出；差异只告警，不改变订阅与同步行为。</p>
    </section>`;
}

function renderDeviceCard() {
  const asideEl = document.querySelector('.aside');
  // 走查修复（用户指认：卡片「分区」区在首次轮询补全文案 → 内容变高 → 贴底抽屉顶边瞬跳）：
  // 内容重渲染前后测高，高度有变化则用 FLIP 平滑掉（reduced-motion 跳过）
  const hBefore = asideEl ? asideEl.getBoundingClientRect().height : 0;
  const cardEl = $('#device-card');
  const empty = $('#device-card-empty');
  const body = $('#device-card-body');
  if (state.locked) {
    // P6A：锁定态整张设备卡退场（不展示占位卡/假设备数据）；星图 ghost 地球仪承担唯一本机表达。
    if (asideEl) {
      asideEl.hidden = true;
      asideEl.classList.remove('is-locked', 'is-open');
    }
    cardEl?.classList.remove('is-disabled');
    cardEl?.removeAttribute('aria-disabled');
    empty.hidden = false;
    empty.textContent = '新建或加入忆云后，这里会显示设备详情。';
    body.hidden = true;
    body.innerHTML = '';
    lastCardSignature = null;
    return;
  }
  if (asideEl) asideEl.hidden = false;
  asideEl?.classList.remove('is-locked');
  cardEl?.classList.remove('is-disabled');
  cardEl?.removeAttribute('aria-disabled');
  empty.textContent = '点击星图上的设备查看详情。';
  if (asideEl) asideEl.classList.toggle('is-open', Boolean(state.selected) && state.view === 'map');
  if (!state.selected) {
    empty.hidden = false;
    body.hidden = true;
    lastCardSignature = null;
    return;
  }
  empty.hidden = true;
  body.hidden = false;
  const device = state.devices.find((d) => d.deviceId === state.selected.deviceId) ?? state.selected;
  const isSelf = device.deviceId === state.overview?.device?.deviceId;
  const status = isSelf
    ? { text: `${ICONS.online} 本机`, cls: 'is-ok' }
    : device.blocked
      ? { text: `${ICONS.revoked} 已移出`, cls: 'is-danger' }
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
  // C2：连接路径（只读；核心地址簿 → settings.peers.paths）
  const pathInfo = isSelf ? null : peerPathFor(device);
  const pathRow = isSelf
    ? '<li class="path-row"><span class="path-key">当前路径</span><span class="path-value">本机（无需拨号）</span></li>'
    : pathInfo
      ? `<li class="path-row"><span class="path-key">当前路径</span><span class="path-value">${pathInfo.connected
          ? `<span class="path-kind path-kind-${escapeHtml(String(pathInfo.kind ?? 'unknown'))}">${escapeHtml(String(pathInfo.kind ?? '未知'))}</span> <code>${escapeHtml(String(pathInfo.address ?? '—'))}</code> <span class="muted">${pathInfo.since ? `自 ${shortTime(pathInfo.since)} 起` : ''}</span>`
          : `<span class="muted">未连接</span>${pathInfo.lastError ? ` <span class="crt-warn">⚠ ${escapeHtml(String(pathInfo.lastError))}</span>` : ''}`}</span></li>`
      : '<li class="path-row"><span class="path-key">当前路径</span><span class="path-value muted">地址簿未启用 / 无记录</span></li>';

  const allNamespaces = allNamespaceNames();
  const writes = state.features.writes && !MOCK;
  const selfRow0 = state.devices.find((d) => d.deviceId === state.overview?.device?.deviceId);
  // 轮询每 3s 触发 render；内容未变时跳过重渲染，避免冲掉「更多操作」展开态与点击
  const cardSignature = JSON.stringify([
    device.deviceId, device.name ?? null, device.online, device.blocked, device.pendingEventCount ?? null,
    device.lastSyncAt ?? null, device.subscriptions ?? [], device.sharesWithMe ?? [],
    isSelf, writes,
    state.security?.level ?? 'low',
    state.settings?.sync?.subscriptions ?? [], state.settings?.fleet?.namespace ?? null,
    allNamespaces,
    (selfRow0?.subscriptions ?? []),
    (state.namespaces ?? []).map((n) => [n.namespace, n.subscribed]),
    device.convergence ?? null,
  ]);
  if (cardSignature === lastCardSignature) return;
  lastCardSignature = cardSignature;

  const nsList = state.namespaces ?? [];
  // 订阅声明：优先运行期 settings.sync.subscriptions（空 = 全部）
  const subsDeclared = state.settings?.sync?.subscriptions ?? null;
  const effectiveSubs = subsDeclared ?? (nsList.some((n) => !n.subscribed) ? nsList.filter((n) => n.subscribed).map((n) => n.namespace) : []);
  const subscribedTo = (ns) => effectiveSubs.length === 0 || effectiveSubs.includes(ns);
  const nsRecord = new Map(nsList.map((n) => [n.namespace, n]));
  const iFollow = (ns) => (nsRecord.has(ns) ? nsRecord.get(ns).subscribed : subscribedTo(ns));

  // 本机：我订阅的记忆域（只读；调整订阅的唯一入口在「记忆共享」）
  const followRows = allNamespaces.length === 0
    ? '<li class="muted">暂无已知记忆域</li>'
    : allNamespaces.map((ns) => `<li>
        <span><span class="ns-chip" style="background:${namespaceColor(ns)}">${escapeHtml(ns)}</span>
          <span class="muted" style="margin-left:6px">${iFollow(ns) ? '已订阅' : '未订阅'}</span></span>
      </li>`).join('');

  // 对端：它订阅的记忆域（对端自声明，只读）
  const peerFollowRows = (device.subscriptions ?? []).length
    ? device.subscriptions.map((ns) => `<li>
        <span><span class="ns-chip" style="background:${namespaceColor(ns)}">${escapeHtml(ns)}</span>
          <span class="muted" style="margin-left:6px">已订阅</span></span>
      </li>`).join('')
    : '<li class="muted">对端尚未声明订阅任何记忆域</li>';

  // 对端：订阅交集 = 双方都能读写的域
  const peerFollowSet = new Set(device.subscriptions ?? []);
  const domains = [...new Set([...allNamespaces, ...peerFollowSet])].sort();
  const interop = domains.map((ns) => {
    const peerIn = peerFollowSet.has(ns);
    const mineIn = iFollow(ns);
    const noContent = !allNamespaces.includes(ns);
    let fact = '';
    if (peerIn && mineIn) fact = '双方都已订阅';
    else if (peerIn) fact = '它已订阅 · 本机未订阅';
    else if (mineIn) fact = '本机已订阅 · 它未订阅';
    if (fact && noContent) fact += ' · 这个域还没有内容';
    return { ns, fact };
  });
  const visibleInterop = interop.filter((row) => row.fact !== '');
  const hiddenCount = interop.length - visibleInterop.length;
  const interopRows = (visibleInterop.length > 0
    ? visibleInterop.map((row) => `<li>
        <span><span class="ns-chip" style="background:${namespaceColor(row.ns)}">${escapeHtml(row.ns)}</span>
          <span class="muted" style="margin-left:6px">${row.fact}</span></span>
      </li>`).join('')
    : '<li class="muted">暂无需处理的记忆域</li>')
    + (hiddenCount > 0 ? `<li class="muted">另有 ${hiddenCount} 个记忆域双方均未订阅</li>` : '');

  // S3 · 移出分级（SPEC §5.2 v1.1）：low 维持「更多操作」折叠（防误触）；
  // medium/high 提级为一等动作（与同步/断开同排，危险样式），门槛由动态码/会签提供。
  const secLevel = state.security?.level ?? 'low';
  const elevatedKick = secLevel === 'medium' || secLevel === 'high';
  const kickButton = `<button class="btn btn-small btn-crt btn-crt-danger" data-action="revoke-device" ${writes ? '' : 'disabled'}>移出</button>`;
  const restoreButton = `<button class="btn btn-small btn-crt" data-action="restore-device" ${writes ? '' : 'disabled'}>恢复设备</button>`;
  const primaryDanger = device.blocked ? restoreButton : kickButton;
  const actions = isSelf ? '' : `
    <div class="card-actions">
      <button class="btn btn-small btn-crt" data-action="sync" ${writes && device.online ? '' : 'disabled'}>立即同步</button>
      ${device.online
        ? `<button class="btn btn-small btn-crt" data-action="disconnect" ${writes ? '' : 'disabled'}>断开连接</button>`
        : `<button class="btn btn-small btn-crt" data-action="connect" ${writes ? '' : 'disabled'}>连接</button>`}
      ${device.blocked || elevatedKick ? primaryDanger : ''}
    </div>
    ${device.blocked
      ? '<p class="card-help muted">该设备已被移出。恢复只恢复身份：旧纪元的订阅/移出策略记录不复活，需要它重新声明订阅。</p>'
      : elevatedKick
        ? `<p class="card-help muted">移出后，本机不再采纳它的记录；已同步的数据不回收。${secLevel === 'high' ? '高档需要另一台已准入设备会签。' : '中档需要本机 6 位动态码。'}</p>`
        : ''}
    <details class="card-advanced">
      <summary>更多操作</summary>
      <div class="card-actions">
        ${device.online ? '' : `<button class="btn btn-small btn-crt" data-action="manual-connect" ${writes ? '' : 'disabled'}>连不上？手动连接…</button>`}
        <button class="btn btn-small btn-crt" data-action="reset-watermarks" ${writes ? '' : 'disabled'}>重置水位</button>
        ${device.blocked || elevatedKick ? '' : primaryDanger}
      </div>
    </details>
    ${writes ? '' : '<p class="muted" style="margin-top:10px">当前为只读模式（写操作需 memory.admin + CSRF）。</p>'}`;

  const advancedOpen = body.querySelector('.card-advanced')?.open === true;
  const conv = isSelf ? null : device.convergence ?? null;
  body.innerHTML = `
    <div class="card-identity">
      ${device.name ? `<span class="card-name">${escapeHtml(device.name)}</span>` : ''}
      <span class="card-id"><span class="dev-led ${status.cls}" aria-hidden="true"></span>${escapeHtml(device.deviceId)}</span>
      <span class="crt-tag card-status ${status.cls}">${status.text}</span>
    </div>
    ${metaParts.length > 0 ? `<p class="card-meta muted">${escapeHtml(metaParts.join(' · '))}</p>` : '<p class="card-meta muted"></p>'}
    <ul class="path-list" aria-label="连接路径（只读）">${pathRow}</ul>
    ${conv ? `
    <h3>同步健康 <span class="h3-note">本机视角 · 只读</span></h3>
    <ul class="chip-list">${convergenceChipRows(conv, shortTime)}</ul>
    ` : ''}
    ${isSelf ? `
    <h3>我订阅的记忆域 <span class="h3-note">阅读权 + 维持义务</span></h3>
    <p class="card-help muted">订阅 = 接收该记忆域的更新，本机新增也同步给其他订阅设备。此处只读；调整订阅请到「记忆共享」。</p>
    <ul class="chip-list">${followRows}</ul>
    <div class="card-actions"><button class="btn btn-small btn-crt" type="button" data-action="goto-domains">去「记忆共享」调整 ›</button></div>
    ` : `
    <h3>它订阅的记忆域 <span class="h3-note">对端自声明 · 图上记录</span></h3>
    <ul class="chip-list">${peerFollowRows}</ul>
    <h3>订阅情况 <span class="h3-note">本机视角</span></h3>
    <ul class="chip-list">${interopRows}</ul>
    `}
    ${actions}
  `;

  const advancedEl = body.querySelector('.card-advanced');
  if (advancedEl && advancedOpen) advancedEl.open = true;
  body.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => handleDeviceAction(button.dataset.action, device));
  });

  // 高度收口：内容/文案变化导致的高度差 → 220ms 平滑过渡（否则贴底抽屉顶边瞬跳）
  if (asideEl && asideEl.classList.contains('is-open') && !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    const hAfter = asideEl.getBoundingClientRect().height;
    if (Math.abs(hAfter - hBefore) > 1) {
      asideEl.animate(
        [{ height: `${hBefore}px` }, { height: `${hAfter}px` }],
        { duration: 220, easing: 'cubic-bezier(0.22, 0.8, 0.24, 1)' },
      );
    }
  }
}

// ---------- 交互 ----------

stage.onHover = (node, x, y) => {
  const tooltip = $('#tooltip');
  if (state.locked) {
    // 锁定态不展示任何设备/记忆悬浮数据（ghost 地球仪只表达「本机未初始化」）。
    tooltip.hidden = true;
    return;
  }
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
    <div class="tt-row">${node.blocked ? '已被我移出' : node.online ? '与我连接中' : '未连接'}</div>
    ${device && (device.sharesWithMe ?? []).length
      ? `<div class="tt-row">共同订阅：${escapeHtml((device.sharesWithMe ?? []).join(', ') || '—')}</div>`
      : ''}
  `;
};

stage.onSelect = (node) => {
  // 选中/取消时收起悬浮提示（避免被设备卡擦写边缘切断），移动鼠标后会重新出现
  $('#tooltip').hidden = true;
  if (state.locked) {
    // 锁定态星图仍可交互（探索感），但点星星/空白统一提示先初始化。
    showLockedToast();
    return;
  }
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
    blocked: node.blocked,
    subscriptions: [],
    sharesWithMe: [],
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
  const lockT = Math.min(1, elapsed / 0.40); // 仪器抽屉 v2：锁定提速（0.55→0.40）
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

  const rot = time * 0.85;
  const gap = Math.PI / 4.5;
  // 外锁定环（旋转双弧）——发光用「宽淡描边」替代 shadowBlur（Intel 核显上模糊描边是慢路径）
  ctx.lineWidth = 3;
  ctx.strokeStyle = `rgba(120, 255, 185, ${(alpha * 0.22).toFixed(3)})`;
  ctx.beginPath();
  ctx.arc(node.x, node.y, focus, rot, rot + Math.PI - gap);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(node.x, node.y, focus, rot + Math.PI, rot + 2 * Math.PI - gap);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = `rgba(120, 255, 185, ${alpha.toFixed(3)})`;
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
    // 发光 = 三档无模糊描边（shadowBlur 在核显上是慢路径）
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(70, 255, 160, 0.10)';
    trace();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(110, 255, 175, 0.20)';
    trace();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(150, 255, 200, 0.85)';
    trace();
    ctx.restore();

    // 折点节点
    if (routed && drawEase * total > Math.hypot(bendX - sx, cornerY - sy)) {
      ctx.save();
      const bendHalo = ctx.createRadialGradient(bendX, cornerY, 0, bendX, cornerY, 7);
      bendHalo.addColorStop(0, 'rgba(80, 255, 170, 0.5)');
      bendHalo.addColorStop(1, 'rgba(80, 255, 170, 0)');
      ctx.fillStyle = bendHalo;
      ctx.beginPath();
      ctx.arc(bendX, cornerY, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(160, 255, 205, 0.95)';
      ctx.beginPath();
      ctx.arc(bendX, cornerY, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // 角端接线端子 + 到位闪光
    if (drawT >= 1) {
      const arrive = elapsed - LINK_DONE;
      ctx.save();
      ctx.translate(cornerX, cornerY);
      const termHalo = ctx.createRadialGradient(0, 0, 0, 0, 0, 9);
      termHalo.addColorStop(0, 'rgba(80, 255, 170, 0.55)');
      termHalo.addColorStop(1, 'rgba(80, 255, 170, 0)');
      ctx.fillStyle = termHalo;
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = 'rgba(160, 255, 205, 0.95)';
      ctx.fillRect(-2.8, -2.8, 5.6, 5.6);
      ctx.restore();
      if (arrive < 0.34) {
        const k = arrive / 0.34;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(170, 255, 215, ${(0.85 * (1 - k)).toFixed(3)})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(cornerX, cornerY, 3 + k * 22, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
    // 数据脉冲（一次性，仪器抽屉 v2）：光束就位后一枚光点沿路径滑入接口
    const PULSE_START = LINK_DONE + 0.02;
    const PULSE_DUR = 0.28;
    if (elapsed >= PULSE_START && elapsed <= PULSE_START + PULSE_DUR) {
      const ptP = (elapsed - PULSE_START) / PULSE_DUR;
      const pe = 1 - Math.pow(1 - ptP, 2);
      let distLeft = total * pe;
      let px = pts[0].x;
      let py = pts[0].y;
      for (const seg of segs) {
        if (distLeft <= seg.len) {
          const t2 = seg.len === 0 ? 0 : distLeft / seg.len;
          px = seg.a.x + (seg.b.x - seg.a.x) * t2;
          py = seg.a.y + (seg.b.y - seg.a.y) * t2;
          break;
        }
        distLeft -= seg.len;
        px = seg.b.x;
        py = seg.b.y;
      }
      const fade = Math.sin(Math.PI * Math.min(1, Math.max(0, ptP)));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const pulseHalo = ctx.createRadialGradient(px, py, 0, px, py, 10);
      pulseHalo.addColorStop(0, `rgba(140, 255, 200, ${(0.5 * fade).toFixed(3)})`);
      pulseHalo.addColorStop(1, 'rgba(140, 255, 200, 0)');
      ctx.fillStyle = pulseHalo;
      ctx.beginPath();
      ctx.arc(px, py, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(200, 255, 227, ${(0.9 * fade).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(px, py, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
};

$('#view-nav').addEventListener('click', (event) => {
  const button = event.target.closest('.view-btn');
  if (!button) return;
  // P3：锁定态共享/记忆/审计禁用（aria-disabled + toast），星图始终可用。
  if (state.locked && button.dataset.view !== 'map') {
    showLockedToast();
    return;
  }
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
  $('#memories-view').hidden = view !== 'memories';
  $('#stage').style.visibility = view === 'map' ? 'visible' : 'hidden';
  // 走查修复：顶部「守护」气泡 /「需要注意」卡只属星图——切出视图即时隐藏
  //（此前仅在 3s 轮询里更新，切走后要滞留最多一个轮询周期才消失）
  renderOverlays();
  const asideEl = document.querySelector('.aside');
  if (asideEl) asideEl.classList.toggle('is-open', view === 'map' && Boolean(state.selected));
  // 设备卡空壳处理：面板视图（记忆共享/审计/记忆）整体隐藏右栏，窄屏不再占底部一行
  document.querySelector('.layout')?.classList.toggle('is-panel-view', view !== 'map');
  syncStageActivity();
}

// F-PERF-1：星图动画只在「星图视图且页面可见」时持有 rAF；其余一律挂起
function syncStageActivity() {
  stage.setPaused(document.hidden === true || state.view !== 'map');
}

document.addEventListener('visibilitychange', () => {
  syncStageActivity();
  if (document.hidden === true) {
    // 隐藏时断开 SSE：客户端不再被 2.5s 状态脉冲唤醒，守护侧的连接保活定时器也随之释放
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    return;
  }
  // 回到前台：重连 SSE 并立即补一次刷新（隐藏期间轮询与 SSE 脉冲均被闸门拦下）
  startEvents();
  scheduleRefresh();
});

$('#audit-filter-action').addEventListener('change', renderAudit);
$('#audit-filter-device').addEventListener('change', renderAudit);
$('#audit-filter-namespace').addEventListener('change', renderAudit);
$('#audit-filter-time')?.addEventListener('change', renderAudit);
$('#audit-list')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-copy-id]');
  if (button) void copyText(button.dataset.copyId, button);
});

$('#mem-filter-archived')?.addEventListener('change', (event) => {
  state.memoryFilters.archived = event.target.checked;
  void refresh();
});
$('#mem-filter-deleted')?.addEventListener('change', (event) => {
  state.memoryFilters.deleted = event.target.checked;
  void refresh();
});
$('#mem-filter-namespace')?.addEventListener('change', (event) => {
  state.memoryFilters.namespace = event.target.value;
  void refresh();
});
$('#mem-refresh')?.addEventListener('click', () => { void refresh(); });
$('#memories-list')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-mem-action]');
  if (!button) return;
  void memAction(button.dataset.memId, button.dataset.memAction);
});

// UX-2「需要注意」浮卡：点击直达处理位（助手 → 设置·AI 助手；对端 → 设备卡）
$('#attention-card')?.addEventListener('click', (event) => {
  const item = event.target.closest('[data-attention-action]');
  if (!item) return;
  if (item.dataset.attentionAction === 'assistants') {
    $('#settings').hidden = false;
    renderSettings('assistants');
  } else if (item.dataset.attentionAction === 'security' || item.dataset.attentionAction === 'security-approvals') {
    $('#settings').hidden = false;
    renderSettings('common');
    setTimeout(() => {
      const slot = $('#settings-security-slot');
      if (!slot) return;
      const target = item.dataset.attentionAction === 'security-approvals'
        ? slot.querySelector('[data-security-pending]')
        : slot;
      (target ?? slot).scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 0);
  } else if (item.dataset.attentionAction === 'device') {
    const deviceId = item.dataset.attentionId?.replace(/^dev-/, '') ?? '';
    if (deviceId) { state.selected = state.devices.find((d) => d.deviceId === deviceId) ?? null; render(); }
  }
});

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

async function handleDeviceAction(action, device) {
  if (action === 'goto-domains') {
    setView('domains');
    return;
  }
  if (action === 'sync') {
    const self = state.overview?.device?.deviceId;
    if (self) stage.launchFleet(self, device.deviceId, { kind: 'mine', ships: 3 });
    await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/sync`, {}, '已触发同步（有 pending 时立即开会话）');
  } else if (action === 'connect' || action === 'manual-connect') {
    // E1：网内传输修复（不改变入网信任与订阅）；Electron 无 window.prompt，统一走 App 内向导。
    openWizard({
      deviceId: device.deviceId,
      address: peerPathFor(device)?.address ?? '',
    });
  } else if (action === 'disconnect') {
    await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/disconnect`, {}, '已断开');
  } else if (action === 'reset-watermarks') {
    const ok = await confirmModal({
      title: '重置同步水位',
      body: `将清除与 ${device.deviceId} 的本机同步水位。已同步内容不会回撤；最多导致已确认事件冗余重发一次。`,
      confirmLabel: '重置',
    });
    if (ok) await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/reset-watermarks`, {}, '水位已重置');
  } else if (action === 'revoke-device') {
    await securityRevokeFlow(device);
  } else if (action === 'restore-device') {
    await securityRestoreFlow(device);
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
    showToast(successMessage);
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

/** P3：锁定态的统一 toast（星图/禁用导航/设备卡）。 */
function showLockedToast() {
  showToast('请先新建或加入忆云');
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

function settleConfirmModal(result) {
  $('#modal').hidden = true;
  if (modalResolve) modalResolve(result);
  modalResolve = null;
}

// ---------- 轮 C：弹层统一关闭规范（点空白 ∧ Esc；所有弹层一处实现） ----------
// 规则（危险语义明确）：
//  - 确认弹层：Esc / 点空白 = 「取消」（resolve false），永不等于确认；
//  - 首次上手 provision：不可关闭（必须先建新或加入）；
//  - 连接向导：连接 / 生成令牌在途时不可关闭，其余可关；
//  - 其余弹层（设置 / 关于 / 邀请 / 交接）：可关；设置即时写盘，无「未保存草稿」。
function visibleModalElements() {
  return [...document.querySelectorAll('.modal')].filter((el) => !el.hidden);
}

function topmostModal() {
  const modals = visibleModalElements();
  return modals.length > 0 ? modals[modals.length - 1] : null;
}

function modalCanDismiss(el) {
  if (!el || el.id === 'provision') return false;
  if (el.dataset.modalStatic === 'true') return false;
  if (el.id === 'wizard' && wizardState.connection === 'connecting') return false;
  // E2-A2：加入忆云提交中不可关闭（避免用户以为取消、实际仍完成切换）
  if (el.id === 'cloud-join' && cloudJoinBusy) return false;
  // P3：首启新建/加入提交中不可关闭（避免同一进程内并发初始化）
  if ((el.id === 'onboard-create' || el.id === 'onboard-join') && onboardBusy) return false;
  // S3：恢复码一次性展示期间不可关闭（必须先回执「我已抄写」）
  if (el.id === 'security-action' && state.securityFlow?.blockClose === true) return false;
  return true;
}

function dismissModal(el) {
  if (!el || !modalCanDismiss(el)) return false;
  if (el.id === 'modal') { settleConfirmModal(false); return true; }
  if (el.id === 'wizard') { closeWizard(); return true; }
  if (el.id === 'security-action') { closeSecurityAction(); return true; }
  if (el.id === 'auth-token') { settleAuthToken(null); return true; }
  el.hidden = true;
  if (el.id === 'handoff') {
    handoffNs = null;
    $('#handoff-result').hidden = true;
    $('#handoff-result').textContent = '';
  }
  if (el.id === 'invite') state.inviteToken = null;
  if (el.id === 'cloud-join') {
    state.cloudJoinInspect = null;
    state.cloudJoinResult = null;
    const input = $('#cloud-join-token');
    if (input) input.value = '';
  }
  return true;
}

// 点空白：按下与抬起都必须落在背板本身（防「弹层内按下、拖到外面松开」误关危险确认）。
let backdropPointerDownTarget = null;
document.addEventListener('pointerdown', (event) => { backdropPointerDownTarget = event.target; });
document.addEventListener('click', (event) => {
  const downTarget = backdropPointerDownTarget;
  backdropPointerDownTarget = null;
  if (downTarget !== event.target) return;
  if (!(event.target instanceof Element) || !event.target.classList.contains('modal')) return;
  if (topmostModal() !== event.target) return;
  dismissModal(event.target);
});

// Esc：只关最上层；in-progress 操作与引导态不响应（见 modalCanDismiss）。
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const modal = topmostModal();
  if (!modal || !modalCanDismiss(modal)) return;
  event.preventDefault();
  dismissModal(modal);
});

// 弹层打开时锁住页面滚动；任何弹层 hidden 变化都重新计算（覆盖所有既有 open/close 路径）。
function syncModalLock() {
  document.body.classList.toggle('modal-open', visibleModalElements().length > 0);
}
new MutationObserver(syncModalLock).observe(document.body, {
  subtree: true,
  attributes: true,
  attributeFilter: ['hidden'],
});
syncModalLock();

$('#modal-cancel').addEventListener('click', () => settleConfirmModal(false));
$('#modal-confirm').addEventListener('click', () => settleConfirmModal(true));
// bearer token：App 内输入（Electron 无 window.prompt）
$('#auth-token-save')?.addEventListener('click', submitAuthToken);
$('#auth-token-cancel')?.addEventListener('click', () => settleAuthToken(null));
$('#auth-token-input')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitAuthToken();
  }
});
// S3：安全操作弹层（确认 / 关闭 / 一次性恢复码回执）
$('#security-action-confirm')?.addEventListener('click', () => void securityConfirmHandler());
$('#security-action-close')?.addEventListener('click', () => {
  if (state.securityFlow?.blockClose === true) return;
  closeSecurityAction();
});
$('#security-action')?.addEventListener('click', (event) => {
  const recoverySwitch = event.target.closest('[data-security-recovery-switch]');
  if (recoverySwitch) {
    const handler = state.securityFlow?.recovery;
    if (typeof handler === 'function') {
      stopSecurityPoll();
      handler();
    }
    return;
  }
  const ack = event.target.closest('[data-security-ack]');
  if (ack) {
    closeSecurityAction();
    void refresh();
  }
});
$('#security-badge')?.addEventListener('click', () => {
  $('#settings').hidden = false;
  renderSettings('security');
  setTimeout(() => {
    const slot = $('#settings-security-slot');
    if (!slot) return;
    slot.scrollIntoView({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth' });
    slot.focus?.();
  }, 0);
});

$('#open-settings').addEventListener('click', () => {
  $('#settings').hidden = false;
  renderSettings(state.settingsTab ?? 'common');
});
// E2-A2：顶栏忆云徽章 → 设置 · 常用忆云卡；加入忆云 → 弹层。
// P3：锁定态顶栏改为「新建忆云 + 加入忆云」，分别走首启 create/join；READY 后加入仍用于多忆云。
$('#cloud-badge')?.addEventListener('click', () => openCloudSettings());
$('#join-cloud')?.addEventListener('click', () => {
  if (state.locked) openOnboardJoin();
  else openCloudJoin();
});
$('#create-cloud')?.addEventListener('click', () => {
  if (state.locked) openOnboardCreate();
});
$('#coach-create')?.addEventListener('click', () => {
  dismissOnboardingCoach();
  openOnboardCreate();
});
$('#coach-join')?.addEventListener('click', () => {
  dismissOnboardingCoach();
  openOnboardJoin();
});
$('#onboard-create-close')?.addEventListener('click', () => closeOnboardCreate());
$('#onboard-create-cancel')?.addEventListener('click', () => closeOnboardCreate());
$('#onboard-create-submit')?.addEventListener('click', () => { void submitOnboard('create'); });
$('#onboard-join-close')?.addEventListener('click', () => closeOnboardJoin());
$('#onboard-join-cancel')?.addEventListener('click', () => closeOnboardJoin());
$('#onboard-join-submit')?.addEventListener('click', () => { void submitOnboard('join'); });
$('#cloud-join-close')?.addEventListener('click', () => closeCloudJoin());
$('#cloud-switch-close')?.addEventListener('click', () => { $('#cloud-switch').hidden = true; });
$('#settings-close').addEventListener('click', () => {
  $('#settings').hidden = true;
});
// Tab 切换 + AI 助手专区动作（事件委托：renderSettings 会整体替换 body）
$('#settings-body').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-settings-tab]');
  if (tab) { renderSettings(tab.dataset.settingsTab); return; }
  // UX-2：附加导航「关于本机」→ 打开既有 about 弹层
  const extra = event.target.closest('[data-settings-extra]');
  if (extra) { $('#about').hidden = false; renderAbout(); return; }
  const svc = event.target.closest('[data-svc-action]');
  if (svc) { void serviceAction(svc.dataset.svcAction); return; }
  const cli = event.target.closest('[data-cli-action]');
  if (cli) { void clientAction(cli.dataset.cliId, cli.dataset.cliAction); return; }
  if (event.target.closest('#asst-add')) {
    state.addForm = state.addForm ? null : { edit: null };
    rerenderAssistants();
    return;
  }
  if (event.target.closest('#asst-add-submit')) { void assistantSubmitForm(); return; }
  if (event.target.closest('#asst-add-cancel')) { state.addForm = null; rerenderAssistants(); return; }
  const editBtn = event.target.closest('[data-asst-edit]');
  if (editBtn) { assistantStartEdit(editBtn.dataset.asstEdit); return; }
  const removeBtn = event.target.closest('[data-asst-remove]');
  if (removeBtn) { void assistantRemove(removeBtn.dataset.asstRemove); return; }
  // 表单内模式切换：选文件 ⇄ 粘片段（字段显隐，不重建整页）
  const modeRadio = event.target.closest('input[name="asst-mode"]');
  if (modeRadio) {
    const form = $('#asst-add-form');
    const fileMode = modeRadio.value === 'file';
    form?.querySelectorAll('.asst-mode-file').forEach((el) => { el.hidden = !fileMode; });
    form?.querySelectorAll('.asst-mode-snippet').forEach((el) => { el.hidden = fileMode; });
    return;
  }
  if (event.target.closest('#asst-missing-toggle')) {
    const missing = $('#asst-missing');
    if (missing) {
      missing.hidden = !missing.hidden;
      event.target.closest('#asst-missing-toggle').textContent = missing.hidden ? '展开 ›' : '收起 ‹';
    }
    return;
  }
  // E2-A2：忆云卡（切换 / 改名 / 保存 / 取消）
  const cloudSwitch = event.target.closest('[data-cloud-switch]');
  if (cloudSwitch) { void requestCloudSwitch(cloudSwitch.dataset.cloudSwitch); return; }
  const cloudRename = event.target.closest('[data-cloud-rename]');
  if (cloudRename) { startCloudRename(cloudRename.dataset.cloudRename); return; }
  if (event.target.closest('[data-cloud-rename-save]')) { void saveCloudRename(); return; }
  if (event.target.closest('[data-cloud-rename-cancel]')) {
    state.cloudRename = null;
    state.cloudRenameError = '';
    renderSettings(state.settingsTab ?? 'common');
    return;
  }
  // UX-2：重启向导（设置 · 常用；web 无 preload 桥时该按钮不渲染）
  if (event.target.closest('#settings-open-wizard')) {
    if (typeof window.mebularDesktop?.openWizard === 'function') void window.mebularDesktop.openWizard();
    return;
  }
  // E1：诊断内「手动连接已知设备」（网内传输修复，不改变入网信任）
  if (event.target.closest('#diag-open-wizard')) {
    openWizard();
    return;
  }
});
$('#settings-body').addEventListener('change', (event) => {
  const select = event.target.closest?.('[data-language-select]');
  if (!select) return;
  // 选择即生效：setLocale → onLocaleChange 重渲染当前页/已开设置与关于弹层；不 reload、不跳页。
  setLocale(select.value, { persist: true });
});
$('#settings-body').addEventListener('input', (event) => {
  if (event.target?.matches?.('[data-cloud-rename-input]')) {
    if (state.cloudRename) state.cloudRename.name = event.target.value;
    state.cloudRenameError = '';
  }
});
$('#self-badge').addEventListener('click', () => {
  $('#about').hidden = false;
  renderAbout();
});
$('#about-close').addEventListener('click', () => {
  $('#about').hidden = true;
});
$('#about-body').addEventListener('click', (event) => {
  if (event.target.closest('[data-device-rename]')) { startDeviceRename(); return; }
  if (event.target.closest('[data-device-rename-save]')) { void saveDeviceRename(); return; }
  if (event.target.closest('[data-device-rename-cancel]')) {
    state.deviceRename = null;
    state.deviceRenameError = '';
    renderAbout();
  }
});
$('#about-body').addEventListener('input', (event) => {
  if (event.target?.matches?.('[data-device-rename-input]') && state.deviceRename) {
    state.deviceRename.name = event.target.value;
    state.deviceRenameError = '';
  }
});
$('#about-to-diagnostics').addEventListener('click', () => {
  $('#about').hidden = true;
  $('#settings').hidden = false;
  renderSettings('advanced'); // 简化轮：诊断并入高级
  setTimeout(() => { const fold = $('#diag-fold'); if (fold) fold.open = true; }, 0);
});
$('#handoff-close').addEventListener('click', () => {
  $('#handoff').hidden = true;
  handoffNs = null;
});
$('#handoff-plan').addEventListener('click', runHandoffPlan);
$('#handoff-confirm').addEventListener('click', confirmHandoff);

// ---------- 邀请设备（T2 令牌加入：主密钥不复制） ----------

function clearInviteBusy() {
  const body = $('#invite-body');
  if (!body) return;
  body.classList.remove('is-busy');
  body.removeAttribute('aria-busy');
}

/** 首次打开的稳定骨架：QR 占位 + 多行占位，高度与结果面板近似，避免弹框先小后大。 */
function inviteSkeletonHtml() {
  return `
    <div class="invite-layout is-skeleton" aria-hidden="true">
      <div class="invite-qr"><div class="invite-skeleton-qr"></div></div>
      <div class="invite-main">
        <p class="invite-skeleton-line invite-skeleton-line-lg"></p>
        <div class="invite-token-block">
          <span class="invite-label">一次性令牌</span>
          <p class="invite-skeleton-line invite-skeleton-code"></p>
          <p class="invite-skeleton-line invite-skeleton-copy"></p>
        </div>
        <div class="invite-controls invite-skeleton-controls">
          <span class="invite-skeleton-line invite-skeleton-ttl"></span>
          <span class="invite-skeleton-line invite-skeleton-expiry"></span>
          <span class="invite-skeleton-line invite-skeleton-regen"></span>
        </div>
      </div>
    </div>
    <div class="invite-foot" aria-hidden="true">
      <p class="invite-skeleton-line invite-skeleton-line-sm"></p>
      <p class="invite-safety">一次性 · 仅当面或可信局域网传递。换新令牌后旧的立即失效，已发出的邀请将无法再兑换。</p>
    </div>
    <p class="invite-loading-note muted" role="status">正在生成令牌…</p>
  `;
}

async function openInvite(ttlMs = state.inviteTtlMs) {
  const selectedTtl = INVITE_TTL_OPTIONS.some((option) => option.ttlMs === ttlMs)
    ? ttlMs
    : INVITE_TTL_DEFAULT_MS;
  state.inviteTtlMs = selectedTtl;
  const level = state.security?.level ?? 'low';
  if (level === 'medium') {
    securityCodeModal({
      title: '邀请设备 · 动态码',
      intro: '中档在生成一次性令牌前需要输入本机 6 位动态码。',
      confirmLabel: '验证并生成令牌',
      onSubmit: async (code) => {
        const res = await api('/admin/api/invite', { method: 'POST', body: { code, ttlMs: selectedTtl } });
        closeSecurityAction();
        showInviteResult(res);
      },
    });
    return;
  }
  if (level === 'high') {
    try {
      await securityStartApproval({
        title: '邀请设备 · 设备会签',
        op: 'join',
        intro: '高档不是立刻出令牌：先在另一台已准入设备上核对配对号并批准，批准后本机自动出令牌/二维码。',
        onApproved: async (approvalId) => {
          const res = await api('/admin/api/invite', {
            method: 'POST',
            body: { approvalId, namespace: inviteNamespace(), ttlMs: selectedTtl },
          });
          closeSecurityAction();
          showInviteResult(res);
        },
      });
    } catch (error) {
      showToast(`发起会签失败：${error.message}`);
    }
    return;
  }
  $('#invite').hidden = false;
  await renderInvite(selectedTtl);
}

/**
 * 生成/刷新令牌。
 * - 首次打开（或没有可保留的结果面板）：先渲染稳定骨架；
 * - 重新生成（keepPanel=true）：不替换现有结果 DOM，只标记 is-busy/aria-busy 并禁用按钮；
 *   成功后原地替换结果，失败保留旧面板并给 inline 错误。
 */
async function renderInvite(ttlMs = state.inviteTtlMs, { keepPanel = false } = {}) {
  const body = $('#invite-body');
  const canKeep = keepPanel && Boolean(body?.querySelector('.invite-layout'));
  $('#invite').hidden = false;
  let button = null;
  let ttlSelect = null;
  if (canKeep) {
    body.classList.add('is-busy');
    body.setAttribute('aria-busy', 'true');
    button = body.querySelector('#invite-regenerate');
    if (button) {
      button.disabled = true;
      button.dataset.label = button.textContent;
      button.textContent = '正在更新…';
    }
    ttlSelect = body.querySelector('#invite-ttl');
    if (ttlSelect) ttlSelect.disabled = true;
    const regenError = body.querySelector('#invite-regen-error');
    if (regenError) {
      regenError.hidden = true;
      regenError.textContent = '';
    }
  } else {
    clearInviteBusy();
    body.innerHTML = inviteSkeletonHtml();
  }
  try {
    const res = await api('/admin/api/invite', {
      method: 'POST',
      body: { ttlMs },
    });
    showInviteResult(res);
    if (canKeep) showToast('已重新生成，旧令牌已失效');
  } catch (error) {
    if (!canKeep) {
      showInviteError(error);
      return;
    }
    clearInviteBusy();
    if (button) {
      button.disabled = false;
      button.textContent = button.dataset.label ?? '重新生成';
      delete button.dataset.label;
    }
    if (ttlSelect) ttlSelect.disabled = false;
    const regenError = body.querySelector('#invite-regen-error');
    if (regenError) {
      regenError.textContent = `重新生成失败：${error.message}。仍显示上一个令牌。`;
      regenError.hidden = false;
    } else {
      showToast(`重新生成失败：${error.message}`);
    }
  }
}

/** joinService 未启用：弹层内就地启用（复用设置写路径；写后自动重启，前台则给一键重启/重试）。 */
async function inviteEnableJoinService(button) {
  if (MOCK) { showToast('mock 模式不执行写操作。'); return; }
  const body = $('#invite-body');
  clearInviteBusy();
  const field = fieldOf('joinService.enabled');
  if (button) {
    button.disabled = true;
    button.textContent = '正在启用…';
  }
  body.innerHTML = '<p class="muted">正在启用加入服务并写入配置…将重启守护；恢复后会自动继续生成令牌。</p>';
  await applyConfigField(field, true);
  if (state.settings?.join?.enabled === true) {
    await renderInvite();
    return;
  }
  if (state.rawConfig?.config?.joinService?.enabled === true) {
    showInvitePendingRestart();
    return;
  }
  const writesAllowed = Boolean(state.features?.writes) && !MOCK;
  body.innerHTML = `
    <p class="crt-warn">没能写入加入服务配置。</p>
    <p class="cfg-help muted">${writesAllowed ? '请重试；若持续失败，检查 config.json 写权限或守护日志。' : '当前控制台为只读模式，需要 memory.admin 写权限。'}</p>
    <div class="domain-actions"><button id="invite-enable-retry" class="btn btn-small btn-crt" type="button" ${writesAllowed ? '' : 'disabled'}>重试</button></div>
  `;
  body.querySelector('#invite-enable-retry')?.addEventListener('click', (event) => {
    void inviteEnableJoinService(event.currentTarget);
  });
}

/** 配置已写入但当前实例未重启：给出既有「一键重启」与「重试」两条路。 */
function showInvitePendingRestart() {
  const body = $('#invite-body');
  clearInviteBusy();
  const pending = pendingRestartItems().some((item) => item.path === 'joinService.enabled');
  const writes = state.features?.writes && !MOCK;
  body.innerHTML = `
    <p class="modal-note muted">加入服务已写入配置${pending ? '，但当前实例还未重启（待重启）' : '，守护正在重启'}。</p>
    <p class="cfg-help muted">重启后守护会读取新配置；点「重试生成」即可直接出令牌与二维码。</p>
    <div class="domain-actions">
      <button class="btn btn-small btn-crt" id="invite-restart-service" type="button" ${writes ? '' : 'disabled'}>一键重启并继续</button>
      <button class="btn btn-small btn-crt" id="invite-retry" type="button">重试生成</button>
    </div>
  `;
  body.querySelector('#invite-retry')?.addEventListener('click', () => void renderInvite());
  body.querySelector('#invite-restart-service')?.addEventListener('click', async () => {
    await restartServeFromUi();
    if (state.settings?.join?.enabled === true) await renderInvite();
    else showInvitePendingRestart();
  });
}

function showInviteError(error) {
  const body = $('#invite-body');
  state.inviteToken = null;
  clearInviteBusy();
  $('#invite').hidden = false;
  if (error.payload?.error === 'join_disabled' || error.status === 409) {
    const writes = state.features?.writes && !MOCK;
    body.innerHTML = `
      <p class="modal-note muted">加入服务未启用：启用后即可在新设备上兑换一次性令牌（主密钥不复制，默认 15 分钟有效）。</p>
      <div class="domain-actions">
        <button id="invite-enable-service" class="btn btn-small btn-crt" type="button" ${writes ? '' : 'disabled'}>一键启用并继续</button>
      </div>
      <p class="cfg-help muted">将写入 joinService.enabled=true 并重启守护（服务托管时自动重启；前台运行时按提示手动重启）。</p>
    `;
    body.querySelector('#invite-enable-service')?.addEventListener('click', (event) => {
      void inviteEnableJoinService(event.currentTarget);
    });
  } else {
    body.innerHTML = `<p class="crt-warn">生成失败：${escapeHtml(error.message)}</p>`;
  }
}

/**
 * 令牌短指纹（FNV-1a 32-bit → 8 位十六进制）：只用于人眼核对「是否换了一枚令牌」，
 * 不是安全摘要，也不回显完整令牌。同一令牌稳定、不同令牌几乎必然不同。
 */
function inviteTokenFingerprint(token) {
  let hash = 2166136261;
  const text = String(token ?? '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 邀请有效期文案：当前 TTL = 已出令牌 TTL 时显示现令牌到期；改档后显示预估的「重新生成后至」。 */
function inviteExpiryLabel(ttlMs = state.inviteTtlMs) {
  const current = state.inviteToken;
  if (current && current.expiresAt && Number(current.ttlMs) === Number(ttlMs)) {
    return `当前令牌至 ${formatClock(current.expiresAt)}`;
  }
  return `重新生成后至 ${formatClock(Date.now() + ttlMs)}`;
}

/** 令牌结果面板（low 直接出；medium/high 门槛通过后复用同一面板）。 */
function showInviteResult(res) {
  const body = $('#invite-body');
  state.inviteToken = res;
  clearInviteBusy();
  $('#invite').hidden = false;
  // 令牌很长：显示截断，复制按钮携带完整值
  const shortToken = res.token.length > 40 ? `${res.token.slice(0, 24)}…${res.token.slice(-8)}` : res.token;
  // 截断后新旧令牌肉眼几乎一样（nonce 在中间）；短指纹让人一眼确认「已换新」。
  const tokenFingerprint = inviteTokenFingerprint(res.token);
  // C7：二维码（服务端用 qrcode-generator 渲染 SVG → data-uri；编码失败为 null → 只显示文本）
  const qrMarkup = res.qrSvg
    ? `<img class="qr-img" alt="邀请令牌二维码" src="data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(res.qrSvg)))}" />`
    : '<p class="cfg-help muted invite-qr-fallback">二维码不可用，请复制令牌。</p>';
  // E2-A2：邀请方忆云名 + 根指纹取 overview.cloud（加入方核对指纹的唯一可靠来源）。
  const cloud = state.overview?.cloud ?? null;
  const cloudLine = cloud?.name
    ? `<p class="cfg-help muted invite-cloud-line" id="invite-cloud-identity"><b>${escapeHtml(cloud.name)}</b> · 根指纹 ${cloud.masterFingerprint ? `<code>${escapeHtml(cloud.masterFingerprint)}</code>` : '<span class="kv-empty">未知</span>'}</p>`
    : '';
  const selectedTtl = INVITE_TTL_OPTIONS.some((option) => option.ttlMs === res.ttlMs)
    ? res.ttlMs
    : state.inviteTtlMs;
  state.inviteTtlMs = selectedTtl;
  const ttlOptions = INVITE_TTL_OPTIONS.map((option) => (
    `<option value="${option.ttlMs}"${option.ttlMs === selectedTtl ? ' selected' : ''}>${escapeHtml(option.label)}</option>`
  )).join('');
  // endpoint 回环/非法与会签批准都只留一条短警告（长说明归设置页）。
  const warnings = [];
  if (res.warning) {
    if (/回环/.test(res.warning)) warnings.push('端点仅本机可达：把 joinService.bind 设为 0.0.0.0 后重新生成。');
    else if (/不是有效地址/.test(res.warning)) warnings.push('端点地址无效：请在「设置 → 高级」检查加入服务。');
    else warnings.push('端点不可达：请检查加入服务设置。');
  }
  if (res.securityApproval) warnings.push('已带上会签批准。');
  const warningLine = warnings.length > 0
    ? `<p class="crt-warn invite-warning">⚠ ${escapeHtml(warnings.join(' '))}</p>`
    : '';
  // 两栏：左 QR，右引导 + 令牌 + TTL；窄屏自动堆叠（见 console.css）。
  body.innerHTML = `
    <div class="invite-layout">
      <div class="invite-qr">${qrMarkup}</div>
      <div class="invite-main">
        <p class="invite-lead">扫码加入，或复制令牌发给对方。</p>
        <div class="invite-token-block">
          <div class="invite-token-head">
            <span class="invite-label">一次性令牌</span>
            <span class="invite-fingerprint" id="invite-token-fingerprint" title="令牌指纹：换新令牌后编号会变">令牌 #${tokenFingerprint}</span>
          </div>
          <code class="invite-token-code">${escapeHtml(shortToken)}</code>
          <button class="btn btn-small btn-primary invite-copy" data-copy="${escapeHtml(res.token)}" title="复制完整令牌">复制令牌</button>
        </div>
        <div class="invite-controls">
          <label class="invite-ttl" for="invite-ttl"><span class="invite-label">有效期</span>
            <select id="invite-ttl" class="crt-input">${ttlOptions}</select>
          </label>
          <span class="invite-expiry" id="invite-expiry">${escapeHtml(inviteExpiryLabel(selectedTtl))}</span>
          <button class="btn btn-small invite-regenerate" id="invite-regenerate" type="button">重新生成</button>
        </div>
        ${warningLine}
        <p class="invite-regen-error crt-warn" id="invite-regen-error" role="alert" hidden></p>
      </div>
    </div>
    <div class="invite-foot">
      ${cloudLine}
      <p class="invite-safety">一次性 · 仅当面或可信局域网传递。换新令牌后旧的立即失效，已发出的邀请将无法再兑换。</p>
    </div>
  `;
  body.querySelector('#invite-ttl')?.addEventListener('change', (event) => {
    const value = Number(event.currentTarget.value);
    if (!INVITE_TTL_OPTIONS.some((option) => option.ttlMs === value)) return;
    state.inviteTtlMs = value;
    const expiry = body.querySelector('#invite-expiry');
    if (expiry) expiry.textContent = inviteExpiryLabel(value);
  });
  body.querySelector('#invite-regenerate')?.addEventListener('click', () => {
    // 不再二次确认：点击即生成新令牌；旧令牌由服务端 activateJoinInvite 立即撤销。
    void renderInvite(state.inviteTtlMs, { keepPanel: true });
  });
  body.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => copyText(button.dataset.copy, button));
  });
}

$('#invite-device').addEventListener('click', () => {
  state.inviteTtlMs = INVITE_TTL_DEFAULT_MS;
  void openInvite();
});
// 共享页只做域管理：唯一入口 = 新建记忆域；邀请只在顶栏。
$('#namespace-new')?.addEventListener('click', openNamespaceNew);
$('#namespace-new-cancel')?.addEventListener('click', closeNamespaceNew);
$('#namespace-new-create')?.addEventListener('click', submitNamespaceNew);
$('#namespace-new-name')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitNamespaceNew();
  }
});
$('#namespace-new-modal')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeNamespaceNew();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('#namespace-new-modal')?.hidden === false) {
    event.preventDefault();
    closeNamespaceNew();
  }
});
$('#invite-close').addEventListener('click', () => {
  $('#invite').hidden = true;
  state.inviteToken = null;
});

// ---------- E2-A2 · 忆云（加入 / 切换 / 改名 / 设置卡） ----------
// 只读列表来自 /admin/api/clouds；加入走当前守护的准备端点，切换由桌面 App 的
// cloudSwitch 桥执行（Web-only 显示 `mebular cloud use <id>` 兜底，绝不假装已切换）。

let cloudJoinBusy = false;
let cloudInspectSeq = 0;
let cloudInspectTimer = null;
let cloudRenameBusy = false;

function hasCloudSwitchBridge() {
  return typeof window.mebularDesktop?.cloudSwitch === 'function';
}

function cloudCurrentName() {
  return state.overview?.cloud?.name
    ?? state.clouds?.profiles?.find((entry) => entry.current)?.name
    ?? '当前忆云';
}

function cloudNameOf(id) {
  return state.clouds?.profiles?.find((entry) => entry.id === id)?.name ?? id;
}

/** 新忆云默认名：未占用的最小整数 N >= 1 → 忆云 N（首启默认 忆云 1；多忆云顺延）。 */
function nextCloudName() {
  const names = new Set((state.clouds?.profiles ?? [])
    .map((entry) => String(entry.name ?? '').trim().toLocaleLowerCase()));
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `忆云 ${n}`;
    if (!names.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return `忆云 ${Date.now()}`;
}

function cloudErrorCopy(error) {
  const code = typeof error === 'string' ? error : error?.payload?.error;
  const server = typeof error === 'string' ? '' : (error?.payload?.message ?? error?.message ?? '');
  const titles = {
    TOKEN_REQUIRED: '请先粘贴加入令牌。',
    TOKEN_INVALID: '令牌格式不对，请让邀请方重新生成。',
    TOKEN_EXPIRED: '令牌已过期，请让邀请方重新生成。',
    TOKEN_REJECTED: '令牌已失效或已被使用，请让邀请方重新生成。',
    CONFIRMATION_REQUIRED: '需要确认后才能加入。',
    INVALID_NAME: '忆云名字需为 1–24 个字符，且不能包含 /、\\ 或 ..。',
    NAME_TAKEN: '已有同名忆云，请换一个名字。',
    CLOUD_ARCHIVED: '归档忆云不支持改名；请先切换到该忆云后再改。',
    CLOUD_BLOCKED: '本机已被移出当前忆云，不能改名。',
    PROFILE_NOT_FOUND: '未找到这个忆云；列表可能已变化，请刷新后重试。',
    PROFILE_JOIN_FAILED: '本机无法创建忆云；令牌可能已在对方处兑换，请让邀请方重新生成。',
    ENDPOINT_UNREACHABLE: '连不上邀请方：确认对方守护在运行、地址可达，然后重试。',
    CLOUD_ALREADY_JOINED: '这台设备已加入该忆云，可直接切换。',
    CLOUD_DISABLED: '当前为自定义 home 或受限环境，忆云管理不可用；当前忆云未变。',
    CLOUD_UNAVAILABLE: '当前为自定义 home 或受限环境，忆云管理不可用；当前忆云未变。',
    CLOUD_UNSUPPORTED: '当前守护不支持忆云管理，请升级 Mebular；当前忆云不受影响。',
    CLOUD_LIST_FAILED: '忆云列表读取失败；当前忆云未变，请稍后重试。',
    CLOUD_REGISTRY_INVALID: '忆云列表无法读取（注册表损坏）；当前忆云未变，请先修复注册表。',
    CLOUD_REGISTRY_LOCKED: '忆云列表正被其他进程写入，请稍后重试。',
    CLOUD_PROFILE_PATH_INVALID: '忆云目录越界，已拒绝操作；当前忆云未变。',
  };
  return {
    title: titles[code] ?? (server || '操作失败，请稍后重试。'),
    detail: titles[code] && server ? server : '',
  };
}

function cloudRowHtml(entry) {
  const id = escapeHtml(entry.id);
  const current = entry.current === true;
  const renaming = state.cloudRename?.id === entry.id;
  const duplicate = entry.duplicateName === true;
  const suggested = entry.suggestedRename === true;
  const fingerprint = entry.masterFingerprint
    ? `<code>${escapeHtml(entry.masterFingerprint)}</code>`
    : '<span class="kv-empty">未知（需要修复）</span>';
  const lastUsed = entry.lastUsedAt ? formatTime(entry.lastUsedAt) : '—';
  const conflictBadges = duplicate
    ? `<span class="badge badge-warn cloud-dup-badge">重名</span>${suggested ? '<span class="badge badge-warn cloud-suggest-badge">最近更新 · 建议改名</span>' : ''}`
    : '';
  // 第一版：只有当前忆云能写网络级名字；归档项提示切换后再改。
  const renameUi = current
    ? (renaming
      ? `<input class="crt-input cloud-rename-input" data-cloud-rename-input type="text" maxlength="24"
           value="${escapeHtml(state.cloudRename?.name ?? entry.name)}" aria-label="忆云名字" />
         <button class="btn btn-small btn-crt" data-cloud-rename-save type="button" ${cloudRenameBusy ? 'disabled' : ''}>保存</button>
         <button class="btn btn-small" data-cloud-rename-cancel type="button">取消</button>`
      : `<button class="btn btn-small btn-crt" data-cloud-rename="${id}" type="button">改名</button>`)
    : `<button class="btn btn-small btn-crt btn-crt-danger" data-cloud-switch="${id}" type="button">切换</button>
       <span class="cloud-rename-hint muted">切换到该忆云后可改名</span>`;
  return `<div class="cloud-row${current ? ' is-current' : ''}${duplicate ? ' is-duplicate' : ''}" data-cloud-row="${id}">
    <div class="cloud-main">
      <span class="cloud-name">${escapeHtml(entry.name)}</span>
      <span class="badge ${current ? 'badge-ok' : 'badge-muted'}">${current ? '当前' : '已归档'}</span>
      ${conflictBadges}
    </div>
    <div class="cloud-meta">
      <span>根指纹 ${fingerprint}</span>
      <span>最近使用 ${escapeHtml(lastUsed)}</span>
      ${entry.nameUpdatedAt ? `<span>名字更新 ${escapeHtml(formatTime(entry.nameUpdatedAt))}</span>` : ''}
    </div>
    <div class="cloud-actions">${renameUi}</div>
    ${current ? '<p class="cfg-help muted cloud-rename-note">改名会同步到所有设备（不改根指纹/信任）。</p>' : ''}
    ${renaming && state.cloudRenameError ? `<p class="crt-warn cloud-rename-error" role="alert">${escapeHtml(state.cloudRenameError)}</p>` : ''}
  </div>`;
}

/** 设置 · 常用：忆云卡（E1 只读状态/动作行之后；不提供删除入口）。 */
function cloudCardHtml() {
  let body;
  if (state.clouds) {
    const rows = (state.clouds.profiles ?? []).map(cloudRowHtml).join('');
    body = `${state.clouds.warning ? `<p class="crt-warn">${escapeHtml(state.clouds.warning)}</p>` : ''}
      <div class="cloud-rows">${rows || '<p class="muted">还没有忆云记录。</p>'}</div>
      <p class="cfg-help muted">当前忆云不可切换；已归档忆云切换前会确认。改名会同步到所有设备，不需要重启；已归档忆云需切换后再改名。</p>
      ${state.clouds.nameConflicts?.currentDuplicate
        ? '<p class="crt-warn">本机有同名忆云：当前忆云已加警告点。请给「最近更新 · 建议改名」的那一项换一个名字。</p>'
        : ''}`;
  } else if (state.cloudsError) {
    const { title, detail } = cloudErrorCopy(state.cloudsError);
    body = `<p class="cloud-unavailable">${escapeHtml(title)}</p>${detail ? `<p class="cfg-help muted">${escapeHtml(detail)}</p>` : ''}`;
  } else {
    body = '<p class="muted">正在读取忆云…</p>';
  }
  return `<section id="settings-cloud-card" class="settings-section cloud-card" data-settings-clouds tabindex="-1">
    <h3>忆云 <span class="badge badge-muted">归档保留，不删除</span></h3>
    <p class="muted cloud-intro">加入忆云不会修改当前忆云；切换后原忆云归档保留，随时可以切回。</p>
    ${body}
  </section>`;
}

function openCloudSettings() {
  $('#settings').hidden = false;
  renderSettings('common');
  setTimeout(() => {
    const card = $('#settings-cloud-card');
    if (!card) return;
    card.scrollIntoView({
      block: 'start',
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth',
    });
    card.focus?.({ preventScroll: true });
  }, 0);
}

function startCloudRename(id) {
  const entry = state.clouds?.profiles?.find((item) => item.id === id);
  if (!entry) return;
  if (!entry.current) {
    showToast('归档忆云不支持改名；请切换到该忆云后再改。');
    return;
  }
  state.cloudRename = { id, name: entry.name };
  state.cloudRenameError = '';
  renderSettings(state.settingsTab ?? 'common');
  setTimeout(() => {
    const input = document.querySelector('[data-cloud-rename-input]');
    if (!input) return;
    input.focus?.();
    input.select?.();
  }, 0);
}

async function saveCloudRename() {
  if (cloudRenameBusy || !state.cloudRename) return;
  const { id } = state.cloudRename;
  const name = String(state.cloudRename.name ?? '').trim();
  if (name.length === 0) {
    state.cloudRenameError = '忆云名字不能为空。';
    renderSettings(state.settingsTab ?? 'common');
    return;
  }
  cloudRenameBusy = true;
  state.cloudRenameError = '';
  renderSettings(state.settingsTab ?? 'common');
  try {
    await api('/admin/api/clouds/rename', { method: 'POST', body: { id, name } });
    state.cloudRename = null;
    state.cloudRenameError = '';
    await refresh();
    showToast(`已改名为「${name}」；不需要重启。`);
  } catch (error) {
    const { title, detail } = cloudErrorCopy(error);
    state.cloudRenameError = detail ? `${title}（${detail}）` : title;
  } finally {
    cloudRenameBusy = false;
    renderSettings(state.settingsTab ?? 'common');
  }
}

function cloudSwitchCommand(id) {
  return `mebular cloud use ${id}`;
}

function cloudSwitchFallbackHtml(id, name, reason = '') {
  const current = cloudCurrentName();
  const command = cloudSwitchCommand(id);
  return `${reason ? `<p class="cloud-switch-error" role="alert">${escapeHtml(reason)}</p>` : ''}
    <p class="muted">当前页面无法直接切换忆云（不在桌面 App 中）。当前忆云仍是「${escapeHtml(current)}」，不会自动变化。</p>
    <p class="cloud-warning">在终端运行下面的命令后，才会切换到「${escapeHtml(name)}」；原忆云归档保留，不删除。</p>
    <div class="copyable"><code>${escapeHtml(command)}</code><button class="btn btn-small btn-crt" type="button" data-copy="${escapeHtml(command)}">复制</button></div>`;
}

function bindCloudCopy(root) {
  root?.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => copyText(button.dataset.copy, button));
  });
}

function openCloudSwitch(id, name = cloudNameOf(id)) {
  const modal = $('#cloud-switch');
  const body = $('#cloud-switch-body');
  if (!modal || !body) return;
  $('#cloud-switch-title').textContent = `切换到「${name}」`;
  if (state.clouds?.current === id) {
    body.innerHTML = `<p class="cloud-switch-ok">「${escapeHtml(name)}」已经是当前忆云，无需切换。</p>`;
    modal.hidden = false;
    return;
  }
  if (hasCloudSwitchBridge()) {
    body.innerHTML = `<p class="cloud-switch-progress" aria-live="polite">正在切换忆云…</p>
      <p class="muted">当前忆云「${escapeHtml(cloudCurrentName())}」将归档保留，不删除；完成后控制台会自动刷新。</p>`;
  } else {
    body.innerHTML = cloudSwitchFallbackHtml(id, name);
    bindCloudCopy(body);
  }
  modal.hidden = false;
  if (hasCloudSwitchBridge()) void performCloudSwitch(id, name);
}

async function performCloudSwitch(id, name = cloudNameOf(id)) {
  const body = $('#cloud-switch-body');
  try {
    await window.mebularDesktop.cloudSwitch(id);
    if (body && $('#cloud-switch')?.hidden === false) {
      body.innerHTML = `<p class="cloud-switch-ok" aria-live="polite">已提交切换到「${escapeHtml(name)}」。</p>
        <p class="muted">App 完成切换后控制台会自动刷新；若仍显示旧忆云，请稍后重试。</p>`;
    }
    const joinError = $('#cloud-join-switch-error');
    if (joinError) joinError.innerHTML = `<p class="cloud-switch-ok">已提交切换；App 完成后控制台会自动刷新。</p>`;
    setTimeout(() => { if (!MOCK) void refresh(); }, 1500);
    return true;
  } catch (error) {
    const reason = `无法自动切换：${error?.message ?? error}`;
    if (body && $('#cloud-switch')?.hidden === false) {
      body.innerHTML = cloudSwitchFallbackHtml(id, name, reason);
      bindCloudCopy(body);
    }
    const joinError = $('#cloud-join-switch-error');
    if (joinError) {
      const command = cloudSwitchCommand(id);
      joinError.innerHTML = `<p class="cloud-switch-error" role="alert">${escapeHtml(reason)}</p>
        <p class="cfg-help muted">可复制命令后在终端切换；当前忆云未变。</p>
        <div class="copyable"><code>${escapeHtml(command)}</code><button class="btn btn-small btn-crt" type="button" data-copy="${escapeHtml(command)}">复制</button></div>`;
      bindCloudCopy(joinError);
    }
    return false;
  }
}

async function requestCloudSwitch(id) {
  const entry = state.clouds?.profiles?.find((item) => item.id === id);
  if (!entry) return;
  if (entry.current) { showToast('这已经是当前忆云。'); return; }
  const ok = await confirmModal({
    title: '切换忆云',
    body: `切换到「${entry.name}」？\n\n当前忆云「${cloudCurrentName()}」将归档保留，不删除；随时可以切回。`,
    confirmLabel: `切换到「${entry.name}」`,
  });
  if (!ok) return;
  openCloudSwitch(entry.id, entry.name);
}

function updateCloudJoinWarning() {
  const el = $('#cloud-join-warning');
  if (!el) return;
  const current = cloudCurrentName();
  el.textContent = hasCloudSwitchBridge()
    ? `加入后切换到新忆云；当前忆云「${current}」归档保留。`
    : `加入后仍需按提示切换；当前忆云「${current}」归档保留。`;
}

/** 首轮数据晚于弹层打开时，补齐当前忆云名与默认名字（用户已编辑则不改名）。 */
function syncCloudJoinMeta() {
  if ($('#cloud-join')?.hidden !== false) return;
  updateCloudJoinWarning();
  if (state.cloudJoinNameAuto) {
    const input = $('#cloud-join-name');
    if (input) input.value = nextCloudName();
  }
  updateCloudJoinSubmitState();
}

function updateCloudJoinSubmitState() {
  const button = $('#cloud-join-submit');
  if (!button) return;
  const cancel = $('#cloud-join-close');
  if (cancel) {
    cancel.hidden = Boolean(state.cloudJoinResult);
    cancel.disabled = cloudJoinBusy;
  }
  const duplicate = state.cloudJoinInspect?.data?.alreadyJoined ?? null;
  if (state.cloudJoinResult) {
    button.disabled = false;
    button.textContent = '关闭';
    return;
  }
  button.disabled = cloudJoinBusy;
  if (cloudJoinBusy) button.textContent = '正在加入…';
  else if (duplicate) button.textContent = `切换到「${duplicate.name}」`;
  else button.textContent = hasCloudSwitchBridge() ? '归档当前并加入' : '加入忆云';
}

function resetCloudJoin() {
  cloudInspectSeq += 1;
  if (cloudInspectTimer) clearTimeout(cloudInspectTimer);
  cloudInspectTimer = null;
  state.cloudJoinInspect = null;
  state.cloudJoinResult = null;
  const token = $('#cloud-join-token');
  if (token) token.value = '';
  const inspect = $('#cloud-join-inspect');
  if (inspect) { inspect.innerHTML = ''; inspect.hidden = true; }
  const error = $('#cloud-join-error');
  if (error) { error.hidden = true; error.innerHTML = ''; }
  const steps = $('#cloud-join-steps');
  if (steps) { steps.hidden = true; steps.textContent = ''; }
  const result = $('#cloud-join-result');
  if (result) { result.hidden = true; result.innerHTML = ''; }
  state.cloudJoinNameAuto = true;
  const name = $('#cloud-join-name');
  if (name) name.value = nextCloudName();
  updateCloudJoinWarning();
  updateCloudJoinSubmitState();
}

function openCloudJoin() {
  resetCloudJoin();
  const modal = $('#cloud-join');
  if (modal) modal.hidden = false;
  setTimeout(() => $('#cloud-join-token')?.focus?.(), 0);
}

function closeCloudJoin() {
  if (cloudJoinBusy) return;
  const modal = $('#cloud-join');
  if (modal) modal.hidden = true;
  resetCloudJoin();
}

function cloudJoinStep(text) {
  const el = $('#cloud-join-steps');
  if (!el) return;
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = text;
}

function showCloudJoinError(error) {
  const el = $('#cloud-join-error');
  const { title, detail } = cloudErrorCopy(error);
  if (!el) return;
  const steps = $('#cloud-join-steps');
  if (steps) { steps.hidden = true; steps.textContent = ''; }
  const result = $('#cloud-join-result');
  if (result) result.hidden = true;
  el.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? `<span class="cloud-error-detail">${escapeHtml(detail)}</span>` : ''}`;
  el.hidden = false;
}

function renderCloudJoinInspect() {
  const el = $('#cloud-join-inspect');
  if (!el) return;
  const inspected = state.cloudJoinInspect;
  if (!inspected) {
    el.innerHTML = '';
    el.hidden = true;
    updateCloudJoinSubmitState();
    return;
  }
  if (inspected.error) {
    // 预览只负责成功态（指纹/重复检测）；令牌错误在提交时给一条可读错误，避免同一文案出现两次。
    el.innerHTML = '';
    el.hidden = true;
    updateCloudJoinSubmitState();
    return;
  }
  el.hidden = false;
  const fingerprint = inspected.data.masterFingerprint
    ? `<code>${escapeHtml(inspected.data.masterFingerprint)}</code>`
    : '<span class="kv-empty">未知</span>';
  const expires = inspected.data.expiresAt ? formatTime(inspected.data.expiresAt) : '—';
  const duplicate = inspected.data.alreadyJoined;
  el.innerHTML = `<p>对方忆云根指纹：${fingerprint}</p>
    <p class="muted">邀请设备 ${escapeHtml(inspected.data.inviterDeviceId ?? '—')} · 共享域 ${escapeHtml(inspected.data.namespace ?? '—')} · 有效期至 ${escapeHtml(expires)}</p>
    ${duplicate ? `<p class="cloud-duplicate">这台设备已加入「${escapeHtml(duplicate.name)}」，可直接切换。</p>` : ''}`;
  updateCloudJoinSubmitState();
}

async function inspectCloudToken(token) {
  const seq = ++cloudInspectSeq;
  try {
    const data = await api('/admin/api/clouds/inspect', { method: 'POST', body: { token } });
    if (seq !== cloudInspectSeq) return { stale: true };
    if ($('#cloud-join')?.hidden !== false) return { stale: true };
    state.cloudJoinInspect = { data };
    renderCloudJoinInspect();
    return { ok: true, data };
  } catch (error) {
    if (seq !== cloudInspectSeq) return { stale: true };
    state.cloudJoinInspect = { error };
    renderCloudJoinInspect();
    return { ok: false, error };
  }
}

function scheduleCloudInspect() {
  if (cloudInspectTimer) clearTimeout(cloudInspectTimer);
  const token = String($('#cloud-join-token')?.value ?? '').trim();
  if (token.length === 0) {
    state.cloudJoinInspect = null;
    renderCloudJoinInspect();
    return;
  }
  cloudInspectTimer = setTimeout(() => { void inspectCloudToken(token); }, 600);
}

function renderCloudJoinResult() {
  const result = $('#cloud-join-result');
  const joined = state.cloudJoinResult;
  if (!result || !joined?.profile) return;
  const errorEl = $('#cloud-join-error');
  if (errorEl) { errorEl.hidden = true; errorEl.innerHTML = ''; }
  const stepsEl = $('#cloud-join-steps');
  if (stepsEl) { stepsEl.hidden = true; stepsEl.textContent = ''; }
  const name = joined.profile.name;
  const oldName = state.clouds?.profiles?.find((entry) => entry.id === joined.current)?.name
    ?? state.overview?.cloud?.name
    ?? joined.current
    ?? '当前忆云';
  const command = joined.switch?.command ?? cloudSwitchCommand(joined.profile.id);
  if (hasCloudSwitchBridge()) {
    result.innerHTML = `<p class="cloud-result-ok">已加入「${escapeHtml(name)}」。</p>
      <p class="muted">正在切换到新忆云…App 完成切换后控制台会自动刷新。</p>
      <div id="cloud-join-switch-error"></div>`;
  } else {
    result.innerHTML = `<p class="cloud-result-ok">已加入「${escapeHtml(name)}」。</p>
      <p class="cloud-warning">当前仍是「${escapeHtml(oldName)}」；执行下面的命令后才会切换。原忆云归档保留，不删除。</p>
      <div class="copyable"><code>${escapeHtml(command)}</code><button class="btn btn-small btn-crt" type="button" data-copy="${escapeHtml(command)}">复制</button></div>
      <div class="domain-actions"><button id="cloud-join-open-settings" class="btn btn-small btn-crt" type="button">打开忆云卡</button></div>`;
    bindCloudCopy(result);
    result.querySelector('#cloud-join-open-settings')?.addEventListener('click', () => {
      closeCloudJoin();
      openCloudSettings();
    });
  }
  result.hidden = false;
}

async function submitCloudJoin() {
  if (cloudJoinBusy) return;
  if (state.cloudJoinResult) { closeCloudJoin(); return; }
  if (cloudInspectTimer) { clearTimeout(cloudInspectTimer); cloudInspectTimer = null; }
  const errorEl = $('#cloud-join-error');
  if (errorEl) { errorEl.hidden = true; errorEl.innerHTML = ''; }
  const token = String($('#cloud-join-token')?.value ?? '').trim();
  const name = String($('#cloud-join-name')?.value ?? '').trim();
  if (token.length === 0) { showCloudJoinError('TOKEN_REQUIRED'); return; }
  if (state.cloudJoinInspect?.data?.alreadyJoined) {
    const existing = state.cloudJoinInspect.data.alreadyJoined;
    openCloudSwitch(existing.id, existing.name);
    return;
  }
  cloudJoinBusy = true;
  updateCloudJoinSubmitState();
  cloudJoinStep('正在校验令牌…');
  const inspected = await inspectCloudToken(token);
  if (inspected.stale) { cloudJoinBusy = false; updateCloudJoinSubmitState(); return; }
  if (!inspected.ok) {
    cloudJoinBusy = false;
    cloudJoinStep('');
    updateCloudJoinSubmitState();
    showCloudJoinError(inspected.error);
    return;
  }
  if (inspected.data.alreadyJoined) {
    cloudJoinBusy = false;
    cloudJoinStep('');
    updateCloudJoinSubmitState();
    return;
  }
  cloudJoinStep('正在创建忆云…');
  try {
    const res = await api('/admin/api/clouds/join', {
      method: 'POST',
      body: { token, name, confirm: true },
    });
    state.cloudJoinResult = res;
    state.cloudJoinInspect = null;
    const input = $('#cloud-join-token');
    if (input) input.value = '';
    renderCloudJoinInspect();
    cloudJoinStep('');
    renderCloudJoinResult();
    cloudJoinBusy = false;
    updateCloudJoinSubmitState();
    if (!hasCloudSwitchBridge()) await refresh();
    if (hasCloudSwitchBridge()) {
      await performCloudSwitch(res.profile.id, res.profile.name);
    }
  } catch (error) {
    cloudJoinBusy = false;
    cloudJoinStep('');
    updateCloudJoinSubmitState();
    showCloudJoinError(error);
    if (error?.payload?.error === 'CLOUD_ALREADY_JOINED') {
      const existing = error.payload?.existing;
      if (existing?.id) {
        state.cloudJoinInspect = { data: { alreadyJoined: existing } };
        renderCloudJoinInspect();
        updateCloudJoinSubmitState();
      }
    }
  }
}

$('#cloud-join-token')?.addEventListener('input', scheduleCloudInspect);
$('#cloud-join-token')?.addEventListener('paste', () => setTimeout(scheduleCloudInspect, 0));
$('#cloud-join-name')?.addEventListener('input', () => { state.cloudJoinNameAuto = false; });
$('#cloud-join-x')?.addEventListener('click', () => closeCloudJoin());
$('#cloud-join-submit')?.addEventListener('click', () => { void submitCloudJoin(); });

// P3：锁定态设备卡整卡禁用——点击给统一 toast（含关闭按钮），不展示/不操作数据。
$('#device-card')?.addEventListener('click', (event) => {
  if (!state.locked) return;
  event.preventDefault();
  showLockedToast();
});

$('#device-card-close').addEventListener('click', () => {
  state.selected = null;
  const url = new URL(location.href);
  url.searchParams.delete('select');
  history.replaceState(null, '', url);
  render();
  stage.redraw();
});

// 图例展开/折叠（用户定稿）：默认收起（首访自动展开在 App 里显得多余）；
// 用户手动展开后尊重其选择（localStorage）
{
  const panel = $('#legend-panel');
  const toggle = $('#legend-toggle');
  const apply = (collapsed) => {
    panel.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
  };
  apply(localStorage.getItem('mebular_legend_collapsed') !== '0'); // 默认收起；仅显式展开过才保持展开
  toggle.addEventListener('click', () => {
    const next = !panel.classList.contains('is-collapsed');
    localStorage.setItem('mebular_legend_collapsed', next ? '1' : '0');
    apply(next);
  });
}
$('#wizard-close').addEventListener('click', closeWizard);
$('#wizard-back').addEventListener('click', () => wizardSet({ type: 'BACK' }));
$('#wizard-next').addEventListener('click', wizardNext);

// ---------- 手动连接已知设备（网内传输修复；不是加入忆云） ----------

const STEP_LABELS = {
  local: '① 对端地址',
  connect: '② 建立连接',
};

let wizardState = createWizardState();

function openWizard({ deviceId = '', address = '' } = {}) {
  wizardState = { ...createWizardState(), deviceId, address };
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
  const order = WIZARD_STEPS;
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
      <p class="wizard-note">一台<strong>已加入同一忆云</strong>的设备一直显示未连接时，可在这里手动粘贴对方地址建立传输。此操作只修复连接，不改变入网信任与订阅。</p>
      <div class="field"><label>对方 deviceId</label><input id="wizard-device" type="text" value="${escapeHtml(wizardState.deviceId)}" placeholder="device-B" /></div>
      <div class="field"><label>对方 multiaddr</label><textarea id="wizard-address" placeholder="/ip4/…/tcp/…/p2p/…">${escapeHtml(wizardState.address)}</textarea></div>
      <details class="wizard-more">
        <summary>我的连接信息 ›</summary>
        <div class="field"><label>本机 deviceId</label><div class="copyable"><code>${escapeHtml(device.deviceId ?? '—')}</code><button class="btn btn-small" data-copy="${escapeHtml(device.deviceId ?? '')}">复制</button></div></div>
        <div class="field"><label>本机 peerId</label><div class="copyable"><code>${escapeHtml(device.peerId ?? '—')}</code>${device.peerId ? `<button class="btn btn-small" data-copy="${escapeHtml(device.peerId)}">复制</button>` : ''}</div></div>
        <div class="field"><label>本机 multiaddrs</label>${multiaddrs.length
          ? multiaddrs.map((addr) => `<div class="copyable"><code>${escapeHtml(addr)}</code><button class="btn btn-small" data-copy="${escapeHtml(addr)}">复制</button></div>`).join('')
          : '<code class="muted">（未启用 P2P，无监听地址）</code>'}</div>
        <div class="field"><label>relay（可选）</label><code>${escapeHtml((device.relays ?? []).join(', ') || '—')}</code></div>
      </details>
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
      ${wizardState.connection === 'connected'
        ? '<p class="wizard-note">传输已修复；回到星图查看该设备是否转为在线。若仍不通，检查端口/防火墙后重试。</p>'
        : ''}
      ${wizardState.connection === 'failed'
        ? '<p class="wizard-note">可行动建议：确认对面已运行 serve、multiaddr 含 /p2p/&lt;peerId&gt;、端口可达；修正后重试。</p>'
        : ''}
    `;
    next.textContent = wizardState.connection === 'connected' ? '完成' : '重试';
    next.disabled = wizardState.connection === 'connecting';
    back.disabled = wizardState.connection === 'connecting';
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
    // Electron / 非安全上下文：navigator.clipboard 可能不可用；用临时 textarea 兜底（不再用 window.prompt）。
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    ta.remove();
    if (button) {
      const old = button.textContent;
      button.textContent = copied ? '已复制' : '请手动复制';
      setTimeout(() => { button.textContent = old; }, 1600);
    }
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
    if (wizardState.connection === 'connected') {
      closeWizard();
      showToast('已接通；回到星图查看该设备是否转为在线');
      return;
    }
    await doWizardConnect();
  }
}

// ---------- 工具 ----------

function formatTime(ts) {
  if (!ts) return '—';
  return formatLocaleDateTime(ts);
}

/** 只取时分（邀请面板的「至 18:34」）。 */
function formatClock(ts) {
  if (!ts) return '—';
  return formatLocaleTime(ts);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

// ---------- mock 数据 ----------

// mock 的完整记忆清单（供记忆视图过滤演示；id 用短 ULID 样式）
const MOCK_MEMORIES = [
  { id: '01MOCKMEMORY000000000000001', type: 'fact', namespace: 'notes', preview: '演示记忆：mock 数据已补齐，记忆视图可离线验收', createdAt: 0, archived: false, deleted: false },
  { id: '01MOCKMEMORY000000000000002', type: 'note', namespace: 'work', preview: '第二条演示记忆（已归档示例）', createdAt: 0, archived: true, deleted: false },
  { id: '01MOCKMEMORY000000000000003', type: 'fact', namespace: 'default', preview: '第三条演示记忆', createdAt: 0, archived: false, deleted: false },
];

function mockSecurity(now) {
  return {
    ok: true,
    level: 'high',
    changedAt: now - 240_000,
    changedBy: 'device-A',
    admitted: ['device-A', 'device-B'],
    recoveryKeyId: 'a1b2c3d4e5f60718',
    coreTierAvailable: true,
    totp: { imported: true, fingerprint: 'a1b2c3d4', createdAt: now - 3_600_000, failures: 0, lockedUntil: 0, backoffUntil: 0, lastAcceptedAt: now - 60_000 },
    recovery: { registered: true, keyId: 'a1b2c3d4e5f60718', mode: 'set', createdAt: now - 240_000, lastUsedAt: null, current: true },
    pendingApprovals: [{
      approvalId: 'mock-approval-kick',
      op: 'kick',
      decision: 'request',
      initiator: 'device-B',
      target: 'device-D',
      nonce: 'mock-kick',
      digest: 'mock-digest',
      pairingCode: '482-917',
      expiresAt: now + 8 * 60_000,
      issuedAt: now - 30_000,
    }],
    recentApprovals: [],
    rejections: [{ eventId: 'e-sec-reject-1', reason: 'missing-proof' }],
  };
}

async function mockData() {
  const now = Date.now();
  // 记忆视图：按当前过滤器在本地过滤（?mock=1 是契约规定的无网络验收路径）
  const f = state.memoryFilters;
  const memories = MOCK_MEMORIES
    .filter((m) => (f.archived || !m.archived) && (f.deleted || !m.deleted) && (!f.namespace || m.namespace === f.namespace))
    .map((m) => ({ ...m, createdAt: now - 240_000, ...(m.archived ? { archivedAt: now - 120_000 } : {}) }));
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
      cloud: { id: 'default', name: '忆云 1', masterFingerprint: 'sha256:1a2b3c4d5e6f', current: true },
      // P3：收敛健康汇总（mock 无网络验收：B 停滞 / C 未连接）
      convergence: { at: now, summary: { peers: 2, online: 1, ok: 0, stalled: 1, diverged: 0, unverifiable: 0, syncing: 0, offline: 1 } },
    },
    devices: [
      { deviceId: 'device-A', online: true, subscriptions: ['notes', 'work'], sharesWithMe: ['notes', 'work'], blocked: false, pendingEventCount: 0 },
      { deviceId: 'device-B', online: true, peerId: 'peer-b', addrs: ['/ip4/127.0.0.1/tcp/4011'], lastSyncAt: now - 65_000, subscriptions: ['notes', 'ledger'], sharesWithMe: ['notes'], blocked: false, pendingEventCount: 3,
        convergence: { peerDeviceId: 'device-B', state: 'stalled', reasons: [{ code: 'no-ack-progress', count: 2 }], since: now - 600_000, lastEvaluatedAt: now, lastSessionAt: now - 120_000, lastConvergedAt: now - 1_800_000, pendingEvents: 3, probes: 0, lastProbeAt: null, online: true } },
      { deviceId: 'device-C', online: false, subscriptions: ['work'], sharesWithMe: [], blocked: false, pendingEventCount: 1,
        convergence: { peerDeviceId: 'device-C', state: 'offline', reasons: [], since: now - 3_600_000, lastEvaluatedAt: now, lastSessionAt: now - 3_600_000, lastConvergedAt: now - 3_600_000, pendingEvents: 1, probes: 0, lastProbeAt: null, online: false } },
      { deviceId: 'device-D', online: false, subscriptions: [], sharesWithMe: [], blocked: true },
    ],
    namespaces: [
      {
        namespace: 'notes', count: 42, lastUpdatedAt: now - 120_000, stateHash: 'h1',
        subscriptionDeclared: true, subscribers: ['device-A', 'device-B'], subscribed: true, selfSubscribed: true, rejoinReset: false,
      },
      {
        namespace: 'work', count: 70, lastUpdatedAt: now - 300_000, stateHash: 'h2',
        subscriptionDeclared: true, subscribers: ['device-A', 'device-C'], subscribed: true, selfSubscribed: true, rejoinReset: false,
      },
      {
        namespace: 'default', count: 16, lastUpdatedAt: now - 900_000, stateHash: 'h3',
        subscriptionDeclared: false, subscribers: [], subscribed: true, selfSubscribed: true, rejoinReset: false,
      },
      {
        namespace: 'ledger', count: 0, lastUpdatedAt: null, stateHash: null,
        subscriptionDeclared: true, subscribers: ['device-B'], subscribed: false, selfSubscribed: false, rejoinReset: false,
        declared: true, declaredAt: now - 1_500_000, declaredBy: 'device-B',
      },
    ],
    memories: { total: memories.length, memories, includeArchived: f.archived, includeDeleted: f.deleted },
    clouds: {
      ok: true,
      root: '~/.mebular',
      current: 'default',
      profiles: [
        { id: 'default', name: '忆云 1', home: '.', kind: 'root', createdAt: now - 30 * 86_400_000, lastUsedAt: now - 3_600_000, masterFingerprint: 'sha256:1a2b3c4d5e6f', deviceId: 'device-A', current: true },
        { id: 'p_demo0001', name: '忆云 2', home: 'profiles/p_demo0001', kind: 'delegated', createdAt: now - 5 * 86_400_000, lastUsedAt: now - 2 * 86_400_000, masterFingerprint: 'sha256:9f8e7d6c5b4a', deviceId: 'device-A', current: false },
      ],
    },
    security: mockSecurity(now),
    policy: [
      { eventId: 'e5', type: 'namespace_subscription', issuer: 'device-C', subject: 'device-C', namespace: 'work', namespaces: ['work'], active: true, at: now - 300_000, valid: true },
      { eventId: 'e6', type: 'namespace_subscription', issuer: 'device-B', subject: 'device-B', namespace: 'notes', namespaces: ['notes'], active: true, at: now - 320_000, valid: true },
      { eventId: 'e7', type: 'namespace_declare', issuer: 'device-B', subject: 'device-B', namespace: 'ledger', namespaces: ['ledger'], at: now - 340_000, valid: true },
      { eventId: 'e3', type: 'device_restore', issuer: 'device-A', subject: 'device-D', at: now - 600_000, valid: true },
      { eventId: 'e2', type: 'device_revoke', issuer: 'device-A', subject: 'device-D', at: now - 700_000, valid: true },
      { eventId: 'e0', type: 'namespace_subscription', issuer: 'device-D', subject: 'device-D', namespace: 'work', namespaces: ['work'], active: false, at: now - 800_000, valid: false, rejectReason: 'foreign-subscription' },
      { eventId: 'e1', type: 'namespace_subscription', issuer: 'device-A', subject: 'device-A', namespace: 'notes', namespaces: ['notes'], active: true, at: now - 900_000, valid: true },
      { eventId: 'e-sec-tier-1', type: 'security_tier', issuer: 'device-A', level: 'high', fromLevel: 'low', at: now - 1_000_000, valid: true },
      { eventId: 'e-sec-reject-1', type: 'security_tier', issuer: 'device-B', level: 'medium', fromLevel: 'high', at: now - 1_020_000, valid: false, rejectReason: 'missing-proof', note: '裸降档应被拒绝' },
      { eventId: 'e-sec-approve-1', type: 'security_approval', issuer: 'device-B', subject: 'device-D', approvalId: 'mock-approval-done', op: 'kick', decision: 'approve', initiator: 'device-A', target: 'device-D', pairingCode: '482-917', at: now - 1_040_000, valid: true, cosignApprover: 'device-B' },
      { eventId: 'e-sec-recovery-1', type: 'security_recovery', issuer: 'device-A', subject: 'device-A', keyId: 'a1b2c3d4e5f60718', mode: 'set', at: now - 1_060_000, valid: true },
      { eventId: 'e-sec-totp-1', type: 'security_totp', issuer: 'device-A', subject: 'device-A', device: 'device-A', fingerprint: 'a1b2c3d4', at: now - 1_080_000, valid: true, note: 'console import' },
    ],
    degraded: null,
    degraded: null,
  };
}

// ---------- 启动 ----------

let eventSource = null;
let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  if (typeof document !== 'undefined' && document.hidden === true) return; // F-PERF-1：隐藏时不取数
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, 700);
}

function startEvents() {
  if (state.locked || MOCK || typeof window.EventSource === 'undefined') return;
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
  eventSource.addEventListener('convergence', onPulse);
  eventSource.onerror = () => {
    // EventSource 会自动重连；网络关闭时保持静默
  };
}


// ---------- P3：锁定主控制台 + 首启入口（新建 / 加入；同页解锁，不 reload） ----------

const ONBOARD_COACH_MS = 6000;
let onboardBusy = false;
let onboardCoachTimer = null;
let onboardCoachHideTimer = null;

async function fetchProvisionStatus() {
  try {
    const res = await fetch('/app/provision/status', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (!res.ok) return null; // 正常态：接口 404/409
    const data = await res.json().catch(() => null);
    return data && data.provision === true ? data : null;
  } catch {
    return null;
  }
}

function setOnboardError(id, message) {
  const el = $(id);
  if (!el) return;
  el.textContent = message ?? '';
  el.hidden = !message;
}

function positionOnboardingCoach() {
  const el = $('#onboarding-coach');
  const bar = document.querySelector('.topbar');
  if (!el || !bar || el.hidden) return;
  // 顶栏会随窄屏换行；锁定横幅也在星图顶端——引导卡放在两者之下，避免互相遮挡。
  const barBottom = bar.getBoundingClientRect().bottom;
  const banner = $('#banner');
  const bannerBottom = banner && !banner.hidden ? banner.getBoundingClientRect().bottom : barBottom;
  el.style.top = `${Math.round(Math.max(barBottom, bannerBottom) + 10)}px`;
  el.style.right = window.innerWidth <= 760 ? '12px' : '16px';
}

/** 每次 App 打开（锁定态）展示一次；数秒自动淡出，点击/ESC 可提前关闭。 */
function showOnboardingCoach() {
  if (!state.locked) return;
  const el = $('#onboarding-coach');
  if (!el) return;
  el.hidden = false;
  el.classList.remove('is-leaving');
  positionOnboardingCoach();
  requestAnimationFrame(() => el.classList.add('is-visible'));
  if (onboardCoachTimer) clearTimeout(onboardCoachTimer);
  onboardCoachTimer = setTimeout(() => dismissOnboardingCoach(), ONBOARD_COACH_MS);
}

function dismissOnboardingCoach() {
  const el = $('#onboarding-coach');
  if (!el || el.hidden) return;
  if (onboardCoachTimer) { clearTimeout(onboardCoachTimer); onboardCoachTimer = null; }
  el.classList.remove('is-visible');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  if (reduced) {
    el.hidden = true;
    el.classList.remove('is-leaving');
    return;
  }
  el.classList.add('is-leaving');
  if (onboardCoachHideTimer) clearTimeout(onboardCoachHideTimer);
  onboardCoachHideTimer = setTimeout(() => {
    el.hidden = true;
    el.classList.remove('is-leaving');
  }, 320);
}

function openOnboardCreate() {
  if (!state.locked) return;
  dismissOnboardingCoach();
  const modal = $('#onboard-create');
  const cloud = $('#onboard-create-cloud');
  const device = $('#onboard-create-device');
  if (!modal) return;
  const status = state.provision ?? {};
  if (cloud) cloud.value = nextCloudName();
  if (device) device.value = status.defaultDeviceName ?? status.hostname ?? '';
  setOnboardError('#onboard-create-error', '');
  modal.hidden = false;
  setTimeout(() => cloud?.focus(), 0);
}

function closeOnboardCreate() {
  if (onboardBusy) return;
  const modal = $('#onboard-create');
  if (modal) modal.hidden = true;
  setOnboardError('#onboard-create-error', '');
}

function openOnboardJoin() {
  if (!state.locked) return;
  dismissOnboardingCoach();
  const modal = $('#onboard-join');
  const device = $('#onboard-join-device');
  const token = $('#onboard-join-token');
  if (!modal) return;
  const status = state.provision ?? {};
  if (device) device.value = status.defaultDeviceName ?? status.hostname ?? '';
  if (token) token.value = '';
  setOnboardError('#onboard-join-error', '');
  modal.hidden = false;
  setTimeout(() => token?.focus(), 0);
}

function closeOnboardJoin() {
  if (onboardBusy) return;
  const modal = $('#onboard-join');
  if (modal) modal.hidden = true;
  setOnboardError('#onboard-join-error', '');
}

/**
 * P1/P3：初始化成功后在同一页面解锁主控制台（不 window.location.reload、不重启）。
 * 解锁后进入正常刷新/轮询；enterNormalConsole 自身幂等（重复调用不会叠加定时器/监听）。
 */
async function unlockConsole(kind) {
  onboardBusy = false;
  const createModal = $('#onboard-create');
  const joinModal = $('#onboard-join');
  if (createModal) createModal.hidden = true;
  if (joinModal) joinModal.hidden = true;
  dismissOnboardingCoach();
  state.locked = false;
  state.provision = null;
  clearLockedChrome();
  lastSettingsSignature = null;
  lastAboutSignature = null;
  await enterNormalConsole();
  showToast(kind === 'create' ? '忆云已建好，控制台已解锁' : '已加入忆云，控制台已解锁');
}

/**
 * 共用首启提交路径（P1 端点）：create { cloudName, deviceName } / join { token, deviceName }。
 * 名称校验交给 P1 API（服务端 normalizeProfileName / normalizeDeviceName），失败内联展示。
 */
async function submitOnboard(kind) {
  if (onboardBusy) return;
  const isCreate = kind === 'create';
  const errorId = isCreate ? '#onboard-create-error' : '#onboard-join-error';
  const submit = $(isCreate ? '#onboard-create-submit' : '#onboard-join-submit');
  const deviceName = String($(isCreate ? '#onboard-create-device' : '#onboard-join-device')?.value ?? '').trim();
  const cloudName = String($('#onboard-create-cloud')?.value ?? '').trim();
  const token = String($('#onboard-join-token')?.value ?? '').trim();
  setOnboardError(errorId, '');
  if (isCreate && cloudName.length === 0) {
    setOnboardError(errorId, '请填写忆云名字（最多 24 个字符）。');
    return;
  }
  if (!isCreate && token.length === 0) {
    setOnboardError(errorId, '请先粘贴加入令牌（邀请面板生成的一次性令牌）。');
    return;
  }
  onboardBusy = true;
  if (submit) {
    submit.disabled = true;
    submit.dataset.label = submit.textContent;
    submit.textContent = isCreate ? '正在新建…' : '正在加入…';
  }
  try {
    const res = await api(isCreate ? '/app/provision/create' : '/app/provision/join', {
      method: 'POST',
      body: {
        confirm: true,
        ...(deviceName ? { deviceName } : {}),
        ...(isCreate && cloudName ? { cloudName } : {}),
        ...(!isCreate ? { token } : {}),
      },
      timeoutMs: isCreate ? 30000 : 45000,
    });
    if (res?.initialized === true) {
      // 同一进程已完成热初始化；同一页面实例进入正常控制台。
      sessionStorage.setItem('mebular_provision', JSON.stringify({ kind, at: Date.now(), result: res }));
      await unlockConsole(kind);
      return;
    }
    setOnboardError(errorId, '初始化未完成（响应未返回 initialized），请重试或检查守护版本。');
  } catch (error) {
    // 重复提交（本进程已热初始化）→ 不裸报错，直接解锁。
    if (error?.status === 409 && error?.payload?.error === 'already_provisioned' && error?.payload?.initialized === true) {
      await unlockConsole(kind);
      return;
    }
    setOnboardError(errorId, `失败：${error?.payload?.message ?? error?.message ?? '初始化失败'}`);
  } finally {
    onboardBusy = false;
    if (submit) {
      submit.disabled = false;
      submit.textContent = submit.dataset.label ?? (isCreate ? '新建忆云' : '加入忆云');
      delete submit.dataset.label;
    }
  }
}

/** 锁定态启动：主控制台可见、星图可动，但不取 admin 数据。 */
async function enterLockedConsole(status) {
  state.locked = true;
  state.provision = status ?? null;
  document.body.classList.add('is-locked');
  const app = $('#app');
  if (app) app.dataset.locked = 'true';
  // 星图保留背景 + 本机 ghost 地球仪（不映射任何设备数据）；不请求 /admin/api/overview 等 409 接口。
  stage.start();
  setView('map');
  render();
  showOnboardingCoach();
  if (status?.phase === 'INITIALIZING') {
    // 极端并发：初始化进行中，入口禁用并给出提示，等待用户重试。
    setOnboardError('#onboard-create-error', '初始化正在进行，请稍候重试。');
  }
  // 托盘在「向导态 → 首次加载控制台」时带来的 ?view= 目标也要生效（锁定壳只开设置/提示，不取数据面）。
  await applyConsoleDeepLink(initialViewFromSearch(location.search), { initial: true });
}

let normalConsolePromise = null;
/**
 * P1：初始化成功后在同一页面进入正常控制台（不依赖 window.location.reload 作为恢复路径）。
 * 幂等：正常启动与首启解锁共用同一个 promise，不会重复 startEvents/定时器。
 */
function enterNormalConsole() {
  normalConsolePromise ??= enterNormalConsoleOnce();
  return normalConsolePromise;
}

/**
 * 统一应用控制台深链：启动 ?query 与桌面壳托盘原地导航共用（不重建页面）。
 * initial=true 时只负责启动落点；后续导航先收起无关弹层，再切视图 / 开目标弹层。
 */
async function applyConsoleDeepLink(deepLink, { initial = false } = {}) {
  if (!deepLink) return;
  if (deepLink.view) setView(deepLink.view);
  if (!initial) {
    if (!deepLink.openSettings) $('#settings').hidden = true;
    if (!deepLink.openInvite) {
      $('#invite').hidden = true;
      state.inviteToken = null;
    }
    for (const id of ['about', 'cloud-switch', 'handoff', 'namespace-new-modal']) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
  }
  // UX-2：?view=connect 别名重定向 → 设置 · AI 助手
  if (deepLink.openSettings) {
    $('#settings').hidden = false;
    renderSettings(deepLink.openSettings);
    if (deepLink.focusSecurity) {
      setTimeout(() => {
        const slot = $('#settings-security-slot');
        if (slot) {
          slot.scrollIntoView({ block: 'start', behavior: 'auto' });
          slot.focus?.();
        }
      }, 0);
    }
    if (deepLink.focusClouds) {
      setTimeout(() => {
        const card = $('#settings-cloud-card');
        if (card) {
          card.scrollIntoView({ block: 'start', behavior: 'auto' });
          card.focus?.({ preventScroll: true });
        }
      }, 0);
    }
  }
  if (deepLink.openInvite) {
    // 锁定态没有可用的邀请数据面：沿用锁定壳的提示，不直接打 409 接口。
    if (state.locked) showLockedToast();
    // 弹层已开着就只显示，不重复生成令牌（重复点托盘不应让旧令牌失效）。
    else if ($('#invite').hidden) await openInvite();
    else $('#invite').hidden = false;
  }
}

async function enterNormalConsoleOnce() {
  // 兼容旧内部路径（P3 起不再用 #provision 遮罩整个 app）。
  const provisionModal = $('#provision');
  if (provisionModal) provisionModal.hidden = true;
  clearLockedChrome();
  dismissOnboardingCoach();
  const appEl = $('#app');
  if (appEl) appEl.hidden = false;
  // R-1 高-3：?view=<视图> 深链（向导②/托盘「连接 AI 助手」的 ?view=connect 落点）；
  // step=device → 进连接页后自动开「邀请设备」
  const deepLink = initialViewFromSearch(location.search);
  // UX-2 补丁 4：桌面壳 + macOS hiddenInset → 顶栏避让交通灯安全区（body 类驱动 CSS）
  document.body.classList.toggle(
    'shell-desktop-darwin',
    Boolean(deepLink.shellDesktop || window.mebularDesktop) && window.mebularDesktop?.platform === 'darwin',
  );
  stage.start();
  setView(deepLink.view ?? 'map');
  await refresh();
  await applyConsoleDeepLink(deepLink, { initial: true });
  startEvents();
  setInterval(() => {
    if (document.hidden === true) return; // F-PERF-1：隐藏页不轮询，回前台由 visibilitychange 补刷
    refresh();
  }, POLL_MS);
}

// 引导遮罩：点击任意处/知道了关闭；ESC 在无弹层时关闭。
$('#onboarding-coach')?.addEventListener('click', () => {
  dismissOnboardingCoach();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if (visibleModalElements().length > 0) return;
  if (!state.locked || $('#onboarding-coach')?.hidden !== false) return;
  event.preventDefault();
  dismissOnboardingCoach();
});
window.addEventListener('resize', () => {
  if ($('#onboarding-coach')?.hidden === false) positionOnboardingCoach();
});

const provisionStatus = await fetchProvisionStatus();
if (provisionStatus && provisionStatus.phase !== 'READY') {
  await enterLockedConsole(provisionStatus);
} else {
  await enterNormalConsole();
}

// 桌面壳托盘原地导航：启动完成后再接；启动期间到达的事件由 preload 缓冲一次。
if (typeof window.mebularDesktop?.onConsoleNavigate === 'function') {
  window.mebularDesktop.onConsoleNavigate((search) => {
    if (typeof search !== 'string' || !search.startsWith('?')) return;
    void applyConsoleDeepLink(initialViewFromSearch(search));
  });
}
