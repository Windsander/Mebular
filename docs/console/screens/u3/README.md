# U-3 · 设置页设计收口（安全 / MCP / 高级）

基线：`openchamber/ui-consistency` `6475131`（#145，含 `f08091f` 新建域弹窗与 `6475131` 小弹窗居中）。本分支只改 `packages/console/**`、`tests/console/**`、`docs/console/**`；不改配置能力、行为或协议。

## 1. 现状 sections → 目标 sections

| Tab | 现状（before） | 目标（after） | 主 section 数 |
|---|---|---|---:|
| 安全 | 1 张 `security-card`：待批准 + 三档长文 + 当前行 + 种子/恢复码 + 拒绝块 + 有资格设备 + 3 段边界 + 降级 | 3 段：**安全等级**（待批准紧凑行 + 三行档位 + 当前 + 一行边界 + 降级）· **动态码种子** · **恢复码** | 3 |
| MCP 接入 | 1 张危险卡（6 字段、长帮助/长警告）+ 1 个危险折叠 | 2 段：**连接**（端口/认证/监听）· **TLS**（启用/证书/私钥）+ 1 个「危险与自救」折叠（3 行） | 2 + 折叠 |
| 高级 | 页级长说明 + 6 张卡（常驻服务 / 忆云连接 / 反熵 / 语义 / 版本 / 完整配置 / 应用结果 / 恢复指引 / 连接排障） | 3 段：**常驻服务** · **网络** · **自动化** + 1 个「诊断与恢复」折叠（版本、完整配置、最近应用、手动连接、恢复指引） | 3 + 折叠 |

视觉系统统一为 `settingsSectionHtml()`：`<section class="settings-section">` → `h3` + 一行 `.settings-section-desc` + `.cfg-row` / `.settings-kv` 行；不再使用 `settings-danger`、`sec-tier` 卡片、`sec-approval-row` 卡片或卡片套卡片。状态 chip 统一用 `.crt-tag`（当前 / 需重启 / 异常 / 只读）。

## 2. 文案删除清单

**安全**

- 删除三档长段落（中档“拿错鼠标/手滑/拿走整台设备/钥匙就在设备里”长解释、高档长解释）；改为一行：无额外门槛 / 6 位动态码，防顺手 / 另一台设备核对配对号，防伪造、只对之后的动作生效。
- 删除重复的「当前：低（默认）」行与「变更者/时间」常显（审计仍可查）。
- 删除 `totp_not_configured` 内部码；未导入只显示「未导入 · 中档敏感操作会被拒绝」。
- 拒绝记录不再显示事件 ID；保留中文原因与「详见审计」。
- 边界从 3 段压成一段（中档挡手不挡钥匙；高档需要另一台设备/恢复码），种子丢失风险放到「动态码种子」段尾一行。
- 「有资格的设备」改为「可会签设备」。

**MCP**

- 删除鉴权方式 300+ 字长警告与 2 段危险说明；折叠内保留 3 行：后果、bearer 自救、oauth/端口失联改回配置。
- 字段帮助默认收起，聚焦时才出现；空值把默认值/短提示放进 placeholder；常态不再显示「生效中」，只有待重启/不一致/未生效才占行。
- 统一「认证」（不再用“鉴权”）；字段标签统一为「证书路径 / 私钥路径」。
- 保留 `token grant`、`config.json`、`.bak` 与自锁确认；风险与自救可达。

**高级**

- 删除页级「高级项改动前请确认…」长说明。
- 删除独立「连接排障 / 版本与服务状态 / 完整配置 / 最近一次应用结果 / 恢复指引」主卡，全部收进底部「诊断与恢复」折叠；折叠内改为紧凑小标题。
- 常驻服务长说明、绑定地址长解释压成一行；「周期反熵」显示名改为「自动对账」。
- 诊断里的恢复指引压缩，但保留 `MCP_INSECURE_CONFIG` / `MCP_STORAGE_LOCKED`、OAuth env 名与 `token grant`。

## 3. 文本量（DOM 文本、去空白；不含折叠；隐藏帮助仍计入，视觉可见更短）

| Tab | before | after | 目标 |
|---|---:|---:|---:|
| 安全 | 573 | **256** | ≤350 |
| MCP 接入 | 1129 | **271**（不含危险折叠） | ≤700 |
| 高级主区 | 2642 | **246**（不含诊断折叠） | ≤1200 |

