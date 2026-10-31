#!/usr/bin/env node
// 构建可下载的 Hermes 插件 Release 资产（不是 npm 包，也不发布 PyPI）。
//
//   npm run package:hermes
//   node scripts/package-hermes.mjs --out-dir dist/hermes
//
// 产物：dist/hermes/mebular-hermes-plugins-<version>.tar.gz
//
// 归档根目录（没有额外 wrapper 目录）：
//   mebular/                 <- integrations/hermes/mebular-memory（必须改名）
//   mebular-companion/       <- integrations/hermes/mebular-companion
//   install.sh
//   README.md
//   VERSION
//
// `mebular` 是 Hermes `memory.provider` 的值：Hermes 按目录名发现 provider，
// 因此不能把仓库目录名 `mebular-memory` 打进 tarball。

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const HERMES_PLUGINS = [
  { source: 'mebular-memory', target: 'mebular', name: 'mebular' },
  { source: 'mebular-companion', target: 'mebular-companion', name: 'mebular-companion' },
];

// Only these top-level plugin files ship. Anything else (tests, caches, local
// config, credentials) is deliberately left out.
const PLUGIN_FILES = ['README.md', '__init__.py', 'plugin.yaml'];
const SKIP_DIRS = new Set(['__pycache__', 'node_modules', 'tests', 'test']);

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const pluginVersion = (text) => {
  const match = /^version:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m.exec(text);
  return match ? match[1] : '';
};
const pluginName = (text) => {
  const match = /^name:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m.exec(text);
  return match ? match[1] : '';
};

function copyPlugin(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  for (const name of PLUGIN_FILES) {
    const source = join(sourceDir, name);
    if (!existsSync(source)) {
      throw new Error(`插件文件不存在：${relative(SCRIPT_ROOT, source)}`);
    }
    copyFileSync(source, join(targetDir, name));
  }
  // Copy any extra top-level regular files except caches/tests/credentials.
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      throw new Error(`插件目录包含未预期的子目录：${relative(SCRIPT_ROOT, join(sourceDir, entry.name))}`);
    }
    if (!entry.isFile()) continue;
    if (PLUGIN_FILES.includes(entry.name)) continue;
    if (/\.(?:pyc|pyo)$/.test(entry.name) || entry.name.startsWith('.')) continue;
    copyFileSync(join(sourceDir, entry.name), join(targetDir, entry.name));
  }
}

export function buildHermesPackage({ root = SCRIPT_ROOT, outDir = join(root, 'dist', 'hermes') } = {}) {
  const rootManifest = readJson(join(root, 'package.json'));
  const version = String(rootManifest.version ?? '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`根 package.json 版本非法：${version}`);
  }

  const sourceRoot = join(root, 'integrations', 'hermes');
  for (const plugin of HERMES_PLUGINS) {
    const manifestFile = join(sourceRoot, plugin.source, 'plugin.yaml');
    if (!existsSync(manifestFile)) {
      throw new Error(`缺少 ${relative(root, manifestFile)}`);
    }
    const yaml = readFileSync(manifestFile, 'utf8');
    const name = pluginName(yaml);
    if (name !== plugin.name) {
      throw new Error(`${relative(root, manifestFile)} name=${name}，期望 ${plugin.name}`);
    }
    const found = pluginVersion(yaml);
    if (found !== version) {
      throw new Error(`${relative(root, manifestFile)} version=${found}，与根版本 ${version} 不一致`);
    }
  }

  const filename = `mebular-hermes-plugins-${version}.tar.gz`;
  const tarball = join(outDir, filename);
  const staging = mkdtempSync(join(tmpdir(), 'mebular-hermes-package-'));
  try {
    for (const plugin of HERMES_PLUGINS) {
      copyPlugin(join(sourceRoot, plugin.source), join(staging, plugin.target));
    }

    const installSource = join(sourceRoot, 'install.sh');
    if (!existsSync(installSource)) throw new Error('缺少 integrations/hermes/install.sh');
    copyFileSync(installSource, join(staging, 'install.sh'));
    chmodSync(join(staging, 'install.sh'), 0o755);

    const readme = join(sourceRoot, 'README.md');
    if (!existsSync(readme)) throw new Error('缺少 integrations/hermes/README.md');
    copyFileSync(readme, join(staging, 'README.md'));
    writeFileSync(join(staging, 'VERSION'), `${version}\n`, 'utf8');

    mkdirSync(outDir, { recursive: true });
    rmSync(tarball, { force: true });
    execFileSync(
      'tar',
      [
        '-czf',
        tarball,
        '-C',
        staging,
        ...HERMES_PLUGINS.map((plugin) => plugin.target),
        'install.sh',
        'README.md',
        'VERSION',
      ],
      { env: { ...process.env, COPYFILE_DISABLE: '1' } },
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return {
    version,
    filename,
    tarball,
    bytes: statSync(tarball).size,
  };
}

function parseArgs(argv) {
  const options = {
    root: SCRIPT_ROOT,
    outDir: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--root') {
      options.root = resolve(argv[++i] ?? '');
    } else if (arg === '--out-dir') {
      options.outDir = resolve(argv[++i] ?? '');
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function usage() {
  return '用法：node scripts/package-hermes.mjs [--root <repo>] [--out-dir <dir>] [--json]';
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

  try {
    const result = buildHermesPackage({
      root: options.root,
      outDir: options.outDir ?? join(options.root, 'dist', 'hermes'),
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const kib = (result.bytes / 1024).toFixed(1);
      console.log(`✓ ${relative(options.root, result.tarball)}（${kib} KiB）`);
      console.log('  内容：mebular/ mebular-companion/ install.sh README.md VERSION');
    }
    return 0;
  } catch (error) {
    console.error(`✗ Hermes 插件打包失败：${error.message}`);
    return 1;
  }
}

const invokedAsScript = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invokedAsScript) {
  process.exitCode = await main(process.argv.slice(2));
}
