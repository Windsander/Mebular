// W-1 · 向导视图模型（纯函数，无 DOM/node 依赖）：renderer wizard.js 与单测共用同一份契约。
//
// 输入 = computeWizardState 的输出；输出 = 渲染所需的全部展示决策
// （徽章文案 / 每步状态·折叠·动作收编 / 完成态通关 CTA / 日志区折叠与结论 / 邀请确认）。
// DOM 契约：status 'current' → .is-current；check '✓' → 步标题前置对勾；
// collapsed → 卡片折叠为回顾；logs.open → <details id="logs-panel"> 的 open 属性。

const STEP_NAME = { start: '启动 Mebular', assistants: '连接 AI 助手', device: '添加设备' };

/**
 * 向导视图模型。
 * @param state computeWizardState({...}) 的返回
 */
export function wizardView(state) {
  const steps = Array.isArray(state?.steps) ? state.steps : [];
  const complete = Boolean(state?.complete);
  const currentIndex = steps.findIndex((s) => s.id === state?.current);

  const start = steps.find((s) => s.id === 'start');
  const provision = start?.detail?.provision ?? { required: false, provisioned: null };
  const registered = Boolean(start?.detail?.registered);

  const badge = complete
    ? '已就绪'
    : `第 ${currentIndex + 1}/3 步 · ${STEP_NAME[state?.current] ?? ''}`.trim();

  // 中-5：异常（① 未完成 = 守护未就绪 / 引导态 / 待重启）→ 日志自动展开 + 一行人话结论
  const abnormal = Boolean(start) && !start.done;
  const logsConclusion = !abnormal
    ? null
    : provision.required
      ? (provision.provisioned
        ? '初始设置已写入，等待重启生效；重启后向导自动继续。'
        : '当前处于初始设置：点①里的「建新 / 加入 →」完成后向导自动继续。')
      : '守护未运行：点①的「启动」；反复失败先看下面的日志。';

  const view = {
    badge,
    complete: complete ? { cta: '进入控制台 ✦' } : null,
    logs: { open: abnormal, conclusion: logsConclusion },
    steps: steps.map((step) => {
      const base = {
        id: step.id,
        title: step.title,
        status: step.done ? 'done' : (step.id === state?.current ? 'current' : 'todo'),
        check: step.done ? '✓' : null,
        collapsed: complete, // 高-2：完成态三步卡全部折叠为回顾
      };
      if (step.id === 'start') return { ...base, ...startStepView(step, provision, registered) };
      if (step.id === 'assistants') return { ...base, detailText: assistantsText(step, start) };
      return { ...base, detailText: '另一台设备装同一个 Mebular App，扫码（或粘贴令牌）即可加入。' };
    }),
  };
  return view;
}

/** 步骤①：文案 + 动作收编（中-4）+ provision CTA（高-1）。 */
function startStepView(step, provision, registered) {
  let detailText;
  if (provision.required) {
    detailText = provision.provisioned
      ? '初始设置已写入，等待重启生效：点「出问题了？」里的重启，或按控制台指引操作。'
      : '还差一步初始设置（建新或加入一个 Mebular，数据都在本机）：';
  } else if (step.done) {
    detailText = registered
      ? '守护运行中（常驻已装 · 开机自启）。'
      : '守护运行中。当前是临时运行——关机/退出后不会自动拉起，想开机自启可让 Mebular 常驻。';
  } else {
    detailText = '守护未就绪：点「启动」；想开机自启就点「让 Mebular 常驻」。';
  }
  return {
    detailText,
    serviceBadge: step.done && !registered ? '临时运行' : null,
    actions: {
      provision: { label: '建新 / 加入 →', kind: 'primary', hidden: !provision.required },
      // 中-4：done 后「启动」禁用收起；「重启」收进折叠的「出问题了？」；常驻留作次级推荐
      start: { label: '启动', kind: 'primary', disabled: step.done, hidden: provision.required },
      install: { label: '让 Mebular 常驻', kind: 'ghost', hidden: registered, recommended: step.done && !registered },
      restart: { label: '重启守护', kind: 'ghost', area: 'troubleshoot', hidden: false },
    },
  };
}

/** 步骤②文案：① 未完成一律「先完成第①步」（409 等人话化收敛到这里）。 */
function assistantsText(step, start) {
  if (start && !start.done) return '先完成第①步：Mebular 跑起来（并完成初始设置）后才能连接助手。';
  const detail = step?.detail;
  if (!detail) return '—';
  if (detail.readError) return `状态读取受限：${detail.readError}（不阻断）—— 点下方按钮去控制台连接。`;
  return `已连接 ${detail.connectedCount ?? 0}/${detail.total ?? '—'} 个 AI 助手`;
}

/**
 * 邀请按钮点击决策（小-7）：已有令牌再点 → 需二次确认（confirm 标志位）；
 * 生成中一律禁用并显示 busyLabel。
 */
export function inviteClickPlan({ hasToken } = {}) {
  return {
    confirm: Boolean(hasToken),
    label: hasToken ? '重新生成邀请' : '生成邀请',
    busyLabel: '正在生成…',
  };
}
