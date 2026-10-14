// M2/UX-2 · 一屏两段向导渲染层（无 node；只用 preload 白名单 window.mebularDesktop）
// W-1：全部展示决策来自纯视图模型 wizardView（与单测共用同一份契约）。
// UX-2：段①「一键开始」原位展开子步骤流水（失败定位 + 从此处续跑）；
//       段②行级接入（名称+状态词+一个动作；「已接入 ✓」不自动翻段，「已完成」显式确认）。

import { wizardView } from './wizard-view.mjs';

const api = window.mebularDesktop;

const $ = (sel) => document.querySelector(sel);
const setText = (sel, text) => { const el = $(sel); if (el) el.textContent = text ?? ''; };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 日志区只在「进入异常态」的边沿自动展开一次（不打断用户手动收起）
let logsAutoOpened = false;

// ---------- 渲染（视图模型驱动） ----------

function renderState(state) {
  if (!state) return;
  const view = wizardView(state);

  const badge = $('#daemon-badge');
  if (badge) {
    badge.textContent = view.badge;
    badge.classList.toggle('todo', !state.complete);
  }

  // 完成态 → 单一主按钮「进入控制台 ✦」+ 两段折叠为回顾（点标题可再展开）
  const cta = $('#complete-cta');
  if (cta) cta.hidden = !view.complete;

  for (const step of view.steps) {
    const el = document.getElementById(`step-${step.id}`);
    if (!el) continue;
    el.classList.toggle('done', step.status === 'done');
    el.classList.toggle('is-current', step.status === 'current');
    el.classList.toggle('is-collapsed', Boolean(step.collapsed) && !el.dataset.userExpanded);
    const check = el.querySelector('.step-check');
    if (check) check.hidden = !step.check;
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
    const btnInstall = $('#btn-install');
    if (btnInstall) btnInstall.hidden = Boolean(start.actions.install.hidden);
    // 非跑流水期间：流水面板按静态进度呈现（① 未完成且从未跑过 → 保持隐藏）
    if (!flow.running && !flow.everRan) {
      const flowEl = $('#start-flow');
      const showStatic = start.status !== 'done' && (start.flow.write !== 'todo' || start.flow.launch === 'done');
      if (flowEl) flowEl.hidden = !showStatic;
      if (showStatic) for (const sub of ['launch', 'write', 'recover']) setSubState(sub, start.flow[sub] ?? 'todo');
    }
  }

  const assistants = view.steps.find((s) => s.id === 'assistants');
  if (assistants) {
    setText('#assistants-detail', assistants.detailText);
    const doneBtn = $('#btn-seg2-done');
    if (doneBtn) doneBtn.disabled = !assistants.doneEnabled;
  }

  // 异常（引导态/启动失败）→ 自动展开 + 一行结论；正常保持默认折叠
  const logsPanel = $('#logs-panel');
  const conclusion = $('#logs-conclusion');
  if (conclusion) {
    conclusion.hidden = !view.logs.conclusion;
    if (view.logs.conclusion) conclusion.textContent = view.logs.conclusion;
  }
  if (logsPanel && view.logs.open && !logsAutoOpened) {
    logsPanel.open = true;
    logsAutoOpened = true;
  }
}

