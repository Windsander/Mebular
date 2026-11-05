# Fleet Agent 矩阵与 Executor/Adapter 契约

> 状态：canonical（Fleet 0.3.2 实现口径）
> 基线：`feat/fleet-orchestration` @ `b4ef1e8`（后续 docs-only 提交不改变代码 SHA）
> 范围：Fleet 如何把任务交给**执行设备上的 Agent**，以及 Console/MCP 客户端如何**派发**。
> 非目标：不新增协议/线格式/状态机；不改 `@mebular/core`；不在 Console 新增 Fleet 专用 UI。

本文区分**已实现**与**真实宿主 smoke 边界**：

- **已实现 kind** 以 `packages/fleet/src/config.ts` 的 `FleetAgentKind` 为准：`echo`、`command`、`hermes`、`openchamber`、`dsh`、`opencode`、`claude-code`。
- DSH / OpenCode / Claude Code 已有 adapter；**真实任务 smoke 尚未全部完成**（DSH/Claude 本机未安装，OpenCode 只验证了 health）。fake CLI 测试不等于真实宿主 E2E。
- `executable`、`executionMode`、`health` 已进入 Agent 目录、能力卡、route 硬过滤与 `task_targets` 输出；它们是**发布/路由元数据**，不是 `fleet.config.json` 的配置字段。
- `package.json` / `fleet.config.json` 仍是权威配置面；`executable` 由 `kind`/`command` 静态推导，`health` 是可选、advisory 的探测快照。

本文中的「客户端」指能与本机 Mebular 守护建立 MCP 连接（HTTP `/mcp` 或 stdio）的 AI 助手/Console。连接方式由 `mebular print-config --client <id>` 与本机 assistant descriptor 决定。

## 1. 两个角色：派发方 ≠ 执行方

Fleet 有两个正交平面：**派发面**（task 工具/MCP）与**执行面**（执行设备本地的 adapter）。同一个客户端可以同时扮演两个角色，但两条链路独立验收。

| 维度 | 派发方（dispatcher） | 执行方（executor） |
|---|---|---|
| 典型载体 | Console / MCP 客户端 / `fleet task_*` CLI | 执行设备上的 fleet daemon + 本机 Agent/adapter |
| 关键动作 | `task_submit`、`task_submit.plan`、`task_status`、`task_cancel`、`task_retry`、`task_targets` | 按 `to.device`/`to.agent` 取任务，调用 adapter 真正运行 |
| 必要前提 | 已连接本机守护；与目标任务域有 L1 订阅交集；本机配额允许 | 本机 `fleet.config.json` 声明 agent；adapter 已配置；health 为 advisory（显式 unavailable 会被 route 拒绝） |
| 能力来源 | MCP 工具面 / `fleet task_*` CLI | `FleetAgentKind` + adapter + `ExecutorRegistry` |
| 不负责 | 不执行 intent；不持有远端命令/凭据；不替执行方做健康检查 | 不做全网调度/配额账本；不读取派发方 env/token；不改变任务语义 |
| 失败语义 | 入口拒绝（配额/订阅/预算/plan 校验） | `failed` + reason（`TIMEOUT`/`EXIT_n`/`ADAPTER_UNAVAILABLE`/…） |

必须遵守的口径：

1. **「能调用 `task_submit`」不等于「能执行任务」。** Console 默认只是派发方；只有本机配置了对应 `kind` 的 adapter，才同时是执行方。
2. **不要写成「所有 Console 客户端都能执行」。** 执行列写「否」或「条件未满足」的行就是不能执行；也不能靠「客户端已安装」推断「adapter 已就绪」。
3. 派发方与执行方的授权彼此独立：L1 订阅决定**能不能读到任务域**，本机 `config.agents[]` + adapter 决定**能不能真正运行**。`task_targets` 是两者交集后的权威视图。
4. 任务 payload 只承载 `intent`/路由/预算/追踪；**命令、参数、env、token 永远由执行设备本地配置提供**，不从任务或远端下发。

## 2. Canonical Agent 矩阵

