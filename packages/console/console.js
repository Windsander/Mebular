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
import { IA_TABS, IA_ADVANCED_SECTIONS, IA_MCP_SECTIONS, IA_FIELD_COPY, IA_SETTINGS_EXTRA, IA_SETTINGS_FOLDS, IA_SECURITY_SECTIONS, IA_MCP_DANGER_LINE_KEYS, INVITE_TTL_OPTIONS, INVITE_TTL_DEFAULT_MS, SECURITY_LEVEL_LABEL, SECURITY_LEVEL_TITLE_KEY, SECURITY_LEVEL_NOTE_KEY, SECURITY_BOUNDARY_KEY, SECURITY_TOTP_FOOT_KEY, refreshCsrfToken, withCsrfRetry } from './settings-ia.js';
import { assistantsPanelHtml, serviceRowHtml, wizardRowHtml, statusPillHtml, attentionItems, assistantAddFormHtml } from './assistants.js';
import { reconcileAssistantUi } from './assistant-status.js';
import { t, getLocale, setLocale, onLocaleChange, applyStaticI18n, languageSettingsRowHtml, initI18n, LOCALE_STORAGE_KEY, formatDateTime as formatLocaleDateTime, formatExpiry } from './i18n.mjs';
import { enhanceSelect, enhanceSelects } from './dropdown.mjs';

const $ = (selector) => document.querySelector(selector);
// 静态筛选器使用紧凑 variant；动态设置/邀请/助手表单在渲染后统一 enhance。
const FILTER_SELECT_IDS = ['audit-filter-action', 'audit-filter-device', 'audit-filter-namespace', 'audit-filter-time', 'mem-filter-namespace'];
function enhanceFilterSelects() {
  for (const id of FILTER_SELECT_IDS) {
    const select = document.getElementById(id);
    if (select) enhanceSelect(select, { variant: 'compact' });
  }
}
const params = new URLSearchParams(location.search);
const MOCK = params.get('mock') === '1';
const POLL_MS = 3000;

const ICONS = { online: '●', offline: '○', revoked: '⊘' };

/** 折叠标题单一真源（IA_SETTINGS_FOLDS）；缺失时回退 id 便于定位。 */
const foldLabel = (id) => {
  const fold = IA_SETTINGS_FOLDS.find((entry) => entry.id === id);
  if (!fold) return id;
  return fold.labelKey ? t(fold.labelKey) : fold.label;
};

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

// i18n foundation：先等 manifest + locale pack 加载完成，再同步静态顶栏/导航（避免首屏 key 闪烁）。
// 语言行已默认开放；只有 ?lang= 或已保存偏好才覆盖默认 zh-CN。
// 未选择时不跟随英文系统语言，避免首次打开就落入半翻译界面。
// 加载失败不抛：保留 index.html 的静态中文兜底，设置/语言行在下次成功加载后恢复。
const hasExplicitLocale = Boolean(params.get('lang')?.trim()) || Boolean(localStorage.getItem(LOCALE_STORAGE_KEY));
await initI18n({ languages: hasExplicitLocale ? undefined : [] });
if (!hasExplicitLocale && getLocale() !== 'zh-CN') setLocale('zh-CN', { persist: false });
applyStaticI18n(document);
enhanceFilterSelects();
onLocaleChange(() => {
  applyStaticI18n(document);
  lastSettingsSignature = null;
  lastAboutSignature = null;
  render();
  if (!$('#wizard').hidden) renderWizard();
  if (!$('#handoff').hidden) renderHandoffCopy();
  if (!$('#invite').hidden && state.inviteToken) showInviteResult(state.inviteToken);
  if (!$('#cloud-join').hidden) {
    updateCloudJoinWarning();
    renderCloudJoinInspect();
    if (state.cloudJoinResult) renderCloudJoinResult();
    updateCloudJoinSubmitState();
  }
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
  if (help) help.innerHTML = t('authToken.help', { command: '<code>mebular token grant --scope memory.read,memory.admin</code>' });
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
    if (error) { error.textContent = t('authToken.error.required'); error.hidden = false; }
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
      message: payload?.message ?? cloudsView.reason?.message ?? t('cloud.error.cloudListFailed'),
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
  if (state.error) return t('status.degraded.disconnected', { message: state.error.message });
  const status = state.overview?.status;
  if (!status) return t('status.degraded.noStatus');
  if (!status.running) return t('status.degraded.p2pOff');
  return null;
}

// ---------- 渲染 ----------

/** 服务端动态消息：中文界面保留原文；英文界面遇到中文原文时退回本地化通用文案。 */
function displayErrorDetail(error, fallbackKey = 'common.actionFailed') {
  const message = String(error?.payload?.message ?? error?.message ?? '').trim();
  if (!message) return t(fallbackKey);
  if (getLocale() === 'zh-CN' || !/[\u3400-\u9fff]/.test(message)) return message;
  return t(fallbackKey);
}

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
      button.title = t('nav.lockedHint');
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

function topbarSecurityLevel(level) {
  const key = `security.level.${level}`;
  const label = t(key);
  return label === key ? (SECURITY_LEVEL_LABEL[level] ?? level) : label;
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
    selfEl.textContent = t('topbar.self.uninitialized');
    selfEl.title = t('topbar.self.openAbout');
    onlineEl.textContent = t('topbar.online.uninitialized');
    onlineEl.className = 'badge badge-muted';
    memEl.textContent = t('topbar.memory.none');
    memEl.className = 'badge badge-muted';
    const secEl = $('#security-badge');
    if (secEl) {
      secEl.textContent = t('topbar.security.none');
      secEl.className = 'badge badge-button badge-muted';
      secEl.title = t('nav.lockedHint');
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
      const duplicateDot = `<span class="cloud-warning-dot" title="${escapeHtml(t('topbar.cloud.duplicateDot'))}" aria-label="${escapeHtml(t('topbar.cloud.duplicateAria'))}"></span>`;
      cloudEl.hidden = false;
      cloudEl.innerHTML = `<svg class="cloud-mark" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.6 12.2h6.9a2.7 2.7 0 0 0 .4-5.37A4.2 4.2 0 0 0 3.4 7.1a2.6 2.6 0 0 0 1.2 5.1Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="cloud-name">${escapeHtml(cloud.name)}</span>${currentConflict ? duplicateDot : ''}`;
      cloudEl.title = currentConflict
        ? t('topbar.cloud.currentConflictHint', { name: cloud.name })
        : t('topbar.cloud.currentHint', { name: cloud.name });
      cloudEl.setAttribute('aria-label', currentConflict
        ? t('topbar.cloud.ariaConflict', { name: cloud.name })
        : t('topbar.cloud.aria', { name: cloud.name }));
    } else {
      cloudEl.hidden = true;
      cloudEl.textContent = '';
    }
  }
  if (state.overview?.device) {
    selfEl.textContent = t('topbar.self.current', { deviceId: state.overview.device.deviceId });
    selfEl.title = t('topbar.self.openAboutWithId', { deviceId: state.overview.device.deviceId });
  } else {
    selfEl.textContent = t('topbar.self.placeholder');
    selfEl.title = t('topbar.self.openAbout');
  }
  const online = Boolean(status?.running);
  onlineEl.textContent = online ? t('topbar.online.enabled') : t('topbar.online.disabled');
  onlineEl.className = `badge ${online ? 'badge-ok' : 'badge-muted'}`;
  memEl.textContent = status ? t('topbar.memory.count', { count: status.nodeCount ?? '—' }) : t('topbar.memory.placeholder');
  memEl.className = 'badge badge-muted';
  // S3：只读安全徽章（点击 = 打开安全卡；不做写操作）
  const secEl = $('#security-badge');
  if (secEl) {
    const level = state.security?.level ?? null;
    const levelLabel = level ? topbarSecurityLevel(level) : '';
    secEl.textContent = level ? t('topbar.security.badge', { level: levelLabel }) : t('topbar.security.none');
    secEl.className = `badge badge-button ${level === 'high' ? 'badge-ok' : level === 'medium' ? 'badge-warn' : 'badge-muted'}`;
    const pending = (state.security?.pendingApprovals ?? []).filter((a) => a?.initiator !== state.overview?.device?.deviceId).length;
    const rejected = (state.security?.rejections ?? []).length;
    secEl.title = level
      ? t('topbar.security.title', {
        level: levelLabel,
        pending: pending ? t('topbar.security.pending', { count: pending }) : '',
        rejected: rejected ? t('topbar.security.rejected', { count: rejected }) : '',
      })
      : t('topbar.security.unavailable');
  }
  const pendingBadge = $('#settings-pending-badge');
  if (pendingBadge) {
    const count = pendingRestartItems().length;
    pendingBadge.hidden = count === 0;
    pendingBadge.textContent = count > 0 ? t('topbar.pendingRestart', { count }) : '';
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
    li.textContent = t('legend.empty');
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
        label: t('lock.ghostLabel'),
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
    label: t('stage.selfLabel'),
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
    canvas.setAttribute('aria-label', state.locked ? t('lock.canvasAria') : t('stage.aria'));
  }
}

function renderBanner() {
  const banner = $('#banner');
  // 常驻横幅可见时给 .stage-wrap 打标——窄屏下面板视图据此让位，不被横幅压住标题/统计
  const wrap = document.querySelector('.stage-wrap');
  if (state.locked) {
    banner.hidden = false;
    banner.className = 'banner is-locked';
    banner.textContent = t('lock.banner');
    wrap?.classList.add('has-banner');
    return;
  }
  if (state.error) {
    banner.hidden = false;
    banner.className = 'banner is-error';
    banner.textContent = t('banner.error', { message: state.error.message });
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
      stats.innerHTML = `<span class="crt-tag">${escapeHtml(t('domains.stats.localView'))}</span>`;
    } else {
      const subscribed = items.filter((n) => n.subscribed).length;
      stats.innerHTML = `<span class="crt-tag">${escapeHtml(t('domains.stats.total', { count: items.length }))}</span>`
        + (subscribed > 0 ? `<span class="crt-tag">${escapeHtml(t('domains.stats.subscribed', { count: subscribed }))}</span>` : '');
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
    const meta = t('domains.item.count', { count: n.count })
      + (n.subscribed ? '' : t('domains.item.unsubscribed'))
      + (isTask ? t('domains.item.task') : '');
    return `<div class="sector-item${active ? ' is-active' : ''}">
      <button class="sector-main" data-sector="${escapeHtml(n.namespace)}" type="button">
        <span class="sector-dot${n.subscribed ? ' is-on' : ''}"></span>
        <span class="sector-name"><span class="ns-chip" style="background:${namespaceColor(n.namespace)}">${escapeHtml(n.namespace)}</span></span>
        <span class="sector-meta${n.subscribed ? '' : ' off'}">${meta}</span>
      </button>
      <button class="sector-more" type="button" data-domain-menu="${escapeHtml(n.namespace)}" title="${escapeHtml(t('common.more'))}" aria-label="${escapeHtml(t('common.moreActions'))}">⋯</button>
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
  const othersText = others.slice(0, 4).map((m) => escapeHtml(m)).join(t('common.listSeparator'))
    + (others.length > 4 ? escapeHtml(t('domains.detail.andMore', { count: others.length })) : '');
  const relation = others.length === 0
    ? t('domains.detail.relationNone')
    : t('domains.detail.relationOthers', { devices: othersText });
  const ordered = [...subscribers].sort((a, b) => (a === selfId ? -1 : 0) - (b === selfId ? -1 : 0));
  const subscriberChips = subscribers.length
    ? ordered.map((m) => `<span class="member-chip is-effective">${m === selfId ? escapeHtml(t('common.self')) : escapeHtml(m)}</span>`).join(' ')
    : `<span class="muted">${escapeHtml(t('domains.detail.noSubscribers'))}</span>`;

  const rejoin = n.rejoinReset
    ? `<div class="ctx-row">
        <span>⟳ ${escapeHtml(t('domains.rejoin.note'))}</span>
        <button class="link-btn" type="button" data-rejoin="${escapeHtml(ns)}" ${writes ? '' : 'disabled'} title="${escapeHtml(writes ? t('domains.rejoin.title') : t('common.readOnlyMode'))}">${escapeHtml(t('domains.rejoin.action'))}</button>
      </div>`
    : '';

  const isTaskNs = (state.settings?.fleet?.namespace ?? null) === ns;
  const subscribeState = n.subscribed ? t('domains.subscribed') : t('domains.unsubscribed');
  detail.innerHTML = `<article class="sector-readout crt-surface crt-corners">
    <header class="readout-head">
      <span class="ns-chip" style="background:${namespaceColor(ns)}">${escapeHtml(ns)}</span>${isTaskNs ? `<span class="crt-tag">${escapeHtml(t('domains.taskTag'))}</span>` : ''}
      <span class="readout-meta">${escapeHtml(t('domains.detail.meta', { count: n.count, time: n.lastUpdatedAt ? formatTime(n.lastUpdatedAt) : '—' }))}</span>
      <span class="ns-subscribe"><label class="toggle" title="${escapeHtml(t('domains.subscribe.title'))}"><input id="ns-subscribe" type="checkbox" data-ns-subscribe="${escapeHtml(ns)}" aria-label="${escapeHtml(t('domains.subscribe.aria', { state: subscribeState }))}" ${n.subscribed ? 'checked' : ''} ${writes ? '' : 'disabled'}><span class="slider"></span></label><span class="readout-meta">${escapeHtml(subscribeState)}</span></span>
    </header>
    ${isTaskNs ? `<p class="muted" style="font-size:11px;margin:6px 0 0">${escapeHtml(t('domains.task.note'))}</p>` : ''}
    <p class="relation">${relation}</p>
    <p class="subscribe-note">${escapeHtml(t('domains.subscribe.note'))}</p>
    <details class="share" open>
      <summary>${escapeHtml(t('domains.detail.subscribers'))}</summary>
      <div class="share-row"><span class="lbl">${escapeHtml(t('domains.subscribed'))}</span><div class="chip-wrap">${subscriberChips}</div></div>
      <div class="share-row"><span class="lbl"></span><span class="share-hint">${escapeHtml(t('domains.detail.subscribersHint'))}</span></div>
    </details>
    ${rejoin}
    <div class="danger-zone">
      <button class="danger-link" type="button" data-handoff="${escapeHtml(ns)}" ${writes ? '' : 'disabled'}>${escapeHtml(t('domains.handoff.action'))}</button>
      <span class="hint">${escapeHtml(t('domains.handoff.hint'))}</span>
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
            title: t('domains.unsubscribeSome.title'),
            body: t('domains.unsubscribeSome.body', { namespace: ns, count: all.length }),
            confirmLabel: t('common.confirm'),
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
    window.alert(t('common.mockReadOnly'));
    return;
  }
  try {
    await api('/admin/api/subscriptions', {
      method: 'POST',
      body: { namespace: ns, active, ...(nextNamespaces !== undefined ? { nextNamespaces } : {}) },
    });
    showToast(active ? t('domains.toast.subscribed', { namespace: ns }) : t('domains.toast.unsubscribed', { namespace: ns }));
    await refresh();
  } catch (error) {
    window.alert(t('common.operationFailed', { message: error.message }));
    await refresh();
  }
}

function openNamespaceNew() {
  if (MOCK) {
    window.alert(t('common.mockReadOnly'));
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
    window.alert(t('common.mockReadOnly'));
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
    showError(t('domains.create.error.empty'));
    return;
  }
  try {
    // 服务端默认自订阅（active:true）：创建完就能写；用户仍可随时退订。
    await api('/admin/api/namespaces', { method: 'POST', body: { namespace, subscribe: true } });
    state.selectedNamespace = namespace;
    closeNamespaceNew();
    await refresh();
    showToast(t('domains.create.success', { namespace }));
  } catch (err) {
    showError(t('domains.create.failed', { message: err.message }));
  }
}

function submitNamespaceNew() {
  void createNamespace($('#namespace-new-name')?.value ?? '');
}

async function doRejoin(ns) {
  if (MOCK) {
    window.alert(t('common.mockReadOnly'));
    return;
  }
  const ok = await confirmModal({
    title: t('domains.rejoin.confirmTitle', { namespace: ns }),
    body: t('domains.rejoin.confirmBody', { namespace: ns }),
    confirmLabel: t('domains.rejoin.confirmAction'),
  });
  if (!ok) return;
  try {
    const result = await api(`/admin/api/namespaces/${encodeURIComponent(ns)}/rejoin`, { method: 'POST', body: {} });
    if (result?.ok) showToast(t('domains.rejoin.toast.done', { namespace: ns }));
    else showToast(t('domains.rejoin.toast.failed', { reason: result?.reason ?? t('domains.rejoin.failedFallback') }));
    await refresh();
  } catch (error) {
    window.alert(t('common.operationFailed', { message: error.message }));
  }
}

// ---------- 退出并交接（plan 预检 + 强确认；force 不提供） ----------

let handoffNs = null;

function renderHandoffCopy() {
  if (!handoffNs) return;
  const title = $('#handoff-title');
  const desc = $('#handoff-desc');
  if (title) title.textContent = t('handoff.title', { namespace: handoffNs });
  if (desc) desc.textContent = t('handoff.desc');
}

function openHandoff(ns) {
  handoffNs = ns;
  renderHandoffCopy();
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
    pre.textContent = t('handoff.planFailed', { message: error.message });
    $('#handoff-confirm').disabled = true;
  }
}

async function confirmHandoff() {
  const ns = handoffNs;
  const successor = ($('#handoff-successor').value ?? '').trim();
  if (!ns || !successor) return;
  const ok = await confirmModal({
    title: t('handoff.confirmTitle', { namespace: ns }),
    body: t('handoff.confirmBody', { namespace: ns, successor }),
    confirmLabel: t('handoff.confirmLabel'),
  });
  if (!ok) return;
  try {
    const result = await api(`/admin/api/namespaces/${encodeURIComponent(ns)}/leave`, { method: 'POST', body: { successor } });
    showToast(result?.ok
      ? t('handoff.toast.done', { namespace: ns })
      : t('handoff.toast.aborted', { reason: result?.reason ?? t('handoff.abortedFallback') }));
    $('#handoff').hidden = true;
    await refresh();
  } catch (error) {
    window.alert(t('common.operationFailed', { message: error.message }));
  }
}

// ---------- 设置卡（本机；运行时 vs 需改配置重启） ----------

// ---------- 设置卡：常用配置编辑器（curated；保存写入 config.json，需重启生效） ----------

// A：编辑器字段元数据来自**服务端单一真源**（config-schema.mjs → /admin/api/settings.configSchema）；
// 控制台不再重复声明字段（曾散在 serve/admin/console/settings-ia 四处 → 漂移）。
// 曝光面：editable 渲染编辑器；status-only 只读展示（自动池 / 推导状态）；internal 不出现在 GUI。

