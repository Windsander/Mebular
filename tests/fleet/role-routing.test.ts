// P5 角色卡 shadow/软排序：默认不改变 chosen；启用后只做最后一项软排序。
import { describe, it, expect } from '@jest/globals';
import {
  AGENT_TASK_TOOL_NAMES,
  ROUTE_ROLE_CARD_DISABLED,
  ROUTE_ROLE_CARD_SHADOW,
  ROUTE_ROLE_CARD_USED,
  buildRoleCardShadowReport,
  loadRouteContext,
  rendezvousScore,
  resolveRoute,
  routeInputFromContext,
  type AgentCapabilityCard,
  type AgentRoleCard,
  type AgentStatusView,
  type PlanRoutingProvider,
  type RouteInput,
} from '../../packages/fleet/src/index.js';

const A = { device: 'device-A', agent: 'planner' };
const B = { device: 'device-B', agent: 'worker' };
const C = { device: 'device-C', agent: 'worker' };

function card(device: string, capabilities: string[], overrides: Partial<AgentCapabilityCard> = {}): AgentCapabilityCard {
  return {
    v: 1,
    kind: 'agent_capability_card',
    device,
    agent: 'worker',
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

function view(device: string, overrides: Partial<AgentStatusView> = {}): AgentStatusView {
  return {
    v: 1,
    kind: 'agent_status_view',
    device,
    agent: 'worker',
    online: true,
    inflight: 0,
    capacity: 2,
    asOf: 1,
    ttlMs: 30_000,
    computedBy: A.device,
    ...overrides,
  };
}

function roleCard(device: string, overrides: Partial<AgentRoleCard> = {}): AgentRoleCard {
  return {
    v: 1,
    kind: 'agent_role_card',
    device,
    agent: 'worker',
    version: 1,
    summary: `${device}: 8 recent tasks, 8 done`,
    strengths: [{ tag: 'write-tests', confidence: 0.8 }],
    preferredIntents: ['write-tests'],
    avoid: [],
    confidence: 0.8,
    evidenceRefs: [{ kind: 'task', id: `task-${device}` }],
    shadow: false,
    provenance: { source: 'task-history', sampleSize: 8, generatedAt: 1, generator: 'test' },
    ...overrides,
  };
}

function planIdWhereBwins(): string {
  for (let index = 0; index < 200; index++) {
    const planId = `plan-role-${index}`;
    const b = rendezvousScore(`${planId}#1#work`, B.device, B.agent);
    const c = rendezvousScore(`${planId}#1#work`, C.device, C.agent);
    if (b > c) return planId;
  }
  throw new Error('找不到 B 赢得 rendezvous 的 planId');
}

function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    planId: planIdWhereBwins(),
    version: 1,
    stepId: 'work',
    intent: 'write-tests',
    route: { require: [], prefer: [], strategy: 'deterministic' },
    policy: {},
    cards: [card(B.device, []), card(C.device, [])],
    authorization: { devices: [B.device, C.device] },
    status: [view(B.device), view(C.device)],
    namespace: 'tasks',
    ...overrides,
  };
}

describe('P5 shadow：不改变派发行为', () => {
  it('默认 shadow 与无角色卡 chosen 完全一致；why.roleCard=shadow-ignored', () => {
    const base = input();
    const without = resolveRoute(base);
    const shadow = resolveRoute({ ...base, roleCards: [roleCard(C.device)], roleCardMode: 'shadow' });
    expect(shadow.chosen).toEqual(without.chosen);
    expect(shadow.chosen).toEqual(B);
    expect(shadow.why.roleCard).toBe(ROUTE_ROLE_CARD_SHADOW);
    expect(without.why.roleCard).toBe(ROUTE_ROLE_CARD_DISABLED);
    expect(shadow.why.ranking.map((entry) => `${entry.device}/${entry.agent}`))
      .toEqual(without.why.ranking.map((entry) => `${entry.device}/${entry.agent}`));
    expect(shadow.why.ranking.find((entry) => entry.device === C.device)?.reasons)
      .toContain(`role=${ROUTE_ROLE_CARD_SHADOW}`);
  });

  it('shadow=false 的卡在 shadow 模式仍被忽略；无卡回退能力卡 + 确定性分配', () => {
    const base = input();
    const shadow = resolveRoute({ ...base, roleCards: [roleCard(C.device, { confidence: 0.99 })], roleCardMode: 'shadow' });
    expect(shadow.chosen).toEqual(B);
    const first = resolveRoute(base);
    const second = resolveRoute(base);
    expect(second.chosen).toEqual(first.chosen);
    expect(second.why.ranking).toEqual(first.why.ranking);
  });
});

