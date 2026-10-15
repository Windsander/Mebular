// M2/UX-2 · 一屏两段向导渲染层（无 node；只用 preload 白名单 window.mebularDesktop）
// W-1：全部展示决策来自纯视图模型 wizardView（与单测共用同一份契约）。
// UX-2：段①「一键开始」原位展开子步骤流水（失败定位 + 从此处续跑）；
//       段②行级接入（名称+状态词+一个动作；「已接入 ✓」不自动翻段，「已完成」显式确认）。

import { wizardView, flapGate, wizardRowStatus } from './wizard-view.mjs';
import { reconcileAssistantUi } from '../../../../packages/console/assistant-status.js';

const api = window.mebularDesktop;

const $ = (sel) => document.querySelector(sel);
const setText = (sel, text) => { const el = $(sel); if (el) el.textContent = text ?? ''; };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 日志区只在「进入异常态」的边沿自动展开一次（不打断用户手动收起）
let logsAutoOpened = false;

// ---------- 渲染（视图模型驱动；01-setup 设计稿：hero/tagline + 里程碑轨道 + done-line 回顾） ----------

// 已设置过·直达变体：首次拿到的状态就是完成态 → 「欢迎回来」替换整个轨道
let firstSeen = false;

function renderState(state) {
  if (!state) return;
  const view = wizardView(state);

  // 直达变体仅按**首次**状态判定（跑完流程当场完成仍走 finish 暖收尾）
  if (!firstSeen) {
    firstSeen = true;
    if (state.complete) document.body.classList.add('is-existing');
  }
  const existing = document.body.classList.contains('is-existing');
  const existingEl = $('#existing');
  if (existingEl) existingEl.hidden = !existing;

  setText('#tagline', existing ? '' : view.tagline);

  const badge = $('#daemon-badge');
  if (badge) {
    badge.textContent = view.badge;
    badge.classList.toggle('todo', !state.complete);
  }

  // 完成态 → 「已就绪 ✦」暖收尾（单一主按钮）+ 两段折叠为回顾（done-line 可再展开）
  const cta = $('#complete-cta');
  if (cta) {
    cta.hidden = !view.complete || existing;
    cta.classList.toggle('show', Boolean(view.complete) && !existing);
  }
  const finishNote = $('#finish-note');
  if (finishNote && view.complete) {
    const pending = [...reloadHints];
    finishNote.innerHTML = (pending.length > 0
      ? `<span class="warn-text">提醒：重启 ${pending.map((n) => escapeHtml(n)).join('、')} 这个软件后，mebular 才会出现在它的工具列表。</span><br />`
      : '') + '之后想接更多助手、邀请其他设备，都在控制台里：<br />顶栏「＋ 邀请新设备」随时可用。';
  }

  for (const step of view.steps) {
    const el = document.getElementById(`step-${step.id}`);
    if (!el) continue;
    el.classList.toggle('done', step.status === 'done');
    el.classList.toggle('is-current', step.status === 'current');
    // 里程碑轨道节点态：active=呼吸 / done=✓ / locked=暗（未到段不可点）
    el.classList.toggle('active', step.node === 'active');
    el.classList.toggle('locked', step.node === 'locked');
    el.classList.toggle('is-collapsed', Boolean(step.collapsed)); // 完成即终态单行（无展开交互；异常时视图自动回到操作态）
    const check = el.querySelector('.step-check');
    if (check) check.hidden = !step.check;
    // done-line 回顾行（折叠时可见；点击重新展开）
    const doneLine = el.querySelector('.done-line');
    if (doneLine && step.doneLine) {
      const [main, sub] = [doneLine.querySelector('span:first-child'), doneLine.querySelector('.muted')];
      if (main) main.textContent = step.doneLine.main;
      if (sub) sub.textContent = step.doneLine.sub;
    }
  }

  const start = view.steps.find((s) => s.id === 'start');
  if (start) {
    setText('#start-detail', start.detailText);
    const svcBadge = $('#start-service-badge');
    if (svcBadge) svcBadge.hidden = !start.serviceBadge;
    const btnGo = $('#btn-go');
    if (btnGo) btnGo.hidden = Boolean(start.actions.go.hidden) || flow.running;
    const btnProvision = $('#btn-provision');
    if (btnProvision) btnProvision.hidden = Boolean(start.actions.provision.hidden);
    const altJoin = $('#alt-join');
    if (altJoin) altJoin.hidden = Boolean(start.actions.join?.hidden ?? true);
    const btnInstall = $('#btn-install');
    if (btnInstall) {
      btnInstall.hidden = Boolean(start.actions.install.hidden);
      btnInstall.disabled = Boolean(start.actions.install.disabled);
      if (start.actions.install.label) btnInstall.textContent = start.actions.install.label;
    }
    // P1 简化：常驻只在 ① 完成后以「开机自启？」一行出现（推荐、非阻塞），不占首屏
    const postRow = $('#postdone-row');
    if (postRow) postRow.hidden = !(start.status === 'done' && !start.actions.install.hidden);
    // 非跑流水期间：流水面板按静态进度呈现（① 未完成且从未跑过 → 保持隐藏）
    if (!flow.running && !flow.everRan) {
      const flowEl = $('#start-flow');
      const showStatic = start.status !== 'done' && (start.flow.write !== 'todo' || start.flow.launch !== 'todo');
      if (flowEl) flowEl.hidden = !showStatic;
      if (showStatic) for (const sub of ['launch', 'write', 'recover']) setSubState(sub, start.flow[sub] ?? 'todo');
    }
  }

  const assistants = view.steps.find((s) => s.id === 'assistants');
  if (assistants) {
    setText('#assistants-detail', assistants.detailText);
    const doneBtn = $('#btn-seg2-done');
    if (doneBtn) {
      doneBtn.disabled = !assistants.doneEnabled;
      doneBtn.hidden = Boolean(assistants.doneHidden);
    }
    const skipBtn = $('#btn-seg2-skip');
    if (skipBtn) skipBtn.hidden = Boolean(assistants.skipConnect?.hidden ?? true);
    setText('#done2-hint', assistants.doneHint ?? '');
  }

  // 异常（引导态/启动失败）→ 自动展开 + 一行结论；正常保持默认折叠
  const logsPanel = $('#logs-panel');
  const conclusion = $('#logs-conclusion');
  if (conclusion) {
    conclusion.hidden = !view.logs.conclusion;
    if (view.logs.conclusion) conclusion.textContent = view.logs.conclusion;
  }
  if (logsPanel) {
    // 简洁（用户定调）：① 就绪后日志折条不常驻；有异常待办时才出现（并自动展开一次）
    const startStep = view.steps.find((s) => s.id === 'start');
    logsPanel.hidden = startStep?.status === 'done';
    if (!logsPanel.hidden && view.logs.open && !logsAutoOpened) {
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

const SUBSTEPS = ['launch', 'write', 'recover'];
const flow = { running: false, everRan: false, failedSub: null };

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
      }
      setSubState(sub, 'done');
    }
    flowMsg('已就绪 ✓');
    flow.failedSub = null;
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
    await loadClients();
  }
}

