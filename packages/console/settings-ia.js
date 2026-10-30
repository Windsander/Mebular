// 控制台设置页信息架构（IA）——单一真源，供前端渲染与 E1 断言共用（纯逻辑，无 DOM）。
// U-1 起也承载少量共享纯函数（CSRF 403 自愈）：console 静态文件白名单固定，避免新增 serve 侧入口。
//
// 决策（用户拍板）：
//  - `sync.autoSync` / `sync.pushOnWrite` 从 GUI 彻底移除（默认常开，不需暴露），仅在「关于本机 · 运行状态」以只读行展示真值；
//  - `joinService.bind/port` 进「高级」，与启用开关聚成「常驻服务」卡；
//  - 只读信息统一进「关于本机」（顶栏状态徽章入口）；
//  - Tab 命名：常用 / 安全 / AI 助手 / MCP 接入 / 高级。
//
// E1 · 入口收口（产品拍板）：
//  - 「邀请设备」「让别的设备能连上我」「Agent 怎么连我」三卡从「常用」迁出；
//  - 网络两项 → 高级（常规字段组）；joinService 三项 → 高级「常驻服务」卡；
//  - MCP 六项（port/auth/host/tls/tlsKey/tlsCert）→ **独立「MCP 接入」Tab**（危险卡；自救恢复文案随迁）；
//  - 常用只保留只读状态 + 重启向导 / 邀请设备入口；
//  - 安全卡（S3）从「常用」迁入独立「安全」Tab。
//
// UX-2 简化轮（用户拍板「自动的东西不保留在 GUI」延伸）：
//  - Tab 4 → **3** 后再由 E1 增回 **安全 / MCP 接入**（常用 / 安全 / AI 助手 / MCP 接入 / 高级；诊断并入高级底部只读折叠）；
//  - 「订阅域」属**内容管理** → 移出设置页，归主页「记忆共享」（IA_MIGRATION home = 'domains'）；
//  - 反熵间隔/抖动、快照阈值、召回阈值 → internal（config.json 文档级，GUI 只留「自动对账」总开关）；
//  - 保存即生效（toggle 点击即写、文本/数字失焦即写；保存后守护自动重启生效）——「保存」按钮从用户路径消失。

/**
 * 设置弹层的 Tab（顺序即展示顺序；`common` 为默认）。E1：增「安全」「MCP 接入」专区。
 * labelKey 是用户可见文案真源；label 只作 catalog 缺 key 时的中文兜底。
 */
export const IA_TABS = [
  { id: 'common', label: '常用', labelKey: 'settings.tab.common' },
  { id: 'security', label: '安全', labelKey: 'settings.tab.security' },
  { id: 'assistants', label: 'AI 助手', labelKey: 'settings.tab.assistants' },
  { id: 'runtime', label: '记忆运行时', labelKey: 'settings.tab.runtime' },
  { id: 'mcp', label: 'MCP 接入', labelKey: 'settings.tab.mcp' },
  { id: 'advanced', label: '高级', labelKey: 'settings.tab.advanced' },
];

/** 设置弹层的附加导航（非 Tab：点击打开既有「关于本机」弹层）。 */
export const IA_SETTINGS_EXTRA = [
  { id: 'about', label: '关于本机', labelKey: 'settings.extra.about', opens: 'about-modal' },
];

/**
 * 折叠白名单（设置/关于共用；≤5，当前 3）。
 * 设置内 2 个（MCP 危险与自救 / 诊断与恢复）；关于本机 1 个（运行状态）。
 * 邀请面板不再有详情折叠。每项必须带 data-settings-fold，UI 断言据此防回归。
 * labelKey 是用户可见文案真源；label 只作 catalog 缺 key 时的中文兜底。
 */