记号：

| 记号 | 含义 |
|---|---|
| `已实现` | adapter/executor 已交付；可被 `task_targets` 选中；真实任务 smoke 可能仍待补 |
| `条件` | 仅在执行设备运行条件满足时可执行（如 OpenChamber bridge 在线） |
| `否` | 没有执行入口；只能派发或完全不参与 |
| `demo` | 仅演示/看板，不承担真实工作 |
| 自动建联 `是` | assistant descriptor 可探测并自动写入 MCP 配置（`mebular print-config --client <id>`） |
| 自动建联 `片段` | 只提供手工粘贴片段，不自动写入 |
| 自动建联 `n/a` | 不是可建联客户端 |

| 客户端 | 自动建联 | 可作为派发方 | 可作为 Fleet 执行方 | adapter / 入口 | 限制 |
|---|---|---|---|---|---|
| `openchamber` | 是（复用 OpenCode global 配置） | 是 | **条件可执行（已实现）**：bridge 在线 | `kind=openchamber`；`OpenChamberAgent` → `HttpOpenChamberSeam` → `POST /agent/run-once` | 必须有 `oc-hermes-bridge` daemon；**无桥即不可执行**；endpoint/token 只从本机 env/文件读取；请求 ≤256 KiB、prompt ≤64 KiB、timeout ≤600 s；每次新建 session；错误归一 `OPENCHAMBER_ERROR`；当前 adapter 无 `health()`，探测结果为 `degraded`（不硬拒绝） |
| `hermes` | 是（`~/.hermes/config.yaml`，热生效） | 是 | **已实现** | `kind=hermes`；`HermesAgent`；`hermes [-p P] [-t T] [-m M] [--in DIR] -z <prompt> --usage-file <tmp>` | 需要 `hermes` CLI；one-shot；stdout 即结果；默认 600 s；超时/非零退出 → `failed`；只透传 env allowlist；大 prompt 受 argv 上限约束；`health()` 探测 `hermes --version` |
| `opencode` | 是（`~/.config/opencode/opencode.json`，重载生效） | 是 | **已实现** | `kind=opencode`；`OpenCodeAgent`；`opencode [baseArgs] run [prompt|stdin]` | 默认 `promptMode: arg`；本机 `opencode v2.0.29` 的 `--version` health 已验证；**真实任务 `opencode run` smoke 待补**；接入 MCP 不等于执行，执行以本机 config + adapter 为准 |
| `claude-code` | 是（`~/.claude.json`，重启生效） | 是 | **已实现** | `kind=claude-code`；`ClaudeCodeAgent`；`claude [baseArgs] -p [prompt|stdin]` | 默认 `promptMode: arg`；本机未安装 `claude`，adapter 仅有 fake CLI 测试；**真实任务 smoke 待补**；成功判定 exit 0 且 stdout 非空 |
| `claude-desktop` | 是（`claude_desktop_config.json`，重启生效） | 是 | **否**（无 CLI） | 仅 MCP 客户端 | dispatch-only；没有终端入口；不得用 UI 自动化冒充 executor |
| `cursor` | 是（`~/.cursor/mcp.json`，重启生效） | 是 | **否**（当前无 kind/adapter） | 仅 MCP 客户端 | 0.3.2 没有 `cursor` kind；`cursor-agent` 未接入执行器，保持 dispatch-only；不得把 GUI 当 CLI |
| `dsh` | 是（项目 `.dsh/cordis.yml` 或用户 `~/.dsh`） | 是 | **已实现**（0.3.2 v1） | `kind=dsh`；`DshHeadlessAgent`；`dsh [baseArgs] --profile headless [prompt|stdin]` | v1 默认 `promptMode: stdin`；one-shot session、stdout final answer、exit code 表示完成；`health()` 探测 `dsh --version`；**本机真实任务 smoke 待补，fake CLI 测试已过**；JSON-RPC（`initialize` / `session` / `prompt` / `session/wait`）留 v2；**现有 `@mebular/dsh-plugin` 是 Web/记忆桥，不是 Fleet executor** |
| `generic` | 片段（仅复制） | 是（若接 MCP） | **是**（`kind=command` 逃生口） | `kind=command`；`command` + `baseArgs` + `promptArgs` + `promptMode` | 完全由本机配置负责；不经 shell；argv 注入面由配置作者承担；`promptMode: arg`（默认，prompt 作为最后一个 argv）或 `stdin`；无 `env` 配置字段，只有 `ENV_ALLOWLIST` |
| `echo` | n/a | 否 | **demo（现有）** | `kind=echo`；`EchoExecutor` → `echo:<intent>` | 确定性 demo；无真实副作用；不得作为 plan owner/MR |
| `board` | n/a | 否 | **否**（看板占位） | board task target / plan owner 占位 | demo/看板；不是 Agent，不运行命令；plan 提交时归一化到本机真实 agent，否则 `PLAN_OWNER_UNEXECUTABLE`；不得作为 plan owner/MR |

