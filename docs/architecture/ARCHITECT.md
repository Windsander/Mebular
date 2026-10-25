# Mebular 架构

> 本文描述稳定架构与边界，不记录发布状态、PR 或测试数字。
> 产品定位、安装与首次运行见 [`README.md`](../../README.md) / [`README_CN.md`](../../README_CN.md)；
> 封板语义见 [`SEALING.md`](../../SEALING.md)，已知边界见 [`LIMITATIONS.md`](../limitations/LIMITATIONS.md)。

Mebular 是一套**本地优先的跨设备记忆与任务协作层**。它不把记忆托管到中心服务，而是让每台机器运行一个守护，
由守护持有身份、网络、同步与信任；Agent、fleet、控制台都只是这个守护的客户端。

![一机一节点一守护](../../assets/architecture-cn.svg)

## 1. 设计约束

这四条约束决定了后面的所有实现：

1. **一机一节点一守护**。同一份 home 只有一个活跃的 `mebular serve`；身份、网络、信任和策略由它统一持有，
   其它入口不复制内核逻辑。
2. **事件日志是单一事实源**。写入先成为签名事件，图、记忆、任务和审计都从事件派生；删除是墓碑，不是静默抹除。
3. **远程面只有记忆通道**。跨设备通信统一走同步的数据面；任务本身也是记忆（DAG），不提供通用远程 RPC。
4. **greenfield 边界**。没有混版兼容层；所有设备必须同版本签订同一套协议语义。

## 2. 运行时分层

这里的“运行时”指进程启动后实际承担职责的层次；“交付面”单独列出，避免把打包和 CI 混进运行时。

| 层 | 职责 | 代表实现 | 明确不负责 |
|---|---|---|---|
| **入口面** | 把用户或 Agent 的意图送进控制面 | 桌面 App、浏览器控制台、`mebular` / `fleet` CLI、MCP 客户端 | 不持有身份、不直接开存储、不自行同步 |
| **控制面** | 装配并守护唯一实例；暴露 HTTP / MCP / admin / console / join | `packages/mcp/src/serve.mjs`、`server.mjs`、`provision.mjs`、`admin.mjs` | 不实现记忆业务；业务一律委托领域面 |
| **领域面** | 记忆、图、事件、任务、同步、信任与策略 | `src/mebular.ts`、`src/memory/*`、`src/sync/*`、`packages/fleet/src/*` | 不依赖具体 UI、不直接绑定某个传输 |
| **基础面** | 可替换的落盘、密码学、网络和系统能力 | `src/storage/*`、`src/crypto/*`、`src/p2p/*`、`packages/service/*`、`src/exchange/*` | 不决定产品语义；通过接口被领域面使用 |
| **交付面** | 包、桌面壳、Skill、文档与流水线 | 6 个 npm 包（5 lockstep + 1 独立插件）、`apps/desktop`、`packages/skill`、`.github/workflows` | 不改变运行时协议；只负责分发和验证 |

### 2.1 入口面

- **桌面 App**：Electron 薄壳。负责窗口、托盘、守护托管、忆云切换和首次向导；控制台仍由守护提供，
  App 不复制控制台或内核。
- **浏览器控制台**：同一份 `/console` 单页应用（原生 ES modules + Canvas 星图），通过 `/admin/api/*` 读写；
  没有独立前端构建链，也没有第二套业务实现。
- **CLI**：`mebular` 负责守护、MCP、服务与控制台；`fleet` 负责上车、邀请、加入与任务 CLI。
  根包 `@mebular/core` 同时提供两个 bin。
- **MCP 客户端**：通过 stdio 或守护的 HTTP `/mcp` 连接；工具面与 CLI 共用同一份注册表。

### 2.2 控制面

`mebular serve` 是唯一的运行时控制面。它负责：

- 取得 home 级单实例锁，校验端口上的 `/healthz` 实例身份；
- 装配 `Mebular`、`MemoryService`、同步、join 服务和 HTTP server；
- 提供 `/mcp`、`/healthz`、`/admin/api/*`、`/console`；
- 在空 home 上进入 `UNINITIALIZED`，在同一进程内完成 create/join 热初始化；
- 写运行时快照、配置生效结果、ready 标记和诊断信息。