let CONFIG_FIELDS_BY_PATH = new Map();

/** IA 字段展示文案：key 优先（locale pack），缺 key 时回退中文兜底。 */
function localizedFieldCopy(path) {
  const copy = IA_FIELD_COPY[path];
  if (!copy) return {};
  const { labelKey = null, helpKey = null, warnKey = null, ...rest } = copy;
  return {
    ...rest,
    ...(labelKey ? { label: t(labelKey) } : {}),
    ...(helpKey ? { help: t(helpKey) } : {}),
    ...(warnKey ? { warn: t(warnKey) } : {}),
  };
}

function rebuildConfigFields() {
  const list = Array.isArray(state.settings?.configSchema) ? state.settings.configSchema : [];
  CONFIG_FIELDS_BY_PATH = new Map(list.map((entry) => [entry.path, {
    path: entry.path,
    kind: entry.kind,
    requiresRestart: entry.requiresRestart !== false,
    ...(entry.ui ?? {}),
    // 展示层覆盖：短帮助/统一词；校验、默认值与写入行为仍由服务端 schema 决定。
    ...localizedFieldCopy(entry.path),
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
  'sync.autoSync': 'settings.restartLabel.autoSync',
  'sync.pushOnWrite': 'settings.restartLabel.pushOnWrite',
};

function pendingRestartItems() {
  return Array.isArray(state.settings?.pendingRestart) ? state.settings.pendingRestart : [];
}

function restartLabel(path) {
  const key = RESTART_LABELS[path];
  return CONFIG_FIELDS_BY_PATH.get(path)?.label ?? (key ? t(key) : path);
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
  if (value === null || value === undefined) return t('settings.editor.unset');
  if (Array.isArray(value)) return value.length ? value.join(', ') : t('settings.editor.unset');
  if (typeof value === 'boolean') return value ? t('settings.editor.on') : t('settings.editor.off');
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
  const fieldText = fields.length ? fields.map(labelOf).join(t('common.listSeparator')) : t('settings.apply.fieldsNone');
  if (apply.status === 'in-progress') {
    return `<div class="pending-restart" data-apply-result="in-progress">
      <div class="pending-restart-head"><span class="crt-tag crt-tag-warn">${escapeHtml(t('settings.apply.inProgress.tag'))}</span><span class="muted">${escapeHtml(t('settings.apply.inProgress.short'))}</span></div>
      <p class="muted pending-restart-note">${escapeHtml(t('settings.apply.inProgress.note', { fields: fields.join(', ') }))}</p>
    </div>`;
  }
  if (apply.status === 'applied') {
    const verify = Array.isArray(apply.verify) ? apply.verify : [];
    const failed = verify.filter((row) => row.ok === false);
    if (failed.length > 0) {
      const detail = failed.map((row) => `<li><b>${escapeHtml(labelOf(row.path))}</b> <code>${escapeHtml(row.path)}</code>`
        + `<span class="muted">${escapeHtml(t('settings.apply.fieldDetail', { configured: formatRestartValue(row.configured), actual: formatRestartValue(row.actual) }))}</span>`
        + (row.reason ? `<span class="pending-restart-reason">${escapeHtml(t('settings.apply.reason', { reason: String(row.reason) }))}</span>` : '')
        + '</li>').join('');
      return `<div class="pending-restart is-error" data-apply-result="mismatch">
        <div class="pending-restart-head"><span class="crt-tag crt-tag-error">${escapeHtml(t('settings.apply.mismatch.tag'))}</span><span class="muted">${escapeHtml(t('settings.apply.mismatch.summary', { count: failed.length }))}</span></div>
        <ul class="pending-restart-list">${detail}</ul>
      </div>`;
    }
    return `<div class="pending-restart is-ok" data-apply-result="applied">
      <div class="pending-restart-head"><span class="crt-tag crt-tag-ok">${escapeHtml(t('settings.apply.applied.tag'))}</span><span class="muted">${escapeHtml(fieldText)}</span></div>
      <p class="muted pending-restart-note">${escapeHtml(t('settings.apply.applied.note', { time: String(apply.at ?? '') }))}</p>
    </div>`;
  }
  if (apply.status === 'rolled-back' || apply.status === 'rollback-failed' || apply.status === 'failed') {
    const rolled = apply.status === 'rolled-back';
    return `<div class="pending-restart is-error" data-apply-result="${escapeHtml(apply.status)}">
      <div class="pending-restart-head"><span class="crt-tag crt-tag-error">${escapeHtml(t('settings.apply.mismatch.tag'))}</span><span class="muted">${escapeHtml(t(rolled ? 'settings.apply.rolledBack' : 'settings.apply.rollbackFailed'))}</span></div>
      <p class="muted pending-restart-note">${escapeHtml(t('settings.apply.reason', { reason: String(apply.reason ?? t('settings.apply.unknownReason')) }))}</p>
      <p class="muted pending-restart-note">${escapeHtml(t('settings.apply.fieldsInvolved', { fields: fieldText }))}${apply.backup ? `；${escapeHtml(t('settings.apply.backupLabel'))}<code>${escapeHtml(String(apply.backup))}</code>` : ''}</p>
    </div>`;
  }
  return '';
}

function pendingRestartBadge() {
  const count = pendingRestartItems().length;
  return count > 0 ? `<span class="crt-tag crt-tag-warn">${escapeHtml(t('settings.pending.count', { count }))}</span>` : '';
}

function pendingRestartBanner() {
  const items = pendingRestartItems();
  if (items.length === 0) return '';
  const envOverrides = Array.isArray(state.settings?.pendingRestartEnvOverrides) ? state.settings.pendingRestartEnvOverrides : [];
  const cmd = restartCommand();
  const managed = state.settings?.restart?.serviceManaged === true;
  const rows = items.map((item) => `<li><b>${escapeHtml(item.label ?? restartLabel(item.path))}</b>`
    + ` <code>${escapeHtml(item.path)}</code>`
    + `<span class="muted">${escapeHtml(t('settings.apply.fieldDetail', { configured: formatRestartValue(item.file), actual: formatRestartValue(item.running) }))}</span>`
    + `<span class="pending-restart-reason">${escapeHtml(t('settings.pending.reason', { reason: String(item.reason ?? t('settings.pending.reasonFallback')) }))}</span></li>`).join('');
  return `<div class="pending-restart" data-pending-restart="1">
    <div class="pending-restart-head">
      <span class="crt-tag crt-tag-warn">${escapeHtml(t('settings.pending.count', { count: items.length }))}</span>
      <span class="muted">${escapeHtml(t('settings.pending.head'))}</span>
    </div>
    <p class="muted pending-restart-note">${escapeHtml(t('settings.pending.note'))}${envOverrides.length > 0 ? escapeHtml(t('settings.pending.noteEnv', { vars: envOverrides.join(', ') })) : ''}</p>
    <ul class="pending-restart-list">${rows}</ul>
    <div class="pending-restart-cmd">
      <button class="btn btn-small btn-crt" type="button" data-cfg-action="restart" ${state.features?.writes && !MOCK ? '' : 'disabled'}>${escapeHtml(t('settings.pending.restart'))}</button>
      <code>${escapeHtml(cmd)}</code>
      <button class="btn btn-small btn-crt" type="button" data-copy="${escapeHtml(cmd)}">${escapeHtml(t('settings.pending.copyCommand'))}</button>
      <span class="cfg-restart-state muted"></span>
    </div>
    ${managed ? '' : `<p class="muted" style="font-size:11px">${escapeHtml(t('settings.pending.manual'))}</p>`}
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
  if (Array.isArray(value)) return value.length ? value.join(', ') : t('settings.editor.emptyDefault');
  if (typeof value === 'boolean') return value ? t('settings.editor.on') : t('settings.editor.off');
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
    + `<span><span class="cfg-eff-key">${escapeHtml(t('settings.editor.configured'))}</span> ${escapeHtml(formatRuntimeValue(configured))}</span>`
    + '<span>/</span>'
    + `<span><span class="cfg-eff-key">${escapeHtml(t('settings.editor.actual'))}</span> ${escapeHtml(formatRuntimeValue(actual))}</span>`
    + (pendingItem ? `<span class="cfg-pending"><span class="cfg-eff-key">${escapeHtml(t('settings.editor.pendingKey'))}</span> ${escapeHtml(t('settings.editor.pendingValue', { saved: formatRestartValue(pendingItem.file), current: formatRestartValue(pendingItem.running) }))}</span>` : '')
    + (showReason ? `<span class="cfg-reason"><span class="cfg-eff-key">${escapeHtml(t('settings.editor.reasonKey'))}</span> ${escapeHtml(reason)}</span>` : '')
    + (mismatch && !showReason ? `<span class="cfg-warn">${escapeHtml(t('settings.editor.mismatch'))}</span>` : '')
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
    ? t('settings.editor.defaultHint', { value: field.default }) : '';
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
  const defaultTag = initial.isDefault && hasDefault ? `<span class="cfg-default">${escapeHtml(t('settings.editor.default'))}</span>` : '';
  const warnMark = field.warn ? `<span class="cfg-warn-mark" title="${escapeHtml(t('settings.editor.riskTitle'))}" aria-label="${escapeHtml(t('settings.editor.riskAria'))}">⚠</span>` : '';
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
      : `<button class="btn btn-small btn-crt" type="button" data-copy="${escapeHtml(row.copyPayload)}">${escapeHtml(t('common.copy'))}</button>`}</dd>`).join('');
  return `<dl class="settings-kv">${cells}</dl>`;
}

// 主值 + 次行（已配置 / 实际）；一致=暗色，不一致=警示色；长值换行悬挂在值列
function valueWithEffective(mainHtml, { configured, effective }) {
  const mismatch = configured !== undefined && JSON.stringify(configured ?? null) !== JSON.stringify(effective ?? null);
  return `<span class="kv-main">${mainHtml}</span>`
    + `<span class="kv-sub${mismatch ? ' is-mismatch' : ''}">`
    + `<span>${escapeHtml(t('settings.editor.configured'))} ${escapeHtml(formatRuntimeValue(configured))}</span>`
    + `<span>/</span>`
    + `<span>${escapeHtml(t('settings.editor.actual'))} ${escapeHtml(formatRuntimeValue(effective))}</span>`
    + (mismatch ? `<span class="cfg-warn">${escapeHtml(t('settings.editor.mismatch'))}</span>` : '')
    + '</span>';
}

function fieldOf(path) {
  const field = CONFIG_FIELDS_BY_PATH.get(path);
  // 容错：schema 缺项（旧服务端 / 载荷异常）时退化为文本行，不整页崩
  if (!field) return { path, type: 'text', label: path, help: t('settings.editor.notInSchema') };
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

/** IA 分区标题/说明：key 优先（locale pack），缺 key 时回退中文兜底。 */
function localizedSection(section) {
  return {
    ...section,
    title: section.titleKey ? t(section.titleKey) : section.title,
    desc: section.descKey ? t(section.descKey) : section.desc,
  };
}

function renderAdvancedSections() {
  return IA_ADVANCED_SECTIONS.map((section) => {
    const copy = localizedSection(section);
    return settingsSectionHtml({
      id: copy.id,
      title: copy.title,
      desc: copy.desc,
      body: renderEditor(copy.fields),
    });
  }).join('');
}

function renderMcpSections() {
  return IA_MCP_SECTIONS.map((section) => {
    const copy = localizedSection(section);
    return settingsSectionHtml({
      id: copy.id,
      title: copy.title,
      desc: copy.desc,
      body: renderEditor(copy.fields),
    });
  }).join('');
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
        <h3>${escapeHtml(t('lock.settings.title'))} <span class="crt-tag crt-tag-warn">${escapeHtml(t('lock.settings.tag'))}</span></h3>
        <p class="settings-section-desc muted">${escapeHtml(t('lock.settings.desc'))}</p>
        <div class="locked-settings-actions">
          <button class="btn btn-primary" type="button" data-locked-action="create">${escapeHtml(t('lock.settings.create'))}</button>
          <button class="btn btn-crt" type="button" data-locked-action="join">${escapeHtml(t('lock.settings.join'))}</button>
        </div>
      </section>
      <section class="settings-section" data-locked-diagnostics>
        <h3>${escapeHtml(t('lock.settings.diagnostics'))} <span class="badge badge-muted">${escapeHtml(t('lock.settings.readonly'))}</span></h3>
        ${kvRows([
          kvRow(t('lock.settings.phase'), escapeHtml(String(status.phase ?? 'UNINITIALIZED'))),
          kvRow(t('lock.settings.home'), `<code>${escapeHtml(String(status.home ?? '—'))}</code>`),
          kvRow(t('lock.settings.deviceName'), escapeHtml(String(status.defaultDeviceName ?? status.hostname ?? '—'))),
          kvRow(t('lock.settings.port'), escapeHtml(String(status.mcpPort ?? '—'))),
        ])}
        <p class="settings-section-foot muted">${escapeHtml(t('lock.settings.foot'))}</p>
        <button class="btn btn-small btn-crt" type="button" id="settings-locked-copy">${escapeHtml(t('lock.settings.copy'))}</button>
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
  const extraButton = (item) => `<button class="settings-tab settings-tab-extra" type="button" data-settings-extra="${escapeHtml(item.opens)}">${escapeHtml(item.labelKey ? t(item.labelKey) : item.label)}</button>`;
  const panel = (id, inner) => `<section id="settings-panel-${id}" class="settings-panel" data-settings-panel="${id}" role="tabpanel"`
    + ` aria-labelledby="settings-tab-${id}"${id === activeTab ? '' : ' hidden'}>${inner}</section>`;
  if (!s) {
    // ?mock=1 无 settings 载荷：仍渲染五页签与安全卡（无网络验收路径；其余设置保持加载态）
    if (MOCK && state.security) {
      body.innerHTML = `
        <div class="settings-tabs" role="tablist" aria-label="${escapeHtml(t('settings.tabsAria'))}" data-i18n-aria-label="settings.tabsAria">${IA_TABS.map(tabButton).join('')}${
          IA_SETTINGS_EXTRA.map(extraButton).join('')
        }</div>
        <div class="settings-scroll">
          ${panel('common', `<section class="settings-section" data-settings-common-status><h3>${escapeHtml(t('settings.mock.commonTitle'))} <span class="badge badge-muted">${escapeHtml(t('settings.common.readonly'))}</span></h3><p class="muted">${escapeHtml(t('settings.mock.commonNote'))}</p></section>`)}
          ${panel('security', `<section id="settings-security-slot" class="settings-slot" data-settings-slot="security" data-security-level="${escapeHtml(state.security?.level ?? 'low')}" tabindex="-1">${securityCardHtml()}</section>`)}
          ${panel('assistants', `<p class="muted">${escapeHtml(t('settings.mock.assistants'))}</p>`)}
          ${panel('mcp', `<p class="muted">${escapeHtml(t('settings.mock.config'))}</p>`)}
          ${panel('advanced', `<p class="muted">${escapeHtml(t('settings.mock.config'))}</p>`)}
        </div>
      `;
      bindSecurityCard(body);
      return;
    }
    body.innerHTML = `<p class="muted">${escapeHtml(t('settings.loading'))}</p>`;
    return;
  }
  rebuildConfigFields();
  const securityLevel = state.security?.level ?? null;

  body.innerHTML = `
    ${pendingRestartBanner()}
    ${applyResultBanner()}
    <div class="settings-tabs" role="tablist" aria-label="${escapeHtml(t('settings.tabsAria'))}" data-i18n-aria-label="settings.tabsAria">${IA_TABS.map(tabButton).join('')}${
      IA_SETTINGS_EXTRA.map(extraButton).join('')
    }</div>
    <div class="settings-scroll">
    ${panel('common', `
      ${languageSettingsRowHtml()}
      <div class="settings-resident" id="settings-resident">${serviceRowHtml(state.service, state.serviceMsg)}</div>
      ${wizardRowHtml(typeof window.mebularDesktop?.openWizard === 'function')}
      <section class="settings-section" data-settings-common-status>
        <h3>${escapeHtml(t('settings.common.statusTitle'))} <span class="badge badge-muted">${escapeHtml(t('settings.common.readonly'))}</span></h3>
        ${kvRows([
          kvRow('P2P', s.network.enabled ? t('settings.common.enabled') : t('settings.common.disabled')),
          kvRow(t('settings.common.inviteService'), s.join?.enabled ? t('settings.common.enabled') : t('settings.common.inviteDisabled')),
          kvRow(t('settings.common.securityLevel'), securityLevel ? securityLevelLabel(securityLevel) : '—'),
        ])}
        <p class="settings-note muted">${escapeHtml(t('settings.common.note'))}</p>
      </section>
      ${cloudCardHtml()}
    `)}
    ${panel('security', `<section id="settings-security-slot" class="settings-slot" data-settings-slot="security" data-security-level="${escapeHtml(state.security?.level ?? 'low')}" tabindex="-1">${securityCardHtml()}</section>`)}
    ${panel('assistants', `<div id="assistants-panel">${assistantsPanelHtml({ clients: state.clients, ui: { ...state, addForm: state.addForm ? assistantAddFormHtml(state.addForm) : '' } })}</div>`)}
    ${panel('mcp', `
      ${renderMcpSections()}
      <details class="settings-fold" id="mcp-danger-fold" data-settings-fold="mcp-danger">
        <summary>${escapeHtml(foldLabel('mcp-danger'))}</summary>
        ${IA_MCP_DANGER_LINE_KEYS.map((key) => `<p class="muted">${escapeHtml(t(key))}</p>`).join('')}
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
  // 设置页整体重建后重新增强：语言行 / MCP auth select / 助手配置格式等动态控件。
  enhanceSelects(body);
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
const SECURITY_REJECTION_KEYS = {
  'missing-proof': 'settings.security.rejection.missingProof',
  'invalid-proof': 'settings.security.rejection.invalidProof',
  'approval-missing-or-not-causal': 'settings.security.rejection.approvalMissing',
  'approval-approver-revoked-at-its-order': 'settings.security.rejection.approverRevoked',
  'approver-not-admitted-at-approval': 'settings.security.rejection.approverNotAdmitted',
  'approver-equals-author': 'settings.security.rejection.approverEqualsAuthor',
  'approver-equals-subject': 'settings.security.rejection.approverEqualsSubject',
  'stale-or-replayed-nonce': 'settings.security.rejection.nonceReplayed',
};

function securityLevelLabel(level) {
  const key = `security.level.${level}`;
  if (t.has(key)) return t(key);
  return SECURITY_LEVEL_LABEL[level] ?? '—';
}

function securityLevelTag(level) {
  return level === 'high' ? 'crt-tag-ok' : level === 'medium' ? 'crt-tag-warn' : 'crt-tag';
}

function securityReasonLabel(reason) {
  const key = SECURITY_REJECTION_KEYS[reason];
  if (key) return t(key);
  return String(reason ?? t('settings.security.unknownReason'));
}

function securityOpText(record) {
  const target = record?.target ?? '—';
  if (record?.op === 'kick') return t('settings.security.op.kick', { target });
  if (record?.op === 'restore') return t('settings.security.op.restore', { target });
  if (record?.op === 'join') {
    return record.namespace
      ? t('settings.security.op.joinNs', { namespace: record.namespace })
      : t('settings.security.op.join');
  }
  if (record?.op === 'tier') return t('settings.security.op.tier', { level: securityLevelLabel(record.level) });
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
      title: t(IA_SECURITY_SECTIONS.level.titleKey),
      desc: t(IA_SECURITY_SECTIONS.level.descKey),
      body: `<p class="muted sec-loading">${escapeHtml(t('settings.security.loading'))}</p>`,
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
      ? `<button class="btn btn-small btn-crt" type="button" data-security-action="upgrade" data-level="${tier}" ${writes ? '' : 'disabled'}>${escapeHtml(t('settings.security.upgradeTo', { level: securityLevelLabel(tier) }))}</button>`
      : current ? `<span class="crt-tag ${securityLevelTag(level)}" data-security-current>${escapeHtml(t('settings.security.current'))}</span>` : '';
    return `<li class="sec-tier${current ? ' is-current' : ''}" data-security-tier="${tier}">
      <div class="sec-tier-main">
        <div class="sec-tier-head"><span class="sec-tier-title">${escapeHtml(t(SECURITY_LEVEL_TITLE_KEY[tier]))}</span></div>
        <p class="sec-tier-note muted">${escapeHtml(t(SECURITY_LEVEL_NOTE_KEY[tier]))}</p>
      </div>
      <div class="sec-tier-action">${action}</div>
    </li>`;
  }).join('');

  const fingerprint = totp.fingerprint ?? null;
  const totpStatus = totp.imported === true
    ? `<span class="sec-ok">${escapeHtml(t('settings.security.totp.imported'))}</span> <code>${escapeHtml(fingerprint ?? '—')}</code>`
    : `<span class="crt-warn">${escapeHtml(t('settings.security.totp.notImported'))}</span> <span class="muted">${escapeHtml(t('settings.security.totp.notImportedNote'))}</span>`;
  const totpActions = `${totp.imported === true
    ? `<button class="btn btn-small btn-crt" type="button" data-security-action="totp-show" ${writes ? '' : 'disabled'}>${escapeHtml(t('settings.security.totp.show'))}</button>`
    : ''}
    <button class="btn btn-small btn-crt" type="button" data-security-action="totp-import" ${writes ? '' : 'disabled'}>${escapeHtml(t('settings.security.totp.import'))}</button>
    ${totp.imported !== true && isRoot
      ? `<button class="btn btn-small btn-crt" type="button" data-security-action="totp-generate" ${writes ? '' : 'disabled'}>${escapeHtml(t('settings.security.totp.generate'))}</button>`
      : ''}`;

  const recoveryStatus = recovery.registered === true
    ? `<span class="sec-ok">${escapeHtml(t('settings.security.recovery.generated'))}</span> <code>${escapeHtml(String(recovery.keyId ?? '').slice(0, 8))}</code>
       <span class="muted">${escapeHtml(t(recovery.mode === 'rotate' ? 'settings.security.recovery.rotated' : 'settings.security.recovery.registered'))} ${escapeHtml(formatTime(recovery.createdAt))}</span>
       ${recovery.lastUsedAt ? `<span class="muted">${escapeHtml(t('settings.security.recovery.lastUsed', { time: formatTime(recovery.lastUsedAt) }))}</span>` : ''}
       ${recovery.current === false ? `<span class="crt-tag crt-tag-warn">${escapeHtml(t('settings.security.recovery.keyMismatch'))}</span>` : ''}`
    : `<span class="muted">${escapeHtml(t('settings.security.recovery.notGenerated'))}</span>`;
  const recoveryActions = recovery.registered === true
    ? `<button class="btn btn-small btn-crt" type="button" data-security-action="recovery-rotate" ${writes ? '' : 'disabled'}>${escapeHtml(t('settings.security.recovery.rotate'))}</button>`
    : level === 'high'
      ? `<button class="btn btn-small btn-crt" type="button" data-security-action="recovery-generate" ${writes ? '' : 'disabled'}>${escapeHtml(t('settings.security.recovery.generate'))}</button>`
      : '';

  const incomingRows = incoming.map((a) => `
    <li class="sec-approval-row" data-approval-id="${escapeHtml(a.approvalId)}">
      <div class="sec-approval-head">
        <b>${escapeHtml(securityOpText(a))}</b>
        <span class="muted">${escapeHtml(t('settings.security.approval.from', { device: a.initiator ?? '—' }))}</span>
      </div>
      <div class="sec-approval-inline">
        <span class="sec-pairing" data-security-pairing aria-live="polite">${escapeHtml(a.pairingCode ?? '—')}</span>
        <span class="sec-approval-meta muted">${escapeHtml(t('settings.security.approval.verifyMeta', { time: formatTime(a.expiresAt) }))}</span>
        <button class="btn btn-small btn-crt" type="button" data-security-approve="${escapeHtml(a.approvalId)}" ${writes ? '' : 'disabled'}>${escapeHtml(t('settings.security.approval.approve'))}</button>
        <button class="btn btn-small btn-crt btn-crt-danger" type="button" data-security-deny="${escapeHtml(a.approvalId)}" ${writes ? '' : 'disabled'}>${escapeHtml(t('settings.security.approval.deny'))}</button>
      </div>
    </li>`).join('');
  const outgoingRows = outgoing.length > 0
    ? `<p class="sec-outgoing muted">${escapeHtml(t('settings.security.approval.waitingPrefix'))}${outgoing.map((a) => t('settings.security.approval.item', {
      op: escapeHtml(securityOpText(a)),
      code: `<span class="sec-pairing-inline">${escapeHtml(a.pairingCode ?? '—')}</span>`,
    })).join(escapeHtml(t('common.listSeparator')))}</p>`
    : '';
  const pendingBlock = incoming.length > 0 || outgoing.length > 0
    ? `<div class="sec-pending sec-pending-top" data-security-pending>
        ${incoming.length > 0 ? `<div class="sec-pending-head"><b>${escapeHtml(t('settings.security.approval.pending'))}</b><span class="crt-tag crt-tag-warn">${escapeHtml(t('settings.security.approval.pendingCount', { count: incoming.length }))}</span></div>` : ''}
        ${incomingRows ? `<ul class="sec-approval-list">${incomingRows}</ul>` : ''}
        ${outgoingRows}
      </div>`
    : '';

  const rejectionReasons = [...new Set(rejections.map((r) => securityReasonLabel(r.reason)))];
  const rejectionBlock = rejections.length > 0
    ? `<p class="crt-warn sec-rejections" data-security-rejections>${escapeHtml(t('settings.security.rejections', {
      count: rejections.length,
      reasons: rejectionReasons.length > 3
        ? t('settings.security.rejectionsMore', { reasons: rejectionReasons.slice(0, 3).join(t('common.listSeparator')) })
        : rejectionReasons.join(t('common.listSeparator')),
    }))}</p>`
    : '';

  const admittedLine = admitted.length > 0
    ? `<p class="settings-section-foot muted" data-security-admitted>${escapeHtml(t('settings.security.admitted', {
      count: admitted.length,
      devices: admitted.join(' · '),
    }))}</p>`
    : '';

  const lowerTiers = ['low', 'medium', 'high'].filter((tier) => SECURITY_LEVEL_ORDER[tier] < SECURITY_LEVEL_ORDER[level]);
  const downgrade = lowerTiers.length > 0
    ? `<div class="sec-downgrade sec-downgrade-inline">
        <span class="sec-downgrade-label muted">${escapeHtml(t('settings.security.downgrade'))}</span>
        ${lowerTiers.map((tier) => `<button class="btn btn-small btn-crt btn-crt-danger" type="button" data-security-action="downgrade" data-level="${tier}" ${writes ? '' : 'disabled'}>${escapeHtml(t('settings.security.downgradeTo', { level: securityLevelLabel(tier) }))}</button>`).join('')}
        <span class="muted">${escapeHtml(t(level === 'high' ? 'settings.security.downgrade.highNote' : 'settings.security.downgrade.mediumNote'))}</span>
      </div>`
    : '';

  const mismatchLine = mismatch
    ? `<p class="crt-warn sec-anomaly">${escapeHtml(t('settings.security.totp.mismatch'))}</p>`
    : '';

  return `
    ${settingsSectionHtml({
      id: 'security-level',
      title: t(IA_SECURITY_SECTIONS.level.titleKey),
      desc: t(IA_SECURITY_SECTIONS.level.descKey),
      body: `${pendingBlock}<ol class="sec-ladder" aria-label="${escapeHtml(t('settings.security.ladderAria'))}">${ladder}</ol>
        ${admittedLine}
        <p class="settings-section-foot muted" data-security-boundary>${escapeHtml(t(SECURITY_BOUNDARY_KEY))}</p>
        ${downgrade}${rejectionBlock}`,
    })}
    ${settingsSectionHtml({
      id: 'security-totp',
      title: t(IA_SECURITY_SECTIONS.totp.titleKey),
      desc: t(IA_SECURITY_SECTIONS.totp.descKey),
      chip: mismatch ? `<span class="crt-tag crt-tag-error">${escapeHtml(t('settings.security.totp.mismatchTag'))}</span>` : '',
      body: `${mismatchLine}
        <dl class="settings-kv sec-kv">
          <dt>${escapeHtml(t('settings.security.status'))}</dt><dd class="kv-value">${totpStatus}</dd><dd class="kv-action sec-actions">${totpActions}</dd>
        </dl>`,
      foot: t(SECURITY_TOTP_FOOT_KEY),
    })}
    ${settingsSectionHtml({
      id: 'security-recovery',
      title: t(IA_SECURITY_SECTIONS.recovery.titleKey),
      desc: t(IA_SECURITY_SECTIONS.recovery.descKey),
      body: `<dl class="settings-kv sec-kv">
          <dt>${escapeHtml(t('settings.security.status'))}</dt><dd class="kv-value">${recoveryStatus}</dd><dd class="kv-action sec-actions">${recoveryActions}</dd>
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

function securityModalConfig({ title, body, confirmLabel = t('common.confirm'), onConfirm = null, hideClose = false, blockClose = false, recovery = null } = {}) {
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
  confirm.textContent = t('security.dialog.busy');
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

function securityCodeModal({ title, intro, confirmLabel = t('security.code.confirm'), onSubmit }) {
  securityModalConfig({
    title,
    body: `<p class="muted">${escapeHtml(intro)}</p>
      <div class="field"><label for="security-code">${escapeHtml(t('security.code.label'))}</label>
      <input id="security-code" class="crt-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" aria-describedby="security-code-help" /></div>
      <p id="security-code-help" class="cfg-help muted">${escapeHtml(t('security.code.help'))}</p>`,
    confirmLabel,
    onConfirm: async () => {
      const code = $('#security-code')?.value?.trim() ?? '';
      if (!/^\d{6}$/.test(code)) {
        securitySetError(t('security.code.invalid'));
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
      title: t('security.upgrade.recoveryOnce.title'),
      intro: t('security.upgrade.recoveryOnce.intro'),
    });
  } else {
    showToast(t('security.tier.set', { level: securityLevelLabel(level) }));
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
          title: t('security.upgrade.title', { level: targetLabel }),
          intro: t('security.upgrade.codeIntro'),
          confirmLabel: t('security.upgrade.title', { level: targetLabel }),
          onSubmit: async (code) => {
            closeSecurityAction();
            await securityPostTier(targetLevel, { code });
          },
        });
        return;
      }
      const ok = await confirmModal({
        title: t('security.upgrade.title', { level: targetLabel }),
        body: targetLevel === 'high'
          ? t('security.upgrade.highBody')
          : t('security.upgrade.mediumBody'),
        confirmLabel: t('security.upgrade.title', { level: targetLabel }),
      });
      if (!ok) return;
      await securityPostTier(targetLevel);
      return;
    }
    // 降级
    if (current === 'high') {
      await securityStartApproval({
        title: t('security.downgrade.coSignTitle', { level: targetLabel }),
        op: 'tier',
        level: targetLevel,
        intro: t('security.downgrade.coSignIntro'),
        onApproved: async (approvalId) => {
          await api('/admin/api/security/tier', { method: 'POST', body: { level: targetLevel, approvalId } });
          closeSecurityAction();
          await refresh();
          showToast(t('security.tier.set', { level: targetLabel }));
        },
        recovery: () => securityTierViaRecovery(targetLevel),
      });
      return;
    }
    securityCodeModal({
      title: t('security.downgrade.title', { level: targetLabel }),
      intro: t('security.downgrade.codeIntro'),
      confirmLabel: t('security.downgrade.confirm', { level: targetLabel }),
      onSubmit: async (code) => {
        closeSecurityAction();
        await securityPostTier(targetLevel, { code });
      },
    });
  } catch (error) {
    window.alert(t('security.tier.failed', { message: error.message }));
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
      <p class="cfg-help muted">${escapeHtml(t('security.approval.pairingHelp'))}</p>
      ${kvRows([
        kvRow(t('security.approval.kvAction'), escapeHtml(securityOpText(request))),
        kvRow(t('security.approval.kvInitiator'), `<code>${escapeHtml(self ?? '—')}</code>`),
        kvRow(t('security.approval.kvExpires'), escapeHtml(formatTime(request.expiresAt))),
        kvRow(t('security.approval.kvAdmitted'), admitted.length ? escapeHtml(admitted.join(' · ')) : `<span class="muted">${escapeHtml(t('security.approval.noAdmitted'))}</span>`),
      ])}
      <p class="sec-wait" id="security-wait-status" aria-live="polite"><span class="sec-wait-dot" aria-hidden="true"></span>${escapeHtml(t('security.approval.waitingDots'))}</p>
      <p class="cfg-help muted">${escapeHtml(t('security.approval.whySafe'))}</p>
      ${typeof recovery === 'function'
        ? `<div class="domain-actions"><button class="btn btn-small btn-crt" type="button" data-security-recovery-switch>${escapeHtml(t('security.approval.useRecovery'))}</button></div>
           <p class="cfg-help muted">${escapeHtml(t('security.approval.recoverySwitchNote'))}</p>`
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
        if (status) status.innerHTML = `<span class="sec-ok">${escapeHtml(t('security.approval.approved'))}</span>`;
        try {
          await onApproved(request.approvalId, decided);
        } catch (error) {
          if (status) status.innerHTML = `<span class="crt-warn">${escapeHtml(t('security.approval.approvedFailed', { message: error.message }))}</span>`;
          securitySetError(t('security.approval.executeFailed', { message: error.message }));
        }
        return;
      }
      if (decided?.decision === 'deny') {
        stopSecurityPoll();
        const status = $('#security-wait-status');
        if (status) {
          status.innerHTML = `<span class="crt-warn">${escapeHtml(t('security.approval.denied'))}</span> <span class="muted">${escapeHtml(t('security.approval.deniedNote'))}</span>`;
          status.dataset.securityDenied = '1';
        }
        void refresh();
        return;
      }
      const expired = typeof request.expiresAt === 'number' && Date.now() > request.expiresAt;
      if (expired) {
        stopSecurityPoll();
        const status = $('#security-wait-status');
        if (status) status.innerHTML = `<span class="crt-warn">${escapeHtml(t('security.approval.expired'))}</span> <span class="muted">${escapeHtml(t('security.approval.expiredNote'))}</span>`;
        return;
      }
      const status = $('#security-wait-status');
      if (status) {
        const left = Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000));
        status.innerHTML = `<span class="sec-wait-dot" aria-hidden="true"></span>${escapeHtml(t('security.approval.waitingDots'))} <span class="muted">${escapeHtml(t('security.approval.waitingLeft', { seconds: left }))}</span>`;
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
    title: t('security.approval.confirmTitle', { op: securityOpText(record) }),
    body: t('security.approval.confirmBody', {
      device: record.initiator,
      code: record.pairingCode,
      time: formatTime(record.expiresAt),
    }),
    confirmLabel: t('settings.security.approval.approve'),
  });
  if (!ok) return;
  try {
    await api(`/admin/api/security/approvals/${encodeURIComponent(approvalId)}/approve`, { method: 'POST', body: {} });
    await refresh();
    showToast(t('security.approval.approvedToast'));
  } catch (error) {
    window.alert(t('security.approval.approveFailed', { message: error.message }));
  }
}

