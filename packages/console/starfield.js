import { Nebula } from './nebula.js';
import { Starfield } from './stars.js';

// 星图舞台（vanilla Canvas2D，零依赖）
//
// 视觉语言参考官网第二页『网络舞台』：视差星空 + 高亮设备星 + 方向分色连线 +
// 同步粒子。本文件不依赖站点代码，只负责画布渲染与指针命中，数据由 console.js 注入。
//
// 公开接口：
//   const stage = new StarStage(canvas);
//   stage.setScene({ nodes, edges });
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

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const COLORS = {
  mine: '#56b4e9',
  theirs: '#e69f00',
  revoked: '#7a8399',
  offline: '#5a6785',
  text: '#dbe4ff',
  muted: '#8391b4',
  revokedNode: '#a06a6a',
  warning: '#d55e00',
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
    this.startTime = performance.now();
    this.pulseUntil = 0;
    this.onHover = null;
    this.onSelect = null;
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
    this.pointerNx = 0.5;
    this.pointerNy = 0.5;
    this.targetNx = 0.5;
    this.targetNy = 0.5;

    this._tick = this._tick.bind(this);
    this._resize = this._resize.bind(this);
    this._pointerMove = this._pointerMove.bind(this);
    this._pointerLeave = this._pointerLeave.bind(this);
    this._click = this._click.bind(this);

    this._resize();
    this._initBackdrop();
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
    this._layout();
    if (!this.running || this.reducedMotion) this._draw(performance.now() / 1000);
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
    if (this.running) return;
    this.running = true;
    if (this.reducedMotion) {
      this._draw(performance.now() / 1000);
      this.raf = 0;
      return;
    }
    this.raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy() {
    this.stop();
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
    }
    if (this.onHover) this.onHover(hit, x, y);
    const nx = rect.width ? x / rect.width : 0.5;
    const ny = rect.height ? y / rect.height : 0.5;
    this.targetNx = nx;
    this.targetNy = ny;
  }

  _pointerLeave() {
    this.hovered = null;
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
      screen.set(id, { x: pos.x + px, y: pos.y + py + bob, depth });
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
    this._drawEdges(time);
    this._drawFleets(time);
    this._drawNodes(time);
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

  _edgePoints(edge) {
    const from = this.screen.get(edge.from) ?? this.positions.get(edge.from);
    const to = this.screen.get(edge.to) ?? this.positions.get(edge.to);
    if (!from || !to) return null;
    return { from, to };
  }

  _edgeStyle(edge) {
    if (edge.revoked) return { color: COLORS.revoked, dashed: true, width: 1 };
    if (!edge.online) return { color: COLORS.offline, dashed: true, width: 1.2 };
    if (edge.kind === 'theirs') return { color: COLORS.theirs, dashed: false, width: 1.8 };
    return { color: COLORS.mine, dashed: false, width: 1.8 };
  }

  /** 航道几何：端点留白 + 双向平行偏移 + 弧线（含深度差偏置） */
  _laneGeometry(edge) {
    const points = this._edgePoints(edge);
    if (!points) return null;
    const { from, to } = points;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const bothWays = this.scene.edges.some(
      (other) => other.from === edge.to && other.to === edge.from && other.kind !== edge.kind,
    );
    const side = edge.kind === 'theirs' ? 1 : -1;
    let nx = 0;
    let ny = 0;
    if (bothWays) {
      // 偏移按规范方向计算，双向各自平行
      const forward = edge.from <= edge.to;
      const cdx = forward ? dx : -dx;
      const cdy = forward ? dy : -dy;
      const cdist = Math.hypot(cdx, cdy) || 1;
      const off = 7 * side;
      nx = (-cdy / cdist) * off;
      ny = (cdx / cdist) * off;
    }
    const pad = 24;
    const sx = from.x + ux * pad + nx;
    const sy = from.y + uy * pad + ny;
    const ex = to.x - ux * pad + nx;
    const ey = to.y - uy * pad + ny;
    // 空间弧线：中点法线弓高（模拟 3D 航道）+ 深度差纵向偏置（远端更低/更高）
    const mx = (sx + ex) / 2;
    const my = (sy + ey) / 2;
    const bow = Math.min(48, dist * 0.15) * side;
    const depthBias = ((to.depth ?? 0.6) - (from.depth ?? 0.6)) * 26;
    const cx = mx - uy * bow + nx * 0.5;
    const cy = my + ux * bow + ny * 0.5 + depthBias;
    return { sx, sy, ex, ey, cx, cy, ux, uy, dist, bothWays, from, to };
  }

  _bezierAt(g, p) {
    const q = 1 - p;
    return {
      x: q * q * g.sx + 2 * q * p * g.cx + p * p * g.ex,
      y: q * q * g.sy + 2 * q * p * g.cy + p * p * g.ey,
    };
  }

  _bezierTangent(g, p) {
    const q = 1 - p;
    return {
      x: 2 * q * (g.cx - g.sx) + 2 * p * (g.ex - g.cx),
      y: 2 * q * (g.cy - g.sy) + 2 * p * (g.ey - g.cy),
    };
  }

  /** 触发一次“舰队出航”（同步完成/手动同步时调用）；编队随机，稀有彩蛋 */
  launchFleet(fromId, toId, options = {}) {
    if (this.reducedMotion || fromId === toId) return;
    const kind = options.kind === 'theirs' ? 'theirs' : 'mine';
    const g = this._laneGeometry({ from: fromId, to: toId, kind, online: true, revoked: false, pending: 0 });
    if (!g) return;

    // 彩蛋：2% 彗星、5% 彩虹信使、8% 旗舰；其余常规编队
    const roll = Math.random();
    const egg = roll < 0.02 ? 'comet' : roll < 0.07 ? 'rainbow' : roll < 0.15 ? 'flagship' : null;
    const count = egg === 'comet'
      ? 1
      : Math.max(2, Math.min(6, options.ships ?? 2 + Math.floor(Math.random() * 5)));
    const formation = ['line', 'wedge', 'scatter'][Math.floor(Math.random() * 3)];

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

    this.fleets.push({
      geometry: g,
      kind,
      egg,
      formation,
      startedAt: performance.now(),
      duration: (egg === 'comet' ? 1150 : 1700) * (0.92 + Math.random() * 0.16),
      ships,
    });
    if (this.fleets.length > 8) this.fleets.splice(0, this.fleets.length - 8);
  }

  _drawEdges(time) {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    for (const edge of this.scene.edges) {
      const g = this._laneGeometry(edge);
      if (!g) continue;
      const avgDepth = ((g.from.depth ?? 0.6) + (g.to.depth ?? 0.6)) / 2;
      const depthFade = 0.45 + avgDepth * 0.75;
      const online = edge.online && !edge.revoked;
      const baseColor = edge.revoked ? COLORS.revoked
        : !edge.online ? COLORS.offline
        : edge.kind === 'theirs' ? COLORS.theirs : COLORS.mine;
      const alpha = (edge.revoked ? 0.45 : edge.online ? 0.85 : 0.5) * depthFade;
      const width = (edge.revoked ? 1 : edge.online ? 1.8 : 1.2) * (0.55 + avgDepth * 0.75);

      // 航道：外发光底 + 细点状航线 + 沿线渐变
      if (online) {
        ctx.beginPath();
        ctx.moveTo(g.sx, g.sy);
        ctx.quadraticCurveTo(g.cx, g.cy, g.ex, g.ey);
        ctx.strokeStyle = rgba(baseColor, 0.07 * depthFade);
        ctx.lineWidth = width * 3.4;
        ctx.stroke();
      }

      const grad = ctx.createLinearGradient(g.sx, g.sy, g.ex, g.ey);
      grad.addColorStop(0, rgba(baseColor, 0));
      grad.addColorStop(0.12, rgba(baseColor, alpha));
      grad.addColorStop(0.88, rgba(baseColor, alpha));
      grad.addColorStop(1, rgba(baseColor, 0));
      ctx.beginPath();
      ctx.setLineDash(online ? [1.5, 6] : [5, 6]);
      ctx.strokeStyle = grad;
      ctx.lineWidth = width;
      ctx.moveTo(g.sx, g.sy);
      ctx.quadraticCurveTo(g.cx, g.cy, g.ex, g.ey);
      ctx.stroke();
      ctx.setLineDash([]);

      // 航向标：小箭标（替代大箭头）
      const tip = this._bezierAt(g, 0.93);
      const tan = this._bezierTangent(g, 0.93);
      const ang = Math.atan2(tan.y, tan.x);
      const size = (edge.revoked ? 4 : 6) * (0.6 + avgDepth * 0.6);
      ctx.globalAlpha = (edge.revoked ? 0.45 : edge.online ? 0.85 : 0.55) * depthFade;
      ctx.fillStyle = baseColor;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - size * Math.cos(ang - 0.42), tip.y - size * Math.sin(ang - 0.42));
      ctx.lineTo(tip.x - size * 0.55 * Math.cos(ang), tip.y - size * 0.55 * Math.sin(ang));
      ctx.lineTo(tip.x - size * Math.cos(ang + 0.42), tip.y - size * Math.sin(ang + 0.42));
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;

      // 航线灯：在线且有待发事件时沿航道流动
      if (online && (edge.pending ?? 0) > 0) {
        const speed = 0.32;
        const count = Math.min(4, 1 + Math.floor((edge.pending ?? 0) / 4));
        for (let i = 0; i < count; i += 1) {
          const p = (time * speed + i / count) % 1;
          const pos = this._bezierAt(g, p);
          ctx.beginPath();
          ctx.fillStyle = baseColor;
          ctx.globalAlpha = 0.85 * Math.sin(Math.PI * p) * depthFade;
          ctx.arc(pos.x, pos.y, 2.1, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  /** 舰队：随机编队沿航道出航；旗舰/彩虹信使/彗星为稀有彩蛋；抵达后绽放 */
  _drawFleets(time) {
    if (this.fleets.length === 0) return;
    const ctx = this.ctx;
    const now = performance.now();
    for (const fleet of this.fleets) {
      const elapsed = now - fleet.startedAt;
      const g = fleet.geometry;
      const baseColor = fleet.kind === 'theirs' ? COLORS.theirs : COLORS.mine;
      const flagship = fleet.egg === 'flagship';
      const norm = { x: -(g.ey - g.sy), y: g.ex - g.sx };
      const nlen = Math.hypot(norm.x, norm.y) || 1;
      norm.x /= nlen;
      norm.y /= nlen;

      for (const ship of fleet.ships) {
        const dur = fleet.duration * ship.durFactor;
        const p = (elapsed / dur - ship.stagger) / (1 - 0.09 * (fleet.ships.length - 1));
        if (p <= 0 || p > 1.02) continue;
        const pc = Math.min(1, p);
        const pos = this._bezierAt(g, pc);
        const tan = this._bezierTangent(g, pc);
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

        // 尾迹（彗星最长、旗舰更亮）
        const tailLen = fleet.egg === 'comet' ? 0.14 : flagship ? 0.08 : 0.05;
        const tail = this._bezierAt(g, Math.max(0, pc - tailLen));
        ctx.beginPath();
        ctx.moveTo(tail.x + norm.x * lat, tail.y + norm.y * lat);
        ctx.lineTo(px, py);
        ctx.strokeStyle = paint(0.38 * (1 - pc * 0.5));
        ctx.lineWidth = flagship ? 2.2 : fleet.egg === 'comet' ? 2 : 1.4;
        ctx.stroke();

        // 舰体
        const scale = ship.size * (flagship ? 1.6 : 1) * (fleet.egg === 'comet' ? 1.35 : 1);
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang);
        ctx.fillStyle = paint(0.95);
        ctx.beginPath();
        ctx.moveTo(5.2 * scale, 0);
        ctx.lineTo(-2.6 * scale, -1.9 * scale);
        ctx.lineTo(-1.2 * scale, 0);
        ctx.lineTo(-2.6 * scale, 1.9 * scale);
        ctx.closePath();
        ctx.fill();
        if (flagship) {
          ctx.beginPath();
          ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.fill();
        }
        ctx.restore();
      }

      // 抵达绽放（旗舰双环 + 更大；彗星短促闪光）
      const bloomWindow = fleet.egg === 'comet' ? 300 : 420;
      const bp = (elapsed - fleet.duration) / bloomWindow;
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
