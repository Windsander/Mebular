# 共享 Runtime：App 与 DSH Plugin 入口对等

> **状态**：v0.2.0 已落地共享 Runtime Supervisor、Provider 注册表、`mebular runtime`
> CLI、App 内部接入、DSH Plugin 共存接入、按需安装/重装、service 所有权、启动更新检查、
> 受控升级/回滚和离线共存 E2E。签名仍不在本版本范围内；真实 Windows Task Scheduler
> 尚未做本机实机验证；legacy service label 遵循 fail-safe 迁移说明。
>
> 相关：[ARCHITECT.md](ARCHITECT.md)（运行时分层）、[SURFACES.md](SURFACES.md)
> （跨表面状态语义）、[SHARED_RUNTIME.md](../operations/SHARED_RUNTIME.md)（操作与回滚）。

## 1. 目标

App 和 DSH Plugin 只是两个入口。本机 Mebular 的 runtime、daemon、service、数据、当前
profile 都属于共享层；两个入口可以同时运行、互不干扰，并操作同一份本机 Mebular。

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
  ├─ runtime/current.json             当前共享 runtime 指针（无秘密）
  ├─ runtime/<version>/               B 下载/安装的固定版本 runtime
  ├─ runtime/install.lock             安装互斥
  ├─ runtime/update.lock              update check 互斥
  ├─ runtime/update-state.json        共享更新检查状态/跳过版本
  ├─ runtime/upgrade.lock             受控升级互斥
  ├─ runtime/upgrade-state.json       共享升级状态（非敏感）
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

## 3. 组件与代码落点

| 组件 | 落点 | 职责 |
| --- | --- | --- |
| Runtime Supervisor | `packages/mcp/src/runtime-supervisor.mjs` | profile/cloudRoot、provider 发现、`resolve`/`ensure`/`status`/`supervise`、启动锁、健康等待、child 所有权 |
| Provider 注册表 | `packages/mcp/src/runtime-providers.mjs` | `runtime-providers.json` 原子读写/加锁/去重；只存 kind/path/version/capabilities |
| current 指针 | `packages/mcp/src/runtime-current.mjs` | `runtime/current.json` 严格校验、原子写、安装完整性校验 |
| 安装器 | `packages/mcp/src/runtime-installer.mjs` | 固定 npm 源安装/重装、staging → 原子换入、锁、失败清理与旧版本保留 |
| service 来源/所有权 | `packages/mcp/src/runtime-service.mjs` | descriptor、service source（current 优先）、install/status/restart/uninstall、manifest 冲突 |
| 更新检查 | `packages/mcp/src/runtime-update.mjs` | 固定官方 npm stable 来源、24h 节流、跨入口 update lock、skip/prompted 共享状态 |
| 受控升级 | `packages/mcp/src/runtime-upgrade.mjs` | 跨入口 upgrade lock、安装/切换 current、service 更新、失败回滚状态 |
| service loader | `packages/mcp/src/service-loader.mjs` | bare `@mebular/service` → core tarball 内置 `packages/service/dist` 回退 |
| CLI | `packages/mcp/bin/mebular.mjs` | `mebular runtime ...`；stdout 稳定 JSON，日志走 stderr |
| App | `apps/desktop/src/main/daemon.mjs`、`clouds.mjs`、`index.mjs`、`runtime-updates.mjs` | 进程内调用 Supervisor、持有自己的 child、service adapter、增量更新提示与升级编排 |
| Plugin | `packages/dsh-plugin/index.js`、`client.js`、`cordis.patch.yml` | spawn `runtime supervise` 持有自己的 child；面板安装/更新/升级；dispose 不卸载共享层 |

约束：

- 不新增 npm 包/依赖；supervisor 放在 `@mebular/mcp` 内。
- `packages/mcp` **不反向 import** `apps/desktop`；App 直接复用本模块。
- DSH Plugin 不 import `@mebular/*`；它通过 `mebular runtime` 子进程接入。
- App 现有 `child/service/reused` 三种语义保持不变，只把内部实现接到共享 supervisor。

## 4. Provider 与解析优先级

Supervisor 的解析顺序：

