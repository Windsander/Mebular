// W-1/UX-2：一屏两段向导交互断言（纯逻辑 + 静态契约；不启 GUI、不引依赖）
//
// ① 状态机漏 provision 步（高-1）：daemonHealthy 但 provisionRequired → ① 不 done、current=start
// ② 完成态通关（高-2）：主 CTA「进入控制台 ✦」+ 两段折叠为回顾（可再展开）
// ③ 当前段高亮（中-3）：current → .is-current 契约；done 段 → ✓
// ④ 日志默认折叠（中-5）：<details> 无 open；异常（引导/未就绪）才自动展开 + 人话结论
// ⑤ UX-2 段① 子步骤流水：启动 → 写入初始设置 → 重启恢复；失败定位 + 从此处续跑
// ⑥ UX-2 段② 行级接入：「已接入 ✓」不自动翻段；「已完成」≥1 已接入才可用
// ⑦ UX-2 邀请移出引导：完成页只提一句；wizard 内不再出现邀请按钮

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeWizardState } from '../../apps/desktop/src/main/wizard.mjs';
import { installDecision } from '../../apps/desktop/src/main/wizard.mjs';
import { probeProvision } from '../../apps/desktop/src/main/daemon.mjs';
import { wizardView } from '../../apps/desktop/src/renderer/wizard-view.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '..', '..', 'apps', 'desktop', 'src', 'renderer');
const wizardHtml = readFileSync(join(rendererDir, 'wizard.html'), 'utf-8');
const wizardJs = readFileSync(join(rendererDir, 'wizard.js'), 'utf-8');

describe('W-1 ① 状态机：provision 步（引导/待重启不算完成启动）', () => {
  it('daemonHealthy + provisionRequired → ① 不 done、current=start（核心用例）', () => {
    const s = computeWizardState({ daemonHealthy: true, provisionRequired: true });
    expect(s.steps[0].done).toBe(false);
    expect(s.current).toBe('start');
    expect(s.complete).toBe(false);
  });

  it('provision 细节入 detail（provisioned 区分待建新 vs 待重启）', () => {
    const s = computeWizardState({ daemonHealthy: true, provisionRequired: true, provisioned: true });
    expect(s.steps[0].detail.provision).toEqual({ required: true, provisioned: true });
  });

  it('probeProvision：200+provision=true → required；404 → 正常态；异常 → 不阻断', async () => {
    const ok = await probeProvision(async () => ({ status: 200, ok: true, json: async () => ({ provision: true, provisioned: false }) }));
    expect(ok).toEqual({ required: true, provisioned: false });
    const done = await probeProvision(async () => ({ status: 200, ok: true, json: async () => ({ provision: true, provisioned: true }) }));
    expect(done).toEqual({ required: true, provisioned: true });
    const normal = await probeProvision(async () => ({ status: 404, ok: false }));
    expect(normal.required).toBe(false);
    const err = await probeProvision(async () => { throw new Error('ECONNREFUSED'); });
    expect(err.required).toBe(false);
  });

  it('回归：无 provision 入参时 daemonHealthy=true 仍判 done', () => {
    const s = computeWizardState({ daemonHealthy: true });
    expect(s.steps[0].done).toBe(true);
  });
});

describe('W-1/UX-2 ② 完成态：通关 CTA + 两段折叠为回顾', () => {
  const completeState = computeWizardState({
    daemonHealthy: true,
    assistants: { connectedCount: 1 },
    wizard: { assistantsAcked: true },
  });

  it('完成态视图含主 CTA「进入控制台」且两段全部折叠', () => {
    const view = wizardView(completeState);
    expect(view.complete).not.toBeNull();
    expect(view.complete.cta).toContain('进入控制台');
    expect(view.steps.every((s) => s.collapsed)).toBe(true);
  });

  it('未完成时不给通关 CTA、当前段不折叠', () => {
    const view = wizardView(computeWizardState({ daemonHealthy: true }));
    expect(view.complete).toBeNull();
    expect(view.steps.find((s) => s.id === 'assistants').collapsed).toBe(false);
  });

  it('静态契约：wizard.html 含 #complete-cta 主按钮挂载点（默认隐藏）+ 邀请提示一句', () => {
    expect(wizardHtml).toMatch(/id="complete-cta"[^>]*hidden|hidden[^>]*id="complete-cta"/);
    expect(wizardHtml).toMatch(/id="btn-enter-console"/);
    expect(wizardHtml).toMatch(/＋ 邀请新设备/);
  });
});

