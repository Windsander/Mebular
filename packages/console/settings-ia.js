// 控制台设置页信息架构（IA）——单一真源，供前端渲染与 E1 断言共用（纯数据，无 DOM）。
//
// 决策（用户拍板）：
//  - `sync.autoSync` / `sync.pushOnWrite` 从 GUI 彻底移除（默认常开，不需暴露），仅在「关于本机 · 运行状态」以只读行展示真值；
//  - `joinService.bind/port` 进「高级」，常用只留开关；
//  - 只读信息统一进「关于本机」（顶栏状态徽章入口）；
//  - Tab 命名：常用 / 高级 / 诊断。
//
// UX-2 简化轮（用户拍板「自动的东西不保留在 GUI」延伸）：
//  - Tab 4 → **3**（常用 / AI 助手 / 高级；诊断并入高级底部只读折叠）；
//  - 「订阅域」属**内容管理** → 移出设置页，归主页「记忆共享」（IA_MIGRATION home = 'domains'）；
//  - 反熵间隔/抖动、快照阈值、召回阈值 → internal（config.json 文档级，GUI 只留「自动对账」总开关）；
//  - 保存即生效（toggle 点击即写、文本/数字失焦即写；保存后守护自动重启生效）——「保存」按钮从用户路径消失。

/** 设置弹层的 Tab（顺序即展示顺序；`common` 为默认）。UX-2：增「AI 助手」专区。 */
export const IA_TABS = [
  { id: 'common', label: '常用' },
  { id: 'assistants', label: 'AI 助手' },
  { id: 'advanced', label: '高级' },
];

/** 设置弹层的附加导航（非 Tab：点击打开既有「关于本机」弹层；UX-2 增「关于本机」区入口）。 */
export const IA_SETTINGS_EXTRA = [
  { id: 'about', label: '关于本机', opens: 'about-modal' },
];

/** 「常用」的任务卡（简化轮：3 张 5 字段——「订阅域」移出归主页「记忆共享」）。 */
export const IA_TASK_CARDS = [
  {
    id: 'connect',
    title: '让别的设备能连上我',
    desc: '开启 P2P 后，已授权对端可直接接入；监听地址留空 = 默认监听。',
    fields: ['network.enabled', 'network.libp2p.listen'],
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
 * 简化轮暴露面收敛：反熵间隔/抖动、快照阈值、召回阈值 → internal（config.json 文档级，
 * 自动策略不劳人参与，GUI 只留「自动对账」总开关）：高级 14 → **10**。
 */
export const IA_ADVANCED_FIELDS = [
  'sync.antiEntropy.enabled',
  'sync.peerWhitelist',
  'sync.policyIssuers',
  'semantic.enabled',
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

/** 全部「可编辑 path」（设置页 5+10 + 记忆共享 1 = **16**）——与 schema EDITABLE_PATHS 一致。 */
export const IA_EDITOR_PATHS = [
  ...IA_TASK_CARDS.flatMap((card) => card.fields),
  ...IA_ADVANCED_FIELDS,
  'sync.namespaces', // 内容管理：归主页「记忆共享」（不在设置页渲染）
];

/** 只读信息块（每块有且仅有一个去处）。简化轮：诊断并入高级底部折叠。 */
export const IA_INFO_BLOCKS = {
  identity: 'about',      // 身份与存储
  syncRate: 'about',      // 同步节奏真值（自动同步 / 写入即推）
  runtime: 'about',       // 运行状态（含 TLS / 加入服务 / 语义召回）
  issuer: 'about',        // 签发者状态
  fleet: 'about',         // 舰队摘要
  tools: 'about',         // 能力清单（MCP = CLI 同名）
  statusOnly: 'about',      // 只读状态（自动推导：relay 池 / LAN / 桥 / 打洞 / 广播 / join / TLS）
  rawConfig: 'advanced', // 完整配置（复制 / 下载）——随诊断并入高级
  version: 'advanced',   // 版本 / 服务状态
  recovery: 'advanced',  // 恢复指引（auth 误切 / host 误设 / 缺证书 / 控制台打不开）
};

/** path → 唯一去处（common / advanced / about / domains）。 */
export const IA_MIGRATION = {
  ...Object.fromEntries(IA_TASK_CARDS.flatMap((card) => card.fields.map((p) => [p, 'common']))),
  ...Object.fromEntries(IA_ADVANCED_FIELDS.map((p) => [p, 'advanced'])),
  // 内容管理：订阅域 → 主页「记忆共享」
  'sync.namespaces': 'domains',
  // 只读面：自动同步 / 写入即推（默认常开）+ relay 池 / LAN / 桥 / 打洞 / 广播 / join / TLS / TTL
  ...Object.fromEntries(IA_STATUS_ONLY_PATHS.map((p) => [p, 'about'])),
  // 只读信息块
  ...IA_INFO_BLOCKS,
};

/** 「常用」字段（扁平）。 */
export const IA_COMMON_FIELDS = IA_TASK_CARDS.flatMap((card) => card.fields);

/** 「高级」里承担动作按钮（非配置键）的条目。 */
export const IA_ADVANCED_ACTIONS = ['declare-issuer'];

/** 前端设置页实际渲染的编辑面 path（常用 5 + 高级 10 = 15；订阅域在「记忆共享」渲染）。 */
export const IA_EDITOR_RENDER_PATHS = [...IA_COMMON_FIELDS, ...IA_ADVANCED_FIELDS];
