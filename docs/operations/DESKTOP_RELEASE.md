# 桌面安装包发布

面向 Mebular v0.2.4 的桌面安装包构建、验收与后续签名计划。发布流程总览见
[`RELEASE.md`](RELEASE.md)。

## 0. v0.2.4 范围

| 平台 | 目标 | 架构 | 产物 |
| --- | --- | --- | --- |
| macOS | DMG | Universal（arm64 + x64） | `Mebular-0.2.4-universal.dmg` |
| Windows | NSIS | x64 | `Mebular-Setup-0.2.4.exe` |
| Linux | AppImage | x64 | `Mebular-0.2.4-x86_64.AppImage` |
| Linux | deb | x64 | `Mebular-0.2.4-amd64.deb` |

- 默认仍为 **unsigned** 发布；正式 release 可通过仓库变量 `SIGN_DESKTOP_RELEASE=true`
  切换到签名/公证构建（见 [`SIGNING.md`](SIGNING.md)）。
- 每个安装包都自带 Electron 和一份完整的 Mebular runtime，**不需要本机 Node.js**，也不依赖
  仓库源码目录。
- GitHub Release 同时提供 `SHA256SUMS.txt`，覆盖上面 4 个安装包。
- 签名、公证、Windows Authenticode 的工程接入已完成，证书与 secrets 到位即可启用；
  自动更新仍留到后续版本（见第 6 节）。

## 1. runtime 架构

安装包里的业务代码不是从仓库 `packages/*` 复制的，而是从**发布的 npm tarball** 安装出来的：

```text
release tarballs（verify 产出，6 个）
  mebular-core-<version>.tgz
  mebular-fleet-<version>.tgz
  mebular-service-<version>.tgz
  mebular-mcp-<version>.tgz
  mebular-skill-<version>.tgz
  mebular-dsh-plugin-<version>.tgz   # 只用于 npm，不进入桌面 runtime
        │
        ▼
prepare-runtime.mjs
  npm install --omit=dev --ignore-scripts --no-save --no-package-lock
        │
        ▼
apps/desktop/runtime/node_modules/
  @mebular/core
  @mebular/fleet
  @mebular/service
  @mebular/mcp
  @mebular/skill
  + 第三方生产依赖
        │
        ▼  electron-builder extraResources
<app>/Contents/Resources/node_modules   （macOS）
<app>/resources/node_modules            （Windows / Linux）
```

关键点：

- `apps/desktop` 在 Electron 的 `app.asar` 里只放壳代码（`src/**`、`resources/**`、
  `package.json`）；`electron-builder.yml` 用 `!**/node_modules/**` 阻止把仓库根依赖塞进
  asar，再用 `extraResources` 把 `runtime/node_modules` 复制成 `<resources>/node_modules`。
- 桌面主进程在打包态优先使用
  `<resources>/node_modules/@mebular/core/packages/mcp/bin/mebular.mjs`，开发态才回退到仓库
  `packages/mcp/bin/mebular.mjs`。
- `@mebular/core` 的 tarball 内含 `packages/mcp`、`packages/console`、`packages/fleet`、
  `packages/service` 和 `locales/`，因此打包态不需要再复制这些仓库目录。
- `prepare-runtime.mjs` 会校验 5 个包版本都等于根 `package.json`，并断言 CLI、Console、
  locales、Skill 等关键文件存在；任一缺失直接失败，不会产出「看似成功但跑不起来」的包。
- `--ignore-scripts` 避免执行发布包的安装钩子；第三方生产依赖仍从 npm registry 解析。
- 因此安装包与 npm 发布消费的是**同一批 verify tarball**，但仍需要网络安装第三方依赖；
  它不承诺离线可重复构建。

## 2. 本地打包

### 2.1 前置

```bash
npm ci
npm ci --prefix apps/desktop
npm run build
```

`apps/desktop` 有独立 `package-lock.json`，不并入根 workspaces。Electron 与
electron-builder 只在 `apps/desktop` 安装。

### 2.2 生成发布 tarball

在仓库根执行：

