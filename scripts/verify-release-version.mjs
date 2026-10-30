#!/usr/bin/env node
// 发布版本 SSOT 校验（只读，可独立运行，也可在 dry-run / release-prep 分支上跑）。
//
//   node scripts/verify-release-version.mjs
//   node scripts/verify-release-version.mjs --version 0.2.0 --tag v0.2.0
//
// 校验：
//   - 7 个 package manifest（core / fleet / mcp / memory-runtime / service / skill / dsh-plugin）；
//   - 根 package-lock 与 7 个 workspace 条目；
//   - memory-runtime 的 @mebular/core 依赖可由 prepack 改写为版本区间（tarball 可安装）；
//   - apps/desktop package.json / package-lock / APP_VERSION；
//   - packages/mcp/src/version.mjs，以及 MCP 其它版本使用点不再手写版本号；
//   - CHANGELOG.md 含 `## [vX.Y.Z]` 章节。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_PACKAGES, SEMVER_RE } from './bump-version.mjs';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const readText = (file) => readFileSync(file, 'utf8');
const readJson = (file) => JSON.parse(readText(file));

export function verifyReleaseVersion({ root = SCRIPT_ROOT, version, tag = `v${version}` } = {}) {
  const checks = [];
  const add = (label, ok, detail = '') => {
    checks.push({ label, ok: Boolean(ok), detail: ok ? '' : String(detail ?? '') });
  };
  const safe = (label, fn) => {
    try {
      fn();
    } catch (error) {
      add(label, false, error.message);
    }
  };
  const releaseTag = String(tag).startsWith('v') ? String(tag) : `v${tag}`;

  if (!version || !SEMVER_RE.test(String(version))) {
    add('version 参数是合法 semver', false, String(version));
    return { ok: false, version, tag: releaseTag, checks };
  }

  // ---- 7 个可发布包 manifest ----
  for (const target of RELEASE_PACKAGES) {
    safe(`${target.name} manifest`, () => {
      const file = join(root, target.rel, 'package.json');
      if (!existsSync(file)) {
        add(`${target.name} manifest`, false, `${target.rel}/package.json 不存在`);
        return;
      }
      const pkg = readJson(file);
      add(`${target.name} name`, pkg.name === target.name, pkg.name);
      add(`${target.name} version`, pkg.version === version, `${pkg.version} != ${version}`);
    });
  }

  // ---- memory-runtime 发布依赖：源码可用 file: 链接，tarball 内必须是版本区间 ----
  safe('@mebular/memory-runtime 发布依赖', () => {
    const file = join(root, 'packages/memory-runtime/package.json');
    if (!existsSync(file)) {
      add('@mebular/memory-runtime 发布依赖', false, 'packages/memory-runtime/package.json 不存在');
      return;
    }
    const pkg = readJson(file);
    const coreSpec = String(pkg.dependencies?.['@mebular/core'] ?? '');
    const isRange = /^\^?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(coreSpec);
    const rewritesForPack =
      /publish-manifest\.mjs\s+set/.test(pkg.scripts?.prepack ?? '')
      && /publish-manifest\.mjs\s+restore/.test(pkg.scripts?.postpack ?? '');
    add(
      '@mebular/memory-runtime 的 @mebular/core 可随 tarball 安装',
      isRange || (coreSpec === 'file:../..' && rewritesForPack),
      `${coreSpec || '缺少依赖'}（需为版本区间，或 file:../.. + prepack/postpack 改写）`,
    );
  });

  // ---- 根 lockfile 与 workspace 条目 ----
  safe('package-lock.json', () => {
    const file = join(root, 'package-lock.json');
    if (!existsSync(file)) {
      add('package-lock.json', false, '不存在');
      return;
    }
    const lock = readJson(file);
    add('package-lock.json version', lock.version === version, `${lock.version} != ${version}`);
    add(
      'package-lock.json packages[""].version',
      lock.packages?.['']?.version === version,
      `${lock.packages?.['']?.version} != ${version}`,
    );
    for (const target of RELEASE_PACKAGES) {
      if (target.rel === '.') continue;
      const entry = lock.packages?.[target.rel];
      add(
        `package-lock.json ${target.rel} version`,
        entry?.version === version,
        entry ? `${entry.version} != ${version}` : '缺少 workspace 条目',
      );
    }
  });

  // ---- 桌面 App ----
  safe('apps/desktop/package.json', () => {
    const pkg = readJson(join(root, 'apps/desktop/package.json'));
    add('apps/desktop/package.json version', pkg.version === version, `${pkg.version} != ${version}`);
  });
  safe('apps/desktop/package-lock.json', () => {
    const file = join(root, 'apps/desktop/package-lock.json');
    if (!existsSync(file)) {
      add('apps/desktop/package-lock.json', false, '不存在');
      return;
    }
    const lock = readJson(file);
    add('apps/desktop/package-lock.json version', lock.version === version, `${lock.version} != ${version}`);
    add(
      'apps/desktop/package-lock.json packages[""].version',
      lock.packages?.['']?.version === version,
      `${lock.packages?.['']?.version} != ${version}`,
    );
  });
  safe('apps/desktop/src/main/daemon.mjs APP_VERSION', () => {
    const source = readText(join(root, 'apps/desktop/src/main/daemon.mjs'));
    const value = /export const APP_VERSION = '([^']+)'/.exec(source)?.[1];
    add('apps/desktop/src/main/daemon.mjs APP_VERSION', value === version, `${value} != ${version}`);
  });

  // ---- MCP 版本真源 ----
  safe('packages/mcp/src/version.mjs', () => {
    const file = join(root, 'packages/mcp/src/version.mjs');
    if (!existsSync(file)) {
      add('packages/mcp/src/version.mjs', false, '不存在');
      return;
    }
    const source = readText(file);
    const value = /export const APP_VERSION = '([^']+)'/.exec(source)?.[1];
    add('packages/mcp/src/version.mjs APP_VERSION', value === version, `${value} != ${version}`);
  });

  safe('packages/mcp/src/serve.mjs 版本来源', () => {
    const source = readText(join(root, 'packages/mcp/src/serve.mjs'));
    add(
      'packages/mcp/src/serve.mjs 从 version.mjs 导入 APP_VERSION',
      /import\s*\{[^}]*\bAPP_VERSION\b[^}]*\}\s*from\s*'\.\/version\.mjs'/.test(source),
    );
    add(
      'packages/mcp/src/serve.mjs 重新导出 APP_VERSION',
      /export\s*\{[^}]*\bAPP_VERSION\b[^}]*\}\s*from\s*'\.\/version\.mjs'/.test(source),
    );
    add(
      'packages/mcp/src/serve.mjs 不再手写 APP_VERSION',
      !/export const APP_VERSION = '\d+\.\d+\.\d+/.test(source),
    );
  });

  safe('packages/memory-runtime/src/sidecar/config.ts SIDECAR_RUNTIME_VERSION', () => {
    const file = join(root, 'packages/memory-runtime/src/sidecar/config.ts');
    if (!existsSync(file)) {
      add('packages/memory-runtime/src/sidecar/config.ts', false, '不存在');
      return;
    }
    const source = readText(file);
    const value = /export const SIDECAR_RUNTIME_VERSION = '([^']+)'/.exec(source)?.[1];
    add('packages/memory-runtime/src/sidecar/config.ts SIDECAR_RUNTIME_VERSION', value === version, `${value} != ${version}`);
  });

  for (const rel of ['packages/mcp/src/server.mjs', 'packages/mcp/src/client.mjs']) {
    safe(`${rel} 版本来源`, () => {
      const source = readText(join(root, rel));
      add(
        `${rel} 从 version.mjs 导入 APP_VERSION`,
        /import\s*\{[^}]*\bAPP_VERSION\b[^}]*\}\s*from\s*'\.\/version\.mjs'/.test(source),
      );
      add(
        `${rel} 不再手写 semver version`,
        !/(?:^|[^A-Za-z])version:\s*'\d+\.\d+\.\d+/.test(source),
      );
    });
  }

  safe('packages/mcp/scripts/publish-manifest.mjs 版本来源', () => {
    const source = readText(join(root, 'packages/mcp/scripts/publish-manifest.mjs'));
    add(
      'packages/mcp/scripts/publish-manifest.mjs 从 package.json 读取版本',
      /pkg\.version/.test(source),
    );
    add(
      'packages/mcp/scripts/publish-manifest.mjs 不再硬编码发布区间',
      !/PUBLISH_RANGE\s*=\s*'\^\d+\.\d+\.\d+/.test(source),
    );
  });

  // ---- CHANGELOG ----
  safe('CHANGELOG.md', () => {
    const file = join(root, 'CHANGELOG.md');
    if (!existsSync(file)) {
      add('CHANGELOG.md', false, '不存在');
      return;
    }
    const text = readText(file);
    add(
      `CHANGELOG.md 含 [${releaseTag}] 章节`,
      text.split('\n').some((line) => line.startsWith(`## [${releaseTag}]`)),
    );
  });

  return {
    ok: checks.every((check) => check.ok),
    version,
    tag: releaseTag,
    checks,
  };
}

function parseArgs(argv) {
  const options = { root: SCRIPT_ROOT, version: undefined, tag: undefined, json: false };
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
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function usage() {
  return '用法：node scripts/verify-release-version.mjs [--root <repo>] [--version <x.y.z>] [--tag vx.y.z] [--json]';
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
    try {
      options.version = readJson(join(options.root, 'package.json')).version;
    } catch (error) {
      console.error(`错误：无法读取根 package.json：${error.message}`);
      return 2;
    }
  }
  const result = verifyReleaseVersion({
    root: options.root,
    version: options.version,
    tag: options.tag ?? `v${options.version}`,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const check of result.checks) {
      console.log(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.label}${check.detail ? `（${check.detail}）` : ''}`);
    }
    console.log('== verify:release-version ==');
    console.log(result.ok ? `✓ ${result.tag} 版本 SSOT 一致` : `✗ ${result.tag} 版本 SSOT 不一致`);
  }
  return result.ok ? 0 : 1;
}

const invokedAsScript = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invokedAsScript) {
  process.exitCode = await main(process.argv.slice(2));
}
