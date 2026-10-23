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
| hover B（可达） | `hoverRouteCount = 2 × 可达目标数 + 不可达目标数`，出现蓝/金双向航道 |
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

任务事件由 **B 的真实 daemon** 经 `POST /app/nodes` 写入
（`type=task event`、`content.type=created`，与 `fleet task_submit` 落库形状一致），
随后走生产同步链路：B daemon `pushOnWrite` → libp2p → A 的 sync 应用 →
A 的 `/admin/events` 广播 `fleet`。脚本同时断言该任务事件确实出现在 A 的图里，
因此不是用 `sync` 事件或本地伪造数据冒充 fleet。

不使用 `/mcp task_submit` 的原因见下节「未解决项」；这不是星图契约，而是守护与
任务工具共用 home 时的写入可见性问题。

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

## 未解决项（仅报告，不在本测试内改生产代码）

1. **本机设备在 `/admin/api/devices` 中 `online=false`。**
   `collectOnlinePeers()` 只统计已建立连接的 peer，root 自身不在其中；前端
   `taskDomainState()` 要求 `online === true`，于是 hover 任意设备时本机被算作
   「任务域不可达」。实测 hover B 的 tooltip 为「3 台可达，2 台不可达」（应为
   4 台可达、仅 F 不可达），画面上本机到 B 也是灰色。最小复现：任意单机 daemon
   `GET /admin/api/devices`，本机条目 `online:false`。mock 数据把 self 写成了
   `online:true`，两边不一致。
2. **`/mcp task_submit` 在已运行的 daemon 上不会触发同步。**
   任务工具用 `offlineMebularOptions` + 同一个 storage 另开一个 `Mebular` 实例写
   JSONL；daemon 的 `EventLog`（`JsonFileStorage extends MemoryStorage`）只在启动时
   装载，收不到这次 append。实测 B 的 store 有 `task event/created`，但 A/C 在
   30s 内都没有该事件（anti-entropy 5s 一轮），A 的 SSE 也没有 `fleet`。因此本
   E2E 改用守护自身的 `/app/nodes` 写入，保证走真实的 daemon → sync → SSE 链路。
3. **视觉观察（不列为测试失败）：当前基线的 hover/fleet 航道是直线偏移。**
   `packages/console/starfield.js` 的 `_lineGeometry` + `_drawRoutes` 用
   `moveTo/lineTo` + 法线偏移绘制；按新的视觉契约，基础边是直线，但 hover 蓝/金、
   灰色不可达与 fleet 航线应保留旧版弧线（二次曲线/双向偏移）。本 E2E 只断言
   存在/方向/计数，不检查几何，因此不会把直线或弧线任一实现判失败；需要实现侧
   修复后以截图目检为准。
