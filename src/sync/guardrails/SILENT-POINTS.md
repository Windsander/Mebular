# 静默点清单（订阅自主）

> 信任与订阅（trust / grantPolicy / namespacePolicy）→ 守护接线（packages/mcp）。

| 静默点 | 现在的发声方式 |
|---|---|
| 对端自称订阅但它有退订记录 | `SyncResult.subscriptionRejected` + `sync-subscription-rejected` 事件 |
| 双方没有任何订阅交集 | `SyncResult.noSubscriptionOverlap` |
| 未知事件类型 | `SyncResult.unknownEventTypes` |
| 被移出作者的事件被隔离 | 入站不 ack；审计时间线显示 `device_revoke` |
| `device_restore` 被拒绝 | `PolicyState.security.rejections`（`missing-proof` / `invalid-proof` / `self-restore`） |
| `namespace_subscription` 替他人声明 | `rejections: foreign-subscription` |
| 恢复后旧订阅不复活 | `restoreAt` + 审计 `device_restore` |
| 策略指纹不一致 | `sync-fingerprint` 事件（只告警，不改变供给） |

**已删除的静默点**：grant/issuer 自动签发、成员制 legacy-empty、链级连坐。
