# U-5 · 运行时页面改版基线（四格状态带 + 单列召回轨迹）

分支：`feat/console-runtime-redesign`。范围仅限控制台「运行时」页面（`#runtime-view` / `nav.runtime`），不改 API、配置、存储、同步与写路径。

## 方向修正

「运行时」原先还提供一个「记忆时间线」，与「记忆」主页读取同一 `/admin/api/memories`，同样提供浏览/查看/归档/删除，只是多了内部对象与类型筛选——属于功能重叠。本版已删除时间线：

- 不做两视图 tabs；时间线、筛选 select、内部对象开关、时间线行、对象详情、归档/删除动作与 `/admin/api/memories` 请求全部移除。
- 运行时只保留：标题 + 刷新、单一状态带（服务 / 模式 / 模型来源 / 版本、异常条）、单列召回轨迹。
- 「记忆」页保持不变，继续是记忆浏览的单一入口。
- 召回轨迹保留展开详情与反馈动作；行改为账本式，不再每行嵌套卡片。

## 页面与一致性

- **页面壳**：沿用共享 / 记忆 / 审计的 `.panel-view` / `.audit-toolbar` / `.view-head`；标题直接复用 `.view-head h2`（13px / 700 / 18px / 3px），刷新按钮复用 `.btn.btn-crt`（34px / padding 7px 11px / 圆角 8px / 8px 内距）。没有运行时专属的标题字号或页面级按钮尺寸。
- **轨迹标题**：`#runtime-traces` 上方有可见 `h3`（`runtime.trace.title`，13 / 700 / 18），section 与列表都用 `aria-labelledby` 指向它；空态、加载、错误、轻量 MCP 下标题保持可见。
- **状态带**：四格 `服务状态 / 记忆模式 / 模型来源 / 版本`。服务状态是单一状态点 + 文本；正常就绪时只有这一条。降级、失败、错误、未启用时追加一条左侧细条状态行（`role=status` / `role=alert`，错误原文沿用原脱敏函数）。900 起允许 2×2。
- **轨迹账本**：从审计的 `.audit-item` 扁平行派生——透明底、0 圆角、虚线底边、`9px 8px 9px 10px` 内距；列为 `时间 / 召回标签 / 查询与紧凑 meta / 一个动作`。行内标签复用 `.crt-tag`（10px），动作复用 `.btn-small`（27px），反馈按钮在展开详情中。详情只保留左侧细线，无大圆角卡。
- **状态块**：加载、空态、错误、轻量 MCP 禁用各只有一个状态块；轻量时状态带显示「轻量 MCP / 不可用」，轨迹给出准确的未启用说明。空 / 加载 / 错误由 Jest 静态断言覆盖（`renderRuntimeTraces` 的四个分支与 `data-rt-traces-disabled` / `data-rt-traces-unavailable` 锚点），不伪造服务端数据截图。
- **可访问性**：轨迹列表是语义化 `ul/li`，展开按钮具备 `aria-expanded` / `aria-controls`，且 `aria-controls` 指向的详情节点 `id="rt-trace-detail-<id>"` 在展开、加载、错误状态下都存在；状态行使用 `role=status` / `role=alert`；状态同时有文字，不只靠颜色。
- **文案清理**：`runtime.trace.note` 已删除（标题承担该列的识别，正文没有第二段说明）；`runtime.trace.listLabel` 也已删除，中英同步。`runtime.trace.title` 现在同时用于可见标题。
- **视觉**：沿用既有 `--crt-*` token、系统字体栈、CRT 扫描线与暗色唯一主题；未引入依赖、webfont、新色板或第二套组件。无新增常驻动画；`prefers-reduced-motion` 下运行时行无过渡。

## 主页面一致性实测

数据来自 `verify:console:ui` 的同一轮 1440×900 / 390×844 走查（运行时 = `/console` 运行时页；共享 = 记忆共享；记忆 = 记忆主页；审计 = 审计时间线）。

| 项目 | 运行时 | 共享 | 记忆 | 审计 |
|---|---|---|---|---|
| h2（1440 / 390） | 13px / 700 / 18px / 3px | 同 | 同 | 同 |
| toolbar 顶部 y（1440） | 107 | 107 | 107 | 107 |
| toolbar 高度（1440） | 34 | 34 | 34 | 34 |
| 页面级按钮 | 34px / 7px 11px / 8px | 同 | 同 | 同 |
| 行形态 | 扁平行 0 圆角、虚线底边、`9px 8px 9px 10px` | 扇区项 | 卡片 8px 圆角、`10px 12px`（未改） | 扁平行 0 圆角、虚线底边、`9px 8px 9px 10px` |
| 行内标签 | `.crt-tag` 10px | — | `.crt-tag` 10px | `.audit-action` 11px |
| 行内动作 | `.btn-small`（本地 27px；与记忆页同高） | — | `.btn-small`（本地 27px） | — |
| 390 横向溢出 | 0 | 0 | 0 | 0 |

