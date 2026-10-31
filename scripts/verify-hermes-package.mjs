#!/usr/bin/env node
// 校验 Hermes 插件 Release tarball：打包 → 解压 → 安装 → 语法/入口 → 备份 → 失败原子性。
//
//   npm run verify:hermes:package
//   node scripts/verify-hermes-package.mjs
//
// 默认完全离线：不访问网络、不启动 Hermes、不读写真实 ~/.hermes。

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHermesPackage, HERMES_PLUGINS } from './package-hermes.mjs';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_FILES = new Set([
  'mebular/README.md',
  'mebular/__init__.py',
  'mebular/plugin.yaml',
  'mebular-companion/README.md',
  'mebular-companion/__init__.py',
  'mebular-companion/plugin.yaml',
  'install.sh',
  'README.md',
  'VERSION',
]);

const SECRET_PATTERNS = [
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{20,}\b/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i],
  ['literal password/secret', /["']?(?:password|secret|api[_-]?key)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i],
];

let passed = true;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) passed = false;
};

const listTarball = (tgz) =>
  execFileSync('tar', ['-tzf', tgz], { encoding: 'utf-8' })
    .split('\n')
    .filter((entry) => entry.length > 0 && !entry.endsWith('/'));
const readTarballFile = (tgz, inner) =>
  execFileSync('tar', ['-xzf', tgz, '-O', inner], { encoding: 'utf-8' });
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const yamlScalar = (text, key) => {
  const match = new RegExp(`^${key}:\\s*["']?([^"'\\s#]+)["']?\\s*(?:#.*)?$`, 'm').exec(text);
  return match ? match[1] : '';
};

async function runInstallScript(script, hermesHome) {
  const result = spawnSync('sh', [script], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HERMES_HOME: hermesHome,
      PYTHONPYCACHEPREFIX: join(hermesHome, '.pycache'),
    },
  });
  return result;
}

function pythonProbe(script, file) {
  return JSON.parse(
    execFileSync('python3', ['-c', script, file], {
      encoding: 'utf-8',
      env: { ...process.env, PYTHONPYCACHEPREFIX: join(tmpdir(), 'mebular-hermes-pycache') },
    }),
  );
}

const PROVIDER_PROBE = [
  'import importlib.util, json, sys',
  'path = sys.argv[1]',
  'spec = importlib.util.spec_from_file_location("mebular", path)',
  'module = importlib.util.module_from_spec(spec)',
  'sys.modules["mebular"] = module',
  'spec.loader.exec_module(module)',
  'provider = getattr(module, "MebularMemoryProvider")',
  'assert issubclass(provider, module.MemoryProvider)',
  'assert module.MebularProvider is provider',
  'assert callable(getattr(module, "register"))',
  'print(json.dumps({"provider": provider.__name__, "register": True}))',
].join('\n');

const COMPANION_PROBE = [
  'import importlib.util, json, sys',
  'path = sys.argv[1]',
  'spec = importlib.util.spec_from_file_location("mebular_companion", path)',
  'module = importlib.util.module_from_spec(spec)',
  'sys.modules["mebular_companion"] = module',
  'spec.loader.exec_module(module)',
  'assert callable(getattr(module, "MebularCompanion"))',
  'assert callable(getattr(module, "register"))',
  'print(json.dumps({"plugin": "MebularCompanion", "register": True}))',
].join('\n');

console.log('Mebular Hermes 插件包验证（tarball / 安装 / Python 入口 / 备份）');
console.log('===============================================================');

