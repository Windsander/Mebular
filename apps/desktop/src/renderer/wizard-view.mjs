// W-1/UX-2 · 一屏两段向导视图模型（纯函数，无 DOM/node 依赖）：renderer wizard.js 与单测共用同一份契约。
//
// 输入 = computeWizardState 的输出；输出 = 渲染所需的全部展示决策
// （徽章文案 / 每段状态·折叠·动作收编 / 段①子步骤流水进度 / 段②「已完成」解锁 / 完成态通关 CTA / 日志区折叠与结论）。
// DOM 契约：status 'current' → .is-current；check '✓' → 段标题前置对勾；
// collapsed → 段折叠为回顾（可再展开）；logs.open → <details id="logs-panel"> 的 open 属性；
// flow.* → 段①子步骤流水（launch/write/recover）的 todo/active/done/failed 图标。

const STEP_NAME = { start: '一键开始', assistants: '连接 AI 助手' };

/**
 * 向导视图模型。
 * @param state computeWizardState({...}) 的返回（两段：start / assistants）
 */
export function wizardView(state) {
  const steps = Array.isArray(state?.steps) ? state.steps : [];
  const complete = Boolean(state?.complete);
  const currentIndex = steps.findIndex((s) => s.id === state?.current);

  const start = steps.find((s) => s.id === 'start');
  const provision = start?.detail?.provision ?? { required: false, provisioned: null };
  const healthy = Boolean(start?.detail?.healthy);
  // F2a 双保险②：三态（true/false/null=未知）——未知一律按「不显示安装按钮」处理
  const registered = start?.detail?.registered === true ? true : start?.detail?.registered === false ? false : null;
  // F4④ 重启/安装宽限窗（渲染层 state.grace，≤60s）：① 已完成期间的健康瞬断不翻回未完成
  const grace = Boolean(state?.grace) && !complete;

  const badge = complete
    ? '已就绪'
    : `第 ${currentIndex + 1}/2 步 · ${STEP_NAME[state?.current] ?? ''}`.trim();

  // 设计稿（01-setup）：hero tagline 随进度变化
  const tagline = complete
    ? '全部就绪。'
    : start?.done
      ? '很好，再接一个助手就完成。'
      : '点两下，把它接进你的日常。';

  // 异常（① 未完成 = 守护未就绪 / 引导态 / 待重启）→ 日志自动展开 + 一行人话结论；宽限窗内不算异常
  const abnormal = Boolean(start) && !start.done && !grace;
  const logsConclusion = !abnormal
    ? null
    : provision.required
      ? (provision.provisioned
        ? '初始设置已写入，等待重启生效；重启后向导自动继续。'
        : '还差一步初始设置：点「去写入初始设置 →」，在控制台里选「建新」或「加入」，完成后向导自动继续。')
      : '守护未运行：点①的「一键开始」；反复失败先看下面的日志。';

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
        collapsed: step.done, // 完成段即收成终态单行（无展开交互）
      };
      if (step.id === 'start') return { ...base, ...startStepView(step, { healthy, provision, registered, grace }) };
      return { ...base, ...assistantsStepView(step, start) };
    }),
  };
}

