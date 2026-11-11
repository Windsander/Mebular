# U-4 · 设置弹层 v2 基线（760 外框 + 188 竖轨 + 40 行）

基线：`feat/console-settings-redesign` 的 v2 设置改版（760×720 / 关于 760×680）。本目录是 v2 全量视觉基线；U-1 / U-3 目录里对应的设置截图已同步刷新。

> **v2 改版（2026-11-11）**：设置外框 640 → **760**，左轨 160 → **188**，内容列约 **530**；设置高 **720**、关于高 **680**。高度只保留 **34 / 40 / 58**（控件 26），面板 = 16 + 行数；字号只保留 **10 / 11 / 12 / 13 / 19**；分组标签 10px / 1.5 字距、sentence case、无渐隐横线、无 pill；安全三卡统一 **114** 并带 19px 状态值；待重启/应用结果条定高 **40**；关于本机三组 + 三折叠、40 行、43 项字段 parity。

## 范围

- **外壳**：设置 760×720、关于 760×680；标题 + 「改动即生效；重启项自动重启。」提示常驻；只有内容列 `.settings-scroll` 滚动。
- **竖轨**：≥901px 为左侧 **188px** 固定页签轨（`常用 / 安全 / 记忆 / 集成 / MCP 接入 / 高级`，底部「关于本机 ⓘ」）；**≤900px** 折叠为顶部横排；**≤760px** 顶部横排 + 只读行改为上下两行；**≤560px** 全屏无边框。
- **900 档**：顶部横排后内容区变矮，**允许竖向滚动**（正常行、正常滚动）；只读行仍是 40px、label/value 同一行，禁止套 390 的堆叠规则。
- **统一行模板**：字段行 `label | control | status`，只读行 `label | value | action`；40px + 行间虚线；常驻/忆云两行信息 58px；警告/帮助独立成行。
- **异常可见性**：`pending` / `mismatch` 的完整三元组（已配置 / 实际 / 原因）默认作为行下静态 11px 警告行显示，不依赖 focus、不藏 popover；行本身仍 40px，无异常时没有这行。
- **安全卡**：三张同构 114px（安全等级 / 动态码种子 / 恢复码），19px 状态值；`is-effective` 实心点 + 左侧荧光条，`is-off` 空心点；待批准条只在有记录时置顶（40px）。
- **关于本机**：三组（身份与存储 / 运行与同步 / 诊断与恢复）+ 三折叠，40px 行；旧 about 的 43 项字段全量保留（见 `../../../console/ABOUT-PARITY` 对应原型清单），不新增日志路径。
- **常驻「更多」**：行内 button + 浮层菜单（`aria-haspopup="menu"` / `aria-expanded`，Esc / 点外关闭，`position: fixed` 不被弹层裁切）；主操作仍直接可见。
- **集成**：保持 40 行 + 原有详情/表单，不做 58 行版本；58 只用于常驻/忆云。
- **说明密度**：每组最多 1 行 11px 说明（长解释进 title / 折叠）。记忆页为「模式提示 / 来源条件说明 / 运行范围说明」各 1 行；常用与安全无独立说明行；MCP 为连接 / TLS 各 1 行 + 端口 mismatch 时 1 行警告。

## 截图

### 1440 × 900（zh-CN）

| 文件 | 说明 |
|---|---|
| `u4-after-settings-common-1440.jpg` | 常用：语言 + 本机运行（常驻 58 / 修复 40 / 向导 40）+ 本机状态 3×40 + 忆云 2×58 |
| `u4-after-settings-common-banner-1440.jpg` | 常用 + 40px 待重启条：单行、动作右对齐、不挤压内容 |
| `u4-after-settings-security-1440.jpg` | 安全：三张 114 卡 + 19px 状态值（无待批准时不显示条件条） |
| `u4-after-settings-memory-1440.jpg` | 记忆：记忆模式（轻量 MCP / 沉浸式）/ 模型来源（heuristic/local/host/api/auto）/ 运行状态 |
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
| `u4-after-settings-common-390.jpg` | 常用：页签换行、常驻动作换行、只读行 label/value 两行 |
| `u4-after-settings-security-390.jpg` | 安全：三张卡单列 |
| `u4-after-settings-memory-390.jpg` | 记忆：模型来源下拉整行 |

### en-US（1440）

| 文件 | 说明 |
|---|---|
| `u4-after-settings-common-en-1440.jpg` | 常用：长状态词不把动作挤出可视区 |
| `u4-after-settings-security-en-1440.jpg` | 安全：英文档位 / 种子 / 恢复码状态 |
| `u4-after-settings-memory-en-1440.jpg` | 记忆：英文说明在 530 内容列内单行 / 截断 |

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

该失败在改动前的 HEAD 上同样复现，与 v2 无关。用临时副本跳过该段后：**418 / 419 通过**（唯一失败仍是同段的「模型来源」fake-sidecar 检查），900 行模板、异常可见性、关于三组、安全卡 v2、i18n v2 token 全绿；官方脚本仍只报这 5 条。

## 人工走查结论

| 检查项 | 结论 |
|---|---|
| 1440 / 1024 | 竖轨 188；弹层 760×720；常用含 40 条时内容 539.7 / 可视 590（浏览器壳）；桌面壳多 40px 向导行 → 579.7 / 590，不滚。 |
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
