# U-4 · 设置弹层 v2 基线（760 外框 + 160 竖轨 + 40 行）

基线：`feat/console-settings-redesign` 的 v2 设置改版（760×720 / 关于 760×680）。本目录是 v2 全量视觉基线；U-1 / U-3 目录里对应的设置截图已同步刷新。

> **v2.5 实证纠偏（2026-11-12，真实 App 改前 + 本地 serve/CDP 改后）**：只读行不再被旧选择器清掉内缩——设置 / 运行状态 / 关于均为左 14，纯只读值右 14；无复制动作时不保留空 56px 列。主值在左、meta 在右；P2P multiaddr 与邀请 URL 仅显示实际 `host:port`，不可解析为 `—`。控件文字 12；安全说明 12/17、辅助 meta 11/16；忆云名称 13/19、辅助 11/16；记忆页尾 11/16；关于标题 15/20，仍 680 + 三组三折叠。1440 与 390 的 common / security / memory / integrations / mcp / advanced 均重新实测，390 无横向溢出。
> **最终几何收口**：本机运行四项均为 **40px**（常驻 / 立即重启 / 自动修复 / 重启向导）；设置面板上下 padding 全 0，panel 自身 `border-radius:10 + overflow:hidden`，首末行与中间一致。重启不进「更多」，向导不在组头。普通 group/section hint 与记忆页尾均 `display:none`，全文由组/控件 `title` 承载，异常 warning 保持可见。模型来源删除空 68px 状态列，`.cfg-control` 右对齐，`.crt-select` 为 `min(280px,100%)`、trigger 全宽；1440/900/390 均为 280px，距面板外缘 15px（14 行内距 + 1 边框）。分段外框 27、content/选项 25，选项 `height:100% + border-box`、圆角 0。常用用组间距 8、组头下距 4，并隐藏语言项上方重复的「界面」组头；四项 + 40px banner 在 1440/900/390 均不滚动。
> **v2.4 字体/间距校准（2026-11-12，设计原稿）**：页签字距 **2px**；普通只读行（settings-kv / runtime-kv）标签与值 **12 / 18**；内容滚动区 **16 / 20 / 20**；组面板内缩 **状态卡 2 / 常驻 12 / 忆云 0**；本机状态右侧 meta **11px 纯文字右对齐**（P2P 监听地址 / 邀请 endpoint / 安全档位说明，无数据 `—`）；常用 720 + 40 条内容 **558 / 596** 不滚；行仍 40/58，安全卡 114/19、160 轨、分段、序号/审计、关于 680 不变。
> **v2.3 控件 token 收口（2026-11-12）**：设置内可见控件统一 **27 高 / 8 圆角**（button `padding: 0 10`；input / select trigger `0 8`）。`.settings-group-body` **padding 0 + overflow hidden**，首/末行严格 40/58（面板高 = 行 + 2px 边框）；`.settings-group-note/-desc/-foot`、`.settings-section-foot` **width 100% / max-width none / 16px 行高 / padding 0 14**，取消 62ch；390 自动修复行改 58 两行，meta 留在面板内。实测：button 27/8/10、trigger 27/8/8、input 27/8/8；group label/body x=541，note 元素 x=542（1px 面板边框内）、右缘 1078，文字左 556。
> **v2.2 校准（2026-11-11，任务书覆盖）**：设置外框 **760**、左轨 **160**、内容列 **538**（约 540）；`.modal-settings` 内距 `18 0 18 20`，`.settings-scroll` 横向 **20** —— 竖线到内容、内容到右缘都留 20（滚动条贴右）。Header **57**（18 顶距 + 38 行）：`✦ 本机设置  改动即生效…` 同一行。左轨激活 **实底 `rgba(80,255,170,.06)` + 2px 左条 + 亮绿**。设置高 **720**、关于 **680**；行 **34 / 40 / 58**，按钮 **27**、输入/下拉 26。
> 排印：页面标题 **15/700**；字段标签/正文 **13/400**；分组标签 **10/600/1.5 字距 + uppercase**（中文不受影响）；辅助 **11/16**；微 **10**；字体栈 **JetBrains Mono 优先**（系统 fallback，不引 webfont）。
> 组件：`.cfg-row` **150 / minmax(0,1fr) / 68** 三列；安全卡 **22px 序号 01–03 + 主列 + 动作列**、仍 **114**、19px 值；卡片下 **11px 审计一行流**（无事件隐藏）；待重启条 40；异常三元组默认可见。
> **Reviewer 文档冲突已收口**：早期 review §4 写 188、§5 写 160；最新 PR #315 校准任务书明确 **160 为准**，本基线按 160 重测重拍。

