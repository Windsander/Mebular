#!/usr/bin/env node
// Negative control for the DSH checkpoint fault harness (test-of-test).
//
// It packs a copy of @mebular/dsh-plugin whose 202 branch is deliberately
// broken to report `committed`, then runs the real DSH + real sidecar/capability
// `faults` scenario. A green harness is only meaningful if this regression makes
// the 202 pending assertion red.

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packPackage, runCommand } from '../../../scripts/lib/e2e-process.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pluginDir = join(repoRoot, 'packages', 'dsh-plugin');
const runner = join(repoRoot, 'tests', 'integration', 'host-e2e', 'dsh-real-runtime.mjs');

const PENDING = `      if (pending) {
        state.committed = false;
        state.pending = true;
        state.failed = false;
        state.error = null;
        state.revision = null;
        stats.checkpoints.pending += 1;`;
const BROKEN = `      if (pending) {
        state.committed = true;
        state.pending = false;
        state.failed = false;
        state.error = null;
        state.revision = 1;
        stats.checkpoints.committed += 1;`;

function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
  return ok;
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'mebular-dsh-checkpoint-negative-'));
  let keep = false;
  let exitCode = 1;
  try {
    console.log('DSH checkpoint 202 negative control（test-of-test）');
    console.log('==================================================');
    const badDir = join(scratch, 'dsh-plugin');
    await cp(pluginDir, badDir, {
      recursive: true,
      filter: (source) => !/(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/.test(source)
        && !source.endsWith('.tgz'),
    });
    const runtimePath = join(badDir, 'memory-runtime.js');
    const source = await readFile(runtimePath, 'utf8');
    if (!source.includes(PENDING)) throw new Error('未找到 202 pending 分支，无法构造坏插件');
    await writeFile(runtimePath, source.replace(PENDING, BROKEN), 'utf8');

    const packDir = join(scratch, 'pack');
    await mkdir(packDir, { recursive: true });
    const badTarball = await packPackage(badDir, packDir, 'broken @mebular/dsh-plugin (202 committed)');
    check('坏插件已构造为 202=committed', badTarball.size > 0, `${badTarball.filename} (${badTarball.size}B)`);

    const result = await runCommand('checkpoint negative control', process.execPath, [
      runner,
      '--scenario', 'faults',
      '--plugin-tarball', badTarball.path,
    ], { cwd: repoRoot, timeoutMs: 900000 });
    const output = `${result.stdout}\n${result.stderr}`;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);

    console.log('\n断言');
    const checks = [
      check('坏插件使 real host E2E 非零退出', result.code !== 0 && result.timedOut !== true, `code=${result.code}`),
      check('faults 场景确实运行', /▶ faults/.test(output)),
      check('202 pending 断言判红',
        /✗ capability 故障时真实 sidecar 以 202 queued 回复，宿主保持 pending/.test(output)),
      check('前置 429 检查仍为绿（失败不是 DSH 未启动）',
        /✓ 429 via synthetic tap（首个 PUT 未到真实 sidecar）：重试后提交/.test(output)),
    ];
    if (checks.every(Boolean)) {
      exitCode = 0;
      console.log('\n✓ checkpoint negative control 通过：202=committed 回归被真实 host E2E 抓住。');
    } else {
      keep = true;
      console.log('\n✗ checkpoint negative control 失败：回归没有被预期断言拦住。');
    }
  } catch (error) {
    keep = true;
    console.error(`\n✗ checkpoint negative control 未完成：${error?.stack ?? error}`);
  } finally {
    if (keep) {
      console.log(`临时目录保留：${scratch}`);
    } else {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return exitCode;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ checkpoint negative control 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
