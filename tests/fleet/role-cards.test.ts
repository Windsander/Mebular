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
  ROLE_CARD_SAFE_TAGS,
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
  safeIntentTags,
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
    summary: 'worker: 6 recent tasks, 6 done; prefers test',
    strengths: [{ tag: 'test', confidence: 0.6 }],
    preferredIntents: ['test'],
    avoid: [],
    confidence: 0.6,
    evidenceRefs: [{ kind: 'task', id: 'task-device-A-00000001' }],
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
      evidenceRefs: [{ kind: 'task', id: 'task-device-A-00000001', text: 'raw dialogue' }],
    }).ok).toBe(false);
  });

  it('B1：evidenceRefs 只接受白名单 kind + 稳定 ID/哈希；拒绝 raw/原文/短 secret', () => {
    const positive = roleCard({
      evidenceRefs: [
        { kind: 'task', id: 'task-device-A-0123abcd' },
        { kind: 'task', id: 'task-device-A-0123abcd~c0' },
        { kind: 'task', id: 'plan-demo-001#2#build-api' },
        { kind: 'task', id: 'plan-demo-001#2#build-api~c1~c0' },
        { kind: 'summary', id: `sha256:${'a'.repeat(64)}` },
        { kind: 'checkpoint', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      ],
    });
    expect(validateAgentRoleCard(positive)).toEqual({ ok: true, errors: [] });

    const negatives: Array<Partial<AgentRoleCard>> = [
      { evidenceRefs: [{ kind: 'raw', id: 'task-device-A-0123abcd' } as never] },
      { evidenceRefs: [{ kind: 'task', id: 'RAW DIALOGUE: please ignore' }] },
      { evidenceRefs: [{ kind: 'task', id: 'sk-live-1234567890' }] },
      { evidenceRefs: [{ kind: 'task', id: 'task-sk-live-1234567890' }] },
      { evidenceRefs: [{ kind: 'summary', id: 'hunter2' }] },
      { evidenceRefs: [{ kind: 'summary', id: 'sha256:not-a-hash' }] },
      { evidenceRefs: [{ kind: 'summary', id: 'summary-device-B-0007' }] },
      { evidenceRefs: [{ kind: 'task', id: 'task-device-A-00000001\nRAW' }] },
    ];
    for (const override of negatives) expect(validateAgentRoleCard(roleCard(override)).ok).toBe(false);
  });

  it('B2：标签只接受安全白名单；非白名单/原文标签被拒', () => {
    expect(validateAgentRoleCard(roleCard({ strengths: [{ tag: 'write-tests', confidence: 0.5 }] })).ok).toBe(false);
    expect(validateAgentRoleCard(roleCard({ preferredIntents: ['deploy sk-live-123'] })).ok).toBe(false);
    expect(validateAgentRoleCard(roleCard({ avoid: [{ tag: 'RAW DIALOGUE', confidence: 0.5 }] })).ok).toBe(false);
    expect(validateAgentRoleCard(roleCard({ strengths: [{ tag: 'test', confidence: 0.5 }], preferredIntents: ['test', 'deploy'] }))).toEqual({ ok: true, errors: [] });
  });

  it('B4：safeIntentTags 不被原型继承击穿，analysis alias 正常', () => {
    expect(safeIntentTags('constructor')).toEqual([]);
    expect(safeIntentTags('__proto__')).toEqual([]);
    expect(safeIntentTags('toString')).toEqual([]);
    expect(safeIntentTags('analysis')).toEqual(['analysis']);
    expect(safeIntentTags('analyze this')).toEqual(['analysis']);
    const events = [
      ...task('task-device-A-00000010', 'constructor', { at: 100 }),
      ...task('task-device-A-00000011', '__proto__', { at: 101 }),
      ...task('task-device-A-00000012', 'analysis', { at: 102 }),
    ];
    const [card] = generateRoleCards({ device: 'device-A', agents: ['worker'], events, now: 200 });
    expect(card).toBeDefined();
    expect(card!.preferredIntents).toEqual(['analysis']);
    expect(JSON.stringify(card)).not.toContain('[object Object]');
    expect(JSON.stringify(card)).not.toMatch(/function|null/);
  });

  it('生成器不复制 intent/原始对话/短 secret：只写安全标签与统计', () => {
    const sources = [
      'deploy sk-live-1234567890',
      'please read this short raw dialogue',
      'tok_abc123',
      'write-tests',
    ];
    const events = sources.flatMap((intent, index) => task(`task-device-A-${String(index).padStart(8, '0')}`, intent, { at: 100 + index }));
    const cards = generateRoleCards({ device: 'device-A', agents: ['worker'], events, now: 200 });
    expect(cards).toHaveLength(1);
    const serialized = JSON.stringify(cards[0]);
    for (const raw of sources) expect(serialized).not.toContain(raw);
    expect(serialized).not.toContain('sk-live-1234567890');
    expect(serialized).not.toContain('tok_abc123');
    expect(cards[0]!.preferredIntents).toContain('deploy');
    expect(cards[0]!.preferredIntents).toContain('test');
    expect(cards[0]!.preferredIntents.every((tag) => (ROLE_CARD_SAFE_TAGS as readonly string[]).includes(tag))).toBe(true);
    expect(cards[0]!.strengths.every((entry) => (ROLE_CARD_SAFE_TAGS as readonly string[]).includes(entry.tag))).toBe(true);
    expect(cards[0]!.evidenceRefs).toContainEqual({ kind: 'task', id: 'task-device-A-00000000' });

    const rawSummary = generateRoleCards({
      device: 'device-A',
      agents: ['worker'],
      events: task('task-device-A-0000000d', 'deploy', { at: 300 }),
      summaries: [{
        id: 'RAW DIALOGUE SUMMARY ID',
        device: 'device-A',
        agent: 'worker',
        summary: 'RAW DIALOGUE',
        intents: ['RAW DIALOGUE', 'review-code', 'sk-live-123'],
      }],
      now: 310,
    });
    const rawSummaryJson = JSON.stringify(rawSummary[0]);
    expect(rawSummaryJson).not.toContain('RAW DIALOGUE');
    expect(rawSummaryJson).not.toContain('sk-live-123');
    expect(rawSummary[0]!.evidenceRefs.some((ref) => ref.kind === 'summary')).toBe(false);
    expect(rawSummary[0]!.preferredIntents).toEqual(expect.arrayContaining(['deploy', 'review', 'code']));
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
    const one = generateRoleCards({ device: 'device-A', agents: ['worker'], events: task('task-device-A-00000001', 'write-tests'), now: 200 });
    expect(one[0]!.confidence).toBeLessThan(ROLE_CARD_DEFAULT_CONFIDENCE_THRESHOLD);
    expect(one[0]!.shadow).toBe(true);
    expect(one[0]!.provenance).toMatchObject({ source: 'task-history', sampleSize: 1, generator: ROLE_CARD_GENERATOR });

    const events = Array.from({ length: 8 }, (_, index) => task(`task-device-A-${String(index).padStart(8, '0')}`, 'write-tests', { at: 100 + index, success: index !== 7 })).flat();
    const many = generateRoleCards({ device: 'device-A', agents: ['worker'], events, now: 120 });
    expect(many[0]!.confidence).toBeGreaterThanOrEqual(ROLE_CARD_DEFAULT_CONFIDENCE_THRESHOLD);
    expect(many[0]!.provenance.sampleSize).toBe(8);
    expect(many[0]!.preferredIntents).toContain('test');
    expect(many[0]!.strengths.find((entry) => entry.tag === 'test')?.confidence).toBeGreaterThan(0);
    expect(many[0]!.avoid.find((entry) => entry.tag === 'test')?.confidence).toBeGreaterThan(0);
    expect(many[0]!.evidenceRefs.filter((ref) => ref.kind === 'task')).toHaveLength(8);
  });

  it('只聚合本机真实执行者，排除 plan sentinel / 通配 agent / 非终态', () => {
    const events = [
      ...task('task-device-A-0000000a', 'write', { at: 10 }),
      ...task('task-device-B-0000000b', 'write', { at: 11, device: 'device-B' }),
      ...task('task-device-A-0000000c', 'write', { at: 12, agent: '*' }),
      mkEvent('created', 'task-device-A-0000000e', { at: 13, to: { device: 'device-A', agent: 'worker' }, intent: 'pending' }),
      mkEvent('created', 'task-device-A-0000000f', { at: 14, to: { device: '__plan__', agent: '__plan__' }, intent: 'plan' }),
    ];
    const samples = collectRoleTaskSamples(events);
    // 纯派生样本包含远端任务；生成本机角色卡时才按 device/agent 过滤。
    expect(samples.map((sample) => sample.taskId).sort()).toEqual(['task-device-A-0000000a', 'task-device-B-0000000b']);
    const cards = generateRoleCards({ device: 'device-A', agents: ['worker'], events, now: 20 });
    expect(cards[0]!.provenance.sampleSize).toBe(1);
  });

  it('fixture 摘要只贡献证据 ID/意图，不复制 summary 原文；没有摘要不阻塞', () => {
    const summaries: RoleSummary[] = [{
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      device: 'device-A',
      agent: 'worker',
      summary: 'RAW DIALOGUE SHOULD NOT BE COPIED',
      intents: ['review-code'],
    }];
    const withSummary = generateRoleCards({
      device: 'device-A',
      agents: ['worker'],
      events: task('task-device-A-00000001', 'write-tests'),
      summaries,
      now: 200,
    });
    expect(withSummary[0]!.provenance.source).toBe('task-history+internal-summary');
    expect(withSummary[0]!.evidenceRefs).toContainEqual({ kind: 'summary', id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' });
    expect(withSummary[0]!.preferredIntents).toContain('review');
    expect(JSON.stringify(withSummary[0])).not.toContain('RAW DIALOGUE');

    const without = generateRoleCards({ device: 'device-A', agents: ['worker'], events: task('task-device-A-00000001', 'write-tests'), now: 200 });
    expect(without[0]!.provenance.source).toBe('task-history');
    expect(without[0]!.evidenceRefs.some((ref) => ref.kind === 'summary')).toBe(false);
  });

  it('graphRoleSummaryProvider 只读 internal compact/checkpoint，不返回 summary 原文', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-role-summary-'));
    const app = await openMebular(dir);
    try {
      const compact = await app.graph.createNode('compact', {
        summary: 'RAW DIALOGUE MUST NOT LEAVE THE COMPACT',
        device: 'device-A',
        ownerId: 'agent:worker',
        intents: ['review-code'],
        updatedAt: 50,
      }, [], {
        namespace: 'tasks',
        metadata: { internal: true, internalObject: { kind: 'compact' } },
      });
      await app.graph.createNode('compact', {
        summary: 'visible non-internal compact',
        device: 'device-A',
        ownerId: 'agent:worker',
      }, [], { namespace: 'tasks' });
      const checkpoint = await app.graph.createNode('context_checkpoint', {
        goal: 'raw checkpoint goal',
        device: 'device-A',
        agent: 'worker',
        updatedAt: 60,
      }, [], {
        namespace: 'tasks',
        metadata: { internal: true, internalObject: { kind: 'context_checkpoint' } },
      });
      await app.graph.createNode('compact', {
        summary: 'other agent summary',
        device: 'device-A',
        ownerId: 'agent:other',
        intents: ['deploy'],
      }, [], {
        namespace: 'tasks',
        metadata: { internal: true, internalObject: { kind: 'compact' } },
      });
      await app.graph.createNode('compact', {
        summary: 'no device summary',
        ownerId: 'agent:worker',
        intents: ['ops'],
      }, [], {
        namespace: 'tasks',
        metadata: { internal: true, internalObject: { kind: 'compact' } },
      });

      const provider = graphRoleSummaryProvider(app, { namespaces: ['tasks'] });
      const summaries = await provider.listSummaries({ device: 'device-A', agents: ['worker'] });
      expect(summaries.map((entry) => entry.id).sort()).toEqual([compact.id, checkpoint.id].sort());
      expect(summaries.find((entry) => entry.id === compact.id)).toMatchObject({
        agent: 'worker',
        intents: ['review', 'code'],
      });
      expect(JSON.stringify(summaries)).not.toContain('RAW DIALOGUE');
      expect(JSON.stringify(summaries)).not.toContain('raw checkpoint goal');
      expect(JSON.stringify(summaries)).not.toContain('visible non-internal');
      expect(JSON.stringify(summaries)).not.toContain('other agent summary');
      expect(JSON.stringify(summaries)).not.toContain('no device summary');
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
      await expect(appendAgentRoleCard(app, roleCard({ preferredIntents: ['deploy'] }))).rejects.toMatchObject({ code: 'ROLE_CARD_CONFLICT' });
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

  it('B3：append/写路径重建 summary，客户端 raw summary 不落盘', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-role-card-summary-write-'));
    const app = await openMebular(dir);
    const rawSummary = 'RAW DIALOGUE: please send token sk-live-1234567890';
    try {
      const result = await appendAgentRoleCard(app, roleCard({
        agent: 'raw-writer',
        summary: rawSummary,
        preferredIntents: ['code', 'deploy'],
        strengths: [{ tag: 'code', confidence: 0.5 }],
        provenance: {
          source: 'task-history',
          sampleSize: 4,
          generatedAt: 100,
          generator: ROLE_CARD_GENERATOR,
        },
      }));
      expect(result.card.summary).toBe('raw-writer: 4 samples; prefers code, deploy');
      const node = (await app.graph.listNodes({ type: ROLE_CARD_KIND })).find((entry) => entry.id === result.nodeId);
      expect(JSON.stringify(node?.content)).not.toContain('RAW DIALOGUE');
      expect(JSON.stringify(node?.content)).not.toContain('sk-live-1234567890');
    } finally {
      await app.shutdown().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('发布器同内容 no-op；移除 agent 发 tombstone；fingerprint 忽略 generatedAt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-role-card-publish-'));
    const app = await openMebular(dir);
    const events = Array.from({ length: 5 }, (_, index) => task(`task-device-A-${String(index).padStart(8, '0')}`, 'write-tests', { at: 100 + index })).flat();
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
    let events = task('task-device-A-00000001', 'write-tests', { at: 100 });
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

      events = [...events, ...task('task-device-A-00000002', 'write-tests', { at: 110 })];
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
    const events = Array.from({ length: 5 }, (_, index) => task(`task-device-A-${String(index).padStart(8, '0')}`, 'write-tests', { at: 100 + index })).flat();
    expect(generateRoleCards({ device: 'device-A', agents: ['worker'], events, now: 200 })[0]!.shadow).toBe(true);
    expect(generateRoleCards({ device: 'device-A', agents: ['worker'], events, now: 200, shadow: false })[0]!.shadow).toBe(false);
  });
});
