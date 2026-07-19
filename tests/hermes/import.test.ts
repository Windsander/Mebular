// Hermes 既有记忆导入器测试（phase-4-plan 4.4）
//
// 样例目录树驱动：MEMORY.md / USER.md / skills/<dir>/SKILL.md / sessions/*.json
// 断言节点映射、source_of 出处边、重复导入幂等、内容追加的增量导入。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { EdgeTypes, type EntityContent, type EpisodeContent, type FactNode, type SkillContent } from '../../src/memory/types.js';
import { HermesImporter } from '../../src/hermes/import/HermesImporter.js';
import { ValidationError } from '../../src/errors.js';
import type { HermesSessionData } from '../../src/hermes/types.js';

const MEMORY_MD = `# 长期记忆

用户的基本偏好与事实。

## 偏好
- 喜欢深色主题
- 使用繁体中文

## 项目
- Mebular 是本地优先记忆库
`;

const USER_MD = `# 用户

- 名字是 Arikan
- 职业是开发者
`;

const SKILL_MD = `# 部署技能

把服务部署到生产环境的流程。

## 步骤
1. 构建产物
2. 上传服务器

## 命令
\`\`\`
npm run build
scp -r dist server:/app
\`\`\`
`;

const SESSION_S1: HermesSessionData = {
  sessionId: 's1',
  userId: 'user',
  messages: [
    { role: 'user', content: '你好', timestamp: 1 },
    { role: 'assistant', content: '你好！有什么可以帮你？', timestamp: 2 },
  ],
  startTime: 1,
  endTime: 2,
};