```bash
rm -rf release-pack
mkdir -p release-pack
ROOT="$PWD"
npm pack --pack-destination "$ROOT/release-pack"
for p in packages/fleet packages/service packages/mcp packages/skill packages/dsh-plugin; do
  (cd "$p" && npm pack --pack-destination "$ROOT/release-pack")
done
ls -lh release-pack
```

应得到 6 个 `.tgz`。`prepare-runtime` 只使用前 5 个；DSH 插件 tarball 供 npm 发布。

### 2.3 安装 runtime

```bash
# 默认从 release-pack 安装到 apps/desktop/runtime
node apps/desktop/scripts/prepare-runtime.mjs --tarballs release-pack

# 或显式指定输入 / 输出
node apps/desktop/scripts/prepare-runtime.mjs \
  --tarballs release-pack \
  --out apps/desktop/runtime
```

脚本会先确认 5 个 tarball 都在，再清空输出目录；失败时保留上一份产物便于排查。它会检查：

- 根 `package.json`、`apps/desktop/package.json`、`daemon.mjs` 的 `APP_VERSION` 三者一致；
- 5 个 `@mebular/*` 安装版本一致；
- `@mebular/core` 内含 MCP CLI、Console、`locales/manifest.json`；
- `@mebular/service`、`@mebular/fleet` 的构建产物存在；
- `@mebular/skill/SKILL.md` 存在。

### 2.4 runtime 冒烟

```bash
npm --prefix apps/desktop run smoke:runtime

# 也可直接指向打包后的 resources
node apps/desktop/scripts/smoke-runtime.mjs \
  --runtime apps/desktop/dist/mac-arm64/Mebular.app/Contents/Resources
```

冒烟会从 runtime 启动 `mebular serve`（临时 home、系统分配端口），断言：

- `/healthz` 返回 ok；
- `/app/embed/info` 的 `loopback=true`、`embedProtocol=1`、`embedUrl` 含 `?embed=dsh`；
- `/console/?embed=dsh` 允许 loopback iframe，且没有 `X-Frame-Options: DENY`；
- 普通 `/console/` 仍保持 `X-Frame-Options: DENY`。

### 2.5 构建安装包

```bash
npm --prefix apps/desktop run dist:dir     # 当前平台，解包目录，用于本地验收
npm --prefix apps/desktop run dist:mac     # macOS Universal DMG（unsigned）
npm --prefix apps/desktop run dist:win     # Windows NSIS x64（unsigned）
npm --prefix apps/desktop run dist:linux   # Linux AppImage + deb x64

# 签名发布（需要证书与公证凭据；见 SIGNING.md）
npm --prefix apps/desktop run dist:mac:signed
npm --prefix apps/desktop run dist:win:signed
node apps/desktop/scripts/verify-signature.mjs --platform mac
node apps/desktop/scripts/verify-signature.mjs --platform win
```

每个 `dist:*` 都会重新执行 `prepare-runtime` 和 `prepare-build`，再调用 electron-builder。
`prepare-build` 在仓库构建产物缺失时会自动补 `npm run build`。

> 本机只能可靠构建当前平台：macOS Universal 在 macOS 上构建，Windows NSIS 在 Windows 上
> 构建，Linux AppImage/deb 在 Linux 上构建。三平台由 CI matrix 分别构建，不要尝试在一个
> runner 上交叉产出全部格式。

`apps/desktop/runtime/`、`apps/desktop/dist/`、仓库根 `release-pack/` 都是本地产物，已
加入 `.gitignore`，不提交。

## 3. 资产名与内容

electron-builder 的 `artifactName` 固定为：

| 平台 | 配置 | 最终文件名 |
| --- | --- | --- |
| macOS | `Mebular-${version}-${arch}.${ext}` + `--universal` | `Mebular-0.2.4-universal.dmg` |
| Windows | `Mebular-Setup-${version}.${ext}` | `Mebular-Setup-0.2.4.exe` |
| Linux AppImage | `Mebular-${version}-${arch}.${ext}` + x64 | `Mebular-0.2.4-x86_64.AppImage` |
| Linux deb | 同上；deb 的 arch 宏为 `amd64` | `Mebular-0.2.4-amd64.deb` |

