#!/usr/bin/env node
// Negative control for the DSH checkpoint fault harness (test-of-test).
//
// It packs a copy of @mebular/dsh-plugin whose 202 branch is deliberately
// broken to report `committed`, then runs the real DSH + real sidecar/capability
// `faults` scenario. A green harness is only meaningful if this regression makes
// the 202 pending assertion red.
//
// It additionally mutates the runtime module in-process for B1/B2/H1/M3 so the
// focused unit assertions are proven to detect those historical defects too.

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { packPackage, runCommand } from '../../../scripts/lib/e2e-process.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pluginDir = join(repoRoot, 'packages', 'dsh-plugin');
const runner = join(repoRoot, 'tests', 'integration', 'host-e2e', 'dsh-real-runtime.mjs');

const PENDING = `      if (pending) {
        state.committed = false;
        state.pending = true;
        state.failed = false;
        state.error = null;
        state.revision = null;
        stats.checkpoints.pending += 1;`;
const BROKEN = `      if (pending) {
        state.committed = true;
        state.pending = false;
        state.failed = false;
        state.error = null;
        state.revision = 1;
        stats.checkpoints.committed += 1;`;

function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
  return ok;
}

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({ ok: status >= 200 && status < 300, data }),
  };
}

function jsonFailure(status, code) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ ok: false, error: { code, retryable: false } }),
  };
}

function cloudCheckpoint(revision, state = {}) {
  return jsonResponse(200, {
    source: 'cloud',
    degraded: false,
    checkpoint: {
      revision,
      source: 'cloud',
      stale: false,
      degraded: false,
      pending: false,
      state,
    },
  });
}

function cloudEmpty() {
  return jsonResponse(200, { source: 'cloud', degraded: false, checkpoint: null });
}

function compactionEvents(compactionId = 'c1', endSeq = 13) {
  return [
    { type: 'compaction/start', seq: endSeq - 3, time: 1, data: { compactionId, turn: 1 } },
    {
      type: 'compaction/summary',
      seq: endSeq - 2,
      time: 2,
      data: { compactionId, summary: [{ type: 'text', text: 'summary' }] },
    },
    {
      type: 'user/message',
      seq: endSeq - 1,
      time: 3,
      data: {
        id: `replacement-${compactionId}`,
        role: 'user',
        content: [{ type: 'text', text: 'summary' }],
        source: { kind: 'compact-checkpoint', compactionId },
      },
    },
    { type: 'compaction/end', seq: endSeq, time: 4, data: { compactionId, turn: 1 } },
  ];
}

async function runMini(createAdapter, { get, put, compactionId = 'c1', endSeq = 13, before = null, repeat = false }) {
  const listeners = new Map();
  const ctx = {
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {};
    },
  };
  const calls = [];
  let putCount = 0;
  const fetchImpl = async (url, init = {}) => {
    let body = null;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    calls.push({ url, init, body });
    if (init.method === 'GET') return get(calls.filter((entry) => entry.init.method === 'GET').length - 1);
    putCount += 1;
    return put(putCount - 1, body);
  };
  const adapter = createAdapter({
    ctx,
    config: {
      url: 'http://127.0.0.1:7331/memory-runtime/v1',
      recall: false,
      ingest: false,
      checkpoints: true,
      hideMemoryTools: false,
      checkpointTimeoutMs: 50,
      checkpointRetries: 0,
      checkpointRetryBaseMs: 1,
    },
    homeDir: join(tmpdir(), 'mebular-negative-nohome'),
    env: {},
    fetchImpl,
  });
  const listener = listeners.get('session/event')[0];
  const session = { id: 's1' };
  for (const event of compactionEvents(compactionId, endSeq)) listener(session, event);
  await adapter.flush();
  if (typeof before === 'function') await before(adapter);
  if (repeat) {
    for (const event of compactionEvents(compactionId, endSeq)) listener(session, event);
    await adapter.flush();
  }
  const state = adapter.getState();
  await adapter.dispose();
  return { calls, state };
}

async function loadAdapter(dir, label) {
  const moduleUrl = `${pathToFileURL(join(dir, 'memory-runtime.js')).href}?negative=${label}-${Date.now()}`;
  const module = await import(moduleUrl);
  return module.createMemoryRuntimeAdapter;
}