1. **健康 daemon**：端口上 `/healthz` 的 `instance` 与当前 `homeKey` 一致 → attach（`reused`）；
2. **已注册 `mebular-serve` service** → 重启/复用（`service`）；
3. **provider**（`runtime-providers.json` → 标准 App 安装路径 → PATH 上的 `mebular` → 当前 CLI 自身）
   → 启动它（`child`）；
4. **没有 provider** → `download_required`；只有入口显式安装（用户同意）才下载；
5. 下载失败/用户拒绝 → 面板提示安装命令与主 README，不静默重试。

Provider 的稳定优先级是 **`app` > `cli` > `shared`**；同 kind 内注册表优先于标准路径、
PATH、当前 CLI 自身。`runtime/current.json` 可用时作为 `kind: shared, source: current`
的 provider 参与选择，但不会越过可用的 App/CLI 入口；**service 来源则永远优先 current**
（见 §8）。这样：

- App 已安装但未启动：启动 App provider，不下载第二个 runtime；
- CLI 已安装：复用 CLI；
- 只有 Plugin/共享 runtime：使用 `shared`（或运行中的 current CLI）；
- 有 current 但入口提供了自己的 CLI：入口仍可运行自己的 CLI 版本；运行中的 daemon 是版本真源。

补充规则：

- `instance_mismatch` / `instance_missing` / `cloud_mismatch` 是终态：端口上不是当前忆云，
  停止重试并报冲突。
- root 级 `active.lock` 被另一个 home 的活 PID 占用 → `CLOUD_ALREADY_ACTIVE`。
- 端口被非 Mebular 程序占用且 daemon 不健康 → `port_in_use`。
- `runtime-start.lock` 被另一个入口持有 → 先等待健康；健康后 attach，超时返回 `start_locked`。
  只回收陈旧 PID 锁，不删除活锁。
- **service 优先不可覆盖**：当前 home 已注册 `mebular-serve` 时，`ensure` / `supervise` 必须走 service，
  即使调用方传 `--start child`。
- **service 状态 fail-closed**：`serviceStatus.ok === false` → `service_unknown`；
  `serviceStatus.foreign === true` → `service_foreign`；两者都不得 restart、不得 fallback child。
  健康 daemon 的 attach 仍然优先级最高。
- **只停止自己启动的 child**：`stopRuntimeChild*` 只处理本次 supervisor 拉起的句柄；
  外部 daemon/service 不动。

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
      "version": "0.2.1",
      "capabilities": ["serve"],
      "registeredAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

- 只存 kind/path/version/capabilities 与时间戳；未知字段（token、身份、私钥等）写入时丢弃。
- 写入/移除：`runtime-providers.lock` + tmp → rename 原子落盘，权限 0600。
- 读取不阻塞 attach/service；文件损坏返回空 provider + warning；写入/移除 fail-closed。
- App 使用单实例注册（原子替换 `kind:app` 记录）；CLI/shared 按 `kind + path` 去重。

## 5. CLI 契约

```text
mebular runtime resolve   [--start auto|child|service] [--port N] [--json]
mebular runtime ensure    [--start auto|child|service] [--port N] [--json]
mebular runtime supervise [--start auto|child|service] [--port N] [--json]
mebular runtime status    [--port N] [--json]
mebular runtime install   [--version V] [--json]
mebular runtime reinstall [--version V] [--json]
mebular runtime current   show|set|clear [--version V --runtime-path P --cli C --provider shared --owner O --installed-at ISO] [--json]
mebular runtime service   install|uninstall|restart|status [--json]
mebular runtime provider  list|add|remove [--kind app|cli|shared --path P --version V --capabilities a,b --id ID] [--json]
mebular runtime check-update [--force] [--json]
mebular runtime update-state show|skip|prompted [--version V] [--json]
mebular runtime upgrade   --to V|latest [--json]
mebular runtime upgrade-state show [--json]
```

- `--json` 可选；`runtime` 子命令始终向 stdout 输出稳定 JSON，人读提示/日志不混入 stdout。
- 成功退出码 0；`ensure`/`supervise` 未达到 ready（`download_required` / 冲突 / 错误）退出码 2；
  `resolve`/`status` 只要上下文解析成功即 0（daemon down 也是有效状态）。
