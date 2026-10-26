# 共享 Runtime：App 与 DSH Plugin 入口对等

> **状态**：Phase 0（契约）+ Phase 1（共享 Runtime Supervisor / Provider 注册表 / `mebular runtime` CLI，
> 含入口持有的 `runtime supervise` child 生命周期）+ Phase 2（App 内部接入 Supervisor 并注册
> `kind:app` provider）+ Phase 4a（共享 runtime 安装器 / `runtime install|reinstall`）已落地。
> B 面板/下载入口、init/start、启动更新检查、升级、签名属于后续阶段；本文先把产品决策写成契约，
> 代码不得提前越过阶段实现。
>
> 相关：运行时分层见 [ARCHITECT.md](ARCHITECT.md)，跨表面状态语义见 [SURFACES.md](SURFACES.md)。

## 1. 目标

App 和 DSH Plugin 只是两个入口。本机 Mebular 的 runtime、daemon、service、数据、当前 profile
都属于共享层；两个入口可以同时运行、互不干扰，并操作同一份本机 Mebular。

```text
App 壳 / DSH Plugin 壳                只负责 UI、发现、ensure/attach
        │
        ▼
共享 Runtime Supervisor               profile/cloudRoot、provider、ensure、锁、健康校验
        │
        ▼
~/.mebular
  ├─ profiles.json / active.lock / profiles/<id>
  ├─ runtime-providers.json           App/CLI/shared runtime 的可发现来源（无秘密）
  ├─ runtime-start.lock               跨入口启动互斥
  ├─ runtime.json                     当前 home 的非敏感发现信息
  └─ store / identity / config
        │
        ▼
一个 mebular-serve service / 一个 daemon
```

## 2. 不变量

1. **一个 runtime**：本机只有一个正在运行的 Mebular runtime/daemon。
2. **一个 service**：同一个 home/cloudRoot 只有一个 `mebular-serve`。
3. **一份数据**：同一 `~/.mebular` root、当前 profile、store、身份与任务图。
4. **入口只 attach/ensure**：App 和 Plugin 不拥有私有 daemon，不创建第二个 home。
5. **先到先得**：谁先启动谁提供 runtime；后到者 attach，不重复启动。
6. **能复用就不下载**：已有 App/CLI/shared runtime provider 时，只启动/attach；只有完全没有
   可用 runtime 且用户明确同意时才走 B 下载。
7. **不静默安装/升级**：B 下载、service 安装、跨版本升级都要显式同意；失败要给出可恢复提示。
8. **卸载入口不拆 runtime**：移除 App 或 Plugin 不得删除另一个入口正在使用的 runtime/service/data。
9. **版本以运行中的 daemon 为准**：shell 版本不一致时先 attach；需要时走受控升级，不自动起第二个版本。

## 3. 组件与代码落点（Phase 1）

| 组件 | 落点 | 职责 |
| --- | --- | --- |
| Runtime Supervisor | `packages/mcp/src/runtime-supervisor.mjs` | `resolveRuntimeContext`、provider 发现、`resolveRuntime`、`ensureRuntime`、`runtimeStatus`、启动锁、健康等待 |
| Provider 注册表 | `packages/mcp/src/runtime-providers.mjs` | `~/.mebular/runtime-providers.json` 的原子读写/加锁/校验 |
| CLI | `packages/mcp/bin/mebular.mjs` | `mebular runtime resolve\|ensure\|status`、`runtime provider list\|add\|remove` |
| 复用模块 | `profiles.mjs`、`cloud-switch.mjs`、`home.mjs`、`runtime-file.mjs`、`service-loader.mjs`、`@mebular/service` | profile/home、service descriptor、runtime.json、平台服务（bare → 内置 dist） |

约束：

- 不新增 npm 包/依赖；supervisor 放在 `@mebular/mcp` 内。
- `packages/mcp` **不反向 import** `apps/desktop`。App 需要共享的纯逻辑由 App 在 Phase 2 改为调用本模块；
  Phase 1 不改 App 行为与 UI。
