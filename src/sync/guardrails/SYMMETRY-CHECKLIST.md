# 对称性检查清单（订阅自主）

| # | 轴 | A 端 | B 端 | 一致性判据 | 信号 |
|---|---|---|---|---|---|
| ① | 域目录 | 公告 ∪ 本地节点 | 公告 ∪ 本地节点 | 公告随 `__policy__` 同步，未订阅也可见 | `GET /admin/api/namespaces` 的 `declaration` 字段 |
| ② | 订阅记录 | 自声明 `author === member` | 自声明 | 同一 `(ns, member)` 最新 `active` 胜出 | `/app/policy/subscriptions` |
| ③ | 供给裁剪 | `trust ∩ localSub ∩ peerSub` | 同构 | 对端有记录看记录；无记录回退 hello | `SyncResult.noSubscriptionOverlap` / `subscriptionRejected` |
| ④ | 订阅热生效 | 运行期 setter + `__policy__` nudge | 同构 | 不重启即生效 | `sync-completed.sentEvents > 0` |
| ⑤ | 移出 | 作者级 `blocked` | 同构 | 只拒作者本人；不沿证书链 | `getBlockedDevices()` |
| ⑥ | 恢复 | `device_restore` + E-1 | 同构 | 旧纪元策略不复活 | `PolicyState.restoreAt` |
| ⑦ | 安全档 | `security_tier` 决定性 | 同构 | 同一事件集同一档位/会签/admitted | `getSecurityTier()` |
| ⑧ | 策略指纹 | `hashPolicyState` | 同构 | subscriptions/blocked/security 一致 | 会话尾 `stateFingerprints.policy` |
| ⑨ | 配置面 | `peerWhitelist`（连接准入） | 本地 | 不是域授权 | 连接登记日志 |
| ⑩ | 域公告 | `namespace_declare` | 同构 | 建域零门槛、全网可见 | 目录对比 |

**明确不存在**：对端 × 按域白名单、grant/issuer、自动签发、链级连坐。
