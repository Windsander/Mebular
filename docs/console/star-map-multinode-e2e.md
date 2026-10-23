# 星图网络 · 真实 6 机 E2E

`npm run verify:star-map:multinode`（脚本：`scripts/verify-star-map-multinode.mjs`）

用 **6 个真实 daemon 进程**验证星图网络与远端 fleet，而不是前端 mock 或单进程内 6 个对象：

| 设备 | 角色 | 订阅 |
| --- | --- | --- |
| `device-A` | root（忆云根身份），console 所在机 | `tasks` |
| `device-B` | 委派身份，远端任务发起方 | `tasks` |
| `device-C` | 委派身份，远端任务目标 | `tasks` |
| `device-D` | 委派身份 | `tasks` |
| `device-E` | 委派身份 | `tasks` |
| `device-F` | 委派身份，**故意不订阅 `tasks`** | `solo` |

- 6 个独立 `MEBULAR_HOME`、独立 HTTP 端口、独立 `MEBULAR_HOME` 下的 `config.json` 与 daemon 进程；
  B..F 经 A 的 join service 取得委派证书链后，各自拨号 A。
- 所有设备都在同一个忆云（同一用户主密钥 + A 签发的委派链）。
- console 由 A 的 daemon 在 `/console/` 提供，headless Chrome 通过 CDP 读取真实 Canvas2D 场景。

## 断言（全部来自 `canvas.dataset` / SSE / API）

| 信号 | 期望 |
| --- | --- |
| `baseEdgeCount` | `15`（6 台两两全连接） |
| `solidEdgeCount` | `10`（A..E 共享 `tasks`） |
| `dashedEdgeCount` | `5`（F 无共同订阅域，至少 1 条虚线） |
| 未 hover `routeCount` | `0` |
| hover B（可达） | `hoverRouteCount = 2 × 可达目标数 + 不可达目标数`（本场景为 `4×2+1=9`），出现蓝/金双向航道 |
| hover F（不可达） | `hoverRouteCount = 5`，全部为灰色（单条、无方向） |
| 远端 fleet | A 的 SSE 收到 `fleet`，payload `from=B / to=C / eventType=created / namespace=tasks`；`fleetRouteCount` 从 0 增长，生命周期结束后回 0 |

`hover` 使用页面内合成的 `PointerEvent` 扫画布星位，走的是 `StarStage` 的真实命中测试；
断言不靠截图。截图与 `canvas-signals.json` 只作为附加证据。

### 视觉几何契约

- **基础边**（共同/无共同订阅）：直线（改动后的几何），E2E 不断言其形状。
- **hover 航道**（蓝 out / 金 in / 灰 blocked）与 **fleet 航线**：必须保留改动前的弧线
  几何（二次曲线 / 双向偏移，旧版 `_laneGeometry` 的味道），不得退化成直线。
- E2E 只断言通道的**存在、方向、计数与可达性**（`canvas.dataset.hoverRouteCount` /
  `routeCount` / `fleetRouteCount`），**不断言直线、曲率或端点坐标**，因此弧线改造不会
  让本测试变红。截图仅用于人工目检。

## 远端 fleet 的写法

脚本用真实 MCP client 连接 B 的 `/mcp`（initialize → `tools/call` `task_submit`），
向 C 派任务。自 #215 起 HTTP `/mcp` 会把运行中 daemon 的 live app 注入任务工具，
任务工具与守护共用同一 EventLog：B 的本地 append 触发 `pushOnWrite` → libp2p →
A 的 sync 应用 → A 的 `/admin/events` 广播 `fleet`。

断言链：

1. `task_submit` 返回 `ok=true` 与 `taskId`；
2. B 的 live graph / 事件日志含该 `taskId`（同一 daemon 的 `task_status` 返回 `queued`）；
3. 经真实 daemon sync，A 的 `task_status` 也返回该任务（from=B / to=C）；
4. A 的 console 收到 `fleet` SSE，payload `from=B / to=C / eventType=created / namespace=tasks`；
5. 画布 `fleetRouteCount` 0 → 1 → 生命周期结束回 0。

不使用 `POST` 节点接口绕开任务工具；任务由 B 的 daemon 自己产生。

## 运行

```bash
npm run build
npm run verify:star-map:multinode
# 可选：CHROME_PATH=/path/to/chrome npm run verify:star-map:multinode
# 证据目录：--evidence <dir>；保留临时 home/日志：--keep；无浏览器只跑拓扑：--skip-browser
```

- 无 Chrome/Chromium 时明确打印 `SKIP`（退出码 0），不伪造通过。
- 失败时保留 6 台 daemon 的 stdout/stderr、临时 root 路径与截图；成功时删除临时 home。
- 脚本按顺序启动 6 个 daemon，串行加入，避免端口/令牌竞争。

## 基线修复记录（本 E2E 复验）

- **self online**：`/admin/api/devices` 现在把本机标为 `online:true`（#215）；脚本断言 6 台全部在线。
  hover B 的航道为 4 台可达（双向）+ F 不可达（灰色）。
- **live task tools**：`/mcp task_submit` 复用运行中 daemon 的 app / EventLog（#215），不再另开
  离线 writer；本 E2E 全程走真实 MCP 路径，B 的 append 能触发 push-on-write 与 fleet SSE。
- **弧线航道**：hover 蓝/金、灰色不可达与 fleet 航线已恢复弧线几何（#216）；基础边保持直线。
  E2E 只断言计数/方向/可达性，不断言几何，避免把任一实现写死。

## 未解决项

无。若真实 `task_submit` 在后续改动中不再同步，脚本会保留 daemon 日志、A/B 图查询结果与截图，
并以 FAIL 退出，不会回退到节点接口伪造数据。