/** 段①：文案 + 动作收编 + 子步骤流水（启动 → 写入初始设置 → 重启恢复）静态进度。 */
function startStepView(step, { healthy, provision, registered, grace = false }) {
  // F4④ 宽限窗：① 曾完成、此刻健康瞬断（安装常驻/重启中）→ 过渡呈现，不翻回未完成
  if (grace && !step.done) {
    return {
      detailText: '正在重启生效中：健康瞬时波动属预期（最长约 60 秒），无需操作。',
      flow: { launch: 'active', write: 'todo', recover: 'todo' },
      serviceBadge: null,
      doneLine: null,
      actions: {
        go: { label: '一键开始', kind: 'primary', hidden: true },
        provision: { label: '去写入初始设置 →', kind: 'primary', hidden: true },
        install: { label: '重启中…', kind: 'ghost', hidden: false, disabled: true },
        restart: { label: '重启守护', kind: 'ghost', area: 'troubleshoot', hidden: false },
        startOnly: { label: '仅启动守护', kind: 'ghost', area: 'troubleshoot', hidden: false },
      },
    };
  }
  let detailText;
  if (provision.required) {
    detailText = provision.provisioned
      ? '初始设置已写入，等待重启生效：向导会自动续跑；也可点「出问题了？」里的重启。'
      : '还差一步初始设置（建新或加入一个 Mebular，数据都在本机）：';
  } else if (step.done) {
    detailText = registered === true
      ? '守护运行中（常驻已装 · 开机自启）。'
      : registered === false
        ? '守护运行中。当前是临时运行——关机/退出后不会自动拉起，想开机自启可让 Mebular 常驻。'
        : '守护运行中。（常驻状态读取中或不可用）';
  } else {
    // 设计稿（01-setup）① 正文
    detailText = '一键完成：启动 Mebular、接上你已装的 AI 助手。数据只存在这台机器上，不上云。';
  }
  // 子步骤流水进度（静态推导；渲染层在跑流水时以运行时状态覆盖）
  const flow = {
    launch: healthy ? 'done' : 'todo',
    write: !healthy ? 'todo' : (provision.required ? (provision.provisioned ? 'done' : 'active') : 'done'),
    recover: provision.required ? (provision.provisioned ? 'active' : 'todo') : (healthy ? 'done' : 'todo'),
  };
  return {
    detailText,
    flow,
    serviceBadge: step.done && registered === false ? '临时运行' : null,
    doneLine: step.done
      ? { main: '✓ 已就绪', sub: registered === true ? '常驻已装 · 开机自启' : '这台机器已在跑你的 Mebular' }
      : null,
    actions: {
      go: { label: '一键开始', kind: 'primary', hidden: step.done && !provision.required },
      provision: { label: '去写入初始设置 →', kind: 'primary', hidden: !(provision.required && !provision.provisioned) },
      // 设计稿：「或加入已有的 Mebular ›」——与「去写入初始设置」同路（控制台 provision），仅引导态显示
      join: { label: '或加入已有的 Mebular ›', kind: 'alt', hidden: !(provision.required && !provision.provisioned) },
      // F2a：仅当明确「未注册」（registered === false）才显示安装按钮；未知/true 一律隐藏
      install: { label: '让 Mebular 常驻', kind: 'ghost', hidden: registered !== false, recommended: step.done && registered === false },
      restart: { label: '重启守护', kind: 'ghost', area: 'troubleshoot', hidden: false },
      startOnly: { label: '仅启动守护', kind: 'ghost', area: 'troubleshoot', hidden: false },
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
  if (!startDone) detailText = '先完成第①步：Mebular 跑起来（并完成初始设置）后才能连接助手。';
  else if (!detail) detailText = '助手列表加载中…';
  else if (detail.readError) detailText = `状态读取受限：${detail.readError}（不阻断）。`;
  else if (installed === 0) detailText = '没检测到已装的 AI 助手 —— 可以先跳过，装好后再到 设置 → AI 助手 接入。';
  else detailText = `检测到 ${installed} 个已装助手（已接入 ${connected} 个）。`;
  return {
    detailText,
    connected,
    total,
    installed,
    // 自动完成（用户定调）：已装的全部接入 = 段② 目的达成，自动 ack 进完成态——
    // 「已完成」按钮是多余仪式；没接齐时不自动翻段（防误判）
    autoAck: startDone && installed > 0 && connected >= installed && !step.done,
    // 「先不接 ›」：有未接齐时的唯一安静出口（显式跳过 = ack）；全部接齐自动完成，不需要任何按钮
    skipConnect: { label: '先不接 ›', hidden: !startDone || step.done },
    doneLine: step.done
      ? (connected >= 1
        ? { main: '✓ 已接好', sub: '重启对应软件后生效' }
        : { main: '— 已跳过', sub: '随时可以在 设置 → AI 助手 接' })
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