由 `verify-console-ui.mjs` 在真实 serve 中测量；安全数字在待批准清零后取，MCP/高级剔除折叠内容。

## 4. 截图

| 文件 | 说明 |
|---|---|
| `before-settings-security.jpg` / `u3-after-settings-security.jpg` | 安全：三档长文 → 三行档位 + 三段式 |
| `before-settings-mcp.jpg` / `u3-after-settings-mcp.jpg` | MCP：单危险卡 → 连接/TLS 两组 + 危险与自救折叠 |
| `u3-after-settings-mcp-danger.jpg` | MCP「危险与自救」展开：后果 + bearer/oauth 两条恢复路径 |
| `before-settings-advanced.jpg` / `u3-after-settings-advanced.jpg` | 高级：多卡 → 三组 + 诊断折叠 |
| `u3-after-settings-advanced-diagnostics.jpg` | 诊断与恢复展开：版本、完整配置、最近应用、手动连接、恢复指引 |
| `u3-after-settings-{security,mcp,advanced}-390.jpg` | 390px：无横向溢出 |
| `u3-after-settings-security-dialog.jpg` | 小弹窗居中（安全档位确认；`modal-center`） |
| `u3-after-dialog-namespace.jpg` | 新建记忆域：与邀请同规格（520、crt 外壳、字段整行） |
| `u3-after-dialog-invite.jpg` | 邀请设备：小弹窗居中（520） |
| `u3-after-dialog-cloud-join.jpg` | 加入忆云：大面板顶部对齐（640，内部滚动） |

## 5. 边界与取舍

- **Electron 兼容补充**：`console.js` 内 `window.prompt` 已归零——bearer token 改用 App 内 `#auth-token` 弹层；设备卡「连接」复用既有手动连接向导；复制失败的兜底改为临时 textarea + `execCommand('copy')`。`window.alert/confirm` 在 Electron 可用，保留。
- **弹窗对齐**：小弹窗（邀请 / 切换忆云 / 安全操作 / 手动连接 / handoff / 通用确认 / 令牌输入 / 新建域）统一 `modal-center` 垂直居中；大面板（设置 / 关于本机 / 加入忆云 / 首启引导）保持顶部对齐 + 内部滚动。
- 字段展示文案覆盖放在 `packages/console/settings-ia.js` 的 `IA_FIELD_COPY`：文件域不包含 `packages/mcp/src/config-schema.mjs`，因此服务端 schema 仍负责校验/默认值/写入，控制台只覆盖展示标签与帮助。
- 安全「变更者/时间」不再常显；审计时间线保留完整记录。
- 绑定地址/端口的深层语义压成一行；完整键语义仍以 `config.json` / 恢复指引为准。
- OAuth 缺 env 的具体变量名只在诊断折叠出现，主界面只留一句「oauth 用环境密钥」。
- 设置内 `<details>` 仍为 2 个（MCP 危险与自救 / 诊断与恢复）；关于本机与邀请面板各 1 个，总数不变。

## 6. 弹窗规范落地

- 统一外壳：所有 `.modal-box` 都带 `crt-surface crt-corners`；没有裸 `modal-box`。
- 小弹窗（`modal-center`，520px）：邀请、新建记忆域、切换忆云、安全操作/批准、手动连接、handoff、通用确认、bearer 令牌输入。
- 大面板（顶部对齐 + 内部滚动）：设置、关于本机、加入忆云（640px）、首启引导（640px）。
- 设置面板：标题下常驻一行「改动即生效」；页签固定；只有页签下的内容滚动；滚动条 6px 贴设置框右边缘；关闭收进右上角 X，底部关闭移除。
- 标题/说明/字段/动作：标题（可带 `crt-tag`）+ 一句 `.modal-note` + `.field` 整行输入 + 右对齐 `.modal-actions`。
- 落地位置：`packages/console/index.html` 的 `.modal` 标记 + `packages/console/console.css` 的 `.modal.modal-center` / `.modal-box-wide` / `.modal-settings` / `.settings-scroll` / `.field`；`verify-console-ui.mjs` 断言对齐、宽度与滚动区不漂移。
