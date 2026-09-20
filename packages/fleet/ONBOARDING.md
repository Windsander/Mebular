# 设备上车（Step 1b）：≤15 分钟把第二台设备加入舰队

> 目标：不 clone、不手写配置，在一台新机器上用**一条 `fleet onboard`** 接入，并用 `fleet doctor`
> 自证「可达、已授权、已收敛」。传输/隐私语义见仓库根 [`SEALING.md`](../../SEALING.md)；
> 双机任务板/执行端的完整叙事见 [`RUNBOOK.md`](./RUNBOOK.md)（本文件是它的「上车」前置）。

## 0. 前置

- Node.js **>= 20**（`node -v`）。
- 两台机器可互相 TCP 可达（同一 LAN 即可；跨 NAT 见 RUNBOOK §3）。
- 信任根 = **同一把用户主密钥**：所有共享它的设备同属一个用户。新设备必须**导入**已有设备的主密钥，否则设备证书互不信任、握手失败、永不收敛。

## 0.5 一键上车（Stage 1）：每台一条命令

两端跑**同一构建 SHA**（`fleet --version` 一致）。A 先出码，B 用码加入，A 再批准：

```bash
# A（第一条命令）：建根 + 声明签发者/成员 + 自授权 + 产出加入码 +（默认）服务 + doctor
fleet quickstart --dir ~/.mebular --device device-A \
  --listen /ip4/0.0.0.0/tcp/4001 \
  --code-file ~/.mebular/join-code.txt        # 0600；内联 base64 同时打到 stdout

# B（第一条命令）：版本核对 → 导入信任材料与 A 的地址 → 声明成员 →（默认）服务 → doctor
fleet join --dir ~/.mebular --code-file <把 join-code.txt 安全传到 B> --device device-B

# A（批准）：pending 列出「在册但未授权」设备；approve 发图上 grant（并登记 B 的地址）
fleet pending --dir ~/.mebular
fleet approve --dir ~/.mebular --device device-B --addr <B 的 multiaddr>
```

- **默认值**：`--dir` = `$FLEET_DIR` 或 `~/.mebular`；`--device` = `$FLEET_DEVICE` 或主机名（清洗）；quickstart/join 的 `--listen` = `/ip4/0.0.0.0/tcp/4001`（端口占用会带修复建议报错）。
- **agent 自动探测**：PATH 有 `hermes` → `hermes`；存在 `MEBULAR_FLEET_OPENCHAMBER_*` → `openchamber`；否则 `echo`（结果见 JSON 的 `agentSources`，可用 `--agent` 覆盖）。
- **加入码含信任材料**（共享主密钥）：`--code-file` 以 **0600** 落盘；不写日志、不回显密钥材料；务必经安全通道传输。**Stage 2 起推荐令牌路径（主密钥不复制，见 §0.6）**。
- **`quickstart --auto-approve`（⚠️ 有风险）**：常驻 `fleet node` 会对**任何在册未授权设备自动授权**。仅在受控信任域使用（默认关闭）。
- **LAN 自动发现**：core 的 mDNS 发现是**注入式**（`network.bonjourFactory`）且**不自动拨号**，Stage 1 未启用（不做半成品）；加入码内的 multiaddr 即**跨网回退**路径。真·同网零地址发现需 core 支持自动拨号（后续）。

## 0.6 信任模型 v2（T2）：令牌加入 —— 主密钥不再复制

推荐路径：inviter（**任意在册设备**，不要求某台特定设备）出**短时效令牌**，新设备用令牌换取**委派证书**。

```bash
# inviter（任意已入网设备；需其 `fleet node` 在跑以提供 join 端点）
fleet invite --dir ~/.mebular                       # 输出令牌（内联 base64）+ join 端点
# 新设备（不导入主密钥；只看令牌）
fleet join --token <内联|--token-file> --dir ~/.mebular --device device-B
```

