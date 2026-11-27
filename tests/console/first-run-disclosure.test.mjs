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
  bindFirstRunCoachActions,
  confirmFirstRunDisclosure,
  firstRunDisclosureAckFor,
  firstRunDisclosureAcknowledgement,
  firstRunDisclosureSubmitPayload,
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

describe('首启披露：generation / 在途 confirm 竞态', () => {
  const confirm = (overrides = {}) => confirmFirstRunDisclosure({
    pending: true,
    disclosureVersion: 1,
    generation: 1,
    currentGeneration: 1,
    element: element(),
    container: element({ kind: 'container' }),
    view: view(),
    ...overrides,
  });

  it('confirm 在途 → dismiss（generation 变化）→ 不产生 firstRunDisclosure', () => {
    expect(confirm()).toEqual({ version: 1, generation: 1 });
    // dismissOnboardingCoach() 会递增 generation；在途 confirm 完成时 generation 已过期。
    expect(confirm({ generation: 1, currentGeneration: 2 })).toBeNull();
  });

  it('先打开 create/join（generation 递增）再完成 confirm → 不产生 ack', () => {
    expect(confirm({ generation: 3, currentGeneration: 4 })).toBeNull();
    // 即使元素仍可见，也不能用旧 generation 置位。
    expect(confirm({ generation: 4, currentGeneration: 4 })).toEqual({ version: 1, generation: 4 });
  });

  it('关闭弹窗后重开：旧 ack 的 generation 过期 / 当前不可见 → 不复用', () => {
    const current = { version: 1, generation: 1 };
    const opts = {
      element: element(),
      container: element({ kind: 'container' }),
      view: view(),
    };
    expect(firstRunDisclosureAckFor({ current, currentGeneration: 1, ...opts }))
      .toEqual({ version: 1, generation: 1 });
    expect(firstRunDisclosureAckFor({ current, currentGeneration: 2, ...opts })).toBeNull();
    expect(firstRunDisclosureAckFor({ current: null, currentGeneration: 2, ...opts })).toBeNull();
    // 捕获瞬间父层隐藏也不接受。
    expect(firstRunDisclosureAckFor({
      current,
      currentGeneration: 1,
      element: element(),
      container: element({ kind: 'container', hidden: true }),
      view: view(),
    })).toBeNull();
  });

  it('父层隐藏 + confirm 在途 → 不 ack', () => {
    expect(confirm({ container: element({ kind: 'container', hidden: true }) })).toBeNull();
  });

  it('coach is-leaving / 非 pending → 不 ack', () => {
    expect(confirm({ coachLeaving: true })).toBeNull();
    expect(confirm({ pending: false })).toBeNull();
  });
});

// 最小 DOM：支持 click 冒泡 + closest + rects，用来跑真实 CTA 接线。
class FakeElement {
  constructor(name, className = '') {
    this.name = name;
    this.className = className;
    this.parent = null;
    this.hidden = false;
    this.listeners = new Map();
    this.getClientRects = () => [{}];
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  closest(selector) {
    if (selector !== '.onboarding-coach-actions') return null;
    if (String(this.className ?? '').split(/\s+/).includes('onboarding-coach-actions')) return this;
    return this.parent?.closest?.(selector) ?? null;
  }

  deliver(type, event) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
    if (!event.stopped) this.parent?.deliver?.(type, event);
  }

  dispatch(type = 'click') {
    const event = {
      target: this,
      stopped: false,
      stopPropagation() { this.stopped = true; },
    };
    this.deliver(type, event);
    return event;
  }

  click() { return this.dispatch('click'); }
}

function coachDom() {
  const coach = new FakeElement('coach', 'onboarding-coach');
  const actions = new FakeElement('actions', 'onboarding-coach-actions');
  actions.parent = coach;
  const create = new FakeElement('create');
  const join = new FakeElement('join');
  const dismiss = new FakeElement('dismiss');
  create.parent = actions;
  join.parent = actions;
  dismiss.parent = actions;
  const disclosure = new FakeElement('disclosure');
  disclosure.parent = coach;
  const title = new FakeElement('title');
  title.parent = coach;
  return { coach, actions, create, join, dismiss, disclosure, title };
}

