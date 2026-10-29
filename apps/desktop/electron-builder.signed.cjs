// Mebular 桌面 App · 签名发布配置（仅 dist:*:signed / 正式 release 使用）
//
// 基础配置仍是 electron-builder.yml（保持 unsigned 可构建）；本文件只叠加签名必需项：
//   - forceCodeSigning + 构建后 verify-signature.mjs：签名失败会让 job 失败，
//     绝不把“看起来成功”的 unsigned 包发出去；
//   - macOS：Developer ID Application + hardened runtime + entitlements + notarize；
//   - Windows：Azure Artifact Signing（electron-builder 的 azureSignOptions）。
//
// 平台相关环境变量只在对应平台的构建机读取，避免 macOS job 因缺 Windows 变量失败。
// 使用说明与 secret 清单见 docs/operations/SIGNING.md。

const path = require('node:path');

const env = process.env;

function requireEnv(name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`[signed build] 缺少环境变量 ${name}；见 docs/operations/SIGNING.md`);
  }
  return value;
}

/** @type {import('electron-builder').Configuration} */
const config = {
  // 用绝对路径，保证从仓库根或 apps/desktop 调用都能找到基础配置。
  extends: path.join(__dirname, 'electron-builder.yml'),
  forceCodeSigning: true,
};

if (process.platform === 'darwin') {
  config.mac = {
    // 允许传入完整 CN；electron-builder 不接受 "Developer ID Application:" 前缀。
    identity: requireEnv('MEBULAR_MAC_IDENTITY').replace(/^Developer ID Application:\s*/i, ''),
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: path.join(__dirname, 'resources', 'entitlements.mac.plist'),
    entitlementsInherit: path.join(__dirname, 'resources', 'entitlements.mac.inherit.plist'),
    notarize: true,
  };
}

if (process.platform === 'win32') {
  const hook = env.MEBULAR_WIN_SIGN_HOOK?.trim();
  if (hook) {
    // 非 Azure 的云签名/HSM（Certum SimplySign、SSL.com eSigner、DigiCert KeyLocker 等）
    // 走自定义 hook；hook 必须自己完成签名，并由 verify-signature.mjs 兜底校验。
    config.win = { signtoolOptions: { sign: hook } };
  } else {
    config.win = {
      azureSignOptions: {
        publisherName: requireEnv('MEBULAR_WIN_PUBLISHER'),
        endpoint: requireEnv('MEBULAR_WIN_ENDPOINT'),
        certificateProfileName: requireEnv('MEBULAR_WIN_CERT_PROFILE'),
        codeSigningAccountName: requireEnv('MEBULAR_WIN_SIGN_ACCOUNT'),
      },
    };
  }
}

module.exports = config;
