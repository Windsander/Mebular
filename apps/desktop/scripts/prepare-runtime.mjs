#!/usr/bin/env node
// Mebular 桌面 App · 准备发布 runtime
//
// 从 npm pack 产出的发布 tarball 安装一份**与仓库源码目录无关**的运行时：
//   <out>/node_modules/@mebular/{core,fleet,service,mcp,memory-runtime,skill}
// electron-builder 再把它作为 extraResources/node_modules 原样装进安装包。
//
// 用法（默认值适用于仓库内 `npm run dist:*`）：
//   node apps/desktop/scripts/prepare-runtime.mjs
//   node apps/desktop/scripts/prepare-runtime.mjs --tarballs release-pack --out apps/desktop/runtime
//
// 约束：
//   - 安装前先清空 out（默认 apps/desktop/runtime；该目录不入 git）；
//   - 一次 npm install 安装 6 个 tarball，--ignore-scripts 避免执行发布包的安装钩子；
//   - 安装后断言版本与关键文件，失败以非 0 退出并给出中文原因。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const repoRoot = join(appDir, '..', '..');

const PACKAGES = [
  { name: '@mebular/core', suffix: 'core', label: '@mebular/core' },
  { name: '@mebular/fleet', suffix: 'fleet', label: '@mebular/fleet' },
  { name: '@mebular/service', suffix: 'service', label: '@mebular/service' },
  { name: '@mebular/mcp', suffix: 'mcp', label: '@mebular/mcp' },
  { name: '@mebular/memory-runtime', suffix: 'memory-runtime', label: '@mebular/memory-runtime' },
  { name: '@mebular/skill', suffix: 'skill', label: '@mebular/skill' },
];

