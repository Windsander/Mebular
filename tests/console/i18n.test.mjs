// i18n foundation 单测（纯逻辑，无浏览器）：
//   locale 归一化 / 解析优先级 / 持久化 / 事件、插值 / 缺 key、静态 data-i18n*、
//   日期时间随 locale、语言行结构 / 就绪开关、设置页接线（在常驻运行之前、无 reload）。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  createI18n,
  normalizeLocale,
  resolveLocale,
  interpolate,
  isI18nReady,
  languageSettingsRowHtml,
} from '../../packages/console/i18n.mjs';
import { IPC_CHANNELS, sanitizeArgs } from '../../apps/desktop/src/main/ipc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const consoleDir = join(here, '..', '..', 'packages', 'console');
const consoleJs = readFileSync(join(consoleDir, 'console.js'), 'utf-8');
const indexHtml = readFileSync(join(consoleDir, 'index.html'), 'utf-8');

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    writes: [],
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, value); this.writes.push([key, value]); },
  };
}

function fakeElement(attributes = {}) {
  const attrs = { ...attributes };
  return {
    attrs,
    textContent: '',
    placeholder: '',
    getAttribute(name) { return attrs[name] ?? null; },
    setAttribute(name, value) { attrs[name] = value; },
  };
}

function fakeRoot() {
  return {
    title: '',
    nodes: {
      '[data-i18n]': [fakeElement({ 'data-i18n': 'settings.language' })],
      '[data-i18n-title]': [fakeElement({ 'data-i18n-title': 'topbar.settings' })],
      '[data-i18n-placeholder]': [fakeElement({ 'data-i18n-placeholder': 'settings.language.aria' })],
      '[data-i18n-aria-label]': [fakeElement({ 'data-i18n-aria-label': 'settings.language.aria' })],
    },
    querySelectorAll(selector) { return this.nodes[selector] ?? []; },
  };
}

describe('i18n foundation · locale', () => {
  it('normalizeLocale：en* → en-US，zh* → zh-CN，未知 / 空 → zh-CN', () => {
    expect(SUPPORTED_LOCALES).toEqual(['zh-CN', 'en-US']);
    expect(DEFAULT_LOCALE).toBe('zh-CN');
    for (const raw of ['en', 'en-US', 'en-GB', 'EN_us', ' en-AU ']) {
      expect(normalizeLocale(raw)).toBe('en-US');
    }
    for (const raw of ['zh', 'zh-CN', 'zh-Hant-TW', 'ZH_hans', null, undefined, '']) {
      expect(normalizeLocale(raw)).toBe('zh-CN');
    }
    expect(normalizeLocale('fr-FR')).toBe('zh-CN');
    expect(normalizeLocale('ja')).toBe('zh-CN');
  });

  it('解析优先级：?lang= > localStorage > navigator.languages > zh-CN', () => {
    const storage = memoryStorage({ [LOCALE_STORAGE_KEY]: 'en-US' });
    expect(resolveLocale({ search: '?lang=zh-CN', storage, languages: ['en-US'] })).toBe('zh-CN');
    expect(resolveLocale({ search: '?lang=fr-FR', storage, languages: ['en-US'] })).toBe('zh-CN');
    expect(resolveLocale({ search: '', storage, languages: ['zh-CN'] })).toBe('en-US');
    // 未知系统语言不会截断列表，后续 en-US 仍能命中
    expect(resolveLocale({ languages: ['fr-FR', 'en-GB'] })).toBe('en-US');
    expect(resolveLocale({ languages: ['de-DE'] })).toBe('zh-CN');
  });

  it('setLocale 持久化到 mebular.locale；persist=false 不写；变化才触发回调', () => {
    const storage = memoryStorage();
    const i18n = createI18n({ storage, search: '', languages: ['zh-CN'] });
    const seen = [];
    const off = i18n.onLocaleChange((locale) => seen.push(locale));

    expect(i18n.getLocale()).toBe('zh-CN');
    expect(i18n.setLocale('en-GB')).toBe('en-US');
    expect(i18n.getLocale()).toBe('en-US');
    expect(storage.data.get(LOCALE_STORAGE_KEY)).toBe('en-US');
    expect(storage.writes).toEqual([[LOCALE_STORAGE_KEY, 'en-US']]);

    i18n.setLocale('en-US');
    expect(seen).toEqual(['en-US']);

    i18n.setLocale('zh-CN', { persist: false });
    expect(seen).toEqual(['en-US', 'zh-CN']);
    expect(storage.writes).toHaveLength(1);

    off();
    i18n.setLocale('en-US');
    expect(seen).toEqual(['en-US', 'zh-CN']);
  });

  it('setLocale 立即同步 document.documentElement.lang（不 reload）', () => {
    const previousDocument = globalThis.document;
    globalThis.document = { documentElement: { lang: '' } };
    try {
      const i18n = createI18n({ storage: memoryStorage(), search: '', languages: ['zh-CN'] });
      expect(globalThis.document.documentElement.lang).toBe('zh-CN');
      i18n.setLocale('en-US');
      expect(globalThis.document.documentElement.lang).toBe('en-US');
      i18n.setLocale('zh-CN');
      expect(globalThis.document.documentElement.lang).toBe('zh-CN');
    } finally {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    }
  });
});

