// 0.3.0 召回质量验收矩阵。
//
// 固定 fixture + fake capability（可选词法过滤）驱动真实 RecallService：
// - 宽泛主题只给 gist；数字/日期/端口/版本/命令/路径/原文/追问才展开；
// - 无命中/闲聊/否定/过期/归档沉默；冲突成组；跨设备无 Raw 诚实降级；
// - 统计 precision、详情正确率、false recall、capability 调用预算与字节/token 预算。
//
// 不启动真实 MCP/core、不访问网络、不下载模型。矩阵结果在测试末尾打印。

import { describe, it, expect, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import { ACCEPTANCE_THREAD, NOW, DAY_MS, acceptancePolicy, acceptanceRecord, createAcceptanceHarness, type AcceptanceHarness } from './acceptance-fixtures.js';
import type { FakeCompact, FakeMemoryRecord } from './fake-capability.js';
import type { ContextResponse, MemoryFragment } from '../../src/sidecar/recall.js';
import type { RawChunk } from '../../src/runtime/types.js';

const AGENT = 'opencode';
const LONG_EPISODE = [
  '部署失败复盘：迁移脚本先删除索引再重建，回滚步骤没有等待副本同步完成。',
  '随后发布窗口被锁住，回滚命令没有在副本健康检查通过后执行。',
  '最终决定把发布拆成预检、迁移、验证、回滚四步，并保留完整命令。',
].join('').repeat(12);

const VERBATIM_TEXT = '我当时说的是：先冻结契约，再迁移 runtime，不要先改宿主。';
const CROSS_DEVICE_TEXT = '我在设备 A 上说过：跨设备只认已沉降记录，不伪造原文。';

function prov(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'runtime',
    writerType: 'agent',
    writerId: 'opencode',
    extractor: 'heuristic',
    model: null,
    version: '0.3.0',
    deviceId: 'device-local',
    hostId: 'h_accept',
    threadId: ACCEPTANCE_THREAD,
    agentId: 'opencode',
    agentName: 'OpenCode',
    confirmation: 'none',
    at: NOW - DAY_MS,
    ...overrides,
  };
}

const prefTheme = acceptanceRecord({
  id: '01JACCPREFTHM',
  type: 'fact',
  kind: 'preference',
  domain: 'user',
  content: { entity: 'user', preferenceType: 'theme', value: 'dark', confidence: 0.92 },
  text: '用户偏好：主题=dark',
  tags: ['preference', '偏好', '主题', '喜好'],
  provenance: prov({ confirmation: 'explicit', extractor: 'host', model: 'host-provided' }),
});

const prefLanguage = acceptanceRecord({
  id: '01JACCPREFLAN',
  type: 'fact',
  kind: 'preference',
  domain: 'user',
  content: { entity: 'user', preferenceType: 'language', value: 'zh', confidence: 0.9 },
  text: '用户偏好：语言=zh',
  tags: ['preference', '偏好', '语言', '喜好'],
  provenance: prov({ confirmation: 'explicit', extractor: 'host', model: 'host-provided' }),
});

const projectEpisode = acceptanceRecord({
  id: '01JACCPROJECT',
  type: 'episode',
  kind: 'episode',
  domain: 'agent:opencode',
  content: {
    episodeType: 'task',
    title: 'Mebular 0.3 项目计划',
    content: '我们聊过 Mebular 项目要拆出 Memory Runtime sidecar，先冻结契约再迁移。',
    startTime: NOW - 2 * DAY_MS,
  },
  text: 'Mebular 0.3 项目计划',
  tags: ['聊过', '项目', 'mebular'],
});

const portFact = acceptanceRecord({
  id: '01JACCPORT7331',
  type: 'fact',
  kind: 'fact',
  domain: 'agent:opencode',
  content: { subject: 'mebular', predicate: 'localPort', object: '7331', confidence: 0.9 },
  text: 'mebular 本地端口 localPort=7331',
  tags: ['端口', 'mebular'],
});

const portDistractor = acceptanceRecord({
  id: '01JACCPORT9000',
  type: 'fact',
  kind: 'fact',
  domain: 'default',
  content: { subject: 'legacy-service', predicate: 'localPort', object: '9000', confidence: 0.3 },
  text: 'legacy-service 本地端口 localPort=9000',
  tags: ['端口'],
  provenance: prov({ threadId: 'th_other', deviceId: 'device-old' }),
  validFrom: NOW - 365 * DAY_MS,
  createdAt: NOW - 365 * DAY_MS,
  updatedAt: NOW - 365 * DAY_MS,
});

