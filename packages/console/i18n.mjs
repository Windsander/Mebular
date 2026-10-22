// Mebular 控制台 i18n foundation（vanilla ES module，零运行时依赖、无构建步骤）
//
// 目标：先提供稳定的 locale / catalog / 静态文案 / 日期时间基础能力，后续 PR 分批迁移文案。
// - 默认 zh-CN；支持 en-US。未知语言一律回退 zh-CN。
// - `?lang=` 优先（测试 / 深链），其次 localStorage，其次 navigator.languages。
// - 缺 key 永不返回空字符串：开发 / 测试回退 key，并只告警一次。
// - 语言变化通过 onLocaleChange 固定回调通知界面重渲染；不 reload、不跳页。

import zhCN from './messages/zh-CN.mjs';
import enUS from './messages/en-US.mjs';

export const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en-US']);
export const DEFAULT_LOCALE = 'zh-CN';
export const LOCALE_STORAGE_KEY = 'mebular.locale';

/** 语言行默认开放；catalog 未全量翻译期间，未选英文的普通用户仍默认 zh-CN。 */
export const I18N_FOUNDATION_READY = true;

export const CATALOGS = Object.freeze({
  'zh-CN': zhCN,
  'en-US': enUS,
});

const DATE_OPTIONS = Object.freeze({ year: 'numeric', month: '2-digit', day: '2-digit' });
const TIME_OPTIONS = Object.freeze({ hour: '2-digit', minute: '2-digit', hour12: false });
const EXPIRY_DAY_TIME_OPTIONS = Object.freeze({
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const DATETIME_OPTIONS = Object.freeze({
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function localeFromTag(raw) {
  const tag = String(raw ?? '').trim().toLowerCase().replaceAll('_', '-');
  if (tag.startsWith('en')) return 'en-US';
  if (tag.startsWith('zh')) return 'zh-CN';
  return null;
}

/** 归一化任意语言标签：en* → en-US，zh* → zh-CN，未知 / 空 → zh-CN。 */
export function normalizeLocale(raw) {
  return localeFromTag(raw) ?? DEFAULT_LOCALE;
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
 * 解析初始 locale（优先级：?lang= > localStorage > 系统语言 > zh-CN）。
 * 未知系统语言不会提前截断列表（例如 ['fr-FR','en-US'] 仍会命中 en-US）。
 */
export function resolveLocale({ search = '', storage = null, languages = [] } = {}) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const query = params.get('lang');
  if (query && query.trim()) return normalizeLocale(query);

  const stored = readStoredLocale(storage);
  if (stored) return normalizeLocale(stored);

  for (const language of Array.isArray(languages) ? languages : []) {
    const matched = localeFromTag(language);
    if (matched) return matched;
  }
  return DEFAULT_LOCALE;
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

/** 静态 DOM 文案：data-i18n / data-i18n-title / data-i18n-placeholder / data-i18n-aria-label。 */
export function applyStaticI18nWith(translate, root = globalThis.document) {
  if (!root?.querySelectorAll) return 0;
  let updated = 0;
  const each = (selector, apply) => {
    for (const element of root.querySelectorAll(selector)) {
      apply(element);
      updated += 1;
    }
  };
  each('[data-i18n]', (element) => {
    element.textContent = translate(element.getAttribute('data-i18n'));
  });
  each('[data-i18n-title]', (element) => {
    element.setAttribute('title', translate(element.getAttribute('data-i18n-title')));
  });
  each('[data-i18n-placeholder]', (element) => {
    const text = translate(element.getAttribute('data-i18n-placeholder'));
    element.placeholder = text;
    element.setAttribute('placeholder', text);
  });
  each('[data-i18n-aria-label]', (element) => {
    element.setAttribute('aria-label', translate(element.getAttribute('data-i18n-aria-label')));
  });
  // 页面标题没有属性承载点：有 app.title key 时顺带同步。
  if (root === globalThis.document && root.title !== undefined) {
    const title = translate('app.title');
    if (title !== 'app.title') root.title = title;
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
 * 创建独立的 i18n 实例（测试 / 多窗口可注入 storage/search/languages）。
 * 模块底部的默认导出是控制台实际使用的单例。
 */
export function createI18n({
  storage = safeStorage(),
  search = safeSearch(),
  languages = safeLanguages(),
  catalogs = CATALOGS,
  onMissing = null,
  documentLang = true,
} = {}) {
  let locale = resolveLocale({ search, storage, languages });
  const listeners = new Set();
  const warned = new Set();

  const translate = (key, vars) => {
    const catalog = catalogs[locale] ?? catalogs[DEFAULT_LOCALE] ?? {};
    const value = catalog[key];
    if (typeof value !== 'string') {
      if (!warned.has(key)) {
        warned.add(key);
        if (typeof onMissing === 'function') onMissing(key, locale);
        else if (isDevRuntime()) console.warn(`[i18n] missing key: ${key} (${locale})`);
      }
      return String(key);
    }
    return interpolate(value, vars);
  };

  syncDocumentLang(locale);

  const api = {
    getLocale: () => locale,
    setLocale(next, { persist = true } = {}) {
      const normalized = normalizeLocale(next);
      const changed = normalized !== locale;
      locale = normalized;
      if (persist && changed) persistLocale(storage, normalized);
      if (documentLang) syncDocumentLang(normalized);
      if (changed) {
        for (const listener of [...listeners]) {
          try {
            listener(normalized);
          } catch {
            // 单个渲染回调失败不能阻断语言切换。
          }
        }
      }
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
  };
  return api;
}

const defaultI18n = createI18n();

export const getLocale = defaultI18n.getLocale;
export const setLocale = defaultI18n.setLocale;
export const t = defaultI18n.t;
export const onLocaleChange = defaultI18n.onLocaleChange;
export const formatDate = defaultI18n.formatDate;
export const formatTime = defaultI18n.formatTime;
export const formatDateTime = defaultI18n.formatDateTime;
export const formatExpiry = defaultI18n.formatExpiry;

export function applyStaticI18n(root = globalThis.document) {
  return defaultI18n.applyStaticI18n(root);
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
 */
export function languageSettingsRowHtml({
  ready = isI18nReady(),
  locale = getLocale(),
  translate = t,
} = {}) {
  if (!ready) return '';
  const current = normalizeLocale(locale);
  const options = SUPPORTED_LOCALES.map((code) => (
    `<option value="${code}"${code === current ? ' selected' : ''}>${escapeHtml(translate(`locale.${code}`))}</option>`
  )).join('');
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
