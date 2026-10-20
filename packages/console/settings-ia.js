// 控制台设置页信息架构（IA）——单一真源，供前端渲染与 E1 断言共用（纯数据，无 DOM）。
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

/** 设置弹层的 Tab（顺序即展示顺序；`common` 为默认）。E1：增「安全」「MCP 接入」专区。 */
export const IA_TABS = [
  { id: 'common', label: '常用' },
  { id: 'security', label: '安全' },
  { id: 'assistants', label: 'AI 助手' },
  { id: 'mcp', label: 'MCP 接入' },
  { id: 'advanced', label: '高级' },
];

/** 设置弹层的附加导航（非 Tab：点击打开既有「关于本机」弹层）。 */
export const IA_SETTINGS_EXTRA = [
  { id: 'about', label: '关于本机', opens: 'about-modal' },
];

/**
 * 「高级」的成组卡片（E1：原「常用」的加入服务三项聚成「常驻服务」）。
 * 网络两项按常规字段组渲染；MCP 六项独立成 Tab（见 IA_MCP_CARD）。
 */
export const IA_ADVANCED_CARDS = [
  {
    id: 'join-service',
    title: '常驻服务',
    desc: '邀请设备前先启用加入服务（主密钥不复制）；bind/port 决定新设备可达的 join 端点，改动需重启守护。',
    fields: ['joinService.enabled', 'joinService.bind', 'joinService.port'],
  },
];

/**
 * 「MCP 接入」独立 Tab 的危险卡：端口/鉴权/监听/TLS 六项。
 * 危险说明与自救恢复文案随迁（改到不可达时的两条出路）。
 */
export const IA_MCP_CARD = {
  id: 'mcp',
  title: 'MCP 接入',
  desc: 'Agent 经 MCP 连接本机；改端口/鉴权/监听/TLS 会立即影响控制台自身的访问方式。改到不可达时：bearer 可粘贴 token 自救；oauth 需 env secret，否则只能编辑 config.json 改回并重启。',
  danger: true,
  fields: ['mcp.http.port', 'mcp.http.auth', 'mcp.http.host', 'mcp.http.tls', 'mcp.http.tlsKey', 'mcp.http.tlsCert'],
};

/**
 * 「高级」字段（卡片之外的散项；默认收起；风险由文案标注）。
 * E1：网络两项从「常用」迁入；其余 sync.* 保持专家旋钮。
 */
export const IA_ADVANCED_FIELDS = [
  'network.enabled',
  'network.libp2p.listen',
  'sync.antiEntropy.enabled',
  'semantic.enabled',
];

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

/** 全部「可编辑 path」（高级卡片 3 + 高级散项 4 + MCP 卡 6 + 记忆共享 1 = **14**）——与 schema EDITABLE_PATHS 一致。 */
export const IA_EDITOR_PATHS = [
  ...IA_ADVANCED_CARDS.flatMap((card) => card.fields),
  ...IA_ADVANCED_FIELDS,
  ...IA_MCP_CARD.fields,
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
  ...Object.fromEntries(IA_ADVANCED_CARDS.flatMap((card) => card.fields.map((p) => [p, 'advanced']))),
  ...Object.fromEntries(IA_ADVANCED_FIELDS.map((p) => [p, 'advanced'])),
  ...Object.fromEntries(IA_MCP_CARD.fields.map((p) => [p, 'mcp'])),
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

/** 前端设置页实际渲染的编辑面 path（高级 3+4 + MCP 6 = 13；订阅域在「记忆共享」渲染）。 */
export const IA_EDITOR_RENDER_PATHS = [
  ...IA_ADVANCED_CARDS.flatMap((card) => card.fields),
  ...IA_ADVANCED_FIELDS,
  ...IA_MCP_CARD.fields,
];
