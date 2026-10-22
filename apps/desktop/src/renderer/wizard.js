// M2/UX-2 · 一屏两段向导渲染层（无 node；只用 preload 白名单 window.mebularDesktop）
// W-1：全部展示决策来自纯视图模型 wizardView（与单测共用同一份契约）。
// UX-2：段①「一键开始」原位展开子步骤流水（失败定位 + 从此处续跑）；
//       段②行级接入（名称+状态词+一个动作；「已接入 ✓」不自动翻段，「已完成」显式确认）。

import { wizardView, flapGate, wizardRowStatus, WIZARD_SUBSTEPS } from './wizard-view.mjs';
import { applyStaticI18nWith, createTranslator, DEFAULT_LOCALE } from '../shared/i18n-core.mjs';

const api = window.mebularDesktop;

// 壳层 i18n：catalogs 由主进程经 preload 的 locale:get 下发（唯一真源 locales/<locale>/desktop.json）。
// 加载失败不阻断：HTML 内的中文静态兜底仍在，动态文案回退 key（数据层随包分发，正常不会走到）。
const localeBundle = await Promise.resolve(api?.getLocale?.()).catch(() => null);
const i18n = createTranslator({
  catalogs: localeBundle?.catalogs ?? {},
  locale: localeBundle?.locale ?? DEFAULT_LOCALE,
  fallbackLocale: localeBundle?.fallbackLocale ?? DEFAULT_LOCALE,
  defaultLocale: localeBundle?.defaultLocale ?? DEFAULT_LOCALE,
  supportedLocales: localeBundle?.supportedLocales ?? null,
});
const t = (key, vars) => i18n.t(key, vars);
document.documentElement.lang = i18n.locale;
applyStaticI18nWith(t, document);
document.title = t('wizard.windowTitle');

const CJK_TEXT = /[\u3400-\u9fff]/;
const isChineseLocale = () => String(i18n.locale).toLowerCase().startsWith('zh');

/** 主进程 warning/错误：优先稳定 warningKey；英文界面遇到未知中文原文时退回本动作兜底。 */
function detailFrom(result, fallbackKey = 'errors.unknown', vars = undefined) {
  if (result && typeof result.warningKey === 'string') {
    return t(result.warningKey, result.warningVars ?? vars);
  }
  return safeDetail(result?.warning, fallbackKey);
}

function safeDetail(raw, fallbackKey = 'errors.unknown') {
  const text = String(raw ?? '').trim();
  if (!text) return t(fallbackKey);
  if (isChineseLocale() || !CJK_TEXT.test(text)) return text;
  return t(fallbackKey);
}

const $ = (sel) => document.querySelector(sel);
const setText = (sel, text) => { const el = $(sel); if (el) el.textContent = text ?? ''; };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

// 日志区只在「进入异常态」的边沿自动展开一次（不打断用户手动收起）
let logsAutoOpened = false;

// ---------- 渲染（视图模型驱动；01-setup 设计稿：hero/tagline + 里程碑轨道 + done-line 回顾） ----------


