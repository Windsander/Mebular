// P3 route resolver：硬过滤、policy、软排序、确定性 tie-break、why/NO_TARGET、状态视图。
import { describe, it, expect } from '@jest/globals';
import {
  AGENT_TASK_TOOL_NAMES,
  buildAgentStatusViews,
  daemonRoutingProvider,
  loadRouteContext,
  observeRouteOutcomes,
  rendezvousScore,
  resolveRoute,
  type AgentCapabilityCard,
  type AgentStatusView,
  type PlanRoutingProvider,
  type RouteInput,
  type TaskEventStore,
  type TaskState,
} from '../../packages/fleet/src/index.js';
import { mkEvent } from './helpers.js';

const A = { device: 'device-A', agent: 'planner' };
const B = { device: 'device-B', agent: 'worker' };
const C = { device: 'device-C', agent: 'worker' };

function card(device: string, agent: string, capabilities: string[], overrides: Partial<AgentCapabilityCard> = {}): AgentCapabilityCard {
  return {
    v: 1,
    kind: 'agent_capability_card',
    device,
    agent,
    version: 1,
    capabilities: ['fleet.task', ...capabilities],
    tools: [...AGENT_TASK_TOOL_NAMES],
    limits: { maxConcurrency: 2 },
    permissions: { taskNamespaces: ['tasks'] },
    runtime: { os: 'test', arch: 'test', runtime: 'node', runtimeVersion: '20' },
    provenance: { source: 'test', configHash: 'cfg', registryHash: 'reg', publishedAt: 1 },
    signature: { alg: 'Ed25519', keyId: device, sig: 'sig' },
    ...overrides,
  };
}

function view(device: string, agent: string, overrides: Partial<AgentStatusView> = {}): AgentStatusView {
  return {
    v: 1,
    kind: 'agent_status_view',
    device,
    agent,
    online: true,
    inflight: 0,
    capacity: 2,
    asOf: 1,
    ttlMs: 30_000,
    computedBy: 'device-A',
    ...overrides,
  };
}

function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    planId: 'plan-routing-001',
    version: 1,
    stepId: 'work',
    route: { require: [], prefer: [], strategy: 'deterministic' },
    policy: {},
    cards: [card(B.device, B.agent, ['api']), card(C.device, C.agent, ['ui'])],
    authorization: { devices: [B.device, C.device] },
    status: [view(B.device, B.agent), view(C.device, C.agent)],
    namespace: 'tasks',
    ...overrides,
  };
}