- **委派证书链**：`master → inviter → 新设备`（叶→根；**跳数上界 4**，超长拒绝）。链逐跳用设备公钥验签、末跳由用户主密钥验签；**没有任何“指定主设备/CA”**，任意在册设备都可签发下级证书。
- **主密钥可离线**：日常扩容不需要主私钥参与；新设备只保留**主公钥**（`master-key.json` 无 `privateKeyPkcs8`），无静态加密/主密钥私钥材料。
- **令牌三态吊销**（与设备证书吊销**分开**）：**过期**（inviter 时钟为准）/ **一次性**（nonce 已用，本地 `<store>.join-tokens.json`）/ **被撕**（显式撤销）。
- **设备证书吊销级联**：`device_revoke` 后，被吊销设备**及其签发的下级证书**一并失效（与策略层 R-b 同源；需吊销事件同步到达各端才生效 → 有传播延迟）。
- **兼容**：Stage 1 的 `quickstart` 仍产出**共享主密钥加入码**（`fleet join --code`），旧部署继续可用；含主密钥私钥的加入码不落日志、`--code-file` 0600。
- **⚠️ 安全提示（join 端点）**：`fleet node` 的 join 端点是 **LAN/明文 HTTP**，令牌/加入码是**秘密**且**短时效**（默认 15 分钟、一次性）。仅建议在**可信 LAN** 使用；跨网段需经 relay/额外防护（未来可加 TLS/mTLS）。令牌可被持有者用于让**任意**设备入网，请勿写入工单/公开日志，传输后即弃；`--join-port`/`--join-host` 只控制通告地址，不改变明文性质。
- **同版本要求**：委派证书是**破坏性协议变更**（旧节点只做一层主密钥验签，收到委派证书会**拒绝**，安全方向）→ 集群须全端升级；共享主密钥 + 主密钥直签证书的旧部署与新端互通。

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
fleet onboard --dir ~/.mebular \
  --device device-A \
  --peer-device device-B \
  --agent echo:echo
```

- 生成 `~/.mebular/master-key.json`（**信任根**，0600）、`~/.mebular/fleet.config.json`（0600）与设备身份文件。
- 输出 JSON 含 `masterKeyFingerprint`（`sha256:<12hex>`，**不是**密钥材料）与 `next` 提示。
- **把 `~/.mebular/master-key.json` 通过安全通道（scp/密钥管理）分发给机器 B**。

启动（`--submit` 派 N 个任务给 B 的 `echo` agent；等待首轮同步后再提交）：

```bash
fleet node --dir ~/.mebular \
  --submit 5 --target-agent echo \
  --expect-prefix ECHO: \
  --wait-sync-ms 30000 --timeout-ms 40000 --linger-ms 30000
```

首行打印 `{"role":"node","event":"listening","multiaddr":"/ip4/…/p2p/…","peerId":"…"}`；把 `multiaddr` 里的
`0.0.0.0` 换成 A 的 LAN IP 即得对端可拨地址。

## 3. 机器 B：导入同一主密钥并上车

```bash
fleet onboard --dir ~/.mebular \
  --device device-B \
  --peer-device device-A \
  --peer-addr /ip4/<A_LAN_IP>/tcp/<PORT>/p2p/<A_PEER_LIBP2P_ID> \
  --master-key /path/to/master-key.json \
  --agent echo:echo
```

`--master-key` 指向从 A 分发来的主密钥；`--peer-device/--peer-addr` 登记 A 并写入 **bootstrap 配置白名单**（默认拒绝，未见者看不到 `tasks`）。若要用「图上授权为主」而不写配置白名单，加 `--no-config-grant`（见 §4）。**C1 起新设备无需 `--policy-issuer`**：引导签发者以图上 `policy_issuer_declare` 同步（旧配置写法仍兼容）。

运行执行端：

```bash
fleet worker --dir ~/.mebular --timeout-ms 30000
# 期望：{"role":"worker","device":"device-B","executed":5}
```

A 在线时，B 自检应全绿：

```bash
fleet doctor --dir ~/.mebular
# summary: ok=true skipped=[]
```

## 4. 图上授权为主（G1）+ 引导签发者上图（C1，推荐）

**配置白名单 = bootstrap；图上 `namespace_grant` = 正路**；**引导签发者也在图上声明**
（`policy_issuer_declare`）——各端同步即自动采纳，**无需本地 `--policy-issuer` 一致**。

```bash
# A 上车：登记 B 但不写配置白名单、不写本地 policyIssuers
fleet onboard --dir ~/.mebular --device device-A --peer-device device-B \
  --no-config-grant --agent echo:echo

# A 在图上把自己声明为引导签发者（去中心化 bootstrap；受信任链约束、可被 device_revoke 排斥）
fleet declare-issuer --dir ~/.mebular --to device-A
# 期望：{"ok":true,"role":"declare-issuer","subject":"device-A","eventId":"…"}

# A 为 B 签发 grant（落保留命名空间 __policy__，由 core 保证必须链到主密钥、不可自授）
fleet grant --dir ~/.mebular --to device-B --namespace tasks
# 期望：{"ok":true,"role":"grant","grantId":"<uuid>","subject":"device-B","namespaces":["tasks"]}

