// 星图设备网络 / 任务域航道的纯函数契约：
// - 所有设备两两之间都有基础边（6 节点 = 15 条），共同订阅实线、否则虚线
// - 悬停航道只在 hover 时存在；任务域可达 = 双方在线 + 双方都订阅任务域
// - fleet 事件只接受 from/to 都在场景内的真实方向

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  DEFAULT_TASK_NAMESPACE,
  StarStage,
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

  test('共同订阅 = 实线，无共同订阅 = 虚线；计数稳定', () => {
    const { edges } = scene();
    expect(summarizeSceneEdges(edges)).toEqual({
      baseEdgeCount: 15,
      solidEdgeCount: 8,
      dashedEdgeCount: 7,
    });
    const byPair = new Map(edges.map((edge) => [`${edge.from}-${edge.to}`, edge]));
    expect(byPair.get('A-B').shared).toBe(true);
    expect(byPair.get('A-B').namespaces).toEqual(['tasks', 'notes']);
    expect(byPair.get('C-D').shared).toBe(false);
    expect(byPair.get('B-D').shared).toBe(true);
    expect(byPair.get('E-F').shared).toBe(false);
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
        { from: 'A', to: 'B', shared: true },
        { from: 'A', to: 'C', shared: false },
        { from: 'B', to: 'C', shared: false },
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
