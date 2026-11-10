# U-4 · 设置弹层改版（竖轨 + 统一行模板 + 安全卡状态）截图基线

基线：`feat/console-settings-redesign` 的 A–F、常用页收口、固定高度与设计稿对齐之后。本目录补的是 U-4 改版后的设置弹层视觉基线；U-1 / U-3 目录里对应的 after 截图已同步刷新。

> **设计稿对齐（2026-11-10）**：保留 640px CRT 外壳与配色，不引入蓝底；按 Kimi 设置稿收紧内部层级——分组标题改 10px / 1.5 字距，本机状态与忆云改为 CRT 内嵌面板，忆云两行合并为一张面板，安全卡动作移入标题行右侧，本机状态前加 6px 状态点。中英文文案同步压缩，常用 / 记忆 / 安全页在 720px 内完整显示，无横向溢出。

## 范围

- **竖轨**：≥901px 为左侧 160px 固定页签轨（`常用 / 安全 / 记忆 / 集成 / MCP 接入 / 高级`，底部「关于本机」）；≤900px 折叠为顶部横排；≤760px 继续换行。
- **关于本机入口**：按设计稿做成 34px 单行，底部内缩分隔线（左右 12px）、左右 16px 内边距、11px `ⓘ` 图标；不再使用全宽粗分隔线和大圆图标。
- **固定外壳**：标题 + 「改动即生效」提示常驻；弹层固定 720px 高（中英文常用页均能容纳），切换页签不再跳高；页签轨不滚，只有内容列 `.settings-scroll` 滚动；滚动时轨与底部「关于本机」不动。
- **统一行模板**：字段行 `label | control | status` 三列，只读行 `label | value | action`；正常状态显示纯文字「生效中」，异常才是琥珀「待重启 / 未生效」。
- **模型来源在记忆页**：`记忆` 页签内「记忆模式 → 模型来源 → 模型状态 → 运行状态」，高级页不再混入模型来源。
- **安全卡状态**：三张状态卡（安全等级 / 动态码种子 / 恢复码），`is-effective`（实心点 + 左侧荧光条）/ `is-off`（空心点 + 中性底）；动作按钮收进标题行右侧，正文获得整行宽度（英文卡片不再被按钮挤成窄柱）；待批准行只在有记录时出现。
- **关于本机叠层**：设置轨底部「关于本机」在设置之上打开只读面板，设置保持打开。

## 截图

### 1440 × 900（zh-CN）

| 文件 | 说明 |
|---|---|
| `u4-after-settings-common-1440.jpg` | 常用：语言行 + 常驻运行 + 自动修复 + 只读状态 + 忆云卡 |
| `u4-after-settings-memory-1440.jpg` | 记忆：记忆模式 / 模型来源（唯一入口）/ 运行状态；模型状态仅在沉浸式显示 |
| `u4-after-settings-security-1440.jpg` | 安全：三张状态卡 = 生效（等级）+ 未配置（种子/恢复码） |
| `u4-after-settings-mcp-1440.jpg` | MCP 接入：连接 / TLS 两组 + 三列状态列 |
| `u4-after-settings-advanced-1440.jpg` | 高级：常驻服务 / 网络 / 自动化 + 诊断与恢复折叠 |
| `u4-after-settings-rail-scrolled-1440.jpg` | 记忆页滚到中部：标题、竖轨、底部「关于本机」保持不动 |
| `u4-after-settings-about-overlay-1440.jpg` | 关于本机叠在设置之上（设置不关闭） |

### 900 × 900（zh-CN，竖轨折叠为顶部横排）

| 文件 | 说明 |
|---|---|
| `u4-after-settings-memory-900.jpg` | 记忆：顶部横排页签 + 长内容滚动 |
| `u4-after-settings-security-900.jpg` | 安全：三张状态卡在横排页签下不溢出 |

### 390 × 844（zh-CN，无横向滚动）

| 文件 | 说明 |
|---|---|
| `u4-after-settings-common-390.jpg` | 常用：页签换行、常驻/修复行不挤压按钮 |
| `u4-after-settings-memory-390.jpg` | 记忆：模型来源下拉整行 |
| `u4-after-settings-security-390.jpg` | 安全：三张状态卡单列 |

### en-US（1440）

| 文件 | 说明 |
|---|---|
| `u4-after-settings-memory-en-1440.jpg` | 记忆：英文长文案在 420px 内容列内正常换行 |
| `u4-after-settings-security-en-1440.jpg` | 安全：英文状态词 + 状态卡 |
| `u4-after-settings-common-en-1440.jpg` | 常用：英文「Not resident (temporary)」不再把「Keep Mebular resident」挤出可视区 |

