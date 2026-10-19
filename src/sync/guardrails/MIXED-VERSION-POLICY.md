# 混合版本策略（greenfield）

**不做混跑，不做兼容层。** 本仓库当前是订阅自主模型的单一目标态：

- 旧端不认识 `namespace_subscription` / `namespace_declare` / `device_restore` → 少收、不可参与（安全方向）；
- 旧端的授权/成员制事件类型在新端是未知类型：入日志但不物化、不参与推导；
- 部署要求全端同版本。发布说明必须标注破坏性变更：
  - 成员制记录 → `namespace_subscription`（`data.subscription`）；
  - 新增 `device_restore`（恢复纪元 E-1）；
  - 新增 `namespace_declare`（域公告）；
  - 旧授权事件类型删除；
  - 加入令牌删除自动授权/TTL 字段，高档次订阅证明改用 `securityApproval`。

不提供「新旧混跑窗口」测试矩阵；相关旧测试已随净删除一并删除。

安全三档记录 `security_tier` / `security_approval` / `security_recovery` 保持不变。
