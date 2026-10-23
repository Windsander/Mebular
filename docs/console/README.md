# Mebular 控制台（本机 GUI）

由守护（`mebular serve`）直接托管的**本机只读/可写控制台**：星图 · 域视图 · 审计 · 上车向导 · 设置。

- 打开：`mebular serve` → `http://127.0.0.1:7331/console`（`mebular console` 打印 URL）。
- 演示数据：`node packages/console/scripts/seed-demo.mjs --home /tmp/mebular-demo`，再按提示启动 serve。
- 只读/写：默认可写（写需 `memory.admin` scope + CSRF，仅 `POST/PUT/PATCH`，`Origin` 同源）；`MEBULAR_CONSOLE_WRITES=0` 只读。
- 非回环：必须 `auth≠none` + TLS（`mcp.http.tlsKey/tlsCert`），否则 serve 拒绝启动；保存时组合校验会拒绝非法组合。
- 邀请设备：令牌里的 endpoint 由 `joinService.bind` 推导（通配取本机 LAN IPv4），面板可临时覆盖；无 LAN 地址会回环并告警。
- auth 自锁恢复：`bearer` 可在页面粘贴 `mebular token grant --scope memory.read,memory.admin` 的 token 自救；`oauth` 需 env secret，否则只能改回 `config.json` 的 `mcp.http.auth=none` 再重启。
- 忆云：顶栏徽章显示当前忆云（名字只取 `overview.cloud.name`，旧守护缺失时隐藏）；「加入忆云」粘贴一次性令牌，加入后由桌面 App 切换（Web-only 显示 `mebular cloud use <id>`）；设置 · 常用「忆云」卡可切换/改名，当前不可切换，已归档切换需确认，**不提供删除**。
- 设置页：常用（常驻状态 + 忆云卡 + 邀请/重启入口）/ 安全 / AI 助手 / MCP 接入 / 高级（含诊断与恢复）；只读信息在「关于本机」（顶栏徽章）。
- 运行手册：[`../../packages/fleet/RUNBOOK.md`](../../packages/fleet/RUNBOOK.md) §6；限制见 [`../limitations/LIMITATIONS.md`](../limitations/LIMITATIONS.md)。

## 设计文档

- [`page-map.md`](./page-map.md) —— 页面地图：哪个设置在哪个 Tab（常用/高级/诊断）与「关于本机」。
- [`interaction-draft.md`](./interaction-draft.md) —— 交互草稿（视图/动作/状态）。
- [`e2-manual-acceptance.md`](./e2-manual-acceptance.md) —— 人工验收手册（E2）。
- [`i18n-finalize-acceptance.md`](./i18n-finalize-acceptance.md) —— v0.1.0 双语发布门禁验收
  （静态/测试、三档布局、真实 Electron 隔离验证、已知缺口）。
