# 测试矩阵盘点（C5 · 护栏包⑤）· 方向 × 形态 × 版本

> **性质**：只读盘点（现状 = `main@bbc2e13` 实测清单；缺口 = 我方建议）。
> **边界**：**cluster 四方向矩阵（A→B、B→A、委派↔委派、重连/双拨）由 P1 主修负责实现与执行**；
> 本文只登记其依赖关系，重点列其余缺口与可自动化项。
> 相关：`MIXED-VERSION-POLICY.md`（C3，§5 验证义务）；`SYMMETRY-CHECKLIST.md`（C2，对账判据）。

## 0. 维度定义

- **形态**：F1 库/门面（`Mebular` 进程内，InMemory 或真 libp2p loopback）；F2 守护（`mcp serve` 进程，
  daemon×daemon）；F12 **混合形态**（门面 ↔ 守护）；F3 WAN（relay / `/p2p-circuit` / L2 隔离网络）；
  F4 Fleet 客户端面（`daemon` store 模式；任务面依赖记忆面）。
- **方向**：数据方向（谁发给谁）与连接方向（谁拨谁）；含委派身份组合与恢复类场景（重连/双拨/退订/重入）。
- **版本**：同版本（现状唯一有覆盖的档）；**行为模拟**（新代码扮演旧端行为）；**真双版本**（两个
  git ref 的产物互连）；跨代（skip-version，不承诺）。
- CI 现状（`.github/workflows/ci.yml`）：`npm test` + `verify:fleet:all`、`verify:daemon`、
  `verify:daemon:cluster`、`verify:connect`、`verify:lan`、`verify:invite`、`verify:nat`、`verify:wan:l2`
  (+docker)、`verify:wan:cross:selftest`、mcp 系列。**下述带「CI」标记者为每 PR 门禁**。

## 1. 矩阵一：方向 × 形态（现状 vs 缺口）

图例：✅ 有自动化覆盖；◐ 部分覆盖（见注）；✗ 缺口。

| 场景（方向 × 性质） | F1 门面 | F2 守护 | F12 混合 | F3 WAN | F4 Fleet/守护客户端 |
|---|---|---|---|---|---|
| A→B 记忆同步 | ✅ `SyncManager.test`、`GraphSync.integration`（CI） | ◐ `verify-daemon:cluster` 断言「记忆经守护同步 A→B」（CI，**仅此一条**）；＋跨网一致性 `verify-mcp-cross`（非 CI，环境依赖） | ◐ `accept-auto-grant.mjs`（门面订阅方 ← 守护，手动脚本，非 CI） | ✅ `verify:wan:l2` ①（CI）；`wan-sync.mjs` | ◐ `verify:fleet:*` 任务面间接 |
| B→A 记忆同步 | ✅ `push-on-write` 双向（H/nudge）、`SyncManager` 双向 | ✗ **cluster 未断言 B→A**（#122 缺陷恰在此方向的经验盲区） | ✗ | ◐ `wan-sync cross`（取决于运行档） | ✗ |
| 委派↔委派（两端均 delegated） | ◐ 链校验单测（`cert-chain`、`TrustChain`）；双委派端到端会话 ✗ | ✗（P1 四方向第 3 项） | ✗ | ✗ | ✗ |
| 重连 / 双拨 / 静默重启 | ✅ `GraphSync.integration` F4 两方向；`SyncManager` 断线续传 | ◐ cluster 无重启/重连断言（P1 四方向第 4 项） | ✗ | ◐ `verify:connect` relay 降级/恢复（CI） | ✗ |
| 授权（grant）传播与生效 | ✅ `namespace-selective-sync`、`grant-policy`、`policy-issuer` | ◐ `verify:daemon` 单守护断言自动授权（C7）+ 作用域隔离（CI）；**跨守护传播 ✗** | ◐ `accept-auto-grant`（手动） | ✗ | ◐ `verify:fleet:grant` |
| 成员资格（M1–M3）传播与闸门 | ✅ `membership.test`（含伪造过滤） | ◐ cluster 只断言「成员表每机一条」；闸门/拒绝/传播 ✗ | ✗ | ✗ | ◐ `verify:fleet:membership` |
| 吊销隔离（作者级：入站/读侧；踢根机/中间设备不连坐） | ✅ `event-trust-revocation`、`grant-policy` | ✗ 无 daemon e2e | ✗ | ✗ | ✗ |
| 吊销可见性传播（`__policy__` 同步） | ✅ `policy-invariants`/`grant-policy` | ✗ | ✗ | ✗ | ◐ |
| 水位（F1/R1/R2/R3/F4） | ✅ `namespace-watermarks`、`snapshot-sync` | ✗ 无 | ✗ | ◐ `wan-sync` 用 `stateHashByNamespace` 硬判据 | ✗ |
| 离线队列跨重启 | ✅ `sync-state-persistence`、`GraphSync` 重启 | ✗ 无 daemon 级重启续传断言 | ✗ | ✗ | ✗ |
| 退订交接 2b / 重入 2c | ✅ `handoff.test`、`rejoin.test` | ✗ | ✗ | ✗ | ◐ `verify:fleet:handoff/rejoin`（面向任务/客户端语义，非记忆面四方向） |
| 反熵 / nudge 实时路径 | ✅ `anti-entropy`、`push-on-write`、`peer-frames` | ✗ 无定向断言（cluster 隐式依赖，未断言走哪条触发路径） | ✗ | ✗ | ✗ |