## 范围

- **外壳**：设置 760×720、关于 760×680；`✦ 本机设置` 与「改动即生效；重启项自动重启。」同一行（header 57，含 18 顶距）；只有内容列 `.settings-scroll` 滚动。
- **竖轨**：≥901px 为左侧 **160px** 固定页签轨（`常用 / 安全 / 记忆 / 集成 / MCP 接入 / 高级`，底部「关于本机 ⓘ」）；激活态为整行实底 + 2px 左条。**≤900px** 折叠为顶部横排；**≤760px** 顶部横排 + 只读行改为上下两行；**≤560px** 全屏无边框。
- **900 档**：顶部横排后内容区变矮，**允许竖向滚动**（正常行、正常滚动）；只读行仍是 40px、label/value 同一行，禁止套 390 的堆叠规则。
- **统一行模板**：字段行 `label 150 | control 1fr | status 68`，只读行 `label | value | action`；40px + 行间虚线；常驻两项信息也在 40px 内，忆云两行信息 58px；高级开关 38×20；警告/帮助独立成行。
- **常用「界面」与本机运行**：语言行保留自有 label，不重复显示「界面」组头；「重启向导」是本机运行最后一个 40px 行（保留 `#settings-open-wizard` 与桌面桥条件）。其它页组间距 **12**、组头下距 **8**；常用使用 **8 / 4**，四项 + 40px banner 在 1440/900/390 均不滚动。
- **异常可见性**：`pending` / `mismatch` 的完整三元组（已配置 / 实际 / 原因）默认作为行下静态 11px 警告行显示，不依赖 focus、不藏 popover；行本身仍 40px，无异常时没有这行。
- **安全卡**：三张同构 114px（安全等级 / 动态码种子 / 恢复码），19px 状态值；`is-effective` 实心点 + 左侧荧光条，`is-off` 空心点、off 大数值用 `--crt-dim`；警告行（`.sec-card-warn`）inset 2px 琥珀 + 8px 左内距。待批准条只在有记录时置顶（40px）。
- **关于本机**：三组（身份与存储 / 运行与同步 / 诊断与恢复）+ 三折叠，40px 行；旧 about 的 43 项字段全量保留（见 `../../../console/ABOUT-PARITY` 对应原型清单），不新增日志路径。
- **常驻「更多」**：行内 `btn-crt` ghost（bg rgba(8,38,26,.6) / bd rgba(80,255,170,.32) / #A9FFD4）+ 浮层菜单（`aria-haspopup="menu"` / `aria-expanded`，Esc / 点外关闭，`position: fixed` 不被弹层裁切）；主操作仍直接可见。
- **集成**：保持 40 行 + 原有详情/表单，不做 58 行版本；58 只用于忆云。
- **说明密度**：普通分组说明 / note / foot 默认隐藏，全文进所在组或控件的 `title`；记忆模式、模型来源与页尾说明同样不占布局。MCP 端口 mismatch、待重启、安全待批准等异常 warning 始终可见。
- **记忆模式**：单个外框分段控件（两格等宽、无间隙），active 格 `rgba(80,255,170,.10)` + ✓；标题旁不再挂模式 chip；外框 27 高 / 8 圆角；内部选项为外框 content 高（25），不再写死 27。
- **运行状态**：模式/状态值是右对齐纯文字（无 `.crt-tag`），异常才琥珀，空值 `—` 用 `--crt-faint`。
- **忆云状态**：「当前」= `.sec-tag-current` 绿描边微光；「已归档」= 透明底 + `--crt-border-soft` 描边 + `--crt-dim`；不用列表页填充式 `.ns-chip`。
- **开关**：off 轨道 `rgba(140,255,200,.12)`、滑块 `rgba(140,255,200,.45)`（去蓝）；on 仍 `var(--ok)` + 白滑块。

