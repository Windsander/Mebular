// 确定性 heuristic 候选抽取。
//
// 只从**用户** chunk 中提取明确的偏好、事实、决策/任务 episode；
// 不扫描普通句子、不推断、不补全，避免把 Agent 的猜测写成用户事实。
// 模型层不在 W4a 范围内：local/api 配置由调用方降级为 heuristic。
//
// 本模块不 import @mebular/core，也不打开图/事件日志。

export type HeuristicKind = 'fact' | 'preference' | 'episode';

export interface HeuristicChunk {
  role: string;
  text: string;
  at: number;
  threadId: string;
}

export interface HeuristicCandidate {
  kind: HeuristicKind;
  content: Record<string, unknown>;
  /** 直接用户陈述/明确偏好 → explicit；decision/task episode → none。 */
  confirmation: 'explicit' | 'none';
  /** 内容来自用户 chunk；用于域路由。 */
  fromUser: boolean;
  tags?: string[];
}

export interface HeuristicResult {
  candidates: HeuristicCandidate[];
  warnings: string[];
}

function cleanValue(value: string): string {
  return value.trim().replace(/[，,。.;；]+$/u, '').trim();
}

function preference(text: string): HeuristicCandidate | null {
  const patterns: Array<{ pattern: RegExp; type: string }> = [
    { pattern: /^(?:以后|今后|之后|从现在起)[，,\s]*(?:请)?(?:默认)?(?:使用|用)?\s*([^。.!！?？\n]{1,200})/, type: 'default' },
    { pattern: /^(?:请)?默认(?:使用|用)?\s*([^。.!！?？\n]{1,200})/, type: 'default' },
    { pattern: /^(?:我)?(?:更)?(?:喜欢|偏好|希望|想要)\s*([^。.!！?？\n]{1,200})/, type: 'like' },
    { pattern: /^(?:I|we)\s+(?:prefer|like|want)\s+([^.!?\n]{1,200})/i, type: 'like' },
    { pattern: /^(?:always|by default)\s+(?:use\s+)?([^.!?\n]{1,200})/i, type: 'default' },
  ];
  for (const { pattern, type } of patterns) {
    const match = text.match(pattern);
    const value = match?.[1] ? cleanValue(match[1]) : '';
    if (value.length === 0) continue;
    // “你喜欢/他喜欢”不是用户偏好，不能写成 user 事实。
    if (/^(你|他|她|它|they|you)\b/i.test(value)) continue;
    return {
      kind: 'preference',
      content: {
        entity: 'user',
        preferenceType: type,
        value,
        confidence: 0.7,
        source: 'heuristic',
      },
      confirmation: 'explicit',
      fromUser: true,
    };
  }
  return null;
}

function facts(text: string): HeuristicCandidate[] {
  const out: HeuristicCandidate[] = [];
  const add = (predicate: string, object: string): void => {
    const value = cleanValue(object);
    if (value.length === 0 || value.length > 500) return;
    out.push({
      kind: 'fact',
      content: {
        subject: 'user',
        predicate,
        object: value,
        confidence: 0.6,
        source: 'heuristic',
      },
      confirmation: 'explicit',
      fromUser: true,
    });
  };

  let match = text.match(/^(?:请)?记住[：:\s]+(.{1,500})$/u);
  if (match?.[1]) add('note', match[1]);

  match = text.match(/^我的([^\s，。,:：]{1,30})[是为：:]\s*(.{1,500})$/u);
  if (match?.[1] && match[2]) add(match[1], match[2]);

  match = text.match(/^My ([A-Za-z0-9 _-]{1,30}) is ([^.\n]{1,500})$/i);
  if (match?.[1] && match[2]) add(match[1].trim(), match[2]);

  match = text.match(/^(?:事实|fact)[:：\s]+(.{1,500})$/iu);
  if (match?.[1]) add('note', match[1]);

  return out;
}

function episode(text: string, chunk: HeuristicChunk): HeuristicCandidate | null {
  const task = /^(?:任务|task|todo|计划|plan)[:：\s]/iu.test(text);
  const decision = /^(?:决定|decision|结论)[:：\s]/iu.test(text);
  if (!task && !decision) return null;
  return {
    kind: 'episode',
    content: {
      episodeType: decision ? 'decision' : 'task',
      title: text.split('\n', 1)[0]?.slice(0, 80) ?? (decision ? 'decision' : 'task'),
      content: text.slice(0, 4000),
      startTime: chunk.at,
      endTime: chunk.at,
      context: chunk.threadId,
    },
    confirmation: 'none',
    fromUser: true,
  };
}

function candidateKey(candidate: HeuristicCandidate): string {
  return [candidate.kind, JSON.stringify(candidate.content)].join('\u0000');
}

/** 从 chunks 中抽取确定性候选；只有 user role 参与。 */
export function heuristicCandidates(chunks: readonly HeuristicChunk[]): HeuristicResult {
  const candidates: HeuristicCandidate[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: HeuristicCandidate | null): void => {
    if (!candidate) return;
    const key = candidateKey(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const chunk of chunks) {
    if (chunk.role !== 'user') continue;
    const text = chunk.text.trim();
    if (text.length === 0) continue;
    push(preference(text));
    for (const fact of facts(text)) push(fact);
    push(episode(text, chunk));
  }

  if (candidates.length === 0) warnings.push('no_extractable_memory');
  return { candidates, warnings };
}
