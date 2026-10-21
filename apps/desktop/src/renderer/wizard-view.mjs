// W-1/UX-2 · 一屏两段向导视图模型（纯函数，无 DOM/node 依赖）：renderer wizard.js 与单测共用同一份契约。
//
// 输入 = computeWizardState 的输出；输出 = 渲染所需的全部展示决策
// （徽章文案 / 每段状态·折叠·动作收编 / 段①子步骤流水进度 / 段②「已完成」解锁 / 完成态通关 CTA / 日志区折叠与结论）。
// DOM 契约：status 'current' → .is-current；check '✓' → 段标题前置对勾；
// collapsed → 段折叠为回顾（可再展开）；logs.open → <details id="logs-panel"> 的 open 属性；
// flow.* → 段①子步骤流水（launch/ready/probe/connect/console）的 todo/active/done/failed 图标。

const STEP_NAME = { start: '一键开始', assistants: '连接 AI 助手' };

// P6A：部署流水单一真源（渲染层与静态视图模型共用）。每条都对应真实动作：
// launch=api.start / ready=health poll / probe=clientsList / connect=autoConnectAll / console=openConsoleOnce。
export const WIZARD_SUBSTEPS = ['launch', 'ready', 'probe', 'connect', 'console'];

/**
 * 向导视图模型。
 * @param state computeWizardState({...}) 的返回（两段：start / assistants）
 */
export function wizardView(state) {
  const steps = Array.isArray(state?.steps) ? state.steps : [];
  const complete = Boolean(state?.complete);
  const currentIndex = steps.findIndex((s) => s.id === state?.current);

  const start = steps.find((s) => s.id === 'start');
  const healthy = Boolean(start?.detail?.healthy);
  // F2a 双保险②：三态（true/false/null=未知）——未知一律按「不显示安装按钮」处理
  const registered = start?.detail?.registered === true ? true : start?.detail?.registered === false ? false : null;
  const assistantsDone = Boolean(steps.find((s) => s.id === 'assistants')?.done);

  const badge = complete
    ? '已就绪'
    : `第 ${currentIndex + 1}/2 步 · ${STEP_NAME[state?.current] ?? ''}`.trim();

  // 设计稿（01-setup）：hero tagline 随进度变化
  const tagline = complete
    ? ''
    : start?.done
      ? '正在接入 AI 助手…'
      : '点一下，接入设备';

  // 异常（① 未完成 = 守护未就绪）→ 日志自动展开 + 一行人话结论。
  // P4：UNINITIALIZED 不再算异常（它只是还没建新/加入，交给控制台锁定壳）。
  const abnormal = Boolean(start) && !start.done;
  const logsConclusion = !abnormal
    ? null
    : '守护未运行：点「开始部署」重试；反复失败先看下面的日志。';

  return {
    badge,
    tagline,
    complete: complete ? { cta: '进入控制台 ✦' } : null,
    logs: { open: abnormal, conclusion: logsConclusion },
    steps: steps.map((step) => {
      const status = step.done ? 'done' : (step.id === state?.current ? 'current' : 'todo');
      const base = {
        id: step.id,
        title: step.title,
        status,
        // 里程碑轨道节点态：当前=呼吸(active)、完成=✓(done)、未到=暗(locked)
        node: step.done ? 'done' : status === 'current' ? 'active' : 'locked',
        // ① 在旅程未完时保持展开（「一键开始」入口可达——重开未 ack 态的唯一动作）；全部完成才折叠成终态单行
        collapsed: step.id === 'start' ? (step.done && complete) : step.done,
      };
      if (step.id === 'start') return { ...base, ...startStepView(step, { healthy, registered, assistantsDone }) };
      return { ...base, ...assistantsStepView(step, start) };
    }),
  };
}

/** 段①：文案 + 动作收编 + 子步骤流水（启动 → 就绪 → 检查 → 接入 → 控制台）静态进度。 */
function startStepView(step, { healthy, registered, assistantsDone = false }) {
  let detailText;
  if (step.done) {
    detailText = registered === true
      ? '守护运行中（常驻已装 · 开机自启）。'
      : registered === false
        ? '守护运行中（App 托管）：退出 App 后停止；想开机自启可让 Mebular 常驻。'
        : '守护运行中。（常驻状态读取中或不可用）';
  } else {
    // 设计稿（01-setup）① 正文
    detailText = '一键完成：启动 Mebular、接上你已装的 AI 助手。数据只存在这台机器上，不上云。';
  }
  // 子步骤流水进度（静态推导；渲染层在跑流水时以运行时状态覆盖）
  const flow = {
    launch: healthy ? 'done' : 'todo',
    ready: healthy ? 'done' : 'todo',
    probe: healthy ? 'done' : 'todo',
    connect: assistantsDone ? 'done' : (healthy ? 'active' : 'todo'),
    console: assistantsDone ? 'done' : 'todo',
  };
  return {
    detailText,
    flow,
    serviceBadge: step.done && registered === false ? 'App 托管' : null,
    doneLine: step.done
      ? { main: '✓ 已就绪', sub: registered === true ? '常驻已装 · 开机自启' : '这台机器已在跑你的 Mebular' }
      : null,
    actions: {
      // 完成前恒在：点一次跑完剩余全部自动化
      go: { label: '开始部署', kind: 'primary', hidden: false },
    },
  };
}

