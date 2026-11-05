# Fleet Agent 矩阵与 Executor/Adapter 契约

> 状态：canonical（Fleet 0.3.2 目标契约）
> 基线：`feat/fleet-orchestration` @ `44e4d50`
> 范围：Fleet 如何把任务交给**执行设备上的 Agent**，以及 Console/MCP 客户端如何**派发**。
> 非目标：不新增协议/线格式/状态机；不改 `@mebular/core`；不在 Console 新增 Fleet 专用 UI。

本文区分**现状**与**目标契约**：

- **现状**以 `packages/fleet/src/config.ts` 的 `FleetAgentKind` 为准：`echo`、`command`、`hermes`、`openchamber` 已交付。
- 矩阵中标注「待实现」「条件」「否」的行，是 0.3.2 的边界承诺，**不是已交付能力**。
- 0.3.2 新增的 `executionMode`、`executable`、`promptArgs`、`promptMode` 等配置字段，需由实现会话落到 `validateFleetConfig` 与执行器构造；在落地前不得假设它们已被接受。

本文中的「客户端」指能与本机 Mebular 守护建立 MCP 连接（HTTP `/mcp` 或 stdio）的 AI 助手/Console。连接方式由 `mebular print-config --client <id>` 与本机 assistant descriptor 决定。

## 1. 两个角色：派发方 ≠ 执行方

Fleet 有两个正交平面：**派发面**（task 工具/MCP）与**执行面**（执行设备本地的 adapter）。同一个客户端可以同时扮演两个角色，但两条链路独立验收。

| 维度 | 派发方（dispatcher） | 执行方（executor） |
|---|---|---|
| 典型载体 | Console / MCP 客户端 / `fleet task_*` CLI | 执行设备上的 fleet daemon + 本机 Agent/adapter |
| 关键动作 | `task_submit`、`task_submit.plan`、`task_status`、`task_cancel`、`task_retry`、`task_targets` | 按 `to.device`/`to.agent` 取任务，调用 adapter 真正运行 |
| 必要前提 | 已连接本机守护；与目标任务域有 L1 订阅交集；本机配额允许 | 本机 `fleet.config.json` 声明 agent；adapter 已安装且健康探测通过 |
| 能力来源 | MCP 工具面 / `fleet task_*` CLI | `FleetAgentKind` + adapter + `ExecutorRegistry` |
| 不负责 | 不执行 intent；不持有远端命令/凭据；不替执行方做健康检查 | 不做全网调度/配额账本；不读取派发方 env/token；不改变任务语义 |
| 失败语义 | 入口拒绝（配额/订阅/预算/plan 校验） | `failed` + reason（`TIMEOUT`/`EXIT_n`/`ADAPTER_UNAVAILABLE`/…） |

必须遵守的口径：

1. **「能调用 `task_submit`」不等于「能执行任务」。** Console 默认只是派发方；只有本机配置了对应 `kind` 的 adapter，才同时是执行方。
2. **不要写成「所有 Console 客户端都能执行」。** 执行列写「待实现/条件/否」的行就是不能执行；也不能靠「客户端已安装」推断「adapter 已就绪」。
3. 派发方与执行方的授权彼此独立：L1 订阅决定**能不能读到任务域**，本机 `config.agents[]` + adapter 决定**能不能真正运行**。`task_targets` 是两者交集后的权威视图。
4. 任务 payload 只承载 `intent`/路由/预算/追踪；**命令、参数、env、token 永远由执行设备本地配置提供**，不从任务或远端下发。

## 2. Canonical Agent 矩阵

记号：

| 记号 | 含义 |
|---|---|
| `现有` | 0.3.2 已交付，可被 `task_targets` 选中 |
| `待实现` | 契约已定，adapter 未交付；不得发布为可执行目标 |
| `条件` | 仅当执行设备运行时验证通过，才可执行 |
| `否` | 没有执行入口 |
| `demo` | 仅演示/看板，不承担真实工作 |
| 自动建联 `是` | assistant descriptor 可探测并自动写入 MCP 配置（`mebular print-config --client <id>`） |
| 自动建联 `片段` | 只提供手工粘贴片段，不自动写入 |
| 自动建联 `n/a` | 不是可建联客户端 |