describe('W-1/UX-2 ③ 当前段高亮 / done 段收编（视图契约）', () => {
  it('当前段 status=current（→ .is-current），done 段 check=✓ 且降透明', () => {
    const view = wizardView(computeWizardState({ daemonHealthy: true }));
    const start = view.steps.find((s) => s.id === 'start');
    const assistants = view.steps.find((s) => s.id === 'assistants');
    expect(start.status).toBe('done');
    expect(start.check).toBe('✓');
    expect(assistants.status).toBe('current');
    expect(assistants.check).toBeNull();
  });

  it('徽章文案「第 N/2 步 · <名称>」（完成时「已就绪」）', () => {
    expect(wizardView(computeWizardState({ daemonHealthy: true })).badge).toBe('第 2/2 步 · 连接 AI 助手');
    expect(wizardView(computeWizardState({})).badge).toBe('第 1/2 步 · 一键开始');
    expect(wizardView(computeWizardState({ daemonHealthy: true, wizard: { assistantsAcked: true } })).badge).toBe('已就绪');
  });

  it('静态契约：样式含 .is-current（左边框 accent）与 .step.done 降透明', () => {
    expect(wizardHtml).toMatch(/\.step\.is-current[^}]*border-left/);
    expect(wizardHtml).toMatch(/\.step\.done[^}]*opacity/);
  });

  it('done 段按钮收编：「重启/仅启动」入「出问题了？」折叠区、常驻留次级 + 临时运行徽章', () => {
    const running = wizardView(computeWizardState({
      daemonHealthy: true,
      service: { registered: false, running: true },
    }));
    const start = running.steps.find((s) => s.id === 'start');
    expect(start.actions.restart.area).toBe('troubleshoot');
    expect(start.actions.startOnly.area).toBe('troubleshoot');
    expect(start.actions.install.hidden).toBe(false);
    expect(start.serviceBadge).toBe('临时运行');
    const registered = wizardView(computeWizardState({
      daemonHealthy: true,
      service: { registered: true, running: true },
    }));
    expect(registered.steps.find((s) => s.id === 'start').actions.install.hidden).toBe(true);
    expect(registered.steps.find((s) => s.id === 'start').serviceBadge).toBeNull();
  });

  it('静态契约：重启按钮位于「出问题了？」<details> 内', () => {
    expect(wizardHtml).toMatch(/<details[^>]*class="troubleshoot"[\s\S]*?btn-restart[\s\S]*?<\/details>/);
    expect(wizardHtml).toMatch(/出问题了？/);
  });
});

