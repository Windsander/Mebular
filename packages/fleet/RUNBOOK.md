# Fleet RUNBOOK（订阅自主）

## 1. 一条命令上车

```bash
# A（第一台）
fleet quickstart --daemon --dir ~/.mebular --device device-A

# B（第二台）
fleet join --token <令牌> --daemon --dir ~/.mebular --device device-B
```

- A 的 quickstart 会开启 join 服务并输出一次性令牌；
- 加入只建立入网信任；两端的订阅由各自声明；
- 订阅零门槛、热生效；没有「待批准」阶段。

## 2. 日常操作

```bash
fleet subscribe   --dir ~/.mebular --namespace notes
fleet unsubscribe --dir ~/.mebular --namespace notes
fleet subscribers --dir ~/.mebular --namespace notes
fleet namespace   --dir ~/.mebular --namespace notes   # 建域公告（零门槛）
fleet leave       --dir ~/.mebular --namespace notes --successor device-B
fleet rejoin      --dir ~/.mebular --namespace notes
fleet restore     --dir ~/.mebular --to device-B
fleet security revoke --dir ~/.mebular --device device-B
fleet doctor      --dir ~/.mebular --json
```

## 2.1 Plan materializer（P2）

- plan 节点提交后，由 **plan owner 设备**上的 `fleet node --run-forever` 或 `fleet worker --run-forever` 周期性推进（两者都会 tick materializer）；daemon 模式经内部 `/app/plans` 读取 plan。
- materializer 只创建依赖已满足且显式 `to` 的 step task；join/reduce/MR 执行属后续阶段。
- 进程重启后从 plan + task 事件恢复，不需要 cursor；确定性 taskId/eventId 保证不重复建 task。
- 默认只推进 owner device 的 plan；未授权设备不应运行 coordinator。

## 3. 供给与水位

- 供给 = **信任 ∩ 本机订阅 ∩ 对端订阅**；没有对端×按域白名单；
- 对端有该域订阅记录时记录权威；没有任何记录时回退 hello 会话声明；
- `sync.namespaces` 为空 = 订阅全部；控制台订阅开关走 `POST /admin/api/subscriptions`，热生效；
- **兼容升级（CR-002）**：旧 daemon `config.json` 若只写 `sync.namespaces: ["tasks"]`，启动期会**幂等**追加 `agents`（能力卡/Agent 目录）；无需改 UI 或手工迁移。若该键为空/缺省，仍保持“订阅全部”语义，不会被收窄。
- 水位按 `(peer, namespace)` 持久化；`fleet` 无独立水位命令，使用 `fleet doctor` 与 admin API 诊断。

## 4. 移出 / 恢复

- 移出：`device_revoke`（作者级，不连坐后代）；high 需会签/恢复码，medium 需动态码；
- 恢复：`device_restore` + E-1；恢复后旧订阅不复活，需重新 `fleet subscribe`；
- 对未移出设备的 restore 是 no-op；自恢复不采纳。

## 5. 常见故障

| 症状 | 处理 |
|---|---|
| 对端在线但没数据 | `fleet doctor` 看 `namespace 订阅` / `对端订阅`；确认双方订阅同一域 |
| 订阅后要等很久 | 确认走的是 `/admin/api/subscriptions`（热生效），不是旧配置保存路径 |
| 被移出后无法同步 | 由其他设备 `fleet restore --to <device>`，再由被恢复设备重新订阅 |
| 恢复后旧域仍收不到 | E-1：旧订阅不复活，重新 `fleet subscribe` |
| 某台设备邀请的下级仍同步 | 移出是逐台动作；需要时显式移出下级 |

## 6. 明确删除

`fleet grant` / `fleet revoke`（域授权）/ `fleet declare-issuer` / `fleet pending` / `fleet approve` 已删除；加入令牌不再有自动授权/TTL 字段；对端×按域白名单、引导签发者、自动签发配置键已删除。
