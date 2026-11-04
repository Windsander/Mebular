// P5 角色卡：schema/隐私/任务历史聚合/可选摘要/版本/tombstone/本地 job。
import { describe, it, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import {
  AGENT_NAMESPACE,
  ROLE_CARD_DEFAULT_CONFIDENCE_THRESHOLD,
  ROLE_CARD_GENERATOR,
  ROLE_CARD_KIND,
  RoleCardJob,
  activeAgentRoleCards,
  appendAgentRoleCard,
  collectRoleTaskSamples,
  generateRoleCards,
  graphRoleSummaryProvider,
  latestAgentRoleCards,
  listAgentRoleCards,
  publishRoleCards,
  roleCardFingerprint,
  validateAgentRoleCard,
  validateFleetConfig,
  type AgentRoleCard,
  type RoleSummary,
} from '../../packages/fleet/src/index.js';
import { mkEvent } from './helpers.js';

function roleCard(overrides: Partial<AgentRoleCard> = {}): AgentRoleCard {
  return {
    v: 1,
    kind: ROLE_CARD_KIND,
    device: 'device-A',
    agent: 'worker',
    version: 1,
    summary: 'worker: 6 recent tasks, 6 done; prefers write-tests',
    strengths: [{ tag: 'write-tests', confidence: 0.6 }],
    preferredIntents: ['write-tests'],
    avoid: [],
    confidence: 0.6,
    evidenceRefs: [{ kind: 'task', id: 'task-1' }],
    shadow: true,
    provenance: {
      source: 'task-history',
      sampleSize: 6,
      generatedAt: 100,
      generator: ROLE_CARD_GENERATOR,
    },
    ...overrides,
  };
}

function task(taskId: string, intent: string, options: { success?: boolean; at?: number; device?: string; agent?: string } = {}) {
  const at = options.at ?? 100;
  return [
    mkEvent('created', taskId, {
      at,
      to: { device: options.device ?? 'device-A', agent: options.agent ?? 'worker' },
      intent,
    }),
    mkEvent('claimed', taskId, { at: at + 1, eventId: `${taskId}#claimed@test` }),
    options.success === false
      ? mkEvent('failed', taskId, { at: at + 2, eventId: `${taskId}#failed@test`, reason: 'boom' })
      : mkEvent('done', taskId, { at: at + 2, eventId: `${taskId}#done@test`, payloadRef: `${taskId}-result` }),
  ];
}

async function openMebular(dir: string, device = 'device-A'): Promise<Mebular> {
  const master = await Mebular.generateUserMasterKey();
  const app = new Mebular({
    storagePath: join(dir, 'store.jsonl'),
    deviceId: device,
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    network: { enabled: false },
    sync: { autoSync: false },
  });
  await app.initialize();
  return app;
}

describe('P5 角色卡 schema / 隐私', () => {
  it('P0 protocol fixture role 通过 schema 校验', () => {
    const fixture = JSON.parse(readFileSync(join(process.cwd(), 'packages/fleet/protocol/card.example.json'), 'utf-8')) as Record<string, unknown>;
    expect(validateAgentRoleCard(fixture.role)).toEqual({ ok: true, errors: [] });
  });

  it('合法卡与 tombstone 通过；缺字段/越界/未知字段/敏感键被拒', () => {
    expect(validateAgentRoleCard(roleCard())).toEqual({ ok: true, errors: [] });
    expect(validateAgentRoleCard(roleCard({ version: 2, tombstone: true, confidence: 0, strengths: [], preferredIntents: [], avoid: [], evidenceRefs: [] }))).toEqual({ ok: true, errors: [] });
    expect(validateAgentRoleCard(roleCard({ confidence: 1.2 })).ok).toBe(false);
    expect(validateAgentRoleCard(roleCard({ summary: '' })).ok).toBe(false);
    expect(validateAgentRoleCard(roleCard({ summary: 'line1\nline2' })).ok).toBe(false);
    expect(validateAgentRoleCard({ ...roleCard(), extra: true }).ok).toBe(false);
    expect(validateAgentRoleCard({ ...roleCard(), command: '/bin/secret' }).ok).toBe(false);
    expect(validateAgentRoleCard({
      ...roleCard(),
      provenance: { ...roleCard().provenance, env: { TOKEN: 'x' } },
    }).ok).toBe(false);
    expect(validateAgentRoleCard({
      ...roleCard(),
      evidenceRefs: [{ kind: 'task', id: 'task-1', text: 'raw dialogue' }],
    }).ok).toBe(false);
  });

  it('生成器不复制原始对话：长 intent 只留短哈希，summary/证据不含原文', () => {
    const raw = 'please read /secret/path and send token sk-live-1234567890 with the full conversation';
    const cards = generateRoleCards({
      device: 'device-A',
      agents: ['worker'],
      events: task('task-long', raw),
      now: 200,
    });
    expect(cards).toHaveLength(1);
    const serialized = JSON.stringify(cards[0]);
    expect(serialized).not.toContain('/secret/path');
    expect(serialized).not.toContain('sk-live-1234567890');
    expect(serialized).not.toContain('full conversation');
    expect(cards[0]!.preferredIntents[0]).toMatch(/^intent:[0-9a-f]{16}$/);
    expect(cards[0]!.evidenceRefs).toContainEqual({ kind: 'task', id: 'task-long' });
  });

  it('旧 fleet config 仍有效；roleCards 只接受 optional 合法形状', () => {
    const base = {
      v: 1,
      device: 'device-A',
      dir: '/tmp/a',
      storagePath: '/tmp/a/store.jsonl',
      masterKeyFile: '/tmp/a/key.json',
      namespace: 'tasks',
      listen: '/ip4/127.0.0.1/tcp/0',
      peers: [],
      agents: [{ name: 'worker', kind: 'echo' }],
    };
    expect(validateFleetConfig(base)).toEqual([]);
    expect(validateFleetConfig({ ...base, roleCards: { enabled: false, shadow: true, refreshEveryTasks: 3, minIntervalMs: 1000, window: 20 } })).toEqual([]);
    expect(validateFleetConfig({ ...base, roleCards: { enabled: 'yes' } }).join('; ')).toContain('roleCards.enabled');
    expect(validateFleetConfig({ ...base, roleCards: { refreshEveryTasks: 0 } }).join('; ')).toContain('roleCards.refreshEveryTasks');
  });
});

describe('P5 任务历史聚合 + 可选内部摘要', () => {
  it('样本量/成功率/一致性决定 confidence；1 个样本为低置信度', () => {
    const one = generateRoleCards({ device: 'device-A', agents: ['worker'], events: task('task-1', 'write-tests'), now: 200 });
    expect(one[0]!.confidence).toBeLessThan(ROLE_CARD_DEFAULT_CONFIDENCE_THRESHOLD);
    expect(one[0]!.shadow).toBe(true);
    expect(one[0]!.provenance).toMatchObject({ source: 'task-history', sampleSize: 1, generator: ROLE_CARD_GENERATOR });

    const events = Array.from({ length: 8 }, (_, index) => task(`task-${index}`, 'write-tests', { at: 100 + index, success: index !== 7 })).flat();
    const many = generateRoleCards({ device: 'device-A', agents: ['worker'], events, now: 120 });
    expect(many[0]!.confidence).toBeGreaterThanOrEqual(ROLE_CARD_DEFAULT_CONFIDENCE_THRESHOLD);
    expect(many[0]!.provenance.sampleSize).toBe(8);
    expect(many[0]!.preferredIntents).toContain('write-tests');
    expect(many[0]!.strengths.find((entry) => entry.tag === 'write-tests')?.confidence).toBeGreaterThan(0);
    expect(many[0]!.avoid.find((entry) => entry.tag === 'write-tests')?.confidence).toBeGreaterThan(0);
    expect(many[0]!.evidenceRefs.filter((ref) => ref.kind === 'task')).toHaveLength(8);
  });

  it('只聚合本机真实执行者，排除 plan sentinel / 通配 agent / 非终态', () => {
    const events = [
      ...task('task-ok', 'write', { at: 10 }),
      ...task('task-remote', 'write', { at: 11, device: 'device-B' }),
      ...task('task-wild', 'write', { at: 12, agent: '*' }),
      mkEvent('created', 'task-pending', { at: 13, to: { device: 'device-A', agent: 'worker' }, intent: 'pending' }),
      mkEvent('created', 'task-plan', { at: 14, to: { device: '__plan__', agent: '__plan__' }, intent: 'plan' }),
    ];
    const samples = collectRoleTaskSamples(events);
    // 纯派生样本包含远端任务；生成本机角色卡时才按 device/agent 过滤。
    expect(samples.map((sample) => sample.taskId).sort()).toEqual(['task-ok', 'task-remote']);
    const cards = generateRoleCards({ device: 'device-A', agents: ['worker'], events, now: 20 });
    expect(cards[0]!.provenance.sampleSize).toBe(1);
  });

  it('fixture 摘要只贡献证据 ID/意图，不复制 summary 原文；没有摘要不阻塞', () => {
    const summaries: RoleSummary[] = [{
      id: 'compact-1',
      device: 'device-A',
      agent: 'worker',
      summary: 'RAW DIALOGUE SHOULD NOT BE COPIED',
      intents: ['review-code'],
    }];
    const withSummary = generateRoleCards({
      device: 'device-A',
      agents: ['worker'],
      events: task('task-1', 'write-tests'),
      summaries,
      now: 200,
    });
    expect(withSummary[0]!.provenance.source).toBe('task-history+internal-summary');
    expect(withSummary[0]!.evidenceRefs).toContainEqual({ kind: 'summary', id: 'compact-1' });
    expect(withSummary[0]!.preferredIntents).toContain('review-code');
    expect(JSON.stringify(withSummary[0])).not.toContain('RAW DIALOGUE');

    const without = generateRoleCards({ device: 'device-A', agents: ['worker'], events: task('task-1', 'write-tests'), now: 200 });
    expect(without[0]!.provenance.source).toBe('task-history');
    expect(without[0]!.evidenceRefs.some((ref) => ref.kind === 'summary')).toBe(false);
  });

  it('graphRoleSummaryProvider 只读 internal compact/checkpoint，不返回 summary 原文', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-role-summary-'));
    const app = await openMebular(dir);
    try {
      const compact = await app.graph.createNode('compact', {
        summary: 'RAW DIALOGUE MUST NOT LEAVE THE COMPACT',
        ownerId: 'agent:worker',
        intents: ['review-code'],
        updatedAt: 50,
      }, [], {
        namespace: 'tasks',
        metadata: { internal: true, internalObject: { kind: 'compact' } },
      });
      await app.graph.createNode('compact', {
        summary: 'visible non-internal compact',
        ownerId: 'agent:worker',
      }, [], { namespace: 'tasks' });
      const checkpoint = await app.graph.createNode('context_checkpoint', {
        goal: 'raw checkpoint goal',
        agent: 'worker',
        updatedAt: 60,
      }, [], {
        namespace: 'tasks',
        metadata: { internal: true, internalObject: { kind: 'context_checkpoint' } },
      });

      const provider = graphRoleSummaryProvider(app, { namespaces: ['tasks'] });
      const summaries = await provider.listSummaries({ device: 'device-A', agents: ['worker'] });
      expect(summaries.map((entry) => entry.id).sort()).toEqual([compact.id, checkpoint.id].sort());
      expect(summaries.find((entry) => entry.id === compact.id)).toMatchObject({
        agent: 'worker',
        intents: ['review-code'],
      });
      expect(JSON.stringify(summaries)).not.toContain('RAW DIALOGUE');
      expect(JSON.stringify(summaries)).not.toContain('raw checkpoint goal');
      expect(JSON.stringify(summaries)).not.toContain('visible non-internal');
    } finally {
      await app.shutdown().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('P5 角色卡存储：版本 / tombstone / 作者 / internal', () => {
  it('版本单调、同版本幂等/冲突、tombstone 排除、internal metadata 正确', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-role-card-store-'));
    const app = await openMebular(dir);
    try {
      const v1 = await appendAgentRoleCard(app, roleCard());
      expect(v1).toMatchObject({ stored: true, replayed: false, createdBy: 'device-A' });
      const node = (await app.graph.listNodes({ type: ROLE_CARD_KIND }))
        .find((entry) => entry.id === v1.nodeId);
      expect(node?.namespace).toBe(AGENT_NAMESPACE);
      expect(node?.metadata).toMatchObject({ internal: true, internalObject: { kind: ROLE_CARD_KIND } });

      const replay = await appendAgentRoleCard(app, roleCard());
      expect(replay).toMatchObject({ stored: false, replayed: true });
      await expect(appendAgentRoleCard(app, roleCard({ summary: 'changed' }))).rejects.toMatchObject({ code: 'ROLE_CARD_CONFLICT' });
      await expect(appendAgentRoleCard(app, roleCard({ version: 3 }))).rejects.toMatchObject({ code: 'ROLE_CARD_VERSION_GAP' });

      const v2 = await appendAgentRoleCard(app, roleCard({ version: 2, confidence: 0.8, summary: 'v2' }));
      expect(v2.stored).toBe(true);
      await expect(appendAgentRoleCard(app, roleCard({ version: 1, summary: 'stale' }))).rejects.toMatchObject({ code: 'ROLE_CARD_STALE' });

      const tombstone = await appendAgentRoleCard(app, roleCard({
        version: 3,
        summary: 'worker: agent removed',
        strengths: [],
        preferredIntents: [],
        avoid: [],
        confidence: 0,
        evidenceRefs: [],
        tombstone: true,
      }));
      expect(tombstone.stored).toBe(true);
      const all = await listAgentRoleCards(app);
      expect(all.map((card) => card.version)).toEqual([1, 2, 3]);
      expect(latestAgentRoleCards(all)[0]).toMatchObject({ version: 3, tombstone: true });
      expect(activeAgentRoleCards(latestAgentRoleCards(all))).toEqual([]);

      await expect(appendAgentRoleCard(app, roleCard({ device: 'device-B' }))).rejects.toMatchObject({ code: 'ROLE_CARD_AUTHOR' });
    } finally {
      await app.shutdown().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('发布器同内容 no-op；移除 agent 发 tombstone；fingerprint 忽略 generatedAt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-role-card-publish-'));
    const app = await openMebular(dir);
    const events = Array.from({ length: 5 }, (_, index) => task(`task-${index}`, 'write-tests', { at: 100 + index })).flat();
    try {
      const first = await publishRoleCards({
        store: { list: () => listAgentRoleCards(app), append: (input) => appendAgentRoleCard(app, input) },
        device: 'device-A',
        agents: ['worker'],
        events,
        now: 200,
      });
      expect(first.published).toBe(1);
      expect(first.cards[0]!.shadow).toBe(true);
      expect(first.cards[0]!.version).toBe(1);

      const second = await publishRoleCards({
        store: { list: () => listAgentRoleCards(app), append: (input) => appendAgentRoleCard(app, input) },
        device: 'device-A',
        agents: ['worker'],
        events,
        now: 300,
      });
      expect(second.published).toBe(0);
      expect(second.unchanged).toBe(1);

      expect(roleCardFingerprint(first.cards[0]!)).toBe(roleCardFingerprint({ ...first.cards[0]!, provenance: { ...first.cards[0]!.provenance, generatedAt: 999 } }));

      const removed = await publishRoleCards({
        store: { list: () => listAgentRoleCards(app), append: (input) => appendAgentRoleCard(app, input) },
        device: 'device-A',
        agents: [],
        events,
        now: 400,
      });
      expect(removed.tombstoned).toBe(1);
      expect(removed.cards[0]).toMatchObject({ version: 2, tombstone: true, shadow: true, confidence: 0 });
      expect(activeAgentRoleCards(latestAgentRoleCards(await listAgentRoleCards(app)))).toEqual([]);
    } finally {
      await app.shutdown().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('远端卡只能经 graph（同步）进入；author 不匹配的节点不被读取', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-role-card-remote-'));
    const app = await openMebular(dir);
    try {
      const remote = roleCard({ device: 'device-B' });
      const wrong = roleCard({ device: 'device-C', agent: 'fake' });
      const goodNode = await app.graph.createNode(ROLE_CARD_KIND, remote as unknown as Record<string, unknown>, [], {
        namespace: AGENT_NAMESPACE,
        metadata: { internal: true, internalObject: { kind: ROLE_CARD_KIND } },
      });
      await app.graph.updateNode(goodNode.id, { createdBy: 'device-B' });
      const wrongNode = await app.graph.createNode(ROLE_CARD_KIND, wrong as unknown as Record<string, unknown>, [], {
        namespace: AGENT_NAMESPACE,
        metadata: { internal: true, internalObject: { kind: ROLE_CARD_KIND } },
      });
      await app.graph.updateNode(wrongNode.id, { createdBy: 'device-A' });
      const cards = await listAgentRoleCards(app);
      expect(cards.some((card) => card.device === 'device-B')).toBe(true);
      expect(cards.some((card) => card.agent === 'fake')).toBe(false);
    } finally {
      await app.shutdown().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('P5 本机 runtime job', () => {
  it('达到任务阈值后才生成；force 可复跑；摘要失败不影响任务历史；移除 agent 发 tombstone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-role-card-job-'));
    const app = await openMebular(dir);
    let events = task('task-1', 'write-tests', { at: 100 });
    try {
      const store = {
        list: () => listAgentRoleCards(app),
        append: (input: unknown) => appendAgentRoleCard(app, input),
      };
      const job = new RoleCardJob({
        device: 'device-A',
        agents: ['worker'],
        events: { all: async () => events },
        store,
        refreshEveryTasks: 2,
        minIntervalMs: 0,
        now: () => 200,
      });
      expect(await job.tick()).toBeNull();
      expect(await listAgentRoleCards(app)).toEqual([]);

      events = [...events, ...task('task-2', 'write-tests', { at: 110 })];
      const first = await job.tick();
      expect(first?.published).toBe(1);
      expect(first?.cards[0]).toMatchObject({ version: 1, shadow: true });
      expect(job.status()).toMatchObject({ lastTaskCount: 2, lastError: null });

      const rerun = await job.tick();
      expect(rerun).toBeNull(); // 增量不足
      const forced = await job.tick({ force: true });
      expect(forced?.unchanged).toBe(1);

      const logs: string[] = [];
      const failingSummaryJob = new RoleCardJob({
        device: 'device-A',
        agents: ['worker'],
        events: { all: async () => events },
        store,
        summaries: { listSummaries: async () => { throw new Error('summary offline'); } },
        refreshEveryTasks: 1,
        minIntervalMs: 0,
        now: () => 300,
        log: (message) => logs.push(message),
      });
      const withFailure = await failingSummaryJob.tick({ force: true });
      expect(withFailure).not.toBeNull();
      expect(logs.join('\n')).toContain('summary offline');

      const removed = new RoleCardJob({
        device: 'device-A',
        agents: [],
        events: { all: async () => events },
        store,
        refreshEveryTasks: 1,
        minIntervalMs: 0,
        now: () => 400,
      });
      const tombstoned = await removed.tick({ force: true });
      expect(tombstoned?.tombstoned).toBe(1);
      expect(activeAgentRoleCards(latestAgentRoleCards(await listAgentRoleCards(app)))).toEqual([]);
    } finally {
      await app.shutdown().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('默认 shadow=true；显式 shadow=false 才写入非 shadow 卡', () => {
    const events = Array.from({ length: 5 }, (_, index) => task(`task-${index}`, 'write-tests', { at: 100 + index })).flat();
    expect(generateRoleCards({ device: 'device-A', agents: ['worker'], events, now: 200 })[0]!.shadow).toBe(true);
    expect(generateRoleCards({ device: 'device-A', agents: ['worker'], events, now: 200, shadow: false })[0]!.shadow).toBe(false);
  });
});