## 截图

### v2.2 / v2.3 改前/改后对照

`u4-v22-before-after.jpg`：v2.2 的 9 组裁切对照（header / 160 轨与 20 呼吸 / active 实底 / 分段 / 运行状态去 pill / 忆云 tag 与更多 ghost / 安全 off 值与警告 left-bar / 开关 off / 整页对齐）。
`u4-v23-token-audit.jpg`：v2.3 控件 token 对照（button/trigger/input 27/8、group body padding 0、首行贴边 3×、说明全宽、390 自动修复行）。
`u4-v24-typography.jpg`：v2.4 字体/间距对照（页签 0.72→2px、只读行 13/19→12/18、滚动区 8→16、面板 0→2/12/0、状态 meta、390）。

### 1440 × 900（zh-CN）

| 文件 | 说明 |
|---|---|
| `u4-after-settings-common-1440.jpg` | 常用：语言 + 本机运行四项均 40（panel 0 内缩）+ 本机状态 3×40（12/18 + 右侧短 meta）+ 忆云 2×58 |
| `u4-after-settings-common-banner-1440.jpg` | 常用 + 40px 待重启条：单行、动作右对齐、不挤压内容 |
| `u4-after-settings-security-1440.jpg` | 安全：01–03 序号列 + 114 卡 + 19px 值 + 11px 审计一行流（无事件时隐藏） |
| `u4-after-settings-memory-1440.jpg` | 记忆：单框分段（轻量 MCP / 沉浸式，active .10 + ✓）/ 模型来源（heuristic/local/host/api/auto）/ 运行状态（纯文字，无 pill） |
| `u4-after-settings-mcp-1440.jpg` | MCP：连接 / TLS 两组；端口未生效时行下可见「已配置 / 实际 / 原因」 |
| `u4-after-settings-advanced-1440.jpg` | 高级：常驻服务 / 网络 / 自动化 + 诊断折叠 |
| `u4-after-settings-rail-scrolled-1440.jpg` | 记忆页滚动后：标题、竖轨、底部「关于本机」不动 |
| `u4-after-settings-about-overlay-1440.jpg` | 关于本机叠在设置之上（设置不关闭），三组 + 折叠 |

### 900 × 900（zh-CN，顶部横排，允许竖向滚动）

| 文件 | 说明 |
|---|---|
| `u4-after-settings-common-900.jpg` | 常用：横排页签；P2P/邀请服务/安全等级仍 40 行、label/value 同行 |
| `u4-after-settings-security-900.jpg` | 安全：三张卡在横排页签下不溢出 |
| `u4-after-settings-memory-900.jpg` | 记忆：长内容竖向滚动 |
| `u4-after-settings-about-900.jpg` | 关于：760×680，行仍 40、label/value 同行 |

### 390 × 844（zh-CN，全屏，无横向滚动）

| 文件 | 说明 |
|---|---|
| `u4-after-settings-common-390.jpg` | 常用：页签换行、常驻动作换行；重启/修复/向导均独立 40 行、普通 hint 隐藏；只读行 label/value 两行 |
| `u4-after-settings-mcp-390.jpg` | MCP：字段行堆叠、异常行下 warning 可见 |
| `u4-after-settings-advanced-390.jpg` | 高级：三组堆叠、开关行不溢出 |
| `u4-after-settings-security-390.jpg` | 安全：三张卡单列 |
| `u4-after-settings-memory-390.jpg` | 记忆：模型来源下拉整行 |

### en-US（1440）

| 文件 | 说明 |
|---|---|
| `u4-after-settings-common-en-1440.jpg` | 常用：长状态词不把动作挤出可视区 |
| `u4-after-settings-security-en-1440.jpg` | 安全：英文档位 / 种子 / 恢复码状态 |
| `u4-after-settings-memory-en-1440.jpg` | 记忆：英文普通说明隐藏并由 `title` 承载；下拉右对齐、运行状态 12/18 |

### reduced-motion（1440）