describe('W-1 ④ 日志区：默认折叠，异常才自动展开 + 人话结论', () => {
  it('静态契约：日志面板为 <details id="logs-panel"> 且默认无 open', () => {
    const tag = wizardHtml.match(/<details[^>]*id="logs-panel"[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag[0]).not.toMatch(/\bopen\b/);
  });

  it('一切正常 → logs.open=false 且无结论；引导态 → 自动展开 + 人话结论', () => {
    const ok = wizardView(computeWizardState({ daemonHealthy: true }));
    expect(ok.logs.open).toBe(false);
    expect(ok.logs.conclusion).toBeNull();
    const provision = wizardView(computeWizardState({ daemonHealthy: true, provisionRequired: true }));
    expect(provision.logs.open).toBe(true);
    expect(provision.logs.conclusion).toMatch(/初始设置|建新/);
    const down = wizardView(computeWizardState({ daemonHealthy: false }));
    expect(down.logs.open).toBe(true);
    expect(down.logs.conclusion).toMatch(/未运行|启动/);
  });
});

describe('UX-2 ⑤ 段① 一键开始：子步骤流水（启动 → 写入 → 重启恢复）', () => {
  it('视图模型：静态流水进度（健康 → launch done；待写入 → write active；待重启 → recover active）', () => {
    const fresh = wizardView(computeWizardState({}));
    expect(fresh.steps[0].flow).toEqual({ launch: 'todo', write: 'todo', recover: 'todo' });
    const healthy = wizardView(computeWizardState({ daemonHealthy: true }));
    expect(healthy.steps[0].flow).toEqual({ launch: 'done', write: 'done', recover: 'done' });
    const needWrite = wizardView(computeWizardState({ daemonHealthy: true, provisionRequired: true, provisioned: false }));
    expect(needWrite.steps[0].flow).toEqual({ launch: 'done', write: 'active', recover: 'todo' });
    const needRestart = wizardView(computeWizardState({ daemonHealthy: true, provisionRequired: true, provisioned: true }));
    expect(needRestart.steps[0].flow).toEqual({ launch: 'done', write: 'done', recover: 'active' });
  });

  it('静态契约：流水三子步骤 + 一键开始 + 从此处续跑 + 失败图标态', () => {
    for (const sub of ['data-sub="launch"', 'data-sub="write"', 'data-sub="recover"']) {
      expect(wizardHtml).toContain(sub);
    }
    expect(wizardHtml).toContain('id="btn-go"');
    expect(wizardHtml).toContain('id="btn-resume"');
    expect(wizardHtml).toMatch(/data-state="failed"/);
    expect(wizardJs).toContain('runFlow');
    expect(wizardJs).toContain('pollState');
    expect(wizardJs).toContain('failedSub');
  });

  it('回归：.flow 的 [hidden] 不被 display:grid 覆盖（未跑流水前流水面板必须真隐藏）', () => {
    expect(wizardHtml).toMatch(/\.flow\[hidden\][^{]*\{[^}]*display:\s*none/);
  });

  it('有界轮询：子步骤等待 ≤60s 上限（40 × 1.5s），超时即失败定位', () => {
    expect(wizardJs).toMatch(/for \(let i = 0; i < 40; i \+= 1\)/);
    expect(wizardJs).toMatch(/60s/);
  });
});

describe('UX-2 ⑥ 段② 行级接入 + 「已完成」显式确认', () => {
  it('「已接入 ✓」不自动翻段：connected≥1 仅解锁「已完成」；start 未完成先拦住', () => {
    const connected = wizardView(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 1, total: 7 } }));
    const assistants = connected.steps.find((s) => s.id === 'assistants');
    expect(assistants.doneEnabled).toBe(true);
    expect(assistants.status).toBe('current');
    expect(assistants.doneLabel).toBe('已完成');
    const zero = wizardView(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 0, total: 7 } }));
    expect(zero.steps.find((s) => s.id === 'assistants').doneEnabled).toBe(false);
    const blocked = wizardView(computeWizardState({ daemonHealthy: false, assistants: { connectedCount: 3 } }));
    expect(blocked.steps.find((s) => s.id === 'assistants').doneEnabled).toBe(false);
    expect(blocked.steps.find((s) => s.id === 'assistants').detailText).toContain('先完成第①步');
  });

  it('静态契约：行级接入行模板（名称+状态词+一个动作）+ ackAssistants 绑定', () => {
    expect(wizardHtml).toContain('id="asst-list"');
    expect(wizardHtml).toContain('id="btn-seg2-done"');
    expect(wizardJs).toContain('data-asst-act');
    expect(wizardJs).toContain('我已重载，重新验证');
    expect(wizardJs).toContain('ackAssistants');
    expect(wizardJs).toContain('clientsList');
    expect(wizardJs).toContain('clientsAction');
  });

  it('行状态词与设置 · AI 助手同一语言（未安装/未接入/待生效/已接入 ✓/需手动）', () => {
    for (const word of ['未安装', '未接入', '待生效', '已接入 ✓', '需手动']) {
      expect(wizardJs).toContain(word);
    }
  });
});

describe('UX-2 ⑦ 邀请移出引导（归控制台单动作页）', () => {
  it('wizard.html 不再出现邀请生成按钮 / QR 容器', () => {
    expect(wizardHtml).not.toContain('id="btn-invite"');
    expect(wizardHtml).not.toContain('id="qr"');
    expect(wizardHtml).not.toContain('id="step-device"');
  });

  it('渲染层不再消费邀请点击计划（inviteClickPlan 已随邀请一起移出）', () => {
    expect(wizardJs).not.toContain('inviteClickPlan');
    expect(wizardJs).not.toContain('createInvite');
  });
});