export const IA_SETTINGS_FOLDS = [
  { id: 'mcp-danger', label: 'MCP 接入 · 危险与自救', labelKey: 'settings.fold.mcpDanger', home: 'mcp' },
  { id: 'diagnostics', label: '诊断与恢复', labelKey: 'settings.fold.diagnostics', home: 'advanced' },
  { id: 'about-runtime', label: '运行状态（只读）', labelKey: 'settings.fold.aboutRuntime', home: 'about' },
  { id: 'runtime-advanced', label: '高级 · 采集、保留与上下文', labelKey: 'settings.fold.runtimeAdvanced', home: 'runtime' },
];

/**
 * 邀请令牌有效期档位（UI 与断言共用；默认 15 分钟 = 服务端默认）。
 * labelKey / labelVars 是用户可见文案真源；label 只作 catalog 缺 key 时的中文兜底。
 */
export const INVITE_TTL_OPTIONS = [
  { label: '5 分钟', labelKey: 'invite.ttl.minutes', labelVars: { n: 5 }, ttlMs: 300_000 },
  { label: '15 分钟', labelKey: 'invite.ttl.minutes', labelVars: { n: 15 }, ttlMs: 900_000 },
  { label: '20 分钟', labelKey: 'invite.ttl.minutes', labelVars: { n: 20 }, ttlMs: 1_200_000 },
  { label: '2 小时', labelKey: 'invite.ttl.hours', labelVars: { n: 2 }, ttlMs: 7_200_000 },
  { label: '6 小时', labelKey: 'invite.ttl.hours', labelVars: { n: 6 }, ttlMs: 21_600_000 },
  { label: '12 小时', labelKey: 'invite.ttl.hours', labelVars: { n: 12 }, ttlMs: 43_200_000 },
  { label: '24 小时', labelKey: 'invite.ttl.hours', labelVars: { n: 24 }, ttlMs: 86_400_000 },
];
export const INVITE_TTL_DEFAULT_MS = 900_000;

/**
 * 安全 tab 的三段式结构：等级 / 动态码种子 / 恢复码。
 * 文案在这里收口（主界面不出现内部错误码；风险说明短句保留）。
 * titleKey / descKey 指向 locales/<locale>/console.json 的 messages。
 */
export const IA_SECURITY_SECTIONS = {
  level: {
    title: '安全等级',
    titleKey: 'settings.security.level.title',
    desc: '档位越高，敏感操作的门槛越高。',
    descKey: 'settings.security.level.desc',
  },
  totp: {
    title: '动态码种子',
    titleKey: 'settings.security.totp.title',
    desc: '中档敏感操作需要 6 位动态码；种子只存本机。',
    descKey: 'settings.security.totp.desc',
  },
  recovery: {
    title: '恢复码',
    titleKey: 'settings.security.recovery.title',
    desc: '高档的离线钥匙；只显示一次，请离线保存。',
    descKey: 'settings.security.recovery.desc',
  },
};

export const SECURITY_LEVEL_LABEL = { low: '低', medium: '中', high: '高' };
export const SECURITY_LEVEL_TITLE_KEY = {
  low: 'settings.security.tier.low.title',
  medium: 'settings.security.tier.medium.title',
  high: 'settings.security.tier.high.title',
};
export const SECURITY_LEVEL_NOTE_KEY = {
  low: 'settings.security.tier.low.note',
  medium: 'settings.security.tier.medium.note',
  high: 'settings.security.tier.high.note',
};
export const SECURITY_BOUNDARY_KEY = 'settings.security.boundary';
export const SECURITY_TOTP_FOOT_KEY = 'settings.security.totp.foot';

/**
 * 「高级」三组（每组 = 标题 + 一行说明 + 字段行）。
 * 字段顺序即展示顺序；能力与 schema 的 editable 集合一一对应。
 * titleKey / descKey 指向 locale pack；title / desc 为中文兜底。
 */
