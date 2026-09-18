// Fleet 边界测试（M0，红线强制）：
//  1) core（`src/**`）**不得**依赖 fleet（`packages/fleet` / `@mebular/fleet`）；
//  2) fleet（`packages/fleet/src/**`）**只能**用 `@mebular/core` 公共入口，不得深路径 `src/...`。
//
// 纯静态源码扫描（不执行 core/fleet）。故意造违规时本套件必须变红（见阶段报告的红→绿）。

import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile() && /\.(ts|mts|cts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 匹配 `import ... from 'x'` / `import('x')` / `export ... from 'x'` 的模块说明符。 */
function moduleSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

describe('fleet 边界（红线）', () => {
  it('core `src/**` 不得依赖 fleet', () => {
    const violations: string[] = [];
    for (const file of listFiles(join(ROOT, 'src'))) {
      for (const spec of moduleSpecifiers(readFileSync(file, 'utf-8'))) {
        if (spec === '@mebular/fleet' || spec.includes('packages/fleet')) {
          violations.push(`${relative(ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('fleet `packages/fleet/src/**` 只能用 @mebular/core 公共入口（不得深路径 src/**）', () => {
    const violations: string[] = [];
    const fleetSrc = join(ROOT, 'packages/fleet/src');
    for (const file of listFiles(fleetSrc)) {
      for (const spec of moduleSpecifiers(readFileSync(file, 'utf-8'))) {
        const deepCore =
          /^@mebular\/core\/.+/.test(spec) || // @mebular/core/src/...
          /(^|\/)src\//.test(spec) || // 任何 .../src/... 深路径
          /^(\.\.\/)+src(\/|$)/.test(spec); // 相对跳到 core 的 src/
        if (deepCore) violations.push(`${relative(ROOT, file)} → ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('fleet 只声明 @mebular/core 与 @mebular/service（无其它内部包）', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/fleet/package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };
    const allowed = ['@mebular/core', '@mebular/service'];
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps).toContain('@mebular/core');
    for (const dep of deps) {
      expect(allowed).toContain(dep);
    }
  });

  it('@mebular/service 不得依赖 core（服务化与记忆语义解耦）', () => {
    const violations: string[] = [];
    for (const file of listFiles(join(ROOT, 'packages/service/src'))) {
      for (const spec of moduleSpecifiers(readFileSync(file, 'utf-8'))) {
        if (spec === '@mebular/core' || spec.startsWith('@mebular/core/')) {
          violations.push(`${relative(ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