describe('P5 enabled：只作为最后一项软排序', () => {
  it('显式启用且 confidence>=0.5、shadow=false → chosen 可变化且 why.roleCard=used-soft', () => {
    const base = input();
    const enabled = resolveRoute({ ...base, roleCards: [roleCard(C.device)], roleCardMode: 'enabled' });
    expect(enabled.chosen).toEqual(C);
    expect(enabled.why.roleCard).toBe(ROUTE_ROLE_CARD_USED);
    expect(enabled.why.ranking.find((entry) => entry.device === C.device)?.reasons)
      .toContain('role=used-soft:0.85');
    // 同一输入确定性：重复解析得到同一 chosen。
    expect(resolveRoute({ ...base, roleCards: [roleCard(C.device)], roleCardMode: 'enabled' }).chosen).toEqual(C);
  });

  it('低置信度 / shadow=true 的卡不参与：回退能力卡与确定性分配', () => {
    const base = input();
    const low = resolveRoute({
      ...base,
      roleCards: [roleCard(C.device, { confidence: 0.49 })],
      roleCardMode: 'enabled',
    });
    expect(low.chosen).toEqual(B);
    expect(low.why.roleCard).toBe(ROUTE_ROLE_CARD_DISABLED);

    const stillShadow = resolveRoute({
      ...base,
      roleCards: [roleCard(C.device, { shadow: true })],
      roleCardMode: 'enabled',
    });
    expect(stillShadow.chosen).toEqual(B);
    expect(stillShadow.why.roleCard).toBe(ROUTE_ROLE_CARD_DISABLED);
  });

  it('不能绕过硬过滤：缺能力/未授权/满载仍被拒绝', () => {
    const missing = input({ route: { require: ['api'], prefer: [], strategy: 'deterministic' } });
    const missingDecision = resolveRoute({
      ...missing,
      cards: [card(B.device, ['api']), card(C.device, [])],
      roleCards: [roleCard(C.device, { confidence: 1 })],
      roleCardMode: 'enabled',
    });
    expect(missingDecision.chosen).toEqual(B);
    expect(missingDecision.rejected).toContainEqual({ device: C.device, agent: 'worker', code: 'MISSING_CAPABILITY', detail: 'api' });

    const policyDenied = resolveRoute({
      ...input({ policy: { allowedDevices: [B.device] } }),
      roleCards: [roleCard(C.device, { confidence: 1 })],
      roleCardMode: 'enabled',
    });
    expect(policyDenied.chosen).toEqual(B);
    expect(policyDenied.rejected).toContainEqual({ device: C.device, agent: 'worker', code: 'POLICY_DENIED', detail: 'device' });

    // 未授权目标不会被角色卡带进候选；显式 to 仍未授权时保持 NO_TARGET，不改派。
    const unauthorized = resolveRoute({
      ...input({ to: C, authorization: { devices: [B.device] } }),
      roleCards: [roleCard(C.device, { confidence: 1 })],
      roleCardMode: 'enabled',
    });
    expect(unauthorized.chosen).toBeNull();
    expect(unauthorized.rejected).toContainEqual({ device: C.device, agent: 'worker', code: 'UNAUTHORIZED', detail: 'device' });

    const capacity = resolveRoute({
      ...input({ status: [view(B.device), view(C.device, { inflight: 2, capacity: 2 })] }),
      roleCards: [roleCard(C.device, { confidence: 1 })],
      roleCardMode: 'enabled',
    });
    expect(capacity.chosen).toEqual(B);
    expect(capacity.rejected).toContainEqual({ device: C.device, agent: 'worker', code: 'AT_CAPACITY', detail: 'capacity=2' });
  });

  it('角色卡排在成功率/时延/prefer 之后，不能覆盖更高优先级软排序', () => {
    const decision = resolveRoute({
      ...input({
        status: [
          view(B.device, { recentSuccessRate: 0.95, samples: { recent: 10, window: 20 } }),
          view(C.device, { recentSuccessRate: 0.55, samples: { recent: 10, window: 20 } }),
        ],
      }),
      roleCards: [roleCard(C.device, { confidence: 1 })],
      roleCardMode: 'enabled',
    });
    expect(decision.chosen).toEqual(B);
    expect(decision.why.roleCard).toBe(ROUTE_ROLE_CARD_USED); // 卡被考虑，但没赢过高优先级项
  });
});

