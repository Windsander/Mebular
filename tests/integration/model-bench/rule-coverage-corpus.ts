// 0.4.0 W0.5b Stage 0：规则覆盖 / 灰区测量的扩展语料（test-only）。
//
// 这不是真实用户流量，也不是抽样调查。每一行都来自下面三类来源之一：
//   1. 现有测试/验收 fixture 的 query（recall.test.ts、acceptance-recall-quality.test.ts、
//      intervention.test.ts、golden set）；
//   2. 由固定模板（中/英各一套）派生出的合成 turn；
//   3. 为了暴露「有候选、无硬规则、相关度中等」的灰区而显式构造的 ambiguous 模板。
//
// 因此本语料的组成（每个切片的条数）是**人为声明的**，不能当作真实用户分布。
// 它的用途只有两个：
//   - 验证规则函数能在哪些切片上稳定做出硬判；
//   - 在给定「中等相关度候选占比」假设下，算出灰区占比的敏感性曲线。
//
// candidate 的 score 是**分档赋值**，不是检索器真实打分：
//   high 0.82-0.93 / mid 0.58-0.72 / low 0.31-0.45。
// 分档故意做成三峰，方便把「歧义」从「明显相关/明显无关」里分离出来。

import type { GoldenCandidate, GoldenCase } from './small-planner-golden-set.js';

export type CorpusSlice =
  | 'must_speak'
  | 'no_candidates'
  | 'novelty_zero'
  | 'conflict'
  | 'defer'
  | 'greeting'
  | 'meta'
  | 'detail'
  | 'quote'
  | 'silent_low_relevance'
  | 'ambiguous';

export type CorpusLang = 'zh' | 'en';

export interface RuleCorpusCase {
  id: string;
  slice: CorpusSlice;
  lang: CorpusLang;
  query: string;
  /** 例：fixture:recall.test.ts#Q08 / template:must_speak-zh / golden:<id> */
  source: string;
  specificity: 'broad' | 'targeted' | 'exact';
  topics: string[];
  entities: string[];
  reasons: string[];
  followUp: boolean;
  candidates: GoldenCandidate[];
  injectedIds: string[];
  /** hard = 策略表 1-6 行；deterministic = 分数档明确、无需模型；grey = 需要模型。 */
  expectedTier: 'hard' | 'deterministic' | 'grey';
  /** 仅 hard/deterministic 切片给出；grey 不给标签，避免用标签反推决策。 */
  expectedAction?: 'speak' | 'defer' | 'silent';
  expectedDepth?: 'gist' | 'detail' | 'quote';
  core: boolean;
  note: string;
}

function cand(
  gist: string,
  score: number,
  options: Partial<Omit<GoldenCandidate, 'gist' | 'score'>> = {},
): GoldenCandidate {
  return {
    kind: options.kind ?? 'fact',
    domain: options.domain ?? 'general',
    gist,
    score,
    confidence: options.confidence ?? 0.8,
    ageDays: options.ageDays ?? 3,
    novelty: options.novelty ?? 1,
    conflict: options.conflict ?? false,
  };
}

interface Row {
  id: string;
  q: string;
  source: string;
  spec: 'broad' | 'targeted' | 'exact';
  topics?: string[];
  entities?: string[];
  reasons?: string[];
  followUp?: boolean;
  cands: GoldenCandidate[];
  injected?: string[];
  action?: 'speak' | 'defer' | 'silent';
  depth?: 'gist' | 'detail' | 'quote';
  core?: boolean;
  note: string;
}

function row(
  slice: CorpusSlice,
  lang: CorpusLang,
  tier: 'hard' | 'deterministic' | 'grey',
  items: Row[],
): RuleCorpusCase[] {
  return items.map((item) => ({
    id: item.id,
    slice,
    lang,
    query: item.q,
    source: item.source,
    specificity: item.spec,
    topics: item.topics ?? [],
    entities: item.entities ?? [],
    reasons: item.reasons ?? [],
    followUp: item.followUp ?? false,
    candidates: item.cands,
    injectedIds: item.injected ?? [],
    expectedTier: tier,
    ...(item.action ? { expectedAction: item.action } : {}),
    ...(item.depth ? { expectedDepth: item.depth } : {}),
    core: item.core ?? false,
    note: item.note,
  }));
}

