// W-1/UX-2 · 一屏两段向导视图模型（纯函数，无 DOM/node 依赖）：renderer wizard.js 与单测共用同一份契约。
//
// 输入 = computeWizardState 的输出；输出 = 渲染所需的全部展示决策
// （徽章文案 / 每段状态·折叠·动作收编 / 段①子步骤流水进度 / 段②「已完成」解锁 / 完成态通关 CTA / 日志区折叠与结论）。
// 文案 i18n：所有面向用户的字符串由调用方传入 translator（t，来自 locales/<locale>/desktop.json）。
// 本模块不内置中文替换表；未传 t 时回退 key。
// DOM 契约：status 'current' → .is-current；check '✓' → 段标题前置对勾；
// collapsed → 段折叠为回顾（可再展开）；logs.open → <details id="logs-panel"> 的 open 属性；
// flow.* → 段①子步骤流水（launch/ready/probe/connect/console）的 todo/active/done/failed 图标。

const keyOnly = (key) => String(key);

// P6A：部署流水单一真源（渲染层与静态视图模型共用）。每条都对应真实动作：
// launch=api.start / ready=health poll / probe=clientsList / connect=autoConnectAll / console=openConsoleOnce。
export const WIZARD_SUBSTEPS = ['launch', 'ready', 'probe', 'connect', 'console'];

/**
 * 向导视图模型。
 * @param state computeWizardState({...}) 的返回（两段：start / assistants）
 * @param t desktop pack translator（缺省回退 key）
 */
export function wizardView(state, t = keyOnly) {
  const steps = Array.isArray(state?.steps) ? state.steps : [];
  const complete = Boolean(state?.complete);
  const currentIndex = steps.findIndex((s) => s.id === state?.current);

  const start = steps.find((s) => s.id === 'start');
  const healthy = Boolean(start?.detail?.healthy);
  // F2a 双保险②：三态（true/false/null=未知）——未知一律按「不显示安装按钮」处理
  const registered = start?.detail?.registered === true ? true : start?.detail?.registered === false ? false : null;
  const assistantsDone = Boolean(steps.find((s) => s.id === 'assistants')?.done);

  const stepName = (id) => (id ? t(`wizard.stepName.${id}`) : '');
  const badge = complete
    ? t('wizard.badge.complete')
    : t('wizard.badge.step', { current: currentIndex + 1, total: 2, name: stepName(state?.current) });

  // 设计稿（01-setup）：hero tagline 随进度变化
  const tagline = complete
    ? ''
    : start?.done
      ? t('wizard.tagline.connecting')
      : t('wizard.tagline.idle');

  // 异常（① 未完成 = 守护未就绪）→ 日志自动展开 + 一行人话结论。
  // P4：UNINITIALIZED 不再算异常（它只是还没建新/加入，交给控制台锁定壳）。
  const abnormal = Boolean(start) && !start.done;
  const logsConclusion = !abnormal ? null : t('wizard.logs.conclusion');

  return {
    badge,
    tagline,
    complete: complete ? { cta: t('wizard.complete.cta') } : null,
    logs: { open: abnormal, conclusion: logsConclusion },
    steps: steps.map((step) => {
      const status = step.done ? 'done' : (step.id === state?.current ? 'current' : 'todo');
      const base = {
        id: step.id,
        title: t(step.titleKey ?? step.title ?? `wizard.step.${step.id}.title`),
        status,
        // 里程碑轨道节点态：当前=呼吸(active)、完成=✓(done)、未到=暗(locked)
        node: step.done ? 'done' : status === 'current' ? 'active' : 'locked',
        // ① 在旅程未完时保持展开（「一键开始」入口可达——重开未 ack 态的唯一动作）；全部完成才折叠成终态单行
        collapsed: step.id === 'start' ? (step.done && complete) : step.done,
      };
      if (step.id === 'start') return { ...base, ...startStepView(step, { healthy, registered, assistantsDone }, t) };
      return { ...base, ...assistantsStepView(step, start, t) };
    }),
  };
}