**生命周期**：

```text
UNINITIALIZED ── create/join ──▶ INITIALIZING ──▶ READY
       ▲                              │
       └────────── 失败回滚 ──────────┘
```

- `UNINITIALIZED`：只开放 `/healthz`、`/console` 引导页、`/app/provision/*`、受限的 `/admin/api/clients`
  和 MCP 协议层（`initialize` / `tools/list` / `prompts/list`）；
- `INITIALIZING`：写入身份、配置、profile 与初始存储；失败时回滚本次落盘产物，锁不释放、端口不换；
- `READY`：切换同一个 server 的可变上下文，解锁完整 admin 数据面。

热初始化不重启进程、不重新绑定端口、不 reload 页面。控制台的“锁定态”是**客户端渲染状态**，
不是第二个 server，也不是独立的 provision 服务。

### 2.3 领域面

- **MemoryService**：Agent 与 MCP 的唯一业务入口；负责写入、召回、搜索、画像、技能、历史、图遍历、
  归档/删除、导入和同步。
- **GraphStore + EventLog**：五类节点（实体 / 事实 / 情节 / 技能 / 元数据）与带类型边；事实带
  `validFrom` / `validTo`；写入生成内容寻址的签名事件，删除写墓碑。
- **SyncManager**：基于向量时钟的增量同步；只交换对端缺失部分，离线后重连收敛。
- **Trust / Policy**：设备证书链、订阅声明、移出/恢复、安全档和设备/忆云名称；策略从事件派生。
- **Task DAG**：任务是共享记忆里的树/DAG（`causedBy`，禁环）；派发、认领、进度、结果和协商都通过
  记忆事件表达。

### 2.4 基础面

- **Storage**：默认 JSONL；可选 SQLite（`node:sqlite`，Node ≥ 22.5）。两种适配器共享同一套
  `StorageAdapter` 语义；Node 20 可用 JSON 适配器，SQLite 缺模块时诚实返回结构化的不可用错误。
- **Crypto**：Ed25519 设备签名、X25519 密钥协商、用户主密钥与设备证书链；存储可做静态加密。
- **Network**：libp2p、Noise、yamux；LAN 发现、直连、relay 与 NAT 打洞按可达性切换。
- **OS Service**：`@mebular/service` 抽象 launchd / systemd / schtasks；install 以新鲜心跳而不是
  “命令退出码”判定启动成功。
- **Exchange**：Canonical Memory Format（CMF）与 Obsidian、日志、JSON memo、Hermes 适配器，
  让记忆可以离开 Mebular 继续被使用。

### 2.5 交付面

- 5 个 lockstep npm 包：`@mebular/core`、`@mebular/service`、`@mebular/fleet`、`@mebular/mcp`、
  `@mebular/skill`；根包提供 `mebular` + `fleet` 双 bin。
- `@mebular/dsh-plugin` 独立版本线，与 v0.1.1 同批发布，但不进入五包 lockstep。
- `packages/console` 与 `apps/desktop` 为 private 工作包，不单独发布；控制台随根包/守护分发。
- Electron 桌面壳包含窗口、托盘、守护托管和云切换；v0.1.1 已纳入三平台 **unsigned** 安装包
  （macOS Universal DMG、Windows NSIS x64、Linux AppImage/deb x64）。安装包 runtime 来自与
  npm 发布同一批 verify tarball，并自带 Electron。签名、公证、自动更新在后续版本处理。

## 3. 表面契约

跨表面的状态、capability、reason 与恢复语义见 [`SURFACES.md`](SURFACES.md)；
本节只列各入口面的结构职责。

### 3.1 MCP

当前工具面为 **29 个**：13 个记忆工具 + 16 个任务工具。MCP 适配器和 CLI 共用 `TOOL_SPECS` /
`TASK_TOOL_SPECS`，避免“MCP 有、CLI 没有”的第二套实现。