- **`supervise` 是入口持有 child 的唯一 CLI 路径**：前台启动 provider child，stdout 输出一次 ready JSON，
  child 日志走 stderr，随后保持存活；SIGTERM/SIGINT 只优雅停止自己拉起的 child。
  startup 期间收到信号会 abort ensure、停止已 spawn 的 child 并输出 `signal_during_start`；
  child 提前退出时输出 `child_exited` 并以 child 退出码退出，不留孤儿。
  `reused`/`service`/`download_required`/`conflict` 输出结果后立即退出，不接管外部 daemon/service。
- `ensure` 的 child 行为固定为 detached，仅用于人工/诊断；CLI 退出后 daemon 继续运行，
  调用方拿不到句柄，**不得作为 App/Plugin 的 child 所有权路径**。
- `install` 对已存在且完整的同版本是幂等的；`reinstall` 明确覆盖同版本并保留旧目录 backup。
- `upgrade --to latest` 只接受共享 `check-update` 缓存里的 stable 目标，不接受任意 URL/registry。

主要字段：

| 字段 | 含义 |
| --- | --- |
| `ok` | 操作是否成功（`ensure` 的 ready 语义；`status` 的上下文解析语义） |
| `mode` | `reused` / `service` / `child` / `down`（status）/ `download_required` / `conflict` / `error` |
| `reason` | 稳定原因码（见 §12） |
| `cloudRoot` / `profileId` / `profile` / `home` / `homeKey` | 当前解析结果 |
| `http` | 探测目标 `{host, port, scheme, url}` |
| `instance` / `version` / `runtimePath` / `runtimeFile` | 运行中/发现到的 runtime 身份 |
| `current` / `currentUsable` / `currentSource` | `runtime/current.json` 摘要与可用性 |
| `provider` / `providers` | 计划/实际使用的 provider；全部 provider 供诊断 |
| `service` | `registered/running/label/autostart/foreign/unitPath/version/provider/owner` |
| `activeLock` | root 级单活锁（含 `conflict`） |
| `daemon` | `status/url/httpStatus/reason/instance/cloudId/version` |
| `bootstrap` | `ready` / `down` / `download_required` / `conflict` / `error` |
| `download` | `download_required` 时的安装引导（不自动下载） |

返回值只含非敏感发现信息；不含令牌、主密钥、身份文件内容或日志。

## 6. Runtime 生命周期与 child 所有权

| 模式 | 谁启动 | 入口退出时 | 后续入口 |
| --- | --- | --- | --- |
| `reused` | 其他入口/用户 | 不影响 | 直接 attach |
| `child` | 本次入口 | 只停止自己拉起的 child | 可启动同一 profile/runtime |
| `service` | `@mebular/service`（launchd/systemd/Task Scheduler） | daemon 继续 | 直接 attach 或重启 service |

| 入口 | 路径 | child 所有权 |
| --- | --- | --- |
| App | 进程内 `ensureRuntime({ detached: false })` | App 自己持有 child 句柄并负责停止 |
| Plugin | spawn `mebular runtime supervise` | 把 supervise 进程当作自己的 child；DSH dispose 时终止 supervise，由 supervise 停止 daemon child |
| 人工/诊断 | `mebular runtime ensure` | detached child 无入口 owner；只用于人工排障 |

停止顺序：SIGTERM → 2s grace → SIGKILL → 等待 child 退出 → supervise 自己退出。
child 提前退出返回 `child_exited`，不留下孤儿，也不接管外部 daemon/service。

**崩溃恢复**：service 由平台 KeepAlive/Restart 拉起；child 崩溃后由所属入口或另一个入口重新
`ensure`；root 级 `active.lock` 与 `/healthz instance` 防止并发启动第二个 daemon。

**profile 切换**：App 的 cloud-switch 停旧/起新，service 的 `MEBULAR_HOME`/`MEBULAR_CLOUD_ROOT`
更新到新 profile；Plugin 在下一次 resolve 时发现 home/instance 变化并 attach 新 daemon 或提示，
不会启动旧 profile 的第二个 daemon。

