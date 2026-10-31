#!/usr/bin/env node
// 发布后 npm 可见性 gate：八个包（7 个 lockstep + dsh-plugin）都必须在 registry 可见，
// 且 dist-tags.latest 指向本次发布版本。
//
// 背景：v0.1.1 的 npm publish job 成功时，@mebular/mcp 的 latest 仍短暂指向旧版本 /
// `npm view` 返回 E404；流水线没有 gate，GitHub Release 仍会创建。本脚本用有界轮询替代
// “sleep 一下就过”，失败时逐包输出最后状态。
//
// 独立运行：
//   node scripts/verify-release-visibility.mjs
//   node scripts/verify-release-visibility.mjs --version 0.2.0 --dsh-version 0.2.0
//   node scripts/verify-release-visibility.mjs --timeout-seconds 600 --interval-seconds 10
//
// 退出码：0 = 八包可见且 latest 正确；1 = 超时/状态不符；2 = 参数或本地 manifest 错误。

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SEMVER_RE } from './bump-version.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const LOCKSTEP_PACKAGES = [
  '@mebular/core',
  '@mebular/service',
  '@mebular/memory-runtime',
  '@mebular/skill',
  '@mebular/mcp',
  '@mebular/fleet',
  '@mebular/opencode-plugin',
];
export const DSH_PACKAGE = '@mebular/dsh-plugin';

const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_INTERVAL_SECONDS = 10;
const VIEW_TIMEOUT_MS = 60_000;

export function buildReleasePackages({ version, dshVersion = version }) {
  return [
    ...LOCKSTEP_PACKAGES.map((name) => ({ name, version })),
    { name: DSH_PACKAGE, version: dshVersion },
  ];
}

export function npmViewArgs(name, version, { registry } = {}) {
  const args = [
    'view',
    `${name}@${version}`,
    'version',
    'dist-tags.latest',
    '--json',
    '--prefer-online',
  ];
  if (registry) args.push('--registry', registry);
  return args;
}

export function parseViewOutput(stdout) {
  const parsed = JSON.parse(String(stdout));
  if (typeof parsed === 'string') {
    // 单字段输出（例如只返回 version）也应能被解析；latest 视为未知。
    return { version: parsed, latest: null };
  }
  return {
    version: parsed?.version ?? null,
    latest: parsed?.['dist-tags.latest'] ?? parsed?.['dist-tags']?.latest ?? null,
  };
}

export async function viewPackageWithNpm(
  name,
  version,
  { npm = 'npm', registry, timeoutMs = VIEW_TIMEOUT_MS } = {},
) {
  const { stdout } = await execFileAsync(npm, npmViewArgs(name, version, { registry }), {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
  return parseViewOutput(stdout);
}

export function formatViewError(error) {
  const stderr = String(error?.stderr ?? '').trim();
  const message = stderr || String(error?.message ?? error);
  const firstMeaningful = message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /E404|404|not in this registry|ETARGET|ERR!/i.test(line));
  return firstMeaningful ?? message.split('\n')[0] ?? 'unknown error';
}

/**
 * 有界轮询：每一轮并行检查所有未通过的包；全部 ok 才返回成功。
 * 依赖注入 viewPackage / sleep / now，便于用确定性 fixture 测试。
 */
export async function verifyVisibility({
  packages,
  timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000,
  intervalMs = DEFAULT_INTERVAL_SECONDS * 1000,
  viewPackage,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now = () => Date.now(),
  log = () => {},
}) {
  const viewer = viewPackage ?? viewPackageWithNpm;
  const states = packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    attempts: 0,
    versionVisible: false,
    latest: null,
    lastError: null,
    ok: false,
    loggedError: undefined,
  }));

  const deadline = now() + Math.max(0, timeoutMs);
  let round = 0;
  let firstRound = true;

  const checkOne = async (state) => {
    state.attempts += 1;
    try {
      const result = await viewer(state.name, state.version);
      state.versionVisible = result.version === state.version;
      state.latest = result.latest ?? null;
      if (!state.versionVisible) {
        state.lastError = `npm view 返回 ${String(result.version)}，期望 ${state.version}`;
      } else if (state.latest !== state.version) {
        state.lastError = `dist-tags.latest=${String(state.latest)}，期望 ${state.version}`;
      } else {
        state.ok = true;
        state.lastError = null;
      }
    } catch (error) {
      state.versionVisible = false;
      state.latest = null;
      state.lastError = formatViewError(error);
    }

    if (state.ok) {
      log(`  ok    ${state.name}@${state.version}  latest=${state.latest}  (attempt ${state.attempts})`);
    } else if (state.lastError !== state.loggedError) {
      log(`  wait  ${state.name}@${state.version}  ${state.lastError}  (attempt ${state.attempts})`);
    }
    state.loggedError = state.lastError;
  };

  while (firstRound || now() < deadline) {
    firstRound = false;
    round += 1;
    const pending = states.filter((state) => !state.ok);
    if (pending.length === 0) break;
    await Promise.all(pending.map(checkOne));
    if (states.every((state) => state.ok)) break;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  return {
    ok: states.every((state) => state.ok),
    timeoutMs,
    intervalMs,
    rounds: round,
    packages: states.map(({ loggedError: _loggedError, ...state }) => state),
  };
}