describe('P3 route resolver', () => {
  it('按能力路由三机；require 不满足 → NO_TARGET/MISSING_CAPABILITY', () => {
    const api = resolveRoute(input({ route: { require: ['api'], prefer: [], strategy: 'deterministic' } }));
    expect(api).toMatchObject({
      decision: 'assigned',
      chosen: B,
      why: {
        code: 'ASSIGNED',
        hardFilters: ['authorized', 'policy', 'capability', 'payload', 'online', 'capacity'],
        tieBreak: 'rendezvous-sha256',
        roleCard: 'disabled',
      },
      rejected: [{ device: C.device, agent: C.agent, code: 'MISSING_CAPABILITY', detail: 'api' }],
    });
    expect(api.why.ranking[0]).toMatchObject({ device: B.device, agent: B.agent, reasons: expect.arrayContaining(['online', 'inflight=0/2']) });

    const missing = resolveRoute(input({ route: { require: ['gpu'], prefer: [], strategy: 'deterministic' } }));
    expect(missing).toMatchObject({ decision: 'NO_TARGET', chosen: null, why: { code: 'NO_TARGET' } });
    expect(missing.rejected).toEqual([
      { device: B.device, agent: B.agent, code: 'MISSING_CAPABILITY', detail: 'gpu' },
      { device: C.device, agent: C.agent, code: 'MISSING_CAPABILITY', detail: 'gpu' },
    ]);
    expect(missing.blockedBy).toEqual(['MISSING_CAPABILITY']);
  });

  it('显式 to 只考虑该目标；不满足硬过滤时 blocked，绝不改派', () => {
    const denied = resolveRoute(input({
      to: C,
      route: { require: ['api'], prefer: [], strategy: 'deterministic' },
    }));
    expect(denied.decision).toBe('NO_TARGET');
    expect(denied.chosen).toBeNull();
    expect(denied.rejected).toEqual([{ device: C.device, agent: C.agent, code: 'MISSING_CAPABILITY', detail: 'api' }]);
    expect(denied.why.ranking).toEqual([]);
    expect(denied.blockedBy).toEqual(['MISSING_CAPABILITY']);
  });

  it('L1 未授权 / policy allowed* 拒绝；显式 policy 越权返回 POLICY_DENIED', () => {
    const unauthorized = resolveRoute(input({ to: C, authorization: { devices: [B.device] } }));
    expect(unauthorized).toMatchObject({ decision: 'NO_TARGET', chosen: null });
    expect(unauthorized.rejected[0]).toMatchObject({ code: 'UNAUTHORIZED', detail: 'device' });

    const policyDenied = resolveRoute(input({
      to: C,
      policy: { allowedDevices: [B.device, C.device], allowedAgents: ['worker', 'reviewer'] },
      authorization: { devices: [B.device, C.device], agents: { [C.device]: ['reviewer'] } },
    }));
    expect(policyDenied.rejected[0]).toMatchObject({ device: C.device, code: 'UNAUTHORIZED', detail: 'agent' });

    const explicit = resolveRoute(input({
      to: C,
      policy: { allowedDevices: [B.device] },
    }));
    expect(explicit).toMatchObject({
      decision: 'POLICY_DENIED',
      chosen: null,
      why: { code: 'POLICY_DENIED' },
      blockedBy: ['POLICY_DENIED'],
    });
    expect(explicit.rejected).toEqual([{ device: C.device, agent: C.agent, code: 'POLICY_DENIED', detail: 'device' }]);
  });

  it('policy requireCapabilities 只能收紧：route.require 不能放宽', () => {
    const cards = [
      card(B.device, B.agent, ['api']),
      card(C.device, C.agent, ['ui', 'secure']),
    ];
    const decision = resolveRoute(input({
      cards,
      policy: { requireCapabilities: ['secure'] },
      route: { require: ['ui'], prefer: [], strategy: 'deterministic' },
    }));
    expect(decision.decision).toBe('assigned');
    expect(decision.chosen).toEqual(C);
    expect(decision.rejected).toEqual([{
      device: B.device,
      agent: B.agent,
      code: 'POLICY_DENIED',
      detail: 'requireCapabilities=secure',
    }]);
  });

  it('显式目标离线/满载 → blocked，不改派；自动路由过滤离线/满载', () => {
    const offline = resolveRoute(input({
      to: B,
      status: [view(B.device, B.agent, { online: false }), view(C.device, C.agent)],
    }));
    expect(offline).toMatchObject({ decision: 'NO_TARGET', chosen: null, blockedBy: ['EXPLICIT_OFFLINE'] });
    expect(offline.rejected[0]).toMatchObject({ code: 'EXPLICIT_OFFLINE' });

    const atCapacity = resolveRoute(input({
      to: B,
      status: [view(B.device, B.agent, { inflight: 2, capacity: 2 }), view(C.device, C.agent)],
    }));
    expect(atCapacity).toMatchObject({ decision: 'NO_TARGET', chosen: null, blockedBy: ['AT_CAPACITY'] });

    const auto = resolveRoute(input({
      status: [
        view(B.device, B.agent, { online: false }),
        view(C.device, C.agent, { inflight: 2, capacity: 2 }),
      ],
    }));
    expect(auto).toMatchObject({ decision: 'NO_TARGET', chosen: null });
    expect(auto.rejected).toEqual([
      { device: B.device, agent: B.agent, code: 'OFFLINE' },
      { device: C.device, agent: C.agent, code: 'AT_CAPACITY', detail: 'capacity=2' },
    ]);
    expect(auto.blockedBy).toEqual(['NO_TARGET']);
  });

  it('软排序：inflight → 成功率 → 时延 → prefer；全同走 rendezvous', () => {
    const lowLoad = resolveRoute(input({
      status: [
        view(B.device, B.agent, { inflight: 2, capacity: 2 }),
        view(C.device, C.agent, { inflight: 0, capacity: 2 }),
      ],
    }));
    expect(lowLoad.chosen).toEqual(C);

    const success = resolveRoute(input({
      status: [
        view(B.device, B.agent, { recentSuccessRate: 0.2, samples: { recent: 10, window: 20 } }),
        view(C.device, C.agent, { recentSuccessRate: 0.9, samples: { recent: 10, window: 20 } }),
      ],
    }));
    expect(success.chosen).toEqual(C);

    const latency = resolveRoute(input({
      status: [
        view(B.device, B.agent, { lastLatencyMs: 900 }),
        view(C.device, C.agent, { lastLatencyMs: 50 }),
      ],
    }));
    expect(latency.chosen).toEqual(C);

    const prefer = resolveRoute(input({
      cards: [card(B.device, B.agent, ['api']), card(C.device, C.agent, ['ui'])],
      route: { require: [], prefer: ['ui'], strategy: 'deterministic' },
    }));
    expect(prefer.chosen).toEqual(C);
    expect(prefer.why.ranking[0]?.reasons).toContain('prefer=ui');
  });

  it('确定性 tie-break：卡片/状态输入顺序变化不改变 chosen；同输入同结果', () => {
    const base = input({
      cards: [card(B.device, B.agent, ['api']), card(C.device, C.agent, ['api'])],
      status: [view(B.device, B.agent), view(C.device, C.agent)],
    });
    const expected = [B, C]
      .map((target) => ({ target, score: rendezvousScore(`${base.planId}#${base.version}#${base.stepId}`, target.device, target.agent) }))
      .sort((a, b) => (a.score < b.score ? 1 : a.score > b.score ? -1 : 0))[0]!.target;
    const first = resolveRoute(base);
    expect(first.chosen).toEqual(expected);
    for (const reversed of [true, false, true, false]) {
      const decision = resolveRoute(reversed
        ? { ...base, cards: [...base.cards].reverse(), status: [...base.status!].reverse() }
        : base);
      expect(decision.chosen).toEqual(expected);
      expect(decision.why.ranking.map((entry) => `${entry.device}/${entry.agent}`))
        .toEqual(first.why.ranking.map((entry) => `${entry.device}/${entry.agent}`));
    }
    const otherStep = resolveRoute({ ...base, stepId: 'another-step' });
    expect(otherStep.decision).toBe('assigned');
  });

  it('payload 可达性：任务域/permissions 不含 → PAYLOAD_UNREACHABLE', () => {
    const unreachable = resolveRoute(input({
      cards: [card(B.device, B.agent, ['api'], { permissions: { taskNamespaces: [] } })],
      authorization: { devices: [B.device] },
      status: [view(B.device, B.agent)],
    }));
    expect(unreachable).toMatchObject({ decision: 'NO_TARGET', blockedBy: ['PAYLOAD_UNREACHABLE'] });
    expect(unreachable.rejected[0]).toMatchObject({ code: 'PAYLOAD_UNREACHABLE', detail: 'namespace=tasks' });

    const explicit = resolveRoute(input({
      to: C,
      cards: [card(C.device, C.agent, ['ui'], { permissions: { taskNamespaces: ['other'] } })],
    }));
    expect(explicit).toMatchObject({ decision: 'NO_TARGET', chosen: null, blockedBy: ['PAYLOAD_UNREACHABLE'] });

    const payloadRef = resolveRoute(input({
      cards: [card(B.device, B.agent, ['api'], { permissions: { taskNamespaces: ['tasks'] } })],
      authorization: { devices: [B.device] },
      status: [view(B.device, B.agent)],
      payloadRef: 'blob-1',
      payloadNamespace: 'private-blobs',
    }));
    expect(payloadRef).toMatchObject({ decision: 'NO_TARGET', blockedBy: ['PAYLOAD_UNREACHABLE'] });
    expect(payloadRef.rejected[0]).toMatchObject({ code: 'PAYLOAD_UNREACHABLE', detail: 'namespace=private-blobs' });
  });

  it('状态视图：online/inflight/容量来自输入；观察不足 3 样本保持中性', () => {
    const views = buildAgentStatusViews({
      cards: [card(B.device, B.agent, ['api'], { limits: { maxConcurrency: 3 } })],
      online: (device) => device === B.device,
      inflight: () => 2,
      observations: [{ device: B.device, agent: B.agent, success: 2, failure: 0, samples: { recent: 2, window: 20 } }],
      asOf: 123,
      computedBy: A.device,
    });
    expect(views).toEqual([{
      v: 1,
      kind: 'agent_status_view',
      device: B.device,
      agent: B.agent,
      online: true,
      inflight: 2,
      capacity: 3,
      samples: { recent: 2, window: 20 },
      asOf: 123,
      ttlMs: 30_000,
      computedBy: A.device,
    }]);
  });

  it('本机观察：成功/失败/时延按窗口聚合；样本不足不产出成功率', () => {
    const events = [
      mkEvent('created', 't1', { at: 10, to: B }),
      mkEvent('done', 't1', { at: 30, payloadRef: 'r1' }),
      mkEvent('created', 't2', { at: 20, to: B }),
      mkEvent('failed', 't2', { at: 25, reason: 'boom' }),
      mkEvent('created', 't3', { at: 30, to: B }),
      mkEvent('done', 't3', { at: 35, payloadRef: 'r3' }),
    ];
    const observations = observeRouteOutcomes(events, { window: 10 });
    expect(observations).toEqual([{
      device: B.device,
      agent: B.agent,
      success: 2,
      failure: 1,
      samples: { recent: 3, window: 10 },
      recentSuccessRate: 0.6667,
      lastLatencyMs: 5,
    }]);
  });

  it('loadRouteContext：inflight 来自任务视图非终态数，online 来自 provider', async () => {
    const state: TaskState = {
      taskId: 'task-inflight',
      from: A,
      to: B,
      intent: 'running',
      status: 'running',
      attempts: 1,
      trace: { chain: [] },
      terminal: false,
      lastEventId: 'task-inflight#running',
    };
    const provider: PlanRoutingProvider = {
      cards: async () => [card(B.device, B.agent, ['api']), card(C.device, C.agent, ['api'])],
      authorized: () => ({ devices: [B.device, C.device] }),
      online: (device) => device === C.device,
      observations: () => [],
      namespace: 'tasks',
    };
    const context = await loadRouteContext(provider, { states: [state], events: [], asOf: 5, computedBy: A.device });
    expect(context.status).toEqual([
      expect.objectContaining({ device: B.device, agent: B.agent, online: false, inflight: 1, capacity: 2 }),
      expect.objectContaining({ device: C.device, agent: C.agent, online: true, inflight: 0, capacity: 2 }),
    ]);
    // B 在 inflight 排序前就被离线硬过滤；C 是唯一在线候选。
    const decision = resolveRoute({
      ...input(),
      ...{ cards: context.cards, authorization: context.authorization, status: context.status },
    });
    expect(decision.chosen).toEqual(C);
    expect(decision.rejected).toEqual([{ device: B.device, agent: B.agent, code: 'OFFLINE' }]);
  });

  it('loadRouteContext fail-closed：卡片/授权读取失败不伪造候选', async () => {
    const failingCards: PlanRoutingProvider = {
      cards: async () => { throw new Error('cards unavailable'); },
      authorized: () => ({ devices: [B.device, C.device] }),
      online: () => true,
    };
    const context = await loadRouteContext(failingCards, { states: [], events: [], asOf: 1, computedBy: A.device });
    expect(context.cardCatalog).toBe('unavailable');
    expect(context.cards).toEqual([]);
    const noCards = resolveRoute({
      ...input(),
      ...{ cards: context.cards, authorization: context.authorization, status: context.status },
    });
    expect(noCards).toMatchObject({ decision: 'NO_TARGET', chosen: null });
    expect(noCards.rejected).toEqual([{ device: '', agent: '', code: 'NO_CANDIDATES', detail: 'no-authorized-capability-cards' }]);

    const failingAuth: PlanRoutingProvider = {
      cards: async () => [card(B.device, B.agent, ['api'])],
      authorized: () => { throw new Error('auth unavailable'); },
      online: () => true,
    };
    const authContext = await loadRouteContext(failingAuth, { states: [], events: [], asOf: 1, computedBy: A.device });
    expect(authContext.authorizationAvailable).toBe(false);
    expect(authContext.authorization.devices).toEqual([]);
    const denied = resolveRoute({
      ...input(),
      ...{ cards: authContext.cards, authorization: authContext.authorization, status: authContext.status },
    });
    expect(denied.decision).toBe('NO_TARGET');
    expect(denied.rejected[0]).toMatchObject({ code: 'NO_CANDIDATES' });
  });

  it('无授权候选 → NO_CANDIDATES；非 task_submit 卡片被拒绝', () => {
    const none = resolveRoute(input({ authorization: { devices: [] } }));
    expect(none).toMatchObject({ decision: 'NO_TARGET', chosen: null });
    expect(none.rejected).toEqual([{ device: '', agent: '', code: 'NO_CANDIDATES', detail: 'no-authorized-capability-cards' }]);

    const noTool = resolveRoute(input({
      cards: [card(B.device, B.agent, ['api'], { tools: ['task_status'] })],
      authorization: { devices: [B.device] },
      status: [view(B.device, B.agent)],
    }));
    expect(noTool.rejected[0]).toMatchObject({ code: 'MISSING_CAPABILITY', detail: 'task_submit' });
  });

  it('daemon provider：无法验证远端卡时只信任本机，远端候选 fail-closed（P6 风险）', async () => {
    const store = { all: async () => [] } as unknown as TaskEventStore;
    const provider = daemonRoutingProvider({
      backend: {
        listCards: async () => [card(A.device, A.agent, ['planner'])],
        getSubscriptions: async (device: string) => (device === B.device ? ['tasks'] : []),
      },
      config: { device: A.device, namespace: 'tasks', peers: [{ device: B.device }] },
      store,
      online: () => true,
    });
    const context = await loadRouteContext(provider, { states: [], events: [], asOf: 1, computedBy: A.device });
    expect(context.cards.map((entry) => entry.device)).toEqual([A.device]);
    const auto = resolveRoute({ ...input({ policy: { allowedDevices: [B.device, C.device], allowedAgents: ['worker'] } }), ...{ cards: context.cards, authorization: context.authorization, status: context.status } });
    expect(auto.decision).toBe('NO_TARGET');
    expect(auto.rejected).toEqual([{ device: A.device, agent: A.agent, code: 'POLICY_DENIED', detail: 'device' }]);
    const explicit = resolveRoute({ ...input({ to: B }), ...{ cards: context.cards, authorization: context.authorization, status: context.status } });
    expect(explicit).toMatchObject({ decision: 'NO_TARGET', chosen: null, blockedBy: ['MISSING_CAPABILITY'] });
    expect(explicit.rejected).toEqual([{ device: B.device, agent: B.agent, code: 'MISSING_CAPABILITY', detail: 'card' }]);
  });

  it('provider online/capacity 抛错时 loadRouteContext 捕获并 fail-closed', async () => {
    const provider: PlanRoutingProvider = {
      cards: async () => [card(B.device, B.agent, ['api'], { limits: { maxConcurrency: 3 } })],
      authorized: () => ({ devices: [B.device] }),
      online: () => { throw new Error('online unavailable'); },
      capacity: () => { throw new Error('capacity unavailable'); },
      observations: () => [],
    };
    const context = await loadRouteContext(provider, { states: [], events: [], asOf: 1, computedBy: A.device });
    expect(context.status).toEqual([expect.objectContaining({
      device: B.device,
      agent: B.agent,
      online: false,
      capacity: 3,
    })]);
    const decision = resolveRoute({ ...input(), ...{ cards: context.cards, authorization: context.authorization, status: context.status } });
    expect(decision.decision).toBe('NO_TARGET');
    expect(decision.rejected).toEqual([{ device: B.device, agent: B.agent, code: 'OFFLINE' }]);
  });

  it('daemon 授权：config.peers 不是授权；B 订阅 tasks 后才进入候选', async () => {
    const store = { all: async () => [] } as unknown as TaskEventStore;
    const subscribed = new Set<string>();
    const queryFailures = new Set<string>();
    const provider = daemonRoutingProvider({
      backend: {
        listCards: async () => [card(B.device, B.agent, ['api'])],
        getSubscriptions: async (device: string) => {
          if (queryFailures.has(device)) throw new Error('policy unavailable');
          return subscribed.has(device) ? ['tasks'] : [];
        },
      },
      config: { device: A.device, namespace: 'tasks', peers: [{ device: C.device }] },
      store,
      online: () => true,
    });
    const base = input({
      policy: { allowedDevices: [B.device], allowedAgents: ['worker'] },
      route: { require: ['api'], prefer: [], strategy: 'deterministic' },
    });

    // 地址簿里有 C，但 C 未订阅；B 有可验证卡但不在 peers 中。两者都不授权。
    let context = await loadRouteContext(provider, { states: [], events: [], asOf: 1, computedBy: A.device });
    expect(context.authorization.devices).toEqual([A.device]);
    let decision = resolveRoute({ ...base, ...{ cards: context.cards, authorization: context.authorization, status: context.status } });
    expect(decision).toMatchObject({ decision: 'NO_TARGET', chosen: null, blockedBy: ['NO_CANDIDATES'] });

    // C 订阅 tasks 也不等于 B 被授权；B 仍不在地址簿。查询 C 失败 → 不授权。
    subscribed.add(C.device);
    queryFailures.add(C.device);
    context = await loadRouteContext(provider, { states: [], events: [], asOf: 1, computedBy: A.device });
    expect(context.authorization.devices).toEqual([A.device]);

    // 把 B 加入 config.peers 且订阅 tasks 后，才可路由。
    const providerWithB = daemonRoutingProvider({
      backend: {
        listCards: async () => [card(B.device, B.agent, ['api'])],
        getSubscriptions: async (device: string) => (device === B.device ? ['tasks'] : []),
      },
      config: { device: A.device, namespace: 'tasks', peers: [{ device: B.device }] },
      store,
      online: () => true,
    });
    context = await loadRouteContext(providerWithB, { states: [], events: [], asOf: 1, computedBy: A.device });
    expect(context.authorization.devices).toEqual([A.device, B.device]);
    decision = resolveRoute({ ...base, ...{ cards: context.cards, authorization: context.authorization, status: context.status } });
    expect(decision).toMatchObject({ decision: 'assigned', chosen: B });
    expect(decision.why.code).toBe('ASSIGNED');
  });

  it('卡片版本/tombstone：只使用最新 active 版本', () => {
    const old = card(B.device, B.agent, ['api'], { version: 1 });
    const latest = card(B.device, B.agent, ['ui'], { version: 2 });
    const tombstoned = card(C.device, C.agent, ['api'], { version: 2, tombstone: true, capabilities: [], tools: [] });
    const decision = resolveRoute(input({
      cards: [old, latest, tombstoned],
      authorization: { devices: [B.device, C.device] },
      status: [view(B.device, B.agent), view(C.device, C.agent)],
      route: { require: ['api'], prefer: [], strategy: 'deterministic' },
    }));
    expect(decision.decision).toBe('NO_TARGET');
    expect(decision.rejected).toEqual([
      { device: B.device, agent: B.agent, code: 'MISSING_CAPABILITY', detail: 'api' },
    ]);
  });
});
