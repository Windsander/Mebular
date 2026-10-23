# Mebular 桌面 App（apps/desktop）

> R1：**壳 + 守护托管 + 内嵌控制台 + 发布 tarball 运行时打包**。签名/公证/自动更新未启用（R2/R6）。
> 方案来源：`plan/electron-app-architecture-v0.1.md`。

## 这是什么

Electron 薄壳：把**既有控制台**（`127.0.0.1:<port>/console`）装进一个原生窗口，并负责**守护托管**
（服务优先 / 子进程兜底）。App 不复制任何内核逻辑，只做编排（与 H-1「常驻运行 / 连接 AI 助手」同源端点）。

## 结构

```
apps/desktop/
├── package.json            # private + 0.1.0（与 npm 五个 lockstep 包同版本）
├── electron-builder.yml    # 安装包配置（runtime/node_modules → resources/node_modules）
├── runtime/                # 发布 tarball 安装出的运行时（不入库）
├── src/main/               # Electron 主进程：daemon.mjs（托管逻辑，纯可测）/ index.mjs（壳）/ ipc.mjs / tray-icons.mjs
├── src/preload/index.cjs   # contextBridge 白名单（contextIsolation + sandbox）
├── scripts/                # prepare-runtime / prepare-build / dev / smoke / smoke-runtime
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

## 安装包（R1）

安装包里的 Mebular 运行时**不来自仓库源码目录**，而是先用 `npm pack` 产出五个发布
tarball，再由 `prepare-runtime` 一次性 `npm install --omit=dev --ignore-scripts` 到
`apps/desktop/runtime`，最后经 `extraResources` 复制成 `<resources>/node_modules`。

```bash
# 仓库根：build + 五个 lockstep tarball（core/fleet/service/mcp/skill）
npm run build
mkdir -p release-pack
npm pack --pack-destination release-pack
for p in packages/fleet packages/service packages/mcp packages/skill; do
  (cd "$p" && npm pack --pack-destination ../../release-pack)
done

# apps/desktop：安装 runtime → 冒烟 → 本机目录包
npm run smoke:runtime             # 从 runtime 起 serve，校验 /healthz 与 embed 安全头
npm run dist:dir                  # runtime → prepare-build → electron-builder --dir

# 三平台 target（签名/公证等由 CI/R2 接管；本机只构建当前平台）
npm run dist:mac                  # DMG（universal）
npm run dist:win                  # NSIS（x64）
npm run dist:linux                # AppImage + deb（x64）
```

`runtime/`、`release-pack/`、`dist/` 都是本地产物，已加入 `.gitignore`，不提交。
打包后的冒烟可直接指向 `<resources>`：

```bash
node scripts/smoke-runtime.mjs --runtime dist/mac-arm64/Mebular.app/Contents/Resources
```

> 当前产物未签名/未公证；macOS Gatekeeper 与 Windows SmartScreen 会提示。发布签名、
> 三平台 CI、自动更新在 R2/R6 处理。

## 守护托管（两条路径，默认优先服务）

1. **服务托管可用**（`@mebular/service` 已登记 `mebular-serve`）→ 调 `restartService`；未装时可先用
   CLI/GUI 的「常驻运行」安装（等价 `mebular service install` 语义）。
2. **兜底**：子进程 `spawn(<electron-node>, <cliBin> serve)`，显式传
   `MEBULAR_HOME`（禁止 cwd）。`cliBin` 在打包态优先
   `<resources>/node_modules/@mebular/core/packages/mcp/bin/mebular.mjs`，开发态回退仓库
   `packages/mcp/bin/mebular.mjs`。**退出策略**：App 退出即停**自己托管**的子进程；服务托管不动。
3. 已有实例在跑（lock + `/healthz` 200 **且 instance 匹配**）→ **直接复用**，不重复启动；端口被非 Mebular 程序占用时给人话处置。

## 忆云切换（E2-B）

App 的 `home` 是**可变运行时状态**（默认取注册表 current）；`httpConf()` 每次都从当前 home 的
`config.json` 读端口。child / 服务两条启动路径都显式带 `MEBULAR_CLOUD_ROOT=<root>`，服务描述符
另带 `ELECTRON_RUN_AS_NODE=1`（打包态用 Electron 的 Node 运行时跑 CLI）。

- **IPC / preload**：`cloud:list` / `cloud:switch` / `cloud:manage`；控制台 A2 通过
  `window.mebularDesktop.cloudSwitch(id)` 触发。不提供删除忆云的 IPC。
- **切换状态机**：停旧守护 → 等旧 `lock` 消失 → 写注册表 current → 起新守护 →
  `/healthz`（`instance=homeKey`）校验 → 重载控制台；失败回滚旧守护。
  切换不复制、不合并、不删除任何忆云目录；原忆云归档保留，随时可切回。
- **崩溃恢复**：`switch.intent.json` 在启动时恢复——目标健康 = 成功；否则回旧；
  两者都不健康只显示诊断，保留 intent 与全部档案。
- **单活**：`<root>/active.lock` 被活 PID 占用且 home 不同 → `CLOUD_ALREADY_ACTIVE`。
- **身份校验**：端口 200 但 `instance` 不匹配 = 端口被另一张忆云占用，不能 `reused`、
  不能继续切换；文案「端口 X 上是另一张忆云，请先停止它」。
- **服务迁移**：旧单 home 服务单元迁到 OS home 归属，保留旧 manifest 的 `autostart`
  （`--no-autostart` 不会被切档改成自启动）。
- **托盘**：「管理忆云…」→ `?view=settings&focus=clouds`（MVP 不做二级菜单）。

详见 `CLOUD-SWITCH.md`。

## 安全

`contextIsolation: true` · `nodeIntegration: false` · `sandbox: true` · 只加载 `127.0.0.1`；
IPC **白名单**（`daemon:status|start|stop|restart`、`console:open`、`logs:open`、`app:diagnostics`）；
不采集遥测、不外联。

## CI

`apps/desktop` **不并入根 workspaces**（独立 `package-lock.json`）→ 现有四 job 不会安装 Electron，
零影响。新增独立 `desktop` job 跑 `npm run smoke`（无 GUI；`ELECTRON_SKIP_BINARY_DOWNLOAD=1` 时自动 SKIP 二进制冒烟）。
R2 会在桌面 job 里补 `prepare-runtime` + `smoke:runtime` + `dist:dir` / 三平台安装包。
