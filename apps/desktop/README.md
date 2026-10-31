# Mebular 桌面 App（apps/desktop）

> v0.3.0：**壳 + 守护托管 + 内嵌控制台 + 发布 tarball 运行时 + 三平台 unsigned 安装包**。
> 安装包 runtime 来自与 npm 发布同一批 verify tarball；签名、公证与自动更新留到后续版本。
> 发布操作见 [`docs/operations/DESKTOP_RELEASE.md`](../../docs/operations/DESKTOP_RELEASE.md)。

## 这是什么

Electron 薄壳：把**既有控制台**（`127.0.0.1:<port>/console`）装进一个原生窗口，并负责**守护托管**
（服务优先 / 子进程兜底）。App 不复制任何内核逻辑，只做编排（与 H-1「常驻运行 / 连接 AI 助手」同源端点）。

## 结构

```
apps/desktop/
├── package.json            # private + 0.3.0（与八个 npm 包同版本）
├── electron-builder.yml    # 安装包配置（runtime/node_modules → resources/node_modules）
├── runtime/                # 发布 tarball 安装出的运行时（不入库）
├── src/main/               # Electron 主进程：daemon.mjs（托管逻辑，纯可测）/ index.mjs（壳）/ ipc.mjs / tray-icons.mjs
├── src/preload/index.cjs   # contextBridge 白名单（contextIsolation + sandbox）
├── scripts/                # prepare-runtime / prepare-build / dev / smoke / smoke-runtime
└── resources/              # 图标/许可证
```

## 一键开发

```bash
# 前置：仓库根已 npm ci && npm run build（prepare-build 会在缺失时自动补齐）
cd apps/desktop && npm install
npm run dev                       # 准备构建产物 → 启动 Electron
npm run dev -- --home ~/.mebular --port 7331   # 透传参数（可选）
npm run smoke                     # 无 GUI 有界冒烟（CI 用）
```

## 安装包（v0.2.4，unsigned）

安装包里的 Mebular 运行时**不来自仓库源码目录**，而是先用 `npm pack` 产出五个发布
tarball，再由 `prepare-runtime` 一次性 `npm install --omit=dev --ignore-scripts` 到
`apps/desktop/runtime`，最后经 `extraResources` 复制成 `<resources>/node_modules`。
安装包自带 Electron，用户机器不需要安装 Node.js。

```bash
# 仓库根：build + 五个 lockstep tarball（core/fleet/service/mcp/skill）
npm run build
rm -rf release-pack && mkdir -p release-pack
npm pack --pack-destination release-pack
for p in packages/fleet packages/service packages/mcp packages/skill; do
  (cd "$p" && npm pack --pack-destination ../../release-pack)
done

# apps/desktop：安装 runtime → 冒烟 → 本机目录包
npm --prefix apps/desktop run prepare:runtime   # 默认读 <repo>/release-pack
npm --prefix apps/desktop run smoke:runtime     # 从 runtime 起 serve，校验 /healthz 与 embed 安全头
npm --prefix apps/desktop run dist:dir          # runtime → prepare-build → electron-builder --dir

# 三平台 target（本机只构建当前平台；正式三平台由 CI matrix 构建）
npm --prefix apps/desktop run dist:mac          # DMG（universal）
npm --prefix apps/desktop run dist:win          # NSIS（x64）
npm --prefix apps/desktop run dist:linux        # AppImage + deb（x64）
```

发布资产名：

- `Mebular-<version>-universal.dmg`
- `Mebular-Setup-<version>.exe`
- `Mebular-<version>-x86_64.AppImage`
- `Mebular-<version>-amd64.deb`

`runtime/`、`release-pack/`、`dist/` 都是本地产物，已加入 `.gitignore`，不提交。
打包后的冒烟可直接指向 `<resources>`：

```bash
node apps/desktop/scripts/smoke-runtime.mjs --runtime apps/desktop/dist/mac-arm64/Mebular.app/Contents/Resources
node apps/desktop/scripts/smoke-runtime.mjs --runtime apps/desktop/dist/win-unpacked/resources
node apps/desktop/scripts/smoke-runtime.mjs --runtime apps/desktop/dist/linux-unpacked/resources
```

> v0.2.4 产物**未签名、未公证**：macOS Gatekeeper 要求右键 → 打开（或系统设置 → 隐私与
> 安全性 → 仍要打开），Windows SmartScreen 要求「更多信息 → 仍要运行」。发布前先用
> Release 的 `SHA256SUMS.txt` 校验。签名、公证与自动更新留到后续版本；完整说明见
> [`docs/operations/DESKTOP_RELEASE.md`](../../docs/operations/DESKTOP_RELEASE.md)。

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

`apps/desktop` **不并入根 workspaces**（独立 `package-lock.json`），因此根 job 不会安装
Electron。

- **CI（`.github/workflows/ci.yml` 的 `desktop` job，ubuntu-latest）**：`npm ci` → 根
  `npm run build` → `npm ci --prefix apps/desktop` → pack 5 个 tarball →
  `prepare-runtime` → `smoke:runtime` → `dist:dir` → packaged runtime smoke →
  `npm run smoke`（无 GUI；`ELECTRON_SKIP_BINARY_DOWNLOAD=1` 时自动 SKIP 二进制冒烟）。
- **Publish（`.github/workflows/publish.yml`）**：`verify` 只 pack 一次 8 个 tarball，三个
  desktop job 分别用同一批 tarball 构建安装包（其中 6 个运行时包进入桌面 runtime）：
  - `desktop-macos`（macos-latest）：Universal DMG + packaged smoke；
  - `desktop-windows`（windows-latest）：NSIS x64 + `win-unpacked` resources smoke；
  - `desktop-linux`（ubuntu-latest）：AppImage + deb x64 + `linux-unpacked` resources smoke。
  三个 job 全部成功后才允许 `publish` 发 npm；`release` job 再上传安装包与
  `SHA256SUMS.txt`。手动 `workflow_dispatch` 是 dry-run：只构建并上传 artifacts，不发布。

版本 SSOT：`apps/desktop/package.json`、`package-lock.json` 根 version 与
`src/main/daemon.mjs` 的 `APP_VERSION` 必须与八个 npm 包（含 `opencode-plugin` 与
`dsh-plugin`）一致；`prepare-runtime.mjs` 校验 runtime 使用的六个包，Publish verify
校验八个包与桌面版本。
