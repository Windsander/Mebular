#!/usr/bin/env node
// Hermes host E2E: real MemoryProvider plugin + real Runtime HTTP.
//
// Boundary: this does not start a real Hermes gateway or run an LLM. It loads
// the exact plugin file a Hermes profile loads, drives the documented
// MemoryProvider methods (initialize / prefetch / sync_turn / on_pre_compress /
// on_session_switch / shutdown), and sends real HTTP to the real Runtime.
//
// Usage:
//   node tests/integration/host-e2e/hermes-real-runtime.mjs [--keep]

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRealRuntime } from './lib/real-runtime.mjs';
import { createRuntimeTap } from './lib/runtime-tap.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const pythonScript = join(here, 'hermes-real-runtime.py');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
  return ok;
}

function runPython(env, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn('python3', [pythonScript], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function parseMarker(stdout) {
  const line = stdout.split('\n').find((entry) => entry.startsWith('HERMES_E2E_RESULT '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('HERMES_E2E_RESULT '.length));
  } catch {
    return null;
  }
}

async function scanForToken(dir, token) {
  const hits = [];
  async function walk(current) {
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'tokens.json') {
        const text = await readFile(path, 'utf8').catch(() => '');
        if (text.includes(token)) hits.push(path);
      } else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.log') || entry.name.endsWith('.txt'))) {
        const text = await readFile(path, 'utf8').catch(() => '');
        if (text.includes(token)) hits.push(path);
      }
    }
  }
  await walk(dir);
  return hits;
}