const MUST_ZH: Row[] = [
  { id: 'x_must_port_zh', q: '你还记得我上次说的部署端口吗？', source: 'fixture:recall.test.ts#port/must', spec: 'exact', topics: ['部署', '端口'], reasons: ['exact_value', 'follow_up'], followUp: true, cands: [cand('部署端口是 7331。', 0.9)], action: 'speak', depth: 'quote', core: true, note: '显式回忆 + 精确值' },
  { id: 'x_must_db_zh', q: '我之前说的数据库名是什么？', source: 'fixture:golden#must_database_name', spec: 'exact', topics: ['数据库'], reasons: ['exact_value'], cands: [cand('主库数据库名是 mebular_dev。', 0.89)], action: 'speak', depth: 'quote', core: true, note: '显式回忆 + 精确值' },
  { id: 'x_must_verbatim_zh', q: '我当时原话怎么说的？', source: 'fixture:recall.test.ts#Q08', spec: 'exact', topics: ['原文'], reasons: ['quote_request'], cands: [cand('原话是“先冻结契约，再迁移 runtime”。', 0.91)], action: 'speak', depth: 'quote', core: true, note: '原话请求' },
  { id: 'x_must_version_zh', q: '上次那个版本号是多少？', source: 'fixture:recall.test.ts#Q05', spec: 'exact', topics: ['版本'], reasons: ['exact_value'], cands: [cand('上次版本号是 0.3.0。', 0.88)], action: 'speak', depth: 'quote', core: false, note: '精确值' },
  { id: 'x_must_command_zh', q: '上次那个部署命令是什么？', source: 'fixture:recall.test.ts#Q06', spec: 'exact', topics: ['命令', '部署'], reasons: ['command_request', 'exact_value'], cands: [cand('部署命令是 pnpm release --tag 0.3.0。', 0.9)], action: 'speak', depth: 'quote', core: true, note: '命令 + 精确值' },
  { id: 'x_must_continue_zh', q: '继续刚才那个部署任务。', source: 'fixture:golden#task_continue_deploy', spec: 'targeted', topics: ['部署', '任务'], reasons: ['task_continue', 'follow_up'], followUp: true, cands: [cand('部署任务停在校验产物签名。', 0.9)], action: 'speak', depth: 'detail', core: true, note: '任务续接' },
  { id: 'x_must_after_zh', q: '那个方案后来呢？', source: 'fixture:recall.test.ts#Q10', spec: 'targeted', topics: ['项目'], reasons: ['follow_up'], followUp: true, cands: [cand('方案后来改成碎片化召回。', 0.86)], action: 'speak', depth: 'detail', core: false, note: '追问上一片段' },
  { id: 'x_must_lint_zh', q: '你不是说过测试要先跑 lint 吗？', source: 'fixture:golden#must_lint_first', spec: 'targeted', topics: ['测试'], reasons: ['follow_up'], cands: [cand('测试前必须先跑 lint。', 0.88)], action: 'speak', depth: 'detail', core: false, note: '“不是说过”触发显式回忆' },
  { id: 'x_must_pref_zh', q: '我的偏好是什么？', source: 'fixture:recall.test.ts#preference', spec: 'broad', topics: ['偏好'], reasons: ['follow_up'], cands: [cand('用户偏好深色主题和中文回答。', 0.84)], action: 'speak', depth: 'detail', core: false, note: '显式偏好询问（golden 外）' },
  { id: 'x_must_hermes_zh', q: 'Hermes 上次说什么？', source: 'fixture:recall.test.ts#Q13', spec: 'targeted', topics: ['任务'], entities: ['Hermes'], reasons: ['follow_up', 'entity_question'], cands: [cand('Hermes 说跨设备只认已沉降记录。', 0.87)], action: 'speak', depth: 'detail', core: false, note: '其他 Agent 的显式追问' },
];

const MUST_EN: Row[] = [
  { id: 'x_must_port_en', q: 'what did I say last time about the deploy port?', source: 'template:must_speak-en', spec: 'exact', topics: ['deploy', 'port'], reasons: ['exact_value', 'follow_up'], followUp: true, cands: [cand('The deploy port is 7331.', 0.9)], action: 'speak', depth: 'quote', core: true, note: 'explicit recall + exact value' },
  { id: 'x_must_command_en', q: 'remind me of the exact command I saved.', source: 'template:must_speak-en', spec: 'exact', topics: ['command'], reasons: ['quote_request', 'command_request'], cands: [cand('The saved command is pnpm deploy --prod.', 0.91)], action: 'speak', depth: 'quote', core: true, note: 'explicit recall + command' },
  { id: 'x_must_branch_en', q: 'what was the release branch name we agreed on?', source: 'template:must_speak-en', spec: 'targeted', topics: ['release'], reasons: ['follow_up'], cands: [cand('We agreed on release/vX.Y.Z.', 0.88)], action: 'speak', depth: 'detail', core: false, note: 'explicit recall' },
  { id: 'x_must_pkg_en', q: 'can you recall my preferred package manager?', source: 'template:must_speak-en', spec: 'targeted', topics: ['tooling'], reasons: ['follow_up'], cands: [cand('The user standardizes on pnpm.', 0.86)], action: 'speak', depth: 'detail', core: false, note: 'explicit recall' },
  { id: 'x_must_continue_en', q: 'continue the migration task from last time.', source: 'template:must_speak-en', spec: 'targeted', topics: ['task', 'migration'], reasons: ['task_continue'], followUp: true, cands: [cand('Migration stopped before the orders table.', 0.89)], action: 'speak', depth: 'detail', core: true, note: 'task continuation' },
  { id: 'x_must_quote_en', q: 'quote the exact deployment command you saved.', source: 'fixture:golden#quote_deploy_en', spec: 'exact', topics: ['command'], reasons: ['command_request', 'quote_request'], cands: [cand('The deployment command is pnpm deploy --prod.', 0.91)], action: 'speak', depth: 'quote', core: false, note: 'quote request' },
];

const NOCAND_ZH: Row[] = [
  { id: 'x_nocand_plan_zh', q: '帮我看看这个方案。', source: 'fixture:golden#nocand_plan', spec: 'targeted', cands: [], action: 'silent', depth: 'gist', core: true, note: '无候选' },
  { id: 'x_nocand_fn_zh', q: '这个函数有什么问题？', source: 'fixture:golden#nocand_function', spec: 'targeted', reasons: ['entity_question'], cands: [], action: 'silent', depth: 'gist', core: false, note: '无候选' },
  { id: 'x_nocand_chat_zh', q: '随便聊聊。', source: 'fixture:golden#nocand_chat', spec: 'broad', cands: [], action: 'silent', depth: 'gist', core: false, note: '无候选' },
  { id: 'x_nocand_end_zh', q: '先这样吧。', source: 'fixture:golden#nocand_ok', spec: 'broad', cands: [], action: 'silent', depth: 'gist', core: false, note: '无候选' },
];

const NOCAND_EN: Row[] = [
  { id: 'x_nocand_approach_en', q: 'take a look at this approach.', source: 'template:no_candidates-en', spec: 'targeted', cands: [], action: 'silent', depth: 'gist', core: false, note: 'no candidates' },
  { id: 'x_nocand_fn_en', q: "what's wrong with this function?", source: 'template:no_candidates-en', spec: 'targeted', reasons: ['entity_question'], cands: [], action: 'silent', depth: 'gist', core: false, note: 'no candidates' },
  { id: 'x_nocand_chat_en', q: "let's just chat.", source: 'template:no_candidates-en', spec: 'broad', cands: [], action: 'silent', depth: 'gist', core: false, note: 'no candidates' },
  { id: 'x_nocand_end_en', q: "that's all for now.", source: 'template:no_candidates-en', spec: 'broad', cands: [], action: 'silent', depth: 'gist', core: false, note: 'no candidates' },
];