- DSH Plugin 继续不 import `@mebular/*`；Phase 3 通过 `mebular runtime` 子进程接入。
- App 现有 `child/service/reused` 三种语义是验收基线：shared supervisor 的 `mode` 必须能一一映射。

### 3.1 ADR：安装布局中的 service 解析（Phase 4a）

**决策：采用共享 service loader，不新增 npm 依赖。**

`@mebular/core` 的 package.json 不依赖 `@mebular/service`，但 core tarball 的 `files` 已包含
`packages/service/dist`。`npm install --prefix runtime/<version> @mebular/core@<version>` 后，
bare `import('@mebular/service')` 无法解析到独立包；若直接失败，`runtime resolve` 的 service
状态会变成 `service_unknown`，plugin-only 首次启动会被误阻断。

`packages/mcp/src/service-loader.mjs` 统一：

1. 先尝试 bare `import('@mebular/service')`（标准安装/本地 workspace）；
2. 失败后回退 `new URL('../../service/dist/index.js', import.meta.url)`（core tarball 内置 dist）；
3. 两者都失败才抛 `SERVICE_MODULE_UNAVAILABLE`，不把失败缓存成“永久不可用”。

使用方：`cloud-switch.mjs`（`profileServiceStatus` 等默认 service）、`runtime-supervisor.mjs`
（service restart adapter）、`bin/mebular.mjs`（`serve` heartbeat、`mebular service`）。
App 仍可注入自己的 service adapter（`deps` / 现有注入点），行为不变；loader 只服务共享 core/CLI
的默认路径。

约束：

- 不新增 npm 依赖，不改发布依赖或 `files` 清单；
- 只允许 bare 包名与本文件相对定位的 bundled dist，不接受任意 URL/路径；
- 相对 URL 以 loader 自身 `import.meta.url` 为锚点，仓库布局与安装布局（`node_modules/@mebular/core/...`）
  都指向 `packages/service/dist/index.js`；
- 只缓存成功结果，修复安装后可重试；错误只保留 cause，不含凭据；
- service 状态失败仍按既有 fail-closed：`service_unknown` 时不 fallback child。

测试：`tests/mcp/service-loader.test.mjs`（bare 成功、bare 失败回退、双失败、缓存、安装布局模拟）+
`tests/mcp/runtime-cli.test.mjs`（无 service 注册返回 `registered:false`）。

## 4. Provider 与解析优先级

Supervisor 的解析顺序固定：

1. **健康 daemon**：端口上 `/healthz` 的 `instance` 与当前 `homeKey` 一致 → attach（`reused`）；
2. **已注册 `mebular-serve` service** → 重启/复用（`service`）；
3. **provider**（`runtime-providers.json` → 标准 App 安装路径 → PATH 上的 `mebular` → 当前 CLI 自身）
   → 启动它（`child`）；
4. **没有 provider** → `download_required`。Phase 1 **绝不下载**，即使调用方传 `allowDownload: true`；
5. 下载失败/用户拒绝 → 面板提示安装命令与主 README，不静默重试（Phase 4）。

补充规则：

- `instance_mismatch` / `instance_missing` / `cloud_mismatch` 是终态：端口上不是当前忆云，停止重试并报冲突。
- root 级 `active.lock` 被另一个 home 的活 PID 占用 → `CLOUD_ALREADY_ACTIVE`，不启动第二个 daemon。
- 端口被非 Mebular 程序占用且 daemon 不健康 → `port_in_use`，不 spawn。
- `runtime-start.lock` 被另一个入口持有 → 先等待健康；健康后 attach，超时返回 `start_locked`。
  只回收陈旧 PID 锁，不删除活锁。
- **service 优先不可覆盖**：当前 home 已注册 `mebular-serve` 时，`ensure` / `supervise` 必须走 service，
  即使调用方传 `--start child`；不得为了“我想要 child”再启动一个 daemon。`--start child` 只表示
  “没有 service 时才用 child”。