**注**：F2 的「◐」= 单条 A→B 记忆断言 + 成员表计数（`verify-daemon-cluster.mjs:123-131`）；
这正是 P1 探针指出的「连接方向与故障同构、断言只查没坏的方向」问题。

## 1.5 S1 安全三档（core）红绿矩阵

> 落点：`tests/sync/security-tier.test.ts`（R1-1…R1-12）＋ `tests/sync/policy-invariants.test.ts`
> （安全轴随机场景）。规格：SECURITY-TIERS-SPEC v1.1 §6.1。

| # | 场景 | 覆盖 | 状态 |
|---|---|---|---|
| R1-1 | 无 tier=low；medium 生效；R-c 最新胜出（乱序/幂等） | `security-tier` | ✅ |
| R1-2 | 被吊销签发者的 tier 记录不采纳（R-b 含历史） | `security-tier` | ✅ |
| R1-3 | 降级逃逸：无证明不采纳；有效 cosign 采纳；各失败原因归因 | `security-tier` | ✅ |
| R1-4 | medium→low 网络侧照常采纳（TOTP 本机门槛归 S2） | `security-tier` | ✅ |
| R1-5 | device_revoke @high：无证明/approver=subject/nonce 重放不采纳；有效 cosign 采纳 | `security-tier` | ✅ |
| R1-6 | 首现验收：新设备无证明不采纳且不 admitted；带证明采纳；历史成员不回溯 | `security-tier` | ✅ |
| R1-7 | 恢复码登记→消费（nonce 一次）→轮换；旧 key 新签名不采纳 | `security-tier` | ✅ |
| R1-7b | 初始登记：high 后裸登记不采纳；升档仪式内免证明；high 后 cosign(op:'rotate', oldKeyId='') 采纳；当前 key 的 cosign 轮换采纳 | `security-tier` | ✅ |
| R1-8 | 拒绝诊断：§3.4E 八类 reason 均出现在 `security.rejections` | `security-tier` | ✅ |
| R1-9 | 纯旧记录 golden 与基线逐字节一致；harness 含新类型后排列/幂等/oracle-free 全过 | `security-tier` · `policy-invariants` | ✅ |
| R1-10 | POLICY-INVARIANTS / SEALING / 护栏四件套同步；`npm test` 不降；CI 五项绿 | 本文档 + 测试内文档断言 | ✅（`npm test` 见 PR） |
| R1-11 | 无墙钟：`expiresAt` 已过去仍采纳；重复推导恒等 | `security-tier` | ✅ |
| R1-12 | 批准人事后吊销不回撤；其新批准不再有效 | `security-tier` | ✅ |

**混合版本**：S1 无行为模拟自动化（G-3 仍缺）；最低手工/脚本判据见
`MIXED-VERSION-POLICY.md` §5：旧端忽略新记录/字段、旧端裸记录 @high 不采纳且
`security.rejections` 可见。**未做**：真双版本互连（G-4）。

## 2. 矩阵二：版本维度（现状 vs 缺口）

| 版本档 | 现状 | 说明 |
|---|---|---|
| 同版本 | ✅ 全部自动化只跑此档（含一次性跨网 `verify-mcp-cross`，非 CI） | 唯一有系统覆盖的档 |
| 行为模拟（新代码→旧端行为） | ◐ 仅 1 例：`accept-auto-grant.mjs` ④a「老订阅端：只 hello、不写 membership → 中性态 + CLI 兜底」（手动脚本，非 CI） | 这是「legacy-empty 降级」的行为模拟，不是混合版本测试框架 |
| 真双版本（N-1 产物互连） | ✗ **零覆盖** | C3 政策 §5 要求的最低验证；当前没有任何脚本/CI 组合两个 ref。S1 安全三档的最低判据：旧端忽略 `security_*` 记录/证明字段，旧端裸记录 @high 新端不采纳 |
| 跨代（skip-version） | ✗（不承诺） | C3 §4：doctor/巡检应显式告警（当前无版本标识） |