# A 自检：图上 grant（无配置白名单）授权通过；策略签发者来自图上声明
fleet doctor --dir ~/.mebular
#   PASS  namespace 已授权  namespace=tasks peers=[device-B:ok]
#   PASS  策略签发者       issuers=[device-A]

# 撤销（按 grantId 精确失效；R-d：恢复必须用**新的** grantId）
fleet revoke --dir ~/.mebular --grant-id <uuid>
fleet doctor --dir ~/.mebular
#   FAIL  namespace 已授权  … → 曾被 namespace_revoke 撤销；必须用新的 grantId 恢复（R-d）
```

- `getEffectiveNamespaces(peer) = 图上 grant ∪ 配置白名单`；**两者皆空 = 拒绝**（默认拒绝不变）；吊销优先。
- **生效引导签发者集合 = 图上声明 ∪ 本地配置**（配置降级为兼容回退）。声明**无条件采纳**（只要求链到主密钥），
  但**签发者或主体被 `device_revoke` 吊销 → 不采纳**（R-b 优先）。
- 未授权设备签发的 grant **不被采纳**（R-a：不能给出自己没有的 / 非生效签发者）；撤销过的 grantId **不能复用**（R-d）。
- B 端只需 `--peer-device device-A`（用于 B→A 回传的 bootstrap 白名单）；结果事件由 A 的图上 grant 决定是否收下。

### 完整 A→B（仅图授权 + 图上声明，无本地配置）

```bash
# 1) A 上车：登记 B，但不写配置白名单/policyIssuers
fleet onboard --dir ~/.mebular --device device-A --peer-device device-B \
  --listen /ip4/0.0.0.0/tcp/4001 --no-config-grant --agent echo:echo

# 2) A 图上声明自己为引导签发者；再为 B 签 grant
fleet declare-issuer --dir ~/.mebular --to device-A
fleet grant --dir ~/.mebular --to device-B --namespace tasks
# → {"ok":true,"role":"grant","grantId":"<uuid>","subject":"device-B","namespaces":["tasks"]}

# 3) A 起服务（把 multiaddr 里的 0.0.0.0 换成 A 的 LAN IP 给 B）
fleet node --dir ~/.mebular --submit 5 --target-agent echo --expect-prefix ECHO: \
  --wait-sync-ms 30000 --timeout-ms 40000 --linger-ms 30000

# 4) B 上车并导入同一主密钥：**无需** --policy-issuer（图上声明会同步过来）
fleet onboard --dir ~/.mebular --device device-B --peer-device device-A \
  --peer-addr /ip4/<A_LAN_IP>/tcp/4001/p2p/<A_PEER_ID> \
  --master-key /path/to/master-key.json --agent echo:echo

# 5) B 同步并执行（B 已采纳 A 的图上声明，进而采纳其 grant）
fleet worker --dir ~/.mebular --timeout-ms 30000
# → {"role":"worker","device":"device-B","executed":5}