const releaseDateFact = acceptanceRecord({
  id: '01JACCDATE1030',
  type: 'fact',
  kind: 'fact',
  domain: 'agent:opencode',
  content: { subject: 'mebular', predicate: 'releaseDate', object: '2026-10-30', confidence: 0.9 },
  text: 'mebular 发布日期 2026-10-30',
  tags: ['日期', '发布'],
});

const nearMissDate = acceptanceRecord({
  id: '01JACCDATE2024',
  type: 'fact',
  kind: 'fact',
  domain: 'default',
  content: { subject: 'legacy', predicate: 'releaseDate', object: '2024-01-01', confidence: 0.3 },
  text: 'legacy 发布日期 2024-01-01',
  tags: ['日期'],
  provenance: prov({ threadId: 'th_other', deviceId: 'device-old' }),
  validFrom: NOW - 365 * DAY_MS,
  createdAt: NOW - 365 * DAY_MS,
  updatedAt: NOW - 365 * DAY_MS,
});

const versionFact = acceptanceRecord({
  id: '01JACCVERSION03',
  type: 'fact',
  kind: 'fact',
  domain: 'agent:opencode',
  content: { subject: 'mebular', predicate: 'version', object: '0.3.0', confidence: 0.9 },
  text: 'mebular 版本 0.3.0',
  tags: ['版本'],
});

const nearMissVersion = acceptanceRecord({
  id: '01JACCVERSION02',
  type: 'fact',
  kind: 'fact',
  domain: 'default',
  content: { subject: 'legacy', predicate: 'version', object: '0.2.0', confidence: 0.3 },
  text: 'legacy 旧版本 0.2.0',
  tags: ['版本'],
  provenance: prov({ threadId: 'th_other', deviceId: 'device-old' }),
  validFrom: NOW - 365 * DAY_MS,
  createdAt: NOW - 365 * DAY_MS,
  updatedAt: NOW - 365 * DAY_MS,
});

const deploySkill = acceptanceRecord({
  id: '01JACCDEPLOY',
  type: 'skill',
  kind: 'skill',
  domain: 'agent:opencode',
  content: {
    name: 'release',
    description: '发布 Mebular 新版本',
    steps: ['运行测试', '构建', '发布'],
    commands: ['pnpm release --tag 0.3.0'],
  },
  text: '部署命令：pnpm release --tag 0.3.0',
  tags: ['部署', '命令', 'deploy', 'skill'],
});

const distractorSkill = acceptanceRecord({
  id: '01JACCOLDEPLOY',
  type: 'skill',
  kind: 'skill',
  domain: 'default',
  content: { name: 'legacy release', description: '旧发布脚本', commands: ['npm publish'] },
  text: '旧发布脚本：npm publish',
  tags: ['部署', '命令'],
  provenance: prov({ threadId: 'th_other', deviceId: 'device-old' }),
  validFrom: NOW - 365 * DAY_MS,
  createdAt: NOW - 365 * DAY_MS,
  updatedAt: NOW - 365 * DAY_MS,
});

const pathFact = acceptanceRecord({
  id: '01JACCPATH',
  type: 'fact',
  kind: 'fact',
  domain: 'agent:opencode',
  content: { subject: 'mebular', predicate: 'deployScript', object: '/opt/mebular/deploy.sh', confidence: 0.9 },
  text: '部署脚本路径 /opt/mebular/deploy.sh',
  tags: ['路径', '部署', '脚本'],
});

const distractorPath = acceptanceRecord({
  id: '01JACCOLDPATH',
  type: 'fact',
  kind: 'fact',
  domain: 'default',
  content: { subject: 'legacy', predicate: 'deployScript', object: '/tmp/old.sh', confidence: 0.3 },
  text: '旧脚本路径 /tmp/old.sh',
  tags: ['路径'],
  provenance: prov({ threadId: 'th_other', deviceId: 'device-old' }),
  validFrom: NOW - 365 * DAY_MS,
  createdAt: NOW - 365 * DAY_MS,
  updatedAt: NOW - 365 * DAY_MS,
});

const verbatimEpisode = acceptanceRecord({
  id: '01JACCVERBATIM',
  type: 'episode',
  kind: 'episode',
  domain: 'agent:opencode',
  content: { episodeType: 'conversation', title: '原话记录', content: VERBATIM_TEXT, startTime: NOW - DAY_MS },
  text: VERBATIM_TEXT,
  tags: ['原话', '原文'],
  provenance: prov({ messageIds: ['m_verbatim'], rawChunkIds: ['rc_verbatim'] }),
});