### 2.1 Hermes

- 使用现有 `hermes` CLI；`kind=hermes` 已接入 `HermesAgent`。
- 调用形状：`hermes [-p <profile>] [-t <toolsets>] [-m <model>] [--in <dir>] -z <prompt> --usage-file <tmp>`。
- 一次性非交互执行；成功以 stdout 作为 `resultRef`；`--usage-file` 里的 `session_id` 只用于观测，不作为任务身份。
- 超时、非零退出、spawn 失败一律 `failed`，附 `TIMEOUT`/`EXIT_<code>` 与 stderr 尾部。
- 不继承 daemon 全量 env；只走 `ENV_ALLOWLIST`。

### 2.2 DSH

- **v1（已实现）**：官方 `dsh --profile headless`。adapter 固定参数 `--profile headless`，默认 `promptMode: 'stdin'`（大 prompt 安全），也支持 `promptMode: 'arg'`。一次性 session，stdout 为 final answer，exit code 表示完成。
- `health()` 只执行 `dsh --version`；缺失/非 0/超时 → `unavailable`，详情不包含 env/stderr。
- **真实边界**：本机未安装 `dsh`，只有 fake CLI 测试；尚未在真实 DSH 上跑任务 smoke。fake 测试覆盖 argv/stdin、超时、截断与 health，但不等于真实宿主 E2E。
- **v2（未实现）**：`dsh --profile sdk` 的 JSON-RPC（`initialize` / `session` / `prompt` / `session/wait`）。v2 才处理长会话、增量事件与显式中断；0.3.2 不实现。
- **现有 `@mebular/dsh-plugin` 是 Web/记忆桥，不是 Fleet executor。** 它可以作为 MCP 派发方连接守护，但不会让 DSH 自动获得执行能力；执行能力只来自执行设备本地的 `kind=dsh` adapter。

### 2.3 OpenCode

- 入口：`opencode [baseArgs] run [prompt|stdin]`，一次性非交互执行；默认 `promptMode: 'arg'`。
- `health()` 探测 `opencode --version`；本机 `opencode v2.0.29` 已返回成功，可视为 **health 已验证**。
- **真实边界**：尚未用 `opencode run` 执行真实 Fleet 任务；`health` 只能证明 CLI 存在且可响应 `--version`，不等于任务 E2E。
- 通过 `mebular print-config --client opencode` 接入 MCP 只解决派发；执行能力仍来自本机 `kind=opencode` adapter。

### 2.4 Claude Code

- 入口：`claude [baseArgs] -p [prompt|stdin]`，`-p` 非交互 one-shot；默认 `promptMode: 'arg'`。
- `health()` 探测 `claude --version`；本机未安装 `claude`，因此 health 与真实任务都未验证。
- **真实边界**：当前只有 fake CLI 测试；真实 Claude Code 任务 smoke 待补。
- 成功判定：exit code 0 且 stdout 非空；stderr 只作为失败证据，不进入 `resultRef`。

### 2.5 OpenChamber