describe('W-1 ① 渲染层接线（provision CTA / ② 先完成第①步）', () => {
  it('引导态 → 段①给「去写入初始设置 →」CTA（openConsole），② 文案「先完成第①步」', () => {
    const view = wizardView(computeWizardState({ daemonHealthy: true, provisionRequired: true, provisioned: false }));
    const start = view.steps.find((s) => s.id === 'start');
    expect(start.actions.provision.hidden).toBe(false);
    expect(start.actions.provision.label).toContain('写入初始设置');
    expect(view.steps.find((s) => s.id === 'assistants').detailText).toContain('先完成第①步');
  });

  it('渲染层绑定契约：wizard.js 消费 wizardView / 应用 is-current / 驱动 complete-cta 与 logs 折叠', () => {
    expect(wizardJs).toMatch(/wizardView/);
    expect(wizardJs).toMatch(/is-current/);
    expect(wizardJs).toMatch(/complete-cta/);
    expect(wizardJs).toMatch(/logs-panel/);
  });

  it('星野舞台：canvas #sky + prefers-reduced-motion 静止降级', () => {
    expect(wizardHtml).toContain('id="sky"');
    expect(wizardJs).toContain('prefers-reduced-motion');
  });
});

// ---------------------------------------------------------------------------
// UX-2 收口 · 引导三连环修复（F1 不导航 / F2 安装按钮语义 / F3 不擅自离开向导 / F4 宽限窗）
// ---------------------------------------------------------------------------

const indexMjs = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'src', 'main', 'index.mjs'), 'utf-8');

describe('F1 向导流水不导航：daemon:start / daemon:restart 处理器去掉 showConsoleWithRetry', () => {
  it('daemon:start / daemon:restart 处理器与 restart() 本体均不含导航；托盘 confirmRestart 显式保留', () => {
    const startHandler = indexMjs.match(/'daemon:start':\s*async \(\) => \{[^}]*\}/)?.[0] ?? '';
    expect(startHandler).toContain('await ensure()');
    expect(startHandler).not.toContain('showConsoleWithRetry');
    const restartHandler = indexMjs.match(/'daemon:restart':\s*async \(\) => \{[^}]*\}/)?.[0] ?? '';
    expect(restartHandler).not.toContain('showConsoleWithRetry');
    const restartFn = indexMjs.match(/async function restart\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(restartFn).not.toContain('showConsoleWithRetry');
    expect(restartFn).not.toContain('safeLoad');
    // 托盘「重启」= 显式用户动作：行为不变（重启后落控制台）
    const confirmRestartFn = indexMjs.match(/async function confirmRestart\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(confirmRestartFn).toContain('await restart()');
    expect(confirmRestartFn).toContain('showConsoleWithRetry');
    // 导航仍只经显式通道：console:open 处理器在
    expect(indexMjs).toMatch(/'console:open':\s*async \(\) => \{[^}]*safeLoad/);
  });

  it('F3：向导流程内不自动打开控制台（write 子步只给显式按钮；导航点 = skip / 进入控制台 ✦ / 显式按钮）', () => {
    const runFlowFn = wizardJs.match(/async function runFlow[\s\S]*?\n\}/)?.[0] ?? '';
    expect(runFlowFn).not.toContain('openConsole');
    // 渲染层全部导航调用均为显式按钮绑定
    for (const m of wizardJs.matchAll(/api\.(openConsole|skipWizard|deepAssistants|deepDevice)\(\)/g)) {
      expect(['openConsole', 'skipWizard', 'deepAssistants', 'deepDevice']).toContain(m[1]);
    }
    expect(wizardJs).toMatch(/\$\('#btn-provision'\)\?\.addEventListener\('click', \(\) => \{ void api\.openConsole\(\); \}\)/);
    expect(wizardJs).toMatch(/\$\('#btn-enter-console'\)\?\.addEventListener\('click', \(\) => \{ void api\.openConsole\(\); \}\)/);
    expect(wizardJs).toMatch(/\$\('#btn-skip'\)\?\.addEventListener\('click', \(\) => \{ void api\.skipWizard\(\); \}\)/);
  });
});