function readManifestVersion(root, rel) {
  return JSON.parse(readFileSync(join(root, rel, 'package.json'), 'utf8')).version;
}

function parseArgs(argv) {
  const options = {
    root: SCRIPT_ROOT,
    version: undefined,
    dshVersion: undefined,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    registry: undefined,
    npm: 'npm',
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--root') {
      options.root = resolve(argv[++i] ?? '');
    } else if (arg === '--version') {
      options.version = argv[++i];
    } else if (arg === '--dsh-version') {
      options.dshVersion = argv[++i];
    } else if (arg === '--timeout-seconds') {
      options.timeoutSeconds = Number(argv[++i]);
    } else if (arg === '--interval-seconds') {
      options.intervalSeconds = Number(argv[++i]);
    } else if (arg === '--registry') {
      options.registry = argv[++i];
    } else if (arg === '--npm') {
      options.npm = argv[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    '用法：node scripts/verify-release-visibility.mjs [选项]',
    `  --version <x.y.z>         ${LOCKSTEP_PACKAGES.length} 个 lockstep 包版本（默认根 package.json）`,
    '  --dsh-version <x.y.z>     @mebular/dsh-plugin 版本（默认其 package.json）',
    '  --timeout-seconds <n>     总超时，默认 600',
    '  --interval-seconds <n>    轮询间隔，默认 10',
    '  --registry <url>          覆盖 npm registry',
    '  --npm <path>              覆盖 npm 可执行文件（测试用）',
    '  --json                    输出机器可读结果',
  ].join('\n');
}

export function formatVisibilityResult(result) {
  const lines = [];
  const status = result.ok ? 'PASS' : 'FAIL';
  lines.push(
    `Release visibility ${status}: ${result.packages.filter((pkg) => pkg.ok).length}/${result.packages.length} packages ok` +
      ` (rounds=${result.rounds}, timeout=${result.timeoutMs / 1000}s, interval=${result.intervalMs / 1000}s)`,
  );
  for (const pkg of result.packages) {
    const detail = pkg.ok
      ? `version=${pkg.version} latest=${pkg.latest}`
      : `versionVisible=${pkg.versionVisible} latest=${String(pkg.latest)} lastError=${pkg.lastError}`;
    lines.push(`  ${pkg.ok ? '✓' : '✗'} ${pkg.name}@${pkg.version}  ${detail}  (attempts=${pkg.attempts})`);
  }
  if (!result.ok) {
    lines.push('修复：确认 publish / publish-dsh 已成功，并等待 registry 传播后重跑该 job；不要跳过本 gate。');
  }
  return lines.join('\n');
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`错误：${error.message}`);
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  try {
    options.version ??= readManifestVersion(options.root, '.');
    options.dshVersion ??= readManifestVersion(options.root, 'packages/dsh-plugin');
  } catch (error) {
    console.error(`错误：无法读取本地 manifest 版本：${error.message}`);
    return 2;
  }

  for (const [label, value] of [
    ['--version', options.version],
    ['--dsh-version', options.dshVersion],
  ]) {
    if (!SEMVER_RE.test(String(value))) {
      console.error(`错误：${label} 不是合法 semver：${value}`);
      return 2;
    }
  }
  for (const [label, value] of [
    ['--timeout-seconds', options.timeoutSeconds],
    ['--interval-seconds', options.intervalSeconds],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      console.error(`错误：${label} 需要非负数字：${value}`);
      return 2;
    }
  }

  const packages = buildReleasePackages({
    version: options.version,
    dshVersion: options.dshVersion,
  });
  const log = options.json
    ? () => {}
    : (line) => console.log(line);

  log(
    `[visibility] ${packages.length} packages · timeout=${options.timeoutSeconds}s · interval=${options.intervalSeconds}s` +
      `${options.registry ? ` · registry=${options.registry}` : ''}`,
  );

  const result = await verifyVisibility({
    packages,
    timeoutMs: options.timeoutSeconds * 1000,
    intervalMs: options.intervalSeconds * 1000,
    viewPackage: (name, version) =>
      viewPackageWithNpm(name, version, {
        npm: options.npm,
        registry: options.registry,
      }),
    log,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatVisibilityResult(result));
  }
  return result.ok ? 0 : 1;
}

const invokedAsScript = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invokedAsScript) {
  process.exitCode = await main(process.argv.slice(2));
}
