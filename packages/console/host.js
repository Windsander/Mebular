// Mebular 控制台 · host 适配层（零依赖）
//
// Console 只有一套实现，外面可以套不同的壳：
// - desktop：Electron preload（window.mebularDesktop）提供的原生窗口能力；
// - dsh：被 DSH 面板以 iframe 嵌入，只通过最小 postMessage 桥沟通；
// - browser：普通浏览器，能力全部为 false。
//
// 页面只按 capabilities 决定是否显示动作，禁止出现不可用的死按钮。

const BRIDGE_METHODS = new Set(['openExternal', 'restartDaemon', 'openWizard', 'setTitle', 'notify', 'cloudSwitch']);
const BRIDGE_TIMEOUT_MS = 5000;
const NAVIGATE_MESSAGE = 'mebular:navigate';

function toSearchParams(search) {
  if (search instanceof URLSearchParams) return search;
  if (typeof search === 'string') return new URLSearchParams(search);
  return new URLSearchParams();
}

/** 只接受 http(s) 的绝对 URL；其余（javascript:、data: 等）一律拒绝。 */
function safeExternalUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.origin === 'null') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** 精确的父页面 origin：优先 ancestorOrigins，其次 document.referrer；推导不到返回 null。 */
function resolveParentOrigin(win) {
  const ancestors = win?.location?.ancestorOrigins;
  if (ancestors && typeof ancestors.length === 'number' && ancestors.length > 0) {
    const fromAncestor = normalizeOrigin(ancestors[0]);
    if (fromAncestor) return fromAncestor;
  }
  const referrer = win?.document?.referrer;
  return normalizeOrigin(referrer);
}

function browserOpenExternal(win, url) {
  const safe = safeExternalUrl(url);
  if (!safe) throw new Error('openExternal: 只允许 http(s) URL');
  if (typeof win?.open === 'function') win.open(safe, '_blank', 'noopener,noreferrer');
}

function noop() {}

function createDesktopHost(win) {
  const preload = win?.mebularDesktop ?? null;
  const has = (name) => typeof preload?.[name] === 'function';
  const call = (name, ...args) => {
    if (!has(name)) throw new Error(`桌面壳未提供 ${name}`);
    return preload[name].apply(preload, args);
  };
  return {
    kind: 'desktop',
    platform: typeof preload?.platform === 'string' ? preload.platform : null,
    capabilities: {
      nativeWindow: true,
      tray: true,
      restartDaemon: has('restart'),
      openWizard: has('openWizard'),
      openExternal: has('openExternal'),
      notifications: has('notify'),
      cloudSwitch: has('cloudSwitch'),
      consoleNavigate: has('onConsoleNavigate'),
    },
    openExternal(url) {
      const safe = safeExternalUrl(url);
      if (!safe) throw new Error('openExternal: 只允许 http(s) URL');
      if (has('openExternal')) return preload.openExternal(safe);
      if (typeof win?.open === 'function') win.open(safe, '_blank', 'noopener,noreferrer');
      return undefined;
    },
    restartDaemon() {
      return call('restart');
    },
    openWizard() {
      return call('openWizard');
    },
    setTitle(title) {
      if (has('setTitle')) return preload.setTitle(String(title ?? ''));
      if (win?.document) win.document.title = String(title ?? '');
      return undefined;
    },
    notify(payload = {}) {
      if (has('notify')) return preload.notify(payload);
      return undefined;
    },
    cloudSwitch(id) {
      return call('cloudSwitch', String(id));
    },
    onConsoleNavigate(handler) {
      if (typeof handler !== 'function' || !has('onConsoleNavigate')) return noop;
      const unsubscribe = preload.onConsoleNavigate(handler);
      return typeof unsubscribe === 'function' ? unsubscribe : noop;
    },
  };
}

