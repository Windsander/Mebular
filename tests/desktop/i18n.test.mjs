// Desktop 壳层 i18n：pack 对等 / loader / 语言偏好同步 / 渲染层静态契约。
// 只读 locales 数据层与纯逻辑模块，不启 Electron、不写真实 home。

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeWizardState, desktopStatePath, readDesktopState, writeDesktopState } from '../../apps/desktop/src/main/wizard.mjs';
import { quitConfirm, trayMenuModel, trayStatusLine } from '../../apps/desktop/src/main/lifecycle.mjs';
import { loadDesktopCatalogs, loadDesktopI18n, resolveLocalesDir } from '../../apps/desktop/src/main/i18n.mjs';
import { applyStaticI18nWith, createTranslator, normalizeDesktopLocale } from '../../apps/desktop/src/shared/i18n-core.mjs';
import { wizardView } from '../../apps/desktop/src/renderer/wizard-view.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const localesDir = join(ROOT, 'locales');
const CJK = /[\u3400-\u9fff]/;

const zh = loadDesktopI18n({ localesDir, locale: 'zh-CN' });
const en = loadDesktopI18n({ localesDir, locale: 'en-US' });
const manifest = JSON.parse(readFileSync(join(localesDir, 'manifest.json'), 'utf-8'));
const zhPack = JSON.parse(readFileSync(join(localesDir, 'zh-CN', 'desktop.json'), 'utf-8'));
const enPack = JSON.parse(readFileSync(join(localesDir, 'en-US', 'desktop.json'), 'utf-8'));

const placeholders = (value) => [...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)]
  .map((match) => match[1]).sort();

describe('desktop pack：唯一真源 + 对等 + 英文无中文', () => {
  it('manifest 注册 desktop pack，且两份 pack envelope 与 locale 一致', () => {
    expect(manifest.packs).toContain('desktop');
    for (const entry of manifest.locales) {
      expect(typeof entry.files.desktop).toBe('string');
      expect(entry.files.desktop).toContain('desktop.json');
    }
    expect(zhPack).toMatchObject({ schemaVersion: manifest.schemaVersion, locale: 'zh-CN', pack: 'desktop' });
    expect(enPack).toMatchObject({ schemaVersion: manifest.schemaVersion, locale: 'en-US', pack: 'desktop' });
    expect(Object.keys(zhPack.messages).length).toBeGreaterThan(40);
  });

  it('zh-CN / en-US key 完全对等，占位符集合一致', () => {
    expect(Object.keys(enPack.messages).sort()).toEqual(Object.keys(zhPack.messages).sort());
    for (const key of Object.keys(zhPack.messages)) {
      expect({ key, placeholders: placeholders(enPack.messages[key]) })
        .toEqual({ key, placeholders: placeholders(zhPack.messages[key]) });
    }
  });

  it('en-US 值不含中文（用户数据/品牌除外——本 pack 无用户数据）', () => {
    const cjk = Object.entries(enPack.messages).filter(([, value]) => CJK.test(value));
    expect(cjk).toEqual([]);
  });

  it('每个值非空字符串', () => {
    for (const value of Object.values(zhPack.messages)) {
      expect(typeof value === 'string' && value.trim().length > 0).toBe(true);
    }
    for (const value of Object.values(enPack.messages)) {
      expect(typeof value === 'string' && value.trim().length > 0).toBe(true);
    }
  });
});

