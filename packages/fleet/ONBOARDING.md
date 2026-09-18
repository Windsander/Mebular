# 设备上车（Step 1b）：≤15 分钟把第二台设备加入舰队

> 目标：不 clone、不手写配置，在一台新机器上用**一条 `fleet onboard`** 接入，并用 `fleet doctor`
> 自证「可达、已授权、已收敛」。传输/隐私语义见仓库根 [`SEALING.md`](../../SEALING.md)；
> 双机任务板/执行端的完整叙事见 [`RUNBOOK.md`](./RUNBOOK.md)（本文件是它的「上车」前置）。

## 0. 前置

- Node.js **>= 20**（`node -v`）。
- 两台机器可互相 TCP 可达（同一 LAN 即可；跨 NAT 见 RUNBOOK §3）。
- 信任根 = **同一把用户主密钥**：所有共享它的设备同属一个用户。新设备必须**导入**已有设备的主密钥，否则设备证书互不信任、握手失败、永不收敛。

## 1. 安装（DTO）

版本钉死到某个 commit，安装即构建（无需 clone、无需发布 npm）：

```bash
# 机器 A、B 都执行；<SHA> 用目标提交（例如 981ea04…）
npm i -g github:Windsander/Mebular#<SHA>
fleet --version
# 期望：@mebular/fleet 0.1.0 (<SHA>)
```

`fleet --version` 打印的 SHA 就是本次构建的提交，用于确认两端跑的是同一版本。
（非全局安装时用 `npx fleet …`；`prepare` 脚本会在 git 安装时自动 `npm run build`。）

## 2. 机器 A：建根 + 上车

```bash
fleet onboard --dir ~/.fleet \
  --device device-A \
  --peer-device device-B \
  --agent echo:echo
```

- 生成 `~/.fleet/master-key.json`（**信任根**，0600）、`~/.fleet/fleet.config.json`（0600）与设备身份文件。
- 输出 JSON 含 `masterKeyFingerprint`（`sha256:<12hex>`，**不是**密钥材料）与 `next` 提示。
- **把 `~/.fleet/master-key.json` 通过安全通道（scp/密钥管理）分发给机器 B**。

启动（`--submit` 派 N 个任务给 B 的 `echo` agent；等待首轮同步后再提交）：

```bash
fleet serve --dir ~/.fleet \
  --submit 5 --target-agent echo \
  --expect-prefix ECHO: \
  --wait-sync-ms 30000 --timeout-ms 40000 --linger-ms 30000
```

首行打印 `{"role":"serve","event":"listening","multiaddr":"/ip4/…/p2p/…","peerId":"…"}`；把 `multiaddr` 里的
`0.0.0.0` 换成 A 的 LAN IP 即得对端可拨地址。

## 3. 机器 B：导入同一主密钥并上车

```bash
fleet onboard --dir ~/.fleet \
  --device device-B \
  --peer-device device-A \
  --peer-addr /ip4/<A_LAN_IP>/tcp/<PORT>/p2p/<A_PEER_LIBP2P_ID> \
  --master-key /path/to/master-key.json \
  --agent echo:echo
```

`--master-key` 指向从 A 分发来的主密钥；`--peer-device/--peer-addr` 登记 A 并写入 **bootstrap 配置白名单**（默认拒绝，未见者看不到 `tasks`）。若要用「图上授权为主」而不写配置白名单，加 `--no-config-grant`（见 §4）。

运行执行端：

```bash
fleet work --dir ~/.fleet --timeout-ms 30000
# 期望：{"role":"work","device":"device-B","executed":5}
```

A 在线时，B 自检应全绿：

```bash
fleet doctor --dir ~/.fleet
# summary: ok=true skipped=[]
```

## 4. 图上授权为主（G1，推荐）

**配置白名单 = bootstrap；图上 `namespace_grant` = 正路**（可审计、可撤销、可转授、无需改配置重启）。