# 6) A 侧确认 done=5 / resultsMatch=true；B 在线时 B 自检 ok=true skipped=[]
fleet doctor --dir ~/.mebular
```

> 兼容：旧写法 `onboard --policy-issuer device-A` 仍可用（配置作为 bootstrap 回退）；新部署推荐只用 `declare-issuer`。
> **破坏性协议变更**：旧节点（不含 C1）会忽略 `policy_issuer_declare`；新旧混跑时旧节点仍需本地 `--policy-issuer`，否则会**少授权**（安全方向）。详见仓库根 `SEALING.md` §3 C1。

### FAQ：信任根 / 引导白名单 / 图上授权 的角色与边界

| 概念 | 是什么 | 存哪 | 谁签 | 能否撤销 | 变更影响 |
| --- | --- | --- | --- | --- | --- |
| **信任根**（用户主密钥） | 整个用户身份的根；设备证书链到它 | 本地 `master-key.json`（0600），**安全分发** | — | 换根 = 换身份体系 | 全端信任边界 |
| **引导白名单**（C1） | 「可为任意 `namespace` 签发」的设备集合 = 图上声明 ∪ 本地配置 | `__policy__`（`policy_issuer_declare`）+ 兼容配置 `sync.policyIssuers` | 任一可信且未被吊销的设备均可声明 | `device_revoke` 主体即失效 | 同步即生效，多端一致（无需本地配置） |
| **图上授权**（G1） | 「某设备可被授予哪些分区」的白名单 | `__policy__`（`namespace_grant`） | 生效引导集合成员，或已获授权者的转授 | `namespace_revoke`（按 grantId，R-d） | 同步即生效 |

边界：引导白名单**只决定「谁能签发」**，不直接授予任何分区；实际能读哪些分区由 `namespace_grant`（图上授权）与
配置白名单的**并集**、按默认拒绝决定。三者都以**主密钥证书链**为唯一信任来源，别家用户/无证书的声明与授权一律忽略。

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
| `策略签发者` | 信息项：列出**生效引导签发者**（图上声明 ∪ 配置）；恒 PASS | —（空时 detail 提示 `declare-issuer`） |
| `同步已收敛` | 本地见到**对端署名**的任务事件 | 无任何任务事件 → **SKIP**（附原因） |

`fleet doctor --json` 输出机器可读报告（`{ok, checks[], skipped[]}`）；**只在 FAIL 时显示 hint**，SKIP 一律在 `skipped` 里明写原因，不静默跳过。
**Windows**：`config 权限` 与 `主密钥权限` 两项为 SKIP（无 POSIX mode 语义），见 [§9](#9-windowsmacos-真双机)。

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
| 主密钥权限过宽（0644/组可读） | `doctor` FAIL `主密钥权限` + hint | `chmod 600 ~/.mebular/master-key.json` |
| 主密钥文件损坏 / 形状非法 | `onboard` 非零退出，`error` 提示 JSON/形状非法 | 重新分发完整文件；不要手改 |
| 未授权 namespace | `doctor` FAIL `namespace 已授权` | 签 `fleet grant --to <peer> --namespace <name>`，或 `onboard --namespace <name>`（bootstrap） |
| 授权被撤销 | `doctor` FAIL 且 hint「新 grantId（R-d）」 | 用**全新** grantId 重新 `fleet grant`；旧 grantId 不可复用（R-d） |
| 未授权设备自授 | grant 命令成功但不生效（`doctor` 仍 FAIL） | 只有引导签发者（`--policy-issuer`）或已获授权者能签发（R-a）；别在被隔离设备上自授 |
| peer 不可达 | `doctor` FAIL `peer 可达` | 核对 A 的监听端口/LAN IP、防火墙；确认 `--peer-addr` 的 `multiaddr` |
| 监听端口被占用 | `fleet node` 非零退出 | 换 `--listen /ip4/…/tcp/<空闲端口>` 重新 `onboard` |
| 配置损坏 | `doctor` FAIL `config` | 删除后重新 `onboard`（主密钥可复用） |
| 两端主密钥不一致 | 握手失败、`doctor` 的 `同步已收敛` 恒为 SKIP/FAIL | 两端必须导入**同一把**主密钥 |

## 8. 安全与边界

- **权限**：主密钥/配置必须 0600，设备目录建议 0700；`doctor` 会断言主密钥权限。
- **目录**：生产请用 `~/.mebular`；仓库内默认的 `./.fleet` 已在 `.gitignore` 忽略（内含归一化主密钥），但更安全的做法是永远放在仓库外。
- **日志脱敏**：`fleet node`/`fleet worker`/`doctor` 输出只含设备名、多播地址、指纹与计数，**不含**私钥材料；`verify:fleet:onboard` 会断言日志中搜不到私钥。
- 主密钥即身份：泄露等同身份泄露；不要提交进仓库、不要放进镜像层。
- 临时文件与密钥一律写在临时目录，不进仓库。
- **Windows**：见 [§9](#9-windowsmacos-真双机)：权限语义、防火墙、`command` agent 一律经 `node` 调用。

## 9. Windows（macOS 真双机）

目标拓扑：一台 macOS（可跑 Hermes）+ 一台 Windows（只有 OpenChamber、无 Hermes/Python），**有线静态 IP**。fleet 侧零改动即可跑通；差异集中在权限/路径/可执行位。

### 9.1 安装

```powershell
winget install OpenJS.NodeJS.LTS   # 或官网 MSI；Node.js >= 20（LTS 均可）
node -v
npm i -g github:Windsander/Mebular#<SHA>
fleet --version                    # @mebular/fleet 0.1.0 (<SHA>)
```

### 9.2 权限与路径（威胁模型差异）

- Windows **无 POSIX mode 语义**：`chmod`/`0o600` 不成立，`stat().mode` 恒为 `0666/0444`。因此 `fleet doctor` 在 Windows 上对 `config 权限` / `主密钥权限` **显式 SKIP**（写入 `skipped`），**绝不假 FAIL**；其余检查（配置形状、身份链、namespace、agent、同步）照常判定。
- 等价保护来自 **用户配置目录 ACL**（`%USERPROFILE%` 默认仅本人与管理员可读）与 OS 会话边界。务必把设备目录放在 `$env:USERPROFILE\.fleet`（**不要**放共享盘/公共目录），并保证 Windows 账户本身有密码/锁屏。
- 路径用 PowerShell 的 `"$env:USERPROFILE\.fleet"`；`fleet` 内部一律用 `os.homedir()`/`os.tmpdir()`，不硬编码 `/tmp`。

### 9.3 静态 IP + 防火墙入站放行

给 A（macOS）固定监听端口（如 4001），在 Windows B 上放行出站即可；若要 B 监听（两端对称），在 **B** 上放行入站：

```powershell
# 以管理员运行：允许舰队监听端口入站（示例 4001，仅私有网络）
New-NetFirewallRule -DisplayName "fleet libp2p 4001" -Direction Inbound `
  -Protocol TCP -LocalPort 4001 -Action Allow -Profile Private
```