| 客户端 | 自动建联 | 可作为派发方 | 可作为 Fleet 执行方 | adapter / 入口 | 限制 |
|---|---|---|---|---|---|
| `openchamber` | 是（复用 OpenCode global 配置） | 是 | **是（现有）**，但依赖 bridge | `kind=openchamber`；`OpenChamberAgent` → `HttpOpenChamberSeam` → `POST /agent/run-once` | 必须有 `oc-hermes-bridge` daemon；**无桥即不可执行**；仅本机端点 + token；请求 ≤256 KiB、prompt ≤64 KiB、timeout ≤600 s；每次新建 session；错误归一 `OPENCHAMBER_ERROR` |
| `hermes` | 是（`~/.hermes/config.yaml`，热生效） | 是 | **是（现有）** | `kind=hermes`；`HermesAgent`；`hermes [-p P] [-t T] [-m M] [--in DIR] -z <prompt>` | 需要 `hermes` CLI；one-shot；stdout 即结果；默认 600 s；超时/非零退出 → `failed`；只透传 env allowlist；大 prompt 受 argv 上限约束 |
| `opencode` | 是（`~/.config/opencode/opencode.json`，重载生效） | 是 | **待实现** | `kind=opencode`（计划）；`opencode run <prompt>` | 0.3.2 无执行 adapter；只能派发；实现前不得出现在可执行目录/能力卡 |
| `claude-code` | 是（`~/.claude.json`，重启生效） | 是 | **待实现** | `kind=claude-code`（计划）；`claude -p <prompt>` | 非交互 one-shot；0.3.2 未实现；只可派发 |
| `claude-desktop` | 是（`claude_desktop_config.json`，重启生效） | 是 | **否**（无 CLI） | 仅 MCP 客户端 | dispatch-only；没有终端入口；不得用 UI 自动化冒充 executor |
| `cursor` | 是（`~/.cursor/mcp.json`，重启生效） | 是 | **条件**：仅 `cursor-agent` 可用且验证通过 | 候选 `kind=cursor`；`cursor-agent` one-shot（flag 以本机 `--help` 验证为准） | GUI 本身不可执行；未验证 → dispatch-only；验证项含非交互、exit code、stdout、超时、可取消；不得把 GUI 当 CLI |
| `dsh` | 是（项目 `.dsh/cordis.yml` 或用户 `~/.dsh`） | 是 | **待实现**（v1 计划） | `kind=dsh`（计划）；v1 `dsh --profile headless "<job>"`；v2 `dsh --profile sdk` JSON-RPC | v1 one-shot session、stdout final answer、exit code 表示完成；大 prompt 可走 stdin；JSON-RPC（`initialize` / `session` / `prompt` / `session/wait`）留 v2；**现有 `@mebular/dsh-plugin` 是 Web/记忆桥，不是 Fleet executor** |
| `generic` | 片段（仅复制） | 是（若接 MCP） | **是**（`kind=command` 逃生口） | `kind=command`；`command` + `baseArgs` + `promptArgs` + `promptMode` | 完全由本机配置负责；不经 shell；argv 注入面由配置作者承担；大 prompt 用 `promptMode: stdin` |
| `echo` | n/a | 否 | **demo（现有）** | `kind=echo`；`EchoExecutor` → `echo:<intent>` | 确定性 demo；无真实副作用；不得作为 plan owner/MR |
| `board` | n/a | 否 | **否**（看板占位） | board task target / plan owner 占位 | demo/看板；不是 Agent，不运行命令；plan 提交时归一化到本机真实 agent，否则 `PLAN_OWNER_UNEXECUTABLE`；不得作为 plan owner/MR |

### 2.1 Hermes

- 使用现有 `hermes` CLI；`kind=hermes` 已接入 `HermesAgent`。
- 调用形状：`hermes [-p <profile>] [-t <toolsets>] [-m <model>] [--in <dir>] -z <prompt> --usage-file <tmp>`。
- 一次性非交互执行；成功以 stdout 作为 `resultRef`；`--usage-file` 里的 `session_id` 只用于观测，不作为任务身份。
- 超时、非零退出、spawn 失败一律 `failed`，附 `TIMEOUT`/`EXIT_<code>` 与 stderr 尾部。
- 不继承 daemon 全量 env；只走 `ENV_ALLOWLIST` 与本地显式配置。

