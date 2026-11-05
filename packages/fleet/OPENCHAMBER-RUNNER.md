# OpenChamber public runner（Fleet 执行入口）

> 状态：0.3.2 canonical。`kind=openchamber` 只对接本文的公开 runner 协议；仓库内不再保留私有 bridge/seam 实现。
>
> 实现：`@mebular/opencode-plugin/fleet-runner`（宿主侧） + `packages/fleet/src/runtime/openchamber-runner.ts`（Fleet 侧）。

## 1. 定位

- Fleet 的 `kind=openchamber` 通过一个**本机回环 HTTP runner**执行任务，入口是 `POST /v1/run-once`。
- runner 由 OpenChamber/OpenCode 进程内的 `@mebular/opencode-plugin/fleet-runner` 插件启动；它调用宿主 `client.session.create` / `client.session.prompt`，**不打开 GUI**，也不依赖任何私有 bridge、skill 或外部 daemon。
- Fleet 侧只做平台翻译：`OpenChamberRunnerAgent` → `OpenChamberRunnerClient` → 一次 HTTP 请求。并发、超时上限、输出截断与结果归一仍由公共执行层负责。
- **一个 Fleet task = 一个全新 session**。请求不接受 `sessionId`；客户端永远不续接/恢复已有会话。

## 2. 默认关闭与启用

runner **默认关闭**，缺少配置时不会监听端口，也不会生成 discovery 文件。

在插件配置（默认 `$MEBULAR_HOME/opencode-plugin.json`，或 `MEBULAR_OPENCODE_PLUGIN_CONFIG` 指向的文件）中加入：

```json
{
  "fleetRunner": {
    "enabled": true
  }
}
```

也可以通过插件 options 传入同一 `fleetRunner` 段。可用键：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 只有显式 `true` 才启动 runner |
| `host` | `127.0.0.1` | 只允许回环（`127.0.0.1` / `localhost` / `::1`） |
| `port` | `0` | `0` 表示随机端口 |
| `discoveryFile` | `$MEBULAR_HOME/openchamber-runner.json` | discovery 路径 |
| `requestTimeoutMs` | `600000` | 单次运行上限，最大 600000 |

限制与边界：

- 同一 home 只允许一个存活 runner 持有 discovery；已有存活 pid 时启动失败为 `FLEET_RUNNER_ALREADY_RUNNING`。
- discovery 文件以 `0600` 写入；home 目录尽量为 `0700`。
- runner 未启用时，`fleet quickstart` / `fleet join` **不会**自动声明 `openchamber`（不伪造可执行能力）；需要时由用户显式配置 `kind=openchamber`。

## 3. Discovery / token

Fleet 默认读取 `<MEBULAR_HOME>/openchamber-runner.json`（`MEBULAR_HOME` 缺省 `~/.mebular`）。文件形状：

```json
{
  "schema": 1,
  "kind": "mebular-openchamber-runner",
  "pid": 12345,
  "port": 49152,
  "host": "127.0.0.1",
  "token": "<32-byte hex>",
  "version": "0.3.2",
  "startedAt": 1760000000000,
  "updatedAt": 1760000005000
}
```

Fleet 侧校验（任一失败 → `ADAPTER_UNAVAILABLE`，fail-closed）：

- `schema === 1` 且 `kind === 'mebular-openchamber-runner'`；
- `port` 为 1–65535，`host` 必须是回环地址；
- `updatedAt` 在 15 秒内（runner 每 5 秒心跳刷新）；
- `pid` 进程存活；
- `token` 非空。

token 只存在于 discovery 文件与 HTTP `Authorization: Bearer <token>` 头。它不会进入任务事件、日志、能力卡、健康详情或错误文本。Fleet **不接受**任务 payload 或远端下发 endpoint/token。

## 4. `POST /v1/run-once`

请求头：`content-type: application/json`、`authorization: Bearer <token>`。