A 的 `fleet node` 打印 `multiaddr`（`/ip4/0.0.0.0/tcp/4001/p2p/…`）后，把 `0.0.0.0` 换成 A 的**静态 LAN IP** 给 B 的 `--peer-addr`。

### 9.4 `command` agent 一律经 `node` 调用（不依赖 shebang/可执行位）

```powershell
fleet onboard --dir "$env:USERPROFILE\.fleet" --device device-Win `
  --agent mycmd:command --agent-command (Get-Command node).Source --agent-base-args "C:\path\my-agent.mjs"
```

`CommandAgent` 执行 `node C:\path\my-agent.mjs -z <prompt>`：`--agent-command` 用 `node.exe`，脚本走 `--agent-base-args`。**不要**依赖 `.mjs` 的 shebang 或可执行位（Windows 不生效）。内置 `echo` agent 全平台可用。

### 9.5 信号 / 终止差异

- POSIX：`SIGINT`(Ctrl-C)/`SIGTERM` 可被进程捕获做优雅收尾；Windows 无真正的 `SIGTERM`，`Ctrl-C` 走 `SIGINT`，`taskkill /F` 等同强杀。`fleet node`/`fleet worker` 在退出前落盘事件；强杀时未落盘的在途窗口由 core 的 anti-entropy 在下次同步补齐（至少一次）。
- 跨机用 `--linger-ms` 保持 A 在线，避免 B 侧 `doctor` 的「peer 可达/同步已收敛」在 A 退出后抖动。

### 9.6 Windows 的 OpenChamber 执行器 = provider #2（Node）

Windows 常无 Hermes/Python。OpenChamber 任务执行改用 **provider #2**（Self-Skills 仓 `oc-node-provider`）：一个只需 Node 的极简 daemon，`POST /agent/run-once` 与 provider #1（`bridge.py`）**同协议**，复用现有 `oc-bridge.js` 插件（inbox/outbox）。安装/启动/替换关系见 Self-Skills `skills/oc-node-provider/README.md`；fleet 侧仅把 `--with-openchamber` 指向该 endpoint（`~/.oc-hermes-bridge/daemon.json`），**无需改 fleet 代码**。


## 10. 常驻服务（D1–D4）：开机自启 + 崩溃自拉 + 日志/状态

三个常驻组件由 `@mebular/service` 统一服务化（**零 core 改动**）：`fleet-node`（任务板/发起端）、`fleet-worker`（执行端）、`mebular-serve`（记忆/同步/MCP 底座）。

```bash
# 安装并启动（默认登录/开机自启）；--no-autostart 只安装不自启
fleet service install fleet-node   --dir ~/.mebular
fleet service install fleet-worker --dir ~/.mebular
mebular service install            # mebular-serve

fleet service status          # 注册/运行/心跳新鲜度/SHA
fleet service logs fleet-node --tail 50
fleet service uninstall fleet-node