## 7. 安装、current 与 provider 的原子性

安装布局：

```text
<cloudRoot>/runtime/
  <version>/
    node_modules/@mebular/core/...       固定版本 core（含 CLI 与 bundled service dist）
  current.json                           指向完整安装；缺 CLI/版本不符 → invalid
  install.lock                           安装互斥（活 PID）
  .tmp-install-<version>-<pid>-<rand>/   安装 staging（永不作为 provider）
  .backup-<version>-.../                 重装时的旧目录 backup
```

流程：

1. 严格校验版本（semver + 路径安全）；
2. 获取 `install.lock`；清理陈旧 staging；
3. `npm install --prefix <staging> --ignore-scripts --no-audit --no-fund @mebular/core@<version>`
   （来源固定为官方 npm 包名 + 固定版本，不接受任意 URL）；
4. 校验 `package.json` 的 name/version 与 CLI 文件；
5. 旧目标目录 rename 为 backup → staging rename 为 `<version>` → 最终校验；任一步失败恢复旧目录；
6. 注册 `kind: shared` provider（原子写）；
7. 写 `current.json`（tmp → rename，0600）。

- 失败不启动半个 runtime、不写 provider、不留下后台进程；staging 清理；旧 runtime/provider 保留。
- `current.json` 读取时做安装完整性校验；损坏/半安装 → `invalid`，provider 发现回退到 App/CLI，
  service 在无 current 时才 fallback，不会指向半成品目录。
- 测试替身：`scripts/verify-runtime-coexistence.mjs` 用 fake npm 覆盖成功、离线、404、重装失败、
  两入口 install lock；断言 current/provider/runtime 的原子性与旧版本保留。真实 npm 路径由
  `tests/mcp/runtime-installer*.test.mjs` 覆盖。

## 8. 启动更新检查与受控升级

### 启动更新检查

- `mebular runtime check-update`：固定来源 `https://registry.npmjs.org/@mebular/core/latest`，
  HTTPS、只接受 stable semver；不接受任意 URL/registry；不做遥测。
- 默认 24h 节流；失败 5 分钟防抖；冷启动/离线/请求失败静默跳过，不阻塞入口启动。
- 共享 `runtime/update-state.json` + `runtime/update.lock`：
  - 一个入口检查/执行时，另一个返回 `busy` 并等待/重连，不重复请求；
  - `skippedVersion`、`promptedVersion` 由两个入口共享，避免重复提示。
- 只提示不静默安装：`current → available`、`更新` / `稍后` / `跳过此版本`；
  service/常驻模式提示会短暂重启 daemon；有任务在跑时应默认「稍后」（见 §11 限制）。
- Provider 通道：`shared` 检查共享 runtime；`app` 提示更新 App；`cli` 提示更新 CLI；
  只有完全没有 provider 时才回到 B 安装。

### 受控升级

`mebular runtime upgrade --to <version|latest>`：

1. 获取 `runtime/upgrade.lock`（另一个入口正在升级 → `busy`，不重复执行）；
2. 读取 current（version 为 from）；
3. 检查 service 状态；`service_unknown` / `service_foreign` → 拒绝升级；
4. 调用安装器安装目标版本（保留旧版本目录）；
5. current 必须指向目标版本，否则恢复 previous current/provider；
6. service 已注册 → 用新 current 重新安装/重启 service，健康校验；未注册 → 只切 current，
   不启动/不重启 daemon；
7. 写 `runtime/upgrade-state.json`；成功后把 update-state 标记为已应用。

失败语义：安装/切换/service 失败 → 恢复 previous current/provider，旧 runtime 保留；
不自动降级、不自动无限重试、不启动第二个版本。旧版本目录用于人工回滚（见 §10）。

## 9. Service 所有权与卸载

- 只有一个 `mebular-serve`；descriptor 携带实例 home（`MEBULAR_HOME` + `MEBULAR_CLOUD_ROOT`）、
  heartbeat/workingDir、runtime 元数据；unit 文件落在 OS 用户 home，不落在 profile 目录。