export const IA_ADVANCED_SECTIONS = [
  {
    id: 'resident',
    title: '常驻服务',
    titleKey: 'settings.section.resident.title',
    desc: '邀请设备前先启用；地址与端口决定新设备能否连上。',
    descKey: 'settings.section.resident.desc',
    fields: ['joinService.enabled', 'joinService.bind', 'joinService.port'],
  },
  {
    id: 'network',
    title: '网络',
    titleKey: 'settings.section.network.title',
    desc: '本机与忆云之间的连接；关闭后仅本机可用。',
    descKey: 'settings.section.network.desc',
    fields: ['network.enabled', 'network.libp2p.listen'],
  },
  {
    id: 'automation',
    title: '自动化',
    titleKey: 'settings.section.automation.title',
    desc: '后台维护与可选能力；默认设置适合多数人。',
    descKey: 'settings.section.automation.desc',
    fields: ['sync.antiEntropy.enabled', 'semantic.enabled'],
  },
];

/**
 * 「MCP 接入」两组：连接 / TLS。危险与自救收进唯一折叠（IA_MCP_DANGER_LINE_KEYS）。
 */
export const IA_MCP_SECTIONS = [
  {
    id: 'connection',
    title: '连接',
    titleKey: 'settings.section.mcp.connection.title',
    desc: 'Agent 经 MCP 连接本机；改动会立即影响控制台访问。',
    descKey: 'settings.section.mcp.connection.desc',
    fields: ['mcp.http.port', 'mcp.http.auth', 'mcp.http.host'],
  },
  {
    id: 'tls',
    title: 'TLS',
    titleKey: 'settings.section.mcp.tls.title',
    desc: '加密 MCP 连接；监听非回环时必需。',
    descKey: 'settings.section.mcp.tls.desc',
    fields: ['mcp.http.tls', 'mcp.http.tlsCert', 'mcp.http.tlsKey'],
  },
];

/** 折叠内三行：后果 + 两条自救路径（保留命令与备份名）。 */
export const IA_MCP_DANGER_LINE_KEYS = [
  'settings.mcp.danger.1',
  'settings.mcp.danger.2',
  'settings.mcp.danger.3',
];

/**
 * 字段展示文案（覆盖服务端 schema 的长帮助/长警告）。
 * 只改展示，不改校验、默认值或写入行为；帮助目标 ≤1 行。
 * labelKey / helpKey / warnKey 指向 locale pack；label / help / warn 为中文兜底。
 */
export const IA_FIELD_COPY = {
  'mcp.http.port': { help: '0 = 自动分配；默认 7331。', helpKey: 'settings.fields.mcpPort.help' },
  'mcp.http.auth': {
    label: '认证',
    labelKey: 'settings.fields.mcpAuth.label',
    help: 'none 仅回环；bearer 用令牌；oauth 用环境密钥。',
    helpKey: 'settings.fields.mcpAuth.help',
    warn: '',
  },
  'mcp.http.host': {
    help: '默认 127.0.0.1；非回环必须配认证与 TLS。',
    helpKey: 'settings.fields.mcpHost.help',
    warn: '',
  },
  'mcp.http.tls': { help: '缺证书会启动失败，不会静默降级。', helpKey: 'settings.fields.mcpTls.help' },
  'mcp.http.tlsCert': {
    label: '证书路径',
    labelKey: 'settings.fields.mcpTlsCert.label',
    help: 'PEM 证书；与私钥同时填写才生效。',
    helpKey: 'settings.fields.mcpTlsCert.help',
  },
  'mcp.http.tlsKey': {
    label: '私钥路径',
    labelKey: 'settings.fields.mcpTlsKey.label',
    help: 'PEM 私钥；与证书同时填写才生效。',
    helpKey: 'settings.fields.mcpTlsKey.help',
  },
  'joinService.enabled': { help: '生成一次性邀请令牌；改动需重启。', helpKey: 'settings.fields.joinEnabled.help' },
  'joinService.bind': { help: '0.0.0.0 允许局域网；仅可信网络使用。', helpKey: 'settings.fields.joinBind.help' },
  'joinService.port': { help: '默认 4002；被占用时改这里。', helpKey: 'settings.fields.joinPort.help' },
  'network.enabled': { help: '关闭后仅本机离线使用。', helpKey: 'settings.fields.networkEnabled.help' },
  'network.libp2p.listen': { help: '留空用默认；仅回环时局域网不可达。', helpKey: 'settings.fields.networkListen.help' },
  'sync.antiEntropy.enabled': {
    label: '自动对账',
    labelKey: 'settings.fields.antiEntropy.label',
    help: '周期核对，弥补推送丢失。',
    helpKey: 'settings.fields.antiEntropy.help',
  },
  'semantic.enabled': {
    label: '启用语义召回',
    labelKey: 'settings.fields.semantic.label',
    help: '需要本地模型；缺失时自动降级关键词。',
    helpKey: 'settings.fields.semantic.help',
    warn: '',
    hideStatusReason: true,
  },
};

