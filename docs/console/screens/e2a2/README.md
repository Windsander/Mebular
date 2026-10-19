# E2-A2 · 忆云控制台 UI · 截图

同一沙箱（临时 `MEBULAR_HOME` + `MEBULAR_CLOUD_ROOT`，注册表含「忆云 1」当前 /「忆云 2」已归档）；桌面 1440×900 / 窄屏 390×844。截图不含真实凭据（邀请令牌/二维码均为临时沙箱生成，已随进程销毁）。

| 文件 | 场景 | 断言点 |
|---|---|---|
| `e2a2-after-topbar-live.jpg` | 活体顶栏 | 品牌后忆云徽章（忆云 1）+「加入忆云 / 邀请设备」对称入口 |
| `e2a2-after-cloud-join-modal.jpg` | 加入忆云弹层 | 令牌、名字预填「忆云 3」、当前忆云归档提示、无 App 桥文案 |
| `e2a2-after-settings-clouds.jpg` | 设置 · 常用忆云卡 | 当前/已归档、根指纹、最近使用、切换/改名；无删除入口 |
| `e2a2-after-cloud-switch-fallback.jpg` | 已归档切换（无 App 桥） | 危险确认后显示 `mebular cloud use p_demo0001` + 复制；当前忆云不变 |
| `e2a2-after-invite-cloud-line.jpg` | 邀请设备单屏 | 本忆云名 + 根指纹 +「加入忆云」指路 |
| `e2a2-after-topbar-narrow-390.jpg` | 390px 顶栏 | 两枚入口折叠为等宽图标；忆云徽章可见；无横向溢出 |

复跑：`MEBULAR_SCREENSHOT_DIR=docs/console/screens/e2a2 npm run verify:console:ui`（Chrome 经 `CHROME_PATH` 指定；无浏览器时 UI 冒烟 SKIP）。
