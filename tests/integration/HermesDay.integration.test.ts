// Hermes 的一天：端到端场景（phase-4-plan 4.5）
//
// 设备 A：导入既有记忆（MEMORY.md / USER.md / skills / sessions）
//   → 一次会话抽取（extractMemory → storeExtraction）
//   → storeMemory 写入偏好/事实/观察
//   → 经 InMemoryHub 与设备 B 自动同步
// 设备 B：retrieveMemory / getUserProfile / getConversationHistory / searchMemory
//   得到同一视图；且 B 重复导入同一目录时跨设备幂等（零新节点）。
//
// libp2p 决策：本阶段语义验证在 InMemoryHub 完成；真实网络验证降级为 M5 前置
// （门面已在配置 libp2p 占位时诚实报错 NETWORK_LIBP2P_NOT_AVAILABLE）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { HermesImporter } from '../../src/hermes/import/HermesImporter.js';
import { HermesMemoryProvider } from '../../src/hermes/HermesMemoryProvider.js';
import type { HermesSessionData } from '../../src/hermes/types.js';
import type { SyncResult } from '../../src/sync/syncmgr/SyncManager.js';

const MEMORY_MD = `# 长期记忆

用户偏好与项目事实。

## 偏好
- 喜欢深色主题
`;

const USER_MD = `# 用户

- 名字是 Arikan
`;

const SKILL_MD = `# 部署技能

把服务部署到生产环境。

## 步骤
1. 构建产物
`;

const SESSION_S1: HermesSessionData = {
  sessionId: 's1',
  userId: 'user',
  messages: [
    { role: 'user', content: '今天整理一下记忆', timestamp: 1 },
    { role: 'assistant', content: '好的，开始整理。', timestamp: 2 },
  ],
  startTime: 1,
  endTime: 2,
};

const SESSION_S2: HermesSessionData = {
  sessionId: 's2',
  userId: 'user',
  messages: [
    { role: 'user', content: '帮我把部署流程记下来', timestamp: 100 },
    { role: 'assistant', content: '好的，已记录部署技能。', timestamp: 101 },
  ],
  startTime: 100,
  endTime: 101,
};

describe('Hermes 的一天（端到端）', () => {
  let dir: string;
  let hermesDir: string;
  let master: { publicKey: Uint8Array; privateKey: CryptoKey };
  // afterEach 统一关停，断言失败路径也不留悬挂句柄
  const facades: Mebular[] = [];
  const makeFacade = (storagePath: string, deviceId: string, hub: InMemoryHub): Mebular => {
    const m = new Mebular({
      storagePath,
      deviceId,
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: { enabled: true, provider: hub },
      sync: { autoSync: true },
    });
    facades.push(m);
    return m;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-hermes-day-'));
    hermesDir = join(dir, 'hermes-data');
    await mkdir(join(hermesDir, 'skills', 'deploy'), { recursive: true });
    await mkdir(join(hermesDir, 'sessions'), { recursive: true });
    await writeFile(join(hermesDir, 'MEMORY.md'), MEMORY_MD, 'utf-8');
    await writeFile(join(hermesDir, 'USER.md'), USER_MD, 'utf-8');
    await writeFile(join(hermesDir, 'skills', 'deploy', 'SKILL.md'), SKILL_MD, 'utf-8');
    await writeFile(join(hermesDir, 'sessions', 's1.json'), JSON.stringify(SESSION_S1), 'utf-8');
    master = await new IdentityManager().generateUserMasterKey();
  });

  afterEach(async () => {
    for (const m of facades.splice(0)) {
      await m.shutdown();
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('A 导入与写入 → 同步 → B 同视图；B 重复导入跨设备幂等', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade(join(dir, 'a.jsonl'), 'device-A', hub);
    const b = makeFacade(join(dir, 'b.jsonl'), 'device-B', hub);
    await a.initialize();
    await b.initialize();

    const providerA = new HermesMemoryProvider(a);
    const importerA = new HermesImporter(new MemoryStore(a.graph));

    // ---- 设备 A 的一天 ----

    // 1) 导入既有记忆（2 实体 + 2 事实 + 1 技能 + 1 会话情节）
    const report = await importerA.importHermesDirectory(hermesDir);
    expect(report.entities.filter((i) => i.created)).toHaveLength(2);
    expect(report.facts.filter((i) => i.created)).toHaveLength(2);
    expect(report.skills.filter((i) => i.created)).toHaveLength(1);
    expect(report.episodes.filter((i) => i.created)).toHaveLength(1);

    // 2) 一次会话抽取并落图（浅抽取：会话 → 情节原文）
    const extraction = await providerA.extractMemory(SESSION_S2);
    const stored = await providerA.storeExtraction(extraction);
    expect(stored.map((s) => s.type)).toEqual(['episode']);

    // 3) storeMemory：偏好 / 事实 / 观察
    await providerA.storeMemory({
      type: 'preference',
      content: '深色主题',
      metadata: { preferenceType: 'theme', confidence: 0.9 },
    });
    await providerA.storeMemory({ type: 'fact', content: '周五提交 Phase 4 报告' });
    await providerA.storeMemory({ type: 'observation', content: '用户上午专注度较高' });

    // ---- 同步 ----
    const syncedA = new Promise<SyncResult>((resolve) => a.sync.once('sync-completed', resolve));
    const syncedB = new Promise<SyncResult>((resolve) => b.sync.once('sync-completed', resolve));
    await b.node!.connectToPeer(a.node!.peerId);
    await Promise.all([syncedA, syncedB]);

    // ---- 设备 B 同视图 ----
    const providerB = new HermesMemoryProvider(b);

    // 偏好检索：storeMemory 写入的偏好已同步（fact 渲染为「主语 谓词 宾语」）
    const prefs = await providerB.retrieveMemory({ types: ['preference'] });
    expect(prefs.memories.some((m) => m.content.includes('深色主题'))).toBe(true);

    // 用户画像：USER.md 实体属性 + 活跃偏好事实
    const profile = await providerB.getUserProfile();
    expect(profile.properties['source']).toBe(join(hermesDir, 'USER.md'));
    expect(profile.preferences.map((p) => `${p.type}:${p.value}`)).toContain('theme:深色主题');

    // 会话历史：导入的 s1 + 抽取的 s2
    const history = await providerB.getConversationHistory({});
    expect(history.episodes.map((e) => e.content.context)).toEqual(
      expect.arrayContaining(['s1', 's2']),
    );

    // 检索：导入条目与偏好事实同时命中；includeRelations 带出出处边
    const search = await providerB.searchMemory({ query: '深色主题', includeRelations: true });
    expect(search.memories.length).toBeGreaterThanOrEqual(2);
    expect(search.relations.some((r) => r.edgeType === 'source_of')).toBe(true);

    // 观察（虚拟类型展开为 observation 情节）
    const observations = await providerB.retrieveMemory({ types: ['observation'] });
    expect(observations.memories.some((m) => m.content.includes('用户上午专注度较高'))).toBe(true);

    // ---- 跨设备幂等：B 重复导入同一目录，零新节点 ----
    const nodesBefore = (await b.graph.listNodes({})).length;
    const reportB = await new HermesImporter(new MemoryStore(b.graph)).importHermesDirectory(hermesDir);
    expect(reportB.skipped).toBe(6); // 2 实体 + 2 事实 + 1 技能 + 1 情节
    expect(
      [...reportB.entities, ...reportB.facts, ...reportB.skills, ...reportB.episodes]
        .every((i) => !i.created),
    ).toBe(true);
    expect((await b.graph.listNodes({})).length).toBe(nodesBefore);
  });
});
