#!/usr/bin/env node
// 桌面安装包资产校验（本地 dry-run 与 CI release 共用）
//
//   npm run verify:desktop:assets -- --dir apps/desktop/dist
//   npm run verify:desktop:assets -- --dir release-assets \
//     --expect dmg,exe,AppImage,deb --require-hermes
//
// 断言：
//   - 每个 --expect 类型恰好 1 个文件，大小 > 0，sha256 可计算；
//   - 生成 SHA256SUMS.txt（<sha256> 两个空格 <文件名>，按文件名 ASCII 排序），
//     并重新读取校验它覆盖全部安装包（含存在的 zip）与可选 Hermes tarball；
//   - 明确报告 signed / notarized，不把 unsigned 当作已签名。
//
// 退出码：资产缺失、空文件、哈希失败、checksums 未覆盖 → 1。
// 未签名 / 未公证是 v0.3.0 的预期状态，只标记，不导致失败。

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const ASSET_TYPES = ['dmg', 'exe', 'AppImage', 'deb', 'zip'];
const INSTALLER_GLOBS = {
  dmg: (name) => name.endsWith('.dmg'),
  exe: (name) => name.endsWith('.exe'),
  AppImage: (name) => name.endsWith('.AppImage'),
  deb: (name) => name.endsWith('.deb'),
  zip: (name) => name.endsWith('.zip'),
};

let failed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? `（${detail}）` : ''}`);
  }
}

function fail(message) {
  console.error(`✗ [desktop:assets] ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`用法：node scripts/verify-desktop-assets.mjs [--dir <dir>] [--expect <types>] [--require-hermes]

  --dir <dir>         安装包目录（默认：apps/desktop/dist）
  --expect <types>    期望各恰好 1 个的类型，逗号分隔：${ASSET_TYPES.join(',')}
                      （默认：dmg）
  --require-hermes    额外要求恰好 1 个 mebular-hermes-plugins-<version>.tar.gz，
                      并写入 SHA256SUMS.txt
`);
}

function parseArgs(argv) {
  const out = { dir: 'apps/desktop/dist', expect: ['dmg'], requireHermes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i]);
    if (token === '--help' || token === '-h') return { help: true };
    if (token === '--dir') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) fail('参数 --dir 缺少目录值');
      out.dir = value;
      i += 1;
      continue;
    }
    if (token.startsWith('--dir=')) {
      const value = token.slice('--dir='.length);
      if (value.length === 0) fail('参数 --dir 缺少目录值');
      out.dir = value;
      continue;
    }
    if (token === '--expect') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) fail('参数 --expect 缺少类型列表');
      out.expect = parseExpect(value);
      i += 1;
      continue;
    }
    if (token.startsWith('--expect=')) {
      out.expect = parseExpect(token.slice('--expect='.length));
      continue;
    }
    if (token === '--require-hermes') {
      out.requireHermes = true;
      continue;
    }
    fail(`未知参数：${token}`);
  }
  return out;
}

function parseExpect(value) {
  const types = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (types.length === 0) fail('参数 --expect 不能为空');
  for (const type of types) {
    if (!ASSET_TYPES.includes(type)) fail(`未知资产类型：${type}（可选：${ASSET_TYPES.join(',')}）`);
  }
  return [...new Set(types)];
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}

const dir = resolve(process.cwd(), args.dir);
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  fail(`资产目录不存在：${dir}`);
}

const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).version;
const hermesName = `mebular-hermes-plugins-${version}.tar.gz`;

console.log('Mebular 桌面资产校验');
console.log('===============================');
console.log(`目录: ${dir}`);
console.log(`期望: ${args.expect.join(', ')}${args.requireHermes ? ` + ${hermesName}` : ''}`);

const entries = readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort();

const byType = Object.fromEntries(ASSET_TYPES.map((type) => [type, entries.filter(INSTALLER_GLOBS[type])]));

for (const type of args.expect) {
  const files = byType[type] ?? [];
  check(`${type} 恰好 1 个`, files.length === 1, files.length === 0 ? '未找到' : files.join(', '));
}

// zip 存在时纳入 checksums；未要求时不因缺少 zip 失败。
if (!args.expect.includes('zip')) {
  console.log(`  · zip：${byType.zip.length === 0 ? '无（未要求）' : `发现 ${byType.zip.join(', ')}，纳入 checksums`}`);
}

if (args.requireHermes) {
  const hermes = entries.filter((name) => name.startsWith('mebular-hermes-plugins-') && name.endsWith('.tar.gz'));
  const ok = hermes.length === 1 && hermes[0] === hermesName;
  check(`Hermes tarball 恰好 1 个（${hermesName}）`, ok, ok ? '' : (hermes.join(', ') || '未找到'));
}