describe('首启披露：真实 coach CTA 点击 / 冒泡路径', () => {
  const domWindow = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };

  const setup = ({ visible = true, generation = 1 } = {}) => {
    const dom = coachDom();
    dom.disclosure.hidden = !visible;
    const state = {
      generation,
      current: visible ? { version: 1, generation } : null,
      ack: null,
      opened: null,
      dismissCount: 0,
    };
    const capture = () => {
      state.ack = firstRunDisclosureAckFor({
        current: state.current,
        currentGeneration: state.generation,
        element: dom.disclosure,
        container: dom.coach,
        view: domWindow,
      });
    };
    const open = (kind) => {
      capture();
      // 生产 openOnboard*：捕获后 generation 递增，再 keepAck 收起 coach。
      state.generation += 1;
      state.current = null;
      state.opened = kind;
    };
    bindFirstRunCoachActions({
      coach: dom.coach,
      create: dom.create,
      join: dom.join,
      dismiss: dom.dismiss,
      openCreate: () => open('create'),
      openJoin: () => open('join'),
      onDismiss: () => {
        // 生产 dismissOnboardingCoach()：默认清空 ack + 作废 generation。
        state.dismissCount += 1;
        state.generation += 1;
        state.current = null;
        state.ack = null;
      },
    });
    return { dom, state };
  };

  it('点击 #coach-create：提交 body 带当前 firstRunDisclosure/version，冒泡不清空', () => {
    const { dom, state } = setup();
    dom.create.click();
    expect(state.opened).toBe('create');
    expect(state.ack).toEqual({ version: 1, generation: 1 });
    expect(firstRunDisclosureSubmitPayload(state.ack))
      .toEqual({ firstRunDisclosure: true, firstRunDisclosureVersion: 1 });
    // stopPropagation：容器不会二次 dismiss 清掉刚捕获的 ack。
    expect(state.dismissCount).toBe(0);
  });

  it('点击 #coach-join：同样带 ack，冒泡不清空', () => {
    const { dom, state } = setup();
    dom.join.click();
    expect(state.opened).toBe('join');
    expect(firstRunDisclosureSubmitPayload(state.ack))
      .toEqual({ firstRunDisclosure: true, firstRunDisclosureVersion: 1 });
    expect(state.dismissCount).toBe(0);
  });

  it('点击 #coach-dismiss：关闭清空 ack，重开不复用', () => {
    const { dom, state } = setup();
    state.ack = { version: 1, generation: 1 };
    dom.dismiss.click();
    expect(state.dismissCount).toBe(1);
    expect(state.ack).toBeNull();
    expect(firstRunDisclosureSubmitPayload(state.ack)).toEqual({});

    // 重开（disclosure 已不可见）：capture 得到 null，body 不带 ack。
    dom.create.click();
    expect(state.opened).toBe('create');
    expect(state.ack).toBeNull();
    expect(firstRunDisclosureSubmitPayload(state.ack)).toEqual({});
  });

  it('容器 action 区域点击被忽略；点说明文字仍关闭', () => {
    const { dom, state } = setup();
    dom.actions.click();
    expect(state.dismissCount).toBe(0);
    expect(state.ack).toBeNull();
    dom.title.click();
    expect(state.dismissCount).toBe(1);
    expect(state.ack).toBeNull();
  });

  it('披露不可见时点击 CTA：不带 ack', () => {
    const { dom, state } = setup({ visible: false });
    dom.create.click();
    expect(state.opened).toBe('create');
    expect(state.ack).toBeNull();
    expect(firstRunDisclosureSubmitPayload(state.ack)).toEqual({});
  });
});

