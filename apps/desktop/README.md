# Mebular 桌面 App（apps/desktop）

> M1：**壳 + 守护托管 + 内嵌控制台**。不做签名/公证/自动更新/安装包分发（M3/M4）。
> 方案来源：`plan/electron-app-architecture-v0.1.md`。

## 这是什么

Electron 薄壳：把**既有控制台**（`127.0.0.1:<port>/console`）装进一个原生窗口，并负责**守护托管**
（服务优先 / 子进程兜底）。App 不复制任何内核逻辑，只做编排（与 H-1「常驻运行 / 连接 AI 助手」同源端点）。

## 结构

```
apps/desktop/
├── package.json            # private + 0.1.0（与 npm 六包 lockstep）
├── electron-builder.yml    # M1 stub（无签名/公证/更新）
├── src/main/               # Electron 主进程：daemon.mjs（托管逻辑，纯可测）/ index.mjs（壳）/ ipc.mjs / tray-icons.mjs
├── src/preload/index.cjs   # contextBridge 白名单（contextIsolation + sandbox）
├── scripts/                # prepare-build（复用仓库产物）/ dev（一键启动）/ smoke（无 GUI 有界冒烟）
└── resources/              # 图标/许可证（占位）
```

## 一键开发

```bash
# 前置：仓库根已 npm ci && npm run build（prepare-build 会在缺失时自动补齐）
cd apps/desktop && npm install
npm run dev                       # 准备构建产物 → 启动 Electron
npm run dev -- --home ~/.mebular --port 7331   # 透传参数（可选）
npm run smoke                     # 无 GUI 有界冒烟（CI 用）
```

## 守护托管（两条路径，默认优先服务）

1. **服务托管可用**（`@mebular/service` 已登记 `mebular-serve`）→ 调 `restartService`；未装时可先用
   CLI/GUI 的「常驻运行」安装（等价 `mebular service install` 语义）。
2. **兜底**：子进程 `spawn(<electron-node>, <repo>/packages/mcp/bin/mebular.mjs serve)`，显式传
   `MEBULAR_HOME`（禁止 cwd）。**M1 退出策略**：App 退出即停**自己托管**的子进程；服务托管不动。
3. 已有实例在跑（lock + `/healthz` 200）→ **直接复用**，不重复启动；端口被非 Mebular 程序占用时给人话处置。

## 安全

`contextIsolation: true` · `nodeIntegration: false` · `sandbox: true` · 只加载 `127.0.0.1`；
IPC **白名单**（`daemon:status|start|stop|restart`、`console:open`、`logs:open`、`app:diagnostics`）；
不采集遥测、不外联。

## CI

`apps/desktop` **不并入根 workspaces**（独立 `package-lock.json`）→ 现有四 job 不会安装 Electron，
零影响。新增独立 `desktop` job 跑 `npm run smoke`（无 GUI；`ELECTRON_SKIP_BINARY_DOWNLOAD=1` 时自动 SKIP 二进制冒烟）。
