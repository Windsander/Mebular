# 桌面签名与分发

面向 Mebular 桌面 App 的 **macOS / Windows 直装签名**，以及 Homebrew Cask、winget、AUR
的包管理器上架。安装包构建细节见 [`DESKTOP_RELEASE.md`](DESKTOP_RELEASE.md)，总发布流程见
[`RELEASE.md`](RELEASE.md)。

> 范围：Developer ID + 公证、Windows Authenticode、包管理器分发。
> 不在范围：Mac App Store / Microsoft Store 商店版（见第 7 节）、应用自动更新（R6）。

## 0. 当前状态与开关

| 构建 | 命令 | 签名 | 用途 |
| --- | --- | --- | --- |
| 默认 | `dist:mac` / `dist:win` | ❌ unsigned | 本地验收、CI dry-run |
| 签名 | `dist:mac:signed` / `dist:win:signed` | ✅ + 校验 | 正式 release、签名 dry-run |

- 默认配置仍是 `apps/desktop/electron-builder.yml`，`mac.identity: null`，不会因为本机钥匙串
  里有证书就意外签名。
- 签名配置是 `apps/desktop/electron-builder.signed.cjs`，设置 `forceCodeSigning: true`，
  并在构建后用 `verify-signature.mjs` 校验：证书缺失、签名失败、公证失败都会让 job 失败，
  不会上传或发布 unsigned 包。
- CI 中签名是显式开关：
  - push 到 `release/v*`：仓库变量 `SIGN_DESKTOP_RELEASE=true` 时签名；
  - `workflow_dispatch`：勾选 `sign` 时签名（仍是 dry-run，不发布 npm / Release）。
- 签名 job 失败会阻断 `publish` / `release`，所以不会出现“npm 已发、安装包没签上”的状态。

## 1. 成本与前置

| 平台 | 需要 | 费用（2026-10） | 周期 | 不签的后果 |
| --- | --- | --- | --- | --- |
| macOS | Apple Developer Program + Developer ID Application 证书 | US$99/年 | 1–2 天 | Gatekeeper 拦截；Homebrew Cask 拒收 |
| Windows | Authenticode 证书 / 云签名服务 | Azure Artifact Signing US$9.99/月起；CA OV/EV 约 US$200–500/年 | 1–3 周 | SmartScreen 警告；下载转化率下降 |
| Linux | 无代码签名要求 | — | — | AppImage / deb 可直接分发 |

### 1.1 macOS

只需要 **Apple Developer Program**（个人或组织均可），不需要 Mac App Store 上架资格。

- 个人账号：US$99/年，使用法定姓名，开启双重认证。
- 组织账号：需要 D-U-N-S 编号，审核更久。
- 证书类型选 **Developer ID Application**（不是 Apple Development，也不是 Mac App Store）。
- 公证使用 Apple ID + App 专用密码，或更推荐的 App Store Connect API Key。

### 1.2 Windows

Windows 代码签名有两条现实路径。**不要再买“PFX 文件”型证书**：CA/B Forum 从 2023-06 起要求
私钥存放在 HSM，2026-03 起证书有效期上限 460 天；传统 PFX 无法直接用于 CI。

**路径 A：Azure Artifact Signing（原 Trusted Signing）**

- Basic US$9.99/月，含 5,000 次签名；Premium US$99.99/月。
- 个人申请目前仅限**美国 / 加拿大**；组织仅限美国、加拿大、欧盟、英国、澳新、日韩、新加坡、
  瑞士、挪威、以色列等地区。**中国大陆个人不符合个人申请资格**。
- 如果你的主体不在上述地区，走路径 B，或先只签 macOS、Windows 保持 unsigned。

**路径 B：CA OV/EV 证书 + 云 HSM**

- 常见服务：Certum SimplySign、SSL.com eSigner、DigiCert KeyLocker、Sectigo Signing Manager。
- 下单前确认：接受中国大陆个人/主体、支持 CI 云签名、提供可脚本化的签名命令。
- EV 通常能更快建立 SmartScreen 信誉；OV 需要时间积累。证书有效期按 460 天规划续期。
- 仓库已预留 `MEBULAR_WIN_SIGN_HOOK`：用服务商 CLI 写一个签名 hook，electron-builder 会逐文件
  调用它。hook 必须自己完成签名；CI 里的 `verify-signature.mjs` 会兜底校验。