describe('F2 安装按钮语义：三态 registered（false 才显示；未知/true 一律隐藏）+ 幂等', () => {
  it('registered=null（probe 失败/未知）→ 安装按钮隐藏、无「临时运行」徽章、文案中性', () => {
    const unknown = wizardView(computeWizardState({ daemonHealthy: true, service: { available: false } }));
    const start = unknown.steps.find((s) => s.id === 'start');
    expect(start.actions.install.hidden).toBe(true);
    expect(start.serviceBadge).toBeNull();
    expect(start.detailText).not.toContain('临时运行——');
  });

  it('registered=false → 显示「让 Mebular 常驻」+ 临时运行徽章；registered=true → 隐藏', () => {
    const unreg = wizardView(computeWizardState({ daemonHealthy: true, service: { registered: false, running: true } }));
    expect(unreg.steps.find((s) => s.id === 'start').actions.install.hidden).toBe(false);
    expect(unreg.steps.find((s) => s.id === 'start').serviceBadge).toBe('临时运行');
    const reg = wizardView(computeWizardState({ daemonHealthy: true, service: { registered: true, running: true } }));
    expect(reg.steps.find((s) => s.id === 'start').actions.install.hidden).toBe(true);
    expect(reg.steps.find((s) => s.id === 'start').detailText).toContain('常驻已装');
  });

  it('computeWizardState 保三态：undefined → null（不坍缩 false）；true/false 原样', () => {
    const s1 = computeWizardState({ daemonHealthy: true, service: { available: false } });
    expect(s1.steps[0].detail.registered).toBeNull();
    const s2 = computeWizardState({ daemonHealthy: true, service: { registered: true } });
    expect(s2.steps[0].detail.registered).toBe(true);
    const s3 = computeWizardState({ daemonHealthy: true, service: { registered: false } });
    expect(s3.steps[0].detail.registered).toBe(false);
  });

  it('service:install 幂等（静态契约 + 纯函数 installDecision）：已注册 → no-op 返回 already，不重装', () => {
    expect(installDecision({ registered: true, running: true })).toEqual({ action: 'noop', already: true });
    expect(installDecision({ registered: false })).toEqual({ action: 'install', already: false });
    expect(installDecision(null)).toEqual({ action: 'install', already: false });
    const fn = indexMjs.match(/async function installServiceDirect\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('serviceStatus');
    expect(fn).toContain('installDecision(status).already');
    expect(fn.indexOf('serviceStatus')).toBeLessThan(fn.indexOf('installService(descriptor'));
  });
});

describe('F4④ 宽限窗：重启/安装窗口内 ① 不翻回未完成（grace 呈现）', () => {
  it('state.grace + ① 暂不健康 → 过渡呈现：current 不报警、日志不自动展开、安装按钮「重启中…」禁用', () => {
    const state = computeWizardState({ daemonHealthy: false, service: { registered: true } });
    state.grace = true;
    const view = wizardView(state);
    const start = view.steps.find((s) => s.id === 'start');
    expect(view.logs.open).toBe(false); // 宽限窗内不算异常
    expect(view.logs.conclusion).toBeNull();
    expect(start.status).toBe('current');
    expect(start.detailText).toContain('重启生效中');
    expect(start.flow.launch).toBe('active');
    expect(start.actions.install.disabled).toBe(true);
    expect(start.actions.install.label).toBe('重启中…');
    expect(start.actions.go.hidden).toBe(true);
  });

  it('无 grace 时健康瞬断仍按未完成呈现（不减弱原语义）', () => {
    const view = wizardView(computeWizardState({ daemonHealthy: false, service: { registered: true } }));
    expect(view.logs.open).toBe(true);
    expect(view.steps.find((s) => s.id === 'start').status).toBe('current');
  });

  it('渲染层契约：安装/重启动作 arm 宽限窗；安装按钮进「重启中…」过渡并轮询恢复（≤60s）', () => {
    expect(wizardJs).toMatch(/function armGrace\(ms = 60000\)/);
    const installHandler = wizardJs.match(/\$\('#btn-install'\)\?\.addEventListener\('click', async \(\) => \{[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(installHandler).toContain('重启中…');
    expect(installHandler).toContain('armGrace()');
    expect(installHandler).toContain('res?.already');
    expect(installHandler).toContain('pollState');
    const restartHandler = wizardJs.match(/\$\('#btn-restart'\)\?\.addEventListener\('click', async \(\) => \{[^}]*\}\);/)?.[0] ?? '';
    expect(restartHandler).toContain('armGrace()');
    // refresh 注入 grace 标志（仅宽限窗内且未完成）
    expect(wizardJs).toMatch(/Date\.now\(\) < graceUntil[\s\S]{0,120}state\.grace = true/);
    // 渲染层按视图模型应用 disabled/label
    expect(wizardJs).toMatch(/btnInstall\.disabled = Boolean\(start\.actions\.install\.disabled\)/);
    expect(wizardJs).toMatch(/btnInstall\.textContent = start\.actions\.install\.label/);
  });
});

// ---------------------------------------------------------------------------
// UX-2 补丁 2 · 引导页按 01-setup 设计稿重做（hero/里程碑轨道/done-line/星野省电）
// ---------------------------------------------------------------------------

describe('设计稿 ① hero 与 tagline（随进度三段变化）', () => {
  it('未开始 →「点两下，把它接进你的日常。」；① done →「很好，再接一个助手就完成。」；完成 →「全部就绪。」', () => {
    expect(wizardView(computeWizardState({})).tagline).toBe('点两下，把它接进你的日常。');
    expect(wizardView(computeWizardState({ daemonHealthy: true })).tagline).toBe('很好，再接一个助手就完成。');
    expect(wizardView(computeWizardState({ daemonHealthy: true, wizard: { assistantsAcked: true } })).tagline).toBe('全部就绪。');
  });

  it('静态契约：hero 品牌区（✦ / MEBULAR / #tagline）+ 右下常驻「跳过引导 ›」+ 星野画布', () => {
    expect(wizardHtml).toContain('class="mark">✦<');
    expect(wizardHtml).toMatch(/<h1>MEBULAR<\/h1>/);
    expect(wizardHtml).toContain('id="tagline"');
    expect(wizardHtml).toContain('点两下，把它接进你的日常。');
    expect(wizardHtml).toContain('id="sky"');
    expect(wizardHtml).toMatch(/class="skip"[^>]*id="btn-skip"|id="btn-skip"[^>]*class="skip"/);
    expect(wizardHtml).toContain('跳过引导 ›');
  });
});

describe('设计稿 ② 里程碑轨道（左轨线 + 节点灯 active/done/locked）', () => {
  it('节点态：当前=active、完成=done、未到=locked（② 在 ① 未完成时 locked）', () => {
    const fresh = wizardView(computeWizardState({}));
    expect(fresh.steps.find((s) => s.id === 'start').node).toBe('active');
    expect(fresh.steps.find((s) => s.id === 'assistants').node).toBe('locked');
    const step2 = wizardView(computeWizardState({ daemonHealthy: true }));
    expect(step2.steps.find((s) => s.id === 'start').node).toBe('done');
    expect(step2.steps.find((s) => s.id === 'assistants').node).toBe('active');
    const done = wizardView(computeWizardState({ daemonHealthy: true, wizard: { assistantsAcked: true } }));
    expect(done.steps.every((s) => s.node === 'done')).toBe(true);
  });

  it('静态契约：轨道结构（.rail::before 轨线 + .pip 节点灯 + active 呼吸/done ✓/locked 暗）', () => {
    expect(wizardHtml).toMatch(/\.rail::before/);
    expect(wizardHtml).toContain('class="pip"');
    expect(wizardHtml).toMatch(/\.node\.active \.pip[^}]*animation/);
    expect(wizardHtml).toMatch(/\.node\.done \.pip::after[^}]*content:\s*"✓"/);
    expect(wizardHtml).toMatch(/\.node\.locked[^}]*opacity/);
  });

  it('渲染层契约：renderState 应用 active/locked 节点类 + done-line 文案填充', () => {
    expect(wizardJs).toMatch(/classList\.toggle\('active', step\.node === 'active'\)/);
    expect(wizardJs).toMatch(/classList\.toggle\('locked', step\.node === 'locked'\)/);
    expect(wizardJs).toMatch(/step\.doneLine\.main/);
    expect(wizardJs).toMatch(/tagline/);
  });
});

describe('设计稿 ③ done-line 回顾行与「先不接 ›」', () => {
  it('① done → doneLine「✓ 已就绪」；② done：已接好（≥1）/ 已跳过（0）两态', () => {
    const s = wizardView(computeWizardState({ daemonHealthy: true, service: { registered: true } }));
    expect(s.steps.find((x) => x.id === 'start').doneLine).toMatchObject({ main: '✓ 已就绪' });
    const connected = wizardView(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 2 }, wizard: { assistantsAcked: true } }));
    expect(connected.steps.find((x) => x.id === 'assistants').doneLine).toMatchObject({ main: '✓ 已接好' });
    const skipped = wizardView(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 0 }, wizard: { assistantsAcked: true } }));
    expect(skipped.steps.find((x) => x.id === 'assistants').doneLine).toMatchObject({ main: '— 已跳过' });
  });

  it('「先不接 ›」：① 完成后可见、与「已完成」同路 ack（显式确认才翻段）', () => {
    const view = wizardView(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 0, total: 3 } }));
    expect(view.steps.find((s) => s.id === 'assistants').skipConnect.hidden).toBe(false);
    const blocked = wizardView(computeWizardState({ daemonHealthy: false, assistants: { connectedCount: 0, total: 3 } }));
    expect(blocked.steps.find((s) => s.id === 'assistants').skipConnect.hidden).toBe(true);
    expect(wizardJs).toMatch(/#btn-seg2-skip'\)\?\.addEventListener\('click', async \(\) => \{[\s\S]{0,120}ackAssistants/);
  });

  it('静态契约：done-line 元素 ×2（折叠时显示）+ 「先不接 ›」挂载点', () => {
    expect(wizardHtml).toContain('id="start-done-line"');
    expect(wizardHtml).toContain('id="connect-done-line"');
    expect(wizardHtml).toMatch(/\.step\.is-collapsed \.done-line[^}]*display:\s*flex/);
    expect(wizardHtml).toContain('id="btn-seg2-skip"');
    expect(wizardHtml).toContain('先不接 ›');
  });
});

