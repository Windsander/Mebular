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

- **Plan readiness（提交前）**：`plan.owner` 必须是提交者设备/Agent；`planAgent` 必须属于本机 `config.agents[].name`，否则 `PLAN_POLICY` + `PLAN_OWNER_UNEXECUTABLE`，不创建 plan/root。`echo`/`board` 只是 demo/测试（确定性 fake executor / 任务板占位），**不作为生产 plan owner 或 MR 目标**；生产 owner 必须是真实可执行 Agent。MR 目标固定为 `plan.owner` 的 `{device,agent}`，`dispatch="root-only"`。入口只有 `task_submit.plan` / `task_status.plan` / `fleet doctor`（设备/订阅/身份自检，不替代 owner readiness）与文档；**Console 不加 Fleet UI**。
- **Agent 执行口径**：Hermes 可执行；OpenChamber 仅经 oc-hermes-bridge 可执行（无桥 dispatch-only）；DSH v1 用 `dsh --profile headless "<job>"` 作为执行宿主（`dsh --profile sdk` 是 v2；`@mebular/dsh-plugin` 是 Web/记忆桥，不是 Fleet executor）；OpenCode（`opencode run`）与 Claude Code（`claude -p`）待 adapter；Cursor 仅在有 `cursor-agent` 时可执行，否则 dispatch-only；Claude Desktop 只能 dispatch-only。完整矩阵见 [`DESIGN.md`](DESIGN.md) §2.5.3。
- **远端 Agent**：adapter 在执行设备本地；目录只发布 `kind + capabilities + executable + executionMode`（0.3.2 目标口径），command/env/token 永不过网。
- plan 节点提交后，由 **plan owner 设备**上的 `fleet node --run-forever` 或 `fleet worker --run-forever` 周期性推进（两者都会 tick materializer）；daemon 模式经内部 `/app/plans` 读取 plan。
- materializer 只创建依赖已满足、且 route/显式 `to` 通过硬过滤的 step task；join/reduce 在全部 `dependsOn` step complete 后才创建。
- **MR 门禁**：root plan 恰好一个 `kind=mr` sink，target 固定为 plan.owner 的 `{device,agent}`，`dispatch="root-only"`；只有所有非 MR step complete 且直接 pre-MR gate（join/reduce all）complete 才创建。MR 按 root `planId` 跨版本唯一：非终态等待、done 才让 root plan done、failed 不重试。
- **失败/取消**：失败 step 走新 plan version + `reuse`；旧 MR 存在时禁止重试版本。`task_cancel(rootTaskId)` 为 plan 级取消（root failed CANCELLED + 清理该 version 非终态 step task 及派生树，已提交 MR 不撤销）；`task_cancel(stepTaskId)` 只取消该 step 子树，plan 派生为 failed。
- 进程重启后从 plan + task 事件恢复，不需要 cursor；确定性 taskId/eventId 保证不重复建 task。
- 默认只推进 owner device 的 plan；未授权设备不应运行 coordinator。
- **sub-plan Agent 绑定**：MCP 任务工具缺省 Agent 是 `board`；宿主必须注入真实执行 Agent，且必须与父 step task 的 `to.agent` 一致，否则 B8 拒绝。默认 MCP sub-plan 不会自动把 `ctx.agent` 对齐到父 step；调用方需显式传正确的 `ctx.agent`（或配置 `defaultAgent` 与父 step 一致）。
- **MCP 默认 plan owner（B1/B1-R）**：普通 task 的默认 agent 仍是 `board`（旧语义不变）；plan 提交使用独立 `planAgent = ctx.agent ?? config.defaultAgent ?? config.agents[0]?.name ?? "board"`。`defaultAgent` 必须是 `config.agents[].name` 之一；最终 `planAgent`（含显式 `ctx.agent`、`defaultAgent`、`agents[0]`、`board` fallback）也必须属于本机配置，否则返回 `PLAN_POLICY` + `PLAN_OWNER_UNEXECUTABLE`，不创建 plan/root。若 `plan.owner.agent="board"` 且 `planAgent !== "board"`，服务端把 owner 归一化为 `planAgent`，MR 也落到该 agent；非 board 的显式 owner 仍必须等于 `planAgent`。
- **daemon CLI 边界**：无 live app 时 `task_targets` / `task_negotiate` / `chatter_*` 为 fail-closed（不回退本地离线 Mebular）；MCP live 路径正常。plan/task/role card 的 daemon 读写已由 `/app/plans`、任务事件和 `/app/role-cards` 覆盖。
- **/app/plans 信任边界**：owner/agent 是设备级 app token 下的自证；该内部端点不在 P2 扩权。`parentTaskAccepted` 是 fleet 内部派生上下文（root 是否已存在），外部直接传 true 不构成信任边界。
- **/app/plans 负例覆盖**：C/join/reduce/mr 的 HTTP 负例可继续依赖 validator；不额外扩 P2 端点测试。
- **双守护 E2E**：`npm run verify:fleet:p6` 启动两个真实 daemon/app loopback，验证 B 的卡片经 sync 到 A、`/app/peers` 的已认证在线公钥验签、daemon materializer 路由到 B、daemon CLI plan submit/status 与 MR 一次。

