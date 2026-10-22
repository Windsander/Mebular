#!/usr/bin/env node
// 控制台 i18n locale pack 校验（确定性 · 离线 · 零依赖）。
//
// 唯一真源：locales/manifest.json + locales/<locale>/*.json。本脚本**不** import
// 任何具体语言模块，避免应用代码与文案数据双真源。
//
// 覆盖：
//   ① manifest 元数据：schemaVersion / defaultLocale / fallbackLocale / locales 注册合法
//   ② manifest 注册的每个 locale / pack 文件均存在、路径不越界
//   ③ pack envelope：schemaVersion / locale / pack 与 manifest 一致，messages 为非空字符串
//   ④ console key 完全对等（无 missing / extra）
//   ⑤ 插值占位符一致
//   ⑥ 非默认语言（en-US）值不含中文（白名单：语言名称自身）
//   ⑦ loader 按 manifest 加载；缺 key 回退 key；fallback 链生效；插值生效
//   ⑧ index.html / console.js / i18n.mjs 的静态 data-i18n 与字面 t() key 均在默认 console pack
//
// 本阶段**不**扫描全仓硬编码中文：文案迁移尚未完成，避免误报。
// 摘要行 I18N_SUMMARY。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createI18n, loadI18n } from '../packages/console/i18n.mjs';
import { loadDesktopI18n } from '../apps/desktop/src/main/i18n.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = join(ROOT, 'locales');
const results = [];
const check = (name, ok, detail = null) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === null ? '' : `  ${JSON.stringify(detail)}`}`);
};

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const readJson = (absolute) => JSON.parse(readFileSync(absolute, 'utf-8'));
const safeRelativePath = (value) => {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
};

// ---------- ① manifest ----------
let manifest = null;
try {
  manifest = readJson(join(LOCALES_DIR, 'manifest.json'));
} catch (error) {
  check('locales/manifest.json 存在且可解析', false, { error: String(error?.message ?? error) });
}

const manifestOk = isObject(manifest)
  && Number.isInteger(manifest.schemaVersion)
  && manifest.schemaVersion >= 1
  && typeof manifest.defaultLocale === 'string'
  && typeof manifest.fallbackLocale === 'string'
  && Array.isArray(manifest.locales)
  && manifest.locales.length > 0
  && Array.isArray(manifest.packs);
check('manifest 元数据完整（schemaVersion / defaultLocale / fallbackLocale / locales / packs）',
  Boolean(manifestOk), manifestOk ? {
    schemaVersion: manifest.schemaVersion,
    defaultLocale: manifest.defaultLocale,
    fallbackLocale: manifest.fallbackLocale,
    packs: manifest.packs,
  } : { manifest });

const locales = manifestOk ? manifest.locales : [];
const codes = locales.map((entry) => entry?.locale);
const uniqueCodes = new Set(codes);
const registered = uniqueCodes;
const localeEntriesOk = locales.every((entry) => isObject(entry)
  && typeof entry.locale === 'string' && entry.locale.trim().length > 0
  && typeof entry.nativeName === 'string' && entry.nativeName.trim().length > 0
  && isObject(entry.files)
  && manifest.packs.every((pack) => safeRelativePath(entry.files[pack])));
check('manifest locale 条目合法（code / nativeName / pack 路径）',
  localeEntriesOk && uniqueCodes.size === locales.length, {
    duplicate: codes.filter((code, index) => codes.indexOf(code) !== index),
  });
check('defaultLocale / fallbackLocale 均已注册',
  registered.has(manifest?.defaultLocale) && registered.has(manifest?.fallbackLocale),
  { defaultLocale: manifest?.defaultLocale, fallbackLocale: manifest?.fallbackLocale, locales: [...registered] });

// ---------- ② / ③ 文件与 envelope ----------
const packs = new Map(); // `${locale}/${pack}` -> messages
const missingFiles = [];
const badEnvelopes = [];
const badValues = [];
const packFileKeys = new Set();
for (const entry of locales) {
  if (!isObject(entry) || !isObject(entry.files)) continue;
  const fileKeys = Object.keys(entry.files).sort();
  packFileKeys.add(fileKeys.join(','));
  for (const pack of manifest.packs) {
    const relative = entry.files[pack];
    if (!safeRelativePath(relative)) {
      missingFiles.push({ locale: entry.locale, pack, relative, reason: 'unsafe path' });
      continue;
    }
    const absolute = join(LOCALES_DIR, relative);
    if (!existsSync(absolute)) {
      missingFiles.push({ locale: entry.locale, pack, relative, reason: 'missing' });
      continue;
    }
    let json;
    try {
      json = readJson(absolute);
    } catch (error) {
      badEnvelopes.push({ locale: entry.locale, pack, relative, error: String(error?.message ?? error) });
      continue;
    }
    if (!isObject(json)
      || json.schemaVersion !== manifest.schemaVersion
      || json.locale !== entry.locale
      || json.pack !== pack
      || !isObject(json.messages)) {
      badEnvelopes.push({ locale: entry.locale, pack, relative });
      continue;
    }
    packs.set(`${entry.locale}/${pack}`, json.messages);
    for (const [key, value] of Object.entries(json.messages)) {
      if (typeof value !== 'string' || value.trim() === '') {
        badValues.push({ locale: entry.locale, pack, key, value });
      }
    }
  }
}
check('manifest 注册的 locale 文件均存在（无越界路径）', missingFiles.length === 0, { missing: missingFiles });
check('pack envelope 与 manifest 一致（schemaVersion / locale / pack / messages）',
  badEnvelopes.length === 0, { bad: badEnvelopes });
check('所有 pack 的 message 均为非空字符串', badValues.length === 0, { bad: badValues });
check('每个 locale 的 pack 文件集合一致', packFileKeys.size <= 1, [...packFileKeys]);

const defaultCode = manifest?.defaultLocale ?? 'zh-CN';
const defaultMessages = packs.get(`${defaultCode}/console`) ?? {};
const defaultKeys = Object.keys(defaultMessages);

// ---------- ④ / ⑤ / ⑥ 对等与占位符 ----------
const parity = [];
const placeholderMismatch = [];
const placeholders = (value) => [...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)]
  .map((match) => match[1])
  .sort()
  .join(',');
for (const entry of locales) {
  if (!isObject(entry) || entry.locale === defaultCode) continue;
  const messages = packs.get(`${entry.locale}/console`) ?? {};
  const keys = Object.keys(messages);
  const missing = defaultKeys.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !defaultKeys.includes(key));
  if (missing.length > 0 || extra.length > 0) parity.push({ locale: entry.locale, missing, extra });
  for (const key of defaultKeys) {
    if (!(key in messages)) continue;
    if (placeholders(defaultMessages[key]) !== placeholders(messages[key])) {
      placeholderMismatch.push({
        locale: entry.locale,
        key,
        expected: placeholders(defaultMessages[key]),
        actual: placeholders(messages[key]),
      });
    }
  }
}
check('console key 完全对等（所有 locale vs default）', parity.length === 0, { mismatch: parity });
check('console 插值占位符一致', placeholderMismatch.length === 0, { mismatch: placeholderMismatch });

// en-US 只允许语言名称一项含中文（简体中文必须用中文书写，否则用户认不出该选项）。
const CJK = /[\u3400-\u9fff]/;
const ALLOWED_CJK_KEYS = new Set(['locale.zh-CN']);
const cjk = [];
for (const entry of locales) {
  if (!isObject(entry) || entry.locale === defaultCode) continue;
  const messages = packs.get(`${entry.locale}/console`) ?? {};
  for (const [key, value] of Object.entries(messages)) {
    if (CJK.test(value) && !ALLOWED_CJK_KEYS.has(key)) {
      cjk.push({ locale: entry.locale, key, value });
    }
  }
}
check('非默认语言值不含中文（白名单 locale.zh-CN）', cjk.length === 0, { cjk });

// ---------- ⑦ loader ----------
const catalogs = Object.fromEntries(locales.map((entry) => [
  entry.locale,
  packs.get(`${entry.locale}/console`) ?? {},
]));
const loaded = await loadI18n({
  manifest,
  catalogs,
  search: '',
  storage: null,
  languages: [defaultCode],
  documentLang: false,
  onMissing: () => {},
});
check('loader 按 manifest 注册全部 locale',
  loaded.supportedLocales.length === locales.length
    && locales.every((entry) => loaded.supportedLocales.includes(entry.locale))
    && loaded.ready === true,
  { supported: loaded.supportedLocales, ready: loaded.ready, errors: loaded.errors.length });

const missingProbe = '__i18n_missing_key_probe__';
check('t() 缺 key 回退 key（不静默空字符串）',
  loaded.i18n.t(missingProbe) === missingProbe, { fallback: loaded.i18n.t(missingProbe) });
check('t() 插值生效',
  loaded.i18n.t('settings.language.current', { language: 'English' }).includes('English')
    && !loaded.i18n.t('settings.language.current', { language: 'English' }).includes('{language}'), {});

// fallback 链：目标语言缺 key 时回退 manifest.fallbackLocale（默认 zh-CN）。
const fallbackCode = manifest?.fallbackLocale ?? defaultCode;
const probeLocale = locales.find((entry) => entry.locale !== defaultCode)?.locale ?? null;
const probeMessages = probeLocale ? { ...(packs.get(`${probeLocale}/console`) ?? {}) } : null;
const fallbackKey = probeMessages ? Object.keys(probeMessages)[0] : null;
if (probeMessages && fallbackKey) delete probeMessages[fallbackKey];
const fallbackI18n = probeLocale && fallbackKey
  ? createI18n({
    manifest,
    catalogs: { ...catalogs, [probeLocale]: probeMessages },
    search: `?lang=${encodeURIComponent(probeLocale)}`,
    languages: [],
    documentLang: false,
    onMissing: () => {},
  })
  : null;
check('fallback 链：目标语言缺 key 时回退默认语言',
  Boolean(fallbackI18n) && fallbackI18n.t(fallbackKey) === defaultMessages[fallbackKey],
  { locale: probeLocale, key: fallbackKey, expected: defaultMessages[fallbackKey], actual: fallbackI18n?.t(fallbackKey) });

// ---------- ⑧ 静态引用 ----------
const referenced = new Set();
const files = ['packages/console/index.html', 'packages/console/console.js', 'packages/console/i18n.mjs'];
for (const relative of files) {
  const source = readFileSync(join(ROOT, relative), 'utf-8');
  for (const match of source.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g)) {
    referenced.add(match[1]);
  }
  for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) {
    referenced.add(match[1]);
  }
  for (const match of source.matchAll(/\btranslate\(\s*'([^']+)'/g)) {
    referenced.add(match[1]);
  }
}
const unknownKeys = [...referenced].filter((key) => !defaultKeys.includes(key) && !key.includes('${'));
check('静态 data-i18n / 字面 t() key 均在默认 console pack 内',
  unknownKeys.length === 0, { unknown: unknownKeys });

// ---------- ⑨ 本批主路径覆盖（顶栏/导航/锁定/新建/加入/邀请/向导） ----------
const PATH_KEY_PREFIXES = [
  'topbar.cloud.', 'topbar.self.', 'topbar.online.', 'topbar.memory.', 'topbar.security.',
  'topbar.pendingRestart', 'nav.lockedHint', 'lock.', 'stage.', 'legend.',
  'onboard.coach.', 'onboard.create.', 'onboard.join.', 'onboard.error.',
  'cloudJoin.', 'cloudSwitch.', 'invite.', 'wizard.',
];
const inPath = (key) => PATH_KEY_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix));
const missingPathPrefixes = PATH_KEY_PREFIXES.filter((prefix) => (
  !defaultKeys.some((key) => key === prefix || key.startsWith(prefix))
));
check('主路径 key 组完整（顶栏/导航/锁定/新建/加入/邀请/向导）',
  missingPathPrefixes.length === 0, { missing: missingPathPrefixes });

const REQUIRED_PATH_STATIC_KEYS = [
  'topbar.cloud.openSettings', 'topbar.self.openAbout', 'topbar.self.placeholder',
  'topbar.online.unknown', 'topbar.security.none', 'topbar.security.view', 'topbar.memory.placeholder',
  'legend.title', 'legend.edges', 'legend.edge.mine', 'legend.edge.theirs', 'legend.edge.offline',
  'legend.edge.revoked', 'legend.note', 'stage.aria',
  'wizard.aria', 'wizard.title', 'wizard.close', 'wizard.back', 'wizard.next',
  'invite.aria', 'invite.title', 'invite.closeAria',
  'cloudJoin.title', 'cloudJoin.lead', 'cloudJoin.tokenLabel', 'cloudJoin.tokenPlaceholder',
  'cloudJoin.nameLabel', 'cloudJoin.namePlaceholder', 'cloudJoin.cancel', 'cloudJoin.submit',
  'cloudJoin.closeAria', 'cloudSwitch.titleStatic',
  'onboard.coach.title', 'onboard.coach.bodyBefore', 'onboard.coach.bodyCreate', 'onboard.coach.bodyOr',
  'onboard.coach.bodyJoin', 'onboard.coach.bodyAfter', 'onboard.coach.create', 'onboard.coach.join',
  'onboard.coach.dismiss', 'onboard.coach.closeTitle',
  'onboard.create.title', 'onboard.create.tag', 'onboard.create.desc', 'onboard.create.cloudLabel',
  'onboard.create.cloudPlaceholder', 'onboard.create.deviceLabel', 'onboard.create.devicePlaceholder',
  'onboard.create.submit', 'onboard.create.closeAria',
  'onboard.join.title', 'onboard.join.lead', 'onboard.join.deviceLabel', 'onboard.join.tokenLabel',
  'onboard.join.devicePlaceholder', 'onboard.join.tokenPlaceholder', 'onboard.join.submit',
  'onboard.join.closeAria', 'common.required',
];
const missingPathStatic = REQUIRED_PATH_STATIC_KEYS.filter((key) => !referenced.has(key));
check('主路径静态 DOM 已挂 data-i18n（顶栏/锁定/新建/加入/邀请/向导）',
  missingPathStatic.length === 0, { missing: missingPathStatic });

const REQUIRED_RUNTIME_PATH_KEYS = [
  'wizard.step.local', 'wizard.step.connect',
  'security.level.low', 'security.level.medium', 'security.level.high',
  'cloud.error.tokenRequired', 'cloud.error.tokenInvalid', 'cloud.error.tokenExpired',
  'cloud.error.tokenRejected', 'cloud.error.confirmationRequired', 'cloud.error.invalidName',
  'cloud.error.nameTaken', 'cloud.error.cloudArchived', 'cloud.error.cloudBlocked',
  'cloud.error.profileNotFound', 'cloud.error.profileJoinFailed', 'cloud.error.endpointUnreachable',
  'cloud.error.cloudAlreadyJoined', 'cloud.error.cloudDisabled', 'cloud.error.cloudUnavailable',
  'cloud.error.cloudUnsupported', 'cloud.error.cloudListFailed', 'cloud.error.cloudRegistryInvalid',
  'cloud.error.cloudRegistryLocked', 'cloud.error.cloudProfilePathInvalid',
  'onboard.error.failed', 'onboard.error.failedFallback', 'onboard.error.invalidName',
  'onboard.error.tokenInvalid', 'onboard.error.tokenExpired', 'onboard.error.tokenRejected',
  'onboard.error.endpointUnreachable', 'onboard.error.notInitialized',
];
const missingRuntimePath = REQUIRED_RUNTIME_PATH_KEYS.filter((key) => !defaultKeys.includes(key));
check('主路径动态 key 完整（安全等级 / 云错误 / 引导错误 / 向导步骤）',
  missingRuntimePath.length === 0, { missing: missingRuntimePath });

const englishMessages = packs.get('en-US/console') ?? {};
const missingPathEnglish = defaultKeys.filter((key) => inPath(key) && typeof englishMessages[key] !== 'string');
const pathCjk = Object.entries(englishMessages)
  .filter(([key, value]) => inPath(key) && CJK.test(value))
  .map(([key, value]) => ({ key, value }));
check('主路径英文 key 完整且无中文兜底（en-US）',
  missingPathEnglish.length === 0 && pathCjk.length === 0,
  { missing: missingPathEnglish, cjk: pathCjk });

// ---------- ⑩ Desktop 壳层 pack（tray / quit / wizard / loading / 主进程对话框） ----------
const desktopDefault = packs.get(`${defaultCode}/desktop`) ?? {};
const desktopKeys = Object.keys(desktopDefault);
check('desktop pack 非空（zh-CN 默认）', desktopKeys.length > 0, { keys: desktopKeys.length });

const desktopParity = [];
const desktopPlaceholderMismatch = [];
const desktopCjk = [];
for (const entry of locales) {
  if (!isObject(entry) || entry.locale === defaultCode) continue;
  const messages = packs.get(`${entry.locale}/desktop`) ?? {};
  const keys = Object.keys(messages);
  const missing = desktopKeys.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !desktopKeys.includes(key));
  if (missing.length > 0 || extra.length > 0) desktopParity.push({ locale: entry.locale, missing, extra });
  for (const key of desktopKeys) {
    if (!(key in messages)) continue;
    if (placeholders(desktopDefault[key]) !== placeholders(messages[key])) {
      desktopPlaceholderMismatch.push({
        locale: entry.locale,
        key,
        expected: placeholders(desktopDefault[key]),
        actual: placeholders(messages[key]),
      });
    }
    if (entry.locale === 'en-US' && CJK.test(messages[key])) desktopCjk.push({ key, value: messages[key] });
  }
}
check('desktop key 完全对等（所有 locale vs zh-CN）', desktopParity.length === 0, { mismatch: desktopParity });
check('desktop 插值占位符一致', desktopPlaceholderMismatch.length === 0, { mismatch: desktopPlaceholderMismatch });
check('desktop 非默认语言值不含中文（en-US）', desktopCjk.length === 0, { cjk: desktopCjk });

const DESKTOP_PATH_PREFIXES = [
  'app.', 'loading.', 'startup.', 'tray.', 'quit.', 'stop.', 'restart.', 'wizard.',
];
const missingDesktopPrefixes = DESKTOP_PATH_PREFIXES.filter((prefix) => (
  !desktopKeys.some((key) => key.startsWith(prefix))
));
check('desktop 主路径 key 组完整（窗口/加载/托盘/退出/停止/重启/向导）',
  missingDesktopPrefixes.length === 0, { missing: missingDesktopPrefixes });

// 静态引用：wizard.html 的 data-i18n + 渲染层/主进程字面 t('key')。
const desktopReferenced = new Set();
const desktopStaticFiles = [
  'apps/desktop/src/renderer/wizard.html',
  'apps/desktop/src/renderer/wizard.js',
  'apps/desktop/src/renderer/wizard-view.mjs',
  'apps/desktop/src/main/index.mjs',
  'apps/desktop/src/main/lifecycle.mjs',
];
for (const relative of desktopStaticFiles) {
  const source = readFileSync(join(ROOT, relative), 'utf-8');
  for (const match of source.matchAll(/data-i18n(?:-title|-aria-label|-placeholder)?="([^"]+)"/g)) {
    desktopReferenced.add(match[1]);
  }
  for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) {
    desktopReferenced.add(match[1]);
  }
}
const unknownDesktopKeys = [...desktopReferenced].filter((key) => !desktopKeys.includes(key));
check('desktop 静态 data-i18n / 字面 t() key 均在默认 desktop pack 内',
  unknownDesktopKeys.length === 0, { unknown: unknownDesktopKeys });

const desktopZh = loadDesktopI18n({ localesDir: LOCALES_DIR, locale: 'zh-CN' });
const desktopEn = loadDesktopI18n({ localesDir: LOCALES_DIR, locale: 'en-US' });
check('desktop loader：zh/en 按 manifest 加载且插值生效',
  desktopZh.locale === 'zh-CN'
    && desktopEn.locale === 'en-US'
    && desktopZh.t('tray.menu.quit') === '退出 Mebular'
    && desktopEn.t('tray.menu.quit') === 'Quit Mebular'
    && desktopZh.t('wizard.badge.step', { current: 1, total: 2, name: 'x' }).includes('/2'),
  { zh: desktopZh.t('tray.menu.quit'), en: desktopEn.t('tray.menu.quit') });
check('desktop t() 缺 key 回退 key（不返回空字符串）',
  desktopEn.t('__desktop_missing_key_probe__') === '__desktop_missing_key_probe__', {});

const failed = results.filter((result) => !result.ok);
console.log('== check:i18n ==');
console.log(`I18N_SUMMARY ${JSON.stringify({
  locales: [...registered],
  defaultLocale: defaultCode,
  fallbackLocale: fallbackCode,
  packs: manifest?.packs ?? [],
  keys: defaultKeys.length,
  desktopKeys: desktopKeys.length,
  checks: results.length,
  failed: failed.map((result) => result.name),
})}`);
process.exit(failed.length === 0 ? 0 : 1);