describe('i18n foundation · 文案与静态属性', () => {
  it('t() 插值替换已知变量；缺 key 回退 key，不返回空字符串', () => {
    const i18n = createI18n({ search: '', languages: ['zh-CN'], onMissing: () => {} });
    expect(i18n.t('settings.language.current', { language: 'English' })).toBe('当前语言：English');
    expect(i18n.t('settings.language.current')).toContain('{language}');
    expect(i18n.t('__missing_key__')).toBe('__missing_key__');
    expect(i18n.t('__missing_key__')).not.toBe('');
    expect(interpolate('a {x} b {unknown}', { x: 1 })).toBe('a 1 b {unknown}');
  });

  it('applyStaticI18n 处理 data-i18n / title / placeholder / aria-label', () => {
    const i18n = createI18n({ search: '?lang=en-US', languages: ['zh-CN'] });
    const root = fakeRoot();
    expect(i18n.applyStaticI18n(root)).toBe(4);
    expect(root.nodes['[data-i18n]'][0].textContent).toBe('Language');
    expect(root.nodes['[data-i18n-title]'][0].attrs.title).toBe('Settings');
    expect(root.nodes['[data-i18n-placeholder]'][0].placeholder).toBe('Interface language');
    expect(root.nodes['[data-i18n-placeholder]'][0].attrs.placeholder).toBe('Interface language');
    expect(root.nodes['[data-i18n-aria-label]'][0].attrs['aria-label']).toBe('Interface language');
  });

  it('日期 / 时间 / 日期时间使用当前 locale 的 Intl.DateTimeFormat', () => {
    const date = new Date(2024, 0, 2, 18, 34, 56);
    const zh = createI18n({ search: '?lang=zh-CN', languages: [] });
    const en = createI18n({ search: '?lang=en-US', languages: [] });
    expect(zh.formatDate(date)).toBe(new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date));
    expect(en.formatDate(date)).toBe(new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date));
    expect(zh.formatTime(date)).toBe(new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date));
    expect(en.formatTime(date)).toBe(new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date));
    expect(zh.formatDateTime(date)).not.toBe(en.formatDateTime(date));
    expect(zh.formatDate('not-a-date')).toBe('—');
  });

  it('formatExpiry：同一日历日只显示 HH:mm；跨天补日期（按 locale，不硬编码）', () => {
    const now = new Date(2026, 9, 22, 9, 0);
    const sameDay = new Date(2026, 9, 22, 18, 30);
    const nextDay = new Date(2026, 9, 23, 9, 30);
    const zh = createI18n({ search: '?lang=zh-CN', languages: [] });
    const en = createI18n({ search: '?lang=en-US', languages: [] });

    expect(zh.formatExpiry(sameDay, now)).toBe(zh.formatTime(sameDay));
    expect(zh.formatExpiry(sameDay, now)).not.toContain('/');
    expect(zh.formatExpiry(nextDay, now)).toContain('10/23');
    expect(zh.formatExpiry(nextDay, now)).toContain('09:30');
    expect(en.formatExpiry(nextDay, now)).toContain('10/23');
    expect(en.formatExpiry(nextDay, now)).not.toBe(en.formatTime(nextDay));
    expect(zh.formatExpiry('not-a-date', now)).toBe('—');
  });
});

