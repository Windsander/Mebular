# OpenChamber Agent 接缝调研（M4 目标一 · 次优先）

结论：**当前没有可被 fleet（外部进程）稳定调用、且非私有的“运行一次会话/提示”接缝**。故本轮
**只落地接口**（`src/runtime/openchamber.ts` 的 `OpenChamberSessionSeam` + `OpenChamberAgent`）并文档化
所需接缝；**不臆造**、不硬编码私有 token。这是一个**停下报告**点（见 goal「停下条件 ②」）。

## 调研到的事实

| 候选接缝 | 位置/形态 | 能否被 fleet 进程使用 | 原因 |
|---|---|---|---|
| in-app agent-tool | `http://127.0.0.1:57123/api/openchamber/agent-tool`，动作 `session.create/send/messages` | ✗ | 需要 OpenChamber 管理的 `OPENCHAMBER_AGENT_TOOL_TOKEN`（仅 OpenChamber 会话内有）；且动作面固定（projects/sessions/schedule），非公开稳定 API |
| 本地 HTTP API | `/api/openchamber/sessions*` 等 | ✗ | 返回 `Authentication required` / `UI authentication required`；鉴权为 OpenChamber UI 会话 |
| OpenChamber 插件 | `oc-bridge.js`（`client.session.*`） | ✗ | 只存在于 OpenChamber 进程内，外部进程无法调用 |

> 复核命令（不打印任何凭据）：`curl -sS http://127.0.0.1:57123/api/openchamber/sessions` 会返回鉴权错误；
> agent-tool 端点对未带 token 的请求返回 `Authentication required`（见仓库 PR 讨论）。

## fleet 已提供什么

- `OpenChamberSessionSeam`：`prompt({prompt,cwd?,model?,agent?,timeoutMs?}) → {text,sessionId?,error?}`。
- `OpenChamberAgent`：实现 `TaskExecutor`，把任务 `intent` 交给 seam；成功→结果=文本（截断）、`reason=session:<id>`；
  失败→`failed` 且 `reason=OPENCHAMBER_ERROR: …`。

## 需要 OpenChamber 侧提供的最小接缝（二选一）

1. **插件注册执行器**：在 OpenChamber 插件里提供 `session.prompt` 的**受控外部入口**（例如经本地 socket + 一次性能力令牌，
   或 MCP 工具），并注入 `OpenChamberSessionSeam` 的实现；fleet 只依赖该接口。
2. **受鉴权的本地会话 API**：为“运行一次提示”提供带最小 scope 的本地 HTTP 接口（带按会话/按次令牌），
   文档化请求/响应与错误语义；同样由 seam 适配。

两者都需要 **OpenChamber 侧改动**（本 goal 明确不做），因此在此停下等待决定，不在 fleet 内发明通道或搬运私有 token。

## 安全红线（若未来接线）

- 不打印/不落盘任何凭据；seam 实现不得把 token 写入任务事件或日志。
- 参数以结构化字段传递（不 shell 拼接）。
- 超时/取消语义由 seam 明确（超时→任务 `failed` 带原因）。
