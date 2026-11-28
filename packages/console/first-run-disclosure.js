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

/**
 * confirm 在途完成时的最终确认：
 * - generation 必须仍是当前值（dismiss/open 会递增，作废在途 confirm）；
 * - 启动状态仍必须是 first-run pending；
 * - coach 不能处于隐藏/离场状态；
 * - 披露元素仍实际可见。
 *
 * 返回 `{ version, generation }`；任何一项不满足返回 null。
 */
export function confirmFirstRunDisclosure({
  pending,
  disclosureVersion,
  generation,
  currentGeneration,
  coachLeaving = false,
  element,
  container,
  view = globalThis,
} = {}) {
  if (pending !== true) return null;
  if (!Number.isInteger(generation) || generation !== currentGeneration) return null;
  if (coachLeaving === true) return null;
  if (container?.hidden === true) return null;
  const ack = firstRunDisclosureAcknowledgement({
    pending: true,
    disclosureVersion,
    element,
    container,
    view,
  });
  if (!ack) return null;
  return { version: ack.version, generation };
}

/**
 * 打开 create/join 前捕获 ack：只接受与当前 generation 相同的“当前可见”证据，
 * 过期 generation 一律拒绝（关闭/隐藏后不得复用曾经可见）。
 * 捕获时再校验一次元素/父层可见性，避免 generation 未变但布局已被隐藏。
 */
export function firstRunDisclosureAckFor({
  current,
  currentGeneration,
  element,
  container,
  view = globalThis,
} = {}) {
  if (!current) return null;
  if (!Number.isInteger(current.version) || current.version < 1) return null;
  if (!Number.isInteger(current.generation)) return null;
  if (current.generation !== currentGeneration) return null;
  if (!isElementActuallyVisible(element, container, view)) return null;
  return { version: current.version, generation: current.generation };
}

/** 提交 body 的 ack 字段；没有合法 ack 时返回空对象（不带任何 ack）。 */
export function firstRunDisclosureSubmitPayload(ack) {
  if (!ack || !Number.isInteger(ack.version) || ack.version < 1) return {};
  return { firstRunDisclosure: true, firstRunDisclosureVersion: ack.version };
}

const COACH_ACTIONS_SELECTOR = '.onboarding-coach-actions';

/**
 * 真实 coach CTA 的点击接线（生产与测试共用）：
 * - create/join：先 stopPropagation，再调用 open（open 内部负责“捕获当前 ack → keepAck 收起 coach”）；
 * - dismiss：关闭并清空 ack；
 * - 容器点击：忽略 action buttons（避免二次 dismiss 清掉刚捕获的 ack），点说明文字仍可关闭。
 */
export function bindFirstRunCoachActions({
  coach,
  create,
  join,
  dismiss,
  openCreate = () => {},
  openJoin = () => {},
  onDismiss = () => {},
} = {}) {
  const listen = (element, handler) => {
    if (element && typeof element.addEventListener === 'function') element.addEventListener('click', handler);
  };
  const stop = (event) => event?.stopPropagation?.();
  listen(create, (event) => { stop(event); openCreate(); });
  listen(join, (event) => { stop(event); openJoin(); });
  listen(dismiss, (event) => { stop(event); onDismiss(); });
  listen(coach, (event) => {
    const target = event?.target;
    if (target && typeof target.closest === 'function' && target.closest(COACH_ACTIONS_SELECTOR)) {
      return; // action button 区域不触发容器 dismiss（CTA 自己已处理）
    }
    onDismiss();
  });
}