$('#btn-go')?.addEventListener('click', () => { void runFlow('launch'); });
$('#btn-resume')?.addEventListener('click', () => { void runFlow(flow.failedSub ?? 'launch'); });
$('#btn-provision')?.addEventListener('click', () => { void api.openConsole(); });
$('#btn-start')?.addEventListener('click', async () => { await api.start(); await refresh(); });
// F2c/F4④：安装常驻 = 登记后守护被 launchd 接管重启 → 按钮进「重启中…」过渡（≤60s 轮询），
// 宽限窗内 ① 不翻回未完成；已注册则服务端 no-op（already）直接刷新。
$('#btn-install')?.addEventListener('click', async () => {
  const btn = $('#btn-install');
  if (btn) { btn.disabled = true; btn.textContent = '重启中…'; }
  try {
    const res = await api.serviceInstall();
    if (res?.ok === false) throw new Error(res.reason ?? '安装失败');
    if (!res?.already) {
      armGrace();
      await refresh(); // 立刻进宽限呈现（不等健康瞬断发生）
      const ok = await pollState((s) => {
        const d = s?.steps?.[0]?.detail ?? {};
        return Boolean(d.healthy) && d.registered === true;
      });
      if (!ok) flowMsg('守护仍在恢复中：稍候会自动刷新；若持续异常请看下方日志。');
    }
  } catch (error) {
    setText('#start-detail', `安装常驻失败：${error.message}`);
  } finally {
    if (btn) btn.disabled = false; // 文案由下次 renderState 按视图模型恢复
    await refresh();
  }
});
$('#btn-restart')?.addEventListener('click', async () => { armGrace(); await api.restart(); await refresh(); });

// 完成段为终态单行（用户定调：展开/高级都是自动保障，不给用户找活——
// 守护/配置异常时视图自动回到操作态并给恢复入口）

// ---------- 段② 行级接入（名称 + 状态词 + 一个动作；与 设置 · AI 助手 同一语言） ----------

