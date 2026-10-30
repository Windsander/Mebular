#!/usr/bin/env node
// Run the three host E2E suites against real host adapters and a real Memory
// Runtime sidecar:
//
//   host process -> real adapter -> real sidecar `/memory-runtime/v1`
//                                -> real MCP capability `/internal/memory/v1`
//                                -> real Runtime/GraphStore
//
// No suite downloads a model, calls an external API or runs a real LLM. Each
// suite starts its own temporary Mebular home and its own MCP daemon + sidecar;
// DSH additionally installs the real `@deepseek-ai/dsh` into a temp prefix from
// the npm cache. No user home is touched.
//
//   node tests/integration/host-e2e/verify-host-e2e.mjs
//   node tests/integration/host-e2e/verify-host-e2e.mjs --host hermes,opencode
//   node tests/integration/host-e2e/verify-host-e2e.mjs --host dsh --dsh-version 0.2.1-rc.2 --keep
//
// Exit code is nonzero if any selected suite fails.

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const suites = {
  hermes: { label: 'Hermes', script: join(here, 'hermes-real-runtime.mjs') },
  opencode: { label: 'OpenCode / OpenChamber', script: join(here, 'opencode-real-runtime.mjs') },
  dsh: { label: 'DSH', script: join(here, 'dsh-real-runtime.mjs') },
};

function parseArgs(argv) {
  const options = {
    hosts: ['hermes', 'opencode', 'dsh'],
    keep: false,
    dshVersion: null,
    controllerFallback: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--controller-fallback') {
      options.controllerFallback = true;
    } else if (arg === '--host') {
      const value = argv[index + 1] ?? '';
      options.hosts = value.split(',').map((entry) => entry.trim()).filter(Boolean);
      index += 1;
    } else if (arg.startsWith('--host=')) {
      options.hosts = arg.slice('--host='.length).split(',').map((entry) => entry.trim()).filter(Boolean);
    } else if (arg === '--dsh-version') {
      options.dshVersion = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith('--dsh-version=')) {
      options.dshVersion = arg.slice('--dsh-version='.length);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  for (const host of options.hosts) {
    if (!suites[host]) throw new Error(`未知 host：${host}；可选 ${Object.keys(suites).join(', ')}`);
  }
  return options;
}

function runSuite(name, options) {
  return new Promise((resolvePromise) => {
    const args = [suites[name].script];
    if (options.keep) args.push('--keep');
    if (name === 'dsh' && options.dshVersion) args.push('--dsh-version', options.dshVersion);
    if (name === 'opencode' && options.controllerFallback) args.push('--controller-fallback');
    console.log(`\n${'='.repeat(72)}\n▶ ${suites[name].label}\n${'='.repeat(72)}`);
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
    child.on('close', (code) => resolvePromise({
      name,
      code: code ?? 1,
      tookMs: Date.now() - started,
    }));
    child.on('error', (error) => resolvePromise({
      name,
      code: 1,
      tookMs: Date.now() - started,
      error,
    }));
  });
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log('Mebular 0.3.0 host E2E');
  console.log('真实宿主适配器 + 真实 MCP capability + 真实 Memory Runtime sidecar');
  console.log('heuristic / 无真实模型 / 无外部网络 / 临时 home');
  console.log(`范围：${options.hosts.join(', ')}`);
  const results = [];
  for (const name of options.hosts) {
    results.push(await runSuite(name, options));
  }
  console.log(`\n${'='.repeat(72)}\n汇总\n${'='.repeat(72)}`);
  for (const result of results) {
    const detail = result.error ? ` (${result.error.message})` : ` (${formatDuration(result.tookMs)})`;
    console.log(`  ${result.code === 0 ? '✓' : '✗'} ${suites[result.name].label}: exit ${result.code}${detail}`);
  }
  const failed = results.filter((result) => result.code !== 0);
  console.log(failed.length === 0
    ? '\n✓ 所有选中的宿主 E2E 通过'
    : `\n✗ ${failed.length} 个宿主 E2E 失败`);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ host E2E 汇总失败：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
