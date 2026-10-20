# namespace · 分区隔离与订阅供给（可执行）

`index.mjs` 演示记忆分区在同步侧的边界：

1. A 只订阅 `default` 分区 → B 拿不到 `private` 分区的记忆；
2. **扩订阅回补**：把 `private` 加进订阅、A 重启（水位从磁盘恢复）后，
   B 自动收到此前被跳过的历史事件，不会永久缺失。

## 运行

```bash
npm run build
node examples/namespace/index.mjs
```

数据落在系统临时目录并在结束时清理。分区与水位语义详见 README「记忆分区与选择性同步」。
