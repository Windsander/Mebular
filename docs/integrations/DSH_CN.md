# 在 DeepSeek Harness（DSH）中使用 Mebular

[English](DSH.md) · [返回文档索引](../README.md)

`@mebular/dsh-plugin` 把 Mebular 的记忆与任务图接入
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH），并在 DSH
侧边栏嵌入共享的 Mebular Console。它是零构建 DSH bundle，不 import `@mebular/*`，
只通过本机 CLI/HTTP 发现共享 runtime。

从 v0.2.0 开始，App 与 DSH Plugin 是**同一套本机 Mebular runtime 的两个入口**：一个
daemon、一个 `mebular-serve`、一个当前 profile/home、一份数据。Plugin 默认只
`attach`；只有用户显式选择 `managed`/`auto` 或点击面板安装时，才会启动/安装 runtime。

## 两个入口，一个 runtime

| 面 | 职责 |
| --- | --- |
| **Mebular App / shared runtime** | 控制面：runtime、daemon、service、身份、存储锁、同步、星图 Console。 |
| **DSH Plugin** | Agent 面：在侧边栏显示同一套 Console，挂载官方 MCP client，并且可以按需 ensure/启动同一个 runtime。 |

插件不会另起第二套 Console，也不直接读 store、identity 或 token。它通过共享 runtime
supervisor 的 `runtime resolve`/`supervise` 和 daemon HTTP 端点工作。

## 安装

从 npm 安装到 DSH 的 Web profile：

```bash
dsh plugin --profile web add @mebular/dsh-plugin@0.2.1
```

开发时从工作树安装：

```bash
dsh plugin --profile web add ./packages/dsh-plugin
```

默认配置仍是最小值和 attach：

```yaml
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: attach
    panel: true
```

安装后重启 DSH 会话使 profile 生效。插件不会在安装时静默下载或启动 Mebular。

### 没有 runtime 时

如果本机已有 App/CLI/service/共享 runtime，插件直接 attach，不安装任何东西。

如果都没有，面板显示 `download_required` 和「安装 Mebular Runtime」入口。用户点击后，
插件安装与自身 package 同版本的固定 `@mebular/core`：下载 → 校验 → 原子安装 → 注册
provider → init → 启动 → Console onboarding。失败会显示原因、手动命令和重试/重装/
重新检测；旧 runtime 保留，不启动半成品。

只有用户点击安装才会下载；`bootstrap: never` 会关闭该入口。

## 共享 runtime 解析

插件不会自己猜当前 profile/端口。它选择一个共享 CLI（App/CLI/shared provider），调用：

```bash
mebular runtime resolve --json
```

解析结果提供当前 `cloudRoot`/profile/home、daemon HTTP、版本、service/provider 和
bootstrap 状态；面板、MCP bridge 与 iframe 使用同一个动态 URL。

Provider 顺序为 `app > cli > shared`；shared 多版本优先 `runtime/current.json`。App
已安装但没启动时，优先启动 App provider，不会下载第二个 runtime。service 已注册时优先
service。显式 `daemonUrl` 是 pin，只 attach，不会被动态 URL 覆盖。

兼容发现顺序仍保留在无共享 CLI 的旧环境：`daemonUrl > MEBULAR_HTTP_PORT >
runtime.json > 127.0.0.1:7331`。插件只读取 `runtime.json` 的非敏感字段，不读
`config.json`、身份、token 或 store。

相关环境变量：

| 变量 | 作用 |
| --- | --- |
| `MEBULAR_CLOUD_ROOT` | 共享 root；缺省 `~/.mebular` |
| `MEBULAR_HOME` | 兼容 home/profile 发现 |
| `MEBULAR_HTTP_PORT` | 旧端口覆盖；共享 resolve 可用时以 resolve 结果为准 |
| `MEBULAR_CLI` | 显式 CLI 候选（`cliPath` 优先） |

## 生命周期

