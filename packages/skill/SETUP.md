# Mebular 部署手册（给 Agent 执行）

> 面向 **Agent**：本文件是可执行的部署/加入剧本。用户只负责两件事：**说出要做什么**、**转交配对码**。
> 每一步都给出命令与「期望输出 / 判定」。任何一步失败：先按 §6 处置，不要猜、不要跳过。

## 0. 会话内接入（每次会话第一步）

> 目标：**在当前会话里直接拿到 Mebular 的跨设备记忆能力**（MCP 工具面），且**不改动任何既有 memory provider**。
> 顺序：① 幂等检查 → ② 无 home 指回 §3/§5（**不自建身份**）→ ③ 有 home 未在跑则拉起 → ④ 接入当前客户端并验证 → ⑤ 红线。

**0.1 幂等：已装且已在跑就直接用，不要重复安装/重启**

```bash
command -v mebular          # 期望：打印路径；未安装（无输出、exit 1）→ 见 §2
test -f "${MEBULAR_HOME:-$HOME/.mebular}/config.json" && echo "home 存在" || echo "无 home → §3 建新 / §5 加入"
MEBULAR_HOME="${MEBULAR_HOME:-$HOME/.mebular}" mebular status      # 判定见下（exit 0）
```

判定「守护已在跑」：`status` 输出里 **`storeLock` 非 null**（形如 `{"pid":…,"startedAt":…,"storagePath":…}`）→
**直接使用**本机已有实例，不要重复 `install` 或再起 `serve`。

> 注意口径：`status.running` 是 **P2P 节点**状态（`network.enabled=true` 才为 true），**不是**守护进程状态；
> 默认 home 下它常为 `false`，属正常。判定守护进程请用 `storeLock`（或 0.3 的 `service status` / `/healthz`）。

**0.2 无 home：不要在这里自建身份**

`mebular status` 会在 home 不存在时**自举身份材料**（`user-master-key.json`、身份文件）。因此：

- 无 `config.json` → **不要**跑 `status`；按 §3（建新）或 §5（加入）走，**只有用户明确要建新/加入时才创建身份**。
- 已有 home（`config.json` 在）→ 才继续 0.3/0.4。

**0.3 有 home 但未在跑：拉起守护**

优先**常驻**（按 `packages/service` 的平台矩阵：darwin = launchd 用户级 LaunchAgent；linux = `systemd --user`；win32 = 计划任务 onlogon）：

```bash
mebular service status     # 只读：services[0].registered / running
mebular service install    # 常驻 + 自启（不想自启用 --no-autostart）
mebular service status     # 判定：services[0].registered === true 且 running === true
```

若所在环境不支持常驻（无 launchd/systemd/计划任务的容器等），改**前台**拉起：

```bash
MEBULAR_HOME=~/.mebular mebular serve --port 7331     # 期望输出含 SERVE_READY {…}
```

**确认已拉起**（任一即可，判据如下）：

```bash
MEBULAR_HOME=~/.mebular mebular status                                    # 判据：storeLock 非 null
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7331/healthz    # 判据：200
```

> 实测（沙箱 home，`mebular serve --port 0`）：`storeLock` 由 `null` → `{"pid":…,"startedAt":…}`，`/healthz` = `200`；
> 停止后 `storeLock` 回到 `null`。`service install` 会注册**真实**常驻服务，故本沙箱未执行，依据 = `mebular service` 用法 +
> `packages/service/src/units.ts` 平台矩阵 + `service status` 实跑输出。

**0.4 接入当前客户端（MCP 片段）**

```bash
mebular print-config --client <opencode|claude|cursor|dsh|generic>    # 远程形态：追加 --url https://<host>/mcp
```

1. 把输出片段合入**当前客户端**的 MCP 配置（**先备份**原文件）；`dsh` 形态为客户端桥接（只桥接 Tools）。
2. **重载客户端**（重启该客户端/会话）后生效。
3. 验证：在本会话调用 `memory_status` —— 期望返回 `deviceId` / `storeLock` / 计数等字段。
   若「没有 mebular 工具」：片段未生效或未重载客户端，回到第 1–2 步。

> 实测：`MEBULAR_HOME=<沙箱> node packages/mcp/bin/mebular.mjs mcp` 上 `tools/call memory_status` 返回
> `deviceId=device-local`，无 `isError`。

**0.5 红线**

**不改变任何既有 memory provider 的代码、存储与进程**；Mebular 仅以 MCP 工具面**叠加**提供跨设备记忆。
与既有 provider 的分工/导入/冲突口径见 [`MEMORY_POLICY.md`](./MEMORY_POLICY.md) §8。

## 1. 前置检查

```bash
node -v          # 期望：v20 或更高
npm -v
```

判定：`node -v` 输出 `v20+`。否则先让用户安装 Node.js LTS，**不要继续**。

## 2. 安装 CLI（二选一）

**A. 从 GitHub 钉住提交（推荐；可复现）**

