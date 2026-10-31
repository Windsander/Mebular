#!/usr/bin/env node
// @mebular/opencode-plugin 发布验证（npm pack + 干净目录安装 + 静态入口检查）。
//
// 1) 对 packages/opencode-plugin 执行 npm pack，检查 tarball 只含发布文件、
//    无测试/源码外大文件、无 file:/workspace: 依赖、无凭据泄漏。
// 2) 在干净临时目录 npm install 该 tarball，验证 package.json 可解析、exports 指向的
//    入口存在，并以包名 `@mebular/opencode-plugin` 动态导入默认导出。
//
// 本脚本不启动 OpenCode、不访问 OpenCode 网络，也不读取真实 ~/.mebular。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const pluginDir = join(rootDir, 'packages', 'opencode-plugin');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const ALLOWED_FILES = new Set([
  'package/package.json',
  'package/index.js',
  'package/README.md',
  'package/LICENSE',
]);
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TARBALL_BYTES = 512 * 1024;
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
const SECRET_PATTERNS = [
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{20,}\b/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i],
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
const manifestOf = (tgz) => JSON.parse(readTarballFile(tgz, 'package/package.json'));

function walkFiles(dir) {
  const out = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) out.push(relative(dir, absolute).split('\\').join('/'));
    }
  };
  visit(dir);
  return out.sort();
}

console.log('Mebular @mebular/opencode-plugin 发布验证（npm pack + tarball 安装）');
console.log('===================================================================');

