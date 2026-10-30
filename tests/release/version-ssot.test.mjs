// Release SSOT：bump-version 与 verify-release-version 的 fixture 测试。
// 不触碰真实仓库文件：每个用例在临时目录搭一个最小仓库。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpVersion } from '../../scripts/bump-version.mjs';
import { verifyReleaseVersion } from '../../scripts/verify-release-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const tempDirs = [];

function write(root, rel, content) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

function writeJson(root, rel, value) {
  write(root, rel, `${JSON.stringify(value, null, 2)}\n`);
}

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mebular-release-ssot-'));
  tempDirs.push(root);

  const packages = {
    'packages/fleet': { name: '@mebular/fleet', deps: { '@mebular/core': 'file:../..', '@mebular/service': '^0.1.1' } },
    'packages/mcp': { name: '@mebular/mcp', deps: { '@mebular/core': 'file:../..' } },
    'packages/memory-runtime': {
      name: '@mebular/memory-runtime',
      deps: { '@mebular/core': 'file:../..' },
      scripts: {
        prepack: 'node ../../scripts/publish-manifest.mjs set',
        postpack: 'node ../../scripts/publish-manifest.mjs restore',
      },
    },
    'packages/service': { name: '@mebular/service' },
    'packages/skill': { name: '@mebular/skill' },
    'packages/dsh-plugin': { name: '@mebular/dsh-plugin' },
  };

  writeJson(root, 'package.json', {
    name: '@mebular/core',
    version: '0.1.1',
    workspaces: ['packages/*'],
  });

  const lockPackages = {
    '': { name: '@mebular/core', version: '0.1.1' },
  };
  for (const [rel, pkg] of Object.entries(packages)) {
    writeJson(root, `${rel}/package.json`, {
      name: pkg.name,
      version: '0.1.1',
      ...(pkg.deps ? { dependencies: pkg.deps } : {}),
      ...(pkg.scripts ? { scripts: pkg.scripts } : {}),
    });
    lockPackages[rel] = { name: pkg.name, version: '0.1.1' };
  }
  writeJson(root, 'package-lock.json', {
    name: '@mebular/core',
    version: '0.1.1',
    lockfileVersion: 3,
    packages: lockPackages,
  });

  writeJson(root, 'apps/desktop/package.json', { name: '@mebular/desktop', version: '0.1.1' });
  writeJson(root, 'apps/desktop/package-lock.json', {
    name: '@mebular/desktop',
    version: '0.1.1',
    lockfileVersion: 3,
    packages: { '': { name: '@mebular/desktop', version: '0.1.1' } },
  });
  write(root, 'apps/desktop/src/main/daemon.mjs', "export const APP_VERSION = '0.1.1';\n");

  write(root, 'packages/mcp/src/version.mjs', "export const APP_VERSION = '0.1.1';\n");
  write(
    root,
    'packages/mcp/src/serve.mjs',
    [
      "import { APP_VERSION } from './version.mjs';",
      "export { APP_VERSION } from './version.mjs';",
      'export const EMBED_PROTOCOL = 1;',
      'export function info() { return { version: APP_VERSION }; }',
      '',
    ].join('\n'),
  );
  write(
    root,
    'packages/mcp/src/server.mjs',
    [
      "import { APP_VERSION } from './version.mjs';",
      "export function build() { return { name: 'mebular', version: APP_VERSION }; }",
      '',
    ].join('\n'),
  );
  write(
    root,
    'packages/mcp/src/client.mjs',
    [
      "import { APP_VERSION } from './version.mjs';",
      'export const init = { clientInfo: { name: \'mebular-cli\', version: APP_VERSION } };',
      '',
    ].join('\n'),
  );
  write(
    root,
    'packages/mcp/scripts/publish-manifest.mjs',
    [
      "const pkg = JSON.parse('{\"version\":\"0.1.1\"}');",
      'const publishRange = `^${pkg.version}`;',
      'export { publishRange };',
      '',
    ].join('\n'),
  );

  write(
    root,
    'CHANGELOG.md',
    '# Changelog\n\n## [v0.1.1] - 2026-10-25\n\n- fixture\n',
  );
  return root;
}

