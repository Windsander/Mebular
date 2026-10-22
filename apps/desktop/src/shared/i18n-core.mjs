// Desktop 壳层 i18n 最小运行时（纯函数，无 node / DOM 依赖）。
//
// 唯一真源仍是 locales/manifest.json + locales/<locale>/desktop.json：
// - 主进程用 main/i18n.mjs 从磁盘读 pack，构造 translator；
// - 渲染层（向导 / 退出确认）通过 preload 的 locale:get 拿到同一份 catalogs，
//   用这里同一套 createTranslator 构造 translator，避免运行时中文替换表。
// - 缺 key 回退 key（不返回空字符串）；fallback 链：请求 locale → manifest.fallbackLocale → defaultLocale。

export const DEFAULT_LOCALE = 'zh-CN';
export const FALLBACK_LOCALE = 'zh-CN';

/** 壳层只开放 manifest 中已登记的语言；未知 / 空一律落到 zh-CN（与既有 locale:get 行为一致）。 */
export function normalizeDesktopLocale(raw) {
  const tag = String(raw ?? '').trim().toLowerCase().replaceAll('_', '-');
  return tag === 'en' || tag.startsWith('en-') ? 'en-US' : DEFAULT_LOCALE;
}

/** 模板插值：只替换传入的 {name}，未知占位符原样保留。 */
export function interpolate(template, vars) {
  if (vars === null || vars === undefined) return String(template);
  return String(template).replaceAll(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  ));
}

/**
 * 从 catalogs（locale → { key: value }）构造 translator。
 * @param {object} options
 * @param {Record<string, Record<string, string>>} options.catalogs
 * @param {string} options.locale
 * @param {string} [options.fallbackLocale]
 * @param {string} [options.defaultLocale]
 * @param {string[]} [options.supportedLocales]
 */
export function createTranslator({
  catalogs = {},
  locale = DEFAULT_LOCALE,
  fallbackLocale = FALLBACK_LOCALE,
  defaultLocale = DEFAULT_LOCALE,
  supportedLocales = null,
} = {}) {
  let current = normalizeDesktopLocale(locale);
  const fallback = normalizeDesktopLocale(fallbackLocale);
  const base = normalizeDesktopLocale(defaultLocale);
  const chain = (code) => [...new Set([normalizeDesktopLocale(code), fallback, base])];
  const supported = Array.isArray(supportedLocales) && supportedLocales.length > 0
    ? [...new Set(supportedLocales.map(normalizeDesktopLocale))]
    : Object.keys(catalogs ?? {}).map(normalizeDesktopLocale);

  const lookup = (key, code = current) => {
    for (const candidate of chain(code)) {
      const value = catalogs?.[candidate]?.[key];
      if (typeof value === 'string') return value;
    }
    return null;
  };

  const translate = (key, vars) => {
    const value = lookup(key);
    return value === null ? String(key) : interpolate(value, vars);
  };
  translate.has = (key) => lookup(key) !== null;

  return {
    get locale() { return current; },
    get supportedLocales() { return [...supported]; },
    setLocale(next) {
      current = normalizeDesktopLocale(next);
      return current;
    },
    t: translate,
    has: (key) => lookup(key) !== null,
    /** 渲染层需要的 catalogs 快照（仅文案，无用户数据）。 */
    getCatalog(code = current) {
      return { ...(catalogs?.[normalizeDesktopLocale(code)] ?? {}) };
    },
    exportCatalogs() {
      const out = {};
      for (const code of supported) out[code] = { ...(catalogs?.[code] ?? {}) };
      return out;
    },
    hasCatalog(code = current) {
      return Object.keys(catalogs?.[normalizeDesktopLocale(code)] ?? {}).length > 0;
    },
  };
}

/**
 * 静态 DOM 文案：data-i18n / data-i18n-title / data-i18n-aria-label / data-i18n-placeholder。
 * 缺 key 不覆盖 HTML 里的中文兜底（避免首帧出现 key）。
 */
export function applyStaticI18nWith(translate, root = globalThis.document) {
  if (!root?.querySelectorAll) return 0;
  let updated = 0;
  const valueFor = (key) => {
    if (typeof translate.has === 'function' && !translate.has(key)) return null;
    const value = translate(key);
    return typeof value === 'string' && value !== key ? value : null;
  };
  const each = (selector, attr, apply) => {
    for (const element of root.querySelectorAll(selector)) {
      const key = element.getAttribute(attr);
      const value = valueFor(key);
      if (value === null) continue;
      apply(element, value);
      updated += 1;
    }
  };
  each('[data-i18n]', 'data-i18n', (element, value) => { element.textContent = value; });
  each('[data-i18n-title]', 'data-i18n-title', (element, value) => { element.setAttribute('title', value); });
  each('[data-i18n-aria-label]', 'data-i18n-aria-label', (element, value) => {
    element.setAttribute('aria-label', value);
  });
  each('[data-i18n-placeholder]', 'data-i18n-placeholder', (element, value) => {
    element.setAttribute('placeholder', value);
  });
  return updated;
}
