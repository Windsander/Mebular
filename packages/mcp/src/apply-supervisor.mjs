#!/usr/bin/env node
// G：应用监督进程（分离启动；守护被重启/终止后仍能完成「健康校验 → 回滚兜底」）。
//
// 由 serve 在保存需重启配置时分离启动：
//   node apply-supervisor.mjs --home <home> --config <config.json> --old-pid <pid> [--port N] [--fields a,b] [--timeout ms]
//
// 退出码：0 = 已生效或已回滚（结果写 <home>/config-apply.result.json）；2 = 监督失败。

import { runApplySupervisor } from './config-apply.mjs';
import { resolveBuildSha } from '@mebular/service';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

const flags = parseArgs(process.argv.slice(2));
const home = typeof flags.home === 'string' ? flags.home : null;
if (!home) {
  console.error('apply-supervisor: 缺少 --home');
  process.exit(2);
}
const configFile = typeof flags.config === 'string' ? flags.config : `${home}/config.json`;
const oldPid = Number(flags['old-pid'] ?? '0') || 0;
const port = Number(flags.port ?? '0') || 0;
const fields = typeof flags.fields === 'string' && flags.fields.length > 0 ? flags.fields.split(',').filter(Boolean) : [];
const timeoutMs = Number(flags.timeout ?? '0') > 0 ? Number(flags.timeout) : undefined;

const result = await runApplySupervisor({
  home,
  configFile,
  oldPid,
  port,
  fields,
  ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  log: (message) => console.error(`[apply ${new Date().toISOString()}] ${message}`),
}).catch((error) => ({ status: 'supervisor-error', reason: String(error?.message ?? error) }));

console.error(`[apply] 结果：${JSON.stringify(result)} sha=${resolveBuildSha()}`);
process.exit(result.status === 'supervisor-error' ? 2 : 0);
