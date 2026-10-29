#!/usr/bin/env node
// Mebular 桌面 App · 签名环境预检
//
// 在耗时的 prepare-runtime / electron-builder 之前快速失败，避免跑了 10 分钟后才因为
// 少一个 secret 报错。只读环境变量，不接触证书内容。
//
// 用法：
//   node apps/desktop/scripts/check-signing-env.mjs --platform mac
//   node apps/desktop/scripts/check-signing-env.mjs --platform win

import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
let platform = null;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === '--help' || token === '-h') {
    console.log(`用法：node apps/desktop/scripts/check-signing-env.mjs --platform <mac|win>

  mac  macOS Developer ID + notarization 凭据
  win  Windows Azure Artifact Signing 凭据
`);
    process.exit(0);
  }
  if (token === '--platform') {
    platform = args[i + 1];
    i += 1;
    continue;
  }
  if (token.startsWith('--platform=')) {
    platform = token.slice('--platform='.length);
    continue;
  }
  console.error(`✗ [signing] 未知参数：${token}`);
  process.exit(2);
}

if (platform !== 'mac' && platform !== 'win') {
  console.error('✗ [signing] 必须指定 --platform mac 或 --platform win');
  process.exit(2);
}

const env = process.env;
const isCI = env.CI === 'true' || env.CI === '1';
const missing = [];
const notes = [];

function value(name) {
  return typeof env[name] === 'string' ? env[name].trim() : '';
}

function requireEnv(name, hint) {
  if (value(name)) return true;
  missing.push(`${name}${hint ? `（${hint}）` : ''}`);
  return false;
}

console.log(`[signing] 预检平台：${platform}${isCI ? '（CI）' : '（本机）'}`);

if (platform === 'mac') {
  if (process.platform !== 'darwin') {
    notes.push('当前不是 macOS；Developer ID 签名与公证必须在 macOS 构建机上执行。');
  }

  requireEnv('MEBULAR_MAC_IDENTITY', '证书 CN，可带或不带 "Developer ID Application:" 前缀');

  if (isCI) {
    requireEnv('CSC_LINK', 'base64 编码的 Developer ID .p12');
    if (!value('CSC_KEY_PASSWORD')) {
      notes.push('CSC_KEY_PASSWORD 为空：仅当 .p12 导出时未设置密码才可继续。');
    }
  } else if (!value('CSC_LINK')) {
    notes.push('未设置 CSC_LINK：将使用本机钥匙串中已安装的 Developer ID 证书。');
  }

  const apiKey = value('APPLE_API_KEY');
  const appleId = value('APPLE_ID');
  const appPassword = value('APPLE_APP_SPECIFIC_PASSWORD');
  const teamId = value('APPLE_TEAM_ID');
  const keychainProfile = value('APPLE_KEYCHAIN_PROFILE');

  if (appleId || appPassword || teamId) {
    requireEnv('APPLE_ID', 'Apple Developer 账号邮箱');
    requireEnv('APPLE_APP_SPECIFIC_PASSWORD', 'Apple ID 专用密码');
    requireEnv('APPLE_TEAM_ID', 'Apple Developer Team ID');
    notes.push('公证使用 Apple ID + 专用密码；更推荐 App Store Connect API Key（可撤销、无需专用密码）。');
  } else if (apiKey) {
    requireEnv('APPLE_API_KEY_ID', 'App Store Connect API Key ID');
    requireEnv('APPLE_API_ISSUER', 'App Store Connect Issuer ID');
    if (!existsSync(apiKey)) {
      missing.push(
        `APPLE_API_KEY=${apiKey} 不是存在的文件路径；secret 里存 .p8 内容时，先写入文件再把路径赋给 APPLE_API_KEY`,
      );
    }
  } else if (!keychainProfile) {
    missing.push(
      '公证凭据：APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER，或 APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID，或 APPLE_KEYCHAIN_PROFILE',
    );
  }
}

if (platform === 'win') {
  if (process.platform !== 'win32') {
    notes.push('当前不是 Windows；NSIS + Azure Artifact Signing 必须在 Windows 构建机上执行。');
  }

  requireEnv('MEBULAR_WIN_PUBLISHER', '证书 Subject CN，必须完全一致');

  const hook = value('MEBULAR_WIN_SIGN_HOOK');
  if (hook) {
    if ((hook.startsWith('.') || hook.startsWith('/')) && !existsSync(hook)) {
      missing.push(`MEBULAR_WIN_SIGN_HOOK=${hook} 不存在；自定义签名 hook 必须是可加载的路径/模块`);
    }
    notes.push('使用 MEBULAR_WIN_SIGN_HOOK 自定义签名；请确认 hook 在 CI 中能访问云 HSM 凭据。');
  } else {
    requireEnv('MEBULAR_WIN_ENDPOINT', 'Artifact Signing account endpoint');
    requireEnv('MEBULAR_WIN_CERT_PROFILE', 'Certificate Profile name');
    requireEnv('MEBULAR_WIN_SIGN_ACCOUNT', 'Code Signing Account name');

    // electron-builder 通过 Invoke-TrustedSigning + Azure Identity EnvironmentCredential 认证。
    requireEnv('AZURE_TENANT_ID');
    requireEnv('AZURE_CLIENT_ID');
    requireEnv('AZURE_CLIENT_SECRET');

    const endpoint = value('MEBULAR_WIN_ENDPOINT');
    if (endpoint && !/^https:\/\//i.test(endpoint)) {
      notes.push('MEBULAR_WIN_ENDPOINT 通常应以 https:// 开头，请确认没有误填账号名。');
    }
  }
}

for (const note of notes) console.log(`  ! ${note}`);

if (missing.length > 0) {
  console.error(`✗ [signing] 缺少 ${missing.length} 项签名配置：`);
  for (const item of missing) console.error(`    - ${item}`);
  console.error('  配置说明：docs/operations/SIGNING.md');
  process.exit(1);
}

console.log('✓ [signing] 环境变量齐全');
