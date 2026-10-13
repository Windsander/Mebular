// Mebular 桌面 App · Electron 二进制解析（健壮：不依赖 postinstall 写出的 path.txt）
//
// 优先 `import('electron')`（正常安装）；失败时回退到 node_modules/electron/dist 的平台默认路径。

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export function electronDistDir() {
  return join(appDir, 'node_modules', 'electron', 'dist');
}

/** 返回可执行文件绝对路径，或 null（未安装/未下载）。 */
export async function resolveElectronBinary() {
  try {
    const require = createRequire(import.meta.url);
    const electronPath = require('electron');
    if (typeof electronPath === 'string' && existsSync(electronPath)) return electronPath;
  } catch {
    // 回退到 dist 默认布局
  }
  const rel = process.platform === 'darwin'
    ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
    : process.platform === 'win32'
      ? 'electron.exe'
      : 'electron';
  const fallback = join(electronDistDir(), rel);
  return existsSync(fallback) ? fallback : null;
}
