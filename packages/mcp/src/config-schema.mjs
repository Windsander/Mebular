// 配置管道单一真源（A）：每一项配置的「写入校验 / 待重启判定 / 生效值 / 未生效原因 / GUI 暴露面 / 文档」都从这里取。
//
// 之前配置声明散在 4 处（serve.mjs CONFIG_PATCH_SPECS / admin.mjs RESTART_CONFIG_PATHS /
// console.js CONFIG_EDITOR+CONFIG_EFFECTIVE / settings-ia.js），每加一项就漂移。本文件是纯数据
// （无副作用、不依赖 node 内建），被 serve/admin/控制台/verify:config/E1 共用。
//
// exposure 语义（用户拍板：**自动的东西不保留在 GUI**）：
//   editable    —— 用户可改：GUI 渲染编辑器，`POST /admin/api/config` 可写（按 kind/spec 校验）
//   status-only —— 只读展示：值由运行时/自动池/学习得出，写请求一律 400
//   internal    —— 不暴露到 GUI（诊断/文档可见）；API 仍可写，但控制台不渲染
//
// requiresRestart：守护只在启动时读一次 config.json，改动需重启才生效（真值由 #80 的 pendingRestart 判定）。
// effective(settings)：从 `/admin/api/settings` 载荷取「实际生效值」（与运行时同源，不是磁盘原值）。
// reason(ctx)：可选的「未生效原因」覆盖；ctx 见 admin.mjs buildEffectiveReasons。

/** 数组归一：非数组/全空 → null（「未设置」），与 #80 pendingRestart 的归一一致。 */
export function listOrNull(value) {
  if (!Array.isArray(value)) return null;
  const list = value.filter((entry) => typeof entry === 'string' && entry.length > 0);
  return list.length > 0 ? list : null;
}

/**
 * 字段表。`kind` 决定写校验（bool/int/num/string/enum/list），`spec` 携带范围/前缀等约束；
 * `ui` 是控制台编辑器元数据（type/label/help/warn/step/min/max/placeholder/options）。
 */