function fail(message) {
  console.error(`✗ [desktop:runtime] ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`用法：node apps/desktop/scripts/prepare-runtime.mjs [--tarballs <dir>] [--out <dir>]

  --tarballs <dir>  发布 tarball 目录（默认：<repo>/release-pack）
  --out <dir>       runtime 输出目录（默认：apps/desktop/runtime）
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i]);
    if (token === '--help' || token === '-h') return { help: true };
    if (token === '--tarballs' || token === '--out') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        fail(`参数 ${token} 缺少目录值`);
      }
      out[token.slice(2)] = value;
      i += 1;
      continue;
    }
    if (token.startsWith('--tarballs=') || token.startsWith('--out=')) {
      const [key, ...rest] = token.slice(2).split('=');
      const value = rest.join('=');
      if (value.length === 0) fail(`参数 --${key} 缺少目录值`);
      out[key] = value;
      continue;
    }
    fail(`未知参数：${token}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}

const repoVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).version;
if (typeof repoVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(repoVersion)) {
  fail(`仓库根 package.json 的 version 非法：${String(repoVersion)}`);
}

// 版本 SSOT：桌面 App package.json / main 进程 APP_VERSION 必须与五个 npm 包同版本。
const desktopVersion = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8')).version;
if (desktopVersion !== repoVersion) {
  fail(`apps/desktop/package.json 版本 ${String(desktopVersion)} 与仓库根版本 ${repoVersion} 不一致。`);
}
const daemonSource = readFileSync(join(appDir, 'src', 'main', 'daemon.mjs'), 'utf-8');
const daemonVersion = /export const APP_VERSION = '([^']+)'/.exec(daemonSource)?.[1];
if (daemonVersion !== repoVersion) {
  fail(`apps/desktop/src/main/daemon.mjs 的 APP_VERSION=${String(daemonVersion)} 与仓库根版本 ${repoVersion} 不一致。`);
}

const tarballDir = args.tarballs
  ? resolve(process.cwd(), args.tarballs)
  : join(repoRoot, 'release-pack');
const outDir = args.out ? resolve(process.cwd(), args.out) : join(appDir, 'runtime');

// 防手滑：runtime 必须是可清空的项目子目录，不能是仓库根 / 文件系统根。
const parsedOut = resolve(outDir);
if (parsedOut === resolve(repoRoot) || dirname(parsedOut) === parsedOut) {
  fail(`拒绝把 runtime 输出到危险目录：${outDir}`);
}

if (!existsSync(tarballDir) || !statSync(tarballDir).isDirectory()) {
  fail(`tarball 目录不存在：${tarballDir}\n  请先在仓库根执行 npm pack（见 apps/desktop/README.md「安装包」）。`);
}

/** 找到某个包对应版本的 tarball；同目录有多份不同版本时拒绝猜测。 */
function findTarball(pkg) {
  const prefix = `mebular-${pkg.suffix}-`;
  const expected = `${prefix}${repoVersion}.tgz`;
  const candidates = readdirSync(tarballDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.tgz'))
    .sort();
  if (candidates.includes(expected)) return join(tarballDir, expected);
  if (candidates.length === 0) {
    fail(`缺少 ${pkg.label} 的发布 tarball：${join(tarballDir, expected)}\n  请先在仓库根 / 对应包目录执行 npm pack。`);
  }
  if (candidates.length > 1) {
    fail(`找到多个 ${pkg.label} tarball，无法确定使用哪一个（期望 ${expected}）：\n  ${candidates.join('\n  ')}`);
  }
  const [only] = candidates;
  const version = only.slice(prefix.length, -'.tgz'.length);
  fail(`找到 ${pkg.label} tarball ${only}，但版本 ${version} 与仓库根版本 ${repoVersion} 不一致。\n  请先 npm run build 并重新 npm pack。`);
}

// 先确认 6 个 tarball 都在，再删除旧 runtime（失败时保留可排查的上一份产物）。
const tarballs = PACKAGES.map(findTarball);

console.log(`[desktop:runtime] tarballs: ${relative(process.cwd(), tarballDir) || tarballDir}`);
console.log(`[desktop:runtime] 版本: ${repoVersion}`);
console.log(`[desktop:runtime] 输出: ${relative(process.cwd(), outDir) || outDir}`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'package.json'),
  `${JSON.stringify({
    name: '@mebular/desktop-runtime',
    version: repoVersion,
    private: true,
    description: 'Mebular 桌面安装包运行时（由发布 tarball 安装，不入库）',
  }, null, 2)}\n`,
  'utf-8',
);

// Windows 不能直接 execFile('npm.cmd')；通过 npm run 调用时优先走 npm-cli.js，直接调用时退回 npm.cmd。
function runNpm(args) {
  const npmExecPath = process.env.npm_execpath;
  if (typeof npmExecPath === 'string' && npmExecPath.endsWith('.js')) {
    return spawnSync(process.execPath, [npmExecPath, ...args], {
      cwd: outDir,
      stdio: 'inherit',
      env: process.env,
    });
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(npm, args, {
    cwd: outDir,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
}

console.log('[desktop:runtime] npm install（6 个发布 tarball，omit=dev / ignore-scripts）…');
const install = runNpm([
  'install',
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--no-save',
  '--no-package-lock',
  '--prefix',
  outDir,
  ...tarballs,
]);
if (install.error) {
  fail(`无法执行 npm：${String(install.error.message ?? install.error)}`);
}
if (install.status !== 0) {
  fail(`npm install 失败（退出码 ${install.status ?? install.signal ?? 'unknown'}）。请检查网络 / npm registry 与 tarball 是否完整。`);
}

const modulesDir = join(outDir, 'node_modules');

function requireFile(relativePath, hint) {
  const absolute = join(modulesDir, relativePath);
  if (!existsSync(absolute)) {
    fail(`runtime 缺少必需文件：${relative(modulesDir, absolute)}${hint ? `\n  ${hint}` : ''}`);
  }
  return absolute;
}

function readInstalledManifest(name) {
  const file = join(modulesDir, '@mebular', name, 'package.json');
  if (!existsSync(file)) {
    fail(`runtime 缺少 @mebular/${name}（npm install 未完成？）`);
  }
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    fail(`无法解析 @mebular/${name}/package.json：${String(error?.message ?? error)}`);
  }
}

for (const pkg of PACKAGES) {
  const manifest = readInstalledManifest(pkg.name.slice('@mebular/'.length));
  if (manifest.version !== repoVersion) {
    fail(`${pkg.label} 安装版本 ${String(manifest.version)} 与仓库根版本 ${repoVersion} 不一致（lockstep 校验失败）。`);
  }
}

// 版本 SSOT：根 tarball 里的 MCP CLI / console / locales / skill 必须完整。
const cliBin = requireFile(
  join('@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs'),
  '发布 tarball 未包含 packages/mcp/bin；请检查根 package.json 的 files。',
);
requireFile(
  join('@mebular', 'core', 'packages', 'mcp', 'src', 'server.mjs'),
  'MCP 运行时入口缺少同包 src（bin/mebular.mjs 依赖它）。',
);
requireFile(
  join('@mebular', 'core', 'packages', 'mcp', 'src', 'profiles.mjs'),
  '桌面忆云切换依赖 packages/mcp/src/profiles.mjs。',
);
requireFile(
  join('@mebular', 'core', 'packages', 'mcp', 'src', 'cloud-switch.mjs'),
  '桌面忆云切换依赖 packages/mcp/src/cloud-switch.mjs。',
);
requireFile(
  join('@mebular', 'core', 'packages', 'service', 'dist', 'index.js'),
  '桌面服务托管依赖 packages/service/dist。',
);
requireFile(
  join('@mebular', 'core', 'packages', 'fleet', 'dist', 'cli.js'),
  '桌面任务/邀请能力依赖 packages/fleet/dist。',
);
requireFile(
  join('@mebular', 'core', 'packages', 'console', 'index.html'),
  '控制台静态资源应随 @mebular/core 发布（packages/console）。',
);
requireFile(
  join('@mebular', 'core', 'packages', 'console', 'host.js'),
  'DSH 嵌入依赖 console/host.js。',
);
requireFile(
  join('@mebular', 'core', 'locales', 'manifest.json'),
  'locale pack 应随 @mebular/core 发布（locales/）。',
);
requireFile(
  join('@mebular', 'skill', 'SKILL.md'),
  'Skill 内容应随 @mebular/skill 发布。',
);

const topLevelCount = readdirSync(modulesDir).filter((name) => !name.startsWith('.')).length;
const coreManifest = readInstalledManifest('core');
console.log('[desktop:runtime] ✓ runtime 已准备');
console.log(`  @mebular/core@${coreManifest.version}（fleet/service/mcp/memory-runtime/skill 同版本）`);
console.log(`  CLI: ${relative(outDir, cliBin)}`);
console.log(`  node_modules 顶层条目: ${topLevelCount}`);
