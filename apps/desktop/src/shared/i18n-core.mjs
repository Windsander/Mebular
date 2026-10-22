// Desktop 壳层 i18n 最小运行时（纯函数，无 node / DOM 依赖）。
//
// 唯一真源仍是 locales/manifest.json + locales/<locale>/desktop.json：
// - 主进程用 main/i18n.mjs 从磁盘读 pack，构造 translator；
// - 渲染层（向导 / 退出确认）通过 preload 的 locale:get 拿到同一份 catalogs，
//   用这里同一套 createTranslator 构造 translator，避免运行时中文替换表。
// - 缺 key 回退 key（不返回空字符串）；fallback 链：请求 locale → manifest.fallbackLocale → defaultLocale。

export const DEFAULT_LOCALE = 'zh-CN';
export const FALLBACK_LOCALE = 'zh-CN';

function normalizeTag(raw) {
  return String(raw ?? '').trim().toLowerCase().replaceAll('_', '-');
}

function codeOf(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object') {
    if (typeof entry.locale === 'string') return entry.locale.trim();
    if (typeof entry.code === 'string') return entry.code.trim();
  }
  return '';
}

/**
 * registry 支持三种形态（均为数据层驱动，不内置语言白名单）：
 * - `string[]` / manifest.locales
 * - `{ supportedLocales: string[] }`
 * - `{ locales: [{ locale }], defaultLocale?, fallbackLocale? }`
 */
function registeredLocales(registry) {
  const source = registry?.supportedLocales ?? registry?.locales ?? registry;
  const list = Array.isArray(source) ? source : [];
  return [...new Set(list.map(codeOf).filter(Boolean))];
}

function registryDefault(registry, list) {
  const requested = !Array.isArray(registry) && typeof registry?.defaultLocale === 'string'
    ? registry.defaultLocale
    : null;
  if (requested) {
    const exact = list.find((code) => normalizeTag(code) === normalizeTag(requested));
    if (exact) return exact;
  }
  const zh = list.find((code) => normalizeTag(code) === 'zh-cn');
  if (zh) return zh;
  if (list.length > 0) return list[0];
  return requested ?? DEFAULT_LOCALE;
}

/**
 * BCP-47 归一化：在 manifest / supportedLocales 注册表内做
 * 精确匹配 → 同语言地区匹配 → 同语言首个 → manifest.defaultLocale。
 * 未知 / 空才回落到 manifest.defaultLocale（无 manifest 时 zh-CN）。
 * 支持任意已注册语言（如 ja-JP）；`en` / `en-US` 仅在注册表包含 en-US 时命中，不再硬编码。
 */
export function normalizeDesktopLocale(raw, registry = null) {
  const list = registeredLocales(registry);
  const fallback = registryDefault(registry, list);
  const tag = normalizeTag(raw);
  if (list.length === 0) return fallback;
  if (!tag) return fallback;

  const exact = list.find((code) => normalizeTag(code) === tag);
  if (exact) return exact;

  const [language, region] = tag.split('-');
  const sameLanguage = list.filter((code) => normalizeTag(code).split('-')[0] === language);
  if (sameLanguage.length === 0) return fallback;
  if (region) {
    const sameRegion = sameLanguage.find((code) => normalizeTag(code).split('-')[1] === region);
    if (sameRegion) return sameRegion;
  }
  return sameLanguage[0];
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
 * 语言集合 / 默认 / 回退全部来自 manifest 驱动参数；locale 传 null 时使用 defaultLocale。
 * @param {object} options
 * @param {Record<string, Record<string, string>>} options.catalogs
 * @param {string|null} [options.locale]
 * @param {string} [options.fallbackLocale]
 * @param {string} [options.defaultLocale]
 * @param {string[]} [options.supportedLocales]
 */
export function createTranslator({
  catalogs = {},
  locale = null,
  fallbackLocale = null,
  defaultLocale = null,
  supportedLocales = null,
} = {}) {
  const listed = Array.isArray(supportedLocales) && supportedLocales.length > 0
    ? supportedLocales.map(codeOf).filter(Boolean)
    : Object.keys(catalogs ?? {}).map(codeOf).filter(Boolean);
  const registry = { supportedLocales: listed, defaultLocale };
  const base = normalizeDesktopLocale(defaultLocale, registry);
  const fallback = normalizeDesktopLocale(fallbackLocale ?? base, registry);
  const supported = [...new Set(listed.map((code) => normalizeDesktopLocale(code, registry)))];
  let current = normalizeDesktopLocale(locale, registry);
  const chain = (code) => [...new Set([normalizeDesktopLocale(code, registry), fallback, base])];

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
    get defaultLocale() { return base; },
    get fallbackLocale() { return fallback; },
    setLocale(next) {
      current = normalizeDesktopLocale(next, registry);
      return current;
    },
    t: translate,
    has: (key) => lookup(key) !== null,
    /** 渲染层需要的 catalogs 快照（仅文案，无用户数据）。 */
    getCatalog(code = current) {
      return { ...(catalogs?.[normalizeDesktopLocale(code, registry)] ?? {}) };
    },
    exportCatalogs() {
      const out = {};
      for (const code of supported) out[code] = { ...(catalogs?.[code] ?? {}) };
      return out;
    },
    hasCatalog(code = current) {
      return Object.keys(catalogs?.[normalizeDesktopLocale(code, registry)] ?? {}).length > 0;
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
