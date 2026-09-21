# Mebular 控制台（本机 GUI）

由守护（`mebular serve`）直接托管的**本机只读/可写控制台**：星图 · 域视图 · 审计 · 上车向导 · 设置。

- 打开：`mebular serve` → `http://127.0.0.1:7331/console`（`mebular console` 打印 URL）。
- 演示数据：`node packages/console/scripts/seed-demo.mjs --home /tmp/mebular-demo`，再按提示启动 serve。
- 只读/写：默认可写（写需 `memory.admin` scope + CSRF，仅 `POST/PUT/PATCH`，`Origin` 同源）；`MEBULAR_CONSOLE_WRITES=0` 只读。
- 非回环：必须 `auth≠none` + TLS（`mcp.http.tlsKey/tlsCert`），否则 serve 拒绝启动；保存时组合校验会拒绝非法组合。
- 邀请新设备：令牌里的 endpoint 由 `joinService.bind` 推导（通配取本机 LAN IPv4），面板可临时覆盖；无 LAN 地址会回环并告警。
- auth 自锁恢复：`bearer` 可在页面粘贴 `mebular token grant --scope memory.read,memory.admin` 的 token 自救；`oauth` 需 env secret，否则只能改回 `config.json` 的 `mcp.http.auth=none` 再重启。
- 设置页：常用（任务卡）/ 高级（默认收起）/ 诊断（恢复指引）；只读信息在「关于本机」（顶栏徽章）。
- 运行手册：[`../../packages/fleet/RUNBOOK.md`](../../packages/fleet/RUNBOOK.md) §6；限制见 [`../../LIMITATIONS.md`](../../LIMITATIONS.md)。

## 设计文档

- [`page-map.md`](./page-map.md) —— 页面地图：哪个设置在哪个 Tab（常用/高级/诊断）与「关于本机」。
- [`interaction-draft.md`](./interaction-draft.md) —— 交互草稿（视图/动作/状态）。
- [`e2-manual-acceptance.md`](./e2-manual-acceptance.md) —— 人工验收手册（E2）。