- stdio：`mebular mcp`，要求没有已运行的守护（避免第二写者）；
- HTTP：`/mcp`，与守护同生命周期；
- OAuth / bearer scope 按工具收紧；
- 未初始化时由 `service-facade` 代理拦截业务调用，返回稳定的 `NOT_INITIALIZED`，协议层仍可发现工具；
- READY 后同一 session 直接转发真实 `MemoryService`，不重连、不重写配置。

### 3.2 Admin / Console

`/admin/api/*` 是控制台与桌面 App 的读写下表面；写请求需要 CSRF 双提交，远程/非环回访问按 auth
策略收紧。控制台只做展示和动作编排，不自行计算策略状态。

### 3.3 CLI / fleet

`fleet` 是任务和上车的 CLI 客户端；任务 handler 与 MCP 任务工具同源。CLI 可以脚本化完成
`quickstart` / `invite` / `join`，但 GUI 不会替用户选择或新建忆云。

## 4. 同步、信任与安全边界

- **配对**：邀请方发一次性、短时效 token；新设备用 token 换取委派证书。主密钥不离开根设备。
- **供给**：`信任 ∩ 本机订阅 ∩ 对端订阅`。订阅是阅读权 + 及时同步义务，不是域级 ACL。
- **移出**：`device_revoke` 是作者级否定，只拒被移出设备本人，不连坐其邀请的后代。
- **安全档**：low / medium / high 决定加入、邀请、移出、改档的动作门槛；high 的设备会签只覆盖
  首次加入。
- **明确边界**：
  - 信任边界内的已准入设备可以自行订阅域；没有“A 能读 X、B 不能读 X”的域内 ACL；
  - 恢复是信任重置，恢复前的策略记录不复活；
  - 根密钥轮换/换锚未实现，丢失或被盗没有产品内恢复；
  - 没有混版兼容层。

这些是产品语义，不是实现遗漏；对外说明必须与 [`LIMITATIONS.md`](../limitations/LIMITATIONS.md) 和
[`SEALING.md`](../../SEALING.md) 保持一致。

## 5. 代码地图

| 路径 | 角色 |
|---|---|
| `src/mebular.ts` | 核心生命周期与领域编排 |
| `src/memory/` | MemoryService、图存储、召回、向量索引 |
| `src/sync/` | 同步协议、收敛、策略派生、网络端点 |
| `src/p2p/` | 设备发现、连接、认证、libp2p 装配 |
| `src/crypto/` | 身份、设备证书链、存储加密 |
| `src/storage/` | JSONL / SQLite / 内存适配器 |
| `src/exchange/` | CMF 与外部记忆格式适配 |
| `packages/mcp/` | 守护、MCP、admin、provision、profiles、join、console 静态服务 |
| `packages/console/` | 控制台 SPA 与 UI 验证脚本 |
| `locales/` | locale pack 数据层：manifest 注册表 + 各语言 console/desktop/errors JSON |
| `packages/fleet/` | 任务 DAG、join token、安全、配额、CLI |
| `packages/service/` | 跨平台常驻服务管理 |
| `apps/desktop/` | Electron 壳、向导、守护托管、云切换 |
| `packages/skill/` | 记忆/任务 Skill 与安装脚本 |

## 6. 延伸阅读

- 产品与使用：[`README_CN.md`](../../README_CN.md) / [`README.md`](../../README.md)
- 快速上手：[`QUICKSTART_CN.md`](../getting-started/QUICKSTART_CN.md)
- 封板契约：[`SEALING_CN.md`](../../SEALING_CN.md) / [`SEALING.md`](../../SEALING.md)
- 已知边界：[`LIMITATIONS_CN.md`](../limitations/LIMITATIONS_CN.md) / [`LIMITATIONS.md`](../limitations/LIMITATIONS.md)
- fleet 设计：[`packages/fleet/DESIGN.md`](../../packages/fleet/DESIGN.md)
- 发布流程：[`RELEASE.md`](../operations/RELEASE.md)
