<div align="center">

![Mebular — 分布式记忆网络](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-hero.svg)

**一份记忆，每个助手，每台设备。**

面向 AI 助手的分布式记忆网络。记忆和任务留在你的设备上，设备之间直接同步。

[![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Windsander/Mebular/blob/main/LICENSE) [![Node.js >=22.19](https://img.shields.io/badge/Node-%E2%89%A522.19-339933?logo=node.js&logoColor=white&style=flat-square)](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART_CN.md) [![MCP server](https://img.shields.io/badge/MCP-server-5A67D8?logo=modelcontextprotocol&logoColor=white&style=flat-square)](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART_CN.md) [![DSH plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE?logo=deepseek&logoColor=white&style=flat-square)](https://awesome-dsh-plugin.com/zh/p/Windsander/Mebular--packages-dsh-plugin/)

[5 分钟开始](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART_CN.md) · [了解架构](https://github.com/Windsander/Mebular/blob/main/docs/architecture/ARCHITECT.md) · [官网](https://mebular.cyberfederal.io) · [English](https://github.com/Windsander/Mebular/blob/main/packages/dsh-plugin/README_EN.md)

*不需要托管账号 · 没有中心协调者*

App 与 DSH Plugin 是同一套本机 Mebular runtime 的两个入口。插件默认 `attach`，
不会因安装而静默启动或下载；已有 App/CLI 时直接连接。没有 runtime 时，面板会先询问，
再按需安装固定版本共享 runtime。

</div>

---

<div align="center">

![星空基准视图：未悬停时的设备网络](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/star-map-baseline-cn-420.jpg) ![任务航道与 fleet 事件：蓝色可发出、金色可接收、灰色不可达](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/star-map-lanes-cn-420.jpg)

*静止时的星图：设备与共同订阅关系。 · 悬停时：任务域航道与实时 fleet 流量。蓝线与金线表示本机 ↔ 各设备的任务域双向可达关系，不是设备之间的互连。*

</div>

<table width="100%">
  <tr>
    <td width="25%"><img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-demo-cn-normal.jpg" alt="完整深色 DeepSeek Harness 界面：侧栏 Mebular 入口、面板 header 与内嵌星图" width="100%"><br><sub>完整 DSH 面板 · 入口与星图</sub></td>
    <td width="25%"><img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-demo-cn-collapsed.jpg" alt="深色 DeepSeek Harness 侧栏折叠后，Mebular Console 全宽显示" width="100%"><br><sub>折叠侧栏 · Console 全宽</sub></td>
    <td width="25%"><img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-demo-cn-memories.jpg" alt="深色 DeepSeek Harness 中的 Mebular 共享记忆视图" width="100%"><br><sub>共享记忆视图</sub></td>
    <td width="25%"><img src="https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-demo-cn-settings.jpg" alt="深色 DeepSeek Harness 中的 Mebular 设置视图（演示数据）" width="100%"><br><sub>设置与常驻配置</sub></td>
  </tr>
</table>

## DSH 接入

<div align="center">

![一张记忆图：两台机器，每台一个 Mebular 节点；机器 A 连接 DSH、Hermes、Codex，机器 B 连接 Pi、OpenCode、Cursor；两个节点直接同步同一张图。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-memory-mesh-cn.svg)

![DSH 里得到什么：侧边栏共享 Console、官方 MCP 工具、状态点、attach / managed / auto 生命周期与按需安装更新；panel: false 只保留 MCP。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-capabilities-cn.svg)

</div>

## 使用说明

<div align="center">

![三步接入：安装插件、重启 DSH；已有 App/CLI 自动连接，没有 runtime 时面板显式安装共享 runtime。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-quickstart-cn.svg)

![DSH 接入：DSH Web 通过 iframe 加载 /console/?embed=dsh，官方 MCP client 连接同一个 daemon 的 /mcp；通过共享 runtime resolve 解析 App/CLI/shared provider 与动态 URL。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-connection-cn.svg)

![状态点：绿色已连接，琥珀色启动/安装/更新中，红色未运行，灰色等待首次检查。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-status-cn.svg)

</div>

已有 Mebular App 或 CLI 时，插件会自动连接；没有 runtime 时，打开 Mebular 面板按提示安装共享 runtime。只有 CLI 方式需要手动 `mebular serve`。

<details>
<summary>命令行：安装 / 开发安装 / 卸载</summary>

```bash
# 安装插件（不会静默启动或下载 Mebular）
dsh plugin --profile web add @mebular/dsh-plugin@0.2.4

# 开发安装
dsh plugin --profile web add ./packages/dsh-plugin

# 验证：在 DSH 中调用任意 mcp__mebular__* 工具
# 卸载
dsh plugin --profile web remove @mebular/dsh-plugin
```

</details>

## MCP 工具

DSH 通过官方 MCP client 连接同一个 daemon 的 `/mcp`；工具在 DSH 里显示为 `mcp__mebular__*`。

| 能力 | 工具 | MCP 说明 |
| --- | --- | --- |
| 记忆写入 | `memory_write` `memory_write_batch` | 写入单条/批量事实、偏好、情节与技能；写入即签名并参与同步 |
| 记忆召回 | `memory_query` `memory_search` `memory_graph` | 语义/关键词召回、图遍历；可按时间与关系过滤 |
| 画像与历史 | `memory_profile` `memory_skills` `memory_history` | 读取用户偏好、技能清单与会话情节 |
| 记忆维护 | `memory_import` `memory_status` `memory_sync` `memory_delete` `memory_archive` | 导入、状态、同步、墓碑删除、归档/解除归档 |
| 任务派发 | `task_submit` `task_submit_batch` `task_cancel` `task_retry` `task_status` `task_list` `task_history` `task_children` `task_summarize` | 派发、取消、重试与查询任务 DAG |
| 协作协商 | `task_subscribe` `task_negotiate` `chatter_send` `chatter_inbox` `task_quota` `task_targets` `board_create` | 变更订阅、协商、配额闲聊、目标与任务板 |

## 文档

| 开始 | 理解 | 运维 | 信任 |
| --- | --- | --- | --- |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART_CN.md">快速上手</a></strong> <br><sub>安装与配对</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/architecture/ARCHITECT.md">架构</a></strong> <br><sub>节点与同步</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/console/README.md">控制台</a></strong> <br><sub>本地界面</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/limitations/LIMITATIONS_CN.md">限制</a></strong> <br><sub>敏感数据</sub> |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/packages/skill/SETUP.md">Agent</a></strong> <br><sub>部署规约</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/packages/fleet/RUNBOOK.md">Fleet</a></strong> <br><sub>多机操作</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/operations/SHARED_RUNTIME.md">共享 runtime</a></strong> <br><sub>安装、升级与回滚</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/SEALING_CN.md">封板契约</a></strong> <br><sub>协议红线</sub> |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/CHANGELOG.md">变更日志</a></strong> <br><sub>发布说明</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/CONTRIBUTING.md">参与贡献</a></strong> <br><sub>质量门禁</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/SECURITY.md">安全</a></strong> <br><sub>报告漏洞</sub> | <strong><a href="https://mebular.cyberfederal.io">官网</a></strong> <br><sub>产品站点</sub> |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH_CN.md">DSH 集成说明</a></strong> <br><sub>完整配置</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/operations/DSH_E2E.md">DSH E2E</a></strong> <br><sub>CI 门禁</sub> | <strong><a href="https://www.npmjs.com/package/@mebular/dsh-plugin">npm</a></strong> <br><sub>包页面</sub> | <strong><a href="https://awesome-dsh-plugin.com/zh/p/Windsander/Mebular--packages-dsh-plugin/">awesome-dsh-plugin</a></strong> <br><sub>插件列表</sub> |

<details>
<summary>兼容发现</summary>

| 场景 | 解析方式 |
| --- | --- |
| 共享 runtime 可用 | 优先使用共享 runtime resolve（App / CLI / shared provider + 动态 URL） |
| 没有共享 CLI 的旧环境 | `daemonUrl > MEBULAR_HTTP_PORT > runtime.json > 7331` |
| `MEBULAR_HOME` | 只用于定位 `runtime.json` |
| Mebular App | 继续独立运行；插件只连接同一个 daemon |

</details>

<div align="center">

v0.2.4 · early · MIT · © 2026 Sobert Li

</div>