> 如果暂时不签 Windows：保留 `dist:win` 的 unsigned 产物即可，SmartScreen 需要用户点
> 「更多信息 → 仍要运行」。这不影响 macOS 先签。

## 2. 仓库侧已经接好的东西

| 文件 | 作用 |
| --- | --- |
| `apps/desktop/electron-builder.signed.cjs` | 签名专用配置；macOS Developer ID + 公证，Windows Azure 或自定义 hook |
| `apps/desktop/resources/entitlements.mac.plist` | hardened runtime entitlements（JIT / 可执行内存 / 关闭 library validation） |
| `apps/desktop/resources/entitlements.mac.inherit.plist` | Electron Helper / 子进程继承的 entitlements |
| `apps/desktop/scripts/check-signing-env.mjs` | 构建前预检，缺 secret 立即失败 |
| `apps/desktop/scripts/verify-signature.mjs` | 构建后校验 codesign / spctl / stapler / Authenticode |
| `.github/workflows/publish.yml` | secrets 注入、签名开关、签名后校验 |

### 2.1 本地签名构建

macOS（证书已导入钥匙串时可以不设 `CSC_LINK`）：

```bash
export MEBULAR_MAC_IDENTITY='Sobert Li (ABCDE12345)'   # 可带 "Developer ID Application:" 前缀
export CSC_LINK="$HOME/certs/DeveloperID.p12"          # 也可用 base64 字符串
export CSC_KEY_PASSWORD='p12 导出密码'
export APPLE_API_KEY="$HOME/certs/AuthKey_ABC123.p8"
export APPLE_API_KEY_ID='ABC123'
export APPLE_API_ISSUER='00000000-0000-0000-0000-000000000000'

npm --prefix apps/desktop run dist:mac:signed
node apps/desktop/scripts/verify-signature.mjs --platform mac
```

也可以改用 Apple ID 公证：

```bash
export APPLE_ID='you@example.com'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'
export APPLE_TEAM_ID='ABCDE12345'
```

Windows（PowerShell）：

```powershell
$env:MEBULAR_WIN_PUBLISHER = 'Sobert Li'
$env:MEBULAR_WIN_ENDPOINT = 'https://eus.codesigning.azure.net/'
$env:MEBULAR_WIN_CERT_PROFILE = 'mebular-public-trust'
$env:MEBULAR_WIN_SIGN_ACCOUNT = 'mebular-signing'
$env:AZURE_TENANT_ID = '...'
$env:AZURE_CLIENT_ID = '...'
$env:AZURE_CLIENT_SECRET = '...'

npm --prefix apps/desktop run dist:win:signed
node apps/desktop/scripts/verify-signature.mjs --platform win
```

使用 CA 云签名时，把 Azure 变量换成 hook：

```powershell
$env:MEBULAR_WIN_SIGN_HOOK = './scripts/sign-windows.cjs'
```

hook 的接口与 electron-builder 的 `signtoolOptions.sign` 一致：接收
`{ path, ... }`，对该文件执行签名；失败时抛错。hook 路径必须位于仓库工作区内。

## 3. 申请 macOS 证书与公证凭据

1. 注册 Apple Developer Program：<https://developer.apple.com/programs/enroll/>。
2. 打开 Keychain Access → Certificate Assistant → **Request a Certificate from a Certificate
   Authority**，保存 CSR 到磁盘（官方说明：
   <https://developer.apple.com/help/account/certificates/create-developer-id-certificates>）。
3. 登录 <https://developer.apple.com/account> → Certificates, Identifiers & Profiles →
   Certificates → **+** → Software → **Developer ID Application** → 上传 CSR → 下载 `.cer`。
   **如果提示选择 Developer ID Certificate Intermediary，选 G2 Sub-CA**：旧 Sub-CA 于
   2027-02-01 过期，旧证书之后不能再用于签名
   （<https://developer.apple.com/help/account/certificates/replace-developer-id-certificates>）。