```bash
# A 自任引导签发者（配置白名单=bootstrap；只有它才能为任意 namespace 签发）
fleet onboard --dir ~/.fleet --device device-A --peer-device device-B \
  --policy-issuer device-A --no-config-grant --agent echo:echo

# A 为 B 签发 grant（落保留命名空间 __policy__，由 core 保证必须链到主密钥、不可自授）
fleet grant --dir ~/.fleet --to device-B --namespace tasks
# 期望：{"ok":true,"role":"grant","grantId":"<uuid>","subject":"device-B","namespaces":["tasks"]}

# A 自检：仅图上 grant（无配置白名单）也应授权通过
fleet doctor --dir ~/.fleet
#   PASS  namespace 已授权  namespace=tasks peers=[device-B:ok]

# 撤销（按 grantId 精确失效；R-d：恢复必须用**新的** grantId）
fleet revoke --dir ~/.fleet --grant-id <uuid>
fleet doctor --dir ~/.fleet
#   FAIL  namespace 已授权  … → 曾被 namespace_revoke 撤销；必须用新的 grantId 恢复（R-d）
```

- `getEffectiveNamespaces(peer) = 图上 grant ∪ 配置白名单`；**两者皆空 = 拒绝**（默认拒绝不变）；吊销优先。
- 未授权设备签发的 grant **不被采纳**（R-a：不能给出自己没有的 / 非引导签发者）；撤销过的 grantId **不能复用**（R-d）。
- B 端只需 `--peer-device device-A`（用于 B→A 回传的 bootstrap 白名单）；结果事件由 A 的图上 grant 决定是否收下。

### 完整 A→B（仅图授权，无配置白名单）

```bash
# 1) A 上车：自任引导签发者，登记 B 但不写配置白名单
fleet onboard --dir ~/.fleet --device device-A --peer-device device-B \
  --listen /ip4/0.0.0.0/tcp/4001 --policy-issuer device-A --no-config-grant --agent echo:echo

# 2) A 为 B 签 grant（A 自检：namespace 已授权 PASS；peer 可达 SKIP）
fleet grant --dir ~/.fleet --to device-B --namespace tasks
# → {"ok":true,"role":"grant","grantId":"<uuid>","subject":"device-B","namespaces":["tasks"]}

# 3) A 起服务（把 multiaddr 里的 0.0.0.0 换成 A 的 LAN IP 给 B）
fleet serve --dir ~/.fleet --submit 5 --target-agent echo --expect-prefix ECHO: \
  --wait-sync-ms 30000 --timeout-ms 40000 --linger-ms 30000

# 4) B 上车并导入同一主密钥；把 A 设为引导签发者 → B 采纳 A 转授的 grant
#    （B→A 回传走 --peer-device 的 bootstrap 白名单）
fleet onboard --dir ~/.fleet --device device-B --peer-device device-A \
  --peer-addr /ip4/<A_LAN_IP>/tcp/4001/p2p/<A_PEER_ID> --policy-issuer device-A \
  --master-key /path/to/master-key.json --agent echo:echo

# 5) B 同步并执行（B 已在此采纳 A 的图上 grant）
fleet work --dir ~/.fleet --timeout-ms 30000
# → {"role":"work","device":"device-B","executed":5}

# 6) A 侧确认 done=5 / resultsMatch=true；B 在线时 B 自检 ok=true skipped=[]
fleet doctor --dir ~/.fleet
```

## 5. `fleet doctor` 检查项

| 检查 | PASS 条件 | 不可判定时 |
| --- | --- | --- |
| `config` / `config 权限` | 配置可加载、形状合法、0600 | 无法加载 → FAIL（附首个错误与 `onboard` 提示） |
| `主密钥权限` / `主密钥` | 文件存在且 0600、可解析 | 权限过宽 → FAIL + hint `chmod 600 …`；不可解析 → FAIL |
| `设备身份文件` | `${storagePath}.identity.json` 存在 | FAIL |
| `主密钥链` | core 用主密钥验签设备证书通过 | FAIL（初始化失败） |
| `peer 可达(device)` | peer 有 addr 时 TCP 可连 | 无 peers 或无 addr → **SKIP**（附原因） |
| `namespace 已授权` | 每个已配置对端在 **图上 grant ∪ 配置白名单** 里含 `namespace`（默认拒绝、吊销优先） | FAIL：既无 grant 也无白名单 → hint `fleet grant`；曾 grant 但被撤销 → hint 用**新 grantId**（R-d）；无对端 → FAIL |
| `agent 注册表` | `config.agents` 全部可解析 | FAIL |
| `同步已收敛` | 本地见到**对端署名**的任务事件 | 无任何任务事件 → **SKIP**（附原因） |

