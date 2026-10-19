# E1 · 入口收口 · 前后对比截图

同一沙箱（`MEBULAR_USER_HOME` 显式指向临时目录）；桌面 1440×900 / 窄屏 390×844；mock 走 `?mock=1`。截图不含真实凭据（邀请令牌/二维码均为临时沙箱生成，已随进程销毁）。

| 文件 | 场景 | 断言点 |
|---|---|---|
| `before-topbar-live.jpg` | 改动前 · 活体顶栏 | 「连接已有地址」与邀请按钮并列（基线） |
| `before-invite-live.jpg` | 改动前 · 活体邀请面板 | 令牌/二维码在首屏，但机制说明与端点信息占据界面 |
| `before-settings-common-mock.jpg` | 改动前 · `?mock=1` 设置 | 安全卡占「常用」顶部；无独立安全 tab |
| `before-topbar-narrow-390.jpg` | 改动前 · 390px 顶栏 | 基线窄屏 |
| `after-topbar-live.jpg` | 改动后 · 活体顶栏 | 仅「设置 / ＋ 邀请设备」 |
| `after-invite-single-screen.jpg` | 改动后 · 活体邀请面板 | 首屏 = 令牌 + 二维码 + 复制 + 一行安全提示；端点/命令/机制收「详情」 |
| `after-settings-security-tab.jpg` | 改动后 · 活体「安全」tab | S3 安全卡完整随迁（低/中/高、动态码种子、恢复码、边界说明） |
| `after-settings-security-mock.jpg` | 改动后 · `?mock=1` 高档安全卡 | 离线验收路径；待批准 + 恢复码 + 拒绝原因同屏 |
| `after-settings-mcp-tab.jpg` | 改动后 · 活体「MCP 接入」tab | 六项 MCP 字段独立成危险卡（port/auth/host/tls/tlsKey/tlsCert） |
| `after-settings-security-narrow-390.jpg` | 改动后 · 390px「安全」tab | 5 页签换行、无横向溢出；安全卡不溢出 |

复跑：`MEBULAR_SCREENSHOT_DIR=docs/console/screens/e1 npm run verify:console:ui`（Chrome 经 `CHROME_PATH` 指定；无浏览器时 UI 冒烟 SKIP）。