- 执行入口是 HTTP bridge（`oc-hermes-bridge`）的 `POST /agent/run-once`，不是 OpenChamber 的 GUI。
- **没有桥就不可执行。** 桥不在线、token 缺失、端点不可达时，任务失败并归一为 `OPENCHAMBER_ERROR`，不得静默降级到其它 agent。
- endpoint/token 只在执行设备本地：默认读 `MEBULAR_FLEET_OPENCHAMBER_ENDPOINT`、`MEBULAR_FLEET_OPENCHAMBER_TOKEN`/`..._TOKEN_FILE`、`..._AUTH_HEADER`；token 不上网、不进任务事件、不落日志、不出现在错误文本。
- 当前 adapter **没有 `health()`**：`BaseExecutor.health()` 返回 `degraded`（`adapter has no health probe`），route 只在显式 `unavailable` 时硬拒绝，因此 `degraded` 不会阻止路由。`supportsCancel=false`，取消不会保证中断已建立的桥会话。
- provider 可替换；fleet 侧只依赖 `OpenChamberSessionSeam` 契约，不假设 bridge 的私有字段。

### 2.6 Cursor

- **0.3.2 没有 `cursor` kind，也没有 `cursor-agent` adapter**；Cursor 保持 **dispatch-only**。
- 将来接入时必须先验证非交互调用、exit code、stdout final answer、超时、取消与参数传递（不经 shell）；未验证不得发布为可执行条目。
- 不得用 GUI 自动化、AppleScript 或模拟点击冒充执行器；那既不可观测，也不可取消。

### 2.7 Claude Desktop

- **dispatch-only，无 CLI。** 它可以通过 MCP 调用 `task_submit`/`task_status`，但不能接收并运行 Fleet 任务。
- 不得为它伪造 executor；也不得把它的 MCP 连接误写成「已具备执行能力」。

### 2.8 generic（`command` 逃生口）

- 用于没有一等 adapter 的本地 CLI：`kind=command` + `command` + `baseArgs` + `promptArgs` + `promptMode`。
- 参数按数组传给 `spawn`，**绝不 shell 拼接**。`promptArgs` 是**固定参数**，插在 prompt 之前；不要写 `{prompt}` 占位符，当前实现不做占位符替换。
- `promptMode`（仅 `arg` / `stdin`）：
  - `arg`（默认）：prompt 作为最后一个 argv 元素，受 OS argv 上限约束；
  - `stdin`：prompt 写入子进程 stdin，适合大 prompt；
  - 没有 `auto`；没有 `PROMPT_TOO_LARGE` 自动降级。
- 旧配置可继续把 `promptArgs` 写成函数（返回完整参数数组，含 prompt）；函数形式优先于 `promptMode`。新配置建议用字符串数组 + `promptMode`。
- 该入口完全信任本机配置作者：命令、固定参数、工作目录由本地决定；远端无法下发这些字段。配置没有 `env` 字段，子进程只继承 `ENV_ALLOWLIST`。

### 2.9 echo / board

- `echo` 是内置确定性执行器，只返回 `echo:<intent>`；用于本地/CI 验证，不产生真实副作用。
- `board` 是看板/占位目标，不是 Agent，也不运行命令；普通 task 的默认 `to.agent=board` 只是占位。
- 两者都是 **demo**：**不得作为 plan owner 或 MR 执行者**（`MR` 指 root plan 的唯一最终 step，`kind="mr"`）。plan 提交必须落到本机真实可执行 agent；没有可用 agent 时 fail-closed 为 `PLAN_OWNER_UNEXECUTABLE`，绝不创建 plan/root。
- **已实现**：`isPlanOwnerExecutableAgent` 显式拒绝 `name=board/echo`、`kind=echo`，以及没有 `command` 的 `command` agent；MCP `task_submit.plan` 在写 plan/root 前返回 `PLAN_POLICY` + `PLAN_OWNER_UNEXECUTABLE`。`fleet doctor` 的 `plan owner 就绪` 会对「只有占位 agent」给 WARN。

## 3. Executor / Adapter 实现契约

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
│  cli · http · json-rpc · in-process                 │
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

