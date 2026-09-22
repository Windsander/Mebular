<div align="center">

![Mebular](assets/banner.svg)

**面向 Agent 的分布式、可验证记忆网络。**

Mebular 把记忆存成一张带签名事件的知识图谱：每条事实都记得自己什么时候有效、由谁写入。
设备之间用向量时钟做增量同步，离线也能用，重连后自动收敛，改过什么都能查。

[![CI](https://github.com/Windsander/Mebular/actions/workflows/ci.yml/badge.svg)](https://github.com/Windsander/Mebular/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=20](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript strict ESM](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[官网](https://mebular.cyberfederal.io) · [为什么](#为什么) · [是什么](#是什么) · [怎么用](#怎么用) · [带来什么](#带来什么) · [文档](#链接与文档) · [English](README.md)

</div>

---

## 为什么

Agent 的记忆大多还躺在单个进程里：一个列表或键值存储，换台设备就断了，被谁改过也说不清，离线直接罢工。

| 问题 | Mebular 的做法 |
|---|---|
| 扁平队列，没有实体与关系 | 图式记忆：实体 / 事实 / 情节 / 技能 / 元数据五类节点，事实带有效期 |
| 写入不可验证 | 每次写入是一条 Ed25519 签名、内容寻址的事件——可审计 |
| 同步依赖中心服务 | 向量时钟增量同步 + 确定性冲突裁决，离线可用 |
| 生态各自为政 | 版本化交换格式 + 适配器（Obsidian、日志型端、json-memo…） |

## 是什么

- **一机 = 一节点 = 一守护。** `mebular serve` 是身份/网络/信任的唯一持有者；fleet 与 Agent 都是本机客户端，共用守护的身份与存储。
- **域（namespace）= 记忆数据通道。** 参与即**数据义务**（收 + 及时同步本地新记忆）；不存在只读参与，域内也不含派发语义。
- **任务 = 树。** 任务是一棵 DAG：root 是派发者，子任务由执行者派生（`causedBy`/`chain`，禁环）。唯一远程面就是记忆通道——不提供通用远程查询/调用。
- **信任 = 链到用户主密钥的证书链。** 任意在册设备都可为新设备签发委派证书（链长有界）；短时效、一次性的加入令牌让新设备**无需复制主密钥**即可入网；吊销会级联到委派证书。

![Mebular 架构图](assets/architecture-cn.svg)

## 怎么用

### Agent 用户

把支持 MCP 的 Agent（Claude / Cursor / OpenCode / DeepSeek Harness）指向守护，用记忆工具
（`memory_write` / `memory_query` / `memory_search` / `memory_status` …）。每个 MCP 工具都有**逐字同名**的
`mebular` 子命令（如 `mebular memory_write`），脚本与 Agent 共用同一表面。

```bash
npm install && npm run build
node packages/skill/scripts/install.mjs        # 安装 Skill（可选）
mebular mcp                                    # 或以 HTTP 常驻：mebular serve
```

### 设备主运维

建一个新的 Mebular —— 这台机器就是信任根：

```bash
fleet quickstart --daemon --dir ~/.mebular --device device-A   # 身份 + 守护 + 加入服务
fleet invite --dir ~/.mebular                                  # 打印二维码 + 令牌
```

新设备加入已有的 Mebular：

```bash
fleet join --qr "<二维码内容>" --daemon --dir ~/.mebular --device device-B   # 也可用 --token
```

这一步就完成了：拿到委派身份（**不复制主密钥**）、自动连上、按令牌分区自动授权（可撤销，默认 24h）。
**默认不需要 `fleet approve`**；只有用 `--no-grant` 签发的邀请才需要再人工批准一次。

### 你能做什么 —— 以及哪些根本不用你管

- **记忆** —— `memory_write`、`memory_query`、`memory_search`、`memory_profile`、`memory_skills`、
  `memory_history`、`memory_graph`、`memory_import`、`memory_status`、`memory_sync`：Agent 走 MCP，
  人用同名 `mebular` 子命令。
- **任务** —— `fleet task_submit` 把活派给其他设备上的 Agent；`task_status`、`task_children`、
  `task_summarize` 跟踪进度。
- **成员与授权** —— `fleet invite`、`fleet grant`、`fleet revoke`、`fleet leave`、`fleet rejoin`。
- **观测** —— `mebular status`、`mebular doctor --net`，以及本机控制台：`mebular serve` 后打开
  `http://127.0.0.1:7331/console`（星图、关于本机、设置、诊断、邀请二维码）。

其余交给 Mebular：LAN 自动发现与地址簿、直连/中继/打洞的自动选择与切换、可达设备自动当桥、地址自动
更新；同步默认常开、断线自动重试；委派证书、令牌过期与授权到期自动清理；服务开机自启与重启自恢复。

唯一需要你物理决定的一件事：两个网络都没有公网入口时，配一台双方都能连到的常开设备——它会自动成为桥。
想先看看界面？用 `seed-demo.mjs` 生成演示数据。

### 开发者

```ts
import { Mebular, HermesMemoryProvider } from 'mebular';
const mebular = new Mebular({ storagePath: './store.jsonl', deviceId: 'device-A', network: { enabled: false } });
await mebular.initialize();
```

可运行示例见 [`examples/quickstart`](examples/quickstart/index.mjs)。fleet 任务树用 `fleet task_submit` 提交 root，
`task_children` / `task_summarize` 遍历与汇总。

## 带来什么

- **本地优先、离线可用**：数据留在你的设备上；重连即收敛。
- **可验证、抗篡改的历史**：签名 + 内容寻址事件，谁改了什么可审计。
- **带时效的图结构**：关系与时间窗，而不只是扁平存储。
- **每台机器一个真正的节点**：一个守护持有身份/网络/信任，Agent 与 fleet 共用、按域分隔。
- **去中心化扩容**：任意在册设备都能邀请；主密钥可保持离线。

## 链接与文档

- **限制与取舍** — [`LIMITATIONS.md`](LIMITATIONS.md)
- **封板契约**（红线 / 协议语义 / 推迟项） — [`SEALING.md`](SEALING.md)
- **fleet 运维手册**（双机操作、WAN 命令、验收） — [`packages/fleet/RUNBOOK.md`](packages/fleet/RUNBOOK.md)
- **Agent 记忆规约** — [`packages/skill/MEMORY_POLICY.md`](packages/skill/MEMORY_POLICY.md)
- **守护 / MCP** — [`packages/mcp`](packages/mcp) · **Fleet** — [`packages/fleet`](packages/fleet)
- **控制台 GUI** — [`packages/console`](packages/console) · **贡献与质量门禁** — [`CONTRIBUTING.md`](CONTRIBUTING.md)

<div align="center">

[官网](https://mebular.cyberfederal.io) · [GitHub](https://github.com/Windsander/Mebular) · © 2026 Windsander · MIT License

</div>