describe('首启披露：失败闭合与只出现一次', () => {
  it('render 只负责展示内容；真实可见由 confirm 判定后才置 shown', () => {
    const renderSource = functionSource('renderFirstRunDisclosure', 'nextAnimationFrame');
    expect(renderSource).toContain('firstRun?.pending === true');
    expect(renderSource).toContain('el.hidden = false');
    expect(renderSource).toContain('firstRunDisclosureGeneration += 1');
    expect(renderSource).not.toContain('firstRunDisclosure = {');
    const confirmStart = consoleJs.indexOf('async function confirmFirstRunDisclosureShown(');
    const confirmSource = consoleJs.slice(confirmStart, confirmStart + 1600);
    expect(confirmSource).toContain('confirmFirstRunDisclosure({');
    expect(confirmSource).toContain('currentGeneration: firstRunDisclosureGeneration');
    expect(confirmSource).toContain("coach?.classList?.contains('is-leaving')");
    expect(confirmSource).toContain("element: $('#first-run-disclosure')");
    expect(confirmSource).toContain('container: coach');
    expect(confirmSource).toContain('if (generation !== firstRunDisclosureGeneration) return');
    expect(confirmSource).toContain('firstRunDisclosure = ack;');
  });

  it('打开建新/加入时先捕获可见 ack，再收起 coach；关闭弹窗清空', () => {
    const assertOpen = (source) => {
      const capture = source.indexOf('captureFirstRunDisclosureAck()');
      const bump = source.indexOf('firstRunDisclosureGeneration += 1');
      const dismiss = source.indexOf('dismissOnboardingCoach({ keepAck: true })');
      expect(capture).toBeGreaterThan(-1);
      expect(capture).toBeLessThan(bump);
      expect(bump).toBeLessThan(dismiss);
    };
    assertOpen(functionSource('openOnboardCreate', 'closeOnboardCreate'));
    assertOpen(functionSource('openOnboardJoin', 'closeOnboardJoin'));
    expect(functionSource('captureFirstRunDisclosureAck', 'openOnboardCreate'))
      .toContain('currentGeneration: firstRunDisclosureGeneration');
    expect(functionSource('closeOnboardCreate', 'openOnboardJoin')).toContain('firstRunDisclosureAck = null');
    expect(functionSource('closeOnboardJoin', 'unlockConsole')).toContain('firstRunDisclosureAck = null');
    const dismissSource = functionSource('dismissOnboardingCoach', 'renderFirstRunDisclosure');
    expect(dismissSource).toContain('firstRunDisclosureGeneration += 1');
    expect(dismissSource).toContain('firstRunDisclosure = null');
    expect(dismissSource).toContain('if (!keepAck) firstRunDisclosureAck = null');
  });

  it('真实 CTA 接线使用 bindFirstRunCoachActions，不再提前 dismiss', () => {
    expect(consoleJs).toContain('bindFirstRunCoachActions({');
    expect(consoleJs).not.toMatch(/\$\('#coach-create'\)\?\.addEventListener/);
    expect(consoleJs).not.toMatch(/\$\('#coach-join'\)\?\.addEventListener/);
    // 容器 click 不再无条件 dismiss；action buttons 由 CTA 自身 stopPropagation。
    expect(consoleJs).not.toMatch(/\$\('#onboarding-coach'\)\?\.addEventListener\('click'[\s\S]{0,80}dismissOnboardingCoach/);
  });

  it('render 清空旧 ack，避免复用上一轮证据', () => {
    const renderSource = functionSource('renderFirstRunDisclosure', 'nextAnimationFrame');
    expect(renderSource).toContain('firstRunDisclosureAck = null');
  });

  it('未展示成功 → create/join 不带 ack 字段；解锁清空', () => {
    const submitStart = consoleJs.indexOf('async function submitOnboard(');
    const submitSource = consoleJs.slice(submitStart, submitStart + 4000);
    expect(submitSource).toContain('...firstRunDisclosureSubmitPayload(firstRunDisclosureAck)');
    const unlockStart = consoleJs.indexOf('async function unlockConsole(');
    const unlockSource = consoleJs.slice(unlockStart, unlockStart + 1500);
    expect(unlockSource).toContain('firstRunDisclosureGeneration += 1');
    expect(unlockSource).toContain('firstRunDisclosure = null');
    expect(unlockSource).toContain('firstRunDisclosureAck = null');
    expect(unlockSource).toContain('firstRunEl.hidden = true');
  });
});
