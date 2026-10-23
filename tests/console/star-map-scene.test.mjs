// 星图设备网络 / 任务域航道的纯函数契约：
// - 所有设备两两之间都有基础边（6 节点 = 15 条）
// - 基础边视觉只由 online（两端在线且未移除）与 shared（共同订阅）决定：
//   solid = online && shared，其余一律灰色虚线
// - 悬停航道只在 hover 时存在；任务域可达 = 双方在线 + 双方都订阅任务域
// - fleet 事件只接受 from/to 都在场景内的真实方向

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  BASE_EDGE_DIM_ON_HOVER,
  DEFAULT_TASK_NAMESPACE,
  StarStage,
  baseEdgePulse,
  baseEdgePulseTiming,
  buildBaseEdges,
  buildHoverRoutes,
  buildNetworkNodes,
  buildNetworkScene,
  normalizeFleetEvent,
  resolveTaskNamespace,
  sharedNamespaces,
  summarizeHoverRoutes,
  summarizeSceneEdges,
  taskDomainState,
} from '../../packages/console/starfield.js';

const devices = () => [
  { deviceId: 'A', online: true, subscriptions: ['tasks', 'notes'], blocked: false },
  { deviceId: 'B', online: true, subscriptions: ['tasks', 'notes'], blocked: false },
  { deviceId: 'C', online: true, subscriptions: ['tasks'], blocked: false },
  { deviceId: 'D', online: true, subscriptions: ['notes'], blocked: false },
  { deviceId: 'E', online: false, subscriptions: ['tasks'], blocked: false },
  { deviceId: 'F', online: true, subscriptions: [], blocked: true },
];

const scene = () => buildNetworkScene({
  devices: devices(),
  selfId: 'A',
  selfLabel: '★ 本机',
  labelFor: (device) => device.deviceId,
});

