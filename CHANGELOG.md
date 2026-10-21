# Changelog

All notable changes to Mebular are documented here.
All published packages share a single lockstep version.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Version headings carry the `v` prefix (`## [v0.1.0]`) because it is the release SSOT:
> the branch name (`release/v0.1.0`), the five `package.json` versions and the Git tag must
> all agree with this section.

The GitHub Release body is extracted from this file: everything between `## [v0.1.0]` and the
next `## [` heading. Keep that section self-contained.

## [Unreleased]

Nothing yet.

## [v0.1.0] - 2026-10-21

Initial release. Five lockstep packages: `@mebular/core`, `@mebular/service`,
`@mebular/fleet`, `@mebular/mcp`, `@mebular/skill`. The root bundle `@mebular/core`
provides both the `mebular` and `fleet` CLIs.

### Highlights (EN)

- **Onboarding v2: one-click to a locked console** — in the desktop app, **Start deployment** starts the local daemon and connects the AI assistants already installed on the machine, then opens the locked main console. The first device creates a Cloud with a Cloud name + device name; later devices join an existing Cloud with a one-time token + device name. Initialization runs in the same daemon process and on the same page: no restart, no reload, and the console unlocks immediately. Once a Cloud is current, the top bar switches from **Create new Cloud / Join existing Cloud** to **Invite device / Join Cloud**.
- **MCP is reachable before setup** — the HTTP `/mcp` facade accepts `initialize`, `tools/list` and `prompts/list` while the instance is UNINITIALIZED. `tools/call` returns the stable `NOT_INITIALIZED` business error, and the same MCP session recovers after create/join without restarting the daemon or rewriting assistant configuration.
- **Graph memory with validity windows** — entity / fact / episode / skill / meta nodes, typed edges, and facts that know when they are true (`validFrom` / `validTo`), so recall can be filtered by time instead of returning a flat queue.
- **Verifiable, tamper-evident history** — every write is an Ed25519-signed, content-addressed event; who changed what is always auditable, and deletes are tombstones rather than silent erasure.
- **Offline-first incremental sync** — vector clocks exchange only what the peer is missing; devices converge on reconnect with no central service, and direct / relay / hole-punch transitions plus automatic bridges are handled for you.
- **One machine, one node, one daemon** — `mebular serve` is the sole holder of identity, network and trust; fleet and agents are local clients. Device enrollment uses a QR code or a short-lived single-use token, and trust is a bounded certificate chain to the user master key, so the master key can stay offline.
- **Back up the root key** — the user master key is the trust root and never leaves the device. Back up `~/.mebular/user-master-key.json` offline after the first setup. v0.1.0 has no master-key rotation or re-anchoring; if the key is lost or stolen, there is no in-product recovery path (see [`LIMITATIONS.md`](https://github.com/Windsander/Mebular/blob/main/LIMITATIONS.md)).
- **Cloud and device names** — give the current Cloud and your own device readable names; changes sync as signed policy metadata to every admitted device, with blocked-author filtering and local duplicate-name warnings.
- **Compact invite panel** — QR, token, TTL and expiry in one small panel; regenerating invalidates the old token, and the panel closes with a top-right X.
- **One MCP surface for any assistant** — 29 tools (13 memory + 16 task) over stdio and Streamable HTTP, with OAuth / bearer hardening, per-tool scopes and the same registry behind the CLI and the console.
- **Fleet task collaboration across devices** — tasks are a DAG inside shared memory (`causedBy`, cycle-free): dispatch, claim, progress, result and negotiation (clarify / counter / accept / reject), with the memory channel as the only remote surface — no general remote RPC.
- **Assistant onboarding in one pass** — 7 built-in descriptors (OpenChamber, Hermes, OpenCode, Claude Code, Claude Desktop, Cursor, DSH) plus a custom snippet path; each goes through detect → apply → verify, and the desktop one-click flow can connect installed assistants before a Cloud exists.
- **Portable by design** — Canonical Memory Format (CMF) v1 with adapters for Obsidian, log journals, json-memo and Hermes, plus installable memory / task skills so the behaviour layer travels with the data.

### 亮点（中文）

- **Onboarding v2：一键进入锁定控制台** —— 桌面 App 点「开始部署」后，启动本机守护、自动接入本机已装的 AI 助手，然后进入锁定主控制台。第一台设备填忆云名 + 设备名新建忆云；后续设备用一次性令牌 + 设备名加入已有忆云。初始化在同一个守护进程、同一个页面内完成：不重启、不刷新，控制台立即解锁。有当前忆云后，顶栏从「新建忆云 / 加入忆云」恢复为「邀请设备 / 加入忆云」。
- **未初始化也能连上 MCP** —— HTTP `/mcp` 在 UNINITIALIZED 阶段即可完成 `initialize`、`tools/list` 与 `prompts/list`；`tools/call` 返回稳定的 `NOT_INITIALIZED` 业务错误。建新 / 加入忆云后，同一个 MCP 会话自动恢复，不需要重启守护或重写助手配置。
- **带有效期窗口的图记忆** —— 实体 / 事实 / 情节 / 技能 / 元数据五类节点与带类型的边；事实自带生效区间（`validFrom` / `validTo`），召回可按时间过滤，而不是返回一个扁平队列。
- **可验证、抗篡改的历史** —— 每次写入都是 Ed25519 签名、内容寻址的事件；谁改了什么随时可审计，删除落墓碑而非静默抹除。
- **离线优先的增量同步** —— 向量时钟只交换对端缺失的部分；重连即收敛，不依赖中心服务；直连 / 中继 / 打洞的切换与自动当桥都由框架完成。
- **一机一节点一守护** —— `mebular serve` 是身份、网络与信任的唯一持有者，fleet 与 Agent 都是本机客户端；设备凭二维码或短时效一次性令牌入网，信任是链到用户主密钥的有界证书链，主密钥可以一直离线。
- **备份根密钥** —— 用户主密钥是信任根，且永不离开本机。首次 setup 后请离线备份 `~/.mebular/user-master-key.json`。v0.1.0 未实现主密钥轮换 / 换锚；丢失或被盗没有产品内恢复路径（见 [`LIMITATIONS.md`](https://github.com/Windsander/Mebular/blob/main/LIMITATIONS.md)）。
- **忆云与设备名同步** —— 当前忆云和本人设备名可改为易读名称；名称作为签名策略元数据同步到所有已准入设备，过滤被移出作者，并在本机重名时给出提示。
- **精简邀请面板** —— 二维码、令牌、有效期和到期时间收进一个小面板；重新生成会作废旧令牌，右上角 X 关闭。
- **面向任意助手的统一 MCP 工具面** —— stdio 与 Streamable HTTP 两种接入，29 个工具（13 记忆 + 16 任务），带 OAuth / bearer 加固与逐工具 scope；CLI 与控制台共用同一份注册表。
- **跨设备 fleet 任务协作** —— 任务是共享记忆里的 DAG（`causedBy`，禁环）：派发、认领、进度、结果与协商（clarify / counter / accept / reject），唯一远程面就是记忆通道，不提供通用远程调用。
- **助手一键接入** —— 7 个内置描述符（OpenChamber、Hermes、OpenCode、Claude Code、Claude Desktop、Cursor、DSH）加自定义片段；统一走探测 → 写入 → 验证三步；桌面一键流程可以在忆云存在之前先接好已装助手。
- **可带走的设计** —— Canonical Memory Format（CMF）v1，配 Obsidian、日志型端、json-memo、Hermes 适配器；记忆 / 任务两个 Skill 可安装，行为层随数据一起迁移。

[Unreleased]: https://github.com/Windsander/Mebular/compare/v0.1.0...HEAD
[v0.1.0]: https://github.com/Windsander/Mebular/releases/tag/v0.1.0