| 配置 | 行为 |
| --- | --- |
| `lifecycle: attach`（默认） | 只 resolve/probe；不启动、不停止；面板提示用户启动 App/安装 runtime。 |
| `lifecycle: managed` | 显式选择；健康 daemon 复用；service 已注册则用 service；否则用 provider 启动。 |
| `lifecycle: auto` | 显式选择，启动语义同 managed；没有 provider 时回到 `download_required`，不下载。 |
| `runtime: external` | 只 attach，永不启动/停止。 |
| `persistence: child` | 默认；插件拥有自己的 supervise 进程。 |
| `persistence: service` | 要求已有 service；未注册时提示，不安装 service。 |
| `bootstrap: prompt` | 缺 runtime 时显示安装入口（默认）。 |
| `bootstrap: never` | 不显示、不接受安装。 |

`managed`/`auto` 通过 `mebular runtime supervise` 持有 child，而不是直接 spawn
`mebular serve`。dispose 时只停止自己启动的 supervise；supervise 再有界清理它拥有的
daemon child。service/外部 daemon 不会被插件停止。

完整配置：

```yaml
- id: mebular
  name: '@mebular/dsh-plugin'
  config:
    lifecycle: managed      # attach | managed | auto
    runtime: auto           # auto | external
    persistence: child      # child | service
    bootstrap: prompt       # prompt | never
    panel: true
    # daemonUrl: ...         # 显式 pin；同时会变成 attach-only
```

非法值会回退安全默认并写 warning，不会让 DSH 激活失败。

## 状态与面板

`GET /mebular/embed-info` 只接受 loopback，返回非敏感状态。v0.2.0 新增了
`state`、`runtimeMode`、`profile`、`provider`、`service`、`downloadRequired`、
`install`、`update`、`upgrade` 等字段；面板、MCP bridge 和 iframe 由同一份状态驱动。

```json
{
  "ok": true,
  "status": "up",
  "state": "up",
  "mode": "attach",
  "runtimeMode": "reused",
  "managed": false,
  "panel": true,
  "version": "0.2.1",
  "profile": { "id": "default", "name": "我的忆云" },
  "provider": { "kind": "app", "source": "registry", "version": "0.2.1" },
  "service": { "registered": false, "running": false, "foreign": false },
  "downloadRequired": false,
  "install": { "state": "idle", "allowed": true },
  "update": { "state": "idle", "available": false, "show": false, "manual": false },
  "upgrade": { "state": "idle", "busy": false },
  "consoleUrl": "http://127.0.0.1:7331/console",
  "embedUrl": "http://127.0.0.1:7331/console/?embed=dsh",
  "mcpUrl": "http://127.0.0.1:7331/mcp",
  "loopback": true,
  "reason": null
}
```

常见面板状态：

- `download_required` / `download_failed`：没有可用 runtime；显示显式安装、手动命令、
  重新检测；不自动下载。
- `provisioning` / `starting`：安装、init 或 supervisor 启动中；暂不挂 MCP tool。
- `service_conflict` / `profile_mismatch` / `port_in_use`：不会启动第二个 daemon；
  按提示检查 service/profile/端口。
- `update_available`：共享 check 发现新 stable 版本；只显示提示。
- `up`：daemon 健康且 embed 协议匹配；MCP bridge 挂载，Console 可嵌入。

状态点仍与面板共用同一份状态：绿=已连接，琥珀=启动/安装/更新中，红=未运行，
灰=首次检查未返回。悬停状态点显示当前状态。

## 更新与升级

插件在启动/刷新时调用共享 `mebular runtime check-update --json`：

- 固定官方 npm registry 的 stable 通道；24h 节流；离线/HTTP/busy 静默跳过；
- 共享 `update-state`/`update.lock`，两个入口只让一个提示；
- `promptedVersion` 在面板实际渲染 banner 后写；App 的提示也写同一状态；
- `跳过此版本` 写共享 skippedVersion；`稍后` 不写 skip、不自动重试。

只有用户点击更新才执行：

```text
mebular runtime upgrade --to latest --json
```

升级会复用 installer，更新 current/provider；service 已注册时由 core 更新并重启
`mebular-serve`；插件只重启自己拥有的 supervise，外部 daemon 不动。共享 upgrade lock
保证两个入口只执行一个；另一个等待/reconnect。失败保留旧 runtime/current/provider，
不产生第二个 daemon。

