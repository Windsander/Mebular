// 0.4.0 W0.5：小模型零样本 planner 横评 golden set。
//
// 这是一份 test-only、人工标注的合成 cue 集，不是产品验收标准，也不是真实用户数据。
// 期望 action/depth 是写给本基准的固定标签，用于跨模型比较；changing them changes the
// benchmark, so keep the file reviewable and versioned.
//
// 覆盖维度：must_speak（显式回忆 / 精确值 / 任务续接）、silent（寒暄 / meta / 低相关 /
// 无候选）、defer（本轮先不注入）、gist/detail/quote、已注入 novelty=0、冲突。
//
// 设计约束：
//   - query 是合成文本；模型 prompt 可以选择带 query（promptMode=query）或不带（aggregate）；
//   - candidates 只含 kind/domain/gist/score/confidence/ageDays/novelty/conflict，
//     不含 detail 正文、token、真实路径或用户数据；
//   - expected 是固定标签，不由 heuristic 或模型输出反推；
//   - `legacy` 仅用于让 heuristic 基线（planIntervention）看到与 case 语义一致的 rawQuery。

export type GoldenAction = 'speak' | 'defer' | 'silent';
export type GoldenDepth = 'gist' | 'detail' | 'quote';
export type GoldenDimension =
  | 'greeting'
  | 'meta'
  | 'must_speak'
  | 'task_continue'
  | 'exact_quote'
  | 'gist'
  | 'detail'
  | 'defer'
  | 'silent_low_relevance'
  | 'no_candidates'
  | 'novelty_zero'
  | 'conflict';

export interface GoldenCandidate {
  kind: string;
  domain: string;
  gist: string;
  score: number;
  confidence: number;
  ageDays: number;
  /** 1 = 本候选从未注入；0 = 已注入（novelty=0）。 */
  novelty: 0 | 1;
  conflict: boolean;
}

export interface GoldenCase {
  id: string;
  dimension: GoldenDimension;
  note: string;
  query: string;
  specificity: 'broad' | 'targeted' | 'exact';
  topics: string[];
  entities: string[];
  /** 与产品 cue.detailIntent.reasons 同名字符串。 */
  reasons: string[];
  followUp: boolean;
  candidates: GoldenCandidate[];
  /** 已注入的 source/fragment ID；heuristic 用它计算 novelty。 */
  injectedIds: string[];
  expected: { action: GoldenAction; depth: GoldenDepth };
  /** true = 关键 case，至少重复 2 次。 */
  core: boolean;
}

function cand(
  gist: string,
  options: Partial<Omit<GoldenCandidate, 'gist'>> = {},
): GoldenCandidate {
  return {
    kind: options.kind ?? 'fact',
    domain: options.domain ?? 'general',
    gist,
    score: options.score ?? 0.82,
    confidence: options.confidence ?? 0.8,
    ageDays: options.ageDays ?? 3,
    novelty: options.novelty ?? 1,
    conflict: options.conflict ?? false,
  };
}

function injected(candidate: GoldenCandidate): { candidate: GoldenCandidate; ids: string[] } {
  return { candidate: { ...candidate, novelty: 0 }, ids: [`rec_${candidate.kind}_injected`, `mf_injected`] };
}

// novelty=0 的注入 ID 与候选的 fragmentId 对齐由 harness 的 cue 适配层完成；
// 这里保留稳定的 source IDs，供 heuristic 的 noveltyOf() 命中。