/** 「高级」全部可编辑字段（由三组派生；不再有“卡片之外的散项”）。 */
export const IA_ADVANCED_FIELDS = IA_ADVANCED_SECTIONS.flatMap((section) => section.fields);

/** 「MCP 接入」全部可编辑字段（由两组派生）。 */
export const IA_MCP_FIELDS = IA_MCP_SECTIONS.flatMap((section) => section.fields);

/**
 * 0.3 记忆运行时：用户只面对一个开关（memoryRuntime.enabled），默认关闭；
 * 模型区继续走 /admin/api/models，但本地模型由 Mebular 管理，当前对话模型由宿主管理。
 * 旧模式的字段不再属于 Console 设置面。
 */
export const IA_RUNTIME_CONTROL_PATHS = ['memoryRuntime.enabled'];
export const IA_RUNTIME_FIELDS = [];
/** Runtime 字段文案（当前没有由 schema 编辑器渲染的 runtime 字段）。 */
export const IA_RUNTIME_FIELD_COPY = {};

/** sidecar 生命周期状态 → Console 文案 key（未知状态按 stopped 展示，不暴露原始码）。 */
export const RUNTIME_SIDECAR_STATES = Object.freeze([
  'disabled', 'not_installed', 'stopped', 'starting', 'ready', 'degraded', 'stopping', 'failed',
]);

export function runtimeSidecarStateKey(state) {
  const value = String(state ?? '');
  return RUNTIME_SIDECAR_STATES.includes(value)
    ? `runtime.sidecar.state.${value}`
    : 'runtime.sidecar.state.stopped';
}

/** memoryRuntime.enabled：状态优先（服务端热生效后的真值），配置兜底，默认关闭。 */
export function memoryRuntimeEnabledOf(status, config) {
  if (typeof status?.enabled === 'boolean') return status.enabled;
  return config?.memoryRuntime?.enabled === true;
}

/**
 * 只读面（status-only）：值由运行时 / 自动推导（relay 池、LAN 发现、桥、打洞、广播、join、TLS、）。
 * 与 config-schema.mjs 的 STATUS_ONLY_PATHS 逐项一致（E1 防漂移断言；多/少即红）。
 */
export const IA_STATUS_ONLY_PATHS = [
  'network.libp2p.relayServers',
  'sync.autoSync',
  'sync.pushOnWrite',
  'status.lan.discovery',
  'status.relay.role',
  'status.relay.bridge',
  'status.nat.holepunch',
  'status.net.broadcast',
  'status.join.endpoint',
  'status.tls',
];

/** 全部「可编辑 path」（高级 7 + MCP 6 + 记忆共享 1 = **14**）——与 schema EDITABLE_PATHS 一致。 */
export const IA_EDITOR_PATHS = [
  ...IA_ADVANCED_FIELDS,
  ...IA_MCP_FIELDS,
  'sync.namespaces', // 内容管理：归主页「记忆共享」（不在设置页渲染）
];