function noveltyCase(
  id: string, lang: CorpusLang, q: string, gist: string, domain: string,
  topics: string[], source: string, core = false,
): Row {
  return {
    id, q, source, spec: 'targeted', topics, reasons: [], followUp: false,
    cands: [cand(gist, 0.88, { kind: 'fact', domain, novelty: 0 })],
    injected: [`rec_${id}_injected`, 'mf_injected'],
    action: 'silent', depth: 'gist', core,
    note: '同一候选已注入，novelty=0',
  };
}

const NOVELTY_ZH: Row[] = [
  noveltyCase('x_nov_theme_zh', 'zh', '我的主题偏好是什么？', '用户偏好深色主题。', 'preferences', ['偏好'], 'fixture:golden#novelty_theme', true),
  noveltyCase('x_nov_port_zh', 'zh', '部署端口是多少？', '部署端口是 7331。', 'deploy', ['端口'], 'fixture:recall.test.ts#port', true),
  noveltyCase('x_nov_editor_zh', 'zh', '我的编辑器配置是什么？', '用户使用 Neovim 和 lazy.nvim。', 'editor', ['配置'], 'fixture:golden#novelty_editor'),
  noveltyCase('x_nov_test_zh', 'zh', '我们用的测试框架是哪个？', '测试主要用 Jest。', 'testing', ['测试'], 'fixture:golden#novelty_test_runner'),
  noveltyCase('x_nov_tz_zh', 'zh', '我的时区偏好是怎样的？', '用户偏好 Asia/Shanghai。', 'preferences', ['偏好', '时间'], 'fixture:golden#novelty_timezone'),
  noveltyCase('x_nov_db_zh', 'zh', '数据库连接串用的是哪个？', '开发库连接串指向 mebular_dev。', 'database', ['数据库'], 'fixture:golden#novelty_database_url'),
  noveltyCase('x_nov_pkg_zh', 'zh', '我常用的包管理器是什么？', '用户统一用 pnpm。', 'tooling', ['命令'], 'fixture:golden#novelty_package_manager'),
  noveltyCase('x_nov_branch_zh', 'zh', '发布分支的命名规则是什么？', '发布分支用 release/vX.Y.Z。', 'git', ['项目'], 'fixture:golden#novelty_branch_rule'),
];

const NOVELTY_EN: Row[] = [
  noveltyCase('x_nov_fmt_en', 'en', 'my preferred code formatter?', 'User prefers Biome for formatting.', 'tooling', ['preferences'], 'fixture:golden#novelty_formatter_en'),
  noveltyCase('x_nov_runner_en', 'en', 'which test runner do we use?', 'The project uses Jest with Node ESM.', 'testing', ['testing'], 'fixture:golden#novelty_runner_en'),
  noveltyCase('x_nov_pkg_en', 'en', "what's my preferred package manager?", 'The user standardizes on pnpm.', 'tooling', ['tooling'], 'template:novelty_zero-en'),
  noveltyCase('x_nov_branch_en', 'en', 'what is the release branch naming rule?', 'Release branches use release/vX.Y.Z.', 'git', ['release'], 'template:novelty_zero-en'),
];

function conflictCase(
  id: string, lang: CorpusLang, q: string, a: string, b: string,
  topics: string[], source: string, core = false,
): Row {
  return {
    id, q, source, spec: 'targeted', topics, reasons: ['conflict'], followUp: false,
    cands: [
      cand(a, 0.86, { conflict: true }),
      cand(b, 0.84, { conflict: true }),
    ],
    action: 'speak', depth: 'detail', core,
    note: '候选互相矛盾；策略表第 4 行',
  };
}

const CONFLICT_ZH: Row[] = [
  conflictCase('x_conf_port_zh', 'zh', '部署端口有 7331 和 7332 两个说法，哪个对？', '部署端口是 7331。', '部署端口是 7332。', ['端口'], 'fixture:recall.test.ts#Q12', true),
  conflictCase('x_conf_pref_zh', 'zh', '我的偏好记录前后不一致，信哪个？', '用户偏好浅色主题。', '用户偏好深色主题。', ['偏好'], 'fixture:golden#conflict_pref', true),
  conflictCase('x_conf_db_zh', 'zh', '数据库名有两个版本，到底用哪个？', '数据库名是 mebular_dev。', '数据库名是 mebular_local。', ['数据库'], 'fixture:golden#conflict_database'),
  conflictCase('x_conf_decision_zh', 'zh', '上次的结论和这次候选冲突，怎么处理？', '上次结论：使用 SQLite。', '新候选：迁移到 Postgres。', ['决策'], 'fixture:golden#conflict_decision'),
  conflictCase('x_conf_release_zh', 'zh', '两条记忆说的发布流程不一样。', '发布流程：先测试再 lint。', '发布流程：先 lint 再测试。', ['发布'], 'fixture:golden#conflict_release_flow', true),
  conflictCase('x_conf_alias_zh', 'zh', '别名记录冲突了，应该以哪条为准？', '项目别名是 mebular-core。', '项目别名是 mebular。', ['项目'], 'fixture:golden#conflict_alias'),
  conflictCase('x_conf_which_zh', 'zh', '两条记录到底哪个对？', '记录 A：端口 7331。', '记录 B：端口 7332。', ['决策'], 'fixture:golden#conflict_which_record', true),
  conflictCase('x_conf_theme_zh', 'zh', '主题偏好的记录打架了。', '主题=dark。', '主题=light。', ['偏好'], 'template:conflict-zh'),
];

const CONFLICT_EN: Row[] = [
  conflictCase('x_conf_record_en', 'en', 'which record is correct? they disagree.', 'Record A says release/0.4.', 'Record B says release/0.5.', ['decision'], 'fixture:golden#conflict_en', true),
  conflictCase('x_conf_flow_en', 'en', 'the two notes disagree about the release flow.', 'Run tests before lint.', 'Run lint before tests.', ['release'], 'template:conflict-en'),
  conflictCase('x_conf_port_en', 'en', 'port 7331 or 7332 - which one is right?', 'The port is 7331.', 'The port is 7332.', ['port'], 'template:conflict-en'),
  conflictCase('x_conf_pref_en', 'en', 'the preference records conflict; which should I trust?', 'User prefers dark mode.', 'User prefers light mode.', ['preferences'], 'template:conflict-en'),
];

