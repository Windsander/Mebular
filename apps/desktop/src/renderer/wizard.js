// M2/UX-2 · 一屏两段向导渲染层（无 node；只用 preload 白名单 window.mebularDesktop）
// W-1：全部展示决策来自纯视图模型 wizardView（与单测共用同一份契约）。
// UX-2：段①「一键开始」原位展开子步骤流水（失败定位 + 从此处续跑）；
//       段②行级接入（名称+状态词+一个动作；「已接入 ✓」不自动翻段，「已完成」显式确认）。

import { wizardView, flapGate, wizardRowStatus } from './wizard-view.mjs';

const api = window.mebularDesktop;

const $ = (sel) => document.querySelector(sel);
const setText = (sel, text) => { const el = $(sel); if (el) el.textContent = text ?? ''; };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

// 日志区只在「进入异常态」的边沿自动展开一次（不打断用户手动收起）
let logsAutoOpened = false;

// ---------- 渲染（视图模型驱动；01-setup 设计稿：hero/tagline + 里程碑轨道 + done-line 回顾） ----------


function renderState(state) {
  if (!state) return;
  const view = wizardView(state);
  const complete = Boolean(state.complete);

  // 三态（用户定稿）：
  //   引导首页 = 全屏居中仅「开始部署」（外开已完成机器也回到这里——重启向导=从头走，部署幂等）
  //   部署中   = 标题上浮 + 阶段框（四步流水 + 旁白）
  //   完成     = 阶段框简述（四步全 ✓）+ 已就绪卡（仅本次会话刚完成时呈现——完成即奖励，再进=首页）
  // 流水运行中优先走「部署」呈现（已完工机器上重复点「开始部署」也完整走一遍动画）；
  // 仅「本次会话刚完成、且没在跑」才切完成简述
  const deployView = flow.running || (!complete && (flow.everRan || Date.now() < graceUntil));
  const doneView = !deployView && complete && flow.everRan;
  const idleView = !deployView && !doneView;
  document.body.classList.toggle('is-idle', idleView);

  setText('#tagline', idleView ? '点一下，接入设备' : (flow.running ? '正在部署…' : view.tagline));
  const idleCta = $('#idle-cta');
  if (idleCta) idleCta.hidden = !idleView;
  const panel = $('#deploy-panel');
  if (panel) panel.hidden = !(deployView || doneView);
  const cta = $('#complete-cta');
  if (cta) cta.hidden = !doneView;
  const finishNote = $('#finish-note');
  if (finishNote && complete) {
    const pending = [...reloadHints];
    finishNote.innerHTML = (pending.length > 0
      ? `<span class="warn-text">提醒：重启 ${pending.map((n) => escapeHtml(n)).join('、')} 这个软件后，mebular 才会出现在它的工具列表。</span><br />`
      : '') + '之后想接更多助手、邀请其他设备，都在控制台里：<br />顶栏「＋ 邀请新设备」随时可用。';
  }

  const start = view.steps.find((s) => s.id === 'start');
  const assistantsDone = Boolean(state.steps?.find((s) => s.id === 'assistants')?.done);
  if (start && (deployView || doneView)) {
    setText('#start-detail', start.detailText);
    const startDetail = $('#start-detail');
    if (startDetail) startDetail.hidden = doneView; // 简述：完成态收掉状态行
    const svcBadge = $('#start-service-badge');
    if (svcBadge) svcBadge.hidden = !start.serviceBadge;
    const goRow = $('#go-row');
    if (goRow) goRow.hidden = doneView; // 简述：完成态无动作行
    const btnGo = $('#btn-go');
    if (btnGo) btnGo.hidden = Boolean(start.actions.go.hidden) || flow.running || doneView;
    const altJoin = $('#alt-join');
    if (altJoin) altJoin.hidden = Boolean(start.actions.join?.hidden ?? true) || flow.running;
    const btnProvision = $('#btn-provision');
    if (btnProvision) btnProvision.hidden = Boolean(start.actions.provision.hidden);

    if (doneView) {
      const msgEl = $('#flow-msg');
      if (msgEl) msgEl.textContent = '';
    }
    // 阶段框：四步现状（未跑流水时按状态静态推导；跑流水时由 runFlow 实时接管）
    if (!flow.running && !flow.everRan) {
      for (const sub of ['launch', 'write', 'recover']) setSubState(sub, start.flow[sub] ?? 'todo');
      setSubState('connect', assistantsDone ? 'done' : (start.status === 'done' ? 'active' : 'todo'));
    }
  }

  // 异常（引导态/启动失败）→ 自动展开 + 一行结论；正常保持默认折叠
  const logsPanel = $('#logs-panel');
  const conclusion = $('#logs-conclusion');
  if (conclusion) {
    conclusion.hidden = !view.logs.conclusion;
    if (view.logs.conclusion) conclusion.textContent = view.logs.conclusion;
  }
  if (logsPanel) {
    // 简洁（用户定调）：日志是**异常件**——未开始不出现、① 就绪后不常驻；
    // 只有真失败（跑过流水且失败）/ 运行中 / 引导态才出现（并自动展开一次）
    const provisionRequired = Boolean(state?.steps?.[0]?.detail?.provision?.required);
    // 日志=异常件：健康部署中不弹（旧式 everRan||running 会让折条随流水全程出现）；失败/引导态才亮
    const showLogs = deployView && start?.status !== 'done'
      && (Boolean(flow.failedSub) || provisionRequired || (!flow.running && flow.everRan));
    logsPanel.hidden = !showLogs;
    if (showLogs && view.logs.open && !logsAutoOpened) {
      logsPanel.open = true;
      logsAutoOpened = true;
    }
  }
}

