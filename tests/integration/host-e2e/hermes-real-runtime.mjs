#!/usr/bin/env node
// Hermes host E2E: real MemoryProvider plugin -> real Memory Runtime sidecar ->
// real MCP capability API -> real MemoryService/GraphStore.
//
// Boundary: this does not start a real Hermes gateway or run an LLM. It loads
// the exact plugin file a Hermes profile loads, drives the documented
// MemoryProvider methods (initialize / prefetch / sync_turn / on_pre_compress /
// on_session_switch / shutdown), and sends real HTTP to the real sidecar.
//
// The sidecar is the real `@mebular/memory-runtime` bundled with this repo; the
// MCP daemon under it is the real `startHttpServer` + capability API + MemoryService path.
// The Hermes profile never receives the MCP capability token or the runtime
// bearer token, and reads the sidecar host token from discovery tokenFile only.
//
// Usage:
//   node tests/integration/host-e2e/hermes-real-runtime.mjs [--keep]

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startRealRuntime } from './lib/real-runtime.mjs';

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

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function waitFor(checkFn, { timeoutMs = 15000, intervalMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await checkFn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('waitFor timeout');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
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
      } else if (entry.isFile() && (entry.name.endsWith('.json')
        || entry.name.endsWith('.jsonl')
        || entry.name.endsWith('.log')
        || entry.name.endsWith('.txt'))) {
        const text = await readFile(path, 'utf8').catch(() => '');
        if (text.includes(token)) hits.push(path);
      }
    }
  }
  await walk(dir);
  return hits;
}

