#!/usr/bin/env node
// 发布版本号同步（lockstep：6 个可发布包共用同一版本）。
//
// 通常通过 scripts/bump_version.sh 调用；也可以直接运行：
//   node scripts/bump-version.mjs --root . --version 0.2.0 --tag v0.2.0
//
// 同步内容：
//   1. package.json × 6（root @mebular/core + fleet / mcp / service / skill / dsh-plugin）；
//   2. 这些 manifest 中任何“已是版本号区间”的内部 @mebular/* 依赖 -> ^<new version>
//      （file: 本地链接留给 pack 期由 publish-manifest 改写）；
//   3. package-lock.json 根 version / packages[""] / 6 个 workspace 条目；
//   4. apps/desktop/package.json、apps/desktop/package-lock.json、main 进程 APP_VERSION；
//   5. packages/mcp/src/version.mjs（MCP 对外版本唯一真源）；
//   6. CHANGELOG.md 插入 `## [vX.Y.Z] - <date>` 章节占位（幂等）。
//
// 发布分支命名（版本 SSOT）：release/vX.Y.Z，工作流据此校验版本一致。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export const RELEASE_PACKAGES = [
  { rel: '.', name: '@mebular/core' },
  { rel: 'packages/fleet', name: '@mebular/fleet' },
  { rel: 'packages/mcp', name: '@mebular/mcp' },
  { rel: 'packages/service', name: '@mebular/service' },
  { rel: 'packages/skill', name: '@mebular/skill' },
  { rel: 'packages/dsh-plugin', name: '@mebular/dsh-plugin' },
];

const INTERNAL = new Set(RELEASE_PACKAGES.map((pkg) => pkg.name));
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
const IS_VERSION_RANGE = /^\^?\d+\.\d+\.\d+/;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

function replaceOnce(text, pattern, replacement, label) {
  if (!pattern.test(text)) {
    throw new Error(`${label} 缺少可替换的版本号`);
  }
  return text.replace(pattern, replacement);
}