describe('desktop loader / translator', () => {
  it('resolveLocalesDir 默认指向仓库 locales；MEBULAR_LOCALES_DIR 覆盖优先', () => {
    expect(resolveLocalesDir({ env: {}, moduleDir: join(ROOT, 'apps', 'desktop', 'src', 'main'), resourcesPath: '' }))
      .toBe(localesDir);
    expect(resolveLocalesDir({ env: { MEBULAR_LOCALES_DIR: '/tmp/custom-locales' }, moduleDir: '/x', resourcesPath: '' }))
      .toBe('/tmp/custom-locales');
  });

  it('加载 manifest 注册的 desktop catalogs（zh/en）且无错误', () => {
    const loaded = loadDesktopCatalogs({ localesDir });
    expect(Object.keys(loaded.catalogs).sort()).toEqual(['en-US', 'zh-CN']);
    expect(loaded.defaultLocale).toBe('zh-CN');
    expect(loaded.errors).toEqual([]);
  });

  it('normalize：en / en-GB → en-US；未知 / 空 → zh-CN', () => {
    expect(normalizeDesktopLocale('en')).toBe('en-US');
    expect(normalizeDesktopLocale('en-GB')).toBe('en-US');
    expect(normalizeDesktopLocale('EN_us')).toBe('en-US');
    expect(normalizeDesktopLocale('fr-FR')).toBe('zh-CN');
    expect(normalizeDesktopLocale('')).toBe('zh-CN');
  });

  it('缺 key 回退 key；目标语言缺 key 时按 manifest fallback 回退 zh', () => {
    expect(zh.t('__missing_key__')).toBe('__missing_key__');
    const sparse = createTranslator({
      catalogs: { 'zh-CN': { 'probe.key': '默认文案' }, 'en-US': {} },
      locale: 'en-US',
    });
    expect(sparse.t('probe.key')).toBe('默认文案');
    expect(sparse.t('__missing_key__')).toBe('__missing_key__');
  });

  it('插值只替换已知占位符', () => {
    expect(zh.t('wizard.badge.step', { current: 2, total: 2, name: '连接 AI 助手' }))
      .toBe('第 2/2 步 · 连接 AI 助手');
    expect(en.t('wizard.badge.step', { current: 2, total: 2, name: 'Connect AI assistants' }))
      .toBe('Step 2/2 · Connect AI assistants');
    expect(en.t('wizard.badge.step', { current: 2 })).toContain('{total}');
  });

  it('applyStaticI18nWith 只替换已有译文的节点（不把中文兜底换成 key）', () => {
    const nodes = [];
    const make = (attrs) => ({
      attrs: { ...attrs },
      textContent: '',
      getAttribute(name) { return this.attrs[name] ?? null; },
      setAttribute(name, value) { this.attrs[name] = value; },
    });
    const keyed = make({ 'data-i18n': 'wizard.skip' });
    const missing = make({ 'data-i18n': '__missing_key__' });
    nodes.push(keyed, missing);
    const root = {
      querySelectorAll(selector) {
        if (selector === '[data-i18n]') return nodes;
        return [];
      },
    };
    applyStaticI18nWith(zh.t, root);
    expect(keyed.textContent).toBe('跳过引导 ›');
    expect(missing.textContent).toBe('');
  });
});

describe('英文壳层：向导视图与托盘/退出确认不含中文', () => {
  it('wizardView(en) 关键场景无中文（未开始 / 已就绪 / 已接入 / 只读受限）', () => {
    const states = [
      computeWizardState({}),
      computeWizardState({ daemonHealthy: true }),
      computeWizardState({ daemonHealthy: true, service: { registered: true, running: true }, assistants: { connectedCount: 2, installedCount: 3, total: 3 }, wizard: { assistantsAcked: true } }),
      computeWizardState({ daemonHealthy: true, assistants: { readError: 'HTTP 401', connectedCount: 0, total: null } }),
    ];
    for (const state of states) {
      const view = wizardView(state, en.t);
      expect(CJK.test(JSON.stringify(view))).toBe(false);
    }
    expect(wizardView(computeWizardState({}), en.t).tagline).toBe('One click to connect this device');
    expect(wizardView(computeWizardState({ daemonHealthy: true, wizard: { assistantsAcked: true } }), en.t).badge).toBe('Ready');
  });

  it('lifecycle(en)：托盘状态/菜单与退出确认均无中文，且 stopped-daemon 语义仍只在 child 托管时出现', () => {
    const model = trayMenuModel({ healthy: true, daemonMode: 'child', loginOpenAtLogin: false, securityLevel: 'high' }, en.t);
    expect(CJK.test(JSON.stringify(model))).toBe(false);
    expect(trayStatusLine({ healthy: true, daemonMode: 'child' }, en.t)).toBe('● Running · Temporary (app-managed)');
    const plan = quitConfirm({ daemonMode: 'child', hasManagedChild: true }, en.t);
    expect(CJK.test(JSON.stringify(plan))).toBe(false);
    expect(plan.buttons).toEqual(['Cancel', 'Quit']);
    for (const mode of ['reused', 'service', null]) {
      expect(quitConfirm({ daemonMode: mode, hasManagedChild: false }, en.t).message)
        .not.toMatch(/stops the local Mebular daemon/i);
    }
  });
});