- service 来源：current 可用时**永远**使用 `shared`（version/runtimePath/cliPath/provider/owner 均取自
  current）；current 不可用时才使用调用方注入的 App/CLI fallback（App/cloud-switch 会注入；CLI 默认
  要求 current）；都没有 → `runtime_required`。
- `service manifest`（`<serviceHome>/.mebular/services/mebular-serve.json`）记录：
  `kind/label/sha/autostart/args/execPath/unitPath/installedAt` 与
  `runtime{version,runtimePath,cliPath,provider,owner,execPath,electron,cloudRoot,home}`；
  不写 token/身份。
- 安装前检查同 label 是否被其他 home 占用：foreign → 拒绝；legacy 无 home 维度的旧 label：
  属于本 home 才迁移/卸载，属于他人只安装本 home 新 label 并告警。
- `mebular runtime service uninstall` 只移除 unit/manifest；**不删除** runtime 目录、
  `runtime-providers.json`、current、store、identity 或任何数据。
- 入口卸载：App/Plugin 退出或移除时只停止自己拥有的 child；不调用 service uninstall，不删除共享
  runtime/data。当前没有“入口卸载钩子”自动移除 provider 记录：App 下次启动会用单实例注册替换旧
  `kind:app` 记录；需要清理时用 `mebular runtime provider remove --kind app --path <path>`。
  已不存在的 provider 路径在发现时标记为 unavailable，不会被启动。

## 10. App / Plugin 配置与灰度

### App

- 启动时注册 `kind: app` provider（内置 CLI 路径 + `APP_VERSION`），使用单实例注册原子替换旧记录。
- `ensureDaemon` 通过共享 supervisor；App 持有自己的 child；service 模式复用共享 descriptor；
  `reused`/`service`/`child`/conflict 映射与文案保持现有交互。
- 启动更新检查在窗口/向导就绪后非阻塞执行；用户选择更新才调用受控升级；App 只停自己的 child，
  升级后/失败后重新 ensure/attach；不产生第二个 daemon。
- Console「让 Mebular 常驻」使用共享 service 安装，不改变 App 主流程/布局。

### DSH Plugin（`cordis.patch.yml` 可选配置）

| 配置 | 值 | 默认 | 含义 |
| --- | --- | --- | --- |
| `lifecycle` | `attach` / `managed` / `auto` | `attach` | `attach` 只连接已有 runtime；`managed` 允许插件持有 supervise；`auto` 按需 |
| `runtime` | `auto` / `external` | `auto` | `external` 永不启动 runtime，只 attach |
| `persistence` | `child` / `service` | `child` | 是否需要已有 service；不会因该选项静默安装 service |
| `bootstrap` | `prompt` / `never` | `prompt` | `prompt` 显示显式安装；`never` 隐藏/拒绝安装，不静默下载 |
| `daemonUrl` | URL | 无 | 显式固定一个实例；固定后始终 attach-only |

- 默认 attach + prompt：安装插件不会静默启动/下载；面板显示 profile/daemon 版本/service/provider。
- 插件面板「安装」使用的固定版本 = **插件自身 `package.json` 的 `version`**。index.js 在模块加载时从
  自身包内 `package.json` 读取（tarball 必含），因此发布版本 bump 不需要改插件源码；同一 release
  train 中该版本等于 `@mebular/core` 版本。CLI/App 的安装器默认版本仍取 core 的 `APP_VERSION`。
- 只有用户点「安装」才执行固定版本安装；失败显示稳定 reason、重试/重装/手动安装命令，
  旧 runtime 与数据保留。
- 更新/升级走共享 `check-update` / `upgrade --to latest` / `update-state`；busy 时有界等待并
  reconnect，不重复安装。
- DSH dispose 只终止自己的 supervise（进而停止自己的 child），不卸载 service/runtime。

### 灰度

当前实现没有单独的全局 feature flag；灰度通过入口配置和发布节奏控制：

1. **CLI/App 先行**：只有 CLI/App 的机器先验证 provider/current/child/service；
2. **Plugin attach-only**：默认 `lifecycle: attach` + `bootstrap: never`，只观察/连接，不启动；
3. **Plugin managed**：用户显式改为 `managed` / `auto`，先用 child，再验证 service 常驻；
4. **plugin-only 安装**：只对明确触发安装的用户开放固定版本下载。