```json
{
  "prompt": "…",
  "timeoutSec": 600,
  "title": "fleet <taskId>",
  "agent": "build",
  "model": "provider/model"
}
```

- `prompt`：必填、非空、UTF-8 ≤ 64 KiB。
- `timeoutSec`：可选整数 1–600；缺省用 runner 的 `requestTimeoutMs`。
- `title`：可选，≤ 512 bytes；Fleet 缺省 `fleet <taskId>`。
- `agent` / `model`：可选；由本机配置/调用方给出，不从远端任务透传。
- **禁止** `sessionId`：出现即 `400 BAD_REQUEST`（只允许新 session）。

成功响应：

```json
{
  "ok": true,
  "result": {
    "sessionId": "ses_…",
    "text": "final assistant text",
    "ms": 1234
  }
}
```

错误响应：

| HTTP | `error` | Fleet 归一 |
|---|---|---|
| 400 | `BAD_REQUEST` | `PROTOCOL_ERROR` |
| 401 | `UNAUTHORIZED` | `AUTH_FAILED` |
| 413 | `PAYLOAD_TOO_LARGE` | `PROTOCOL_ERROR` |
| 502 | `SESSION_CREATE_FAILED` / `PROMPT_FAILED` | `PROTOCOL_ERROR` |
| 503 | — | `ADAPTER_UNAVAILABLE` |
| 504 | `TIMEOUT` | `TIMEOUT` |

整体限制：

- 请求体 ≤ 256 KiB；prompt ≤ 64 KiB；单次运行 ≤ 600 秒。
- 响应体在 Fleet 侧限制为 4 MiB；超出或非 JSON → `PROTOCOL_ERROR`。
- 客户端 abort（超时/取消）会销毁连接；runner 观察到连接断开后尽力 `session.abort`。

## 5. Fresh-session 与安全

- runner 每次请求都先 `client.session.create` 再 `session.prompt`，不读取也不复用旧 session。
- Fleet 的 fresh-session 黑名单仍适用于 `baseArgs`/`promptArgs`；`kind=openchamber` 本身不接收 command/baseArgs，避免把 resume 参数带进 runner。
- 只绑定回环地址；token 使用随机 32 字节并与请求头做常量时间比较。
- 任务只在执行设备本地执行；远端只能看到 Agent 目录里的 `kind + capabilities + executable + executionMode`，看不到 discovery、token、session 或命令。

## 6. 与 `opencode run` CLI 的区别

| 维度 | `kind=opencode` | `kind=openchamber` |
|---|---|---|
| 入口 | `opencode run` CLI（`OpenCodeAgent`） | 本机回环 runner `POST /v1/run-once` |
| 宿主 | 独立 CLI 进程 | 运行中的 OpenChamber/OpenCode 进程内插件 |
| 默认状态 | CLI 在 PATH 即声明 | runner 默认关闭，需显式启用 |
| 会话 | 每次新进程/新 session | 每次 `session.create` 新 session |
| 输出 | stdout | 最终 assistant 文本 |
| 适用 | 无 OpenChamber 或希望进程隔离 | 需要复用已运行宿主/会话模型，但仍要求每任务新 session |

## 7. 排障

- `ADAPTER_UNAVAILABLE` 且 detail=`discovery_not_found`：runner 未启用或 discovery 路径不是 `<MEBULAR_HOME>/openchamber-runner.json`。
- detail=`discovery_stale`：runner 心跳停止（进程挂起/被休眠）；`discovery_pid_dead`：宿主进程已退出。
- `AUTH_FAILED`：discovery token 与运行中 runner 不一致（通常是旧文件/多实例）。
- `TIMEOUT`：超过请求的 `timeoutSec` 或 runner 上限 600 s。
- 真实 OpenChamber 任务 E2E 由后续验收会话补齐；当前 Fleet 侧回归使用 fake runner HTTP server，不依赖真实宿主。
