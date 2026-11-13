# 社区目录与收录审计

Mebular（含其 DSH 插件）在 npm、GitHub Release 与产品站点之外的露出位置、当前实际内容，
以及下一步由谁处理。

- **审计日期**：2026-11-13
- **当前版本**：v0.3.4（`@mebular/*` 全部 npm 包，含 `@mebular/dsh-plugin`）
- **DSH 条目权威源**：[`docs/dsh/awesome-dsh-plugin-entry.yml`](../dsh/awesome-dsh-plugin-entry.yml)
- **范围**：仅社区/目录露出面。版本号、manifest、CHANGELOG、发布工作流、tag 与 release notes
  归发布流程所有，不在本文档修改范围内。

## 已确认的 DSH 长描述

条目文案以
[awesome-dsh-plugin#11519](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11519)
确认的 🌌 版为准：

```yaml
description:
  en: "🌌 Mebular · shared memory and task collaboration for agents. Through a DSH-native plugin, it provides complete cross-device, cross-agent memory sharing and task-graph capabilities — so physical devices are no longer the boundary of your agents. Secure, controllable, and decentralized!"
  zh: '🌌 Mebular 忆云 · 智能体共享记忆与任务协作。通过 DSH 原生插件接入，提供完整的跨设备、跨 Agent 记忆共享与任务图功能，让物理设备不再是你智能体的边界，安全、可控、去中心化！'
```

上游 `main` 目前是上述文本再加一句运行时前置说明（`attaches to an existing Mebular app or
CLI runtime; when none exists, …`）。该句由维护者的批量校准提交反复补回，因此按“已接受的
补充”处理，不作为需要回滚的偏差。

## 状态表

| 露出面 | 当前内容（2026-11-13） | 本次动作 | PR / 链接 | 状态 |
|---|---|---|---|---|
| awesome-dsh-plugin 条目（`data/plugins/Windsander__Mebular--packages-dsh-plugin.yml`） | 🌌 文案 + 一句运行时前置说明；`category: memory`；`url` → `tree/main/packages/dsh-plugin`；icon 可访问（HTTP 200） | 仅核对。#9167（首次收录）、#11519（🌌 文案）、#12556（恢复 🌌 文案）均已合并；未开重复 PR | [条目](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/data/plugins/Windsander__Mebular--packages-dsh-plugin.yml) · [#9167](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/9167) · [#11519](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11519) · [#12556](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12556) | 与上游一致 |
| awesome-dsh-plugin 详情页（EN/ZH） | 文案已是 🌌 版，但安装片段仍为 `@mebular/dsh-plugin@0.3.2` | 本地无法直接改：该页渲染缓存 README，由上游夜间 `build-site` 从本仓库 README 重建（本仓库已是 0.3.4） | [EN](https://awesome-dsh-plugin.com/p/Windsander/Mebular--packages-dsh-plugin/) · [ZH](https://awesome-dsh-plugin.com/zh/p/Windsander/Mebular--packages-dsh-plugin/) | 等待上游重建 |
| dshmarketplace.dev | 已收录：搜索 `mebular` 命中 1 条，分类 `memory`，安装检查 **通过**（DSH `0.2.2-rc.1`，2026-11-13），npm 安装命令不带版本，star 数为缓存值 16 | 仅核对；该站从社区 registry 与 `dsh-plugin` GitHub topic 自动同步 | [搜索](https://dshmarketplace.dev/plugins?q=mebular) · [API 记录](https://dshmarketplace.dev/api/v1/plugins?q=mebular) | 已同步 |
| dshmarket.com | 已进入 browse 索引（10,581 个插件），数据同 registry | 仅核对；该站是 awesome-dsh-plugin registry 的前端 | [browse](https://dshmarket.com/browse/) | 已同步（自动派生） |
| dsh-plugin.org | 未收录。页面只按仓库维度（`/plugins/<owner>/<repo>`）生成，提交需要 npm 包、`dsh-plugin` topic，并走 GitHub issue 审核 | 已准备提交草稿，未投递 —— 需要已登录的 GitHub 会话，本维护会话没有 | [提交页](https://dsh-plugin.org/submit) · [issue 模板](https://github.com/dshplugin/dsh-plugin-hub/issues/new) | 阻塞（缺少凭据） |
| dshplugin.app | 未收录。registry 抓取仓库根目录再分类，提交表单带交互式人机校验 | 已准备草稿，未投递 —— 表单需人工交互，且 monorepo 根目录会被索引成整个产品而非插件 | [提交页](https://dshplugin.app/submit) | 阻塞（交互式表单） |
| dsharness.io | 未收录。其目录每天爬 `dsh-plugin` topic，但对 `mebular` 返回“No plugins match”；站点数据时间戳 2026-11-06 | 仅核对；仓库已带 `dsh-plugin` topic，属对方抓取/准入侧问题 | [搜索](https://dsharness.io/en/plugins?q=mebular) | 阻塞（外部抓取） |
| dshpub | 域名不解析：`dshpub.com`、`dshpub.dev`、`dshpub.io`、`dshpub.net` 均 NXDOMAIN | 记录；无可更新对象 | — | 不适用 |
| GitHub 仓库 About | 描述、主页（`https://mebular.cyberfederal.io/`）、topics（`agent-context`、`agent-memory`、`ai-memory`、`deepseek-harness`、`dsh-plugin`、`knowledge-graph`、`mcp`、`multi-agents`、`task-graph`）均为当前值 | 仅核对，无需改动 | [仓库](https://github.com/Windsander/Mebular) | 已是最新 |
| README / README_CN 社区入口 | 安装命令已是 0.3.4；收录说明此前只提到 awesome-dsh-plugin | 补上已验证的目录链接，并指向本文档 | [`README.md`](../../README.md) · [`README_CN.md`](../../README_CN.md) | 本次更新 |
| npm（`@mebular/*`） | 8 个包的 `latest` 均为 `0.3.4`，含 `@mebular/dsh-plugin` | 只读核对；发布不属于本次范围 | [npm](https://www.npmjs.com/package/@mebular/dsh-plugin) | 已是最新 |

## 提交草稿（尚未投递）

两个接受提交的目录的现成材料。都必须由已登录的维护者投递；这些不是公告，也不应被当作评论
或社交媒体内容发布。

### dsh-plugin.org — issue 正文

```markdown
### Repository
https://github.com/Windsander/Mebular/tree/main/packages/dsh-plugin

### One-line value
Shared memory and task graph for every agent on every device, delivered as a DSH-native plugin.

### Category
Memory & Context

### Install command
dsh plugin --profile web add @mebular/dsh-plugin@0.3.4

### Compatibility
DSH >=0.2.1-rc.2 <0.3.0; Node.js >=22.19; macOS, Windows and Linux (loopback panel only).

### License
MIT

### Screenshots / demo
https://raw.githubusercontent.com/Windsander/Mebular/main/packages/dsh-plugin/assets/dsh-panel.jpg

### Notes
Monorepo sub-package: the plugin lives in packages/dsh-plugin and is published on npm as
@mebular/dsh-plugin. The GitHub repository root is the Mebular product, not the plugin alone.
```

### dshplugin.app — 表单取值

- **GitHub repository URL**：`https://github.com/Windsander/Mebular`
- **Notes**：`DSH plugin is the npm package @mebular/dsh-plugin in packages/dsh-plugin of this monorepo. Install: dsh plugin --profile web add @mebular/dsh-plugin@0.3.4. Category: memory. MIT.`

## 这个面的规则

1. 每个目录只保留一个上游条目；开新 PR 前先确认是否已有 PR 或收录。
2. 文案改动走 registry 条目，不直接改各目录自己的数据库。
3. 缓存 README 快照的目录页按其自身节奏重建，不为了刷新而开 PR。
4. 公告、marketplace 评论与对外发帖先在本文档起草，获得明确同意后再发布。