const crossDeviceEpisode = acceptanceRecord({
  id: '01JACCCROSS',
  type: 'episode',
  kind: 'episode',
  domain: 'agent:opencode',
  content: { episodeType: 'conversation', title: '跨设备原话', content: CROSS_DEVICE_TEXT, startTime: NOW - 2 * DAY_MS },
  text: CROSS_DEVICE_TEXT,
  tags: ['原话', '原文', '跨设备'],
  provenance: prov({
    deviceId: 'device-a',
    hostId: 'h_device_a',
    messageIds: ['m_remote'],
    rawChunkIds: ['rc_remote_device'],
  }),
});

const planEpisode = acceptanceRecord({
  id: '01JACCPLAN',
  type: 'episode',
  kind: 'episode',
  domain: 'agent:opencode',
  content: {
    episodeType: 'decision',
    title: '召回方案',
    content: '那个方案后来改成碎片化召回：先给 gist，再按意图展开详情。',
    startTime: NOW - DAY_MS,
  },
  text: '召回方案',
  tags: ['方案', '召回'],
});

const whyEpisode = acceptanceRecord({
  id: '01JACCWHY',
  type: 'episode',
  kind: 'episode',
  domain: 'agent:opencode',
  content: {
    episodeType: 'decision',
    title: '选择 SQLite',
    content: '为什么选 SQLite：本地单文件、事务可靠、无需额外服务。',
    startTime: NOW - 3 * DAY_MS,
  },
  text: '选择 SQLite',
  tags: ['为什么', 'SQLite', '决策'],
});

const conflictPort7331 = acceptanceRecord({
  id: '01JACCCONFLICT1',
  type: 'fact',
  kind: 'fact',
  domain: 'agent:opencode',
  content: { subject: 'mebular', predicate: 'localPort', object: '7331', confidence: 0.9 },
  text: 'mebular localPort 7331',
  tags: ['端口', '7331'],
});

const conflictPort7332 = acceptanceRecord({
  id: '01JACCCONFLICT2',
  type: 'fact',
  kind: 'fact',
  domain: 'agent:opencode',
  content: { subject: 'mebular', predicate: 'localPort', object: '7332', confidence: 0.9 },
  text: 'mebular localPort 7332',
  tags: ['端口', '7332'],
});

const hermesEpisode = acceptanceRecord({
  id: '01JACCHERMES',
  type: 'episode',
  kind: 'episode',
  domain: 'agent:hermes',
  content: {
    episodeType: 'task',
    title: 'Hermes 任务记忆',
    content: 'Hermes 说先合并 sidecar 边界，再做召回。',
    startTime: NOW - DAY_MS,
  },
  text: 'Hermes 任务记忆',
  tags: ['Hermes', '任务', '说什么'],
  provenance: prov({
    writerId: 'hermes',
    agentId: 'hermes',
    agentName: 'Hermes',
    deviceId: 'device-hermes',
    hostId: 'h_hermes',
    threadId: 'th_hermes',
  }),
});

const staleFact = acceptanceRecord({
  id: '01JACCTALEFACT',
  type: 'fact',
  kind: 'fact',
  domain: 'agent:opencode',
  content: { subject: 'mebular', predicate: 'localPort', object: '7000', confidence: 0.9 },
  text: '旧端口 7000（已过期）',
  tags: ['端口', '旧'],
  validTo: NOW - DAY_MS,
});

const archivedEpisode = acceptanceRecord({
  id: '01JACCARCHIVED',
  type: 'episode',
  kind: 'episode',
  domain: 'agent:opencode',
  content: { episodeType: 'task', title: '归档的部署记录', content: '这条部署记录已归档。' },
  text: '归档的部署记录',
  tags: ['部署', '归档'],
  metadata: { archivedAt: NOW - DAY_MS },
});

const observationTheme = acceptanceRecord({
  id: '01JACCOBSERVE',
  type: 'fact',
  kind: 'observation',
  domain: 'agent:opencode',
  content: { content: '用户可能喜欢浅色主题，但未确认。', confidence: 0.45 },
  text: '用户可能喜欢浅色主题，但未确认。',
  tags: ['主题', '观察', '偏好'],
});

const mixedSkill = acceptanceRecord({
  id: '01JACCMIXED',
  type: 'skill',
  kind: 'skill',
  domain: 'agent:opencode',
  content: { name: 'deploy', description: '部署到生产', commands: ['pnpm deploy --env prod'] },
  text: 'deploy 命令：pnpm deploy --env prod',
  tags: ['部署', '命令', 'deploy', 'skill'],
});

const longEpisode = acceptanceRecord({
  id: '01JACCLONG',
  type: 'episode',
  kind: 'episode',
  domain: 'agent:opencode',
  content: { episodeType: 'error', title: '部署失败复盘', content: LONG_EPISODE, startTime: NOW - DAY_MS },
  text: LONG_EPISODE,
  tags: ['部署', '为什么', '复盘'],
});