## 常驻与卸载

- Console 的「让 Mebular 常驻」安装/检查共享 `mebular-serve`；
- 插件面板显示 service 状态，并链接到 Console；插件本身不安装 service；
- 卸载 DSH 插件只移除插件和它自己的 supervise/timer，不删除 runtime、provider、
  service 或数据；
- 显式移除常驻服务用 `mebular runtime service uninstall`；它会保留 runtime/provider/data。

## 安全

- `/mebular/embed-info` 只接受 loopback；响应不含 token、密钥、home 或 CLI 路径。
- 安装/升级是 loopback-only `POST`，要求 JSON、拒绝任意 version/URL/registry；固定源和
  固定目标由 host 读取，不由客户端传入。
- iframe 只在 daemon、embed protocol、loopback 与 `capabilities.embedConsole` 都满足时
  创建；sandbox 不含 top navigation。
- `?embed=dsh` 下 Console CSP 允许 loopback HTTP 祖先和 DSH Desktop 的
  `dsh-app://app` origin；普通 Console 请求仍保持 `frame-ancestors 'none'`。
- DSH 内嵌态隐藏锁定横幅和 onboarding 卡：它们在窄面板会压住 Console 右侧导航
  （`审计` / `设置`）。内嵌态右上角提供紧凑操作条：锁定态为 `新建忆云` /
  `加入忆云`，初始化后为 `加入忆云` / `邀请设备`。
- 共享 update/upgrade/install 锁防止两个入口重复安装或升级；日志先脱敏。

## 常见 reason

| reason | 处理 |
| --- | --- |
| `download_required` | 没有 runtime；在面板点击安装，或打开 App/安装 CLI |
| `service_conflict` / `service_unknown` / `service_foreign` | 检查 Console/service；不会启动第二个 daemon |
| `profile_mismatch` / `instance_mismatch` / `CLOUD_ALREADY_ACTIVE` | 切换到同一 profile 或停止另一个实例 |
| `port_in_use` | 释放端口或调整 Mebular 端口 |
| `runtime_resolve_failed` | 更新/重装 App/CLI 或共享 runtime |
| `supervise_failed` / `child_exited` | 检查共享 runtime 日志后重试 |
| `update_*` / `upgrade_busy` | 等另一个入口完成，或稍后重试；升级是显式动作 |
| `peer_missing` | 确认 DSH 提供 `@deepseek-ai/dsh-mcp-client` peer |

## 验证

```bash
npm test -- --runInBand tests/dsh
npm run verify:dsh-plugin
npm run verify:runtime:coexistence
```

真实 DSH Web E2E（最小支持版 + npm latest）、冷启动、单 daemon、service、更新锁和升级
回滚由 CI 与 `docs/operations/DSH_E2E.md` 覆盖。

## 发布与版本

- 版本：`0.2.1`，随统一 Mebular v0.2.1 release train（六个 npm 包同版本）
- npm：`@mebular/dsh-plugin@0.2.1`
- 插件是独立适配器：代码隔离在 `packages/dsh-plugin`，由独立 npm job 发布；插件运行时从
  自己的 `package.json` 读取 pinned runtime 版本，发布 bump 不需要改插件源码。
- 发布先 `@mebular/core@0.2.1`，再 `@mebular/dsh-plugin@0.2.1`；详见
  [发布 SOP](../operations/RELEASE.md)。
- 插件已收录于
  [awesome-dsh-plugin](https://awesome-dsh-plugin.com/zh/p/Windsander/Mebular--packages-dsh-plugin/)
  的 `memory` 分类。

## 卸载

```bash
dsh plugin --profile web remove @mebular/dsh-plugin
```

确认 profile 中已无插件：

```bash
dsh --profile web --dump-config | grep -i mebular   # 应无输出
```

卸载只移除 DSH 插件；Mebular App、runtime、service、数据与运行中的 Console 不受影响。
不要删除 Mebular home 或 store。
