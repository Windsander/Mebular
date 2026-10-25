# Mebular 表面状态契约

> 本文定义一个 Mebular daemon 在 Desktop App、Console、CLI、MCP 客户端与 DSH
> 中共享的**状态语义**。共享的是语义，不是 React 组件、Console 代码或 DSH UI；
> 各表面可以有不同的颜色、文案与交互，但不得把同一事实解释成互相矛盾的状态。
>
> 本文描述**已经存在**的 wire 契约（`/healthz`、`/app/embed/info`、DSH
> `/mebular/embed-info`），以及 DSH adapter 私有的 Agent 可见提示（非 wire）。
> 本轮不新增 endpoint、字段或核心状态，只记录缺口。

## 1. 状态词汇

| 状态 | 含义 | 现有来源 |
|---|---|---|
| `uninitialized` | daemon 已监听，但 home 尚未建新/加入忆云。 | Console 的 provisioning 流程；`/healthz` 仍返回 `200`、`status: "ok"`。当前 `/app/embed/info` 在引导态返回 `409 provision_required`。 |
| `starting` | daemon 正在启动，尚未通过健康检查。 | 仅 DSH managed lifecycle：`/mebular/embed-info` 的 `status: "starting"`。核心 HTTP server 不产生这个 wire 状态。 |
| `up` | daemon 可达且 `/healthz` 报告健康；Console/embed 能力可能仍然不可用。 | `/healthz` 的 `status: "ok"`；DSH embed-info 的 `status: "up"`。 |
| `down` | daemon 不可达，或 `/healthz` 不健康，或 managed 启动失败。 | DSH embed-info 的 `status: "down"`，通常带 `reason`。 |
| `degraded` | daemon 可达且健康，但某个表面能力不可用（当前主要是 Console/embed）。 | 由 `status: "up"` + 非空 `reason`（`embed_*`、`not_loopback`）推导。 |

判定规则：

- 状态是**每个表面各自得出的结论**，不是 daemon 广播的全局单值。例如 daemon 为
  `up` 时，普通浏览器 Console 可用，但 DSH 可能因非 loopback 而处于 `degraded`。
- `/healthz` 为 `200` 只证明 HTTP 监听和实例身份，不证明 home 已初始化，也不证明同步
  已就绪。
- `uninitialized` 是 daemon 生命周期状态，不是 `/app/embed/info` 的 `status` 值。当前
  DSH 会看到 `up` + `embed_info_unavailable`（见 §5 缺口）。
- `starting` 只属于 DSH 的 managed 启动过程；attach 模式没有这个阶段。

## 2. Capabilities

| 能力 | 现有契约 | 说明 |
|---|---|---|
| Console / embed | `/app/embed/info` 的 `capabilities.embedConsole`、`loopback`、`embedProtocol` | 只有 `loopback: true`、`embedProtocol: 1`、`capabilities.embedConsole: true` 且 URL 为 loopback HTTP(S) 时才允许 iframe。 |
| MCP tools | `/mcp`，以及 DSH host 的 MCP bridge 生命周期 | 没有单独的 capability 布尔值。DSH 只在 daemon `up` 时挂载官方 MCP client；`uninitialized` 时 `initialize` / `tools/list` 可用，`tools/call` 返回 `NOT_INITIALIZED`。 |
| Agent status hint | DSH host 的 system prompt section `mebular:status`（非 wire） | 仅 DSH adapter。daemon `up` 时为空；非 `up` 时给出短恢复动作。不注册 MCP 工具，其他 MCP 客户端不保证存在。 |
| Sync / ready | 无 discovery 字段 | `/healthz`、`/app/embed/info` 和 `runtime.json` 都不暴露同步进度或应用层 ready。不要从 `status: "ok"` 推断同步已完成；以 Console/Admin 数据面为准。 |
| 面板开关 | DSH `/mebular/embed-info` 的 `panel` | 只表示 DSH 是否注册 sidebar/main 槽位，不影响 daemon 的 MCP 工具，也不影响 Agent 提示。 |

本轮不新增 `capabilities.mcpTools`、`capabilities.sync` 或 `ready` 字段。

### Agent 可见状态（仅 DSH adapter）