export const CONFIG_SCHEMA = [
  // ------------------------------------------------------------------ editable · 常用（6）
  {
    path: 'network.enabled',
    read: (c) => c?.network?.enabled ?? false,
    kind: 'bool',
    exposure: 'editable',
    requiresRestart: true,
    default: false,
    envVar: 'MEBULAR_NETWORK_ENABLED',
    ui: { type: 'bool', label: '启用 P2P', help: '关闭后仅本机离线使用' },
    effective: (s) => s?.network?.enabled === true,
  },
  {
    path: 'network.libp2p.listen',
    read: (c) => listOrNull(c?.network?.libp2p?.listen),
    kind: 'list',
    spec: { prefix: '/', empty: 'delete' },
    exposure: 'editable',
    requiresRestart: true,
    default: null,
    ui: {
      type: 'list',
      label: '监听地址',
      placeholder: '/ip4/127.0.0.1/tcp/14001',
      help: 'multiaddr 列表；留空 = 默认监听',
    },
    effective: (s) => (s?.network?.listenConfigured?.length ? s.network.listenConfigured : (s?.network?.listen ?? [])),
    reason: (ctx) => {
      const actual = ctx.settings?.network?.listen ?? [];
      const nonLoopback = actual.some((addr) => !/\/ip4\/127\.|\/ip6\/::1|\/ip4\/0\.0\.0\.0/.test(addr) && !/\/dns/.test(addr));
      const wildcard = actual.some((addr) => /\/ip4\/0\.0\.0\.0/.test(addr));
      if (actual.length > 0 && !nonLoopback && !wildcard) return '仅回环监听：LAN 内其他设备不可达（如需 LAN 可设 0.0.0.0 或本机 LAN IP）';
      return null;
    },
  },
  {
    path: 'sync.namespaces',
    read: (c) => listOrNull(c?.sync?.namespaces),
    kind: 'list',
    spec: { empty: 'set' },
    exposure: 'editable',
    requiresRestart: true,
    default: null,
    ui: {
      type: 'list',
      label: '订阅数据域（M）',
      placeholder: 'default, notes',
      help: '订阅即承担数据义务：接收该域，并同步本机新增记忆。留空 = 参与全部。生效共享 = 对端授权 ∩ 对端在册（启用成员制时）∩ 本机订阅',
    },
    effective: (s) => (s?.sync?.subscriptions?.length ? s.sync.subscriptions : null),
  },
  {
    path: 'joinService.enabled',
    read: (c) => c?.joinService?.enabled === true,
    kind: 'bool',
    exposure: 'editable',
    requiresRestart: true,
    default: false,
    ui: { type: 'bool', label: '启用加入服务', help: '开启后可由「＋ 邀请新设备」签发一次性令牌（需重启）' },
    effective: (s) => s?.join?.enabled === true,
    reason: (ctx) => (ctx.settings?.join?.enabled === true && ctx.settings?.join?.endpointLoopback === true
      ? 'join 端点解析为回环地址：LAN 内新设备不可达（joinService.bind 设 0.0.0.0）'
      : null),
  },
  {
    path: 'mcp.http.port',
    read: (c) => c?.mcp?.http?.port ?? 7331,
    kind: 'int',
    spec: { min: 0, max: 65535, nullable: true },
    exposure: 'editable',
    requiresRestart: true,
    default: 7331,
    ui: { type: 'number', label: '端口', min: 0, max: 65535 },
    effective: (s) => s?.mcp?.port,
  },
  {
    path: 'mcp.http.auth',
    read: (c) => c?.mcp?.http?.auth ?? 'none',
    kind: 'enum',
    spec: { values: ['none', 'bearer', 'oauth'] },
    exposure: 'editable',
    requiresRestart: true,
    default: 'none',
    ui: {
      type: 'select',
      label: '鉴权模式',
      options: [['none', 'none（仅回环）'], ['bearer', 'bearer（token）'], ['oauth', 'oauth']],
      warn: '切换后控制台 API 立即需要凭证：bearer 需先 `mebular token grant --scope memory.read,memory.admin` 并在页面粘贴 token（否则 401 missing bearer token）；oauth 需在 env 提供 MEBULAR_OAUTH_ADMIN_SECRET / MEBULAR_OAUTH_REGISTER_SECRET，否则 /register 默认 404、静态 token 会 401 invalid token，控制台内无法自救。误切后恢复：编辑 config.json 把 mcp.http.auth 改回 none（仅回环），或补齐凭证后重启 mebular serve',
    },
    effective: (s) => s?.mcp?.auth,
    reason: (ctx) => (ctx.settings?.mcp?.auth !== 'none'
      ? '已生效：控制台 API 现需凭证（页面需粘贴 token / 走 OAuth）'
      : null),
  },

  // ------------------------------------------------------------------ editable · 高级（14）
  {
    path: 'sync.antiEntropy.enabled',
    read: (c) => c?.sync?.antiEntropy?.enabled ?? true,
    kind: 'bool',
    exposure: 'editable',
    requiresRestart: true,
    default: true,
    ui: { group: '反熵与快照', type: 'bool', label: '周期反熵', help: '周期性对账，弥补推送丢失' },
    effective: (s) => s?.sync?.antiEntropy?.enabled ?? true,
  },
  {
    path: 'sync.antiEntropy.intervalMs',
    read: (c) => c?.sync?.antiEntropy?.intervalMs ?? 600000,
    kind: 'int',
    spec: { min: 1000, nullable: true },
    exposure: 'editable',
    requiresRestart: true,
    default: 600000,
    ui: { type: 'minutes', label: '反熵间隔（分钟）', help: '默认 10 分钟（±20% 抖动）' },
    effective: (s) => s?.sync?.antiEntropy?.intervalMs ?? 600000,
  },
  {
    path: 'sync.antiEntropy.jitterRatio',
    read: (c) => c?.sync?.antiEntropy?.jitterRatio ?? 0.2,
    kind: 'num',
    spec: { min: 0, max: 1, nullable: true },
    exposure: 'editable',
    requiresRestart: true,
    default: 0.2,
    ui: { type: 'number', label: '反熵抖动比例', step: 0.05, min: 0, max: 1, help: '0 ~ 1，默认 0.2' },
    effective: (s) => s?.sync?.antiEntropy?.jitterRatio ?? 0.2,
  },
  {
    path: 'sync.snapshotThreshold',
    read: (c) => c?.sync?.snapshotThreshold ?? null,
    kind: 'int',
    spec: { min: 1, nullable: true },
    exposure: 'editable',
    requiresRestart: true,
    default: null,
    ui: { type: 'number', label: '快照阈值（事件数）', min: 1, placeholder: '留空 = 不启用', help: '对端空时钟且缺失事件数 ≥ 阈值时改用物化快照' },
    effective: (s) => s?.sync?.snapshotThreshold ?? null,
  },
  {
    path: 'sync.peerWhitelist',
    read: (c) => listOrNull(c?.sync?.peerWhitelist),
    kind: 'list',
    spec: { empty: 'delete' },
    exposure: 'editable',
    requiresRestart: true,
    default: null,
    ui: { group: '对端与签发者',       type: 'list',
      label: '对端白名单',
      placeholder: 'device-B, device-C',
      help: '记忆通道的传输闸门：仅与列出的 deviceId 建立会话；留空 = 不启用（按授权 / 成员制判定）',
    },
    effective: (s) => (s?.sync?.peerWhitelist?.length ? s.sync.peerWhitelist : null),
  },
  {
    path: 'sync.policyIssuers',
    read: (c) => listOrNull(c?.sync?.policyIssuers),
    kind: 'list',
    spec: { empty: 'delete' },
    exposure: 'editable',
    requiresRestart: true,
    default: null,
    ui: {
      type: 'list',
      label: '引导签发者（配置）',
      placeholder: 'device-A',
      help: '可签发任意分区的引导设备；留空 = 仅图上声明',
    },
    effective: (s) => (s?.sync?.configPolicyIssuers?.length ? s.sync.configPolicyIssuers : null),
  },
  {
    path: 'semantic.enabled',
    read: (c) => c?.semantic?.enabled ?? false,
    kind: 'bool',
    exposure: 'editable',
    requiresRestart: true,
    default: false,
    envVar: 'MEBULAR_SEMANTIC_ENABLED',
    ui: { group: '语义召回（可选依赖）',       type: 'bool',
      label: '启用语义召回',
      help: '需要本地 embedding 模型（可选依赖）',
      warn: '需可选依赖 @huggingface/transformers；缺失时自动降级关键词并告警',
    },
    effective: (s) => s?.semantic?.enabled === true,
    reason: (ctx) => (ctx.settings?.semantic?.enabled === true
      ? null
      : '缺可选依赖 @huggingface/transformers（或未安装）：自动降级关键词召回'),
  },
  {
    path: 'semantic.minScore',
    read: (c) => c?.semantic?.minScore ?? 0.2,
    kind: 'num',
    spec: { min: 0, max: 1, nullable: true },
    exposure: 'editable',
    requiresRestart: true,
    default: 0.2,
    ui: { type: 'number', label: '召回阈值', step: 0.05, min: 0, max: 1, help: '0 ~ 1，默认 0.2' },
    effective: (s) => s?.semantic?.minScore ?? 0.2,
  },
  {
    path: 'joinService.bind',
    read: (c) => c?.joinService?.bind ?? '0.0.0.0',
    kind: 'string',
    spec: { nonEmpty: true },
    exposure: 'editable',
    requiresRestart: true,
    default: '0.0.0.0',
    ui: { group: '设备接入（高级）',       type: 'text',
      label: '绑定地址',
      placeholder: '0.0.0.0',
      help: '令牌 join 端点绑定；默认即 0.0.0.0（quickstart 依赖 LAN 可达），仅可信 LAN 使用。它同时决定邀请令牌里写死的 endpoint：通配时自动取本机 LAN IPv4（无 LAN 时回环并在邀请面板告警）',
    },
    effective: (s) => s?.join?.bind,
  },
  {
    path: 'joinService.port',
    read: (c) => c?.joinService?.port ?? 4002,
    kind: 'int',
    spec: { min: 0, max: 65535, nullable: true },
    exposure: 'editable',
    requiresRestart: true,
    default: 4002,
    ui: { type: 'number', label: '端口', min: 0, max: 65535, help: '默认 4002' },
    effective: (s) => s?.join?.port,
    reason: (ctx) => {
      const lastError = ctx.settings?.join?.lastError;
      if (lastError && /EADDRINUSE|被占|占用/.test(String(lastError.message ?? lastError))) {
        return `join 端口被占（上次启动失败：${lastError.port ?? ctx.settings?.join?.port}）——改端口或释放占用`;
      }
      return null;
    },
  },
  {
    path: 'mcp.http.host',
    read: (c) => c?.mcp?.http?.host ?? '127.0.0.1',
    kind: 'string',
    spec: { nonEmpty: true, empty: 'delete' },
    exposure: 'editable',
    requiresRestart: true,
    default: '127.0.0.1',
    ui: { group: 'MCP 接入（高级）',       type: 'text',
      label: '监听地址',
      placeholder: '127.0.0.1',
      help: '仅回环可 auth=none/无 TLS',
      warn: '非回环（如 0.0.0.0）必须 auth≠none 且启用 TLS 并配证书，否则 serve 拒绝启动',
    },
    effective: (s) => s?.mcp?.host,
  },
  {
    path: 'mcp.http.tls',
    read: (c) => c?.mcp?.http?.tls === true,
    kind: 'bool',
    exposure: 'editable',
    requiresRestart: true,
    default: false,
    ui: {
      type: 'bool',
      label: '启用 TLS',
      help: '真开关：true 但缺证书时 serve 启动即报错（不静默降级）；证书齐备即实际启用（与运行状态同一真值）',
    },
    effective: (s) => s?.mcp?.tls === true,
    reason: (ctx) => (ctx.config?.mcp?.http?.tls === true && !(ctx.config?.mcp?.http?.tlsKey && ctx.config?.mcp?.http?.tlsCert)
      ? '缺证书：mcp.http.tlsKey / tlsCert 未齐备，serve 启动即报 MCP_INSECURE_CONFIG'
      : null),
  },
  {
    path: 'mcp.http.tlsKey',
    read: (c) => c?.mcp?.http?.tlsKey ?? null,
    kind: 'string',
    spec: { nonEmpty: true, empty: 'delete' },
    exposure: 'editable',
    requiresRestart: true,
    default: null,
    ui: { type: 'text', label: 'TLS 证书私钥路径', placeholder: '/path/to/key.pem', help: '与证书路径同时填写即实际启用 TLS（tls=true 则强制要求）' },
    effective: (s) => (s?.mcp?.tlsKeyConfigured ? '（已配置）' : null),
  },
  {
    path: 'mcp.http.tlsCert',
    read: (c) => c?.mcp?.http?.tlsCert ?? null,
    kind: 'string',
    spec: { nonEmpty: true, empty: 'delete' },
    exposure: 'editable',
    requiresRestart: true,
    default: null,
    ui: { type: 'text', label: 'TLS 证书路径', placeholder: '/path/to/cert.pem', help: '与证书路径同时填写即实际启用 TLS（tls=true 则强制要求）' },
    effective: (s) => (s?.mcp?.tlsCertConfigured ? '（已配置）' : null),
  },

  // ------------------------------------------------------------------ status-only（只读；写 → 400）
  {
    // B：自动 relay 池（seeds/hints/学习）——用户拍板「自动的不保留在 GUI 编辑面」
    path: 'network.libp2p.relayServers',
    read: (c) => listOrNull(c?.network?.libp2p?.relayServers),
    kind: 'list',
    exposure: 'status-only',
    requiresRestart: true,
    default: null,
    ui: { type: 'list', label: 'Relay 池（自动）', help: '自动来源：config seeds ∪ 配对令牌 hints ∪ 地址簿学习；只读展示，手工配置请编辑 config.json' },
    effective: (s) => (s?.network?.relays?.length ? s.network.relays : null),
    reason: (ctx) => (ctx.settings?.network?.relays?.length ? '已生效：自动池（seeds/hints/学习）' : '空：无已知 relay（配对或提供 relay 后自动填充）'),
  },
  {
    // 默认常开，不需暴露（决策：只读展示真值）
    path: 'sync.autoSync',
    read: (c) => c?.sync?.autoSync ?? true,
    kind: 'bool',
    exposure: 'status-only',
    requiresRestart: true,
    default: true,
    ui: { type: 'bool', label: '自动同步', help: '连接建立或事件到达时自动触发一次收敛（默认常开）' },
    effective: (s) => s?.sync?.autoSync ?? true,
    reason: (() => '已生效：常驻模式默认常开'),
  },
  {
    path: 'sync.pushOnWrite',
    read: (c) => c?.sync?.pushOnWrite ?? true,
    kind: 'bool',
    exposure: 'status-only',
    requiresRestart: true,
    default: true,
    envVar: 'MEBULAR_PUSH_ON_WRITE',
    ui: { type: 'bool', label: '写入即推送', help: '本机写入后即时推给对端（常驻模式默认开）' },
    effective: (s) => s?.sync?.pushOnWrite ?? true,
    reason: (() => '已生效：常驻模式默认常开'),
  },
  {
    path: 'status.lan.discovery',
    kind: 'status',
    exposure: 'status-only',
    requiresRestart: false,
    ui: { type: 'status', label: 'LAN 自动发现（mDNS）' },
    effective: (s) => s?.net?.mode ?? 'off',
    reason: (ctx) => (ctx.settings?.network?.enabled !== true
      ? '网络未启用：LAN 发现为 no-op'
      : '已生效：随网络启用（默认 mDNS）'),
  },
  {
    path: 'status.relay.role',
    kind: 'status',
    exposure: 'status-only',
    requiresRestart: false,
    ui: { type: 'status', label: '内建 relay 角色（桥）' },
    effective: (s) => s?.relay?.mode ?? 'off',
    reason: (ctx) => {
      const relay = ctx.settings?.relay;
      if (!relay) return '状态不可读';
      if (relay.mode === 'off') return `未提供中转：${relay.reason ?? 'mode=off'}`;
      return relay.serving ? '已生效：本机对外提供中转（仅已配对/已授权对端）' : `待条件满足：${relay.reason ?? '未对外可达'}`;
    },
  },
  {
    path: 'status.relay.bridge',
    kind: 'status',
    exposure: 'status-only',
    requiresRestart: false,
    ui: { type: 'status', label: '当前中转（经谁）' },
    effective: (s) => s?.relay?.bridge?.peer ?? null,
    reason: (ctx) => (ctx.settings?.relay?.bridge
      ? `已生效：经 ${ctx.settings.relay.bridge.address ?? ctx.settings.relay.bridge.peer} 中转`
      : '直连优先：当前未走 relay（打洞成功或直连可达）'),
  },
  {
    path: 'status.nat.holepunch',
    kind: 'status',
    exposure: 'status-only',
    requiresRestart: false,
    ui: { type: 'status', label: 'NAT 穿透（AutoNAT/DCUtR）' },
    effective: (s) => (s?.nat?.dcutrEnabled ? 'on' : 'off'),
    reason: (ctx) => {
      const nat = ctx.settings?.nat;
      if (!nat) return '状态不可读';
      if (nat.enabled !== true) return '未启用：网络未开启（AutoNAT/DCUtR 未装配）';
      if (nat.dcutrEnabled !== true) return `打洞不可用：${nat.loadError ?? 'DCUtR 未启用'}`;
      return nat.directUpgrades > 0 ? `已生效：已直连升级 ${nat.directUpgrades} 次` : '已装配：尚无打洞升级（直连失败时后台重试）';
    },
  },
  {
    path: 'status.net.broadcast',
    kind: 'status',
    exposure: 'status-only',
    requiresRestart: false,
    ui: { type: 'status', label: '地址自动广播（只作 hints）' },
    effective: (s) => s?.net?.mode ?? 'off',
    reason: (ctx) => (ctx.settings?.net?.enabled
      ? `已生效：档位 ${ctx.settings.net.mode}（已发布 ${ctx.settings.net.published} / 已采用 ${ctx.settings.net.applied}）`
      : '未启用（opt-in）：默认不广播地址'),
  },
  {
    path: 'status.join.endpoint',
    kind: 'status',
    exposure: 'status-only',
    requiresRestart: false,
    ui: { type: 'status', label: '邀请端点（join）' },
    effective: (s) => s?.join?.endpoint ?? (s?.join?.port ? `:${s.join.port}` : null),
    reason: (ctx) => {
      const join = ctx.settings?.join;
      if (!join?.enabled && !join?.endpoint) return '未启用：joinService.enabled=false';
      if (join.endpointLoopback === true) return '不可达：端点回环（新设备无法访问）——joinService.bind 设 0.0.0.0';
      if (join.lastError) return `上次启动失败：${join.lastError.message ?? join.lastError}`;
      return '已生效：端点对新设备可达';
    },
  },
  {
    path: 'status.tls',
    kind: 'status',
    exposure: 'status-only',
    requiresRestart: false,
    ui: { type: 'status', label: 'TLS（实际）' },
    effective: (s) => (s?.mcp?.tls === true ? 'on' : 'off'),
    reason: (ctx) => (ctx.settings?.mcp?.tls ? '已生效：TLS 实际启用' : '未启用：明文 HTTP（仅回环安全）'),
  },
  {
    // grantTtl 不是配置键：由邀请令牌的 grantTtlMs 决定（默认 24h，自动撤销）
    path: 'status.invite.grantTtl',
    kind: 'status',
    exposure: 'status-only',
    requiresRestart: false,
    ui: { type: 'status', label: '邀请自动授权 TTL' },
    effective: (() => '24h'),
    reason: (() => '已生效：默认 24h（随令牌可选覆盖，到期自动撤销）'),
  },

  // ------------------------------------------------------------------ internal（GUI 不渲染；API 仍可写）
  { path: 'network.libp2p.relayUnlimited', read: (c) => c?.network?.libp2p?.relayUnlimited === true, kind: 'bool', exposure: 'internal', writable: true, requiresRestart: true, default: false, ui: { type: 'bool', label: 'Relay 不做限额' } },
  { path: 'network.libp2p.relayServer', kind: 'bool', exposure: 'internal', requiresRestart: true, default: false, ui: { type: 'bool', label: '本机充当 relay 服务端' } },
  { path: 'network.libp2p.relayPolicy', kind: 'object', exposure: 'internal', writable: false, requiresRestart: true, default: null, ui: { type: 'object', label: 'Relay 白名单/预约上限' } },
  { path: 'network.lan.enabled', kind: 'bool', exposure: 'internal', requiresRestart: true, default: true, ui: { type: 'bool', label: 'LAN 自动发现开关' } },
  { path: 'network.lan.autoDial', kind: 'bool', exposure: 'internal', requiresRestart: true, default: true, ui: { type: 'bool', label: 'LAN 发现后自动拨号' } },
  { path: 'network.lan.defaultFactory', kind: 'bool', exposure: 'internal', requiresRestart: true, default: true, ui: { type: 'bool', label: '内置 mDNS factory' } },
  { path: 'network.relayService', kind: 'enum', spec: { values: ['auto', 'off', 'on'] }, exposure: 'internal', requiresRestart: true, default: 'auto', ui: { type: 'select', label: '内建 relay 角色' } },
  { path: 'network.broadcast.mode', kind: 'enum', spec: { values: ['off', 'full', 'relay-only'] }, exposure: 'internal', requiresRestart: true, default: 'off', ui: { type: 'select', label: '地址广播档位' } },
  { path: 'network.broadcast.ttlMs', kind: 'int', exposure: 'internal', requiresRestart: true, default: 86400000, ui: { type: 'number', label: '广播 TTL' } },
  { path: 'network.nat.autonat', kind: 'bool', exposure: 'internal', requiresRestart: true, default: true, ui: { type: 'bool', label: 'AutoNAT' } },
  { path: 'network.nat.dcutr', kind: 'bool', exposure: 'internal', requiresRestart: true, default: true, ui: { type: 'bool', label: 'DCUtR 打洞' } },
  { path: 'network.endpointStore', kind: 'object', exposure: 'internal', writable: false, requiresRestart: true, default: null, ui: { type: 'object', label: '端点簿存储接缝' } },
  { path: 'network.autoConnect', kind: 'bool', exposure: 'internal', requiresRestart: true, default: true, ui: { type: 'bool', label: '地址簿自动拨号' } },
  { path: 'network.peers', kind: 'list', exposure: 'internal', writable: false, requiresRestart: true, default: null, ui: { type: 'list', label: '启动时主动拨号对端' } },
  { path: 'sync.pushOnWriteThrottleMs', kind: 'int', exposure: 'internal', requiresRestart: true, default: 50, ui: { type: 'number', label: '写入即推节流' } },
  { path: 'sync.peerNamespacePolicy', kind: 'object', exposure: 'internal', writable: false, requiresRestart: true, default: null, ui: { type: 'object', label: '按对端的分区策略（旧）' } },
  { path: 'sync.syncTimeout', kind: 'int', exposure: 'internal', requiresRestart: true, default: null, ui: { type: 'number', label: '同步超时' } },
  { path: 'sync.syncStatePath', kind: 'string', exposure: 'internal', writable: false, requiresRestart: true, default: null, ui: { type: 'text', label: '已确认集合持久化路径' } },
  { path: 'semantic.model', kind: 'string', exposure: 'internal', writable: false, requiresRestart: true, default: null, ui: { type: 'text', label: 'embedding 模型' } },
  { path: 'semantic.cacheDir', kind: 'string', exposure: 'internal', writable: false, requiresRestart: true, default: null, ui: { type: 'text', label: '模型缓存目录' } },
  { path: 'storagePath', kind: 'string', exposure: 'internal', writable: false, requiresRestart: true, default: null, ui: { type: 'text', label: '存储路径' } },
  { path: 'storageAdapter', kind: 'enum', spec: { values: ['json', 'sqlite'] }, exposure: 'internal', writable: false, requiresRestart: true, default: 'json', ui: { type: 'select', label: '存储适配器' } },
  { path: 'deviceId', kind: 'string', exposure: 'internal', writable: false, requiresRestart: true, default: null, ui: { type: 'text', label: '设备标识' } },
  { path: 'deviceName', kind: 'string', exposure: 'internal', writable: false, requiresRestart: true, default: null, ui: { type: 'text', label: '设备名' } },
  { path: 'identity.mode', kind: 'enum', spec: { values: ['root', 'delegated'] }, exposure: 'internal', writable: false, requiresRestart: true, default: 'root', ui: { type: 'select', label: '身份模式' } },
  { path: 'encryption.level', kind: 'enum', spec: { values: ['none', 'at-rest'] }, exposure: 'internal', writable: false, requiresRestart: true, default: 'none', ui: { type: 'select', label: '加密级别' } },
  { path: 'encryption.passphraseEnv', kind: 'string', exposure: 'internal', writable: false, requiresRestart: true, default: null, ui: { type: 'text', label: '口令环境变量名' } },
  { path: 'mcp.http.tokensFile', kind: 'string', exposure: 'internal', writable: false, requiresRestart: true, default: null, ui: { type: 'text', label: '静态 token 文件' } },
];

