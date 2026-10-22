// Mebular 控制台 i18n foundation（vanilla ES module，零运行时依赖、无构建步骤）
//
// 目标：locale 文案独立为数据包，应用代码只依赖 manifest + t()。
// - 唯一注册表：/locales/manifest.json（locale、nativeName、fallback、pack 路径）。
// - 每种语言一个目录：/locales/<locale>/console.json（本 PR 只迁 console 24 个 key）。
// - 默认 zh-CN；请求 locale 缺 key 时按 manifest fallback 链回退。
// - `?lang=` 优先（测试 / 深链），其次 localStorage，其次 navigator.languages。
// - 缺 key 永不返回空字符串：开发 / 测试回退 key，并只告警一次。
// - 初始化（initI18n）是异步的；console.js 在首帧渲染前 await，避免先显示 key。
// - manifest / pack 加载失败不抛异常：静态中文兜底仍在，t() 回退 key，界面不白屏。
// - 语言变化通过 onLocaleChange 固定回调通知界面重渲染；不 reload、不跳页。
// - 新增语言只需新增目录 + manifest 注册，不改业务代码。

export const DEFAULT_LOCALE = 'zh-CN';
export const LOCALE_STORAGE_KEY = 'mebular.locale';
export const MANIFEST_URL = '/locales/manifest.json';
export const LOCALES_BASE_URL = '/locales';
export const CONSOLE_PACK = 'console';

/** 语言行默认开放；catalog 未全量翻译期间，未选英文的普通用户仍默认 zh-CN。 */
export const I18N_FOUNDATION_READY = true;

/** 当前 manifest 注册的 locale code（initI18n 后更新；空数组表示尚未加载）。 */
export let SUPPORTED_LOCALES = Object.freeze([]);

/** 兼容旧调用方的只读入口：initI18n 后填入已加载的 console catalog。 */
export const CATALOGS = Object.create(null);