describe('星图设备网络：节点与基础边', () => {
  test('6 台设备 → 6 个节点 + 15 条两两基础边（含本机与离线设备）', () => {
    const { nodes, edges } = scene();
    expect(nodes.map((node) => node.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(nodes[0].self).toBe(true);
    expect(nodes.find((node) => node.id === 'E').online).toBe(false);
    expect(edges).toHaveLength(15);
    expect(new Set(edges.map((edge) => `${edge.from}-${edge.to}`)).size).toBe(15);
  });

  test('online + 共同订阅 = 实线；离线/被移除/无共同订阅 = 虚线；计数稳定', () => {
    const { edges } = scene();
    expect(summarizeSceneEdges(edges)).toEqual({
      baseEdgeCount: 15,
      solidEdgeCount: 5,
      dashedEdgeCount: 10,
    });
    const byPair = new Map(edges.map((edge) => [`${edge.from}-${edge.to}`, edge]));
    // A/B/C/D 均在线：共同订阅才实线。
    expect(byPair.get('A-B')).toMatchObject({
      shared: true, online: true, solid: true, dashed: false, namespaces: ['tasks', 'notes'],
    });
    expect(byPair.get('A-C')).toMatchObject({ shared: true, online: true, solid: true });
    expect(byPair.get('A-D')).toMatchObject({ shared: true, online: true, solid: true });
    expect(byPair.get('B-D')).toMatchObject({ shared: true, online: true, solid: true });
    // 有共同订阅但一端不可用 → 虚线。
    expect(byPair.get('A-E')).toMatchObject({ shared: true, online: false, solid: false, dashed: true });
    expect(byPair.get('C-E')).toMatchObject({ shared: true, online: false, solid: false, dashed: true });
    // 无共同订阅 → 虚线。
    expect(byPair.get('C-D')).toMatchObject({ shared: false, online: true, solid: false, dashed: true });
    expect(byPair.get('E-F')).toMatchObject({ shared: false, online: false, solid: false, dashed: true });
  });

  test('任一端 offline / blocked → 相关基础边全部 dashed（即使有共同订阅）', () => {
    const { edges } = scene();
    const offlineEdges = edges.filter((edge) => edge.from === 'E' || edge.to === 'E'
      || edge.from === 'F' || edge.to === 'F');
    expect(offlineEdges).toHaveLength(9); // 5 + 5 - E-F 重复
    expect(offlineEdges.every((edge) => edge.solid === false && edge.dashed === true)).toBe(true);
    // 离线设备即使有共同订阅域，也不会被渲染成实线。
    expect(edges.filter((edge) => edge.from === 'E' || edge.to === 'E')
      .some((edge) => edge.shared === true)).toBe(true);
  });

  test('solid / dashed 与稳定脉冲节奏：周期 6–14s、持续 0.6–0.9s、各边错开', () => {
    const { edges } = scene();
    const solidEdges = edges.filter((edge) => edge.solid === true);
    const timings = solidEdges.map((edge) => baseEdgePulseTiming(edge));
    for (const timing of timings) {
      expect(timing.period).toBeGreaterThanOrEqual(6);
      expect(timing.period).toBeLessThanOrEqual(14);
      expect(timing.duration).toBeGreaterThanOrEqual(0.6);
      expect(timing.duration).toBeLessThanOrEqual(0.9);
      expect(timing.offset).toBeGreaterThanOrEqual(0);
      expect(timing.offset).toBeLessThan(timing.period);
    }
    // 稳定：同一条边任何时候算出的节奏都一样。
    expect(baseEdgePulseTiming(solidEdges[0])).toEqual(timings[0]);
    // 不是所有边同一节奏/同相位（避免整张图一起闪）。
    expect(new Set(timings.map((timing) => timing.period)).size).toBeGreaterThan(1);
    expect(new Set(timings.map((timing) => timing.offset)).size).toBeGreaterThan(1);

    // 脉冲计算不改变边的 solid/dashed 语义。
    const before = JSON.stringify(edges);
    const edge = solidEdges[0];
    const activeAt = baseEdgePulseTiming(edge);
    const t = (((activeAt.duration / 2 - activeAt.offset) % activeAt.period) + activeAt.period) % activeAt.period;
    expect(baseEdgePulse(edge, t).active).toBe(true);
    expect(baseEdgePulse(edge, t + activeAt.duration).active).toBe(false);
    expect(JSON.stringify(edges)).toBe(before);
  });

  test('基础边无方向（每对只出现一次），且不依赖 sharesWithMe', () => {
    const { edges } = scene();
    const reversed = edges.filter((edge) => edges.some(
      (other) => other.from === edge.to && other.to === edge.from,
    ));
    expect(reversed).toHaveLength(0);
    expect(edges.every((edge) => edge.kind === 'base')).toBe(true);
    expect(sharedNamespaces({ subscriptions: ['a'] }, { subscriptions: ['a', 'b'] })).toEqual(['a']);
  });

  test('设备列表缺本机时仍补出本机节点；重复设备只保留一个', () => {
    const nodes = buildNetworkNodes({
      devices: [
        { deviceId: 'B', online: true, subscriptions: [] },
        { deviceId: 'B', online: false, subscriptions: ['tasks'] },
      ],
      selfId: 'A',
      selfLabel: '★',
    });
    expect(nodes.map((node) => node.id)).toEqual(['A', 'B']);
    expect(nodes[1].subscriptions).toEqual(['tasks']);
  });
});

describe('悬停航道：任务域可达判定', () => {
  test('任务域缺省 tasks；settings.fleet.namespace 优先', () => {
    expect(resolveTaskNamespace(null)).toBe(DEFAULT_TASK_NAMESPACE);
    expect(resolveTaskNamespace({ fleet: { namespace: '  work  ' } })).toBe('work');
  });

  test('可达 = 双方在线 + 双方都订阅任务域', () => {
    const { nodes } = scene();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    expect(taskDomainState(byId.get('A'), 'tasks').reachable).toBe(true);
    expect(taskDomainState(byId.get('D'), 'tasks').reachable).toBe(false); // 在线但未订阅
    expect(taskDomainState(byId.get('E'), 'tasks').reachable).toBe(false); // 订阅但离线
  });

  test('hover A：B/C 可达（蓝 H→T + 金 T→H），D/E/F 各一条灰线', () => {
    const { nodes } = scene();
    const routes = buildHoverRoutes({ nodes, hoveredId: 'A', taskNamespace: 'tasks' });
    expect(routes).toHaveLength(7);
    expect(summarizeHoverRoutes(routes)).toEqual({
      laneCount: 7,
      reachableTargets: 2,
      blockedTargets: 3,
    });
    const blue = routes.filter((route) => route.direction === 'out');
    const gold = routes.filter((route) => route.direction === 'in');
    expect(blue.map((route) => route.to).sort()).toEqual(['B', 'C']);
    expect(gold.map((route) => route.from).sort()).toEqual(['B', 'C']);
    expect(routes.filter((route) => route.direction === 'blocked').map((route) => route.to).sort())
      .toEqual(['D', 'E', 'F']);
    expect(routes.filter((route) => !route.reachable).every((route) => route.direction === 'blocked')).toBe(true);
  });

  test('hover 离线设备 E：所有目标都不可达（一条灰线/目标）', () => {
    const { nodes } = scene();
    const routes = buildHoverRoutes({ nodes, hoveredId: 'E', taskNamespace: 'tasks' });
    expect(routes).toHaveLength(5);
    expect(routes.every((route) => route.reachable === false && route.direction === 'blocked')).toBe(true);
    expect(summarizeHoverRoutes(routes)).toEqual({ laneCount: 5, reachableTargets: 0, blockedTargets: 5 });
  });

  test('hover 在线但未订阅任务域的 D：所有目标都不可达', () => {
    const { nodes } = scene();
    const routes = buildHoverRoutes({ nodes, hoveredId: 'D', taskNamespace: 'tasks' });
    expect(routes.every((route) => route.reachable === false)).toBe(true);
    expect(routes.every((route) => route.reason === 'namespace')).toBe(true);
  });

  test('hover 离开（hoveredId=null）不产生任何航道', () => {
    const { nodes } = scene();
    expect(buildHoverRoutes({ nodes, hoveredId: null })).toEqual([]);
    expect(buildHoverRoutes({ nodes, hoveredId: 'missing' })).toEqual([]);
  });

  test('基础边与 hover 航道独立：hover 不改变 scene.edges', () => {
    const { edges } = scene();
    const before = JSON.stringify(edges);
    buildHoverRoutes({ nodes: scene().nodes, hoveredId: 'A' });
    expect(JSON.stringify(edges)).toBe(before);
    expect(buildBaseEdges(scene().nodes)).toHaveLength(15);
  });
});

describe('fleet 事件契约', () => {
  const nodeIds = new Set(['A', 'B', 'C']);

  test('本机发出 / 本机接收 / peer 转运方向', () => {
    expect(normalizeFleetEvent({
      at: 1, fromDeviceId: 'A', toDeviceId: 'B', taskId: 't1', eventType: 'created', namespace: 'tasks',
    }, { nodeIds, selfId: 'A' })).toMatchObject({ from: 'A', to: 'B', direction: 'out', namespace: 'tasks' });
    expect(normalizeFleetEvent({
      fromDeviceId: 'B', toDeviceId: 'A', eventType: 'created', namespace: 'tasks',
    }, { nodeIds, selfId: 'A' })).toMatchObject({ direction: 'in' });
    expect(normalizeFleetEvent({
      fromDeviceId: 'B', toDeviceId: 'C', eventType: 'created', namespace: 'tasks',
    }, { nodeIds, selfId: 'A' })).toMatchObject({ direction: 'transit' });
  });

  test('from/to 缺失、相同或不在场景 → null（不画假线）', () => {
    expect(normalizeFleetEvent({ fromDeviceId: 'A', toDeviceId: 'A', eventType: 'created' }, { nodeIds })).toBeNull();
    expect(normalizeFleetEvent({ fromDeviceId: 'A', toDeviceId: 'Z', eventType: 'created' }, { nodeIds })).toBeNull();
    expect(normalizeFleetEvent({ fromDeviceId: 'A', eventType: 'created' }, { nodeIds })).toBeNull();
    expect(normalizeFleetEvent(null)).toBeNull();
  });

  test('非 created 事件与缺省 namespace', () => {
    expect(normalizeFleetEvent({
      fromDeviceId: 'A', toDeviceId: 'B', eventType: 'completed',
    }, { nodeIds })).toBeNull();
    const parsed = normalizeFleetEvent({ fromDeviceId: 'A', toDeviceId: 'B', eventType: 'created' }, { nodeIds });
    expect(parsed.namespace).toBe(DEFAULT_TASK_NAMESPACE);
  });
});

describe('画布只读测试信号', () => {
  let stage;
  let canvas;

  beforeEach(() => {
    globalThis.window = {
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    canvas = {
      width: 0,
      height: 0,
      style: {},
      dataset: {},
      getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      parentElement: { querySelector: () => null },
      getContext: () => new Proxy({ canvas: null }, {
        get: (target, prop) => (prop in target ? target[prop] : () => undefined),
        set: (target, prop, value) => { target[prop] = value; return true; },
      }),
    };
    stage = new StarStage(canvas);
  });

  afterEach(() => {
    stage.destroy();
    delete globalThis.window;
  });

  test('setScene / setRoutes 暴露 base/solid/dashed/route/hovered 计数', () => {
    stage.setScene({
      nodes: [],
      edges: [
        { from: 'A', to: 'B', shared: true, online: true, solid: true },
        // 有共同订阅但一端离线：必须计入虚线。
        { from: 'A', to: 'C', shared: true, online: false, solid: false },
        { from: 'B', to: 'C', shared: false, online: true, solid: false },
      ],
    });
    expect(canvas.dataset.baseEdgeCount).toBe('3');
    expect(canvas.dataset.solidEdgeCount).toBe('1');
    expect(canvas.dataset.dashedEdgeCount).toBe('2');
    expect(canvas.dataset.routeCount).toBe('0');

    stage.setRoutes([
      { from: 'A', to: 'B', direction: 'out', reachable: true },
      { from: 'B', to: 'A', direction: 'in', reachable: true },
    ]);
    expect(canvas.dataset.routeCount).toBe('2');
    expect(canvas.dataset.hoverRouteCount).toBe('2');

    stage.setRoutes([]);
    expect(canvas.dataset.routeCount).toBe('0');
  });
});

describe('航道几何：曲线不变式 + 基础边直线/降亮', () => {
  let stage;
  let calls;

  const fakeCanvas = (ctx) => ({
    width: 0,
    height: 0,
    style: {},
    dataset: {},
    getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    parentElement: { querySelector: () => null },
    getContext: () => ctx,
  });

  const recordingContext = () => {
    const log = [];
    const gradient = () => ({ addColorStop: () => undefined });
    const proxy = new Proxy({}, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
          return (...args) => { log.push({ method: prop, args }); return gradient(); };
        }
        return (...args) => { log.push({ method: prop, args }); };
      },
      set(target, prop, value) {
        log.push({ method: `set:${prop}`, args: [value] });
        target[prop] = value;
        return true;
      },
    });
    return { proxy, log };
  };

  const place = (entries) => {
    stage.screen = new Map(Object.entries(entries).map(([id, [x, y, depth, r]]) => [
      id,
      { x, y, depth: depth ?? 0.6, r: r ?? 8 },
    ]));
  };

  const methods = (name) => calls.filter((call) => call.method === name);

  beforeEach(() => {
    globalThis.window = {
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const recorder = recordingContext();
    calls = recorder.log;
    stage = new StarStage(fakeCanvas(recorder.proxy));
    stage.ctx = recorder.proxy;
  });

  afterEach(() => {
    stage.destroy();
    delete globalThis.window;
  });

  test('基础边仍是直线：_lineGeometry 无曲线控制点，_drawBaseEdges 只用 lineTo', () => {
    place({ A: [100, 300, 0.5, 8], B: [700, 300, 0.8, 10] });
    stage.scene = {
      nodes: [{ id: 'A' }, { id: 'B' }],
      edges: [{ from: 'A', to: 'B', shared: true, online: true, solid: true }],
    };

    const g = stage._lineGeometry('A', 'B');
    expect(g.cx).toBeUndefined();
    expect(g.cy).toBeUndefined();

    calls.length = 0;
    stage._drawBaseEdges(0);
    expect(methods('lineTo').length).toBeGreaterThan(0);
    expect(methods('quadraticCurveTo')).toHaveLength(0);
  });

  test('solid 为非灰冷青实线；offline / 无共同订阅为灰虚线（同色系不同亮度）', () => {
    place({ A: [100, 300, 0.6, 8], B: [500, 300, 0.6, 8], C: [700, 300, 0.6, 8] });
    stage.scene = {
      nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      edges: [
        { from: 'A', to: 'B', shared: true, online: true, solid: true },
        { from: 'A', to: 'C', shared: true, online: false, solid: false },
        { from: 'B', to: 'C', shared: false, online: true, solid: false },
      ],
    };
    stage.reducedMotion = true;
    calls.length = 0;
    stage._drawBaseEdges(3.2);

    const strokes = calls.filter((call) => call.method === 'set:strokeStyle').map((call) => call.args[0]);
    // 冷青白：rgb(159,230,242)；灰虚线两档：rgb(124,133,152) / rgb(95,103,121)。
    expect(strokes.some((color) => color.startsWith('rgba(159,230,242'))).toBe(true);
    expect(strokes.some((color) => color.startsWith('rgba(124,133,152'))).toBe(true);
    expect(strokes.some((color) => color.startsWith('rgba(95,103,121'))).toBe(true);
    // 虚线只用于非 solid；solid 线段不带 dash。
    const dashSets = calls.filter((call) => call.method === 'setLineDash').map((call) => call.args[0]);
    expect(dashSets.some((pattern) => Array.isArray(pattern) && pattern[0] === 3 && pattern[1] === 7)).toBe(true);
    expect(calls.filter((call) => call.method === 'set:lineDashOffset')
      .every((call) => call.args[0] === 0)).toBe(true);
  });

  test('脉冲只对 solid 边且 reduced-motion 关闭；不改变 solid/dashed 状态', () => {
    place({ A: [100, 300, 0.6, 8], B: [500, 300, 0.6, 8], C: [700, 300, 0.6, 8] });
    const edges = [
      { from: 'A', to: 'B', shared: true, online: true, solid: true },
      { from: 'B', to: 'C', shared: true, online: false, solid: false },
    ];
    stage.scene = { nodes: [{ id: 'A' }, { id: 'B' }, { id: 'C' }], edges };

    const timing = baseEdgePulseTiming(edges[0]);
    const activeAt = ((((timing.duration / 2) - timing.offset) % timing.period) + timing.period) % timing.period;
    const before = JSON.stringify(edges);

    stage.reducedMotion = true;
    calls.length = 0;
    stage._drawBaseEdges(activeAt);
    expect(methods('createRadialGradient')).toHaveLength(0);
    expect(methods('arc')).toHaveLength(0);

    stage.reducedMotion = false;
    calls.length = 0;
    stage._drawBaseEdges(activeAt);
    // 只有 solid 边产生一个脉冲光点（dashed 边不脉冲）。
    expect(methods('createRadialGradient')).toHaveLength(1);
    expect(methods('arc')).toHaveLength(1);
    expect(JSON.stringify(edges)).toBe(before);
    expect(summarizeSceneEdges(edges)).toEqual({ baseEdgeCount: 2, solidEdgeCount: 1, dashedEdgeCount: 1 });
  });

  test('航道几何是曲线：控制点/中点偏离弦，且深度差带来纵向偏置', () => {
    place({ A: [100, 300, 0.4, 8], B: [700, 300, 0.8, 8] });
    const g = stage._laneGeometry('A', 'B');
    const chordMid = { x: (g.sx + g.ex) / 2, y: (g.sy + g.ey) / 2 };
    const controlOffset = Math.hypot(g.cx - chordMid.x, g.cy - chordMid.y);
    const mid = stage._lanePoint(g, 0.5);
    const midOffset = Math.hypot(mid.x - chordMid.x, mid.y - chordMid.y);

    expect(controlOffset).toBeGreaterThan(8);
    expect(midOffset).toBeGreaterThan(4);
    // 深度差 0.4 → 控制点纵向偏置 10.4，公式保持不变式。
    expect(g.depthBias).toBeCloseTo((0.8 - 0.4) * 26, 6);
    const flat = stage._laneGeometry('A', 'B', { bowSign: 1 });
    place({ A: [100, 300, 0.6, 8], B: [700, 300, 0.6, 8] });
    const noDepth = stage._laneGeometry('A', 'B');
    expect(noDepth.depthBias).toBe(0);
    expect(flat.bow).toBeGreaterThan(0);
    expect(stage._laneTangent(noDepth, 0.5).x).not.toBe(0);
  });

  test('旧版几何：pad=24、双向 offset=7、bow=min(48, dist*0.15)', () => {
    place({ A: [100, 300, 0.6, 8], B: [700, 300, 0.6, 8] });
    const g = stage._laneGeometry('A', 'B');
    // 端点沿 A→B 各留白 24，不压在星体上。
    expect(g.sx).toBeCloseTo(124, 6);
    expect(g.ex).toBeCloseTo(676, 6);
    // 600px 距离 → bow = min(48, 90) = 48。
    expect(g.bow).toBeCloseTo(48, 6);

    const out = stage._laneGeometry('A', 'B', { offset: 7 });
    const inbound = stage._laneGeometry('B', 'A', { offset: 7 });
    // 双向航道平行偏移 7，且方向相反自然落在弦两侧。
    expect(out.sy).toBeCloseTo(307, 6);
    expect(out.ey).toBeCloseTo(307, 6);
    expect(inbound.sy).toBeCloseTo(293, 6);
    expect(inbound.ey).toBeCloseTo(293, 6);
    const midOut = stage._lanePoint(out, 0.5);
    const midIn = stage._lanePoint(inbound, 0.5);
    expect((midOut.y - 300) * (midIn.y - 300)).toBeLessThan(0);
    expect(midOut.y).not.toBeCloseTo(midIn.y, 1);

    // 近距离航道：bow 按距离线性缩小（200px → 30）。
    place({ A: [100, 300, 0.6, 8], B: [300, 300, 0.6, 8] });
    expect(stage._laneGeometry('A', 'B').bow).toBeCloseTo(30, 6);
  });

  test('hover 航道用旧版视觉：外发光 + 沿线渐变 + 流动点状虚线 + 航向标', () => {
    place({ A: [100, 300, 0.6, 8], B: [700, 300, 0.6, 8] });
    stage.routes = [
      { from: 'A', to: 'B', direction: 'out', reachable: true },
      { from: 'B', to: 'A', direction: 'in', reachable: true },
      { from: 'A', to: 'B', direction: 'blocked', reachable: false },
    ];
    calls.length = 0;
    stage._drawRoutes(4.2);
    expect(methods('quadraticCurveTo').length).toBeGreaterThanOrEqual(3);
    // 沿线渐变。
    expect(methods('createLinearGradient').length).toBeGreaterThanOrEqual(3);
    // 外发光底：约 3.4x 宽度。
    expect(calls.some((call) => call.method === 'set:lineWidth' && call.args[0] >= 3)).toBe(true);
    // 可发出/接收航道用旧版流动点状虚线 [1.5,6]，且随时间移动。
    expect(calls.some((call) => call.method === 'setLineDash'
      && call.args[0]?.[0] === 1.5 && call.args[0]?.[1] === 6)).toBe(true);
    expect(calls.some((call) => call.method === 'set:lineDashOffset'
      && call.args[0] < 0)).toBe(true);
    // 灰色不可达仍是虚线降级（不是纯细实线）。
    expect(calls.some((call) => call.method === 'setLineDash'
      && call.args[0]?.[0] === 5 && call.args[0]?.[1] === 6)).toBe(true);
    // 航向标：箭标三角用 lineTo 绘制在曲线之外。
    expect(methods('lineTo').length).toBeGreaterThan(0);
  });

  test('待发事件时沿航道流动数据灯', () => {
    place({ A: [100, 300, 0.6, 8], B: [700, 300, 0.6, 8] });
    stage.routes = [
      { from: 'A', to: 'B', direction: 'out', reachable: true, pending: 4 },
    ];
    calls.length = 0;
    stage._drawRoutes(4.2);
    expect(methods('arc').length).toBeGreaterThan(0);

    stage.routes = [{ from: 'A', to: 'B', direction: 'out', reachable: true }];
    calls.length = 0;
    stage._drawRoutes(4.2);
    expect(methods('arc')).toHaveLength(0);
  });

  test('fleet 事件航道沿用旧航道视觉，且几何每帧从星位取（不烘焙）', () => {
    place({ A: [100, 300, 0.6, 8], B: [700, 300, 0.6, 8] });
    stage.scene = { nodes: [{ id: 'A' }, { id: 'B' }], edges: [] };
    stage.launchFleet('A', 'B', { event: true, ships: 2 });
    const fleet = stage.fleets[0];
    expect(fleet.geometry).toBeUndefined();
    expect(fleet.fromId).toBe('A');
    expect(fleet.toId).toBe('B');

    fleet.ships = [];
    calls.length = 0;
    stage._drawFleets(4.2);
    expect(methods('quadraticCurveTo').length).toBeGreaterThan(0);
    expect(methods('createLinearGradient').length).toBeGreaterThan(0);
    expect(calls.some((call) => call.method === 'setLineDash'
      && call.args[0]?.[0] === 1.5 && call.args[0]?.[1] === 6)).toBe(true);
    // 航向标也保留在事件航道上。
    expect(methods('lineTo').length).toBeGreaterThan(0);

    const before = stage._laneGeometry(fleet.fromId, fleet.toId, { bowSign: -1 });
    place({ A: [140, 340, 0.6, 8], B: [700, 300, 0.6, 8] });
    const after = stage._laneGeometry(fleet.fromId, fleet.toId, { bowSign: -1 });
    expect(after.sx).not.toBeCloseTo(before.sx, 6);
    expect(after.sy).not.toBeCloseTo(before.sy, 6);
  });

  test('hover 时基础边目标亮度降到 20%，离开恢复；reduced-motion 直接切换', () => {
    expect(BASE_EDGE_DIM_ON_HOVER).toBeGreaterThanOrEqual(0.15);
    expect(BASE_EDGE_DIM_ON_HOVER).toBeLessThanOrEqual(0.25);

    stage.routes = [];
    expect(stage.baseEdgeDimTarget()).toBe(1);
    stage.routes = [{ from: 'A', to: 'B', direction: 'out', reachable: true }];
    expect(stage.baseEdgeDimTarget()).toBe(BASE_EDGE_DIM_ON_HOVER);

    stage.reducedMotion = true;
    stage._updateBaseEdgeDim(10);
    expect(stage.baseEdgeDim).toBe(BASE_EDGE_DIM_ON_HOVER);
    stage.routes = [];
    stage._updateBaseEdgeDim(11);
    expect(stage.baseEdgeDim).toBe(1);

    stage.reducedMotion = false;
    stage.baseEdgeDim = 1;
    stage.lastDimAt = 0;
    stage.routes = [{ from: 'A', to: 'B', direction: 'out', reachable: true }];
    stage._updateBaseEdgeDim(10);
    expect(stage.baseEdgeDim).toBeLessThan(1);
    expect(stage.baseEdgeDim).toBeGreaterThan(BASE_EDGE_DIM_ON_HOVER);
    for (let t = 10.02; t <= 11; t += 0.02) stage._updateBaseEdgeDim(t);
    expect(stage.baseEdgeDim).toBeCloseTo(BASE_EDGE_DIM_ON_HOVER, 2);
  });
});