### 2.2 DSH

- **v1（计划）**：官方 `dsh --profile headless "<job>"`。一次性 session，stdout 为 final answer，exit code 表示完成；大 prompt 可走 stdin。adapter 必须在探测阶段确认当前 DSH 版本是否支持对应的 stdin 形态，不支持则 fail-closed 为 `PROMPT_TOO_LARGE`。
- **v2（以后）**：`dsh --profile sdk` 的 JSON-RPC（`initialize` / `session` / `prompt` / `session/wait`）。v2 才处理长会话、增量事件与显式中断；0.3.2 不实现。
- **现有 `@mebular/dsh-plugin` 是 Web/记忆桥，不是 Fleet executor。** 它可以作为 MCP 派发方连接守护，但不会让 DSH 自动获得执行能力；执行能力只来自执行设备本地的 `kind=dsh` adapter。

### 2.3 OpenCode

- 计划入口：`opencode run <prompt>`，一次性非交互执行。
- 0.3.2 只有契约，没有 adapter；因此 OpenCode 目前是 **dispatch-only**。
- 通过 `mebular print-config --client opencode` 接入 MCP 只解决派发，不解决执行；不得据此在 Agent 目录发布可执行条目。

### 2.4 Claude Code

- 计划入口：`claude -p <prompt>`，`-p` 非交互 one-shot。
- 0.3.2 只有契约，没有 adapter；目前是 **dispatch-only**。
- 成功判定：exit code 0 且 stdout 非空；stderr 只作为失败证据，不进入 `resultRef`。

### 2.5 OpenChamber

- 执行入口是 HTTP bridge（`oc-hermes-bridge`）的 `POST /agent/run-once`，不是 OpenChamber 的 GUI。
- **没有桥就不可执行。** 桥不在线、token 缺失、端点不可达时，任务必须失败（目标码 `ADAPTER_UNAVAILABLE`/`AUTH_FAILED`；当前实现统一归一到 `OPENCHAMBER_ERROR`，细化属于 0.3.2 实现项），不得静默降级到其它 agent。
- endpoint/token 只在执行设备本地：`tokenFile` 指向 `daemon.json` 之类的 0600 文件；token 不上网、不进任务事件、不落日志、不出现在错误文本。
- provider 可替换；fleet 侧只依赖 `OpenChamberSessionSeam` 契约，不假设 bridge 的私有字段。

### 2.6 Cursor

- 只有 `cursor-agent` 可用**且验证通过**时，Cursor 才可作为 Fleet 执行方；否则一律 **dispatch-only**。
- 验证至少覆盖：非交互调用、exit code 语义、stdout final answer、超时、取消、参数传递（不经 shell）。
- 不得用 GUI 自动化、AppleScript 或模拟点击冒充执行器；那既不可观测，也不可取消。

### 2.7 Claude Desktop

- **dispatch-only，无 CLI。** 它可以通过 MCP 调用 `task_submit`/`task_status`，但不能接收并运行 Fleet 任务。
- 不得为它伪造 executor；也不得把它的 MCP 连接误写成「已具备执行能力」。

### 2.8 generic（`command` 逃生口）

- 用于没有一等 adapter 的本地 CLI：`kind=command` + `command` + `baseArgs` + `promptArgs` + `promptMode`。
- 参数按数组传给 `spawn`，**绝不 shell 拼接**；`{prompt}` 只作为单个 argv 元素展开，不做二次解析。
- `promptMode`：
  - `argv`：prompt 作为参数，受 OS argv 上限约束；
  - `stdin`：prompt 写入 stdin，适合大 prompt；
  - `auto`：按 prompt 字节数与 adapter 能力在本地选择；两者都不支持时失败为 `PROMPT_TOO_LARGE`。
- 该入口完全信任本机配置作者：命令、env、工作目录都由本地决定；远端无法下发这些字段。

### 2.9 echo / board