/** 只读信息块（每块有且仅有一个去处）。简化轮：诊断并入高级底部折叠。 */
export const IA_INFO_BLOCKS = {
  identity: 'about',      // 身份与存储
  syncRate: 'about',      // 同步节奏真值（自动同步 / 写入即推）
  runtime: 'about',       // 运行状态（含 TLS / 加入服务 / 语义召回）
  fleet: 'about',         // 舰队摘要
  tools: 'about',         // 能力清单（MCP = CLI 同名）
  statusOnly: 'about',      // 只读状态（自动推导：relay 池 / LAN / 桥 / 打洞 / 广播 / join / TLS）
  rawConfig: 'advanced', // 完整配置（复制 / 下载）——随诊断并入高级
  version: 'advanced',   // 版本 / 服务状态
  recovery: 'advanced',  // 恢复指引（auth 误切 / host 误设 / 缺证书 / 控制台打不开）
};

/** path → 唯一去处（common / advanced / mcp / about / domains；E1 后常用无编辑项）。 */
export const IA_MIGRATION = {
  ...Object.fromEntries(IA_ADVANCED_FIELDS.map((p) => [p, 'advanced'])),
  ...Object.fromEntries(IA_MCP_FIELDS.map((p) => [p, 'mcp'])),
  // 0.3 记忆运行时：两条主轴的字段与高级折叠同属「记忆运行时」tab
  ...Object.fromEntries(IA_RUNTIME_FIELDS.map((p) => [p, 'runtime'])),
  ...Object.fromEntries(IA_RUNTIME_CONTROL_PATHS.map((p) => [p, 'runtime'])),
  // 内容管理：订阅域 → 主页「记忆共享」
  'sync.namespaces': 'domains',
  // 只读面：自动同步 / 写入即推（默认常开）+ relay 池 / LAN / 桥 / 打洞 / 广播 / join / TLS
  ...Object.fromEntries(IA_STATUS_ONLY_PATHS.map((p) => [p, 'about'])),
  // 只读信息块
  ...IA_INFO_BLOCKS,
};

/** 「常用」字段（E1 三卡迁出后为 0；常用只留只读状态与动作入口）。 */
export const IA_COMMON_FIELDS = [];

/** 「高级」里承担动作按钮（非配置键）的条目。E1：已无策略声明动作。 */
export const IA_ADVANCED_ACTIONS = [];

/** 前端设置页实际渲染的编辑面 path（高级 7 + MCP 6 = 13；订阅域在「记忆共享」渲染）。 */
export const IA_EDITOR_RENDER_PATHS = [
  ...IA_ADVANCED_FIELDS,
  ...IA_MCP_FIELDS,
];

