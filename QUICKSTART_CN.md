# Mebular 快速上手（5 分钟）

从零到一个能用记忆的 Agent——再把这份记忆同步到第二台设备。

Mebular 是一个去中心化的记忆网络：一台机器跑一个节点（守护进程），数据只留在你自己的设备上，每次写入都经
Ed25519 签名、内容寻址。没有云、没有协调者。

**前置条件：** Node.js >= 20。用 `node -v` 检查。

## 1. 安装（约 1 分钟）

**A. 从 GitHub 钉住提交（推荐，可复现）：**

```bash
SHA=$(git ls-remote https://github.com/Windsander/Mebular.git refs/heads/main | cut -f1)
npm i -g "github:Windsander/Mebular#$SHA"
command -v mebular && command -v fleet
```

**B. 从本地仓库（开发者）：**

```bash
git clone https://github.com/Windsander/Mebular.git && cd Mebular
npm ci && npm run build
npm i -g .
command -v mebular && command -v fleet
```

现在你有两个命令：`mebular`（守护、MCP 服务、控制台）与 `fleet`（上车、邀请、加入）。

## 2. 创建身份并启动守护

一机 = 一节点 = 一守护。守护是身份/网络/信任的唯一持有者；Agent 与 fleet 命令行都是本机客户端，共用它。

```bash
mebular serve
```

浏览器打开控制台 `http://127.0.0.1:7331/console`。家目录为空时先进入**首次上手页**——点**建新 Mebular**
（root 身份 + 写配置，随后自动重启），全程不需要命令行。

**命令行等价写法**（脚本化/批量），同时会起加入服务：

```bash
fleet quickstart --daemon --dir ~/.mebular --device "$(hostname | tr '[:upper:]' '[:lower:]')"
```

**确认已就绪：**

```bash
mebular status
```

`fleet quickstart` 与 `mebular serve` 共用同一个 home（默认 `~/.mebular`，可用 `MEBULAR_HOME` 覆盖）。
守护持有 store 锁——同一个 home 只跑一个写者。

## 3. 连接 MCP Agent

打印一份可直接粘贴的 MCP 配置：

```bash
mebular print-config --client opencode   # 也可：claude、cursor、dsh、generic
```

把它粘进你的 Agent 的 MCP 配置。本地形态通过 stdio 运行 `mebular mcp`；Streamable HTTP 客户端则可指向
`http://127.0.0.1:7331/mcp`。

可选：把行为层 Skill（记忆规约与工作流）安装到 Agent 的 Skill 目录：

```bash
node packages/skill/scripts/install.mjs
```

## 4. 写入与查询记忆

让你的 Agent 记住一件事。它会调用 `memory_write`，再用 `memory_query` 召回。每次写入都签名并内容寻址，
随时能查出谁改了什么。

同一套 handler 也开放给命令行（agent 中立面），方便冒烟测试：

```bash
mebular memory_write --input '{"items":[{"type":"fact","content":"Ada 偏好深色模式"}]}'
mebular memory_query  --input '{"query":"深色模式"}'
mebular memory_status
```

## 5. 同步第二台设备

配对靠二维码（或令牌）。设备 A 发出邀请，设备 B 加入。**不复制主密钥**——新设备拿到的是委派证书。

设备 A —— 生成邀请（终端二维码 + 文本令牌）：

```bash
fleet invite --dir ~/.mebular
```

GUI：控制台 → **＋ 邀请新设备**。

设备 B —— 用二维码内容（或 `--token`）加入：

```bash
fleet join --qr "<二维码内容>" --daemon --dir ~/.mebular --device device-B
```

加入后授权自动生效（作用域 = 令牌分区，默认 24h 到期，可撤销），并立即进行一次同步。两台设备上的写入在
重连后自动收敛——离线优先，无中心服务。

## 6. 自检与排错

```bash
mebular status          # 身份 / 存储 / 计数 / 状态哈希
mebular doctor --net    # 地址簿 / LAN 发现 / NAT / 桥角色 / 下一步建议
```

| 症状 | 处置 |
|---|---|
| `MCP_STORAGE_LOCKED` | 已有实例持锁：复用它，或先停掉它。 |
| `MCP_INSECURE_CONFIG` | 改 `~/.mebular/config.json`：把 `mcp.http.host` 改回 `127.0.0.1`，或补齐 `auth` + `tls`。 |
| 切换 `auth` 后控制台 API 返回 401 | 见控制台 → 设置 → 诊断；`bearer` 可在界面自救，`oauth` 需 env secret。 |
| 加入后连不上对端 | 跑 `mebular doctor --net`，按 `next` 建议处理。 |

## 接下来

- **README** —— [中文](README_CN.md) · [English](README.md)
- **限制与取舍** —— [`LIMITATIONS_CN.md`](LIMITATIONS_CN.md)
- **封板契约** —— [`SEALING_CN.md`](SEALING_CN.md)
- **双机运维** —— [`packages/fleet/RUNBOOK.md`](packages/fleet/RUNBOOK.md)
- **可运行库示例** —— [`examples/quickstart`](examples/quickstart/index.mjs)