/** path → 条目（O(1) 查表）。 */
export const CONFIG_SCHEMA_BY_PATH = new Map(CONFIG_SCHEMA.map((entry) => [entry.path, entry]));

/** 某 path 的暴露面；未知 path = null（写请求应拒绝）。 */
export function exposureOf(path) {
  return CONFIG_SCHEMA_BY_PATH.get(path)?.exposure ?? null;
}

/**
 * 是否允许经 `POST /admin/api/config` 写入：
 *   editable → 允许；internal → 仅 `writable: true` 允许；status-only / 敏感 internal / 未知 → 拒绝。
 */
export function isWritable(path) {
  const entry = CONFIG_SCHEMA_BY_PATH.get(path);
  if (!entry) return false;
  if (entry.exposure === 'editable') return true;
  if (entry.exposure === 'internal') return entry.writable === true;
  return false;
}

/** 写请求拒绝时的分类（供 400 文案与断言）。 */
export function writeRejection(path) {
  const entry = CONFIG_SCHEMA_BY_PATH.get(path);
  if (!entry) return 'unknown';
  if (entry.exposure === 'status-only') return 'status-only';
  if (entry.exposure === 'internal') return entry.writable === true ? null : 'internal-protected';
  return null;
}

const pathsWith = (exposure) => CONFIG_SCHEMA.filter((entry) => entry.exposure === exposure).map((entry) => entry.path);