> 以下是**当前实现**。`BaseExecutor` 统一承担并发、超时、AbortSignal、env 白名单、输出截断、结果归一、执行日志与可选 health；adapter 只做平台翻译。

1. **并发**：每 agent 一个 FIFO semaphore。默认 `command=1`、`hermes=2`、`dsh=1`、`opencode=1`、`claude-code=1`；`openchamber` 默认不额外限制（可通过本机 `concurrency` 收窄）。上限来自本机 config，不来自远端；超额本地排队，不依赖全局账本。
2. **超时**：`timeoutMs` 到点 abort 并返回 `failed` + `TIMEOUT after <n>ms`；CLI adapter 会终止子进程。默认值：CLI 类 600 s，`command` 60 s（能力卡按 kind 展示）。
3. **取消**：公共层为**超时**创建 `AbortSignal`，CLI adapter 响应并杀子进程。`task_cancel` 目前写 `failed(CANCELLED)` 并清理未终态任务；**不保证中断已经在运行中的 adapter 调用**（`OpenChamber` 的 descriptor 还显式 `supportsCancel=false`）。
4. **env 白名单**：只传 `ENV_ALLOWLIST`；**配置没有 `env` 字段**，adapter 不继承 daemon 全量 env；不打印、不落盘 env 值。
5. **输出截断**：UTF-8 安全，默认 65,536 bytes；超出追加 `…[truncated N bytes]`；`resultRef` 默认取截断后的 stdout。
6. **结果/错误归一化**：统一 `{ ok, resultRef?, reason? }`；reason 使用稳定码（见下表）；stderr 只保留尾部并脱敏。
7. **执行日志**：按 `taskId` 的 append-only `ExecutionLog`；同一 taskId 的成功结果不重复执行；重启可恢复；失败重试以新任务/新事件表达。
8. **健康探测**：内置 CLI adapter 的 `health()` 执行 `<command> --version`（5 s 超时，stderr 不进入 detail）；`ExecutorRegistry.healthOf()` 可按 agent 调用。`fleet doctor` 当前**不逐 agent 跑 health**，只检查配置/身份/订阅/plan owner readiness；能力卡的 `health` 是可选 advisory 快照，不会自动发布，也不会因探测失败自动撤销卡片。route 只把显式 `health.status="unavailable"` 当作硬拒绝。

当前会产生的执行 reason（稳定集合，新增需文档同步）：

| reason | 含义 | 产生层 |
|---|---|---|
| `TIMEOUT after <n>ms` | 超时 | 公共层 |
| `EXIT_<code>: <stderr tail>` | 非零退出；spawn 失败时 `code=null` | 公共层 |
| `EXECUTOR_ERROR: <err>` | adapter 抛异常/返回空失败 | 公共层 |
| `OPENCHAMBER_ERROR: <err>` | bridge/provider 配置缺失、不可达或返回错误 | OpenChamber adapter |
| `CANCELLED` | 任务/计划被取消（任务级状态） | surface / plan-control |
| `ADAPTER_UNAVAILABLE` | route 显式拒绝（`executable=false` 或 `health=unavailable`） | route |
| `UNKNOWN_AGENT: <name>` | worker 找不到本机 executor | worker |

保留但当前未产生的错误码：`AUTH_FAILED`、`PROTOCOL_ERROR`、`PROMPT_TOO_LARGE`。不要把它们写成 0.3.2 的已实现行为。

### 3.3 Adapter 只做什么

| executionMode | 输入 | 输出 | 典型 |
|---|---|---|---|
| `cli` | prompt（argv 或 stdin）+ 本地固定参数 | stdout + exit code | hermes、dsh、opencode、claude-code、command |
| `http` | prompt + 本地 endpoint/token | JSON `{ ok, result, error }` | openchamber bridge |
| `json-rpc` | JSON-RPC 请求/响应 + session | final text / 状态 | 预留；当前无 adapter |
| `in-process` | 进程内调用 | 直接结果 | echo、demo/占位 |

