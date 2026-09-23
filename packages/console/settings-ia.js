// 控制台设置页信息架构（IA）——单一真源，供前端渲染与 E1 断言共用（纯数据，无 DOM）。
//
// 决策（用户拍板）：
//  - `sync.autoSync` / `sync.pushOnWrite` 从 GUI 彻底移除（默认常开，不需暴露），仅在「关于本机 · 运行状态」以只读行展示真值；
//  - `joinService.bind/port` 进「高级」，常用只留开关；
//  - 只读信息统一进「关于本机」（顶栏状态徽章入口）；
//  - Tab 命名：常用 / 高级 / 诊断。

/** 设置弹层的三个 Tab（顺序即展示顺序；`common` 为默认）。 */
export const IA_TABS = [
  { id: 'common', label: '常用' },
  { id: 'advanced', label: '高级' },
  { id: 'diagnostics', label: '诊断' },
];

/** 「常用」的四张任务卡（共 6 字段：多或少即回归）。 */
export const IA_TASK_CARDS = [
  {
    id: 'connect',
    title: '让别的设备能连上我',
    desc: '开启 P2P 后，已授权对端可直接接入；监听地址留空 = 默认监听。',
    fields: ['network.enabled', 'network.libp2p.listen'],
  },
  {
    id: 'domains',
    title: '我参加哪些记忆域',
    desc: '订阅即承担数据义务：接收该域并同步本机新增记忆；留空 = 参与全部。',
    fields: ['sync.namespaces'],
  },
  {
    id: 'invite',
    title: '邀请新设备上车',
    desc: '开启后可由「＋ 邀请新设备」签发一次性令牌（主密钥不复制），保存后需重启。',
    fields: ['joinService.enabled'],
  },
  {
    id: 'agent',
    title: 'Agent 怎么连我',
    desc: 'Agent 经 MCP 连接本机；改端口/鉴权会立即影响控制台自身的访问方式。',
    danger: true,
    fields: ['mcp.http.port', 'mcp.http.auth'],
  },
];

/**
 * 「高级」字段（默认收起；风险由文案标注）。
 * B：暴露面收敛 —— `network.libp2p.relayServers` → status-only（自动 relay 池，只读），
 * `network.libp2p.relayUnlimited` → internal（GUI 不渲染）：高级面 16 → **14**。
 */
export const IA_ADVANCED_FIELDS = [
  'sync.antiEntropy.enabled',
  'sync.antiEntropy.intervalMs',
  'sync.antiEntropy.jitterRatio',
  'sync.snapshotThreshold',
  'sync.peerWhitelist',
  'sync.policyIssuers',
  'semantic.enabled',
  'semantic.minScore',
  'joinService.bind',
  'joinService.port',
  'mcp.http.host',
  'mcp.http.tls',
  'mcp.http.tlsKey',
  'mcp.http.tlsCert',
];

/**
 * 只读面（status-only）：值由运行时 / 自动推导（relay 池、LAN 发现、桥、打洞、广播、join、TLS、TTL）。
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
  'status.invite.grantTtl',
];

/** 全部「可编辑 path」（常用 6 + 高级 14 = **20**）——与 schema EDITABLE_PATHS 一致。 */
export const IA_EDITOR_PATHS = [
  ...IA_TASK_CARDS.flatMap((card) => card.fields),
  ...IA_ADVANCED_FIELDS,
];

/** 只读信息块（每块有且仅有一个去处）。 */
export const IA_INFO_BLOCKS = {
  identity: 'about',      // 身份与存储
  syncRate: 'about',      // 同步节奏真值（自动同步 / 写入即推）
  runtime: 'about',       // 运行状态（含 TLS / 加入服务 / 语义召回）
  issuer: 'about',        // 签发者状态
  fleet: 'about',         // 舰队摘要
  tools: 'about',         // 能力清单（MCP = CLI 同名）
  statusOnly: 'about',      // 只读状态（自动推导：relay 池 / LAN / 桥 / 打洞 / 广播 / join / TLS）
  rawConfig: 'diagnostics', // 完整配置（复制 / 下载）
  version: 'diagnostics',   // 版本 / 服务状态
  recovery: 'diagnostics',  // 恢复指引（auth 误切 / host 误设 / 缺证书 / 控制台打不开）
};

/** path → 唯一去处（common / advanced / about / diagnostics）。 */
export const IA_MIGRATION = {
  ...Object.fromEntries(IA_TASK_CARDS.flatMap((card) => card.fields.map((p) => [p, 'common']))),
  ...Object.fromEntries(IA_ADVANCED_FIELDS.map((p) => [p, 'advanced'])),
  // 只读面：自动同步 / 写入即推（默认常开）+ relay 池 / LAN / 桥 / 打洞 / 广播 / join / TLS / TTL
  ...Object.fromEntries(IA_STATUS_ONLY_PATHS.map((p) => [p, 'about'])),
  // 只读信息块
  ...IA_INFO_BLOCKS,
};

/** 「常用」字段（扁平），用于断言「恰 6 字段」。 */
export const IA_COMMON_FIELDS = IA_TASK_CARDS.flatMap((card) => card.fields);

/** 「高级」里承担动作按钮（非配置键）的条目。 */
export const IA_ADVANCED_ACTIONS = ['declare-issuer'];

/** 前端实际渲染的编辑面 path（常用 6 + 高级 14 = 20）。 */
export const IA_EDITOR_RENDER_PATHS = [...IA_COMMON_FIELDS, ...IA_ADVANCED_FIELDS];
