// UX-2 走查修复 B：桌面壳「交通灯安全区」必须在首帧前生效。
// 历史问题：安全区类由 console.js 模块在 await fetch 之后才加（晚于首帧数百 ms），
// 首帧标题（x=16）正好压在原生交通灯（x≈12–63）下——载入完成后才恢复。
// 约束：CSP 禁内联脚本 → 独立小文件；<head> 中同步执行（parser-blocking），先于任何绘制。
(function bootShellClass() {
  try {
    var query = /(?:^|[?&])shell=desktop(?:&|$)/.test(location.search);
    var embedded = /(?:^|[?&])embed=dsh(?:&|$)/.test(location.search);
    // DSH embed：在首帧前落 data-embed，避免 topbar 先画一帧再被 CSS 隐藏。
    if (embedded) document.documentElement.dataset.embed = 'dsh';
    var api = window.mebularDesktop;
    var isShell = query || Boolean(api);
    var isDarwin = Boolean(api) && api.platform === 'darwin';
    if (isShell && isDarwin) document.documentElement.classList.add('shell-desktop-darwin');
  } catch (_e) {
    /* 首帧适配失败不阻断页面 */
  }
})();

// i18n 首帧门：index.html 的静态文案是中文兜底，而 locale pack 要等 console.js
// 的异步 initI18n 才能确定。若直接绘制，#app 会先闪一帧中文再切成 en-US。
// 这里在解析阶段（早于样式与首帧）给 <html> 加 console-booting：
// CSS 据此隐藏 #app、只显示无语言文本的品牌占位；console.js 在 locale pack 加载、
// applyStaticI18n 完成、dataset.consoleReady='1' 的同一处移除本类。
// 与 console.js 解耦：即使模块脚本加载失败，占位也不会永久停留（见下方超时兜底）。
(function bootI18nGate() {
  var root = document.documentElement;
  var BOOT_GATE_TIMEOUT_MS = 9000;
  try {
    root.classList.add('console-booting');
  } catch (_e) {
    /* classList 不可用不阻断页面 */
  }
  // 失败兜底：初始化异常或长期未 ready 时不能永远停在占位/黑屏。
  // 到点只解除视觉门控、露出既有静态中文兜底；真实异常仍由 console.js / 浏览器上报（不吞）。
  try {
    setTimeout(function () {
      if (!root || root.dataset.consoleReady === '1') return;
      root.classList.remove('console-booting');
      try {
        console.warn('[console] boot gate released by timeout before consoleReady');
      } catch (_e) {
        /* 无 console 环境 */
      }
    }, BOOT_GATE_TIMEOUT_MS);
  } catch (_e) {
    /* setTimeout 不可用不阻断页面 */
  }
})();
