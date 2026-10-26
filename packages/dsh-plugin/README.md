<div align="center">

![Mebular — 分布式记忆网络](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-plugin-hero.svg)

**一份记忆，每个助手，每台设备。**

面向 AI 助手的分布式记忆网络。记忆和任务留在你的设备上，设备之间直接同步。

[![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://github.com/Windsander/Mebular/blob/main/LICENSE) [![Node.js >=22.19](https://img.shields.io/badge/Node-%E2%89%A522.19-339933?logo=node.js&logoColor=white&style=flat-square)](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART_CN.md) [![MCP server](https://img.shields.io/badge/MCP-server-5A67D8?logo=modelcontextprotocol&logoColor=white&style=flat-square)](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART_CN.md) [![DSH plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE?logo=deepseek&logoColor=white&style=flat-square)](https://awesome-dsh-plugin.com/zh/p/Windsander/Mebular--packages-dsh-plugin/)

[5 分钟开始](https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART_CN.md) · [了解架构](https://github.com/Windsander/Mebular/blob/main/docs/architecture/ARCHITECT.md) · [官网](https://mebular.cyberfederal.io) · [English](https://github.com/Windsander/Mebular/blob/main/packages/dsh-plugin/README_EN.md)

*不需要托管账号 · 没有中心协调者*

</div>

---

<div align="center">

![星空基准视图：未悬停时的设备网络](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/star-map-baseline-cn-420.jpg) ![任务航道与 fleet 事件：蓝色可发出、金色可接收、灰色不可达](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/star-map-lanes-cn-420.jpg)

*静止时的星图：设备与共同订阅关系。 · 悬停时：任务域航道与实时 fleet 流量。蓝线与金线表示本机 ↔ 各设备的任务域双向可达关系，不是设备之间的互连。*

</div>

## DSH 接入

<div align="center">

![一张记忆图：两台机器，每台一个 Mebular 节点；机器 A 连接 DSH、Hermes、Codex，机器 B 连接 Pi、OpenCode、Cursor；两个节点直接同步同一张图。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-memory-mesh-cn.svg)

![DSH 里得到什么：侧边栏共享 Console、官方 MCP 工具、状态点与 attach / managed 生命周期；panel: false 只保留 MCP。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-capabilities-cn.svg)

</div>

## 使用说明

<div align="center">

![三步接入：启动 daemon、安装插件、重启 DSH；Mebular App 继续独立运行。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-quickstart-cn.svg)

</div>

```bash
mebular serve
dsh plugin --profile web add @mebular/dsh-plugin@0.1.2
# 开发安装：dsh plugin --profile web add ./packages/dsh-plugin
# 验证：调用任意 mcp__mebular__* 工具
# 卸载：dsh plugin --profile web remove @mebular/dsh-plugin
```

<div align="center">

![DSH 接入：DSH Web 通过 iframe 加载 /console/?embed=dsh，官方 MCP client 连接同一个 daemon 的 /mcp；发现顺序 daemonUrl → MEBULAR_HTTP_PORT → runtime.json → 7331。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-connection-cn.svg)

![状态点：绿色已连接，琥珀色启动中或降级，红色未运行，灰色等待首次检查。](https://raw.githubusercontent.com/Windsander/Mebular/HEAD/assets/dsh-status-cn.svg)

</div>

## 文档

| 开始 | 理解 | 运维 | 信任 |
| --- | --- | --- | --- |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/getting-started/QUICKSTART_CN.md">快速上手</a></strong> <br><sub>安装与配对</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/architecture/ARCHITECT.md">架构</a></strong> <br><sub>节点与同步</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/console/README.md">控制台</a></strong> <br><sub>本地界面</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/limitations/LIMITATIONS_CN.md">限制</a></strong> <br><sub>敏感数据</sub> |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/packages/skill/SETUP.md">Agent</a></strong> <br><sub>部署规约</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/packages/fleet/RUNBOOK.md">Fleet</a></strong> <br><sub>多机操作</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/operations/RELEASE.md">发布流程</a></strong> <br><sub>发布步骤</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/SEALING_CN.md">封板契约</a></strong> <br><sub>协议红线</sub> |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/CHANGELOG.md">变更日志</a></strong> <br><sub>发布说明</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/CONTRIBUTING.md">参与贡献</a></strong> <br><sub>质量门禁</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/SECURITY.md">安全</a></strong> <br><sub>报告漏洞</sub> | <strong><a href="https://mebular.cyberfederal.io">官网</a></strong> <br><sub>产品站点</sub> |
| <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/integrations/DSH_CN.md">DSH 集成说明</a></strong> <br><sub>完整配置</sub> | <strong><a href="https://github.com/Windsander/Mebular/blob/main/docs/operations/DSH_E2E.md">DSH E2E</a></strong> <br><sub>CI 门禁</sub> | <strong><a href="https://www.npmjs.com/package/@mebular/dsh-plugin">npm</a></strong> <br><sub>包页面</sub> | <strong><a href="https://awesome-dsh-plugin.com/zh/p/Windsander/Mebular--packages-dsh-plugin/">awesome-dsh-plugin</a></strong> <br><sub>插件列表</sub> |

<div align="center">

v0.1.2 · early · MIT · © 2026 Sobert Li

</div>