Adapter 的红线：

- 只做平台翻译；不实现重试、路由、配额、状态机、plan、记忆写入。
- prompt 是数据，不是 shell；只用 argv 数组，不拼字符串、不经过 shell。
- 只读本地凭据；**永不接受任务 payload 里的 command/env/token/endpoint**。
- CLI adapter 提供 `health()`；没有 probe 的 adapter 由公共层记为 `degraded`，不得伪造 `ok`。失败不得静默回退到其它 agent。
- 不写 fleet store；执行结果只通过 `ExecutionOutcome` 返回。

接口（与 `packages/fleet/src/runtime/executor.ts` 对齐）：

```ts
type ExecutorExecutionMode = 'cli' | 'http' | 'json-rpc' | 'in-process';

interface ExecutorDescriptor {
  kind: string;
  executionMode: ExecutorExecutionMode;
  supportsCancel: boolean;
  supportsStreaming?: boolean;
  promptMode?: 'arg' | 'stdin';
}

interface ExecutorAdapter {
  readonly descriptor: ExecutorDescriptor;
  invoke(request: ExecutorRequest, signal: AbortSignal): Promise<ExecutorResult>;
  health?(): Promise<ExecutorHealth>;
}
```

`ExecutorRequest` 携带已归一化的 `task`、`prompt`、`timeoutMs`、`maxOutputBytes`、白名单 `env` 与可选 `cwd`；`ExecutorResult` 由 `BaseExecutor` 再做截断与结果归一。

### 3.4 配置示例（当前 `fleet.config.json` 形状）

