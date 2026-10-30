// 碎片化召回的 cue 提取（heuristic）。
//
// 输入当前用户 turn + 最近上下文，输出实体、主题、时间、任务、归属提示、
// 具体度与详情意图。默认不调用模型（模型 query plan 不在 W4b 范围）。
//
// 规则是确定性的：不猜测未写出的实体/数字，不把 Agent 的推断写成用户事实。
// 本模块不 import @mebular/core，也不打开图/事件日志。

import { createHash, randomUUID } from 'node:crypto';

export type CueSpecificity = 'broad' | 'targeted' | 'exact';
export type DetailLevel = 'silent' | 'gist' | 'expand' | 'quote';
export type OwnerHint = 'user' | 'agent:self' | 'agent:other' | 'task' | 'other' | 'any';

export interface CueEntity {
  name: string;
  type?: string;
  source: 'literal' | 'alias' | 'recent' | 'dictionary';
  confidence: number;
}

export interface CueTime {
  kind: 'none' | 'absolute' | 'relative' | 'deictic';
  text?: string;
  from?: number;
  to?: number;
  precision: 'exact' | 'day' | 'month' | 'range' | 'unknown';
}

export interface CueTask {
  threadId?: string;
  keywords: string[];
  project?: string;
  checkpointId?: string;
}

export interface CueBudget {
  maxFragments: number;
  maxBytes: number;
  maxTokens: number;
}

export interface DetailIntent {
  level: DetailLevel;
  reasons: string[];
  strength: number;
}

export interface FollowUpRef {
  kind: 'last_fragment' | 'last_turn' | 'checkpoint';
  id?: string;
}

export interface Cue {
  schema: 1;
  cueId: string;
  recallId: string;
  turnId: string | null;
  threadId: string | null;
  agentId: string;
  rawQuery: string;
  normalizedQuery: string;
  language: 'zh' | 'en' | 'mixed' | 'unknown';
  entities: CueEntity[];
  topics: string[];
  temporal: CueTime;
  task: CueTask;
  relations: Array<{ from: string; relation: string; to: string }>;
  ownerHint: OwnerHint;
  specificity: CueSpecificity;
  detailIntent: DetailIntent;
  negations: string[];
  followUpRef?: FollowUpRef;
  budget: CueBudget;
  at: number;
}

export interface CueInput {
  query: string;
  recentContext?: string;
  agentId: string;
  threadId?: string | null;
  turnId?: string | null;
  recallId: string;
  now: number;
  budget: CueBudget;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const EN_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'did',
  'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here', 'him', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'my', 'of', 'on', 'or',
  'our', 'she', 'should', 'so', 'some', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'to', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'about', 'again',
  'last', 'time', 'remember', 'recall', 'know', 'tell', 'please',
]);

const ZH_STOPWORDS = new Set([
  '的', '了', '吗', '呢', '吧', '啊', '呀', '嘛', '哦', '嗯', '是', '在', '有', '和',
  '与', '就', '都', '也', '还', '很', '太', '我', '你', '他', '她', '它', '我们', '你们',
  '他们', '这个', '那个', '这些', '那些', '什么', '怎么', '怎样', '如何', '一下', '一些',
  '可以', '能否', '请问', '帮我', '告诉', '记得', '回想起', '之前', '刚才', '现在',
  '东西', '事情', '时候', '一个', '没有', '不是', '就是',
]);

const ZH_TOPIC_DICTIONARY = [
  '偏好', '主题', '语言', '端口', '部署', '命令', '脚本', '项目', '版本', '路径', '原文',
  '原话', '数据库', '配置', '测试', '发布', '任务', '决策', '故障', '错误', '日志',
  '模型', '记忆', '时间', '日期', '地址', '文件夹', '服务器', '接口', '插件', '助手',
];

const TOPIC_ALIASES: Array<[RegExp, string]> = [
  [/喜欢|偏好|prefer|like/i, '偏好'],
  [/部署|deploy|release/i, '部署'],
  [/命令|脚本|command|script|cli/i, '命令'],
  [/端口|port/i, '端口'],
  [/版本|version/i, '版本'],
  [/路径|目录|path|folder/i, '路径'],
  [/数据库|database|db/i, '数据库'],
  [/原文|原话|verbatim|quote/i, '原文'],
  [/项目|project|repo/i, '项目'],
];

