# 日志型端（log-journal）

Mebular 跨端互通的 append-only 日志端参考：设备日志、行为流水、手动
记录——任何「一行一条、只增不改」的文本都能进图，不依赖 Mebular
运行时，只约定行格式。

## 数据形态

两种形态，同一适配器按内容自动判别：

**JSONL**（`data/journal.jsonl`）：每行一个 JSON 对象。

```jsonl
{"time": 1756502400000, "level": "info", "message": "同步窗口开启"}
```

识别字段：时间 `time` / `timestamp` / `ts`（epoch 毫秒或 ISO 字符串）；
正文 `message` / `text` / `msg` / `content`（必需）；级别 `level`
（进节点标签 `level:<level>`）。任一行解析失败或缺正文字段 → 诚实
报错（带行号），不产生半成品投影。

**纯文本**（`data/plain.txt`）：每行一条，可选 ISO 时间戳前缀与
`[LEVEL]` 前缀：

```
2026-08-28T09:00:00Z [INFO] 设备上线
2026-08-28T09:05:12Z 心跳正常
[WARN] 磁盘水位 80%
```

## 映射规则

| 日志结构 | Mebular 节点/边 |
| --- | --- |
| 日志整体 | 容器 Entity：entityType=`other`，name=来源端标识 |
| 每行 | Episode：episodeType=`observation`，时间戳进 `startTime`，级别进标签 |
| 条目归属 | 容器 → 条目的 `source_of` 边 |
| append-only 序 | 相邻条目接 `follows` 边（后一条 follows 前一条），时序在图内可遍历 |

互通链路：`LogJournalAdapter` → CMF（`src/exchange/cmf.ts`）→ 适配器
框架幂等落图（`src/exchange/adapter.ts`）→ 图同步收敛到其他端。
条目 ID 为确定性 `log:<index>`，跨端去重键含内容指纹，重发/乱序
不会误判为重复。

集成测试见 `tests/exchange/`。