// ---------- config-schema reason 文案（Console 侧映射；不改 CLI/服务端契约） ----------
// config-schema.mjs 的 reason() 由服务端计算并作为**中文纯文本**下发（CLI / 终端输出仍按原文）。
// Console 只按已知模板翻译静态说明；未命中的动态错误原文原样返回（下一批处理）。
export const SCHEMA_REASON_RULES = [
  // 服务端三元组通用状态
  { pattern: /^已生效$/, key: 'settings.schema.reason.active' },
  { pattern: /^已声明为热生效/, key: 'settings.schema.reason.hot' },
  { pattern: /^环境变量优先/, key: 'settings.schema.reason.envOverride' },
  { pattern: /^待重启：已保存的值将在重启后生效（当前实例/, key: 'settings.schema.reason.pendingRestartCurrent' },
  { pattern: /^待重启：已保存的值将在重启后生效$/, key: 'settings.schema.reason.pendingRestart' },
  { pattern: /^状态不可读$/, key: 'settings.schema.reason.unreadable' },

  // editable
  { path: 'network.libp2p.listen', pattern: /^仅回环监听/, key: 'settings.schema.reason.networkListenLoopback' },
  { path: 'joinService.enabled', pattern: /^join 端点解析为回环地址/, key: 'settings.schema.reason.joinLoopback' },
  { path: 'mcp.http.auth', pattern: /^已生效：控制台 API 现需凭证/, key: 'settings.schema.reason.authActive' },
  { path: 'semantic.enabled', pattern: /^缺可选依赖/, key: 'settings.schema.reason.semanticMissing' },
  {
    path: 'joinService.port',
    pattern: /^join 端口被占（上次启动失败：([^）]*)）/,
    key: 'settings.schema.reason.joinPortBusy',
    vars: (match) => ({ port: match[1] }),
  },
  { path: 'mcp.http.tls', pattern: /^缺证书/, key: 'settings.schema.reason.tlsMissing' },

  // status-only
  { path: 'network.libp2p.relayServers', pattern: /^已生效：自动池/, key: 'settings.schema.reason.relayAutoActive' },
  { path: 'network.libp2p.relayServers', pattern: /^空：无已知 relay/, key: 'settings.schema.reason.relayEmpty' },
  { path: 'sync.autoSync', pattern: /^已生效：常驻模式默认常开/, key: 'settings.schema.reason.alwaysOn' },
  { path: 'sync.pushOnWrite', pattern: /^已生效：常驻模式默认常开/, key: 'settings.schema.reason.alwaysOn' },
  { path: 'status.lan.discovery', pattern: /^网络未启用：LAN 发现/, key: 'settings.schema.reason.lanNetOff' },
  { path: 'status.lan.discovery', pattern: /^已生效：随网络启用/, key: 'settings.schema.reason.lanActive' },
  {
    path: 'status.relay.role',
    pattern: /^未提供中转：([\s\S]*)$/,
    key: 'settings.schema.reason.relayRoleOff',
    vars: (match) => ({ detail: match[1] }),
  },
  { path: 'status.relay.role', pattern: /^已生效：本机对外提供中转/, key: 'settings.schema.reason.relayRoleServing' },
  {
    path: 'status.relay.role',
    pattern: /^待条件满足：([\s\S]*)$/,
    key: 'settings.schema.reason.relayRoleWaiting',
    vars: (match) => ({ detail: match[1] }),
  },
  {
    path: 'status.relay.bridge',
    pattern: /^已生效：经 ([\s\S]*) 中转$/,
    key: 'settings.schema.reason.relayBridgeActive',
    vars: (match) => ({ detail: match[1] }),
  },
  { path: 'status.relay.bridge', pattern: /^直连优先/, key: 'settings.schema.reason.relayBridgeDirect' },
  { path: 'status.nat.holepunch', pattern: /^未启用：网络未开启/, key: 'settings.schema.reason.natNetOff' },
  {
    path: 'status.nat.holepunch',
    pattern: /^打洞不可用：([\s\S]*)$/,
    key: 'settings.schema.reason.natUnavailable',
    vars: (match) => ({ detail: match[1] }),
  },
  {
    path: 'status.nat.holepunch',
    pattern: /^已生效：已直连升级 ([\s\S]+) 次$/,
    key: 'settings.schema.reason.natUpgraded',
    vars: (match) => ({ count: match[1] }),
  },
  { path: 'status.nat.holepunch', pattern: /^已装配：尚无打洞升级/, key: 'settings.schema.reason.natIdle' },
  {
    path: 'status.net.broadcast',
    pattern: /^已生效：档位 ([\s\S]+?)（已发布 ([\s\S]+?) \/ 已采用 ([\s\S]+?)）$/,
    key: 'settings.schema.reason.broadcastActive',
    vars: (match) => ({ mode: match[1], published: match[2], applied: match[3] }),
  },
  { path: 'status.net.broadcast', pattern: /^未启用（opt-in）/, key: 'settings.schema.reason.broadcastOff' },
  { path: 'status.join.endpoint', pattern: /^未启用：joinService\.enabled=false$/, key: 'settings.schema.reason.joinOff' },
  { path: 'status.join.endpoint', pattern: /^不可达：端点回环/, key: 'settings.schema.reason.joinLoopbackUnreachable' },
  {
    path: 'status.join.endpoint',
    pattern: /^上次启动失败：([\s\S]*)$/,
    key: 'settings.schema.reason.joinLastError',
    vars: (match) => ({ detail: match[1] }),
  },
  { path: 'status.join.endpoint', pattern: /^已生效：端点对新设备可达$/, key: 'settings.schema.reason.joinReachable' },
  { path: 'status.tls', pattern: /^已生效：TLS 实际启用$/, key: 'settings.schema.reason.tlsActive' },
  { path: 'status.tls', pattern: /^未启用：明文 HTTP/, key: 'settings.schema.reason.tlsOff' },
];