export function bumpVersion({
  root,
  version,
  tag = `v${version}`,
  date = new Date().toISOString().slice(0, 10),
  log = () => {},
}) {
  if (!SEMVER_RE.test(String(version))) {
    throw new Error(`版本号格式非法：${version}`);
  }

  const changes = [];
  let changedDeps = 0;

  // ---- 6 个可发布包 manifest + 内部依赖区间 ----
  for (const target of RELEASE_PACKAGES) {
    const file = join(root, target.rel, 'package.json');
    const pkg = readJson(file);
    if (pkg.name !== target.name) {
      throw new Error(`${target.rel}/package.json name=${pkg.name}，期望 ${target.name}`);
    }
    pkg.version = version;
    for (const field of DEP_FIELDS) {
      const deps = pkg[field];
      if (!deps) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (!INTERNAL.has(name)) continue;
        // 仅同步已成为版本号区间的内部依赖；file:/workspace: 留给本地 workspace / pack 期改写。
        if (IS_VERSION_RANGE.test(String(spec))) {
          deps[name] = `^${version}`;
          changedDeps += 1;
        }
      }
    }
    writeJson(file, pkg);
    changes.push(`${target.rel}/package.json -> ${version}`);
    log(`  version -> ${version}  ${target.name}`);
  }

  // ---- 根 package-lock（workspace 成员版本也是 lock 的一部分） ----
  const rootLockFile = join(root, 'package-lock.json');
  if (existsSync(rootLockFile)) {
    const lock = readJson(rootLockFile);
    lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    for (const target of RELEASE_PACKAGES) {
      if (target.rel === '.') continue;
      const entry = lock.packages?.[target.rel];
      if (entry && entry.name === target.name) entry.version = version;
    }
    writeJson(rootLockFile, lock);
    changes.push(`package-lock.json -> ${version}`);
    log(`  version -> ${version}  package-lock.json`);
  } else {
    log('  WARN: package-lock.json 不存在，跳过（发布前请确认 npm ci 可用）');
  }

  // ---- 桌面 App：package.json + package-lock 根 version + main 进程 APP_VERSION ----
  const desktopPackageFile = join(root, 'apps/desktop/package.json');
  if (!existsSync(desktopPackageFile)) {
    throw new Error('apps/desktop/package.json 不存在');
  }
  const desktopPackage = readJson(desktopPackageFile);
  if (desktopPackage.name !== '@mebular/desktop') {
    throw new Error(`apps/desktop/package.json name=${desktopPackage.name}，期望 @mebular/desktop`);
  }
  desktopPackage.version = version;
  writeJson(desktopPackageFile, desktopPackage);
  changes.push(`apps/desktop/package.json -> ${version}`);
  log(`  version -> ${version}  apps/desktop/package.json`);

  const desktopLockFile = join(root, 'apps/desktop/package-lock.json');
  if (!existsSync(desktopLockFile)) {
    throw new Error('apps/desktop/package-lock.json 不存在');
  }
  const desktopLock = readJson(desktopLockFile);
  desktopLock.version = version;
  if (desktopLock.packages?.['']) desktopLock.packages[''].version = version;
  writeJson(desktopLockFile, desktopLock);
  changes.push(`apps/desktop/package-lock.json -> ${version}`);
  log(`  version -> ${version}  apps/desktop/package-lock.json`);

  const desktopDaemon = join(root, 'apps', 'desktop', 'src', 'main', 'daemon.mjs');
  if (!existsSync(desktopDaemon)) {
    throw new Error('apps/desktop/src/main/daemon.mjs 不存在');
  }
  const daemonBefore = readFileSync(desktopDaemon, 'utf8');
  const daemonAfter = replaceOnce(
    daemonBefore,
    /(export const APP_VERSION = ')[^']+(';)/,
    `$1${version}$2`,
    'apps/desktop/src/main/daemon.mjs',
  );
  if (daemonAfter === daemonBefore) {
    log(`  APP_VERSION 已是 ${version}，跳过`);
  } else {
    writeFileSync(desktopDaemon, daemonAfter, 'utf8');
    changes.push(`apps/desktop/src/main/daemon.mjs APP_VERSION -> ${version}`);
    log(`  APP_VERSION -> ${version}  apps/desktop/src/main/daemon.mjs`);
  }

  // ---- MCP 对外版本唯一真源 ----
  const mcpVersionFile = join(root, 'packages/mcp/src/version.mjs');
  if (!existsSync(mcpVersionFile)) {
    throw new Error('packages/mcp/src/version.mjs 不存在；MCP 版本必须走单一真源');
  }
  const mcpBefore = readFileSync(mcpVersionFile, 'utf8');
  const mcpAfter = replaceOnce(
    mcpBefore,
    /(export const APP_VERSION = ')[^']+(';)/,
    `$1${version}$2`,
    'packages/mcp/src/version.mjs',
  );
  if (mcpAfter === mcpBefore) {
    log(`  MCP APP_VERSION 已是 ${version}，跳过`);
  } else {
    writeFileSync(mcpVersionFile, mcpAfter, 'utf8');
    changes.push(`packages/mcp/src/version.mjs APP_VERSION -> ${version}`);
    log(`  MCP APP_VERSION -> ${version}  packages/mcp/src/version.mjs`);
  }

  // ---- CHANGELOG 章节占位 ----
  const clFile = join(root, 'CHANGELOG.md');
  const HEADER =
    '# Changelog\n\nAll notable changes to Mebular are documented here.\nAll published packages share a single release version.\n';
  let text = existsSync(clFile) ? readFileSync(clFile, 'utf8') : HEADER;
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^## \\[${escapedTag}\\]`, 'm').test(text)) {
    log(`  CHANGELOG 已存在 [${tag}] 章节，跳过`);
  } else {
    const block =
      `## [${tag}] - ${date}\n\n` +
      '### Added\n\n- _TODO_\n\n' +
      '### Changed\n\n- _TODO_\n\n' +
      '### Fixed\n\n- _TODO_\n';
    const lines = text.split('\n');
    const idx = lines.findIndex((line) => line.startsWith('## ['));
    if (idx === -1) {
      text = `${text.replace(/\s*$/, '')}\n\n${block}\n`;
    } else {
      // 在首个 `## [` 之前插入新章节，并保留与旧章节之间的空行。
      lines.splice(idx, 0, block.replace(/\n$/, ''), '');
      text = lines.join('\n');
    }
    writeFileSync(clFile, text, 'utf8');
    changes.push(`CHANGELOG.md + [${tag}]`);
    log(`  CHANGELOG 新增 [${tag}] 章节占位`);
  }

  log(`  内部依赖版本号同步：${changedDeps} 处（file: 本地依赖由 pack 期改写）`);
  return { version, tag, changes, changedDeps };
}

function parseArgs(argv) {
  const options = {
    root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    version: undefined,
    tag: undefined,
    date: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--root') {
      options.root = resolve(argv[++i] ?? '');
    } else if (arg === '--version') {
      options.version = argv[++i];
    } else if (arg === '--tag') {
      options.tag = argv[++i];
    } else if (arg === '--date') {
      options.date = argv[++i];
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function usage() {
  return '用法：node scripts/bump-version.mjs --root <repo> --version <x.y.z> [--tag vx.y.z] [--date YYYY-MM-DD]';
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`错误：${error.message}`);
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.version) {
    console.error('错误：缺少 --version');
    console.error(usage());
    return 2;
  }
  const version = String(options.version).replace(/^v/, '');
  try {
    const result = bumpVersion({
      root: options.root,
      version,
      tag: options.tag ?? `v${version}`,
      date: options.date,
      log: (line) => console.log(line),
    });
    console.log(
      `✓ 已同步为 ${result.tag}（6 个 npm 包 + 根 lock + 桌面 App + MCP 版本源 + CHANGELOG）`,
    );
    return 0;
  } catch (error) {
    console.error(`错误：${error.message}`);
    return 1;
  }
}

const invokedAsScript = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invokedAsScript) {
  process.exitCode = await main(process.argv.slice(2));
}