## 2.2 Route + policy（P3）

- **目标来源**：P1 能力卡（已验签/active/非 tombstone）+ sync 在线 peer + 本机任务视图/观察；显式 `to` 也只考虑该目标。
- **硬过滤**：L1 授权 → policy `allowedDevices/allowedAgents/requireCapabilities` → `route.require`/工具 → payload 可达 → 在线/容量。显式 `to` 不通过即 blocked，**不会改派**。
- **同 tick 容量**：materializer 每成功 append 一个 task 就实时递增该 `(device, agent)` 的 inflight；后续 step（含显式 `to`）满载返回 `AT_CAPACITY`，不建 task。
- **无 routing provider**：materializer fail-closed（blocked `routing-unavailable`），不走 P2 无硬过滤路径；生产 CLI embedded/daemon 都会注入 provider。
- **daemon 远端卡片验证**：daemon 无本地 `Mebular`，远端能力卡签名通过内部 `GET /app/peers` 返回的**已认证在线 peer 公钥**校验；旧守护没有该端点、或 peer 离线时远端 route/显式 `to` **fail-closed**，不伪造通过。`/app/peers` 只取 sync 握手登记的在线 peer，不回退 `config.peers` 地址簿。
- **daemon L1 授权**：`DaemonAgentBackend.getSubscriptions()` 走只读 `/app/policy/subscriptions?device=`；只有订阅任务 namespace 的 peer 才进入授权集合，查询失败不授权，**绝不**回退 `config.peers` 地址簿。
- **可解释性**：`task_status.plan` 的 step 可额外返回 `why`/`blockedBy`；已物化 step 也会返回当前确定性 route 的 additive 审计 `why`（不改变 status/taskId）。`why.policy="inherited"` 表示实际生效的 plan policy，不是新授权来源。`why` 只含标签/计数/原因码，不含原始对话、command/env/凭据。
- **角色卡（P5/P6）**：本机 runtime job 从任务历史（可选 memory runtime internal compact/checkpoint 摘要）生成 `agent_role_card` internal 节点，默认 `shadow=true`，只写 `agents` 域；`fleet node/worker --run-forever` 每完成 N 个任务（默认 5）且超过最小间隔（默认 60s）后低频生成。daemon 模式经内部 `/app/role-cards` 写读，author 固定本机守护设备，不新增公共 MCP/UI。写路径（生成器/append/daemon）统一从安全字段重建 `summary`；**读路径（embedded/daemon/远端旧卡）同样重建 summary**，不暴露历史 raw summary。`agent` 与 `provenance.source/generator` 只接受安全 token，拒绝空白/路径/引号/原文；直接 summaries 必须带本机 `device`。生成器只写固定安全标签白名单（如 code/test/docs/review）和真实任务/plan ID、内容哈希、ULID/UUID 证据；不复制 intent/摘要原文。
- **shadow 语义**：`roleCards.enabled` **默认 false**，在 P6 真实 shadow 报告完成前**不得开启**。默认 route 行为与无卡完全一致（`why.roleCard="shadow-ignored"`；无卡 `"disabled"`）。只有显式 `roleCards.enabled=true`、卡片 `shadow=false` 且 `confidence>=0.5` 时，角色卡才作为 P3 软排序最后一项（`why.roleCard="used-soft"`）；永不参与授权/硬过滤/容量，低置信度/无卡回退能力卡 + 确定性分配。
- **join/MR**：P4 已实现 join/reduce/MR 门禁；P3 角色卡在 P5 进入 shadow，不做人工审核入口。

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

