// P1 · Console host adapter：三态判定 / Electron 转发 / DSH 最小 postMessage 桥 / embed 标记。
// 最新 main 的宿主耦合（cloudSwitch / consoleNavigate / platform / 设置入口）一并覆盖。
// 纯 Node 假 window，不启动浏览器。

import { describe, it, expect, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConsoleHost, markEmbeddedDocument } from '../../packages/console/host.js';

const here = dirname(fileURLToPath(import.meta.url));
const consoleJs = readFileSync(join(here, '..', '..', 'packages', 'console', 'console.js'), 'utf-8');
const shellBootJs = readFileSync(join(here, '..', '..', 'packages', 'console', 'shell-boot.js'), 'utf-8');
const indexHtml = readFileSync(join(here, '..', '..', 'packages', 'console', 'index.html'), 'utf-8');
const consoleCss = readFileSync(join(here, '..', '..', 'packages', 'console', 'console.css'), 'utf-8');

const ALL_CAPABILITIES = [
  'nativeWindow', 'tray', 'restartDaemon', 'openWizard', 'openExternal',
  'notifications', 'cloudSwitch', 'consoleNavigate',
];

function makeBridgeWin({ ancestorOrigins = [], referrer = '' } = {}) {
  const listeners = [];
  const posted = [];
  const parent = {
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    },
  };
  const win = {
    parent,
    location: {
      href: 'http://127.0.0.1:7331/console/?embed=dsh',
      ancestorOrigins,
    },
    document: { referrer, title: '' },
    open: jest.fn(),
    addEventListener(type, listener) {
      if (type === 'message') listeners.push(listener);
    },
  };
  return {
    win,
    parent,
    posted,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

describe('P1 host：三态判定与能力', () => {
  it('无 preload → browser，capabilities 全 false / platform=null；openExternal 仍走 window.open 兜底', async () => {
    const win = { open: jest.fn(), document: { title: '' } };
    const host = createConsoleHost({ search: '', win });
    expect(host.kind).toBe('browser');
    expect(host.platform).toBeNull();
    expect(Object.keys(host.capabilities).sort()).toEqual([...ALL_CAPABILITIES].sort());
    expect(Object.values(host.capabilities).every((value) => value === false)).toBe(true);
    host.openExternal('https://example.com/path');
    expect(win.open).toHaveBeenCalledWith('https://example.com/path', '_blank', 'noopener,noreferrer');
    expect(() => host.openExternal('javascript:alert(1)')).toThrow(/http\(s\)/);
    expect(() => host.openWizard()).toThrow(/浏览器模式/);
    await expect(host.cloudSwitch('c1')).rejects.toThrow(/浏览器模式/);
    expect(host.onConsoleNavigate(() => {})).toEqual(expect.any(Function));
  });

  it('preload → desktop，能力如实反映并转发到现有 preload（含 cloudSwitch / consoleNavigate / platform）', async () => {
    const calls = [];
    let consoleNavigateHandler = null;
    const win = {
      mebularDesktop: {
        platform: 'darwin',
        restart: async () => { calls.push('restart'); return { mode: 'managed' }; },
        openWizard: () => { calls.push('openWizard'); return { opened: true }; },
        openExternal: async (url) => { calls.push(`openExternal:${url}`); return { opened: true }; },
        notify: (payload) => { calls.push(`notify:${payload.message}`); },
        setTitle: (title) => { calls.push(`title:${title}`); },
        cloudSwitch: async (id) => { calls.push(`cloudSwitch:${id}`); return { switched: id }; },
        onConsoleNavigate: (handler) => {
          calls.push('onConsoleNavigate');
          consoleNavigateHandler = handler;
          return () => calls.push('unsubscribe');
        },
      },
      open: jest.fn(),
      document: { title: '' },
    };
    const host = createConsoleHost({ search: '', win });
    expect(host.kind).toBe('desktop');
    expect(host.platform).toBe('darwin');
    expect(host.capabilities).toEqual({
      nativeWindow: true,
      tray: true,
      restartDaemon: true,
      openWizard: true,
      openExternal: true,
      notifications: true,
      cloudSwitch: true,
      consoleNavigate: true,
    });
    await expect(host.restartDaemon()).resolves.toEqual({ mode: 'managed' });
    expect(host.openWizard()).toEqual({ opened: true });
    await expect(host.openExternal('https://example.com/x')).resolves.toEqual({ opened: true });
    await expect(host.cloudSwitch('cloud-1')).resolves.toEqual({ switched: 'cloud-1' });
    host.notify({ message: 'hello' });
    host.setTitle('Mebular');
    const unsubscribe = host.onConsoleNavigate((search) => calls.push(`navigate:${search}`));
    consoleNavigateHandler('?view=settings');
    expect(calls).toContain('navigate:?view=settings');
    unsubscribe();
    expect(calls).toEqual([
      'restart', 'openWizard', 'openExternal:https://example.com/x',
      'cloudSwitch:cloud-1', 'notify:hello', 'title:Mebular',
      'onConsoleNavigate', 'navigate:?view=settings', 'unsubscribe',
    ]);
  });

  it('desktop 缺少可选桥：capabilities=false，不伪造能力；platform 缺省为 null', () => {
    const win = { mebularDesktop: { restart: async () => ({}) }, document: { title: '' } };
    const host = createConsoleHost({ search: '', win });
    expect(host.kind).toBe('desktop');
    expect(host.platform).toBeNull();
    expect(host.capabilities).toMatchObject({
      restartDaemon: true,
      openWizard: false,
      openExternal: false,
      notifications: false,
      cloudSwitch: false,
      consoleNavigate: false,
    });
    expect(host.onConsoleNavigate(() => {})).toEqual(expect.any(Function));
  });

  it('?embed=dsh 优先于 preload → dsh，且不触碰 preload', async () => {
    const preload = {
      restart: jest.fn(),
      openWizard: jest.fn(),
      cloudSwitch: jest.fn(),
      onConsoleNavigate: jest.fn(),
    };
    const host = createConsoleHost({ search: '?embed=dsh', win: { mebularDesktop: preload } });
    expect(host.kind).toBe('dsh');
    expect(host.platform).toBeNull();
    expect(Object.values(host.capabilities).every((value) => value === false)).toBe(true);
    expect(host.bridgeAvailable).toBe(false);
    await expect(host.restartDaemon()).rejects.toThrow(/bridge unavailable/);
    await expect(host.cloudSwitch('cloud-1')).rejects.toThrow(/bridge unavailable/);
    expect(preload.restart).not.toHaveBeenCalled();
    expect(preload.openWizard).not.toHaveBeenCalled();
    expect(preload.cloudSwitch).not.toHaveBeenCalled();
    expect(preload.onConsoleNavigate).not.toHaveBeenCalled();
  });

  it('markEmbeddedDocument：只在 dsh 时设置 data-embed=dsh', () => {
    const doc = { documentElement: { dataset: {} } };
    markEmbeddedDocument(doc, 'browser');
    expect(doc.documentElement.dataset.embed).toBeUndefined();
    markEmbeddedDocument(doc, 'desktop');
    expect(doc.documentElement.dataset.embed).toBeUndefined();
    markEmbeddedDocument(doc, 'dsh');
    expect(doc.documentElement.dataset.embed).toBe('dsh');
  });
});

describe('P1 host：DSH postMessage 桥', () => {
  it('请求用精确 targetOrigin；忽略错误 origin/source；response 往返', async () => {
    const bridge = makeBridgeWin({ ancestorOrigins: ['http://127.0.0.1:3000'] });
    const host = createConsoleHost({ search: '?embed=dsh', win: bridge.win });
    expect(host.bridgeAvailable).toBe(true);

    const promise = host.restartDaemon();
    expect(bridge.posted).toHaveLength(1);
    const [{ message, targetOrigin }] = bridge.posted;
    expect(targetOrigin).toBe('http://127.0.0.1:3000');
    expect(message).toMatchObject({ type: 'mebular:request', method: 'restartDaemon', params: {} });
    expect(typeof message.id).toBe('number');

    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });

    bridge.emit({ source: bridge.parent, origin: 'http://127.0.0.1:9999', data: { type: 'mebular:response', id: message.id, ok: true } });
    bridge.emit({ source: {}, origin: 'http://127.0.0.1:3000', data: { type: 'mebular:response', id: message.id, ok: true } });
    await Promise.resolve();
    expect(settled).toBe(false);

    bridge.emit({ source: bridge.parent, origin: 'http://127.0.0.1:3000', data: { type: 'mebular:response', id: message.id, ok: true, result: { restarted: true } } });
    await expect(promise).resolves.toEqual({ restarted: true });
    expect(settled).toBe(true);
  });

  it('referrer 兜底推导 origin；错误 response → reject；方法参数形状稳定', async () => {
    const bridge = makeBridgeWin({ referrer: 'http://localhost:7777/workspace' });
    const host = createConsoleHost({ search: '?embed=dsh', win: bridge.win });

    const notify = host.notify({ level: 'warn', message: 'hello' });
    const [{ message, targetOrigin }] = bridge.posted;
    expect(targetOrigin).toBe('http://localhost:7777');
    expect(message).toMatchObject({ method: 'notify', params: { level: 'warn', message: 'hello' } });
    bridge.emit({ source: bridge.parent, origin: 'http://localhost:7777', data: { type: 'mebular:response', id: message.id, ok: false, error: 'denied' } });
    await expect(notify).rejects.toThrow('denied');

    const switchPromise = host.cloudSwitch('cloud-2');
    const switchMessage = bridge.posted.at(-1);
    expect(switchMessage.message).toMatchObject({ method: 'cloudSwitch', params: { id: 'cloud-2' } });
    bridge.emit({ source: bridge.parent, origin: 'http://localhost:7777', data: { type: 'mebular:response', id: switchMessage.message.id, ok: true, result: { switched: true } } });
    await expect(switchPromise).resolves.toEqual({ switched: true });

    void host.setTitle('Mebular');
    const last = bridge.posted.at(-1);
    expect(last.message).toMatchObject({ method: 'setTitle', params: { title: 'Mebular' } });
    bridge.emit({ source: bridge.parent, origin: 'http://localhost:7777', data: { type: 'mebular:response', id: last.message.id, ok: true } });
    await Promise.resolve();
  });

  it('推导不到父 origin → 禁用桥，绝不回退 *', async () => {
    const bridge = makeBridgeWin({ ancestorOrigins: [], referrer: '' });
    const host = createConsoleHost({ search: '?embed=dsh', win: bridge.win });
    expect(host.bridgeAvailable).toBe(false);
    await expect(host.openExternal('https://example.com')).rejects.toThrow(/bridge unavailable/);
    expect(bridge.posted).toHaveLength(0);
  });

  it('宿主原地导航：只接受父窗口 + 精确 origin 的 mebular:navigate', () => {
    const bridge = makeBridgeWin({ ancestorOrigins: ['http://127.0.0.1:3000'] });
    const host = createConsoleHost({ search: '?embed=dsh', win: bridge.win });
    const seen = [];
    const unsubscribe = host.onConsoleNavigate((search) => seen.push(search));

    bridge.emit({ source: {}, origin: 'http://127.0.0.1:3000', data: { type: 'mebular:navigate', search: '?view=settings' } });
    bridge.emit({ source: bridge.parent, origin: 'http://127.0.0.1:9999', data: { type: 'mebular:navigate', search: '?view=audit' } });
    bridge.emit({ source: bridge.parent, origin: 'http://127.0.0.1:3000', data: { type: 'mebular:navigate', search: 'view=bad' } });
    expect(seen).toEqual([]);

    bridge.emit({ source: bridge.parent, origin: 'http://127.0.0.1:3000', data: { type: 'mebular:navigate', search: '?view=settings' } });
    expect(seen).toEqual(['?view=settings']);
    unsubscribe();
    bridge.emit({ source: bridge.parent, origin: 'http://127.0.0.1:3000', data: { type: 'mebular:navigate', search: '?view=audit' } });
    expect(seen).toEqual(['?view=settings']);
  });
});

