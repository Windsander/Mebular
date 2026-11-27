// 0.4.0 W1b：唯一允许的 UI 增量——首启一次性披露。
//
// 源码/文案契约（不启浏览器）：
// - 披露只是说明，不是 consent：不新增页面、不新增开关/勾选、不改现有建新/加入流程；
// - 只在 `firstRun.pending === true` 展示；
// - ack 必须基于“当前确实可见”（DOM 布局/父层/样式），未可见不 ack → 不启用 immersive；
// - 披露成功后（marker done）不再出现；已有用户没有 pending 状态。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';
import {
  firstRunDisclosureAcknowledgement,
  isElementActuallyVisible,
} from '../../packages/console/first-run-disclosure.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const indexHtml = readFileSync(join(root, 'packages', 'console', 'index.html'), 'utf-8');
const consoleJs = readFileSync(join(root, 'packages', 'console', 'console.js'), 'utf-8');
const zh = JSON.parse(readFileSync(join(root, 'locales', 'zh-CN', 'console.json'), 'utf-8')).messages;
const en = JSON.parse(readFileSync(join(root, 'locales', 'en-US', 'console.json'), 'utf-8')).messages;

const KEY = 'provision.firstRun.disclosure.body';

function functionSource(name, nextName) {
  const start = consoleJs.indexOf(`function ${name}(`);
  let end = consoleJs.indexOf(`function ${nextName}(`, start);
  if (end < 0) end = consoleJs.indexOf(`const ${nextName} =`, start);
  return start >= 0 && end > start ? consoleJs.slice(start, end) : '';
}

// DOM 语义替身：hidden / getClientRects / computed style。
const visibleStyle = { display: 'block', visibility: 'visible' };
const element = (overrides = {}) => ({
  hidden: false,
  getClientRects: () => [{}],
  ...overrides,
});
const view = ({ elementStyle = visibleStyle, containerStyle = visibleStyle } = {}) => ({
  getComputedStyle: (node) => (node.kind === 'container' ? containerStyle : elementStyle),
});