/** 段①：文案 + 动作收编 + 子步骤流水（启动 → 就绪 → 检查 → 接入 → 控制台）静态进度。 */
function startStepView(step, { healthy, registered, assistantsDone = false }, t) {
  let detailText;
  if (step.done) {
    detailText = registered === true
      ? t('wizard.start.detail.doneRegistered')
      : registered === false
        ? t('wizard.start.detail.doneManaged')
        : t('wizard.start.detail.doneUnknown');
  } else {
    // 设计稿（01-setup）① 正文
    detailText = t('wizard.start.detail.idle');
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
    serviceBadge: step.done && registered === false ? t('wizard.start.serviceBadge') : null,
    doneLine: step.done
      ? {
        main: t('wizard.start.doneLine.main'),
        sub: registered === true
          ? t('wizard.start.doneLine.subRegistered')
          : t('wizard.start.doneLine.subManaged'),
      }
      : null,
    actions: {
      // 完成前恒在：点一次跑完剩余全部自动化
      go: { label: t('wizard.start.go'), kind: 'primary', hidden: false },
    },
  };
}

/** 段②：行级接入 + 「已完成」解锁（≥1 已接入才可用；① 未完成先拦住）+ 设计稿文案与「先不接 ›」。 */
function assistantsStepView(step, start, t) {
  const startDone = Boolean(start?.done);
  const detail = step?.detail;
  const connected = Number(detail?.connectedCount ?? 0);
  const total = Number(detail?.total ?? 0);
  // 已装数（installedCount）——列表只显示已装，文案口径必须一致（旧载荷回退 total）
  const installed = Number(detail?.installedCount ?? detail?.total ?? 0);
  let detailText;
  if (!startDone) detailText = t('wizard.assistants.detail.blocked');
  else if (!detail) detailText = t('wizard.assistants.detail.loading');
  else if (detail.readError) detailText = t('wizard.assistants.detail.readError', { error: detail.readError });
  else if (installed === 0) detailText = t('wizard.assistants.detail.empty');
  else if (connected >= installed) detailText = t('wizard.assistants.detail.connectedAll', { connected });
  else detailText = t('wizard.assistants.detail.partial', { installed, connected });
  return {
    detailText,
    connected,
    total,
    installed,
    // 自动化（用户定调）：第二步纯过程展示、零按钮——确认收尾由渲染层在流水尾部统一执行
    doneLine: step.done
      ? (connected >= 1
        ? { main: t('wizard.assistants.doneLine.main'), sub: t('wizard.assistants.doneLine.sub') }
        : { main: t('wizard.assistants.doneLine.noneMain'), sub: t('wizard.assistants.doneLine.noneSub') })
      : null,
  };
}

// ---------------------------------------------------------------------------
// UX-2 补丁 3：瞬态容忍 + 行状态机（纯函数，渲染层与单测共用）
// ---------------------------------------------------------------------------

// The packaged renderer resolves @mebular/core from Resources/node_modules;
// the repository layout keeps the sibling packages/console path for development.
const packagedAssistantStatus = new URL('../../../node_modules/@mebular/core/packages/console/assistant-status.js', import.meta.url);
const developmentAssistantStatus = new URL('../../../../packages/console/assistant-status.js', import.meta.url);
function isMissingModuleError(error) {
  return error?.code === 'ERR_MODULE_NOT_FOUND'
    || error?.code === 'MODULE_NOT_FOUND'
    || /^(?:Cannot find module|Failed to fetch dynamically imported module)\b/.test(String(error?.message ?? ''));
}

let projectAssistantStatus;
try {
  ({ projectAssistantStatus } = await import(packagedAssistantStatus.href));
} catch (error) {
  if (!isMissingModuleError(error)) throw error;
  ({ projectAssistantStatus } = await import(developmentAssistantStatus.href));
}

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
