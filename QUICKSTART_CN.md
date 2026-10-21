# Mebular 快速上手（5 分钟）

从零到一个能用记忆的 Agent——再把这份记忆同步到第二台设备。

Mebular 是一个去中心化的记忆网络：一台机器跑一个节点（守护进程），数据只留在你自己的设备上，每次写入都经
Ed25519 签名、内容寻址。没有云、没有协调者。

**前置条件：** Node.js >= 20。用 `node -v` 检查。

## 1. 安装（约 1 分钟）

**A. 从 npm 安装（已发布版本的推荐方式）：**

```bash
npm install -g @mebular/core
command -v mebular && command -v fleet
```

五个 `@mebular/*` 包按 lockstep 同版本发布。`@mebular/core` 是根包，同时提供两个命令：`mebular`
负责守护、MCP 服务与控制台，`fleet` 负责上车、邀请与加入。只装 `@mebular/mcp` 时只有 `mebular`，
没有 `fleet`。

**B. 从 GitHub 钉住提交（从源码构建，可复现）：**

```bash
SHA=$(git ls-remote https://github.com/Windsander/Mebular.git refs/heads/main | cut -f1)
npm i -g "github:Windsander/Mebular#$SHA"
command -v mebular && command -v fleet
```

**C. 从本地仓库（开发者）：**

```bash
git clone https://github.com/Windsander/Mebular.git && cd Mebular
npm ci && npm run build
npm i -g .
command -v mebular && command -v fleet
```

现在你有两个命令：`mebular`（守护、MCP 服务、控制台）与 `fleet`（上车、邀请、加入）。

## 2. 启动，然后新建或加入忆云

一机 = 一节点 = 一守护。守护是身份/网络/信任的唯一持有者；Agent 与 fleet 命令行都是本机客户端，共用它。

**桌面 App：** 打开 App，点「开始部署」。它会启动本机服务、自动接入本机已装的 AI 助手，然后进入
**锁定主控制台**。它**不会**替你新建忆云。

**浏览器：** 同一个控制台也可以由下面的命令提供：

```bash
mebular serve
```

打开 `http://127.0.0.1:7331/console`。家目录为空时控制台处于锁定态：星图可见，其它卡片禁用，顶栏
只有两个入口——**新建忆云** 与 **加入忆云**。

- **第一台设备** —— 「新建忆云」：填忆云名 + 设备名，本机成为根。
- **后续设备** —— 在已加入该忆云的设备上用「邀请设备」拿二维码 / 一次性令牌；新设备点「加入忆云」，
  粘贴令牌并填设备名。新设备拿到委派证书，**不复制主密钥**。

新建 / 加入都在**同一守护进程、同一页面**完成：不重启守护、不刷新页面。初始化返回后控制台立即解锁，
顶栏恢复为「邀请设备」+「加入忆云」。

**命令行等价写法**（脚本化 / 批量；这是另一条路径——桌面向导不会替你选云或建云）：

```bash
fleet quickstart --daemon --dir ~/.mebular --device "$(hostname | tr '[:upper:]' '[:lower:]')"
```

`fleet quickstart` 会准备好本机，并打印给后续设备用的一次性邀请令牌。后续设备用下面的命令加入：

```bash
fleet join --qr "<二维码内容>" --daemon --dir ~/.mebular --device device-B   # 也可用 --token
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
`http://127.0.0.1:7331/mcp`。桌面 App 的自动接入写的就是 HTTP `/mcp` 形态，所以初始化后同一条路径继续
可用，不需要重写助手配置。

未初始化时，`/mcp` 已能完成 `initialize`、`tools/list` 与 `prompts/list`；`tools/call` 返回稳定的
`NOT_INITIALIZED` 业务错误。这是预期行为，不是连接坏了。建新 / 加入忆云后，**同一个 MCP 会话**即可
恢复工具调用——不需要重启守护，也不需要重写配置。

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

GUI：控制台 → **＋ 邀请设备**。

设备 B —— 在 GUI 里进入锁定主控制台，点「加入忆云」，粘贴令牌并填设备名。也可用命令行配合二维码内容
（或 `--token`）加入：

```bash
fleet join --qr "<二维码内容>" --daemon --dir ~/.mebular --device device-B
```

加入后 GUI 在同一进程内立即解锁（不重启、不刷新）。新设备自行声明订阅（零门槛），并立即进行一次同步。
两台设备上的写入在重连后自动收敛——离线优先，无中心服务。

## 6. 自检与排错

```bash
mebular status          # 身份 / 存储 / 计数 / 状态哈希
mebular doctor --net    # 地址簿 / LAN 发现 / NAT / 桥角色 / 下一步建议
```

| 症状 | 处置 |
|---|---|
| 控制台锁定，只有星图 | 首次使用尚未建云：用顶栏「新建忆云」/「加入忆云」。 |
| 点完「开始部署」但没有忆云 | 这是预期：它只启动守护并接入助手，不替你建云；用顶栏两个入口。 |
| MCP 工具调用返回 `NOT_INITIALIZED` | 尚未建新 / 加入忆云：在锁定控制台完成即可；同一会话自动恢复，无需重启。 |
| `MCP_STORAGE_LOCKED` | 已有实例持锁：复用它，或先停掉它。 |
| `MCP_INSECURE_CONFIG` | 改 `~/.mebular/config.json`：把 `mcp.http.host` 改回 `127.0.0.1`，或补齐 `auth` + `tls`。 |
| 切换 `auth` 后控制台 API 返回 401 | 见控制台 → 设置 → 诊断；`bearer` 可在界面自救，`oauth` 需 env secret。 |
| 加入后连不上对端 | 跑 `mebular doctor --net`，按 `next` 建议处理。 |

## 接下来

- **README** —— [中文](README_CN.md) · [English](README.md)
- **变更日志** —— [`CHANGELOG.md`](CHANGELOG.md)
- **发布 SOP** —— [`RELEASE.md`](RELEASE.md)
- **限制与取舍** —— [`LIMITATIONS_CN.md`](LIMITATIONS_CN.md)
- **封板契约** —— [`SEALING_CN.md`](SEALING_CN.md)
- **双机运维** —— [`packages/fleet/RUNBOOK.md`](packages/fleet/RUNBOOK.md)
- **可运行库示例** —— [`examples/quickstart`](examples/quickstart/index.mjs)
