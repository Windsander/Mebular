# authorization · 图上授权生命周期（可执行）

`index.mjs` 演示「授权即记忆」的完整闭环（无中心服务，全部由签名事件驱动）：

1. **默认拒绝**：A 持有数据，B 未获授权 → 同步后 B 拿不到任何分区；
2. **授予**（`grantNamespaces`）→ B 收到授权事件并**补发历史**（扩权回补）；
3. **撤销**（`revokeGrant(grantId)`）→ A 的新写入不再发给 B；**已入图数据不回撤**（域收缩）；
4. **恢复**：用**全新 grantId** 再授予 → B 补发拿到撤销期间的写入（R-d：恢复须用新 id）。

每一步打印 `getEffectiveNamespaces(peer)` 审计结果；`getRevokedDevices()` 展示设备吊销审计入口
（本示例未做设备吊销，见 README「记忆分区与选择性同步」）。

## 运行

```bash
npm run build
node examples/authorization/index.mjs
```

数据落在系统临时目录并在结束时清理。协议语义以仓库根 [`SEALING.md`](../../SEALING.md) 为准。
