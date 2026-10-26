#!/usr/bin/env node
// Negative control for the real DSH E2E harness (test-of-test).
//
// The real E2E asserts that the production plugin renders a sidebar entry and
// loads the Console iframe. A green run is only meaningful if a broken plugin
// turns that run red. This script:
//
//   1. copies `packages/dsh-plugin` into a throwaway directory;
//   2. flips `panel: true` to `panel: false` in the copied `cordis.patch.yml`,
//      so the host still mounts MCP tools but registers no sidebar/panel;
//   3. `npm pack`s the broken copy;
//   4. runs `verify-dsh-e2e --scenario happy-path --plugin-tarball <bad.tgz>`
//      with a throwaway harness root;
//   5. expects a non-zero exit, a failing sidebar/iframe check, and a *green*
//      probe/tool check (proving the failure is the UI regression, not a
//      preflight shortcut or a DSH that never started);
//   6. removes the throwaway directory (or keeps it with --keep / on an
//      unexpected result).
//
// This is deliberately not part of the nightly or release workflows: it doubles
// E2E cost. Run it before a release or whenever the E2E assertions change.
//
// Usage:
//   node tests/dsh/e2e/negative-control.mjs [--dsh-version <version>] [--keep]
//
// Exit codes: 0 the bad plugin was rejected as expected; 1 otherwise.

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packPackage, runCommand } from '../../../scripts/lib/e2e-process.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pluginDir = join(repoRoot, 'packages', 'dsh-plugin');
const runner = join(repoRoot, 'scripts', 'verify-dsh-e2e.mjs');
const PATCHED_PANEL = /^(\s*)panel:\s*true\s*$/m;

function parseArgs(argv) {
  const options = { keep: false, forward: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--dsh-version') {
      const value = argv[index + 1] ?? '';
      if (value.length === 0) throw new Error('--dsh-version 需要版本');
      options.forward.push('--dsh-version', value);
      index += 1;
    } else if (arg.startsWith('--dsh-version=')) {
      options.forward.push(arg);
    } else if (arg === '--scenario' || arg.startsWith('--scenario=')) {
      throw new Error('negative control 固定运行 happy-path，不接受 --scenario');
    } else if (arg === '--plugin-tarball' || arg.startsWith('--plugin-tarball=')) {
      throw new Error('negative control 自己生成坏插件 tarball，不接受 --plugin-tarball');
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
  return ok;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scratch = await mkdtemp(join(tmpdir(), 'mebular-dsh-negative-'));
  let keepScratch = options.keep;
  let exitCode = 1;

  try {
    console.log('DSH E2E negative control（test-of-test）');
    console.log('========================================');
    console.log(`临时目录：${scratch}`);

    const badDir = join(scratch, 'dsh-plugin');
    await cp(pluginDir, badDir, {
      recursive: true,
      filter: (source) => !/(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/.test(source)
        && !source.endsWith('.tgz'),
    });

    const patchPath = join(badDir, 'cordis.patch.yml');
    const patch = await readFile(patchPath, 'utf-8');
    if (!PATCHED_PANEL.test(patch)) {
      throw new Error('复制的 cordis.patch.yml 没有预期的 `panel: true`，无法构造坏插件');
    }
    const brokenPatch = patch.replace(PATCHED_PANEL, '$1panel: false');
    await writeFile(patchPath, brokenPatch, 'utf-8');
    const mutated = await readFile(patchPath, 'utf-8');
    check('坏插件副本已把 panel 改为 false', /^\s*panel:\s*false\s*$/m.test(mutated));

    const packDir = join(scratch, 'pack');
    await mkdir(packDir, { recursive: true });
    const badTarball = await packPackage(badDir, packDir, 'broken @mebular/dsh-plugin');
    check('坏插件已 npm pack', badTarball.size > 0, `${badTarball.filename} (${badTarball.size}B)`);

    const harnessRoot = join(scratch, 'harness');
    const args = [
      runner,
      '--scenario', 'happy-path',
      '--plugin-tarball', badTarball.path,
      '--root', harnessRoot,
      ...options.forward,
    ];
    console.log(`\n→ 运行 ${process.execPath} ${args.join(' ')}`);
    const result = await runCommand('negative control', process.execPath, args, {
      cwd: repoRoot,
      timeoutMs: 900000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);

    console.log('\n断言');
    const checks = [
      check('harness 以非零状态退出', result.code !== 0 && result.timedOut !== true, `code=${result.code} timedOut=${result.timedOut}`),
      check('happy-path 场景确实运行了', /▶ happy-path/.test(output) && /场景汇总/.test(output)),
      check(
        '输出包含侧边栏 Mebular 入口失败',
        /✗ 侧边栏存在唯一的 Mebular 入口/.test(output),
      ),
      check(
        '输出包含 Mebular 面板 iframe 失败',
        /✗ Mebular 面板 iframe 已挂载/.test(output),
      ),
      check(
        '工具与 probe 仍为绿（失败来自 UI 注册，不是 DSH 未启动）',
        /✓ probe 完成工具读取与调用/.test(output)
          && /✓ 关键 Mebular 工具已注册/.test(output)
          && /✓ DSH Web 页面已加载/.test(output),
      ),
      check('失败现场写入了 artifacts', /artifacts: .+scenario-happy-path/.test(output)),
    ];

    if (checks.every(Boolean)) {
      exitCode = 0;
      console.log('\n✓ negative control 通过：坏插件被 E2E 正确判红，正常工具链仍为绿。');
    } else {
      keepScratch = true;
      console.log('\n✗ negative control 失败：坏插件没有被预期的断言拦住。');
    }
  } catch (error) {
    keepScratch = true;
    console.error(`\n✗ negative control 未完成：${error?.stack ?? error}`);
  } finally {
    if (keepScratch) {
      console.log(`临时目录保留：${scratch}`);
    } else {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      console.log(`临时目录已清理：${scratch}`);
    }
  }

  return exitCode;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ negative control 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
