// P6B · 托盘控制台原地导航契约
//
// 目标固定（map / settings·clouds / settings·security / settings·assistants / invite），
// 已加载 /console 只发 IPC，未加载才 loadURL 一次；不接受任意 URL / query 透传。

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONSOLE_NAV_TARGETS,
  consoleNavSearch,
  consoleNavUrl,
  isConsoleUrl,
} from '../../apps/desktop/src/main/console-nav.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const indexMjs = readFileSync(join(root, 'apps', 'desktop', 'src', 'main', 'index.mjs'), 'utf-8');
const preloadCjs = readFileSync(join(root, 'apps', 'desktop', 'src', 'preload', 'index.cjs'), 'utf-8');

const base = 'http://127.0.0.1:7331/console';

describe('P6B 托盘原地导航 · 固定目标映射', () => {
  it('目标键固定：map / clouds / security / assistants / invite', () => {
    expect(Object.keys(CONSOLE_NAV_TARGETS)).toEqual(['map', 'clouds', 'security', 'assistants', 'invite']);
    expect(CONSOLE_NAV_TARGETS.map).toEqual({ view: 'map' });
    expect(CONSOLE_NAV_TARGETS.clouds).toEqual({ view: 'settings', focus: 'clouds' });
    expect(CONSOLE_NAV_TARGETS.security).toEqual({ view: 'settings', focus: 'security' });
    expect(CONSOLE_NAV_TARGETS.assistants).toEqual({ view: 'connect' });
    expect(CONSOLE_NAV_TARGETS.invite).toEqual({ view: 'connect', step: 'device' });
  });

  it('query 由固定映射生成；未知目标 / 空目标不产生 URL（无任意透传）', () => {
    expect(consoleNavSearch('map')).toBe('?view=map');
    expect(consoleNavSearch('clouds')).toBe('?view=settings&focus=clouds');
    expect(consoleNavSearch('security')).toBe('?view=settings&focus=security');
    expect(consoleNavSearch('assistants')).toBe('?view=connect');
    expect(consoleNavSearch('invite')).toBe('?view=connect&step=device');
    expect(consoleNavSearch('https://evil.example/console')).toBeNull();
    expect(consoleNavSearch('')).toBeNull();
    expect(consoleNavSearch('__proto__')).toBeNull();
    expect(consoleNavUrl(base, 'security')).toBe(`${base}?view=settings&focus=security`);
    expect(consoleNavUrl(base, 'nope')).toBeNull();
    expect(consoleNavUrl('', 'map')).toBeNull();
  });

  it('isConsoleUrl：同 origin + /console（含尾斜杠）才算已加载；端口/路径不同都不算', () => {
    expect(isConsoleUrl('http://127.0.0.1:7331/console', base)).toBe(true);
    expect(isConsoleUrl('http://127.0.0.1:7331/console/', base)).toBe(true);
    expect(isConsoleUrl('http://127.0.0.1:7331/console?view=settings&shell=desktop', base)).toBe(true);
    expect(isConsoleUrl('http://127.0.0.1:7331/console/index.html', base)).toBe(false);
    expect(isConsoleUrl('http://127.0.0.1:7332/console', base)).toBe(false);
    expect(isConsoleUrl('http://127.0.0.1:7331/other', base)).toBe(false);
    expect(isConsoleUrl('data:text/html,loading', base)).toBe(false);
    expect(isConsoleUrl('not a url', base)).toBe(false);
  });
});

describe('P6B 托盘原地导航 · 主进程 / preload 接线', () => {
  it('五个托盘入口全部走 navigateConsole（不再 safeLoad 直接刷新）', () => {
    const actions = indexMjs.match(/function trayActions\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(actions).not.toContain('safeLoad');
    for (const [id, target] of [
      ['open-console', 'map'],
      ['manage-clouds', 'clouds'],
      ['security-level', 'security'],
      ['connect-assistants', 'assistants'],
      ['add-device', 'invite'],
    ]) {
      expect(actions).toMatch(new RegExp(`'${id}': \\(\\) => \\{ void navigateConsole\\('${target}'\\)`));
    }
    // 向导仍是显式加载（不吞掉「重启向导」语义）
    expect(actions).toMatch(/'open-wizard': \(\) => \{ showWindow\(\); void loadWizardView\(\)/);
  });

  it('navigateConsole：已是 /console → webContents.send；否则才 safeLoad 一次', () => {
    const fn = indexMjs.match(/async function navigateConsole\(target\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('consoleNavUrl(base, target)');
    expect(fn).toContain('isConsoleUrl(win.webContents.getURL(), base)');
    expect(fn).toContain("win.webContents.send('console:navigate'");
    expect(fn).toContain('await safeLoad(shellDeepLink(url));');
    expect(fn).not.toMatch(/safeLoad\(target|safeLoad\(url\s*\?\?/);
    expect(fn).not.toContain('win.loadURL');
  });

  it('preload 只暴露固定 onConsoleNavigate，固定单通道，不透传 channel', () => {
    expect(preloadCjs).toContain('onConsoleNavigate: (callback) => {');
    expect(preloadCjs).toContain("ipcRenderer.on('console:navigate'");
    expect(preloadCjs).toContain("payload.search.startsWith('?')");
    expect(preloadCjs).not.toMatch(/ipcRenderer\.on\(\s*channel/);
    expect(preloadCjs).not.toMatch(/ipcRenderer\.send\(\s*channel/);
  });
});