// 补丁 3 增补：语义更名 pendingReload → reloadHints（提示层「已写入·请重载」，**不再驱动「待生效」状态词**）；
// rowVerify = 最近一次服务端 verify 真值（pending-restart 是「待生效」唯一正当来源）。
const reloadHints = new Set();
const rowVerify = new Map();
// UX-2 补丁 3：行级失败态（id → { kind: 'connect'|'verify', reason }）——失败绝不显示「待生效」
const rowFailed = new Map();
let clientsSignature = null;

function renderClients(clients) {
  const list = $('#asst-list');
  if (!list) return;
  if (!Array.isArray(clients)) {
    list.innerHTML = '<p class="amsg">助手列表加载中…</p>';
    return;
  }
  const signature = JSON.stringify(
    clients.map((c) => [c.id, Boolean(c.installed), Boolean(c.connected), c.state ?? null])
      .concat([...reloadHints].map((k) => `hint:${k}`))
      .concat([...rowFailed.keys()].map((k) => `fail:${k}`))
      .concat([...rowVerify.entries()].map(([k, v]) => `verify:${k}:${v}`)),
  );
  if (signature === clientsSignature) return;
  clientsSignature = signature;
  const failedObj = Object.fromEntries(rowFailed);
  const verifyObj = Object.fromEntries(rowVerify);
  // P1 简化：只显示**已安装**的助手（未装不出现——装好后自会进来）；每行一个动作
  // 只显示**真实已装**的助手：未安装不出现；内置兜底「其他 AI 助手（复制片段）」（state=manual）不进向导（太干扰，归设置处理）
  const visible = clients.filter((c) => (c.state ?? (c.installed ? 'x' : 'not-installed')) !== 'not-installed'
    && c.state !== 'detect-failed' && c.state !== 'manual' && c.needsManual !== true);
  if (visible.length === 0) {
    list.innerHTML = '<p class="amsg">没检测到已装的 AI 助手——可以先跳过，装好后回到这里（或到 设置 → AI 助手 接入）。</p>';
    return;
  }
  list.innerHTML = visible.map((c) => {
    const st = wizardRowStatus(c, { pending: reloadHints, failed: failedObj, verifyStates: verifyObj });
    let action = '';
    if (st.key === 'not-connected') action = `<button data-asst-act="connect" data-asst-id="${c.id}">接入</button>`;
    else if (st.key === 'connect-failed') action = `<button data-asst-act="connect" data-asst-id="${c.id}">重试</button>`;
    else if (st.key === 'verify-failed') action = `<button data-asst-act="verify" data-asst-id="${c.id}">重新验证</button>`;
    else if (st.key === 'pending-reload' || (st.key === 'connected' && st.reloadHint)) {
      // 提示层/待生效共用动作：「我已重载，验证」（有验证命令走服务端 verify，否则回读重检测）
      action = c.hasVerify
        ? `<button data-asst-act="verify" data-asst-id="${c.id}">我已重载，验证</button>`
        : `<button data-asst-act="recheck" data-asst-id="${c.id}">我已重载，验证</button>`;
    }
    else if (st.key === 'manual') action = `<button class="ghost" data-asst-act="console" data-asst-id="${c.id}">去控制台处理 ›</button>`;
    // 简化轮：提示层收进同一行（小字，不出新行）；成功/在途不新增行，仅失败时给原因行
    const hintInline = st.reloadHint && st.key === 'connected'
      ? '<span class="ast-hint">已写入 · 重启后生效</span>'
      : '';
    return `<div class="arow" data-asst-row="${c.id}">
      <span class="aname">${c.name ?? c.id}</span>
      <span class="ast${st.key === 'connected' ? ' ok' : st.key === 'pending-reload' || st.key === 'connect-failed' || st.key === 'verify-failed' ? ' todo' : ''}">${st.label}</span>
      ${hintInline}
      <span class="asp"></span>${action}
    </div>
    <p class="amsg" data-asst-msg="${c.id}" hidden></p>`;
  }).join('');
}

function asstMsg(id, text) {
  const el = document.querySelector(`[data-asst-msg="${CSS.escape(id)}"]`);
  if (!el) return;
  el.hidden = !text;
  el.textContent = text ?? '';
}