fleet node   --dir ~/.mebular --run-forever
fleet worker --dir ~/.mebular --run-forever
```

- **平台**：macOS = launchd 用户级 LaunchAgent（`~/Library/LaunchAgents`，RunAtLoad + KeepAlive + ThrottleInterval）；Linux = `systemd --user`（`Restart=on-failure`，`WantedBy=default.target`）；Windows = **Task Scheduler onlogon**（`schtasks`，无需管理员）。
- **心跳**：常驻进程写 `<设备目录>/service.heartbeat` `{pid,ts,role,sha}`（0600）；`doctor` 增两项——`服务已注册`（dir-scoped，未安装 → SKIP 明列原因）与 `心跳新鲜`（陈旧 → FAIL）。
- **幂等**：重复 `install` = 更新单元并重启；`uninstall` 未安装 = 清晰提示（`removed:false`）。单元/manifest 记录**构建 SHA**，`service status` 输出。
- **Windows 边界**：Task Scheduler 为登录级、非真 Windows Service（后者需管理员，记为后续可选项）；`--no-autostart` 下任务注册后立即 `schtasks /End`（已注册但停止）。
- **已知限制（日志轮转）**：服务日志按平台写入各自日志目录，**无自动轮转/上限**；长期常驻请自行 `logrotate`/定时清理（或后续补内建轮转）。

> 命令名（D5）：`fleet node`（任务板/发起端）/ `fleet worker`（执行端），与 `FleetNode`/`FleetWorker` 对齐；JSON `role` 字段为 `node`/`worker`；M2 单机双进程（spool）命令为 `fleet spool node|worker`。（历史别名 `serve`/`work` 已移除。）

## 11. 成员资格（M1–M3）：订阅 = 持久、签名的图上记录

订阅从「瞬时 hello 声明」升格为**图上持久成员资格**（`namespace_membership`，落 `__policy__`）。裁剪链变为
`对端授权 ∩ 对端成员资格 ∩ 本机订阅声明`；hello 订阅声明仅作**活跃性/一致性校验**，不一致时**显式拒绝/告警**
（`sync-completed.membershipRejected`），不静默。

```bash
# 把 device-B 声明为 tasks 分区的成员（在册）；--leave 注销
fleet member --dir ~/.mebular --to device-B --namespace tasks
fleet member --dir ~/.mebular --to device-B --namespace tasks --leave

# 查询：生效成员 = 图上在册成员 ∩ 该成员对该分区的生效授权（默认拒绝不变）
fleet members --dir ~/.mebular --namespace tasks
# → {"ok":true,"active":true,"members":["device-A","device-B"],"onRecord":["device-A","device-B"]}
```

- **生效成员 = 成员记录 ∧ 授权**：`getNamespaceMembers(ns)`；**成员记录不放宽授权**（无 grant 仍不流动，默认拒绝不变）。
- **兼容（legacy-empty）**：某分区**没有任何成员记录**时视为未启用成员资格，沿用 hello 订阅裁剪（不破坏既有部署）；
  一旦出现成员记录，即成为该分区**强制闸门**（非成员收不到）。
- `doctor` 增 `namespace 成员资格`：未启用 → **SKIP**（明列原因）；启用后本机在册 → PASS，否则 FAIL。
- **A→B 与 B→A 都需要对方“在册”**：A 发任务要 A 视图里 B 是成员；B 回传结果要 B 视图里 A 是成员。
- **退订交接（2b）**：注销（`--leave`）会做**继任者全量 ack 门禁 + 本地彻底清理**（见 §12）。

> 破坏性协议变更：旧节点忽略 `namespace_membership`，对旧端该分区始终「未启用成员资格」→ 行为不变或**少收**
> （安全方向，不 fail-open）。详见仓库根 `SEALING.md` §3 M1–M3。

## 12. 退订交接（2b）：继任者全量 ack 门禁 + 本地彻底清理

退订 = **成员资格退出**（`namespace_membership(active:false)`）+ **本机彻底清理**该分区数据。**绝不产生 tombstone**（不写任何“已删除”事件）。

```bash
# 先看交接计划（只读，不删）：继任者是否在册、还差哪些作者/多少条
fleet leave --dir ~/.mebular --namespace tasks --successor device-B --dry-run
# → {"ok":false,"successorIsMember":true,"pendingTotal":1,"pendingByAuthor":[{"author":"device-A","count":1}]}

# 默认：继任者已全量 ack 才清理；否则中止且数据原封不动
fleet leave --dir ~/.mebular --namespace tasks --successor device-B
# → {"ok":true,"deleted":{"events":12,"nodes":12,"edges":0},"handoffEventId":"…"}

