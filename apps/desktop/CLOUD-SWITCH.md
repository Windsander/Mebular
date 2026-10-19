# App 壳 · 忆云切换（E2-B）

> 范围：`apps/desktop/**`。后端注册表/切换引擎属于 E2-A1（`packages/mcp/src/profiles.mjs`、
> `cloud-switch.mjs`），控制台 UI 属于 E2-A2（`packages/console`）；本文件只描述 App 壳的编排契约。

## 运行时 home

- `home` 不再是常量：启动时由注册表 `current` 解析，切换成功后更新。
- `httpConf()` 每次调用都从当前 `home/config.json` 读 host/port；切换后控制台 URL、日志路径、
  健康探测自然使用新端口。
- child / service 两条启动路径都显式注入：

```
MEBULAR_HOME=<cloud home>
MEBULAR_CLOUD_ROOT=<root>
ELECTRON_RUN_AS_NODE=1
```

- `@mebular/service` 的 `ServiceOptions.home` 固定为 **OS 用户 home**（plist/manifest 落盘位置），
  不是忆云 home；忆云身份由 `MEBULAR_HOME` + `MEBULAR_CLOUD_ROOT` 携带。

## IPC / preload

| channel | preload | 语义 |
| --- | --- | --- |
| `cloud:list` | `cloudList()` | 只读注册表视图（无秘密） |
| `cloud:switch` | `cloudSwitch(id)` | 停旧/起新/校验/回滚；成功后 App 重载控制台 |
| `cloud:manage` | `cloudManage()` | 打开控制台 `?view=settings&focus=clouds` |

`cloud:switch` 只接受 1 个字符串参数，主进程再按 `^[a-z0-9_]+$` 校验。没有删除忆云的通道。

控制台 A2 已实现「切换」前的危险确认（当前忆云会归档保留）；App 不重复弹二次确认。

## 切换状态机

```
停旧守护（child / service / lock PID）
  → 等旧 <home>/lock 与 /healthz 释放
  → 注册表 current=<to>（引擎写 switch.intent.json）
  → 起新守护（沿用旧忆云的 service/child 模式与 autostart）
  → 等待 /healthz：instance === homeKey(newHome) 且 cloudId === <to>
  → 成功：清 intent、重载控制台、updateTray、重置 daemon 状态
失败：abort 半启动的新守护 → current 回 <from> → 按原模式重启旧守护 → 清 intent
```

- 切换只改注册表 current 与进程/服务，**不复制、不合并、不删除**忆云目录。
- 原忆云在控制台显示「已归档」，需要时可切回。
- 当前忆云不可切换（引擎返回 `changed:false`）。
- 旧守护停止失败、端口仍被占用时直接失败，不盲目继续。

## 健康探测与实例身份

- `probeHealthDetail` / `waitForDaemonDetail` 接受 `expectedInstance`（`homeKey(home)`）与
  `cloudId`。
- 200 但 `instance` 缺失/不匹配是**终态**：不得 `reused`、不得继续切换。
- 文案：`端口 X 上是另一张忆云，请先停止它`。
- 端口被非 Mebular 程序占用：`CLOUD_PORT_BUSY` 人话提示，不启动。
- 陈旧 heartbeat 不参与健康判定；只认 `/healthz` + `<home>/lock`。

## 单活与不删除

- `<root>/active.lock` `{pid, profileId, home, startedAt}`：活 PID 且 home 不同 →
  `CLOUD_ALREADY_ACTIVE`（预检 + 守护自身双保险）。
- 不提供删除忆云；崩溃诊断也不清理 `switch.intent.json` 或档案。

## 服务迁移

`migrateLegacyService`：

1. 读旧布局（`ServiceOptions.home=<cloud home>`）的 manifest/unit；
2. 若新布局（OS home）未登记，按旧 manifest 的 `autostart` 安装；
3. 只在安装成功后清理旧 unit/manifest 文件，不 bootout 新作业。

因此 `mebular service install --no-autostart` 的忆云在切档后仍保持不自启动。

## 崩溃恢复

启动时若存在 `switch.intent.json`：

| 状态 | 处理 |
| --- | --- |
| 目标 `/healthz` 健康且 instance 匹配 | 认定切换成功：`current=to`，清 intent |
| 目标不健康、旧忆云可起 | 停半启动目标，`current=from`，重启旧守护，清 intent |
| 两者都不健康 | 显示诊断；保留 intent 与全部档案，不删除任何目录 |

## 验收映射

- **CL-02**：`active.lock` 活 PID 不同 home → `CLOUD_ALREADY_ACTIVE`；`ensureDaemon` 不 spawn。
- **CL-05**：`/healthz` instance 不匹配 → `conflict` / `CLOUD_INSTANCE_MISMATCH`，不 reused。
- **CL-09**：成功切换、失败回滚、`switch.intent.json` 三种恢复路径。
- 单测：`tests/desktop/clouds.test.mjs`；真实 serve 身份：`tests/desktop/cloud-health-real.test.mjs`。
