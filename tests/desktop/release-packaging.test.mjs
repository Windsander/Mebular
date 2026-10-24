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
const electronBuilderYaml = readFileSync(join(repoRoot, 'apps', 'desktop', 'electron-builder.yml'), 'utf-8');

// 行式读取顶层段与段内标量：本仓库 tests 不引入 yaml 依赖，配置结构固定且浅层。
function yamlSection(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${name}:\\s*(?:#.*)?$`).test(line));
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^[^\s#]/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

function yamlScalar(section, key) {
  const match = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`, 'm').exec(section ?? '');
  return match ? match[1].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '') : null;
}

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

// R4.1：package name 是 @mebular/desktop，Linux 默认 executableName 会派生为 @mebulardesktop，
// AppImage 因 @/. 拒绝构建，故必须显式声明合法可执行名；静态契约防止回归。
describe('R4.1 Linux executableName / desktopName 契约', () => {
  const linux = yamlSection(electronBuilderYaml, 'linux');

  it('linux 段显式声明合法可执行名并同步 .desktop 文件名', () => {
    expect(linux).not.toBeNull();
    expect(yamlScalar(linux, 'executableName')).toBe('mebular');
    expect(yamlScalar(linux, 'syncDesktopName')).toBe('true');
  });

  it('desktopName 是合法可执行名，且与 executableName 一致', () => {
    expect(desktopPackage.desktopName).toMatch(/^(?=.*[A-Za-z0-9])[A-Za-z0-9._ -]+$/);
    expect(desktopPackage.desktopName).toBe(yamlScalar(linux, 'executableName'));
  });

  it('Linux artifactName 仍保留 ${arch}，可执行名改动不影响产物名', () => {
    expect(yamlScalar(linux, 'artifactName')).toBe('Mebular-${version}-${arch}.${ext}');
  });

  it('macOS / Windows artifactName 未随 Linux 修复改变', () => {
    expect(yamlScalar(yamlSection(electronBuilderYaml, 'mac'), 'artifactName'))
      .toBe('Mebular-${version}-${arch}.${ext}');
    expect(yamlScalar(yamlSection(electronBuilderYaml, 'win'), 'artifactName'))
      .toBe('Mebular-Setup-${version}.${ext}');
  });
});

// R4.2：.deb 需要 homepage / author.email / linux.maintainer，缺一即拒绝构建；
// 静态契约固定元数据，同时防止 Linux 产物名在补齐元数据时被改动。
describe('R4.2 Debian 元数据契约', () => {
  const linux = yamlSection(electronBuilderYaml, 'linux');

  it('package homepage 是 https URL', () => {
    expect(typeof desktopPackage.homepage).toBe('string');
    expect(() => new URL(desktopPackage.homepage)).not.toThrow();
    expect(new URL(desktopPackage.homepage).protocol).toBe('https:');
  });

  it('author email 存在且是合法 email', () => {
    expect(desktopPackage.author).toMatchObject({ name: 'Windsander' });
    expect(desktopPackage.author.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  });

  it('linux.maintainer 含与 package author 相同的 email', () => {
    const maintainer = yamlScalar(linux, 'maintainer');
    expect(maintainer).not.toBeNull();
    expect(maintainer).toContain(desktopPackage.author.email);
    expect(maintainer).toMatch(/^.+\s<[^\s@]+@[^\s@]+\.[^\s@]+>$/);
  });

  it('Linux executableName / artifactName 保持不变', () => {
    expect(yamlScalar(linux, 'executableName')).toBe('mebular');
    expect(yamlScalar(linux, 'artifactName')).toBe('Mebular-${version}-${arch}.${ext}');
  });
});