- `echo` 是内置确定性执行器，只返回 `echo:<intent>`；用于本地/CI 验证，不产生真实副作用。
- `board` 是看板/占位目标，不是 Agent，也不运行命令；普通 task 的默认 `to.agent=board` 只是占位。
- 两者都是 **demo**：**不得作为 plan owner 或 MR 执行者**（`MR` 指 root plan 的唯一最终 step，`kind="mr"`）。plan 提交必须落到本机真实可执行 agent；没有可用 agent 时 fail-closed 为 `PLAN_OWNER_UNEXECUTABLE`，绝不创建 plan/root。
- 当前实现只校验「agent 名是否在本机 `config.agents[]`」；把 echo/board 显式排除出 plan owner/MR 属于 0.3.2 的收紧项（见 §6）。

## 3. Executor / Adapter 契约草案

### 3.1 分层

```text
┌────────────────────────────────────────────────────┐
│ Fleet core（平台无关）                             │
│  TaskExecutor.execute(task) → ExecutionOutcome     │
│  路由 / 配额 / 状态机 / plan / 记忆同步             │
└───────────────────────┬────────────────────────────┘
                        │
┌───────────────────────▼────────────────────────────┐
│ 公共执行层（所有 adapter 共用，不重复实现）         │
│  并发 · 超时 · AbortSignal · env 白名单             │
│  输出截断 · 结果归一 · 执行日志 · 健康探测          │
└───────────────────────┬────────────────────────────┘
                        │
┌───────────────────────▼────────────────────────────┐
│ Adapter（只做平台翻译，安装在执行设备本地）         │
│  cli-one-shot · http-json · jsonrpc                 │
└───────────────────────┬────────────────────────────┘
                        │
        Hermes / DSH / OpenCode / Claude Code /
        OpenChamber bridge / command / …
```

术语：

- **Executor**：fleet 侧对象，实现 `TaskExecutor.execute(task) → ExecutionOutcome`，负责把任务接到公共层。
- **Adapter**：执行设备本地的平台翻译层，只懂某个客户端的 CLI/HTTP/JSON-RPC；不参与路由、配额、状态机与记忆写入。
- **公共执行层**：跨 adapter 的横切能力；adapter 不得各自实现一套，否则超时、取消、脱敏与截断语义会漂移。

### 3.2 公共层职责（adapter 不得重复实现）

> 以下是 0.3.2 的**目标契约**。当前实现已具备并发（`command`/`hermes`）、超时、env 白名单、输出截断与执行日志；**AbortSignal/取消、统一健康探测、`openchamber` 并发闸仍需实现**，不得把本节读成现状。

1. **并发**：每 agent 一个 FIFO semaphore。默认 `command=1`、`hermes=2`；`openchamber` 在公共层接入后目标默认 2（当前没有并发闸）。上限来自本机 config，不来自远端；超额本地排队或拒绝（本地记账），不依赖全局账本。
2. **超时**：`timeoutMs` 到点终止子进程或 HTTP 请求；结果 `failed` + `TIMEOUT after <n>ms`；必须杀进程组，避免孤儿进程。
3. **取消**：`AbortSignal` 由 `task_cancel` 触发；adapter 必须响应并尽快停止子进程/连接；取消写 `failed` + `CANCELLED`（协议现状），迟到的输出丢弃。
4. **env 白名单**：只传 `ENV_ALLOWLIST` + 本地 config 显式 `env`；绝不继承 daemon 全量 env；不打印、不落盘 env 值。
5. **输出截断**：UTF-8 安全，默认 65,536 bytes；超出追加 `…[truncated N bytes]`；`resultRef` 默认取截断后的 stdout。
6. **结果/错误归一化**：统一 `{ ok, resultRef?, reason? }`；reason 使用稳定码（见下表）；stderr 只保留尾部 ≤800 字符并脱敏。
7. **执行日志**：按 `taskId` 的 append-only `ExecutionLog`；同一 taskId 的成功结果不重复执行；重启可恢复；失败重试以新任务/新事件表达。
8. **健康探测**：`fleet doctor` 与 adapter `probe()` 检查可执行文件、版本、端点、鉴权是否配置；只输出布尔/原因，绝不输出 token/env；探测失败 → 不发布可执行能力（目标契约）。

