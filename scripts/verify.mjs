#!/usr/bin/env node
// Mebular 全阶段验证汇总入口（G0）
//
// 依序运行 scripts/verify-phase0..6.mjs，任一失败即中止并非零退出。
// 用法：
//   node scripts/verify.mjs        # 全部阶段
//   node scripts/verify.mjs 0 3 6  # 仅指定阶段
//
// docs.design/ 缺失时，各阶段的文档检查项会降级为跳过 + 告警
// （见 scripts/verify-lib.mjs），代码/构建/测试等实质检查照常执行。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const phases = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['0', '1', '2', '3', '4', '5', '6'];

const results = [];
for (const phase of phases) {
  const script = join(__dirname, `verify-phase${phase}.mjs`);
  if (!existsSync(script)) {
    console.log(`✗ 未知阶段：${phase}（找不到 ${script}）`);
    process.exit(1);
  }

  console.log(`\n${'#'.repeat(60)}\n# verify-phase${phase}\n${'#'.repeat(60)}`);
  const res = spawnSync(process.execPath, [script], { cwd: rootDir, stdio: 'inherit' });
  const ok = res.status === 0;
  results.push({ phase, ok });
  if (!ok) {
    console.log(
      `\n✗ verify-phase${phase} 失败（退出码 ${res.status ?? res.signal}），中止后续阶段`,
    );
    break;
  }
}

console.log('\n' + '='.repeat(60));
console.log('验证汇总：');
for (const { phase, ok } of results) {
  console.log(`  ${ok ? '✓' : '✗'} verify-phase${phase}`);
}
const allOk = results.length === phases.length && results.every((r) => r.ok);
console.log(allOk ? '\n✓ 全部阶段验证通过' : '\n✗ 验证未全部通过');
process.exit(allOk ? 0 : 1);
