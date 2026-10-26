// 共享 Runtime 布局与版本约束（无状态、可被 installer/current/service 共用）。
//
// 单独成模块的原因：`runtime-current` 需要校验 current 指向的安装布局，而
// `runtime-installer` 又要写入 current；把路径/版本规则放在这里可避免两者循环依赖，
// 也让“共享 runtime 目录结构”只有一个真源。

import { join } from 'node:path';
import { cloudError } from './profiles.mjs';

export const RUNTIME_DIR = 'runtime';
export const RUNTIME_CLI_RELATIVE = join('node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs');
export const RUNTIME_PACKAGE_RELATIVE = join('node_modules', '@mebular', 'core', 'package.json');
export const RUNTIME_PACKAGE_NAME = '@mebular/core';

const SEMVER_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_VERSION_LENGTH = 128;

export function runtimeRootPath(root) {
  return join(root, RUNTIME_DIR);
}

export function runtimeVersionPath(root, version) {
  return join(runtimeRootPath(root), version);
}

export function sharedRuntimeCliPath(root, version) {
  return join(runtimeVersionPath(root, version), RUNTIME_CLI_RELATIVE);
}

export function manualRuntimeInstallCommand(version) {
  return `npm install -g ${RUNTIME_PACKAGE_NAME}@${version}`;
}

/** 严格 semver + 路径安全：只允许可安全拼进目录/npm spec 的字符。 */
export function assertRuntimeVersion(value) {
  if (typeof value !== 'string') {
    throw cloudError('unsupported_version', 'runtime 版本必须是字符串');
  }
  const version = value.trim();
  if (version.length === 0 || version.length > MAX_VERSION_LENGTH || !SEMVER_RE.test(version)) {
    throw cloudError('unsupported_version', `不支持的 runtime 版本：${version.slice(0, MAX_VERSION_LENGTH) || '(空)'}`);
  }
  return version;
}
