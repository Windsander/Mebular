# 在 DSH 中使用 Mebular

**一张记忆图，连接每个 Agent、每台机器。**

Mebular 是 Agent 与设备之间的记忆与任务互通层；`@mebular/dsh-plugin` 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）接入同一张图：侧边栏复用共享 Console，官方 MCP client 连接同一个 daemon。

[![npm](https://img.shields.io/npm/v/@mebular/dsh-plugin?style=flat-square)](https://www.npmjs.com/package/@mebular/dsh-plugin) [![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.2-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness) [![Node](https://img.shields.io/badge/Node-%E2%89%A522.19-339933?logo=node.js&logoColor=white&style=flat-square)](https://nodejs.org) [![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Windsander/Mebular/blob/main/LICENSE) [![awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-memory-4D6BFE?style=flat-square)](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/)

[English](https://github.com/Windsander/Mebular/blob/main/packages/dsh-plugin/README_EN.md) · [npm](https://www.npmjs.com/package/@mebular/dsh-plugin) · [主 README](https://github.com/Windsander/Mebular/blob/main/README_CN.md) · [集成说明](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH_CN.md)

![一张记忆图：两台机器，每台一个 Mebular 节点；机器 A 连接 DSH、Hermes、Codex，机器 B 连接 Pi、OpenCode、Cursor；两个节点直接同步同一张图。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-memory-mesh-cn.svg)

*不同 Agent、不同机器，共享同一张图。DSH 是其中一个壳；图中其他 Agent 仅作示意，本文只覆盖 DSH。*

> **叠加，不替代。** DSH 的本机记忆 provider（如 Mem0）继续负责单机上下文；Mebular 在其上增加跨设备、跨 Agent 的共享图。

## 这个插件为 DSH 增加什么

| 能力 | 说明 |
| --- | --- |
| 共享 Console | 侧边栏加载同一个 Mebular Console（`?embed=dsh`，仅 loopback），不是第二套 UI。 |
| 官方 MCP 工具 | 官方 `@deepseek-ai/dsh-mcp-client` 连接 `/mcp`，工具名为 `mcp__mebular__*`。 |
| 状态点 | 绿 / 琥珀 / 红 / 灰；daemon 非 `up` 时用 `mebular:status` 提示 Agent 如何恢复。 |
| `attach` / `managed` | 默认只探测已有 daemon；`managed` 才启动插件托管的 `mebular serve` 子进程。 |
| 零构建、零依赖 | 不 import 任何 `@mebular/*`，不读 store、token 或 `~/.mebular/config.json`。 |

## 快速开始

**前提**：Node `>=22.19` · DSH `>=0.2.1-rc.2 <0.3.0` · 运行中的 Mebular daemon

**1. 启动 daemon**

```bash
mebular serve
curl -sS http://127.0.0.1:7331/healthz
```

**2. 安装插件**

```bash
dsh plugin --profile web add @mebular/dsh-plugin@0.1.2
```

开发安装：`dsh plugin --profile web add ./packages/dsh-plugin`

**3. 重启 DSH Web**：侧边栏出现 Mebular 图标；打开面板确认 Console，调用任意 `mcp__mebular__*` 工具能返回数据即接通。

> Mebular App 继续独立运行；插件只接入，不会停止或替换它。

## 它如何连接

![DSH 接入：DSH Web 通过 iframe 加载 /console/?embed=dsh，官方 MCP client 连接同一个 daemon 的 /mcp。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-connection-cn.svg)

*一个 daemon，一套 Console，两个壳。*

插件只在 daemon 健康时挂载官方 peer，并让 iframe 指向同一个 origin；面板、`/mebular/embed-info` 与 MCP 工具共用一个解析结果，不会出现“面板连 7332、工具连 7331”。

| 端点 | 用途 |
| --- | --- |
| `/healthz` | daemon 健康检查 |
| `/app/embed/info` | Console 可嵌入性 |
| `/console/?embed=dsh` | DSH 侧边栏 iframe |
| `/mcp` | 官方 MCP client 的 Streamable HTTP 端点 |
| `/mebular/embed-info` | 面板只读状态（仅 loopback） |

## 配置

```yaml
# 默认：一条 host row
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: attach
    panel: true
# 只保留 MCP，不显示面板：panel: false
# 托管 daemon：
# lifecycle: managed
# cliPath: /absolute/path/to/mebular
```

**daemon 发现顺序**

| 顺序 | 来源 |
| --- | --- |
| 1 | 显式 `daemonUrl`（拒绝含凭据的 URL） |
| 2 | `MEBULAR_HTTP_PORT`（有效端口 1–65535） |
| 3 | `<home>/runtime.json`（`pid` 已不存在则视为 stale 并跳过） |
| 4 | `http://127.0.0.1:7331` |

`<home>` = `MEBULAR_HOME`，缺省 `~/.mebular`。host 只读取 `runtime.json` 中的 `version`、`pid`、`http.*`、`consolePath`、`mcpPath`、`embedProtocol`。

**字段**

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `daemonUrl` | `http://127.0.0.1:7331` | 只接受 `http:` / `https:`，尾部斜杠会被去掉 |
| `lifecycle` | `attach` | `attach` 只探测；`managed` 在无 daemon 时启动子进程 |
| `panel` | `true` | `false` 时不注册 sidebar / main 面板，MCP 工具照常可用 |
| `cliPath` | 未设置 | 仅 `managed` 使用；也接受 `MEBULAR_CLI`，最后回退到 `PATH` |

非法值会回退安全默认并写一条 `warn`，不会让 DSH 启动失败；`panel: false` 时 `/mebular/embed-info` 与 MCP bridge 仍运行。`managed` 的完整生命周期、信号与日志脱敏见[集成说明](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH_CN.md#生命周期attach-或-managed)。

**环境变量**

| 变量 | 作用 |
| --- | --- |
| `MEBULAR_HTTP_PORT` | 覆盖 daemon 端口；host、面板、MCP 桥一起跟随 |
| `MEBULAR_HOME` | 定位 `runtime.json`；缺省 `~/.mebular` |
| `MEBULAR_CLI` | `managed` 的 CLI 候选（`cliPath` 优先） |
| `DSH_HOME` | DSH profile 根；与 Mebular home 无关 |

## 验证与排障

**检查 profile**

```bash
dsh --profile web --dump-config | grep -A6 mebular   # 应只有 mebular host row，无静态 MCP row / 写死 URL
```

**状态点**

| 颜色 | 含义 |
| --- | --- |
| 绿 | daemon 已连接，记忆/任务工具可用 |
| 琥珀 | daemon 正在启动，或处于降级状态 |
| 红 | daemon 未运行 / 不可达 |
| 灰 | 首次检查尚未返回 |

**只读状态**

```bash
curl -sS http://127.0.0.1:7331/app/embed/info
curl -sS http://127.0.0.1:<dsh-port>/mebular/embed-info
```

返回 `status`、`mode`、`managed`、`panel`、`version`、`embedProtocol`、`consoleUrl`、`embedUrl`、`mcpUrl`、`loopback`、`reason`；完整 JSON 契约见[集成说明](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH_CN.md#mebularembed-info-状态契约)。

**常见 reason**

| reason | 处理 |
| --- | --- |
| `daemon_unreachable` | 启动 Mebular App 或 `mebular serve`；检查 `7331` |
| `daemon_unhealthy` | 检查 `/healthz`、端口和 daemon 日志 |
| `embed_info_unavailable` | 检查 daemon 版本与 `/app/embed/info` |
| `not_loopback` / `embed_unsupported` | 面板只支持 loopback；在本地 DSH 使用 |
| `managed_cli_missing` | 安装 Mebular CLI，或设置 `cliPath` / `MEBULAR_CLI` |
| `managed_start_failed` | 查看 DSH 日志中脱敏后的 managed child stderr |
| `peer_missing` | 确认 DSH 提供 `@deepseek-ai/dsh-mcp-client` peer |

**卸载**：`dsh plugin --profile web remove @mebular/dsh-plugin`；只移除插件，daemon 与 Console 不受影响。

## 安全与限制

- **仅 loopback**：`/mebular/embed-info` 只接受 loopback 请求，其他来源 `404`；响应不含 token、密钥、home/CLI 路径或进程环境。
- **iframe 门禁**：sandbox 为 `allow-scripts allow-same-origin allow-forms`，不授予 top navigation；daemon、loopback、embed protocol 与 `capabilities.embedConsole` 全部满足才创建。
- **不碰数据**：不打开 `store.jsonl`、不读 token、不写 `~/.mebular`；managed child 的 stdout/stderr 先脱敏再进 DSH 日志。
- **默认 attach**：不启动、不停止 Mebular；只有显式 `lifecycle: managed` 才会启动子进程。
- **MCP peer 由 DSH 提供**：`@deepseek-ai/dsh-mcp-client` 是 peerDependency；缺失时工具不可用，面板不受影响。
- **跨 home 需显式配置**：DSH 与 daemon 的 `MEBULAR_HOME` 不同时，自动发现不会命中，请设 `daemonUrl` 或 `MEBULAR_HTTP_PORT`。
- **DSH preview API**：`panel` 开关依赖 `webServer.tapIndex`；DSH 升级后重新验证 `sidebar.panellist` 与 `main` keyed slot。
- **卸载残留**：pnpm 可能留下 `node_modules/@mebular/dsh-plugin` 符号链接，但不在 profile bundles 中，不会被加载。

完整安全说明见 [SECURITY.md](https://github.com/Windsander/Mebular/blob/main/SECURITY.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [主 README](https://github.com/Windsander/Mebular/blob/main/README_CN.md) | 产品总览、桌面 App、CLI、配对 |
| [DSH 集成说明](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH_CN.md) | 完整接入、JSON 契约、架构、开发与发布 |
| [npm](https://www.npmjs.com/package/@mebular/dsh-plugin) | 包页面与版本 |
| [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/) | 插件列表 `memory` 分类 |
| [Release SOP](https://github.com/Windsander/Mebular/blob/main/docs/operations/RELEASE.md) | 发布流程与版本约束 |
| [SECURITY.md](https://github.com/Windsander/Mebular/blob/main/SECURITY.md) | 漏洞报告 |

---

v0.1.2 · MIT · © 2026 Sobert Li