### reduced-motion（1440）

| 文件 | 说明 |
|---|---|
| `u4-after-settings-memory-reduced-motion.jpg` | `prefers-reduced-motion: reduce` 下记忆页（去掉过渡/闪烁，布局不变） |

## 复跑命令

官方脚本（会因「本地模型来源」段既有 fake-sidecar 缺陷中断，见下）：

```bash
CHROME_PATH='/Users/sobertli/Library/Caches/ms-playwright/chromium-1248/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
  npm run verify:console:ui
```

只要截图时，复制 `packages/console/scripts/verify-console-ui.mjs` 为同目录临时文件（保证相对 import 不变），跳过「本地模型来源」失败段（`capture('c6-settings-memory-model-source.jpg')` 之后到 `[data-settings-tab=assistants]` 点击之前），然后：

```bash
MEBULAR_SCREENSHOT_DIR=/tmp/mebular-u4-shots U4_SKIP_LOCAL_MODELS=1 \
CHROME_PATH='/Users/sobertli/Library/Caches/ms-playwright/chromium-1248/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' \
  node packages/console/scripts/verify-console-ui-u4-tmp.mjs
```

临时脚本跑完即删，不入库。u1/u3/u4 截图从 `MEBULAR_SCREENSHOT_DIR` 拷回本仓库对应目录。

## 已知既有失败（非本次 UI 改动）

官方 `verify:console:ui` 在「本地模型来源」段固定失败 **5 条**（fake sidecar 报 `model-source available:false`，随后模型卡不存在导致 null click 中断）：

1. `记忆模型来源：5 个来源、默认 heuristic、无 endpoint/key/path 明文`
2. `C8f local 选中：同一模型来源设置项内出现 4 个模型`
3. `C8f local 选中不立刻写 model-source（避免 pack_required）`
4. `C8f 模型列表 760px：单列卡片、无横向滚动`
5. `UI 冒烟执行（页面求值失败：TypeError: Cannot read properties of null (reading 'click')）`

A–E 已分别确认与本次 UI 改动无关；本会话按要求不改 API/config/core 去“修”它。跳过后其余 **415 项全绿**（连跑两次一致）。

## 人工走查结论

| 检查项 | 结论 |
|---|---|
| 1440 / 900 / 390 三档 | 1440 竖轨 160px；900 折顶部横排（`aria-orientation=horizontal`，轨宽 = 内容列宽）；390 页签换行、无横向滚动（探针 `scrollWidth <= clientWidth + 1`）。 |
| 中 / 英 | 中文与 en-US 均不裁切按钮、不产生弹框内横向溢出；1440px 下 en-US 常用 / 记忆 / 安全页内容高度均 ≤ 视口内容区（639 / 623 / 623px），无需滚动即可看全；390px 集成页 `Snippet ›` 不再越界。 |
| reduced-motion | `prefers-reduced-motion: reduce` 下无位移动画依赖，布局与常规一致。 |
| 滚动时 rail 固定 | 记忆页 `scrollTop > 0` 时 rail / rail-foot 的 `getBoundingClientRect().top` 变化 ≤1px；滚动只发生在 `.settings-scroll`。 |
| 关于本机叠层 | 设置轨底部「关于本机」打开 `#about` 时 `#settings` 仍可见，层级正确。 |
| 安全卡三种状态 | 当前低档：安全等级 = 生效（实心点/荧光条），动态码种子 = 未导入（`is-off`），恢复码 = 未生成（`is-off`）；待批准条只在有记录时出现。高档/待批准/恢复码基线见 `../u3/` 与 `../security-tiers/`。 |
| 模型来源在记忆页 | 记忆页含唯一 `#rt-model-source`；高级页断言 `!p.querySelector('#rt-model-source')` 通过。 |
| 无横向滚动 | 官方脚本 390px 断言（安全 / MCP / 高级）通过；新增常用 / 记忆 390px 探针同样通过。 |

## 本会话顺带修复（属 UI/测试收口，不改核心）

1. `packages/console/console.css`：640 外框减 160 竖轨后内容列仅约 420px，en-US 常驻行的长状态文本把动作按钮挤出可视区（官方 i18n 密度断言 1440/1024 报 `scrollerOver=75`）。按「重启向导 / 自动修复」行同一策略收紧 `.settings-resident`：名称不占固定宽、状态可收缩换行、按钮不收缩。修复后 `scrollerOver=0`。
2. `packages/console/scripts/verify-console-ui.mjs`：英文深度页断言仍期待旧文案 `Add assistant`，而实际文案与中文「＋ 接入 Agent」一致为 `+ Add agent`（i18n 翻译提交起就存在），改为 `/Add agent/`。
