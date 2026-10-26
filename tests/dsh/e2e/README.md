# DSH 真实 E2E（Phase 1）

一条命令跑完“真 daemon + 真 DSH + 真浏览器 + 真工具调用”的本地 happy path：

```bash
npm run verify:dsh:e2e
# 指定 DSH 版本
node scripts/verify-dsh-e2e.mjs --dsh-version 0.2.1-rc.2
# 保留临时目录与 artifacts（成功时也保留）
node scripts/verify-dsh-e2e.mjs --keep
```

## 前置

- 已安装依赖并构建：`npm ci`（`prepare` 会执行 `npm run build`），或手动 `npm run build`。
- 系统有 Chrome/Chromium；也可用 `CHROME_PATH` 指定。已缓存的
  Playwright/Chrome for Testing 二进制会被自动发现。
- `pnpm` 在 PATH 上（`dsh plugin add` 会把参数转发给 pnpm）。
- 不需要 DeepSeek API key；本阶段不启动真实 Agent 对话。

## 覆盖范围

1. 临时 `MEBULAR_HOME`：真实身份、一个默认忆云、一个 namespace、一条带随机关联 token 的记忆。
2. 随机端口启动真实 `mebular serve`，等待 `SERVE_READY` 与 `/healthz`。
3. `npm pack` 出 `@mebular/dsh-plugin` 和仅测试用的 probe 插件。
4. 把 `@deepseek-ai/dsh` 装进临时 prefix，用它的 `dsh plugin` 安装两个 tarball。
5. `dsh --profile web --dump-config`：只有一条 `mebular` host row，没有静态 MCP row。
6. 启动 DSH Web，headless Chrome/CDP 断言：Mebular 侧边栏、`connected` 状态、
   iframe 指向 `http://127.0.0.1:<daemon-port>/console/?embed=dsh`、iframe 内
   `documentElement.dataset.embed === "dsh"`。
7. probe 插件通过 DSH 自身 `ctx.tools.schemas()` 断言关键工具存在（不硬编码工具总数），
   再通过 `ctx.tools.execute()` 调用 `mcp__mebular__memory_query`，断言返回本次临时 home 的
   记忆 token 与 memory id。

不在本阶段：daemon down/recovery、`panel:false`、自定义端口矩阵、卸载隔离、CI workflow、
managed 生命周期、真实模型调用。这些属于后续 Phase。

## 失败时

- 临时目录默认保留，并打印路径。
- artifacts 包含：`seed.json`、`runtime.json`、`profiles.json`、`dsh-log.txt`、
  `daemon-log.txt`、`dsh-dump-config.yml`、`healthz.json`、`embed-info.json`、
  `probe.json`、`browser-errors.json`、`browser-dom.html`、`screenshot.png`（能采集时）。
- 成功时默认删除临时目录；`--keep` 可保留。

## 边界

- probe 插件只存在于 `tests/dsh/e2e/fixtures/probe-plugin`，不会进入
  `@mebular/dsh-plugin` 的 npm 包。
- 不读写真实的 `~/.mebular` / `~/.dsh`；所有 home、端口、安装目录都在本轮临时根目录下。
- 不引入 Playwright 依赖；直接使用 Chrome/CDP。
