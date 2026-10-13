// W-1：M2 三步向导交互修复断言（纯逻辑 + 静态契约；不启 GUI、不引依赖）
//
// ① 状态机漏 provision 步（高-1）：daemonHealthy 但 provisionRequired → ① 不 done、current=start
// ② 完成态通关（高-2）：主 CTA「进入控制台 ✦」+ 三步卡折叠为回顾
// ③ 当前步高亮（中-3）：current → .is-current 契约；done 步 → ✓
// ④ 日志默认折叠（中-5）：<details> 无 open；异常（引导/未就绪）才自动展开 + 人话结论
// ⑤ 邀请二次确认（小-7）：已有令牌再点 → confirm 标志位

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeWizardState } from '../../apps/desktop/src/main/wizard.mjs';
import { probeProvision } from '../../apps/desktop/src/main/daemon.mjs';
import { wizardView, inviteClickPlan } from '../../apps/desktop/src/renderer/wizard-view.mjs';

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

describe('W-1 ② 完成态：通关 CTA + 三步卡折叠为回顾', () => {
  const completeState = computeWizardState({
    daemonHealthy: true,
    assistants: { connectedCount: 1 },
    invite: { created: true },
  });

  it('完成态视图含主 CTA「进入控制台」且三步全部折叠', () => {
    const view = wizardView(completeState);
    expect(view.complete).not.toBeNull();
    expect(view.complete.cta).toContain('进入控制台');
    expect(view.steps.every((s) => s.collapsed)).toBe(true);
  });

  it('未完成时不给通关 CTA、当前步不折叠', () => {
    const view = wizardView(computeWizardState({ daemonHealthy: true }));
    expect(view.complete).toBeNull();
    expect(view.steps.find((s) => s.id === 'assistants').collapsed).toBe(false);
  });

  it('静态契约：wizard.html 含 #complete-cta 主按钮挂载点（默认隐藏）', () => {
    expect(wizardHtml).toMatch(/id="complete-cta"[^>]*hidden|hidden[^>]*id="complete-cta"/);
    expect(wizardHtml).toMatch(/id="btn-enter-console"/);
  });
});

describe('W-1 ③ 当前步高亮 / done 步收编（视图契约）', () => {
  it('当前步 status=current（→ .is-current），done 步 check=✓ 且降透明', () => {
    const view = wizardView(computeWizardState({ daemonHealthy: true }));
    const start = view.steps.find((s) => s.id === 'start');
    const assistants = view.steps.find((s) => s.id === 'assistants');
    expect(start.status).toBe('done');
    expect(start.check).toBe('✓');
    expect(assistants.status).toBe('current');
    expect(assistants.check).toBeNull();
  });

  it('徽章文案「第 N/3 步 · <名称>」（完成时「已就绪」）', () => {
    expect(wizardView(computeWizardState({ daemonHealthy: true })).badge).toBe('第 2/3 步 · 连接 AI 助手');
    expect(wizardView(computeWizardState({})).badge).toBe('第 1/3 步 · 启动 Mebular');
    expect(wizardView(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 1 }, invite: { created: true } })).badge).toBe('已就绪');
  });

  it('静态契约：样式含 .is-current（左边框 accent）与 .step.done 降透明', () => {
    expect(wizardHtml).toMatch(/\.step\.is-current[^}]*border-left/);
    expect(wizardHtml).toMatch(/\.step\.done[^}]*opacity/);
  });

  it('done 步按钮收编：「启动」禁用、「重启」入「出问题了？」折叠区、常驻留次级 + 临时运行徽章', () => {
    const running = wizardView(computeWizardState({
      daemonHealthy: true,
      service: { registered: false, running: true },
    }));
    const start = running.steps.find((s) => s.id === 'start');
    expect(start.actions.start.disabled).toBe(true);
    expect(start.actions.restart.area).toBe('troubleshoot');
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

describe('W-1 ⑤ 邀请：loading 禁用 + 已有令牌再点 → 二次确认（标志位）', () => {
  it('inviteClickPlan：无令牌直接生成；已有令牌 → confirm=true', () => {
    expect(inviteClickPlan({ hasToken: false })).toMatchObject({ confirm: false, busyLabel: '正在生成…' });
    expect(inviteClickPlan({ hasToken: true })).toMatchObject({ confirm: true, label: '重新生成邀请' });
  });
});

describe('W-1 ① 渲染层接线（provision CTA / ② 先完成第①步）', () => {
  it('引导态 → 步骤①给「建新/加入 →」CTA（openConsole），② 文案「先完成第①步」', () => {
    const view = wizardView(computeWizardState({ daemonHealthy: true, provisionRequired: true, provisioned: false }));
    const start = view.steps.find((s) => s.id === 'start');
    expect(start.actions.provision.hidden).toBe(false);
    expect(start.actions.provision.label).toContain('建新');
    expect(view.steps.find((s) => s.id === 'assistants').detailText).toContain('先完成第①步');
  });

  it('渲染层绑定契约：wizard.js 消费 wizardView / 应用 is-current / 驱动 complete-cta 与 logs 折叠', () => {
    expect(wizardJs).toMatch(/wizardView/);
    expect(wizardJs).toMatch(/is-current/);
    expect(wizardJs).toMatch(/complete-cta/);
    expect(wizardJs).toMatch(/logs-panel/);
  });
});
