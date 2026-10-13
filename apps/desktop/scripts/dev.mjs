// Mebular 桌面 App · 一键开发启动：准备构建产物 → 启动 Electron
//
// 用法：npm run dev [-- --home ~/.mebular] [-- --port 7331]
// （额外参数会透传给 Electron main 的 parseArgs）

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');

// 1) 准备构建产物（缺失则仓库根 build）
await import('./prepare-build.mjs');

// 2) 启动 Electron（健壮解析二进制；不依赖 postinstall 写出的 path.txt）
const { resolveElectronBinary } = await import('./electron-path.mjs');
const electronPath = await resolveElectronBinary();
if (!electronPath) {
  console.error('[desktop] 未找到 electron 二进制：请先在 apps/desktop 执行 npm install（或允许其 postinstall 下载）');
  process.exit(2);
}

const forwarded = process.argv.slice(2);
const child = spawn(electronPath, ['.', ...forwarded], { cwd: appDir, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