错误码（稳定集合，新增需文档同步）：

| reason | 含义 | 产生层 |
|---|---|---|
| `TIMEOUT after <n>ms` | 超时 | 公共层 |
| `EXIT_<code>: <stderr tail>` | 非零退出；spawn 失败时 `code=null` | 公共层 |
| `CANCELLED` | 任务被取消 | 公共层 |
| `ADAPTER_UNAVAILABLE` | 无对应 kind/adapter，或平台不满足 | 执行器 |
| `PROMPT_TOO_LARGE` | argv/stdin 都无法承载 prompt | 公共层 |
| `AUTH_FAILED` | 401/凭据缺失 | adapter |
| `PROTOCOL_ERROR` | HTTP/JSON-RPC 响应不符合契约 | adapter |
| `OPENCHAMBER_ERROR: <err>` | bridge/provider 返回错误 | adapter |

### 3.3 Adapter 只做什么

| executionMode | 输入 | 输出 | 典型 |
|---|---|---|---|
| `cli-one-shot` | prompt（argv 或 stdin）+ 本地固定参数 | stdout + exit code | hermes、dsh、opencode、claude-code、command、cursor-agent |
| `http-json` | prompt + 本地 endpoint/token | JSON `{ ok, result, error }` | openchamber bridge |
| `jsonrpc` | JSON-RPC 请求/响应 + session | final text / 状态 | dsh v2 sdk |

Adapter 的红线：

- 只做平台翻译；不实现重试、路由、配额、状态机、plan、记忆写入。
- prompt 是数据，不是 shell；只用 argv 数组，不拼字符串、不经过 shell。
- 只读本地凭据；**永不接受任务 payload 里的 command/env/token/endpoint**。
- 必须提供 `probe()` 与稳定错误码；失败不得静默回退到其它 agent。
- 不写 fleet store；执行结果只通过 `ExecutionOutcome` 返回。

接口草案（字段名可由实现会话调整，职责边界不变）：

```ts
type ExecutionMode = 'cli-one-shot' | 'http-json' | 'jsonrpc';

interface AdapterContext {
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  env: Readonly<Record<string, string>>;
}

interface FleetAdapter {
  readonly kind: string;
  readonly executionMode: ExecutionMode;
  probe(): Promise<{ ok: boolean; reason?: string }>;
  run(
    prompt: string,
    ctx: AdapterContext,
  ): Promise<{ stdout: string; exitCode: number | null; meta?: Record<string, string> }>;
}
```

### 3.4 配置示例（0.3.2 目标形状）

以下只展示字段关系，**不是当前可直接使用的配置**：当前 `validateFleetConfig` 只接受 `echo`/`command`/`hermes`/`openchamber`，`executionMode` 等字段还没有进入校验。示例不含任何真实 token/key。

```json
{
  "v": 1,
  "device": "device-A",
  "namespace": "tasks",
  "store": "daemon",
  "agents": [
    {
      "name": "hermes",
      "kind": "hermes",
      "executionMode": "cli-one-shot",
      "executable": "hermes",
      "capabilities": ["code", "review"],
      "concurrency": 2,
      "timeoutMs": 600000,
      "adapter": {
        "profile": "default",
        "toolsets": "file,shell"
      }
    },
    {
      "name": "dsh",
      "kind": "dsh",
      "executionMode": "cli-one-shot",
      "executable": "dsh",
      "capabilities": ["code", "long-context"],
      "concurrency": 1,
      "timeoutMs": 900000,
      "adapter": {
        "profile": "headless",
        "promptMode": "stdin"
      }
    },
    {
      "name": "opencode",
      "kind": "opencode",
      "executionMode": "cli-one-shot",
      "executable": "opencode",
      "capabilities": ["code", "test"],
      "concurrency": 2,
      "timeoutMs": 900000,
      "adapter": {
        "subcommand": "run",
        "promptMode": "argv"
      }
    },
    {
      "name": "claude-code",
      "kind": "claude-code",
      "executionMode": "cli-one-shot",
      "executable": "claude",
      "capabilities": ["code", "docs"],
      "concurrency": 2,
      "timeoutMs": 900000,
      "adapter": {
        "args": ["-p"],
        "promptMode": "argv"
      }
    },
    {
      "name": "openchamber",
      "kind": "openchamber",
      "executionMode": "http-json",
      "capabilities": ["code", "review"],
      "concurrency": 1,
      "timeoutMs": 600000,
      "adapter": {
        "endpoint": "http://127.0.0.1:<port>/agent/run-once",
        "authHeader": "X-Bridge-Token",
        "tokenFile": "~/.oc-hermes-bridge/daemon.json",
        "tokenJsonPath": "token"
      }
    },
    {
      "name": "local-command",
      "kind": "command",
      "executionMode": "cli-one-shot",
      "executable": "/opt/agents/run-batch",
      "capabilities": ["custom"],
      "concurrency": 1,
      "timeoutMs": 300000,
      "adapter": {
        "baseArgs": ["--non-interactive"],
        "promptArgs": ["--prompt", "{prompt}"],
        "promptMode": "argv",
        "env": { "AGENT_MODE": "batch" }
      }
    }
  ]
}
```