## 7. P6 三机 E2E、回归与硬化

### 7.1 一条命令

```bash
npm run build
npm run verify:fleet:tasks
npm run verify:fleet:p6
```

`verify:fleet:p6` 覆盖：
- embedded loopback A/B/C/D/J：plan 提交 → B/C/D 分支 → J `all` join → pre-MR reduce → MR(owner A) → root done；MR 恰好一次、任务图无重复、`task_status.plan` 的 status/why/blockedBy；
- 重复投递/重复提交、coordinator kill/restart、plan cancel 级联、分支失败 v2 + `reuse`；
- 双 daemon/app loopback：卡片经 sync 到对端、`/app/peers` 已认证公钥验签、daemon materializer 路由、daemon CLI plan submit/status、内部 role/plan 端点。

### 7.2 旧版本与 MR 收敛（P6 硬化）

- 新版本接管后，旧版本 root 不再永久悬挂：缺失 root 会补建并写 `failed(SUPERSEDED_BY:<newVersion>)`；无 MR 的旧版本同时清理未终态 step task。
- 旧版本已存在 MR 时，MR 唯一性优先：
  - MR pending → 旧 root 保持 active 等待，MR 不撤销；
  - MR done → 旧 root 按 MR 回执收敛 done（acceptance/subtree 仍校验），当前版本 root 也按跨版本回执 done；
  - MR failed/acceptance failed → 旧 root 保留失败证据（`MR_FAILED`/`MR_ACCEPTANCE_FAILED`），不重试 MR。
- `task_cancel(rootTaskId)` 在 MR pending 时取消该 MR（`failed(CANCELLED)`），之后不得再创建新 MR；已 terminal done 的 MR 永不撤销，root 已终态返回 `already-terminal`。
- MR 创建使用确定性 taskId/eventId；同进程并发 materializer 由 eventId 串行，跨进程由事件去重收敛。**不要**让两台设备同时以 `coordinateForeignPlans` 运行同一 plan；本期没有 leader 选举，owner 设备是唯一正常 coordinator。

### 7.2.1 CR-003 内部 app 端点（已批准）

只允许 `/app/nodes`（optional metadata；raw debug 拒绝 card/role/plan 写入）、`/app/capability-cards` POST、`/app/plans` POST/GET、`/app/role-cards` POST/GET、`/app/peers` GET；默认 loopback；非 loopback 仅 TLS+bearer/scope 且需显式部署；internal metadata，不新增公共 MCP/UI/TaskEvent。除此之外仍按“不新增公开/内部 HTTP 端点”执行。

### 7.3 已知限制（P6 记录，不伪造通过）

- 五节点 P6 E2E 使用进程内 `InMemoryHub` + 确定性 event bridge（eventId 幂等复制）隔离 anti-entropy 调度抖动；真实 libp2p 证据仅限 `verify:fleet:tasks`（2 节点）与 `verify:daemon:cluster`（双守护 2 节点）；`routing-e2e` 同样使用嵌入式 loopback，不作为真实 libp2p 证据。不声称真实 3+ 节点 plan E2E 或 5 节点真实 WAN 性能。
- daemon 远端卡片验证依赖 `/app/peers` 中**当前在线**的已认证 peer 公钥；peer 离线时远端路由 fail-closed。旧守护无 `/app/peers` 时行为等同 P3 的“只信任本机公钥”。
- `plan.example.json` 的 join/reduce 步骤必须带 `to` 或 `route`，否则运行时按 `NO_TARGET` 阻塞（协议合法不等于可执行）。
- 旧 worker 只执行普通 task；`to.device/agent="__plan__"` 的 root task 必须跳过，不写 failed/UNKNOWN_AGENT。
- P7 `p7-blockers` 测试是 **handler 级**（直接调用 `TASK_TOOLS` handler + 真实 Mebular/store/materializer），不是真实 MCP transport；真实 MCP stdio/HTTP 默认 plan 仍由 `tests/fleet/surface.test.ts` 的统一入口和既有 MCP 套件覆盖。
- 角色卡默认 shadow；P6 未开启生产软排序。`roleCards.enabled=true` 仍是内部/测试配置，需真实 shadow 报告与审核。
- 本期无 claim/lease/抢单、无跨 plan 依赖、无执行中改图；任何此类需求走 CR。
