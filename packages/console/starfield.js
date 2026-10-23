import { Nebula } from './nebula.js';
import { Starfield } from './stars.js';

// 星图舞台（vanilla Canvas2D，零依赖）
//
// 视觉语言参考官网第二页『网络舞台』：视差星空 + 高亮设备星 + 方向分色连线 +
// 同步粒子。本文件不依赖站点代码，只负责画布渲染与指针命中，数据由 console.js 注入。
//
// 公开接口：
//   const stage = new StarStage(canvas);
//   stage.setScene({ nodes, edges });       // edges = 无向基础边（共同/无共同订阅）
//   stage.setRoutes(routes);                // 仅 hover 的任务域航道；scene 不掺业务路由
//   stage.launchFleet(fromId, toId, opts);  // fleet 事件：航道 + 舰队（端点每帧绑星位）
//   stage.launchCourier(fromId, toId);      // 手动同步的本地反馈（独立白色信使）
//   stage.onHover = (node|null, x, y) => {};
//   stage.onSelect = (node) => {};

// Okabe–Ito 色盲安全配色（namespace 色板）
export const NAMESPACE_PALETTE = [
  '#56B4E9', // sky
  '#E69F00', // orange
  '#009E73', // green
  '#CC79A7', // pink
  '#D55E00', // vermillion
  '#F0E442', // yellow
  '#0072B2', // blue
];

export function namespaceColor(name) {
  const text = String(name ?? 'default');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return NAMESPACE_PALETTE[Math.abs(hash) % NAMESPACE_PALETTE.length];
}

// 悬停航道出现时，基础边降到正常亮度的 20%（保留网络结构感，但让蓝/金/灰航道成为主视觉）。
export const BASE_EDGE_DIM_ON_HOVER = 0.2;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const COLORS = {
  text: '#dbe4ff',
  muted: '#8391b4',
  revokedNode: '#a06a6a',
  warning: '#d55e00',
  // 基础边：中性银灰，不用蓝/金（蓝金只属于任务域航道）。
  baseShared: '#c1c8d6',
  baseUnshared: '#7c8598',
  // 悬停航道：蓝 = 可发出，金 = 可接收，灰 = 任务域不可达。
  routeSend: '#56b4e9',
  routeReceive: '#f0c46a',
  routeBlocked: '#8993a8',
  // fleet 事件：本机发出 / 本机接收 / peer 间转运。
  fleetSend: '#56b4e9',
  fleetReceive: '#f0c46a',
  fleetTransit: '#d9e2f2',
  syncCourier: '#e8eef8',
};

function hsla(h, s, l, alpha) {
  return `hsla(${h},${s}%,${l}%,${alpha})`;
}

