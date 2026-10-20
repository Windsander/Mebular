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
 * 折叠白名单（设置/关于共用；≤5，当前 3）。
 * 设置内 2 个（MCP 危险与自救 / 诊断与恢复）；关于本机 1 个（运行状态）。
 * 邀请面板不再有详情折叠。每项必须带 data-settings-fold，UI 断言据此防回归。
 */
export const IA_SETTINGS_FOLDS = [
  { id: 'mcp-danger', label: 'MCP 接入 · 危险与自救', home: 'mcp' },
  { id: 'diagnostics', label: '诊断与恢复', home: 'advanced' },
  { id: 'about-runtime', label: '运行状态（只读）', home: 'about' },
];

/** 邀请令牌有效期档位（UI 与断言共用；默认 15 分钟 = 服务端默认）。 */
export const INVITE_TTL_OPTIONS = [
  { label: '5 分钟', ttlMs: 300_000 },
  { label: '15 分钟', ttlMs: 900_000 },
  { label: '20 分钟', ttlMs: 1_200_000 },
  { label: '2 小时', ttlMs: 7_200_000 },
  { label: '6 小时', ttlMs: 21_600_000 },
  { label: '12 小时', ttlMs: 43_200_000 },
  { label: '24 小时', ttlMs: 86_400_000 },
];
export const INVITE_TTL_DEFAULT_MS = 900_000;

/**
 * 安全 tab 的三段式结构：等级 / 动态码种子 / 恢复码。
 * 文案在这里收口（主界面不出现内部错误码；风险说明短句保留）。
 */
export const IA_SECURITY_SECTIONS = {
  level: {
    title: '安全等级',
    desc: '档位越高，敏感操作的门槛越高。',
  },
  totp: {
    title: '动态码种子',
    desc: '中档敏感操作需要 6 位动态码；种子只存本机。',
  },
  recovery: {
    title: '恢复码',
    desc: '高档的离线钥匙；只显示一次，请离线保存。',
  },
};

export const SECURITY_LEVEL_LABEL = { low: '低', medium: '中', high: '高' };
export const SECURITY_LEVEL_TITLE = {
  low: '低（默认）',
  medium: '中 · 动态码',
  high: '高 · 设备会签',
};
export const SECURITY_LEVEL_NOTE = {
  low: '无额外门槛。',
  medium: '6 位动态码，防顺手。',
  high: '另一台设备核对配对号，防伪造；只对之后的动作生效。',
};
export const SECURITY_BOUNDARY = '中档挡手不挡钥匙：设备被拿走，种子也一并被拿走。高档需要另一台设备在场，不在时用离线恢复码。';
export const SECURITY_TOTP_FOOT = '种子只在本机；全部设备丢失时由 root 重置，无主密钥备份则不可恢复。';

/**
 * 「高级」三组（每组 = 标题 + 一行说明 + 字段行）。
 * 字段顺序即展示顺序；能力与 schema 的 editable 集合一一对应。
 */
export const IA_ADVANCED_SECTIONS = [
  {
    id: 'resident',
    title: '常驻服务',
    desc: '邀请设备前先启用；地址与端口决定新设备能否连上。',
    fields: ['joinService.enabled', 'joinService.bind', 'joinService.port'],
  },
  {
    id: 'network',
    title: '网络',
    desc: '本机与忆云之间的连接；关闭后仅本机可用。',
    fields: ['network.enabled', 'network.libp2p.listen'],
  },
  {
    id: 'automation',
    title: '自动化',
    desc: '后台维护与可选能力；默认设置适合多数人。',
    fields: ['sync.antiEntropy.enabled', 'semantic.enabled'],
  },
];

/**
 * 「MCP 接入」两组：连接 / TLS。危险与自救收进唯一折叠（IA_MCP_DANGER_LINES）。
 */
export const IA_MCP_SECTIONS = [
  {
    id: 'connection',
    title: '连接',
    desc: 'Agent 经 MCP 连接本机；改动会立即影响控制台访问。',
    fields: ['mcp.http.port', 'mcp.http.auth', 'mcp.http.host'],
  },
  {
    id: 'tls',
    title: 'TLS',
    desc: '加密 MCP 连接；监听非回环时必需。',
    fields: ['mcp.http.tls', 'mcp.http.tlsCert', 'mcp.http.tlsKey'],
  },
];

/** 折叠内三行：后果 + 两条自救路径（保留命令与备份名）。 */
export const IA_MCP_DANGER_LINES = [
  '改认证/监听/TLS 可能让控制台立即失联；提交前会再确认一次。',
  'bearer 失联：粘贴 token grant 生成的 token 自救。',
  'oauth/端口失联：改回 config.json，重启 mebular serve。',
];

/**
 * 字段展示文案（覆盖服务端 schema 的长帮助/长警告）。
 * 只改展示，不改校验、默认值或写入行为；帮助目标 ≤1 行。
 */
export const IA_FIELD_COPY = {
  'mcp.http.port': { help: '0 = 自动分配；默认 7331。' },
  'mcp.http.auth': {
    label: '认证',
    help: 'none 仅回环；bearer 用令牌；oauth 用环境密钥。',
    warn: '',
  },
  'mcp.http.host': {
    help: '默认 127.0.0.1；非回环必须配认证与 TLS。',
    warn: '',
  },
  'mcp.http.tls': { help: '缺证书会启动失败，不会静默降级。' },
  'mcp.http.tlsCert': {
    label: '证书路径',
    help: 'PEM 证书；与私钥同时填写才生效。',
  },
  'mcp.http.tlsKey': {
    label: '私钥路径',
    help: 'PEM 私钥；与证书同时填写才生效。',
  },
  'joinService.enabled': { help: '生成一次性邀请令牌；改动需重启。' },
  'joinService.bind': { help: '0.0.0.0 允许局域网；仅可信网络使用。' },
  'joinService.port': { help: '默认 4002；被占用时改这里。' },
  'network.enabled': { help: '关闭后仅本机离线使用。' },
  'network.libp2p.listen': { help: '留空用默认；仅回环时局域网不可达。' },
  'sync.antiEntropy.enabled': {
    label: '自动对账',
    help: '周期核对，弥补推送丢失。',
  },
  'semantic.enabled': {
    label: '启用语义召回',
    help: '需要本地模型；缺失时自动降级关键词。',
    warn: '',
    hideStatusReason: true,
  },
};

/** 「高级」全部可编辑字段（由三组派生；不再有“卡片之外的散项”）。 */
export const IA_ADVANCED_FIELDS = IA_ADVANCED_SECTIONS.flatMap((section) => section.fields);

/** 「MCP 接入」全部可编辑字段（由两组派生）。 */
export const IA_MCP_FIELDS = IA_MCP_SECTIONS.flatMap((section) => section.fields);

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
