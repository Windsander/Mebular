// W-1/UX-2：一屏两段向导交互断言（纯逻辑 + 静态契约；不启 GUI、不引依赖）
//
// ① 状态机（P4）：daemonHealthy 即 ① done——UNINITIALIZED 不再阻塞启动
// ② 完成态通关（高-2）：主 CTA「进入控制台 ✦」+ 两段折叠为回顾（可再展开）
// ③ 当前段高亮（中-3）：current → .is-current 契约；done 段 → ✓
// ④ 日志默认折叠（中-5）：<details> 无 open；异常（守护未运行）才自动展开 + 人话结论
// ⑤ P4 段① 两步流水：启动 → 自动接入；完成后一次 openConsole（无 write/recover/restart）
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
import { loadDesktopI18n } from '../../apps/desktop/src/main/i18n.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '..', '..', 'apps', 'desktop', 'src', 'renderer');
const wizardHtml = readFileSync(join(rendererDir, 'wizard.html'), 'utf-8');
const wizardJs = readFileSync(join(rendererDir, 'wizard.js'), 'utf-8');
const wizardViewSrc = readFileSync(join(rendererDir, 'wizard-view.mjs'), 'utf-8');
// 壳层文案唯一真源 = locales/zh-CN/desktop.json；视图模型显式接收 translator。
const zh = loadDesktopI18n({ localesDir: join(here, '..', '..', 'locales'), locale: 'zh-CN' });
const wizardViewT = (state) => wizardView(state, zh.t);