const DEFER_ZH: Row[] = [
  { id: 'x_defer_code_zh', q: '先别回忆，等我写完这段代码再说。', source: 'fixture:golden#defer_finish_code', spec: 'targeted', topics: ['任务'], cands: [cand('用户上次要求先跑 lint 再测试。', 0.86)], action: 'defer', depth: 'gist', core: true, note: '显式 defer' },
  { id: 'x_defer_later_zh', q: '这个先放一放，我们晚点再聊记忆。', source: 'fixture:golden#defer_later', spec: 'targeted', topics: ['记忆'], cands: [cand('用户偏好按周回顾记忆。', 0.82)], action: 'defer', depth: 'gist', core: false, note: '显式 defer' },
  { id: 'x_defer_focus_zh', q: '现在只专注跑步流程，别注入旧上下文。', source: 'fixture:golden#defer_focus_pipeline', spec: 'targeted', topics: ['任务'], cands: [cand('用户上周记录过跑步配速偏好。', 0.88)], action: 'defer', depth: 'gist', core: true, note: '显式 defer（“别注入”）' },
  { id: 'x_defer_repro_zh', q: '等我把错误复现出来再查以前的记录。', source: 'fixture:golden#defer_reproduce_bug', spec: 'targeted', topics: ['故障'], cands: [cand('上次相同错误是缓存未清导致的。', 0.85)], action: 'defer', depth: 'gist', core: false, note: '显式 defer（时间从句）' },
  { id: 'x_defer_scratch_zh', q: '先不查历史，我想从零试一次。', source: 'fixture:golden#defer_from_scratch', spec: 'targeted', topics: ['任务'], cands: [cand('用户以前遇到过相同的初始化错误。', 0.83)], action: 'defer', depth: 'gist', core: false, note: '显式 defer（“先不查历史”）' },
  { id: 'x_defer_think_zh', q: '暂时不要提以前的方案，让我自己想想。', source: 'fixture:golden#defer_let_me_think', spec: 'targeted', topics: ['任务'], cands: [cand('用户以前选过方案 B。', 0.87)], action: 'defer', depth: 'gist', core: true, note: '显式 defer + 含“以前”的假 must_speak 风险' },
  { id: 'x_defer_next_zh', q: '下一轮再回顾偏好，这一轮先改代码。', source: 'fixture:golden#defer_next_turn', spec: 'targeted', topics: ['任务', '偏好'], cands: [cand('用户偏好 100 字符行宽。', 0.8)], action: 'defer', depth: 'gist', core: false, note: '显式 defer（“下一轮”）' },
  { id: 'x_defer_negate_zh', q: '别用记忆回答我的偏好', source: 'fixture:recall.test.ts#Q16', spec: 'targeted', topics: ['偏好'], reasons: ['user_negated'], cands: [cand('用户偏好深色主题。', 0.84)], action: 'defer', depth: 'gist', core: true, note: '否定记忆（现有 cue 检测）' },
  { id: 'x_defer_norecall_zh', q: '不用回忆，直接说方案。', source: 'template:defer-zh', spec: 'targeted', topics: ['任务'], cands: [cand('用户上次否掉了方案 C。', 0.82)], action: 'defer', depth: 'gist', core: false, note: '显式 defer' },
  { id: 'x_defer_skip_zh', q: '先跳过旧上下文，聚焦当前报错。', source: 'template:defer-zh', spec: 'targeted', topics: ['故障'], cands: [cand('旧包版本曾导致相同报错。', 0.81)], action: 'defer', depth: 'gist', core: false, note: '显式 defer（“跳过旧上下文”）' },
];

const DEFER_EN: Row[] = [
  { id: 'x_defer_refactor_en', q: 'hold off on memory for now; let me finish this refactor.', source: 'fixture:golden#defer_refactor_en', spec: 'targeted', topics: ['task'], cands: [cand('User prefers refactors in small commits.', 0.84)], action: 'defer', depth: 'gist', core: false, note: 'explicit defer' },
  { id: 'x_defer_oldctx_en', q: "don't bring up old context yet.", source: 'template:defer-en', spec: 'targeted', cands: [cand('The user previously chose plan B.', 0.83)], action: 'defer', depth: 'gist', core: false, note: 'explicit defer' },
  { id: 'x_defer_skip_en', q: 'skip the memory lookup for this turn.', source: 'template:defer-en', spec: 'targeted', cands: [cand('The user prefers weekly memory reviews.', 0.82)], action: 'defer', depth: 'gist', core: false, note: 'explicit defer' },
  { id: 'x_defer_recall_en', q: "let's not recall anything until I finish.", source: 'template:defer-en', spec: 'targeted', cands: [cand('The user tracks memory under the memory domain.', 0.81)], action: 'defer', depth: 'gist', core: false, note: 'explicit defer' },
];

const GREETING_ZH: Row[] = [
  { id: 'x_greet_hello_zh', q: '你好！', source: 'fixture:golden#greet_hello_zh', spec: 'broad', reasons: ['chitchat'], cands: [cand('用户偏好深色主题。', 0.78)], action: 'silent', depth: 'gist', core: true, note: '寒暄；候选分高也必须 silent' },
  { id: 'x_greet_morning_zh', q: '早上好', source: 'fixture:golden#greet_morning', spec: 'broad', reasons: ['chitchat'], cands: [cand('用户通常在上午做代码审查。', 0.72)], action: 'silent', depth: 'gist', core: false, note: '寒暄' },
  { id: 'x_greet_there_zh', q: '嗨，在吗', source: 'fixture:golden#greet_are_you_there', spec: 'broad', reasons: ['chitchat'], cands: [], action: 'silent', depth: 'gist', core: false, note: '寒暄（cue 正则不覆盖“嗨，在吗”）' },
  { id: 'x_greet_thanks_zh', q: '谢谢！', source: 'fixture:golden#greet_thanks', spec: 'broad', reasons: ['chitchat'], cands: [cand('用户上次感谢了发布检查清单。', 0.74)], action: 'silent', depth: 'gist', core: true, note: '致谢' },
  { id: 'x_greet_ack_zh', q: '收到，辛苦了', source: 'fixture:golden#greet_ack', spec: 'broad', reasons: ['chitchat'], cands: [], action: 'silent', depth: 'gist', core: false, note: '确认收到' },
  { id: 'x_greet_evening_zh', q: '晚上好呀', source: 'fixture:golden#greet_evening', spec: 'broad', reasons: ['chitchat'], cands: [], action: 'silent', depth: 'gist', core: false, note: '寒暄' },
];