- **service 状态 fail-closed**：`serviceStatus.ok === false` → `service_unknown`；
  `serviceStatus.foreign === true` → `service_foreign`。两种情况都不得 restart、不得 fallback child；
  只有 `ok:true, registered:false, foreign:false` 才允许继续 provider/child。
  健康 daemon 的 attach 仍然优先级最高（即使 service 状态未知）。
- `ensure --start service` 在未注册时返回 `service_not_registered`，Phase 1 不自动安装 service
  （安装属于 Phase 5）；状态未知时返回 `service_unknown`，不是 `service_not_registered`。
- **只停止自己启动的 child**：`stopRuntimeChild` / `stopRuntimeChildGracefully` 只处理本次 supervisor
  拉起的句柄；外部 daemon/service 不动。入口必须持有 child 所有权（见 §7）。

### Provider 优先级

先按 kind：`app` > `cli` > `shared`；同 kind 内注册表优先于标准路径/PATH/self。
App 已安装但未启动时，应启动 App provider，不得下载第二个 runtime；CLI 已安装时复用 CLI。

### Provider 注册表

`~/.mebular/runtime-providers.json`：

```json
{
  "v": 1,
  "providers": [
    {
      "id": "sha256(kind+path) 前 12 hex",
      "kind": "app | cli | shared",
      "path": "/absolute/path/to/runtime-entry",
      "version": "0.1.2",
      "capabilities": ["serve", "console"],
      "registeredAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

- **只存** kind/path/version/capabilities 与时间戳；未知字段（token、身份、私钥等）写入时丢弃。
- 写入/移除：`runtime-providers.lock` + tmp → rename 原子落盘，权限 0600。
- 读取：不阻塞 attach/service；文件损坏时返回空 provider + warning；写入/移除 fail-closed，不覆盖损坏文件。
- 注册/更新：
  - 通用 `registerRuntimeProvider` 按 `kind + path` 去重，保留 `registeredAt`；用于 CLI/shared 等可多实例 kind。
  - 单实例 `registerExclusiveRuntimeProvider` 在同一把 `runtime-providers.lock` 内**原子替换该 kind 的全部记录**；
    用于 App（`kind:app`）。同一 path 的版本更新保留 `registeredAt`；path 变化会删除旧 App 记录、只保留
    当前一条（避免 Plugin/CLI 按字典序选中旧 App runtime）；其他 kind 原样保留。内容未变化时返回
    `unchanged` 且不重写文件。
  - 移除需显式 `id` 或 `kind + path`。
- 标准 App 路径发现集中在 `standardAppProviderPaths()`，打包布局变化只改这一处。
- App 在 Phase 2 启动时注册 `kind: app`（路径 = 内置 CLI、版本 = `APP_VERSION`、能力 = `serve`），
  调用单实例注册原子替换旧的 App 记录；注册失败只告警，不阻塞 App。Phase 1 已支持 CLI PATH、self 与注册表读取。

## 5. CLI 契约（稳定 JSON）

```text
mebular runtime resolve   [--start auto|child|service] [--port N] [--json]
mebular runtime ensure    [--start auto|child|service] [--port N] [--json]
mebular runtime supervise [--start auto|child|service] [--port N] [--json]
mebular runtime status    [--port N] [--json]
mebular runtime provider list|add|remove [--kind app|cli|shared --path P --version V --capabilities a,b --id ID] [--json]
```

- `--json` 可选；`runtime` 子命令始终向 stdout 输出稳定 JSON，人读提示/日志不混入 stdout。
- 成功退出码 0；`ensure`/`supervise` 未达到 ready（`download_required` / 冲突 / 错误）退出码 2；
  `resolve`/`status` 只要上下文解析成功即 0（daemon down 也是有效状态）。
- **`supervise` 是入口持有 child 的唯一 CLI 路径**：前台启动 provider child，stdout 输出一次 ready JSON，
  child 日志走 stderr，随后保持存活；SIGTERM/SIGINT 时只优雅停止自己拉起的 child，等待退出后再退出。
  startup 期间收到信号会 abort ensure、停止已 spawn 的 child，并输出 `signal_during_start` 后退出；
  child 提前退出时向 stderr 输出 `child_exited` 事件并以 child 退出码退出，不留孤儿。
  `reused` / `service` / `download_required` / `conflict` 时输出结果后立即退出，不接管外部 daemon/service。
- `ensure` 的 child 行为固定为 detached，仅用于人工/诊断；CLI 退出后 daemon 继续运行，调用方拿不到句柄，
  **不得作为 App/Plugin 的 child 所有权路径**。
- `check-update` / `reinstall` / `upgrade` / `runtime service ...` **不暴露**；后续阶段实现后再加命令。

主要字段：

| 字段 | 含义 |
| --- | --- |
| `ok` | 操作是否成功（`ensure` 的 ready 语义；`status` 的上下文解析语义） |
| `mode` | `reused` / `service` / `child` / `down`（status）/ `download_required` / `conflict` / `error` |
| `reason` | 稳定原因码（见 §9） |
| `cloudRoot` / `profileId` / `profile` / `home` / `homeKey` | 当前解析结果 |
| `http` | 探测目标 `{host, port, scheme, url}` |
| `instance` / `version` / `runtimePath` / `runtimeFile` | 运行中/发现到的 runtime 身份 |
| `provider` | 计划/实际使用的 provider；`{kind, path, version, capabilities, source}` |
| `providers` | 全部 provider（含 `available`/warning），供诊断 |
| `service` | `registered/running/label/autostart/foreign/unitPath` |
| `activeLock` | root 级单活锁（含 `conflict`） |
| `daemon` | `status/url/httpStatus/reason/instance/cloudId/version` |
| `bootstrap` | `ready` / `down` / `download_required` / `conflict` / `error`；`allowDownload` 在 Phase 1 恒为 false |
| `download` | 仅 `download_required` 时出现；`{required:true, allowed:false, requested, reason, next}` |

返回值只含非敏感发现信息；不含令牌、主密钥、身份文件内容或日志。

## 6. 行为矩阵（验收基线）

| 场景 | 期望 |
| --- | --- |
| 只有 Plugin，无 App/CLI | 面板提示下载/初始化；用户同意 → B 下载固定版本 → 自动安装 → init → 启动 → Console onboarding |
| B 下载成功 | 下载 → 校验 → 安装依赖 → 注册 provider → init → 启动，一次用户操作完成 |
| B 下载/安装失败 | 显示原因、重试、重装、复制手动安装命令；无半安装/残留进程，旧 runtime 保留 |
| 启动时发现新 runtime | 提示更新；用户同意后下载 → 安装 → 切换 → 重启 daemon/service；不静默安装 |
| 两个入口同时检查/更新 | 共享 update lock：一个执行/提示，另一个等待并 reconnect；不重复提示/安装 |
| Plugin 先装、先启动 | 使用共享 runtime/profile；后装 App 时 App 读同一 cloudRoot/profile/service/provider → attach |
| App 先装、先启动 | App 建/用 profile，启动 service/child；Plugin 解析同一 profile，attach；**不下载** |
| service 已注册 + `--start child` | 仍走 service；不得 spawn 第二个 daemon，不得返回 child 句柄 |
| service 状态 unknown / foreign | fail-closed：`service_unknown` / `service_foreign`；不 restart、不 spawn、不碰他人作业 |
| supervise startup 期间收到信号 | abort ensure、停止已 spawn 的 child（graceful），输出 `signal_during_start`，无孤儿 |
| 入口需要 child 所有权 | App 进程内 `ensureRuntime({detached:false})`；Plugin spawn `runtime supervise` 并终止 supervise，由它停止 daemon child |
| App 已安装但没启动 | Plugin 通过 provider/service/标准路径启动 App 的 runtime；**不下载** |
| CLI 已安装 | Plugin 复用 CLI runtime；**不下载** |
| App/CLI 已安装但发现不到 | 提示“打开 Mebular / 安装 CLI”，不静默下载第二个 runtime |
| 两边同时冷启动 | 启动锁 + `/healthz` instance + 单实例锁：一个启动，另一个 attach；无第二个 daemon/端口冲突 |
| 两边同时运行 | 同一个 `homeKey`、同一张图；两个 Console 的数据一致；互不重启 |
| 一个入口退出（child） | child 停止；另一个入口可启动同一个 profile/runtime |
| 一个入口退出（service/常驻） | daemon 继续；另一个入口直接 attach |
| Console 开「让 Mebular 常驻」 | 安装共享 `mebular-serve`；之后退出 App/DSH 都不停 |
| App 切换 profile | Plugin 检测到 instance/home 变化，attach 新 daemon 或提示；不启动旧 profile 的第二个 daemon |
| 版本 skew | 运行中的 daemon 为准；兼容则 attach；需要升级 → 受控升级；不自动起第二版本 |
| 卸载 Plugin | App 继续使用共享 runtime/service/data；不删 runtime |
| 卸载 App | Plugin 继续使用共享 runtime/service/data；不删 runtime |
| 重新安装入口 | attach 现有 runtime；不重建数据 |
| B 下载失败 | 面板显示失败原因、重试、复制安装命令/主 README；无半安装 runtime |
| runtime 崩溃 | service 自动拉起或另一个入口 ensure；active lock/health 处理 |

Phase 1 自动化覆盖：默认/非默认 profile、custom `MEBULAR_CLOUD_ROOT`、显式 home 跟随 current、
active lock、instance mismatch、service 注册与不可覆盖优先级、provider 发现/注册表、端口冲突、
启动锁、ensure attach/service/child、`supervise` child 所有权与 SIGTERM/SIGKILL 升级、
无 provider → `download_required`、CLI 稳定 JSON。
Phase 2 自动化覆盖：App `ensureDaemon` 委托 supervisor 的 reused/service/child/conflict 映射、App 专属
service descriptor、child 句柄归 App 所有、`kind:app` provider 注册/版本更新/**路径变化原子替换**/失败不阻塞、
第二入口 attach；CLI `provider list` / `runtime resolve` 不会选到旧 App path。
B 下载/更新/升级/卸载矩阵行在对应阶段补齐。

## 7. child 与 service

| 模式 | 谁启动 | 入口退出时 | 后续入口 |
| --- | --- | --- | --- |
| `reused` | 其他入口/用户 | 不影响 | 直接 attach |
| `child` | 本次入口 | 只停止自己拉起的 child | 可启动同一 profile/runtime |
| `service` | `@mebular/service`（launchd/systemd/Task Scheduler） | daemon 继续 | 直接 attach 或重启 service |

- 默认 child；Console「让 Mebular 常驻」才安装 service。安装/卸载 service 属于 Phase 5。
- **service 已注册时 child 不是可选覆盖**：`ensure`/`supervise` 一律走 service；`--start child` 只在没有
  service 时生效。入口不得为了“我想 child”绕过已有 service。
- service descriptor 必须携带实例 home（`MEBULAR_HOME` + `MEBULAR_CLOUD_ROOT` + heartbeat/workingDir），
  服务单元落在 OS 用户 home，不落在 profile 目录。
- App 现有 child/service/reused 行为与文案在 Phase 2 保持不变，只把内部实现接到 shared supervisor。

### 入口所有权分工

| 入口 | 路径 | child 所有权 |
| --- | --- | --- |
| App（Phase 2） | 进程内 `ensureRuntime({ detached: false })` | App 自己持有 child 句柄并负责停止 |
| Plugin（Phase 3） | spawn `mebular runtime supervise` | 把 supervise 进程当作自己的 child；DSH dispose 时终止 supervise，由 supervise 停止 daemon child |
| 人工/诊断 | `mebular runtime ensure` | detached child 无入口 owner；只用于人工排障，不是入口路径 |

`supervise` 的停止顺序：SIGTERM → 2s grace → SIGKILL → 等待 child 退出 → supervise 自己退出。
child 提前退出时返回 `child_exited`，不留下孤儿，也不接管外部 daemon/service。

**startup 期间信号**：`supervise` 在调用 `ensure` 前安装临时 SIGTERM/SIGINT 处理；`ensure` 通过
`onChildStarted` 暴露已 spawn 的 child，并在等待健康时可被 abort。收到信号时由 `ensure` 作为唯一
owner 停止已 spawn 的 child（graceful，SIGTERM→SIGKILL），等待退出后 `supervise` 输出
`reason: "signal_during_start"` / `stopped` 并退出。ready 之后的信号走原有 `stopped`/`stop_failed` 路径；
两者不重复杀/等待。

## 8. 后续阶段的产品决策（写成契约，未实现）

### B：按需下载 / 自动安装 / 失败重装（Phase 4）

- 来源：官方 npm registry 的 `@mebular/core@<pinned version>`；版本随插件版本固定；HTTPS + integrity。
- 安装到 `~/.mebular/runtime/<version>/`；安装锁；失败清理半成品。
- **一次操作完成**：下载 → 校验 → 安装依赖 → 注册 `kind: shared` provider → init → 启动；
  不拆成“下载”和“安装”两个动作。
- 只有没有健康 daemon、service、App/CLI provider，且用户明确同意时才下载。
- 失败原因稳定：`offline`、`registry_unreachable`、`http_error`、`integrity_mismatch`、`disk_full`、
  `permission_denied`、`npm_missing`、`unsupported_version`、`cancelled`。
- 失败 UX：原因、目标版本/来源、`重试`、`重新安装 Runtime`、复制安装命令、主 README/Release 链接；
  不自动无限重试；不启动半个 runtime、不写 provider、不留后台进程；旧 runtime 与数据保留。
- Reinstall 语义：`mebular runtime reinstall --version <version>`；停/保留旧 runtime → 清理半成品 →
  重新下载/校验/安装/init/启动；失败保留旧 runtime/provider。
- 手动安装 fallback：用户执行 `npm install -g @mebular/core@<version>` 后「重新检测」，provider 发现后 attach。

### 启动更新检查 / 升级（Phase 5）

- 默认启动时检查（节流约 24h）；冷启动/离线/请求失败静默跳过，不阻塞入口启动。
- 来源固定官方 npm stable；不接受任意 URL；不做遥测。
- 只提示，不静默安装：`current → available`、`更新` / `稍后` / `跳过此版本`；有任务在跑默认「稍后」。
- 两个入口共享 `update-state.json` / update lock：一个执行，另一个等待并 reconnect，不重复提示/安装。
- 更新流程：下载新版本 → 校验 → `runtime/<new>/` → 切换 `current.json` → 更新 service → 重启 →
  `/healthz` 校验 → 成功清理旧版本 / 失败回滚；旧 runtime 保留用于回滚。
- Provider 通道：`shared` 检查共享 runtime；`app` 提示更新 App；`cli` 提示更新 CLI；
  只有没有 provider 才回到 B。
- 版本以运行中的 daemon 为准；需要升级走 `mebular runtime upgrade --to <version>`；禁止自动起第二版本。

### Service 所有权 / 卸载

- 只有一个 `mebular-serve`；manifest 记录 `runtimePath`、`version`、`owner/refcount`。
- 移除入口不删共享 runtime/service/data；只有 `mebular runtime uninstall` 在检查其他入口/refcount 后
  才移除 runtime/service；data 永不默认删除。
- 入口卸载时只移除自己的 provider 记录，shared runtime 保留。

## 9. 原因码

| 原因 | 含义 / 下一步 |
| --- | --- |
| `download_required` | 无可用 provider；Phase 1 不下载，提示打开 App/安装 CLI |
| `instance_mismatch` | 端口上是另一张忆云；停止它或换端口，不 attach/不启动 |
| `instance_missing` | 端口守护没有 `/healthz instance`（旧版）；无法确认身份 |
| `cloud_mismatch` | `/healthz cloudId` 与当前 profile 不一致 |
| `CLOUD_ALREADY_ACTIVE` | root 级单活锁被另一 home 的活 PID 占用 |
| `port_in_use` | 端口被非 Mebular 程序占用 |
| `start_locked` | 另一个入口正在启动且等待健康超时 |
| `service_not_registered` | 显式要求 service，但当前 home 未注册；Phase 1 不自动安装 |
| `service_unknown` | service 状态探测失败：fail-closed，不 restart/不 fallback child |
| `service_foreign` | service label 被其他 home 作业占用：不碰他人作业 |
| `service_start_failed` | service 已重启但健康校验失败 |
| `signal_during_start` | supervise startup 期间收到 SIGTERM/SIGINT，已停止 child 后退出 |
| `aborted` | ensure 被 startup 信号 abort（内部原因码） |
| `supervise_failed` | supervise 调用 ensure 时出现未预期异常（已尽力清理 child） |
| `child_exited` | supervise 的 daemon child 提前退出（传播退出码，不留孤儿） |
| `stopped` / `stop_failed` | supervise 收到终止信号后 child 已停止 / 未能停止 |
| `spawn_failed` | provider 进程无法启动 |
| `start_failed` | child 启动后健康校验失败（已停止本次 child） |
| `registry_invalid` / `RUNTIME_PROVIDERS_INVALID` | provider 注册表损坏（读取 warning，写入 fail-closed） |
| `RUNTIME_PROVIDERS_LOCKED` | 另一个进程正在写 provider 注册表 |
| `custom_home` / `home_outside_root` | 自定义 home 无法归属当前 cloudRoot |
| `INVALID_START_MODE` / `INVALID_PORT` | CLI 参数非法 |

## 10. 非目标与边界

- 不新增第二个 daemon/home/service/runtime。
- 不静默下载/安装/升级；Phase 1 完全不下载。
- 不重写 Console、数据或身份格式。
- 不修改 App 现有主流程/布局/交互；App 接入在 Phase 2，只换内部实现。
- 不修改 DSH Plugin 行为/`package.json`/`verify-dsh-plugin` 契约；Plugin 接入在 Phase 3。
- 签名暂缓：service/runtime 必须指向共享路径，不指向 App bundle 或 Plugin `node_modules`；
  后续签名 ADR 再决定 signed runtime/helper 或 signed launcher。
- 不做跨大版本自动迁移数据。

## 11. 测试

```bash
npm test -- --runInBand tests/mcp/runtime-providers.test.mjs tests/mcp/runtime-supervisor.test.mjs tests/mcp/runtime-cli.test.mjs
```

- `runtime-providers.test.mjs`：原子写/0600/未知字段丢弃、去重、移除、损坏 fail-closed、锁/陈旧锁、CLI provider 命令。
- `runtime-supervisor.test.mjs`：root/profile/current/显式 home、custom `MEBULAR_CLOUD_ROOT`、HTTP 目标、
  health 探测/等待/端口、provider 发现、attach/service/child、service 优先级不可覆盖、
  service unknown/foreign fail-closed、active lock、instance mismatch、端口冲突、启动锁、
  无 provider → `download_required`、只读 resolve/status、`supervise` ready/SIGTERM/startup 信号/
  child 提前退出、`stopRuntimeChildGracefully` 的 SIGTERM→SIGKILL 升级。
- `runtime-cli.test.mjs`：稳定 JSON、退出码、current profile 跟随、`--start child` 不绕过已注册 service、
  `supervise` 接线、`ensure --start service` 未注册、非法参数、无 `child`/秘密字段。