describe('P4 ① 状态机：daemonHealthy 即 start done（UNINITIALIZED 不阻塞）', () => {
  it('daemonHealthy + provisionRequired（UNINITIALIZED）→ ① done、current=assistants（核心用例）', () => {
    const s = computeWizardState({ daemonHealthy: true, provisionRequired: true });
    expect(s.steps[0].done).toBe(true);
    expect(s.current).toBe('assistants');
    expect(s.complete).toBe(false);
    expect(s.steps[0].detail.provision).toEqual({ required: true, provisioned: false });
  });

  it('provision 细节仅作诊断（provisioned 区分待建新 vs 已初始化），不影响 done', () => {
    const s = computeWizardState({ daemonHealthy: true, provisionRequired: true, provisioned: true });
    expect(s.steps[0].done).toBe(true);
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

describe('P4 一键启动 → 锁定控制台（UNINITIALIZED 可用；一次导航）', () => {
  it('UNINITIALIZED 不再阻塞向导：start done 只取决于 daemonHealthy', () => {
    for (const provisioned of [false, true]) {
      const s = computeWizardState({ daemonHealthy: true, provisionRequired: true, provisioned });
      expect(s.steps[0].done).toBe(true);
      expect(s.current).toBe('assistants');
    }
    expect(computeWizardState({ daemonHealthy: false, provisionRequired: true }).steps[0].done).toBe(false);
  });

  it('自动接入走 P2 受限 clients API：UNINITIALIZED 列表 / connect 均可用', () => {
    const fn = wizardJs.match(/async function autoConnectAll\([^)]*\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain('api.clientsList()');
    expect(fn).toMatch(/api\.clientsAction\(c\.id, 'connect'\)/);
    // P2 服务端契约（不改端点）：列表读面 + connect 动作在 UNINITIALIZED 开放
    const serveSrc = readFileSync(join(here, '..', '..', 'packages', 'mcp', 'src', 'serve.mjs'), 'utf-8');
    expect(serveSrc).toContain("path === '/admin/api/clients' && req.method === 'GET'");
    expect(serveSrc).toContain('const UNINITIALIZED_CLIENT_ACTION');
    expect(serveSrc).toContain('(connect|preview|verify|recheck)');
  });

  it('openConsole 恰好一次、无 location.reload、无 restart/write/recover', () => {
    expect(wizardJs.match(/api\.openConsole\(\)/g)).toHaveLength(1);
    expect(wizardJs).not.toContain('location.reload');
    expect(wizardJs).not.toContain('api.restart');
    expect(wizardJs).not.toContain("sub === 'write'");
    expect(wizardJs).not.toContain("sub === 'recover'");
  });
});

describe('W-1/UX-2 ② 完成态：通关 CTA + 两段折叠为回顾', () => {
  const completeState = computeWizardState({
    daemonHealthy: true,
    assistants: { connectedCount: 1 },
    wizard: { assistantsAcked: true },
  });

  it('完成态视图含主 CTA「进入控制台」且两段全部折叠', () => {
    const view = wizardViewT(completeState);
    expect(view.complete).not.toBeNull();
    expect(view.complete.cta).toContain('进入控制台');
    expect(view.steps.every((s) => s.collapsed)).toBe(true);
  });

  it('未完成时不给通关 CTA、当前段不折叠', () => {
    const view = wizardViewT(computeWizardState({ daemonHealthy: true }));
    expect(view.complete).toBeNull();
    expect(view.steps.find((s) => s.id === 'assistants').collapsed).toBe(false);
  });

  it('静态契约：wizard.html 含 #complete-cta 主按钮挂载点（默认隐藏）+ 邀请提示一句', () => {
    expect(wizardHtml).toMatch(/id="complete-cta"[^>]*hidden|hidden[^>]*id="complete-cta"/);
    expect(wizardHtml).toMatch(/id="btn-enter-console"/);
    expect(wizardHtml).toMatch(/＋ 邀请设备/);
  });
});

describe('W-1/UX-2 ③ 当前段高亮 / done 段收编（视图契约）', () => {
  it('当前段 status=current（→ .is-current），done 段 check=✓ 且降透明', () => {
    const view = wizardViewT(computeWizardState({ daemonHealthy: true }));
    const start = view.steps.find((s) => s.id === 'start');
    const assistants = view.steps.find((s) => s.id === 'assistants');
    expect(start.status).toBe('done');
    // h2 前置对勾退场（与 done-line「✓ 已就绪」重复；用户定调）——✓ 由回顾行表达
    expect(start.doneLine).toMatchObject({ main: '✓ 已就绪' });
    expect(assistants.status).toBe('current');
    expect(assistants.doneLine).toBeNull();
  });

  it('徽章文案「第 N/2 步 · <名称>」（完成时「已就绪」）', () => {
    expect(wizardViewT(computeWizardState({ daemonHealthy: true })).badge).toBe('第 2/2 步 · 连接 AI 助手');
    expect(wizardViewT(computeWizardState({})).badge).toBe('第 1/2 步 · 一键开始');
    expect(wizardViewT(computeWizardState({ daemonHealthy: true, wizard: { assistantsAcked: true } })).badge).toBe('已就绪');
  });

  it('静态契约（单面板）：无「蓝条/当前步边框」概念；唯一呼吸点 = 流水进行中圆点；面板提亮表达运行', () => {
    expect(wizardHtml).not.toMatch(/\.step\.is-current/);
    expect(wizardHtml).toMatch(/\.flow li\[data-state="active"\] i \{[^}]*animation: pulse/);
    expect(wizardHtml).toMatch(/\.flow li\[data-state="active"\] > i[^}]*box-shadow/);
  });

  it('done 段按钮收编（用户定稿去运维化）：常驻/重启/仅启动退出向导——入口归托盘与设置；保留 App 托管徽章', () => {
    const running = wizardViewT(computeWizardState({
      daemonHealthy: true,
      service: { registered: false, running: true },
    }));
    const start = running.steps.find((s) => s.id === 'start');
    expect(start.actions.install).toBeUndefined();
    expect(start.actions.restart).toBeUndefined();
    expect(start.actions.startOnly).toBeUndefined();
    expect(start.serviceBadge).toBe('App 托管');
    expect(start.detailText).toContain('退出 App 后停止');
    expect(start.detailText).toContain('想开机自启可让 Mebular 常驻');
    expect(wizardHtml).toMatch(/id="start-service-badge"[^>]*>App 托管<\/span>/);
    expect(wizardHtml).not.toContain('>临时运行</span>');
    const registered = wizardViewT(computeWizardState({
      daemonHealthy: true,
      service: { registered: true, running: true },
    }));
    expect(registered.steps.find((s) => s.id === 'start').serviceBadge).toBeNull();
  });

  it('静态契约（用户定稿）：向导无「出问题了？」运维折叠——重启/仅启动入口归托盘菜单', () => {
    expect(wizardHtml).not.toContain('出问题了');
    expect(wizardHtml).not.toContain('btn-restart');
    expect(wizardHtml).not.toContain('btn-start');
    expect(wizardHtml).not.toContain('troubleshoot');
  });
});

describe('W-1 ④ 日志区：默认折叠，异常才自动展开 + 人话结论', () => {
  it('静态契约：日志面板为 <details id="logs-panel"> 且默认无 open', () => {
    const tag = wizardHtml.match(/<details[^>]*id="logs-panel"[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag[0]).not.toMatch(/\bopen\b/);
  });

  it('一切正常 / UNINITIALIZED → logs.open=false 且无结论；守护未运行才自动展开 + 人话结论', () => {
    const ok = wizardViewT(computeWizardState({ daemonHealthy: true }));
    expect(ok.logs.open).toBe(false);
    expect(ok.logs.conclusion).toBeNull();
    // P4：UNINITIALIZED 是正常引导阶段，不再当异常
    const uninitialized = wizardViewT(computeWizardState({ daemonHealthy: true, provisionRequired: true }));
    expect(uninitialized.logs.open).toBe(false);
    expect(uninitialized.logs.conclusion).toBeNull();
    const down = wizardViewT(computeWizardState({ daemonHealthy: false }));
    expect(down.logs.open).toBe(true);
    expect(down.logs.conclusion).toMatch(/未运行|启动/);
  });
});

describe('P6A ⑤ 段① 一键开始：五步真实流水（启动 → 就绪 → 检查 → 接入 → 控制台）', () => {
  const allTodo = { launch: 'todo', ready: 'todo', probe: 'todo', connect: 'todo', console: 'todo' };
  it('视图模型：静态流水进度（健康 → 前3步 done；接入中 → connect active；已确认 → 全 done）', () => {
    const fresh = wizardViewT(computeWizardState({}));
    expect(fresh.steps[0].flow).toEqual(allTodo);
    const healthy = wizardViewT(computeWizardState({ daemonHealthy: true }));
    expect(healthy.steps[0].flow).toEqual({ ...allTodo, launch: 'done', ready: 'done', probe: 'done', connect: 'active' });
    const acked = wizardViewT(computeWizardState({ daemonHealthy: true, wizard: { assistantsAcked: true } }));
    expect(acked.steps[0].flow).toEqual({ launch: 'done', ready: 'done', probe: 'done', connect: 'done', console: 'done' });
    // P4：UNINITIALIZED 不改变流水进度（不再有 write/recover）
    const uninitialized = wizardViewT(computeWizardState({ daemonHealthy: true, provisionRequired: true }));
    expect(uninitialized.steps[0].flow).toEqual({ ...allTodo, launch: 'done', ready: 'done', probe: 'done', connect: 'active' });
  });

  it('静态契约：五条真实子步骤 + 一键开始 + 从此处续跑 + 失败图标态', () => {
    for (const sub of ['launch', 'ready', 'probe', 'connect', 'console']) {
      expect(wizardHtml).toContain(`data-sub="${sub}"`);
    }
    expect(wizardHtml).toContain('等待本机就绪');
    expect(wizardHtml).toContain('检查已装 AI 助手');
    expect(wizardHtml).toContain('接入 MCP 配置（自动）');
    expect(wizardHtml).toContain('打开控制台');
    expect(wizardHtml).not.toContain('data-sub="write"');
    expect(wizardHtml).not.toContain('data-sub="recover"');
    expect(wizardHtml).toContain('id="btn-go"');
    expect(wizardHtml).toContain('id="btn-resume"');
    expect(wizardHtml).toMatch(/data-state="failed"/);
  });

  it('运行层五步各自对应真实动作，且不伪造 0 个助手', () => {
    expect(wizardViewSrc).toMatch(/export const WIZARD_SUBSTEPS = \['launch', 'ready', 'probe', 'connect', 'console'\]/);
    expect(wizardJs).toMatch(/const SUBSTEPS = WIZARD_SUBSTEPS/);
    const runFlowFn = wizardJs.match(/async function runFlow[\s\S]*?\n\}/)?.[0] ?? '';
    for (const sub of ['launch', 'ready', 'probe', 'connect', 'console']) {
      expect(runFlowFn).toContain(`sub === '${sub}'`);
    }
    const order = [
      runFlowFn.indexOf('await api.start()'),
      runFlowFn.indexOf('await pollState('),
      runFlowFn.indexOf('await api.clientsList()'),
      runFlowFn.indexOf('await autoConnectAll('),
      runFlowFn.indexOf('await openConsoleOnce()'),
    ];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(runFlowFn).toContain("t('wizard.flowMsg.probeEmpty')");
    expect(runFlowFn).toContain("t('wizard.flowMsg.nothingToDo')");
    expect(runFlowFn).toMatch(/if \(!res\?\.ok\) throw new Error/);
  });

  it('回归：.flow 的 [hidden] 不被 display:grid 覆盖（未跑流水前流水面板必须真隐藏）', () => {
    expect(wizardHtml).toMatch(/\.flow\[hidden\][^{]*\{[^}]*display:\s*none/);
  });

  it('有界轮询：等待本机就绪 ≤60s 上限（40 × 1.5s），超时即失败定位', () => {
    expect(wizardJs).toMatch(/for \(let i = 0; i < 40; i \+= 1\)/);
    expect(wizardJs).toMatch(/60s/);
    const runFlowFn = wizardJs.match(/async function runFlow[\s\S]*?\n\}/)?.[0] ?? '';
    expect(runFlowFn).toMatch(/setSubState\(currentSub, 'failed'\)/);
    expect(runFlowFn).toContain('flow.failedSub = currentSub');
    expect(runFlowFn).toContain("$('#btn-resume').hidden = false");
    expect(wizardJs).toMatch(/runFlow\(flow\.failedSub \?\? 'launch'\)/);
  });
});

describe('UX-2 ⑥ 段② 行级接入 + 「已完成」显式确认', () => {
  it('自动化模型（用户定调）：② 无出口按钮；确认由「开始部署」流水尾统一执行（点过即确认）', () => {
    const partial = wizardViewT(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 1, total: 8, installedCount: 3 } }));
    const a = partial.steps.find((s) => s.id === 'assistants');
    expect(a.skipConnect).toBeUndefined();
    expect(a.detailText).toContain('点「开始部署」');
    expect(wizardJs).not.toContain('data-asst-act');
    expect(wizardJs).toMatch(/await api\.ackAssistants\(\)/); // 流水尾统一确认
    // start 未完成 → 拦住
    const blocked = wizardViewT(computeWizardState({ daemonHealthy: false, assistants: { connectedCount: 3, installedCount: 3 } }));
    expect(blocked.steps.find((s) => s.id === 'assistants').detailText).toContain('先完成第①步');
  });

  it('静态契约（单面板）：无行级清单 UI——接入归流水旁白；确认由流水尾执行', () => {
    expect(wizardHtml).not.toContain('id="asst-list"');
    expect(wizardHtml).not.toContain('data-asst-act');
    expect(wizardHtml).toContain('id="start-flow"');
    expect(wizardJs).toContain('ackAssistants');
    expect(wizardJs).toContain('clientsList');
    expect(wizardJs).toContain('clientsAction');
  });

  it('行状态词与设置 · AI 助手同一语言（未安装/未接入/待生效/已接入 ✓/需手动）', () => {
    // 状态词唯一真源 = packages/console/assistant-status.js 的 projectAssistantStatus（补丁 3 增补起两面共用）
    const statusSrc = readFileSync(join(here, '..', '..', 'packages', 'console', 'assistant-status.js'), 'utf-8');
    for (const word of ['未安装', '未接入', '待生效', '已接入 ✓', '需手动']) {
      expect(statusSrc).toContain(word);
    }
    // 补丁 3 新增同语言：接入失败 / 验证未过 / 写入中… / 验证中…
    for (const word of ['接入失败', '验证未过', '写入中…', '验证中…']) {
      expect(statusSrc).toContain(word);
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

describe('P4 渲染层接线（无 provision CTA；② 先完成第①步）', () => {
  it('UNINITIALIZED 健康 → 段①已完成且无 provision/join 动作；② 由 daemonHealthy 解锁', () => {
    const view = wizardViewT(computeWizardState({ daemonHealthy: true, provisionRequired: true, provisioned: false }));
    const start = view.steps.find((s) => s.id === 'start');
    expect(start.status).toBe('done');
    expect(start.actions.provision).toBeUndefined();
    expect(start.actions.join).toBeUndefined();
    expect(view.steps.find((s) => s.id === 'assistants').detailText).not.toContain('初始设置');
    const blocked = wizardViewT(computeWizardState({ daemonHealthy: false }));
    expect(blocked.steps.find((s) => s.id === 'assistants').detailText).toContain('先完成第①步');
  });

  it('渲染层绑定契约：wizard.js 消费 wizardView / 驱动单面板两态与 logs 折叠', () => {
    expect(wizardJs).toMatch(/wizardView/);
    expect(wizardJs).toMatch(/setText\('#start-detail'/);
    expect(wizardJs).toMatch(/complete-cta/);
    expect(wizardJs).toMatch(/logs-panel/);
    expect(wizardJs).toMatch(/panel\.hidden = !\(deployView \|\| doneView\)/); // 完成态步骤框保留
  });

  it('星野舞台：canvas #sky + prefers-reduced-motion 静止降级', () => {
    expect(wizardHtml).toContain('id="sky"');
    expect(wizardJs).toContain('prefers-reduced-motion');
  });
});

// ---------------------------------------------------------------------------
// UX-2 收口 · 引导修复（F1 守护动作不导航 / F2 安装语义；P4：流水结束一次显式导航）
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
    // 导航仍只经显式通道：console:open 走原地导航（console 已加载不 loadURL）
    expect(indexMjs).toMatch(/'console:open':\s*async \(\) => \{[^}]*navigateConsole\('map'\)/);
  });

  it('P4：流水结束自动打开控制台一次（不再等待初始设置）；无 write/recover/restart', () => {
    const runFlowFn = wizardJs.match(/async function runFlow[\s\S]*?\n\}/)?.[0] ?? '';
    expect(runFlowFn).toContain('openConsoleOnce');
    expect(runFlowFn).not.toMatch(/\bsub === 'write'/);
    expect(runFlowFn).not.toMatch(/\bsub === 'recover'/);
    expect(runFlowFn).not.toContain('api.restart');
    expect(wizardJs).not.toContain('api.restart');
    expect(wizardJs).not.toContain('location.reload');
    // openConsole 只有一个调用点（helper 内），自动流程 / 完成 CTA 复用 → 实际最多一次
    expect(wizardJs.match(/api\.openConsole\(\)/g)).toHaveLength(1);
    // 导航仍只经显式通道：跳过 / 进入控制台（复用一次性 helper）
    expect(wizardJs).toMatch(/\$\('#btn-enter-console'\)\?\.addEventListener\('click', \(\) => \{ void openConsoleOnce\(\); \}\)/);
    expect(wizardJs).toMatch(/\$\('#btn-skip'\)\?\.addEventListener\('click', \(\) => \{ void api\.skipWizard\(\); \}\)/);
    expect(wizardJs).not.toContain('#btn-provision');
  });
});

describe('F2 常驻语义：三态 registered（徽章/文案；安装入口已退出向导——归托盘/设置）+ 幂等', () => {
  it('registered=null（probe 失败/未知）→ 无「App 托管」徽章、文案中性；向导不再提供安装动作', () => {
    const unknown = wizardViewT(computeWizardState({ daemonHealthy: true, service: { available: false } }));
    const start = unknown.steps.find((s) => s.id === 'start');
    expect(start.actions.install).toBeUndefined();
    expect(start.serviceBadge).toBeNull();
    expect(start.detailText).not.toContain('App 托管');
    expect(start.detailText).toContain('常驻状态读取中或不可用');
  });

  it('registered=false → App 托管徽章（安装入口归托盘/设置）；registered=true → 常驻已装', () => {
    const unreg = wizardViewT(computeWizardState({ daemonHealthy: true, service: { registered: false, running: true } }));
    const unregStart = unreg.steps.find((s) => s.id === 'start');
    expect(unregStart.serviceBadge).toBe('App 托管');
    expect(unregStart.detailText).toBe('守护运行中（App 托管）：退出 App 后停止；想开机自启可让 Mebular 常驻。');
    expect(unregStart.actions.install).toBeUndefined();
    const reg = wizardViewT(computeWizardState({ daemonHealthy: true, service: { registered: true, running: true } }));
    expect(reg.steps.find((s) => s.id === 'start').serviceBadge).toBeNull();
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
    expect(fn).toContain('appServiceFallbackBlock');
    expect(fn.indexOf('serviceStatus')).toBeLessThan(fn.indexOf('installLegacyAppService'));
  });
});

describe('P4 去 write/recover/restart：向导不再等待初始设置或重启', () => {
  it('渲染层契约：流水五步（launch/ready/probe/connect/console）；无 armGrace/recover/restart', () => {
    expect(wizardJs).toMatch(/const SUBSTEPS = WIZARD_SUBSTEPS/);
    expect(wizardViewSrc).toMatch(/export const WIZARD_SUBSTEPS = \['launch', 'ready', 'probe', 'connect', 'console'\]/);
    expect(wizardJs).not.toContain('armGrace');
    expect(wizardJs).not.toContain('graceUntil');
    expect(wizardJs).not.toContain("sub === 'recover'");
    expect(wizardJs).not.toContain('api.restart');
    expect(wizardJs).toMatch(/await api\.start\(\)/);
    expect(wizardJs).toContain('autoConnectAll');
    expect(wizardJs).toContain('openConsoleOnce');
  });

  it('静态契约：HTML 无 write/recover 子步骤、无 provision/join 动作，保留续跑与进入控制台', () => {
    expect(wizardHtml).not.toContain('data-sub="write"');
    expect(wizardHtml).not.toContain('data-sub="recover"');
    expect(wizardHtml).not.toContain('id="btn-provision"');
    expect(wizardHtml).not.toContain('alt-join');
    expect(wizardHtml).not.toContain('去写入初始设置');
    expect(wizardHtml).not.toContain('加入已有忆云');
    expect(wizardHtml).toContain('id="btn-resume"');
    expect(wizardHtml).toContain('id="btn-enter-console"');
  });
});

// ---------------------------------------------------------------------------
// UX-2 补丁 2 · 引导页按 01-setup 设计稿重做（hero/里程碑轨道/done-line/星野省电）
// ---------------------------------------------------------------------------

describe('设计稿 ① hero 与 tagline（随进度三段变化）', () => {
  it('tagline 三态（用户定稿）：未开始「点一下，接入设备」→ 接入中「正在接入 AI 助手…」→ 完成留白（缩略卡说话）', () => {
    expect(wizardViewT(computeWizardState({})).tagline).toBe('点一下，接入设备');
    expect(wizardViewT(computeWizardState({ daemonHealthy: true })).tagline).toBe('正在接入 AI 助手…');
    expect(wizardViewT(computeWizardState({ daemonHealthy: true, wizard: { assistantsAcked: true } })).tagline).toBe('');
  });

  it('静态契约：hero 品牌区（✦ / MEBULAR / #tagline）+ 右下常驻「跳过引导 ›」+ 星野画布', () => {
    expect(wizardHtml).toContain('class="mark">✦<');
    expect(wizardHtml).toMatch(/<h1>MEBULAR<\/h1>/);
    expect(wizardHtml).toContain('id="tagline"');
    expect(wizardHtml).toContain('点一下，接入设备');
    expect(wizardHtml).toContain('id="sky"');
    expect(wizardHtml).toMatch(/class="skip"[^>]*id="btn-skip"|id="btn-skip"[^>]*class="skip"/);
    expect(wizardHtml).toContain('跳过引导 ›');
    expect(wizardHtml).toMatch(/\.hero \{[^}]*-webkit-app-region: drag/);
    expect(wizardHtml).not.toMatch(/\.hero \.mark \{[^}]*animation/);
  });
});

describe('设计稿 ② 里程碑轨道（左轨线 + 节点灯 active/done/locked）', () => {
  it('节点态：当前=active、完成=done、未到=locked（② 在 ① 未完成时 locked）', () => {
    const fresh = wizardViewT(computeWizardState({}));
    expect(fresh.steps.find((s) => s.id === 'start').node).toBe('active');
    expect(fresh.steps.find((s) => s.id === 'assistants').node).toBe('locked');
    const step2 = wizardViewT(computeWizardState({ daemonHealthy: true }));
    expect(step2.steps.find((s) => s.id === 'start').node).toBe('done');
    expect(step2.steps.find((s) => s.id === 'assistants').node).toBe('active');
    const done = wizardViewT(computeWizardState({ daemonHealthy: true, wizard: { assistantsAcked: true } }));
    expect(done.steps.every((s) => s.node === 'done')).toBe(true);
  });

  it('静态契约（单面板）：rail/pip 里程碑退场——一块面板讲完整个部署故事', () => {
    expect(wizardHtml).not.toContain('class="rail"');
    expect(wizardHtml).not.toContain('class="pip"');
    expect(wizardHtml).not.toContain('.rail::before');
    expect(wizardHtml).toContain('id="deploy-panel"');
    expect(wizardHtml).toContain('id="start-flow"');
  });

  it('渲染层契约（三态·用户定稿）：is-idle 居中 → 部署阶段框 → 完成缩略卡（含 CTA）', () => {
    expect(wizardJs).toMatch(/const deployView = flow\.running \|\| \(!complete && flow\.everRan\)/);
    expect(wizardJs).toMatch(/const doneView = !deployView && complete && flow\.everRan/);
    expect(wizardJs).toMatch(/classList\.toggle\('is-idle', idleView\)/);
    expect(wizardJs).toMatch(/idleCta\.hidden = !idleView/);
    expect(wizardJs).toMatch(/panel\.hidden = !\(deployView \|\| doneView\)/); // 完成态：阶段框简述保留
    expect(wizardJs).toMatch(/cta\.hidden = !doneView/);
  });
});

describe('设计稿 ③ done-line 回顾行与「先不接 ›」', () => {
  it('① done → doneLine「✓ 已就绪」；② done：已接好（≥1）/ 已跳过（0）两态', () => {
    const s = wizardViewT(computeWizardState({ daemonHealthy: true, service: { registered: true } }));
    expect(s.steps.find((x) => x.id === 'start').doneLine).toMatchObject({ main: '✓ 已就绪' });
    const connected = wizardViewT(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 2 }, wizard: { assistantsAcked: true } }));
    expect(connected.steps.find((x) => x.id === 'assistants').doneLine).toMatchObject({ main: '✓ 已接好' });
    const skipped = wizardViewT(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 0 }, wizard: { assistantsAcked: true } }));
    expect(skipped.steps.find((x) => x.id === 'assistants').doneLine).toMatchObject({ main: '— 无需接入' });
  });

  it('「先不接 ›」退场（自动化模型）：② 零出口按钮——文案承担指引', () => {
    // ② 零按钮模型：无「先不接」出口（用户定调）——文案承担指引
    expect(wizardHtml).not.toContain('先不接');
    const blocked = wizardViewT(computeWizardState({ daemonHealthy: false, assistants: { connectedCount: 0, total: 3 } }));
    expect(blocked.steps.find((s) => s.id === 'assistants').detailText).toContain('先完成第①步');
  });

  it('静态契约：done-line/折叠回顾已随单面板退场；② 零按钮', () => {
    expect(wizardHtml).not.toContain('done-line');
    expect(wizardHtml).not.toContain('is-collapsed');
    expect(wizardHtml).not.toContain('先不接 ›');
  });
});