async function loadClients() {
  try {
    const res = await api.clientsList();
    const clients = res?.clients ?? [];
    // 补丁 3 增补 · 对账：每轮刷新清掉与服务端真值矛盾的客户端残留
    for (const c of clients) {
      reconcileAssistantUi(c, { reloadHints, verifyStates: rowVerify, failed: rowFailed });
    }
    renderClients(clients);
    if (res?.warning) setText('#assistants-detail', `${res.warning}（不阻断，可稍后在「设置 · AI 助手」里补）`);
  } catch {
    renderClients([]);
  }
}

$('#asst-list')?.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-asst-act]');
  if (!btn) return;
  const id = btn.dataset.asstId;
  const act = btn.dataset.asstAct;
  if (act === 'console') { void api.deepAssistants(); return; }
  // 补丁 3：操作在途——该行按钮全禁 + 状态列「写入中…/验证中…」（防重复点击与困惑）
  // 简化轮·行内反馈：在途/成功只变状态列与按钮（不新增行）；仅失败/待生效指引才给原因行
  const row = btn.closest('.arow');
  row?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  const stEl = row?.querySelector('.ast');
  if (stEl) stEl.textContent = act === 'verify' ? '验证中…' : act === 'connect' ? '写入中…' : '检测中…';
  const res = await api.clientsAction(id, act);
  let msg = '';
  if (act === 'verify') {
    // 服务端 verify 真值：connected → 完成（清提醒）；pending-restart → 「待生效」唯一正当来源；failed → 验证未过
    if (res?.ok && res.state === 'connected') {
      rowVerify.set(id, 'connected');
      reloadHints.delete(id);
      rowFailed.delete(id);
    } else if (res?.state === 'pending-restart') {
      rowVerify.set(id, 'pending-restart');
      msg = '仍在待生效：请完全退出并重新打开该软件（不是只关窗口）后，点「我已重载，验证」。';
    } else {
      const failedSteps = (res?.steps ?? []).filter((s) => s && s.ok === false).map((s) => s.label ?? s.name).join('、');
      rowVerify.set(id, 'verify-failed');
      rowFailed.set(id, { kind: 'verify', reason: failedSteps || '验证未过' });
      msg = `验证未过${failedSteps ? `（${failedSteps}）` : ''}；详情见「设置 · AI 助手」。`;
    }
  } else if (!res?.ok) {
    // 补丁 3 接入失败语义：状态词「接入失败」+ 一行原因（脱敏）；rolledBack → 明示已自动还原
    rowFailed.set(id, { kind: 'connect', reason: res?.warning ?? '没能完成' });
    msg = `${res?.warning ?? '没能完成；可在「设置 · AI 助手」里看详情。'}${res?.rolledBack ? '（已自动还原原配置）' : ''}`;
  } else if (act === 'connect') {
    rowFailed.delete(id);
    rowVerify.delete(id);
    reloadHints.add(id); // 提示层：行内小字「已写入 · 重启后生效」（不出新行）
  } else {
    rowFailed.delete(id);
    rowVerify.delete(id);
    reloadHints.delete(id);
  }
  await loadClients();
  asstMsg(id, msg); // 仅失败/指引有内容（成功无行）
  await refresh();
});

// 「已完成」：显式确认（≥1 已接入才可用）→ 持久化 assistantsAcked → 完成态
$('#btn-seg2-done')?.addEventListener('click', async () => {
  try { await api.ackAssistants(); } catch { /* 落盘失败不阻断 */ }
  await refresh();
});
// 「先不接 ›」：段② 的显式跳过（与「已完成」同路 ack——用户显式确认后才翻段/通关）
$('#btn-seg2-skip')?.addEventListener('click', async () => {
  try { await api.ackAssistants(); } catch { /* 落盘失败不阻断 */ }
  await refresh();
});
// 「或加入已有的 Mebular ›」：与「去写入初始设置」同路（控制台 provision），显式点击才导航
$('#alt-join')?.addEventListener('click', () => { void api.openConsole(); });

$('#btn-skip')?.addEventListener('click', () => { void api.skipWizard(); });
$('#btn-enter-console')?.addEventListener('click', () => { void api.openConsole(); });
$('#btn-enter-console-2')?.addEventListener('click', () => { void api.openConsole(); });

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
    }));
  }
  function draw(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      // 闪烁治理：明灭幅度收窄 + 周期放慢（0.5±0.15，2.2s 周期）——星空是氛围，不抢戏不闪烁
      const tw = reduced ? 0.6 : 0.5 + 0.15 * Math.sin(t / 2200 + s.p);
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
void loadClients();
void loadLogs();
// 状态轮询（跑流水期间也有自己的有界轮询；这里只读、幂等）
setInterval(() => { if (!flow.running) { void refresh(); void loadClients(); } void loadLogs(); }, 3000);
