// Mebular 桌面 App · 准备构建产物：确保仓库既有产物存在（不重复构建）
//
// App 只编排、不复制逻辑：需要 dist/（core）、packages/{mcp,service,fleet,console,skill}。
// 缺失时调用仓库根 `npm run build`。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');

const required = [
  join(root, 'dist', 'index.js'),
  join(root, 'packages', 'service', 'dist', 'index.js'),
  join(root, 'packages', 'fleet', 'dist', 'cli.js'),
];

// Windows 不能直接 execFile('npm.cmd')；通过 npm run 调用时优先走 npm-cli.js，
// 直接调用时退回 npm.cmd（与 prepare-runtime.mjs 的 runNpm 保持一致）。
function runRepoBuild() {
  const npmExecPath = process.env.npm_execpath;
  if (typeof npmExecPath === 'string' && npmExecPath.endsWith('.js')) {
    execFileSync(process.execPath, [npmExecPath, 'run', 'build'], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
    return;
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
}

const missing = required.filter((p) => !existsSync(p));
if (missing.length === 0) {
  console.log('[desktop] 构建产物已就绪');
} else {
  console.log(`[desktop] 缺少构建产物（${missing.length}），先执行仓库根 npm run build…`);
  runRepoBuild();
}

// fleet 的 QR 运行时依赖；开发态从仓库 node_modules 解析（打包态由 runtime 自带）。
const qrEncoder = join(root, 'node_modules', 'qrcode-generator', 'package.json');
if (!existsSync(qrEncoder)) {
  console.error('[desktop] 缺少 node_modules/qrcode-generator（开发态 fleet QR 运行时依赖）：请先 npm install');
  process.exit(1);
}

// 开发态 locale pack 从仓库 locales/ 读取（打包态由 runtime 内 @mebular/core/locales 提供）。
const localesManifestPath = join(root, 'locales', 'manifest.json');
if (!existsSync(localesManifestPath)) {
  console.error('[desktop] 缺少 locales/manifest.json（locale pack 数据层）');
  process.exit(1);
}
try {
  const manifest = JSON.parse(readFileSync(localesManifestPath, 'utf-8'));
  const missingPacks = [];
  for (const entry of Array.isArray(manifest.locales) ? manifest.locales : []) {
    for (const relative of Object.values(entry.files ?? {})) {
      if (typeof relative !== 'string') continue;
      if (!existsSync(join(root, 'locales', relative))) missingPacks.push(relative);
    }
  }
  if (missingPacks.length > 0) {
    console.error(`[desktop] locale pack 文件缺失：${missingPacks.join(', ')}`);
    process.exit(1);
  }
  console.log(`[desktop] locale packs 已就绪（${manifest.locales?.length ?? 0} 个语言）`);
} catch (error) {
  console.error(`[desktop] locales/manifest.json 无法解析：${String(error?.message ?? error)}`);
  process.exit(1);
}

// Adapter 源目录在 monorepo 根，electron-builder 的 `from` 必须位于桌面项目目录内。
// 先 staging 到 apps/desktop/build/adapters/，再由 electron-builder 放进 App bundle。
// 版本 lockstep 由各 adapter 的 manifest 提供，运行时不联网下载。
const ADAPTER_BUNDLES = [
  { source: join(root, 'packages', 'opencode-plugin'), target: join(here, '..', 'build', 'adapters', 'opencode-plugin') },
  { source: join(root, 'packages', 'dsh-plugin'), target: join(here, '..', 'build', 'adapters', 'dsh-plugin') },
  { source: join(root, 'integrations', 'hermes', 'mebular-memory'), target: join(here, '..', 'build', 'adapters', 'hermes') },
];
const skipAdapterArtifact = (source) => {
  const name = source.split(/[\\/]/).pop() ?? '';
  return name !== 'node_modules'
    && name !== '.git'
    && name !== '__pycache__'
    && !name.endsWith('.pyc')
    && !name.endsWith('.pyo');
};
for (const bundle of ADAPTER_BUNDLES) {
  if (!existsSync(bundle.source)) {
    console.error(`[desktop] 缺少 adapter 源目录：${bundle.source}`);
    process.exit(1);
  }
  rmSync(bundle.target, { recursive: true, force: true });
  mkdirSync(dirname(bundle.target), { recursive: true });
  cpSync(bundle.source, bundle.target, { recursive: true, filter: skipAdapterArtifact });
}
console.log(`[desktop] adapter bundles 已就绪（${ADAPTER_BUNDLES.length} 个）`);