describe('设计稿 ④ 段② 文案与空态（以设计稿为准）', () => {
  it('检测到 N 个已装助手（含已接入计数）；空态不渲染「已完成」', () => {
    const view = wizardView(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 1, total: 3 } }));
    const a = view.steps.find((s) => s.id === 'assistants');
    expect(a.detailText).toBe('检测到 3 个已装助手（已接入 1 个）。点「接入」；都接好了点「已完成」。');
    expect(a.doneHint).toBe('还可以继续接其他助手');
    const zero = wizardView(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 0, total: 3 } }));
    expect(zero.steps.find((s) => s.id === 'assistants').doneHint).toBe('接好一个即可点「已完成」');
    const empty = wizardView(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 0, total: 0 } }));
    const ae = empty.steps.find((s) => s.id === 'assistants');
    expect(ae.detailText).toContain('没检测到已装的 AI 助手');
    expect(ae.doneHidden).toBe(true);
    expect(ae.doneHint).toBe('');
  });

  it('① 正文按设计稿（数据只存在这台机器上，不上云）；注脚/hint 静态契约', () => {
    const view = wizardView(computeWizardState({}));
    expect(view.steps.find((s) => s.id === 'start').detailText).toContain('数据只存在这台机器上，不上云');
    expect(wizardHtml).toContain('接入只改它的一条配置；重载对应助手后生效（可到 设置 → AI 助手 验证）。');
    expect(wizardHtml).toContain('id="done2-hint"');
    expect(wizardHtml).toContain('在这台机器上启动 Mebular 并完成初始设置。');
  });

  it('「或加入已有的 Mebular ›」：仅引导态显示、显式点击 openConsole', () => {
    const provision = wizardView(computeWizardState({ daemonHealthy: true, provisionRequired: true, provisioned: false }));
    expect(provision.steps.find((s) => s.id === 'start').actions.join.hidden).toBe(false);
    const normal = wizardView(computeWizardState({ daemonHealthy: true }));
    expect(normal.steps.find((s) => s.id === 'start').actions.join.hidden).toBe(true);
    expect(wizardJs).toMatch(/#alt-join'\)\?\.addEventListener\('click', \(\) => \{ void api\.openConsole\(\); \}\)/);
  });
});

