# 升级/回滚数据安全演练（C19）

该目录只包含验收编排，不修改产品语义。

```bash
node tests/acceptance/upgrade-rollback/run-upgrade-rollback.mjs
```

默认行为：

1. 从 `v0.3.0` 与当前 `HEAD` 各构建一份完整运行时（临时目录，`npm ci` + `npm run build`，不安装全局包）。
2. 在同一个临时 home 上依次运行：
   - 旧版创建 MemoryRecord / Detail / Compact / ContextCheckpoint / SelfRecord；
   - 当前版读取旧数据、验证公共 MCP/CLI、内部对象默认隐藏，并由当前版新增对象；
   - 旧版回滚读取全部旧数据与当前版新增对象，比较图/事件/文件快照。
3. 写出 `docs/quality/0.3.2-upgrade-rollback.json` 与 `.md`，然后删除临时 home、构建目录和 sidecar 进程。

边界：

- 只验证单一 home 的顺序升级/回滚；**不承诺混版并发或双向兼容**。
- 不使用 fake capability、fake 图、宿主或模型；真实/fake/未覆盖范围以生成报告为准。
- 不接触真实用户 home，不 push，不开 PR。

常用参数：

```bash
node tests/acceptance/upgrade-rollback/run-upgrade-rollback.mjs --keep
node tests/acceptance/upgrade-rollback/run-upgrade-rollback.mjs \
  --old-ref v0.3.0 --new-ref HEAD \
  --json-out /tmp/upgrade-rollback.json --report-out /tmp/upgrade-rollback.md
```