const work = await mkdtemp(join(tmpdir(), 'mebular-hermes-verify-'));
try {
  const rootManifest = JSON.parse(await readFile(join(SCRIPT_ROOT, 'package.json'), 'utf-8'));
  const version = rootManifest.version;
  const built = buildHermesPackage({ root: SCRIPT_ROOT, outDir: join(work, 'dist') });
  check('构建 Hermes tarball', existsSync(built.tarball) && built.bytes > 0, relative(work, built.tarball));
  check('tarball 文件名与根版本一致', built.filename === `mebular-hermes-plugins-${version}.tar.gz`, built.filename);
  check('tarball 版本与根 package.json 一致', built.version === version, `${built.version} / ${version}`);

  // ---------- 归档清单 ----------
  const files = listTarball(built.tarball);
  const missing = [...EXPECTED_FILES].filter((file) => !files.includes(file));
  const unexpected = files.filter((file) => !EXPECTED_FILES.has(file));
  check('tarball 含全部发布文件', missing.length === 0, missing.join(', '));
  check('tarball 无多余文件', unexpected.length === 0, unexpected.join(', '));
  check(
    'memory provider 目录名为 mebular（不是 mebular-memory）',
    files.some((file) => file.startsWith('mebular/'))
      && !files.some((file) => file.startsWith('mebular-memory/')),
  );
  check(
    '无 __pycache__ / .pyc / 测试 / node_modules',
    !files.some((file) => /(?:^|\/)(?:__pycache__|node_modules|tests?)(?:\/|$)/.test(file))
      && !files.some((file) => /\.(?:pyc|pyo)$/.test(file)),
  );
  check(
    '归档成员均为相对路径（无绝对路径/..）',
    files.every(
      (file) =>
        !file.startsWith('/')
        && !/^[A-Za-z]:/.test(file)
        && !file.split('/').includes('..'),
    ),
  );

  const text = files.map((file) => readTarballFile(built.tarball, file)).join('\n');
  check('VERSION 内容与根版本一致', readTarballFile(built.tarball, 'VERSION').trim() === version);

  for (const plugin of HERMES_PLUGINS) {
    const yaml = readTarballFile(built.tarball, `${plugin.target}/plugin.yaml`);
    check(
      `${plugin.target}/plugin.yaml name/version 正确`,
      yamlScalar(yaml, 'name') === plugin.name && yamlScalar(yaml, 'version') === version,
      `${yamlScalar(yaml, 'name')}@${yamlScalar(yaml, 'version')}`,
    );
  }

  const envTokenNames = ['MEBULAR_MEMORY_RUNTIME_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'GITHUB_TOKEN'];
  const envLeaks = envTokenNames.filter((name) => {
    const value = String(process.env[name] ?? '').trim();
    return value.length >= 8 && text.includes(value);
  });
  const secretLeaks = SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  check('tarball 无环境 token 泄漏', envLeaks.length === 0, envLeaks.join(', '));
  check('tarball 无常见凭据格式', secretLeaks.length === 0, secretLeaks.join(', '));

  const absolutePathPatterns = [
    ['仓库绝对路径', new RegExp(escapeRegExp(SCRIPT_ROOT))],
    ['macOS 用户目录', /\/Users\/[A-Za-z0-9._-]+\//],
    ['Linux 用户目录', /\/home\/[A-Za-z0-9._-]+\//],
    ['Windows 用户目录', /[A-Za-z]:\\Users\\/],
  ];
  const absoluteLeaks = absolutePathPatterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
  check('tarball 无本机绝对路径', absoluteLeaks.length === 0, absoluteLeaks.join(', '));

  // ---------- 解压并安装 ----------
  const bundleDir = join(work, 'bundle');
  const hermesHome = join(work, 'hermes-home');
  await mkdir(bundleDir, { recursive: true });
  execFileSync('tar', ['-xzf', built.tarball, '-C', bundleDir], { env: process.env });
  const installScript = join(bundleDir, 'install.sh');
  check('install.sh 可执行位', (statSync(installScript).mode & 0o111) !== 0);

  await mkdir(hermesHome, { recursive: true });
  await writeFile(join(hermesHome, 'MEMORY.md'), 'hermes built-in memory\n', 'utf-8');
  await writeFile(join(hermesHome, 'USER.md'), 'hermes built-in user profile\n', 'utf-8');

  const first = await runInstallScript(installScript, hermesHome);
  check('install.sh 首次安装退出 0', first.status === 0, String(first.stderr ?? '').trim().slice(0, 300));
  check(
    'install.sh 打印下一步 memory.provider',
    String(first.stdout).includes('hermes config set memory.provider mebular'),
  );
  check(
    'install.sh 说明内置 MEMORY.md / USER.md 不受影响',
    String(first.stdout).includes('MEMORY.md') && String(first.stdout).includes('USER.md'),
  );
  check(
    'install.sh 不修改内置 MEMORY.md / USER.md',
    (await readFile(join(hermesHome, 'MEMORY.md'), 'utf-8')) === 'hermes built-in memory\n'
      && (await readFile(join(hermesHome, 'USER.md'), 'utf-8')) === 'hermes built-in user profile\n',
  );

  const pluginsDir = join(hermesHome, 'plugins');
  for (const plugin of HERMES_PLUGINS) {
    const dir = join(pluginsDir, plugin.target);
    check(
      `安装后 ${plugin.target}/plugin.yaml 与 __init__.py 存在`,
      existsSync(join(dir, 'plugin.yaml')) && existsSync(join(dir, '__init__.py')),
    );
  }

  // ---------- Python 语法与入口 ----------
  for (const plugin of HERMES_PLUGINS) {
    const result = spawnSync('python3', ['-m', 'py_compile', join(pluginsDir, plugin.target, '__init__.py')], {
      encoding: 'utf-8',
      env: { ...process.env, PYTHONPYCACHEPREFIX: join(work, '.pycache') },
    });
    check(`${plugin.target}/__init__.py py_compile`, result.status === 0, String(result.stderr ?? '').trim().slice(0, 300));
  }

  const providerProbe = pythonProbe(PROVIDER_PROBE, join(pluginsDir, 'mebular', '__init__.py'));
  check(
    'mebular 模块可导入（MemoryProvider / register）',
    providerProbe.provider === 'MebularMemoryProvider' && providerProbe.register === true,
    JSON.stringify(providerProbe),
  );
  const companionProbe = pythonProbe(COMPANION_PROBE, join(pluginsDir, 'mebular-companion', '__init__.py'));
  check(
    'mebular-companion 模块可导入（register）',
    companionProbe.plugin === 'MebularCompanion' && companionProbe.register === true,
    JSON.stringify(companionProbe),
  );

  // ---------- 重复安装：备份旧目录 ----------
  await writeFile(join(pluginsDir, 'mebular', 'old-marker.txt'), 'old-provider\n', 'utf-8');
  await writeFile(join(pluginsDir, 'mebular-companion', 'old-marker.txt'), 'old-companion\n', 'utf-8');
  const second = await runInstallScript(installScript, hermesHome);
  check('install.sh 重复安装退出 0', second.status === 0, String(second.stderr ?? '').trim().slice(0, 300));

  const entries = await readdir(pluginsDir);
  const providerBackups = entries.filter((name) => /^mebular\.bak-\d{8}-\d{6}/.test(name));
  const companionBackups = entries.filter((name) => /^mebular-companion\.bak-\d{8}-\d{6}/.test(name));
  check('重复安装生成 mebular .bak-<timestamp>', providerBackups.length === 1, providerBackups.join(', '));
  check(
    '重复安装生成 mebular-companion .bak-<timestamp>',
    companionBackups.length === 1,
    companionBackups.join(', '),
  );
  check(
    '旧 provider 目录内容保留在备份中',
    providerBackups.length === 1
      && existsSync(join(pluginsDir, providerBackups[0], 'old-marker.txt')),
  );
  check(
    '旧 companion 目录内容保留在备份中',
    companionBackups.length === 1
      && existsSync(join(pluginsDir, companionBackups[0], 'old-marker.txt')),
  );
  check(
    '新安装不含旧 marker（确实替换而非复用旧目录）',
    !existsSync(join(pluginsDir, 'mebular', 'old-marker.txt'))
      && !existsSync(join(pluginsDir, 'mebular-companion', 'old-marker.txt')),
  );
  check(
    '安装后无 staging 残留',
    entries.every((name) => !name.startsWith('.mebular-install.')),
    entries.filter((name) => name.startsWith('.mebular-install.')).join(', '),
  );

  // ---------- 失败时不部分安装 ----------
  const brokenBundle = join(work, 'broken-bundle');
  const brokenHome = join(work, 'broken-home');
  await cp(bundleDir, brokenBundle, { recursive: true });
  await rm(join(brokenBundle, 'mebular-companion'), { recursive: true, force: true });
  const broken = await runInstallScript(join(brokenBundle, 'install.sh'), brokenHome);
  check('install.sh 缺少源目录时非零退出', broken.status !== 0, `status=${broken.status}`);
  check(
    'install.sh 失败时未部分安装',
    !existsSync(join(brokenHome, 'plugins', 'mebular'))
      && !existsSync(join(brokenHome, 'plugins', 'mebular-companion')),
  );

  // ---------- 校验汇总 ----------
  console.log('===============================================================');
  if (passed) {
    console.log(`✓ verify:hermes:package 通过（${version}，离线）`);
  } else {
    console.log('✗ verify:hermes:package 失败');
    process.exitCode = 1;
  }
} catch (error) {
  check('Hermes 插件包验证', false, String(error?.stderr ?? error?.message ?? error).substring(0, 500));
  console.log('✗ verify:hermes:package 失败');
  process.exitCode = 1;
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}