const GREETING_EN: Row[] = [
  { id: 'x_greet_hello_en', q: 'hello', source: 'fixture:golden#greet_hello_en', spec: 'broad', reasons: ['chitchat'], cands: [cand('User prefers concise answers.', 0.76)], action: 'silent', depth: 'gist', core: false, note: 'greeting' },
  { id: 'x_greet_hi_en', q: 'hi there', source: 'fixture:golden#greet_hi_there', spec: 'broad', reasons: ['chitchat'], cands: [cand('User uses a dark terminal theme.', 0.79)], action: 'silent', depth: 'gist', core: false, note: 'greeting' },
  { id: 'x_greet_thanks_en', q: 'thanks!', source: 'template:greeting-en', spec: 'broad', reasons: ['chitchat'], cands: [cand('User thanked the release checklist.', 0.74)], action: 'silent', depth: 'gist', core: false, note: 'thanks' },
  { id: 'x_greet_morning_en', q: 'good morning', source: 'template:greeting-en', spec: 'broad', reasons: ['chitchat'], cands: [cand('User reviews code in the morning.', 0.72)], action: 'silent', depth: 'gist', core: false, note: 'greeting' },
];

const META_ZH: Row[] = [
  { id: 'x_meta_who_zh', q: '你是谁？', source: 'fixture:golden#meta_who_are_you', spec: 'broad', reasons: ['entity_question'], cands: [cand('用户给助手起过昵称“老喵”。', 0.7)], action: 'silent', depth: 'gist', core: true, note: 'meta：问助手身份' },
  { id: 'x_meta_cap_zh', q: '你能做什么？', source: 'fixture:golden#meta_capabilities', spec: 'broad', reasons: ['entity_question'], cands: [], action: 'silent', depth: 'gist', core: false, note: 'meta：能力边界' },
  { id: 'x_meta_usage_zh', q: '这个怎么用？', source: 'fixture:golden#meta_how_to_use', spec: 'broad', topics: ['产品'], reasons: ['entity_question'], cands: [cand('用户曾配置过本地模型路径。', 0.66)], action: 'silent', depth: 'gist', core: false, note: 'meta：产品用法' },
  { id: 'x_meta_time_zh', q: '现在几点了？', source: 'fixture:golden#meta_time', spec: 'broad', topics: ['时间'], reasons: ['entity_question'], cands: [cand('用户所在时区是 Asia/Shanghai。', 0.8)], action: 'silent', depth: 'gist', core: true, note: 'meta：问时间，不是记忆请求' },
  { id: 'x_meta_ability_zh', q: '帮我解释一下你的能力', source: 'fixture:golden#meta_explain_ability', spec: 'broad', reasons: ['entity_question'], cands: [], action: 'silent', depth: 'gist', core: false, note: 'meta：能力解释' },
  { id: 'x_meta_model_zh', q: '你是什么模型？', source: 'template:meta-zh', spec: 'broad', reasons: ['entity_question'], cands: [cand('用户配置过 0.5B 本地模型。', 0.72)], action: 'silent', depth: 'gist', core: false, note: 'meta：模型身份' },
];

const META_EN: Row[] = [
  { id: 'x_meta_model_en', q: 'what model are you?', source: 'fixture:golden#meta_what_model', spec: 'broad', reasons: ['entity_question'], cands: [], action: 'silent', depth: 'gist', core: false, note: 'meta: model identity' },
  { id: 'x_meta_cap_en', q: 'what can you do?', source: 'template:meta-en', spec: 'broad', reasons: ['entity_question'], cands: [], action: 'silent', depth: 'gist', core: false, note: 'meta: capabilities' },
  { id: 'x_meta_usage_en', q: 'how do I use this?', source: 'template:meta-en', spec: 'broad', reasons: ['entity_question'], cands: [], action: 'silent', depth: 'gist', core: false, note: 'meta: usage' },
  { id: 'x_meta_time_en', q: 'what time is it?', source: 'template:meta-en', spec: 'broad', reasons: ['entity_question'], cands: [cand('User is in Asia/Shanghai.', 0.8)], action: 'silent', depth: 'gist', core: false, note: 'meta: time question' },
];