# 本地应急（跳过门禁；仍如实记录 forced:true + 缺失明细）；**不经 MCP/远程暴露**
fleet leave --dir ~/.mebular --namespace tasks --successor device-B --force
```

- **全量 ack 判定（H1）**：复用既有 per-event ack（`getPendingEvents(successor)`）——退订方校验继任者已 ack 其在该分区持有的**他人署名**事件（继任者自证事件其本就拥有）；**不新增同步协议、不放宽快照门禁**（SEALING §4 快照门禁仍不放宽）。
- **验前不删**：校验通过 → 写成员注销 + 交接记录（`namespace_handoff`，`__policy__`，含 `forced`/缺失明细）→ 写**图外**意图（`<storagePath>.handoff.json`）→ 物理删除事件/节点/边 → 清本地水位 → 移除意图。崩溃后重跑 `fleet leave` **幂等续跑**。
- **`__policy__` 永不清理**：策略/成员/交接记录保留 → 清理**不改变**策略推导（oracle-free）；legacy-empty 不退化（**清理后成员闸门仍在**，非成员仍收不到）。
- **可观测**：`fleet leave --dry-run` 给验证明细；`doctor` 增 `交接状态`（有未完成意图 → FAIL，提示续跑）。
- **重入/重订阅恢复（2c）**：清理后可用 `fleet rejoin` 重新加入并从对端拉回历史（见 §13）。

## 13. 重订阅恢复（2c）：显式降水位

退订清理后重新加入：`fleet rejoin` 重新声明成员在册，并**显式降水位**（对端从 0 重新发送历史）。**不新增同步协议、不放宽快照门禁、无 tombstone。**

```bash
# 重入（准入：①本机对该分区有生效授权 ②成员在册；任一不满足 → 显式失败）
fleet rejoin --dir ~/.mebular --namespace tasks
# 成功 → {"ok":true,"reset":true,"member":true,"authorized":true}
# 未授权 → {"ok":false,"reason":"not-authorized"}

# doctor 显示重入/重置状态
fleet doctor --dir ~/.mebular   # PASS 重入状态  reset=true（已声明重置；下次同步将从零拉取）
```

- **准入（R1）**：`getEffectiveNamespaces(self)` 含该分区（存在签发给本机的 grant；默认拒绝不变）**且**成员在册；否则显式失败（`not-authorized` / `membership-not-active`），不静默。
- **显式降水位（R2）**：重入写**图外**标记 `<storagePath>.rejoin.<ns>.json`（R3，**不同步/无 tombstone**）并清本机该分区本地水位；本机 hello 以**空时钟**上报该分区 → 对端按「自报水位**只允许向下修正**」从 0 重发（或按既有“空水位”门禁发初始快照；**门禁不放宽**）。**只允许向下、绝不向上**（不会把“对端没有”误判为“已有”）。
- **确定/幂等（R4）**：重复 `rejoin` 安全；rejoin/reset **不改变** `__policy__` 推导（oracle-free）。
- 前置：重入方需已被授权（例如对端 `fleet grant --to <rejoin设备>`），否则拉不到（显式失败）。

## 14. 协作形态（1d）：审查 DAG / 有限协商 / 配额制闲聊（已接 live）

三形态的纯模型已接到**真实节点**（任务协议/worker 接线，**线格式未变**：协商/闲聊是同分区内的独立节点类型，DAG 用既有 `created` + `trace`）。

- **审查 DAG**：worker 执行成功后按**计划**派生直接子任务（`causedBy`/`chain`）；**禁环守卫**在真实提交路径生效（成环 → 父任务 `failed`，原因 `DAG_CYCLE: p→c`）；发起端用 `dagCompletion` 判定**全部可达节点终态**才完成，`summarizeDag` 产出汇总。计划可用 `mapPlanner({ <intent>: [{intent:…}, …] })` 或自定义 `TaskPlanner`。
- **有限协商**：worker 对启用协商的任务在执行前发 `counter`（轮次 r），发起端 `policy: 'accept'` 接受或 `'counter'` 反提案；**轮替**（对端发言后才回），超 `maxRounds` → `failed`（`NEGOTIATION_LIMIT: r>N`）。消息 `messageId` 幂等、顺序无关。
- **配额制闲聊**：`FleetChatter.send` 对 `from.device` 走 `LocalQuota`（`accepted`/`queued`/`rejected`，无全局协调）；落图消息随记忆同步，收件按 `messageId` 幂等。
- **验收**：`npm run verify:fleet:collab`（真实 libp2p loopback 双端，12/12）；夹具 `packages/fleet/protocol/collab.example.json`；矩阵见 `PROTOCOL-INVARIANTS.md §7`。
- **限制**：自动化用确定性 fake executor（`EchoExecutor`）；真实执行器（Hermes/OpenChamber）沿用既有适配器，本轮未新增真实 Agent 验收。

## 15. Agent 如何派活（W1：域=数据通道 · 任务=树）

**域（namespace）= 数据通道**（参与即收 + 及时同步本地新记忆，无派发语义）；**任务 = 树**：root 由发起 Agent 创建，子任务由执行者在预算内派生。派发权限三层：**L1 域授权（默认拒绝）→ L2 任务树（创建者即派发者）→ L3 本地执行（device/agent 过滤 + 并发/准入）**。

```bash
# 0) 建板（= 建域 + 授权 + 邀请成员，免手工 grant/member）
fleet board_create --dir ~/.mebular --input '{"name":"team","with":["device-B"]}'