describe('设计稿 ⑤ 完成时刻与已设置过·直达 + 星野省电纪律', () => {
  it('完成态 finish 暖收尾（.show 动画类 + 已就绪 ✦ + 控制台提一句邀请）', () => {
    expect(wizardHtml).toMatch(/class="finish"[^>]*id="complete-cta"|id="complete-cta"[^>]*class="finish"/);
    expect(wizardHtml).toContain('已就绪 ✦');
    expect(wizardHtml).toMatch(/\.finish\.show[^}]*opacity/);
    expect(wizardJs).toMatch(/cta\.classList\.toggle\('show'/);
    expect(wizardJs).toMatch(/提醒：重载 /);
  });

  it('已设置过·直达：首次即完成 → is-existing（欢迎回来替换轨道；跑完当场完成仍走 finish）', () => {
    expect(wizardHtml).toContain('id="existing"');
    expect(wizardHtml).toContain('欢迎回来');
    expect(wizardHtml).toMatch(/body\.is-existing \.rail[^}]*display:\s*none/);
    expect(wizardJs).toMatch(/if \(!firstSeen\)[\s\S]{0,160}is-existing/);
    expect(wizardJs).toContain('btn-enter-console-2');
  });

  it('星野省电纪律：仅可见时渲染、隐藏即停（visibilitychange + cancelAnimationFrame）；reduced-motion 静止', () => {
    expect(wizardJs).toContain("document.addEventListener('visibilitychange'");
    expect(wizardJs).toContain('cancelAnimationFrame');
    expect(wizardJs).toContain('document.visibilityState');
    expect(wizardJs).toContain("prefers-reduced-motion");
  });
});