describe('设计稿 ④ 段② 文案与空态（以设计稿为准）', () => {
  it('检测到 N 个已装助手（含已接入计数）；文案指引「开始部署」', () => {
    const view = wizardViewT(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 1, total: 3 } }));
    const a = view.steps.find((s) => s.id === 'assistants');
    expect(a.detailText).toBe('检测到 3 个已装助手（已接入 1 个）——点「开始部署」接上；未成功的会在下方给出原因。');
    expect(a.skipConnect).toBeUndefined();
    const zero = wizardViewT(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 0, total: 3, installedCount: 3 } }));
    expect(zero.steps.find((s) => s.id === 'assistants').detailText).toContain('点「开始部署」');
    const empty = wizardViewT(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 0, total: 0 } }));
    const ae = empty.steps.find((s) => s.id === 'assistants');
    expect(ae.detailText).toContain('没检测到已装的 AI 助手');
    expect(ae.skipConnect).toBeUndefined();
  });

  it('（三态修订）初始态仅「开始部署」一个按钮；隐私文案随面板退场（不再上屏）', () => {
    expect(wizardHtml).toContain('开始部署');
    expect(wizardHtml).toContain('id="idle-cta"');
    expect(wizardHtml).not.toContain('id="assist-note"');
  });

  it('P4：向导不再出现「去写入初始设置 / 加入已有忆云」入口（建新/加入归控制台弹框）', () => {
    const uninitialized = wizardViewT(computeWizardState({ daemonHealthy: true, provisionRequired: true, provisioned: false }));
    const start = uninitialized.steps.find((s) => s.id === 'start');
    expect(start.actions.provision).toBeUndefined();
    expect(start.actions.join).toBeUndefined();
    expect(start.actions.go).toBeDefined();
    expect(wizardJs).not.toContain('btn-provision');
    expect(wizardJs).not.toContain('alt-join');
    expect(wizardHtml).not.toContain('btn-provision');
    expect(wizardHtml).not.toContain('alt-join');
    expect(wizardHtml).not.toContain('或加入已有忆云');
  });
});

