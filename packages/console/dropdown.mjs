/* global document, MutationObserver */
// Mebular 控制台自定义下拉框（vanilla，零依赖）。
//
// 原生 <select> 保留为隐藏的「值 / 事件兼容层」：视觉弹层完全由 trigger + listbox 承担，
// 选中后回写 select.value 并派发冒泡 change，既有监听器无需改动。
//
// 设计约束：
// - trigger = combobox（aria-haspopup / expanded / controls / activedescendant）
// - menu = listbox，每次打开都从 select.options 重建（支持审计设备/域等动态选项）
// - 菜单 fixed 挂到 body，避开设置弹层 / modal 的 overflow 裁剪；空间不足向上翻转
// - 一次只开一个；点击外部 / Esc / 滚动 / resize 关闭，关闭后焦点回到 trigger
// - enhanceSelect 可重复调用：已增强的 select 只同步状态，不会重复包裹

const records = new WeakMap();
const menusById = new Map();
let sequence = 0;
let openRecord = null;

const isSelect = (el) => Boolean(el) && el.tagName === 'SELECT';

/** 与原生 select 关联的可见文案：aria-label → label[for] / 包裹 label → title。 */
function associatedLabelText(select) {
  const aria = select.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const id = select.getAttribute('id');
  let label = id ? select.ownerDocument?.querySelector(`label[for="${cssEscape(id)}"]`) : null;
  if (!label) label = select.closest('label');
  if (!label) return '';
  const clone = label.cloneNode(true);
  clone.querySelectorAll('select, .crt-select').forEach((el) => el.remove());
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function optionText(option) {
  const text = option.label ?? option.textContent ?? option.value ?? '';
  return String(text).replace(/\s+/g, ' ').trim() || String(option.value ?? '');
}

function makeId(select, suffix) {
  const base = select.id || `crt-select-${sequence += 1}`;
  return `${base}-${suffix}`;
}

function syncTrigger(record) {
  const { select, trigger, valueEl, wrapper } = record;
  const options = Array.from(select.options);
  const selected = select.selectedIndex >= 0 ? options[select.selectedIndex] : null;
  const empty = options.length === 0;
  const disabled = Boolean(select.disabled) || empty;
  const text = selected ? optionText(selected) : (select.value || '—');
  valueEl.textContent = text || '—';
  trigger.disabled = disabled;
  trigger.setAttribute('aria-disabled', String(disabled));
  const label = associatedLabelText(select);
  if (label) trigger.setAttribute('aria-label', label);
  else trigger.removeAttribute('aria-label');
  const title = select.getAttribute('title');
  if (title) trigger.setAttribute('title', title);
  else trigger.removeAttribute('title');
  wrapper.classList.toggle('is-disabled', disabled);
  wrapper.classList.toggle('is-empty', empty);
  wrapper.dataset.variant = record.variant;
  if (record.open) {
    record.menu.setAttribute('aria-label', label || text || '');
    if (disabled) closeMenu(record, { focus: false });
    else {
      rebuildMenu(record, record.activeIndex);
      positionMenu(record);
    }
  }
}

function rebuildMenu(record, preferredIndex = null) {
  const { select, menu } = record;
  const options = Array.from(select.options);
  menu.textContent = '';
  record.optionEls = [];
  if (options.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'crt-select-empty';
    empty.textContent = '—';
    menu.append(empty);
    record.activeIndex = -1;
    record.trigger.removeAttribute('aria-activedescendant');
    return;
  }
  const selectedIndex = select.selectedIndex;
  options.forEach((option, index) => {
    const item = document.createElement('div');
    item.className = 'crt-select-option';
    item.id = `${menu.id}-opt-${index}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === selectedIndex));
    item.dataset.index = String(index);
    if (option.disabled) {
      item.classList.add('is-disabled');
      item.setAttribute('aria-disabled', 'true');
    }
    const text = document.createElement('span');
    text.className = 'crt-select-option-label';
    text.textContent = optionText(option);
    const check = document.createElement('span');
    check.className = 'crt-select-option-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '✓';
    item.append(text, check);
    menu.append(item);
    record.optionEls.push(item);
  });
  let active = selectedIndex >= 0 ? selectedIndex : 0;
  if (Number.isInteger(preferredIndex) && preferredIndex >= 0) active = preferredIndex;
  record.activeIndex = Math.max(0, Math.min(active, options.length - 1));
  highlightActive(record);
}

function highlightActive(record) {
  const { optionEls, trigger } = record;
  if (!optionEls?.length) return;
  const index = Math.max(0, Math.min(record.activeIndex, optionEls.length - 1));
  record.activeIndex = index;
  optionEls.forEach((el, i) => {
    const active = i === index;
    el.classList.toggle('is-active', active);
    if (active) {
      trigger.setAttribute('aria-activedescendant', el.id);
      el.scrollIntoView?.({ block: 'nearest' });
    }
  });
}

function enabledIndexes(record) {
  const result = [];
  Array.from(record.select.options).forEach((option, index) => {
    if (!option.disabled) result.push(index);
  });
  return result;
}

function moveActive(record, delta) {
  const indexes = enabledIndexes(record);
  if (indexes.length === 0) return;
  const current = indexes.indexOf(record.activeIndex);
  const next = current < 0
    ? (delta > 0 ? 0 : indexes.length - 1)
    : (current + delta + indexes.length) % indexes.length;
  record.activeIndex = indexes[next];
  highlightActive(record);
}

function jumpActive(record, edge) {
  const indexes = enabledIndexes(record);
  if (indexes.length === 0) return;
  record.activeIndex = edge === 'last' ? indexes[indexes.length - 1] : indexes[0];
  highlightActive(record);
}

function positionMenu(record) {
  const { menu, trigger } = record;
  if (menu.hidden) return;
  const viewportWidth = globalThis.innerWidth || 1024;
  const viewportHeight = globalThis.innerHeight || 768;
  const gap = 6;
  const margin = 8;
  const triggerRect = trigger.getBoundingClientRect();
  menu.style.width = '';
  menu.style.maxWidth = `${Math.max(120, viewportWidth - margin * 2)}px`;
  menu.style.minWidth = `${Math.max(120, Math.round(triggerRect.width))}px`;
  const natural = menu.getBoundingClientRect();
  const width = Math.min(natural.width, viewportWidth - margin * 2);
  const spaceBelow = viewportHeight - triggerRect.bottom - gap - margin;
  const spaceAbove = triggerRect.top - gap - margin;
  const flip = natural.height > spaceBelow && spaceAbove > spaceBelow;
  const available = Math.max(96, flip ? spaceAbove : spaceBelow);
  menu.style.maxHeight = `${Math.min(320, Math.floor(available))}px`;
  menu.style.width = `${Math.round(width)}px`;
  const height = menu.getBoundingClientRect().height;
  let top = flip ? triggerRect.top - gap - height : triggerRect.bottom + gap;
  let left = triggerRect.left;
  if (left + width > viewportWidth - margin) left = triggerRect.right - width;
  left = Math.max(margin, Math.min(left, viewportWidth - width - margin));
  top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.classList.toggle('is-flipped', flip);
}

function selectOption(record, index) {
  const option = record.select.options[index];
  if (!option || option.disabled) return;
  if (record.select.multiple) {
    option.selected = !option.selected;
    record.select.dispatchEvent(new Event('change', { bubbles: true }));
    syncTrigger(record);
    rebuildMenu(record, index);
    positionMenu(record);
    return;
  }
  if (record.select.selectedIndex !== index) record.select.selectedIndex = index;
  record.select.value = option.value;
  const triggerId = record.trigger.id;
  record.select.dispatchEvent(new Event('change', { bubbles: true }));
  syncTrigger(record);
  closeMenu(record, { focus: false });
  // 语言切换会同步重渲染设置页：优先把焦点交给新 DOM 中的同 id trigger。
  const activeTrigger = record.trigger.isConnected
    ? record.trigger
    : (triggerId ? document.getElementById(triggerId) : null);
  activeTrigger?.focus?.({ preventScroll: true });
}

function onTriggerClick(record) {
  if (record.open) closeMenu(record, { focus: true });
  else openMenu(record);
}

function onTriggerKeydown(record, event) {
  const key = event.key;
  if (key === 'Escape' && record.open) {
    event.preventDefault();
    event.stopPropagation();
    closeMenu(record, { focus: true });
    return;
  }
  if (key === 'Tab') {
    if (record.open) closeMenu(record, { focus: false });
    return;
  }
  const isSpace = key === ' ' || key === 'Spacebar';
  const handled = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(key) || isSpace;
  if (!handled || record.trigger.disabled) return;
  event.preventDefault();
  if (!record.open) {
    openMenu(record, { last: key === 'ArrowUp' || key === 'End' });
    return;
  }
  if (key === 'ArrowDown') moveActive(record, 1);
  else if (key === 'ArrowUp') moveActive(record, -1);
  else if (key === 'Home') jumpActive(record, 'first');
  else if (key === 'End') jumpActive(record, 'last');
  else if (record.activeIndex >= 0) selectOption(record, record.activeIndex);
}

function onMenuPointerDown(event) {
  // 保持 trigger 焦点：listbox 不接收焦点，所有键盘事件仍由 combobox 处理。
  event.preventDefault();
}

function onMenuClick(record, event) {
  const item = event.target.closest?.('[role="option"]');
  if (!item || !record.menu.contains(item)) return;
  const index = Number(item.dataset.index);
  if (!Number.isInteger(index)) return;
  selectOption(record, index);
}

function onMenuMouseOver(record, event) {
  const item = event.target.closest?.('[role="option"]');
  if (!item || !record.menu.contains(item)) return;
  const index = Number(item.dataset.index);
  if (!Number.isInteger(index)) return;
  record.activeIndex = index;
  highlightActive(record);
}

function onDocumentPointerDown(event) {
  const record = openRecord;
  if (!record) return;
  if (record.wrapper.contains(event.target) || record.menu.contains(event.target)) return;
  closeMenu(record, { focus: false });
}

function onDocumentClick(event) {
  const record = openRecord;
  if (!record) return;
  if (record.wrapper.contains(event.target) || record.menu.contains(event.target)) return;
  // 程序化 .click() 不产生 pointerdown，这里补一层外部关闭。
  closeMenu(record, { focus: false });
}

function onViewportChange(event) {
  const record = openRecord;
  if (!record) return;
  if (event?.type === 'scroll' && record.menu.contains(event.target)) return;
  closeMenu(record, { focus: false });
}

function bindOpenListeners(record) {
  record.listeners = {
    pointerdown: onDocumentPointerDown,
    click: onDocumentClick,
    scroll: onViewportChange,
    resize: onViewportChange,
  };
  document.addEventListener('pointerdown', record.listeners.pointerdown, true);
  document.addEventListener('click', record.listeners.click, true);
  document.addEventListener('scroll', record.listeners.scroll, true);
  globalThis.addEventListener('resize', record.listeners.resize, { passive: true });
}

function unbindOpenListeners(record) {
  if (!record.listeners) return;
  document.removeEventListener('pointerdown', record.listeners.pointerdown, true);
  document.removeEventListener('click', record.listeners.click, true);
  document.removeEventListener('scroll', record.listeners.scroll, true);
  globalThis.removeEventListener('resize', record.listeners.resize);
  record.listeners = null;
}

function openMenu(record, { last = false } = {}) {
  if (record.trigger.disabled || record.select.options.length === 0) return;
  if (openRecord && openRecord !== record) closeMenu(openRecord, { focus: false });
  record.open = true;
  openRecord = record;
  const selected = record.select.selectedIndex;
  const preferred = selected >= 0 ? selected : (last ? record.select.options.length - 1 : 0);
  rebuildMenu(record, preferred);
  record.menu.hidden = false;
  record.menu.classList.add('is-open');
  record.menu.setAttribute('aria-label', record.trigger.getAttribute('aria-label') || '');
  record.trigger.setAttribute('aria-expanded', 'true');
  record.wrapper.classList.add('is-open');
  positionMenu(record);
  bindOpenListeners(record);
  if (document.activeElement !== record.trigger) record.trigger.focus({ preventScroll: true });
}

function closeMenu(record, { focus = true } = {}) {
  if (!record.open) return;
  record.open = false;
  if (openRecord === record) openRecord = null;
  record.menu.hidden = true;
  record.menu.classList.remove('is-open');
  record.menu.classList.remove('is-flipped');
  record.trigger.setAttribute('aria-expanded', 'false');
  record.trigger.removeAttribute('aria-activedescendant');
  record.wrapper.classList.remove('is-open');
  unbindOpenListeners(record);
  if (focus && record.trigger.isConnected) record.trigger.focus({ preventScroll: true });
}

function teardownRecord(record) {
  closeMenu(record, { focus: false });
  record.observer?.disconnect();
  record.menu.remove();
  if (menusById.get(record.menu.id) === record.menu) menusById.delete(record.menu.id);
  records.delete(record.select);
}

function enhance(select, options = {}) {
  const variant = options.variant === 'compact' ? 'compact' : 'normal';
  const existing = records.get(select);
  if (existing) {
    if (existing.wrapper.isConnected) {
      existing.variant = variant;
      syncTrigger(existing);
      return existing;
    }
    teardownRecord(existing);
  }

  const wrapper = document.createElement('span');
  wrapper.className = 'crt-select';
  wrapper.dataset.crtSelect = '';
  wrapper.dataset.variant = variant;
  select.parentNode.insertBefore(wrapper, select);
  wrapper.appendChild(select);
  select.classList.add('crt-select-native');
  select.setAttribute('tabindex', '-1');
  select.setAttribute('aria-hidden', 'true');

  const menu = document.createElement('div');
  menu.className = 'crt-select-menu';
  menu.id = makeId(select, 'menu');
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  // 设置页/邀请面板重建会生成同 id 的新 select：旧菜单跟随旧 DOM 退休，避免重复 id
  // 与 querySelector 命中已废弃的空菜单。
  const stale = menusById.get(menu.id);
  if (stale && stale !== menu) stale.remove();
  menusById.set(menu.id, menu);
  document.body.appendChild(menu);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'crt-select-trigger';
  trigger.id = makeId(select, 'trigger');
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', menu.id);

  const valueEl = document.createElement('span');
  valueEl.className = 'crt-select-value';
  const chevron = document.createElement('span');
  chevron.className = 'crt-select-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  trigger.append(valueEl, chevron);
  wrapper.appendChild(trigger);

  const record = {
    select,
    wrapper,
    trigger,
    menu,
    valueEl,
    variant,
    open: false,
    activeIndex: -1,
    optionEls: [],
    listeners: null,
    observer: null,
  };
  records.set(select, record);

  trigger.addEventListener('click', () => onTriggerClick(record));
  trigger.addEventListener('keydown', (event) => onTriggerKeydown(record, event));
  menu.addEventListener('pointerdown', onMenuPointerDown);
  menu.addEventListener('click', (event) => onMenuClick(record, event));
  menu.addEventListener('mouseover', (event) => onMenuMouseOver(record, event));
  select.addEventListener('change', () => syncTrigger(record));
  select.addEventListener('input', () => syncTrigger(record));

  const observer = new MutationObserver(() => {
    if (!select.isConnected) {
      teardownRecord(record);
      return;
    }
    syncTrigger(record);
  });
  observer.observe(select, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'aria-label', 'title'],
  });
  record.observer = observer;

  syncTrigger(record);
  return record;
}

/**
 * 增强一个原生 select。可重复调用（幂等）；返回内部 record 便于测试/接线。
 * @param {HTMLSelectElement} select
 * @param {{variant?: 'normal'|'compact'}} [options]
 */
export function enhanceSelect(select, options = {}) {
  if (!isSelect(select) || !select.parentNode) return null;
  return enhance(select, options);
}

/** 增强 root 下所有原生 select（已在本次会话增强过的只同步状态）。 */
export function enhanceSelects(root = globalThis.document) {
  if (!root?.querySelectorAll) return [];
  return Array.from(root.querySelectorAll('select'))
    .filter((select) => !select.closest('[data-crt-select-ignore]'))
    .map((select) => enhanceSelect(select));
}