describe('P1 console 接线（静态契约）', () => {
  it('console.js 不再直接出现 mebularDesktop，host 在任何渲染前创建并标记 embed', () => {
    expect(consoleJs).not.toContain('mebularDesktop');
    expect(consoleJs).toMatch(/import \{ createConsoleHost, markEmbeddedDocument \} from '\.\/host\.js'/);
    expect(consoleJs).toMatch(/const host = createConsoleHost\(\{ search: location\.search, win: window \}\)/);
    expect(consoleJs.indexOf('markEmbeddedDocument(document, host.kind)')).toBeGreaterThan(consoleJs.indexOf('const host = createConsoleHost'));
    expect(consoleJs.indexOf('markEmbeddedDocument(document, host.kind)')).toBeLessThan(consoleJs.indexOf('await initI18n('));
    // 首帧引导脚本同样在解析期标记 embed（避免 topbar 先画一帧）。
    expect(shellBootJs).toMatch(/embed=dsh/);
    expect(shellBootJs).toContain("document.documentElement.dataset.embed = 'dsh'");
    expect(consoleJs).toMatch(/host\.capabilities\.openWizard/);
    expect(consoleJs).toMatch(/host\.capabilities\.cloudSwitch/);
    expect(consoleJs).toMatch(/host\.openWizard\(\)/);
    expect(consoleJs).toMatch(/host\.cloudSwitch\(id\)/);
    expect(consoleJs).toMatch(/host\.onConsoleNavigate\(/);
    expect(consoleJs).toMatch(/host\.platform === 'darwin'/);
  });

  it('index.html / console.css：embed-only 设置入口（i18n key）与 dsh 布局', () => {
    expect(indexHtml).toMatch(/id="embed-open-settings"[^>]*type="button"/);
    expect(indexHtml).not.toMatch(/id="embed-open-settings"[^>]*class="[^"]*view-btn/);
    expect(indexHtml).toMatch(/id="embed-open-settings"[\s\S]{0,280}data-i18n="topbar\.settings"/);
    expect(indexHtml).toMatch(/id="embed-open-settings"[\s\S]{0,280}data-i18n-aria-label="topbar\.settings"/);
    expect(consoleCss).toContain('.embed-only { display: none; }');
    expect(consoleCss).toContain("[data-embed='dsh'] .embed-only { display: list-item; }");
    expect(consoleCss).toContain("[data-embed='dsh'] .topbar { display: none; }");
    expect(consoleCss).toContain("[data-embed='dsh'] .banner.is-locked { display: none; }");
    expect(consoleCss).toMatch(/\[data-embed='dsh'\] \.layout \{ flex: 1 1 auto; min-height: 0; \}/);
  });
});