async function refresh() {
  try { renderState(await api.wizardState()); } catch (error) { setText('#start-detail', `状态读取失败：${error.message}`); }
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
          flowMsg('请在打开的控制台里选「建新」或「加入」，完成后这里自动继续…');
          $('#btn-provision').hidden = false;
          void api.openConsole();
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
$('#btn-install')?.addEventListener('click', async () => {
  try { await api.serviceInstall(); } catch (error) { setText('#start-detail', `安装常驻失败：${error.message}`); }
  await refresh();
});
$('#btn-restart')?.addEventListener('click', async () => { await api.restart(); await refresh(); });

// 完成态段标题点击 → 重新展开回顾
for (const id of ['step-start', 'step-assistants']) {
  document.getElementById(id)?.querySelector('h2')?.addEventListener('click', () => {
    const el = document.getElementById(id);
    if (!el?.classList.contains('is-collapsed') && !el?.dataset.userExpanded) return;
    el.dataset.userExpanded = el.dataset.userExpanded ? '' : '1';
    el.classList.toggle('is-collapsed', !el.dataset.userExpanded);
  });
}

// ---------- 段② 行级接入（名称 + 状态词 + 一个动作；与 设置 · AI 助手 同一语言） ----------

const pendingReload = new Set(); // 本会话内「已写入待重载」的助手 id
let clientsSignature = null;

function rowStatus(client) {
  if (client.needsManual) return { key: 'manual', label: '需手动' };
  if (!client.installed) return { key: 'not-installed', label: '未安装' };
  if (pendingReload.has(client.id)) return { key: 'pending', label: '待生效' };
  if (client.connected) return { key: 'connected', label: '已接入 ✓' };
  return { key: 'not-connected', label: '未接入' };
}

function renderClients(clients) {
  const list = $('#asst-list');
  if (!list) return;
  if (!Array.isArray(clients)) {
    list.innerHTML = '<p class="amsg">助手列表加载中…</p>';
    return;
  }
  const signature = JSON.stringify(clients.map((c) => [c.id, Boolean(c.installed), Boolean(c.connected)]).concat([...pendingReload]));
  if (signature === clientsSignature) return;
  clientsSignature = signature;
  if (clients.length === 0) {
    list.innerHTML = '<p class="amsg">还没有检测到已知助手；也可稍后在「设置 · AI 助手」里补。</p>';
    return;
  }
  list.innerHTML = clients.map((c) => {
    const st = rowStatus(c);
    let action = '';
    if (st.key === 'not-connected') action = `<button data-asst-act="connect" data-asst-id="${c.id}">接入</button>`;
    else if (st.key === 'pending') action = `<button data-asst-act="recheck" data-asst-id="${c.id}">我已重载，重新验证</button>`;
    else if (st.key === 'manual') action = `<button class="ghost" data-asst-act="console" data-asst-id="${c.id}">去控制台处理 ›</button>`;
    return `<div class="arow" data-asst-row="${c.id}">
      <span class="aname">${c.name ?? c.id}</span>
      <span class="ast${st.key === 'connected' ? ' ok' : st.key === 'pending' ? ' todo' : ''}">${st.label}</span>
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
    renderClients(res?.clients ?? []);
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
  btn.disabled = true;
  asstMsg(id, act === 'connect' ? '正在接入…' : '正在重新验证…');
  const res = await api.clientsAction(id, act);
  if (!res?.ok) {
    asstMsg(id, res?.warning ?? '没能完成；可在「设置 · AI 助手」里看详情。');
  } else if (act === 'connect') {
    pendingReload.add(id);
    asstMsg(id, res.changed ? '已接好（写前已备份），重载该助手后生效。' : '已接入（无需改动）。');
  } else {
    pendingReload.delete(id);
    asstMsg(id, '已重新检测。');
  }
  await loadClients();
  await refresh();
});

// 「已完成」：显式确认（≥1 已接入才可用）→ 持久化 assistantsAcked → 完成态
$('#btn-seg2-done')?.addEventListener('click', async () => {
  try { await api.ackAssistants(); } catch { /* 落盘失败不阻断 */ }
  await refresh();
});

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

// ---------- 星野舞台（轻量；prefers-reduced-motion → 静止一帧） ----------

(function sky() {
  const canvas = $('#sky');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  let stars = [];
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
      const tw = reduced ? 0.6 : 0.35 + 0.3 * Math.sin(t / 900 + s.p);
      ctx.globalAlpha = Math.max(0.08, tw);
      ctx.fillStyle = '#b9d2ff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (!reduced) window.requestAnimationFrame(draw);
  }
  window.addEventListener('resize', () => { resize(); draw(0); });
  resize();
  if (reduced) draw(0); else window.requestAnimationFrame(draw);
})();

void refresh();
void loadClients();
void loadLogs();
// 状态轮询（跑流水期间也有自己的有界轮询；这里只读、幂等）
setInterval(() => { if (!flow.running) { void refresh(); void loadClients(); } void loadLogs(); }, 3000);