function escapeHtml(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// F4④ 重启/安装宽限窗（≤60s）：① 已完成期间的健康瞬断不翻回未完成（grace 注入视图模型）
let graceUntil = 0;
function armGrace(ms = 60000) { graceUntil = Date.now() + ms; }

// UX-2 补丁 3：① 瞬态容忍（flapGate 纯函数）——连续 ≥2 次 miss 才翻回未完成；单次 miss UI 不动
let healthMisses = 0;
let lastStartDone = false;

async function refresh() {
  try {
    const state = await api.wizardState();
    const gate = flapGate({
      lastDone: lastStartDone,
      done: Boolean(state?.steps?.[0]?.done),
      misses: healthMisses,
    });
    healthMisses = gate.misses;
    lastStartDone = gate.lastDone;
    if (gate.hold) return; // 单次 miss：不翻段、不自动展开日志（其他区随下一轮更新）
    if (Date.now() < graceUntil && state && !state.complete) state.grace = true;
    renderState(state);
  } catch (error) { setText('#start-detail', `状态读取失败：${error.message}`); }
}

// ---------- 段① 一键开始：子步骤流水（启动 → 写入初始设置 → 重启恢复） ----------

const SUBSTEPS = ['launch', 'write', 'recover', 'connect'];
// 过程可见性：每个子步最小停留（太快等于没展示）；汇总行读完再收尾
const SUB_MIN_DWELL_MS = 900;
const flow = { running: false, everRan: false, failedSub: null };
// 可自动接入的目标：已装、未接、非 manual 兜底、非检测失败
function connectTargets(clients) {
  return (clients ?? []).filter((c) => c.installed && !c.connected
    && c.state !== 'manual' && c.needsManual !== true && c.state !== 'detect-failed');
}
/** 逐个自动接入（旁白式进度：一次只报当前一个；失败非阻断，收尾汇总）。返回 { ok:[], failed:[] }。 */
async function autoConnectAll() {
  let clients = [];
  try { clients = (await api.clientsList())?.clients ?? []; } catch { return { ok: [], failed: [] }; }
  const targets = connectTargets(clients);
  const ok = [];
  const failed = [];
  for (let i = 0; i < targets.length; i += 1) {
    const c = targets[i];
    flowMsg(`正在接入 ${c.name}…（${i + 1}/${targets.length}）`);
    try {
      const r = await api.clientsAction(c.id, 'connect');
      if (r?.ok) {
        ok.push(c.name);
        reloadHints.add(c.id); // 完成页提醒名单（重启对应软件后生效）
      } else {
        failed.push(`${c.name}（${r?.warning ?? '未成功'}）`);
      }
    } catch (error) {
      failed.push(`${c.name}（${error?.message ?? error}）`);
    }
  }
  return { ok, failed };
}

function setSubState(sub, state) {
  const li = document.querySelector(`#start-flow [data-sub="${sub}"]`);
  if (li) li.dataset.state = state;
}

function flowMsg(text, isError = false) {
  const el = $('#flow-msg');
  if (!el) return;
  el.textContent = text ?? '';
  el.classList.toggle('error', Boolean(isError));
}

/** 有界轮询 wizardState 直到谓词满足（每 1.5s，最多 40 次 = 60s 上限）。 */
async function pollState(predicate) {
  for (let i = 0; i < 40; i += 1) {
    const state = await api.wizardState();
    if (predicate(state)) return state;
    await sleep(1500);
  }
  return null;
}

async function runFlow(fromSub = 'launch') {
  if (flow.running) return;
  flow.running = true;
  flow.everRan = true;
  flow.failedSub = null;
  $('#start-flow').hidden = false;
  $('#btn-go').hidden = true;
  $('#btn-resume').hidden = true;
  flowMsg('');
  // 立即上屏：阶段框在本帧出现（3s 轮询曾有 running 守卫，点击后屏幕会冻在初始页直跳完成——走查事故）
  // 开场动画（用户定稿手势）：品牌从居中滑到顶部 → 卡片随后展开（FLIP；reduced-motion 直接切换）
  const heroEl = $('.hero');
  const panelEl = $('#deploy-panel');
  const heroBefore = heroEl?.getBoundingClientRect();
  await refresh();
  if (!reducedMotion && heroEl && heroBefore) {
    const dy = heroBefore.top - heroEl.getBoundingClientRect().top;
    if (Math.abs(dy) > 2) {
      heroEl.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
        { duration: 420, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' });
    }
  }
  if (!reducedMotion && panelEl && !panelEl.hidden) {
    panelEl.animate([{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 420, delay: 140, easing: 'ease-out', fill: 'backwards' });
  }

  const startIndex = SUBSTEPS.indexOf(fromSub);
  let currentSub = fromSub;
  try {
    for (let i = Math.max(0, startIndex); i < SUBSTEPS.length; i += 1) {
      const sub = SUBSTEPS[i];
      currentSub = sub;
      setSubState(sub, 'active');
      if (sub === 'launch') {
        flowMsg('正在启动守护…');
        await api.start();
        const ok = await pollState((s) => Boolean(s?.steps?.[0]?.detail?.healthy));
        if (!ok) throw new Error('守护未在 60s 内就绪');
      } else if (sub === 'write') {
        const state = await api.wizardState();
        const provision = state?.steps?.[0]?.detail?.provision ?? { required: false };
        if (provision.required && !provision.provisioned) {
          // F3：不自动跳控制台——给出显式按钮，由用户点开（引导期间窗口不擅自导航）
          flowMsg('点「去写入初始设置 →」打开控制台，选「建新」或「加入」，完成后这里自动继续…');
          $('#btn-provision').hidden = false;
          const ok = await pollState((s) => {
            const p = s?.steps?.[0]?.detail?.provision ?? {};
            return !p.required || Boolean(p.provisioned);
          });
          if (!ok) throw new Error('初始设置未在 60s 内完成');
        }
      } else if (sub === 'recover') {
        const state = await api.wizardState();
        const provision = state?.steps?.[0]?.detail?.provision ?? { required: false };
        if (provision.required) {
          flowMsg('正在重启守护以恢复…');
          armGrace(); // 重启窗口内 ① 不翻回未完成
          await api.restart();
          const ok = await pollState((s) => {
            const d = s?.steps?.[0]?.detail ?? {};
            return Boolean(d.healthy) && !d.provision?.required;
          });
          if (!ok) throw new Error('重启后守护未在 60s 内恢复');
        }
      } else if (sub === 'connect') {
        // 一键启动的核心自动化：把已装的 AI 助手全部接上（行内实时翻状态；失败非阻断）
        flowMsg('正在接入 AI 助手…');
        const { ok, failed } = await autoConnectAll();
        if (failed.length > 0) {
          flowMsg(`已自动接入 ${ok.length} 个；${failed.join('；')}——可在 设置 → AI 助手 重试。`, true);
        } else if (ok.length > 0) {
          flowMsg(`已接入 ${ok.length} 个 AI 助手——重启对应软件后生效。`);
        } else {
          flowMsg('没有需要接入的助手。');
        }
      }
      setSubState(sub, 'done');
      await sleep(SUB_MIN_DWELL_MS); // 最小停留：让每一步看得见
    }
    flowMsg('已就绪 ✓');
    flow.failedSub = null;
    await sleep(SUB_MIN_DWELL_MS + 600); // 汇总行停留：读完再进完成态
    // 用户点过「一键开始」= 对 ② 的显式确认：统一 ack 收尾（个别未成功的已给原因，重试归设置·AI 助手）
    try { await api.ackAssistants(); } catch { /* 落盘失败不阻断 */ }
  } catch (error) {
    setSubState(currentSub, 'failed');
    flow.failedSub = currentSub;
    flowMsg(`这一步没走完：${error.message}。可「从此处续跑」，或开下方日志看原因。`, true);
    $('#btn-resume').hidden = false;
    $('#logs-panel').open = true;
  } finally {
    flow.running = false;
    $('#btn-go').hidden = true; // 跑过后由「续跑」/状态驱动，不再回显主按钮（幂等）
    await refresh();
    }
}

$('#btn-go')?.addEventListener('click', () => { void runFlow('launch'); });
$('#btn-resume')?.addEventListener('click', () => { void runFlow(flow.failedSub ?? 'launch'); });
$('#btn-provision')?.addEventListener('click', () => { void api.openConsole(); });

// 完成段为终态单行（用户定调：展开/高级都是自动保障，不给用户找活——
// 守护/配置异常时视图自动回到操作态并给恢复入口）

// ---------- 段② 行级接入（名称 + 状态词 + 一个动作；与 设置 · AI 助手 同一语言） ----------

// 补丁 3 增补：语义更名 pendingReload → reloadHints（提示层「已写入·请重载」，**不再驱动「待生效」状态词**）；
const reloadHints = new Set();
// UX-2 补丁 3：行级失败态（id → { kind: 'connect'|'verify', reason }）——失败绝不显示「待生效」
let clientsSignature = null;

$('#alt-join')?.addEventListener('click', () => { void api.openConsole(); });

$('#btn-skip')?.addEventListener('click', () => { void api.skipWizard(); });
$('#btn-enter-console')?.addEventListener('click', () => { void api.openConsole(); });

// ---------- 诊断与日志 ----------

async function loadLogs() {
  try {
    const res = await api.readLogs();
    setText('#logs-source', res?.source === 'service' ? '来源：常驻服务日志' : res?.source === 'file' ? '来源：serve.log' : '暂无日志');
    setText('#log', res?.text || '(空)');
  } catch (error) {
    setText('#log', `读取失败：${error.message}`);
  }
}
$('#btn-logs')?.addEventListener('click', () => { void loadLogs(); });
$('#btn-logs-open')?.addEventListener('click', () => { void api.openLogs(); });

// ---------- 星野舞台（轻量；省电纪律：仅可见时渲染、隐藏即停；prefers-reduced-motion → 静止一帧） ----------

(function sky() {
  const canvas = $('#sky');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  let stars = [];
  let rafId = null;
  let running = false;
  function resize() {
    canvas.width = Math.floor(window.innerWidth * (window.devicePixelRatio || 1));
    canvas.height = Math.floor(window.innerHeight * (window.devicePixelRatio || 1));
    const count = Math.min(160, Math.floor((canvas.width * canvas.height) / 16000));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: Math.random() * 1.4 + 0.3,
      p: Math.random() * Math.PI * 2,
      // 每颗星独立频率（0.55~1.45 倍速）：错落闪烁，避免整体同步呼吸的「假星星」感
      s: 0.55 + Math.random() * 0.9,
    }));
  }
  function draw(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      // 星野闪烁：每颗独立频率慢速明灭（基准 1.6s × 0.55~1.45）——错落、明显、不抢戏；
      // 与「整页闪烁」（合成级，已由去 backdrop-filter 治理）不是一回事
      const tw = reduced ? 0.6 : 0.42 + 0.3 * Math.sin(t * s.s / 1600 + s.p);
      ctx.globalAlpha = Math.max(0.12, tw);
      ctx.fillStyle = '#b4ffd6'; // 设计稿星色（console 契约：稀疏、缓慢、不抢戏）
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function loop(t) {
    draw(t);
    rafId = running ? window.requestAnimationFrame(loop) : null;
  }
  function setRunning(on) {
    if (reduced || on === running) return;
    running = on;
    if (on) {
      if (rafId === null) rafId = window.requestAnimationFrame(loop);
    } else if (rafId !== null) {
      window.cancelAnimationFrame(rafId); // 隐藏即停：不再消耗 GPU/电量
      rafId = null;
    }
  }
  window.addEventListener('resize', () => { resize(); draw(0); });
  document.addEventListener('visibilitychange', () => setRunning(document.visibilityState === 'visible'));
  resize();
  if (reduced) draw(0);
  else setRunning(document.visibilityState === 'visible');
})();

void refresh();
void loadLogs();
// 状态轮询（幂等；跑流水期间必须照常——阶段框显隐由 renderState 驱动，曾被 running 守卫吞掉）
setInterval(() => { void refresh(); void loadLogs(); }, 3000);
