// R1 桌面发布打包：打包态 CLI / locales 解析优先级 + 版本 SSOT。
// 不启动 Electron、不依赖 release-pack（用临时目录模拟 resources 布局）。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, repoRootFromModule, resolveCliBin } from '../../apps/desktop/src/main/daemon.mjs';
import { resolveLocalesDir } from '../../apps/desktop/src/main/i18n.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const desktopPackage = JSON.parse(readFileSync(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf-8'));
const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function touch(file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '// fixture\n', 'utf-8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('R1 版本 SSOT', () => {
  it('仓库根 / 桌面 package / APP_VERSION 三者一致', () => {
    expect(desktopPackage.version).toBe(rootPackage.version);
    expect(APP_VERSION).toBe(rootPackage.version);
  });

  it('repoRootFromModule 指向仓库根', () => {
    expect(repoRootFromModule()).toBe(repoRoot);
  });
});

describe('R1 resolveCliBin：打包 runtime 优先', () => {
  it('优先 <resources>/node_modules/@mebular/core，其次旧 packages/mcp，最后仓库开发态', () => {
    const resources = tempDir('mebular-resources-');
    const checkout = tempDir('mebular-checkout-');

    const runtimeCli = join(resources, 'node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs');
    const legacyCli = join(resources, 'packages', 'mcp', 'bin', 'mebular.mjs');
    const devCli = join(checkout, 'packages', 'mcp', 'bin', 'mebular.mjs');
    touch(runtimeCli);
    touch(legacyCli);
    touch(devCli);

    expect(resolveCliBin(checkout, { resourcesPath: resources })).toBe(runtimeCli);

    rmSync(join(resources, 'node_modules'), { recursive: true, force: true });
    expect(resolveCliBin(checkout, { resourcesPath: resources })).toBe(legacyCli);

    rmSync(join(resources, 'packages'), { recursive: true, force: true });
    expect(resolveCliBin(checkout, { resourcesPath: resources })).toBe(devCli);
  });

  it('没有文件时返回首选 runtime 路径（便于诊断错误）', () => {
    const resources = tempDir('mebular-resources-empty-');
    expect(resolveCliBin('/nonexistent-checkout', { resourcesPath: resources }))
      .toBe(join(resources, 'node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs'));
  });

  it('未打包（无 resourcesPath）时回退仓库开发态', () => {
    expect(resolveCliBin(repoRoot, { resourcesPath: '' }))
      .toBe(join(repoRoot, 'packages', 'mcp', 'bin', 'mebular.mjs'));
  });
});

describe('R1 resolveLocalesDir：runtime 内 locale pack', () => {
  it('旧 <resources>/locales 优先，其次 <resources>/node_modules/@mebular/core/locales', () => {
    const resources = tempDir('mebular-locales-');
    const runtimeLocales = join(resources, 'node_modules', '@mebular', 'core', 'locales');
    touch(join(runtimeLocales, 'manifest.json'));

    expect(resolveLocalesDir({ env: {}, moduleDir: '/x', resourcesPath: resources })).toBe(runtimeLocales);

    const legacyLocales = join(resources, 'locales');
    touch(join(legacyLocales, 'manifest.json'));
    expect(resolveLocalesDir({ env: {}, moduleDir: '/x', resourcesPath: resources })).toBe(legacyLocales);
  });

  it('MEBULAR_LOCALES_DIR 仍最高优先', () => {
    expect(resolveLocalesDir({ env: { MEBULAR_LOCALES_DIR: '/tmp/custom' }, moduleDir: '/x', resourcesPath: '/res' }))
      .toBe('/tmp/custom');
  });
});