describe('locale 偏好同步（Console → Desktop 壳层）', () => {
  it('偏好写回 <home>/.desktop-state.json；读回后 normalize 命中 en-US', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mebular-desktop-locale-'));
    try {
      expect(desktopStatePath(home)).toBe(join(home, '.desktop-state.json'));
      writeDesktopState(home, { locale: 'en-US' });
      expect(readDesktopState(home).locale).toBe('en-US');
      expect(normalizeDesktopLocale(readDesktopState(home).locale)).toBe('en-US');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preload 只读观察同源 localStorage key，并复用既有 locale:set IPC（不新增通道）', () => {
    const preload = readFileSync(join(ROOT, 'apps', 'desktop', 'src', 'preload', 'index.cjs'), 'utf-8');
    expect(preload).toContain("const LOCALE_STORAGE_KEY = 'mebular.locale'");
    expect(preload).toContain('syncLocaleFromConsole');
    expect(preload).toContain("ipcRenderer.invoke('locale:set'");
    expect(preload).toContain("window.addEventListener('focus'");
    expect(preload).toContain("document.addEventListener('visibilitychange'");
    expect(preload).not.toContain("ipcRenderer.invoke('locale:sync'");
  });

  it('主进程 locale:get 下发 catalogs；locale:set 落到 translator + 托盘/窗口标题', () => {
    const main = readFileSync(join(ROOT, 'apps', 'desktop', 'src', 'main', 'index.mjs'), 'utf-8');
    expect(main).toContain('loadDesktopI18n');
    expect(main).toMatch(/'locale:get':[\s\S]{0,420}catalogs: desktopI18n\.exportCatalogs\(\)/);
    expect(main).toMatch(/'locale:set':[^\n]*applyDesktopLocale\(locale, \{ persist: true \}\)/);
    expect(main).toMatch(/function applyDesktopLocale[\s\S]{0,300}updateTray\(\);[\s\S]{0,120}setWindowTitle\(\)/);
    expect(main).toContain('reloadDesktopLocale()');
  });

  it('向导从 locale:get 拿 catalogs 并先应用静态文案再刷新', () => {
    const wizardJs = readFileSync(join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'wizard.js'), 'utf-8');
    expect(wizardJs).toContain("api?.getLocale?.()");
    expect(wizardJs).toContain('createTranslator(');
    expect(wizardJs).toContain('applyStaticI18nWith(t, document)');
    expect(wizardJs).toContain("document.title = t('wizard.windowTitle')");
    expect(wizardJs).toContain('wizardView(state, t)');
    expect(wizardJs.indexOf('applyStaticI18nWith(t, document)')).toBeLessThan(wizardJs.indexOf('void refresh()'));
  });

  it('退出确认窗口的标题/message/按钮/hint/aria 由主进程按 locale 下发', () => {
    const main = readFileSync(join(ROOT, 'apps', 'desktop', 'src', 'main', 'index.mjs'), 'utf-8');
    expect(main).toMatch(/function presentQuitDialog[\s\S]{0,700}title: t\('quit\.title'\)/);
    expect(main).toMatch(/function presentQuitDialog[\s\S]{0,900}hint: t\('quit\.hint'\)/);
    expect(main).toMatch(/function presentQuitDialog[\s\S]{0,900}closeLabel: t\('quit\.closeAria'\)/);
    const quitJs = readFileSync(join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'quit-confirm.js'), 'utf-8');
    expect(quitJs).toContain('plan.hint');
    expect(quitJs).toContain('plan.closeLabel');
    expect(quitJs).toContain("closeEl.setAttribute('aria-label', plan.closeLabel)");
  });
});

describe('desktop 静态文案挂载', () => {
  it('wizard.html 的 data-i18n key 全部在默认 desktop pack 内', () => {
    const html = readFileSync(join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'wizard.html'), 'utf-8');
    const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter((key) => !(key in zhPack.messages))).toEqual([]);
  });

  it('裸 ASCII UI 文案（Main/Preferences/OK 等）没有被误当 key：动态文案全部走 t()', () => {
    const wizardJs = readFileSync(join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'wizard.js'), 'utf-8');
    const keys = [...wizardJs.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter((key) => !(key in zhPack.messages))).toEqual([]);
  });

  it('wizard-view.mjs 的动态 key 全部在 pack 内（模板 key 的手工白名单）', () => {
    const src = readFileSync(join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'wizard-view.mjs'), 'utf-8');
    const literalKeys = [...src.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]);
    expect(literalKeys.filter((key) => !(key in zhPack.messages))).toEqual([]);
    for (const id of ['start', 'assistants']) {
      expect(zhPack.messages[`wizard.stepName.${id}`]).toBeTruthy();
      expect(zhPack.messages[`wizard.step.${id}.title`]).toBeTruthy();
    }
  });
});