/**
 * Console 渲染 config-schema 的「未生效原因」：命中已知静态模板时用 t()，
 * 动态错误原文（未命中）原样返回，避免把用户数据/服务端错误误当文案。
 * @param {string} path 配置 path
 * @param {unknown} reason 服务端 reason 文本
 * @param {(key: string, vars?: object) => string} translate t()
 */
export function localizeSchemaReason(path, reason, translate) {
  const text = typeof reason === 'string' ? reason : '';
  if (!text) return '';
  for (const rule of SCHEMA_REASON_RULES) {
    if (rule.path && rule.path !== path) continue;
    const match = rule.pattern.exec(text);
    if (!match) continue;
    if (typeof translate !== 'function') return text;
    return translate(rule.key, rule.vars ? rule.vars(match) : undefined);
  }
  return text;
}

/** config-schema `effective` 的「已配置」哨兵值（文本字段只读展示用）。 */
export const SCHEMA_CONFIGURED_VALUE = '（已配置）';

/** Runtime 模型包状态 → 文案 key（未知状态回退 failed，不把内部状态码直接给用户）。 */
export function runtimePackStateKey(state) {
  const key = `settings.runtime.state.${String(state ?? 'not_installed')}`;
  return [
    'settings.runtime.state.not_installed',
    'settings.runtime.state.downloading',
    'settings.runtime.state.verifying',
    'settings.runtime.state.installing',
    'settings.runtime.state.paused',
    'settings.runtime.state.failed',
    'settings.runtime.state.cancelled',
    'settings.runtime.state.installed',
    'settings.runtime.state.corrupt',
  ].includes(key) ? key : 'settings.runtime.state.failed';
}

/** 下载进度（字节 + 百分比）；total 未知时 percent=null。 */
export function runtimePackProgress(download) {
  const downloadedBytes = Number.isFinite(download?.downloadedBytes) ? Math.max(0, download.downloadedBytes) : 0;
  const totalBytes = Number.isFinite(download?.totalBytes) ? Math.max(0, download.totalBytes) : 0;
  const percent = totalBytes > 0 ? Math.min(100, Math.max(0, (downloadedBytes / totalBytes) * 100)) : null;
  return { downloadedBytes, totalBytes, percent };
}

/** 人类可读体积（十进制单位；不显示量化/上下文长度等技术细节）。 */
export function formatByteSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let index = 0;
  while (amount >= 1000 && index < units.length - 1) {
    amount /= 1000;
    index += 1;
  }
  const rounded = index === 0 ? Math.round(amount) : Math.round(amount * 10) / 10;
  return `${rounded} ${units[index]}`;
}

/** 内部对象判定（与 core 通用可见性 + 0.3 内部类型同义；用于 Console 时间线过滤）。 */
export const RUNTIME_INTERNAL_NODE_TYPES = Object.freeze([
  'compact', 'context_checkpoint', 'self_record', 'raw_chunk', 'recall_trace',
]);

const RUNTIME_INTERNAL_TYPE_SET = new Set(RUNTIME_INTERNAL_NODE_TYPES);

