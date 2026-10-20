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

## [v0.1.0] - 2026-10-20

First public release. Five lockstep packages: `@mebular/core`, `@mebular/service`,
`@mebular/fleet`, `@mebular/mcp`, `@mebular/skill`.

### Highlights (EN)

- **Graph memory with validity windows** — entity / fact / episode / skill / meta nodes, typed edges, and facts that know when they are true (`validFrom` / `validTo`), so recall can be filtered by time instead of returning a flat queue.
- **Verifiable, tamper-evident history** — every write is an Ed25519-signed, content-addressed event; who changed what is always auditable, and deletes are tombstones rather than silent erasure.
- **Offline-first incremental sync** — vector clocks exchange only what the peer is missing; devices converge on reconnect with no central service, and direct / relay / hole-punch transitions plus automatic bridges are handled for you.
- **One machine, one node, one daemon** — `mebular serve` is the sole holder of identity, network and trust; fleet and agents are local clients. Device enrollment uses a QR code or a short-lived single-use token, and trust is a bounded certificate chain to the user master key, so the master key can stay offline.
- **One MCP surface for any assistant** — 29 tools (13 memory + 16 task) over stdio and Streamable HTTP, with OAuth / bearer hardening, per-tool scopes and the same registry behind the CLI and the console.
- **Fleet task collaboration across devices** — tasks are a DAG inside shared memory (`causedBy`, cycle-free): dispatch, claim, progress, result and negotiation (clarify / counter / accept / reject), with the memory channel as the only remote surface — no general remote RPC.
- **Assistant onboarding in one pass** — 7 built-in descriptors (OpenChamber, Hermes, OpenCode, Claude Code, Claude Desktop, Cursor, DSH) plus a custom snippet path; each goes through detect → apply → verify, and the desktop app and star-map console cover first-run **Create new / Join existing**.
- **Portable by design** — Canonical Memory Format (CMF) v1 with adapters for Obsidian, log journals, json-memo and Hermes, plus installable memory / task skills so the behaviour layer travels with the data.

### 亮点（中文）

- **带有效期窗口的图记忆** —— 实体 / 事实 / 情节 / 技能 / 元数据五类节点与带类型的边；事实自带生效区间（`validFrom` / `validTo`），召回可按时间过滤，而不是返回一个扁平队列。
- **可验证、抗篡改的历史** —— 每次写入都是 Ed25519 签名、内容寻址的事件；谁改了什么随时可审计，删除落墓碑而非静默抹除。
- **离线优先的增量同步** —— 向量时钟只交换对端缺失的部分；重连即收敛，不依赖中心服务；直连 / 中继 / 打洞的切换与自动当桥都由框架完成。
- **一机一节点一守护** —— `mebular serve` 是身份、网络与信任的唯一持有者，fleet 与 Agent 都是本机客户端；设备凭二维码或短时效一次性令牌入网，信任是链到用户主密钥的有界证书链，主密钥可以一直离线。
- **面向任意助手的统一 MCP 工具面** —— stdio 与 Streamable HTTP 两种接入，29 个工具（13 记忆 + 16 任务），带 OAuth / bearer 加固与逐工具 scope；CLI 与控制台共用同一份注册表。
- **跨设备 fleet 任务协作** —— 任务是共享记忆里的 DAG（`causedBy`，禁环）：派发、认领、进度、结果与协商（clarify / counter / accept / reject），唯一远程面就是记忆通道，不提供通用远程调用。
- **助手一键接入** —— 7 个内置描述符（OpenChamber、Hermes、OpenCode、Claude Code、Claude Desktop、Cursor、DSH）加自定义片段；统一走探测 → 写入 → 验证三步；桌面应用与星图控制台覆盖首次「建新 / 加入已有」。
- **可带走的设计** —— Canonical Memory Format（CMF）v1，配 Obsidian、日志型端、json-memo、Hermes 适配器；记忆 / 任务两个 Skill 可安装，行为层随数据一起迁移。

[Unreleased]: https://github.com/Windsander/Mebular/compare/v0.1.0...HEAD
[v0.1.0]: https://github.com/Windsander/Mebular/releases/tag/v0.1.0
