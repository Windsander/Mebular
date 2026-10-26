<div align="center">

![Mebular — 分布式记忆网络](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-hero.svg)

**一份记忆，每个助手，每台设备。**

面向 AI 助手的分布式记忆网络。记忆和任务留在你的设备上，设备之间直接同步。

[![npm](https://img.shields.io/npm/v/@mebular/dsh-plugin?style=flat-square)](https://www.npmjs.com/package/@mebular/dsh-plugin) [![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.1--rc.2-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness) [![Node](https://img.shields.io/badge/Node-%E2%89%A522.19-339933?logo=node.js&logoColor=white&style=flat-square)](https://nodejs.org) [![MCP server](https://img.shields.io/badge/MCP-server-5A67D8?logo=modelcontextprotocol&logoColor=white&style=flat-square)](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH_CN.md) [![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Windsander/Mebular/blob/main/LICENSE) [![awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-memory-4D6BFE?style=flat-square)](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/)

[5 分钟开始](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART_CN.md) · [了解架构](https://github.com/Windsander/Mebular/blob/main/docs/architecture/ARCHITECT.md) · [官网](https://mebular.cyberfederal.io) · [English](https://github.com/Windsander/Mebular/blob/main/packages/dsh-plugin/README_EN.md)

*不需要托管账号 · 没有中心协调者*

</div>

---

<div align="center">

![星图示例：静止时的设备网络与悬停时的任务航道](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-starmap-cn.jpg)

*静止时的星图：设备与共同订阅关系。 · 悬停时：任务域航道与实时 fleet 流量。蓝线与金线表示本机 ↔ 各设备的任务域双向可达关系，不是设备之间的互连。*

</div>

## 在 DSH 中使用 Mebular

Mebular 是 Agent 与设备之间的记忆与任务互通层；`@mebular/dsh-plugin` 把 DSH 接入同一张图。

[npm](https://www.npmjs.com/package/@mebular/dsh-plugin) · [主 README](https://github.com/Windsander/Mebular/blob/main/README_CN.md) · [集成说明](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH_CN.md)

![一张记忆图：两台机器，每台一个 Mebular 节点；机器 A 连接 DSH、Hermes、Codex，机器 B 连接 Pi、OpenCode、Cursor；两个节点直接同步同一张图。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-memory-mesh-cn.svg)

*不同 Agent、不同机器，共享同一张图。DSH 是其中一个壳；图中其他 Agent 仅作示意，本文只覆盖 DSH。*

> **叠加，不替代。** 本机记忆 provider 继续工作；Mebular 只增加跨设备、跨 Agent 的共享图。

## DSH 里得到什么

![DSH 里得到什么：侧边栏共享 Console、官方 MCP 工具、状态点与 attach / managed 生命周期。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-capabilities-cn.svg)

共享 Console、官方 MCP 工具、状态与生命周期，一次接入。

## 三步接入

![三步接入：启动 daemon、安装插件、重启 DSH。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-quickstart-cn.svg)

**前提**：Node `>=22.19` · DSH `>=0.2.1-rc.2 <0.3.0` · 本机已有 Mebular App 或 Mebular CLI（`@mebular/core`）

```bash
mebular serve                                            # 1. 没有 App 时启动 daemon；默认 :7331
dsh plugin --profile web add @mebular/dsh-plugin@0.1.2   # 2. 安装
# 3. 重启 DSH Web，打开 Mebular 面板；调用任意 mcp__mebular__* 工具验证
```

插件不安装 daemon/Console，默认 `attach` 只探测，安装不会自动启动 daemon；`managed` 模式下才会代启动。daemon 已运行但未初始化时，面板会显示与 App 相同的创建/加入忆云引导。Mebular App 继续独立运行；开发安装：`dsh plugin --profile web add ./packages/dsh-plugin`。

## 它如何连接

![DSH 接入：DSH Web 通过 iframe 加载 /console/?embed=dsh，官方 MCP client 连接同一个 daemon 的 /mcp。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-connection-cn.svg)

*一个 daemon，一套 Console，两个壳。*

`daemonUrl` → `MEBULAR_HTTP_PORT` → `runtime.json` → `7331`；面板、`/mebular/embed-info` 与 MCP 工具始终指向同一个 origin。

## 配置

```yaml
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: attach
    panel: true
# panel: false 只保留 MCP
# lifecycle: managed 时托管 daemon
```

字段、环境变量、managed 细节与 endpoint 列表见[集成说明](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH_CN.md)。

## 排障

![状态点：绿色已连接，琥珀色启动中或降级，红色未运行，灰色等待首次检查。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-status-cn.svg)

- `daemon_unreachable` → 启动 Mebular App 或 `mebular serve`
- `managed_cli_missing` → 设置 `cliPath` / `MEBULAR_CLI`
- `peer_missing` → 确认 DSH 提供官方 MCP peer
- 完整 reason 列表见[集成说明](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH_CN.md)

## 安全与限制

- 仅 loopback 可嵌入；`/mebular/embed-info` 只接受 loopback。
- 不读 store/token，不写 `~/.mebular`；managed child 日志脱敏。
- 默认 `attach` 不启动/停止 Mebular；只有 `lifecycle: managed` 才启动子进程。
- `@deepseek-ai/dsh-mcp-client` 是 DSH 提供的 peer；跨 home 需显式配置 `daemonUrl` 或 `MEBULAR_HTTP_PORT`。

## 文档

[主 README](https://github.com/Windsander/Mebular/blob/main/README_CN.md) · [集成说明](https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH_CN.md) · [DSH E2E](https://github.com/Windsander/Mebular/blob/main/docs/operations/DSH_E2E.md) · [npm](https://www.npmjs.com/package/@mebular/dsh-plugin) · [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/) · [SECURITY](https://github.com/Windsander/Mebular/blob/main/SECURITY.md)

---

v0.1.2 · MIT · 卸载：`dsh plugin --profile web remove @mebular/dsh-plugin`