async function mutateCopy(scratch, label, mutations) {
  const dir = join(scratch, `plugin-${label}`);
  await cp(pluginDir, dir, {
    recursive: true,
    filter: (source) => !/(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/.test(source)
      && !source.endsWith('.tgz'),
  });
  const file = join(dir, 'memory-runtime.js');
  let source = await readFile(file, 'utf8');
  for (const [from, to] of mutations) {
    if (!source.includes(from)) throw new Error(`negative ${label}: mutation target missing`);
    source = source.replace(from, to);
  }
  await writeFile(file, source, 'utf8');
  return dir;
}

async function runMutationChecks(scratch) {
  const checks = [];
  const legacyDir = await mutateCopy(scratch, 'b1', [[
    'if (remoteEnd === null || localEnd === null) return false;',
    'if (remoteEnd === null || localEnd === null) return true;',
  ]]);
  const legacy = await runMini(await loadAdapter(legacyDir, 'b1'), {
    get: () => cloudCheckpoint(3, { legacy: true }),
    put: () => cloudCheckpoint(4, { compactionId: 'c1', endSeq: 13 }),
  });
  checks.push(check('B1 negative：legacy current 被误判 supersede 时无 PUT',
    legacy.calls.filter((entry) => entry.init.method === 'PUT').length === 0
    && legacy.state.compactions[0]?.superseded === true));

  const equalDir = await mutateCopy(scratch, 'm3', [[
    'return remoteEnd > localEnd;',
    'return remoteEnd >= localEnd;',
  ]]);
  const equal = await runMini(await loadAdapter(equalDir, 'm3'), {
    get: () => cloudCheckpoint(5, { compactionId: 'other', endSeq: 13 }),
    put: () => cloudCheckpoint(6, { compactionId: 'c1', endSeq: 13 }),
  });
  checks.push(check('M3 negative：相等 endSeq 被误判 supersede 时无 PUT',
    equal.calls.filter((entry) => entry.init.method === 'PUT').length === 0
    && equal.state.compactions[0]?.superseded === true));

  const conflictDir = await mutateCopy(scratch, 'h1', [[
    'if (isRetryableAuthorityFailure(current)) {',
    'if (false) {',
  ]]);
  let h1Gets = 0;
  const conflict = await runMini(await loadAdapter(conflictDir, 'h1'), {
    get: () => {
      h1Gets += 1;
      if (h1Gets === 1) return cloudCheckpoint(4, { compactionId: 'older', endSeq: 3 });
      return jsonResponse(200, {
        source: 'cache',
        degraded: true,
        checkpoint: { revision: 4, source: 'cache', stale: true, degraded: true, pending: false },
      });
    },
    put: () => jsonFailure(409, 'revision_mismatch'),
  });
  checks.push(check('H1 negative：409 + cache/stale 被误判永久 failed',
    conflict.state.checkpoints.failed === 1));

  const priorDir = await mutateCopy(scratch, 'b2', [[
    `        } else {
          // The authoritative graph has a different/older checkpoint. The
          // cached committedRevision is no longer trustworthy; clear it and
          // write against the current authoritative revision.
          priorOperation = null;
          checkpointOperations.delete(operationKey);
          checkpointRevisions.set(revisionKey, current.revision);
        }`,
    '        }',
  ]]);
  let b2FirstPhase = true;
  const prior = await runMini(await loadAdapter(priorDir, 'b2'), {
    get: () => (b2FirstPhase
      ? cloudEmpty()
      : cloudCheckpoint(2, { legacy: true })),
    put: (count) => {
      if (count === 0) return cloudCheckpoint(1, { compactionId: 'c1', endSeq: 13 });
      return cloudCheckpoint(3, { compactionId: 'c1', endSeq: 13 });
    },
    before: async () => { b2FirstPhase = false; },
    repeat: true,
  });
  checks.push(check('B2 negative：prior committed + 更旧 current 时被误判 committed',
    prior.calls.filter((entry) => entry.init.method === 'PUT').length === 1
    && prior.state.compactions.at(-1)?.failed !== true));
  return checks;
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'mebular-dsh-checkpoint-negative-'));
  let keep = false;
  let exitCode = 1;
  try {
    console.log('DSH checkpoint 202 negative control（test-of-test）');
    console.log('==================================================');
    const badDir = join(scratch, 'dsh-plugin');
    await cp(pluginDir, badDir, {
      recursive: true,
      filter: (source) => !/(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/.test(source)
        && !source.endsWith('.tgz'),
    });
    const runtimePath = join(badDir, 'memory-runtime.js');
    const source = await readFile(runtimePath, 'utf8');
    if (!source.includes(PENDING)) throw new Error('未找到 202 pending 分支，无法构造坏插件');
    await writeFile(runtimePath, source.replace(PENDING, BROKEN), 'utf8');

    const packDir = join(scratch, 'pack');
    await mkdir(packDir, { recursive: true });
    const badTarball = await packPackage(badDir, packDir, 'broken @mebular/dsh-plugin (202 committed)');
    check('坏插件已构造为 202=committed', badTarball.size > 0, `${badTarball.filename} (${badTarball.size}B)`);

    const result = await runCommand('checkpoint negative control', process.execPath, [
      runner,
      '--scenario', 'faults',
      '--plugin-tarball', badTarball.path,
    ], { cwd: repoRoot, timeoutMs: 900000 });
    const output = `${result.stdout}\n${result.stderr}`;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);

    console.log('\n断言');
    const checks = [
      check('坏插件使 real host E2E 非零退出', result.code !== 0 && result.timedOut !== true, `code=${result.code}`),
      check('faults 场景确实运行', /▶ faults/.test(output)),
      check('202 pending 断言判红',
        /✗ capability 故障时真实 sidecar 以 202 queued 回复，宿主保持 pending/.test(output)),
      check('前置 429 检查仍为绿（失败不是 DSH 未启动）',
        /✓ 429 via synthetic tap（首个 PUT 未到真实 sidecar）：重试后提交/.test(output)),
    ];
    checks.push(...await runMutationChecks(scratch));
    if (checks.every(Boolean)) {
      exitCode = 0;
      console.log('\n✓ checkpoint negative control 通过：202 与 B1/B2/H1/M3 回归均被捕获。');
    } else {
      keep = true;
      console.log('\n✗ checkpoint negative control 失败：回归没有被预期断言拦住。');
    }
  } catch (error) {
    keep = true;
    console.error(`\n✗ checkpoint negative control 未完成：${error?.stack ?? error}`);
  } finally {
    if (keep) {
      console.log(`临时目录保留：${scratch}`);
    } else {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return exitCode;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ checkpoint negative control 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
