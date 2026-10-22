// Mebular 桌面 App · 准备构建产物：确保仓库既有产物存在（不重复构建）
//
// App 只编排、不复制逻辑：需要 dist/（core）、packages/{mcp,service,fleet,console,skill}。
// 缺失时调用仓库根 `npm run build`。

import { existsSync, readFileSync } from 'node:fs';
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

const missing = required.filter((p) => !existsSync(p));
if (missing.length === 0) {
  console.log('[desktop] 构建产物已就绪');
} else {
  console.log(`[desktop] 缺少构建产物（${missing.length}），先执行仓库根 npm run build…`);
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
}

// fleet 的 QR 运行时依赖；extraResources 会从根 node_modules 复制到 App。
const qrEncoder = join(root, 'node_modules', 'qrcode-generator', 'package.json');
if (!existsSync(qrEncoder)) {
  console.error('[desktop] 缺少 node_modules/qrcode-generator（fleet QR 运行时依赖）：请先 npm install');
  process.exit(1);
}

// locale pack 是运行时数据（extraResources → <resources>/locales），构建前校验 manifest + 文件齐全。
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