function renderState(state) {
  if (!state) return;
  const view = wizardView(state, t);
  const complete = Boolean(state.complete);

  // 三态（用户定稿）：
  //   引导首页 = 全屏居中仅「开始部署」（外开已完成机器也回到这里——重启向导=从头走，部署幂等）
  //   部署中   = 标题上浮 + 阶段框（五步流水 + 旁白）
  //   完成     = 阶段框简述（五步全 ✓）+ 已就绪卡（仅本次会话刚完成时呈现——完成即奖励，再进=首页）
  // 流水运行中优先走「部署」呈现（已完工机器上重复点「开始部署」也完整走一遍动画）；
  // 仅「本次会话刚完成、且没在跑」才切完成简述
  const deployView = flow.running || (!complete && flow.everRan);
  const doneView = !deployView && complete && flow.everRan;
  const idleView = !deployView && !doneView;
  document.body.classList.toggle('is-idle', idleView);

  setText('#tagline', idleView ? t('wizard.tagline.idle') : (flow.running ? t('wizard.tagline.deploying') : view.tagline));
  const idleCta = $('#idle-cta');
  if (idleCta) idleCta.hidden = !idleView;
  const panel = $('#deploy-panel');
  if (panel) panel.hidden = !(deployView || doneView);
  const cta = $('#complete-cta');
  if (cta) cta.hidden = !doneView;
  const finishNote = $('#finish-note');
  if (finishNote && complete) {
    const pending = [...reloadHints];
    const appList = (() => {
      try {
        return new Intl.ListFormat(i18n.locale, { style: 'short', type: 'conjunction' }).format(pending);
      } catch {
        return pending.join(', ');
      }
    })();
    finishNote.innerHTML = (pending.length > 0
      ? `<span class="warn-text">${escapeHtml(t('wizard.complete.restartNotice', { apps: appList }))}</span><br />`
      : '') + `${escapeHtml(t('wizard.complete.note.line1'))}<br />${escapeHtml(t('wizard.complete.note.line2'))}`;
  }

  const start = view.steps.find((s) => s.id === 'start');
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

    if (doneView && !doneFxPlayed) { doneFxPlayed = true; playDoneFx(); } // 收尾动效：一次锁定（含已就绪入场）
    // 阶段框：五步现状（未跑流水时按状态静态推导；跑流水时由 runFlow 实时接管）
    if (!flow.running && !flow.everRan) {
      for (const sub of SUBSTEPS) setSubState(sub, start.flow[sub] ?? 'todo');
    }
  }

  // 异常（守护未启动/流水失败）→ 自动展开 + 一行结论；正常保持默认折叠
  const logsPanel = $('#logs-panel');
  const conclusion = $('#logs-conclusion');
  if (conclusion) {
    conclusion.hidden = !view.logs.conclusion;
    if (view.logs.conclusion) conclusion.textContent = view.logs.conclusion;
  }
  if (logsPanel) {
    // 简洁（用户定调）：日志是**异常件**——未开始不出现、① 就绪后不常驻；
    // 只有真失败（任一步失败）/ 守护未就绪才出现（并自动展开一次）。
    // P4：UNINITIALIZED 不是异常；自动接入失败仍要能看到真实原因。
    const showLogs = deployView && (
      Boolean(flow.failedSub)
      || (start?.status !== 'done' && !flow.running && flow.everRan)
    );
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

// 收尾动效（用户定稿 2 · 同框变身）：完成 → 部署内容退场、卡片收束，「已就绪」在本卡内入场
// （不再另起一张卡；「已完成/已就绪」两个完成词不再打架）
let doneFxPlayed = false;
function playDoneFx() {
  const panel = $('#deploy-panel');
  const flowBox = $('#deploy-flow');
  const cta = $('#complete-cta');
  if (!panel) return;
  const compact = () => panel.classList.add('is-compact');
  if (reducedMotion) { compact(); return; } // 减动效：直达变身态
  const h0 = panel.getBoundingClientRect().height;
  [...(flowBox?.children ?? [])]
    .filter((el) => !el.hidden)
    .forEach((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: 'forwards' }));
  window.setTimeout(() => {
    compact();
    const h1 = panel.getBoundingClientRect().height;
    panel.animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' });
    cta?.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 320, delay: 160, easing: 'ease-out', fill: 'backwards' });
  }, 160);
}

// P4：不再有重启/安装宽限窗——流水只启动 + 接入，完成后一次导航进控制台。

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
    renderState(state);
  } catch (error) { setText('#start-detail', t('wizard.state.readFailed', { error: safeDetail(error?.message, 'errors.unknown') })); }
}

// ---------- 段① 一键开始：五步真实流水（启动 → 就绪 → 检查助手 → 接入 MCP → 控制台） ----------

