// 0.4.0 W1b：首启披露“真的可见”判定（DOM 级，无副作用）。
//
// 披露不是 consent，但 ack 必须对应“用户确实看到了披露”。仅设置 hidden=false 不够：
// 父层 hidden / coach 未显示 / CSS display:none / 脱离布局（getClientRects 为空）都不能 ack。
//
// 本模块只接收 DOM 节点 + 一个带 getComputedStyle 的 view（通常是 window），
// 便于 Node 侧用 DOM 语义的替身做测试；不触碰网络、存储或宿主。

/** 元素 + 容器在布局/样式上是否真的可见（父层隐藏会体现在 rects 为空）。 */
export function isElementActuallyVisible(element, container, view = globalThis) {
  if (!element || !container) return false;
  if (element.hidden === true || container.hidden === true) return false;
  let rects;
  try {
    rects = typeof element.getClientRects === 'function' ? element.getClientRects() : null;
  } catch {
    return false;
  }
  if (!rects || rects.length === 0) return false;
  const getComputedStyle = view?.getComputedStyle;
  if (typeof getComputedStyle !== 'function') return true;
  try {
    for (const node of [element, container]) {
      const style = getComputedStyle.call(view, node);
      if (!style) return false;
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      // 过渡起点 opacity:0 也算不可见（coach 未加 is-visible 时正好是 0）。
      if (Number.parseFloat(style.opacity) === 0) return false;
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * 产出可回传给服务端的 ack；只有 pending + 合法版本 + 实际可见时才返回。
 * 返回 `{ version }`（不含用户数据）；其他情况返回 null（fail closed）。
 */
export function firstRunDisclosureAcknowledgement({
  pending,
  disclosureVersion,
  element,
  container,
  view = globalThis,
} = {}) {
  if (pending !== true) return null;
  if (!Number.isInteger(disclosureVersion) || disclosureVersion < 1) return null;
  if (!isElementActuallyVisible(element, container, view)) return null;
  return { version: disclosureVersion };
}