const unrelatedFact = acceptanceRecord({
  id: '01JACCWEATHER',
  type: 'fact',
  kind: 'fact',
  domain: 'default',
  content: { subject: 'weather', predicate: 'today', object: 'sunny', confidence: 0.7 },
  text: '今天天气晴朗',
  tags: ['天气'],
});

const changeEpisode = acceptanceRecord({
  id: '01JACCCHANGE',
  type: 'episode',
  kind: 'episode',
  domain: `task:${ACCEPTANCE_THREAD}`,
  content: {
    episodeType: 'task',
    title: '上周变更',
    content: '上周修改了召回预算和 trace 环形保留。',
    startTime: NOW - 3 * DAY_MS,
  },
  text: '上周变更',
  tags: ['上周', '变更'],
});

const staleCompact: FakeCompact = {
  id: '01JACCSTALECOMPACT',
  domain: 'user',
  summary: '旧摘要：mebular 本地端口=7000，但源记录已变更。',
  sourceIds: ['01JACCTALEFACT'],
  stale: true,
  createdAt: NOW - 10 * DAY_MS,
  updatedAt: NOW - 10 * DAY_MS,
};

type DetailExpectation = 'none' | 'expand' | 'verbatim' | 'missing_cross_device' | 'conflict' | 'truncated';

interface ScenarioRequest {
  maxFragments?: number;
  maxBytes?: number;
  tokenBudget?: number;
  domains?: string[];
  includeOtherAgents?: boolean;
}

interface QualityScenario {
  id: string;
  name: string;
  query: string;
  records: FakeMemoryRecord[];
  compacts?: FakeCompact[];
  rawText?: { id: string; messageId: string; text: string };
  request?: ScenarioRequest;
  expected: {
    relevant: string[];
    silence?: string[];
    detail: DetailExpectation;
    require?: string[];
    ownerDomain?: string;
    minFragments?: number;
    maxFragments?: number;
    noText?: string[];
  };
  maxCalls?: number;
}