DSH host 通过 `ctx.inject(['systemPrompt'])` 注册唯一 section `mebular:status`，把
lifecycle 快照中的非 `up` 状态解释成一句短提示：`down` 时告诉 Agent 不要声称记忆可用，
并提示用户启动 Mebular App 或运行 `mebular serve`；`starting` 时说明工具暂不可用；
managed 失败时按 `managed_cli_missing` / `managed_start_failed` 给出对应恢复动作。
`up` 时 section 文本为空，不增加 token。

这条提示不是新的状态源：它只从 MCP bridge 已有的 2s 快照派生，文本变化时才发
`system-prompt/change`，不会每个 tick 刷新。它是 DSH profile 级别的 system prompt，同一
profile 的 Agent 都可能看到，因此文案保持短，只描述 Mebular 自身可用性。

- `systemPrompt` 服务不存在时（旧 DSH / 无该服务的 profile）安全跳过，不影响插件激活、
  面板或 MCP bridge；`panel: false` 也不会关闭它，因为它是 prompt 文本而不是 UI。
- 它是 DSH adapter 能力，不是 wire 字段，也不是通用 MCP 能力。不要假设所有 MCP 客户端
  都会收到这条提示；Mebular 不新增 `mebular_status` 工具。

## 3. Reason 码

Reason 是稳定、可编程的诊断码；展示文案由各表面本地化，不得把 reason 直接当 UI 文案。

| Reason | 来源 | 含义 | 用户恢复动作 |
|---|---|---|---|
| `daemon_unreachable` | DSH host、MCP bridge | 配置的 loopback 地址上没有健康 daemon。 | 启动 Mebular App，或运行 `mebular serve`；DSH 面板与 MCP 工具会自动恢复。 |
| `daemon_unhealthy` | DSH host | daemon 有响应，但 `/healthz` 未报告健康。 | 查看 Mebular 日志，修复后刷新；必要时重启 daemon。 |
| `managed_cli_missing` | DSH managed | managed 模式找不到 Mebular CLI，已降级为 attach。 | 安装 Mebular，或设置 `MEBULAR_CLI` / 插件 `cliPath`，然后重启 DSH。 |
| `managed_start_failed` | DSH managed | managed 子进程未在时限内健康，或提前退出。 | 查看日志，或手动启动 Mebular；daemon 恢复后工具自动挂载。 |
| `embed_info_unavailable` | DSH host | daemon 在跑，但没有可用的 `/app/embed/info`（旧版本，或当前引导态返回 `409`）。 | 升级 Mebular；若刚建/加入忆云，先完成 Console provisioning。 |
| `embed_not_ok` | DSH host | `/app/embed/info` 明确返回 `ok: false`。 | 检查 Mebular 版本与 daemon 状态。 |
| `not_loopback` | DSH host | daemon 或 DSH 不在 loopback，嵌入被禁用。 | 改用 loopback 地址，或在浏览器打开 Console。 |
| `embed_protocol_unsupported` | DSH host | Console 的 embed protocol 与插件不一致。 | 升级插件或 Mebular，使 `embedProtocol` 对齐。 |
| `embed_unsupported` | DSH host | daemon 不提供 Console 嵌入能力。 | 升级 Mebular；或在浏览器使用 Console。 |
| `embed_url_invalid` | DSH host | 发现结果里的 Console/embed URL 不是 loopback HTTP(S)。 | 修正 daemon 配置；面板不会加载该 URL。 |
| `frame_blocked` | DSH client | iframe 被 CSP/跨源策略阻止或加载超时。 | 在浏览器打开 Console；检查 Console 安全头。 |
| `unknown` | DSH client | 没有可识别的 reason。 | 打开 Console 查看 daemon 状态。 |

DSH MCP bridge 另有日志诊断码 `daemon_starting`、`peer_missing`、`ctx_unavailable`、
`mcp_client_start_failed`；它们描述 DSH 本地挂载问题，不出现在 `/mebular/embed-info`
的 `reason` 中。

## 4. Surface matrix