function readVersion(root, rel) {
  return JSON.parse(readFileSync(join(root, rel, 'package.json'), 'utf8')).version;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('bump-version：七包 + MCP 版本源', () => {
  it('同步 7 个 manifest、两个 lock、桌面 APP_VERSION、MCP version.mjs 与 CHANGELOG', () => {
    const root = buildFixture();
    const result = bumpVersion({ root, version: '0.2.0', tag: 'v0.2.0', date: '2026-10-26' });

    for (const rel of ['', 'packages/fleet', 'packages/mcp', 'packages/memory-runtime', 'packages/service', 'packages/skill', 'packages/dsh-plugin']) {
      expect(readVersion(root, rel)).toBe('0.2.0');
    }
    const rootLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    expect(rootLock.version).toBe('0.2.0');
    expect(rootLock.packages[''].version).toBe('0.2.0');
    expect(rootLock.packages['packages/dsh-plugin'].version).toBe('0.2.0');
    expect(rootLock.packages['packages/fleet'].version).toBe('0.2.0');
    expect(rootLock.packages['packages/memory-runtime'].version).toBe('0.2.0');

    const desktopLock = JSON.parse(readFileSync(join(root, 'apps/desktop/package-lock.json'), 'utf8'));
    expect(desktopLock.version).toBe('0.2.0');
    expect(desktopLock.packages[''].version).toBe('0.2.0');
    expect(readFileSync(join(root, 'apps/desktop/src/main/daemon.mjs'), 'utf8')).toContain(
      "APP_VERSION = '0.2.0'",
    );
    expect(readFileSync(join(root, 'packages/mcp/src/version.mjs'), 'utf8')).toContain(
      "APP_VERSION = '0.2.0'",
    );

    const fleet = JSON.parse(readFileSync(join(root, 'packages/fleet/package.json'), 'utf8'));
    expect(fleet.dependencies['@mebular/core']).toBe('file:../..');
    expect(fleet.dependencies['@mebular/service']).toBe('^0.2.0');
    expect(result.changedDeps).toBe(1);

    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('## [v0.2.0] - 2026-10-26');
    expect(changelog).toContain('## [v0.1.1]');
  });

  it('重复执行同一版本不会重复插入 CHANGELOG 章节', () => {
    const root = buildFixture();
    bumpVersion({ root, version: '0.2.0', tag: 'v0.2.0', date: '2026-10-26' });
    bumpVersion({ root, version: '0.2.0', tag: 'v0.2.0', date: '2026-10-26' });
    const matches = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').match(/^## \[v0\.2\.0\]/gm) ?? [];
    expect(matches).toHaveLength(1);
  });
});

describe('verify-release-version：通过/失败定位', () => {
  it('bump 后 fixture 通过完整 SSOT 校验', () => {
    const root = buildFixture();
    bumpVersion({ root, version: '0.2.0', tag: 'v0.2.0', date: '2026-10-26' });
    const result = verifyReleaseVersion({ root, version: '0.2.0', tag: 'v0.2.0' });
    expect(result.ok).toBe(true);
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
  });

  it('MCP version.mjs 落后时报错并指出文件', () => {
    const root = buildFixture();
    bumpVersion({ root, version: '0.2.0', tag: 'v0.2.0', date: '2026-10-26' });
    write(root, 'packages/mcp/src/version.mjs', "export const APP_VERSION = '0.1.1';\n");
    const result = verifyReleaseVersion({ root, version: '0.2.0', tag: 'v0.2.0' });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.label.includes('version.mjs APP_VERSION'))?.ok).toBe(false);
  });

  it('dsh-plugin manifest 落后时报错', () => {
    const root = buildFixture();
    bumpVersion({ root, version: '0.2.0', tag: 'v0.2.0', date: '2026-10-26' });
    writeJson(root, 'packages/dsh-plugin/package.json', {
      name: '@mebular/dsh-plugin',
      version: '0.1.1',
    });
    const result = verifyReleaseVersion({ root, version: '0.2.0', tag: 'v0.2.0' });
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.label === '@mebular/dsh-plugin version')?.ok).toBe(false);
  });

  it('memory-runtime 的 @mebular/core 无法随 tarball 安装时报错', () => {
    const root = buildFixture();
    bumpVersion({ root, version: '0.2.0', tag: 'v0.2.0', date: '2026-10-26' });
    writeJson(root, 'packages/memory-runtime/package.json', {
      name: '@mebular/memory-runtime',
      version: '0.2.0',
      dependencies: { '@mebular/core': 'workspace:*' },
    });
    const result = verifyReleaseVersion({ root, version: '0.2.0', tag: 'v0.2.0' });
    expect(result.ok).toBe(false);
    expect(
      result.checks.find((check) => check.label === '@mebular/memory-runtime 的 @mebular/core 可随 tarball 安装')?.ok,
    ).toBe(false);
  });

  it('真实仓库当前版本通过 SSOT 校验', () => {
    const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
    const result = verifyReleaseVersion({ root: repoRoot, version, tag: `v${version}` });
    const failed = result.checks.filter((check) => !check.ok);
    if (failed.length > 0) console.error(failed);
    expect(result.ok).toBe(true);
  });
});