function normalizeQuery(value: unknown): string {
  return String(value ?? '').normalize('NFKC').replace(/\r\n?/g, '\n').trim().slice(0, 2000);
}

function normalizeContext(value: unknown): string {
  return String(value ?? '').normalize('NFKC').replace(/\r\n?/g, '\n').trim().slice(-4000);
}

function detectLanguage(text: string): Cue['language'] {
  if (text.length === 0) return 'unknown';
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (cjk === 0 && latin === 0) return 'unknown';
  if (cjk > 0 && latin / Math.max(1, cjk) > 0.6) return 'mixed';
  if (latin > cjk * 3) return 'en';
  if (cjk > 0) return 'zh';
  return 'mixed';
}

function pushEntity(
  out: Map<string, CueEntity>,
  name: string,
  type: string | undefined,
  source: CueEntity['source'],
  confidence: number,
): void {
  const value = name.trim();
  if (value.length === 0 || value.length > 120) return;
  const key = value.toLowerCase();
  const previous = out.get(key);
  if (!previous || previous.confidence < confidence) {
    out.set(key, { name: value, ...(type ? { type } : {}), source, confidence });
  }
}

function extractEntities(text: string): CueEntity[] {
  const out = new Map<string, CueEntity>();
  const addMatches = (
    pattern: RegExp,
    type: string,
    source: CueEntity['source'],
    confidence: number,
    group = 1,
  ): void => {
    for (const match of text.matchAll(pattern)) {
      const value = match[group];
      if (typeof value === 'string') pushEntity(out, value, type, source, confidence);
    }
  };

  addMatches(/(?:^|[\s(（`“"'「『])((?:\/|\.{1,2}\/)[A-Za-z0-9._~@%+/-]{2,})/g, 'path', 'literal', 0.94);
  addMatches(/\bhttps?:\/\/[^\s<>()（）"']+/g, 'url', 'literal', 0.94);
  addMatches(/(?:^|[\s(（])(@[A-Za-z0-9._-]{2,64})/g, 'agent', 'literal', 0.9);
  addMatches(/\b(\d{4}-\d{2}-\d{2})\b/g, 'date', 'literal', 0.95);
  addMatches(/\b(v?\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?)\b/g, 'version', 'literal', 0.9);
  addMatches(/(?:端口|port|:)\s*(\d{2,5})\b/gi, 'port', 'literal', 0.95);
  addMatches(/[“"`]([^”"`\n]{2,120})[”"`]/g, 'literal', 'literal', 0.9);
  addMatches(/(?<![\w.])(\d{2,6})(?![\w.])/g, 'number', 'literal', 0.72);
  addMatches(/\b([A-Z][A-Za-z0-9._-]{1,40})\b/g, 'tool', 'literal', 0.7);
  addMatches(/([\u3400-\u9fff]{2,12})(?=项目|插件|工具|服务|系统|助手|模型|数据库|团队)/g, 'concept', 'literal', 0.68);

  for (const name of ['Hermes', 'OpenCode', 'OpenChamber', 'DSH', 'Claude', 'Codex', 'Mebular']) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(text)) {
      pushEntity(out, name, 'agent', 'dictionary', 0.9);
    }
  }

  return [...out.values()]
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
    .slice(0, 16);
}

function addTopic(out: string[], topic: string): void {
  const value = topic.trim();
  if (value.length === 0 || value.length > 40) return;
  if (ZH_STOPWORDS.has(value) || EN_STOPWORDS.has(value.toLowerCase())) return;
  if (!out.includes(value)) out.push(value);
}

function extractTopics(query: string, context: string): string[] {
  const out: string[] = [];
  const queryLower = query.toLowerCase();
  for (const [pattern, topic] of TOPIC_ALIASES) {
    if (pattern.test(queryLower)) addTopic(out, topic);
  }
  for (const topic of ZH_TOPIC_DICTIONARY) {
    if (query.includes(topic)) addTopic(out, topic);
  }

  for (const match of query.matchAll(/[A-Za-z][A-Za-z0-9._-]{1,40}/g)) {
    const word = match[0]!.toLowerCase().replace(/[._-]+$/g, '');
    if (word.length < 2 || EN_STOPWORDS.has(word)) continue;
    addTopic(out, word);
  }

  for (const run of query.matchAll(/[\u3400-\u9fff]{2,}/g)) {
    const value = run[0]!;
    if (value.length <= 4) addTopic(out, value);
    for (let index = 0; index < value.length - 1; index += 1) {
      const bigram = value.slice(index, index + 2);
      if (!ZH_STOPWORDS.has(bigram)) addTopic(out, bigram);
    }
  }

  // 最近上下文只补主题，不改变当前 turn 的具体度/详情意图。
  if (context.length > 0) {
    for (const match of context.matchAll(/[A-Za-z][A-Za-z0-9._-]{2,40}/g)) {
      const word = match[0]!.toLowerCase();
      if (!EN_STOPWORDS.has(word)) addTopic(out, word);
      if (out.length >= 12) break;
    }
  }

  return out.slice(0, 12);
}

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayRange(from: number): { from: number; to: number } {
  return { from, to: from + DAY_MS - 1 };
}

function parseTemporal(query: string, now: number): CueTime {
  const dateMatch = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(query);
  if (dateMatch) {
    const at = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3])).getTime();
    if (Number.isFinite(at)) {
      const range = dayRange(at);
      return { kind: 'absolute', text: dateMatch[0], ...range, precision: 'day' };
    }
  }
  const cnDate = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(query) ?? /(\d{1,2})月(\d{1,2})日/.exec(query);
  if (cnDate) {
    const hasYear = cnDate.length === 4;
    const year = hasYear ? Number(cnDate[1]) : new Date(now).getFullYear();
    const month = Number(cnDate[hasYear ? 2 : 1]);
    const day = Number(cnDate[hasYear ? 3 : 2]);
    const at = new Date(year, month - 1, day).getTime();
    if (Number.isFinite(at)) {
      const range = dayRange(at);
      return { kind: 'absolute', text: cnDate[0], ...range, precision: 'day' };
    }
  }

  if (/今天|today/i.test(query)) {
    const range = dayRange(startOfDay(now));
    return { kind: 'relative', text: '今天', ...range, precision: 'day' };
  }
  if (/昨天|yesterday/i.test(query)) {
    const range = dayRange(startOfDay(now) - DAY_MS);
    return { kind: 'relative', text: '昨天', ...range, precision: 'day' };
  }
  if (/前天/i.test(query)) {
    const range = dayRange(startOfDay(now) - 2 * DAY_MS);
    return { kind: 'relative', text: '前天', ...range, precision: 'day' };
  }

  const daysAgo = /(\d+)\s*天前/.exec(query);
  if (daysAgo) {
    const range = dayRange(startOfDay(now) - Number(daysAgo[1]) * DAY_MS);
    return { kind: 'relative', text: daysAgo[0], ...range, precision: 'day' };
  }

  if (/上周|上个星期|last week/i.test(query)) {
    const day = new Date(now);
    const weekday = day.getDay() === 0 ? 7 : day.getDay();
    const mondayThisWeek = startOfDay(now) - (weekday - 1) * DAY_MS;
    return {
      kind: 'relative',
      text: '上周',
      from: mondayThisWeek - 7 * DAY_MS,
      to: mondayThisWeek - 1,
      precision: 'range',
    };
  }
  if (/这周|本周|这个星期|this week/i.test(query)) {
    const day = new Date(now);
    const weekday = day.getDay() === 0 ? 7 : day.getDay();
    const monday = startOfDay(now) - (weekday - 1) * DAY_MS;
    return { kind: 'relative', text: '本周', from: monday, to: now, precision: 'range' };
  }
  if (/上个月|last month/i.test(query)) {
    const date = new Date(now);
    const from = new Date(date.getFullYear(), date.getMonth() - 1, 1).getTime();
    const to = new Date(date.getFullYear(), date.getMonth(), 1).getTime() - 1;
    return { kind: 'relative', text: '上个月', from, to, precision: 'month' };
  }
  if (/这个月|本月|this month/i.test(query)) {
    const date = new Date(now);
    const from = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
    return { kind: 'relative', text: '本月', from, to: now, precision: 'month' };
  }
  if (/刚才|刚刚|just now/i.test(query)) {
    return { kind: 'relative', text: '刚才', from: now - 2 * 60 * 60 * 1000, to: now, precision: 'range' };
  }
  if (/上次|那次|之前|以前|last time|earlier/i.test(query)) {
    return { kind: 'deictic', text: '上次', precision: 'unknown' };
  }
  return { kind: 'none', precision: 'unknown' };
}

function detectOwnerHint(query: string): OwnerHint {
  if (/\b(Hermes|OpenChamber|DSH|Codex|Claude)\b/i.test(query)
    || /(?:另一个|其他|别的)\s*Agent|他说|她说|它说/i.test(query)) {
    return 'agent:other';
  }
  if (/我的|我(?:喜欢|偏好|想要|当时|之前|说过|记得|的)|我们/i.test(query)) return 'user';
  if (/你(?:自己)?|你的/i.test(query)) return 'agent:self';
  if (/任务|继续|接着|上次那个任务/i.test(query)) return 'task';
  return 'any';
}

function detectNegations(query: string): string[] {
  const out: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/别用记忆|不要用记忆|不用记忆|别回忆|不要想起|不要提|别提|别提起/i, 'user_negated'],
    [/忘掉|忘记|删除那条|删掉那条|清除记忆/i, 'memory_governance'],
  ];
  for (const [pattern, reason] of patterns) {
    if (pattern.test(query)) out.push(reason);
  }
  return out;
}

function detectFollowUp(query: string): FollowUpRef | undefined {
  if (/继续|接着(?:上次|做|来)|上次(?:的)?任务/i.test(query)) {
    return { kind: 'checkpoint' };
  }
  if (/那个|这个|它|刚才|上面|前面|后来呢|然后呢|上次那个/i.test(query)) {
    return { kind: 'last_fragment' };
  }
  return undefined;
}

function isChitchat(query: string): boolean {
  const compact = query.replace(/\s+/g, '');
  return /^(你好|您好|hi|hello|hey|谢谢|多谢|thanks|thankyou|在吗|ok|okay|好的|嗯|早|早安|晚安|再见|bye)[!！。,.，？?]*$/i.test(compact);
}

function isBroadQuery(query: string): boolean {
  return /记得(?:我|我的|什么)|你还记得|我们之前(?:聊|说|做)过什么|聊过什么|你了解我|我的偏好(?:是|有)?什么|what do you remember|my preferences?|do you remember/i.test(query);
}

function hasExactToken(query: string): boolean {
  return /\b\d{2,5}\b|\bv?\d+\.\d+(?:\.\d+)?\b|`[^`]+`|[“"][^”"]+[”"]|(?:^|\s)(?:\/|\.{1,2}\/)[A-Za-z0-9._~@%+/-]{2,}/.test(query);
}

function specificityOf(query: string, entities: CueEntity[], topics: string[]): CueSpecificity {
  if (hasExactToken(query)
    || /原文|原话|具体|哪一行|哪一个|哪一个版本|多少|几个|端口|日期|版本|路径|命令|脚本|verbatim|exact/i.test(query)) {
    return 'exact';
  }
  if (isBroadQuery(query)) return 'broad';
  if (entities.length > 0 || topics.length > 2) return 'targeted';
  if (query.length >= 18) return 'targeted';
  if (topics.length === 0) return 'broad';
  return 'targeted';
}

function detailIntentOf(query: string): DetailIntent {
  if (detectNegations(query).length > 0) {
    return { level: 'silent', reasons: detectNegations(query), strength: 1 };
  }
  if (isChitchat(query)) {
    return { level: 'silent', reasons: ['chitchat'], strength: 1 };
  }
  if (/记住(?:这个|一下)?|保存(?:这个|一下)?|忘掉|删除那条|归档那条/i.test(query)) {
    return { level: 'silent', reasons: ['memory_governance'], strength: 1 };
  }
  if (query.length === 0) {
    return { level: 'silent', reasons: ['no_cue'], strength: 1 };
  }

  const reasons: string[] = [];
  if (/原话|原文|我当时(?:怎么|是)说|怎么说的|verbatim|word for word/i.test(query)) {
    reasons.push('quote_request');
  }
  if (/命令|脚本|怎么部署|部署命令|执行(?:命令|脚本)|command|script|cli/i.test(query)) {
    reasons.push('command_request');
  }
  if (/为什么|原因|怎么决定|决策|why|reason/i.test(query)) reasons.push('why');
  if (/还是|到底|冲突|哪个对|不一致/i.test(query)) reasons.push('conflict');
  if (/那个|这个|它|刚才|后来呢|然后呢|上次那个/i.test(query)) reasons.push('follow_up');
  if (/继续|接着(?:上次|做|来)|上次(?:的)?任务/i.test(query)) reasons.push('task_continue');
  if (/具体|哪一行|多少|几个|端口|日期|版本|路径|数字|exact/i.test(query) || hasExactToken(query)) {
    reasons.push('exact_value');
  }
  if (/\b(?:what|which|who|how)\b|什么|哪个|谁|怎么/i.test(query)) reasons.push('entity_question');

  const level: DetailLevel = reasons.includes('quote_request')
    ? 'quote'
    : reasons.length > 0
      ? 'expand'
      : isBroadQuery(query)
        ? 'gist'
        : 'gist';
  const strength = level === 'quote'
    ? 0.95
    : reasons.includes('command_request') || reasons.includes('exact_value')
      ? 0.9
      : reasons.includes('why') || reasons.includes('conflict')
        ? 0.82
        : reasons.includes('follow_up') || reasons.includes('task_continue')
          ? 0.72
          : reasons.includes('entity_question')
            ? 0.68
            : 0.4;
  return { level, reasons: [...new Set(reasons)], strength };
}

/** 提取 cue；query 为空时仍返回结构，detailIntent.level=silent。 */
export function extractCue(input: CueInput): Cue {
  const query = normalizeQuery(input.query);
  const context = normalizeContext(input.recentContext);
  const analysis = context.length > 0 ? `${query}\n${context}` : query;
  const entities = extractEntities(analysis);
  const topics = extractTopics(query, context);
  const negations = detectNegations(query);
  const followUpRef = detectFollowUp(query);
  const language = detectLanguage(query);

  return {
    schema: 1,
    cueId: `cue_${randomUUID().replace(/-/g, '')}`,
    recallId: input.recallId,
    turnId: input.turnId ?? null,
    threadId: input.threadId ?? null,
    agentId: input.agentId,
    rawQuery: query,
    normalizedQuery: query,
    language,
    entities,
    topics,
    temporal: parseTemporal(query, input.now),
    task: {
      ...(input.threadId ? { threadId: input.threadId } : {}),
      keywords: topics.slice(0, 8),
    },
    relations: [],
    ownerHint: detectOwnerHint(query),
    specificity: specificityOf(query, entities, topics),
    detailIntent: detailIntentOf(query),
    negations,
    ...(followUpRef ? { followUpRef } : {}),
    budget: {
      maxFragments: Math.max(1, Math.min(3, Math.floor(input.budget.maxFragments))),
      maxBytes: Math.max(1, Math.floor(input.budget.maxBytes)),
      maxTokens: Math.max(1, Math.floor(input.budget.maxTokens)),
    },
    at: input.now,
  };
}

export function queryHash(query: string): string {
  return createHash('sha256').update(normalizeQuery(query), 'utf8').digest('hex');
}

/** 精确 token（数字/端口/版本/路径/引号）用于 exact 意图的 token 命中判定。 */
export function exactTokensOf(query: string): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined): void => {
    const token = value?.trim();
    if (token && token.length >= 2) out.add(token);
  };
  for (const match of query.matchAll(/\b\d{2,5}\b/g)) add(match[0]);
  for (const match of query.matchAll(/\bv?\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?\b/g)) add(match[0]);
  for (const match of query.matchAll(/[“"`]([^”"`\n]{2,120})[”"`]/g)) add(match[1]);
  for (const match of query.matchAll(/(?:^|\s)((?:\/|\.{1,2}\/)[A-Za-z0-9._~@%+/-]{2,})/g)) add(match[1]);
  return [...out];
}
