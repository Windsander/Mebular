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
    peers.forEach((peer, index) => {
      const offset = (hashString(peer.id) % 360) * (Math.PI / 180);
      const angle = offset + index * GOLDEN_ANGLE;
      const ring = Math.floor(index / 9);
      const radius = Math.min(baseRadius * (1 + ring * 0.32), Math.min(this.width, this.height) * 0.46);
      positions.set(peer.id, {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius * 0.82,
      });
    });
    this.positions = positions;
  }

  _hitTest(x, y) {
    let best = null;
    let bestDist = 22;
    for (const node of this.scene.nodes) {
      const pos = this.positions.get(node.id);
      if (!pos) continue;
      const dist = Math.hypot(pos.x - x, pos.y - y);
      if (dist < bestDist) {
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
    if (this.nebula) { this.nebula.mouseX = nx; this.nebula.mouseY = ny; }
    if (this.starsField) { this.starsField.mouseX = nx; this.starsField.mouseY = ny; }
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

  _draw(time) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this._drawStars(time);
    this._drawEdges(time);
    this._drawNodes(time);
  }

  _drawStars(time) {
    const bg = this.bgCtx;
    if (!bg || !this.starsField) return;
    const now = performance.now();
    const dt = this.lastBackdropAt ? Math.min(0.05, (now - this.lastBackdropAt) / 1000) : 0.016;
    this.lastBackdropAt = now;
    if (this.nebula && this.visualQuality !== 'low') {
      this.nebula.update(dt);
      this.nebula.render(bg);
    } else {
      bg.fillStyle = '#03050a';
      bg.fillRect(0, 0, bg.canvas.width, bg.canvas.height);
    }
    this.starsField.time = time;
    this.starsField.update(dt);
    this.starsField.render(bg);
  }

  _edgePoints(edge) {
    const from = this.positions.get(edge.from);
    const to = this.positions.get(edge.to);
    if (!from || !to) return null;
    return { from, to };
  }

  _edgeStyle(edge) {
    if (edge.revoked) return { color: COLORS.revoked, dashed: true, width: 1 };
    if (!edge.online) return { color: COLORS.offline, dashed: true, width: 1.2 };
    if (edge.kind === 'theirs') return { color: COLORS.theirs, dashed: false, width: 1.8 };
    return { color: COLORS.mine, dashed: false, width: 1.8 };
  }

  _drawEdges(time) {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    for (const edge of this.scene.edges) {
      const points = this._edgePoints(edge);
      if (!points) continue;
      const { from, to } = points;
      const style = this._edgeStyle(edge);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      // 双向授权时向法线偏移，避免两条边重合。
      // 偏移必须基于**规范方向**（按 id 排序），否则正反两向各自按自身方向取
      // 法线会算出同一个偏移量，两条线仍完全重合、后画的盖住先画的。
      const bothWays = this.scene.edges.some(
        (other) => other.from === edge.to && other.to === edge.from && other.kind !== edge.kind,
      );
      const side = edge.kind === 'theirs' ? 1 : -1;
      let nx = 0;
      let ny = 0;
      if (bothWays) {
        const forward = edge.from <= edge.to;
        const cdx = forward ? dx : -dx;
        const cdy = forward ? dy : -dy;
        const cdist = Math.hypot(cdx, cdy) || 1;
        const off = 7 * side;
        nx = (-cdy / cdist) * off;
        ny = (cdx / cdist) * off;
      }
      const startX = from.x + ux * 20 + nx;
      const startY = from.y + uy * 20 + ny;
      const endX = to.x - ux * 20 + nx;
      const endY = to.y - uy * 20 + ny;

      ctx.beginPath();
      ctx.setLineDash(style.dashed ? [5, 6] : []);
      ctx.strokeStyle = style.color;
      ctx.globalAlpha = edge.revoked ? 0.5 : edge.online ? 0.85 : 0.55;
      ctx.lineWidth = style.width;
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // 箭头
      const ax = endX;
      const ay = endY;
      const angle = Math.atan2(uy, ux);
      ctx.fillStyle = style.color;
      ctx.globalAlpha = edge.revoked ? 0.5 : 0.9;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - 8 * Math.cos(angle - 0.4), ay - 8 * Math.sin(angle - 0.4));
      ctx.lineTo(ax - 8 * Math.cos(angle + 0.4), ay - 8 * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;

      // 同步粒子：在线且有待发事件时流动
      if (edge.online && !edge.revoked && (edge.pending ?? 0) > 0) {
        const speed = 0.35;
        const count = Math.min(4, 1 + Math.floor((edge.pending ?? 0) / 4));
        for (let i = 0; i < count; i += 1) {
          const t = ((time * speed + i / count) % 1);
          const px = startX + (endX - startX) * t;
          const py = startY + (endY - startY) * t;
          ctx.beginPath();
          ctx.fillStyle = style.color;
          ctx.globalAlpha = 0.9 * Math.sin(Math.PI * t);
          ctx.arc(px, py, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  _drawNodes(time) {
    const ctx = this.ctx;
    const now = performance.now();
    const pulseProgress = now < this.pulseUntil ? 1 - (this.pulseUntil - now) / 1200 : null;
    const selfPos = this.scene.nodes.find((n) => n.self);
    if (pulseProgress !== null && selfPos) {
      const center = this.positions.get(selfPos.id);
      if (center) {
        const radius = 14 + pulseProgress * 70;
        ctx.beginPath();
        ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,233,168,${0.55 * (1 - pulseProgress)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    for (const node of this.scene.nodes) {
      const pos = this.positions.get(node.id);
      if (!pos) continue;
      const hovered = this.hovered === node.id;
      const selected = this.selectedId === node.id;
      let radius = node.self ? 9 : 6;
      let color = node.self ? '#ffe9a8' : '#9fd0ff';
      if (node.revoked) {
        color = COLORS.revokedNode;
        radius = node.self ? 8 : 5;
      } else if (!node.online) {
        color = '#6b7694';
      }

      // 光晕
      if (node.self || node.online) {
        const glow = ctx.createRadialGradient(pos.x, pos.y, 1, pos.x, pos.y, node.self ? 26 : 18);
        glow.addColorStop(0, node.self ? 'rgba(255,233,168,0.55)' : 'rgba(86,180,233,0.4)');
        glow.addColorStop(1, 'rgba(86,180,233,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, node.self ? 26 : 18, 0, Math.PI * 2);
        ctx.fill();
      }

      if (node.self) {
        drawStarShape(ctx, pos.x, pos.y, radius * 1.6, color);
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

      // 在线脉冲环
      if (node.online && !node.self && !node.revoked) {
        const pulse = (Math.sin(time * 2 + hashString(node.id) % 6) + 1) / 2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius + 4 + pulse * 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,158,115,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 标签（文字兜底）
      ctx.font = '11px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = node.self ? '#ffe9a8' : '#c6d3f0';
      ctx.fillText(node.label ?? shortId(node.id), pos.x, pos.y + radius + 14);
      if (hovered || selected) {
        ctx.fillStyle = '#ffffff';
        ctx.fillText(node.label ?? shortId(node.id), pos.x, pos.y + radius + 14);
      }
    }
  }
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
