<div align="center">

![Mebular](assets/banner.svg)

**面向 AI 助手的分布式记忆网络。**

记忆和任务留在你的设备上。<br>设备直接同步，共用一份图记忆。

[![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node.js >=20](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](docs/getting-started/QUICKSTART_CN.md) [![MCP](https://img.shields.io/badge/MCP-5A67D8)](docs/getting-started/QUICKSTART_CN.md)

[官网](https://mebular.cyberfederal.io) · [快速上手](docs/getting-started/QUICKSTART_CN.md) · [English](README.md)

</div>

---

![Mebular 网络概览：两台机器各跑一个本地节点，为接入的助手同步同一份图记忆](assets/network-overview-cn.svg)

<p align="center"><sub>一台机器一个节点，所有节点共用一份图记忆。</sub></p>

## 是什么

| 本地优先 | 点对点 | 可审计 | MCP |
|---|---|---|---|
| 记忆和任务留在你的设备上，断网也能继续用。 | 设备之间直接同步。不需要托管账号，也没有中心协调者。 | 每次写入都有签名、按内容寻址，历史查得到。 | 已有的助手通过 stdio 或 HTTP 接入。 |

忆云是网络里的一份共享记忆空间，不是托管服务。

## 为什么需要 Mebular

| 常见情况 | Mebular |
|---|---|
| 上下文困在一个助手或一台机器里。 | 接进来的助手读写同一份图记忆。 |
| 同步要账号和托管服务。 | 每台机器跑一个节点，设备之间直接交换记忆。 |
| 说不清谁改了什么。 | 写入有签名，历史可审计。 |

## 开始使用

### 桌面 App

![桌面 App 三步：1 开始部署，2 新建或加入忆云，3 邀请下一台设备](assets/desktop-steps-cn.svg)

**开始部署** → **新建忆云** / **加入忆云** → **邀请设备**。

App 支持 64 位 macOS、Windows 和 Linux。暂时没有你所用平台的安装包？用下面的浏览器或命令行路径。

### 其他路径

| 路径 | 从这里开始 |
|---|---|
| **浏览器** | `npm install -g @mebular/core` → `mebular serve` |
| **命令行** | `fleet quickstart` → `fleet invite` / `fleet join` |
| **Agent** | [装好 Skill](packages/skill/SETUP.md)，然后说“部署 Mebular” |

浏览器、命令行和 Agent 路径需要 Node.js 20 或更高版本。

```bash
npm install -g @mebular/core
mebular serve                                  # 浏览器控制台
fleet quickstart --daemon                      # 命令行启动
mebular print-config --client opencode         # MCP 配置
```

## 你能得到什么

| 你会得到 | 实际效果 |
|---|---|
| **上下文跟着你走** | 用 `memory_write` 写一次，接进来的助手都能用 `memory_query` 召回。 |
| **任务能流动** | `task_submit` 把任务交给另一个助手，进度留在同一条链上。 |
| **历史查得到** | 谁写了哪条事实、什么时候改过、当时什么是真的，都能查。 |
| **记忆带得走** | Canonical Memory Format 和适配器支持 Obsidian、日志和 JSON memo。 |

## 它如何工作

![配对流程：设备 A 新建并发出邀请，设备 B 用二维码加入，随后连接和默认授权自动完成](assets/pairing-flow-cn.svg)

一个二维码或令牌就能让设备入网。主密钥留在根设备；之后每台设备各自同步，中间没有中心协调者。

## 文档

| 从这里开始 | 深入看 |
|---|---|
| [快速上手](docs/getting-started/QUICKSTART_CN.md) | [架构](docs/architecture/ARCHITECT.md) |
| [控制台](docs/console/README.md) | [限制与取舍](docs/limitations/LIMITATIONS_CN.md) |
| [变更日志](CHANGELOG.md) | [Fleet 运维手册](packages/fleet/RUNBOOK.md) |
| [参与贡献](CONTRIBUTING.md) | [Agent Skill](packages/skill/SETUP.md) |
| [发布 SOP](docs/operations/RELEASE.md) | [封板契约](SEALING_CN.md) |

<details>
<summary>谁做什么</summary>

| 谁 | 管什么 |
|---|---|
| **你** | 一次性配对、选择忆云、邀请设备、管理订阅。 |
| **你的助手** | 读写记忆、接手并完成任务。 |
| **Mebular** | 发现与寻址、直连 / 中继 / 打洞、重试、证书、服务自启。 |

</details>

<details>
<summary>在代码里使用</summary>

```ts
import { Mebular } from 'mebular';

const mebular = new Mebular({
  storagePath: './store.jsonl',
  deviceId: 'device-a',
  network: { enabled: false },
});

await mebular.initialize();
```

可运行示例：[`examples/quickstart`](examples/quickstart/index.mjs) 写入并召回一条偏好；[`examples/two-devices`](examples/two-devices/index.mjs) 演示双设备离线同步。

</details>

<div align="center">

[官网](https://mebular.cyberfederal.io) · [GitHub](https://github.com/Windsander/Mebular)

v0.1.0 · early · MIT

</div>
