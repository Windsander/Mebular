// i18n 首帧门：静态契约（不启浏览器）。
// 目标：index.html 的静态中文兜底在 locale pack 就绪前不参与绘制；
// shell-boot.js 在解析期加 console-booting，console.js 只在 consoleReady 同处移除。
// 活体断言（真实浏览器 + ?lang=en-US）在 verify:console:ui。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf-8');
const indexHtml = read('packages/console/index.html');
const css = read('packages/console/console.css');
const consoleJs = read('packages/console/console.js');
const bootJs = read('packages/console/shell-boot.js');

const CJK = /[\u3400-\u9fff]/;
const bootStart = indexHtml.indexOf('<div id="boot-screen"');
const bootEnd = indexHtml.indexOf('<div id="app"');
const bootBlock = bootStart >= 0 && bootEnd > bootStart ? indexHtml.slice(bootStart, bootEnd) : '';

describe('boot 占位：无语言文本 + 先于 #app', () => {
  it('index.html 有 #boot-screen，且位于 #app 之前（首帧元素序）', () => {
    expect(bootStart).toBeGreaterThan(-1);
    expect(bootEnd).toBeGreaterThan(bootStart);
  });

  it('占位不含任何语言文案 / data-i18n（只保留品牌 ✦ + Mebular）', () => {
    expect(bootBlock).not.toMatch(CJK);
    expect(bootBlock).not.toContain('data-i18n');
    expect(bootBlock).toContain('boot-mark');
    expect(bootBlock).toContain('✦');
    expect(bootBlock).toContain('Mebular');
  });
});

describe('shell-boot.js：解析期加门 + 超时兜底', () => {
  it('同步脚本仍在 <head>、先于样式（首帧前执行）', () => {
    expect(indexHtml.indexOf('./shell-boot.js')).toBeGreaterThan(-1);
    expect(indexHtml.indexOf('./shell-boot.js')).toBeLessThan(indexHtml.indexOf('./console.css'));
  });

  it('给 <html> 加 console-booting，不依赖 console.js', () => {
    expect(bootJs).toContain("root.classList.add('console-booting')");
    expect(bootJs).toContain('document.documentElement');
    expect(bootJs.indexOf('console-booting')).toBeLessThan(bootJs.indexOf('console.warn'));
  });

  it('超时兜底 8–10s：仅在未 ready 时移除，且给出告警（不吞错误）', () => {
    const timeout = bootJs.match(/BOOT_GATE_TIMEOUT_MS\s*=\s*(\d+)/);
    expect(timeout).not.toBeNull();
    const ms = Number(timeout[1]);
    expect(ms).toBeGreaterThanOrEqual(8000);
    expect(ms).toBeLessThanOrEqual(10000);
    expect(bootJs).toMatch(/if \(!root \|\| root\.dataset\.consoleReady === '1'\) return;/);
    expect(bootJs).toMatch(/root\.classList\.remove\('console-booting'\)/);
    expect(bootJs).toContain("console.warn('[console] boot gate released by timeout before consoleReady')");
  });
});

describe('CSS：门控期隐藏 #app、只显示占位', () => {
  it('html.console-booting 隐藏 #app（visibility 保留布局/画布测量）', () => {
    expect(css).toMatch(/html\.console-booting #app \{\s*visibility:\s*hidden;/);
  });

  it('#boot-screen 默认隐藏；门控期以 fixed 全屏显示（轻量 CRT，无文字依赖）', () => {
    expect(css).toMatch(/#boot-screen \{\s*display:\s*none;/);
    expect(css).toMatch(/html\.console-booting #boot-screen \{[^}]*position:\s*fixed;[^}]*display:\s*flex;/);
    expect(css).toMatch(/html\.console-booting #boot-screen::after \{[^}]*repeating-linear-gradient/);
  });
});

describe('console.js：ready 同处解除门控', () => {
  it('applyStaticI18n 先于 consoleReady（文案已就绪才放行）', () => {
    const appliedAt = consoleJs.indexOf('applyStaticI18n(document);');
    const readyAt = consoleJs.indexOf("dataset.consoleReady = '1'");
    expect(appliedAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(appliedAt);
  });

  it('移除 console-booting 紧跟 consoleReady 标记（同一处）', () => {
    const readyAt = consoleJs.indexOf("dataset.consoleReady = '1'");
    const releaseAt = consoleJs.indexOf("classList.remove('console-booting')", readyAt);
    expect(readyAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(readyAt);
    expect(releaseAt - readyAt).toBeLessThan(400);
  });

  it('只有两处解除：启动成功与 i18n 失败兜底；失败分支 rethrow（不吞）', () => {
    const releases = consoleJs.match(/classList\.remove\('console-booting'\)/g) ?? [];
    expect(releases.length).toBe(2);
    expect(consoleJs).toMatch(/catch \(error\) \{[\s\S]*?classList\.remove\('console-booting'\)[\s\S]*?throw error;/);
  });
});