字段口径：

- `executable`：本地可执行文件的**逻辑名**（如 `hermes`、`dsh`）或本机解析后的名字；完整路径、参数、env、token、endpoint 不进入目录。
- `adapter`：平台私有配置块；由本机 adapter 解析，不跨设备同步。
- `tokenFile`：只给路径，不给 token 值；文件权限由本机负责。
- `promptArgs` 中的 `{prompt}` 只展开为一个 argv 元素；`promptMode` 决定它走 argv 还是 stdin。
- `env` 只在本机注入；不打印、不落盘、不上网。

### 3.5 远端 Agent：发布什么、不发布什么

Agent 目录是**声明**，不是授权；L1 订阅仍是派发前提。执行设备发布的最小条目：

```json
{
  "name": "hermes",
  "kind": "hermes",
  "capabilities": ["code", "review"],
  "executable": "hermes",
  "executionMode": "cli-one-shot",
  "concurrency": 2,
  "capacity": 4
}
```

规则：

- 除 `(device, name)` 身份字段外，**只发布** `kind` + `capabilities` + `executable` + `executionMode`（以及建议性的 `concurrency`/`capacity`）。
- `executable` 只发布逻辑名/基线名；绝对路径、`baseArgs`、`promptArgs`、env、token、endpoint、session 一律不发布。
- **command/env/token 永不过网**：不进入 Agent 目录、能力卡、任务事件、presence、日志或错误文本。
- 远端只能看到「这台设备声明自己能跑什么」；真正的命令与凭据只在执行设备本地配置里。
- adapter 安装在**执行设备本地**；派发方不下载、不代理、不远程执行命令。
- 不认识的 `kind`、探测失败的 adapter、能力不匹配 → 不选中；已被派发的任务 fail-closed 为 `ADAPTER_UNAVAILABLE`，不得回退到 `echo` 或其它 agent。

远端执行时序：

1. 执行设备启动 daemon，读取本地 `fleet.config.json`，在本机构造 adapter 与 `ExecutorRegistry`。
2. 执行设备发布 Agent 目录条目（仅上述最小字段）。
3. 派发方调用 `task_targets`，按 `(device, agent)`、`capabilities`、`kind`、`executionMode` 过滤。
4. 派发方 `task_submit`，任务只携带 `intent`、`to`、预算、`trace`。
5. 执行设备按 `to.device`/`to.agent` 取任务，检查并发/配额/健康探测；不满足则 `failed`。
6. adapter 执行，公共层归一结果并写状态事件；任务事件里只有结果引用/原因，没有 argv/env/token。
7. `fleet doctor` 可在两端分别检查：派发侧看订阅/对端可达，执行侧看 executable/endpoint/鉴权。

### 3.6 兼容与版本

- `executionMode` 是稳定枚举；新增 kind 是 additive，删除/改语义是破坏性变更，需全端同版本。
- 旧配置没有 `executionMode` 时，只能由已知 `kind` 推导默认值；**不得**从「客户端已安装」推断可执行。
- 0.3.2 已交付集合仍是 `echo`/`command`/`hermes`/`openchamber`；其余 kind 在 adapter 落地前只能作为派发方存在。