const SUBSTEPS = WIZARD_SUBSTEPS;
// 过程可见性：每个子步最小停留（太快等于没展示）；汇总行读完再收尾
const SUB_MIN_DWELL_MS = 900;
const flow = { running: false, everRan: false, failedSub: null, probe: null };
// P4：自动流程结束只导航一次；按钮兜底也复用同一入口，避免重复打开/重复加载。
let consoleOpened = false;
async function openConsoleOnce() {
  if (consoleOpened) return;
  consoleOpened = true;
  try {
    await api.openConsole();
  } catch (error) {
    consoleOpened = false; // 导航失败时允许用户再点一次
    throw error;
  }
}
// 可自动接入的目标：已装、未接、非 manual 兜底、非检测失败
function connectTargets(clients) {
  return (clients ?? []).filter((c) => c.installed && !c.connected
    && c.state !== 'manual' && c.needsManual !== true && c.state !== 'detect-failed');
}
/** 逐个自动接入（旁白式进度：一次只报当前一个；失败非阻断，收尾汇总）。返回 { ok:[], failed:[], targets:number }。 */
async function autoConnectAll(clientsInput) {
  let clients = clientsInput;
  if (!Array.isArray(clients)) {
    // 续跑兜底：没有本轮 probe 结果时，重新读取真实列表；读不到即失败（不伪造 0 个）。
    const res = await api.clientsList();
    if (!res?.ok) throw new Error(detailFrom(res, 'wizard.error.readClients'));
    clients = res.clients ?? [];
  }
  const targets = connectTargets(clients);
  const ok = [];
  const failed = [];
  for (let i = 0; i < targets.length; i += 1) {
    const c = targets[i];
    flowMsg(t('wizard.flowMsg.connectingOne', { name: c.name, index: i + 1, total: targets.length }));
    try {
      const r = await api.clientsAction(c.id, 'connect');
      if (r?.ok) {
        ok.push(c.name);
        reloadHints.add(c.id); // 完成页提醒名单（重启对应软件后生效）
      } else {
        failed.push(t('wizard.flowMsg.connectFailedItem', {
          name: c.name,
          reason: detailFrom(r, 'wizard.flowMsg.connectFailed'),
        }));
      }
    } catch (error) {
      failed.push(`${c.name}（${safeDetail(error?.message, 'errors.unknown')}）`);
    }
  }
  return { ok, failed, targets: targets.length };
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
  if (fromSub === 'launch') flow.probe = null;
  $('#start-flow').hidden = false;
  $('#btn-go').hidden = true;
  $('#btn-resume').hidden = true;
  flowMsg('');
  doneFxPlayed = false; // 重置收尾动效：重复部署整场可再次播放
  $('#deploy-panel')?.classList.remove('is-compact');
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
        flowMsg(t('wizard.flowMsg.launching'));
        await api.start();
      } else if (sub === 'ready') {
        flowMsg(t('wizard.flowMsg.waiting'));
        const ok = await pollState((s) => Boolean(s?.steps?.[0]?.detail?.healthy));
        if (!ok) throw new Error(t('wizard.flowMsg.notReady'));
      } else if (sub === 'probe') {
        // 真实检查：读取 clients 列表并统计已装/需要接入；读不到即失败，绝不伪造 0 个。
        flowMsg(t('wizard.flowMsg.probing'));
        let res;
        try {
          res = await api.clientsList();
        } catch (error) {
          throw new Error(t('wizard.error.readClientsDetail', { error: safeDetail(error?.message, 'errors.unknown') }));
        }
        if (!res?.ok) throw new Error(t('wizard.error.readClientsUnknown', { reason: detailFrom(res, 'wizard.error.readClients') }));
        const clients = Array.isArray(res.clients) ? res.clients : [];
        const installed = clients.filter((c) => c.installed).length;
        const targets = connectTargets(clients);
        flow.probe = { clients, installed, targets: targets.length };
        flowMsg(installed === 0
          ? t('wizard.flowMsg.probeEmpty')
          : t('wizard.flowMsg.probeCount', { installed, targets: targets.length }));
      } else if (sub === 'connect') {
        // 一键启动的核心自动化：把 probe 找到的已装助手 MCP 配置全部接上（失败非阻断）。
        // P2：UNINITIALIZED 下 /admin/api/clients 与 connect 均可用；MCP 未初始化不再误报连接失败。
        const probe = flow.probe;
        if (!probe) flowMsg(t('wizard.flowMsg.connecting'));
        else if (probe.targets === 0) flowMsg(t('wizard.flowMsg.nothingToDo'));
        else flowMsg(t('wizard.flowMsg.connectCount', { count: probe.targets }));
        const { ok, failed } = await autoConnectAll(probe?.clients);
        if (failed.length > 0) {
          flowMsg(t('wizard.flowMsg.connectPartial', {
            ok: ok.length,
            failed: failed.join(t('wizard.flowMsg.failedSeparator')),
          }), true);
        } else if (ok.length > 0) {
          flowMsg(t('wizard.flowMsg.connectOk', { ok: ok.length }));
        } else {
          flowMsg(t('wizard.flowMsg.connectNone'));
        }
      } else if (sub === 'console') {
        // 用户点过「开始部署」= 对 ② 的显式确认：统一 ack（个别未成功的已给原因，重试归设置·AI 助手）。
        flowMsg(t('wizard.flowMsg.openConsole'));
        try { await api.ackAssistants(); } catch { /* 落盘失败不阻断 */ }
        await openConsoleOnce();
      }
      setSubState(sub, 'done');
      await sleep(SUB_MIN_DWELL_MS); // 最小停留：让每一步看得见
    }
    flowMsg(t('wizard.flowMsg.ready'));
    flow.failedSub = null;
    await sleep(SUB_MIN_DWELL_MS + 600); // 汇总行停留：读完再进完成态
  } catch (error) {
    setSubState(currentSub, 'failed');
    flow.failedSub = currentSub;
    flowMsg(t('wizard.flowMsg.failed', { error: safeDetail(error?.message, 'errors.unknown') }), true);
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

// 完成段为终态单行（用户定调：展开/高级都是自动保障，不给用户找活——
// 守护/配置异常时视图自动回到操作态并给恢复入口）

// ---------- 段② 行级接入（名称 + 状态词 + 一个动作；与 设置 · AI 助手 同一语言） ----------

// 补丁 3 增补：语义更名 pendingReload → reloadHints（提示层「已写入·请重载」，**不再驱动「待生效」状态词**）；
const reloadHints = new Set();
// UX-2 补丁 3：行级失败态（id → { kind: 'connect'|'verify', reason }）——失败绝不显示「待生效」
let clientsSignature = null;

$('#btn-skip')?.addEventListener('click', () => { void api.skipWizard(); });
$('#btn-enter-console')?.addEventListener('click', () => { void openConsoleOnce(); });

// ---------- 诊断与日志 ----------

async function loadLogs() {
  try {
    const res = await api.readLogs();
    setText('#logs-source', res?.source === 'service' ? t('wizard.logs.source.service') : res?.source === 'file' ? t('wizard.logs.source.file') : t('wizard.logs.source.none'));
    setText('#log', res?.text || t('wizard.logs.empty'));
  } catch (error) {
    setText('#log', t('wizard.logs.readFailed', { error: safeDetail(error?.message, 'errors.unknown') }));
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