function scenarios(): QualityScenario[] {
  return [
    {
      id: 'Q01', name: '宽泛偏好 → gist', query: '你记得我的喜好吗？',
      records: [prefTheme, prefLanguage],
      expected: { relevant: [prefTheme.id, prefLanguage.id], detail: 'none', minFragments: 1, maxFragments: 2 },
    },
    {
      id: 'Q02', name: '宽泛项目回忆 → gist', query: '我们之前聊过什么？',
      records: [projectEpisode],
      expected: { relevant: [projectEpisode.id], detail: 'none', minFragments: 1, maxFragments: 2 },
    },
    {
      id: 'Q03', name: '端口精确值 → expand', query: '本地端口是多少？',
      records: [portFact, portDistractor],
      request: { maxFragments: 1 },
      expected: { relevant: [portFact.id], detail: 'expand', require: ['7331'], maxFragments: 1 },
    },
    {
      id: 'Q04', name: '日期精确值 → expand', query: '发布日期是哪天？',
      records: [releaseDateFact, nearMissDate],
      request: { maxFragments: 1 },
      expected: { relevant: [releaseDateFact.id], detail: 'expand', require: ['2026-10-30'], maxFragments: 1 },
    },
    {
      id: 'Q05', name: '版本号 → expand', query: '上次那个版本号是多少？',
      records: [versionFact, nearMissVersion],
      request: { maxFragments: 1 },
      expected: { relevant: [versionFact.id], detail: 'expand', require: ['0.3.0'], maxFragments: 1 },
    },
    {
      id: 'Q06', name: '部署命令 → expand', query: '上次那个部署命令是什么？',
      records: [deploySkill, distractorSkill],
      request: { maxFragments: 1 },
      expected: { relevant: [deploySkill.id], detail: 'expand', require: ['pnpm release --tag 0.3.0'], maxFragments: 1 },
    },
    {
      id: 'Q07', name: '脚本路径 → expand', query: '部署脚本的路径在哪？',
      records: [pathFact, distractorPath],
      request: { maxFragments: 1 },
      expected: { relevant: [pathFact.id], detail: 'expand', require: ['/opt/mebular/deploy.sh'], maxFragments: 1 },
    },
    {
      id: 'Q08', name: '本机原文 → verbatim', query: '我当时原话怎么说的？',
      records: [verbatimEpisode],
      rawText: { id: 'rc_verbatim', messageId: 'm_verbatim', text: VERBATIM_TEXT },
      expected: { relevant: [verbatimEpisode.id], detail: 'verbatim', require: [VERBATIM_TEXT] },
    },
    {
      id: 'Q09', name: '跨设备无 Raw → 诚实降级', query: '我当时原话怎么说的？',
      records: [crossDeviceEpisode],
      expected: { relevant: [crossDeviceEpisode.id], detail: 'missing_cross_device', require: ['原文仅保留在写入设备'] },
    },
    {
      id: 'Q10', name: '追问“那个方案” → expand', query: '那个方案后来呢？',
      records: [planEpisode],
      expected: { relevant: [planEpisode.id], detail: 'expand', require: ['碎片化召回'] },
    },
    {
      id: 'Q11', name: '为什么/决策 → expand', query: '为什么选 SQLite？',
      records: [whyEpisode],
      expected: { relevant: [whyEpisode.id], detail: 'expand', require: ['SQLite'] },
    },
    {
      id: 'Q12', name: '冲突事实 → 成组展开', query: '到底用 7331 还是 7332？',
      records: [conflictPort7331, conflictPort7332],
      request: { maxFragments: 3 },
      expected: {
        relevant: [conflictPort7331.id, conflictPort7332.id],
        detail: 'conflict', require: ['7331', '7332'], minFragments: 2, maxFragments: 2,
      },
    },
    {
      id: 'Q13', name: '其他 Agent → 归属不冒充自己', query: 'Hermes 上次说什么？',
      records: [hermesEpisode],
      request: { includeOtherAgents: true },
      expected: { relevant: [hermesEpisode.id], detail: 'expand', require: ['Hermes'], ownerDomain: 'agent:hermes' },
    },
    {
      id: 'Q14', name: '无关 query → 沉默', query: '量子纠缠的退相干时间是多少？',
      records: [unrelatedFact],
      expected: { relevant: [], silence: ['no_hits'], detail: 'none', maxFragments: 0 },
    },
    {
      id: 'Q15', name: '闲聊 → 沉默', query: '你好',
      records: [prefTheme],
      expected: { relevant: [], silence: ['chitchat'], detail: 'none', maxFragments: 0 },
    },
    {
      id: 'Q16', name: '否定 → 沉默', query: '别用记忆回答我的偏好',
      records: [prefTheme],
      expected: { relevant: [], silence: ['user_negated'], detail: 'none', maxFragments: 0 },
    },
    {
      id: 'Q17', name: '过期事实 → 排除', query: '旧端口是多少？',
      records: [staleFact],
      expected: { relevant: [], silence: ['only_stale'], detail: 'none', maxFragments: 0 },
    },
    {
      id: 'Q18', name: 'stale compact → 排除', query: '本地端口是多少？',
      records: [],
      compacts: [staleCompact],
      expected: { relevant: [], silence: ['only_stale'], detail: 'none', maxFragments: 0 },
    },
    {
      id: 'Q19', name: '归档记录 → 排除', query: '归档的部署记录是什么？',
      records: [archivedEpisode],
      expected: { relevant: [], silence: ['no_hits'], detail: 'none', maxFragments: 0 },
    },
    {
      id: 'Q20', name: '中英混合命令 → expand', query: '上次那个 deploy 命令是什么？',
      records: [mixedSkill],
      request: { maxFragments: 1 },
      expected: { relevant: [mixedSkill.id], detail: 'expand', require: ['pnpm deploy --env prod'], maxFragments: 1 },
    },
    {
      id: 'Q21', name: '用户偏好 vs Agent 观察', query: '我的主题偏好是什么？',
      records: [prefTheme, observationTheme],
      request: { maxFragments: 2 },
      expected: {
        relevant: [prefTheme.id, observationTheme.id],
        detail: 'expand', require: ['theme=dark'], ownerDomain: 'user', maxFragments: 2,
      },
    },
    {
      id: 'Q22', name: '精确值不匹配 → 不展开假值', query: '端口是 9999 吗？',
      records: [portFact],
      request: { maxFragments: 1 },
      expected: { relevant: [portFact.id], detail: 'none', noText: ['9999'], maxFragments: 1 },
    },
    {
      id: 'Q23', name: '小预算 → 截断但保留 citation', query: '上次部署为什么失败？',
      records: [longEpisode],
      request: { maxFragments: 1, maxBytes: 512, tokenBudget: 300 },
      expected: { relevant: [longEpisode.id], detail: 'truncated', minFragments: 1, maxFragments: 1 },
    },
    {
      id: 'Q24', name: '时间范围 → 只取范围内 gist/expand', query: '上周改了什么？',
      records: [changeEpisode],
      expected: { relevant: [changeEpisode.id], detail: 'expand', require: ['召回预算'] },
    },
    {
      id: 'Q25', name: '空记忆 → 沉默', query: 'Mebular 的端口是多少？',
      records: [],
      expected: { relevant: [], silence: ['no_hits'], detail: 'none', maxFragments: 0 },
    },
    {
      id: 'Q26', name: '冲突预算不足 → 整组不单边', query: '到底用 7331 还是 7332？',
      records: [conflictPort7331, conflictPort7332],
      request: { maxFragments: 1 },
      expected: { relevant: [], silence: ['conflict_over_budget'], detail: 'none', maxFragments: 0 },
    },
  ];
}

