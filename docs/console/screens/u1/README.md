# U-1 · 设置/共享页 UI 收口（前后对比）

基线：main `f1a1219`。截图由 `verify-console-ui.mjs`（真实 serve + headless Chrome）与同一临时 home 的 Playwright 截图生成。

> **U-4 刷新（2026-11-09）**：设置弹层改为「左侧竖轨 + 固定外壳 + 统一行模板」，常用页基线已刷新为 `u1-after-settings-common.jpg`、`u1-after-settings-common-390.jpg`（脚本原始输出名 `u1-after-settings-common*`）。旧 `after-settings-common*.jpg` 已移除。安全 / MCP / 高级的后续基线以 `../u3/` 为准，U-4 全量基线见 `../u4-settings-redesign/`。

## 折叠预算

| 范围 | before | after |
|---|---:|---:|
| 设置弹层 `#settings-body details` | 24 | **2**（MCP 危险与自救 / 诊断与恢复） |
| 设置 + 关于（邀请无折叠） | 24+ | **3**（关于·运行状态） |

白名单单一真源：`packages/console/settings-ia.js` 的 `IA_SETTINGS_FOLDS`（≤5）。

## 截图

| 文件 | 说明 |
|---|---|
| `before-settings-common.jpg` / `u1-after-settings-common.jpg` | 设置·常用（U-4 竖轨版已刷新）：删除重复「邀请设备」入口；统一 section 标题/间距；无卡片套卡片；语言行 + 常驻/修复行 |
| `before-settings-advanced.jpg` / `after-settings-advanced.jpg` | 高级：页级说明改为一行；字段帮助内联；底部诊断折叠 |
| `before-settings-mcp.jpg` / `after-settings-mcp.jpg` | MCP 接入：六字段 + 一个「危险与自救」折叠 |
| `before-settings-security.jpg` / `after-settings-security.jpg` | 安全：有资格设备一行计数；档位边界内联 |
| `after-about-runtime.jpg` | 关于本机：身份/存储/收敛 + 单一「运行状态（只读）」折叠 |
| `before-shared-empty.jpg` / `after-shared-empty.jpg` | 共享页空态：只留「＋ 新建记忆域」 |
| `before-shared-list.jpg` / `after-shared-list.jpg` | 共享页有域：域目录/订阅状态/参与设备；无邀请 CTA |
| `before-invite.jpg` / `after-invite.jpg` | 历史截图：邀请单屏（当时含「邀请设备 · 详情」；该折叠已移除，现为 TTL + 重新生成） |
| `u1-after-settings-common-390.jpg` | 390px 设置·常用（U-4 刷新）：页签换行、常驻/修复行不挤压按钮、无横向溢出 |

## 文案/动作断言

- 全站用户可见「添加设备」= 0；桌面托盘改「邀请设备」（id/点击不变）。
- 设置内无 `sync.peerWhitelist` / `sync.policyIssuers` / `autoGrant` / `status.invite.grantTtl`；无「引导签发者」。
- 用户可见「授权 / 签发 / 参与」= 0。
- CSRF 403 自愈：旧 token → 重取一次 `/console/` → 原表单内容重试一次成功；页面不重载。
