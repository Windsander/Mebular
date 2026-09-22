---
name: mebular-memory
description: 通过 Mebular MCP 使用跨设备、离线可用的图式长期记忆：先查后写、类型化节点、时效与关系、隐私红线。
whenToUse: 需要记住或复用用户偏好/事实/会话/技能，跨会话或跨设备共享 Agent 记忆，或按语义/关系检索既有记忆时。
---

# Mebular Memory

Mebular 是一个本地优先的分布式图记忆层。通过 MCP 工具读写记忆，行为规约见 `MEMORY_POLICY.md`。

## 何时使用

- 用户透露稳定偏好、事实或约束，且未来会复用时。
- 需要回顾历史会话、任务过程或既有技能时。
- 需要按语义（同义不同词）或关系检索既有记忆时。

## 工具（11 个）

| 工具 | 用途 |
|------|------|
| `memory_write` / `memory_write_batch` | 写入一/多条记忆（fact / preference / episode / observation / skill） |
| `memory_query` | 语义（配置向量索引）/关键词召回，可按类型与过滤 |
| `memory_search` | 关键词检索，可选一跳关系 |
| `memory_profile` | 用户偏好与属性画像 |
| `memory_skills` | 技能列表（按分类/关键词/标签） |
| `memory_history` | 会话历史 |
| `memory_graph` | 从某节点遍历关系图 |
| `memory_import` | 经适配器导入异构来源（kv / markdown / …） |
| `memory_status` | 设备/网络/计数/状态哈希/开关 |
| `memory_sync` | 连接对端并等待一次同步（需 network.enabled） |

## 工作流

1. **先查后写**：写入前用 `memory_query`/`memory_search` 查重。
2. **选对类型**：稳定事实→`fact`；用户偏好→`preference`；会话/任务过程→`episode`；可复用步骤→`skill`；观察→`observation`。
3. **标注时效**：有有效期的用 `metadata.expiresAt`；过期事实不当现状。
4. **表达关系**：`metadata.relatedTo` 精确关联已存在节点。
5. **诚实回答**：召回为空就如实说明，不要臆造记忆。

完整行为规约见 `MEMORY_POLICY.md`。

## 接入

本 Skill 目录附各客户端 MCP 接入片段（见 `mcp/`）；`scripts/install.mjs` 可将本 Skill 安装到常见 Skill 目录。

## 部署 / 加入 / 邀请

**部署一台新机器、加入别人的 Mebular、生成邀请（二维码 + 令牌）**：见 [`SETUP.md`](./SETUP.md)
——面向 Agent 的可执行剧本（前置检查 → 安装 CLI（钉 SHA）→ `fleet quickstart` / `fleet join --qr` →
`mebular doctor --net` 自检 → 失败恢复 → 安全红线）。
