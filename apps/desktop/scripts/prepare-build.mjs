// Mebular 桌面 App · 准备构建产物：确保仓库既有产物存在（不重复构建）
//
// App 只编排、不复制逻辑：需要 dist/（core）、packages/{mcp,service,fleet,console,skill}。
// 缺失时调用仓库根 `npm run build`。

import { existsSync } from 'node:fs';
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