describe('HermesImporter', () => {
  let root: string;
  let storage: MemoryStorage;
  let eventLog: EventLog;
  let graph: GraphStore;
  let memory: MemoryStore;
  let importer: HermesImporter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mebular-hermes-import-'));
    await mkdir(join(root, 'skills', 'deploy'), { recursive: true });
    await mkdir(join(root, 'sessions'), { recursive: true });
    await writeFile(join(root, 'MEMORY.md'), MEMORY_MD, 'utf-8');
    await writeFile(join(root, 'USER.md'), USER_MD, 'utf-8');
    await writeFile(join(root, 'skills', 'deploy', 'SKILL.md'), SKILL_MD, 'utf-8');
    await writeFile(join(root, 'sessions', 's1.json'), JSON.stringify(SESSION_S1), 'utf-8');

    storage = new MemoryStorage();
    eventLog = new EventLog(storage, 'device-A');
    graph = new GraphStore({ storage, author: 'device-A', eventLog });
    memory = new MemoryStore(graph);
    importer = new HermesImporter(memory);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('整树导入：文档实体 / 条目事实 / 技能 / 会话情节全部落图', async () => {
    const report = await importer.importHermesDirectory(root);

    expect(report.entities.filter((e) => e.created)).toHaveLength(2);
    expect(report.facts.filter((f) => f.created)).toHaveLength(5);
    expect(report.skills.filter((s) => s.created)).toHaveLength(1);
    expect(report.episodes.filter((e) => e.created)).toHaveLength(1);
    expect(report.skipped).toBe(0);

    // 文档实体：USER.md 锚定 user 实体（getUserProfile 的锚点），MEMORY.md 为 other
    const entities = await memory.listByType('entity');
    const contents = entities.map((n) => n.content as unknown as EntityContent);
    const userEntity = contents.find((c) => c.entityType === 'user');
    expect(userEntity?.name).toBe('user');
    expect(userEntity?.properties?.['source']).toBe(join(root, 'USER.md'));
    const memoryDoc = contents.find((c) => c.entityType === 'other');
    expect(memoryDoc?.name).toBe('长期记忆');
    expect(memoryDoc?.description).toBe('用户的基本偏好与事实。');

    // 条目事实：谓词取小节标题，source 记录文件路径
    const facts = (await memory.listByType('fact')) as FactNode[];
    const byPredicate = new Map<string, string[]>();
    for (const fact of facts) {
      const list = byPredicate.get(fact.content.predicate) ?? [];
      list.push(fact.content.object);
      byPredicate.set(fact.content.predicate, list);
    }
    expect(byPredicate.get('偏好')).toEqual(['喜欢深色主题', '使用繁体中文']);
    expect(byPredicate.get('项目')).toEqual(['Mebular 是本地优先记忆库']);
    expect(byPredicate.get('用户')).toEqual(['名字是 Arikan', '职业是开发者']);
    for (const fact of facts) {
      expect(fact.content.source).toMatch(/(MEMORY|USER)\.md$/);
    }

    // 出处边：文档实体 → 事实
    const memoryEntity = entities.find(
      (n) => (n.content as unknown as EntityContent).name === '长期记忆',
    )!;
    const sourceEdges = await graph.listEdges({ source: memoryEntity.id, relation: EdgeTypes.SOURCE_OF });
    expect(sourceEdges).toHaveLength(3);

    // 技能：标题/描述/步骤/命令
    const skills = await memory.listByType('skill');
    expect(skills).toHaveLength(1);
    const skill = skills[0]!.content as unknown as SkillContent;
    expect(skill.name).toBe('部署技能');
    expect(skill.description).toBe('把服务部署到生产环境的流程。');
    expect(skill.category).toBe('imported');
    expect(skill.steps).toEqual(['构建产物', '上传服务器']);
    expect(skill.commands).toEqual(['npm run build\nscp -r dist server:/app']);

    // 会话情节：conversation 型，含原文与 contentHash
    const episodes = await memory.listByType('episode');
    expect(episodes).toHaveLength(1);
    const episode = episodes[0]!.content as unknown as EpisodeContent;
    expect(episode.episodeType).toBe('conversation');
    expect(episode.content).toBe('user: 你好\nassistant: 你好！有什么可以帮你？');
    expect(episode.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(episode.context).toBe('s1');
  });

  it('重复导入幂等：不产生重复节点', async () => {
    await importer.importHermesDirectory(root);
    const before = await graph.listNodes({});

    const second = await importer.importHermesDirectory(root);
    expect(second.entities.every((e) => !e.created)).toBe(true);
    expect(second.facts.every((f) => !f.created)).toBe(true);
    expect(second.skills.every((s) => !s.created)).toBe(true);
    expect(second.episodes.every((e) => !e.created)).toBe(true);
    expect(second.skipped).toBe(9); // 2 实体 + 5 事实 + 1 技能 + 1 情节

    const after = await graph.listNodes({});
    expect(after).toHaveLength(before.length);
  });

  it('内容追加可增量导入：新条目建事实，文档实体按路径身份复用', async () => {
    await importer.importHermesDirectory(root);
    await appendFile(join(root, 'MEMORY.md'), '\n## 饮食\n- 喜欢喝咖啡\n', 'utf-8');

    const report = await importer.importHermesDirectory(root);
    const createdFacts = report.facts.filter((f) => f.created);
    expect(createdFacts).toHaveLength(1);
    expect(report.entities.every((e) => !e.created)).toBe(true);

    const facts = (await memory.listByType('fact')) as FactNode[];
    const diet = facts.filter((f) => f.content.predicate === '饮食');
    expect(diet.map((f) => f.content.object)).toEqual(['喜欢喝咖啡']);
    expect(diet[0]!.content.subject).toBe('长期记忆');
  });

  it('直接导入 HermesSessionData：幂等且与文件路径导入同构', async () => {
    const first = await importer.importSession(SESSION_S1);
    expect(first.episodes[0]!.created).toBe(true);

    const second = await importer.importSession(SESSION_S1);
    expect(second.episodes[0]!.created).toBe(false);
    expect(second.episodes[0]!.id).toBe(first.episodes[0]!.id);

    expect(await memory.listByType('episode')).toHaveLength(1);
  });

  it('损坏的会话文件诚实报错（ValidationError 指明文件）', async () => {
    await writeFile(join(root, 'sessions', 'broken.json'), '{ not json', 'utf-8');
    const attempt = importer.importSessionsDirectory(join(root, 'sessions'));
    // 先挂期望再 await，避免未处理拒绝
    await expect(attempt).rejects.toThrow(ValidationError);
    await expect(
      importer.importSessionsDirectory(join(root, 'sessions')),
    ).rejects.toThrow(/broken\.json/);
  });
});
