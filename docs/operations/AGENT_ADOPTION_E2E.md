# Agent Adoption E2E Gate

> 发布前门禁：验证 Agent **真的发现并使用了 Mebular**，而不是只验证 Skill 文件存在或 MCP 接口可调用。
> 本 gate 是发布前的**真实客户端 smoke**，不放进普通单元 CI；CI 继续负责目标目录矩阵与 MCP 契约测试。

## 1. 覆盖矩阵

| Agent | 自动安装目录 | 完整链路 gate |
|---|---|---|
| OpenChamber / OpenCode | `~/.config/opencode/skills` | **必跑**：实际 Agent 会话 |
| DeepSeek Harness (DSH) | `~/.agents/skills` | **必跑**：现有真实 DSH E2E + Skill 文件/目录检查 |
| Hermes | `~/.hermes/skills` | 有本机 CLI 时跑；否则记录 skipped |
| Claude Code | `~/.claude/skills` | 有本机 CLI 时跑；否则记录 skipped |
| Cursor | `~/.cursor/skills` | GUI smoke / 人工记录 |
| Claude Desktop | 无文件夹式目录（zip/UI） | 人工上传 smoke；不声称自动安装 |
| Generic | 无 | 只验证手动片段 |

OpenChamber 与 OpenCode 共用 OpenCode 的全局 Skill 目录；两者只算一个真实使用目标。

## 2. 必跑 gate：OpenChamber / OpenCode

在一台**已有 App runtime、未安装 Skill** 的干净机器（或临时 HOME）上：

1. 安装/启动包含本次变更的 0.2.4 App。
2. 确认 App/守护运行；打开 OpenChamber/OpenCode 的新会话。
3. 检查 Skill 目录存在：
   ```bash
   test -f ~/.config/opencode/skills/mebular-memory/SKILL.md
   test -f ~/.config/opencode/skills/mebular-tasks/SKILL.md
   ```
4. 在新会话输入：
   > 请用 Mebular 记住：我的界面偏好是深色模式。只记录这一条稳定偏好。
5. 证据必须是**工具调用**：`memory_write` 成功，且写入内容是 preference（不是普通回答）。
6. 再开一个新会话输入：
   > 我喜欢什么界面主题？请从跨会话记忆回答。
7. 证据必须是 `memory_query` 调用并返回刚才的偏好；不是模型猜测。
8. 修改 `~/.config/opencode/skills/mebular-memory/SKILL.md` 的可见标记，重启后确认默认保留。
9. 设置 → 常用 → 自动修复，确认后：
   - Skill 恢复标准版本；
   - MCP 仍可调用；
   - 记忆数量与身份不变；
   - 新会话仍能召回第 4 步写入的偏好。

通过标准：第 5、7、9 步的工具调用/数据结果都成立；只看到文件存在或自然语言回答不算通过。

## 3. DSH gate

在现有真实 DSH E2E 基础上：

1. 确认 `~/.agents/skills/mebular-memory/SKILL.md` 与 `mebular-tasks/SKILL.md` 存在。
2. 用 DSH 的真实 Agent 会话执行上面的写入/召回问答。
3. 断言实际 `memory_write` / `memory_query` 调用，或 DSH probe 记录的 MCP 工具调用。
4. 至少跑 `npm run verify:dsh:e2e:min` 和 `verify:dsh:e2e:latest`。

## 4. 其他客户端

- Hermes：`hermes --version` 可用时，临时 HOME 起 Hermes，重复第 4–7 步。
- Claude Code：`claude --version` 可用时，临时 HOME/项目重复第 4–7 步。
- Cursor：新窗口打开临时项目，确认 `~/.cursor/skills` 被识别并实际调用记忆工具；GUI 证据用截图/日志记录。
- Claude Desktop：按 zip/UI 上传流程验证；不要求文件夹自动安装。
- Generic：只验证 `print-config` 片段和手动粘贴，不算自动采用。

## 5. 证据与记录

发布记录至少包含：

- 日期、App 版本、客户端版本、OS
- 每个 gate 的实际工具调用/数据证据（日志或截图路径）
- 未跑客户端及原因（例如本机未安装）
- 失败项；失败不得用“模型没按预期回答”掩盖工具调用缺失

> 真实 LLM 输出可能波动；本 gate 以工具调用和存储结果为准，不以自然语言措辞为准。