const installers = ASSET_TYPES.flatMap((type) => byType[type]);
const checksumTargets = [...installers];
if (args.requireHermes && existsSync(join(dir, hermesName))) checksumTargets.push(hermesName);

for (const name of checksumTargets) {
  const file = join(dir, name);
  const size = statSync(file).size;
  check(`${name} 非空`, size > 0, `${formatSize(size)}`);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  const mib = bytes / (1024 * 1024);
  return mib >= 1 ? `${mib.toFixed(1)} MiB（${bytes} bytes）` : `${(bytes / 1024).toFixed(1)} KiB（${bytes} bytes）`;
}

function sha256(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

const sums = new Map();
for (const name of checksumTargets) {
  try {
    const digest = await sha256(join(dir, name));
    sums.set(name, digest);
    console.log(`  · sha256 ${digest}  ${name}`);
  } catch (error) {
    check(`${name} sha256 可计算`, false, String(error?.message ?? error));
  }
}

const sumsPath = join(dir, 'SHA256SUMS.txt');
try {
  const lines = [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, digest]) => `${digest}  ${name}`);
  if (lines.length === 0) {
    check('SHA256SUMS.txt 已生成', false, '没有可校验的资产');
  } else {
    writeFileSync(sumsPath, `${lines.join('\n')}\n`, 'utf-8');
    check('SHA256SUMS.txt 已生成', true, `${lines.length} 个文件`);
  }
} catch (error) {
  check('SHA256SUMS.txt 已生成', false, String(error?.message ?? error));
}

const parsed = new Map();
try {
  for (const line of readFileSync(sumsPath, 'utf-8').split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (match) parsed.set(match[2], match[1]);
  }
} catch {
  // 生成失败已在上一项报告
}

for (const [name, digest] of sums) {
  const ok = parsed.get(name) === digest;
  check(`SHA256SUMS.txt 覆盖 ${name}`, ok, ok ? '' : (parsed.has(name) ? '哈希不一致' : '缺少条目'));
}

// ---- 签名 / 公证：只报告事实，不冒充 ----
function walkApps(dirPath, depth = 0) {
  if (depth > 4) return [];
  const found = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dirPath, entry.name);
    if (entry.name.endsWith('.app')) {
      found.push(full);
    } else {
      found.push(...walkApps(full, depth + 1));
    }
  }
  return found;
}

function run(command, commandArgs) {
  return spawnSync(command, commandArgs, { encoding: 'utf-8' });
}

const apps = process.platform === 'darwin' ? walkApps(dir).sort() : [];
const signature = {
  signed: false,
  notarized: false,
  basis: '',
  apps: [],
};

if (process.platform !== 'darwin') {
  signature.basis = '非 macOS 主机，无法用 codesign/spctl 验证；signed/notarized 按 false 报告';
} else if (apps.length === 0) {
  signature.basis = '目录内没有 .app（release 资产只有安装包），无法在本机验证签名/公证';
} else {
  for (const app of apps) {
    const details = run('codesign', ['-dv', '--verbose=4', app]);
    const detailText = `${details.stdout}\n${details.stderr}`;
    const verify = run('codesign', ['--verify', '--deep', '--strict', app]);
    const spctl = run('spctl', ['-a', '-vv', '--type', 'execute', app]);
    const hasDeveloperId = /Authority=Developer ID Application/.test(detailText);
    const hasTeam = /TeamIdentifier=(?!not set)\S+/.test(detailText);
    const signed = verify.status === 0 && hasDeveloperId && hasTeam;
    const notarized = signed && spctl.status === 0;
    const reason = signed
      ? (notarized ? 'spctl 接受' : `spctl 拒绝：${String(spctl.stderr || spctl.stdout).trim()}`)
      : `codesign --verify=${verify.status}${hasDeveloperId ? '' : '，无 Developer ID Authority'}${hasTeam ? '' : '，无 TeamIdentifier'}`;
    signature.apps.push({ path: app, signed, notarized, reason });
    console.log(`  · ${app}: signed=${signed} notarized=${notarized}（${reason}）`);
  }
  signature.signed = signature.apps.every((app) => app.signed);
  signature.notarized = signature.apps.every((app) => app.notarized);
  signature.basis = 'codesign --verify --deep --strict + Developer ID Authority/TeamIdentifier；spctl 判定公证';
}

console.log('===============================');
console.log(`signed=${signature.signed} notarized=${signature.notarized}`);
console.log(`签名依据：${signature.basis}`);
if (signature.apps.length > 0) {
  for (const app of signature.apps) console.log(`  ${app.path}: signed=${app.signed} notarized=${app.notarized}`);
}
console.log(`SHA256SUMS：${sumsPath}`);

if (failed === 0) {
  console.log(`✓ 桌面资产校验通过（v${version} 的 unsigned 状态为预期）`);
  process.exit(0);
}
console.log(`✗ 桌面资产校验失败（${failed} 项）`);
process.exit(1);
