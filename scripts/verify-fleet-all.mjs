#!/usr/bin/env node
// S6：单命令跑完全部 fleet 验收（local + remote + agents + onboard）→ 一个 JSON 摘要（含 skipped）。
//
// 依次运行各脚本（每个都打印 `FLEET_SUMMARY {json}`），汇总后打印总账；任一子验收失败 → 非零退出。
// 前置：npm run build。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SUITES = [
  { name: 'local', script: fileURLToPath(new URL('./verify-fleet-local.mjs', import.meta.url)) },
  { name: 'remote', script: fileURLToPath(new URL('./verify-fleet-remote.mjs', import.meta.url)) },
  { name: 'agents', script: fileURLToPath(new URL('./verify-fleet-agents.mjs', import.meta.url)) },
  { name: 'onboard', script: fileURLToPath(new URL('./verify-fleet-onboard.mjs', import.meta.url)) },
  { name: 'grant', script: fileURLToPath(new URL('./verify-fleet-grant.mjs', import.meta.url)) },
  { name: 'service', script: fileURLToPath(new URL('./verify-fleet-service.mjs', import.meta.url)) },
  { name: 'membership', script: fileURLToPath(new URL('./verify-fleet-membership.mjs', import.meta.url)) },
  { name: 'handoff', script: fileURLToPath(new URL('./verify-fleet-handoff.mjs', import.meta.url)) },
  { name: 'rejoin', script: fileURLToPath(new URL('./verify-fleet-rejoin.mjs', import.meta.url)) },
];

function run(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      const line = out.split('\n').reverse().find((l) => l.startsWith('FLEET_SUMMARY '));
      let summary = null;
      if (line) {
        try {
          summary = JSON.parse(line.slice('FLEET_SUMMARY '.length));
        } catch {
          summary = null;
        }
      }
      resolve({ code, out, err, summary });
    });
  });
}

const aggregate = { ok: true, suites: {}, total: 0, passed: 0, failed: [], skipped: [] };
for (const suite of SUITES) {
  const res = await run(suite.script);
  if (res.summary === null) {
    aggregate.ok = false;
    aggregate.suites[suite.name] = { total: 0, passed: 0, failed: ['no FLEET_SUMMARY'], skipped: [] };
    aggregate.failed.push(`${suite.name}:no-summary`);
    console.log(`FAIL  ${suite.name}  (exit ${res.code}, no FLEET_SUMMARY)`);
    continue;
  }
  const s = res.summary;
  aggregate.suites[suite.name] = s;
  aggregate.total += s.total;
  aggregate.passed += s.passed;
  for (const f of s.failed) aggregate.failed.push(`${suite.name}:${f}`);
  for (const sk of s.skipped ?? []) aggregate.skipped.push({ suite: suite.name, ...(typeof sk === 'string' ? { name: sk } : sk) });
  if (res.code !== 0 || (s.failed?.length ?? 0) > 0) aggregate.ok = false;
  console.log(`${res.code === 0 && (s.failed?.length ?? 0) === 0 ? 'PASS' : 'FAIL'}  ${suite.name}  total=${s.total} passed=${s.passed} failed=${s.failed?.length ?? 0} skipped=${(s.skipped ?? []).length}  (exit ${res.code})`);
}

console.log('== verify:fleet:all ==');
console.log(JSON.stringify(aggregate, null, 2));
process.exit(aggregate.ok ? 0 : 1);
