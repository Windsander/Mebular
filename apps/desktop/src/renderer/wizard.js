// M2 · 向导渲染层（无 node；只用 preload 白名单 window.mebularDesktop）

const api = window.mebularDesktop;

const $ = (sel) => document.querySelector(sel);
const setText = (sel, text) => { const el = $(sel); if (el) el.textContent = text ?? ''; };

function renderState(state) {
  if (!state) return;
  const badge = $('#daemon-badge');
  if (badge) {
    badge.textContent = state.complete ? '已就绪' : `第 ${state.steps.findIndex((s) => s.id === state.current) + 1} 步待完成`;
    badge.classList.toggle('todo', !state.complete);
  }
  for (const step of state.steps ?? []) {
    const el = document.getElementById(`step-${step.id}`);
    if (el) el.classList.toggle('done', Boolean(step.done));
  }
  const start = state.steps?.find((s) => s.id === 'start');
  const svc = start?.detail;
  setText('#start-detail', start?.done
    ? `守护运行中（${svc?.registered ? `常驻已装${svc?.running ? '· 运行中' : ''}` : '临时运行'}）`
    : '守护未就绪：点「启动」；想开机自启就点「让 Mebular 常驻」。');

  const assistants = state.steps?.find((s) => s.id === 'assistants')?.detail;
  setText('#assistants-detail', assistants
    ? (assistants.readError
      ? `状态读取受限：${assistants.readError}（不阻断）—— 点右侧按钮去控制台连接。`
      : `已连接 ${assistants.connectedCount ?? 0}/${assistants.total ?? '—'} 个 AI 助手`)
    : '—');
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
$('#btn-assistants')?.addEventListener('click', () => { void api.deepAssistants(); });
$('#open-console')?.addEventListener('click', () => { void api.openConsole(); });

let inviteToken = null;
$('#btn-invite')?.addEventListener('click', async () => {
  const msg = $('#invite-msg');
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
  }
});
$('#btn-copy')?.addEventListener('click', async () => {
  if (!inviteToken) return;
  try { await navigator.clipboard.writeText(inviteToken); setText('#invite-msg', '令牌已复制。'); } catch { setText('#invite-msg', '复制失败，请手动选择文本。'); }
});

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
setInterval(refresh, 3000);
