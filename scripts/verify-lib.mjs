#!/usr/bin/env node
// verify 脚本共享工具（G0）
//
// `docs.design/` 是本地设计文档，已被 .gitignore 排除、不随仓库分发。
// 新克隆环境下 `verify-phase*.mjs` 不应因缺少这些文档而整体失败：
// 文档项**跳过并打印一次告警**，代码/测试/构建等实质检查照常执行。

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scriptsDir = dirname(fileURLToPath(import.meta.url));
export const rootDir = join(scriptsDir, '..');
export const docsDesignDir = join(rootDir, 'docs.design');

/** 本地设计文档目录是否存在（新克隆下不存在） */
export function hasDocsDesign() {
  return existsSync(docsDesignDir);
}

/**
 * 检查单个必需路径。
 * @param {string} relPath 相对仓库根目录的路径
 * @returns {'ok'|'missing'|'skipped'} `docs.design/*` 在目录整体缺失时返回 'skipped'
 */
export function checkRequiredFile(relPath) {
  if (relPath.startsWith('docs.design/') && !hasDocsDesign()) {
    return 'skipped';
  }
  return existsSync(join(rootDir, relPath)) ? 'ok' : 'missing';
}

/**
 * 逐项检查并打印；返回是否全部通过（跳过的文档项不计失败）。
 * docs.design 缺失时只打印一次告警。
 * @param {string[]} files 相对仓库根目录的路径
 * @param {{indent?: string, showSize?: boolean}} [opts]
 * @returns {boolean}
 */
export function checkFiles(files, opts = {}) {
  const indent = opts.indent ?? '  ';
  const showSize = opts.showSize ?? false;
  let passed = true;
  let docsWarned = false;

  for (const file of files) {
    const status = checkRequiredFile(file);
    if (status === 'skipped') {
      if (!docsWarned) {
        console.log(
          `${indent}⚠ 跳过文档检查：docs.design/ 不存在（本地設計文件不隨倉庫分發，見 CONTRIBUTING.md）`,
        );
        docsWarned = true;
      }
      continue;
    }
    if (status === 'ok') {
      const suffix = showSize ? ` (${statSync(join(rootDir, file)).size} 字节)` : '';
      console.log(`${indent}✓ ${file}${suffix}`);
    } else {
      console.log(`${indent}✗ 缺失: ${file}`);
      passed = false;
    }
  }

  return passed;
}