/** 可编辑面（常用 6 + 高级 14 = 20）。 */
export const EDITABLE_PATHS = pathsWith('editable');
/** 只读面（自动池/状态行；写请求 → 400）。 */
export const STATUS_ONLY_PATHS = pathsWith('status-only');
/** 内部面（GUI 不渲染；API 仍可写）。 */
export const INTERNAL_PATHS = pathsWith('internal');

/**
 * 需要重启才生效的 path（真值判定仍在 admin.computePendingRestart）。
 * 待重启横幅只覆盖「有 GUI 去处」的项：editable ∪ status-only ∪ 显式可写 internal
 * （= 与 #80 的 24 项逐一对应；纯 protected internal 不渲染也不报）。
 */
export const PENDING_RESTART_PATHS = CONFIG_SCHEMA.filter(
  (entry) => entry.requiresRestart === true
    && (entry.exposure === 'editable' || entry.exposure === 'status-only' || entry.writable === true),
);

/** 控制台编辑器元数据（editable 面；含 path/kind/spec/ui/requiresRestart/default）。 */
export function consoleSchema() {
  return CONFIG_SCHEMA.filter((entry) => entry.exposure === 'editable').map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    spec: entry.spec ?? {},
    ui: entry.ui,
    requiresRestart: entry.requiresRestart === true,
    default: entry.default ?? null,
  }));
}

/** 控制台只读面（status-only 行：label + 实际值 + 原因），供「关于本机 / 诊断」只读展示。 */
export function consoleStatusSchema() {
  return CONFIG_SCHEMA.filter((entry) => entry.exposure === 'status-only').map((entry) => ({
    path: entry.path,
    ui: entry.ui,
  }));
}
