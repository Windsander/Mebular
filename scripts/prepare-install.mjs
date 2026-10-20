#!/usr/bin/env node
// prepare 钩子（F-INST-1）：让 `npm i -g github:…#<sha>` 一条命令装出可用 CLI。
//
// 根因：npm 的 git-dep staging 会继承外层 `npm i -g` 的 `global=true` 配置，
// 使内层依赖安装变成「全局安装」而**不在 clone 里生成 node_modules**；随后
// `prepare`（npm run build）找不到 `tsc`（实测：`sh: tsc: command not found`）。
//
// 修法：若构建工具链缺失，就在 clone 里补做一次**本地**安装——显式去掉 global
// 诉求（`npm_config_global`/argv），并用 `--ignore-scripts` 避免 `prepare` 递归。
// 随后执行完整构建（不变：仍跑全量 tsc 三包构建）。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const npmExec = process.env.npm_execpath;
const env = { ...process.env };
delete env.npm_config_global;
delete env.npm_config_argv;
delete env.npm_config_prefix;

function run(args) {
  if (npmExec && npmExec.endsWith('.js')) {
    execFileSync(process.execPath, [npmExec, ...args], { stdio: 'inherit', env });
  } else {
    execFileSync('npm', args, { stdio: 'inherit', env });
  }
}

const tscBin = join('node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tscBin)) {
  console.log('[prepare] 构建工具链缺失（git/全局安装路径）→ 本地安装依赖（含 dev，忽略脚本）');
  run(['install', '--no-save', '--no-audit', '--no-fund', '--include=dev', '--ignore-scripts']);
}

run(['run', 'build']);