async function securityDeny(approvalId) {
  const record = (state.security?.pendingApprovals ?? []).find((a) => a?.approvalId === approvalId);
  if (!record) return;
  const ok = await confirmModal({
    title: t('security.deny.title'),
    body: t('security.deny.body', { op: securityOpText(record), device: record.initiator }),
    confirmLabel: t('settings.security.approval.deny'),
  });
  if (!ok) return;
  try {
    await api(`/admin/api/security/approvals/${encodeURIComponent(approvalId)}/deny`, { method: 'POST', body: {} });
    await refresh();
    showToast(t('security.deny.toast'));
  } catch (error) {
    window.alert(t('security.deny.failed', { message: error.message }));
  }
}

function securityTotpImport() {
  securityModalConfig({
    title: t('security.totp.import.title'),
    body: `<p class="muted">${escapeHtml(t('security.totp.import.body'))}</p>
      <div class="field"><label for="security-totp-secret">${escapeHtml(t('security.totp.import.secretLabel'))}</label>
      <textarea id="security-totp-secret" class="crt-input" rows="3" spellcheck="false" placeholder="${escapeHtml(t('security.totp.import.secretPlaceholder'))}"></textarea></div>
      <div class="field"><label for="security-totp-fingerprint">${escapeHtml(t('security.totp.import.fingerprintLabel'))}</label>
      <input id="security-totp-fingerprint" class="crt-input" type="text" maxlength="16" placeholder="a1b2c3d4" /></div>
      <p class="cfg-help muted">${escapeHtml(t('security.totp.import.help'))}</p>`,
    confirmLabel: t('security.totp.import.confirm'),
    onConfirm: async () => {
      const secret = $('#security-totp-secret')?.value?.trim() ?? '';
      if (!secret) {
        securitySetError(t('security.totp.import.missing'));
        return;
      }
      const expectedFingerprint = $('#security-totp-fingerprint')?.value?.trim() ?? '';
      const result = await api('/admin/api/security/totp/import', {
        method: 'POST',
        body: { secret, ...(expectedFingerprint ? { expectedFingerprint } : {}) },
      });
      await refresh();
      closeSecurityAction();
      showToast(t('security.totp.import.done', { fingerprint: result.fingerprint }));
    },
  });
  setTimeout(() => $('#security-totp-secret')?.focus(), 0);
}