interface MatrixRow {
  id: string;
  name: string;
  expectedLayer: string;
  silence: string | null;
  fragments: number;
  relevant: number;
  precision: number;
  detailOk: boolean;
  calls: number;
  bytes: number;
  tokens: number;
}

const harnesses: AcceptanceHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

function putRaw(harness: AcceptanceHarness, raw: { id: string; messageId: string; text: string }): Promise<unknown> {
  const chunk: RawChunk = {
    schema: 1,
    id: raw.id,
    threadId: ACCEPTANCE_THREAD,
    agentId: AGENT,
    hostId: harness.identity.hostId,
    role: 'user',
    text: raw.text,
    mime: 'text/plain',
    at: NOW - DAY_MS,
    messageId: raw.messageId,
    chunkIndex: 0,
    contentHash: createHash('sha256').update(raw.text).digest('hex'),
    redaction: { applied: false, rules: [] },
    expiresAt: NOW + DAY_MS,
  };
  return harness.local.store.putRawChunk(harness.identity.cloudId, chunk);
}

function fragmentText(fragment: MemoryFragment): string {
  return [fragment.gist, fragment.detail?.text ?? ''].join('\n');
}

describe('0.3.0 acceptance: fragmented recall quality', () => {
  it('固定矩阵：precision、详情正确率、false recall、预算与调用次数', async () => {
    const harness = await createAcceptanceHarness({
      policy: acceptancePolicy(['agent:hermes']),
      filterQuery: true,
      traceMaxEntries: 200,
    });
    harnesses.push(harness);

    const rows: MatrixRow[] = [];
    const hardFailures: string[] = [];
    const detailFailures: string[] = [];
    const allScenarios = scenarios();
    expect(allScenarios.length).toBeGreaterThanOrEqual(20);

    for (const scenario of allScenarios) {
      harness.fake.setRecords(scenario.records);
      harness.fake.setCompacts(scenario.compacts ?? []);
      if (scenario.rawText) await putRaw(harness, scenario.rawText);

      const before = harness.fake.requests.length;
      const request = {
        agentId: AGENT,
        threadId: ACCEPTANCE_THREAD,
        turnId: `turn_${scenario.id}`,
        turnKind: 'human' as const,
        query: scenario.query,
        ...(scenario.request ?? {}),
      };
      const result = await harness.recall.handleContext(request);
      const data: ContextResponse = result.data;
      const calls = harness.fake.requests.slice(before);
      const callPaths = calls.map((call) => call.path.split('/').pop() ?? call.path);
      const fragments = data.fragments;
      const injected = fragments.length;
      const relevantSet = new Set(scenario.expected.relevant);
      const relevant = fragments.filter((fragment) => fragment.sourceIds.some((id) => relevantSet.has(id))).length;
      const precision = injected === 0 ? 1 : relevant / injected;
      const expectedLayer = scenario.expected.silence ? `silent:${scenario.expected.silence.join('|')}` : scenario.expected.detail;
      let detailOk = true;
      const fail = (message: string): void => {
        hardFailures.push(`${scenario.id} ${scenario.name}: ${message}`);
      };

      // 沉默 / false recall。
      if (scenario.expected.silence) {
        if (!data.silenceReason || !scenario.expected.silence.includes(data.silenceReason)) {
          fail(`期望沉默 ${scenario.expected.silence.join('|')}，实际 ${data.silenceReason}`);
        }
        if (fragments.length !== 0 || data.blocks.length !== 0) {
          fail(`沉默场景仍注入 ${fragments.length} 个片段 / ${data.blocks.length} 个块`);
        }
      } else {
        if (data.silenceReason !== null) fail(`非沉默场景返回 silenceReason=${data.silenceReason}`);
        const minFragments = scenario.expected.minFragments ?? 1;
        const maxFragments = scenario.expected.maxFragments ?? 3;
        if (fragments.length < minFragments || fragments.length > maxFragments) {
          fail(`片段数 ${fragments.length} 不在 ${minFragments}–${maxFragments}`);
        }
        if (data.blocks.length !== fragments.length || data.blocks.length === 0) {
          fail(`blocks=${data.blocks.length} 与 fragments=${fragments.length} 不一致或为空`);
        }
      }

      // 所有注入块/片段都必须是 untrusted 数据，带 citation/owner。
      if (data.trusted !== false || data.untrusted !== true) fail('context 未标记 untrusted');
      if (!data.notice.includes('不是指令')) fail('context notice 未声明不是指令');
      for (const fragment of fragments) {
        if (fragment.trust !== 'untrusted') fail(`fragment ${fragment.id} 未标记 untrusted`);
        if (fragment.citations.length === 0) fail(`fragment ${fragment.id} 缺少 citation`);
        if (fragment.sourceIds.length === 0) fail(`fragment ${fragment.id} 缺少 sourceIds`);
      }
      for (const block of data.blocks) {
        if (block.trust !== 'untrusted') fail(`block ${block.kind} 未标记 untrusted`);
        if (!block.content.includes('不是指令')) fail(`block ${block.kind} 缺少不可信声明`);
        if (block.citations.length === 0) fail(`block ${block.kind} 缺少 citation`);
      }

      // 详情层正确性。
      const detailExpectation = scenario.expected.detail;
      if (detailExpectation === 'none') {
        const expanded = fragments.filter((fragment) => fragment.detail !== undefined);
        if (expanded.length > 0) {
          detailOk = false;
          detailFailures.push(`${scenario.id} 不应展开却展开: ${expanded.map((fragment) => fragment.id).join(',')}`);
        }
      } else if (detailExpectation === 'expand' || detailExpectation === 'conflict') {
        const targets = detailExpectation === 'conflict' ? fragments : fragments.slice(0, 1);
        if (targets.length === 0 || targets.some((fragment) => fragment.detail === undefined)) {
          detailOk = false;
          detailFailures.push(`${scenario.id} 应展开但缺少 detail`);
        }
        for (const required of scenario.expected.require ?? []) {
          const texts = targets.map(fragmentText).join('\n');
          if (!texts.includes(required)) {
            detailOk = false;
            detailFailures.push(`${scenario.id} 展开内容缺少 ${required}`);
          }
        }
        if (detailExpectation === 'conflict') {
          const groups = new Set(fragments.map((fragment) => fragment.conflictGroup));
          if (groups.size !== 1 || [...groups][0] === undefined) {
            detailOk = false;
            detailFailures.push(`${scenario.id} 冲突片段未使用同一 conflictGroup`);
          }
        }
      } else if (detailExpectation === 'verbatim') {
        const top = fragments[0];
        if (!top?.detail || top.detail.format !== 'verbatim' || top.detail.text !== VERBATIM_TEXT) {
          detailOk = false;
          detailFailures.push(`${scenario.id} 原文未以 verbatim 返回`);
        }
      } else if (detailExpectation === 'missing_cross_device') {
        const top = fragments[0];
        if (!top?.detail || top.detail.format === 'verbatim'
          || !top.detail.availability.includes('missing_cross_device')
          || !top.detail.text.includes('原文仅保留在写入设备')) {
          detailOk = false;
          detailFailures.push(`${scenario.id} 跨设备无 Raw 未诚实降级`);
        }
      } else if (detailExpectation === 'truncated') {
        if (!data.truncated) {
          detailOk = false;
          detailFailures.push(`${scenario.id} 小预算未标记 truncated`);
        }
        const block = data.blocks[0];
        if (!block || block.citations.length === 0 || !block.owner?.domain) {
          detailOk = false;
          detailFailures.push(`${scenario.id} 截断后丢失 citation/owner`);
        }
      }

      if (scenario.expected.ownerDomain) {
        const actual = fragments[0]?.owner.domain;
        if (actual !== scenario.expected.ownerDomain) {
          detailOk = false;
          detailFailures.push(`${scenario.id} owner.domain=${actual}，期望 ${scenario.expected.ownerDomain}`);
        }
      }
      for (const forbidden of scenario.expected.noText ?? []) {
        if (fragments.some((fragment) => fragmentText(fragment).includes(forbidden))) {
          detailOk = false;
          detailFailures.push(`${scenario.id} 注入了不该出现的值 ${forbidden}`);
        }
      }

      // 预算：请求值 + 硬上限；context 的 estimate 与实际块一致。
      const maxBytes = Math.min(scenario.request?.maxBytes ?? 8192, 8192);
      const maxTokens = Math.min(scenario.request?.tokenBudget ?? 2000, 2000);
      const blockBytes = data.blocks.reduce((sum, block) => sum + block.bytes, 0);
      if (data.estimatedBytes > maxBytes || blockBytes > maxBytes) {
        fail(`字节 ${Math.max(data.estimatedBytes, blockBytes)} > 预算 ${maxBytes}`);
      }
      if (data.estimatedTokens > maxTokens) fail(`token ${data.estimatedTokens} > 预算 ${maxTokens}`);
      if (data.estimatedBytes > 8192 || data.estimatedTokens > 2000) fail('超过 8 KiB / 2000 token 硬上限');
      if (data.blocks.length > 3) fail(`注入块 ${data.blocks.length} > 3`);

      // capability 调用预算：每个通道最多一次、总次数受控、召回只读。
      if (calls.some((call) => call.path.endsWith('/write'))) fail('召回路径出现 capability 写请求');
      const counts = new Map<string, number>();
      for (const path of callPaths) counts.set(path, (counts.get(path) ?? 0) + 1);
      for (const [path, count] of counts) {
        if (count > 1) fail(`capability 通道 ${path} 调用 ${count} 次`);
      }
      if (calls.length > (scenario.maxCalls ?? 8)) fail(`capability 调用 ${calls.length} 次超预算`);
      if (counts.get('query') && (counts.get('query') ?? 0) > 1) fail('query 通道重复调用');
      if (counts.get('search') && (counts.get('search') ?? 0) > 1) fail('search 通道重复调用');

      rows.push({
        id: scenario.id,
        name: scenario.name,
        expectedLayer,
        silence: data.silenceReason,
        fragments: fragments.length,
        relevant,
        precision,
        detailOk,
        calls: calls.length,
        bytes: data.estimatedBytes,
        tokens: data.estimatedTokens,
      });
    }

    const totalInjected = rows.reduce((sum, row) => sum + row.fragments, 0);
    const totalRelevant = rows.reduce((sum, row) => sum + row.relevant, 0);
    const precision = totalInjected === 0 ? 1 : totalRelevant / totalInjected;
    const detailCorrect = rows.filter((row) => row.detailOk).length / rows.length;
    const falseRecall = rows
      .filter((row) => row.expectedLayer.startsWith('silent:'))
      .reduce((sum, row) => sum + row.fragments, 0);
    const maxCalls = Math.max(...rows.map((row) => row.calls));
    const maxBytes = Math.max(...rows.map((row) => row.bytes));
    const maxTokens = Math.max(...rows.map((row) => row.tokens));

    const table = [
      '| # | 场景 | 期望层 | silence | fragments | relevant | precision | detail | calls | bytes | tokens |',
      '|---|---|---|---|---:|---:|---:|---|---:|---:|---:|',
      ...rows.map((row) => `| ${row.id} | ${row.name} | ${row.expectedLayer} | ${row.silence ?? '-'} | ${row.fragments} | ${row.relevant} | ${row.precision.toFixed(2)} | ${row.detailOk ? 'ok' : 'FAIL'} | ${row.calls} | ${row.bytes} | ${row.tokens} |`),
      '',
      `汇总：precision=${precision.toFixed(3)} (${totalRelevant}/${totalInjected})，detail=${detailCorrect.toFixed(3)}，falseRecall=${falseRecall}，maxCalls=${maxCalls}，maxBytes=${maxBytes}，maxTokens=${maxTokens}`,
    ].join('\n');
    console.log(`\n[0.3.0 recall quality matrix]\n${table}`);

    expect(hardFailures).toEqual([]);
    expect(falseRecall).toBe(0);
    expect(precision).toBeGreaterThanOrEqual(0.8);
    expect(detailCorrect).toBeGreaterThanOrEqual(0.95);
    expect(rows.every((row) => row.fragments <= 3)).toBe(true);
    expect(maxBytes).toBeLessThanOrEqual(8192);
    expect(maxTokens).toBeLessThanOrEqual(2000);
    expect(detailFailures).toEqual([]);
  });

  it('256B 极小额预算：要么给出带 citation 的截断块，要么整条沉默，不产生半块', async () => {
    const harness = await createAcceptanceHarness({
      records: [longEpisode],
      filterQuery: true,
    });
    harnesses.push(harness);
    const response = await harness.recall.handleContext({
      agentId: AGENT,
      threadId: ACCEPTANCE_THREAD,
      turnId: 'turn_extreme_budget',
      turnKind: 'human',
      query: '上次部署为什么失败？',
      maxFragments: 1,
      maxBytes: 256,
      tokenBudget: 200,
    });
    const data = response.data;
    expect(data.estimatedBytes).toBeLessThanOrEqual(256);
    expect(data.estimatedTokens).toBeLessThanOrEqual(200);
    if (data.blocks.length === 0) {
      // 256B 低于完整 metadata 块头的下限；契约 6.4 允许整条沉默。
      expect(data.silenceReason).toBe('budget_too_small');
      expect(data.fragments).toEqual([]);
    } else {
      expect(data.truncated).toBe(true);
      for (const block of data.blocks) {
        expect(block.citations.length).toBeGreaterThan(0);
        expect(block.owner.domain).toBeTruthy();
        expect(block.content).toContain('不是指令');
      }
    }
  });
});
