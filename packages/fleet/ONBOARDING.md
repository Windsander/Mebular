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

`--master-key` 指向从 A 分发来的主密钥；`--peer-device/--peer-addr` 授权 A 并登记其地址（默认拒绝，未见者看不到 `tasks`）。

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

## 4. `fleet doctor` 检查项

| 检查 | PASS 条件 | 不可判定时 |
| --- | --- | --- |
| `config` / `config 权限` | 配置可加载、形状合法、0600 | 无法加载 → FAIL（附首个错误与 `onboard` 提示） |
| `主密钥权限` / `主密钥` | 文件存在且 0600、可解析 | 权限过宽 → FAIL + hint `chmod 600 …`；不可解析 → FAIL |
| `设备身份文件` | `${storagePath}.identity.json` 存在 | FAIL |
| `主密钥链` | core 用主密钥验签设备证书通过 | FAIL（初始化失败） |
| `peer 可达(device)` | peer 有 addr 时 TCP 可连 | 无 peers 或无 addr → **SKIP**（附原因） |
| `namespace 已授权` | 已授权至少一个对端且 namespace 非空（默认拒绝） | FAIL + hint `--peer-device` |
| `agent 注册表` | `config.agents` 全部可解析 | FAIL |
| `同步已收敛` | 本地见到**对端署名**的任务事件 | 无任何任务事件 → **SKIP**（附原因） |

`fleet doctor --json` 输出机器可读报告（`{ok, checks[], skipped[]}`）；**只在 FAIL 时显示 hint**，SKIP 一律在 `skipped` 里明写原因，不静默跳过。

## 5. 一键验收（CI 同款）

```bash
npm run verify:fleet:onboard   # temp 目录内 onboard→双节点派活→doctor 全绿 + 失败矩阵（16/16）
npm run verify:fleet:all       # local + remote + agents + onboard 汇总 → 一个 JSON 摘要（含 skipped）
```

`verify:fleet:onboard` 使用确定性 fake agent，不触达真实 Hermes/OpenChamber；单条命令打印 `FLEET_SUMMARY {json}` 供 CI 解析。

## 6. 失败矩阵与恢复

| 场景 | 现象 | 恢复 |
| --- | --- | --- |
| 主密钥文件缺失 | `onboard` 非零退出，`error` 提示 master key | 从 A 重新分发，或用 `--master-key` 指对路径 |
| 主密钥权限过宽（0644/组可读） | `doctor` FAIL `主密钥权限` + hint | `chmod 600 ~/.fleet/master-key.json` |
| 主密钥文件损坏 / 形状非法 | `onboard` 非零退出，`error` 提示 JSON/形状非法 | 重新分发完整文件；不要手改 |
| 未授权 namespace | `doctor` FAIL `namespace 已授权` | 重新 `onboard --namespace <name>`，并确认对端策略 |
| peer 不可达 | `doctor` FAIL `peer 可达` | 核对 A 的监听端口/LAN IP、防火墙；确认 `--peer-addr` 的 `multiaddr` |
| 监听端口被占用 | `serve` 非零退出 | 换 `--listen /ip4/…/tcp/<空闲端口>` 重新 `onboard` |
| 配置损坏 | `doctor` FAIL `config` | 删除后重新 `onboard`（主密钥可复用） |
| 两端主密钥不一致 | 握手失败、`doctor` 的 `同步已收敛` 恒为 SKIP/FAIL | 两端必须导入**同一把**主密钥 |

## 7. 安全与边界

- **权限**：主密钥/配置必须 0600，设备目录建议 0700；`doctor` 会断言主密钥权限。
- **日志脱敏**：`serve`/`work`/`doctor` 输出只含设备名、多播地址、指纹与计数，**不含**私钥材料；`verify:fleet:onboard` 会断言日志中搜不到私钥。
- 主密钥即身份：泄露等同身份泄露；不要提交进仓库、不要放进镜像层。
- **Windows**：`command` agent 必须指向 Windows 可执行的入口（`.cmd`/`.ps1` 包装）；`verify:fleet:onboard` 的 fake-agent 依赖 POSIX 可执行位，Windows 上该条会 SKIP 并提示改用 `command=node` 包装。内置 `echo` agent 全平台可用。
- 临时文件与密钥一律写在临时目录，不进仓库。