4. 双击 `.cer` 导入登录钥匙串，确认私钥存在；在钥匙串中同时导出证书与私钥为 `.p12`，设置密码。
5. 在 <https://developer.apple.com/account> 的 Membership details 记下 **Team ID**。
6. 公证凭据二选一：
   - **App Store Connect API Key（推荐）**：App Store Connect → Users and Access → Integrations →
     App Store Connect API → 生成 Key（Developer 或 App Manager 权限），下载 `.p8`（只给一次），
     记下 **Key ID** 与 **Issuer ID**。创建说明：
     <https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api>
   - **Apple ID + App 专用密码**：<https://appleid.apple.com> → Sign-In and Security →
     App-Specific Passwords → 生成；配合 Apple ID 与 Team ID 使用。

验证证书：

```bash
security find-identity -v -p codesigning | grep 'Developer ID Application'
```

## 4. 配置 Windows 签名

### 4.1 Azure Artifact Signing

官方 Quickstart：<https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart>
产品与定价：<https://azure.microsoft.com/en-us/products/artifact-signing> ·
<https://azure.microsoft.com/en-us/pricing/details/artifact-signing/>

1. 在 Azure 订阅中创建 **Artifact Signing**（原 Trusted Signing）账号，选择区域。
2. 完成 **Identity Validation**（组织或个人），1–20 个工作日。
3. 创建 **Public Trust** Certificate Profile，记下：
   - Account endpoint（如 `https://eus.codesigning.azure.net/`）
   - Code Signing Account name
   - Certificate Profile name
   - 证书 Subject CN（必须与 `WIN_PUBLISHER` 完全一致）
4. 创建 Entra ID App Registration + Client Secret，并在签名账号上授予签名角色
   （Trusted / Artifact Signing Certificate Profile Signer，以门户当前名称为准）。
5. 记下 Tenant ID、Client ID、Client Secret。

electron-builder 26.x 会在 Windows runner 上安装 `TrustedSigning` PowerShell 模块并调用
`Invoke-TrustedSigning`。首次构建会多花 1–2 分钟；模块安装失败时先看 job 日志里的
PowerShell 报错。

### 4.2 CA 云 HSM

常见服务商：

- Certum Code Signing：<https://certum.eu/en/code-signing>
- SSL.com Code Signing：<https://www.ssl.com/certificates/code-signing/>
- DigiCert Code Signing：<https://www.digicert.com/signing/code-signing-certificates>

1. 按服务商文档完成个人/组织验证，拿到证书与云签名 CLI。
2. 在仓库放一个签名 hook（示例路径 `apps/desktop/scripts/sign-windows.cjs`），逐文件调用服务商
   CLI；不要把私钥、访问令牌写进仓库。
3. 在 CI 注入服务商凭据，并设置 `MEBULAR_WIN_SIGN_HOOK`。
4. 用 `verify-signature.mjs --platform win` 确认 `Get-AuthenticodeSignature` 返回 `Valid`。

## 5. GitHub Secrets / Variables

在 GitHub 仓库配置：

- Secrets：<https://github.com/Windsander/Mebular/settings/secrets/actions>
- Variables：<https://github.com/Windsander/Mebular/settings/variables/actions>
- Publish workflow：<https://github.com/Windsander/Mebular/actions/workflows/publish.yml>

### 5.1 macOS

| Secret | 对应环境变量 | 内容 |
| --- | --- | --- |
| `MAC_CSC_LINK` | `CSC_LINK` | Developer ID `.p12` 的 base64，或可访问的文件路径 |
| `MAC_CSC_KEY_PASSWORD` | `CSC_KEY_PASSWORD` | `.p12` 导出密码 |
| `MAC_IDENTITY` | `MEBULAR_MAC_IDENTITY` | 证书 CN，如 `Sobert Li (ABCDE12345)` |
| `APPLE_API_KEY_P8` | 写入临时 `.p8` | App Store Connect API Key 文件内容 |
| `APPLE_API_KEY_ID` | `APPLE_API_KEY_ID` | Key ID |
| `APPLE_API_ISSUER` | `APPLE_API_ISSUER` | Issuer ID |
| `APPLE_ID` | `APPLE_ID` | 可选：Apple ID 公证 |
| `APPLE_APP_SPECIFIC_PASSWORD` | `APPLE_APP_SPECIFIC_PASSWORD` | 可选：App 专用密码 |
| `APPLE_TEAM_ID` | `APPLE_TEAM_ID` | Team ID |

