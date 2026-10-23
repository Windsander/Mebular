<div align="center">

![Mebular](assets/banner.svg)

**一份记忆，每个助手，每台设备。**

面向 AI 助手的分布式记忆网络。<br>
记忆和任务留在你的设备上，设备之间直接同步。

[![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg?style=flat-square)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE) [![Node.js >=20](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white&style=flat-square)](docs/getting-started/QUICKSTART_CN.md) [![MCP](https://img.shields.io/badge/MCP-5A67D8?style=flat-square)](docs/getting-started/QUICKSTART_CN.md)

[5 分钟开始](docs/getting-started/QUICKSTART_CN.md) · [了解架构](docs/architecture/ARCHITECT.md) · [官网](https://mebular.cyberfederal.io) · [English](README.md)

<sub>不需要托管账号 · 没有中心协调者</sub>

</div>

---

<p align="center">
  <img src="assets/star-map-baseline-cn.jpg" width="49%" alt="星空基准视图：未悬停时的设备网络">
  <img src="assets/star-map-lanes-cn.jpg" width="49%" alt="任务航道与 fleet 事件：蓝色可发出、金色可接收、灰色不可达">
</p>
<p align="center"><sub>静止时的星图：设备与共同订阅关系。 · 悬停时：任务域航道与实时 fleet 流量。<br>蓝线与金线表示本机 ↔ 各设备的任务域双向可达关系，不是设备之间的互连。</sub></p>

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

<table width="100%">
  <thead>
    <tr>
      <th align="left">路径</th>
      <th align="left">从这里开始</th>
      <th align="left">适合</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>浏览器</strong></td>
      <td><code>npm install -g @mebular/core</code> → <code>mebular serve</code></td>
      <td>不装 App，用同一个控制台</td>
    </tr>
    <tr>
      <td><strong>命令行</strong></td>
      <td><code>fleet quickstart</code> → <code>fleet invite</code> / <code>fleet join</code></td>
      <td>脚本化、无图形界面的机器</td>
    </tr>
    <tr>
      <td><strong>Agent</strong></td>
      <td><a href="packages/skill/SETUP.md">装好 Skill</a>，然后说“部署 Mebular”</td>
      <td>让助手代跑安装</td>
    </tr>
  </tbody>
</table>

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

![Mebular 网络概览：两台机器各跑一个本地节点，为接入的助手同步同一份图记忆](assets/network-overview-cn.svg)

<p align="center"><sub>一台机器一个节点，所有节点共用一份图记忆。</sub></p>

每台机器跑一个节点，节点之间直接同步记忆和任务。加设备只需要一个二维码或令牌——主密钥留在根设备。

![配对流程：设备 A 新建并发出邀请，设备 B 用二维码加入，随后连接和默认授权自动完成](assets/pairing-flow-cn.svg)

## 文档

<table width="100%">
  <thead>
    <tr>
      <th align="left">从这里开始</th>
      <th align="left">深入看</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong><a href="docs/getting-started/QUICKSTART_CN.md">快速上手</a></strong><br><sub>安装、配对、同步第二台设备</sub></td>
      <td><strong><a href="docs/architecture/ARCHITECT.md">架构</a></strong><br><sub>节点、同步与信任边界</sub></td>
    </tr>
    <tr>
      <td><strong><a href="docs/console/README.md">控制台</a></strong><br><sub>本地界面与页面地图</sub></td>
      <td><strong><a href="docs/limitations/LIMITATIONS_CN.md">限制与取舍</a></strong><br><sub>存敏感数据前先读</sub></td>
    </tr>
    <tr>
      <td><strong><a href="CHANGELOG.md">变更日志</a></strong><br><sub>发布说明</sub></td>
      <td><strong><a href="packages/fleet/RUNBOOK.md">Fleet 运维手册</a></strong><br><sub>双机操作与 WAN 排查</sub></td>
    </tr>
    <tr>
      <td><strong><a href="CONTRIBUTING.md">参与贡献</a></strong><br><sub>质量门禁与参与方式</sub></td>
      <td><strong><a href="packages/skill/SETUP.md">Agent Skill</a></strong><br><sub>部署、记忆规约、任务手册</sub></td>
    </tr>
    <tr>
      <td><strong><a href="docs/operations/RELEASE.md">发布 SOP</a></strong><br><sub>发布流程</sub></td>
      <td><strong><a href="SEALING_CN.md">封板契约</a></strong><br><sub>协议红线与推迟项</sub></td>
    </tr>
  </tbody>
</table>

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

v0.1.0 · early · MIT

</div>