describe('设计稿 ⑥ [hidden] 语义兜底（author display 不得覆盖 hidden）', () => {
  it('置末位的 [hidden]{display:none} 守卫 + 安装按钮初始 hidden（F2a 未知一律隐藏，无首屏闪现）', () => {
    expect(wizardHtml).toMatch(/\[hidden\] \{ display: none; \}/);
    expect(wizardHtml.indexOf('[hidden] { display: none; }')).toBeGreaterThan(wizardHtml.indexOf('.alt {'));
    expect(wizardHtml).toMatch(/id="btn-install"[^>]*hidden/);
  });
});

// ---------------------------------------------------------------------------
// UX-2 补丁 4 · 窗口外框 + 滚动条/滚动手感（desktop 侧契约）
// ---------------------------------------------------------------------------

const preloadCjs = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'src', 'preload', 'index.cjs'), 'utf-8');

describe('补丁 4 · 窗口外框（macOS hiddenInset 交通灯内嵌；Windows/Linux 保守）', () => {
  it('BrowserWindow：darwin → titleBarStyle hiddenInset；其他平台不带（条件展开）', () => {
    const cw = indexMjs.match(/function createWindow\(\) \{[\s\S]*?webPreferences/)?.[0] ?? '';
    expect(cw).toContain("process.platform === 'darwin'");
    expect(cw).toContain("titleBarStyle: 'hiddenInset'");
    expect(cw).not.toContain('frame: false'); // 不无框（保守）
  });

  it('preload 暴露静态 platform（渲染层避让交通灯安全区用；非函数不增攻击面）', () => {
    expect(preloadCjs).toContain('platform: process.platform');
  });

  it('向导拖拽区：hero 可拖 + 可点元素 no-drag（含右下「跳过引导 ›」）', () => {
    expect(wizardHtml).toMatch(/\.hero \{[^}]*-webkit-app-region: drag/);
    expect(wizardHtml).toMatch(/\.hero \.badge[^}]*no-drag/);
    expect(wizardHtml).toMatch(/\.skip \{[^}]*-webkit-app-region: no-drag/);
  });
});

describe('补丁 4 · 滚动条主题化 + 滚动手感（向导侧契约）', () => {
  it('向导 ::-webkit-scrollbar：细 10px / 透明轨道 / 契约色 thumb / hover 微亮 / corner 清理', () => {
    expect(wizardHtml).toMatch(/::-webkit-scrollbar \{[^}]*width: 10px/);
    expect(wizardHtml).toMatch(/::-webkit-scrollbar-track \{[^}]*transparent/);
    expect(wizardHtml).toMatch(/::-webkit-scrollbar-thumb \{[^}]*border-radius: 999px/);
    expect(wizardHtml).toMatch(/::-webkit-scrollbar-thumb:hover/);
    expect(wizardHtml).toMatch(/::-webkit-scrollbar-corner \{[^}]*transparent/);
  });

  it('向导长页 scrollbar-gutter: stable（滚动条出现/消失不跳变）', () => {
    expect(wizardHtml).toMatch(/html \{ scrollbar-gutter: stable/);
  });
});
