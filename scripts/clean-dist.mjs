#!/usr/bin/env node
// 跨平台清理构建产物（D5）。
//
// `tsc` 不会删除「已从源码移除」的旧输出（例如删掉 src/types/vcshape.ts 后
// dist/types/vcshape.d.ts 仍残留）。构建前先清空输出目录，保证 dist 与源码一致。
// 仅用 Node 内建 fs（Windows/macOS/Linux 通用），不新增依赖。

import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  'dist',
  'packages/service/dist',
  'packages/fleet/dist',
  // tsc 增量信息：陈旧会导致「输出已存在」误判，一并清理
  'tsconfig.tsbuildinfo',
  'packages/service/tsconfig.tsbuildinfo',
  'packages/fleet/tsconfig.tsbuildinfo',
];

for (const target of TARGETS) {
  rmSync(join(ROOT, target), { recursive: true, force: true });
}