export function isInternalRuntimeMemory(memory) {
  if (!memory) return false;
  if (RUNTIME_INTERNAL_TYPE_SET.has(memory.type)) return true;
  if (memory.internal === true) return true;
  if (memory.metadata?.internal === true) return true;
  // 0.3 原型数据兼容：发布版不再写入 metadata.runtime.internal。
  if (memory.metadata?.runtime?.internal === true) return true;
  return typeof memory.namespace === 'string'
    && memory.namespace.startsWith('__')
    && memory.namespace !== '__policy__';
}

/** 时间线分类：memory / compact / checkpoint / self / other（other 仍属内部）。 */
export function runtimeTimelineKind(memory) {
  if (memory?.type === 'compact') return 'compact';
  if (memory?.type === 'context_checkpoint') return 'checkpoint';
  if (memory?.type === 'self_record') return 'self';
  if (isInternalRuntimeMemory(memory)) return 'other';
  return 'memory';
}

/** 默认只显示普通记录；includeInternal 打开后可按 kind 筛选。 */
export function filterRuntimeTimeline(memories, { filter = 'memory', includeInternal = false } = {}) {
  const list = Array.isArray(memories) ? memories : [];
  return list.filter((memory) => {
    const kind = runtimeTimelineKind(memory);
    if (!includeInternal && kind !== 'memory') return false;
    if (filter === 'all') return true;
    return kind === filter;
  });
}

// ---------- U-1 · CSRF 403 自愈（与 IA 同处共享纯逻辑模块：无 DOM、零依赖） ----------
// 长开页面 / 守护重启后旧 token 失效时，重取一次 /console/ 的 token（响应头 + cookie），
// 保留调用方表单状态并重试一次；不做无限重试。独立静态文件需同步改 serve 白名单，
// 故与 IA 常量共置（见 PR 说明）。

export const CSRF_ERROR_MESSAGE = 'CSRF token 缺失或无效';
export const CSRF_RETRY_FAILED_MESSAGE = '会话已刷新，请重试；仍失败请重开窗口';

/** 只认服务端明确的 CSRF 403；其它 403（scope/权限）不触发重取。 */
export function isCsrfFailure(error) {
  return Number(error?.status) === 403
    && String(error?.message ?? '').includes(CSRF_ERROR_MESSAGE);
}

/** 包一层统一错误（保留原状态码/载荷，便于调用方继续做错误映射）。 */
export function csrfRetryError(cause) {
  const error = new Error(CSRF_RETRY_FAILED_MESSAGE);
  error.status = cause?.status ?? 403;
  error.payload = cause?.payload ?? null;
  error.csrfRetry = true;
  error.cause = cause;
  return error;
}

/**
 * 重新取 CSRF token：优先读 /console/ 响应头的 x-mebular-csrf（同源），
 * 读不到再回退 document.cookie。不整页重载，调用方 DOM/表单原样保留。
 */
export async function refreshCsrfToken({
  fetchImpl = globalThis.fetch,
  readCookie = () => null,
} = {}) {
  const res = await fetchImpl('/console/', {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'text/html' },
  });
  const header = res?.headers?.get?.('x-mebular-csrf') ?? null;
  const token = header || readCookie('mebular_csrf');
  return res?.ok && token ? token : null;
}

/**
 * 发送一次；命中 CSRF 403 时恢复 token 并原样重试一次。
 * send 必须自行读取最新 token（调用方在 recover 回调里写回状态）。
 */
export async function withCsrfRetry(send, recover) {
  try {
    return await send();
  } catch (error) {
    if (!isCsrfFailure(error)) throw error;
    const token = await recover();
    if (!token) throw csrfRetryError(error);
    try {
      return await send();
    } catch (retryError) {
      if (isCsrfFailure(retryError)) throw csrfRetryError(retryError);
      throw retryError;
    }
  }
}