const DETAIL_ZH: Row[] = [
  { id: 'x_detail_sqlite_zh', q: '为什么当时选了 SQLite 而不是 Postgres？', source: 'fixture:golden#detail_sqlite_choice', spec: 'targeted', topics: ['数据库'], entities: ['SQLite', 'Postgres'], reasons: ['why'], cands: [cand('选 SQLite 是为了本地优先、零运维。', 0.9)], action: 'speak', depth: 'detail', core: true, note: '高相关 detail' },
  { id: 'x_detail_threads_zh', q: '我们怎么决定用 4 个线程的？', source: 'fixture:golden#detail_threads_choice', spec: 'targeted', topics: ['模型'], reasons: ['why'], cands: [cand('4 threads 是 i7-8850H 上质量/延迟折中点。', 0.87)], action: 'speak', depth: 'detail', core: false, note: '高相关 detail' },
  { id: 'x_detail_nvim_zh', q: 'Neovim 的配置怎么设？', source: 'fixture:golden#detail_neovim', spec: 'targeted', topics: ['配置'], entities: ['Neovim'], reasons: ['entity_question'], cands: [cand('Neovim 配置在 ~/.config/nvim。', 0.88)], action: 'speak', depth: 'detail', core: true, note: '高相关 detail' },
  { id: 'x_detail_deploy_zh', q: '那个部署脚本后来怎么改的？', source: 'fixture:golden#detail_deploy_script', spec: 'targeted', topics: ['部署'], reasons: ['follow_up'], followUp: true, cands: [cand('部署脚本增加了签名校验和回滚。', 0.86)], action: 'speak', depth: 'detail', core: false, note: '高相关 detail' },
  { id: 'x_detail_ci_zh', q: '这个项目用哪个 CI？', source: 'fixture:golden#detail_ci_choice', spec: 'targeted', topics: ['项目'], reasons: ['entity_question'], cands: [cand('CI 用 GitHub Actions。', 0.85)], action: 'speak', depth: 'detail', core: false, note: '高相关 detail' },
  { id: 'x_detail_test_zh', q: '我们的测试策略是什么？', source: 'fixture:golden#detail_test_strategy', spec: 'targeted', topics: ['测试'], reasons: ['entity_question'], cands: [cand('单元测试优先，集成测试覆盖真实路径。', 0.88)], action: 'speak', depth: 'detail', core: false, note: '高相关 detail' },
];

const DETAIL_EN: Row[] = [
  { id: 'x_detail_pnpm_en', q: 'why did we pick pnpm over npm?', source: 'fixture:golden#detail_pnpm_why_en', spec: 'targeted', topics: ['tooling'], entities: ['pnpm', 'npm'], reasons: ['why'], cands: [cand('pnpm was chosen for strict workspace linking.', 0.89)], action: 'speak', depth: 'detail', core: false, note: 'high-relevance detail' },
  { id: 'x_detail_threads_en', q: 'how did we decide on four threads?', source: 'template:detail-en', spec: 'targeted', topics: ['inference'], reasons: ['why'], cands: [cand('Four threads balanced quality and latency.', 0.87)], action: 'speak', depth: 'detail', core: false, note: 'high-relevance detail' },
  { id: 'x_detail_test_en', q: 'what is our testing strategy?', source: 'template:detail-en', spec: 'targeted', topics: ['testing'], reasons: ['entity_question'], cands: [cand('Unit tests first, integration tests cover real paths.', 0.88)], action: 'speak', depth: 'detail', core: false, note: 'high-relevance detail' },
  { id: 'x_detail_ci_en', q: 'which CI does this project use?', source: 'template:detail-en', spec: 'targeted', topics: ['project'], reasons: ['entity_question'], cands: [cand('The project uses GitHub Actions.', 0.85)], action: 'speak', depth: 'detail', core: false, note: 'high-relevance detail' },
];

const QUOTE_ZH: Row[] = [
  { id: 'x_quote_params_zh', q: '那条命令的准确参数是什么？', source: 'fixture:golden#quote_command_params', spec: 'exact', topics: ['命令'], reasons: ['command_request', 'quote_request'], cands: [cand('命令参数是 --threads 4 --ctx-size 32768。', 0.89)], action: 'speak', depth: 'quote', core: false, note: '高相关 quote' },
  { id: 'x_quote_config_zh', q: '我引用的那句配置原文是什么？', source: 'fixture:golden#quote_config_text', spec: 'exact', topics: ['配置', '原文'], reasons: ['quote_request'], cands: [cand('原文是 response_format: json_schema。', 0.87)], action: 'speak', depth: 'quote', core: false, note: '高相关 quote' },
  { id: 'x_quote_path_zh', q: '部署脚本的路径在哪？', source: 'fixture:recall.test.ts#Q07', spec: 'exact', topics: ['路径', '部署'], reasons: ['exact_value'], cands: [cand('部署脚本路径是 /opt/mebular/deploy.sh。', 0.88)], action: 'speak', depth: 'quote', core: false, note: '高相关 quote（路径）' },
  { id: 'x_quote_date_zh', q: '发布日期是哪天？', source: 'fixture:recall.test.ts#Q04', spec: 'exact', topics: ['日期'], reasons: ['exact_value'], cands: [cand('发布日期是 2026-10-30。', 0.86)], action: 'speak', depth: 'quote', core: false, note: '高相关 quote（日期）' },
  { id: 'x_quote_verbatim_zh', q: '把原话给我复述一遍。', source: 'fixture:golden#quote_verbatim', spec: 'exact', topics: ['原文'], reasons: ['quote_request'], cands: [cand('原话是“先别合并，等 CI 绿了再说”。', 0.9)], action: 'speak', depth: 'quote', core: true, note: '高相关 quote' },
];

const QUOTE_EN: Row[] = [
  { id: 'x_quote_cmd_en', q: 'quote the exact deployment command you saved.', source: 'template:quote-en', spec: 'exact', topics: ['command'], reasons: ['command_request', 'quote_request'], cands: [cand('The deployment command is pnpm deploy --prod.', 0.9)], action: 'speak', depth: 'quote', core: false, note: 'high-relevance quote' },
  { id: 'x_quote_path_en', q: "what's the exact path of the deploy script?", source: 'template:quote-en', spec: 'exact', topics: ['path'], reasons: ['exact_value'], cands: [cand('The deploy script is at /opt/mebular/deploy.sh.', 0.88)], action: 'speak', depth: 'quote', core: false, note: 'high-relevance quote' },
  { id: 'x_quote_version_en', q: 'what version did we release?', source: 'template:quote-en', spec: 'exact', topics: ['release'], reasons: ['exact_value'], cands: [cand('The release version is 0.3.0.', 0.87)], action: 'speak', depth: 'quote', core: false, note: 'high-relevance quote' },
];