## 3. 缺口清单与可自动化项

| # | 缺口 | 归属 | 可自动化方案（落点建议） | 断言要点 |
|---|---|---|---|---|
| G-1 | **F2 方向矩阵**：daemon×daemon 仅 A→B、无 B→A / 委派↔委派 / 重连 | **P1（主修）** | 扩 `scripts/verify-daemon-cluster.mjs`（或新脚本）：四方向各自写「设备自签事件（membership）+ 记忆」并断言对端落图 | 双向事件落图；角色互补；重连后水位续传不重发/不漏发 |
| G-2 | F12 混合形态矩阵（门面↔守护三组合） | 后续（本波登记） | 新脚本 `scripts/verify-daemon-mixed.mjs`：`Mebular` 门面（真 libp2p）↔ `serve` 守护，跑 A→B/B→A + 授权/成员传播；复用 `accept-auto-grant` 的 boot 工具函数 | 与 F1 断言同构（收敛、denied/membershipRejected 可见） |
| G-3 | **混合版本·行为模拟框架** | 后续（C3 §5 最高优先） | 单测 harness（`tests/sync/mixed-version-behavior.test.ts`）：注册「旧端适配器」——禁用 nudge、禁发快照、忽略 `namespace_membership`/`policy_issuer_declare`、不物化新事件类型——跑双向会话矩阵 | 每个降级项：旧端侧只「少收/慢；不越权」；新端侧有可解释信号（或明确接受静默的清单） |
| G-4 | 真双版本（N-1）互连 | 后续（CI 可选） | 两个 ref 各 `npm run build` → 复制两份 dist/工作树 → 跑 G-1 脚本变体；最低限度：门面级（同一进程加载两份构建不现实，用两进程 + 文件注入） | C3 承诺 A 类兼容 + B 类窗口规则 |
| G-5 | 策略/水位**跨端对账**（stateHash）的**周期化/常驻化** | **P3（收敛健康度）** | 已有原语与一次性脚本（`verify-mcp-cross`）；缺周期性对账：收敛健康度主计划落地（共同域相等断言 + 差异定位到分区/作者） | 静止窗口后全对相等；差异可定位、可呈现「未收敛/停滞」 |
| G-6 | daemon 级：吊销隔离、denied、membershipRejected 的**端到端负例** | 后续 | 扩 cluster 脚本：C 被吊销后 B 发送 → A 拒收计数；A 未授权 B → B 侧期望与实际对账 | 负例都「显式」（C1 的出口建议落地后） |
| G-7 | daemon 级：离线队列跨重启续传 | 后续 | cluster 脚本中重启 B（保留 home）→ 断言续传收敛 | `sync-state.json` 生效、不重发已 ack |
| G-8 | 反熵/nudge 触发路径的定向断言 | 后续 | 脚本内配置 `pushOnWrite`/`antiEntropy` 矩阵（开/关 × 两端），断言送达时延与触发源计数 | H 双向（nudge）成立；纯反熵兜底收敛 |
| G-9 | 版本面 lint / 巡检 | 后续 | `doctor`/巡检加：对端协议串合法、跨代对端告警（依赖 C3 §6 版本标识） | skip-version 显式拒绝而非随机协议错误 |
| G-10 | C1 静默点出口的回归测试 | 跟实现 | 每落地一个计数/告警出口 → 对应单测（触发场景 → 断言计数/事件） | 出口=观测到的信号 |

## 4. 使用与边界

- 本表只登记**现状与缺口**；新增/修改测试一律遵循仓库既有纪律（`SEALING_CN.md` §3 的破坏性协议
  变更需全端版本面、`POLICY-INVARIANTS.md` 的准入条件），不因「测试」名义夹带产品行为变更。
- `verify:*` 脚本跑 `dist` 产物：改动 core 后先 `npm run build`（fleet `PROTOCOL-INVARIANTS.md` §6 同纪律）。
- G-1 的最终形态以 P1 提案为准；本文与 P1 冲突时，以 P1 的「四方向矩阵」实现为基准、本文回填更新。