const work = await mkdtemp(join(tmpdir(), 'mebular-opencode-publish-'));
try {
  // ---------- npm pack ----------
  const packOut = execFileSync(npm, ['pack', '--json', '--pack-destination', work], {
    cwd: pluginDir,
    encoding: 'utf-8',
    env: process.env,
  });
  const meta = JSON.parse(packOut)[0];
  const tarball = join(work, meta.filename);
  check(
    '@mebular/opencode-plugin npm pack',
    meta.name === '@mebular/opencode-plugin' && existsSync(tarball),
    `${meta.name}@${meta.version} -> ${relative(work, tarball)}`,
  );

  const manifest = manifestOf(tarball);
  const rootManifest = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf-8'));
  const packageManifest = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf-8'));
  const version = packageManifest.version;
  check('tarball 版本与 lockstep SSOT 一致', manifest.version === version && version === rootManifest.version, `${manifest.version} / root ${rootManifest.version}`);
  check('tarball 名称正确', manifest.name === '@mebular/opencode-plugin', manifest.name);
  check('tarball main = index.js', manifest.main === 'index.js', manifest.main);
  check(
    'tarball exports["."] 指向 index.js',
    (typeof manifest.exports?.['.'] === 'string' && manifest.exports['.'] === './index.js')
      || manifest.exports?.['.']?.import === './index.js',
    JSON.stringify(manifest.exports?.['.']),
  );

  // 内部依赖必须是版本号引用；OpenCode 插件当前应完全无依赖。
  const depSpecs = DEP_FIELDS.flatMap((field) =>
    Object.entries(manifest[field] ?? {}).map(([name, spec]) => ({ field, name, spec: String(spec) })),
  );
  const nonRange = depSpecs.filter(({ spec }) => spec.startsWith('file:') || spec.startsWith('workspace:'));
  check('tarball 无 file:/workspace: 依赖', nonRange.length === 0, nonRange.map((dep) => `${dep.field}:${dep.name}`).join(', '));
  check('tarball 无运行时依赖（HTTP 薄客户端）', depSpecs.length === 0, depSpecs.map((dep) => `${dep.field}:${dep.name}`).join(', '));

  // 文件集合与大小：只允许 package.json / index.js / README / LICENSE。
  const files = listTarball(tarball);
  const unexpected = files.filter((file) => !ALLOWED_FILES.has(file));
  const missing = [...ALLOWED_FILES].filter((file) => !files.includes(file));
  check('tarball 只含发布文件（package.json/index.js/README/LICENSE）', unexpected.length === 0 && missing.length === 0, [
    unexpected.length > 0 ? `多余 ${unexpected.join(', ')}` : '',
    missing.length > 0 ? `缺少 ${missing.join(', ')}` : '',
  ].filter(Boolean).join('；'));

  const extractDir = join(work, 'files');
  await mkdir(extractDir, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', extractDir], { env: process.env });
  const extracted = walkFiles(extractDir);
  const oversized = extracted.filter((file) => statSync(join(extractDir, file)).size > MAX_FILE_BYTES);
  check('tarball 无超过 256 KiB 的单文件', oversized.length === 0, oversized.join(', '));
  const totalBytes = extracted.reduce((sum, file) => sum + statSync(join(extractDir, file)).size, 0);
  check(
    `tarball 总体积 <= 512 KiB`,
    totalBytes <= MAX_TARBALL_BYTES,
    `${(totalBytes / 1024).toFixed(1)} KiB`,
  );

  // 凭据扫描：环境里的 token 与常见密钥格式都不得出现在 tarball 文本中。
  const text = extracted.map((file) => readTarballFile(tarball, file)).join('\n');
  const envTokenNames = ['MEBULAR_MEMORY_RUNTIME_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'GITHUB_TOKEN'];
  const envLeaks = envTokenNames.filter((name) => {
    const value = String(process.env[name] ?? '').trim();
    return value.length >= 8 && text.includes(value);
  });
  const secretLeaks = SECRET_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
  check('tarball 无环境 token 泄漏', envLeaks.length === 0, envLeaks.join(', '));
  check('tarball 无常见凭据格式', secretLeaks.length === 0, secretLeaks.join(', '));

  // ---------- 干净目录安装 ----------
  const app = join(work, 'app');
  await mkdir(app, { recursive: true });
  await writeFile(
    join(app, 'package.json'),
    '{"name":"mebular-opencode-publish-smoke","private":true,"version":"0.0.0"}\n',
    'utf-8',
  );
  execFileSync(
    npm,
    ['install', tarball, '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'],
    { cwd: app, stdio: ['ignore', 'ignore', 'inherit'], env: process.env },
  );

  const installedDir = join(app, 'node_modules', '@mebular', 'opencode-plugin');
  const installedManifest = JSON.parse(await readFile(join(installedDir, 'package.json'), 'utf-8'));
  check(`tarball 安装：@mebular/opencode-plugin@${version}`, installedManifest.version === version, installedManifest.version);
  check('tarball 安装：入口 index.js 存在', existsSync(join(installedDir, 'index.js')));
  check('tarball 安装：README/LICENSE 存在', existsSync(join(installedDir, 'README.md')) && existsSync(join(installedDir, 'LICENSE')));

  const probe = [
    "const mod = await import('@mebular/opencode-plugin');",
    'const def = mod.default;',
    'console.log(JSON.stringify({',
    '  pluginId: mod.PLUGIN_ID,',
    '  packageName: mod.PACKAGE_NAME,',
    '  packageVersion: mod.PACKAGE_VERSION,',
    '  hasDefault: Boolean(def),',
    '  setup: typeof def?.setup,',
    '  id: def?.id,',
    '}));',
  ].join('\n');
  const probeOut = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: app,
    encoding: 'utf-8',
    env: { ...process.env, MEBULAR_HOME: join(work, 'home') },
  }));
  check('安装后按包名导入可解析（exports）', probeOut.packageName === '@mebular/opencode-plugin', probeOut.packageName);
  check(`安装后 PACKAGE_VERSION=${version}`, probeOut.packageVersion === version, probeOut.packageVersion);
  check('安装后默认导出含 setup（OpenCode 插件入口）', probeOut.hasDefault === true && probeOut.setup === 'function' && probeOut.id === 'mebular.memory', JSON.stringify(probeOut));
} catch (error) {
  check('@mebular/opencode-plugin 发布验证', false, String(error?.stderr ?? error?.message ?? error).substring(0, 500));
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}

console.log('===================================================================');
if (passed) {
  console.log('✓ verify:opencode:publish 通过');
  process.exit(0);
} else {
  console.log('✗ verify:opencode:publish 失败');
  process.exit(1);
}
