#!/usr/bin/env node
// Mebular 桌面 App · 签名产物校验
//
// 只在“签名发布”路径运行：任何一项不通过都以非 0 退出，避免把未签名/未公证的包
// 当成签名包发出去。
//
// 用法：
//   node apps/desktop/scripts/verify-signature.mjs --platform mac
//   node apps/desktop/scripts/verify-signature.mjs --platform win
//   node apps/desktop/scripts/verify-signature.mjs --platform mac --dist apps/desktop/dist

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');

const args = process.argv.slice(2);
let platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : null;
let dist = join(appDir, 'dist');

for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === '--help' || token === '-h') {
    console.log(`用法：node apps/desktop/scripts/verify-signature.mjs --platform <mac|win> [--dist <dir>]

  mac  codesign + spctl + stapler（Developer ID / 公证）
  win  Get-AuthenticodeSignature（Authenticode）
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
  if (token === '--dist') {
    dist = args[i + 1];
    i += 1;
    continue;
  }
  if (token.startsWith('--dist=')) {
    dist = token.slice('--dist='.length);
    continue;
  }
  console.error(`✗ [signature] 未知参数：${token}`);
  process.exit(2);
}

if (platform !== 'mac' && platform !== 'win') {
  console.error('✗ [signature] 必须指定 --platform mac 或 --platform win');
  process.exit(2);
}

let failures = 0;

function ok(label, detail = '') {
  console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`);
}

function fail(label, detail = '') {
  failures += 1;
  console.error(`  ✗ ${label}${detail ? `（${detail}）` : ''}`);
}

function run(label, command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf-8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.error) {
    fail(label, result.error.message);
    return { ok: false, output };
  }
  if (result.status !== 0) {
    fail(label, `exit ${result.status}`);
    if (output) console.error(output.split('\n').map((line) => `      ${line}`).join('\n'));
    return { ok: false, output };
  }
  ok(label);
  if (output) console.log(output.split('\n').map((line) => `      ${line}`).join('\n'));
  return { ok: true, output };
}

function topLevelDirs() {
  if (!existsSync(dist)) return [];
  return readdirSync(dist)
    .map((name) => join(dist, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

function findMacApp() {
  const candidates = topLevelDirs()
    .filter((dir) => /^mac(-|$)/.test(basename(dir)))
    .map((dir) => join(dir, 'Mebular.app'))
    .filter((path) => existsSync(path));
  return candidates[0] ?? null;
}

function findWindowsArtifacts() {
  const installer = readdirSync(dist)
    .filter((name) => /^Mebular-Setup-.*\.exe$/i.test(name))
    .map((name) => join(dist, name))
    .find((path) => existsSync(path));
  const unpacked = join(dist, 'win-unpacked', 'Mebular.exe');
  return { installer: installer ?? null, unpacked: existsSync(unpacked) ? unpacked : null };
}

console.log(`[signature] 平台：${platform}；产物目录：${dist}`);

if (platform === 'mac') {
  if (process.platform !== 'darwin') {
    console.error('✗ [signature] macOS 签名校验只能在 macOS 上运行');
    process.exit(1);
  }

  const app = findMacApp();
  if (!app) {
    console.error(`✗ [signature] 在 ${dist} 下找不到 mac*/Mebular.app`);
    process.exit(1);
  }
  console.log(`[signature] App：${app}`);

  const verify = run('codesign 严格校验', 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  if (verify.ok) ok('codesign --deep --strict 通过');

  const info = run('读取签名信息', 'codesign', ['-dv', '--verbose=4', app]);
  if (info.ok) {
    if (/Authority=Developer ID Application/i.test(info.output)) {
      ok('证书类型为 Developer ID Application');
    } else {
      fail('证书类型不是 Developer ID Application，不能用于直装分发');
    }
    if (/TeamIdentifier=\S+/.test(info.output)) {
      ok('TeamIdentifier 已写入签名');
    } else {
      fail('签名中缺少 TeamIdentifier');
    }
  }

  const gatekeeper = run('Gatekeeper 评估', 'spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
  if (gatekeeper.ok) {
    if (/accepted/i.test(gatekeeper.output)) {
      ok('spctl 判定 accepted');
    } else {
      fail('spctl 未返回 accepted');
    }
    if (/Notarized Developer ID/i.test(gatekeeper.output)) {
      ok('公证票据可被 Gatekeeper 识别');
    } else {
      fail('未看到 "Notarized Developer ID"；确认公证成功且已 staple');
    }
  }

  run('stapler 票据校验', 'xcrun', ['stapler', 'validate', app]);

  const dmgCount = readdirSync(dist).filter((name) => name.endsWith('.dmg')).length;
  if (dmgCount === 1) {
    ok('DMG 已生成', `${dmgCount} 个`);
  } else {
    fail('DMG 数量异常', `期望 1 个，实际 ${dmgCount} 个`);
  }
}

if (platform === 'win') {
  if (process.platform !== 'win32') {
    console.error('✗ [signature] Windows 签名校验只能在 Windows 上运行');
    process.exit(1);
  }

  const { installer, unpacked } = findWindowsArtifacts();
  if (!installer) {
    console.error(`✗ [signature] 在 ${dist} 下找不到 Mebular-Setup-*.exe`);
    process.exit(1);
  }
  console.log(`[signature] 安装包：${installer}`);

  const paths = [installer];
  if (unpacked) paths.push(unpacked);

  const quoted = paths.map((path) => `'${path.replace(/'/g, "''")}'`).join(', ');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$paths = @(${quoted})`,
    'foreach ($path in $paths) {',
    "  $sig = Get-AuthenticodeSignature -FilePath $path",
    '  Write-Output ("{0}`t{1}`t{2}" -f $path, $sig.Status, $sig.SignerCertificate.Subject)',
    "  if ($sig.Status -ne 'Valid') { exit 1 }",
    '}',
  ].join('\n');

  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf-8' },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.error) {
    fail('Authenticode 校验无法执行', result.error.message);
  } else if (result.status !== 0) {
    fail('Authenticode 校验失败', `exit ${result.status}`);
    if (output) console.error(output.split('\n').map((line) => `      ${line}`).join('\n'));
  } else {
    ok('Authenticode 签名有效');
    if (output) console.log(output.split('\n').map((line) => `      ${line}`).join('\n'));
    if (unpacked) ok('win-unpacked/Mebular.exe 已签名');
  }
}

if (failures > 0) {
  console.error(`✗ [signature] ${failures} 项校验失败`);
  process.exit(1);
}

console.log('✓ [signature] 签名产物校验通过');