390 下 toolbar 高度随内容自然增长（运行时 / 共享 34；记忆 64；审计 104，筛选换行），这是既有页面的内容驱动高度，不是运行时新增样式；h2 与页面级按钮仍完全同源。

行内动作不写死像素高度：它复用记忆页同一个 `.btn-small`。macOS 实测 27px，CI Linux 的字体度量下为 24px；测试按“与记忆页行内按钮同高”断言，避免跨平台误报，也不引入第二套按钮尺寸。

## 截图

### 改前（旧版运行时，含三张状态卡 + 时间线）

| 文件 | 说明 |
|---|---|
| `u5-before-runtime-1440.jpg` | 三张状态卡占满首屏，时间线从约 y=680 才开始；时间线/轨迹硬并排。 |
| `u5-before-runtime-900.jpg` | 900 下时间线在 y≈828 才出现。 |
| `u5-before-runtime-390.jpg` | 390 下时间线在 y≈930，首屏看不到记录。 |

### 改后

| 文件 | 说明 |
|---|---|
| `u5-after-runtime-traces-1440.jpg` | 状态带 + 可见 h3「召回轨迹 · 为什么想起」+ 单列账本；首行顶部实测 238px。 |
| `u5-after-runtime-traces-expanded-1440.jpg` | 展开详情：`aria-controls` 指向的 `id` 存在；why / hits / citations / confidence / domain / owner / provenance + 反馈；左侧细线，无大圆角卡。 |
| `u5-after-runtime-traces-900.jpg` | 900：状态带 2×2，首行仍在首屏；`docOver=0 / panelOver=0`。 |
| `u5-after-runtime-traces-390.jpg` | 390：状态带 2×2，行堆叠；`docOver=0 / panelOver=0 / bodyOver=0`。 |
| `u5-after-runtime-traces-en-1440.jpg` | en-US：状态带 / 召回轨迹 / 行动作全部走 i18n；用户数据保持原文。 |
| `u5-after-runtime-traces-reduced-motion-1440.jpg` | `prefers-reduced-motion: reduce`：行无动画/过渡。 |

### 主页面一致性验收（1440 / 390）

同一轮脚本按运行时 → 共享 → 记忆 → 审计顺序截图，不覆盖旧目录：

`u5-consistency-runtime-1440.jpg`、`u5-consistency-shared-1440.jpg`、`u5-consistency-memories-1440.jpg`、`u5-consistency-audit-1440.jpg`；以及对应的 `-390.jpg`。

## 验证

在本地构建 `npm run build` 后执行：

```bash
npm run verify:console
npm test -- tests/console/runtime-ui.test.mjs
npm run verify:console:ui   # 需 CHROME_PATH 指向 Chrome/Chromium
npm run lint
npm run check:docs
npm run check:i18n
```

UI 冒烟覆盖：三张状态卡不存在、状态带四格、可见轨迹标题与 `aria-labelledby`、无时间线 / 无 tabs、轨迹账本行、`aria-controls` 指向的详情节点存在、轨迹展开与反馈徽标、1440/900 首行可见、390 无横向溢出、轻量 MCP 禁用状态、英文与 reduced-motion，以及运行时 / 共享 / 记忆 / 审计的主页面一致性。空 / 加载 / 错误由 Jest 静态断言覆盖。

## 本轮验证结果

| 命令 | 结果 |
|---|---|
| `npm run verify:console` | 通过 |
| `npm test -- tests/console/runtime-ui.test.mjs` | 27 / 27 通过 |
| `npm run verify:console:ui` | 460 / 460 通过（完整脚本，未跳过任何段） |
| `npm run lint` | 通过 |
| `npm run check:docs` | 7 / 7 通过 |
| `npm run check:i18n` | 32 项检查，0 失败 |

截图复跑（示例）：

```bash
CHROME_PATH=/path/to/chrome \
MEBULAR_SCREENSHOT_DIR=/tmp/u5-shots \
npm run verify:console:ui
```

改前截图由同一 serve + fake sidecar 数据在旧版运行时代码上生成（临时脚本不入库）。

## 边界

- 修改：`packages/console/index.html`（`#runtime-view` 内部）、`console.js`（`renderRuntime*` 与 runtime 事件/数据加载）、`console.css`（runtime 作用域规则）、`scripts/verify-console-ui.mjs`（runtime 断言与一致性走查）、`scripts/verify-console.mjs`（仅 runtime 静态锚点从 `#runtime-timeline` 改为 `#runtime-status`）、中英文 console 文案、runtime 专属 Jest 断言与本文目录。
- 未改 API、配置、存储、同步、写路径、设置页、星图 / 共享 / 记忆 / 审计 / 邀请页面。
- 未把时间线搬去「记忆」页；`#memories-view`、记忆页筛选/动作/API 原样保留。
