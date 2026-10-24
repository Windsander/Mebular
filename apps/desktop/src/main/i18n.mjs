// Desktop 主进程 locale pack 加载器（只读 locales/ 数据层，不 import electron）。
//
// 路径优先级：
//   ① MEBULAR_LOCALES_DIR（测试 / 自定义分发）
//   ② <resources>/locales（旧 M1 布局：electron-builder extraResources）
//   ③ <resources>/node_modules/@mebular/core/locales（R1 发布 runtime）
//   ④ 仓库根 locales/（开发态：apps/desktop/src/main → ../../../..）
//
// 只读取 manifest 注册的 desktop pack；文件缺失 / 解析失败不抛异常，
// 返回空 catalog（translator 回退 key，界面仍有 wizard.html 静态中文兜底）。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTranslator, normalizeDesktopLocale,
} from '../shared/i18n-core.mjs';

export const DESKTOP_PACK = 'desktop';
export const ERRORS_PACK = 'errors';

/** 解析 locales 根目录（确定性；不依赖 cwd）。 */
export function resolveLocalesDir({
  env = process.env,
  moduleDir = import.meta.dirname,
  resourcesPath = process.resourcesPath,
} = {}) {
  const override = env?.MEBULAR_LOCALES_DIR;
  if (typeof override === 'string' && override.trim()) return override;
  if (typeof resourcesPath === 'string' && resourcesPath.trim()) {
    const candidates = [
      join(resourcesPath, 'locales'),
      join(resourcesPath, 'node_modules', '@mebular', 'core', 'locales'),
    ];
    for (const packaged of candidates) {
      if (existsSync(join(packaged, 'manifest.json'))) return packaged;
    }
  }
  return join(moduleDir, '..', '..', '..', '..', 'locales');
}

function readJson(absolute) {
  try {
    return JSON.parse(readFileSync(absolute, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 读取 manifest + 所有注册 locale 的 desktop pack。
 * @returns {{ manifest, catalogs, supportedLocales, defaultLocale, fallbackLocale, errors }}
 */
export function loadDesktopCatalogs({ localesDir = resolveLocalesDir() } = {}) {
  const manifest = readJson(join(localesDir, 'manifest.json'));
  const entries = Array.isArray(manifest?.locales) ? manifest.locales : [];
  const catalogs = {};
  const errors = [];
  for (const entry of entries) {
    const code = typeof entry?.locale === 'string' ? entry.locale : null;
    const relative = entry?.files?.[DESKTOP_PACK];
    if (!code || typeof relative !== 'string') {
      errors.push({ locale: code, reason: 'missing desktop pack path' });
      continue;
    }
    const json = readJson(join(localesDir, relative));
    if (!json || !json.messages || typeof json.messages !== 'object' || Array.isArray(json.messages)) {
      errors.push({ locale: code, path: relative, reason: 'missing or invalid pack' });
      continue;
    }
    // 错误 pack 与 desktop 文案合并：主进程对话框 / 向导可共用同一套错误码文案。
    const messages = { ...json.messages };
    const errorsPath = entry?.files?.[ERRORS_PACK];
    if (typeof errorsPath === 'string') {
      const extra = readJson(join(localesDir, errorsPath));
      if (extra?.messages && typeof extra.messages === 'object' && !Array.isArray(extra.messages)) {
        Object.assign(messages, extra.messages);
      } else {
        errors.push({ locale: code, path: errorsPath, reason: 'missing or invalid errors pack' });
      }
    }
    catalogs[code] = messages;
  }
  const supportedLocales = entries.map((entry) => entry?.locale).filter(Boolean);
  // default / fallback 来自 manifest，并在已注册语言内归一化（不在 loader 里硬编码 en/zh）。
  const defaultLocale = normalizeDesktopLocale(manifest?.defaultLocale, {
    supportedLocales,
    defaultLocale: manifest?.defaultLocale,
  });
  const fallbackLocale = normalizeDesktopLocale(manifest?.fallbackLocale ?? defaultLocale, {
    supportedLocales,
    defaultLocale,
  });
  return {
    manifest: manifest ?? {
      schemaVersion: 1,
      defaultLocale,
      fallbackLocale,
      packs: [DESKTOP_PACK],
      locales: [],
    },
    catalogs,
    supportedLocales,
    defaultLocale,
    fallbackLocale,
    errors,
  };
}

/** 构造主进程 translator（catalogs 常驻内存；setLocale 不重新读盘）。 */
export function loadDesktopI18n({ localesDir = resolveLocalesDir(), locale = null } = {}) {
  const loaded = loadDesktopCatalogs({ localesDir });
  return createTranslator({
    catalogs: loaded.catalogs,
    locale,
    fallbackLocale: loaded.fallbackLocale,
    defaultLocale: loaded.defaultLocale,
    supportedLocales: loaded.supportedLocales,
  });
}