describe('i18n foundation · 语言行与就绪开关', () => {
  it('默认开放；?i18n=1 / ?lang= / 桌面壳显式 i18nReady 仍为 true', () => {
    expect(isI18nReady({ search: '', desktop: null })).toBe(true);
    expect(isI18nReady({ search: '?mock=1', desktop: {} })).toBe(true);
    expect(isI18nReady({ search: '?i18n=1', desktop: null })).toBe(true);
    expect(isI18nReady({ search: '?lang=en-US', desktop: null })).toBe(true);
    expect(isI18nReady({ search: '', desktop: { i18nReady: true } })).toBe(true);
  });

  it('语言行默认可见；显式 ready=false 才隐藏；就绪为单行 select（复用 asst-row，无独立卡片）', () => {
    expect(languageSettingsRowHtml()).toContain('id="settings-language"');
    expect(languageSettingsRowHtml({ ready: false })).toBe('');
    const html = languageSettingsRowHtml({ ready: true, locale: 'zh-CN' });
    expect(html).toContain('id="settings-language"');
    expect(html).toContain('class="asst-row settings-language-row"');
    expect(html.match(/class="asst-row /g)).toHaveLength(1);
    expect(html).not.toContain('settings-section');
    expect(html).not.toContain('<section');
    expect(html).toContain('data-language-select');
    expect(html).toContain('<option value="zh-CN" selected>简体中文</option>');
    expect(html).toContain('<option value="en-US">English</option>');
    expect(html).toContain('data-i18n="settings.language"');

    const en = createI18n({ search: '?lang=en-US', languages: [] });
    const enHtml = languageSettingsRowHtml({ ready: true, locale: en.getLocale(), translate: en.t });
    expect(enHtml).toContain('>Language</span>');
    expect(enHtml).toContain('<option value="en-US" selected>English</option>');
    expect(enHtml).toContain('aria-label="Interface language"');
  });

  it('设置页接线：语言行在 #settings-resident 之前；选择只 setLocale + 重渲染，不 reload', () => {
    const rowAt = consoleJs.indexOf('${languageSettingsRowHtml()}');
    const residentAt = consoleJs.indexOf('<div class="settings-resident" id="settings-resident">');
    expect(rowAt).toBeGreaterThan(-1);
    expect(residentAt).toBeGreaterThan(-1);
    expect(rowAt).toBeLessThan(residentAt);

    expect(consoleJs).toContain("const hasExplicitLocale = Boolean(params.get('lang')?.trim()) || Boolean(localStorage.getItem(LOCALE_STORAGE_KEY));");
    expect(consoleJs).toContain("if (!hasExplicitLocale && getLocale() !== 'zh-CN') setLocale('zh-CN', { persist: false });");
    expect(consoleJs).toContain("setLocale(select.value, { persist: true })");
    expect(consoleJs).toMatch(/onLocaleChange\(\(\) => \{[\s\S]*?applyStaticI18n\(document\)[\s\S]*?render\(\);[\s\S]*?\}\);/);
    expect(consoleJs).not.toMatch(/location\.reload\s*\(/);

    // 设置壳与页签、顶栏/导航都挂了静态 data-i18n 属性。
    for (const key of ['app.brand', 'nav.map', 'settings.title', 'topbar.settings']) {
      expect(indexHtml).toContain(`data-i18n="${key}"`);
    }
  });

  it('默认 zh-CN；?lang=en-US 覆盖并同步 html lang 属性', () => {
    const zh = createI18n({ search: '', languages: ['zh-CN'] });
    const en = createI18n({ search: '?lang=en-US', languages: ['zh-CN'] });
    expect(zh.getLocale()).toBe('zh-CN');
    expect(zh.t('nav.map')).toBe('星图');
    expect(en.getLocale()).toBe('en-US');
    expect(en.t('nav.map')).toBe('Star map');
  });
});

describe('i18n foundation · 桌面壳 locale 预留', () => {
  it('IPC 白名单含 locale:get / locale:set；set 只收 1 个字符串参数', () => {
    expect(IPC_CHANNELS).toEqual(expect.arrayContaining(['locale:get', 'locale:set']));
    expect(sanitizeArgs([], 'locale:get')).toEqual([]);
    expect(sanitizeArgs(['en-GB'], 'locale:set')).toEqual(['en-GB']);
    expect(sanitizeArgs(['en-US', 'EXTRA'], 'locale:set')).toEqual(['en-US']);
  });

  it('preload 暴露固定 getLocale / setLocale / i18nReady（不透传 channel）', () => {
    const preload = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'src', 'preload', 'index.cjs'), 'utf-8');
    expect(preload).toContain("getLocale: () => ipcRenderer.invoke('locale:get')");
    expect(preload).toContain("setLocale: (locale) => ipcRenderer.invoke('locale:set', String(locale ?? ''))");
    expect(preload).toContain('i18nReady: false');
    expect(preload).not.toMatch(/ipcRenderer\.invoke\(\s*channel/);
  });
});