function securitySeedDisplay(seed, { generated = false } = {}) {
  const groupText = Array.isArray(seed.groups)
    ? seed.groups.join(' ')
    : String(seed.groups ?? seed.secret ?? '');
  const qr = typeof seed.qrSvg === 'string' && seed.qrSvg.length > 0
    ? `<div class="readout-block qr-block"><span class="domain-label">${escapeHtml(t('security.totp.qrIntro'))}</span>
       <img class="qr-img" alt="${escapeHtml(t('security.totp.qrAlt'))}" src="data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(seed.qrSvg)))}" /></div>`
    : `<p class="cfg-help muted">${escapeHtml(t('security.totp.qrUnavailable'))}</p>`;
  securityModalConfig({
    title: generated ? t('security.totp.seed.sharedTitle') : t('security.totp.seed.title'),
    hideClose: false,
    body: `<div id="totp-seed-display" class="sec-seed" tabindex="-1">
        <p class="crt-warn">${escapeHtml(seed.warning ?? t('security.totp.seed.warningDefault'))}</p>
        ${qr}
        <div class="readout-block"><span class="domain-label">${escapeHtml(t('security.totp.seed.groups'))}</span><code class="sec-seed-groups">${escapeHtml(groupText)}</code></div>
        <div class="readout-block"><span class="domain-label">${escapeHtml(t('security.totp.seed.uri'))}</span><code class="sec-seed-uri">${escapeHtml(seed.otpauth ?? '')}</code></div>
        <p class="muted">${escapeHtml(t('security.totp.seed.fingerprintLabel'))}<code>${escapeHtml(seed.fingerprint ?? '—')}</code>${escapeHtml(t('security.totp.seed.fingerprintNote'))}</p>
        <p class="cfg-help muted">${escapeHtml(t('security.totp.seed.noScreenshot'))}</p>
      </div>`,
  });
  setTimeout(() => { $('#totp-seed-display')?.focus(); }, 0);
}

async function securityTotpShow() {
  securityCodeModal({
    title: t('security.totp.show.title'),
    intro: t('security.totp.show.intro'),
    confirmLabel: t('security.totp.show.confirm'),
    onSubmit: async (code) => {
      const seed = await api('/admin/api/security/totp/show', { method: 'POST', body: { code } });
      securitySeedDisplay(seed);
    },
  });
}

async function securityTotpGenerate() {
  const ok = await confirmModal({
    title: t('security.totp.generate.title'),
    body: t('security.totp.generate.body'),
    confirmLabel: t('security.totp.generate.confirm'),
  });
  if (!ok) return;
  try {
    const seed = await api('/admin/api/security/totp/show', { method: 'POST', body: { generate: true } });
    await refresh();
    securitySeedDisplay(seed, { generated: true });
  } catch (error) {
    window.alert(t('security.totp.generate.failed', { message: error.message }));
  }
}

function securityShowRecoveryOnce(codeFormatted, { title, intro = '' } = {}) {
  securityModalConfig({
    title,
    hideClose: true,
    blockClose: true,
    body: `<p class="muted">${escapeHtml(intro)}</p>
      <div id="security-recovery-once" class="sec-once-code" data-security-once tabindex="-1" aria-live="polite">${escapeHtml(codeFormatted)}</div>
      <p class="crt-warn">${escapeHtml(t('security.recovery.once.warning'))}</p>
      <p class="muted">${escapeHtml(t('security.recovery.once.after'))}</p>
      <div class="domain-actions"><button class="btn btn-crt" type="button" data-security-ack>${escapeHtml(t('security.recovery.once.ack'))}</button></div>`,
  });
  setTimeout(() => {
    const once = $('#security-recovery-once');
    if (once) once.focus();
  }, 0);
}

async function securityRecoveryRotate() {
  securityModalConfig({
    title: t('security.recovery.rotate.title'),
    body: `<p class="muted">${escapeHtml(t('security.recovery.rotate.body'))}</p>
      <div class="field"><label for="security-recovery-old">${escapeHtml(t('security.recovery.rotate.oldLabel'))}</label>
      <input id="security-recovery-old" class="crt-input" type="text" autocomplete="off" spellcheck="false" placeholder="XXXX XXXX …" /></div>
      <p class="cfg-help muted">${escapeHtml(t('security.recovery.rotate.help'))}</p>`,
    confirmLabel: t('security.recovery.rotate.confirm'),
    onConfirm: async () => {
      const oldCode = $('#security-recovery-old')?.value?.trim() ?? '';
      if (!oldCode) {
        securitySetError(t('security.recovery.rotate.missing'));
        return;
      }
      const result = await api('/admin/api/security/recovery/rotate', { method: 'POST', body: { oldCode } });
      await refresh();
      securityShowRecoveryOnce(result.codeFormatted ?? result.code, {
        title: t('security.recovery.rotate.newTitle'),
        intro: t('security.recovery.rotate.newIntro', { keyId: String(result.oldKeyId ?? '').slice(0, 8) }),
      });
    },
  });
  setTimeout(() => $('#security-recovery-old')?.focus(), 0);
}

async function securityRecoveryGenerate() {
  const ok = await confirmModal({
    title: t('security.recovery.generate.title'),
    body: t('security.recovery.generate.body'),
    confirmLabel: t('security.recovery.generate.confirm'),
  });
  if (!ok) return;
  try {
    const result = await api('/admin/api/security/recovery/generate', { method: 'POST', body: {} });
    await refresh();
    securityShowRecoveryOnce(result.codeFormatted ?? result.code, { title: t('security.recovery.once.offlineTitle') });
  } catch (error) {
    window.alert(t('security.recovery.generate.failed', { message: error.message }));
  }
}

const SECURITY_RECOVERY_ERROR_KEYS = {
  recovery_mismatch: 'security.recovery.error.mismatch',
  recovery_missing: 'security.recovery.error.missing',
  recovery_invalid: 'security.recovery.error.invalid',
  recovery_not_applicable: 'security.recovery.error.notApplicable',
  recovery_sign_failed: 'security.recovery.error.signFailed',
};

function securityRecoveryErrorText(error) {
  const key = SECURITY_RECOVERY_ERROR_KEYS[error?.payload?.error];
  if (key) return t(key);
  return error?.message ?? t('security.recovery.error.fallback');
}

