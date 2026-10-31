#!/usr/bin/env node
// Memory Runtime sidecar 独立覆盖率门禁。
//
// 主 test:coverage 只收集 core/fleet/service 与 memory-runtime 的非 sidecar 源；
// sidecar 是独立进程/独立包，必须单独设定门槛，不能长期靠排除来保持全局绿。

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jest = resolve(root, 'node_modules/jest/bin/jest.js');

const args = [
  '--experimental-vm-modules',
  jest,
  'packages/memory-runtime/tests/sidecar',
  '--runInBand',
  '--coverage',
  '--collectCoverageFrom=packages/memory-runtime/src/sidecar/**/*.ts',
  '--coverageDirectory=coverage-sidecar',
  '--coverageReporters=text-summary',
  '--coverageThreshold={"global":{"lines":70,"branches":60,"functions":75,"statements":72}}',
];

const result = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`[sidecar-coverage] 启动失败：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