## 4. Console 边界：不加 Fleet UI

**Console 不新增 Fleet 专用 UI**（不做 plan 看板、Agent 管理页、adapter 配置页、配额仪表盘）。原因：Fleet 的权威面是 MCP/CLI 工具与记忆域；再加一套 UI 会与 `task_submit.plan`/`fleet doctor` 漂移，也会把「派发方」误呈现成「执行方」。

Console 只作为派发方，入口保持四个：

| 入口 | 用途 | 约束 |
|---|---|---|
| `task_submit` + `plan` 字段 | 提交 plan/root 与步骤 | `to` 固定 `{ "device": "__plan__", "agent": "__plan__" }`；owner/MR 必须是本机真实可执行 agent；无可用 agent → `PLAN_OWNER_UNEXECUTABLE`（echo/board 的显式排除待收紧） |
| `task_status.plan` | 读取 plan 进度/阻塞 | 只读派生；不改写 plan 节点；支持 root/step/MR taskId；返回 `why`/`blockedBy` 等增量字段 |
| `fleet doctor` | 本机身份/订阅/端点/agent 健康检查 | 不打印 token/env；失败给出稳定原因；可分别在派发侧与执行侧运行 |
| `fleet task_*` / 本文档 | CLI 等价入口与契约 | 与 MCP 工具面完全一致；文档是唯一 canonical 矩阵 |

补充：

- Console 可以展示通用任务状态，但**不新增 Fleet 页面/组件**；Fleet 的计划语义留在 `task_submit.plan`/`task_status.plan`。
- 任何「在 Console 里配置远端命令/env/token」的设计都越界：这些字段永远属于执行设备本地。
- plan owner/MR 不能是 `board`/`echo`；看板占位只在普通 task 的默认 `to.agent` 上成立。

## 5. 验收清单

实现/评审本契约时逐项检查：

- [ ] 矩阵覆盖 `openchamber`、`hermes`、`opencode`、`claude-code`、`claude-desktop`、`cursor`、`dsh`、`generic`，以及 `echo`/`board`。
- [ ] 每个「可作为执行方」的行都有明确 adapter/入口与失败模式；「待实现/条件/否」没有被写成已交付。
- [ ] 配置示例覆盖 hermes / dsh / opencode / claude-code / openchamber / command，且不含真实 token/key。
- [ ] Agent 目录只发布 `kind` + `capabilities` + `executable` + `executionMode`（及建议性容量），command/env/token 不过网。
- [ ] 公共层承担并发/超时/取消/env 白名单/截断/归一/执行日志/健康探测；adapter 只做平台翻译。
- [ ] Console 没有新增 Fleet UI；入口仍是 `task_submit.plan`、`task_status.plan`、`fleet doctor`、文档/CLI。
- [ ] `echo`/`board` 不作为 plan owner/MR；无真实 agent 时 fail-closed。
- [ ] 只改文档，不改生产代码、tests、CHANGELOG 或其它 docs。

## 6. 待冻结项（0.3.2 实现前必须回答）

1. **配置 schema**：`executionMode`、`executable`、`promptArgs`、`promptMode` 需进入 `validateFleetConfig` 与执行器构造；当前实现只认 `echo`/`command`/`hermes`/`openchamber`。
2. **目录 schema**：`AgentDirectoryAgent` 需增加 `executable`/`executionMode`；需确认 `executable` 只发布逻辑名，避免泄露绝对路径。
3. **echo/board 收紧**：当前 plan 校验只检查 agent 是否在本机 `config.agents[]`；需显式拒绝 `echo`/`board` 作为 plan owner/MR。
4. **cursor-agent**：具体 flag、非交互语义、取消与 exit code 需实机验证；未验证前保持 dispatch-only。
5. **DSH stdin**：`dsh --profile headless` 的大 prompt stdin 形态需按版本确认；不支持时 fail-closed。
6. **OpenCode / Claude Code**：adapter 尚未实现；在实现前不得发布可执行能力卡。
7. **健康探测与发布**：探测失败是否自动撤销能力卡/目录条目，需与 P1 能力卡发布路径统一，避免「目录说能跑、实际跑不了」。
