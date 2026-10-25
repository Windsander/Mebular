// 已合并分支清理：纯选择逻辑，确保受保护分支不会进入删除清单。

import { describe, it, expect } from '@jest/globals';
import { isProtectedBranch, selectMergedBranches } from '../../scripts/prune-merged-branches.mjs';

const branches = [
  'main',
  'release/v0.1.1',
  'release-prep/v0.1.1',
  'site',
  'site-v1.0',
  'docs/merged',
  'fix/merged',
  'feat/open-pr',
  'chore/current',
  'chore/worktree',
].map((name) => ({ name, sha: 'abc1234', date: '2026-10-25', subject: `subject ${name}` }));

describe('prune-merged-branches：保护规则', () => {
  it('保护 main / release / release-prep / site / 当前分支 / worktree / open PR', () => {
    const selected = selectMergedBranches(branches, {
      current: 'chore/current',
      worktrees: ['chore/worktree'],
      openPrs: ['feat/open-pr'],
    });
    expect(selected.map((branch) => branch.name)).toEqual(['docs/merged', 'fix/merged']);
  });

  it('没有保护上下文时仍保护内置分支模式', () => {
    expect(isProtectedBranch('main')).toBe(true);
    expect(isProtectedBranch('release/v0.2.0')).toBe(true);
    expect(isProtectedBranch('release-prep/v0.2.0')).toBe(true);
    expect(isProtectedBranch('site-v1.3')).toBe(true);
    expect(isProtectedBranch('docs/merged')).toBe(false);
  });
});