/** 段②：行级接入 + 「已完成」解锁（≥1 已接入才可用；① 未完成先拦住）+ 设计稿文案与「先不接 ›」。 */
function assistantsStepView(step, start) {
  const startDone = Boolean(start?.done);
  const detail = step?.detail;
  const connected = Number(detail?.connectedCount ?? 0);
  const total = Number(detail?.total ?? 0);
  // 已装数（installedCount）——列表只显示已装，文案口径必须一致（旧载荷回退 total）
  const installed = Number(detail?.installedCount ?? detail?.total ?? 0);
  let detailText;
  if (!startDone) detailText = '先完成第①步：Mebular 跑起来后才能连接助手。';
  else if (!detail) detailText = '助手列表加载中…';
  else if (detail.readError) detailText = `状态读取受限：${detail.readError}（不阻断）。`;
  else if (installed === 0) detailText = '没检测到已装的 AI 助手 —— 装好后回来点「一键开始」即可。';
  else if (connected >= installed) detailText = `已接入 ${connected} 个 AI 助手。`;
  else detailText = `检测到 ${installed} 个已装助手（已接入 ${connected} 个）——点「开始部署」接上；未成功的会在下方给出原因。`;
  return {
    detailText,
    connected,
    total,
    installed,
    // 自动化（用户定调）：第二步纯过程展示、零按钮——确认收尾由渲染层在流水尾部统一执行
    doneLine: step.done
      ? (connected >= 1
        ? { main: '✓ 已接好', sub: '重启对应软件后生效' }
        : { main: '— 无需接入', sub: '这台机器没有已装的 AI 助手' })
      : null,
  };
}

// ---------------------------------------------------------------------------
// UX-2 补丁 3：瞬态容忍 + 行状态机（纯函数，渲染层与单测共用）
// ---------------------------------------------------------------------------

import { projectAssistantStatus } from '../../../../packages/console/assistant-status.js';

/**
 * ①「守护已就绪」瞬态容忍（防误翻）：曾就绪时**连续 ≥2 次**探测失败才翻回未完成；
 * 单次 miss → hold（保持上一帧：不翻段、不自动展开日志）；恢复后立即回到 done（无额外延迟）。
 * @returns {{ hold: boolean, misses: number, lastDone: boolean }}
 */
export function flapGate({ lastDone = false, done = false, misses = 0 } = {}) {
  if (done) return { hold: false, misses: 0, lastDone: true };
  if (!lastDone) return { hold: false, misses: 0, lastDone: false }; // 本来就未完成：正常呈现
  const next = misses + 1;
  return next < 2
    ? { hold: true, misses: next, lastDone: true }   // 单次 miss：UI 不动
    : { hold: false, misses: next, lastDone: false }; // 连续 ≥2 次：翻回未完成
}

/**
 * 段②行状态 = 共享 helper 薄封装（packages/console/assistant-status.js，
 * 与设置 · AI 助手同一投影；一致性由快照断言守护）。
 * ui: { pending?: Set<id>（语义 = reloadHint 提示层）, busy?: {id:action}, failed?: {id:{kind}}, verifyStates?: {id:state} }
 * 铁律：失败（connect !ok / verify verify-failed）→「接入失败」/「验证未过」，**一律不得显示「待生效」**；
 *       「待生效」唯一来源 = 服务端 verify pending-restart；服务端 connected → 「已接入 ✓」不被覆盖。
 */
export function wizardRowStatus(client, ui = {}) {
  const id = client?.id;
  return projectAssistantStatus(client, {
    busy: ui.busy?.[id] ?? null,
    failed: ui.failed?.[id] ?? null,
    verifyState: ui.verifyStates?.[id] ?? null,
    reloadHint: ui.pending?.has?.(id) ?? false,
  });
}