每一步都保持「不静默下载/升级」；出现问题时可直接退回 attach-only（见下）。

### 回滚

1. **入口退回 attach-only**：Plugin `lifecycle: attach`、`runtime: external`、`bootstrap: never`；
   App 退出/重开后只 attach。两个入口都不会因此删除 runtime/data。
2. **停止本次入口的 child**：退出 App/Plugin 即可；service 不会被停。
3. **停用常驻**：`mebular runtime service uninstall`；daemon 停止，但 current/provider/runtime/data 保留。
4. **回到旧 runtime**：旧版本目录由升级保留时，可显式 `mebular runtime current set` 指回旧
   `runtime/<version>` 并重启 service/重新 ensure；若旧目录已不存在，用
   `mebular runtime reinstall --version <old>` 重新安装。没有自动降级。
5. **不要删除 `~/.mebular`**：数据、身份与 provider/current 都在这里；回滚不需要清空 home。

## 11. 已知限制

- **Windows**：代码包含 Task Scheduler 分支，但本阶段未在真实 Windows 上验证；离线 E2E 的
  fake launchctl/service fixture 仅覆盖 POSIX。Windows 用户应先以 attach/service 手工验证。
- **legacy service label**：旧版 `com.mebular.mebular-serve`（无 home 维度）仍通过迁移逻辑识别；
  若被其他 home 占用，只安装本 home 新 label 并告警，不 bootout 他人。首次升级后建议
  `runtime service status` 确认 ownership。
- **外部 daemon**：supervisor 只 attach，不停止/升级/重启外部启动的 daemon；更新只能在用户
  停止外部 daemon 或交给 service 后进行。
- **任务中更新提示**：App 目前没有公开的运行中任务只读 API，`hasRunningTasks` 仍为 hook；
  Plugin 也不阻塞运行中的任务。更新提示不会静默打断任务，但“任务中默认稍后”尚未自动接线。
- **provider 优先级**：App > CLI > shared；安装的 CLI 会优先于共享 current 被选为启动 provider，
  但 service 来源和运行中 daemon 的版本仍以 current/daemon 为准。
- **current 失效**：手工删除 `runtime/<version>` 或 CLI 会让 current 变为 `invalid`；此时回退
  App/CLI provider，service 可能返回 `runtime_required`，需要重新安装或修复 current。
- **provider 记录不会随入口卸载自动删除**：App 被移除后 `kind:app` 记录可能仍留在
  `runtime-providers.json`；路径不存在时只显示 unavailable、不会启动。需要清理时用
  `runtime provider remove`。
- **没有 `runtime uninstall` CLI**：只有 `runtime service uninstall`；共享 runtime 目录与旧版本
  不会自动回收，需人工确认无入口使用后删除（数据永不默认删除）。
- **签名暂缓**：service/runtime 指向共享路径，不指向 App bundle 或 Plugin `node_modules`；
  后续签名 ADR 再决定 signed runtime/helper 或 signed launcher。
- 不做跨大版本自动迁移数据；不静默降级；不自动起第二个版本。

## 12. 原因码

