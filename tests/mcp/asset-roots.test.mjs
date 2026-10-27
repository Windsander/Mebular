import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveStaticAssetRoots } from '../../packages/mcp/src/asset-roots.mjs';

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function createModule(root, standalone) {
  const modulePath = standalone
    ? join(root, 'node_modules', '@mebular', 'mcp', 'src', 'serve.mjs')
    : join(root, 'node_modules', '@mebular', 'core', 'packages', 'mcp', 'src', 'serve.mjs');
  mkdirSync(dirname(modulePath), { recursive: true });
  writeFileSync(modulePath, '// fixture\n', 'utf-8');
  return pathToFileURL(modulePath).href;
}
function createCoreAssets(root) {
  const consoleDir = join(root, 'node_modules', '@mebular', 'core', 'packages', 'console');
  const localesDir = join(root, 'node_modules', '@mebular', 'core', 'locales');
  mkdirSync(consoleDir, { recursive: true });
  mkdirSync(localesDir, { recursive: true });
  writeFileSync(join(consoleDir, 'index.html'), '<!doctype html>\n', 'utf-8');
  writeFileSync(join(localesDir, 'manifest.json'), '{}\n', 'utf-8');
  return { consoleDir, localesDir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveStaticAssetRoots：core 内嵌与 standalone MCP', () => {
  it('core 内嵌直接使用 core/packages/console 与 core/locales', () => {
    const root = tempDir('asset-roots-core-');
    const assets = createCoreAssets(root);
    const roots = resolveStaticAssetRoots(createModule(root, false));
    expect(roots).toEqual(assets);
  });

  it('standalone MCP 回退到同一 core 包，而不是 @mebular/console 或 node_modules/locales', () => {
    const root = tempDir('asset-roots-standalone-');
    const assets = createCoreAssets(root);
    const roots = resolveStaticAssetRoots(createModule(root, true));
    expect(roots).toEqual(assets);
    expect(roots.consoleDir).not.toBe(join(root, 'node_modules', '@mebular', 'console'));
    expect(roots.localesDir).not.toBe(join(root, 'node_modules', 'locales'));
  });
});