`SHA256SUMS.txt` 由 release job 在 Linux 上生成，只包含安装包，按文件名 `LC_ALL=C sort`
排序，例如：

```text
<hash>  Mebular-0.2.4-amd64.deb
<hash>  Mebular-0.2.4-universal.dmg
<hash>  Mebular-0.2.4-x86_64.AppImage
<hash>  Mebular-Setup-0.2.4.exe
```

dry-run 不会生成这个文件；它只在正式 `release` job 创建 GitHub Release 时产生。

## 4. unsigned 安装体验（默认）

默认产物没有 Apple Developer ID、公证或 Windows 代码签名证书。用户会看到系统安全提示，
这是预期行为，不是安装包损坏。启用签名（`SIGN_DESKTOP_RELEASE=true`）后，下面的绕过步骤
不再需要；签名与公证的接入见 [`SIGNING.md`](SIGNING.md)。

### 4.1 先校验

```bash
# macOS
shasum -a 256 -c SHA256SUMS.txt

# Linux
sha256sum -c SHA256SUMS.txt
```

Windows 可用 PowerShell 的 `Get-FileHash -Algorithm SHA256` 对照 `SHA256SUMS.txt`。
校验失败时不要继续安装，重新下载。

### 4.2 macOS Gatekeeper

1. 打开 DMG，把 Mebular 拖到「应用程序」。
2. 首次启动时**右键点 App → 打开**，在弹窗中再次确认「打开」；
   或先双击（系统拦截），再到「系统设置 → 隐私与安全性」点「仍要打开」。
3. 不要用 `spctl --master-disable` 全局关闭 Gatekeeper；也不要把
   `xattr -dr com.apple.quarantine` 当作常规安装步骤。

### 4.3 Windows SmartScreen

1. 运行 `Mebular-Setup-0.2.4.exe`。
2. 出现「Windows 已保护你的电脑」时点「更多信息」，再点「仍要运行」。

### 4.4 Linux

```bash
chmod +x Mebular-0.2.4-x86_64.AppImage
./Mebular-0.2.4-x86_64.AppImage

# Debian / Ubuntu
sudo apt install ./Mebular-0.2.4-amd64.deb
```

AppImage 需要 FUSE；没有 FUSE 时可使用 `--appimage-extract-and-run`。deb 安装后从应用菜单
启动 Mebular。

## 5. CI：dry-run 与正式 release

| 项目 | `workflow_dispatch` dry-run | push `release/v*` 正式发布 |
| --- | --- | --- |
| verify（6 tarballs） | ✅ | ✅ |
| preflight（npm whoami） | ❌ | ✅ |
| desktop matrix（三平台） | ✅ | ✅ |
| 签名 / 公证（可选） | 勾选 `sign` 时 ✅ | 仓库变量 `SIGN_DESKTOP_RELEASE=true` 时 ✅ |
| npm publish（5 + 1） | ❌ | ✅ |
| npm visibility gate（6 包 + latest） | ❌ | ✅ |
| GitHub Release + 资产 | ❌ | ✅ |
| `SHA256SUMS.txt` | ❌（仅 artifacts） | ✅ |
| 版本来源 | prep 分支根 `package.json` | 分支名 `release/vX.Y.Z` |

dry-run 的 artifacts：

- `release-tarballs`：6 个 `.tgz`，保留 7 天；
- `desktop-macos`：DMG；
- `desktop-windows`：NSIS `.exe`；
- `desktop-linux`：AppImage + deb。

正式流水线中，`publish` / `publish-dsh` 依赖三个 desktop job 全部成功，因此**安装包没全绿
就不会发 npm**。`visibility` job 再确认六包均可 `npm view` 且 `dist-tags.latest` 指向本次
版本；只有它通过后，`release` job 才下载三平台 artifacts，校验每种扩展名恰好 1 个，生成
`SHA256SUMS.txt`，创建/更新 GitHub Release 并 `--clobber` 上传。

本地或 CI 都可以对解包目录跑 packaged runtime smoke：

