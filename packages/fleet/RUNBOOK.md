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

## 2.1 Plan materializer（P2/P4）

- plan 节点提交后，由 **plan owner 设备**上的 `fleet node --run-forever` 或 `fleet worker --run-forever` 周期性推进（两者都会 tick materializer）；daemon 模式经内部 `/app/plans` 读取 plan。
- materializer 只创建依赖已满足、且 route/显式 `to` 通过硬过滤的 step task；join/reduce 在全部 `dependsOn` step complete 后才创建。
- **MR 门禁**：root plan 恰好一个 `kind=mr` sink，target 固定为 plan.owner 的 `{device,agent}`，`dispatch="root-only"`；只有所有非 MR step complete 且直接 pre-MR gate（join/reduce all）complete 才创建。MR 按 root `planId` 跨版本唯一：非终态等待、done 才让 root plan done、failed 不重试。
- **失败/取消**：失败 step 走新 plan version + `reuse`；旧 MR 存在时禁止重试版本。`task_cancel(rootTaskId)` 为 plan 级取消（root failed CANCELLED + 清理该 version 非终态 step task 及派生树，已提交 MR 不撤销）；`task_cancel(stepTaskId)` 只取消该 step 子树，plan 派生为 failed。
- 进程重启后从 plan + task 事件恢复，不需要 cursor；确定性 taskId/eventId 保证不重复建 task。
- 默认只推进 owner device 的 plan；未授权设备不应运行 coordinator。
- **sub-plan Agent 绑定**：MCP 任务工具缺省 Agent 是 `board`；宿主应注入真实执行 Agent，且必须与父 step task 的 `to.agent` 一致，否则 B8 拒绝。
- **daemon CLI 边界**：无 live app 时 `task_targets` / `task_negotiate` / `chatter_*` 为 fail-closed（不回退本地离线 Mebular）；MCP live 路径正常。daemon-backed 读取留 P6。
- **/app/plans 信任边界**：owner/agent 是设备级 app token 下的自证；该内部端点不在 P2 扩权。`parentTaskAccepted` 是 fleet 内部派生上下文（root 是否已存在），外部直接传 true 不构成信任边界。
- **/app/plans 负例覆盖**：C/join/reduce/mr 的 HTTP 负例可继续依赖 validator；不额外扩 P2 端点测试。
- **测试空白**：双守护进程 E2E 留 P6；当前覆盖单守护 + CLI/materializer 与三机 loopback join/MR。

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

## 2.2 Route + policy（P3）

- **目标来源**：P1 能力卡（已验签/active/非 tombstone）+ sync 在线 peer + 本机任务视图/观察；显式 `to` 也只考虑该目标。
- **硬过滤**：L1 授权 → policy `allowedDevices/allowedAgents/requireCapabilities` → `route.require`/工具 → payload 可达 → 在线/容量。显式 `to` 不通过即 blocked，**不会改派**。
- **同 tick 容量**：materializer 每成功 append 一个 task 就实时递增该 `(device, agent)` 的 inflight；后续 step（含显式 `to`）满载返回 `AT_CAPACITY`，不建 task。
- **无 routing provider**：materializer fail-closed（blocked `routing-unavailable`），不走 P2 无硬过滤路径；生产 CLI embedded/daemon 都会注入 provider。
- **daemon coordinator 限制**：daemon 没有本地 `Mebular`，远端能力卡通常无法取得已认证公钥验签 → 远端 route/显式 `to` **fail-closed**，不伪造通过；双守护 E2E 的远端公钥/卡片验证留 P6。
- **daemon L1 授权**：`DaemonAgentBackend.getSubscriptions()` 走只读 `/app/policy/subscriptions?device=`；只有订阅任务 namespace 的 peer 才进入授权集合，查询失败不授权，**绝不**回退 `config.peers` 地址簿。
- **可解释性**：`task_status.plan` 的 step 可额外返回 `why`/`blockedBy`；`why.policy="inherited"` 表示实际生效的 plan policy，不是新授权来源。`why` 只含标签/计数/原因码，不含原始对话、command/env/凭据。
- **角色卡/join/MR**：P4 已实现 join/reduce/MR 门禁；P3 角色卡仍未接入（`roleCard="disabled"`），P5 才进入 shadow。
