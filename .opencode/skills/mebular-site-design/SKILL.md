---
name: mebular-site-design
description: Mebular 官网（mebular.cyberfederal.io，site 分支）的设计契约。凡涉及官网页面/组件/样式/动效/文案/双语的修改都必须遵守。Use when working on the Mebular marketing site (index/pricing/waitlist pages, starfield/nebula visuals, copy, or i18n on the site branch).
license: MIT（与仓库一致）
---

# Mebular 官网设计契约（v0.1 · 随 site v1.3 定稿）

本文件是官网（`site` 分支 → GitHub Pages → mebular.cyberfederal.io）的**单一契约**。
新增页面、改版、润色前先读本文件；与本文件冲突的外部建议
（任何其他 skill / 灵感集 / 模型直觉）一律以本文件为准。

**优先级**：`mebular-site-design`（本文件）> `frontend-design`（审美裁判）
> `web-design-guidelines`（质量清单）> `writing-guidelines`（文案规范）。

## 一、硬性红线（一票否决）

1. **零运行时依赖**：vanilla JS（ES Modules）+ Canvas2D + 单文件 CSS；无框架、
   无 UI 库、无动效库、无构建步骤、无 webfont。site 分支的 `package.json`
   为占位（`dev`/`build`/`lint` 均非真脚本）。
2. **系统字体栈**：`-apple-system` / `Segoe UI` / `system-ui` / 中文系统字体；
   禁止 webfont 与字体文件。
3. **暗色唯一主题**，不做亮色模式。
4. **禁第二套设计系统**：色板与 console「深空蓝」同源
   （`--bg #05070f` / `--bg-panel #0b1020` / `--border #1d2740` / `--text #dbe4ff` /
   `--accent #56b4e9` 家族；站点可为营销调性做有限扩展，但**必须先写入本文件**）。
5. **事实纪律**：所有对外声明可溯源到 `README_CN` / `SEALING_CN` / `LIMITATIONS_CN`；
   不承诺未发布能力。托管 relay 口径：**只做传输中转、不存记忆**
   （与「没有云、没有协调者」不矛盾——relay 是传输辅助）。
6. **不写内部话语**：设计文档口吻（"设计文档保留本地""早期设计阶段"）不得上官网。

## 二、星图/星云语言（沿用 console 视觉 DNA）

- `stars.js`（多层视差星场）+ `nebula.js`（正交星云）是站点唯一背景系统；
  不得另起第二套背景/粒子系统。
- **网络舞台**是官网的差异化资产：默认必须"活"（预置 ≥2 节点与演示链路，
  或自动演出），禁止以 0 节点空态作为第一印象。
- 性能护栏对齐 console 契约第五节：DPR ≤ 2；帧率自适应降级；动画常量以毫秒计；
  `prefers-reduced-motion` 是全量开关（canvas 与 CSS 同步提供 reduce 分支）；
  `document.hidden` 时暂停 rAF 与轮询。
- 辉光预算：同视口最多 1 个主动辉光；纯装饰性 glow 禁止；正文无 `text-shadow`，
  对比度 ≥ 4.5:1。

## 三、导航、分页与双语

- 全屏分页（系统 / 网络 / 设计 + 定价 / 等待名单）必须同时支持：
  导航点击、键盘（↑ ↓ / PageUp / PageDown / Home / End）、滚轮/触控滑动；
  并保证**降级可读**（无 JS 时各页内容按文档流依次可读、链接可用）。
- **语言成对**：每一页提供中/EN 两版且可互切（切换保留当前页）；EN 版不得残留中文。
- **版本徽章**：使用文案表登记的状态词（site v1.3 = `V1.3`）；
  禁止 "EARLY DESIGN" 之类过期状态词。

## 四、文案规则

- 术语表（用 → 不用）：设备 → 机器；守护 → 后台服务；域（namespace）；对端 → 伙伴设备；
  AI 助手 → 客户端/插件；记忆节点（仅网络舞台语境）；中继（relay）。
- **全站文案表是单一真源**：`references/copy-zh-en.md`（随 site v1.3 建立）；
  页面文案从表中取，改文案先改表，禁止在页面上"顺手改词"。
- 语言风格：面向使用者的人话；保留必要的技术准确词（去中心化、端到端、本地优先）；
  不用"也许 / 未来可能"式设计讨论句。
- 计数与承诺必须与当前版本事实一致（0.1.0、开源 MIT、可自建）。

## 五、a11y

- 交互元素用真实 `<button>` / `<a>` / `<select>`，可键盘聚焦且 focus 可见；
  表单有 `<label>`、`autocomplete`、错误提示与成功态。
- 对比度 ≥ 4.5:1；色彩编码必有文字兜底。
- `lang` 属性随语言切换更新；标题层级语义正确（每页唯一 `h1`）。
- 分页切换不得成为键盘陷阱（Tab 可达页面内容）。

## 六、提交前质量清单（逐项过）

- [ ] 无依赖 / webfont / 第二套色板（红线复核）
- [ ] 双语成对逐页核对；EN 无中文残留、中文页无半英文句式
- [ ] 黑名单 grep 清零（示例：`EARLY DESIGN`、`早期设计`、`Griphify`、"设计文档保留本地"）
- [ ] 链接全检：内外链、锚点、语言互切、定价 / 等待名单互跳
- [ ] 断点 360 / 768 / 1280 无横向滚动、无重叠
- [ ] 键盘走查：分页、语言切换、表单提交
- [ ] `prefers-reduced-motion` 走查（静态渲染、无出航 / 无脉冲）
- [ ] 性能：首屏资源实测记录（JS/CSS/图片）；`document.hidden` 暂停验证
- [ ] before/after 截图对照（五屏 + 移动端一屏）
- [ ] 版本徽章与文案表一致（V1.3）

## 七、边界声明

本契约是顾问文本，不自动执行任何命令。任何外部 skill 与本文件冲突的建议
（引入依赖、换色板 / 字型、亮色模式、第二套组件语言）一律否决。