| 表面 | 状态来源 | `up` | `starting` | `down` | `degraded` | 恢复入口 |
|---|---|---|---|---|---|---|
| Desktop App | `/healthz` + 实例身份 + 进程托管状态 | 正常窗口/托盘 | 启动中 | 启动失败或实例退出 | 按 App 自己的诊断展示，不消费 DSH embed-info | App 内启动/重启、向导、日志 |
| Console（浏览器） | 自身 origin 的 `/healthz` 与 Admin API | 完整控制台 | 不适用（页面随 daemon 启动） | 页面不可达 | 只读/受限能力按 Console 自身状态展示 | 刷新页面；启动 daemon |
| CLI | `mebular status` / `doctor` / `service status`；`/healthz` | 正常输出 | managed/服务启动中 | 非零退出或结构化错误 | 按具体命令输出 | `mebular serve`、`service install`、`doctor` |
| MCP 客户端 | `/mcp` 握手与工具调用 | 工具可调用 | DSH 不挂载客户端 | 连接失败 | `NOT_INITIALIZED`（协议层可用、业务调用被拒） | 启动 daemon；完成 provisioning |
| DSH Web/Desktop | `/healthz` + `/app/embed/info` → `/mebular/embed-info` | 绿点；embed 就绪时加载共享 Console；Agent 提示为空 | 琥珀点；启动占位页；Agent 提示说明暂不可用 | 红点；离线占位页与 CTA；Agent 提示说明未运行 | 琥珀点；说明具体 `embed_*` reason | 启动 daemon / 修复配置；面板、MCP 与 Agent 提示自动恢复 |

DSH 客户端把 `connected` / `starting` / `unavailable` / `offline` / `checking` 映射为
绿 / 琥珀 / 琥珀 / 红 / 灰，并在状态点上提供 `title`（例如 `Mebular: Connected`）。
颜色不是唯一信息；文案与 reason 必须同时可读。

## 5. Wire 快照

`GET /healthz`（已初始化或引导态都返回）：

```json
{
  "status": "ok",
  "name": "mebular",
  "version": "0.1.2",
  "auth": "none",
  "tls": false,
  "instance": "<home-key>"
}
```

`GET /app/embed/info`（READY + loopback）：

```json
{
  "ok": true,
  "name": "mebular",
  "version": "0.1.2",
  "embedProtocol": 1,
  "consoleUrl": "http://127.0.0.1:7331/console",
  "embedUrl": "http://127.0.0.1:7331/console/?embed=dsh",
  "mcpUrl": "http://127.0.0.1:7331/mcp",
  "loopback": true,
  "capabilities": { "embedConsole": true }
}
```

`GET /mebular/embed-info`（DSH host，loopback-only）：

```json
{
  "ok": true,
  "status": "up",
  "mode": "attach",
  "managed": false,
  "panel": true,
  "version": "0.1.2",
  "embedProtocol": 1,
  "consoleUrl": "http://127.0.0.1:7331/console",
  "embedUrl": "http://127.0.0.1:7331/console/?embed=dsh",
  "mcpUrl": "http://127.0.0.1:7331/mcp",
  "loopback": true,
  "reason": null
}
```

DSH 的 `status` 只有 `up` / `down` / `starting`；`ok` 为 `true` 仅当 `status: "up"` 且
`reason` 为 `null`。`starting` 与任何带 reason 的 `up` 都不会给出 `embedUrl`。

## 6. 已知缺口（只记录，不在本轮实现）

1. **`uninitialized` 没有独立 reason**：引导态的 `/app/embed/info` 返回 `409`，DSH 只能
   显示 `up` + `embed_info_unavailable`。未来若要区分，需要 daemon 在引导态提供只读
   discovery，或返回一个稳定 reason；本轮不新增。
2. **同步/ready 没有 discovery 字段**：`/healthz` 的 `status: "ok"` 不等于 READY，也不
   表示同步完成。需要判断业务就绪时，以 MCP `NOT_INITIALIZED` 或 Console/Admin 数据为准。
3. **DSH 的 `degraded` 是推导值**：wire 上仍是 `status: "up"` + `reason`，没有单独的
   `degraded` 字段。各表面应按 reason 展示，不要新增同义 status。

## 7. 边界

- 本契约覆盖状态、能力与恢复语义，不覆盖视觉规范、组件结构或轮询实现。
- Console、DSH client 与 Desktop App 不互相 import；DSH client 只依赖 React 和
  loopback HTTP，不 import `@mebular/*`。
- Agent 可见状态属于 DSH adapter；Mebular 核心、daemon、Console 与桌面 App 不提供、
  也不依赖这条提示，其他 MCP 客户端不应假设它存在。
- 任何新状态或 capability 必须先落在这个矩阵里，再进入 wire；禁止只在某一个 UI 中
  发明无法映射到 daemon/DSH 的事实。
