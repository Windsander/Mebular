# OpenChamber Agent 接缝（fleet 侧中立协议）

## 定位

fleet 对 provider **毫不知情**。Mebular 侧只保三样东西：

- **接口** `OpenChamberSessionSeam`（`prompt(input) → { text, sessionId?, error? }`）；
- **执行器** `OpenChamberAgent`（把任务 `intent` 交给 seam；成功→文本截断、`reason=session:<id>`；失败→`failed(OPENCHAMBER_ERROR: …)`）；
- **中立 HTTP 客户端** `HttpOpenChamberSeam`（只做「POST 一个端点 + 带 token + 超时」）。

provider 实现留在**外部**。当前 **provider #1 = Self-Skills 的 oc-hermes-bridge daemon**（`POST /agent/run-once`，转发给 OpenChamber 进程内插件执行 `client.session.*`）。将来可换**独立 provider** 或 **OpenChamber 官方 API**：只要满足下方协议，**替换不影响 fleet 代码**。

## fleet 侧配置（`HttpOpenChamberSeam`；`OpenChamberAgent` 另可传 agent/model/cwd/maxOutputBytes）

| 项 | 选项 | env | 说明 |
|---|---|---|---|
| 端点 | `endpoint` | `MEBULAR_FLEET_OPENCHAMBER_ENDPOINT` | **完整 URL**（路径由 provider 决定） |
| 令牌 | `token` / `tokenFile` + `tokenJsonPath` | `..._TOKEN` / `..._TOKEN_FILE` / `..._TOKEN_JSON_PATH`（默认 `token`） | 内联，或从文件读（JSON 按点分路径，否则整文件文本） |
| 鉴权头名 | `authHeader` | `..._AUTH_HEADER`（默认 `X-Bridge-Token`） | provider 决定 |
| 超时 | `timeoutMs` | — | 默认 600000ms，上限 600s |

**代码里不含任何 bridge/hermes 专有字段或路径假设**；provider 接线（读 daemon.json、拼端口）在调用方/脚本侧。

## provider 本地协议（客户端所 speak 的契约）

- **方法/路径**：`POST <endpoint>`，`Content-Type: application/json`。
- **鉴权**：由 `authHeader` 指定的头携带 token（provider #1 用 `X-Bridge-Token`）。
- **请求体**：`{ "prompt": string, "timeoutSec"?: int, "agent"?: string, "model"?: string }`。
- **响应**：
  - `200 {"ok": true, "result": {"sessionId": string, "text": string, "ms": number}}`
  - `200 {"ok": false, "error": string}`（会话失败 / 超时 / provider 离线）
  - `401 {"ok": false, "error": "unauthorized"}`
  - `413 {"ok": false, "error": "payload too large"}`
- **上限**：请求体 ≤ 256 KiB；`prompt` ≤ 64 KiB；`timeoutSec` ≤ 600。
- **映射**：任何错误/超时 → fleet 归一到 `OPENCHAMBER_ERROR: <error>`。

## provider #1：oc-hermes-bridge（当前实现）

- 实现（外部仓库 Self-Skills）：`skills/oc-hermes-bridge` —— daemon 新增 `POST /agent/run-once`，经 `inbox.jsonl → 插件 client.session.* → outbox.jsonl` 开**新**会话并等待回复；回环 + daemon token（`daemon.json` 0600，按 daemon 启动轮换）；prompt/token 不落日志；不接受外部 `sessionId`（始终新建）。
- provider 侧接线（示例见 `scripts/verify-fleet-agents.mjs --with-openchamber`）：读 `~/.oc-hermes-bridge/daemon.json` 取 `port`/`token`，`endpoint = http://127.0.0.1:<port>/agent/run-once`，`tokenFile = <bridgeDir>/daemon.json`，`tokenJsonPath = 'token'`。

## 部署依赖与降级

- fleet 的 OpenChamber 派活**需要桥 daemon 在线**（provider #1）。**无桥环境默认降级**：`--with-openchamber` 缺省关，测试/CI 用确定性 **fake provider**（本地 fake HTTP server），不依赖 OpenChamber。
- 替换 provider：提供满足上表契约的 `endpoint`+`token` 即可；`OpenChamberAgent`/`HttpOpenChamberSeam` 不改。
