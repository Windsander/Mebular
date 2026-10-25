#!/usr/bin/env node
// 已合并远端分支清理清单（默认只列清单，绝不删除）。
//
//   node scripts/prune-merged-branches.mjs
//   node scripts/prune-merged-branches.mjs --fetch
//   node scripts/prune-merged-branches.mjs --apply --yes      # 明确确认后才删除
//
// 安全约束：
//   - 默认 dry-run；--apply 必须同时给 --yes；
//   - 保护 main / master / release/* / release-prep/* / site* / gh-pages；
//   - 保护当前分支、所有 worktree 已检出的分支、仍有 open PR 的 head 分支；
//   - open PR 检查不可用时，--apply 中止（除非显式 --skip-open-pr-check）；
//   - 只删除确认已合并进 --base（默认 origin/main）的远端分支。

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BUILTIN_PROTECTED = [/^main$/, /^master$/, /^trunk$/, /^release\//, /^release-prep\//, /^site$/, /^site-/, /^gh-pages$/, /^pages$/];

export function isProtectedBranch(name, { current, worktrees = [], openPrs = [] } = {}) {
  if (!name || name === 'HEAD') return true;
  if (name === current) return true;
  if (worktrees.includes(name)) return true;
  if (openPrs.includes(name)) return true;
  return BUILTIN_PROTECTED.some((pattern) => pattern.test(name));
}

export function selectMergedBranches(branches, options = {}) {
  return branches.filter((branch) => !isProtectedBranch(branch.name, options));
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: SCRIPT_ROOT, encoding: 'utf8', ...options });
}

function currentBranch() {
  try {
    return git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch {
    return '';
  }
}

function worktreeBranches() {
  try {
    return git(['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((line) => line.startsWith('branch refs/heads/'))
      .map((line) => line.slice('branch refs/heads/'.length).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function openPullRequestHeads() {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'headRefName', '--jq', '.[].headRefName'],
      { encoding: 'utf8' },
    );
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function listMergedRemoteBranches({ remote, baseRef }) {
  const format = '%(refname:short)%09%(objectname:short)%09%(committerdate:short)%09%(subject)';
  const out = git(['for-each-ref', `--merged=${baseRef}`, `--format=${format}`, `refs/remotes/${remote}`]);
  const prefix = `${remote}/`;
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, date, ...subject] = line.split('\t');
      return {
        name: ref.startsWith(prefix) ? ref.slice(prefix.length) : ref,
        sha,
        date,
        subject: subject.join('\t'),
      };
    })
    .filter((branch) => branch.name && branch.name !== 'HEAD');
}

function parseArgs(argv) {
  const options = {
    remote: 'origin',
    base: 'origin/main',
    apply: false,
    yes: false,
    json: false,
    fetch: false,
    skipOpenPrCheck: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--remote') {
      options.remote = argv[++i];
    } else if (arg === '--base') {
      options.base = argv[++i];
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--yes') {
      options.yes = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--fetch') {
      options.fetch = true;
    } else if (arg === '--skip-open-pr-check') {
      options.skipOpenPrCheck = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    '用法：node scripts/prune-merged-branches.mjs [选项]',
    '  --remote <name>            远端，默认 origin',
    '  --base <ref>               合并基准，默认 origin/main',
    '  --fetch                    先执行 git fetch --prune <remote>',
    '  --json                     输出机器可读清单',
    '  --apply --yes              删除清单中的分支（必须同时给 --yes）',
    '  --skip-open-pr-check       跳过 open PR 保护（仅在你确认无 open PR 时使用）',
  ].join('\n');
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
  if (!options.remote || !options.base) {
    console.error('错误：--remote / --base 不能为空');
    return 2;
  }
  if (options.apply && !options.yes) {
    console.error('错误：--apply 必须同时给 --yes（默认只做 dry-run 清单）。');
    return 2;
  }

  if (options.fetch) {
    console.log(`$ git fetch --prune ${options.remote}`);
    try {
      git(['fetch', '--prune', options.remote], { stdio: 'inherit' });
    } catch {
      console.error('错误：git fetch 失败，未做任何删除。');
      return 1;
    }
  }

  let branches;
  try {
    branches = listMergedRemoteBranches({ remote: options.remote, baseRef: options.base });
  } catch (error) {
    console.error(`错误：无法列出已合并分支（base=${options.base}）：${error.message}`);
    return 1;
  }

  const openPrs = options.skipOpenPrCheck ? [] : openPullRequestHeads();
  const openPrCheckUnavailable = openPrs === null;
  const selected = selectMergedBranches(branches, {
    current: currentBranch(),
    worktrees: worktreeBranches(),
    openPrs: openPrs ?? [],
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          remote: options.remote,
          base: options.base,
          apply: options.apply,
          openPrCheck: openPrCheckUnavailable ? 'unavailable' : 'ok',
          candidates: selected,
        },
        null,
        2,
      ),
    );
  } else {
    if (openPrCheckUnavailable) {
      console.warn('WARN: gh 不可用或未登录，无法检查 open PR；dry-run 清单未排除 open PR。');
    }
    console.log(`已合并进 ${options.base} 且可安全删除的远端分支（${selected.length}）：`);
    if (selected.length === 0) {
      console.log('  （无）');
    }
    for (const branch of selected) {
      console.log(`  ${branch.name}  ${branch.sha}  ${branch.date}  ${branch.subject}`);
    }
    if (!options.apply) {
      console.log('\n这是 dry-run 清单，未删除任何分支。确认后运行：');
      console.log('  node scripts/prune-merged-branches.mjs --apply --yes');
    }
  }

  if (!options.apply) return 0;

  if (openPrCheckUnavailable) {
    console.error('错误：无法检查 open PR，拒绝批量删除。确认无 open PR 后可加 --skip-open-pr-check。');
    return 1;
  }

  let failures = 0;
  for (const branch of selected) {
    const ref = `${options.remote}/${branch.name}`;
    console.log(`删除 ${ref}（${branch.sha}）`);
    try {
      git(['push', options.remote, '--delete', branch.name], { stdio: 'inherit' });
    } catch {
      failures += 1;
      console.error(`失败：${ref}`);
    }
  }
  if (failures > 0) {
    console.error(`完成，但有 ${failures} 个分支删除失败。`);
    return 1;
  }
  console.log(`完成：已删除 ${selected.length} 个已合并远端分支。`);
  return 0;
}

const invokedAsScript = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invokedAsScript) {
  process.exitCode = await main(process.argv.slice(2));
}