> API Key 与 Apple ID 二选一。两者同时配置时，electron-builder 优先使用 Apple ID；建议只保留
> 一套，避免公证失败时误判。

### 5.2 Windows

| Secret | 对应环境变量 | 内容 |
| --- | --- | --- |
| `WIN_PUBLISHER` | `MEBULAR_WIN_PUBLISHER` | 证书 Subject CN |
| `WIN_ENDPOINT` | `MEBULAR_WIN_ENDPOINT` | Artifact Signing endpoint |
| `WIN_CERT_PROFILE` | `MEBULAR_WIN_CERT_PROFILE` | Certificate Profile name |
| `WIN_SIGN_ACCOUNT` | `MEBULAR_WIN_SIGN_ACCOUNT` | Code Signing Account name |
| `AZURE_TENANT_ID` | `AZURE_TENANT_ID` | Entra tenant |
| `AZURE_CLIENT_ID` | `AZURE_CLIENT_ID` | App registration client ID |
| `AZURE_CLIENT_SECRET` | `AZURE_CLIENT_SECRET` | App registration secret |
| `WIN_SIGN_HOOK` | `MEBULAR_WIN_SIGN_HOOK` | 可选：自定义签名 hook 路径 |

### 5.3 开关

```bash
# 推荐用 gh 一次性写入
base64 -i DeveloperID.p12 | tr -d '\n' | gh secret set MAC_CSC_LINK
gh secret set MAC_CSC_KEY_PASSWORD --body '<p12 导出密码>'
gh secret set MAC_IDENTITY --body 'Sobert Li (ABCDE12345)'
gh secret set APPLE_API_KEY_P8 < AuthKey_ABC123.p8
gh secret set APPLE_API_KEY_ID --body 'ABC123'
gh secret set APPLE_API_ISSUER --body '00000000-0000-0000-0000-000000000000'

gh variable set SIGN_DESKTOP_RELEASE --body true
```

设置变量后：

- push `release/vX.Y.Z` → macOS / Windows 使用签名配置构建，并在上传前校验；
- 任意分支 `workflow_dispatch` 勾选 `sign` → 只构建并上传 artifacts，不发布。

## 6. 发布后校验

CI 已经跑 `verify-signature.mjs`，本地也可以复验。Apple 公证背景：
<https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>

```bash
# macOS
codesign --verify --deep --strict --verbose=2 'apps/desktop/dist/mac-universal/Mebular.app'
codesign -dv --verbose=4 'apps/desktop/dist/mac-universal/Mebular.app'
spctl --assess --type execute --verbose=4 'apps/desktop/dist/mac-universal/Mebular.app'
xcrun stapler validate 'apps/desktop/dist/mac-universal/Mebular.app'

# Windows
powershell -NoProfile -Command "Get-AuthenticodeSignature 'apps/desktop/dist/Mebular-Setup-0.3.0.exe' | Format-List"
```

期望：

- `codesign` 输出 `Authority=Developer ID Application: ...`；
- `spctl` 输出 `accepted` 且 `source=Notarized Developer ID`；
- `stapler validate` 输出 `The validate action worked`；
- Windows `Status` 为 `Valid`，`SignerCertificate.Subject` 含证书 CN。

公证失败时拿 submission ID 查日志：

```bash
xcrun notarytool history --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"
xcrun notarytool log <submission-id> --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"
```

常见原因：某个嵌套二进制未签名、entitlements 不合法、DMG 里的 App 未 staple、API Key 权限不足。

## 7. 包管理器上架

### 7.1 Homebrew Cask（macOS）

Homebrew 5.0 起，官方 cask 必须 codesign + notarize；未签名 cask 会被弃用并从官方 tap 移除。
所以先完成第 3–6 节，再提交。官方文档：
<https://docs.brew.sh/Cask-Cookbook> ·
<https://docs.brew.sh/Adding-Software-to-Homebrew>

