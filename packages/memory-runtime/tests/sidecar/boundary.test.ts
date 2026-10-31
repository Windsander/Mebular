// 架构守卫（W4a）：sidecar 只经 capability client 访问记忆。
//
// 与 scripts/check-architecture.mjs 的 sidecar 规则一致；这里直接扫描源码，
// 避免 Jest 在 CJS 测试进程里加载 ESM 脚本。

import { describe, it, expect } from '@jest/globals';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SIDECAR_DIR = join(process.cwd(), 'packages', 'memory-runtime', 'src', 'sidecar');
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const FORBIDDEN = /(^|\/)(GraphStore|EventLog|SyncManager|MemoryService)(\/|$|\.)/;

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(path));
    else if (entry.isFile() && path.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('memory-runtime sidecar boundary', () => {
  it('不 import core/MCP 内部模块或图/事件/同步服务', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(SIDECAR_DIR)) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(IMPORT_RE)) {
        const spec = match[1]!;
        if (spec === '@mebular/core' || spec.startsWith('@mebular/core/')
          || spec === '@mebular/mcp' || spec.startsWith('@mebular/mcp/')
          || spec.includes('packages/mcp')
          || spec.startsWith('src/graph') || spec.startsWith('src/memory')
          || FORBIDDEN.test(spec)) {
          violations.push(`${file}: ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