const SILENT_ZH: Row[] = [
  { id: 'x_sil_movie_zh', q: '推荐一部科幻电影。', source: 'fixture:golden#silent_movie', spec: 'targeted', cands: [cand('用户喜欢《银翼杀手》。', 0.38)], action: 'silent', depth: 'gist', core: true, note: '低分候选 → silent' },
  { id: 'x_sil_stock_zh', q: '今天股市怎么样？', source: 'fixture:golden#silent_stock', spec: 'targeted', cands: [cand('用户关注过一次指数基金。', 0.34)], action: 'silent', depth: 'gist', core: false, note: '低分候选 → silent' },
  { id: 'x_sil_regex_zh', q: '帮我写个正则匹配邮箱。', source: 'fixture:golden#silent_regex', spec: 'targeted', cands: [cand('用户曾用过 email-regex 包。', 0.42)], action: 'silent', depth: 'gist', core: true, note: '低分候选 → silent' },
  { id: 'x_sil_translate_zh', q: '翻译这句话：hello world', source: 'fixture:golden#silent_translate', spec: 'targeted', cands: [cand('用户偏好中文回答。', 0.45)], action: 'silent', depth: 'gist', core: false, note: '低分候选 → silent' },
  { id: 'x_sil_food_zh', q: '有什么好吃的餐厅？', source: 'fixture:golden#silent_restaurant', spec: 'targeted', cands: [cand('用户上次查过一家川菜馆。', 0.31)], action: 'silent', depth: 'gist', core: false, note: '低分候选 → silent' },
  { id: 'x_sil_joke_zh', q: '讲个笑话吧。', source: 'fixture:golden#silent_joke', spec: 'targeted', cands: [cand('用户喜欢冷笑话。', 0.36)], action: 'silent', depth: 'gist', core: false, note: '低分候选 → silent' },
  { id: 'x_sil_weather_zh', q: '明天会下雨吗？', source: 'fixture:golden#silent_weather', spec: 'targeted', cands: [cand('用户在杭州。', 0.4)], action: 'silent', depth: 'gist', core: false, note: '低分候选 → silent' },
  { id: 'x_sil_physics_zh', q: '量子纠缠的退相干时间是多少？', source: 'fixture:acceptance-recall-quality.test.ts#Q14', spec: 'exact', cands: [cand('用户曾聊过量子计算。', 0.33)], action: 'silent', depth: 'gist', core: false, note: '无命中/低分 → silent' },
];

const SILENT_EN: Row[] = [
  { id: 'x_sil_cat_en', q: "what's a good name for a cat?", source: 'fixture:golden#silent_cat_name_en', spec: 'targeted', cands: [cand('User once mentioned a cat named Mochi.', 0.44)], action: 'silent', depth: 'gist', core: false, note: 'low score → silent' },
  { id: 'x_sil_movie_en', q: 'recommend a sci-fi movie.', source: 'template:silent-en', spec: 'targeted', cands: [cand('User liked Blade Runner.', 0.38)], action: 'silent', depth: 'gist', core: false, note: 'low score → silent' },
  { id: 'x_sil_stock_en', q: "how's the stock market today?", source: 'template:silent-en', spec: 'targeted', cands: [cand('User follows one index fund.', 0.34)], action: 'silent', depth: 'gist', core: false, note: 'low score → silent' },
  { id: 'x_sil_translate_en', q: 'translate this sentence: hello world', source: 'template:silent-en', spec: 'targeted', cands: [cand('User prefers Chinese answers.', 0.45)], action: 'silent', depth: 'gist', core: false, note: 'low score → silent' },
];

const AMBIGUOUS_ZH: Row[] = [
  { id: 'x_amb_function_zh', q: '帮我改一下这个函数。', source: 'template:ambiguous-zh', spec: 'targeted', topics: ['项目'], cands: [cand('用户偏好 TypeScript 严格模式。', 0.66, { kind: 'preference', domain: 'preferences' })], core: true, note: '有候选但无硬规则；相关度中等' },
  { id: 'x_amb_optimize_zh', q: '这个方案还能优化吗？', source: 'template:ambiguous-zh', spec: 'targeted', topics: ['项目'], cands: [cand('上次方案评审提出拆小 PR。', 0.64, { kind: 'episode', domain: 'planning' })], core: false, note: '相关度中等' },
  { id: 'x_amb_config_zh', q: '我想调整一下配置。', source: 'template:ambiguous-zh', spec: 'targeted', topics: ['配置'], cands: [cand('用户曾把线程数调到 4。', 0.61, { kind: 'preference', domain: 'inference' })], core: false, note: '相关度中等' },
  { id: 'x_amb_next_zh', q: '接下来做什么比较好？', source: 'template:ambiguous-zh', spec: 'targeted', topics: ['任务'], cands: [cand('当前任务是补 golden set。', 0.7, { kind: 'episode', domain: 'planning' })], core: true, note: '相关度中等偏高' },
  { id: 'x_amb_debug_zh', q: '这个报错怎么排查？', source: 'template:ambiguous-zh', spec: 'targeted', topics: ['故障'], cands: [cand('上次类似报错是端口占用。', 0.68, { kind: 'episode', domain: 'debugging' })], core: true, note: '相关度中等' },
  { id: 'x_amb_messy_zh', q: '最近工作有点乱。', source: 'template:ambiguous-zh', spec: 'broad', cands: [cand('用户偏好每周回顾任务。', 0.6, { kind: 'preference', domain: 'workflow' })], core: false, note: '宽泛 + 中等相关' },
  { id: 'x_amb_organize_zh', q: '帮我整理一下思路。', source: 'template:ambiguous-zh', spec: 'targeted', cands: [cand('用户习惯先写 checklist。', 0.63, { kind: 'preference', domain: 'workflow' })], core: false, note: '相关度中等' },
  { id: 'x_amb_design_zh', q: '这个设计合理吗？', source: 'template:ambiguous-zh', spec: 'targeted', topics: ['项目'], cands: [cand('项目约定零 UI 依赖扩散。', 0.67, { kind: 'preference', domain: 'frontend' })], core: false, note: '相关度中等' },
  { id: 'x_amb_tool_zh', q: '我在考虑换个工具。', source: 'template:ambiguous-zh', spec: 'targeted', topics: ['工具'], cands: [cand('用户统一用 pnpm。', 0.65, { kind: 'preference', domain: 'tooling' })], core: false, note: '相关度中等' },
  { id: 'x_amb_simpler_zh', q: '有没有更简单的做法？', source: 'template:ambiguous-zh', spec: 'targeted', cands: [cand('上次决定先冻结契约。', 0.62, { kind: 'episode', domain: 'planning' })], core: false, note: '相关度中等' },
  { id: 'x_amb_process_zh', q: '这个流程要不要改？', source: 'template:ambiguous-zh', spec: 'targeted', topics: ['流程'], cands: [cand('发布流程拆成四步。', 0.69, { kind: 'skill', domain: 'release' })], core: false, note: '相关度中等' },
  { id: 'x_amb_direction_zh', q: '先按这个方向做吧。', source: 'template:ambiguous-zh', spec: 'broad', cands: [cand('用户上次选了方案 B。', 0.6, { kind: 'episode', domain: 'planning' })], core: false, note: '宽泛 + 中等相关' },
];