以下字段均通过 `validateFleetConfig`。`executable` / `executionMode` / `health` **不是配置字段**：它们由 config + adapter 推导后进入目录/能力卡。示例不含任何真实 token/key。

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
      "capabilities": ["code", "review"],
      "concurrency": 2,
      "timeoutMs": 600000
    },
    {
      "name": "dsh",
      "kind": "dsh",
      "capabilities": ["code", "long-context"],
      "concurrency": 1,
      "timeoutMs": 900000,
      "promptMode": "stdin"
    },
    {
      "name": "opencode",
      "kind": "opencode",
      "capabilities": ["code", "test"],
      "concurrency": 2,
      "timeoutMs": 900000,
      "promptMode": "arg"
    },
    {
      "name": "claude-code",
      "kind": "claude-code",
      "capabilities": ["code", "docs"],
      "concurrency": 2,
      "timeoutMs": 900000,
      "promptMode": "arg"
    },
    {
      "name": "openchamber",
      "kind": "openchamber",
      "capabilities": ["code", "review"],
      "concurrency": 1,
      "timeoutMs": 600000
    },
    {
      "name": "local-command",
      "kind": "command",
      "command": "/opt/agents/run-batch",
      "capabilities": ["custom"],
      "concurrency": 1,
      "timeoutMs": 300000,
      "baseArgs": ["--non-interactive"],
      "promptArgs": ["--prompt"],
      "promptMode": "arg"
    }
  ]
}
```

字段口径：

- `command`：`kind=command` 必填；对 `dsh`/`opencode`/`claude-code` 可选，用于覆盖默认可执行文件名/路径（只在本机生效）。
- `baseArgs` / `promptArgs`：都是本地固定参数数组；`promptArgs` 插在 prompt 之前，不含 `{prompt}` 占位符。
- `promptMode`：`arg`（默认，prompt 作为最后一个 argv）或 `stdin`（prompt 写入 stdin）；只对 CLI adapter 生效。
- `executable` / `executionMode`：不在 config；目录/能力卡发布时由 `deriveAgentExecution()` 静态推导。`executable` 是**布尔**（不是路径），目录不发布命令路径。
- `health`：不在 config；能力卡可选快照，取自 `ExecutorRegistry.healthOf()`/adapter `health()`，advisory。
- OpenChamber 的 endpoint/token/auth header 只从执行设备 env/文件读取（见 §2.5），不进入 config、目录或任务事件。
- 配置没有 `env` 字段；子进程只继承 `ENV_ALLOWLIST`，不打印、不落盘、不上网。

### 3.5 远端 Agent：发布什么、不发布什么

Agent 目录是**声明**，不是授权；L1 订阅仍是派发前提。执行设备发布的最小条目：

```json
{
  "name": "hermes",
  "kind": "hermes",
  "capabilities": ["code", "review"],
  "executable": true,
  "executionMode": "cli",
  "concurrency": 2,
  "capacity": 4
}
```

规则：

- 除 `(device, name)` 身份字段外，**只发布** `kind` + `capabilities` + `executable` + `executionMode`（以及建议性的 `concurrency`/`capacity`）。
- `executable` 是**布尔可执行性**，由本机 config 静态推导；绝对路径、`baseArgs`、`promptArgs`、env、token、endpoint、session 一律不发布。
- `health` 不属于目录条目；能力卡可选携带 `{status,checkedAt?,latencyMs?,detail?}`，由 `task_targets` 合并到目标，advisory。
- **command/env/token 永不过网**：不进入 Agent 目录、能力卡、任务事件、presence、日志或错误文本。
- 远端只能看到「这台设备声明自己能跑什么」；真正的命令与凭据只在执行设备本地配置里。
- adapter 安装在**执行设备本地**；派发方不下载、不代理、不远程执行命令。
- 不认识的 `kind`、`executable=false`、卡片 `health=unavailable`、能力不匹配 → 不选中；已被派发的任务 fail-closed 为 `ADAPTER_UNAVAILABLE`，不得回退到 `echo` 或其它 agent。旧目录/旧卡缺少字段时按“未知”兼容，不当作 false。

远端执行时序：

1. 执行设备启动 daemon，读取本地 `fleet.config.json`，在本机构造 adapter 与 `ExecutorRegistry`。
2. 执行设备发布 Agent 目录条目（仅上述最小字段）。
3. 派发方调用 `task_targets` 取回 `(device, agent)`、`capabilities`、`kind`、`executionMode`、`executable`、`health` 等元数据；route 再按这些字段做硬过滤。
4. 派发方 `task_submit`，任务只携带 `intent`、`to`、预算、`trace`。
5. 执行设备按 `to.device`/`to.agent` 取任务，检查并发/配额；adapter health 缺失只降级为 advisory，不伪造通过。
6. adapter 执行，公共层归一结果并写状态事件；任务事件里只有结果引用/原因，没有 argv/env/token。
7. `fleet doctor` 可在两端分别检查：派发侧看订阅/对端可达，执行侧看 config/身份/plan owner readiness；adapter 的 `--version` health 不在 doctor 内自动运行，需要 `ExecutorRegistry.healthOf()` 单独探测。

### 3.6 兼容与版本

- `executionMode` 是稳定枚举：`cli` / `http` / `json-rpc` / `in-process`；新增 kind 是 additive，删除/改语义是破坏性变更，需全端同版本。
- 旧目录/旧卡没有 `executable`/`executionMode`/`health` 时按“未知”兼容；**不得**从「客户端已安装」推断可执行，也不得把缺失字段当作 `false`/`unavailable`。
- 0.3.2 已交付集合：`echo`/`command`/`hermes`/`openchamber`/`dsh`/`opencode`/`claude-code`。`cursor`/`claude-desktop` 仍只能派发。
- 真实宿主 smoke 是交付证据的一部分，不是 enum 兼容性的一部分：DSH/Claude 本机未安装，OpenCode 只验证 health；不要据此宣称真实 3+ 节点任务 E2E。

## 4. Console 边界：不加 Fleet UI

**Console 不新增 Fleet 专用 UI**（不做 plan 看板、Agent 管理页、adapter 配置页、配额仪表盘）。原因：Fleet 的权威面是 MCP/CLI 工具与记忆域；再加一套 UI 会与 `task_submit.plan`/`fleet doctor` 漂移，也会把「派发方」误呈现成「执行方」。

Console 只作为派发方，入口保持四个：

| 入口 | 用途 | 约束 |
|---|---|---|
| `task_submit` + `plan` 字段 | 提交 plan/root 与步骤 | `to` 固定 `{ "device": "__plan__", "agent": "__plan__" }`；owner/MR 必须是本机真实可执行 agent；`echo`/`board`/无 `command` 的 `command` 已显式拒绝，返回 `PLAN_POLICY` + `PLAN_OWNER_UNEXECUTABLE` |
| `task_status.plan` | 读取 plan 进度/阻塞 | 只读派生；不改写 plan 节点；支持 root/step/MR taskId；返回 `why`/`blockedBy` 等增量字段 |
| `fleet doctor` | 本机身份/订阅/端点/plan owner readiness 检查 | 不打印 token/env；失败给出稳定原因；不逐 agent 跑 `--version` health |
| `fleet task_*` / 本文档 | CLI 等价入口与契约 | 与 MCP 工具面完全一致；文档是唯一 canonical 矩阵 |

补充：

- Console 可以展示通用任务状态，但**不新增 Fleet 页面/组件**；Fleet 的计划语义留在 `task_submit.plan`/`task_status.plan`。
- 任何「在 Console 里配置远端命令/env/token」的设计都越界：这些字段永远属于执行设备本地。
- plan owner/MR 不能是 `board`/`echo`；看板占位只在普通 task 的默认 `to.agent` 上成立。

## 5. 当前验收状态

- [x] 矩阵覆盖 `openchamber`、`hermes`、`opencode`、`claude-code`、`claude-desktop`、`cursor`、`dsh`、`generic`，以及 `echo`/`board`。
- [x] 每个可执行行都有 adapter/入口与失败模式；`cursor`/`claude-desktop` 明确为 dispatch-only。
- [x] 配置示例覆盖 hermes / dsh / opencode / claude-code / openchamber / command，且不含真实 token/key。
- [x] Agent 目录发布 `kind` + `capabilities` + `executable`(boolean) + `executionMode`（及建议性容量）；command/env/token 不过网。
- [x] 公共层承担并发/超时/AbortSignal/env 白名单/截断/归一/执行日志；adapter 只做平台翻译。
- [x] `executable`/`health` 进入 route 硬过滤与 `task_targets`；显式 false/unavailable 被拒绝，旧字段缺失按未知兼容。
- [x] Console 没有新增 Fleet UI；入口仍是 `task_submit.plan`、`task_status.plan`、`fleet doctor`、文档/CLI。
- [x] `echo`/`board`/无 `command` 的 `command` 不作为 plan owner/MR；无真实 agent 时 fail-closed。
- [ ] DSH / Claude Code 真实任务 smoke；OpenCode 真实 `run` 任务 smoke。
- [ ] 真实 3+ 节点 plan E2E（P6 五节点是 `InMemoryHub`）。

## 6. 0.3.2 剩余边界（不要写成已交付）

1. **真实宿主 smoke**：本机没有 `dsh` 与 `claude`，二者只有 fake CLI 测试；OpenCode 仅 `--version` health 通过。需要真实任务 smoke 才能宣称宿主 E2E。
2. **health 发布链路**：`health()` 已实现于 CLI adapter/registry，但 `fleet doctor` 不逐 agent 探测，能力卡也不会在探测失败时自动撤销；`health` 是 advisory，只有显式 `unavailable` 才被 route 拒绝。
3. **OpenChamber**：无 `health()`（记 `degraded`），`supportsCancel=false`；无 bridge 时执行失败为 `OPENCHAMBER_ERROR`，不要写成“自动降级”。
4. **Cursor**：没有 `cursor` kind/adapter，始终 dispatch-only；将来接入需先实机验证。
5. **DSH v2**：`dsh --profile sdk` JSON-RPC 未实现；当前只有 v1 headless。
6. **真实网络**：P6 五节点 plan E2E 使用进程内 `InMemoryHub`；真实 libp2p 证据仅 2 节点 `verify:fleet:tasks` 与双守护 `verify:daemon:cluster`。
