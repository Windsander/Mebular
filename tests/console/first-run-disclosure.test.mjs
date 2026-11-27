// 0.4.0 W1b：唯一允许的 UI 增量——首启一次性披露。
//
// 源码/文案契约（不启浏览器）：
// - 披露只是说明，不是 consent：不新增页面、不新增开关/勾选、不改现有建新/加入流程；
// - 只在 `firstRun.pending === true` 展示；披露未成功展示时不向服务端 ack → 不启用 immersive；
// - 披露成功后（marker done）不再出现；已有用户没有 pending 状态。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const indexHtml = readFileSync(join(root, 'packages', 'console', 'index.html'), 'utf-8');
const consoleJs = readFileSync(join(root, 'packages', 'console', 'console.js'), 'utf-8');
const zh = JSON.parse(readFileSync(join(root, 'locales', 'zh-CN', 'console.json'), 'utf-8')).messages;
const en = JSON.parse(readFileSync(join(root, 'locales', 'en-US', 'console.json'), 'utf-8')).messages;

const KEY = 'provision.firstRun.disclosure.body';

function functionSource(name, nextName) {
  const start = consoleJs.indexOf(`function ${name}(`);
  const end = consoleJs.indexOf(`function ${nextName}(`, start);
  return start >= 0 && end > start ? consoleJs.slice(start, end) : '';
}

describe('首启披露：位置与形态', () => {
  it('在现有首启引导内、建新/加入按钮上方，只有一个说明段落', () => {
    const disclosureStart = indexHtml.indexOf('id="first-run-disclosure"');
    const actions = indexHtml.indexOf('onboarding-coach-actions');
    expect(disclosureStart).toBeGreaterThan(-1);
    expect(actions).toBeGreaterThan(disclosureStart);
    // 只是 <p> 说明，不带任何输入/按钮/勾选。
    const tagStart = indexHtml.lastIndexOf('<', disclosureStart);
    const tagEnd = indexHtml.indexOf('>', disclosureStart);
    const openTag = indexHtml.slice(tagStart, tagEnd + 1);
    expect(openTag.startsWith('<p')).toBe(true);
    expect(openTag).toContain('data-first-run-disclosure');
    expect(openTag).toContain('hidden');
    expect(openTag).toContain(`data-i18n="${KEY}"`);
    expect(openTag).not.toMatch(/<(?:input|button|select|textarea|label)/);
  });

  it('不新增 consent 开关 / 第二个模式控件', () => {
    expect(indexHtml).not.toMatch(/first-run-disclosure[\s\S]{0,200}type="checkbox"/);
    expect(indexHtml).not.toMatch(/data-i18n="provision\.firstRun\.disclosure\.(consent|agree)"/);
    expect(indexHtml.match(/id="first-run-disclosure"/g)).toHaveLength(1);
  });

  it('文案覆盖本机采集、宿主副本/同步、本地预取、allowRemote 与切回轻量', () => {
    for (const copy of [zh[KEY], en[KEY]]) {
      expect(typeof copy).toBe('string');
      expect(copy.length).toBeGreaterThan(40);
    }
    expect(zh[KEY]).toContain('本机');
    expect(zh[KEY]).toContain('远端 API');
    expect(zh[KEY]).toContain('轻量模式');
    expect(en[KEY]).toContain('this device');
    expect(en[KEY]).toContain('remote API');
    expect(en[KEY]).toContain('Lightweight');
  });
});

describe('首启披露：失败闭合与只出现一次', () => {
  it('仅在 firstRun.pending 时展示；缺失/版本非法都 fail closed', () => {
    const source = functionSource('renderFirstRunDisclosure', 'openOnboardCreate');
    expect(source).toContain('status?.firstRun');
    expect(source).toContain('firstRun?.pending === true');
    expect(source).toContain('Number.isInteger(version)');
    expect(source).toContain('firstRunDisclosure = null');
    expect(source).toContain('el.hidden = false');
  });

  it('披露未展示成功 → create/join 不带 ack 字段', () => {
    const submitStart = consoleJs.indexOf('async function submitOnboard(');
    const submitSource = consoleJs.slice(submitStart, submitStart + 4000);
    expect(submitSource).toContain('...(firstRunDisclosure');
    expect(submitSource).toContain('firstRunDisclosure: true');
    expect(submitSource).toContain('firstRunDisclosureVersion: firstRunDisclosure.version');
  });

  it('解锁后清除披露状态并隐藏，不重复出现', () => {
    const unlockStart = consoleJs.indexOf('async function unlockConsole(');
    const unlockSource = consoleJs.slice(unlockStart, unlockStart + 1200);
    expect(unlockSource).toContain('firstRunDisclosure = null');
    expect(unlockSource).toContain('firstRunEl.hidden = true');
    const coachStart = consoleJs.indexOf('function showOnboardingCoach(');
    const coachSource = consoleJs.slice(coachStart, coachStart + 1200);
    // pending 披露期间不自动淡出。
    expect(coachSource).toContain('if (firstRunDisclosure)');
  });
});
