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
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const localesDir = join(ROOT, 'locales');
const CJK = /[\u3400-\u9fff]/;

const zh = loadDesktopI18n({ localesDir, locale: 'zh-CN' });
const en = loadDesktopI18n({ localesDir, locale: 'en-US' });
const productionRegistry = {
  supportedLocales: ['zh-CN', 'en-US'],
  defaultLocale: 'zh-CN',
};
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
    expect(loadDesktopI18n({ localesDir, locale: 'en-GB' }).locale).toBe('en-US');
    expect(loadDesktopI18n({ localesDir, locale: 'fr-FR' }).locale).toBe('zh-CN');
  });

  it('normalize：注册表内精确 / 语言 / 地区匹配；未知 / 空 → manifest default', () => {
    expect(normalizeDesktopLocale('zh-CN', productionRegistry)).toBe('zh-CN');
    expect(normalizeDesktopLocale('en', productionRegistry)).toBe('en-US');
    expect(normalizeDesktopLocale('en-GB', productionRegistry)).toBe('en-US');
    expect(normalizeDesktopLocale('EN_us', productionRegistry)).toBe('en-US');
    expect(normalizeDesktopLocale('fr-FR', productionRegistry)).toBe('zh-CN');
    expect(normalizeDesktopLocale('', productionRegistry)).toBe('zh-CN');
    // 无注册表时未知 / 空才回落 zh-CN（最后兜底，不参与语言选择）。
    expect(normalizeDesktopLocale('fr-FR')).toBe('zh-CN');
    expect(normalizeDesktopLocale('')).toBe('zh-CN');
  });

  it('合成 ja-JP：normalize / loader 完全由 manifest 驱动（不改生产语言列表）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mebular-desktop-locales-'));
    const manifest = {
      schemaVersion: 1,
      defaultLocale: 'ja-JP',
      fallbackLocale: 'ja-JP',
      packs: ['desktop'],
      locales: [
        { locale: 'ja-JP', nativeName: '日本語', files: { desktop: 'ja-JP/desktop.json' } },
        { locale: 'zh-CN', nativeName: '简体中文', files: { desktop: 'zh-CN/desktop.json' } },
      ],
    };
    try {
      await mkdir(join(dir, 'ja-JP'), { recursive: true });
      await mkdir(join(dir, 'zh-CN'), { recursive: true });
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
      await writeFile(join(dir, 'ja-JP', 'desktop.json'), JSON.stringify({
        schemaVersion: 1, locale: 'ja-JP', pack: 'desktop', messages: { 'probe.key': '日本語' },
      }));
      await writeFile(join(dir, 'zh-CN', 'desktop.json'), JSON.stringify({
        schemaVersion: 1, locale: 'zh-CN', pack: 'desktop', messages: { 'probe.key': '中文' },
      }));

      const registration = { supportedLocales: ['ja-JP', 'zh-CN'], defaultLocale: 'ja-JP' };
      expect(normalizeDesktopLocale('ja', registration)).toBe('ja-JP');
      expect(normalizeDesktopLocale('ja-JP', registration)).toBe('ja-JP');
      expect(normalizeDesktopLocale('ja-JP-u-ca-japanese', registration)).toBe('ja-JP');
      expect(normalizeDesktopLocale('fr-FR', registration)).toBe('ja-JP');

      const loaded = loadDesktopCatalogs({ localesDir: dir });
      expect(loaded.supportedLocales).toEqual(['ja-JP', 'zh-CN']);
      expect(loaded.defaultLocale).toBe('ja-JP');
      expect(loaded.fallbackLocale).toBe('ja-JP');
      expect(loaded.errors).toEqual([]);

      const jaByLanguage = loadDesktopI18n({ localesDir: dir, locale: 'ja' });
      expect(jaByLanguage.locale).toBe('ja-JP');
      expect(jaByLanguage.defaultLocale).toBe('ja-JP');
      expect(jaByLanguage.supportedLocales).toEqual(['ja-JP', 'zh-CN']);
      expect(jaByLanguage.t('probe.key')).toBe('日本語');

      const unknown = loadDesktopI18n({ localesDir: dir, locale: 'fr-FR' });
      expect(unknown.locale).toBe('ja-JP');
      expect(unknown.t('probe.key')).toBe('日本語');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  it('同一托盘状态切换 zh→en：菜单/状态行/退出确认全量换语言，id 与结构不变', () => {
    const state = { healthy: true, daemonMode: 'service', loginOpenAtLogin: true, securityLevel: 'medium' };
    const zhModel = trayMenuModel(state, zh.t);
    const enModel = trayMenuModel(state, en.t);
    const ids = (model) => model.map((item) => item.type === 'separator' ? '|' : item.id);
    expect(ids(enModel)).toEqual(ids(zhModel));
    expect(zhModel.find((item) => item.id === 'open-console')?.label).toBe('打开控制台');
    expect(enModel.find((item) => item.id === 'open-console')?.label).toBe('Open console');
    expect(zhModel[0].label).toContain('运行中');
    expect(enModel[0].label).toContain('Running');
    expect(zhModel.find((item) => item.id === 'add-device')?.label).toBe('邀请设备');
    expect(enModel.find((item) => item.id === 'add-device')?.label).toBe('Invite a device');
    expect(trayStatusLine({ healthy: true, daemonMode: 'service' }, zh.t)).toContain('常驻服务');
    expect(trayStatusLine({ healthy: true, daemonMode: 'service' }, en.t)).toContain('Background service');
    expect(quitConfirm({ daemonMode: 'service', hasManagedChild: false }, en.t).buttons).not.toEqual(
      quitConfirm({ daemonMode: 'service', hasManagedChild: false }, zh.t).buttons,
    );
  });
});

describe('locale 偏好同步（Console → Desktop 壳层）', () => {
  it('偏好写回 <home>/.desktop-state.json；读回后 normalize 命中 en-US', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mebular-desktop-locale-'));
    try {
      expect(desktopStatePath(home)).toBe(join(home, '.desktop-state.json'));
      writeDesktopState(home, { locale: 'en-US' });
      expect(readDesktopState(home).locale).toBe('en-US');
      expect(normalizeDesktopLocale(readDesktopState(home).locale, productionRegistry)).toBe('en-US');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preload 只读观察同源 localStorage key，并复用既有 locale:set IPC（不新增通道）', () => {
    const preload = readFileSync(join(ROOT, 'apps', 'desktop', 'src', 'preload', 'index.cjs'), 'utf-8');
    expect(preload).toContain("const LOCALE_STORAGE_KEY = 'mebular.locale'");
    expect(preload).toContain('syncLocaleFromConsole');
    expect(preload).toContain('bootstrapLocaleFromShell');
    expect(preload).toContain("ipcRenderer.invoke('locale:get')");
    expect(preload).toContain("ipcRenderer.invoke('locale:set'");
    expect(preload).toContain("window.addEventListener('focus'");
    expect(preload).toContain("document.addEventListener('visibilitychange'");
    expect(preload).not.toContain("ipcRenderer.invoke('locale:sync'");
    // 启动先以壳层偏好对齐，再允许 localStorage 回推（防陈旧值反写）。
    expect(preload).toContain('void bootstrapLocaleFromShell()');
    expect(preload).toContain('if (!localeBootstrapped) return;');
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