```bash
# macOS
node apps/desktop/scripts/smoke-runtime.mjs \
  --runtime "$(find apps/desktop/dist -type d -path '*Mebular.app/Contents/Resources' -print -quit)"

# Windows
node apps/desktop/scripts/smoke-runtime.mjs --runtime apps/desktop/dist/win-unpacked/resources

# Linux
node apps/desktop/scripts/smoke-runtime.mjs --runtime apps/desktop/dist/linux-unpacked/resources
```

## 6. 签名、公证与自动更新

签名通道已接好，证书申请、GitHub secrets、签名后校验与包管理器上架见
[`SIGNING.md`](SIGNING.md)。

- **默认 unsigned**：`electron-builder.yml` 的 `identity: null` 保持不变，本地 `dist:*` 不会
  因为钥匙串里有证书而意外签名。
- **签名构建**：`dist:mac:signed` / `dist:win:signed` 使用
  `electron-builder.signed.cjs`，开启 `forceCodeSigning`，并在构建后跑
  `verify-signature.mjs`；证书/公证失败即 job 失败。
- **macOS**：Developer ID Application + hardened runtime + entitlements + `notarytool`，
  公证后 staple；CI 用 `verify-signature.mjs` 校验 `codesign` / `spctl` / `stapler`。
- **Windows**：Azure Artifact Signing（`azureSignOptions`）或自定义
  `MEBULAR_WIN_SIGN_HOOK`；CI 用 `Get-AuthenticodeSignature` 校验。
- **自动更新**：仍是后续独立设计（更新源、签名校验、回滚、灰度），不要和首次签名混在
  同一次发布里。

当前 `electron-builder.yml` 仍设置 `publish: null`，安装包不会自行上传或检查更新；发布资产
完全由 `publish.yml` 的 `release` job 管理。

## 7. 常见问题

| 现象 | 处理 |
| --- | --- |
| `缺少 @mebular/core 的发布 tarball` | 先在仓库根 `npm pack` 5 个包到 `release-pack`；确认文件名版本与根 `package.json` 一致。 |
| `找到多个 ... tarball，无法确定使用哪一个` | `release-pack` 混入了旧版本；清空后重新 pack。 |
| `apps/desktop/package.json 版本 ... 不一致` | 桌面版本未随 lockstep 更新；跑 `bump_version.sh` 或手工同步后重试。 |
| `runtime 缺少必需文件` | 根包 `files` 或构建产物不完整；先 `npm run build`，再重新 pack。 |
| `dist:mac` 失败并提示架构 / 证书 | Universal 只能在 macOS 构建；`dist:mac` 是 unsigned，签名请用 `dist:mac:signed` 并配好证书。 |
| `缺少 MEBULAR_MAC_IDENTITY` / 公证凭据 | 按 [`SIGNING.md`](SIGNING.md) 配置 secrets；CI 在构建前会预检并一次列出所有缺失项。 |
| `spctl` 显示 `Unnotarized Developer ID` | 公证失败或未 staple；查 `notarytool log`，不要继续发版。 |
| packaged smoke 找不到 `Resources` | 查看 `apps/desktop/dist/` 实际目录；不同 electron-builder 版本的解包目录名可能不同。 |
| macOS 提示「已损坏，无法打开」 | 这通常是 Gatekeeper 对未签名包的处理；按 4.2 右键打开，并先确认 checksum。不要关闭全局安全策略。 |
| Windows 安装被 SmartScreen 拦截 | 按 4.3「更多信息 → 仍要运行」；企业环境可能另有策略，需管理员放行。 |
| Release 资产 checksum 不匹配 | 重新下载；若仍失败，重跑 release job 并用 `--clobber` 重传资产与 `SHA256SUMS.txt`。 |

## 8. 相关文档

- 发布总流程：[`RELEASE.md`](RELEASE.md)
- 签名与包管理器分发：[`SIGNING.md`](SIGNING.md)
- 桌面开发与守护托管：[`apps/desktop/README.md`](../../apps/desktop/README.md)
- 架构与交付面：[`docs/architecture/ARCHITECT.md`](../architecture/ARCHITECT.md)
- 已知限制：[`docs/limitations/LIMITATIONS.md`](../limitations/LIMITATIONS.md)
