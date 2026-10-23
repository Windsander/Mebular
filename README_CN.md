<div align="center">

![Mebular](assets/banner.svg)

**面向 AI 助手的分布式记忆网络。**

Mebular 把记忆和任务留在你的设备上，设备之间点对点同步。一份记忆，连接每个助手、每台设备——不需要托管账号，也没有中心协调者。

[![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP: stdio + HTTP](https://img.shields.io/badge/MCP-stdio%20%2B%20HTTP-5A67D8)](docs/getting-started/QUICKSTART_CN.md)

[官网](https://mebular.cyberfederal.io) · [快速上手](docs/getting-started/QUICKSTART_CN.md) · [English](README.md)

</div>

---

## 为什么需要分布式记忆网络

助手的记忆通常只活在一个工具、一个进程里。换一个助手，上下文就断了；换一台机器，记忆就没了。中心服务能把它们连起来，但也多了一个账号、一个依赖和一处必须信任的地方。

| 常见情况 | Mebular |
|---|---|
| 上下文困在一个助手或一台机器里 | 接进来的助手读写同一份图记忆 |
| 一离线就停工 | 照常工作，重连后自动收敛 |
| 同步要账号和托管服务 | 每台机器跑自己的节点，设备之间直接交换记忆 |
| 说不清谁改了什么 | 写入有签名、按内容寻址，历史可审计 |
| 笔记被锁在某个应用里 | 版本化交换格式，提供 Obsidian、日志、JSON memo 适配器 |

## 是什么

Mebular 是面向 AI 助手的分布式记忆网络。每台机器跑一个节点，节点之间直接同步记忆和任务，组成同一份图记忆。

- **网络由你的设备组成。** 每台设备跑一个节点，节点之间直接交换记忆和任务。忆云是网络里的一份共享记忆空间，不是托管服务：第一台设备新建，其余设备加入。
- **本地优先，离线可用。** 记忆和任务历史存在你自己的存储里，断网也能继续用，重连后自动收敛。
- **一台机器一个节点。** `mebular serve` 持有这台机器的身份、存储、同步和 MCP 入口。桌面 App、浏览器控制台、命令行和助手都是这个节点的客户端。
- **记忆是一张图，也有一段历史。** 实体、事实、情节、技能、元数据五类节点，带类型的边，事实可以带有效期。每次写入都是 Ed25519 签名、内容寻址的事件，谁改了什么查得到。
- **助手通过 MCP 接入。** 记忆与任务工具支持 stdio 和 Streamable HTTP，已有的 MCP 客户端可以直接使用，不用换助手。

## 怎么用

有桌面安装包时，桌面 App 是最短路径。浏览器、命令行和 Agent 路径使用同一个本机节点、同一个控制台。

### 桌面 App

1. **拿到 App。** 从 [GitHub Releases](https://github.com/Windsander/Mebular/releases) 下载桌面版并打开。如果暂时没有你所用平台的安装包，先用下面的浏览器或命令行路径；后续步骤不依赖 App。
2. **点「开始部署」。** App 启动本机服务，并接入这台机器上已经装好的 AI 助手。不会上传到托管服务。
3. **新建或加入忆云。** 控制台以锁定状态打开。第一台设备点「新建忆云」，填忆云名和设备名；后续设备点「加入忆云」，粘贴一次性令牌。之后在顶栏点「邀请设备」，接入下一台机器。

第一次运行时，星图只显示这台机器，其它卡片在忆云存在前不可用。新建和加入都在同一进程、同一页面完成：不重启守护、不刷新页面；初始化返回后控制台解锁，顶栏变成「邀请设备」和「加入忆云」。

### 浏览器、命令行与 Agent

这些路径需要 Node.js 20 或更高版本。它们最终都打开同一个控制台：`http://127.0.0.1:7331/console`。

| 路径 | 从这里开始 | 适合 |
|---|---|---|
| **浏览器** | `npm install -g @mebular/core`，再运行 `mebular serve` | 不装桌面 App，用同一个控制台 |
| **命令行** | `fleet quickstart`，然后 `fleet invite` 或 `fleet join` | 脚本化、无图形界面的机器 |
| **Agent** | 装好 Skill，然后说“部署 Mebular”或“用这个码加入” | 让助手代跑安装 |

**浏览器**

```bash
npm install -g @mebular/core
mebular serve   # 打开 http://127.0.0.1:7331/console
```

**命令行**

```bash
fleet quickstart --daemon --dir ~/.mebular --device device-a
fleet invite --dir ~/.mebular
fleet join --qr "<二维码内容>" --daemon --dir ~/.mebular --device device-b
```

**Agent**

```bash
npm install -g @mebular/core
node "$(npm root -g)/@mebular/core/packages/skill/scripts/install.mjs"
```

### 接入助手

打印当前客户端的 MCP 配置，粘进它的 MCP 设置，然后重启客户端：

```bash
mebular print-config --client opencode   # 也支持 claude、cursor、dsh、generic
```

桌面 App 在「开始部署」时会给已接入的助手写入 HTTP `/mcp` 形式；手动接入的 HTTP 客户端可以指向 `http://127.0.0.1:7331/mcp`。

## 你能得到什么

下面这些用的都是同一份图记忆，不管助手跑在这台机器还是另一台。

- **上下文能跨会话。** 用 `memory_write` 写一次偏好，之后任何接进来的助手都能用 `memory_query` 召回。技术栈、习惯、上个月定下的方案，不用再说一遍。
- **任务能在助手之间流动。** `task_submit` 派出的任务，可以由本机或另一台机器上的助手接手；进度、结果和协商都留在同一条链上。
- **历史查得到。** 每次改动都有签名、按内容寻址；谁写了哪条事实、什么时候改过、有效期是什么时候，都能查。
- **数据留在自己手里。** 记忆在你自己的磁盘上，离线也能用，随时可以备份；重连后设备自动收敛。
- **记忆可以带走。** Canonical Memory Format 和适配器可以把记忆带到 Obsidian、日志型应用、JSON memo 和 Hermes。

## 它如何工作

### 配对一次

![配对流程：设备 A 新建并发出邀请，设备 B 用二维码加入，随后连接和默认授权自动完成](assets/pairing-flow-cn.svg)

第一台设备新建忆云。后续设备用二维码或一次性令牌加入，拿到委派证书；主密钥留在根设备。之后每台设备各自同步。

### 一台机器一个节点

![Mebular 架构：一台机器一个守护，助手与 fleet 都是本机客户端](assets/architecture-cn.svg)

每台机器跑一个 `mebular serve`，身份、存储、同步和 MCP 入口都归它管。助手连到这个服务；设备之间直接交换记忆，中间没有中心协调者。

## 开发者与文档

先从[快速上手](docs/getting-started/QUICKSTART_CN.md)开始：桌面、浏览器、命令行、Agent、源码安装、MCP 接入、第二台设备和排错都在里面。

### 谁做什么

| 谁 | 管什么 | 常用命令 |
|---|---|---|
| **你** | 一次性配对、选择忆云、邀请设备、管理订阅 | `fleet invite` · `fleet subscribe` · `fleet join` |
| **你的助手** | 读写记忆、接手并完成任务 | `memory_write` · `task_submit` |
| **Mebular** | 发现与寻址、直连 / 中继 / 打洞、重试、证书、服务自启 | 自动完成 |

唯一需要你判断的网络问题：两个网络都没有公网入口时，留一台常在线、彼此可达的设备当桥。

### 在代码里使用

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

### 文档

- **快速上手** — [桌面、浏览器、命令行、Agent 与源码](docs/getting-started/QUICKSTART_CN.md) · [English](docs/getting-started/QUICKSTART.md)
- **架构** — [运行时分层的信任模型](docs/architecture/ARCHITECT.md)
- **限制与取舍** — [存敏感数据前先看](docs/limitations/LIMITATIONS_CN.md) · [English](docs/limitations/LIMITATIONS.md)
- **控制台** — [本地界面能做什么](docs/console/README.md)
- **变更日志** — [发布说明](CHANGELOG.md)
- **参与贡献** — [质量门禁与参与方式](CONTRIBUTING.md)
- **Fleet 运维手册** — [双机操作与 WAN 排查](packages/fleet/RUNBOOK.md)
- **Agent Skill** — [部署手册](packages/skill/SETUP.md) · [记忆规约](packages/skill/MEMORY_POLICY.md) · [任务手册](packages/skill/tasks/SKILL.md)
- **封板契约** — [协议红线与推迟项](SEALING_CN.md)
- **发布 SOP** — [发布流程](docs/operations/RELEASE.md)

<div align="center">

[官网](https://mebular.cyberfederal.io) · [GitHub](https://github.com/Windsander/Mebular)

v0.1.0 · early · MIT

</div>