const CASES: GoldenCase[] = [
  // ---------- 寒暄：即使候选分高也应 silent ----------
  {
    id: 'greet_hello_zh', dimension: 'greeting', note: '固定中文问候',
    query: '你好！', specificity: 'broad', topics: [], entities: [], reasons: ['chitchat'], followUp: false,
    candidates: [cand('用户偏好深色主题。', { score: 0.78, domain: 'preferences' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: true,
  },
  {
    id: 'greet_morning', dimension: 'greeting', note: '中文早安',
    query: '早上好', specificity: 'broad', topics: [], entities: [], reasons: ['chitchat'], followUp: false,
    candidates: [cand('用户通常在上午做代码审查。', { score: 0.72, domain: 'workflow' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'greet_are_you_there', dimension: 'greeting', note: '在线确认',
    query: '嗨，在吗', specificity: 'broad', topics: [], entities: [], reasons: ['chitchat'], followUp: false,
    candidates: [], injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'greet_hello_en', dimension: 'greeting', note: '英文问候',
    query: 'hello', specificity: 'broad', topics: [], entities: [], reasons: ['chitchat'], followUp: false,
    candidates: [cand('User prefers concise answers.', { score: 0.76, domain: 'preferences' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'greet_evening', dimension: 'greeting', note: '晚间问候',
    query: '晚上好呀', specificity: 'broad', topics: [], entities: [], reasons: ['chitchat'], followUp: false,
    candidates: [], injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'greet_thanks', dimension: 'greeting', note: '致谢，不注入记忆',
    query: '谢谢！', specificity: 'broad', topics: [], entities: [], reasons: ['chitchat'], followUp: false,
    candidates: [cand('用户上次感谢了发布检查清单。', { score: 0.74, domain: 'workflow' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: true,
  },
  {
    id: 'greet_ack', dimension: 'greeting', note: '确认收到',
    query: '收到，辛苦了', specificity: 'broad', topics: [], entities: [], reasons: ['chitchat'], followUp: false,
    candidates: [], injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'greet_hi_there', dimension: 'greeting', note: '英文寒暄',
    query: 'hi there', specificity: 'broad', topics: [], entities: [], reasons: ['chitchat'], followUp: false,
    candidates: [cand('User uses a dark terminal theme.', { score: 0.79, domain: 'preferences' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },

  // ---------- meta：问助手自身，不应注入长期记忆 ----------
  {
    id: 'meta_who_are_you', dimension: 'meta', note: '问助手身份',
    query: '你是谁？', specificity: 'broad', topics: [], entities: [], reasons: ['entity_question'], followUp: false,
    candidates: [cand('用户给助手起过昵称“老喵”。', { score: 0.7, domain: 'preferences' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: true,
  },
  {
    id: 'meta_capabilities', dimension: 'meta', note: '问能力边界',
    query: '你能做什么？', specificity: 'broad', topics: [], entities: [], reasons: ['entity_question'], followUp: false,
    candidates: [], injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'meta_how_to_use', dimension: 'meta', note: '问产品用法',
    query: '这个怎么用？', specificity: 'broad', topics: ['产品'], entities: [], reasons: ['entity_question'], followUp: false,
    candidates: [cand('用户曾配置过本地模型路径。', { score: 0.66, domain: 'setup' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'meta_what_model', dimension: 'meta', note: '英文问模型身份',
    query: 'what model are you?', specificity: 'broad', topics: [], entities: [], reasons: ['entity_question'], followUp: false,
    candidates: [], injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'meta_explain_ability', dimension: 'meta', note: '问能力解释',
    query: '帮我解释一下你的能力', specificity: 'broad', topics: [], entities: [], reasons: ['entity_question'], followUp: false,
    candidates: [], injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'meta_time', dimension: 'meta', note: '问当前时间，不是记忆请求',
    query: '现在几点了？', specificity: 'broad', topics: ['时间'], entities: [], reasons: ['entity_question'], followUp: false,
    candidates: [cand('用户所在时区是 Asia/Shanghai。', { score: 0.8, domain: 'preferences' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: true,
  },

  // ---------- must_speak：显式回忆 / 追问 ----------
  {
    id: 'must_port_remember', dimension: 'must_speak', note: '显式追问部署端口',
    query: '你还记得我上次说过的部署端口吗？', specificity: 'exact', topics: ['部署', '端口'], entities: [],
    reasons: ['exact_value', 'follow_up'], followUp: true,
    candidates: [cand('用户上次说部署端口是 8080。', { kind: 'fact', domain: 'deploy', score: 0.93 })],
    injectedIds: [], expected: { action: 'speak', depth: 'quote' }, core: true,
  },
  {
    id: 'must_database_name', dimension: 'must_speak', note: '显式追问数据库名',
    query: '我之前说的数据库名是什么？', specificity: 'exact', topics: ['数据库'], entities: [],
    reasons: ['exact_value'], followUp: false,
    candidates: [cand('主库数据库名是 mebular_dev。', { kind: 'fact', domain: 'database', score: 0.91 })],
    injectedIds: [], expected: { action: 'speak', depth: 'quote' }, core: true,
  },
  {
    id: 'must_pnpm_forgot', dimension: 'must_speak', note: '“你忘了”触发显式回忆',
    query: '你忘了我说过要用 pnpm 吗？', specificity: 'exact', topics: ['命令'], entities: ['pnpm'],
    reasons: ['exact_value'], followUp: false,
    candidates: [cand('用户要求包管理器统一用 pnpm。', { kind: 'preference', domain: 'tooling', score: 0.9 })],
    injectedIds: [], expected: { action: 'speak', depth: 'quote' }, core: false,
  },
  {
    id: 'must_release_flow', dimension: 'must_speak', note: '追问上次发布流程',
    query: '还记得我们上次定的发布流程吗？', specificity: 'targeted', topics: ['发布', '任务'], entities: [],
    reasons: ['follow_up'], followUp: true,
    candidates: [cand('发布流程是先跑 lint，再跑测试，最后打 tag。', { kind: 'skill', domain: 'release', score: 0.88 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: true,
  },
  {
    id: 'must_command_quote', dimension: 'must_speak', note: '追问原命令',
    query: '我说过的那条命令是什么？', specificity: 'exact', topics: ['命令'], entities: [],
    reasons: ['exact_value', 'quote_request'], followUp: false,
    candidates: [cand('部署命令是 pnpm build && pnpm deploy --prod。', { kind: 'skill', domain: 'deploy', score: 0.92 })],
    injectedIds: [], expected: { action: 'speak', depth: 'quote' }, core: false,
  },
  {
    id: 'must_project_path', dimension: 'must_speak', note: '追问项目路径',
    query: '之前提到的项目路径在哪？', specificity: 'exact', topics: ['路径', '项目'], entities: [],
    reasons: ['exact_value', 'follow_up'], followUp: false,
    candidates: [cand('项目路径是 /srv/work/mebular。', { kind: 'fact', domain: 'project', score: 0.87 })],
    injectedIds: [], expected: { action: 'speak', depth: 'quote' }, core: false,
  },
  {
    id: 'must_timezone_pref', dimension: 'must_speak', note: '追问时区偏好',
    query: '你记得我的时区偏好吗？', specificity: 'targeted', topics: ['偏好', '时间'], entities: [],
    reasons: ['follow_up'], followUp: false,
    candidates: [cand('用户偏好按 Asia/Shanghai 显示时间。', { kind: 'preference', domain: 'preferences', score: 0.86 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
  {
    id: 'must_branch_rule', dimension: 'must_speak', note: '追问分支禁用规则',
    query: '上次我让你别用默认分支，还记得吗？', specificity: 'targeted', topics: ['项目'], entities: [],
    reasons: ['follow_up'], followUp: true,
    candidates: [cand('用户要求不要直接提交到 main，必须开分支。', { kind: 'preference', domain: 'git', score: 0.89 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: true,
  },
  {
    id: 'must_lint_first', dimension: 'must_speak', note: '“你不是说过”触发回忆',
    query: '你不是说过测试要先跑 lint 吗？', specificity: 'targeted', topics: ['测试'], entities: [],
    reasons: ['follow_up'], followUp: false,
    candidates: [cand('测试前必须先跑 lint。', { kind: 'skill', domain: 'testing', score: 0.88 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
  {
    id: 'must_naming_rule', dimension: 'must_speak', note: '追问命名规范',
    query: '我上次强调的命名规范是什么？', specificity: 'targeted', topics: ['项目'], entities: [],
    reasons: ['follow_up'], followUp: false,
    candidates: [cand('文件名统一用 kebab-case。', { kind: 'preference', domain: 'style', score: 0.85 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },

  // ---------- task_continue：硬规则 must_speak ----------
  {
    id: 'task_continue_deploy', dimension: 'task_continue', note: '继续部署任务',
    query: '继续刚才那个部署任务。', specificity: 'targeted', topics: ['部署', '任务'], entities: [],
    reasons: ['task_continue', 'follow_up'], followUp: true,
    candidates: [cand('部署任务停在第 3 步：校验产物签名。', { kind: 'episode', domain: 'deploy', score: 0.9 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: true,
  },
  {
    id: 'task_continue_migration', dimension: 'task_continue', note: '继续迁移脚本',
    query: '接着上次的迁移脚本往下写。', specificity: 'targeted', topics: ['脚本', '任务'], entities: [],
    reasons: ['task_continue'], followUp: true,
    candidates: [cand('迁移脚本已完成 users 表，下一步是 orders 表。', { kind: 'episode', domain: 'database', score: 0.88 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
  {
    id: 'task_continue_bug', dimension: 'task_continue', note: '回到 bug 排查',
    query: '我们回到刚才的 bug 排查。', specificity: 'targeted', topics: ['故障', '任务'], entities: [],
    reasons: ['task_continue', 'follow_up'], followUp: true,
    candidates: [cand('bug 排查停在复现 500 错误这一步。', { kind: 'episode', domain: 'debugging', score: 0.86 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: true,
  },
  {
    id: 'task_continue_release_en', dimension: 'task_continue', note: '英文任务续接',
    query: 'continue the release checklist from where we stopped.', specificity: 'targeted', topics: ['release', 'task'], entities: [],
    reasons: ['task_continue'], followUp: true,
    candidates: [cand('Release checklist stopped at signing the desktop build.', { kind: 'episode', domain: 'release', score: 0.9 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
  {
    id: 'task_continue_split', dimension: 'task_continue', note: '按之前分工继续',
    query: '按之前的分工继续。', specificity: 'targeted', topics: ['任务'], entities: [],
    reasons: ['task_continue'], followUp: true,
    candidates: [cand('分工是 A 写测试、B 改文档。', { kind: 'episode', domain: 'planning', score: 0.84 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
  {
    id: 'task_next_step', dimension: 'task_continue', note: '任务上下文中的下一步',
    query: '下一步该做什么？', specificity: 'targeted', topics: ['任务'], entities: [],
    reasons: ['task_continue'], followUp: true,
    candidates: [cand('当前任务下一步是补 golden set 的冲突用例。', { kind: 'episode', domain: 'planning', score: 0.83 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },

  // ---------- exact_quote：精确值 / 原文 ----------
  {
    id: 'quote_port_choice', dimension: 'exact_quote', note: '端口二选一',
    query: '当时说的端口是 8080 还是 9090？', specificity: 'exact', topics: ['端口'], entities: [],
    reasons: ['exact_value', 'conflict'], followUp: true,
    candidates: [cand('部署端口记录为 8080。', { kind: 'fact', domain: 'deploy', score: 0.93 })],
    injectedIds: [], expected: { action: 'speak', depth: 'quote' }, core: true,
  },
  {
    id: 'quote_verbatim', dimension: 'exact_quote', note: '要求原话',
    query: '把原话给我复述一遍。', specificity: 'exact', topics: ['原文'], entities: [],
    reasons: ['quote_request', 'follow_up'], followUp: true,
    candidates: [cand('原话是“先别合并，等 CI 绿了再说”。', { kind: 'episode', domain: 'git', score: 0.9 })],
    injectedIds: [], expected: { action: 'speak', depth: 'quote' }, core: true,
  },
  {
    id: 'quote_command_params', dimension: 'exact_quote', note: '命令精确参数',
    query: '那条命令的准确参数是什么？', specificity: 'exact', topics: ['命令'], entities: [],
    reasons: ['command_request', 'quote_request'], followUp: false,
    candidates: [cand('命令参数是 --threads 4 --ctx-size 32768。', { kind: 'skill', domain: 'inference', score: 0.89 })],
    injectedIds: [], expected: { action: 'speak', depth: 'quote' }, core: false,
  },
  {
    id: 'quote_config_text', dimension: 'exact_quote', note: '配置原文',
    query: '我引用的那句配置原文是什么？', specificity: 'exact', topics: ['配置', '原文'], entities: [],
    reasons: ['quote_request'], followUp: false,
    candidates: [cand('原文是 response_format: json_schema。', { kind: 'fact', domain: 'config', score: 0.87 })],
    injectedIds: [], expected: { action: 'speak', depth: 'quote' }, core: false,
  },
  {
    id: 'quote_version', dimension: 'exact_quote', note: '版本号精确值',
    query: '版本号到底是 1.2.3 还是 1.2.4？', specificity: 'exact', topics: ['版本'], entities: [],
    reasons: ['exact_value', 'conflict'], followUp: false,
    candidates: [cand('版本号记录为 1.2.4。', { kind: 'fact', domain: 'release', score: 0.92 })],
    injectedIds: [], expected: { action: 'speak', depth: 'quote' }, core: false,
  },
  {
    id: 'quote_deploy_en', dimension: 'exact_quote', note: '英文精确命令',
    query: 'quote the exact deployment command you saved.', specificity: 'exact', topics: ['command'], entities: [],
    reasons: ['command_request', 'quote_request'], followUp: false,
    candidates: [cand('The deployment command is pnpm deploy --prod.', { kind: 'skill', domain: 'deploy', score: 0.91 })],
    injectedIds: [], expected: { action: 'speak', depth: 'quote' }, core: false,
  },

  // ---------- gist：概览即可 ----------
  {
    id: 'gist_tech_pref', dimension: 'gist', note: '概览技术偏好',
    query: '简单说下我的技术偏好。', specificity: 'targeted', topics: ['偏好'], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户偏好 TypeScript、pnpm、深色主题。', { kind: 'preference', domain: 'preferences', score: 0.84 })],
    injectedIds: [], expected: { action: 'speak', depth: 'gist' }, core: true,
  },
  {
    id: 'gist_frontend_decisions', dimension: 'gist', note: '概览前端决策',
    query: '概览一下我们做过的前端决策。', specificity: 'broad', topics: ['项目'], entities: [], reasons: [], followUp: false,
    candidates: [cand('前端使用 React + Vite，并保持零 UI 依赖扩散。', { kind: 'episode', domain: 'frontend', score: 0.78 })],
    injectedIds: [], expected: { action: 'speak', depth: 'gist' }, core: false,
  },
  {
    id: 'gist_stack', dimension: 'gist', note: '常用技术栈',
    query: '我的常用技术栈是什么？', specificity: 'targeted', topics: ['偏好'], entities: [], reasons: ['entity_question'], followUp: false,
    candidates: [cand('用户常用 Node.js、TypeScript、SQLite。', { kind: 'preference', domain: 'stack', score: 0.85 })],
    injectedIds: [], expected: { action: 'speak', depth: 'gist' }, core: false,
  },
  {
    id: 'gist_preferences_en', dimension: 'gist', note: '英文概览偏好',
    query: 'summarize my coding preferences briefly.', specificity: 'targeted', topics: ['preferences'], entities: [], reasons: [], followUp: false,
    candidates: [cand('User prefers small PRs and explicit error handling.', { kind: 'preference', domain: 'preferences', score: 0.83 })],
    injectedIds: [], expected: { action: 'speak', depth: 'gist' }, core: false,
  },
  {
    id: 'gist_test_framework', dimension: 'gist', note: '测试框架概览',
    query: '我们一般用什么测试框架？', specificity: 'targeted', topics: ['测试'], entities: [], reasons: ['entity_question'], followUp: false,
    candidates: [cand('测试主要用 Jest，集成测试放在 tests/integration。', { kind: 'fact', domain: 'testing', score: 0.86 })],
    injectedIds: [], expected: { action: 'speak', depth: 'gist' }, core: false,
  },
  {
    id: 'gist_editor_habit', dimension: 'gist', note: '编辑器习惯概览',
    query: '我的编辑器习惯大概是什么？', specificity: 'targeted', topics: ['偏好'], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户用 Neovim，偏键盘操作、少用鼠标。', { kind: 'preference', domain: 'editor', score: 0.81 })],
    injectedIds: [], expected: { action: 'speak', depth: 'gist' }, core: false,
  },

  // ---------- detail：需要解释/上下文 ----------
  {
    id: 'detail_sqlite_choice', dimension: 'detail', note: '解释数据库选型',
    query: '为什么当时选了 SQLite 而不是 Postgres？', specificity: 'targeted', topics: ['数据库'], entities: ['SQLite', 'Postgres'],
    reasons: ['why'], followUp: false,
    candidates: [cand('选 SQLite 是为了本地优先、零运维和单文件迁移。', { kind: 'episode', domain: 'database', score: 0.9 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: true,
  },
  {
    id: 'detail_threads_choice', dimension: 'detail', note: '解释线程数决策',
    query: '我们怎么决定用 4 个线程的？', specificity: 'targeted', topics: ['模型'], entities: [],
    reasons: ['why'], followUp: false,
    candidates: [cand('4 threads 是在 i7-8850H 上质量/延迟折中点。', { kind: 'episode', domain: 'inference', score: 0.87 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
  {
    id: 'detail_neovim', dimension: 'detail', note: '具体实体配置',
    query: 'Neovim 的配置怎么设？', specificity: 'targeted', topics: ['配置'], entities: ['Neovim'],
    reasons: ['entity_question'], followUp: false,
    candidates: [cand('Neovim 配置在 ~/.config/nvim，使用 lazy.nvim。', { kind: 'fact', domain: 'editor', score: 0.88 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: true,
  },
  {
    id: 'detail_deploy_script', dimension: 'detail', note: '脚本后续改动',
    query: '那个部署脚本后来怎么改的？', specificity: 'targeted', topics: ['部署', '脚本'], entities: [],
    reasons: ['follow_up'], followUp: true,
    candidates: [cand('部署脚本后来增加了签名校验和失败回滚。', { kind: 'episode', domain: 'deploy', score: 0.86 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
  {
    id: 'detail_test_strategy', dimension: 'detail', note: '测试策略',
    query: '我们的测试策略是什么？', specificity: 'targeted', topics: ['测试'], entities: [],
    reasons: ['entity_question'], followUp: false,
    candidates: [cand('单元测试优先，集成测试覆盖真实路径，默认跳过网络。', { kind: 'skill', domain: 'testing', score: 0.88 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
  {
    id: 'detail_pnpm_why_en', dimension: 'detail', note: '英文解释选型',
    query: 'why did we pick pnpm over npm?', specificity: 'targeted', topics: ['tooling'], entities: ['pnpm', 'npm'],
    reasons: ['why'], followUp: false,
    candidates: [cand('pnpm was chosen for strict workspace linking and disk savings.', { kind: 'episode', domain: 'tooling', score: 0.89 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
  {
    id: 'detail_ci_choice', dimension: 'detail', note: 'CI 选择',
    query: '这个项目用哪个 CI？', specificity: 'targeted', topics: ['项目'], entities: [],
    reasons: ['entity_question'], followUp: false,
    candidates: [cand('CI 用 GitHub Actions，macOS x64 是主要 canary。', { kind: 'fact', domain: 'ci', score: 0.85 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
  {
    id: 'detail_error_fix', dimension: 'detail', note: '报错如何解决',
    query: '那条报错最后是怎么解决的？', specificity: 'targeted', topics: ['故障', '错误'], entities: [],
    reasons: ['follow_up', 'why'], followUp: true,
    candidates: [cand('报错是端口占用，最后改成随机端口启动。', { kind: 'episode', domain: 'debugging', score: 0.86 })],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },

  // ---------- defer：本轮先不注入 ----------
  {
    id: 'defer_finish_code', dimension: 'defer', note: '先写完代码再回忆',
    query: '先别回忆，等我写完这段代码再说。', specificity: 'targeted', topics: ['任务'], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户上次要求先跑 lint 再测试。', { kind: 'preference', domain: 'testing', score: 0.86 })],
    injectedIds: [], expected: { action: 'defer', depth: 'gist' }, core: true,
  },
  {
    id: 'defer_later', dimension: 'defer', note: '晚点再聊记忆',
    query: '这个先放一放，我们晚点再聊记忆。', specificity: 'targeted', topics: ['记忆'], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户偏好按周回顾记忆。', { kind: 'preference', domain: 'memory', score: 0.82 })],
    injectedIds: [], expected: { action: 'defer', depth: 'gist' }, core: false,
  },
  {
    id: 'defer_focus_pipeline', dimension: 'defer', note: '专注当前流程',
    query: '现在只专注跑步流程，别注入旧上下文。', specificity: 'targeted', topics: ['任务'], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户上周记录过跑步配速偏好。', { kind: 'preference', domain: 'fitness', score: 0.88 })],
    injectedIds: [], expected: { action: 'defer', depth: 'gist' }, core: true,
  },
  {
    id: 'defer_reproduce_bug', dimension: 'defer', note: '先复现再查记录',
    query: '等我把错误复现出来再查以前的记录。', specificity: 'targeted', topics: ['故障'], entities: [], reasons: [], followUp: false,
    candidates: [cand('上次相同错误是缓存未清导致的。', { kind: 'episode', domain: 'debugging', score: 0.85 })],
    injectedIds: [], expected: { action: 'defer', depth: 'gist' }, core: false,
  },
  {
    id: 'defer_refactor_en', dimension: 'defer', note: '英文 defer',
    query: 'hold off on memory for now; let me finish this refactor.', specificity: 'targeted', topics: ['task'], entities: [], reasons: [], followUp: false,
    candidates: [cand('User prefers refactors in small commits.', { kind: 'preference', domain: 'git', score: 0.84 })],
    injectedIds: [], expected: { action: 'defer', depth: 'gist' }, core: false,
  },
  {
    id: 'defer_from_scratch', dimension: 'defer', note: '从零试一次',
    query: '先不查历史，我想从零试一次。', specificity: 'targeted', topics: ['任务'], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户以前遇到过相同的初始化错误。', { kind: 'episode', domain: 'setup', score: 0.83 })],
    injectedIds: [], expected: { action: 'defer', depth: 'gist' }, core: false,
  },
  {
    id: 'defer_let_me_think', dimension: 'defer', note: '自己想，不要旧方案',
    query: '暂时不要提以前的方案，让我自己想想。', specificity: 'targeted', topics: ['任务'], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户以前选过方案 B。', { kind: 'episode', domain: 'planning', score: 0.87 })],
    injectedIds: [], expected: { action: 'defer', depth: 'gist' }, core: true,
  },
  {
    id: 'defer_next_turn', dimension: 'defer', note: '下一轮再回顾',
    query: '下一轮再回顾偏好，这一轮先改代码。', specificity: 'targeted', topics: ['任务', '偏好'], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户偏好 100 字符行宽。', { kind: 'preference', domain: 'style', score: 0.8 })],
    injectedIds: [], expected: { action: 'defer', depth: 'gist' }, core: false,
  },

  // ---------- silent：低相关候选 ----------
  {
    id: 'silent_movie', dimension: 'silent_low_relevance', note: '弱相关电影推荐',
    query: '推荐一部科幻电影。', specificity: 'targeted', topics: [], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户喜欢《银翼杀手》。', { score: 0.38, domain: 'media' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: true,
  },
  {
    id: 'silent_stock', dimension: 'silent_low_relevance', note: '股市问题',
    query: '今天股市怎么样？', specificity: 'targeted', topics: [], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户关注过一次指数基金。', { score: 0.34, domain: 'finance' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'silent_regex', dimension: 'silent_low_relevance', note: '写正则',
    query: '帮我写个正则匹配邮箱。', specificity: 'targeted', topics: [], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户曾用过 email-regex 包。', { score: 0.42, domain: 'coding' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: true,
  },
  {
    id: 'silent_translate', dimension: 'silent_low_relevance', note: '翻译',
    query: '翻译这句话：hello world', specificity: 'targeted', topics: [], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户偏好中文回答。', { score: 0.45, domain: 'preferences' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'silent_restaurant', dimension: 'silent_low_relevance', note: '餐厅推荐',
    query: '有什么好吃的餐厅？', specificity: 'targeted', topics: [], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户上次查过一家川菜馆。', { score: 0.31, domain: 'food' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'silent_joke', dimension: 'silent_low_relevance', note: '讲笑话',
    query: '讲个笑话吧。', specificity: 'targeted', topics: [], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户喜欢冷笑话。', { score: 0.36, domain: 'preferences' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'silent_weather', dimension: 'silent_low_relevance', note: '天气',
    query: '明天会下雨吗？', specificity: 'targeted', topics: [], entities: [], reasons: [], followUp: false,
    candidates: [cand('用户在杭州。', { score: 0.4, domain: 'location' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'silent_cat_name_en', dimension: 'silent_low_relevance', note: '英文取名',
    query: "what's a good name for a cat?", specificity: 'targeted', topics: [], entities: [], reasons: [], followUp: false,
    candidates: [cand('User once mentioned a cat named Mochi.', { score: 0.44, domain: 'personal' })],
    injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },

  // ---------- 无候选 ----------
  {
    id: 'nocand_plan', dimension: 'no_candidates', note: '没有候选',
    query: '帮我看看这个方案。', specificity: 'targeted', topics: [], entities: [], reasons: [], followUp: false,
    candidates: [], injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: true,
  },
  {
    id: 'nocand_function', dimension: 'no_candidates', note: '没有候选',
    query: '这个函数有什么问题？', specificity: 'targeted', topics: [], entities: [], reasons: ['entity_question'], followUp: false,
    candidates: [], injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'nocand_chat', dimension: 'no_candidates', note: '没有候选',
    query: '随便聊聊。', specificity: 'broad', topics: [], entities: [], reasons: [], followUp: false,
    candidates: [], injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },
  {
    id: 'nocand_ok', dimension: 'no_candidates', note: '没有候选',
    query: '先这样吧。', specificity: 'broad', topics: [], entities: [], reasons: [], followUp: false,
    candidates: [], injectedIds: [], expected: { action: 'silent', depth: 'gist' }, core: false,
  },

  // ---------- novelty=0：已注入 ----------
  ...([
    ['novelty_theme', '深色主题的偏好再确认下。', '用户偏好深色主题。', 'preferences', ['偏好']],
    ['novelty_port', '我的部署端口是多少？', '部署端口是 8080。', 'deploy', ['端口', '部署']],
    ['novelty_editor', '我的编辑器配置是什么？', '用户使用 Neovim 和 lazy.nvim。', 'editor', ['配置']],
    ['novelty_test_runner', '我们用的测试框架是哪个？', '测试主要用 Jest。', 'testing', ['测试']],
    ['novelty_timezone', '我的时区偏好是怎样的？', '用户偏好 Asia/Shanghai。', 'preferences', ['偏好', '时间']],
    ['novelty_database_url', '数据库连接串用的是哪个？', '开发库连接串指向 mebular_dev。', 'database', ['数据库']],
    ['novelty_package_manager', '我常用的包管理器是什么？', '用户统一用 pnpm。', 'tooling', ['命令']],
    ['novelty_branch_rule', '发布分支的命名规则是什么？', '发布分支用 release/vX.Y.Z。', 'git', ['项目']],
    ['novelty_formatter_en', 'my preferred code formatter?', 'User prefers Biome for formatting.', 'tooling', ['preferences']],
    ['novelty_runner_en', 'which test runner do we use?', 'The project uses Jest with Node ESM.', 'testing', ['testing']],
  ] as Array<[string, string, string, string, string[]]>).map(([id, query, gist, domain, topics]) => {
    const source = cand(gist, { kind: 'preference', domain, score: 0.88 });
    const prepared = injected({ ...source, kind: 'fact' });
    return {
      id, dimension: 'novelty_zero' as const, note: '候选已注入，novelty=0，应 silent',
      query, specificity: 'targeted' as const, topics, entities: [],
      reasons: /\b(what|which)\b|什么|哪个|多少/i.test(query) ? ['entity_question'] : [],
      followUp: false,
      candidates: [prepared.candidate],
      injectedIds: prepared.ids,
      expected: { action: 'silent' as const, depth: 'gist' as const },
      core: ['novelty_theme', 'novelty_port', 'novelty_editor'].includes(id),
    };
  }),

  // ---------- conflict：候选互相矛盾 ----------
  {
    id: 'conflict_which_record', dimension: 'conflict', note: '两条记录哪个对',
    query: '两条记录到底哪个对？', specificity: 'targeted', topics: ['决策'], entities: [], reasons: ['conflict'], followUp: false,
    candidates: [
      cand('记录 A：部署端口是 8080。', { score: 0.86, conflict: true }),
      cand('记录 B：部署端口是 9090。', { score: 0.84, conflict: true }),
    ],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: true,
  },
  {
    id: 'conflict_port_two', dimension: 'conflict', note: '端口两个说法',
    query: '部署端口有 8080 和 9090 两个说法，哪个对？', specificity: 'exact', topics: ['端口'], entities: [], reasons: ['conflict', 'exact_value'], followUp: false,
    candidates: [
      cand('部署端口是 8080。', { score: 0.9, conflict: true }),
      cand('部署端口是 9090。', { score: 0.88, conflict: true }),
    ],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: true,
  },
  {
    id: 'conflict_pref', dimension: 'conflict', note: '偏好前后不一致',
    query: '我的偏好记录前后不一致，信哪个？', specificity: 'targeted', topics: ['偏好'], entities: [], reasons: ['conflict'], followUp: false,
    candidates: [
      cand('用户偏好浅色主题。', { kind: 'preference', score: 0.83, conflict: true }),
      cand('用户偏好深色主题。', { kind: 'preference', score: 0.85, conflict: true }),
    ],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
  {
    id: 'conflict_database', dimension: 'conflict', note: '数据库名两版',
    query: '数据库名有两个版本，到底用哪个？', specificity: 'exact', topics: ['数据库'], entities: [], reasons: ['conflict', 'exact_value'], followUp: false,
    candidates: [
      cand('数据库名是 mebular_dev。', { score: 0.87, conflict: true }),
      cand('数据库名是 mebular_local。', { score: 0.85, conflict: true }),
    ],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
  {
    id: 'conflict_decision', dimension: 'conflict', note: '结论冲突',
    query: '上次的结论和这次候选冲突，怎么处理？', specificity: 'targeted', topics: ['决策'], entities: [], reasons: ['conflict', 'why'], followUp: true,
    candidates: [
      cand('上次结论：使用 SQLite。', { kind: 'episode', score: 0.84, conflict: true }),
      cand('新候选：迁移到 Postgres。', { kind: 'episode', score: 0.82, conflict: true }),
    ],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
  {
    id: 'conflict_en', dimension: 'conflict', note: '英文冲突',
    query: 'which record is correct? they disagree.', specificity: 'targeted', topics: ['decision'], entities: [], reasons: ['conflict'], followUp: false,
    candidates: [
      cand('Record A says the release branch is release/0.4.', { score: 0.86, conflict: true }),
      cand('Record B says the release branch is release/0.5.', { score: 0.84, conflict: true }),
    ],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
  {
    id: 'conflict_release_flow', dimension: 'conflict', note: '发布流程不一致',
    query: '两条记忆说的发布流程不一样。', specificity: 'targeted', topics: ['发布', '任务'], entities: [], reasons: ['conflict'], followUp: false,
    candidates: [
      cand('发布流程：先测试再 lint。', { kind: 'skill', score: 0.85, conflict: true }),
      cand('发布流程：先 lint 再测试。', { kind: 'skill', score: 0.87, conflict: true }),
    ],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: true,
  },
  {
    id: 'conflict_alias', dimension: 'conflict', note: '别名记录冲突',
    query: '别名记录冲突了，应该以哪条为准？', specificity: 'targeted', topics: ['项目'], entities: [], reasons: ['conflict', 'entity_question'], followUp: false,
    candidates: [
      cand('项目别名是 mebular-core。', { score: 0.84, conflict: true }),
      cand('项目别名是 mebular。', { score: 0.82, conflict: true }),
    ],
    injectedIds: [], expected: { action: 'speak', depth: 'detail' }, core: false,
  },
];

if (CASES.length < 60 || CASES.length > 100) {
  throw new Error(`golden set must contain 60-100 cases, got ${CASES.length}`);
}
const seen = new Set<string>();
for (const item of CASES) {
  if (seen.has(item.id)) throw new Error(`duplicate golden case id: ${item.id}`);
  seen.add(item.id);
}

export const GOLDEN_SET: readonly GoldenCase[] = Object.freeze(CASES);
export const GOLDEN_SET_SIZE = GOLDEN_SET.length;
export const GOLDEN_CORE_SIZE = GOLDEN_SET.filter((item) => item.core).length;

/** 覆盖矩阵，写进 evidence 方便审阅。 */
export function goldenSetSummary(): Array<{ dimension: GoldenDimension; count: number; core: number }> {
  const map = new Map<GoldenDimension, { dimension: GoldenDimension; count: number; core: number }>();
  for (const item of GOLDEN_SET) {
    const entry = map.get(item.dimension) ?? { dimension: item.dimension, count: 0, core: 0 };
    entry.count += 1;
    if (item.core) entry.core += 1;
    map.set(item.dimension, entry);
  }
  return [...map.values()];
}