| 文件 | 说明 |
|---|---|
| `u4-after-settings-memory-reduced-motion.jpg` | `prefers-reduced-motion: reduce` 下记忆页（无过渡，布局不变） |

## 复跑

官方脚本会因「本地模型来源 / C8f」既有 fake-sidecar 缺陷中断（见下）。截图由本地 CDP 直连生成（深链 `?view=settings&tab=…&lang=…`，视口 1440×900 / 900×900 / 390×844，JPEG q90）：

```bash
# 先起本地测试 serve（只读，不碰 App / ~/.mebular）
MEBULAR_HOME=/tmp/mebular-v2-home MEBULAR_USER_HOME=/tmp/mebular-v2-home \
MEBULAR_CLOUD_ROOT=/tmp/mebular-v2-home node packages/mcp/bin/mebular.mjs serve --port 7391

# 再用 CDP 截图脚本（本目录 v2 基线即此流程产物；脚本不入库）
```

设置页也支持深链直接打开：`/console/?view=settings&tab=common|security|memory|mcp|advanced`，`&lang=en` 切英文；关于本机从页签轨底部「关于本机 ⓘ」打开。

## 已知既有失败（非本次 UI 改动）

官方 `verify:console:ui` 在「本地模型来源」段固定失败 **5 条**（fake sidecar 报 `model-source available:false`，随后模型卡不存在导致 null click 中断）：

1. `记忆模型来源：5 个来源、默认 heuristic、无 endpoint/key/path 明文`
2. `C8f local 选中：同一模型来源设置项内出现 4 个模型`
3. `C8f local 选中不立刻写 model-source（避免 pack_required）`
4. `C8f 模型列表 760px：单列卡片、无横向滚动`
5. `UI 冒烟执行（页面求值失败：TypeError: Cannot read properties of null (reading 'click')）`

该失败在改动前的 HEAD 上同样复现，与 v2 无关。用临时副本跳过该段后：**432 / 432 通过**（900 行模板、异常可见性、关于三组、安全卡 v2、i18n v2 token、v2.2 栅格/分段/去 pill 全绿）；官方脚本仍只报这 5 条。

## 人工走查结论

| 检查项 | 结论 |
|---|---|
| 1440 / 1024 | 竖轨 160；弹层 760×720；内容列 538，竖线→内容/内容→右缘各 20；常用含 40 条时内容 574 / 可视 596，不滚；header 57 同行。 |
| 900 | 顶部横排（`aria-orientation=horizontal`）；只读行 40 高、dt 与 value 的 top 差 0；允许竖向滚动，无横向溢出。 |
| 390 | 全屏；页签换行；只读行两行（label 上 / value 下）；`document.scrollWidth === innerWidth`。 |
| 中 / 英 | 中英同一套 token；英文说明走单行 + 截断（`title` 保留全文），不撑行高。 |
| reduced-motion | 无过渡依赖，布局与常规一致。 |
| 滚动时 rail 固定 | 记忆页 `scrollTop > 0` 时 rail / rail-foot 位置不变；只有 `.settings-scroll` 滚动。 |
| 关于本机叠层 | 设置轨底部「关于本机 ⓘ」打开 `#about` 时 `#settings` 仍可见。 |
| 安全卡 | 低档：等级生效（实心点/荧光条）、种子未导入、恢复码未生成；待批准条只在有记录时出现。 |
| 行模板 | 1440/1024/900：40 行、label/value 同行；390：两行；无横向滚动。 |

## v2 修复记录

1. `900` 断点曾误把只读行压成上下两行（`grid-column: 1`），行高从 40 涨到 ~80、常用内容 659.7。已把堆叠规则移到 **≤760**，900 保持三列/同行；修复后 900 常用内容 **539.7 / 535**（仅 4.7 竖向滚动），行高 40、dt/value top 差 0。
2. 待重启/应用结果条从多行块收成 **40px** 单行（字段清单与手动指引进 `title`）。
3. 关于本机由 8 段单折叠改为三组 + 三折叠，40 行；43 项字段 parity。
4. 异常三元组原先被 v2 的 `.cfg-row > .cfg-effective { display:none }` 隐藏，只能聚焦看到；现移到行外做静态警告行，`pending/mismatch` 默认可见，行仍 40。