const AMBIGUOUS_EN: Row[] = [
  { id: 'x_amb_function_en', q: 'can you help me improve this function?', source: 'template:ambiguous-en', spec: 'targeted', topics: ['project'], cands: [cand('User prefers strict TypeScript.', 0.66, { kind: 'preference', domain: 'preferences' })], core: true, note: 'eligible but mid-band' },
  { id: 'x_amb_design_en', q: 'is this design reasonable?', source: 'template:ambiguous-en', spec: 'targeted', cands: [cand('The project keeps zero UI dependency spread.', 0.67, { kind: 'preference', domain: 'frontend' })], core: false, note: 'eligible but mid-band' },
  { id: 'x_amb_next_en', q: 'what should I do next?', source: 'template:ambiguous-en', spec: 'targeted', topics: ['task'], cands: [cand('The current task is the golden-set gap.', 0.7, { kind: 'episode', domain: 'planning' })], core: false, note: 'eligible but mid-band' },
  { id: 'x_amb_tools_en', q: "I'm thinking about switching tools.", source: 'template:ambiguous-en', spec: 'targeted', cands: [cand('The user standardizes on pnpm.', 0.65, { kind: 'preference', domain: 'tooling' })], core: false, note: 'eligible but mid-band' },
  { id: 'x_amb_debug_en', q: 'how should I troubleshoot this error?', source: 'template:ambiguous-en', spec: 'targeted', topics: ['error'], cands: [cand('A similar error was caused by a port conflict.', 0.68, { kind: 'episode', domain: 'debugging' })], core: true, note: 'eligible but mid-band' },
  { id: 'x_amb_simpler_en', q: 'is there a simpler approach?', source: 'template:ambiguous-en', spec: 'targeted', cands: [cand('We decided to freeze the contract first.', 0.62, { kind: 'episode', domain: 'planning' })], core: false, note: 'eligible but mid-band' },
  { id: 'x_amb_config_en', q: "let's adjust the configuration.", source: 'template:ambiguous-en', spec: 'targeted', topics: ['config'], cands: [cand('The user once set threads to 4.', 0.61, { kind: 'preference', domain: 'inference' })], core: false, note: 'eligible but mid-band' },
  { id: 'x_amb_thoughts_en', q: 'help me organize my thoughts.', source: 'template:ambiguous-en', spec: 'targeted', cands: [cand('The user prefers checklists first.', 0.63, { kind: 'preference', domain: 'workflow' })], core: false, note: 'eligible but mid-band' },
];

export const RULE_CORPUS: readonly RuleCorpusCase[] = Object.freeze([
  ...row('must_speak', 'zh', 'hard', MUST_ZH),
  ...row('must_speak', 'en', 'hard', MUST_EN),
  ...row('no_candidates', 'zh', 'hard', NOCAND_ZH),
  ...row('no_candidates', 'en', 'hard', NOCAND_EN),
  ...row('novelty_zero', 'zh', 'hard', NOVELTY_ZH),
  ...row('novelty_zero', 'en', 'hard', NOVELTY_EN),
  ...row('conflict', 'zh', 'hard', CONFLICT_ZH),
  ...row('conflict', 'en', 'hard', CONFLICT_EN),
  ...row('defer', 'zh', 'hard', DEFER_ZH),
  ...row('defer', 'en', 'hard', DEFER_EN),
  ...row('greeting', 'zh', 'hard', GREETING_ZH),
  ...row('greeting', 'en', 'hard', GREETING_EN),
  ...row('meta', 'zh', 'hard', META_ZH),
  ...row('meta', 'en', 'hard', META_EN),
  ...row('detail', 'zh', 'deterministic', DETAIL_ZH),
  ...row('detail', 'en', 'deterministic', DETAIL_EN),
  // 精确值/命令/引用在策略表第 3 行属于 must_speak，不是 heuristic 分数档。
  ...row('quote', 'zh', 'hard', QUOTE_ZH),
  ...row('quote', 'en', 'hard', QUOTE_EN),
  ...row('silent_low_relevance', 'zh', 'deterministic', SILENT_ZH),
  ...row('silent_low_relevance', 'en', 'deterministic', SILENT_EN),
  ...row('ambiguous', 'zh', 'grey', AMBIGUOUS_ZH),
  ...row('ambiguous', 'en', 'grey', AMBIGUOUS_EN),
]);

export const RULE_CORPUS_PROVENANCE = Object.freeze({
  fixture: 'query copied from an existing test/fixture (recall.test.ts, acceptance-recall-quality.test.ts, golden set)',
  template: 'synthetic turn generated from a declared zh/en template, not collected from users',
  scoreBands: { high: [0.82, 0.93], mid: [0.58, 0.72], low: [0.31, 0.45] },
  limits: [
    'No real user traffic and no sampling frame; composition is declared, not measured.',
    'Candidate scores are band-assigned, not produced by the production retriever.',
    'Queries are short synthetic turns; they do not represent long multi-turn threads.',
    'The corpus deliberately over-samples hard slices to verify rule coverage; it is not a traffic prior.',
  ],
});

/** 供 golden set 的类型参考；防止 golden set 的导出被 tree-shake 后类型漂移。 */
export type GoldenCaseRef = GoldenCase;
