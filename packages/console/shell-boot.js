// UX-2 走查修复 B：桌面壳「交通灯安全区」必须在首帧前生效。
// 历史问题：安全区类由 console.js 模块在 await fetch 之后才加（晚于首帧数百 ms），
// 首帧标题（x=16）正好压在原生交通灯（x≈12–63）下——载入完成后才恢复。
// 约束：CSP 禁内联脚本 → 独立小文件；<head> 中同步执行（parser-blocking），先于任何绘制。
(function bootShellClass() {
  try {
    var query = /(?:^|[?&])shell=desktop(?:&|$)/.test(location.search);
    var api = window.mebularDesktop;
    var isShell = query || Boolean(api);
    var isDarwin = Boolean(api) && api.platform === 'darwin';
    if (isShell && isDarwin) document.documentElement.classList.add('shell-desktop-darwin');
  } catch (_e) {
    /* 首帧适配失败不阻断页面 */
  }
})();