async function main() {
  const keep = process.argv.includes('--keep');
  const runRoot = join(tmpdir(), `mebular-hermes-host-e2e-${process.pid}-${Date.now()}`);
  const hermesHome = join(runRoot, 'hermes-home');
  await mkdir(hermesHome, { recursive: true });

  const runtime = await startRealRuntime({ auth: 'bearer', token: `hermes-host-token-${Date.now()}` });
  const tap = await createRuntimeTap(runtime.url, { name: 'hermes-real-runtime' });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const query = `hermes-prefetch-${suffix}`;
  const turnUser = `以后默认用 hermes-turn-${suffix} 主题`;
  const compressUser = `hermes-compress-${suffix} 这段对话在压缩前归档`;
  const nextTurnUser = `以后默认用 hermes-s2-${suffix} 主题`;
  const secretSystemPrompt = `SECRET HOST PROMPT ${suffix} do not archive`;

  await writeFile(join(hermesHome, 'mebular-memory.json'), JSON.stringify({
    runtime_url: tap.url,
    agent_id: 'hermes',
    capture: 'local',
    extractor: 'heuristic',
    recall_timeout: 3,
    ingest_timeout: 3,
    archive_flush_timeout: 3,
  }, null, 2), 'utf8');

  const config = {
    session_id: 'hermes-s1',
    query,
    turn_user: turnUser,
    turn_assistant: '已经记住这个偏好。',
    compress_user: compressUser,
    compress_assistant: '压缩前的助手回复。',
    secret_system_prompt: secretSystemPrompt,
    next_session_id: 'hermes-s2',
    next_turn_user: nextTurnUser,
    next_turn_assistant: '第二个会话已经记住。',
  };

  try {
    console.log('Hermes 真实 plugin + 真实 Runtime HTTP');
    console.log('===================================');
    const seeded = await runtime.seedMemory({
      text: `以后默认用 ${query} 主题`,
      namespace: 'default',
      agentId: 'hermes',
    });
    check('Runtime heuristic seed 写入', seeded.accepted.records === 1, JSON.stringify(seeded.records));

    const python = await runPython({
      HERMES_HOME: hermesHome,
      MEBULAR_HOME: join(runRoot, 'unused-mebular-home'),
      MEBULAR_RUNTIME_TOKEN: runtime.token,
      HERMES_E2E_CONFIG: JSON.stringify(config),
      PYTHONDONTWRITEBYTECODE: '1',
    }, repoRoot);

    const result = parseMarker(python.stdout) ?? parseMarker(python.stderr);
    check('Python plugin 进程退出 0', python.code === 0, `code=${python.code}`);
    check('插件结果可解析', result !== null && result.error === undefined,
      result?.error ?? python.stderr.slice(-500));

    if (result !== null && result.error === undefined) {
      check('真实 Runtime 可发现', result.available === true);
      check('插件不暴露工具（保持 MCP 治理面）', Array.isArray(result.tools) && result.tools.length === 0);
      check('system prompt 声明 Mebular 记忆已启用', String(result.systemPrompt).includes('Mebular Memory'));
      check('prefetch 命中 seed 记忆', String(result.prefetch).includes('## Mebular Memory')
        && String(result.prefetch).includes(query), result.prefetch);
      check('prefetch 第二次仍可用', String(result.prefetchSecond).includes(query));
      check('sync_turn 已 flush', result.turnFlushed === true && result.turnPending === 0,
        JSON.stringify({ flushed: result.turnFlushed, pending: result.turnPending }));
      check('on_pre_compress 返回空且不阻塞', result.preCompressReturn === ''
        && result.compressFlushed === true && result.compressPending === 0,
        JSON.stringify({ returned: result.preCompressReturn, pending: result.compressPending }));
      check('session switch 后 s2 已 flush', result.switchFlushed === true && result.switchPending === 0);
      check('shutdown 后队列清空', result.pendingAfterShutdown === 0);
    }

    const requests = tap.runtimeRequests();
    check('所有 Runtime 请求通过真实 bearer', requests.length > 0
      && requests.every((entry) => entry.auth === 'bearer' && entry.ok), JSON.stringify(
      requests.map((entry) => `${entry.method} ${entry.path}:${entry.status}:${entry.auth}`),
    ));

    const recalls = requests.filter((entry) => entry.method === 'POST' && entry.path === '/runtime/v1/recall');
    check('prefetch 走真实 /recall 且返回 seed 记录', recalls.length >= 2
      && recalls.every((entry) => entry.body?.query === query)
      && JSON.stringify(recalls[0]?.response).includes(query), `count=${recalls.length}`);

    const ingests = requests.filter((entry) => entry.method === 'POST' && entry.path === '/runtime/v1/ingest');
    const ingestTexts = ingests.map((entry) => (entry.body?.chunks ?? []).map((chunk) => chunk.text).join('\n'));
    check('sync_turn 走真实 /ingest 且 thread=s1', ingests.some((entry) => entry.body?.threadId === 'hermes-s1'
      && ingestTexts[ingests.indexOf(entry)].includes(turnUser)), `count=${ingests.length}`);
    const compress = ingests.find((entry) => String(entry.body?.requestId).startsWith('hermes_compress'));
    const compressText = (compress?.body?.chunks ?? []).map((chunk) => chunk.text).join('\n');
    check('on_pre_compress 走真实 /ingest 并归档 user 内容', compress !== undefined
      && compressText.includes(compressUser), compress?.body?.requestId ?? 'missing');
    check('on_pre_compress 不归档 system prompt', !compressText.includes(secretSystemPrompt));
    check('session switch 后 ingest thread=s2', ingests.some((entry) => entry.body?.threadId === 'hermes-s2'
      && (entry.body?.chunks ?? []).some((chunk) => String(chunk.text).includes(nextTurnUser))));

    const raw = await runtime.rawChunks();
    const rawText = raw.map((chunk) => chunk.text).join('\n');
    check('真实 Runtime 本地 raw 含 sync_turn 内容', rawText.includes(turnUser));
    check('真实 Runtime 本地 raw 含压缩前归档', rawText.includes(compressUser));
    check('真实 Runtime 本地 raw 不含 host system prompt', !rawText.includes(secretSystemPrompt));
    check('真实 Runtime 本地 raw 含 s2 内容', rawText.includes(nextTurnUser));

    const recalled = await runtime.recall(`hermes-turn-${suffix}`, { agentId: 'hermes' });
    check('真实 Runtime 可从 heuristic 记录召回 sync_turn', recalled.records.some((record) => String(record.content).includes(`hermes-turn-${suffix}`)),
      JSON.stringify(recalled.records));

    const leaked = await scanForToken(hermesHome, runtime.token);
    check('Hermes profile 不持久化 Runtime token', leaked.length === 0, JSON.stringify(leaked));
  } finally {
    await tap.close().catch(() => undefined);
    if (keep) {
      console.log(`临时目录保留：${runRoot}（Runtime home：${runtime.home}）`);
      await runtime.close().catch(() => undefined);
    } else {
      await runtime.cleanup().catch(() => undefined);
      const { rm } = await import('node:fs/promises');
      await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} Hermes host E2E：${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ Hermes host E2E 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