describe('设计稿 ⑤ 完成时刻与已设置过·直达 + 星野省电纪律', () => {
  it('完成态 = 同框变身（用户定稿 2：已就绪 ✦ + 提醒 + 进入控制台 ✦ 内嵌于部署卡片）；无旧 finish 动画类', () => {
    const panel = wizardHtml.match(/<section class="panel" id="deploy-panel"[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(panel).toContain('id="deploy-flow"');
    expect(panel).toMatch(/class="done-card" id="complete-cta"/);
    expect(wizardHtml).toContain('已就绪 ✦');
    expect(wizardHtml).toContain('＋ 邀请设备');
    expect(wizardHtml).not.toContain('.finish');
    expect(wizardJs).toContain("t('wizard.complete.restartNotice'");
    expect(wizardJs).toContain("t('wizard.complete.note.line1')");
  });

  it('外开已完成机器 → 引导首页（重启向导=从头走，部署幂等）；欢迎回来变体已退场', () => {
    expect(wizardHtml).not.toContain('欢迎回来');
    expect(wizardHtml).not.toContain('id="existing"');
    expect(wizardJs).not.toContain('is-existing');
    expect(wizardJs).not.toContain('firstSeen');
    // 三态裁决：仅「本次会话刚完成」才走完成简述；其余（含外开完成机）回引导首页
    expect(wizardJs).toMatch(/const doneView = !deployView && complete && flow\.everRan/);
    expect(wizardJs).toMatch(/const idleView = !deployView && !doneView/);
  });

  it('星野省电纪律：仅可见时渲染、隐藏即停（visibilitychange + cancelAnimationFrame）；reduced-motion 静止', () => {
    expect(wizardJs).toContain("document.addEventListener('visibilitychange'");
    expect(wizardJs).toContain('cancelAnimationFrame');
    expect(wizardJs).toContain('document.visibilityState');
    expect(wizardJs).toContain("prefers-reduced-motion");
  });
});

describe('设计稿 ⑥ [hidden] 语义兜底（author display 不得覆盖 hidden）', () => {
  it('置末位的 [hidden]{display:none} 守卫（author display 不得覆盖 hidden）', () => {
    expect(wizardHtml).toMatch(/\[hidden\] \{ display: none; \}/);
    expect(wizardHtml.lastIndexOf('[hidden] { display: none; }')).toBeGreaterThan(wizardHtml.lastIndexOf('details {'));
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
    expect(cw).toContain('trafficLightPosition: { x: 12, y: 20 }'); // 走查：灯与顶栏内容同线（顶栏 56 → 中线 28）
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
// UX-2 补丁 3：接入反馈语义 + 瞬态容忍
// ---------------------------------------------------------------------------

import { flapGate, wizardRowStatus } from '../../apps/desktop/src/renderer/wizard-view.mjs';

describe('补丁 3 · 瞬态容忍（flapGate）：连续 ≥2 次 miss 才翻回未完成', () => {
  it('单次 miss → hold（UI 不动）；连续第二次 miss → 翻回；恢复立即 done', () => {
    // 已就绪基线
    let g = flapGate({ lastDone: true, done: true, misses: 0 });
    expect(g).toEqual({ hold: false, misses: 0, lastDone: true });
    // 单次 miss：hold，不翻
    g = flapGate({ lastDone: true, done: false, misses: 0 });
    expect(g).toEqual({ hold: true, misses: 1, lastDone: true });
    // 连续第二次 miss：翻回未完成
    g = flapGate({ lastDone: true, done: false, misses: 1 });
    expect(g).toEqual({ hold: false, misses: 2, lastDone: false });
    // 恢复：立即回到 done（无额外延迟，计数清零）
    g = flapGate({ lastDone: false, done: true, misses: 2 });
    expect(g).toEqual({ hold: false, misses: 0, lastDone: true });
    // 本来就未完成：misses 不累计、正常呈现（不 hold）
    g = flapGate({ lastDone: false, done: false, misses: 0 });
    expect(g).toEqual({ hold: false, misses: 0, lastDone: false });
  });

  it('渲染层接线：refresh 经 flapGate 判定，hold 时跳过渲染（不翻段、不动日志）', () => {
    expect(wizardJs).toMatch(/flapGate\(\{[\s\S]{0,120}lastDone/);
    expect(wizardJs).toMatch(/if \(gate\.hold\) return/);
    expect(wizardJs).toMatch(/healthMisses = gate\.misses/);
  });
});

describe('补丁 3 · 行状态机（wizardRowStatus → 共享 helper projectAssistantStatus）：在途 > 失败 > verify 真值 > 服务端真值', () => {
  const base = { id: 'x', installed: true, connected: false, state: 'not-connected' };
  const connected = { id: 'x', installed: true, connected: true, state: 'connected' };
  it('在途 busy →「写入中…/验证中…」+ busy 标志（渲染层据此禁用按钮）', () => {
    expect(wizardRowStatus(base, { busy: { x: 'connect' } })).toMatchObject({ key: 'busy', label: '写入中…', busy: true });
    expect(wizardRowStatus(base, { busy: { x: 'verify' } })).toMatchObject({ key: 'busy', label: '验证中…', busy: true });
  });

  it('失败语义：connect 失败 →「接入失败」；verify 失败 →「验证未过」；均不得落入「待生效」', () => {
    expect(wizardRowStatus(base, { failed: { x: { kind: 'connect', reason: '写入失败已回滚' } } })).toMatchObject({ key: 'connect-failed', label: '接入失败' });
    expect(wizardRowStatus(base, { failed: { x: { kind: 'verify' } } })).toMatchObject({ key: 'verify-failed', label: '验证未过' });
    // 防御：failed 与 hint 同时存在时失败优先
    expect(wizardRowStatus(connected, { failed: { x: { kind: 'connect' } }, pending: new Set(['x']) }).label).not.toBe('待生效');
  });

  it('补丁 3 增补 · 状态一致性：服务端 connected → 「已接入 ✓」（hint 只进提示层，永不覆盖状态词）', () => {
    // 用户真机事故回归：写入后服务端已 connected，UI 不得显示「待生效」
    const st = wizardRowStatus(connected, { pending: new Set(['x']) });
    expect(st).toMatchObject({ key: 'connected', label: '已接入 ✓', reloadHint: true });
    expect(st.label).not.toBe('待生效');
    // 「待生效」唯一来源 = 服务端 verify pending-restart
    expect(wizardRowStatus(connected, { verifyStates: { x: 'pending-restart' } })).toMatchObject({ key: 'pending-reload', label: '待生效' });
    // hint 在 not-connected 时不成立（配置不在 → 无提醒）
    expect(wizardRowStatus(base, { pending: new Set(['x']) })).toMatchObject({ key: 'not-connected', label: '未接入', reloadHint: false });
  });

  it('原语义保留：connected → 已接入 ✓；manual/not-installed 不变', () => {
    expect(wizardRowStatus(connected, {})).toMatchObject({ key: 'connected', label: '已接入 ✓' });
    expect(wizardRowStatus({ id: 'm', needsManual: true }, {})).toMatchObject({ key: 'manual', label: '需手动' });
    expect(wizardRowStatus({ id: 'n', installed: false, state: 'not-installed' }, {})).toMatchObject({ key: 'not-installed', label: '未安装' });
  });

  it('渲染层契约（自动化模型·旁白式）：接入进度一次只报当前一个；失败非阻断并入汇总', () => {
    const fn = wizardJs.match(/async function autoConnectAll\([^)]*\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toContain("t('wizard.flowMsg.connectingOne', { name: c.name, index: i + 1, total: targets.length })");
    expect(fn).toMatch(/failed\.push/);
    expect(wizardJs).toContain("t('wizard.flowMsg.connectPartial'");
    expect(wizardJs).toContain("t('wizard.flowMsg.failedSeparator')");
  });

  it('clientActionViaApi 透传 rolledBack/backupPath（主进程契约）', () => {
    const wizardMjs = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'src', 'main', 'wizard.mjs'), 'utf-8');
    expect(wizardMjs).toMatch(/rolledBack:\s*Boolean\(data\?\.rolledBack\)/);
    expect(wizardMjs).toMatch(/backupPath:\s*typeof data\?\.backupPath/);
  });
});

// ---------------------------------------------------------------------------
// UX-2 补丁 3 增补 · 状态一致性（"待生效"黏性态修复）：单一真源 + 对账 + 提示层分离
// ---------------------------------------------------------------------------

import { assistantStatus as consoleStatus, normalizeClient } from '../../packages/console/assistants.js';
import { projectAssistantStatus, reconcileAssistantUi } from '../../packages/console/assistant-status.js';

describe('补丁 3 增补 · 单一真源：向导/设置两面投影一致（同一 helper 快照）', () => {
  // 同一组输入，两侧薄封装（wizardRowStatus / console assistantStatus）→ 同 key 同 label
  const cases = [
    ['未安装', { id: 'a', state: 'not-installed', installed: false }, {}],
    ['未接入', { id: 'a', state: 'not-connected', installed: true, connected: false }, {}],
    ['已接入', { id: 'a', state: 'connected', installed: true, connected: true }, {}],
    ['已接入+写入提醒', { id: 'a', state: 'connected', installed: true, connected: true }, { hint: true }],
    ['待生效（verify pending-restart）', { id: 'a', state: 'connected', installed: true, connected: true }, { verifyState: 'pending-restart' }],
    ['验证未过', { id: 'a', state: 'not-connected', installed: true }, { verifyState: 'verify-failed' }],
    ['接入失败', { id: 'a', state: 'not-connected', installed: true }, { failed: { kind: 'connect', reason: 'x' } }],
    ['写入中', { id: 'a', state: 'connected', installed: true, connected: true }, { busy: 'connect' }],
    ['需手动', { id: 'a', state: 'manual', needsManual: true }, {}],
    ['检测失败', { id: 'a', state: 'detect-failed' }, {}],
  ];
  it.each(cases.map((c, i) => [String(i), ...c]))('两面一致 #%s（%s）', (_i, _name, client, ui) => {
    const w = wizardRowStatus(client, {
      pending: ui.hint ? new Set([client.id]) : new Set(),
      busy: ui.busy ? { [client.id]: ui.busy } : {},
      failed: ui.failed ? { [client.id]: ui.failed } : {},
      verifyStates: ui.verifyState ? { [client.id]: ui.verifyState } : {},
    });
    const c = consoleStatus(normalizeClient(client), {
      clientBusy: ui.busy ? { [client.id]: ui.busy } : {},
      clientFailed: ui.failed ? { [client.id]: ui.failed } : {},
      clientVerify: ui.verifyState ? { [client.id]: { state: ui.verifyState } } : {},
      clientRestart: ui.hint ? { [client.id]: true } : {},
    });
    expect({ key: w.key, label: w.label, tone: w.tone, reloadHint: w.reloadHint })
      .toEqual({ key: c.key, label: c.label, tone: c.tone, reloadHint: c.reloadHint });
  });

  it('helper 直测：服务端 connected + reloadHint → 已接入 ✓（hint 仅提示层）；hint 仅 connected/pending-restart 携带', () => {
    expect(projectAssistantStatus({ state: 'connected' }, { reloadHint: true })).toMatchObject({ key: 'connected', label: '已接入 ✓', reloadHint: true });
    expect(projectAssistantStatus({ state: 'not-connected', installed: true }, { reloadHint: true }).reloadHint).toBe(false);
    expect(projectAssistantStatus({ state: 'connected' }, { verifyState: 'pending-restart', reloadHint: true })).toMatchObject({ key: 'pending-reload', label: '待生效', reloadHint: true });
  });

  it('对账：list not-connected → 清 hint/verify/failed；verify connected → 清 hint', () => {
    const reloadHints = new Set(['a']);
    const verifyStates = new Map([['a', 'pending-restart']]);
    const failed = { a: { kind: 'connect' } };
    // 配置不在了（用户抹掉/回滚）→ 全清
    expect(reconcileAssistantUi({ id: 'a', state: 'not-connected' }, { reloadHints, verifyStates, failed })).toBe(true);
    expect(reloadHints.size).toBe(0);
    expect(verifyStates.size).toBe(0);
    expect(failed.a).toBeUndefined();
    // verify 确认 connected → 提醒退场
    const hints2 = new Set(['b']);
    reconcileAssistantUi({ id: 'b', state: 'connected' }, { reloadHints: hints2, verifyStates: { b: 'connected' } });
    expect(hints2.size).toBe(0);
    // 无矛盾 → 不动
    const hints3 = new Set(['c']);
    expect(reconcileAssistantUi({ id: 'c', state: 'connected' }, { reloadHints: hints3, verifyStates: {} })).toBe(false);
    expect(hints3.size).toBe(1);
  });

  it('渲染层契约（旁白式）：无行内 hint/清单；完成页提醒名单由 reloadHints 承担', () => {
    expect(wizardJs).toMatch(/reloadHints\.add\(c\.id\)/);
    expect(wizardJs).toContain("t('wizard.complete.restartNotice'");
    expect(wizardJs).not.toContain('data-asst-act');
    const consoleJsSrc = readFileSync(join(here, '..', '..', 'packages', 'console', 'console.js'), 'utf-8');
    expect(consoleJsSrc).toMatch(/reconcileAssistantUi\(c, \{/);
  });

  it('CONSOLE_FILES 登记 assistant-status.js（serve 白名单）', () => {
    const serveSrc = readFileSync(join(here, '..', '..', 'packages', 'mcp', 'src', 'serve.mjs'), 'utf-8');
    const filesBlock = serveSrc.match(/CONSOLE_FILES\s*=\s*\{[\s\S]*?\}/)?.[0] ?? '';
    expect(filesBlock).toContain("'assistant-status.js'");
  });
});

// ---------------------------------------------------------------------------
// UX-2 简化轮 · 向导：首屏可点 ≤3 / ② 只显示已装 / 运维收「高级」
// ---------------------------------------------------------------------------

describe('简化轮 · 向导首屏去运维化（① 全自动、② 只看已装）', () => {
  it('首屏（初始态）只有一个按钮；常驻/重启/仅启动已退出向导（入口归托盘与设置）', () => {
    const idle = wizardHtml.match(/<div class="idle-cta" id="idle-cta">[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(idle).toContain('id="btn-go"');
    expect(idle).toContain('开始部署');
    expect(idle).not.toContain('alt-join');
    expect(wizardHtml).not.toContain('btn-install');
    expect(wizardHtml).not.toContain('btn-restart');
  });

  it('（旁白式修订）向导不再有助手清单——manual 兜底天然不进向导；目标过滤只含真实已装', () => {
    const fn = wizardJs.match(/function connectTargets\(clients\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/c\.state !== 'manual'/);
    expect(fn).toMatch(/c\.needsManual !== true/);
    expect(fn).toMatch(/c\.state !== 'needs-confirmation'/);
    expect(fn).toMatch(/c\.needsConfirmation !== true/);
    expect(wizardJs).not.toContain('renderClients');
  });

  it('（用户定稿）持久化按钮不进部署卡片——「让 Mebular 常驻」整行下线', () => {
    expect(wizardJs).not.toContain('postdone-row');
    expect(wizardJs).not.toContain('btn-install');
    expect(wizardHtml).not.toContain('让 Mebular 常驻');
    expect(wizardHtml).not.toContain('postdone-row');
  });
});

describe('简化轮 · 行内反馈（一点接入不新增行）', () => {
  it('（旁白式修订）无行内提示行；「已写入·重启后生效」由完成页提醒与旁白汇总承担', () => {
    expect(wizardJs).not.toContain('ast-hint');
    expect(wizardHtml).not.toContain('ast-hint');
    expect(wizardJs).toMatch(/重启对应软件后生效/); // 旁白汇总文案
  });
  it('（旁白式修订）无 .ast-hint 样式残留——向导样式回归纯流水', () => {
    expect(wizardHtml).not.toContain('ast-hint');
    expect(wizardHtml).toMatch(/\.flow li\[data-state="done"\]/);
  });
});

describe('简化轮走查修复 · 文案口径与完成段收纳', () => {
  it('② 文案用「已装数」而非全部客户端数（列表只显示已装，口径一致）；旧载荷回退 total', () => {
    // 真机场景：8 个客户端登记、其中 4 个已装、3 个已接入
    const v = wizardViewT(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 3, total: 8, installedCount: 4 } }));
    const a = v.steps.find((s) => s.id === 'assistants');
    expect(a.detailText).toContain('检测到 4 个已装助手（已接入 3 个）');
    expect(a.detailText).not.toContain('8 个已装');
    // 旧载荷（无 installedCount）→ 回退 total 不崩
    const legacy = wizardViewT(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 1, total: 3 } }));
    expect(legacy.steps.find((s) => s.id === 'assistants').detailText).toContain('检测到 3 个已装助手');
    // 已装 0（全未安装）→ 空态 + 不渲染已完成
    const empty = wizardViewT(computeWizardState({ daemonHealthy: true, assistants: { connectedCount: 0, total: 5, installedCount: 0 } }));
    const ae = empty.steps.find((s) => s.id === 'assistants');
    expect(ae.detailText).toContain('没检测到已装的 AI 助手');
    expect(ae.skipConnect).toBeUndefined();
  });

  it('折叠 = 旅程完成：① 完成但 ② 未确认时保持展开（一键开始可达）；全完成两段折叠', () => {
    const step2 = wizardViewT(computeWizardState({ daemonHealthy: true }));
    // ① done 但 ② 未 ack：① 不折叠（「一键开始」仍是唯一动作入口，必须可达）
    expect(step2.steps.find((s) => s.id === 'start').collapsed).toBe(false);
    expect(step2.steps.find((s) => s.id === 'start').actions.go.hidden).toBe(false);
    // 全部完成 → 两段折叠为终态单行
    const done = wizardViewT(computeWizardState({ daemonHealthy: true, wizard: { assistantsAcked: true } }));
    expect(done.steps.every((s) => s.collapsed)).toBe(true);
  });

  it('闪烁治理契约：品牌标静态、唯一呼吸点=流水活跃圆点、面板无 backdrop-filter、星野逐星频率', () => {
    expect(wizardHtml).not.toMatch(/\.hero \.mark \{[^}]*animation/);
    expect(wizardHtml).toMatch(/\.flow li\[data-state="active"\] i \{[^}]*animation: pulse 1\.8s/);
    expect(wizardHtml).not.toMatch(/backdrop-filter:\s*blur/);
    const wizardJsSrc = readFileSync(join(rendererDir, 'wizard.js'), 'utf-8');
    expect(wizardJsSrc).toMatch(/0\.42 \+ 0\.3 \* Math\.sin\(t \* s\.s \/ 1600/);
    expect(wizardJsSrc).toMatch(/s: 0\.55 \+ Math\.random\(\) \* 0\.9/);
  });
});

describe('简化轮走查修复 2 · 极简（用户定调：完成即终态、兜底行不进向导）', () => {
  it('完成态（用户定稿）：阶段框收束为缩略卡——四步回顾让位「已就绪 ✦」+ 主按钮；无展开残留', () => {
    expect(wizardHtml).not.toContain('展开 ›');
    expect(wizardJs).not.toContain('userExpanded');
    // 阶段框与缩略卡互斥：完成时 panel 隐藏、done-card 显示
    expect(wizardJs).toMatch(/panel\.hidden = !\(deployView \|\| doneView\)/); // 完成态：阶段框简述保留
    expect(wizardJs).toMatch(/cta\.hidden = !doneView/);
  });

  it('内置兜底「其他 AI 助手（复制片段）」（manual）不进向导——connectTargets 排除', () => {
    const fn = wizardJs.match(/function connectTargets\(clients\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/c\.state !== 'manual'/);
    expect(fn).toMatch(/c\.needsManual !== true/);
  });

  it('（用户定稿·去运维化）「高级 · 出问题了？」整块下线——部署卡片只剩步骤+旁白（运维入口归托盘/设置）', () => {
    expect(wizardHtml).not.toContain('高级 · 出问题了');
    expect(wizardHtml).not.toContain('troubleshoot');
    expect(wizardJs).not.toContain('troubleshooting');
  });
});

describe('简化轮走查修复 3 · 日志折条不常驻（① 就绪即隐藏，异常才出现）', () => {
  it('渲染层契约：日志是异常件（未开始不出现；失败/守护未就绪才出现并自动展开一次）', () => {
    // P4：UNINITIALIZED 不是异常；流水任一步失败或守护未就绪才亮
    expect(wizardJs).toMatch(/const showLogs = deployView && \(\s*Boolean\(flow\.failedSub\)\s*\|\| \(start\?\.status !== 'done' && !flow\.running && flow\.everRan\)\s*\)/);
    expect(wizardJs).toMatch(/logsPanel\.hidden = !showLogs/);
    expect(wizardJs).not.toContain('provisionRequired');
    expect(wizardHtml).toMatch(/<details[^>]*id="logs-panel"[^>]*>/);
  });
});

describe('简化轮走查修复 5 · 点击即上屏（走查事故回归：点按钮后冻屏直跳完成）', () => {
  it('runFlow 开场立即 refresh（阶段框本帧出现）；3s 轮询不再被 running 守卫吞掉', () => {
    // 事故根因：setInterval 的 !flow.running 守卫 + runFlow 不在开场刷新 → 面板显隐无人驱动，
    // 屏幕冻在初始页直到流水结束的 finally refresh 才蹦出完成态
    expect(wizardJs).toMatch(/\/\/ 立即上屏[\s\S]{0,460}await refresh\(\);/);
    expect(wizardJs).not.toMatch(/if \(!flow\.running\) \{ void refresh/);
    expect(wizardJs).toMatch(/setInterval\(\(\) => \{ void refresh\(\); void loadLogs\(\); \}, 3000\)/);
    // 部署中副标题不再是「点一下，接入设备」
    expect(wizardJs).toMatch(/flow\.running \? t\('wizard\.tagline\.deploying'\) : view\.tagline/);
    // 用户定稿手势：品牌 FLIP 滑到顶部 → 卡片延迟展开（reduced-motion 直达）
    expect(wizardJs).toMatch(/heroBefore = heroEl\?\.getBoundingClientRect\(\)/);
    expect(wizardJs).toMatch(/heroEl\.animate\(\[/);
    expect(wizardJs).toMatch(/panelEl\.animate\(\[\{ opacity: 0/);
    expect(wizardJs).toMatch(/if \(!reducedMotion && heroEl && heroBefore\)/);
  });
});

describe('简化轮走查修复 6 · 收尾动效（用户定稿 2：卡片「同框变身」为已就绪——不再两个完成词）', () => {
  it('静态：done 内容并入部署卡片（同框变身）+ compact 收束规则；「✓ 已完成」条已退场', () => {
    expect(wizardHtml).not.toContain('flow-doneline');
    expect(wizardHtml).not.toContain('✓ 已完成'); // 用户定稿 2：与「已就绪」重复，删除
    expect(wizardHtml).toMatch(/#deploy-panel\.is-compact #deploy-flow \{ display: none; \}/);
    expect(wizardHtml).toMatch(/#deploy-panel:not\(\.is-compact\) #complete-cta \{ display: none; \}/);
    expect(wizardHtml).toMatch(/#deploy-panel \.done-card \{ margin-top: 0; \}/);
  });

  it('渲染层：完成时播放一次；内容退场→收束变身→已就绪入场；reduced-motion 直达；runFlow 重置', () => {
    expect(wizardJs).toMatch(/doneView && !doneFxPlayed[\s\S]{0,60}doneFxPlayed = true; playDoneFx\(\)/);
    expect(wizardJs).toMatch(/flowBox\?\.children \?\? \[\]/);
    expect(wizardJs).toMatch(/panel\.animate\(\[\{ height: /);
    expect(wizardJs).toMatch(/cta\?\.animate\(\[\{ opacity: 0/);
    expect(wizardJs).toMatch(/if \(reducedMotion\) \{ compact\(\); return; \}/);
    expect(wizardJs).toMatch(/doneFxPlayed = false; \/\/ 重置收尾动效[\s\S]{0,80}classList\.remove\('is-compact'\)/);
  });
});

describe('简化轮走查修复 4 · 一键启动（①②全自动跑给你看）', () => {
  it('P6A 流水五步：启动 → 就绪 → 检查助手 → 接入 MCP → 控制台；HTML/JS 契约', () => {
    for (const sub of ['launch', 'ready', 'probe', 'connect', 'console']) {
      expect(wizardHtml).toContain(`data-sub="${sub}"`);
    }
    expect(wizardHtml).toContain('接入 MCP 配置（自动）');
    expect(wizardJs).toMatch(/const SUBSTEPS = WIZARD_SUBSTEPS/);
    expect(wizardJs).toContain('autoConnectAll');
    expect(wizardJs).toMatch(/sub === 'probe'[\s\S]{0,420}clientsList\(\)/);
    expect(wizardJs).toMatch(/sub === 'connect'[\s\S]{0,900}autoConnectAll\(/);
    expect(wizardJs).toMatch(/sub === 'console'[\s\S]{0,240}openConsoleOnce\(\)/);
  });

  it('一键启动核心自动化：connect 子步逐个接入（非阻断，失败行进「重试」）+ 行在流程中被动（无按钮）', () => {
    const fn = wizardJs.match(/async function autoConnectAll\([^)]*\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/clientsAction\(c\.id, 'connect'\)/);
    expect(fn).toMatch(/failed\.push/); // 失败非阻断
    expect(wizardJs).not.toContain('data-asst-act'); // 全程零按钮（含流程中）
  });

  it('重开向导自动续跑接入（一次/会话，防循环）；点一次即可的叙事文案', () => {
    expect(wizardJs).toMatch(/await api\.ackAssistants\(\)/); // 流水尾部统一确认
    expect(wizardViewT(computeWizardState({})).steps.find((s) => s.id === 'start').detailText).toContain('一键完成');
  });
});

describe('简化轮走查修复 5 · 居中 + 过程可见性', () => {
  it('（单面板修订）无轨道挂点——stage 居中即面板居中，无需补偿 hack', () => {
    expect(wizardHtml).not.toContain('.rail');
    expect(wizardHtml).toMatch(/\.stage \{[^}]*margin: 0 auto/);
  });

  it('流水最小停留（过程可见）：每子步 ≥900ms + 汇总停留后再收尾', () => {
    expect(wizardJs).toMatch(/SUB_MIN_DWELL_MS = 900/);
    expect(wizardJs).toMatch(/await sleep\(SUB_MIN_DWELL_MS\); \/\/ 最小停留/);
    expect(wizardJs).toMatch(/汇总行停留：读完再进完成态/);
  });
});

describe('App 图标（用户定稿：网页版 favicon 的 ✦ 同源）', () => {
  it('main：macOS Dock 图标（开发态也生效）+ 窗口 icon；打包配置指向 resources/icon.png', () => {
    expect(indexMjs).toMatch(/app\.dock\.setIcon/);
    expect(indexMjs).toMatch(/icon: appIconPath\(\)/);
    const yml = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'electron-builder.yml'), 'utf-8');
    expect(yml).toMatch(/^icon: resources\/icon\.png/m);
    // 资源在位且为合法 PNG（魔数）
    const png = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'resources', 'icon.png'));
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    // 矢量源同步在仓（可再生成任意尺寸）；尺寸遵循 macOS 网格（824 内容 @ 1024 画布）
    const svg = readFileSync(join(here, '..', '..', 'apps', 'desktop', 'resources', 'icon.svg'), 'utf-8');
    expect(svg).toContain('#6dffb8');
    expect(svg).toMatch(/x="100" y="100" width="824" height="824"/);
    // 菜单栏星章：模板图 + @2x
    expect(indexMjs).toMatch(/setTemplateImage\(true\)/);
    expect(indexMjs).toMatch(/addRepresentation\(\{ scaleFactor: 2/);
  });
});
