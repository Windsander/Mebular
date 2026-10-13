// M2 · 向导渲染层（无 node；只用 preload 白名单 window.mebularDesktop）
// W-1：全部展示决策来自纯视图模型 wizardView（与单测共用同一份契约）。

import { wizardView, inviteClickPlan } from './wizard-view.mjs';

const api = window.mebularDesktop;

const $ = (sel) => document.querySelector(sel);
const setText = (sel, text) => { const el = $(sel); if (el) el.textContent = text ?? ''; };

// 中-5：日志区只在「进入异常态」的边沿自动展开一次（不打断用户手动收起）
let logsAutoOpened = false;

function renderState(state) {
  if (!state) return;
  const view = wizardView(state);

  const badge = $('#daemon-badge');
  if (badge) {
    badge.textContent = view.badge;
    badge.classList.toggle('todo', !state.complete);
  }

  // 高-2：完成态 → 单一主按钮「进入控制台 ✦」+ 三步卡折叠为回顾
  const cta = $('#complete-cta');
  if (cta) cta.hidden = !view.complete;

  for (const step of view.steps) {
    const el = document.getElementById(`step-${step.id}`);
    if (!el) continue;
    el.classList.toggle('done', step.status === 'done');
    el.classList.toggle('is-current', step.status === 'current');
    el.classList.toggle('is-collapsed', Boolean(step.collapsed));
    const check = el.querySelector('.step-check');
    if (check) check.hidden = !step.check;
  }

  const start = view.steps.find((s) => s.id === 'start');
  if (start) {
    setText('#start-detail', start.detailText);
    const svcBadge = $('#start-service-badge');
    if (svcBadge) svcBadge.hidden = !start.serviceBadge;
    const btnProvision = $('#btn-provision');
    if (btnProvision) btnProvision.hidden = start.actions.provision.hidden;
    const btnStart = $('#btn-start');
    if (btnStart) {
      btnStart.hidden = Boolean(start.actions.start.hidden);
      btnStart.disabled = Boolean(start.actions.start.disabled);
    }
    const btnInstall = $('#btn-install');
    if (btnInstall) btnInstall.hidden = Boolean(start.actions.install.hidden);
  }

  setText('#assistants-detail', view.steps.find((s) => s.id === 'assistants')?.detailText ?? '—');

  // 中-5：异常（引导态/启动失败）→ 自动展开 + 一行结论；正常保持默认折叠
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

$('#btn-start')?.addEventListener('click', async () => { await api.start(); await refresh(); });
$('#btn-install')?.addEventListener('click', async () => {
  try { await api.serviceInstall(); } catch (error) { setText('#start-detail', `安装常驻失败：${error.message}`); }
  await refresh();
});
$('#btn-restart')?.addEventListener('click', async () => { await api.restart(); await refresh(); });
// 高-1：引导态下 /console/ 即引导页，直接打开控制台完成建新/加入
$('#btn-provision')?.addEventListener('click', () => { void api.openConsole(); });
$('#btn-assistants')?.addEventListener('click', () => { void api.deepAssistants(); });
$('#open-console')?.addEventListener('click', () => { void api.openConsole(); });
$('#btn-skip')?.addEventListener('click', () => { void api.skipWizard(); });
$('#btn-enter-console')?.addEventListener('click', () => { void api.openConsole(); });

// ---------- ③ 添加设备：邀请（小-7：loading 禁用 + 已有令牌二次确认） ----------

let inviteToken = null;
let inviteBusy = false;

$('#btn-invite')?.addEventListener('click', async () => {
  if (inviteBusy) return;
  const plan = inviteClickPlan({ hasToken: Boolean(inviteToken) });
  if (plan.confirm && !window.confirm('已生成过一个邀请。重新生成会让旧令牌失效，确定继续？')) return;
  const btn = $('#btn-invite');
  const msg = $('#invite-msg');
  inviteBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = plan.busyLabel; }
  if (msg) msg.textContent = '正在生成邀请…';
  try {
    const res = await api.createInvite();
    inviteToken = res?.token ?? null;
    const qr = $('#qr');
    const text = $('#invite-text');
    if (res?.qrSvg && qr) { qr.innerHTML = res.qrSvg; }
    if (text) { text.hidden = false; text.textContent = res?.text ?? '(未取到令牌)'; }
    $('#btn-copy')?.removeAttribute('hidden');
    if (msg) msg.textContent = res?.warning ? `${res.warning}` : (res?.token ? '把二维码/令牌给另一台设备。' : '未取到令牌：请确认守护在跑且已开启加入服务。');
  } catch (error) {
    if (msg) msg.textContent = `生成失败：${error.message}`;
  } finally {
    inviteBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = inviteClickPlan({ hasToken: Boolean(inviteToken) }).label; }
  }
});
$('#btn-copy')?.addEventListener('click', async () => {
  if (!inviteToken) return;
  try { await navigator.clipboard.writeText(inviteToken); setText('#invite-msg', '令牌已复制。'); } catch { setText('#invite-msg', '复制失败，请手动选择文本。'); }
});

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

void refresh();
void loadLogs();
// 日志随状态轮询刷新（守护刚起时 serve.log 可能尚未写出 → 自愈）
setInterval(() => { void refresh(); void loadLogs(); }, 3000);
