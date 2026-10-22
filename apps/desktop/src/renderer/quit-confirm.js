// 退出确认窗口 · renderer（无 Node；只通过 preload 的固定动作回答）
document.documentElement.dataset.quitReady = '1';
const titleEl = document.getElementById('q-title');
const messageEl = document.getElementById('q-message');
const cancelEl = document.getElementById('q-cancel');
const confirmEl = document.getElementById('q-confirm');
const closeEl = document.getElementById('q-close');
const hintEl = document.getElementById('q-hint');

let answered = false;
function answer(confirmed) {
  if (answered) return;
  answered = true;
  window.mebularQuit?.answer(confirmed === true);
}

window.mebularQuit?.onPlan((plan) => {
  // 窗口跨多次退出请求复用：每个新 plan 都必须重新允许回答。
  answered = false;
  if (typeof plan.title === 'string' && plan.title) titleEl.textContent = plan.title;
  if (typeof plan.message === 'string') messageEl.textContent = plan.message;
  if (typeof plan.hint === 'string' && plan.hint) hintEl.textContent = plan.hint;
  if (typeof plan.closeLabel === 'string' && plan.closeLabel) {
    closeEl.setAttribute('aria-label', plan.closeLabel);
    closeEl.setAttribute('title', plan.closeLabel);
  }
  if (typeof plan.locale === 'string' && plan.locale) document.documentElement.lang = plan.locale;
  const buttons = Array.isArray(plan.buttons) ? plan.buttons : [];
  if (typeof buttons[0] === 'string' && buttons[0]) cancelEl.textContent = buttons[0];
  if (typeof buttons[1] === 'string' && buttons[1]) confirmEl.textContent = buttons[1];
  cancelEl.focus();
});

cancelEl.addEventListener('click', () => answer(false));
confirmEl.addEventListener('click', () => answer(true));
closeEl.addEventListener('click', () => answer(false));
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  event.preventDefault();
  answer(false);
});