describe('P5 shadow 对比报告', () => {
  it('同一批候选：报告 chosen 变化可解释，硬过滤集合一致', () => {
    const report = buildRoleCardShadowReport({
      ...input(),
      roleCards: [roleCard(C.device)],
    });
    expect(report.shadow.chosen).toEqual(B);
    expect(report.enabled.chosen).toEqual(C);
    expect(report.changed).toBe(true);
    expect(report.hardFiltersEqual).toBe(true);
    expect(report.eligible).toEqual([{ device: C.device, agent: 'worker', confidence: 0.8, score: 0.85 }]);
    expect(report.ignored).toEqual([]);
  });

  it('报告解释低置信度/shadow；硬过滤受阻时 chosen 不变', () => {
    const report = buildRoleCardShadowReport({
      ...input({ route: { require: ['api'], prefer: [], strategy: 'deterministic' } }),
      cards: [card(B.device, ['api']), card(C.device, [])],
      roleCards: [
        roleCard(C.device, { confidence: 0.4 }),
        roleCard(B.device, { shadow: true }),
      ],
    });
    expect(report.changed).toBe(false);
    expect(report.hardFiltersEqual).toBe(true);
    expect(report.ignored).toEqual(expect.arrayContaining([
      { device: B.device, agent: 'worker', reason: 'shadow' },
      { device: C.device, agent: 'worker', reason: 'low-confidence' },
    ]));
  });
});

describe('P5 routing provider seam', () => {
  async function decisionWith(mode: 'shadow' | 'enabled') {
    const base = input();
    const provider: PlanRoutingProvider = {
      cards: async () => base.cards,
      roleCards: async () => [roleCard(C.device)],
      roleCardMode: mode,
      authorized: async () => base.authorization,
      online: () => true,
      observations: () => [],
      namespace: 'tasks',
    };
    const context = await loadRouteContext(provider, { states: [], events: [], asOf: 1, computedBy: A.device });
    return resolveRoute({
      planId: base.planId,
      version: base.version,
      stepId: base.stepId,
      intent: base.intent,
      route: base.route,
      policy: base.policy,
      ...routeInputFromContext(context),
    });
  }

  it('provider 读取角色卡：默认 shadow 不改变 chosen；enabled 才软排序', async () => {
    const shadow = await decisionWith('shadow');
    expect(shadow.chosen).toEqual(B);
    expect(shadow.why.roleCard).toBe(ROUTE_ROLE_CARD_SHADOW);
    const enabled = await decisionWith('enabled');
    expect(enabled.chosen).toEqual(C);
    expect(enabled.why.roleCard).toBe(ROUTE_ROLE_CARD_USED);
  });

  it('provider 角色卡读取失败 → 空卡，不影响 P3 路径', async () => {
    const base = input();
    const provider: PlanRoutingProvider = {
      cards: async () => base.cards,
      roleCards: async () => { throw new Error('role store offline'); },
      roleCardMode: 'enabled',
      authorized: async () => base.authorization,
      online: () => true,
      observations: () => [],
      namespace: 'tasks',
    };
    const context = await loadRouteContext(provider, { states: [], events: [], asOf: 1, computedBy: A.device });
    const decision = resolveRoute({
      planId: base.planId,
      version: base.version,
      stepId: base.stepId,
      route: base.route,
      policy: base.policy,
      ...routeInputFromContext(context),
    });
    expect(decision.chosen).toEqual(B);
    expect(decision.why.roleCard).toBe(ROUTE_ROLE_CARD_DISABLED);
  });
});
