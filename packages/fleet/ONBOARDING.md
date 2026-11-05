# Fleet 上车（订阅自主 · greenfield）

> 目标态只有四个概念：**设备（信任链）· 订阅（阅读权 + 维持义务）· 移出（唯一否定）· 安全档（动作门槛）**。
> 没有 grant/issuer/自动签发/对端×按域白名单；没有旧设备兼容层。

## 1. 建域（第一台）

```bash
fleet quickstart --daemon --dir ~/.mebular --device device-A
```

- 生成主密钥 + 设备身份 + `config.json`；
- 本机声明订阅默认域（`tasks`）；
- 启动 join 服务并生成加入令牌；
- 建域零门槛：任何设备都可以 `fleet namespace --namespace <name>` 写域公告。

## 2. 加入（第二台）

```bash
fleet join --token <令牌|文件> --daemon --dir ~/.mebular --device device-B
```

- 新设备取得委派证书链（不复制主密钥）；
- 新设备自行声明订阅；
- 订阅零门槛、无需批准；订阅热生效（无需重启）。

## 3. 订阅 / 退订

```bash
fleet subscribe   --dir ~/.mebular --namespace notes
fleet unsubscribe --dir ~/.mebular --namespace notes
fleet subscribers --dir ~/.mebular --namespace notes
```

- 订阅 = 阅读权 + 维持义务：接收该域更新，并把本机新增同步给其他订阅设备；
- 只能改自己（`author === member`）；不能替他人订阅/退订；
- 退订只改声明，不清本地历史；「退出并交接」才清本机数据与水位。

## 4. 移出 / 恢复

```bash
fleet security revoke --dir ~/.mebular --device device-B   # 移出（UI 称「移出」）
fleet restore --dir ~/.mebular --to device-B               # 恢复
```

- 移出是作者级：只拒被移出设备本人；不连坐其后代/新成员；
- 恢复建立新纪元 E-1：恢复前署名的订阅/移出/档位记录不复活；恢复后需重新订阅；
- high 档需会签或恢复码；medium 需本机动态码。

## 5. 医生

```bash
fleet doctor --dir ~/.mebular --json
```

关键项：

| 项 | 含义 |
|---|---|
| `namespace 订阅` | 本机是否已声明订阅该域 |
| `对端订阅` | 对端是否已声明订阅（未订阅不算失败，等待即可） |
| `移出状态` | 本机/对端是否被移出 |
| `peer 可达` | 地址簿中的对端是否可达 |

## 5.1 执行方准备（派发 ≠ 执行）

- 上车只解决**信任、订阅与派发**；能否在本机执行任务取决于**执行设备本地**是否装了真实 Agent 适配器。
- 可执行口径：**Hermes** 可执行；**OpenChamber** 仅在 oc-hermes-bridge 在线时可执行，无桥只能 dispatch-only；**DSH v1** 用官方 `dsh --profile headless "<job>"` 作为执行宿主（`dsh --profile sdk` 是 v2；`@mebular/dsh-plugin` 是 Web/记忆桥，不是 Fleet executor）；**OpenCode**（`opencode run`）与 **Claude Code**（`claude -p`）待 adapter；**Cursor** 仅在有 `cursor-agent` 时可执行，否则 dispatch-only；**Claude Desktop** 只能 dispatch-only。
- `echo` / `board` 是 demo/测试用：`echo` 是确定性 fake executor，`board` 是任务板占位；生产 plan 的 **owner 与 MR 目标必须是真实可执行 Agent**。
- plan 提交前自检：`planAgent` 必须在 `config.agents[].name` 中，否则 `PLAN_POLICY` + `PLAN_OWNER_UNEXECUTABLE`，不会创建 plan/root。完整矩阵与 readiness 见 [`DESIGN.md`](DESIGN.md) §2.5.3。
- 远端 Agent 的 adapter 只在执行设备本地；目录只发布 `kind + capabilities + executable + executionMode`（0.3.2 目标口径），command/env/token 永不过网。

## 6. 命令边界

- 没有 `fleet grant` / `fleet revoke`（域授权）/ `fleet declare-issuer` / `fleet pending` / `fleet approve`；
- `fleet member(s)` 已改为 `subscribe` / `unsubscribe` / `subscribers`；
- 加入令牌不再携带自动授权/TTL 字段；高档次订阅证明由 `securityApproval` 携带。

## 7. 明确边界

- 订阅不提供域级保密：信任边界内、未被移出的设备可自行订阅任意域；
- 移出是逐台动作，不沿证书链传播；
- 不做「删除域」；全网删域属未来治理协议。
