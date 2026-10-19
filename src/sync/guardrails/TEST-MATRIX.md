# 测试矩阵（订阅自主）

| 轴 | 用例 | 锚点 |
|---|---|---|
| 订阅即读 | 两台设备各自订阅 → 双向数据 | `tests/sync/subscription-autonomy.test.ts` |
| 自声明 | `author !== member` 不采纳 | `tests/sync/policy-invariants.test.ts` |
| 域公告 | 新域未订阅也可见；订阅后才可读 | `tests/sync/subscription-autonomy.test.ts` |
| 供给裁剪 | trust ∩ localSub ∩ peerSub；无记录回退 hello | `tests/sync/namespace-selective-sync.test.ts` |
| 订阅热生效 | setter + 端点 + nudge，无需重启 | `tests/sync/subscription-autonomy.test.ts` |
| 移出 | 作者级隔离；不连坐后代 | `tests/sync/event-trust-revocation.test.ts` |
| 恢复 | `device_restore` + E-1；旧订阅不复活 | `tests/sync/device-restore.test.ts` |
| 安全三档 | H1：仅首次 active 订阅要 join 会签 | `tests/sync/security-tier.test.ts` |
| 水位/快照 | per-(peer, ns) 水位；快照按订阅裁剪 | `tests/sync/namespace-watermarks.test.ts` |
| 策略指纹 | subscriptions/blocked/security 确定性哈希 | `tests/sync/convergence-fingerprints.test.ts` |
| 净删除 | 旧符号 0 引用 | `rg` 门禁 + `scripts/check-cleanliness.mjs` |

R1-6 已从「grant/membership 首现」改为「subscription 首现」；R-d 恢复用例改为 `device_restore` + E-1。