`fleet doctor --json` 输出机器可读报告（`{ok, checks[], skipped[]}`）；**只在 FAIL 时显示 hint**，SKIP 一律在 `skipped` 里明写原因，不静默跳过。

## 6. 一键验收（CI 同款）

```bash
npm run verify:fleet:onboard   # onboard→双节点派活→doctor 全绿 + 失败矩阵 F1–F7（16/16）
npm run verify:fleet:grant     # G1：仅图上 grant 派活、撤销后不可见、R-a/R-d + 失败矩阵（16/16）
npm run verify:fleet:all       # local + remote + agents + onboard + grant 汇总 → 一个 JSON 摘要（含 skipped）
```

这些脚本使用确定性 fake agent，不触达真实 Hermes/OpenChamber；各自打印 `FLEET_SUMMARY {json}` 供 CI 解析。
**注意（A2）**：脚本跑的是 `dist` 产物，改 `src/**` 后做红→绿必须先 `npm run build`。

## 7. 失败矩阵与恢复

| 场景 | 现象 | 恢复 |
| --- | --- | --- |
| 主密钥文件缺失 | `onboard` 非零退出，`error` 提示 master key | 从 A 重新分发，或用 `--master-key` 指对路径 |
| 主密钥权限过宽（0644/组可读） | `doctor` FAIL `主密钥权限` + hint | `chmod 600 ~/.fleet/master-key.json` |
| 主密钥文件损坏 / 形状非法 | `onboard` 非零退出，`error` 提示 JSON/形状非法 | 重新分发完整文件；不要手改 |
| 未授权 namespace | `doctor` FAIL `namespace 已授权` | 签 `fleet grant --to <peer> --namespace <name>`，或 `onboard --namespace <name>`（bootstrap） |
| 授权被撤销 | `doctor` FAIL 且 hint「新 grantId（R-d）」 | 用**全新** grantId 重新 `fleet grant`；旧 grantId 不可复用（R-d） |
| 未授权设备自授 | grant 命令成功但不生效（`doctor` 仍 FAIL） | 只有引导签发者（`--policy-issuer`）或已获授权者能签发（R-a）；别在被隔离设备上自授 |
| peer 不可达 | `doctor` FAIL `peer 可达` | 核对 A 的监听端口/LAN IP、防火墙；确认 `--peer-addr` 的 `multiaddr` |
| 监听端口被占用 | `serve` 非零退出 | 换 `--listen /ip4/…/tcp/<空闲端口>` 重新 `onboard` |
| 配置损坏 | `doctor` FAIL `config` | 删除后重新 `onboard`（主密钥可复用） |
| 两端主密钥不一致 | 握手失败、`doctor` 的 `同步已收敛` 恒为 SKIP/FAIL | 两端必须导入**同一把**主密钥 |

## 8. 安全与边界

- **权限**：主密钥/配置必须 0600，设备目录建议 0700；`doctor` 会断言主密钥权限。
- **目录**：生产请用 `~/.fleet`；仓库内默认的 `./.fleet` 已在 `.gitignore` 忽略（内含归一化主密钥），但更安全的做法是永远放在仓库外。
- **日志脱敏**：`serve`/`work`/`doctor` 输出只含设备名、多播地址、指纹与计数，**不含**私钥材料；`verify:fleet:onboard` 会断言日志中搜不到私钥。
- 主密钥即身份：泄露等同身份泄露；不要提交进仓库、不要放进镜像层。
- **Windows**：`command` agent 必须指向 Windows 可执行的入口（`.cmd`/`.ps1` 包装）；`verify:fleet:onboard` 的 fake-agent 依赖 POSIX 可执行位，Windows 上该条会 SKIP 并提示改用 `command=node` 包装。内置 `echo` agent 全平台可用。
- 临时文件与密钥一律写在临时目录，不进仓库。
