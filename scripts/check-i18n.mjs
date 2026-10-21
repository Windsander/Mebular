#!/usr/bin/env node
// 控制台 i18n foundation 校验（确定性 · 离线 · 零依赖）。
//
// 覆盖：
//   ① zh-CN / en-US key 完全一致（无 missing / extra）
//   ② 两个 locale 的 {placeholder} 集合一致
//   ③ en-US 值不含中文（白名单：语言名称自身的 zh-CN 写法）
//   ④ 值不静默为空；t() 缺 key 回退 key（不是空字符串）
//   ⑤ index.html / console.js 里 data-i18n* 与字面 t('key') 均在 catalog 内
//
// 本阶段**不**扫描全仓硬编码中文：文案迁移尚未完成，避免误报。
// 摘要行 I18N_SUMMARY。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zhCN from '../packages/console/messages/zh-CN.mjs';
import enUS from '../packages/console/messages/en-US.mjs';
import { SUPPORTED_LOCALES, createI18n } from '../packages/console/i18n.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = null) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === null ? '' : `  ${JSON.stringify(detail)}`}`);
};

const ZH = new Set(Object.keys(zhCN));
const EN = new Set(Object.keys(enUS));
const missing = [...ZH].filter((key) => !EN.has(key));
const extra = [...EN].filter((key) => !ZH.has(key));
check('zh-CN / en-US key 完全一致', missing.length === 0 && extra.length === 0, { missing, extra });

const placeholders = (value) => [...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)]
  .map((match) => match[1])
  .sort()
  .join(',');
const placeholderMismatch = [...ZH]
  .filter((key) => EN.has(key) && placeholders(zhCN[key]) !== placeholders(enUS[key]))
  .map((key) => ({
    key,
    zh: placeholders(zhCN[key]),
    en: placeholders(enUS[key]),
  }));
check('插值占位符一致', placeholderMismatch.length === 0, { mismatch: placeholderMismatch });

const empty = [...ZH].filter((key) => typeof zhCN[key] !== 'string' || zhCN[key].trim() === '')
  .concat([...EN].filter((key) => typeof enUS[key] !== 'string' || enUS[key].trim() === ''));
check('catalog 值均为非空字符串', empty.length === 0, { empty });

// en-US 只允许语言名称一项含中文（简体中文必须用中文书写，否则用户认不出该选项）。
const CJK = /[\u3400-\u9fff]/;
const ALLOWED_CJK_KEYS = new Set(['locale.zh-CN']);
const cjk = Object.entries(enUS)
  .filter(([key, value]) => CJK.test(value) && !ALLOWED_CJK_KEYS.has(key))
  .map(([key, value]) => ({ key, value }));
check('en-US 值不含中文（白名单 locale.zh-CN）', cjk.length === 0, { cjk });

const missingProbe = '__i18n_missing_key_probe__';
// 校验脚本不依赖宿主系统语言：固定 zh-CN，并静默缺 key 探针。
const i18n = createI18n({ search: '', languages: ['zh-CN'], storage: null, onMissing: () => {} });
check('t() 缺 key 回退 key（不静默空字符串）', i18n.t(missingProbe) === missingProbe, { fallback: i18n.t(missingProbe) });
check('t() 插值生效', i18n.t('settings.language.current', { language: 'English' }).includes('English')
  && !i18n.t('settings.language.current', { language: 'English' }).includes('{language}'), {});

check('SUPPORTED_LOCALES 与 catalog 对齐', SUPPORTED_LOCALES.length === 2
  && SUPPORTED_LOCALES.includes('zh-CN') && SUPPORTED_LOCALES.includes('en-US'), { locales: SUPPORTED_LOCALES });

// 静态属性 / 字面 t() 引用必须落在 catalog 内（只查 foundation 会用到的地方）。
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
const unknownKeys = [...referenced].filter((key) => !ZH.has(key) && !key.includes('${'));
check('静态 data-i18n / 字面 t() key 均在 catalog 内', unknownKeys.length === 0, { unknown: unknownKeys });

const failed = results.filter((result) => !result.ok);
console.log('== check:i18n ==');
console.log(`I18N_SUMMARY ${JSON.stringify({
  locales: [...SUPPORTED_LOCALES],
  keys: ZH.size,
  checks: results.length,
  failed: failed.map((result) => result.name),
})}`);
process.exit(failed.length === 0 ? 0 : 1);
