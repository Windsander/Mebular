# 安全三档 UI · 前后对比截图（S3）

同一沙箱（`MEBULAR_USER_HOME` 显式指向临时目录），桌面 1440×900 / 窄屏 390×844；mock 走 `?mock=1`。截图只用于验收对照，不含真实凭据（恢复码/种子均为一次性演示或已销毁）。

| 文件 | 场景 | 断言点 |
|---|---|---|
| `before-settings-common-live.jpg` | 改动前 · 活体低档设置·常用 | 安全卡插槽未渲染（基线） |
| `after-settings-security-live-high.jpg` | 改动后 · 活体高档安全卡（状态全貌） | 当前档 / 动态码种子状态 / 恢复码 / 拒绝原因 / 降级入口 |
| `after-settings-security-live-high-pending.jpg` | 改动后 · 活体高档待批准 | 两条他机请求 + 配对号（aria-live）+ 批准/拒绝 + 到期时间 |
| `after-settings-security-mock-high.jpg` | 改动后 · `?mock=1` 高档完整卡 | 离线验收路径；pending + recovery + rejection 同屏 |
| `after-settings-security-narrow-390.jpg` | 改动后 · 390px 窄屏 | 无横向溢出；三档说明、配对号、按钮换行正常 |
| `after-invite-high-pairing-wait.jpg` | 改动后 · 高档邀请改道 | 先出配对号并等待另一台设备批准，批准后自动出令牌 |
| `after-high-kick-recovery-code.jpg` | 改动后 · 高档移出「用恢复码执行」 | 原确认与会签等待保留；切到恢复码输入（密码型、不回显、不落浏览器存储） |
| `after-audit-security-mock.jpg` | 改动后 · 审计安全行 | 等级变更 / 会签 / 恢复码 / 动态码 + 拒绝原因抬头可见 |

复跑：`npm run verify:console`、`npm run verify:console:ui`（Chrome 经 `CHROME_PATH` 指定；无浏览器时 UI 冒烟 SKIP）。截图复跑：`MEBULAR_SCREENSHOT_DIR=docs/console/screens/security-tiers npm run verify:console:ui`（S4 新增 `after-high-kick-recovery-code.jpg`）。

> E1 入口收口后，安全卡位于设置「**安全**」Tab（本目录截图保留 S3 时期位置作为历史对照；E1 新截图见 [`../e1/`](../e1/)）。