```bash
SHA=$(git ls-remote https://github.com/Windsander/Mebular.git refs/heads/main | cut -f1)
npm i -g "github:Windsander/Mebular#$SHA"
command -v mebular && command -v fleet
```

判定：`mebular --help`（exit 0）与 `fleet --version`（exit 0）均可执行；记录 `$SHA` 以便回报。
（`mebular --version` 不存在：会打印「未知命令：--version」并 exit 2。）

**B. 本地仓库（开发者）**

```bash
npm ci && npm run build
npm i -g .
command -v mebular && command -v fleet
```

## 3. 建一个新的 Mebular（本机 = 信任根）

```bash
fleet quickstart --daemon --dir ~/.mebular --device "$(hostname | tr '[:upper:]' '[:lower:]')"
```

- Windows（PowerShell）把家目录写成：`--dir "$env:USERPROFILE\.mebular"`。
- 这一条做了什么：生成本机设备身份 + 守护 home + 加入服务；打印的 JSON 里有 `joinEndpoint` 等字段。

判定：命令退出码 0，且 JSON 含 `"ok": true`。随后自检：

```bash
mebular status           # home 由 MEBULAR_HOME 决定，缺省 ~/.mebular
```

> `mebular status` **没有** `--home` 参数（传了会被忽略）；要指定别的 home 用 `MEBULAR_HOME=<dir> mebular status`。

## 4. 出一个邀请（让别的设备加入你）

```bash
fleet invite --dir ~/.mebular
```

输出含：**二维码**（终端渲染）与**文本令牌**（JSON 的 `token` 字段，也含 `qr`/`qrSvg`）。

**安全红线（必须遵守）**：

- 令牌是**一次性、短时效**（默认 15 分钟）的入网凭证：**只交给用户**，由用户安全转交新设备。
- **不得**把令牌/二维码写入日志、聊天记录、工单或任何外部服务；**不得**回显密钥材料。
- 主密钥**永不离开本机**；邀请过程不复制主密钥。
- 授权默认随令牌生效（作用域 = 令牌分区，**默认 24h 到期自动撤销**，可 `fleet revoke`）。

## 5. 加入一个已有的 Mebular（新设备）

需要用户提供**二维码内容或令牌**（二者等价）：

```bash
fleet join --qr "<二维码内容>" --daemon --dir ~/.mebular --device "$(hostname | tr '[:upper:]' '[:lower:]')"
# 等价写法：fleet join --token <令牌文件或内联> --daemon --dir ~/.mebular --device <本机名>
```

- Windows（PowerShell）：`fleet join --qr "<内容>" --daemon --dir "$env:USERPROFILE\.mebular" --device "$env:COMPUTERNAME"`。
- 一步完成：委派身份（**不复制主密钥**）+ 自动连接 + 按令牌分区自动授权。
- **默认不需要 `fleet approve`**；只有邀请方用了 `--no-grant` 时才需要在其侧人工批准。

判定：退出码 0，JSON 含 `"ok": true`。

## 6. 自检与失败恢复

```bash
mebular doctor --net     # 网络：地址簿 / LAN 发现 / 打洞 / 桥角色 / 下一步建议
mebular status           # 身份 / 存储 / 计数 / 状态哈希
```

常见失败与处置（**不要自行改授权或重置身份**）：

| 症状 | 处置 |
|---|---|
| `MCP_INSECURE_CONFIG`（缺证书 / 非回环组合非法） | 编辑 `~/.mebular/config.json`：把 `mcp.http.host` 改回 `127.0.0.1`，或补齐 `auth` + `tls` + `tlsKey`/`tlsCert`，再重启 `mebular serve` |
| `MCP_STORAGE_LOCKED`（存储已被占用） | 已有实例持锁：复用该实例，或先停掉它再启动 |
| 切换 `auth=bearer/oauth` 后控制台 API 401 | 见控制台「设置 → 诊断 → 恢复指引」；bearer 可粘贴 `mebular token grant --scope memory.read,memory.admin` 的 token 自救；oauth 需 env secret，否则改回 `auth=none`（仅回环） |
| 控制台打不开 | `mebular serve` 是否在跑、日志里是否有上述错误码；再打开 `http://127.0.0.1:7331/console` 的「诊断」页 |
| 加入后连不上对端 | `mebular doctor --net` 看 `next` 建议（LAN 发现 / relay seeds / 白名单） |

更多运维细节见 [`../../packages/fleet/RUNBOOK.md`](../../packages/fleet/RUNBOOK.md)（§6 控制台、§9 桥角色、§7 配对即连）。

## 7. 回报给用户（Agent 输出模板）

```text
部署结果：<新建 | 加入>
设备：<device>
守护 home：<dir>
自检：mebular status = ok，mebular doctor --net 建议：<next 摘要>
下一步：<邀请别人：fleet invite | 在控制台打开 http://127.0.0.1:7331/console>
```

不要输出令牌、二维码或任何密钥材料；它们只属于用户与新设备之间的转交。
