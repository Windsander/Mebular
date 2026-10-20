# 订阅自主 · 策略不变量（greenfield）

> 系统只有四个概念：**设备（信任链）· 订阅（阅读权 + 维持义务）· 移出（唯一否定）· 安全档（动作门槛）**。
> 没有第二条授权轴：没有 grant / revoke / issuer / 自动签发 / 对端×按域白名单。

## 1. 记录类型

| 事件（`__policy__`） | 含义 | 参与推导 |
|---|---|---|
| `namespace_subscription` | 设备对某记忆域的自声明（`active:true/false`） | 是 |
| `namespace_declare` | 域公告（自签名，零门槛） | 目录可见性 |
| `device_revoke` | 移出设备（事件名保留；UI「移出」） | 是 |
| `device_restore` | 恢复设备 + 恢复纪元 E-1 | 是 |
| `namespace_handoff` | 退出并交接审计 | 否 |
| `security_tier` / `security_approval` / `security_recovery` | 安全三档 | 是 |

旧授权事件类型（grant / revoke / issuer / membership）不再识别：未知类型不参与推导。

## 2. 规则代号

| 代号 | 含义 |
|---|---|
| **S-1** | 自声明：`namespace_subscription` 仅 `author === member` 时采纳；禁止替他人订阅/退订 |
| **R-b** | 作者级移出：被移出作者本人的策略记录不采纳（含历史）；**不沿证书链传播** |
| **R-c** | 逻辑时间定序：同作者 `seq` / 跨作者 `sum(vectorClock)` / `(author,id)` 兜底；不看墙钟 |
| **E-1** | 恢复纪元：最近一次被采纳 `device_restore` 位次之前的策略记录不采纳 |
| **H-1** | 加入首记：high 档下设备**首次** `active=true` 订阅需 `cosign(op:'join')`/`breakGlass`；通过后订阅任何域自主、无需会签 |

## 3. 记录 × 状态矩阵

| 记录 | 作者状态 | 对象状态 | 期望 | 覆盖 |
|---|---|---|---|---|
| `namespace_subscription(active)` | 可信、未被移出、`author === member` | member 未被移出；E-1 通过 | 采纳：member 进入该域订阅者集合；该域进入权威模式 | S-1 |
| `namespace_subscription` | `author !== member` | — | **不采纳**；进 `rejections`（`foreign-subscription`） | S-1 反例 |
| `namespace_subscription(active=false)` | 可信、未被移出、自声明 | — | 采纳：member 移出；不 seed/admitted、不触发会签 | 退订 |
| `namespace_subscription` | 被移出（R-b 含历史） | — | **不采纳** | R-b |
| `namespace_subscription`（恢复前） | 已恢复设备 | — | **不采纳**（E-1） | 纪元 |
| `namespace_subscription`（high 首现） | 可信、未被移出 | 无证明 | **不采纳**；不进 `admitted`；`missing-proof`/`invalid-proof` | H-1 |
| `namespace_subscription`（high 首现） | 可信、未被移出 | 有效 `cosign(op:'join')`/`breakGlass` | 采纳；进 `admitted` | H-1 |
| `namespace_declare` | 可信、未被移出、E-1 通过 | — | 采纳：进入域目录（可见 ≠ 可读） | 公告 |
| `device_revoke` | 可信、未被移出 | subject 未移出 | 采纳：subject 进 `blocked` | 移出 |
| `device_revoke` | 被移出 | — | **不采纳**（R-b 含历史） | R-b |
| `device_revoke` | `subject === author` | — | **不采纳**（自移出） | 自否定 |
| `device_revoke`（high） | 可信、未被移出 | 无证明 | **不采纳**；`rejections` | 安全档 |
| `device_restore` | 可信、未被移出、`author !== subject` | subject 当前被移出 | 采纳：移出 → 未移出；记 `restoreAt`；旧纪元策略失效 | E-1 |
| `device_restore` | 可信、未被移出 | subject 未被移出 | **no-op**（防洗历史） | E-1 |
| `device_restore` | `author === subject` | — | **不采纳**（自恢复） | 自否定 |
| `device_restore`（high） | 可信、未被移出 | 无证明 | **不采纳**；`rejections` | 安全档 |
| `security_tier` / `security_approval` / `security_recovery` | 同原语义 | 同原语义 | 不变；seed 口径更新；拒绝原因含 `approval-missing-or-not-causal` | 安全三档 |

## 4. 横切不变量

1. **排列不变性**：打乱 block/restore/subscribe/declare 输入，`blocked`/`subscriptions`/`declarations`/`restoreAt` 一致。
2. **幂等**：重复推导一致。
3. **自声明闭包**：输出订阅者集合 ⊆ 自声明 `active=true` 的作者集合。
4. **R-b 闭包**：输出 `blocked` 中设备的记录不被采纳（含历史 + 回退路径）。
5. **E-1 闭包**：恢复位次之前的策略记录不进入 `subscriptions` / `security` / `admitted`。
6. **有界**：迭代上限是输入的确定纯函数 `2·|entries|+2`；未收敛回退只增不减，`converged=false` 可观测。
7. **无墙钟**：`issuedAt/expiresAt` 不参与采纳。
8. **无授权轴**：`PolicyState` 没有 `authorized`/`issuers`/`members`；读权只能由 `subscriptions` + `blocked` + 信任边界解释。
9. **无链级连坐**：`blocked(author) ⇒ 该作者的记录不采纳`；`blocked(ancestor) ⇏ 拒绝 descendant`。

## 5. 扰动检查

- **S-1**：删掉所有 `author !== member` 的订阅记录后重跑，结果不变。
- **R-b**：删掉输出 `blocked` 里设备署名的全部策略记录后重跑，`subscriptions`/`blocked` 不变。
- **E-1**：对已恢复设备，删掉恢复位次之前的全部策略记录后重跑，结果不变。
- **H-1**：删掉 high 档未带证明的首现订阅后重跑，结果不变。
- **无链级连坐**：把被移出设备的祖先从 `blocked` 中加入/移除后重跑，后代作者的事件采纳结果不变。

## 6. 供给链

```text
send(peer, ns) ⇔ trusted(peer) ∧ localSub(ns) ∧ peerSub(peer, ns)
```

- 没有「对端授权」项；
- 对端有该域的订阅记录 → 记录权威（`active=false` 即不订阅）；
- 对端没有任何该域记录 → 回退 hello 会话声明（首个会话 bootstrap）；
- `__policy__` 始终放行（策略事件无需订阅即可见）。

## 7. 测试锚点

- `tests/sync/security-tier.test.ts`：安全三档 + H1 首现。
- `tests/sync/policy-invariants.test.ts`：S-1 / R-b / E-1 / 排列不变。
- `tests/sync/subscription-autonomy.test.ts`：订阅即读、零授权记录。
- `tests/sync/device-restore.test.ts`：移出 → 恢复 → 重新订阅。
- `tests/sync/namespace-selective-sync.test.ts`：供给裁剪与快照裁剪。