先在自有 tap 验证：

1. 新建仓库 `Windsander/homebrew-mebular`，目录 `Casks/mebular.rb`：

```ruby
cask "mebular" do
  version "0.3.0"
  sha256 "<DMG 的 sha256>"

  url "https://github.com/Windsander/Mebular/releases/download/v#{version}/Mebular-#{version}-universal.dmg",
      verified: "github.com/Windsander/Mebular/"
  name "Mebular"
  desc "Local-first graph memory for AI agents"
  homepage "https://github.com/Windsander/Mebular"

  app "Mebular.app"

  zap trash: [
    "~/.mebular",
    "~/Library/Application Support/Mebular",
    "~/Library/Caches/com.mebular.desktop",
    "~/Library/Preferences/com.mebular.desktop.plist",
  ]
end
```

2. 本地安装与审计：

```bash
brew install --cask Windsander/mebular/mebular
brew audit --cask --online Windsander/mebular/mebular
brew style Windsander/mebular/mebular
```

3. 稳定后向 `Homebrew/homebrew-cask` 提交 PR；新 cask 可用
   `brew create --cask <DMG URL>` 生成骨架，再用 `brew bump-cask-pr` 维护版本。

### 7.2 winget（Windows）

winget 不强制签名，但签名会显著改善首次安装体验。推荐用 `wingetcreate` 生成清单，避免手写
schema 漂移。工具与文档：<https://github.com/microsoft/winget-create> ·
<https://learn.microsoft.com/en-us/windows/package-manager/package/manifest> ·
<https://learn.microsoft.com/en-us/windows/package-manager/package/repository>

```powershell
wingetcreate new https://github.com/Windsander/Mebular/releases/download/v0.3.0/Mebular-Setup-0.3.0.exe
wingetcreate validate .\manifests\m\Mebular\Mebular\0.3.0
wingetcreate submit .\manifests\m\Mebular\Mebular\0.3.0
```

关键字段：

- `PackageIdentifier: Mebular.Mebular`
- `InstallerType: nullsoft`
- `Architecture: x64`
- `InstallerSwitches.Silent: /S`
- `InstallerSha256` 与 Release 资产一致

提交前用 `winget validate --manifest <目录>` 本地校验；PR 目标仓库是
<https://github.com/microsoft/winget-pkgs>。

### 7.3 AUR（Arch Linux）

AUR 首页：<https://aur.archlinux.org/>；提交规范：
<https://wiki.archlinux.org/title/AUR_submission_guidelines>；PKGBUILD 参考：
<https://wiki.archlinux.org/title/PKGBUILD>。

建议包名 `mebular-bin`，直接复用 AppImage：

```bash
pkgname=mebular-bin
pkgver=0.3.0
pkgrel=1
pkgdesc="Local-first graph memory for AI agents"
arch=('x86_64')
url="https://github.com/Windsander/Mebular"
license=('MIT')
depends=('fuse2' 'gtk3' 'nss' 'libxss' 'libnotify' 'libxtst' 'xdg-utils' 'at-spi2-core')
provides=('mebular')
conflicts=('mebular')
options=('!strip')
source=("$pkgname-$pkgver.AppImage::https://github.com/Windsander/Mebular/releases/download/v$pkgver/Mebular-$pkgver-x86_64.AppImage")
sha256sums=('<AppImage 的 sha256>')

package() {
  install -Dm755 "$srcdir/$pkgname-$pkgver.AppImage" "$pkgdir/opt/mebular/Mebular.AppImage"
  install -d "$pkgdir/usr/bin"
  ln -s /opt/mebular/Mebular.AppImage "$pkgdir/usr/bin/mebular"
  install -Dm644 /dev/stdin "$pkgdir/usr/share/applications/mebular.desktop" <<'EOF'
[Desktop Entry]
Name=Mebular
Exec=/opt/mebular/Mebular.AppImage %U
Terminal=false
Type=Application
Categories=Utility;
EOF
}
```