/** 恢复码输入（高档「另一台设备不在」路径）：只用于本次签名，不回显、不进 localStorage。 */
function securityRecoveryCodeModal({ title, intro, confirmLabel = t('security.recovery.code.confirm'), onSubmit }) {
  securityModalConfig({
    title,
    body: `<p class="muted">${escapeHtml(intro)}</p>
      <div class="field"><label for="security-recovery-code">${escapeHtml(t('security.recovery.code.label'))}</label>
      <input id="security-recovery-code" class="crt-input" type="password" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-…" aria-describedby="security-recovery-help" /></div>
      <p id="security-recovery-help" class="cfg-help muted">${escapeHtml(t('security.recovery.code.help'))}</p>`,
    confirmLabel,
    onConfirm: async () => {
      const input = $('#security-recovery-code');
      const code = input?.value?.trim() ?? '';
      if (!code) {
        securitySetError(t('security.recovery.code.missing'));
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
    title: t('security.revoke.viaRecovery.title'),
    intro: t('security.revoke.viaRecovery.intro'),
    onSubmit: async (code) => {
      await api(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/revoke`, {
        method: 'POST',
        body: { recoveryCode: code },
      });
      closeSecurityAction();
      await refresh();
      showToast(t('security.revoke.viaRecovery.toast'));
    },
  });
}

async function securityTierViaRecovery(targetLevel) {
  const targetLabel = securityLevelLabel(targetLevel);
  securityRecoveryCodeModal({
    title: t('security.tier.viaRecovery.title', { level: targetLabel }),
    intro: t('security.tier.viaRecovery.intro'),
    onSubmit: async (code) => {
      await api('/admin/api/security/tier', { method: 'POST', body: { level: targetLevel, recoveryCode: code } });
      closeSecurityAction();
      await refresh();
      showToast(t('security.tier.setRecovery', { level: targetLabel }));
    },
  });
}

/** 移出改道（SPEC §5.2）：low 直接确认；medium 要码；high 会签或恢复码。 */
async function securityRevokeFlow(device) {
  const level = state.security?.level ?? 'low';
  const ok = await confirmModal({
    title: t('security.revoke.title'),
    body: `${t('security.revoke.bodyIntro', { device: device.deviceId })}\n\n`
      + (level === 'high'
        ? t('security.revoke.gate.high')
        : level === 'medium'
          ? t('security.revoke.gate.medium')
          : t('security.revoke.gate.low')),
    confirmLabel: t('security.revoke.title'),
  });
  if (!ok) return;
  if (level === 'high') {
    try {
      await securityStartApproval({
        title: t('security.revoke.coSignTitle'),
        op: 'kick',
        target: device.deviceId,
        intro: t('security.revoke.intro', { device: device.deviceId }),
        onApproved: async (approvalId) => {
          await api(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/revoke`, { method: 'POST', body: { approvalId } });
          closeSecurityAction();
          await refresh();
          showToast(t('security.revoke.coSignToast'));
        },
        recovery: () => securityRevokeViaRecovery(device),
      });
    } catch (error) {
      window.alert(t('security.revoke.startFailed', { message: error.message }));
    }
    return;
  }
  if (level === 'medium') {
    securityCodeModal({
      title: t('security.revoke.codeTitle'),
      intro: t('security.revoke.codeIntro'),
      confirmLabel: t('security.revoke.title'),
      onSubmit: async (code) => {
        await api(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/revoke`, { method: 'POST', body: { code } });
        closeSecurityAction();
        await refresh();
        showToast(t('security.revoke.toast'));
      },
    });
    return;
  }
  await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/revoke`, {}, t('security.revoke.toast'));
}

/** 恢复改道：low 直接确认；medium 要码；high 会签或恢复码。 */
async function securityRestoreFlow(device) {
  const level = state.security?.level ?? 'low';
  const ok = await confirmModal({
    title: t('security.restore.title'),
    body: `${t('security.restore.bodyIntro', { device: device.deviceId })}\n\n`
      + (level === 'high'
        ? t('security.restore.gate.high')
        : level === 'medium'
          ? t('security.revoke.gate.medium')
          : t('security.revoke.gate.low')),
    confirmLabel: t('security.restore.title'),
  });
  if (!ok) return;
  if (level === 'high') {
    await securityStartApproval({
      title: t('security.restore.coSignTitle'),
      op: 'restore',
      target: device.deviceId,
      intro: t('security.restore.intro', { device: device.deviceId }),
      onApproved: async (approvalId) => {
        await api(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/restore`, { method: 'POST', body: { approvalId } });
        closeSecurityAction();
        await refresh();
        showToast(t('security.restore.coSignToast'));
      },
      recovery: async () => {
        securityRecoveryCodeModal({
          title: t('security.restore.viaRecovery.title'),
          intro: t('security.restore.viaRecovery.intro'),
          onSubmit: async (code) => {
            await api(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/restore`, {
              method: 'POST',
              body: { recoveryCode: code },
            });
            closeSecurityAction();
            await refresh();
            showToast(t('security.restore.viaRecovery.toast'));
          },
        });
      },
    });
    return;
  }
  if (level === 'medium') {
    securityCodeModal({
      title: t('security.restore.codeTitle'),
      intro: t('security.restore.codeIntro'),
      confirmLabel: t('security.restore.title'),
      onSubmit: async (code) => {
        await api(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/restore`, { method: 'POST', body: { code } });
        closeSecurityAction();
        await refresh();
        showToast(t('security.restore.toast'));
      },
    });
    return;
  }
  await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/restore`, {}, t('security.restore.toast'));
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
    if (!apply) return `<p class="muted">${escapeHtml(t('settings.diag.noApply'))}</p>`;
    const statusKey = {
      applied: 'settings.diag.applyStatus.applied',
      'in-progress': 'settings.diag.applyStatus.inProgress',
      mismatch: 'settings.diag.applyStatus.mismatch',
      'rolled-back': 'settings.diag.applyStatus.rolledBack',
      'rollback-failed': 'settings.diag.applyStatus.rollbackFailed',
      failed: 'settings.diag.applyStatus.failed',
    }[apply.status];
    const statusText = statusKey ? t(statusKey) : String(apply.status);
    const verify = Array.isArray(apply.verify) ? apply.verify : [];
    return kvRows([
      kvRow(t('settings.diag.status'), escapeHtml(statusText)),
      kvRow(t('settings.diag.time'), escapeHtml(String(apply.at ?? '—'))),
      kvRow(t('settings.diag.fields'), escapeHtml((apply.fields ?? []).join(', ') || '—')),
      ...(apply.reason ? [kvRow(t('settings.diag.reason'), escapeHtml(String(apply.reason)))] : []),
      ...(apply.backup ? [copyRowOf(t('settings.diag.backup'), String(apply.backup))] : []),
      ...(verify.length ? [kvRow(t('settings.diag.verify'), verify.map((row) => `${escapeHtml(row.path)}: ${row.ok === true ? '✓' : row.ok === false ? '✗' : '—'}`).join(' · '))] : []),
    ]);
  })();

  const readonlyChip = `<span class="badge badge-muted">${escapeHtml(t('settings.common.readonly'))}</span>`;
  return `
    ${diagBlock('version', t('settings.diag.block.version'), kvRows([
      kvRow('serve', health ? escapeHtml(`${health.name ?? 'mebular'} @ ${health.version ?? '—'}`) : escapeHtml(t('settings.diag.healthMissing'))),
      kvRow(t('settings.diag.serviceStatus'), health?.status ? escapeHtml(String(health.status)) : '—'),
      kvRow(t('settings.diag.mcpListen'), `${escapeHtml(s.mcp.host)}:${escapeHtml(String(s.mcp.port))} · auth=${escapeHtml(s.mcp.auth)}`),
      kvRow('TLS', s.mcp.tls ? t('settings.diag.tlsOn') : t('settings.diag.tlsOff')),
      kvRow(t('settings.diag.writes'), state.features.writes ? t('settings.diag.writesOn') : t('settings.diag.writesOff')),
      kvRow('P2P', s.network.enabled ? t('settings.common.enabled') : t('settings.common.disabled')),
      kvRow(t('settings.diag.stateHash'), (state.namespaces ?? []).filter((n) => n.stateHash).length
        ? escapeHtml((state.namespaces ?? []).filter((n) => n.stateHash).map((n) => `${n.namespace} ${String(n.stateHash).slice(0, 10)}`).join(' · '))
        : '—'),
    ]), { chip: readonlyChip })}

    ${diagBlock('rawConfig', t('settings.diag.raw.title'), `
      <p class="muted cfg-diag-path">${escapeHtml(configPath)}${state.rawConfig?.parseError ? escapeHtml(t('settings.diag.raw.parseFailed', { error: state.rawConfig.parseError })) : ''}</p>
      <div class="cfg-raw-block"><pre class="snippet">${escapeHtml(JSON.stringify(currentConfigFile(), null, 2))}</pre></div>
      <div class="domain-actions">
        <button id="cfg-copy-all" class="btn btn-small btn-crt" type="button">${escapeHtml(t('settings.diag.raw.copy'))}</button>
        <button id="cfg-download" class="btn btn-small btn-crt" type="button">${escapeHtml(t('settings.diag.raw.download'))}</button>
      </div>`, { chip: readonlyChip })}

    ${diagBlock('lastApply', t('settings.diag.lastApply.title'), applyBody, { chip: readonlyChip })}

    ${diagBlock('connectionRepair', t('settings.diag.connection.title'), `
      <p class="muted">${escapeHtml(t('settings.diag.connection.note'))}</p>
      <div class="domain-actions"><button id="diag-open-wizard" class="btn btn-small btn-crt" type="button" ${state.features.writes && !MOCK ? '' : 'disabled'}>${escapeHtml(t('settings.diag.connection.action'))}</button></div>`)}

    ${diagBlock('recovery', t('settings.diag.recovery.title'), kvRows([
      kvRow(t('settings.diag.recovery.auth'), t('settings.diag.recovery.authBody')),
      kvRow(t('settings.diag.recovery.host'), t('settings.diag.recovery.hostBody')),
      kvRow(t('settings.diag.recovery.cert'), t('settings.diag.recovery.certBody')),
      kvRow(t('settings.diag.recovery.console'), t('settings.diag.recovery.consoleBody')),
    ]), { chip: `<span class="crt-tag">${escapeHtml(t('settings.diag.recovery.chip'))}</span>` })}
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
    state.deviceRenameError = t('about.identity.nameEmpty');
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
    showToast(t('about.identity.renameSuccess', { name }));
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
        <h3>${escapeHtml(t('about.locked.title'))} <span class="badge badge-muted">${escapeHtml(t('about.locked.tag'))}</span></h3>
        <p class="muted" style="font-size:12px;line-height:1.7;margin:0 0 8px">${escapeHtml(t('about.locked.desc'))}</p>
        ${kvRows([
          kvRow(t('about.identity.phase'), escapeHtml(String(status.phase ?? 'UNINITIALIZED'))),
          kvRow(t('about.identity.home'), `<code>${escapeHtml(String(status.home ?? '—'))}</code>`),
          kvRow(t('about.identity.defaultDeviceName'), escapeHtml(String(status.defaultDeviceName ?? status.hostname ?? '—'))),
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
    body.innerHTML = `<p class="muted">${escapeHtml(t('about.loading'))}</p>`;
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
    : [emptyRowOf('multiaddr', t('about.identity.noMultiaddrs'))];
  const writes = state.features.writes && !MOCK;
  const renamingDevice = state.deviceRename !== null;
  const deviceName = s.identity.name ?? '';
  const deviceNameRow = renamingDevice
    ? kvRow(t('about.identity.deviceName'), `<span class="device-rename-inline">
        <input class="crt-input device-rename-input" data-device-rename-input type="text" maxlength="24"
          value="${escapeHtml(state.deviceRename?.name ?? deviceName)}" aria-label="${escapeHtml(t('about.identity.deviceNameAria'))}" />
        <button class="btn btn-small btn-crt" data-device-rename-save type="button" ${writes ? '' : 'disabled'}>${escapeHtml(t('common.save'))}</button>
        <button class="btn btn-small" data-device-rename-cancel type="button">${escapeHtml(t('common.cancel'))}</button>
      </span>${state.deviceRenameError ? `<span class="crt-warn device-rename-error" role="alert">${escapeHtml(state.deviceRenameError)}</span>` : ''}`)
    : kvRow(t('about.identity.deviceName'), `${deviceName
      ? `<span class="device-name-value">${escapeHtml(deviceName)}</span>`
      : `<span class="kv-empty">${escapeHtml(t('about.identity.nameUnset'))}</span>`}
      <button class="btn btn-small btn-crt" data-device-rename type="button" ${writes ? '' : 'disabled'}>${escapeHtml(t('about.identity.rename'))}</button>
      <span class="cfg-help muted">${escapeHtml(t('about.identity.renameNote'))}</span>`);
  body.innerHTML = `
    <section class="settings-section" data-info-block="identity">
      <h3>${escapeHtml(t('about.identity.title'))} <span class="badge badge-muted">${escapeHtml(t('about.identity.tag'))}</span></h3>
      ${kvRows([
        copyRowOf('deviceId', s.identity.deviceId),
        deviceNameRow,
        kvRow(t('about.identity.mode'), s.identity.mode === 'delegated'
          ? t('about.identity.modeDelegated')
          : t('about.identity.modeRoot')),
        ...(s.identity.peerId ? [copyRowOf('peerId', s.identity.peerId)] : []),
        ...addrRows,
        copyRowOf('storagePath', s.storage.path ?? '—'),
        copyRowOf(t('about.identity.configFile'), configPath),
        kvRow(t('about.identity.backup'), `<code>${escapeHtml(configPath)}.bak</code><span class="muted">${escapeHtml(t('about.identity.backupNote'))}</span>`),
        kvRow('storageAdapter', escapeHtml(s.storage.adapter)),
        kvRow(t('about.identity.encryption'), `${escapeHtml(s.encryption.level)}${s.encryption.atRest ? escapeHtml(t('about.identity.atRest')) : ''}`),
      ])}
    </section>

    ${convergenceAboutSection()}

    <details class="settings-fold fold-about-runtime" id="about-runtime-fold" data-settings-fold="about-runtime">
      <summary>${escapeHtml(foldLabel('about-runtime'))}</summary>
      <div class="settings-fold-body">
    <section class="settings-section" data-info-block="syncRate">
      <h3>${escapeHtml(t('about.syncRate.title'))} <span class="badge badge-muted">${escapeHtml(t('about.syncRate.tag'))}</span></h3>
      ${kvRows(statusRows().filter((row) => row.path === 'sync.autoSync' || row.path === 'sync.pushOnWrite').map((row) => kvRow(
        row.label ?? row.path,
        valueWithEffective(escapeHtml(formatRuntimeValue(row.actual)), {
          configured: row.configured,
          effective: row.actual,
          reason: row.reason,
        }),
      )))}
      <p class="muted" style="font-size:11px">${t('about.syncRate.note')}</p>
    </section>

    <section class="settings-section" data-info-block="statusOnly">
      <h3>${escapeHtml(t('about.statusOnly.title'))} <span class="badge badge-muted">${escapeHtml(t('settings.common.readonly'))}</span></h3>
      <p class="muted" style="font-size:11px;margin:0 0 8px">${escapeHtml(t('about.statusOnly.desc'))}</p>
      ${kvRows(statusRows().filter((row) => row.path !== 'sync.autoSync' && row.path !== 'sync.pushOnWrite').map((row) => kvRow(
        row.label ?? row.path,
        `${escapeHtml(formatRuntimeValue(row.actual))}${row.reason && row.reason !== '已生效' ? `<span class="cfg-reason"><span class="cfg-eff-key">${escapeHtml(t('settings.editor.reasonKey'))}</span> ${escapeHtml(row.reason)}</span>` : ''}`,
      )))}
    </section>

    <section class="settings-section" data-info-block="runtime">
      <h3>${escapeHtml(t('about.runtime.title'))} <span class="badge badge-muted">${escapeHtml(t('settings.common.readonly'))}</span>${pendingRestartBadge()}${listenAlarm.length ? `<span class="crt-tag crt-tag-warn">${escapeHtml(t('about.runtime.publicListen'))}</span>` : ''}</h3>
      ${kvRows([
        ...(pendingRestartItems().length > 0
          ? [kvRow(t('about.runtime.pendingRestart'), t('about.runtime.pendingRestartBody', { count: pendingRestartItems().length }))]
          : []),
        kvRow('P2P', s.network.enabled ? t('settings.common.enabled') : t('settings.common.disabled')),
        kvRow(t('about.runtime.listen'), escapeHtml(s.network.listen.join(', ') || '—')),
        kvRow(t('about.runtime.mcpListen'), `${escapeHtml(s.mcp.host)}:${escapeHtml(String(s.mcp.port))} · auth=${escapeHtml(s.mcp.auth)}`),
        // R-1 中-5：常驻 plist 全路径从连接页卡片收编到这里
        ...(state.service?.unitPath ? [kvRow(t('about.runtime.serviceUnit'), `<code>${escapeHtml(state.service.unitPath)}</code>`)] : []),
        kvRow('TLS', s.mcp.tls
          ? t('about.runtime.tlsOn', {
            key: s.mcp.tlsKeyConfigured ? t('about.runtime.present') : t('about.runtime.missing'),
            cert: s.mcp.tlsCertConfigured ? t('about.runtime.present') : t('about.runtime.missing'),
          })
          : t('about.runtime.tlsOff')),
        kvRow(t('about.runtime.joinService'), s.join?.enabled
          ? t('about.runtime.joinOn', { bind: escapeHtml(String(s.join.bind)), port: escapeHtml(String(s.join.port)) })
          : t('settings.common.disabled')),
        kvRow(t('about.runtime.semantic'), t('about.runtime.semanticValue', {
          state: s.semantic.enabled ? t('settings.common.enabled') : t('settings.common.disabled'),
          score: s.semantic.minScore,
        })),
        // C6：内建 relay 角色（只读；桥的选举自动完成，此处仅展示）
        kvRow(t('about.runtime.relay'), s.relay
          ? t('about.runtime.relayValue', {
            state: s.relay.serving ? t('about.runtime.on') : t('about.runtime.off'),
            reason: escapeHtml(String(s.relay.reason ?? '—')),
          })
          : '—'),
        kvRow(t('about.runtime.bridge'), s.relay?.bridge
          ? `<code>${escapeHtml(String(s.relay.bridge.address))}</code> <span class="muted">· ${escapeHtml(String(s.relay.bridge.peer))}</span>`
          : t('about.runtime.bridgeNone')),
        kvRow(t('about.runtime.bridgeAllowed'), s.relay
          ? t('about.runtime.bridgeAllowedValue', { count: s.relay.allowedClients ?? 0 })
          : '—'),
        // C5：地址自动广播（只读；提示类信息，不影响订阅）
        kvRow(t('about.runtime.broadcast'), s.net
          ? `${s.net.enabled ? t('about.runtime.broadcastMode', { mode: escapeHtml(String(s.net.mode)) }) : t('about.runtime.broadcastOff')}${t('about.runtime.broadcastStats', { published: s.net.published, applied: s.net.applied })}`
          : '—'),
        // C4：NAT 穿透（只读）
        kvRow(t('about.runtime.nat'), s.nat
          ? `${s.nat.dcutrEnabled ? t('about.runtime.dcutrOn') : t('about.runtime.dcutrOff')} · ${s.nat.autonatEnabled ? t('about.runtime.autonatOn') : t('about.runtime.autonatOff')} · ${t('about.runtime.natUpgrades', { count: s.nat.directUpgrades ?? 0 })}${s.nat.loadError ? ` ⚠ ${escapeHtml(String(s.nat.loadError))}` : ''}`
          : t('about.runtime.natOff')),
        kvRow(t('about.runtime.ignored'), s.net && Object.values(s.net.ignored ?? {}).some((v) => v > 0)
          ? escapeHtml(Object.entries(s.net.ignored).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(' / '))
          : t('common.none')),
      ])}
      ${listenAlarm.length ? `<p class="crt-warn">${escapeHtml(t('about.runtime.listenAlarm', { addresses: listenAlarm.join(', ') }))}</p>` : ''}
    </section>

    <section class="settings-section" data-info-block="paths">
      <h3>${escapeHtml(t('about.paths.title'))} <span class="badge badge-muted">${escapeHtml(t('about.paths.tag'))}</span></h3>
      ${(() => {
        const peers = s.peers ?? { enabled: false, paths: [] };
        if (!peers.enabled) return `<p class="muted" style="font-size:11px">${escapeHtml(t('about.paths.disabled'))}</p>`;
        if (peers.paths.length === 0) return `<p class="muted" style="font-size:11px">${escapeHtml(t('about.paths.empty'))}</p>`;
        return `<ul class="path-list">${peers.paths.map((p) => `<li class="path-row">
          <span class="path-key"><code>${escapeHtml(p.key)}</code></span>
          <span class="path-value">${p.connected
            ? `<span class="path-kind path-kind-${escapeHtml(String(p.kind ?? 'unknown'))}">${escapeHtml(String(p.kind ?? t('common.unknown')))}</span> <code>${escapeHtml(String(p.address ?? '—'))}</code> <span class="muted">${p.since ? escapeHtml(t('about.paths.switched', { time: formatTime(p.since) })) : ''}</span>`
            : `<span class="muted">${escapeHtml(t('common.notConnected'))}</span>${p.lastError ? ` <span class="crt-warn">⚠ ${escapeHtml(String(p.lastError))}</span>` : ''}`} <span class="muted">· ${escapeHtml(t('about.paths.candidates', { count: p.candidates }))}</span></span>
        </li>`).join('')}</ul>`;
      })()}
      <p class="muted" style="font-size:11px">${escapeHtml(t('about.paths.note'))}</p>
    </section>

    <section class="settings-section" data-info-block="fleet">
      <h3>${escapeHtml(t('about.fleet.title'))} <span class="badge badge-muted">${escapeHtml(t('settings.common.readonly'))}</span></h3>
      ${s.fleet?.configured
        ? kvRows([
          kvRow(t('about.fleet.namespace'), s.fleet.namespace ? `<code>${escapeHtml(s.fleet.namespace)}</code>` : t('about.fleet.unset')),
          kvRow(t('about.fleet.peers'), String(s.fleet.peers ?? 0)),
          kvRow(t('about.fleet.agents'), String(s.fleet.agents ?? 0)),
          kvRow(t('about.fleet.config'), escapeHtml(s.fleet.path ?? 'fleet.config.json')),
        ])
        : `<p class="muted" style="font-size:11px">${escapeHtml(t('about.fleet.empty'))}</p>`}
      <p class="muted" style="font-size:11px">${t('about.fleet.note')}${s.fleet?.configured ? '' : t('about.fleet.onboard')}</p>
    </section>

    <section class="settings-section" data-info-block="tools">
      <h3>${escapeHtml(t('about.tools.title'))} <span class="badge badge-muted">${escapeHtml(t('about.tools.tag', { count: (s.tools ?? []).length }))}</span></h3>
      <p class="muted" style="font-size:11px;margin:0 0 8px">${t('about.tools.note')}</p>
      <div class="chip-wrap">${(s.tools ?? []).map((tool) => `<span class="crt-tag">${escapeHtml(tool)}</span>`).join(' ')}</div>
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
      const riskText = typeof warning === 'string' && warning.trim().length > 0
        ? `\n\n${t('settings.write.riskNote', { warning: warning.trim() })}`
        : '';
      const ok = await confirmModal({
        title: t('settings.write.confirmTitle'),
        body: t('settings.write.confirmBody', {
          message: error.payload.message ?? '',
          risk: riskText,
          paths: lockPaths.join(', '),
        }),
        confirmLabel: t('settings.write.confirmLabel'),
      });
      if (!ok) {
        const cancel = new Error(t('settings.write.cancelled'));
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
    showToast(t('settings.write.restarting'));
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
      ? t('settings.write.rolledBack')
      : t('settings.write.applied'));
  } else if (res.effectiveImmediately) {
    showToast(t('settings.write.appliedImmediate'));
    await refresh();
    renderSettings();
    renderAbout();
  } else {
    // 前台模式：手动指引
    const cmd = res.restart?.command ?? restartCommand();
    showToast(res.backup
      ? t('settings.write.manualRestart', { path: res.path, command: cmd })
      : t('settings.write.manualRestartNoBackup', { path: res.path, command: cmd }));
    await refresh();
    renderSettings();
  }
}

/** 单字段即时写入（值与当前不同才写；被自锁确认取消则静默回读）。 */
async function applyConfigField(field, next) {
  const current = normalizedFieldValue(field);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  if (MOCK) { showToast(t('common.mockReadOnly')); return; }
  const patch = {};
  cfgSet(patch, field.path, next);
  try {
    const res = await submitConfigPatch(patch, field.warn ?? '');
    await onConfigSaved(res);
  } catch (error) {
    if (!error?.uiHandled) showToast(t('settings.write.failed', { message: error.message }));
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
    window.alert(t('common.mockReadOnly'));
    return;
  }
  const stateEl = document.querySelector('.cfg-restart-state');
  const btn = event?.currentTarget ?? null;
  const ok = await confirmModal({
    title: t('settings.restart.confirmTitle'),
    body: t('settings.restart.confirmBody'),
    confirmLabel: t('settings.restart.confirmLabel'),
  });
  if (!ok) return;
  if (btn) btn.disabled = true;
  if (stateEl) stateEl.textContent = t('settings.restart.running');
  try {
    const res = await api('/admin/api/restart', { method: 'POST', body: { confirm: true } });
    if (res?.dryRun) {
      if (stateEl) stateEl.textContent = t('settings.restart.dryRun', { command: res.command ?? '' });
      if (btn) btn.disabled = false;
      return;
    }
    if (stateEl) stateEl.textContent = t('settings.restart.triggered');
    showToast(t('settings.restart.triggered'));
    await waitForServeBack();
    lastSettingsSignature = null;
    lastAboutSignature = null;
    await refresh();
    renderSettings();
    if (stateEl) stateEl.textContent = '';
    showToast(t('settings.restart.restored'));
  } catch (error) {
    const manual = error?.payload?.manual ?? null;
    if (stateEl) stateEl.textContent = manual ?? t('settings.restart.failed', { message: error.message });
    if (btn) btn.disabled = false;
    if (manual) window.alert(t('settings.restart.unavailable', { message: manual }));
    else window.alert(t('settings.restart.failed', { message: error.message }));
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
  if (action === 'archive') return t('memories.action.archive');
  if (action === 'unarchive') return t('memories.action.unarchive');
  if (action === 'delete') return t('memories.action.delete');
  return action;
}

async function memAction(id, action) {
  if (MOCK) {
    window.alert(t('common.mockReadOnly'));
    return;
  }
  if (action === 'delete') {
    const ok = await confirmModal({
      title: t('memories.delete.title'),
      body: t('memories.delete.body', { id }),
      confirmLabel: t('memories.action.delete'),
    });
    if (!ok) return;
  }
  try {
    await api(`/admin/api/memories/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
    showToast(action === 'delete'
      ? t('memories.toast.deleted', { id })
      : action === 'archive' ? t('memories.toast.archived', { id }) : t('memories.toast.unarchived', { id }));
    await refresh();
  } catch (error) {
    window.alert(t('common.operationFailed', { message: error.message }));
  }
}

function populateMemFilters() {
  const select = $('#mem-filter-namespace');
  if (!select) return;
  const current = state.memoryFilters.namespace;
  const names = [...new Set((state.namespaces ?? []).map((n) => n.namespace))].sort();
  select.innerHTML = `<option value="">${escapeHtml(t('memories.filter.allNamespaces'))}</option>`
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
    list.innerHTML = `<p class="muted">${escapeHtml(t('memories.loading'))}</p>`;
    return;
  }
  if (data.memories.length === 0) {
    list.innerHTML = `<p class="muted">${escapeHtml(t('memories.empty', { total: data.total }))}</p>`;
    return;
  }
  list.innerHTML = data.memories.map((memory) => {
    const badges = [
      memory.archived ? `<span class="crt-tag crt-tag-warn">${escapeHtml(t('memories.badge.archived'))}</span>` : '',
      memory.deleted ? `<span class="crt-tag crt-tag-error">${escapeHtml(t('memories.badge.deleted'))}</span>` : '',
    ].filter(Boolean).join(' ');
    const canArchive = state.features.writes && !memory.deleted;
    const actions = [
      canArchive
        ? `<button class="btn btn-small btn-crt" type="button" data-mem-action="${memory.archived ? 'unarchive' : 'archive'}" data-mem-id="${escapeHtml(memory.id)}">${escapeHtml(memory.archived ? t('memories.action.unarchive') : t('memories.action.archive'))}</button>`
        : '',
      !memory.deleted && state.features.writes
        ? `<button class="btn btn-small btn-crt" type="button" data-mem-action="delete" data-mem-id="${escapeHtml(memory.id)}">${escapeHtml(t('memories.action.delete'))}</button>`
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
        <p class="mem-preview">${escapeHtml(memory.preview || t('memories.emptyPreview'))}</p>
        <p class="muted mem-meta">${escapeHtml(t('memories.meta.created', { time: formatTime(memory.createdAt) }))}${memory.archivedAt ? escapeHtml(t('memories.meta.archived', { time: formatTime(memory.archivedAt) })) : ''}${memory.deletedAt ? escapeHtml(t('memories.meta.deleted', { time: formatTime(memory.deletedAt) })) : ''}</p>
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
    card.innerHTML = `<h3>${escapeHtml(t('attention.title'))}</h3><ul>${items.map((it) =>
      `<li><button class="attention-item" type="button" data-attention-action="${escapeHtml(it.action)}" data-attention-id="${escapeHtml(it.id)}">${escapeHtml(it.label)} ›</button></li>`).join('')}</ul>`;
  } else {
    // 注意项退场时同步清空隐藏卡：hidden 只负责视觉，残留文案仍会被读屏/验收读到。
    card.innerHTML = '';
  }
}

async function serviceAction(action) {
  const say = (message) => { state.serviceMsg = message; rerenderAssistants(); };
  try {
    if (action === 'recheck') { await refresh(); say(t('settings.service.msg.refreshed')); return; }
    if (action === 'restart') {
      await api('/admin/api/restart', { method: 'POST', body: {} });
      say(t('settings.service.msg.restartRequested'));
      return;
    }
    const res = await api(`/admin/api/service/${action}`, { method: 'POST', body: {}, timeoutMs: 30000 }); // launchd 安装/重启可能较慢
    if (res?.dryRun) {
      const cmds = (res.commands ?? []).map((c) => c.join(' ')).join('；');
      say(t('settings.service.msg.dryRun', { commands: cmds }));
    } else {
      say(action === 'install' ? t('settings.service.msg.installed') : t('settings.service.msg.uninstalled'));
    }
    await refresh();
  } catch (error) {
    say(t('settings.service.msg.failed', { message: error.message }));
  }
}

async function clientAction(id, action) {
  const say = (message) => { state.clientMsg[id] = message; rerenderAssistants(); };
  const showDiff = (message) => { state.clientDiff[id] = message; rerenderAssistants(); };
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
      if (res?.state === 'connected') { state.clientRestart[id] = false; say(t('assistants.action.verifyOk')); }
      else if (res?.state === 'pending-restart') say(t('assistants.action.verifyReady'));
      else say(t('assistants.action.verifyNotPassed'));
      return;
    }
    if (action === 'recheck') { state.clientRestart[id] = false; state.clientVerify[id] = null; delete state.clientFailed[id]; await refresh(); say(t('assistants.action.rechecked')); return; }
    if (action === 'copy') {
      const client = (state.clients ?? []).find((c) => c.id === id);
      await navigator.clipboard.writeText(client?.snippet ?? '');
      say(t('assistants.action.copied'));
      return;
    }
    if (action === 'preview') {
      const res = await api(`/admin/api/clients/${id}/preview`, { method: 'POST', body: {} });
      showDiff(res.preview || t('assistants.preview.unchanged'));
      say(res.needsManual ? t('assistants.preview.manual', { reason: res.reason ?? '' }) : '');
      return;
    }
    // R-1 小-11：回滚是不可逆方向的操作 → 应用内二次确认（取消 / Esc / 点空白 = 不执行）
    if (action === 'rollback') {
      const ok = await confirmModal({
        title: t('assistants.rollback.title'),
        body: t('assistants.rollback.body'),
        confirmLabel: t('assistants.rollback.confirm'),
      });
      if (!ok) return;
    }
    const res = await api(`/admin/api/clients/${id}/${action}`, { method: 'POST', body: {}, timeoutMs: 20000 }); // 写入/CLI 动作给足余量
    if (typeof res.preview === 'string' && res.preview.length > 0) showDiff(res.preview);
    if (!res.ok) { say(t('assistants.manualNeeded', { reason: res.reason ?? t('assistants.preview.chooseSnippet') })); return; }
    delete state.clientFailed[id]; // 成功/重试成功 → 清失败态
    say(action === 'connect'
      ? (res.changed ? t('assistants.done.connectChanged') : t('assistants.done.connectUnchanged'))
      : action === 'rollback' ? t('assistants.done.rolledBack') : t('assistants.done.installed'));
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
      say(t('assistants.form.failed', { message: error.message }));
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
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return { error: t('assistants.form.error.id') };
  if (name === '') return { error: t('assistants.form.error.name') };
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
  if (primaryPath === '') return { error: t('assistants.form.error.path') };
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
    if (!res?.ok) { state.addForm = { ...(state.addForm ?? {}), error: res?.reason ?? t('assistants.registerFailed') }; rerenderAssistants(); return; }
    state.addForm = null;
    await refresh();
    if ($('#settings') && !$('#settings').hidden) { lastSettingsSignature = null; renderSettings('assistants'); }
  } catch (error) {
    state.addForm = { ...(state.addForm ?? {}), error: t('assistants.form.failed', { message: error.message }) };
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
    title: t('assistants.remove.title'),
    body: t('assistants.remove.body', { id }),
    confirmLabel: t('assistants.remove.confirm'),
  });
  if (!ok) return;
  try {
    const res = await api(`/admin/api/assistants/${encodeURIComponent(id)}/remove`, { method: 'POST', body: {} });
    if (!res?.ok) { state.clientMsg[id] = res?.reason ?? t('assistants.remove.failed'); rerenderAssistants(); return; }
    await refresh();
    if ($('#settings') && !$('#settings').hidden) { lastSettingsSignature = null; renderSettings('assistants'); }
  } catch (error) {
    state.clientMsg[id] = t('assistants.form.failed', { message: error.message });
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
    list.innerHTML = `<li class="muted">${escapeHtml(t('audit.empty'))}</li>`;
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
    <span class="audit-detail">${describeEvent(event)}${event.rejectReason ? ` · <span class="crt-warn">${escapeHtml(t('audit.rejected', { reason: securityReasonLabel(event.rejectReason) }))}</span>` : ''}</span>
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
  if (type === 'namespace_subscription') return t('audit.type.subscription');
  if (type === 'namespace_declare') return t('audit.type.declare');
  if (type === 'device_revoke') return t('audit.type.deviceRevoke');
  if (type === 'device_restore') return t('audit.type.deviceRestore');
  if (type === 'namespace_handoff') return t('audit.type.handoff');
  if (type === 'security_tier') return t('audit.type.securityTier');
  if (type === 'security_approval') return t('audit.type.securityApproval');
  if (type === 'security_recovery') return t('audit.type.securityRecovery');
  if (type === 'security_totp') return t('audit.type.securityTotp');
  return type;
}

function describeEvent(event) {
  const cosign = event.cosignApprover
    ? t('audit.event.cosign', { approver: `<b>${escapeHtml(event.cosignApprover)}</b>` })
    : '';
  const recoveryCode = event.breakGlassKeyId
    ? t('audit.event.recoveryCode', { keyId: escapeHtml(String(event.breakGlassKeyId).slice(0, 8)) })
    : '';
  const invalid = event.valid ? '' : t('audit.event.invalid');
  if (event.type === 'namespace_subscription') {
    const ns = `<span class="ns-chip" style="background:${namespaceColor(event.namespace ?? 'default')}">${escapeHtml(event.namespace ?? 'default')}</span>`;
    const actor = escapeHtml(event.issuer === event.subject ? t('common.self') : event.subject);
    return t('audit.event.subscription', {
      actor: `<b>${actor}</b>`,
      verb: event.active === false ? t('audit.event.unsubscribe') : t('audit.event.subscribe'),
      namespace: ns,
      extra: `${cosign}${invalid}`,
    });
  }
  if (event.type === 'namespace_declare') {
    const ns = `<span class="ns-chip" style="background:${namespaceColor(event.namespace ?? 'default')}">${escapeHtml(event.namespace ?? 'default')}</span>`;
    return t('audit.event.declare', { issuer: `<b>${escapeHtml(event.issuer)}</b>`, namespace: ns });
  }
  if (event.type === 'device_restore') {
    return t('audit.event.restore', {
      issuer: `<b>${escapeHtml(event.issuer)}</b>`,
      subject: `<b>${escapeHtml(event.subject)}</b>`,
      extra: `${cosign}${recoveryCode}${invalid}`,
    });
  }
  if (event.type === 'device_revoke') {
    return t('audit.event.revoke', {
      issuer: `<b>${escapeHtml(event.issuer)}</b>`,
      subject: `<b>${escapeHtml(event.subject)}</b>`,
      extra: `${cosign}${recoveryCode}${invalid}`,
    });
  }
  if (event.type === 'security_tier') {
    const from = event.fromLevel ? securityLevelLabel(event.fromLevel) : '—';
    const to = securityLevelLabel(event.level);
    return t('audit.event.tier', {
      issuer: `<b>${escapeHtml(event.issuer)}</b>`,
      from: `<b>${escapeHtml(from)} → ${escapeHtml(to)}</b>`,
      extra: `${cosign}${recoveryCode}`,
    });
  }
  if (event.type === 'security_approval') {
    const decision = event.decision === 'approve'
      ? t('audit.event.decision.approve')
      : event.decision === 'deny' ? t('audit.event.decision.deny') : t('audit.event.decision.request');
    const pair = event.pairingCode ? t('audit.event.pairing', { code: escapeHtml(event.pairingCode) }) : '';
    const op = escapeHtml(securityOpText(event));
    if (event.decision === 'deny') {
      return t('audit.event.approvalDeny', { op, pair });
    }
    if (event.decision === 'approve') {
      return t('audit.event.approvalApprove', {
        issuer: `<b>${escapeHtml(event.issuer)}</b>`,
        decision,
        op: `<b>${op}</b>`,
        pair,
      });
    }
    return t('audit.event.approvalRequest', {
      initiator: `<b>${escapeHtml(event.initiator)}</b>`,
      op: `<b>${op}</b>`,
      pair,
      expires: event.expiresAt ? t('audit.event.expires', { time: escapeHtml(formatTime(event.expiresAt)) }) : '',
    });
  }
  if (event.type === 'security_recovery') {
    const extra = `${event.breakGlassKeyId ? t('audit.event.oldCode', { keyId: escapeHtml(String(event.breakGlassKeyId).slice(0, 8)) }) : ''}${cosign ? t('audit.event.cosignPlain', { approver: escapeHtml(event.cosignApprover) }) : ''}`;
    const keyId = escapeHtml(String(event.keyId ?? '').slice(0, 8));
    return event.mode === 'rotate'
      ? t('audit.event.recoveryRotate', { keyId, extra })
      : t('audit.event.recoveryRegister', { keyId, extra });
  }
  if (event.type === 'security_totp') {
    const device = `<b>${escapeHtml(event.device ?? event.issuer)}</b>`;
    const fingerprint = escapeHtml(event.fingerprint ?? '—');
    return /show/i.test(String(event.note ?? ''))
      ? t('audit.event.totpShow', { device, fingerprint })
      : t('audit.event.totpImport', { device, fingerprint });
  }
  if (event.type === 'namespace_handoff') {
    const ns = `<span class="ns-chip" style="background:${namespaceColor(event.namespace ?? 'default')}">${escapeHtml(event.namespace ?? 'default')}</span>`;
    return t('audit.event.handoff', {
      issuer: `<b>${escapeHtml(event.issuer)}</b>`,
      namespace: ns,
      subject: `<b>${escapeHtml(event.subject ?? '—')}</b>`,
      forced: event.forced ? ' · forced' : '',
      count: event.pendingCount ?? 0,
    });
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
  ok: { key: 'convergence.state.ok', text: '已收敛', cls: 'crt-tag-ok' },
  stalled: { key: 'convergence.state.stalled', text: '停滞', cls: 'crt-tag-error' },
  diverged: { key: 'convergence.state.diverged', text: '未收敛', cls: 'crt-tag-error' },
  unverifiable: { key: 'convergence.state.unverifiable', text: '未对账', cls: 'crt-tag-warn' },
  syncing: { key: 'convergence.state.syncing', text: '同步中', cls: 'crt-tag-warn' },
  offline: { key: 'convergence.state.offline', text: '未连接', cls: 'is-off' },
};

function convergenceStateMeta(state) {
  const meta = CONVERGENCE_STATE_META[state];
  if (!meta) return { text: String(state ?? '—'), cls: 'is-off' };
  return { text: t.has(meta.key) ? t(meta.key) : meta.text, cls: meta.cls };
}

function fmtClock(at) {
  const d = new Date(at);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** P3：收敛原因 → 人话（与 src/sync/convergence.ts 的 reason code 对齐；只读展示） */
function convergenceReasonText(reason) {
  const domains = Array.isArray(reason?.domains) ? reason.domains.join(t('common.listSeparator')) : '';
  switch (reason?.code) {
    case 'fingerprint-mismatch':
      return reason.detail === '策略视图指纹不一致'
        ? t('convergence.reason.fingerprintPolicy')
        : t('convergence.reason.fingerprintDomains', { domains: domains || t('convergence.reason.shared') });
    case 'session-failures': return t('convergence.reason.sessionFailures', { count: reason.count ?? '' });
    case 'no-ack-progress': return t('convergence.reason.noAckProgress');
    case 'backlog-mismatch': return t('convergence.reason.backlogMismatch', { count: reason.count ?? 0 });
    case 'keying-drop': return t('convergence.reason.keyingDrop');
    case 'keying-drops': return t('convergence.reason.keyingDrops', { count: reason.count ?? '' });
    case 'probe-ineffective': return t('convergence.reason.probeIneffective');
    case 'peer-claims-ahead': return t('convergence.reason.peerClaimsAhead');
    case 'peer-state-loss': return t('convergence.reason.peerStateLoss', { count: reason.count ?? '' });
    case 'unknown-event-types': return t('convergence.reason.unknownEventTypes', { count: reason.count ?? '' });
    case 'no-fingerprints': return t('convergence.reason.noFingerprints');
    case 'awaiting-session': return t('convergence.reason.awaitingSession');
    case 'expected-yet-unverifiable': return t('convergence.reason.expectedYetUnverifiable', {
      domains: domains ? t('convergence.reason.domainsQuoted', { domains }) : '',
    });
    default: return String(reason?.code ?? '');
  }
}

function convergencePrimaryText(conv) {
  const reason = (conv?.reasons ?? []).find((r) => r && r.code !== 'awaiting-session');
  return reason ? convergenceReasonText(reason) : '';
}

/** 设备卡（对端）：状态 chip 一行 + 至多两条人话原因（只读；不设第二套开关） */
function convergenceChipRows(conv, shortTimeFn) {
  const meta = convergenceStateMeta(conv?.state);
  const when = conv?.state === 'ok' && conv.lastConvergedAt
    ? `<span class="muted" style="margin-left:6px">${escapeHtml(t('convergence.chipReconciled', { time: shortTimeFn(conv.lastConvergedAt) }))}</span>`
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
      <h3>${escapeHtml(t('about.convergence.title'))} <span class="badge badge-muted">${escapeHtml(t('settings.common.readonly'))}</span></h3>
      <p class="muted" style="font-size:11px;margin:0">${t('about.convergence.disabled')}</p>
    </section>`;
  }
  const summary = s
    ? t('about.convergence.summary', {
      peers: s.peers,
      ok: s.ok,
      stalled: s.stalled,
      diverged: s.diverged,
      unverifiable: s.unverifiable,
      offline: s.offline,
    })
    : '';
  const rows = peers.map((d) => {
    const conv = d.convergence;
    const meta = convergenceStateMeta(conv.state);
    const detail = [
      convergencePrimaryText(conv),
      conv.state === 'ok' && conv.lastConvergedAt ? t('convergence.chipReconciled', { time: fmtClock(conv.lastConvergedAt) }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return kvRow(d.deviceId, `<span class="crt-tag ${meta.cls}">${meta.text}</span>${detail ? ` <span class="muted">${escapeHtml(detail)}</span>` : ''}`);
  });
  return `
    <section class="settings-section" data-info-block="convergence">
      <h3>${escapeHtml(t('about.convergence.title'))} <span class="badge badge-muted">${escapeHtml(t('about.convergence.tag'))}</span></h3>
      ${summary ? `<p class="muted" style="font-size:11px;margin:0 0 8px">${escapeHtml(summary)}</p>` : ''}
      ${peers.length ? kvRows(rows) : `<p class="muted" style="font-size:11px;margin:0">${escapeHtml(t('about.convergence.empty'))}</p>`}
      <p class="muted" style="font-size:11px;margin:8px 0 0">${escapeHtml(t('about.convergence.note'))}</p>
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
    empty.textContent = t('deviceCard.emptyLocked');
    body.hidden = true;
    body.innerHTML = '';
    lastCardSignature = null;
    return;
  }
  if (asideEl) asideEl.hidden = false;
  asideEl?.classList.remove('is-locked');
  cardEl?.classList.remove('is-disabled');
  cardEl?.removeAttribute('aria-disabled');
  empty.textContent = t('deviceCard.empty');
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
    ? { text: `${ICONS.online} ${t('deviceCard.status.self')}`, cls: 'is-ok' }
    : device.blocked
      ? { text: `${ICONS.revoked} ${t('deviceCard.status.blocked')}`, cls: 'is-danger' }
      : device.online
        ? { text: `${ICONS.online} ${t('deviceCard.status.online')}`, cls: 'is-ok' }
        : { text: `${ICONS.offline} ${t('deviceCard.status.offline')}`, cls: 'is-off' };
  const shortTime = (at) => {
    const d = new Date(at);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  const metaParts = [];
  if (!isSelf && device.pendingEventCount) metaParts.push(t('deviceCard.meta.pending', { count: device.pendingEventCount }));
  if (!isSelf && device.lastSyncAt) metaParts.push(t('deviceCard.meta.lastSync', { time: shortTime(device.lastSyncAt) }));
  // C2：连接路径（只读；核心地址簿 → settings.peers.paths）
  const pathInfo = isSelf ? null : peerPathFor(device);
  const pathLabel = escapeHtml(t('deviceCard.path.key'));
  const pathRow = isSelf
    ? `<li class="path-row"><span class="path-key">${pathLabel}</span><span class="path-value">${escapeHtml(t('deviceCard.path.self'))}</span></li>`
    : pathInfo
      ? `<li class="path-row"><span class="path-key">${pathLabel}</span><span class="path-value">${pathInfo.connected
          ? `<span class="path-kind path-kind-${escapeHtml(String(pathInfo.kind ?? 'unknown'))}">${escapeHtml(String(pathInfo.kind ?? t('common.unknown')))}</span> <code>${escapeHtml(String(pathInfo.address ?? '—'))}</code> <span class="muted">${pathInfo.since ? escapeHtml(t('deviceCard.path.since', { time: shortTime(pathInfo.since) })) : ''}</span>`
          : `<span class="muted">${escapeHtml(t('common.notConnected'))}</span>${pathInfo.lastError ? ` <span class="crt-warn">⚠ ${escapeHtml(String(pathInfo.lastError))}</span>` : ''}`}</span></li>`
      : `<li class="path-row"><span class="path-key">${pathLabel}</span><span class="path-value muted">${escapeHtml(t('deviceCard.path.unavailable'))}</span></li>`;

  const allNamespaces = allNamespaceNames();
  const writes = state.features.writes && !MOCK;
  const selfRow0 = state.devices.find((d) => d.deviceId === state.overview?.device?.deviceId);
  // 轮询每 3s 触发 render；内容未变时跳过重渲染，避免冲掉「更多操作」展开态与点击
  const cardSignature = JSON.stringify([
    getLocale(),
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
    ? `<li class="muted">${escapeHtml(t('deviceCard.follow.none'))}</li>`
    : allNamespaces.map((ns) => `<li>
        <span><span class="ns-chip" style="background:${namespaceColor(ns)}">${escapeHtml(ns)}</span>
          <span class="muted" style="margin-left:6px">${escapeHtml(iFollow(ns) ? t('domains.subscribed') : t('domains.unsubscribed'))}</span></span>
      </li>`).join('');

  // 对端：它订阅的记忆域（对端自声明，只读）
  const peerFollowRows = (device.subscriptions ?? []).length
    ? device.subscriptions.map((ns) => `<li>
        <span><span class="ns-chip" style="background:${namespaceColor(ns)}">${escapeHtml(ns)}</span>
          <span class="muted" style="margin-left:6px">${escapeHtml(t('domains.subscribed'))}</span></span>
      </li>`).join('')
    : `<li class="muted">${escapeHtml(t('deviceCard.peerFollow.none'))}</li>`;

  // 对端：订阅交集 = 双方都能读写的域
  const peerFollowSet = new Set(device.subscriptions ?? []);
  const domains = [...new Set([...allNamespaces, ...peerFollowSet])].sort();
  const interop = domains.map((ns) => {
    const peerIn = peerFollowSet.has(ns);
    const mineIn = iFollow(ns);
    const noContent = !allNamespaces.includes(ns);
    let fact = '';
    if (peerIn && mineIn) fact = t('deviceCard.interop.both');
    else if (peerIn) fact = t('deviceCard.interop.peerOnly');
    else if (mineIn) fact = t('deviceCard.interop.mineOnly');
    if (fact && noContent) fact += t('deviceCard.interop.noContent');
    return { ns, fact };
  });
  const visibleInterop = interop.filter((row) => row.fact !== '');
  const hiddenCount = interop.length - visibleInterop.length;
  const interopRows = (visibleInterop.length > 0
    ? visibleInterop.map((row) => `<li>
        <span><span class="ns-chip" style="background:${namespaceColor(row.ns)}">${escapeHtml(row.ns)}</span>
          <span class="muted" style="margin-left:6px">${escapeHtml(row.fact)}</span></span>
      </li>`).join('')
    : `<li class="muted">${escapeHtml(t('deviceCard.interop.none'))}</li>`)
    + (hiddenCount > 0 ? `<li class="muted">${escapeHtml(t('deviceCard.interop.hidden', { count: hiddenCount }))}</li>` : '');

  // S3 · 移出分级（SPEC §5.2 v1.1）：low 维持「更多操作」折叠（防误触）；
  // medium/high 提级为一等动作（与同步/断开同排，危险样式），门槛由动态码/会签提供。
  const secLevel = state.security?.level ?? 'low';
  const elevatedKick = secLevel === 'medium' || secLevel === 'high';
  const kickButton = `<button class="btn btn-small btn-crt btn-crt-danger" data-action="revoke-device" ${writes ? '' : 'disabled'}>${escapeHtml(t('deviceCard.action.kick'))}</button>`;
  const restoreButton = `<button class="btn btn-small btn-crt" data-action="restore-device" ${writes ? '' : 'disabled'}>${escapeHtml(t('deviceCard.action.restore'))}</button>`;
  const primaryDanger = device.blocked ? restoreButton : kickButton;
  const actions = isSelf ? '' : `
    <div class="card-actions">
      <button class="btn btn-small btn-crt" data-action="sync" ${writes && device.online ? '' : 'disabled'}>${escapeHtml(t('deviceCard.action.sync'))}</button>
      ${device.online
        ? `<button class="btn btn-small btn-crt" data-action="disconnect" ${writes ? '' : 'disabled'}>${escapeHtml(t('deviceCard.action.disconnect'))}</button>`
        : `<button class="btn btn-small btn-crt" data-action="connect" ${writes ? '' : 'disabled'}>${escapeHtml(t('deviceCard.action.connect'))}</button>`}
      ${device.blocked || elevatedKick ? primaryDanger : ''}
    </div>
    ${device.blocked
      ? `<p class="card-help muted">${escapeHtml(t('deviceCard.help.blocked'))}</p>`
      : elevatedKick
        ? `<p class="card-help muted">${escapeHtml(t('deviceCard.help.elevated', {
          gate: secLevel === 'high' ? t('deviceCard.help.gateHigh') : t('deviceCard.help.gateMedium'),
        }))}</p>`
        : ''}
    <details class="card-advanced">
      <summary>${escapeHtml(t('deviceCard.more'))}</summary>
      <div class="card-actions">
        ${device.online ? '' : `<button class="btn btn-small btn-crt" data-action="manual-connect" ${writes ? '' : 'disabled'}>${escapeHtml(t('deviceCard.action.manualConnect'))}</button>`}
        <button class="btn btn-small btn-crt" data-action="reset-watermarks" ${writes ? '' : 'disabled'}>${escapeHtml(t('deviceCard.action.resetWatermarks'))}</button>
        ${device.blocked || elevatedKick ? '' : primaryDanger}
      </div>
    </details>
    ${writes ? '' : `<p class="muted" style="margin-top:10px">${escapeHtml(t('deviceCard.readOnly'))}</p>`}`;

  const advancedOpen = body.querySelector('.card-advanced')?.open === true;
  const conv = isSelf ? null : device.convergence ?? null;
  body.innerHTML = `
    <div class="card-identity">
      ${device.name ? `<span class="card-name">${escapeHtml(device.name)}</span>` : ''}
      <span class="card-id"><span class="dev-led ${status.cls}" aria-hidden="true"></span>${escapeHtml(device.deviceId)}</span>
      <span class="crt-tag card-status ${status.cls}">${escapeHtml(status.text)}</span>
    </div>
    ${metaParts.length > 0 ? `<p class="card-meta muted">${escapeHtml(metaParts.join(' · '))}</p>` : '<p class="card-meta muted"></p>'}
    <ul class="path-list" aria-label="${escapeHtml(t('deviceCard.path.aria'))}">${pathRow}</ul>
    ${conv ? `
    <h3>${escapeHtml(t('deviceCard.syncHealth.title'))} <span class="h3-note">${escapeHtml(t('deviceCard.syncHealth.note'))}</span></h3>
    <ul class="chip-list">${convergenceChipRows(conv, shortTime)}</ul>
    ` : ''}
    ${isSelf ? `
    <h3>${escapeHtml(t('deviceCard.mine.title'))} <span class="h3-note">${escapeHtml(t('deviceCard.mine.note'))}</span></h3>
    <p class="card-help muted">${escapeHtml(t('deviceCard.mine.help'))}</p>
    <ul class="chip-list">${followRows}</ul>
    <div class="card-actions"><button class="btn btn-small btn-crt" type="button" data-action="goto-domains">${escapeHtml(t('deviceCard.mine.goto'))}</button></div>
    ` : `
    <h3>${escapeHtml(t('deviceCard.peer.title'))} <span class="h3-note">${escapeHtml(t('deviceCard.peer.note'))}</span></h3>
    <ul class="chip-list">${peerFollowRows}</ul>
    <h3>${escapeHtml(t('deviceCard.interop.title'))} <span class="h3-note">${escapeHtml(t('deviceCard.interop.note'))}</span></h3>
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
    <div class="tt-title">${escapeHtml(node.self ? t('common.self') : node.id)}</div>
    <div class="tt-row">${escapeHtml(node.blocked ? t('tooltip.removed') : node.online ? t('tooltip.connected') : t('common.notConnected'))}</div>
    ${device && (device.sharesWithMe ?? []).length
      ? `<div class="tt-row">${escapeHtml(t('tooltip.shared', { namespaces: (device.sharesWithMe ?? []).join(', ') || '—' }))}</div>`
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
    await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/sync`, {}, t('deviceCard.toast.sync'));
  } else if (action === 'connect' || action === 'manual-connect') {
    // E1：网内传输修复（不改变入网信任与订阅）；Electron 无 window.prompt，统一走 App 内向导。
    openWizard({
      deviceId: device.deviceId,
      address: peerPathFor(device)?.address ?? '',
    });
  } else if (action === 'disconnect') {
    await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/disconnect`, {}, t('deviceCard.toast.disconnected'));
  } else if (action === 'reset-watermarks') {
    const ok = await confirmModal({
      title: t('deviceCard.reset.title'),
      body: t('deviceCard.reset.body', { device: device.deviceId }),
      confirmLabel: t('deviceCard.reset.confirm'),
    });
    if (ok) await runWrite(`/admin/api/devices/${encodeURIComponent(device.deviceId)}/reset-watermarks`, {}, t('deviceCard.reset.toast'));
  } else if (action === 'revoke-device') {
    await securityRevokeFlow(device);
  } else if (action === 'restore-device') {
    await securityRestoreFlow(device);
  }
}

async function runWrite(path, body, successMessage) {
  if (MOCK) {
    window.alert(t('common.mockReadOnly'));
    return;
  }
  try {
    const result = await api(path, { method: 'POST', body });
    await refresh();
    showToast(successMessage);
  } catch (error) {
    window.alert(t('common.operationFailed', { message: error.message }));
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
  showToast(t('lock.toast'));
}

// ---------- 模态 ----------

let modalResolve = null;
function confirmModal({ title, body, confirmLabel }) {
  $('#modal-title').textContent = title;
  $('#modal-body').textContent = body;
  $('#modal-confirm').textContent = confirmLabel ?? t('common.confirm');
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
          <span class="invite-label">${escapeHtml(t('invite.token.label'))}</span>
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
      <p class="invite-safety">${escapeHtml(t('invite.safety'))}</p>
    </div>
    <p class="invite-loading-note muted" role="status">${escapeHtml(t('invite.loading'))}</p>
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
      button.textContent = t('invite.regenerating');
    }
    ttlSelect = body.querySelector('#invite-ttl');
    if (ttlSelect) {
      ttlSelect.disabled = true;
      enhanceSelect(ttlSelect);
    }
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
    if (canKeep) showToast(t('invite.regen.success'));
  } catch (error) {
    if (!canKeep) {
      showInviteError(error);
      return;
    }
    clearInviteBusy();
    if (button) {
      button.disabled = false;
      button.textContent = button.dataset.label ?? t('invite.regenerate');
      delete button.dataset.label;
    }
    if (ttlSelect) {
      ttlSelect.disabled = false;
      enhanceSelect(ttlSelect);
    }
    const message = displayErrorDetail(error);
    const regenError = body.querySelector('#invite-regen-error');
    if (regenError) {
      regenError.textContent = t('invite.regen.failed', { message });
      regenError.hidden = false;
    } else {
      showToast(t('invite.regen.failedToast', { message }));
    }
  }
}

/** joinService 未启用：弹层内就地启用（复用设置写路径；写后自动重启，前台则给一键重启/重试）。 */
async function inviteEnableJoinService(button) {
  if (MOCK) { showToast(t('common.mockReadOnly')); return; }
  const body = $('#invite-body');
  clearInviteBusy();
  const field = fieldOf('joinService.enabled');
  if (button) {
    button.disabled = true;
    button.textContent = t('invite.enabling');
  }
  body.innerHTML = `<p class="muted">${escapeHtml(t('invite.enablingNote'))}</p>`;
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
    <p class="crt-warn">${escapeHtml(t('invite.enableFailed.title'))}</p>
    <p class="cfg-help muted">${escapeHtml(t(writesAllowed ? 'invite.enableFailed.retryHelp' : 'invite.enableFailed.readonlyHelp'))}</p>
    <div class="domain-actions"><button id="invite-enable-retry" class="btn btn-small btn-crt" type="button" ${writesAllowed ? '' : 'disabled'}>${escapeHtml(t('invite.enableFailed.retry'))}</button></div>
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
  const stateText = pending ? t('invite.pending.notRestarted') : t('invite.pending.restarting');
  body.innerHTML = `
    <p class="modal-note muted">${escapeHtml(t('invite.pending.written'))}${escapeHtml(stateText)}。</p>
    <p class="cfg-help muted">${escapeHtml(t('invite.pending.note'))}</p>
    <div class="domain-actions">
      <button class="btn btn-small btn-crt" id="invite-restart-service" type="button" ${writes ? '' : 'disabled'}>${escapeHtml(t('invite.pending.restart'))}</button>
      <button class="btn btn-small btn-crt" id="invite-retry" type="button">${escapeHtml(t('invite.pending.retry'))}</button>
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
      <p class="modal-note muted">${escapeHtml(t('invite.joinDisabled.note'))}</p>
      <div class="domain-actions">
        <button id="invite-enable-service" class="btn btn-small btn-crt" type="button" ${writes ? '' : 'disabled'}>${escapeHtml(t('invite.joinDisabled.enable'))}</button>
      </div>
      <p class="cfg-help muted">${escapeHtml(t('invite.joinDisabled.help'))}</p>
    `;
    body.querySelector('#invite-enable-service')?.addEventListener('click', (event) => {
      void inviteEnableJoinService(event.currentTarget);
    });
  } else {
    const message = displayErrorDetail(error);
    body.innerHTML = `<p class="crt-warn">${escapeHtml(t('invite.error.generate', { message }))}</p>`;
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
    return t('invite.expiry.current', { time: formatExpiry(current.expiresAt) });
  }
  return t('invite.expiry.next', { time: formatExpiry(Date.now() + ttlMs) });
}

/** TTL 档位文案（数据仍来自 INVITE_TTL_OPTIONS；中文/英文只换标签）。 */
function inviteTtlLabel(ttlMs) {
  const minutes = Math.round(ttlMs / 60_000);
  return minutes < 60
    ? t('invite.ttl.minutes', { n: minutes })
    : t('invite.ttl.hours', { n: minutes / 60 });
}

/** 蓝色代码块文本：长令牌显示「前缀…指纹…后8」，保证重新生成后肉眼可辨。 */
function inviteTokenShortText(token) {
  const text = String(token ?? '');
  if (text.length <= 40) return text;
  return `${text.slice(0, 12)}…#${inviteTokenFingerprint(text)}…${text.slice(-8)}`;
}

/** 令牌结果面板（low 直接出；medium/high 门槛通过后复用同一面板）。 */
function showInviteResult(res) {
  const body = $('#invite-body');
  state.inviteToken = res;
  clearInviteBusy();
  $('#invite').hidden = false;
  // 令牌很长：显示截断；指纹放在蓝色文本中段，避免新旧 nonce 都被截掉。
  const tokenFingerprint = inviteTokenFingerprint(res.token);
  const shortToken = inviteTokenShortText(res.token);
  // C7：二维码（服务端用 qrcode-generator 渲染 SVG → data-uri；编码失败为 null → 只显示文本）
  const qrMarkup = res.qrSvg
    ? `<img class="qr-img" alt="${escapeHtml(t('invite.token.qrAlt'))}" src="data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(res.qrSvg)))}" />`
    : `<p class="cfg-help muted invite-qr-fallback">${escapeHtml(t('invite.qrUnavailable'))}</p>`;
  // E2-A2：邀请方忆云名 + 根指纹取 overview.cloud（加入方核对指纹的唯一可靠来源）。
  const cloud = state.overview?.cloud ?? null;
  const fingerprint = cloud?.masterFingerprint
    ? `<code>${escapeHtml(cloud.masterFingerprint)}</code>`
    : `<span class="kv-empty">${escapeHtml(t('common.unknown'))}</span>`;
  const cloudLine = cloud?.name
    ? `<p class="cfg-help muted invite-cloud-line" id="invite-cloud-identity"><b>${escapeHtml(cloud.name)}</b> · ${escapeHtml(t('invite.cloud.rootFingerprint'))} ${fingerprint}</p>`
    : '';
  const selectedTtl = INVITE_TTL_OPTIONS.some((option) => option.ttlMs === res.ttlMs)
    ? res.ttlMs
    : state.inviteTtlMs;
  state.inviteTtlMs = selectedTtl;
  const ttlOptions = INVITE_TTL_OPTIONS.map((option) => (
    `<option value="${option.ttlMs}"${option.ttlMs === selectedTtl ? ' selected' : ''}>${escapeHtml(inviteTtlLabel(option.ttlMs))}</option>`
  )).join('');
  // endpoint 回环/非法与会签批准都只留一条短警告（长说明归设置页）。
  const warnings = [];
  if (res.warning) {
    if (/回环/.test(res.warning)) warnings.push(t('invite.warning.loopback'));
    else if (/不是有效地址/.test(res.warning)) warnings.push(t('invite.warning.invalid'));
    else warnings.push(t('invite.warning.unreachable'));
  }
  if (res.securityApproval) warnings.push(t('invite.warning.approval'));
  const warningLine = warnings.length > 0
    ? `<p class="crt-warn invite-warning">⚠ ${escapeHtml(warnings.join(' '))}</p>`
    : '';
  // 两栏：左 QR，右引导 + 令牌 + TTL；窄屏自动堆叠（见 console.css）。
  body.innerHTML = `
    <div class="invite-layout">
      <div class="invite-qr">${qrMarkup}</div>
      <div class="invite-main">
        <p class="invite-lead">${escapeHtml(t('invite.lead'))}</p>
        <div class="invite-token-block">
          <div class="invite-token-head">
            <span class="invite-label">${escapeHtml(t('invite.token.label'))}</span>
            <span class="invite-fingerprint" id="invite-token-fingerprint" title="${escapeHtml(t('invite.token.fingerprintTitle'))}">${escapeHtml(t('invite.token.fingerprint', { fingerprint: tokenFingerprint }))}</span>
          </div>
          <code class="invite-token-code">${escapeHtml(shortToken)}</code>
          <button class="btn btn-small btn-primary invite-copy" data-copy="${escapeHtml(res.token)}" title="${escapeHtml(t('invite.token.copyTitle'))}">${escapeHtml(t('invite.token.copy'))}</button>
        </div>
        <div class="invite-controls">
          <label class="invite-ttl" for="invite-ttl"><span class="invite-label">${escapeHtml(t('invite.ttl.label'))}</span>
            <select id="invite-ttl" class="crt-input" aria-label="${escapeHtml(t('invite.ttl.aria'))}" title="${escapeHtml(t('invite.ttl.aria'))}">${ttlOptions}</select>
          </label>
          <span class="invite-expiry" id="invite-expiry">${escapeHtml(inviteExpiryLabel(selectedTtl))}</span>
          <button class="btn btn-small invite-regenerate" id="invite-regenerate" type="button" title="${escapeHtml(t('invite.regenerateTitle'))}">${escapeHtml(t('invite.regenerate'))}</button>
        </div>
        ${warningLine}
        <p class="invite-regen-error crt-warn" id="invite-regen-error" role="alert" hidden></p>
      </div>
    </div>
    <div class="invite-foot">
      ${cloudLine}
      <p class="invite-safety">${escapeHtml(t('invite.safety'))}</p>
    </div>
  `;
  enhanceSelect(body.querySelector('#invite-ttl'));
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
    ?? t('cloud.currentFallback');
}

function cloudNameOf(id) {
  return state.clouds?.profiles?.find((entry) => entry.id === id)?.name ?? id;
}

/** 新忆云默认名：未占用的最小整数 N >= 1 → 忆云 N（首启默认 忆云 1；多忆云顺延）。 */
function nextCloudName() {
  const names = new Set((state.clouds?.profiles ?? [])
    .map((entry) => String(entry.name ?? '').trim().toLocaleLowerCase()));
  for (let n = 1; n < 1000; n += 1) {
    const candidate = t('cloud.defaultName', { n });
    if (!names.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return t('cloud.defaultName', { n: Date.now() });
}

const CLOUD_ERROR_KEYS = Object.freeze({
  TOKEN_REQUIRED: 'cloud.error.tokenRequired',
  TOKEN_INVALID: 'cloud.error.tokenInvalid',
  TOKEN_EXPIRED: 'cloud.error.tokenExpired',
  TOKEN_REJECTED: 'cloud.error.tokenRejected',
  CONFIRMATION_REQUIRED: 'cloud.error.confirmationRequired',
  INVALID_NAME: 'cloud.error.invalidName',
  NAME_TAKEN: 'cloud.error.nameTaken',
  CLOUD_ARCHIVED: 'cloud.error.cloudArchived',
  CLOUD_BLOCKED: 'cloud.error.cloudBlocked',
  PROFILE_NOT_FOUND: 'cloud.error.profileNotFound',
  PROFILE_JOIN_FAILED: 'cloud.error.profileJoinFailed',
  ENDPOINT_UNREACHABLE: 'cloud.error.endpointUnreachable',
  CLOUD_ALREADY_JOINED: 'cloud.error.cloudAlreadyJoined',
  CLOUD_DISABLED: 'cloud.error.cloudDisabled',
  CLOUD_UNAVAILABLE: 'cloud.error.cloudUnavailable',
  CLOUD_UNSUPPORTED: 'cloud.error.cloudUnsupported',
  CLOUD_LIST_FAILED: 'cloud.error.cloudListFailed',
  CLOUD_REGISTRY_INVALID: 'cloud.error.cloudRegistryInvalid',
  CLOUD_REGISTRY_LOCKED: 'cloud.error.cloudRegistryLocked',
  CLOUD_PROFILE_PATH_INVALID: 'cloud.error.cloudProfilePathInvalid',
});

function cloudErrorCopy(error) {
  const code = typeof error === 'string' ? error : error?.payload?.error;
  const server = typeof error === 'string' ? '' : (error?.payload?.message ?? error?.message ?? '');
  const key = CLOUD_ERROR_KEYS[code];
  const localized = key ? t(key) : null;
  const known = Boolean(localized && localized !== key);
  return {
    title: known ? localized : (getLocale() === 'zh-CN' && server ? server : t('common.actionFailed')),
    detail: known && getLocale() === 'zh-CN' && server ? server : '',
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
    : `<span class="kv-empty">${escapeHtml(t('settings.cloud.row.unknownRepair'))}</span>`;
  const lastUsed = entry.lastUsedAt ? formatTime(entry.lastUsedAt) : '—';
  const conflictBadges = duplicate
    ? `<span class="badge badge-warn cloud-dup-badge">${escapeHtml(t('settings.cloud.row.duplicate'))}</span>${suggested ? `<span class="badge badge-warn cloud-suggest-badge">${escapeHtml(t('settings.cloud.row.suggestRename'))}</span>` : ''}`
    : '';
  // 第一版：只有当前忆云能写网络级名字；归档项提示切换后再改。
  const renameUi = current
    ? (renaming
      ? `<input class="crt-input cloud-rename-input" data-cloud-rename-input type="text" maxlength="24"
           value="${escapeHtml(state.cloudRename?.name ?? entry.name)}" aria-label="${escapeHtml(t('settings.cloud.rename.aria'))}" />
         <button class="btn btn-small btn-crt" data-cloud-rename-save type="button" ${cloudRenameBusy ? 'disabled' : ''}>${escapeHtml(t('settings.cloud.rename.save'))}</button>
         <button class="btn btn-small" data-cloud-rename-cancel type="button">${escapeHtml(t('common.cancel'))}</button>`
      : `<button class="btn btn-small btn-crt" data-cloud-rename="${id}" type="button">${escapeHtml(t('settings.cloud.rename.action'))}</button>`)
    : `<button class="btn btn-small btn-crt btn-crt-danger" data-cloud-switch="${id}" type="button">${escapeHtml(t('settings.cloud.row.switch'))}</button>
       <span class="cloud-rename-hint muted">${escapeHtml(t('settings.cloud.row.switchHint'))}</span>`;
  return `<div class="cloud-row${current ? ' is-current' : ''}${duplicate ? ' is-duplicate' : ''}" data-cloud-row="${id}">
    <div class="cloud-main">
      <span class="cloud-name">${escapeHtml(entry.name)}</span>
      <span class="badge ${current ? 'badge-ok' : 'badge-muted'}">${escapeHtml(t(current ? 'settings.cloud.row.current' : 'settings.cloud.row.archived'))}</span>
      ${conflictBadges}
    </div>
    <div class="cloud-meta">
      <span>${t('settings.cloud.row.rootFingerprint', { fingerprint })}</span>
      <span>${escapeHtml(t('settings.cloud.row.lastUsed', { time: lastUsed }))}</span>
      ${entry.nameUpdatedAt ? `<span>${escapeHtml(t('settings.cloud.row.nameUpdated', { time: formatTime(entry.nameUpdatedAt) }))}</span>` : ''}
    </div>
    <div class="cloud-actions">${renameUi}</div>
    ${current ? `<p class="cfg-help muted cloud-rename-note">${escapeHtml(t('settings.cloud.row.renameNote'))}</p>` : ''}
    ${renaming && state.cloudRenameError ? `<p class="crt-warn cloud-rename-error" role="alert">${escapeHtml(state.cloudRenameError)}</p>` : ''}
  </div>`;
}

/** 设置 · 常用：忆云卡（E1 只读状态/动作行之后；不提供删除入口）。 */
function cloudCardHtml() {
  let body;
  if (state.clouds) {
    const rows = (state.clouds.profiles ?? []).map(cloudRowHtml).join('');
    body = `${state.clouds.warning ? `<p class="crt-warn">${escapeHtml(state.clouds.warning)}</p>` : ''}
      <div class="cloud-rows">${rows || `<p class="muted">${escapeHtml(t('settings.cloud.empty'))}</p>`}</div>
      <p class="cfg-help muted">${escapeHtml(t('settings.cloud.note'))}</p>
      ${state.clouds.nameConflicts?.currentDuplicate
        ? `<p class="crt-warn">${escapeHtml(t('settings.cloud.duplicate'))}</p>`
        : ''}`;
  } else if (state.cloudsError) {
    const { title, detail } = cloudErrorCopy(state.cloudsError);
    body = `<p class="cloud-unavailable">${escapeHtml(title)}</p>${detail ? `<p class="cfg-help muted">${escapeHtml(detail)}</p>` : ''}`;
  } else {
    body = `<p class="muted">${escapeHtml(t('settings.cloud.loading'))}</p>`;
  }
  return `<section id="settings-cloud-card" class="settings-section cloud-card" data-settings-clouds tabindex="-1">
    <h3>${escapeHtml(t('settings.cloud.title'))} <span class="badge badge-muted">${escapeHtml(t('settings.cloud.keepArchived'))}</span></h3>
    <p class="muted cloud-intro">${escapeHtml(t('settings.cloud.intro'))}</p>
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
    showToast(t('cloud.error.cloudArchived'));
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
    state.cloudRenameError = t('settings.cloud.rename.empty');
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
    showToast(t('settings.cloud.rename.success', { name }));
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
    <p class="muted">${t('cloudSwitch.fallbackNote', { current: escapeHtml(current) })}</p>
    <p class="cloud-warning">${t('cloudSwitch.fallbackWarning', { name: escapeHtml(name) })}</p>
    <div class="copyable"><code>${escapeHtml(command)}</code><button class="btn btn-small btn-crt" type="button" data-copy="${escapeHtml(command)}">${escapeHtml(t('common.copy'))}</button></div>`;
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
  $('#cloud-switch-title').textContent = t('cloudSwitch.title', { name });
  if (state.clouds?.current === id) {
    body.innerHTML = `<p class="cloud-switch-ok">${t('cloudSwitch.already', { name: escapeHtml(name) })}</p>`;
    modal.hidden = false;
    return;
  }
  if (hasCloudSwitchBridge()) {
    body.innerHTML = `<p class="cloud-switch-progress" aria-live="polite">${t('cloudSwitch.progress')}</p>
      <p class="muted">${t('cloudSwitch.progressNote', { name: escapeHtml(cloudCurrentName()) })}</p>`;
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
      body.innerHTML = `<p class="cloud-switch-ok" aria-live="polite">${t('cloudSwitch.submitted', { name: escapeHtml(name) })}</p>
        <p class="muted">${t('cloudSwitch.submittedNote')}</p>`;
    }
    const joinError = $('#cloud-join-switch-error');
    if (joinError) joinError.innerHTML = `<p class="cloud-switch-ok">${t('cloudSwitch.submittedJoin')}</p>`;
    setTimeout(() => { if (!MOCK) void refresh(); }, 1500);
    return true;
  } catch (error) {
    const reason = t('cloudSwitch.switchFailed', { message: displayErrorDetail(error) });
    if (body && $('#cloud-switch')?.hidden === false) {
      body.innerHTML = cloudSwitchFallbackHtml(id, name, reason);
      bindCloudCopy(body);
    }
    const joinError = $('#cloud-join-switch-error');
    if (joinError) {
      const command = cloudSwitchCommand(id);
      joinError.innerHTML = `<p class="cloud-switch-error" role="alert">${escapeHtml(reason)}</p>
        <p class="cfg-help muted">${t('cloudSwitch.manual')}</p>
        <div class="copyable"><code>${escapeHtml(command)}</code><button class="btn btn-small btn-crt" type="button" data-copy="${escapeHtml(command)}">${escapeHtml(t('common.copy'))}</button></div>`;
      bindCloudCopy(joinError);
    }
    return false;
  }
}

async function requestCloudSwitch(id) {
  const entry = state.clouds?.profiles?.find((item) => item.id === id);
  if (!entry) return;
  if (entry.current) { showToast(t('cloudSwitch.alreadyToast')); return; }
  const ok = await confirmModal({
    title: t('cloudSwitch.confirm.title'),
    body: t('cloudSwitch.confirm.body', { name: entry.name, current: cloudCurrentName() }),
    confirmLabel: t('cloudSwitch.confirm.label', { name: entry.name }),
  });
  if (!ok) return;
  openCloudSwitch(entry.id, entry.name);
}

function updateCloudJoinWarning() {
  const el = $('#cloud-join-warning');
  if (!el) return;
  const current = cloudCurrentName();
  el.textContent = hasCloudSwitchBridge()
    ? t('cloudJoin.warning.switch', { name: current })
    : t('cloudJoin.warning.manual', { name: current });
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
    button.textContent = t('cloudJoin.submit.close');
    return;
  }
  button.disabled = cloudJoinBusy;
  if (cloudJoinBusy) button.textContent = t('cloudJoin.submit.busy');
  else if (duplicate) button.textContent = t('cloudJoin.submit.switch', { name: duplicate.name });
  else button.textContent = hasCloudSwitchBridge() ? t('cloudJoin.submit.archiving') : t('cloudJoin.submit');
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
    : `<span class="kv-empty">${escapeHtml(t('common.unknown'))}</span>`;
  const expires = inspected.data.expiresAt ? formatTime(inspected.data.expiresAt) : '—';
  const duplicate = inspected.data.alreadyJoined;
  el.innerHTML = `<p>${t('cloudJoin.inspect.fingerprint', { fingerprint })}</p>
    <p class="muted">${t('cloudJoin.inspect.meta', {
    deviceId: escapeHtml(inspected.data.inviterDeviceId ?? '—'),
    namespace: escapeHtml(inspected.data.namespace ?? '—'),
    expires: escapeHtml(expires),
  })}</p>
    ${duplicate ? `<p class="cloud-duplicate">${t('cloudJoin.inspect.duplicate', { name: escapeHtml(duplicate.name) })}</p>` : ''}`;
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
    ?? t('cloud.currentFallback');
  const command = joined.switch?.command ?? cloudSwitchCommand(joined.profile.id);
  if (hasCloudSwitchBridge()) {
    result.innerHTML = `<p class="cloud-result-ok">${t('cloudJoin.result.joined', { name: escapeHtml(name) })}</p>
      <p class="muted">${t('cloudJoin.result.switching')}</p>
      <div id="cloud-join-switch-error"></div>`;
  } else {
    result.innerHTML = `<p class="cloud-result-ok">${t('cloudJoin.result.joined', { name: escapeHtml(name) })}</p>
      <p class="cloud-warning">${t('cloudJoin.result.manual', { oldName: escapeHtml(oldName) })}</p>
      <div class="copyable"><code>${escapeHtml(command)}</code><button class="btn btn-small btn-crt" type="button" data-copy="${escapeHtml(command)}">${escapeHtml(t('common.copy'))}</button></div>
      <div class="domain-actions"><button id="cloud-join-open-settings" class="btn btn-small btn-crt" type="button">${escapeHtml(t('cloudJoin.result.openSettings'))}</button></div>`;
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
  cloudJoinStep(t('cloudJoin.steps.validating'));
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
  cloudJoinStep(t('cloudJoin.steps.creating'));
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

const stepLabel = (step) => t(`wizard.step.${step}`);

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
    .map((step, i) => `<span class="${i === index ? 'active' : ''}">${escapeHtml(stepLabel(step))}</span>`)
    .join(' › ');
  const error = $('#wizard-error');
  error.hidden = !wizardState.error;
  error.textContent = wizardState.error ? displayErrorDetail({ message: wizardState.error }) : '';
  const body = $('#wizard-body');
  const next = $('#wizard-next');
  const back = $('#wizard-back');
  const copyLabel = escapeHtml(t('common.copy'));

  if (wizardState.step === 'local') {
    const device = state.overview?.device ?? {};
    const multiaddrs = device.multiaddrs ?? [];
    body.innerHTML = `
      <p class="wizard-note">${escapeHtml(t('wizard.local.note'))}</p>
      <div class="field"><label>${escapeHtml(t('wizard.local.deviceLabel'))}</label><input id="wizard-device" type="text" value="${escapeHtml(wizardState.deviceId)}" placeholder="device-B" /></div>
      <div class="field"><label>${escapeHtml(t('wizard.local.addressLabel'))}</label><textarea id="wizard-address" placeholder="/ip4/…/tcp/…/p2p/…">${escapeHtml(wizardState.address)}</textarea></div>
      <details class="wizard-more">
        <summary>${escapeHtml(t('wizard.local.more'))}</summary>
        <div class="field"><label>${escapeHtml(t('wizard.local.selfDevice'))}</label><div class="copyable"><code>${escapeHtml(device.deviceId ?? '—')}</code><button class="btn btn-small" data-copy="${escapeHtml(device.deviceId ?? '')}">${copyLabel}</button></div></div>
        <div class="field"><label>${escapeHtml(t('wizard.local.selfPeer'))}</label><div class="copyable"><code>${escapeHtml(device.peerId ?? '—')}</code>${device.peerId ? `<button class="btn btn-small" data-copy="${escapeHtml(device.peerId)}">${copyLabel}</button>` : ''}</div></div>
        <div class="field"><label>${escapeHtml(t('wizard.local.selfAddrs'))}</label>${multiaddrs.length
          ? multiaddrs.map((addr) => `<div class="copyable"><code>${escapeHtml(addr)}</code><button class="btn btn-small" data-copy="${escapeHtml(addr)}">${copyLabel}</button></div>`).join('')
          : `<code class="muted">${escapeHtml(t('wizard.local.noAddrs'))}</code>`}</div>
        <div class="field"><label>${escapeHtml(t('wizard.local.relay'))}</label><code>${escapeHtml((device.relays ?? []).join(', ') || '—')}</code></div>
      </details>
    `;
    next.textContent = t('wizard.connect');
    next.disabled = false;
    back.disabled = true;
    bindWizardFields();
  } else if (wizardState.step === 'connect') {
    const status = wizardState.connection === 'connected'
      ? t('wizard.connected')
      : wizardState.connection === 'connecting'
        ? t('wizard.connecting')
        : wizardState.connection === 'failed' ? t('wizard.failed') : t('wizard.pending');
    body.innerHTML = `
      <p class="wizard-note">${t('wizard.target', {
    deviceId: `<code>${escapeHtml(wizardState.deviceId)}</code>`,
    address: `<code>${escapeHtml(wizardState.address)}</code>`,
  })}</p>
      <p><b>${escapeHtml(status)}</b></p>
      ${wizardState.connection === 'connected'
        ? `<p class="wizard-note">${escapeHtml(t('wizard.note.connected'))}</p>`
        : ''}
      ${wizardState.connection === 'failed'
        ? `<p class="wizard-note">${escapeHtml(t('wizard.note.failed'))}</p>`
        : ''}
    `;
    next.textContent = wizardState.connection === 'connected' ? t('wizard.done') : t('common.retry');
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
      button.textContent = t('common.copied');
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
      button.textContent = copied ? t('common.copied') : t('common.copyManual');
      setTimeout(() => { button.textContent = old; }, 1600);
    }
  }
}

async function doWizardConnect() {
  if (MOCK) {
    wizardSet({ type: 'CONNECT_FAILURE', message: t('wizard.mock') });
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
      showToast(t('wizard.successToast'));
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
  showToast(t(kind === 'create' ? 'onboard.create.success' : 'onboard.join.success'));
}

const ONBOARD_ERROR_KEYS = Object.freeze({
  INVALID_NAME: 'onboard.error.invalidName',
  TOKEN_INVALID: 'onboard.error.tokenInvalid',
  TOKEN_EXPIRED: 'onboard.error.tokenExpired',
  TOKEN_REJECTED: 'onboard.error.tokenRejected',
  ENDPOINT_UNREACHABLE: 'onboard.error.endpointUnreachable',
});

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
    setOnboardError(errorId, t('onboard.create.error.cloudName'));
    return;
  }
  if (!isCreate && token.length === 0) {
    setOnboardError(errorId, t('onboard.join.error.token'));
    return;
  }
  onboardBusy = true;
  if (submit) {
    submit.disabled = true;
    submit.dataset.label = submit.textContent;
    submit.textContent = isCreate ? t('onboard.create.busy') : t('onboard.join.busy');
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
    setOnboardError(errorId, t('onboard.error.notInitialized'));
  } catch (error) {
    // 重复提交（本进程已热初始化）→ 不裸报错，直接解锁。
    if (error?.status === 409 && error?.payload?.error === 'already_provisioned' && error?.payload?.initialized === true) {
      await unlockConsole(kind);
      return;
    }
    const mappedKey = ONBOARD_ERROR_KEYS[error?.payload?.error];
    const message = getLocale() !== 'zh-CN' && mappedKey
      ? t(mappedKey)
      : displayErrorDetail(error, 'onboard.error.failedFallback');
    setOnboardError(errorId, t('onboard.error.failed', { message }));
  } finally {
    onboardBusy = false;
    if (submit) {
      submit.disabled = false;
      submit.textContent = submit.dataset.label ?? (isCreate ? t('onboard.create.submit') : t('onboard.join.submit'));
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
    setOnboardError('#onboard-create-error', t('lock.settings.initializing'));
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

// 启动完成标记：locale pack 已加载、静态文案已应用、事件已接线。
// UI 冒烟 / 外部壳只在该标记出现后交互，避免在 top-level await 期间点到尚未接线的按钮。
document.documentElement.dataset.consoleReady = '1';