| 原因 | 含义 / 下一步 |
| --- | --- |
| `download_required` | 无可用 provider；提示打开 App/安装 CLI 或显式安装 |
| `instance_mismatch` | 端口上是另一张忆云；停止它或换端口，不 attach/不启动 |
| `instance_missing` | 端口守护没有 `/healthz instance`（旧版）；无法确认身份 |
| `cloud_mismatch` | `/healthz cloudId` 与当前 profile 不一致 |
| `CLOUD_ALREADY_ACTIVE` | root 级单活锁被另一 home 的活 PID 占用 |
| `port_in_use` | 端口被非 Mebular 程序占用 |
| `start_locked` | 另一个入口正在启动且等待健康超时 |
| `service_not_registered` | 显式要求 service，但当前 home 未注册 |
| `service_unknown` | service 状态探测失败：fail-closed，不 restart/不 fallback child |
| `service_foreign` | service label 被其他 home 作业占用：不碰他人作业 |
| `service_conflict` | manifest 属于另一个 home/cloudRoot：拒绝覆盖/卸载 |
| `service_start_failed` | service 已重启但健康校验失败 |
| `service_install_failed` / `service_uninstall_failed` | 平台 service 安装/卸载失败（已尽力恢复旧 unit/manifest） |
| `signal_during_start` | supervise startup 期间收到 SIGTERM/SIGINT，已停止 child 后退出 |
| `aborted` | ensure 被 startup 信号 abort（内部原因码） |
| `supervise_failed` | supervise 调用 ensure 时出现未预期异常（已尽力清理 child） |
| `child_exited` | supervise 的 daemon child 提前退出（传播退出码，不留孤儿） |
| `stopped` / `stop_failed` | supervise 收到终止信号后 child 已停止 / 未能停止 |
| `spawn_failed` | provider 进程无法启动 |
| `start_failed` | child 启动后健康校验失败（已停止本次 child） |
| `install_locked` | 另一个进程正在安装 runtime |
| `offline` / `registry_unreachable` / `http_error` / `timeout` | 安装/更新检查的网络失败 |
| `integrity_mismatch` | 包版本/CLI 校验失败；不换入 |
| `permission_denied` / `disk_full` / `npm_missing` / `cancelled` | 安装环境失败/取消 |
| `unsupported_version` | 版本非法或 npm 无匹配版本 |
| `busy` | 另一个入口正在 check-update/upgrade；等待并 reconnect |
| `upgrade_failed` / `current_registration_failed` | 升级失败；已恢复 previous current/provider |
| `registry_invalid` / `RUNTIME_PROVIDERS_INVALID` | provider 注册表损坏（读取 warning，写入 fail-closed） |
| `RUNTIME_PROVIDERS_LOCKED` | 另一个进程正在写 provider 注册表 |
| `custom_home` / `home_outside_root` | 自定义 home 无法归属当前 cloudRoot |
| `INVALID_START_MODE` / `INVALID_PORT` | CLI 参数非法 |

## 13. 测试

```bash
# 离线共存 E2E：真实 CLI 子进程 + fake provider/daemon/npm + 真实 service manifest
npm run verify:runtime:coexistence

# 定向单测
npm test -- --runInBand \
  tests/mcp/runtime-providers.test.mjs \
  tests/mcp/runtime-supervisor.test.mjs \
  tests/mcp/runtime-cli.test.mjs \
  tests/mcp/runtime-current.test.mjs \
  tests/mcp/runtime-installer.test.mjs \
  tests/mcp/runtime-service.test.mjs \
  tests/mcp/runtime-update.test.mjs \
  tests/mcp/runtime-upgrade.test.mjs \
  tests/mcp/runtime-upgrade-lock.test.mjs

# 插件契约（不联网）
npm run verify:dsh-plugin
```

E2E 覆盖（每个场景独立临时 home/root/端口，结束清理进程与目录）：

- 健康 daemon attach、`/healthz instance` 校验、外部 daemon 不被停止；
- 两个入口同时冷启动：一个 `runtime-start.lock` 持有者、一个 attach、只有一个 provider 启动/daemon；
- child 入口退出后另一个入口可重新启动同一 profile；
- App/CLI provider 复用且不下载；无 current 时 service 回退 App/CLI；
- install/current/provider 原子性；离线/404 重装与新版安装失败保留旧版本；
- 两入口 install lock、update check lock、upgrade lock 只执行一次；busy 入口有界等待并 reconnect，
  不重复升级；
- 升级失败恢复 previous current/provider，无 staging/半安装；
- service manifest 的 version/provider/owner/home/cloudRoot；service 入口退出后 daemon 继续；
- service uninstall 只移除 unit/manifest，runtime/provider/data 保留；
- 入口诊断/退出不修改 current/provider/data。

## 14. 非目标

- 两个 daemon、两个 home、两个 service、两个版本的 runtime。
- 静默下载/安装/升级/降级。
- 跨大版本自动迁移数据。
- 重写 Console 或数据/身份格式。
- 本阶段实现签名。
- 重写 App 现有主流程/布局；只增加 runtime 更新提示（增量 UI）。