describe('首启披露：位置与形态', () => {
  it('在现有首启引导内、建新/加入按钮上方，只有一个说明段落', () => {
    const disclosureStart = indexHtml.indexOf('id="first-run-disclosure"');
    const actions = indexHtml.indexOf('onboarding-coach-actions');
    expect(disclosureStart).toBeGreaterThan(-1);
    expect(actions).toBeGreaterThan(disclosureStart);
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

  it('文案完整覆盖本机/跨设备同步/宿主副本/local 预取/原始消息/远端 API/轻量', () => {
    const copy = zh[KEY];
    expect(typeof copy).toBe('string');
    for (const phrase of [
      '本机',
      '跨设备',
      '忆云同步',
      '其他设备',
      'OpenCode',
      'OpenChamber',
      'DSH',
      'Hermes',
      '宿主也可能保留自己的会话副本',
      '不读取宿主私有存储',
      'local 预取',
      '本机处理记忆',
      '会话细节',
      '原始消息',
      '显式允许',
      '远端 API',
      '轻量模式',
    ]) {
      expect(copy).toContain(phrase);
    }
    // 不能只用“默认本机”带过同步/宿主副本；三句必须都在同一披露里。
    expect(copy).toMatch(/记忆默认保存在本机/);
    expect(copy).toMatch(/同步到其他设备/);
    expect(copy).toMatch(/宿主.*会话副本/);
  });

  it('英文文案覆盖同样要点，且静态兜底与 zh-CN locale 一致', () => {
    const copy = en[KEY];
    for (const phrase of [
      'this device',
      'cross-device',
      'cloud sync',
      'other devices',
      'OpenCode',
      'OpenChamber',
      'DSH',
      'Hermes',
      'copies of sessions',
      'host private storage',
      'Local prefetching',
      'session details',
      'raw messages',
      'explicitly allow',
      'remote API',
      'Lightweight',
    ]) {
      expect(copy).toContain(phrase);
    }
    // index.html 的中文兜底必须与 locale 文案一致，避免两份披露漂移。
    expect(indexHtml).toContain(zh[KEY]);
  });
});

describe('首启披露：可见性判定（DOM 级）', () => {
  const ack = (overrides = {}) => firstRunDisclosureAcknowledgement({
    pending: true,
    disclosureVersion: 1,
    element: element(),
    container: element({ kind: 'container' }),
    view: view(),
    ...overrides,
  });

  it('元素 + 父层实际可见 → 返回 ack', () => {
    expect(isElementActuallyVisible(element(), element({ kind: 'container' }), view())).toBe(true);
    expect(ack()).toEqual({ version: 1 });
  });

  it('父层 hidden → 不 ack', () => {
    expect(ack({ container: element({ kind: 'container', hidden: true }) })).toBeNull();
  });

  it('元素 hidden / 无布局 rects → 不 ack', () => {
    expect(ack({ element: element({ hidden: true }) })).toBeNull();
    expect(ack({ element: element({ getClientRects: () => [] }) })).toBeNull();
  });

  it('元素或父层被 CSS 隐藏 → 不 ack', () => {
    expect(ack({ view: view({ elementStyle: { display: 'none', visibility: 'visible' } }) })).toBeNull();
    expect(ack({ view: view({ containerStyle: { display: 'block', visibility: 'hidden' } }) })).toBeNull();
    expect(ack({ view: view({ containerStyle: { display: 'block', visibility: 'visible', opacity: '0' } }) })).toBeNull();
  });

  it('非 pending / 版本缺失或非法 → 不 ack', () => {
    expect(ack({ pending: false })).toBeNull();
    expect(ack({ disclosureVersion: undefined })).toBeNull();
    expect(ack({ disclosureVersion: '1' })).toBeNull();
    expect(ack({ disclosureVersion: 0 })).toBeNull();
  });

  it('关闭/隐藏后不复用“曾经可见”的证据', () => {
    const el = element();
    const container = element({ kind: 'container' });
    expect(firstRunDisclosureAcknowledgement({
      pending: true,
      disclosureVersion: 1,
      element: el,
      container,
      view: view(),
    })).toEqual({ version: 1 });
    el.hidden = true;
    expect(firstRunDisclosureAcknowledgement({
      pending: true,
      disclosureVersion: 1,
      element: el,
      container,
      view: view(),
    })).toBeNull();
  });
});

describe('首启披露：失败闭合与只出现一次', () => {
  it('render 只负责展示内容；真实可见由 confirm 判定后才置 shown', () => {
    const renderSource = functionSource('renderFirstRunDisclosure', 'nextAnimationFrame');
    expect(renderSource).toContain('firstRun?.pending === true');
    expect(renderSource).toContain('el.hidden = false');
    expect(renderSource).not.toContain('firstRunDisclosure = {');
    const confirmStart = consoleJs.indexOf('async function confirmFirstRunDisclosureShown(');
    const confirmSource = consoleJs.slice(confirmStart, confirmStart + 1200);
    expect(confirmSource).toContain('firstRunDisclosureAcknowledgement');
    expect(confirmSource).toContain('element: $(\'#first-run-disclosure\')');
    expect(confirmSource).toContain('container: $(\'#onboarding-coach\')');
    expect(confirmSource).toContain('firstRunDisclosure = ack ?');
  });

  it('打开建新/加入时先捕获可见 ack，再收起 coach；关闭弹窗清空', () => {
    const createSource = functionSource('openOnboardCreate', 'closeOnboardCreate');
    expect(createSource.indexOf('firstRunDisclosureAck = firstRunDisclosure'))
      .toBeLessThan(createSource.indexOf('dismissOnboardingCoach()'));
    const joinSource = functionSource('openOnboardJoin', 'closeOnboardJoin');
    expect(joinSource.indexOf('firstRunDisclosureAck = firstRunDisclosure'))
      .toBeLessThan(joinSource.indexOf('dismissOnboardingCoach()'));
    expect(functionSource('closeOnboardCreate', 'openOnboardJoin')).toContain('firstRunDisclosureAck = null');
    expect(functionSource('closeOnboardJoin', 'unlockConsole')).toContain('firstRunDisclosureAck = null');
    expect(functionSource('dismissOnboardingCoach', 'renderFirstRunDisclosure'))
      .toContain('firstRunDisclosure = null');
  });

  it('未展示成功 → create/join 不带 ack 字段；解锁清空', () => {
    const submitStart = consoleJs.indexOf('async function submitOnboard(');
    const submitSource = consoleJs.slice(submitStart, submitStart + 4000);
    expect(submitSource).toContain('...(firstRunDisclosureAck');
    expect(submitSource).toContain('firstRunDisclosureVersion: firstRunDisclosureAck.version');
    const unlockStart = consoleJs.indexOf('async function unlockConsole(');
    const unlockSource = consoleJs.slice(unlockStart, unlockStart + 1500);
    expect(unlockSource).toContain('firstRunDisclosure = null');
    expect(unlockSource).toContain('firstRunDisclosureAck = null');
    expect(unlockSource).toContain('firstRunEl.hidden = true');
  });
});
