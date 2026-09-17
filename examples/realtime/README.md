# realtime · 写入即推与周期兜底（可执行）

`index.mjs` 演示实时同步（v1.1）：**连接 ≠ 持续同步**，实时性来自两个显式机制：

- **写入即推送（push-on-write）**：本机是发起方时直接起一轮定向会话；是响应方时在既有信道上发
  一个无载荷 `sync-nudge` 请对方起一轮——**双向都亚秒级**（不再受设备 ID 字典序限制）；
- **周期 anti-entropy**：长连兜底（默认 10 分钟 ±20% jitter；示例缩到 1s 便于观察），
  无 pending 短路、会话在途跳过、失败退避。

库/嵌入式形态**默认关闭**两者；常驻入口（`mebular serve` / MCP）**默认开启**。
配置项：`sync.pushOnWrite`、`sync.pushOnWriteThrottleMs`（默认 50ms）、
`sync.antiEntropy.{enabled, intervalMs, jitterRatio}`。

## 运行

```bash
npm run build
node examples/realtime/index.mjs
# 预期：A 写入 → B 可见（数十 ms）；B 写入 → A 可见（nudge，数十至百余 ms）
```

数据落在系统临时目录并在结束时清理。口径见仓库根 [`SEALING.md`](../../SEALING.md) §2.7。
