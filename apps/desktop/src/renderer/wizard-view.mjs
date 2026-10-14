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
  const registered = Boolean(start?.detail?.registered);

  const badge = complete
    ? '已就绪'
    : `第 ${currentIndex + 1}/2 步 · ${STEP_NAME[state?.current] ?? ''}`.trim();

  // 异常（① 未完成 = 守护未就绪 / 引导态 / 待重启）→ 日志自动展开 + 一行人话结论
  const abnormal = Boolean(start) && !start.done;
  const logsConclusion = !abnormal
    ? null
    : provision.required
      ? (provision.provisioned
        ? '初始设置已写入，等待重启生效；重启后向导自动继续。'
        : '还差一步初始设置：在打开的控制台里选「建新」或「加入」，完成后向导自动继续。')
      : '守护未运行：点①的「一键开始」；反复失败先看下面的日志。';

  return {
    badge,
    complete: complete ? { cta: '进入控制台 ✦' } : null,
    logs: { open: abnormal, conclusion: logsConclusion },
    steps: steps.map((step) => {
      const base = {
        id: step.id,
        title: step.title,
        status: step.done ? 'done' : (step.id === state?.current ? 'current' : 'todo'),
        check: step.done ? '✓' : null,
        collapsed: complete, // 完成态两段折叠为回顾（可再展开）
      };
      if (step.id === 'start') return { ...base, ...startStepView(step, { healthy, provision, registered }) };
      return { ...base, ...assistantsStepView(step, start) };
    }),
  };
}

/** 段①：文案 + 动作收编 + 子步骤流水（启动 → 写入初始设置 → 重启恢复）静态进度。 */
function startStepView(step, { healthy, provision, registered }) {
  let detailText;
  if (provision.required) {
    detailText = provision.provisioned
      ? '初始设置已写入，等待重启生效：向导会自动续跑；也可点「出问题了？」里的重启。'
      : '还差一步初始设置（建新或加入一个 Mebular，数据都在本机）：';
  } else if (step.done) {
    detailText = registered
      ? '守护运行中（常驻已装 · 开机自启）。'
      : '守护运行中。当前是临时运行——关机/退出后不会自动拉起，想开机自启可让 Mebular 常驻。';
  } else {
    detailText = '一键完成：启动守护 → 写入初始设置 → 重启恢复。中途失败会停在对应子步骤，可「从此处续跑」。';
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
    serviceBadge: step.done && !registered ? '临时运行' : null,
    actions: {
      go: { label: '一键开始', kind: 'primary', hidden: step.done && !provision.required },
      provision: { label: '去写入初始设置 →', kind: 'primary', hidden: !(provision.required && !provision.provisioned) },
      install: { label: '让 Mebular 常驻', kind: 'ghost', hidden: registered, recommended: step.done && !registered },
      restart: { label: '重启守护', kind: 'ghost', area: 'troubleshoot', hidden: false },
      startOnly: { label: '仅启动守护', kind: 'ghost', area: 'troubleshoot', hidden: false },
    },
  };
}

/** 段②：行级接入 + 「已完成」解锁（≥1 已接入才可用；① 未完成先拦住）。 */
function assistantsStepView(step, start) {
  const startDone = Boolean(start?.done);
  const detail = step?.detail;
  const connected = Number(detail?.connectedCount ?? 0);
  const total = Number(detail?.total ?? 0);
  let detailText;
  if (!startDone) detailText = '先完成第①步：Mebular 跑起来（并完成初始设置）后才能连接助手。';
  else if (!detail) detailText = '助手列表加载中…';
  else if (detail.readError) detailText = `状态读取受限：${detail.readError}（不阻断）。`;
  else detailText = `已接入 ${connected}/${total || '—'} 个 AI 助手。接入 ≥1 个后可点「已完成」；也可稍后在「设置 · AI 助手」里补。`;
  return {
    detailText,
    connected,
    total,
    doneEnabled: startDone && connected >= 1,
    doneLabel: '已完成',
  };
}