function createDshHost(win) {
  const parent = win?.parent;
  const embedded = Boolean(parent && parent !== win);
  const targetOrigin = embedded ? resolveParentOrigin(win) : null;
  const bridgeEnabled = Boolean(embedded && targetOrigin && typeof parent?.postMessage === 'function');
  const pending = new Map();
  const navigateHandlers = new Set();
  let nextId = 1;

  function trusted(event) {
    if (!bridgeEnabled) return false;
    return event?.source === parent && event?.origin === targetOrigin;
  }

  function onMessage(event) {
    if (!trusted(event)) return;
    const data = event?.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === NAVIGATE_MESSAGE) {
      const search = data.search;
      if (typeof search !== 'string' || !search.startsWith('?')) return;
      for (const handler of [...navigateHandlers]) {
        try {
          handler(search);
        } catch {
          // 单个导航订阅异常不影响桥本身
        }
      }
      return;
    }
    if (data.type !== 'mebular:response') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(typeof data.error === 'string' ? data.error : 'host request failed'));
  }

  if (bridgeEnabled && typeof win.addEventListener === 'function') {
    win.addEventListener('message', onMessage);
  }

  function request(method, params) {
    if (!BRIDGE_METHODS.has(method)) return Promise.reject(new Error(`不支持 host 方法 ${method}`));
    if (!bridgeEnabled) return Promise.reject(new Error('host bridge unavailable'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`host request timeout: ${method}`));
      }, BRIDGE_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        parent.postMessage({ type: 'mebular:request', id, method, params }, targetOrigin);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  return {
    kind: 'dsh',
    platform: null,
    capabilities: {
      nativeWindow: false,
      tray: false,
      restartDaemon: false,
      openWizard: false,
      openExternal: false,
      notifications: false,
      cloudSwitch: false,
      consoleNavigate: false,
    },
    bridgeAvailable: bridgeEnabled,
    openExternal(url) {
      const safe = safeExternalUrl(url);
      if (!safe) return Promise.reject(new Error('openExternal: 只允许 http(s) URL'));
      return request('openExternal', { url: safe });
    },
    restartDaemon() {
      return request('restartDaemon', {});
    },
    openWizard() {
      return request('openWizard', {});
    },
    setTitle(title) {
      return request('setTitle', { title: String(title ?? '') });
    },
    notify(payload = {}) {
      return request('notify', {
        level: String(payload?.level ?? 'info'),
        message: String(payload?.message ?? ''),
      });
    },
    cloudSwitch(id) {
      return request('cloudSwitch', { id: String(id) });
    },
    onConsoleNavigate(handler) {
      if (typeof handler !== 'function' || !bridgeEnabled) return noop;
      navigateHandlers.add(handler);
      return () => navigateHandlers.delete(handler);
    },
  };
}

function createBrowserHost(win) {
  return {
    kind: 'browser',
    platform: null,
    capabilities: {
      nativeWindow: false,
      tray: false,
      restartDaemon: false,
      openWizard: false,
      openExternal: false,
      notifications: false,
      cloudSwitch: false,
      consoleNavigate: false,
    },
    openExternal(url) {
      browserOpenExternal(win, url);
    },
    restartDaemon() {
      return Promise.reject(new Error('浏览器模式不支持重启守护'));
    },
    openWizard() {
      throw new Error('浏览器模式不支持打开桌面向导');
    },
    setTitle(title) {
      if (win?.document) win.document.title = String(title ?? '');
    },
    notify(payload = {}) {
      void payload;
    },
    cloudSwitch() {
      return Promise.reject(new Error('浏览器模式不支持切换忆云'));
    },
    onConsoleNavigate() {
      return noop;
    },
  };
}

/**
 * 创建 Console host 适配层。
 * `?embed=dsh` 优先于 Electron preload；未嵌入的 DSH 页面仍按 dsh 布局处理。
 */
export function createConsoleHost({ search = '', win = globalThis.window } = {}) {
  const params = toSearchParams(search);
  if (params.get('embed') === 'dsh') return createDshHost(win);
  if (win?.mebularDesktop) return createDesktopHost(win);
  return createBrowserHost(win);
}

/** embed 布局标记：只有 DSH 内嵌时设置 documentElement.dataset.embed。 */
export function markEmbeddedDocument(document, kind) {
  if (kind !== 'dsh') return;
  const root = document?.documentElement;
  if (root?.dataset) root.dataset.embed = 'dsh';
}