const DATE_OPTIONS = Object.freeze({ year: 'numeric', month: '2-digit', day: '2-digit' });
const TIME_OPTIONS = Object.freeze({ hour: '2-digit', minute: '2-digit', hour12: false });
const EXPIRY_DAY_TIME_OPTIONS = Object.freeze({
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const DATETIME_OPTIONS = Object.freeze({
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function normalizeTag(raw) {
  return String(raw ?? '').trim().toLowerCase().replaceAll('_', '-');
}

function emptyManifest() {
  return {
    schemaVersion: 1,
    defaultLocale: DEFAULT_LOCALE,
    fallbackLocale: DEFAULT_LOCALE,
    packs: [CONSOLE_PACK],
    locales: [],
  };
}

function safePackPath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return null;
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return value;
}

/**
 * 归一化 manifest；缺字段时给出安全默认值。
 * 允许测试 / 嵌入方只传 catalogs（由 catalog 的 key 推导 supported locales）。
 */
function normalizeManifest(raw, { catalogs = null } = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const catalogLocales = catalogs && typeof catalogs === 'object'
    ? Object.keys(catalogs).filter((code) => typeof code === 'string' && code.trim())
    : [];
  const rawLocales = Array.isArray(source.locales) ? source.locales : [];
  const locales = [];
  for (const entry of rawLocales) {
    if (!entry || typeof entry !== 'object') continue;
    const code = typeof entry.locale === 'string'
      ? entry.locale.trim()
      : (typeof entry.code === 'string' ? entry.code.trim() : '');
    if (!code) continue;
    const files = entry.files && typeof entry.files === 'object' && !Array.isArray(entry.files)
      ? { ...entry.files }
      : {};
    locales.push({
      locale: code,
      nativeName: typeof entry.nativeName === 'string' && entry.nativeName.trim() ? entry.nativeName.trim() : null,
      files,
    });
  }
  if (locales.length === 0 && catalogLocales.length > 0) {
    for (const code of catalogLocales) {
      locales.push({
        locale: code,
        nativeName: null,
        files: { [CONSOLE_PACK]: `${code}/console.json` },
      });
    }
  }
  const codes = new Set(locales.map((entry) => entry.locale));
  const requestedDefault = typeof source.defaultLocale === 'string' && source.defaultLocale.trim()
    ? source.defaultLocale.trim()
    : null;
  const requestedFallback = typeof source.fallbackLocale === 'string' && source.fallbackLocale.trim()
    ? source.fallbackLocale.trim()
    : null;
  // manifest 是唯一注册表：未注册的 default / fallback 不能把界面带到无文案的 locale。
  const defaultLocale = codes.size === 0
    ? (requestedDefault ?? DEFAULT_LOCALE)
    : (requestedDefault && codes.has(requestedDefault)
      ? requestedDefault
      : (codes.has(DEFAULT_LOCALE) ? DEFAULT_LOCALE : locales[0].locale));
  const fallbackLocale = codes.size === 0
    ? (requestedFallback ?? defaultLocale)
    : (requestedFallback && codes.has(requestedFallback) ? requestedFallback : defaultLocale);
  return {
    manifest: {
      schemaVersion: Number.isInteger(source.schemaVersion) ? source.schemaVersion : 1,
      defaultLocale,
      fallbackLocale,
      packs: Array.isArray(source.packs) ? [...source.packs] : [CONSOLE_PACK],
      locales: locales.map((entry) => ({ ...entry })),
    },
    locales,
    defaultLocale,
    fallbackLocale,
  };
}

function activeRegistry() {
  return normalizeManifest(defaultManifest);
}

let defaultManifest = emptyManifest();

function toRegistry(input) {
  if (!input) return activeRegistry();
  if (Array.isArray(input)) {
    return normalizeManifest({ locales: input });
  }
  if (input.locales && Array.isArray(input.locales) && input.locales[0] && typeof input.locales[0] === 'object') {
    return normalizeManifest(input);
  }
  return normalizeManifest(input);
}

/** 在给定注册表中匹配语言：精确 code > 同语言前缀（en-GB → en-US）> null。 */
function matchLocale(raw, registry) {
  const tag = normalizeTag(raw);
  if (!tag) return null;
  const exact = registry.locales.find((entry) => entry.locale.toLowerCase() === tag);
  if (exact) return exact.locale;
  const base = tag.split('-')[0];
  const sameLanguage = registry.locales.filter((entry) => entry.locale.toLowerCase().split('-')[0] === base);
  if (sameLanguage.length === 0) return null;
  const region = tag.split('-')[1];
  const sameRegion = sameLanguage.find((entry) => entry.locale.toLowerCase().split('-')[1] === region);
  return (sameRegion ?? sameLanguage[0]).locale;
}

/** 归一化任意语言标签：命中 manifest → 注册 code；未知 / 空 → 默认 locale。 */
export function normalizeLocale(raw, manifest = null) {
  const registry = toRegistry(manifest);
  return matchLocale(raw, registry) ?? registry.defaultLocale;
}

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function safeSearch() {
  try {
    return globalThis.location?.search ?? '';
  } catch {
    return '';
  }
}

function safeLanguages() {
  try {
    const languages = globalThis.navigator?.languages;
    if (Array.isArray(languages) && languages.length > 0) return languages;
    const language = globalThis.navigator?.language;
    return language ? [language] : [];
  } catch {
    return [];
  }
}

function readStoredLocale(storage) {
  try {
    const value = storage?.getItem?.(LOCALE_STORAGE_KEY);
    return typeof value === 'string' && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function persistLocale(storage, locale) {
  try {
    storage?.setItem?.(LOCALE_STORAGE_KEY, locale);
  } catch {
    // 隐私模式 / 配额满：语言仍在本页生效，只是不跨刷新记忆。
  }
}

/**
 * 解析初始 locale（优先级：?lang= > localStorage > 系统语言 > 默认 locale）。
 * 未知系统语言不会提前截断列表（例如 ['fr-FR','en-US'] 仍会命中 en-US）。
 */
export function resolveLocale({ search = '', storage = null, languages = [], manifest = null } = {}) {
  const registry = toRegistry(manifest);
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const query = params.get('lang');
  if (query && query.trim()) return matchLocale(query, registry) ?? registry.defaultLocale;

  const stored = readStoredLocale(storage);
  if (stored) return matchLocale(stored, registry) ?? registry.defaultLocale;

  for (const language of Array.isArray(languages) ? languages : []) {
    const matched = matchLocale(language, registry);
    if (matched) return matched;
  }
  return registry.defaultLocale;
}

/** 模板插值：只替换传入的 {name}，未知占位符原样保留，避免误吞内容。 */
export function interpolate(template, vars) {
  if (vars === null || vars === undefined) return template;
  return String(template).replaceAll(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  ));
}

function isDevRuntime() {
  try {
    return globalThis.process?.env?.NODE_ENV !== 'production';
  } catch {
    return true;
  }
}

function syncDocumentLang(locale) {
  try {
    if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = locale;
  } catch {
    // 非浏览器环境（单测 / CLI）没有 document。
  }
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function normalizeCatalogMap(catalogs) {
  const out = Object.create(null);
  if (!catalogs || typeof catalogs !== 'object' || Array.isArray(catalogs)) return out;
  for (const [code, value] of Object.entries(catalogs)) {
    if (typeof code !== 'string' || !code.trim()) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const messages = value.messages && typeof value.messages === 'object' && !Array.isArray(value.messages)
      ? value.messages
      : value;
    out[code] = messages;
  }
  return out;
}

function extractMessages(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const messages = json.messages;
  if (messages && typeof messages === 'object' && !Array.isArray(messages)) return messages;
  // 兼容直接以 { key: value } 存放的 pack；过滤 envelope 元数据字段。
  const out = {};
  for (const [key, value] of Object.entries(json)) {
    if (key === 'schemaVersion' || key === 'locale' || key === 'pack' || key === 'messages') continue;
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** 静态 DOM 文案：data-i18n / data-i18n-title / data-i18n-placeholder / data-i18n-aria-label。 */
export function applyStaticI18nWith(translate, root = globalThis.document) {
  if (!root?.querySelectorAll) return 0;
  let updated = 0;
  const translateFor = (key) => {
    // 加载失败时不把服务端已渲染的中文兜底替换成 key（避免首屏出现 key / 白屏）。
    if (typeof translate.has === 'function' && !translate.has(key)) return null;
    const value = translate(key);
    if (typeof value !== 'string' || value === key) return null;
    return value;
  };
  const each = (selector, apply) => {
    for (const element of root.querySelectorAll(selector)) {
      const key = element.getAttribute(selector.slice(1, -1));
      const value = translateFor(key);
      if (value === null) continue;
      apply(element, value);
      updated += 1;
    }
  };
  each('[data-i18n]', (element, value) => {
    element.textContent = value;
  });
  each('[data-i18n-title]', (element, value) => {
    element.setAttribute('title', value);
  });
  each('[data-i18n-placeholder]', (element, value) => {
    element.placeholder = value;
    element.setAttribute('placeholder', value);
  });
  each('[data-i18n-aria-label]', (element, value) => {
    element.setAttribute('aria-label', value);
  });
  // 页面标题没有属性承载点：有 app.title key 时顺带同步。
  if (root === globalThis.document && root.title !== undefined) {
    const title = translateFor('app.title');
    if (title !== null) root.title = title;
  }
  return updated;
}

function formatWith(locale, options, value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return String(value);
  }
}

function sameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/**
 * 到期时刻：同一日历日只显示 HH:mm；跨天补 MM/DD（由 Intl 按 locale 排列）。
 * now 可注入，便于测试「同日 / 跨天」边界。
 */
function formatExpiryWith(locale, value, now = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const base = now instanceof Date ? now : new Date(now);
  const options = !Number.isNaN(base.getTime()) && sameCalendarDay(date, base)
    ? TIME_OPTIONS
    : EXPIRY_DAY_TIME_OPTIONS;
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return String(value);
  }
}

/**
 * 创建独立的 i18n 实例（测试 / 多窗口可注入 storage/search/languages/catalogs/manifest）。
 * 模块底部的默认导出是控制台实际使用的单例。
 */
export function createI18n({
  storage = safeStorage(),
  search = safeSearch(),
  languages = safeLanguages(),
  catalogs = null,
  manifest = null,
  locale: initialLocale = null,
  onMissing = null,
  documentLang = true,
} = {}) {
  let registry = normalizeManifest(manifest, { catalogs });
  let catalogState = normalizeCatalogMap(catalogs);
  let locale = initialLocale === null
    ? resolveLocale({ search, storage, languages, manifest: registry })
    : normalizeLocale(initialLocale, registry);
  let missingHandler = onMissing;
  let syncLang = documentLang;
  const listeners = new Set();
  const warned = new Set();

  const fallbackChain = (code) => [...new Set([code, registry.fallbackLocale, registry.defaultLocale].filter(Boolean))];

  const lookup = (key, code = locale) => {
    for (const candidate of fallbackChain(code)) {
      const value = catalogState[candidate]?.[key];
      if (typeof value === 'string') return value;
    }
    return null;
  };

  const translate = (key, vars) => {
    const value = lookup(key);
    if (value === null) {
      if (!warned.has(key)) {
        warned.add(key);
        if (typeof missingHandler === 'function') missingHandler(key, locale);
        else if (isDevRuntime()) console.warn(`[i18n] missing key: ${key} (${locale})`);
      }
      return String(key);
    }
    return interpolate(value, vars);
  };
  translate.has = (key) => lookup(key) !== null;

  const syncDocument = () => {
    if (syncLang) syncDocumentLang(locale);
  };

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener(locale);
      } catch {
        // 单个渲染回调失败不能阻断语言切换。
      }
    }
  };

  syncDocument();

  const api = {
    getLocale: () => locale,
    getSupportedLocales: () => registry.locales.map((entry) => entry.locale),
    getManifest: () => registry.manifest,
    setLocale(next, { persist = true } = {}) {
      const normalized = normalizeLocale(next, registry);
      const changed = normalized !== locale;
      locale = normalized;
      if (persist && changed) persistLocale(storage, normalized);
      syncDocument();
      if (changed) notify();
      return normalized;
    },
    t: translate,
    onLocaleChange(callback) {
      if (typeof callback !== 'function') return () => {};
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    applyStaticI18n(root = globalThis.document) {
      return applyStaticI18nWith(translate, root);
    },
    formatDate(value) {
      return formatWith(locale, DATE_OPTIONS, value);
    },
    formatTime(value) {
      return formatWith(locale, TIME_OPTIONS, value);
    },
    formatDateTime(value) {
      return formatWith(locale, DATETIME_OPTIONS, value);
    },
    formatExpiry(value, now = Date.now()) {
      return formatExpiryWith(locale, value, now);
    },
    /** 内部：initI18n 在加载完成后把 manifest / catalogs / locale 换入单例。 */
    configure(next = {}) {
      registry = normalizeManifest(next.manifest ?? registry.manifest, { catalogs: next.catalogs ?? catalogState });
      catalogState = normalizeCatalogMap(next.catalogs ?? catalogState);
      if (next.onMissing !== undefined) missingHandler = next.onMissing;
      if (next.documentLang !== undefined) syncLang = next.documentLang;
      const normalized = next.locale === undefined
        ? normalizeLocale(locale, registry)
        : normalizeLocale(next.locale, registry);
      const changed = normalized !== locale;
      locale = normalized;
      syncDocument();
      if (changed) notify();
      return api;
    },
  };
  return api;
}

function defaultFetch() {
  try {
    return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
  } catch {
    return null;
  }
}

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

async function fetchJson(fetchImpl, url) {
  if (typeof fetchImpl !== 'function') throw new Error(`fetch unavailable: ${url}`);
  const response = await fetchImpl(url);
  if (!response || response.ok === false) {
    throw new Error(`HTTP ${response?.status ?? 'error'}: ${url}`);
  }
  return response.json();
}

/**
 * 按 manifest 加载全部 console pack，返回独立实例（不修改模块单例）。
 * 供测试 / 嵌入方使用；控制台入口用 initI18n。
 */
export async function loadI18n({
  fetchImpl = defaultFetch(),
  manifestUrl = MANIFEST_URL,
  localesBaseUrl = LOCALES_BASE_URL,
  manifest: manifestInput = null,
  catalogs: preloaded = null,
  search = safeSearch(),
  storage = safeStorage(),
  languages = safeLanguages(),
  requestLocale = null,
  onMissing = null,
  documentLang = true,
} = {}) {
  const errors = [];
  let rawManifest = manifestInput;
  if (!rawManifest) {
    try {
      rawManifest = await fetchJson(fetchImpl, manifestUrl);
    } catch (error) {
      errors.push({ scope: 'manifest', url: manifestUrl, message: String(error?.message ?? error) });
    }
  }

  let registry = normalizeManifest(rawManifest, { catalogs: preloaded });

  // manifest 不可用时仍尝试默认语言包（约定路径），保证界面退化为静态中文而不是白屏。
  if (registry.locales.length === 0) {
    const emergencyPath = `${DEFAULT_LOCALE}/console.json`;
    try {
      const json = await fetchJson(fetchImpl, joinUrl(localesBaseUrl, emergencyPath));
      const messages = extractMessages(json);
      if (Object.keys(messages).length > 0) {
        preloaded = { ...(preloaded ?? {}), [DEFAULT_LOCALE]: messages };
        registry = normalizeManifest({
          schemaVersion: 1,
          defaultLocale: DEFAULT_LOCALE,
          fallbackLocale: DEFAULT_LOCALE,
          packs: [CONSOLE_PACK],
          locales: [{ locale: DEFAULT_LOCALE, nativeName: null, files: { [CONSOLE_PACK]: emergencyPath } }],
        });
      }
    } catch (error) {
      errors.push({ scope: 'pack', locale: DEFAULT_LOCALE, path: emergencyPath, message: String(error?.message ?? error) });
    }
  }

  const normalizedPreloaded = normalizeCatalogMap(preloaded);
  const catalogs = Object.create(null);
  await Promise.all(registry.locales.map(async (entry) => {
    const code = entry.locale;
    if (normalizedPreloaded[code]) {
      catalogs[code] = normalizedPreloaded[code];
      return;
    }
    const path = safePackPath(entry.files?.[CONSOLE_PACK]);
    if (!path) {
      errors.push({ scope: 'manifest', locale: code, message: `missing ${CONSOLE_PACK} pack path` });
      catalogs[code] = {};
      return;
    }
    try {
      const json = await fetchJson(fetchImpl, joinUrl(localesBaseUrl, path));
      catalogs[code] = extractMessages(json);
    } catch (error) {
      errors.push({ scope: 'pack', locale: code, path, message: String(error?.message ?? error) });
      catalogs[code] = {};
    }
  }));

  const manifest = registry.manifest;
  const locale = requestLocale === null
    ? resolveLocale({ search, storage, languages, manifest: registry })
    : normalizeLocale(requestLocale, registry);
  const i18n = createI18n({ manifest, catalogs, locale, onMissing, documentLang });
  const defaultMessages = catalogs[manifest.defaultLocale] ?? {};
  return {
    i18n,
    manifest,
    catalogs,
    locale: i18n.getLocale(),
    supportedLocales: registry.locales.map((entry) => entry.locale),
    errors,
    ready: registry.locales.length > 0 && Object.keys(defaultMessages).length > 0,
  };
}

/**
 * 加载 manifest + packs 并切换模块默认单例。
 * 失败不抛：返回 ready=false，调用方可继续渲染静态兜底。
 */
export async function initI18n(options = {}) {
  const loaded = await loadI18n(options);
  defaultManifest = loaded.manifest;
  SUPPORTED_LOCALES = Object.freeze(loaded.supportedLocales);
  for (const key of Object.keys(CATALOGS)) delete CATALOGS[key];
  Object.assign(CATALOGS, loaded.catalogs);
  defaultI18n.configure({
    manifest: loaded.manifest,
    catalogs: loaded.catalogs,
    locale: loaded.locale,
    onMissing: options.onMissing,
    documentLang: options.documentLang,
  });
  return loaded;
}

const defaultI18n = createI18n({ storage: null, search: '', languages: [], documentLang: true });

export const getLocale = () => defaultI18n.getLocale();
export const setLocale = (locale, options) => defaultI18n.setLocale(locale, options);
export const t = (key, vars) => defaultI18n.t(key, vars);
// 与实例 t 保持同形：静态文案应用时据此判断“是否真的有译文”，缺 key 不覆盖服务端兜底。
t.has = (key) => defaultI18n.t.has(key);
export const onLocaleChange = (callback) => defaultI18n.onLocaleChange(callback);
export const formatDate = (value) => defaultI18n.formatDate(value);
export const formatTime = (value) => defaultI18n.formatTime(value);
export const formatDateTime = (value) => defaultI18n.formatDateTime(value);
export const formatExpiry = (value, now) => defaultI18n.formatExpiry(value, now);

export function applyStaticI18n(root = globalThis.document) {
  return defaultI18n.applyStaticI18n(root);
}

/** manifest 注册表快照（initI18n 后可用；未加载时 locales 为空）。 */
export function getManifest() {
  return defaultManifest;
}

export function getManifestLocales() {
  return activeRegistry().locales.map(({ locale, nativeName }) => ({ locale, nativeName }));
}

export function getSupportedLocales() {
  return activeRegistry().locales.map((entry) => entry.locale);
}

/** 就绪开关：默认开放；?lang= / ?i18n=1 / 桌面壳显式 i18nReady 仍然兼容。 */
export function isI18nReady({
  search = safeSearch(),
  desktop = globalThis.mebularDesktop,
} = {}) {
  if (I18N_FOUNDATION_READY) return true;
  if (desktop?.i18nReady === true) return true;
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  return params.get('i18n') === '1' || Boolean(params.get('lang')?.trim());
}

/**
 * 设置 · 常用页的语言行（单行，复用 .asst-row 的虚线分隔）。
 * 默认开放；catalog 尚未全量翻译时也保留入口，避免用户找不到语言开关。
 * 语言名称来自 manifest.nativeName（新增语言不需要新增 locale.* 文案 key）。
 */
export function languageSettingsRowHtml({
  ready = isI18nReady(),
  locale = getLocale(),
  translate = t,
  locales = null,
} = {}) {
  if (!ready) return '';
  const entries = (Array.isArray(locales) && locales.length > 0
    ? locales
    : getManifestLocales()).map((entry) => (
    typeof entry === 'string' ? { locale: entry, nativeName: null } : entry
  ));
  if (entries.length === 0) return '';
  const current = normalizeLocale(locale, { locales: entries, defaultLocale: entries[0].locale });
  const options = entries.map((entry) => {
    const code = entry.locale;
    const nativeName = entry.nativeName;
    const label = nativeName || translate(`locale.${code}`) || code;
    return `<option value="${escapeHtml(code)}"${code === current ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
  return `<div class="asst-row settings-language-row" id="settings-language" data-settings-language>
      <span class="asst-name" data-i18n="settings.language">${escapeHtml(translate('settings.language'))}</span>
      <span class="asst-sp"></span>
      <select id="settings-language-select" class="crt-input settings-language-select" data-language-select
        aria-label="${escapeHtml(translate('settings.language.aria'))}"
        data-i18n-aria-label="settings.language.aria"
        title="${escapeHtml(translate('settings.language.title'))}"
        data-i18n-title="settings.language.title">${options}</select>
    </div>`;
}