function rgba(hex, alpha) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < String(text).length; i += 1) {
    hash ^= String(text).charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shortId(id) {
  const text = String(id ?? '?');
  return text.length <= 14 ? text : `${text.slice(0, 8)}…${text.slice(-4)}`;
}

// ---------- 星图设备网络场景（纯函数，零 DOM） ----------
//
// 忆云设备网络：节点 = 当前忆云所有已知设备（含本机与离线设备），
// 基础边 = 所有设备两两之间的无向连线（共同订阅 = 实线，无共同订阅 = 虚线）。
// 航道 = 仅在悬停设备时计算的「任务域可达」方向线，不写回 scene。
// 坐标不在这里烘焙：StarStage 每帧按星体当前位置（含视差/深度）计算端点。
// 这些纯函数与渲染同文件导出，避免控制台静态白名单新增文件（serve.mjs 不变）。

export const DEFAULT_TASK_NAMESPACE = 'tasks';

const stringList = (value) => (Array.isArray(value)
  ? [...new Set(value.filter((item) => typeof item === 'string' && item.trim().length > 0))]
  : []);

/** 任务域：settings.fleet.namespace，缺省 tasks。 */
export function resolveTaskNamespace(settings) {
  const configured = settings?.fleet?.namespace;
  return typeof configured === 'string' && configured.trim().length > 0
    ? configured.trim()
    : DEFAULT_TASK_NAMESPACE;
}

/** 设备订阅（兼容 nodes 同时带 subscriptions / namespaces 的旧形状）。 */
export function subscriptionsOf(node) {
  return stringList(node?.subscriptions ?? node?.namespaces);
}

export function sharedNamespaces(a, b) {
  const right = new Set(subscriptionsOf(b));
  return subscriptionsOf(a).filter((name) => right.has(name));
}

/**
 * 单台设备能否参与任务域航道：订阅任务域 + 在线。
 * 注意：这是「任务域可达」的参与者门槛，不代表完整 fleet 路由。
 */
export function taskDomainState(node, taskNamespace = DEFAULT_TASK_NAMESPACE) {
  const namespace = String(taskNamespace || DEFAULT_TASK_NAMESPACE);
  const subscribed = subscriptionsOf(node).includes(namespace);
  const online = node?.online === true;
  return {
    namespace,
    subscribed,
    online,
    reachable: subscribed && online,
  };
}

/**
 * 构建节点：state.devices 全量（含本机/离线/已移除），self 固定排在最前。
 * labelFor 由调用方注入（控制台用 shortId），纯函数不依赖 i18n。
 */
export function buildNetworkNodes({ devices = [], selfId = null, selfLabel = '★', labelFor = null } = {}) {
  const byId = new Map();
  for (const device of Array.isArray(devices) ? devices : []) {
    const id = typeof device?.deviceId === 'string' ? device.deviceId : '';
    if (!id) continue;
    byId.set(id, {
      id,
      label: id === selfId
        ? selfLabel
        : (typeof labelFor === 'function' ? labelFor(device) : id),
      self: id === selfId,
      online: device.online === true,
      blocked: device.blocked === true,
      subscriptions: subscriptionsOf(device),
      pendingEventCount: Number.isFinite(device.pendingEventCount) ? Math.max(0, device.pendingEventCount) : 0,
    });
  }
  // 设备列表偶尔晚于 overview 到达：本机仍要有星位，避免整张图空白。
  if (selfId && !byId.has(selfId)) {
    byId.set(selfId, {
      id: selfId,
      label: selfLabel,
      self: true,
      online: true,
      blocked: false,
      subscriptions: [],
      pendingEventCount: 0,
    });
  }
  const nodes = [...byId.values()];
  nodes.sort((a, b) => {
    if (a.self !== b.self) return a.self ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return nodes;
}

/** 所有设备两两之间的基础边；无方向、无箭头。 */
export function buildBaseEdges(nodes = []) {
  const edges = [];
  const list = Array.isArray(nodes) ? nodes : [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const shared = sharedNamespaces(list[i], list[j]);
      edges.push({
        from: list[i].id,
        to: list[j].id,
        kind: 'base',
        shared: shared.length > 0,
        namespaces: shared,
      });
    }
  }
  return edges;
}

export function buildNetworkScene({ devices = [], selfId = null, selfLabel = '★', labelFor = null } = {}) {
  const nodes = buildNetworkNodes({ devices, selfId, selfLabel, labelFor });
  return { nodes, edges: buildBaseEdges(nodes) };
}

/** 基础边计数（验收/测试信号）。 */
export function summarizeSceneEdges(edges = []) {
  const list = Array.isArray(edges) ? edges : [];
  const solidEdgeCount = list.filter((edge) => edge?.shared === true).length;
  return {
    baseEdgeCount: list.length,
    solidEdgeCount,
    dashedEdgeCount: list.length - solidEdgeCount,
  };
}

/**
 * 悬停 H 的任务域航道（只含 H 与其他设备）：
 * - 双方都订阅任务域且都在线 → 两条方向航道：H→T 蓝（可发出）、T→H 金（可接收）
 * - 否则 → 一条灰色不可达线（不伪造方向）
 */
export function buildHoverRoutes({
  nodes = [],
  hoveredId = null,
  taskNamespace = DEFAULT_TASK_NAMESPACE,
} = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const hovered = list.find((node) => node?.id === hoveredId && !node.ghost);
  if (!hovered) return [];
  const namespace = String(taskNamespace || DEFAULT_TASK_NAMESPACE);
  const hoveredState = taskDomainState(hovered, namespace);
  const routes = [];
  for (const target of list) {
    if (!target || target.ghost || target.id === hovered.id) continue;
    const targetState = taskDomainState(target, namespace);
    const reachable = hoveredState.reachable && targetState.reachable;
    if (reachable) {
      routes.push({
        from: hovered.id,
        to: target.id,
        direction: 'out',
        reachable: true,
        namespace,
      });
      routes.push({
        from: target.id,
        to: hovered.id,
        direction: 'in',
        reachable: true,
        namespace,
      });
    } else {
      routes.push({
        from: hovered.id,
        to: target.id,
        direction: 'blocked',
        reachable: false,
        namespace,
        reason: !hoveredState.subscribed || !targetState.subscribed
          ? 'namespace'
          : 'offline',
      });
    }
  }
  return routes;
}

/** 悬停航道统计（tooltip / 测试用）。 */
export function summarizeHoverRoutes(routes = []) {
  const list = Array.isArray(routes) ? routes : [];
  // 蓝色 H→T 的目标是 to，金色 T→H 的目标是 from（两者都相对悬停设备 H）。
  const targetOf = (route) => (route.reachable && route.direction === 'in' ? route.from : route.to);
  const reachableTargets = new Set(list.filter((route) => route.reachable).map(targetOf));
  const blockedTargets = new Set(list.filter((route) => !route.reachable).map(targetOf));
  return {
    laneCount: list.length,
    reachableTargets: reachableTargets.size,
    blockedTargets: blockedTargets.size,
  };
}

/**
 * 远端/本机一致的 fleet 事件契约：
 * { at, fromDeviceId, toDeviceId, taskId, eventType:'created', namespace }
 * 仅当 from/to 都在当前场景且不同时返回航线；否则返回 null（不画假线）。
 */
export function normalizeFleetEvent(raw, { nodeIds = null, selfId = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.eventType !== undefined && raw.eventType !== 'created') return null;
  const from = typeof raw.fromDeviceId === 'string' ? raw.fromDeviceId.trim() : '';
  const to = typeof raw.toDeviceId === 'string' ? raw.toDeviceId.trim() : '';
  if (!from || !to || from === to) return null;
  if (nodeIds && !(nodeIds.has ? nodeIds.has(from) && nodeIds.has(to) : nodeIds.includes?.(from) && nodeIds.includes?.(to))) {
    return null;
  }
  const namespace = typeof raw.namespace === 'string' && raw.namespace.trim().length > 0
    ? raw.namespace.trim()
    : DEFAULT_TASK_NAMESPACE;
  return {
    at: Number.isFinite(raw.at) ? raw.at : null,
    from,
    to,
    taskId: typeof raw.taskId === 'string' ? raw.taskId : null,
    namespace,
    eventType: 'created',
    // 方向只用于选择本地可读的色相：本机发出 / 本机接收 / peer 间转运。
    direction: from === selfId ? 'out' : to === selfId ? 'in' : 'transit',
  };
}

export class StarStage {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.stars = [];
    this.scene = { nodes: [], edges: [] };
    this.positions = new Map();
    this.hovered = null;
    this.selectedId = null;
    this.running = false;
    this.raf = 0;
    // 省电（F-PERF-1）：_started 记录「应运行」意图，_paused 记录页面隐藏/
    // 非星图视图导致的挂起；只有 _started && !_paused 才真正持有 rAF 循环
    this._started = false;
    this._paused = false;
    this.startTime = performance.now();
    this.pulseUntil = 0;
    this.onHover = null;
    this.onSelect = null;
    // 每帧最后调用（ctx, time）：供外部叠加连线/标注等交互层
    this.onOverlay = null;
    this.reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.visualQuality = 'high';
    this.degradeStreak = 0;
    this.lastTickAt = 0;
    this.lastBackdropAt = 0;
    this.bgCanvas = null;
    this.bgCtx = null;
    this.nebula = null;
    this.starsField = null;
    this.depths = new Map();
    this.screen = new Map();
    this.fleets = [];
    this.couriers = [];
    // 悬停任务域航道：只由 console.js 通过 setRoutes 注入，场景本身保持纯设备数据。
    this.routes = [];
    this._reducedTimers = [];
    this.pointerNx = 0.5;
    this.pointerNy = 0.5;
    this.targetNx = 0.5;
    this.targetNy = 0.5;
    // 基础边亮度：hover 航道出现时平滑降到 BASE_EDGE_DIM_ON_HOVER，离开恢复。
    this.baseEdgeDim = 1;
    this.lastDimAt = 0;

    this._tick = this._tick.bind(this);
    this._resize = this._resize.bind(this);
    this._pointerMove = this._pointerMove.bind(this);
    this._pointerLeave = this._pointerLeave.bind(this);
    this._click = this._click.bind(this);

    this._resize();
    this._initBackdrop();
    this._updateSignals();
    window.addEventListener('resize', this._resize);
    canvas.addEventListener('pointermove', this._pointerMove);
    canvas.addEventListener('pointerleave', this._pointerLeave);
    canvas.addEventListener('click', this._click);
  }

  setScene(scene) {
    this.scene = {
      nodes: Array.isArray(scene?.nodes) ? scene.nodes : [],
      edges: Array.isArray(scene?.edges) ? scene.edges : [],
    };
    this.selfId = this.scene.nodes.find((n) => n.self)?.id ?? null;
    // 场景重建后旧航道可能引用已消失的节点；console.js 会立刻按当前 hover 重算。
    this.routes = [];
    this._layout();
    this._updateSignals();
    if (!this.running || this.reducedMotion) this._draw(performance.now() / 1000);
  }

  /** 悬停航道（仅 hover 时由 console.js 注入；不写回 scene）。 */
  setRoutes(routes) {
    this.routes = (Array.isArray(routes) ? routes : [])
      .filter((route) => route && route.from && route.to && route.from !== route.to)
      .map((route) => ({
        from: route.from,
        to: route.to,
        direction: route.direction === 'out' || route.direction === 'in' ? route.direction : 'blocked',
        reachable: route.reachable === true,
        // 待发事件数：>0 时沿线流动数据灯（旧版 _drawEdges 的 pending 视觉）。
        pending: Math.max(0, Number(route.pending ?? 0) || 0),
        namespace: route.namespace ?? null,
      }));
    this._updateSignals();
    if (!this.running || this.reducedMotion) this._draw(performance.now() / 1000);
  }

  /** 画布上的只读验收信号（不含设备名/地址等敏感数据）。 */
  _updateSignals() {
    const dataset = this.canvas?.dataset;
    if (!dataset) return;
    const edges = this.scene.edges;
    const solid = edges.filter((edge) => edge?.shared === true).length;
    const eventRoutes = this.fleets.filter((fleet) => fleet.event).length;
    dataset.baseEdgeCount = String(edges.length);
    dataset.solidEdgeCount = String(solid);
    dataset.dashedEdgeCount = String(edges.length - solid);
    dataset.routeCount = String(this.routes.length + eventRoutes);
    dataset.hoverRouteCount = String(this.routes.length);
    dataset.fleetRouteCount = String(eventRoutes);
    dataset.hoveredDevice = this.hovered ?? '';
  }

  setSelected(deviceId) {
    this.selectedId = deviceId ?? null;
  }

  /** 触发一次本机脉冲（SSE 状态/同步事件到达时） */
  pulse(durationMs = 1200) {
    if (this.reducedMotion) return;
    this.pulseUntil = performance.now() + durationMs;
  }

  start() {
    this._started = true;
    if (this.running || this._paused) return;
    this.running = true;
    if (this.reducedMotion) {
      this._draw(performance.now() / 1000);
      this.raf = 0;
      return;
    }
    this.raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this._started = false;
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /**
   * 暂停/恢复动画循环（页面隐藏、切到非星图视图时调用；F-PERF-1）。
   * 只影响 rAF 持有，不改变「应运行」意图：暂停后再 start() 不会抢跑，
   * 恢复时若此前已 start() 则自动续跑。
   */
  setPaused(paused) {
    const next = paused === true;
    if (next === this._paused) return;
    this._paused = next;
    if (next) {
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      return;
    }
    if (this._started) {
      // 长时间挂起后 frameMs 极大，清零避免误触帧率自适应降级
      this.lastTickAt = 0;
      this.start();
    }
  }

  destroy() {
    this.stop();
    for (const timer of this._reducedTimers) clearTimeout(timer);
    this._reducedTimers = [];
    window.removeEventListener('resize', this._resize);
    this.canvas.removeEventListener('pointermove', this._pointerMove);
    this.canvas.removeEventListener('pointerleave', this._pointerLeave);
    this.canvas.removeEventListener('click', this._click);
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this._seedStars();
    this._layout();
    this._resizeBackdrop();
  }

  _initBackdrop() {
    const bg = this.canvas.parentElement?.querySelector?.('canvas.stage-bg');
    if (!bg) return;
    this.bgCanvas = bg;
    this.bgCtx = bg.getContext('2d');
    this.nebula = new Nebula(bg, {
      baseParallax: 0.03, mouseInfluence: 1.0,
      viewLon: 0.5, viewTilt: 0.6, viewScale: 0.7,
      mistEnabled: !this.reducedMotion, mistAlpha: 0.08, mistParallax: 0.5,
      seed: Date.now(),
    });
    this.starsField = new Starfield(bg, { mouseInfluence: 1.0, maxStars: 220, seed: Date.now() + 1 });
    this._resizeBackdrop();
  }

  _resizeBackdrop() {
    if (!this.bgCanvas) return;
    this.bgCanvas.width = Math.max(1, Math.floor(this.width));
    this.bgCanvas.height = Math.max(1, Math.floor(this.height));
    if (this.nebula && typeof this.nebula._resize === 'function') this.nebula._resize();
    if (this.starsField && typeof this.starsField._resize === 'function') this.starsField._resize();
  }

  _seedStars() {
    const count = Math.max(90, Math.floor((this.width * this.height) / 9000));
    const stars = [];
    for (let i = 0; i < count; i += 1) {
      const depth = 0.25 + Math.random() * 0.75;
      stars.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        r: 0.4 + depth * 1.4,
        depth,
        phase: Math.random() * Math.PI * 2,
        twinkle: 0.6 + Math.random() * 1.6,
      });
    }
    this.stars = stars;
  }

  _layout() {
    const { nodes } = this.scene;
    const positions = new Map();
    if (this.width === 0 || this.height === 0) return;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const self = nodes.find((n) => n.self);
    const peers = nodes.filter((n) => !n.self).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    if (self) positions.set(self.id, { x: cx, y: cy });
    const baseRadius = Math.min(this.width, this.height) * 0.34;
    this.depths = new Map();
    if (self) this.depths.set(self.id, 1);
    peers.forEach((peer, index) => {
      const offset = (hashString(peer.id) % 360) * (Math.PI / 180);
      const angle = offset + index * GOLDEN_ANGLE;
      const ring = Math.floor(index / 9);
      const radius = Math.min(baseRadius * (1 + ring * 0.32), Math.min(this.width, this.height) * 0.46);
      positions.set(peer.id, {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius * 0.82,
      });
      // 稳定深度层（0.30~0.92）：近大远小、各自视差、前后遮挡
      this.depths.set(peer.id, 0.3 + (hashString(peer.id) % 1000) / 1000 * 0.62);
    });
    this.positions = positions;
  }

  _hitTest(x, y) {
    let best = null;
    let bestDist = 0;
    for (const node of this.scene.nodes) {
      const pos = this.screen.get(node.id) ?? this.positions.get(node.id);
      if (!pos) continue;
      const reach = 14 + (pos.depth ?? 0.6) * 12;
      const dist = Math.hypot(pos.x - x, pos.y - y);
      if (dist < reach && (best === null || dist < bestDist)) {
        best = node;
        bestDist = dist;
      }
    }
    return best;
  }

  _pointerMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = this._hitTest(x, y);
    if (hit !== this.hovered) {
      this.hovered = hit ? hit.id : null;
      this.canvas.style.cursor = hit ? 'pointer' : 'crosshair';
      this._updateSignals();
    }
    if (this.onHover) this.onHover(hit, x, y);
    const nx = rect.width ? x / rect.width : 0.5;
    const ny = rect.height ? y / rect.height : 0.5;
    this.targetNx = nx;
    this.targetNy = ny;
  }

  _pointerLeave() {
    this.hovered = null;
    this._updateSignals();
    if (this.onHover) this.onHover(null, 0, 0);
  }

  _click(event) {
    const rect = this.canvas.getBoundingClientRect();
    const hit = this._hitTest(event.clientX - rect.left, event.clientY - rect.top);
    if (this.onSelect) this.onSelect(hit);
  }

  _tick(now) {
    if (!this.running) return;
    const frameMs = this.lastTickAt ? now - this.lastTickAt : 16;
    this.lastTickAt = now;
    if (!this.reducedMotion) this._trackQuality(frameMs);
    this._draw(now / 1000);
    if (this.reducedMotion) {
      this.raf = 0;
      return;
    }
    this.raf = requestAnimationFrame(this._tick);
  }

  /** 帧率自适应降级：high(星云+雾) → balanced(星云无雾) → low(仅星空) */
  _trackQuality(frameMs) {
    if (frameMs > 22) this.degradeStreak += 1;
    else this.degradeStreak = Math.max(0, this.degradeStreak - 1);
    if (this.degradeStreak < 90) return;
    this.degradeStreak = 0;
    if (this.visualQuality === 'high') {
      this.visualQuality = 'balanced';
      if (this.nebula) this.nebula.options.mistEnabled = false;
    } else if (this.visualQuality === 'balanced') {
      this.visualQuality = 'low';
    } else {
      return;
    }
    console.info(`[console] 视觉降级：${this.visualQuality}`);
  }

  _stepStars(dt) {
    const drift = 6 * dt;
    for (const star of this.stars) {
      star.x += drift * star.depth;
      if (star.x > this.width + 2) star.x = -2;
    }
  }

  _computeScreen(time) {
    const ease = this.reducedMotion ? 1 : 0.12;
    this.pointerNx += (this.targetNx - this.pointerNx) * ease;
    this.pointerNy += (this.targetNy - this.pointerNy) * ease;
    if (this.nebula) { this.nebula.mouseX = this.pointerNx; this.nebula.mouseY = this.pointerNy; }
    if (this.starsField) { this.starsField.mouseX = this.pointerNx; this.starsField.mouseY = this.pointerNy; }
    const mx = (this.pointerNx ?? 0.5) - 0.5;
    const my = (this.pointerNy ?? 0.5) - 0.5;
    const animate = !this.reducedMotion;
    const screen = new Map();
    for (const [id, pos] of this.positions) {
      const depth = this.depths.get(id) ?? 0.6;
      const px = animate ? mx * this.width * 0.07 * depth : 0;
      const py = animate ? my * this.height * 0.06 * depth : 0;
      // 本机几乎不随波浮动（太出戏）；对端保留轻微漂浮
      const isSelf = this.selfId && id === this.selfId;
      const bobAmp = isSelf ? 0.7 : (1.5 + depth * 4.5);
      const bob = animate
        ? Math.sin(time * (0.35 + depth * 0.45) + depth * 6.283) * bobAmp
        : 0;
      // 视觉半径（与 _drawNodes 一致）：外部连线/标注据此精确贴合星体边缘
      const r = (isSelf ? 9 : 6) * (0.6 + depth * 0.7);
      screen.set(id, { x: pos.x + px, y: pos.y + py + bob, depth, r });
    }
    this.screen = screen;
  }

  _draw(time) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this._computeScreen(time);
    this._drawStars(time);
    this._updateBaseEdgeDim(time);
    this._drawBaseEdges(time);
    this._drawRoutes(time);
    this._drawFleets(time);
    this._drawCouriers();
    this._drawNodes(time);
    if (this.onOverlay) this.onOverlay(ctx, time);
  }

  /** 立即重绘一帧（reducedMotion 暂停循环或外部状态变化时使用） */
  redraw() {
    this._draw(performance.now() / 1000);
  }

  _drawStars(time) {
    const bg = this.bgCtx;
    if (!bg || !this.starsField) return;
    const now = performance.now();
    const dtMs = this.lastBackdropAt ? Math.min(100, now - this.lastBackdropAt) : 16;
    this.lastBackdropAt = now;
    if (this.nebula && this.visualQuality !== 'low') {
      this.nebula.update(dtMs);
      this.nebula.render(bg);
    } else {
      bg.fillStyle = '#03050a';
      bg.fillRect(0, 0, bg.canvas.width, bg.canvas.height);
    }
    // 官网 stars/nebula 的动画常量以**毫秒**计（twinkleSpeed≈0.0004/ms），
    // 这里必须喂毫秒，否则闪烁/雾推进慢 1000 倍≈冻结
    this.starsField.time = time * 1000;
    this.starsField.update(dtMs);
    this.starsField.render(bg);
  }

  /** 当前星位（已含 parallax/depth/bob）→ 直线端点；绝不使用烘焙坐标。 */
  _lineGeometry(fromId, toId, options = {}) {
    const from = this.screen.get(fromId) ?? this.positions.get(fromId);
    const to = this.screen.get(toId) ?? this.positions.get(toId);
    if (!from || !to) return null;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return null;
    const ux = dx / dist;
    const uy = dy / dist;
    const offset = options.offset ?? 0;
    // 法线方向偏移：out/in 两个方向各占一侧，形成成对平行航道。
    const nx = -uy * offset;
    const ny = ux * offset;
    const padFrom = options.pad === false ? 0 : (options.padFrom ?? ((from.r ?? 0) + 4));
    const padTo = options.pad === false ? 0 : (options.padTo ?? ((to.r ?? 0) + 4));
    return {
      sx: from.x + ux * padFrom + nx,
      sy: from.y + uy * padFrom + ny,
      ex: to.x - ux * padTo + nx,
      ey: to.y - uy * padTo + ny,
      ux,
      uy,
      nx: -uy,
      ny: ux,
      dist: Math.max(1, dist - padFrom - padTo),
      from,
      to,
    };
  }

  _pointAt(g, p) {
    return {
      x: g.sx + (g.ex - g.sx) * p,
      y: g.sy + (g.ey - g.sy) * p,
    };
  }

  /**
   * 航道几何（hover 蓝/金/灰航道、fleet 事件航道与舰队）：
   * 端点每帧取星位 + 端点留白 pad=24 + 双向平行偏移 offset=7 +
   * 二次曲线弓高 bow=min(48, dist*0.15) + 深度差纵向偏置 *26。
   * 基础边与手动同步信使仍用 _lineGeometry 的直线几何。
   */
  _laneGeometry(fromId, toId, options = {}) {
    const from = this.screen.get(fromId) ?? this.positions.get(fromId);
    const to = this.screen.get(toId) ?? this.positions.get(toId);
    if (!from || !to) return null;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return null;
    const ux = dx / dist;
    const uy = dy / dist;
    const padFrom = options.pad === false ? 0 : (options.padFrom ?? options.pad ?? 24);
    const padTo = options.pad === false ? 0 : (options.padTo ?? options.pad ?? 24);
    const offset = options.offset ?? 0;
    // out/in 各自沿行进方向取同一侧法线；方向相反即自然落在弦两侧，形成平行航道。
    const nx = -uy * offset;
    const ny = ux * offset;
    const sx = from.x + ux * padFrom + nx;
    const sy = from.y + uy * padFrom + ny;
    const ex = to.x - ux * padTo + nx;
    const ey = to.y - uy * padTo + ny;
    const mx = (sx + ex) / 2;
    const my = (sy + ey) / 2;
    const bowSign = options.bowSign === -1 ? -1 : 1;
    // 旧航道视觉：弓高按整条星间距离取比例，与端点留白无关。
    const bow = Math.min(48, dist * 0.15) * bowSign;
    // 深度差纵向偏置：远端更低/更高，读起来像有落差的 3D 航道。
    const depthBias = ((to.depth ?? 0.6) - (from.depth ?? 0.6)) * 26;
    const cx = mx - uy * bow + nx * 0.5;
    const cy = my + ux * bow + ny * 0.5 + depthBias;
    return {
      sx, sy, ex, ey, cx, cy, ux, uy,
      nx: -uy,
      ny: ux,
      dist,
      bow,
      bowSign,
      depthBias,
      from,
      to,
    };
  }

  /** 二次曲线上的点（p ∈ [0,1]）。 */
  _lanePoint(g, p) {
    const q = 1 - p;
    return {
      x: q * q * g.sx + 2 * q * p * g.cx + p * p * g.ex,
      y: q * q * g.sy + 2 * q * p * g.cy + p * p * g.ey,
    };
  }

  /** 二次曲线在 p 处的切线（用于舰体朝向）。 */
  _laneTangent(g, p) {
    const q = 1 - p;
    return {
      x: 2 * q * (g.cx - g.sx) + 2 * p * (g.ex - g.cx),
      y: 2 * q * (g.cy - g.sy) + 2 * p * (g.ey - g.cy),
    };
  }

  /**
   * 旧版航道视觉语言（b961e87 的 _drawEdges）：外发光底 + 沿线渐变 +
   * 流动点状航线 + 航向标 + 待发事件数据灯。
   * 蓝色 hover 可发出 / 金色可接收 / 灰色不可达（降级虚线）与 fleet 事件共用。
   */
  _drawLaneVisual(g, options = {}) {
    const ctx = this.ctx;
    if (!ctx || !g) return;
    const time = options.time ?? 0;
    const color = options.color ?? COLORS.routeSend;
    const dashed = options.dashed === true;
    const strength = Math.max(0, Math.min(1, options.strength ?? 1));
    const opacity = Math.max(0, Math.min(1, options.opacity ?? 1));
    if (strength <= 0 || opacity <= 0) return;
    const pending = Math.max(0, Math.floor(options.pending ?? 0));
    const seed = options.seed ?? `${g.sx}~${g.sy}~${g.ex}~${g.ey}`;

    const avgDepth = ((g.from.depth ?? 0.6) + (g.to.depth ?? 0.6)) / 2;
    const depthFade = (0.45 + avgDepth * 0.75) * opacity;
    const fromDepth = g.from.depth ?? 0.6;
    const toDepth = g.to.depth ?? 0.6;
    const endAlpha = (depth) => 0.85 * (0.4 + depth * 1.0);
    // 较远（深度更低）的一端再按航道长度衰减，强化「由近及远」。
    const dimEnd = Math.max(0.12, 1 - Math.min(
      0.68,
      g.dist / ((Math.min(this.width, this.height) || 720) * 0.8),
    ));
    let aFrom = endAlpha(fromDepth);
    let aTo = endAlpha(toDepth);
    if (fromDepth >= toDepth) aTo *= dimEnd;
    else aFrom *= dimEnd;
    const phase = (hashString(seed) % 628) / 100;
    const breathe = dashed || this.reducedMotion
      ? 1
      : 0.95 + 0.05 * Math.sin(time * 0.9 + phase);
    const laneAlpha = (dashed ? 0.5 : 1) * depthFade * strength;
    const width = (dashed ? 1 : 1.8) * (0.55 + avgDepth * 0.75);

    ctx.save();
    ctx.lineCap = 'round';

    // 外发光底：比航线宽 3.4 倍的低透明底层（不可达航道降级为无发光）。
    if (!dashed) {
      ctx.beginPath();
      ctx.moveTo(g.sx, g.sy);
      ctx.quadraticCurveTo(g.cx, g.cy, g.ex, g.ey);
      ctx.strokeStyle = rgba(color, 0.07 * depthFade * strength);
      ctx.lineWidth = width * 3.4;
      ctx.stroke();
    }

    // 沿线渐变：两端更淡、中间按端点深度取值，保留「由近及远」的纵深。
    const grad = ctx.createLinearGradient(g.sx, g.sy, g.ex, g.ey);
    grad.addColorStop(0, rgba(color, aFrom * 0.55 * breathe * laneAlpha));
    grad.addColorStop(0.08, rgba(color, aFrom * breathe * laneAlpha));
    grad.addColorStop(0.5, rgba(color, ((aFrom + aTo) / 2) * breathe * laneAlpha));
    grad.addColorStop(0.92, rgba(color, aTo * breathe * laneAlpha));
    grad.addColorStop(1, rgba(color, aTo * 0.55 * breathe * laneAlpha));

    ctx.beginPath();
    ctx.setLineDash(dashed ? [5, 6] : [1.5, 6]);
    // 航线持续流动：点距周期与 [1.5,6] 对齐，保证无缝；reduced-motion 静止。
    if (!dashed && !this.reducedMotion) {
      ctx.lineDashOffset = -((time * 6) % 7.5);
    } else {
      ctx.lineDashOffset = 0;
    }
    ctx.strokeStyle = grad;
    ctx.lineWidth = width;
    ctx.moveTo(g.sx, g.sy);
    ctx.quadraticCurveTo(g.cx, g.cy, g.ex, g.ey);
    ctx.stroke();
    ctx.lineDashOffset = 0;
    ctx.setLineDash([]);

    // 航向标：旧版小箭标（不是箭头线），标出航道终点方向。
    const tip = this._lanePoint(g, 0.93);
    const tan = this._laneTangent(g, 0.93);
    const ang = Math.atan2(tan.y, tan.x);
    const size = (dashed ? 4 : 6) * (0.6 + avgDepth * 0.6);
    ctx.globalAlpha = (dashed ? 0.5 : 0.85) * depthFade * strength;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - size * Math.cos(ang - 0.42), tip.y - size * Math.sin(ang - 0.42));
    ctx.lineTo(tip.x - size * 0.55 * Math.cos(ang), tip.y - size * 0.55 * Math.sin(ang));
    ctx.lineTo(tip.x - size * Math.cos(ang + 0.42), tip.y - size * Math.sin(ang + 0.42));
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // 沿线数据灯：只有可发出/接收且有待发事件时才流动。
    if (!dashed && pending > 0) {
      const speed = 0.18;
      const count = Math.min(4, 1 + Math.floor(pending / 4));
      ctx.fillStyle = color;
      for (let i = 0; i < count; i += 1) {
        const p = (time * speed + i / count) % 1;
        const point = this._lanePoint(g, p);
        ctx.globalAlpha = 0.85 * Math.sin(Math.PI * p) * depthFade * strength;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  /**
   * 触发一次舰队出航（fleet 事件）。端点不落盘：每帧按当前星位重新取几何。
   * kind: mine（本机发出）/ theirs（本机接收）/ transit（peer 之间）。
   */
  launchFleet(fromId, toId, options = {}) {
    if (fromId === toId) return;
    const ids = new Set(this.scene.nodes.map((node) => node.id));
    if (!ids.has(fromId) || !ids.has(toId)) return;
    const kind = options.kind === 'theirs' ? 'theirs'
      : options.kind === 'transit' ? 'transit'
        : 'mine';
    const event = options.event === true;
    const reduced = this.reducedMotion === true;

    // 彩蛋：2% 彗星、5% 彩虹信使、8% 旗舰；其余常规编队（事件航道不掷彩蛋）
    const roll = Math.random();
    const egg = !event && !reduced
      ? (roll < 0.02 ? 'comet' : roll < 0.07 ? 'rainbow' : roll < 0.15 ? 'flagship' : null)
      : null;
    const count = reduced
      ? 2
      : egg === 'comet'
        ? 1
        : Math.max(2, Math.min(6, options.ships ?? 2 + Math.floor(Math.random() * 5)));
    const formation = reduced ? 'line' : ['line', 'wedge', 'scatter'][Math.floor(Math.random() * 3)];

    const ships = Array.from({ length: count }, (_, i) => {
      let lat;
      if (formation === 'line') lat = (i - (count - 1) / 2) * 7.5;
      else if (formation === 'wedge') lat = (i - (count - 1) / 2) * 11;
      else lat = (Math.random() * 2 - 1) * 18;
      return {
        stagger: i * (formation === 'wedge' ? 0.045 : 0.075) * (0.8 + Math.random() * 0.4),
        lat,
        wiggle: Math.random() * Math.PI * 2,
        durFactor: 0.9 + Math.random() * 0.2,
        size: 0.85 + Math.random() * 0.4,
        hue: (i * 47) % 360,
      };
    });

    const duration = (egg === 'comet' ? 1150 : 1700) * (0.92 + Math.random() * 0.16);
    const fleet = {
      fromId,
      toId,
      kind,
      egg,
      formation,
      event,
      namespace: options.namespace ?? null,
      taskId: options.taskId ?? null,
      startedAt: performance.now(),
      duration,
      ships,
      reduced,
    };
    this.fleets.push(fleet);
    if (this.fleets.length > 8) this.fleets.splice(0, this.fleets.length - 8);
    this._updateSignals();

    if (reduced) {
      // reduced-motion：航道 + 静止编队各画一帧；结束后移除（不做淡出）
      this.redraw();
      const timer = setTimeout(() => {
        this.fleets = this.fleets.filter((item) => item !== fleet);
        this._reducedTimers = this._reducedTimers.filter((item) => item !== timer);
        this._updateSignals();
        this.redraw();
      }, duration + 600);
      this._reducedTimers.push(timer);
    }
  }

  /** 手动同步的本地反馈：独立白色信使，不复用任务舰队视觉。 */
  launchCourier(fromId, toId, options = {}) {
    if (fromId === toId) return;
    const ids = new Set(this.scene.nodes.map((node) => node.id));
    if (!ids.has(fromId) || !ids.has(toId)) return;
    const courier = {
      fromId,
      toId,
      startedAt: performance.now(),
      duration: options.duration ?? 950,
    };
    this.couriers.push(courier);
    if (this.couriers.length > 4) this.couriers.splice(0, this.couriers.length - 4);
    if (this.reducedMotion) {
      this.redraw();
      const timer = setTimeout(() => {
        this.couriers = this.couriers.filter((item) => item !== courier);
        this._reducedTimers = this._reducedTimers.filter((item) => item !== timer);
        this.redraw();
      }, courier.duration);
      this._reducedTimers.push(timer);
    }
  }

  /** hover 航道出现时基础边的目标亮度；离开恢复 1。 */
  baseEdgeDimTarget() {
    return this.routes.length > 0 ? BASE_EDGE_DIM_ON_HOVER : 1;
  }

  /**
   * 基础边亮度平滑过渡（时间常数 60ms，约 120ms 内基本到位；与帧率无关）。
   * reduced-motion 直接切换，避免任何渐变。
   */
  _updateBaseEdgeDim(time) {
    const target = this.baseEdgeDimTarget();
    if (this.reducedMotion) {
      this.baseEdgeDim = target;
      return this.baseEdgeDim;
    }
    const last = this.lastDimAt || time - 0.016;
    const dt = Math.max(0, Math.min(0.1, time - last));
    this.lastDimAt = time;
    const k = 1 - Math.exp(-dt / 0.06);
    this.baseEdgeDim += (target - this.baseEdgeDim) * k;
    if (Math.abs(target - this.baseEdgeDim) < 0.001) this.baseEdgeDim = target;
    return this.baseEdgeDim;
  }

  /** 基础边：所有设备两两相连；共同订阅实线、无共同订阅虚线；无方向箭头。 */
  _drawBaseEdges(time) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const edge of this.scene.edges) {
      const g = this._lineGeometry(edge.from, edge.to);
      if (!g) continue;
      const avgDepth = ((g.from.depth ?? 0.6) + (g.to.depth ?? 0.6)) / 2;
      const depthFade = 0.4 + avgDepth * 0.7;
      const shared = edge.shared === true;
      const color = shared ? COLORS.baseShared : COLORS.baseUnshared;
      const phase = (hashString(`${edge.from}~${edge.to}`) % 628) / 100;
      const breathe = this.reducedMotion
        ? 0.92
        : 0.78 + 0.22 * Math.sin(time * 0.75 + phase);
      const alpha = (shared ? 0.42 : 0.24) * depthFade * breathe * this.baseEdgeDim;

      if (shared) {
        // 共同订阅：细实线 + 极淡外发光（比无共同订阅更亮，但仍保持中性色）。
        ctx.beginPath();
        ctx.moveTo(g.sx, g.sy);
        ctx.lineTo(g.ex, g.ey);
        ctx.strokeStyle = rgba(color, alpha * 0.18);
        ctx.lineWidth = 3.2;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.moveTo(g.sx, g.sy);
      ctx.lineTo(g.ex, g.ey);
      ctx.strokeStyle = rgba(color, alpha);
      ctx.lineWidth = (shared ? 1.25 : 1) * (0.6 + avgDepth * 0.6);
      if (!shared) {
        ctx.setLineDash([3, 7]);
        ctx.lineDashOffset = this.reducedMotion ? 0 : -((time * 3) % 10);
      } else {
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
    ctx.restore();
  }

  /** 悬停航道：只画 console.js 注入的 routes；离开即 setRoutes([])。 */
  _drawRoutes(time) {
    if (this.routes.length === 0) return;
    for (const route of this.routes) {
      const reachable = route.reachable === true;
      // 双向航道（H→T 蓝 + T→H 金）平行偏移 7；灰色不可达单线居中。
      const paired = reachable && this.routes.some(
        (other) => other.from === route.to && other.to === route.from,
      );
      const offset = paired ? 7 : 0;
      // out 与 in 沿各自行进方向弯向同一侧，方向相反对称落在弦两侧。
      const bowSign = route.direction === 'in' ? 1 : -1;
      const g = this._laneGeometry(route.from, route.to, { offset, bowSign });
      if (!g) continue;
      const color = route.direction === 'out'
        ? COLORS.routeSend
        : route.direction === 'in' ? COLORS.routeReceive : COLORS.routeBlocked;
      this._drawLaneVisual(g, {
        time,
        color,
        dashed: !reachable,
        pending: route.pending,
        seed: `${route.from}~${route.to}~${route.direction}`,
      });
    }
  }

  _drawCouriers() {
    if (this.couriers.length === 0) return;
    const ctx = this.ctx;
    const now = performance.now();
    ctx.save();
    ctx.lineCap = 'round';
    for (const courier of this.couriers) {
      const g = this._lineGeometry(courier.fromId, courier.toId);
      if (!g) continue;
      const p = this.reducedMotion ? 0.5 : Math.min(1, Math.max(0, (now - courier.startedAt) / courier.duration));
      // 白色细线 + 单颗信使光点：明确的「本机手动同步」本地反馈，与任务舰队分开。
      ctx.beginPath();
      ctx.moveTo(g.sx, g.sy);
      ctx.lineTo(g.ex, g.ey);
      ctx.strokeStyle = rgba(COLORS.syncCourier, 0.16 * (1 - p * 0.35));
      ctx.lineWidth = 1;
      ctx.stroke();
      const point = this._pointAt(g, p);
      const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, 9);
      glow.addColorStop(0, rgba(COLORS.syncCourier, 0.55));
      glow.addColorStop(1, rgba(COLORS.syncCourier, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(COLORS.syncCourier, 0.95);
      ctx.beginPath();
      ctx.arc(point.x, point.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    this.couriers = this.couriers.filter((courier) => (
      this.reducedMotion ? true : now - courier.startedAt < courier.duration + 120
    ));
  }


  /** 舰队：沿事件方向出航；端点每帧绑当前星位；旗舰/彩虹信使/彗星为稀有彩蛋。 */
  _drawFleets(time) {
    if (this.fleets.length === 0) return;
    const ctx = this.ctx;
    const now = performance.now();
    const before = this.fleets.length;
    for (const fleet of this.fleets) {
      const elapsed = now - fleet.startedAt;
      // 不烘焙几何：每帧按星体当前屏幕位置（parallax/depth/bob 之后）重新取弧线航道。
      // mine / transit 弯向一侧，theirs 弯向另一侧，双向航道自然分开。
      const g = this._laneGeometry(fleet.fromId, fleet.toId, {
        bowSign: fleet.kind === 'theirs' ? 1 : -1,
      });
      if (!g) continue;
      const baseColor = fleet.kind === 'theirs'
        ? COLORS.fleetReceive
        : fleet.kind === 'transit' ? COLORS.fleetTransit : COLORS.fleetSend;
      const flagship = fleet.egg === 'flagship';
      const norm = { x: g.nx, y: g.ny };

      if (fleet.event) {
        // 事件航道：舰队结束后淡出移除；无 hover 也可见，沿用旧航道视觉语言。
        const fadeWindow = 700;
        const fade = elapsed <= fleet.duration
          ? 1
          : Math.max(0, 1 - (elapsed - fleet.duration) / fadeWindow);
        if (fade > 0) {
          this._drawLaneVisual(g, {
            time,
            color: baseColor,
            strength: fade,
            opacity: 0.65,
            seed: `${fleet.fromId}~${fleet.toId}~event`,
          });
        }
      }

      for (const ship of fleet.ships) {
        const dur = fleet.duration * ship.durFactor;
        const raw = (elapsed / dur - ship.stagger) / (1 - 0.09 * (fleet.ships.length - 1));
        const p = fleet.reduced ? 0.62 : raw;
        if (p <= 0 || p > 1.02) continue;
        const pc = Math.min(1, p);
        const pos = this._lanePoint(g, pc);
        const tan = this._laneTangent(g, pc);
        const ang = Math.atan2(tan.y, tan.x);
        // 编队横向错位 + 轻微蛇形摆动（随机相位）
        const lat = ship.lat * (1 - pc * 0.25) * 0.7 + Math.sin(pc * 9 + ship.wiggle) * 2.2;
        const px = pos.x + norm.x * lat;
        const py = pos.y + norm.y * lat;

        const swim = fleet.egg === 'rainbow';
        const paint = (alpha) => (swim
          ? hsla((now / 7 + ship.hue) % 360, 85, 70, alpha)
          : fleet.egg === 'comet'
            ? `rgba(223,242,255,${alpha})`
            : rgba(baseColor, alpha));

        // 尾迹（彗星最长、旗舰更亮）：宽晕 + 细亮线
        const tailLen = fleet.egg === 'comet' ? 0.14 : flagship ? 0.08 : 0.05;
        const tail = this._lanePoint(g, Math.max(0, pc - tailLen));
        ctx.beginPath();
        ctx.moveTo(tail.x + norm.x * lat, tail.y + norm.y * lat);
        ctx.lineTo(px, py);
        ctx.strokeStyle = paint(0.16 * (1 - pc * 0.5));
        ctx.lineWidth = flagship ? 3.6 : fleet.egg === 'comet' ? 3 : 2.4;
        ctx.stroke();
        ctx.strokeStyle = paint(0.42 * (1 - pc * 0.5));
        ctx.lineWidth = flagship ? 1.6 : fleet.egg === 'comet' ? 1.4 : 1;
        ctx.stroke();

        // 舰体：流线小艇（非箭形）；彗星/彩虹信使为光点形态
        const scale = ship.size * (flagship ? 1.6 : 1) * (fleet.egg === 'comet' ? 1.35 : 1);
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang);
        if (fleet.egg === 'comet' || fleet.egg === 'rainbow') {
          const mote = scale * (fleet.egg === 'rainbow' ? 1.5 : 1.3);
          const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, mote * 3.4);
          glow.addColorStop(0, paint(0.8));
          glow.addColorStop(1, paint(0));
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(0, 0, mote * 3.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = paint(0.95);
          ctx.beginPath();
          ctx.arc(0, 0, mote, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.beginPath();
          ctx.arc(0, 0, mote * 0.42, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const s2 = scale * (flagship ? 1.35 : 1);
          // 尾部引擎辉光
          const engine = ctx.createRadialGradient(-2.6 * s2, 0, 0, -2.6 * s2, 0, 5.5 * s2);
          engine.addColorStop(0, paint(0.5));
          engine.addColorStop(1, paint(0));
          ctx.fillStyle = engine;
          ctx.beginPath();
          ctx.arc(-2.6 * s2, 0, 5.5 * s2, 0, Math.PI * 2);
          ctx.fill();
          // 后掠翼线（manta 剪影）
          ctx.strokeStyle = paint(0.55);
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.moveTo(0.7 * s2, -0.65 * s2);
          ctx.quadraticCurveTo(-1.1 * s2, -1.85 * s2, -2.55 * s2, -2.15 * s2);
          ctx.moveTo(0.7 * s2, 0.65 * s2);
          ctx.quadraticCurveTo(-1.1 * s2, 1.85 * s2, -2.55 * s2, 2.15 * s2);
          ctx.stroke();
          // 椭圆舱体（圆头圆尾，非箭形）
          ctx.fillStyle = paint(0.95);
          ctx.beginPath();
          ctx.ellipse(0.45 * s2, 0, 3.5 * s2, 1.15 * s2, 0, 0, Math.PI * 2);
          ctx.fill();
          // 舰首航行灯 + 翼尖灯
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.beginPath();
          ctx.arc(3.15 * s2, 0, 0.55 * s2, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = paint(0.9);
          ctx.beginPath();
          ctx.arc(-2.55 * s2, -2.15 * s2, 0.55 * s2, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(-2.55 * s2, 2.15 * s2, 0.55 * s2, 0, Math.PI * 2);
          ctx.fill();
          if (flagship) {
            // 旗舰：舰桥核心 + 尾翼灯
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.beginPath();
            ctx.arc(0.2 * s2, 0, 1.1, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = paint(0.85);
            ctx.beginPath();
            ctx.arc(-2.2 * s2, 0, 0.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      }

      // 抵达绽放（旗舰双环 + 更大；彗星短促闪光；reduced-motion 不播放）
      const bloomWindow = fleet.egg === 'comet' ? 300 : 420;
      const bp = fleet.reduced ? 0 : (elapsed - fleet.duration) / bloomWindow;
      if (bp > 0 && bp < 1) {
        const big = fleet.egg === 'comet' ? 1.4 : flagship ? 1.5 : 1;
        const radius = (5 + bp * 16) * big;
        ctx.beginPath();
        ctx.arc(g.ex, g.ey, radius, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(baseColor, 0.7 * (1 - bp));
        ctx.lineWidth = flagship ? 2.2 : 1.6;
        ctx.stroke();
        if (flagship) {
          ctx.beginPath();
          ctx.arc(g.ex, g.ey, radius * 1.5, 0, Math.PI * 2);
          ctx.strokeStyle = rgba(baseColor, 0.35 * (1 - bp));
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        const bloom = ctx.createRadialGradient(g.ex, g.ey, 0, g.ex, g.ey, radius * 1.6);
        bloom.addColorStop(0, rgba(baseColor, (fleet.egg === 'comet' ? 0.5 : 0.35) * (1 - bp)));
        bloom.addColorStop(1, rgba(baseColor, 0));
        ctx.fillStyle = bloom;
        ctx.beginPath();
        ctx.arc(g.ex, g.ey, radius * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    this.fleets = this.fleets.filter((f) => now - f.startedAt < f.duration + 700);
    if (this.fleets.length !== before) this._updateSignals();
  }

  _drawNodes(time) {
    const ctx = this.ctx;
    const now = performance.now();
    const pulseProgress = now < this.pulseUntil ? 1 - (this.pulseUntil - now) / 1200 : null;
    const selfPos = this.scene.nodes.find((n) => n.self);
    if (pulseProgress !== null && selfPos) {
      const center = this.screen.get(selfPos.id) ?? this.positions.get(selfPos.id);
      if (center) {
        const radius = 14 + pulseProgress * 70;
        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,233,168,${0.55 * (1 - pulseProgress)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    const ordered = this.scene.nodes.slice().sort((a, b) => {
      const da = this.screen.get(a.id)?.depth ?? 0.6;
      const db = this.screen.get(b.id)?.depth ?? 0.6;
      return da - db; // 远者先画，近者覆盖
    });
    for (const node of ordered) {
      const pos = this.screen.get(node.id) ?? this.positions.get(node.id);
      if (!pos) continue;
      const depth = pos.depth ?? 0.6;
      const scale = 0.6 + depth * 0.7;
      const hovered = this.hovered === node.id;
      const selected = this.selectedId === node.id;
      if (node.ghost) {
        // P6A：锁定态本机虚影（CRT 经纬线地球仪 + 卫星 + 干扰毛刺）——不冒充真实设备星。
        drawGhostGlobe(ctx, pos.x, pos.y, (node.self ? 9 : 7) * scale, time, this.reducedMotion, hovered || selected, node.label);
        continue;
      }
      let radius = (node.self ? 9 : 6) * scale;
      let color = node.self ? '#ffe9a8' : '#9fd0ff';
      if (node.revoked) {
        color = COLORS.revokedNode;
        radius = (node.self ? 8 : 5) * scale;
      } else if (!node.online) {
        color = '#6b7694';
      }

      // 光晕（按深度缩放与衰减）
      if (node.self || node.online) {
        const glowR = (node.self ? 18 : 18) * scale;
        const glowAlpha = (node.self ? 0.3 : 0.4) * (0.45 + depth * 0.75);
        const glow = ctx.createRadialGradient(pos.x, pos.y, 1, pos.x, pos.y, glowR);
        glow.addColorStop(0, node.self ? `rgba(255,233,168,${glowAlpha})` : `rgba(86,180,233,${glowAlpha})`);
        glow.addColorStop(1, 'rgba(86,180,233,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, glowR, 0, Math.PI * 2);
        ctx.fill();
      }

      if (node.self) {
        drawSelfBeacon(ctx, pos.x, pos.y, radius * 1.15, time, this.reducedMotion, node.online);
      } else {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = hovered || selected ? 2 : 1;
        ctx.strokeStyle = hovered || selected ? '#ffffff' : 'rgba(255,255,255,0.35)';
        ctx.stroke();
      }

      if (node.revoked && !node.self) {
        ctx.strokeStyle = '#ff9b9b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(pos.x - radius, pos.y - radius);
        ctx.lineTo(pos.x + radius, pos.y + radius);
        ctx.stroke();
      }

      // 微闪烁：像恒星一样轻微明暗（不剧烈；reduced-motion 下静止）
      if (!node.self && !node.revoked && !this.reducedMotion) {
        const tw = 0.88 + 0.12 * Math.sin(time * (1.3 + (hashString(node.id) % 7) * 0.13) + (hashString(node.id) % 628) / 100);
        ctx.globalAlpha = tw;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius * 1.9, 0, Math.PI * 2);
        ctx.fillStyle = node.online ? 'rgba(159,208,255,0.10)' : 'rgba(159,208,255,0.05)';
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // 在线脉冲环
      if (node.online && !node.self && !node.revoked) {
        const pulse = (Math.sin(time * 2 + hashString(node.id) % 6) + 1) / 2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius + 4 + pulse * 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,158,115,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 标签（文字兜底；字号/亮度按深度）
      const labelSize = Math.round(9 + depth * 3);
      ctx.font = `${labelSize}px ui-monospace, Menlo, monospace`;
      ctx.globalAlpha = 0.5 + depth * 0.5;
      ctx.textAlign = 'center';
      const labelY = node.self ? pos.y + radius * 3.4 : pos.y + radius + 13;
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = node.self ? 6 : 3;
      ctx.fillStyle = node.self ? '#ffe9a8' : '#c6d3f0';
      ctx.fillText(node.label ?? shortId(node.id), pos.x, labelY);
      if (hovered || selected) {
        ctx.fillStyle = '#ffffff';
        ctx.fillText(node.label ?? shortId(node.id), pos.x, labelY + 1);
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }
}

/**
 * P6A：锁定态「本机虚影」。用 CRT 绿的低透明度经纬线地球仪（无光环）+
 * 环绕卫星 + 间隔性干扰毛刺，明确表达「本机尚未初始化」，不与真实设备星/本机信标混淆。
 */
function drawGhostGlobe(ctx, x, y, radius, time, reducedMotion, active, label) {
  const t = reducedMotion ? 0 : time;
  const R = radius * 2.15;
  // 地球仪本体：无外发光，只靠线条明暗与扫描感表达 CRT 虚影。
  const flicker = reducedMotion ? 0.82 : 0.74 + 0.05 * Math.sin(t * 2.2) + 0.02 * Math.sin(t * 8.7);
  const alpha = Math.max(0.5, Math.min(0.92, flicker + (active ? 0.1 : 0)));
  const glitch = crtGlitchLevel(t);
  // 沿用本机信标星的卫星轨道手感：同倾角、同投影比例；轨道略大于球体，卫星始终在轮廓外。
  const orbit = ghostOrbit(R * 1.7, -0.5, 0.72);
  // 干扰时整颗地球仪轻微横抖（标签不抖，保持可读）。
  const jitterX = glitch > 0.12 && !reducedMotion ? Math.sin(t * 95) * 3.2 * glitch : 0;
  const jitterY = glitch > 0.12 && !reducedMotion ? Math.sin(t * 127) * 1.2 * glitch : 0;

  ctx.save();
  ctx.translate(jitterX, jitterY);
  // 轨道后半个弧（在球体后面，暗）
  strokeGhostOrbit(ctx, x, y, orbit, alpha * 0.55, false);
  const satelliteA = t * 0.52;
  const satellite = orbit.point(satelliteA);
  if (satellite.z < 0) drawGhostSatellite(ctx, x, y, orbit, satelliteA, alpha * 0.62);

  // 经纬线球体
  drawGhostWireGlobe(ctx, x, y, R, t, alpha);

  // 轨道前半个弧 + 卫星（在球体前面，亮）
  strokeGhostOrbit(ctx, x, y, orbit, alpha, true);
  if (satellite.z >= 0) drawGhostSatellite(ctx, x, y, orbit, satelliteA, alpha);

  // CRT 干扰：间隔性横向撕裂/丢行/噪点（reduced-motion 不播放）
  if (glitch > 0) drawGhostGlitch(ctx, x, y, R, t, alpha, glitch);
  ctx.restore();

  // 标签：诚实的「本机 · 未初始化」。
  ctx.save();
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = `rgba(140,255,200,${0.68 * alpha})`;
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 4;
  ctx.fillText(label ?? '本机 · 未初始化', x, y + R + 24);
  ctx.restore();
}

/** 经纬线地球仪：外轮廓 + 8 条经线 + 5 条纬线 + 极轴；无填充、无光环。 */
function drawGhostWireGlobe(ctx, x, y, R, time, alpha) {
  // 锁定态地轴朝左：北极在左上、南极在右下（north.x < 0）。
  const TILT = 0.42;
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);
  const rotate = (px, py, pz) => ({
    x: px * cosT - py * sinT,
    y: px * sinT + py * cosT,
    z: pz,
  });
  const project = (p) => ({ x: x + p.x * R, y: y - p.y * R, z: p.z });
  const lonOffset = time * 0.22;

  // 球体轮廓（不是光环：只有 1px 线）
  ctx.strokeStyle = `rgba(109,255,184,${0.58 * alpha})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.stroke();

  // 极轴（虚线，轻微倾斜）
  const north = project(rotate(0, 1, 0));
  const south = project(rotate(0, -1, 0));
  ctx.setLineDash([2, 4]);
  ctx.strokeStyle = `rgba(109,255,184,${0.22 * alpha})`;
  ctx.beginPath();
  ctx.moveTo(north.x, north.y);
  ctx.lineTo(south.x, south.y);
  ctx.stroke();
  ctx.setLineDash([]);

  const drawCurve = (pointAt, steps, backAlpha, frontAlpha, width = 1) => {
    // 背面整条曲线先暗画一遍，正面再覆盖亮段。
    ctx.strokeStyle = `rgba(109,255,184,${backAlpha * alpha})`;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i <= steps; i += 1) {
      const p = pointAt(i / steps);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    ctx.strokeStyle = `rgba(170,255,210,${frontAlpha * alpha})`;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < steps; i += 1) {
      const p1 = pointAt(i / steps);
      const p2 = pointAt((i + 1) / steps);
      if ((p1.z + p2.z) / 2 < 0) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(p1.x, p1.y);
        started = true;
      }
      ctx.lineTo(p2.x, p2.y);
    }
    ctx.stroke();
  };

  // 经线：8 条，随时间绕轴旋转。
  for (let k = 0; k < 8; k += 1) {
    const lon = lonOffset + (Math.PI / 4) * k;
    const pointAt = (u) => {
      const lat = -Math.PI / 2 + u * Math.PI;
      const cosLat = Math.cos(lat);
      return project(rotate(cosLat * Math.sin(lon), Math.sin(lat), cosLat * Math.cos(lon)));
    };
    drawCurve(pointAt, 30, 0.16, k === 0 ? 0.68 : 0.48);
  }

  // 纬线：-60 / -30 / 0 / +30 / +60；赤道稍亮。
  for (const latDeg of [-60, -30, 0, 30, 60]) {
    const lat = (latDeg * Math.PI) / 180;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const pointAt = (u) => {
      const lon = u * Math.PI * 2;
      return project(rotate(cosLat * Math.sin(lon), sinLat, cosLat * Math.cos(lon)));
    };
    const equator = latDeg === 0;
    drawCurve(pointAt, 30, equator ? 0.22 : 0.13, equator ? 0.68 : 0.42);
  }
}

/** 卫星轨道几何：圆轨道在倾斜面上投影成椭圆；z > 0 表示在球体前方。 */
function ghostOrbit(radius, tilt, flatten) {
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  return {
    radius,
    point(a) {
      const lx = Math.cos(a) * radius;
      const ly = Math.sin(a) * radius * flatten;
      return {
        x: lx * cosT - ly * sinT,
        y: lx * sinT + ly * cosT,
        z: Math.sin(a),
      };
    },
  };
}

/** 只描轨道的一半（front=true 描 z>=0，false 描 z<0），断续虚线。 */
function strokeGhostOrbit(ctx, x, y, orbit, alpha, front) {
  const steps = 48;
  ctx.setLineDash([2, 5]);
  ctx.strokeStyle = `rgba(109,255,184,${(front ? 0.52 : 0.24) * alpha})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < steps; i += 1) {
    const p1 = orbit.point((i / steps) * Math.PI * 2);
    const p2 = orbit.point(((i + 1) / steps) * Math.PI * 2);
    if ((front ? p1.z : -p1.z) < 0) {
      started = false;
      continue;
    }
    if (!started) {
      ctx.moveTo(x + p1.x, y + p1.y);
      started = true;
    }
    ctx.lineTo(x + p2.x, y + p2.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

/** 小卫星：短尾迹 + 太阳能板横线 + 亮点；位于球体后方时整体压暗。 */
function drawGhostSatellite(ctx, x, y, orbit, a, alpha) {
  const p = orbit.point(a);
  const tail = orbit.point(a - 0.22);
  const sx = x + p.x;
  const sy = y + p.y;
  ctx.strokeStyle = `rgba(170,255,210,${0.5 * alpha})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + tail.x, y + tail.y);
  ctx.lineTo(sx, sy);
  ctx.stroke();

  ctx.strokeStyle = `rgba(109,255,184,${0.72 * alpha})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(sx - 5, sy);
  ctx.lineTo(sx + 5, sy);
  ctx.stroke();

  ctx.fillStyle = `rgba(210,255,232,${0.95 * alpha})`;
  ctx.fillRect(sx - 1.6, sy - 1.6, 3.2, 3.2);
}

/** CRT 干扰强度：约每 4.2s 一次 180ms 撕裂，另每 7.3s 一次 70ms 短闪。导出供视觉契约单测。 */
export function crtGlitchLevel(t) {
  if (t <= 0) return 0;
  const first = t % 4.2;
  const second = (t + 2.15) % 7.3;
  const a = first < 0.18 ? 1 - first / 0.18 : 0;
  const b = second < 0.07 ? 1 - second / 0.07 : 0;
  return Math.max(a, b * 0.8);
}

/** 干扰毛刺：横向丢行 + 位移重绘（切片错位）+ 亮线 + 少量噪点；只作用在球体附近。 */
function drawGhostGlitch(ctx, x, y, R, t, alpha, level) {
  const seed = Math.floor(t * 24);
  const rand = (n) => {
    const v = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  ctx.save();
  for (let i = 0; i < 4; i += 1) {
    const by = y + (rand(i) - 0.5) * R * 1.6;
    const bh = 1 + rand(i + 8) * 3;
    const shift = (rand(i + 16) - 0.5) * R * 1.25;
    // 先丢行，再把该切片的地球仪横向错位重绘：经典 CRT tracking 故障感。
    ctx.clearRect(x - R * 1.35, by, R * 2.7, bh);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - R * 1.35, by, R * 2.7, bh);
    ctx.clip();
    ctx.translate(shift, 0);
    drawGhostWireGlobe(ctx, x, y, R, t, alpha * 0.92);
    ctx.restore();
    ctx.strokeStyle = `rgba(190,255,225,${0.85 * level * alpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - R * 1.25 + shift, by + bh * 0.5);
    ctx.lineTo(x + R * 1.25 + shift, by + bh * 0.5);
    ctx.stroke();
  }
  for (let i = 0; i < 6; i += 1) {
    const bx = x + (rand(i + 30) - 0.5) * R * 2.3;
    const by = y + (rand(i + 40) - 0.5) * R * 1.9;
    ctx.fillStyle = `rgba(109,255,184,${0.22 * level * alpha})`;
    ctx.fillRect(bx, by, 1 + rand(i + 50) * 7, 1);
  }
  ctx.restore();
}

/**
 * 本机“信标”星：白热核心 + 衍射星芒 + 缓慢旋转的虚线轨道环。
 * 比五角星更接近科幻恒星/信标观感；reduced-motion 时静止。
 */
function drawSelfBeacon(ctx, x, y, radius, time, reducedMotion, online) {
  const t = reducedMotion ? 0 : time;
  const spin = t * 0.1;
  // 核心微脉动 + 偶发“闪亮”（约每 20s 一次短促增亮，像恒星耀斑）
  const spike = reducedMotion ? 0 : Math.pow(Math.max(0, Math.sin(t * 0.31)), 26);
  const shimmer = reducedMotion ? 1 : Math.min(1.25, 0.92 + 0.08 * Math.sin(t * 2.3) + spike * 0.3);

  // 倾斜轨道几何：圆轨道在 45° 倾角下投影为椭圆（含平转 tilt），
  // z = sin(a) 表示深度（>0 在前，<0 在后）
  const ORBIT_R = radius * 1.75;
  const INC = Math.SQRT1_2;            // ≈0.707（45° 倾角投影）
  const TILT = -0.5;                   // 轨道面在屏幕上的平转角
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);
  const orbitLocal = (a) => {
    const lx = Math.cos(a) * ORBIT_R;
    const ly = Math.sin(a) * ORBIT_R * INC;
    return {
      x: lx * cosT - ly * sinT,
      y: lx * sinT + ly * cosT,
      z: Math.sin(a),
    };
  };

  // 外层柔光（收小、低对比）
  const halo = ctx.createRadialGradient(x, y, 1, x, y, radius * 3.2);
  halo.addColorStop(0, `rgba(255,255,255,${0.75 * shimmer})`);
  halo.addColorStop(0.3, `rgba(255,233,168,${0.34 * shimmer})`);
  halo.addColorStop(0.65, 'rgba(86,180,233,0.12)');
  halo.addColorStop(1, 'rgba(86,180,233,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(x, y, radius * 3.2, 0, Math.PI * 2);
  ctx.fill();

  // 极淡外环（平面参考环）
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = 'rgba(140,190,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, radius * 2.15, 0, Math.PI * 2);
  ctx.stroke();

  // 科技刻度环：24 道短刻度，缓慢反向旋转（雷达/星图质感）
  const tickR = radius * 2.45;
  const tickSpin = -spin * 0.35;
  ctx.rotate(tickSpin);
  ctx.strokeStyle = 'rgba(150,200,255,0.20)';
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 24; i += 1) {
    const a = (Math.PI * 2 * i) / 24;
    const long = i % 6 === 0;
    const len = long ? radius * 0.28 : radius * 0.15;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * (tickR - len), Math.sin(a) * (tickR - len));
    ctx.lineTo(Math.cos(a) * tickR, Math.sin(a) * tickR);
    ctx.stroke();
  }
  ctx.rotate(-tickSpin);

  // 等离子弧：内环上三段不同速的弧光
  if (!reducedMotion) {
    for (let i = 0; i < 3; i += 1) {
      const arcSpin = t * (0.5 + i * 0.22) * (i % 2 === 0 ? 1 : -1);
      const span = 0.32 + i * 0.08;
      const arcR = radius * (1.28 + i * 0.12);
      ctx.strokeStyle = i === 1 ? 'rgba(255,233,168,0.30)' : 'rgba(120,200,255,0.32)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(0, 0, arcR, arcSpin, arcSpin + span);
      ctx.stroke();
    }
  }

  // 心跳脉冲：约每 4.2s 一圈极淡扩散环（能量呼吸，不是同步脉冲）
  if (!reducedMotion) {
    const hb = (t % 4.2) / 4.2;
    if (hb < 0.4) {
      const k = hb / 0.4;
      ctx.strokeStyle = `rgba(255,233,168,${0.22 * (1 - k)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, radius * (0.7 + k * 2.1), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();

  const drawOrbitArc = (startA, endA, alpha) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(TILT);
    ctx.strokeStyle = online ? `rgba(120,200,255,${alpha})` : `rgba(140,150,180,${alpha * 0.75})`;
    ctx.lineWidth = 0.9;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.ellipse(0, 0, ORBIT_R, ORBIT_R * INC, 0, startA, endA);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  };

  const drawSatellite = (a) => {
    const p = orbitLocal(a);
    const z = p.z;
    const satR = radius * 0.34 * (1 + z * 0.3);
    const satAlpha = online ? 0.55 + 0.45 * ((z + 1) / 2) : 0.3;
    const sx = x + p.x;
    const sy = y + p.y;
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, satR * 2.1);
    glow.addColorStop(0, `rgba(255,255,255,${0.95 * satAlpha})`);
    glow.addColorStop(0.4, `rgba(120,200,255,${0.5 * satAlpha})`);
    glow.addColorStop(1, 'rgba(120,200,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(sx, sy, satR * 2.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sx, sy, satR, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${0.95 * satAlpha})`;
    ctx.fill();
  };

  // 伴星相位（约 14s 一圈）
  const satA = t * 0.45;
  const sat = orbitLocal(satA);
  const behind = sat.z < 0;

  // 后半个轨道 + 伴星（在星体之后：先画，之后被核心/光晕遮挡）
  drawOrbitArc(Math.PI, Math.PI * 2, 0.18);
  if (behind) drawSatellite(satA);

  // 衍射星芒（4 长 + 4 短；细、渐变衰减）
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(spin * 0.5);
  for (let i = 0; i < 8; i += 1) {
    const long = i % 2 === 0;
    const len = radius * (long ? 3.1 : 1.7);
    const alpha = (long ? 0.4 : 0.22) * shimmer;
    ctx.save();
    ctx.rotate((Math.PI / 4) * i);
    const grad = ctx.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
    grad.addColorStop(0.4, `rgba(255,233,168,${alpha * 0.45})`);
    grad.addColorStop(1, 'rgba(255,233,168,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = long ? 1 : 0.7;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(len, 0);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  // 核心：白热小核 + 暖色内环 + 极亮中点
  const coreGlow = ctx.createRadialGradient(x, y, 0, x, y, radius * 0.95);
  coreGlow.addColorStop(0, `rgba(255,255,255,${0.98 * shimmer})`);
  coreGlow.addColorStop(0.55, `rgba(255,244,210,${0.75 * shimmer})`);
  coreGlow.addColorStop(1, 'rgba(255,233,168,0)');
  ctx.fillStyle = coreGlow;
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.95, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, radius * 0.92, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,233,168,0.6)';
  ctx.lineWidth = 1.1;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, radius * 0.32, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // 前半个轨道 + 伴星（在星体之前：后画，更大更亮）
  drawOrbitArc(0, Math.PI, 0.46);
  if (!behind) drawSatellite(satA);
}

function drawStarShape(ctx, x, y, radius, color) {
  const spikes = 5;
  const outer = radius;
  const inner = radius * 0.45;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const angle = (Math.PI / spikes) * i - Math.PI / 2;
    const px = x + Math.cos(angle) * r;
    const py = y + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

export { shortId };