# 1) 看我能派给谁（L1 授权 ∩ 对端 Agent 目录）
fleet task_targets --dir ~/.mebular --namespace team

# 2) 发起 root（带预算与派发策略；agent 由工具填 from，root 有主）
fleet task_submit --dir ~/.mebular --namespace team --agent board --input \
  '{"intent":"审查 root","to":{"device":"device-B","agent":"echo"},"budget":{"maxDepth":2,"maxChildren":4,"maxTasks":8},"dispatch":"children-ok"}'

# 3) 跟踪 / 树 / 汇总
fleet task_status  --dir ~/.mebular --input '{"taskId":"task-…"}'
fleet task_children --dir ~/.mebular --input '{"taskId":"task-…"}'
fleet task_summarize --dir ~/.mebular --input '{"taskId":"task-…"}'
fleet task_subscribe --dir ~/.mebular --watch          # 变化推送（轮询）

# 4) 运维/协作
fleet task_quota --dir ~/.mebular
fleet task_negotiate --dir ~/.mebular --input '{"taskId":"task-…","kind":"counter","round":1}'
fleet chatter_send  --dir ~/.mebular --input '{"topic":"status","text":"…"}'
fleet chatter_inbox --dir ~/.mebular
```

- **与 MCP 完全一致**：`fleet mcp`（stdio JSON-RPC）暴露同名工具（`task_submit`…`board_create`），**同一 handler**、同一结构化输出；对照表见 [`DESIGN.md`](./DESIGN.md) §2.5.2。
- **反滥用**：子任务预算 **≤ 父剩余**（越深越小）；越预算/越链长/`root-only` 派生属**无效事件**（入口拒收 + 权威视图剔除）；worker **公平轮转**（单一发送方份额 ≤50%）、每 Agent 并发默认 2。
- **目录**：设备在 `agents` 域发布签名目录（`name/kind/capabilities?/concurrency/capacity?`）；`task_targets` = L1 授权 ∩ 目录；`capacity` 仅建议，**不参与授权/一致性**。

## 16. 一机一节点（W2 守护形态，推荐）

**一台机器 = 一个守护（记忆/身份/网络/信任唯一持有者）**；fleet 与各 Agent 都是本机客户端，共用守护身份与存储（数据分域），**同机 Agent 默认可信**。统一 home = `~/.mebular`（`MEBULAR_HOME` 覆盖）。

```bash
# A（首台，root 身份）：一条命令写好守护 home + fleet 客户端 + 令牌（+ 默认装 mebular-serve）
fleet quickstart --daemon --dir ~/.mebular --device device-A \
  --listen /ip4/0.0.0.0/tcp/4001 --daemon-port 7331 --agent echo
mebular service install mebular-serve      # 常驻守护（也可由 quickstart 默认安装）
mebular status                             # identityMode=root / 网络 / 锁 / 域 / join 服务

# 守护托管邀请 + 新机加入（B 无需主密钥 → delegated 身份）
fleet invite --dir ~/.mebular                       # 出令牌（守护签发）
fleet join  --token <内联|文件> --daemon --dir ~/.mebular --device device-B --agent echo
fleet pending --dir ~/.mebular
fleet approve --dir ~/.mebular --device device-B

# 本机 app 接口（loopback + bearer；非回环 fail-closed；单写者）
# GET /app/nodes?namespace=&type=&limit= · POST /app/nodes · GET /app/namespaces
# POST /app/policy/{grant,revoke,member,declare-issuer} · GET /app/policy/{effective,membership}
```

- **身份模式**：首台 `root`（持主密钥）；令牌加入的设备 `delegated`（仅委派链+设备钥，**无主私钥**）。`mebular doctor` 一并显示。
- **fleet 客户端化**：`fleet node|worker --store daemon` **不监听 libp2p、不托管 join**（网络/信任归守护）。
- **完整命令序列（真机审核侧参考）**：`npm i -g <repo>` → A `fleet quickstart --daemon` → `mebular service install mebular-serve` → `fleet invite` → B `fleet join --token … --daemon` → A `fleet approve` → `mebular doctor` / `fleet doctor` 双绿。

### 16.1 测试模式（embedded，**test/dev only**）

`--store embedded`（或未配置 `store`）保留**本地 Mebular**运行（现有 `verify:*` 与本地开发用）；旧 `~/.fleet` 目录**已从生产形态退役**，仅在显式 `--dir` 指向时作为测试目录使用，**不要用于生产**。