async function sidecarStatus(discovery, home) {
  const tokenRecord = await readJson(join(home, 'memory-runtime', 'host-token'));
  const token = typeof tokenRecord?.token === 'string' ? tokenRecord.token : '';
  const response = await fetch(`${discovery.url}/status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => null);
  return { token, status: response.status, body, data: body?.data ?? null };
}

async function sidecarCheckpoint(discovery, token, threadId) {
  const response = await fetch(
    `${discovery.url}/checkpoints/${encodeURIComponent(threadId)}?agentId=hermes`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const body = await response.json().catch(() => null);
  return { status: response.status, data: body?.data ?? null };
}

async function main() {
  const keep = process.argv.includes('--keep');
  const runRoot = join(tmpdir(), `mebular-hermes-host-e2e-${process.pid}-${Date.now()}`);
  const hermesHome = join(runRoot, 'hermes-home');
  const runtimeRoot = join(runRoot, 'runtime-root');
  const runtimeHome = join(runtimeRoot, 'mebular-home');
  await mkdir(hermesHome, { recursive: true });
  // Port 0 avoids colliding with a developer's sidecar or another test suite.
  await mkdir(join(runtimeHome, 'memory-runtime'), { recursive: true });
  await writeFile(join(runtimeHome, 'memory-runtime', 'config.json'), JSON.stringify({
    schema: 1,
    http: { host: '127.0.0.1', port: 0 },
  }, null, 2), 'utf8');

  const runtime = await startRealRuntime({
    auth: 'bearer',
    token: `hermes-host-token-${Date.now()}`,
    root: runtimeRoot,
    memoryRuntime: { enabled: true },
    manageMemoryRuntime: true,
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const query = `hermes-prefetch-${suffix}`;
  const turnUser = `以后默认用 hermes-turn-${suffix} 主题`;
  const compressUser = `hermes-compress-${suffix} 这段对话在压缩前归档`;
  const nextTurnUser = `以后默认用 hermes-s2-${suffix} 主题`;
  const secretSystemPrompt = `SECRET HOST PROMPT ${suffix} do not archive`;

  try {
    console.log('Hermes 真实 plugin + 真实 sidecar + 真实 Runtime');
    console.log('================================================');

    const discoveryPath = join(runtime.home, 'memory-runtime.json');
    const discovery = await waitFor(async () => {
      const record = await readJson(discoveryPath);
      return record?.state === 'ready' && typeof record?.url === 'string' ? record : null;
    });
    check('sidecar discovery 写出 /memory-runtime/v1', String(discovery.url).endsWith('/memory-runtime/v1'),
      discovery.url);
    check('sidecar discovery 不含 token 明文',
      discovery.token === undefined && discovery.capabilityToken === undefined);
    check('sidecar discovery 使用 host-token tokenFile',
      typeof discovery.tokenFile === 'string'
      && discovery.tokenFile.endsWith('/memory-runtime/host-token'));

    const seeded = await runtime.seedMemory({
      text: `以后默认用 ${query} 主题`,
      namespace: 'default',
      agentId: 'hermes',
    });
    check('Runtime heuristic seed 写入', seeded.accepted.records === 1, JSON.stringify(seeded.records));

    await writeFile(join(hermesHome, 'mebular-memory.json'), JSON.stringify({
      agent_id: 'hermes',
      extractor: 'heuristic',
      recall_timeout: 3,
      ingest_timeout: 3,
      checkpoint_timeout: 3,
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

    const python = await runPython({
      HERMES_HOME: hermesHome,
      MEBULAR_MEMORY_RUNTIME_HOME: runtime.home,
      MEBULAR_HOME: runtime.home,
      MEBULAR_MEMORY_RUNTIME_URL: '',
      MEBULAR_MEMORY_RUNTIME_TOKEN: '',
      MEBULAR_RUNTIME_URL: '',
      MEBULAR_RUNTIME_TOKEN: '',
      HERMES_E2E_CONFIG: JSON.stringify(config),
      PYTHONDONTWRITEBYTECODE: '1',
    }, repoRoot);

    const result = parseMarker(python.stdout) ?? parseMarker(python.stderr);
    check('Python plugin 进程退出 0', python.code === 0, `code=${python.code}`);
    check('插件结果可解析', result !== null && result.error === undefined,
      result?.error ?? python.stderr.slice(-500));

    if (result !== null && result.error === undefined) {
      check('真实 sidecar 可发现', result.available === true);
      check('插件不暴露工具（保持 MCP 治理面）', Array.isArray(result.tools) && result.tools.length === 0);
      check('system prompt 声明 Mebular 记忆已启用', String(result.systemPrompt).includes('Mebular Memory'));
      check('插件使用 discovery 而非宿主 token', result.status?.tokenSource === 'tokenFile'
        && result.status?.discovery === 'discovery',
      JSON.stringify(result.status));
      check('插件状态不含 host token', !JSON.stringify(result.status).includes('host-token'));
      check('prefetch 命中 seed 记忆', String(result.prefetch).includes('<mebular_memory')
        && String(result.prefetch).includes(query), result.prefetch);
      check('prefetch 第二次仍可用', String(result.prefetchSecond).includes(query));
      check('sync_turn 已 flush', result.turnFlushed === true && result.turnPending === 0,
        JSON.stringify({ flushed: result.turnFlushed, pending: result.turnPending }));
      check('on_pre_compress 返回空且不阻塞', result.preCompressReturn === ''
        && result.compressFlushed === true && result.compressPending === 0,
      JSON.stringify({ returned: result.preCompressReturn, pending: result.compressPending }));
      check('session switch 后 s2 已 flush', result.switchFlushed === true && result.switchPending === 0);
      check('shutdown 后队列清空', result.pendingAfterShutdown === 0);
      check('checkpoint 已提交', result.checkpointPending === 0);
    }

    const statusResult = await sidecarStatus(discovery, runtime.home);
    check('sidecar /status 鉴权成功', statusResult.status === 200 && statusResult.data != null,
      `status=${statusResult.status}`);
    check('插件状态不含 host token', result === null
      || !JSON.stringify(result.status).includes(statusResult.token));
    const counts = statusResult.data?.counts ?? {};
    check('sidecar 记录 context 请求（第二次由 Provider 缓存）', (counts.contexts ?? 0) >= 1,
      JSON.stringify(counts));
    check('sidecar 记录 ingest 请求', (counts.ingested ?? 0) >= 3, JSON.stringify(counts));
    check('sidecar 记录 checkpoint 提交', (counts.checkpoints ?? 0) >= 1, JSON.stringify(counts));
    check('sidecar outbox 已清空', (statusResult.data?.outbox?.items ?? 0) === 0,
      JSON.stringify(statusResult.data?.outbox));

    const details = await waitFor(async () => {
      const values = await runtime.resolveDetails({
        agentId: 'hermes',
        domains: ['default', 'user', 'agent:hermes', 'task:hermes-s1', 'task:hermes-s2'],
      }).catch(() => []);
      return values.length > 0 ? values : null;
    }, { timeoutMs: 20000, describe: 'capability detail records' });
    const detailText = (details ?? []).map((entry) => String(entry.text ?? '')).join('\n');
    check('capability 已沉降 Hermes 详情（域内共享）', Boolean(details)
      && detailText.includes(turnUser), `details=${details?.length ?? 0}`);
    const stagingText = (await runtime.sidecarStagingChunks()).join('\n');
    check('压缩前归档进入详情或 staging（无记录时只留 staging）',
      detailText.includes(compressUser) || stagingText.includes(compressUser));
    check('详情与 staging 不含 host system prompt',
      !detailText.includes(secretSystemPrompt) && !stagingText.includes(secretSystemPrompt));
    check('capability 详情含 s2 内容', detailText.includes(nextTurnUser));
    check('Hermes 详情带域与 citation', (details ?? []).every((entry) => typeof entry.domain === 'string'
      && Array.isArray(entry.availability)
      && entry.availability.includes('available')), JSON.stringify(details?.map((entry) => entry.domain)));

    const recalled = await runtime.recall(`hermes-turn-${suffix}`, {
      agentId: 'hermes',
      namespaces: ['default', 'agent:hermes', 'user'],
    });
    check('真实 Runtime 可从 heuristic 记录召回 sync_turn',
      recalled.records.some((record) => String(record.content).includes(`hermes-turn-${suffix}`)),
      JSON.stringify(recalled.records));

    const checkpointResult = await sidecarCheckpoint(discovery, statusResult.token, 'hermes-s1');
    const checkpoint = checkpointResult.data?.checkpoint ?? null;
    check('真实 sidecar 持久化 checkpoint', checkpointResult.status === 200 && checkpoint !== null,
      JSON.stringify(checkpointResult.data));
    check('checkpoint 无伪造 summary', checkpoint?.summary === null,
      JSON.stringify({ summary: checkpoint?.summary }));
    check('checkpoint schema 2 summary_only（无结构化字段、不冒充）',
      checkpoint?.state?.schema === 2
      && checkpoint?.state?.contentMode === 'summary_only'
      && checkpoint?.state?.goal === null
      && Array.isArray(checkpoint?.state?.nextSteps)
      && checkpoint.state.nextSteps.length === 0
      && checkpoint?.state?.task?.key === 'task:hermes-s1',
    JSON.stringify(checkpoint?.state));
    check('checkpoint state-only 元数据', checkpoint?.state?.kind === 'pre_compress'
      && checkpoint?.state?.messageCount >= 2, JSON.stringify(checkpoint?.state));

    const leaked = await scanForToken(hermesHome, statusResult.token);
    check('Hermes profile 不持久化 sidecar host token', leaked.length === 0, JSON.stringify(leaked));
    const runtimeLeaked = await scanForToken(hermesHome, runtime.token);
    check('Hermes profile 不持久化 Runtime bearer', runtimeLeaked.length === 0, JSON.stringify(runtimeLeaked));

    check('未使用旧 /runtime/v1 路径（插件侧）',
      String(result?.status?.runtime_url ?? '').includes('/memory-runtime/v1'));
  } finally {
    if (keep) {
      console.log(`临时目录保留：${runRoot}（Runtime home：${runtime.home}）`);
      await runtime.close().catch(() => undefined);
    } else {
      await runtime.cleanup().catch(() => undefined);
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
