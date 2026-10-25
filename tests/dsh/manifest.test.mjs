// P2 · @mebular/dsh-plugin manifest / bundle patch / import boundary.
// These checks are intentionally static: installing a DSH profile needs no
// network, no build step, and no Mebular package.

import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const pkgDir = join(root, 'packages', 'dsh-plugin');
const read = (file) => readFileSync(join(pkgDir, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const patch = read('cordis.patch.yml');
const host = read('index.js');
const client = read('client.js');

describe('P2 @mebular/dsh-plugin manifest：DSH bundle 形状', () => {
  it('package.json 标识、入口与 exports 完整', () => {
    expect(pkg.name).toBe('@mebular/dsh-plugin');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    expect(pkg.license).toBe('MIT');
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('index.js');
    expect(pkg.exports).toMatchObject({
      '.': './index.js',
      './client': './client.js',
      './package.json': './package.json',
      './locale/*': './locale/*',
    });
  });

  it('声明 dsh.bundle / dsh.client，且 node / dsh engines 固定兼容范围', () => {
    expect(pkg.dsh).toMatchObject({
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', inject: [] },
    });
    expect(pkg.engines.node).toBe('>=22.19');
    expect(pkg.engines.dsh).toBe('>=0.2.1-rc.2 <0.3.0');
    expect(existsSync(join(pkgDir, pkg.dsh.bundle.patch))).toBe(true);
    expect(existsSync(join(pkgDir, pkg.main))).toBe(true);
    expect(existsSync(join(pkgDir, 'client.js'))).toBe(true);
  });

  it('零运行时/开发依赖，只声明官方 MCP client 为 peer，且不声明任何 @mebular/* 依赖', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(pkg.peerDependencies).toEqual({
      '@deepseek-ai/dsh-mcp-client': '>=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-rc.1 <0.3.0-0',
    });
    expect(Object.keys(pkg.devDependencies ?? {})).toEqual([]);
    expect(JSON.stringify(pkg.dependencies ?? {})).not.toMatch(/@mebular\//);
    expect(JSON.stringify(pkg.devDependencies ?? {})).not.toMatch(/@mebular\//);
    expect(JSON.stringify(pkg.peerDependencies ?? {})).not.toMatch(/@mebular\//);
    // The peer is a host contract: DSH supplies it at runtime, installation
    // must not require the plugin to bundle a copy.
    expect(pkg.peerDependenciesMeta).toBeUndefined();
  });

  it('files 覆盖无构建产物（host/client/patch/locale/README/LICENSE/icon/screenshots/assets）', () => {
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        'index.js',
        'client.js',
        'cordis.patch.yml',
        'locale',
        'README.md',
        'LICENSE',
        'icon.svg',
        'screenshots.json',
        'assets',
      ]),
    );
    for (const file of [
      'locale/en.json',
      'locale/zh.json',
      'README.md',
      'LICENSE',
      'icon.svg',
      'screenshots.json',
      'assets/icon-180.png',
      'assets/dsh-panel.jpg',
      'assets/console-starmap.jpg',
    ]) {
      expect(existsSync(join(pkgDir, file))).toBe(true);
    }
  });

  it('没有第二套旧客户端目录', () => {
    expect(existsSync(join(pkgDir, 'client'))).toBe(false);
    expect(pkg.exports['./client']).toBe('./client.js');
  });
});

describe('P5 @mebular/dsh-plugin manifest：cordis.patch.yml', () => {
  it('只插入 mebular host 行，不再有 MCP patch row', () => {
    expect(patch).toMatch(/^-\s+insert:/m);
    expect(patch).toMatch(/id:\s*mebular\b/);
    expect(patch).toMatch(/name:\s*'@mebular\/dsh-plugin'/);
    expect(patch).not.toMatch(/mebular-mcp/);
    expect(patch).not.toMatch(/@deepseek-ai\/dsh-mcp-client/);
    expect(patch).not.toMatch(/serverName:|transport:|failOnStartupError:/);
    expect(patch).not.toMatch(/url:\s*!!js/);
  });

  it('不写死 daemonUrl，attach / panel', () => {
    // Runtime discovery needs an absent daemonUrl; an explicit value here
    // would always win over MEBULAR_HTTP_PORT/runtime.json.
    expect(patch).not.toMatch(/daemonUrl\s*:/);
    expect(patch).not.toMatch(/^\s*url\s*:/m);
    expect(patch).toMatch(/lifecycle:\s*attach/);
    expect(patch).toMatch(/panel:\s*true/);
  });

  it('不把 Mebular 系统设置或 MCP 实现塞进 patch', () => {
    expect(patch).toMatch(/name:\s*'@mebular\/dsh-plugin'/);
    expect(patch).not.toMatch(/packages\/console/);
    expect(patch).not.toMatch(/store\.jsonl|auth|token|secret/i);
  });
});

describe('P2 @mebular/dsh-plugin manifest：静态导入边界', () => {
  it('host/client 不静态 import 任何 @mebular/* 或 @deepseek-ai/* 模块', () => {
    const importSpecifiers = new Set();
    for (const source of [host, client]) {
      for (const match of source.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
        importSpecifiers.add(match[1]);
      }
      for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        importSpecifiers.add(match[1]);
      }
    }
    expect([...importSpecifiers].filter((specifier) => /^@mebular\//.test(specifier))).toEqual([]);
    expect([...importSpecifiers].filter((specifier) => /^@deepseek-ai\//.test(specifier))).toEqual([]);
  });

  it('host 只在 apply 期动态 import 官方 MCP client peer', () => {
    expect(host).toContain("await import('@deepseek-ai/dsh-mcp-client')");
    const dynamic = [...host.matchAll(/await import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
    expect(dynamic).toEqual(['@deepseek-ai/dsh-mcp-client']);
  });

  it('client 只 require react；host 只用 node: 内置与全局能力', () => {
    const requires = [...client.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
    expect(requires).toEqual(['react']);
    const hostImports = [...host.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)]
      .map((match) => match[1]);
    expect(hostImports.length).toBeGreaterThan(0);
    expect(hostImports.every((specifier) => specifier.startsWith('node:'))).toBe(true);
    expect(host).not.toMatch(/\brequire\(/);
  });
});