本地验证 `makepkg -si`、`namcap PKGBUILD`，再推送到 AUR（`mebular-bin` 仓库）。AppImage 依赖
FUSE；无 FUSE 环境需在文档里说明 `--appimage-extract-and-run`。

### 7.4 Snap / Flathub（暂缓）

- **Snap**：electron-builder 有 snap target，但 strict confinement 会限制本地守护、`~/.mebular`
  与系统服务安装；classic confinement 需要 Store 人工审核。等有明确需求再做。
- **Flathub**：需要 Flatpak manifest 与沙箱权限；应用的 runtime 自升级（下载并执行 npm 包）与
  Flathub 的自包含要求冲突。商店版需要单独裁剪。

## 8. 什么时候才考虑真·应用商店

当前架构与两个商店的硬约束冲突，不建议和首次签名混在一起做：

| 约束 | Mac App Store | Microsoft Store（MSIX） |
| --- | --- | --- |
| 沙箱 | 必须 App Sandbox；`~/.mebular`、launchd LaunchAgent 不可用 | MSIX 容器；`schtasks` 常驻服务安装不可用 |
| 自升级 | 禁止下载并执行代码（Guideline 2.5.2） | 商店应用不允许绕过 Store 自升级 |
| 网络 | 需要 network server/client entitlement，P2P 监听需审查 | 受容器与网络策略限制 |
| 结论 | 需要“商店版”：容器 home、去掉服务安装、禁用 runtime 升级 | 需要 MSIX + 关闭自升级，另做打包与提审 |

Microsoft Store 个人账号在 2026 年已免费；如果未来要做，建议单独开一个
`store/` 分支或 product flavor，而不是在现有安装包上打补丁。

## 9. 上线检查清单

- [ ] Apple Developer Program 已付费，Developer ID Application 证书已导出 `.p12`
- [ ] `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` / `MAC_IDENTITY` 已写入 secrets
- [ ] 公证凭据（API Key 或 Apple ID）已写入 secrets
- [ ] Windows 证书/云签名已就绪（或明确决定本期不签 Windows）
- [ ] `WIN_*` / `AZURE_*` / `WIN_SIGN_HOOK` 已写入 secrets
- [ ] 仓库变量 `SIGN_DESKTOP_RELEASE=true`
- [ ] `workflow_dispatch` 勾选 `sign` 跑通一次 dry-run
- [ ] 正式 release 后 `verify-signature` 全绿，Release notes 写明已签名/已公证
- [ ] Homebrew Cask / winget / AUR 至少一个渠道已提交
- [ ] `DESKTOP_RELEASE.md` 的 unsigned 绕过说明按实际情况更新

## 10. 常见问题

| 现象 | 处理 |
| --- | --- |
| `identity explicitly is set to null` | 用了 `dist:mac` 而不是 `dist:mac:signed`；默认配置故意禁用签名。 |
| `Please remove prefix "Developer ID Application:"` | `MAC_IDENTITY` 传了完整 CN 且带前缀；脚本会自动去掉，若仍报错检查是否有多余空格/引号。 |
| `code object is not signed at all` | `.p12` 没导入成功，或 `CSC_LINK` 不是有效 base64/路径；先跑 `security find-identity -v -p codesigning`。 |
| `spctl` 显示 `Unnotarized Developer ID` | 公证没成功或没有 staple；查 `notarytool log`，不要直接发版。 |
| `stapler validate` 失败 | 公证票据未写入；确认 `@electron/notarize` 在签名后执行，且没有跳过 `mac.notarize`。 |
| Azure 报 `Invoke-TrustedSigning` 不存在 | PowerShell 模块安装失败或区域 endpoint 不对；看 job 日志，确认 runner 能访问 PSGallery。 |
| Windows `Status=NotSigned` | Azure/hook 没真正签上；`forceCodeSigning` 之外还要依赖 `verify-signature.mjs` 兜底。 |
| 签名后 App 启动崩溃 | 先检查 entitlements；Electron 常见缺失是 `allow-jit` / `allow-unsigned-executable-memory`。 |
| Homebrew audit 报 Gatekeeper | cask 的 DMG 里 App 未签名/未公证；先修签名，不要给 cask 加绕过参数。 |
