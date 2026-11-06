#!/usr/bin/env node
// 失败路径 / 中断路径的故障注入验证。
//
// 覆盖：
// 1. seed 批次失败（注入）仍写 partial JSON；
// 2. read 样本失败（注入）仍写 partial JSON；
// 3. SIGTERM 中断仍写 partial JSON 并完成清理；
// 4. sidecar SIGKILL 后的异常路径仍写 JSON，且清理不残留。
//
// 所有临时 home/output 都在 os.tmpdir()，不接触用户真实 home。
// 用法：
//   node tests/integration/scale-bench/failure-injection.mjs \
//     --out docs/quality/0.3.2-scale-benchmark-failure-injection.json

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const RUNNER = join(HERE, 'run.mjs');
const DEFAULT_OUT = join(ROOT, 'docs/quality/0.3.2-scale-benchmark-failure-injection.json');
const CASE_TIMEOUT_MS = 180_000;

function parseArgs(argv) {
  let out = DEFAULT_OUT;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      out = resolve(String(argv[index + 1] ?? ''));
      index += 1;
    } else if (argv[index] === '--help' || argv[index] === '-h') {
      process.stdout.write('用法: node tests/integration/scale-bench/failure-injection.mjs [--out <path>]\n');
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${argv[index]}`);
    }
  }
  return { out };
}

function gitInfo() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
    return { sha, dirty: status.length > 0, dirtyFileCount: status === '' ? 0 : status.split('\n').length };
  } catch {
    return { sha: null, dirty: null, dirtyFileCount: null };
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function runCase({ label, args, outputPath, killAfterSeedBatch = false, killSignal = 'SIGTERM' }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [RUNNER, ...args, '--label', label, '--output', outputPath], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({ ...result, stdout, stderr });
    };

    const timer = setTimeout(async () => {
      child.kill('SIGKILL');
      await finish({ exitCode: null, signal: 'TIMEOUT', json: await readJson(outputPath) });
    }, CASE_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    if (killAfterSeedBatch) {
      const poll = setInterval(async () => {
        const json = await readJson(outputPath);
        if (json?.seed?.batchesCompleted >= 1) {
          clearInterval(poll);
          child.kill(killSignal);
          killTimer = setTimeout(() => child.kill('SIGKILL'), 25_000);
          killTimer.unref?.();
        }
      }, 50);
      poll.unref?.();
      child.once('exit', () => clearInterval(poll));
    }

    child.once('exit', async (code, signal) => {
      clearTimeout(timer);
      await finish({ exitCode: code, signal, json: await readJson(outputPath) });
    });
    child.once('error', async (error) => {
      clearTimeout(timer);
      await finish({ exitCode: null, signal: 'SPAWN_ERROR', error: String(error?.message ?? error) });
    });
  });
}

function assertCase(condition, message) {
  assert.equal(Boolean(condition), true, message);
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(join(os.tmpdir(), 'mebular-scale-failure-'));
  const startedAt = new Date().toISOString();
  const cases = [];
  const failures = [];

  async function executeCase(name, caseOptions, verify) {
    const outputPath = join(tempRoot, `${name}.json`);
    const result = await runCase({ ...caseOptions, outputPath });
    const entry = {
      name,
      exitCode: result.exitCode,
      signal: result.signal,
      jsonPresent: result.json !== null,
      status: result.json?.status ?? null,
      error: result.json?.error ?? null,
      seed: result.json?.seed
        ? {
          status: result.json.seed.status,
          writtenRecords: result.json.seed.writtenRecords,
          batchesCompleted: result.json.seed.batchesCompleted,
          faultInjection: result.json.seed.faultInjection ?? null,
        }
        : null,
      reads: result.json?.reads
        ? {
          status: result.json.reads.status,
          samplesCompleted: result.json.reads.samplesCompleted,
          faultInjection: result.json.reads.faultInjection ?? null,
        }
        : null,
      checkpoints: result.json?.checkpoints ?? null,
      sidecarPids: result.json?.sidecarPids ?? null,
      sidecarPidEvents: result.json?.sidecarPidEvents ?? null,
      cleanup: result.json?.cleanup
        ? {
          cleaned: result.json.cleanup.cleaned,
          tempHomeRemoved: result.json.cleanup.tempHomeRemoved,
          residualPids: result.json.cleanup.residualPids,
          sidecarStop: result.json.cleanup.sidecarStop,
          errors: result.json.cleanup.errors,
        }
        : null,
    };
    try {
      verify(result, result.json);
      entry.ok = true;
    } catch (error) {
      entry.ok = false;
      entry.assertionError = String(error?.message ?? error);
      failures.push({ name, error: entry.assertionError });
    }
    cases.push(entry);
    process.stderr.write(`[failure-injection] ${name}: ${entry.ok ? 'PASS' : 'FAIL'} (exit=${result.exitCode})\n`);
  }

  try {
    await executeCase('seed-failure', {
      args: [
        '--records', '20', '--details', '20', '--batch-size', '5', '--queries', '2',
        '--fail-after-batches', '1',
      ],
    }, (result, json) => {
      assertCase(result.exitCode === 1, `expected exit 1, got ${result.exitCode}`);
      assertCase(json, 'partial JSON missing');
      assertCase(json.status === 'failed', `expected failed, got ${json.status}`);
      assertCase(json.seed?.status === 'failed', 'seed status not failed');
      assertCase(json.seed?.writtenRecords === 5, `expected 5 written records, got ${json.seed?.writtenRecords}`);
      assertCase(json.seed?.batchesCompleted === 1, 'seed checkpoint count mismatch');
      assertCase(json.seed?.faultInjection?.type === 'seed_fail_after_batches', 'fault injection marker missing');
      assertCase(json.checkpoints?.count > 0, 'no periodic checkpoint recorded');
      assertCase(json.cleanup?.cleaned === true, `cleanup failed: ${JSON.stringify(json.cleanup)}`);
      assertCase(json.cleanup?.tempHomeRemoved === true, 'temp home not removed');
    });

    await executeCase('read-failure', {
      args: [
        '--records', '20', '--details', '20', '--batch-size', '5', '--queries', '4',
        '--fail-after-read-samples', '1',
      ],
    }, (result, json) => {
      assertCase(result.exitCode === 1, `expected exit 1, got ${result.exitCode}`);
      assertCase(json, 'partial JSON missing');
      assertCase(json.status === 'failed', `expected failed, got ${json.status}`);
      assertCase(json.seed?.status === 'completed', 'seed should complete before read failure');
      assertCase(json.seed?.writtenRecords === 20, 'seed records missing');
      assertCase(json.reads?.status === 'failed', 'reads status not failed');
      assertCase(json.reads?.samplesCompleted === 1, 'read checkpoint count mismatch');
      assertCase(json.reads?.faultInjection?.type === 'reads_fail_after_samples', 'read fault marker missing');
      assertCase(json.cleanup?.cleaned === true, `cleanup failed: ${JSON.stringify(json.cleanup)}`);
    });

    await executeCase('sigterm', {
      args: [
        '--records', '1000', '--details', '1000', '--batch-size', '10', '--queries', '4',
      ],
      killAfterSeedBatch: true,
    }, (result, json) => {
      assertCase(result.exitCode === 143, `expected SIGTERM exit 143, got ${result.exitCode}`);
      assertCase(json, 'partial JSON missing after SIGTERM');
      assertCase(json.status === 'interrupted', `expected interrupted, got ${json.status}`);
      assertCase(json.abort?.reason === 'SIGTERM', 'abort reason mismatch');
      assertCase(json.seed?.writtenRecords > 0, 'no seed records before SIGTERM');
      assertCase(json.cleanup?.cleaned === true, `cleanup failed: ${JSON.stringify(json.cleanup)}`);
      assertCase(json.cleanup?.residualPids?.length === 0, 'sidecar residual process left');
    });

    await executeCase('sigint', {
      args: [
        '--records', '1000', '--details', '1000', '--batch-size', '10', '--queries', '4',
      ],
      killAfterSeedBatch: true,
      killSignal: 'SIGINT',
    }, (result, json) => {
      assertCase(result.exitCode === 130, `expected SIGINT exit 130, got ${result.exitCode}`);
      assertCase(json, 'partial JSON missing after SIGINT');
      assertCase(json.status === 'interrupted', `expected interrupted, got ${json.status}`);
      assertCase(json.abort?.reason === 'SIGINT', 'abort reason mismatch');
      assertCase(json.seed?.writtenRecords > 0, 'no seed records before SIGINT');
      assertCase(json.cleanup?.cleaned === true, `cleanup failed: ${JSON.stringify(json.cleanup)}`);
      assertCase(json.cleanup?.residualPids?.length === 0, 'sidecar residual process left');
    });

    await executeCase('sidecar-sigkill', {
      args: [
        '--records', '20', '--details', '20', '--batch-size', '5', '--queries', '2',
        '--kill-sidecar-after-batches', '1',
      ],
    }, (result, json) => {
      assertCase(json, 'JSON missing after sidecar SIGKILL');
      assertCase(json.seed?.faultInjection?.type === 'sidecar_sigkill', 'sidecar kill marker missing');
      assertCase(json.cleanup?.cleaned === true, `cleanup failed: ${JSON.stringify(json.cleanup)}`);
      assertCase(json.cleanup?.residualPids?.length === 0, 'sidecar residual process left');
      const killedPid = json.seed?.faultInjection?.pid ?? null;
      assertCase(
        Array.isArray(json.sidecarPids)
          && json.sidecarPids.length >= 2
          && json.sidecarPids.includes(killedPid)
          && json.sidecarPids.some((pid) => pid !== killedPid),
        `sidecar restart pid not tracked: ${JSON.stringify(json.sidecarPids)}`,
      );
      assertCase(
        Array.isArray(json.sidecarPidEvents) && json.sidecarPidEvents.length >= 2,
        `sidecar pid event log incomplete: ${JSON.stringify(json.sidecarPidEvents)}`,
      );
      assertCase(result.exitCode === 0 || result.exitCode === 1, `unexpected exit ${result.exitCode}`);
    });

    await executeCase('cleanup-sigkill-fallback', {
      args: [
        '--records', '20', '--details', '20', '--batch-size', '5', '--queries', '2',
        '--freeze-sidecar-after-batches', '1',
      ],
    }, (result, json) => {
      assertCase(result.exitCode === 1, `expected exit 1, got ${result.exitCode}`);
      assertCase(json, 'JSON missing after frozen sidecar');
      assertCase(json.status === 'failed', `expected failed, got ${json.status}`);
      assertCase(json.seed?.faultInjection?.type === 'sidecar_sigstop', 'sidecar freeze marker missing');
      assertCase(json.cleanup?.cleaned === true, `cleanup failed: ${JSON.stringify(json.cleanup)}`);
      assertCase(json.cleanup?.tempHomeRemoved === true, 'temp home not removed');
      assertCase(json.cleanup?.residualPids?.length === 0, 'sidecar residual process left');
      const frozenPid = json.seed?.faultInjection?.pid ?? null;
      const stop = Array.isArray(json.cleanup?.sidecarStop)
        ? json.cleanup.sidecarStop.find((entry) => entry.pid === frozenPid)
        : null;
      assertCase(stop?.stopped === true, `frozen sidecar not stopped: ${JSON.stringify(json.cleanup?.sidecarStop)}`);
      assertCase(stop?.escalation === 'SIGKILL', `expected SIGKILL escalation, got ${stop?.escalation}`);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  const summary = {
    schema: 'mebular.scale-benchmark-failure-injection/1',
    status: failures.length === 0 ? 'passed' : 'failed',
    startedAt,
    finishedAt: new Date().toISOString(),
    git: gitInfo(),
    realBoundary: [
      'real MCP capability + GraphStore/MemoryService + managed sidecar',
      'fault injection only triggers failure timing; product components remain real',
      'no real host/model/sync',
    ],
    cases,
    failures,
  };
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  process.stdout.write(`${JSON.stringify({
    status: summary.status,
    cases: cases.map((entry) => ({ name: entry.name, ok: entry.ok, exitCode: entry.exitCode })),
    failures,
    output: out,
  }, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
