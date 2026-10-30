#!/usr/bin/env node
// Memory Runtime 可运行 Demo（0.3.0）
//
// 使用真实 Mebular app + 真实 `startHttpServer`（含 Memory Capability API）+ 真实
// supervisor 启动真实 `mebular-memory-runtime` sidecar，演示：
//   1. ingest 用户偏好（heuristic）
//   2. ingest 项目事实（host candidates，不是模型调用）
//   3. 宽泛 recall 只返回 gist，不展开 detail
//   4. 具体问题展开 detail（端口原值）
//   5. `/context` 在预算内组装不可信背景块
//   6. checkpoint 写入忆云并从 sidecar 读回
//
// 不访问外部网络、不下载模型、不调用模型；只使用已构建的仓库 dist。
// 前置：npm run build
// 运行：node examples/memory-runtime-demo/index.mjs
// 复用 home：node examples/memory-runtime-demo/index.mjs --home /tmp/mebular-memory-demo
//
// 临时 home 在结束时删除；显式 --home 时保留（只停止 server/app/sidecar）。

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IdentityManager, Mebular, MemoryService } from '../../dist/index.js';
import { buildServer } from '../../packages/mcp/src/server.mjs';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const AGENT_ID = 'opencode';
const AGENT_NAME = 'OpenCode';
const SIDECAR_TIMEOUT_MS = 30_000;

function usage() {
  console.log(`用法：node examples/memory-runtime-demo/index.mjs [--home DIR]

  --home DIR   复用指定数据目录（默认使用临时目录，结束时删除）
  --help       显示本帮助`);
}

function parseArgs(argv) {
  const options = { home: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--home') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--home 需要一个目录');
      options.home = resolve(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--home=')) {
      const value = arg.slice('--home='.length);
      if (!value) throw new Error('--home 需要一个目录');
      options.home = resolve(value);
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }
  return options;
}

async function loadOrCreateUserMasterKey(home) {
  const keyPath = join(home, 'demo-master-key.json');
  if (existsSync(keyPath)) {
    const saved = JSON.parse(await readFile(keyPath, 'utf8'));
    return {
      publicKey: new Uint8Array(Buffer.from(saved.publicKey, 'base64')),
      privateKey: await IdentityManager.importPrivateKey(saved.privateKeyPkcs8),
    };
  }
  const pair = await Mebular.generateUserMasterKey('memory-runtime-demo');
  await writeFile(keyPath, JSON.stringify({
    publicKey: Buffer.from(pair.publicKey).toString('base64'),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(pair.privateKey),
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  return pair;
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function waitForSidecar(home, { timeoutMs = SIDECAR_TIMEOUT_MS, notPid = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const discovery = await readJson(join(home, 'memory-runtime.json'));
    last = discovery;
    if (discovery?.state === 'ready' && typeof discovery.url === 'string') {
      if (notPid === null || discovery.pid !== notPid) {
        try {
          const response = await fetch(`${discovery.healthUrl ?? `${discovery.url}/health`}`, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(1000),
          });
          const health = await response.json().catch(() => null);
          if (response.ok && health?.ready === true) return discovery;
        } catch {
          // sidecar 正在 listen / 心跳，继续轮询。
        }
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待 sidecar ready 超时（${timeoutMs}ms）；最后发现文件：${JSON.stringify(last)}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

async function readHostToken(discovery) {
  const raw = (await readFile(discovery.tokenFile, 'utf8')).trim();
  if (raw.length === 0) throw new Error('host token 文件为空');
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token === 'string' && parsed.token.length > 0) return parsed.token;
  } catch {
    // 兼容手工写入的裸 token。
  }
  return raw;
}

function makeSidecarClient(discovery, token) {
  return async function requestSidecar(path, init = {}) {
    const response = await fetch(`${discovery.url}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok !== true) {
      const code = body?.error?.code ?? `HTTP_${response.status}`;
      const message = body?.error?.message ?? 'sidecar 请求失败';
      throw new Error(`${path} 失败：${code} ${message}`);
    }
    return body.data;
  };
}

function fragmentLine(fragment) {
  const owner = fragment.owner?.domain ?? 'unknown';
  return `${fragment.kind} · ${owner} · ${fragment.gist}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }

  const home = options.home ?? await mkdtemp(join(tmpdir(), 'mebular-memory-runtime-demo-'));
  const ephemeral = options.home === null;
  const runId = randomUUID().slice(0, 8);
  const threadId = `th_demo_${runId}`;
  const requestPrefix = `req_demo_${runId}`;
  let server = null;
  let app = null;

  // 明确使用仓库里真实构建的 sidecar；不依赖用户 PATH 上的版本。
  if (!process.env.MEBULAR_MEMORY_RUNTIME_BIN) {
    process.env.MEBULAR_MEMORY_RUNTIME_BIN = join(REPO_ROOT, 'packages', 'memory-runtime', 'bin', 'mebular-memory-runtime.mjs');
  }

  try {
    await mkdir(home, { recursive: true });
    const master = await loadOrCreateUserMasterKey(home);
    app = new Mebular({
      storagePath: join(home, 'device.jsonl'),
      deviceId: `device-demo-${createHash('sha256').update(home).digest('hex').slice(0, 12)}`,
      encryption: {
        userMasterKey: master.publicKey,
        userMasterPrivateKey: master.privateKey,
      },
      network: { enabled: false },
      sync: { autoSync: false },
    });
    await app.initialize();

    const service = new MemoryService(app);
    server = await startHttpServer({
      home,
      app,
      service,
      buildServer,
      config: { memoryRuntime: { enabled: true, startTimeoutMs: 20_000 } },
      host: '127.0.0.1',
      port: 0,
      auth: 'none',
      manageMemoryRuntime: true,
    });

    const discovery = await waitForSidecar(home);
    const token = await readHostToken(discovery);
    const requestSidecar = makeSidecarClient(discovery, token);

    const health = await fetch(discovery.healthUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(2000),
    }).then((response) => response.json()).catch(() => null);
    const status = await requestSidecar('/status');
    const model = status?.model?.active ?? 'heuristic';
    if (model !== 'heuristic') {
      throw new Error(`演示要求 heuristic（不调用模型），但 sidecar 当前模型来源是 ${model}`);
    }
    const state = health?.state ?? status?.state ?? discovery.state;

    console.log('[Mebular Memory Runtime Demo]');
    console.log(`home: ${home}${ephemeral ? '（临时，结束删除）' : '（复用）'}`);
    console.log(`MCP daemon: http://127.0.0.1:${server.port}`);
    console.log(`Memory Runtime sidecar: ${discovery.url}`);
    console.log(`sidecar 状态: ${state} · 模型来源: ${model}`);

    console.log('\n[1/6] ingest 用户偏好（heuristic）');
    const preferenceIngest = await requestSidecar('/ingest', {
      method: 'POST',
      body: JSON.stringify({
        requestId: `${requestPrefix}_pref`,
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        threadId,
        capture: 'local',
        extractor: 'heuristic',
        chunks: [{
          role: 'user',
          text: '我喜欢深色主题，默认用中文回答。',
          messageId: `m_pref_${runId}`,
          at: Date.now(),
        }],
      }),
    });
    console.log(`  写入 ${preferenceIngest.records.length} 条记录：${preferenceIngest.records.map((record) => `${record.kind}@${record.domain}`).join(', ') || '(none)'}`);
    if (preferenceIngest.records.length === 0) {
      throw new Error('用户偏好没有沉淀出记录；heuristic 输入可能不符合规则');
    }

    console.log('\n[2/6] ingest 项目事实（host candidates；不调用模型）');
    const factIngest = await requestSidecar('/ingest', {
      method: 'POST',
      body: JSON.stringify({
        requestId: `${requestPrefix}_fact`,
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        threadId,
        capture: 'local',
        extractor: 'host',
        chunks: [{
          role: 'user',
          text: '项目 Mebular 的本地端口是 7331。',
          messageId: `m_fact_${runId}`,
          at: Date.now(),
        }],
        candidates: [{
          kind: 'fact',
          domain: `agent:${AGENT_ID}`,
          content: {
            subject: 'mebular',
            predicate: 'port',
            object: '7331',
            confidence: 0.9,
            source: 'host',
          },
        }],
      }),
    });
    console.log(`  写入 ${factIngest.records.length} 条记录：${factIngest.records.map((record) => `${record.kind}@${record.domain}`).join(', ') || '(none)'}`);
    if (factIngest.records.length === 0) throw new Error('项目事实没有沉淀出记录');

    console.log('\n[3/6] 宽泛 recall："你还记得我的偏好吗？"');
    const broad = await requestSidecar('/recall', {
      method: 'POST',
      body: JSON.stringify({
        agentId: AGENT_ID,
        threadId,
        query: '你还记得我的偏好吗？',
        domains: ['user', `agent:${AGENT_ID}`],
      }),
    });
    const broadFragments = broad.fragments ?? [];
    if (broadFragments.length === 0) {
      throw new Error(`宽泛 recall 没有命中（silenceReason=${broad.silenceReason ?? 'null'}）`);
    }
    console.log(`  命中 ${broadFragments.length} 个片段；只返回 gist，不展开 detail`);
    for (const fragment of broadFragments) {
      console.log(`  - ${fragmentLine(fragment)}`);
      if (fragment.detail) throw new Error('宽泛 recall 不应展开 detail');
    }

    console.log('\n[4/6] 具体问题：查询精确端口 7331（query="7331"）');
    const specific = await requestSidecar('/recall', {
      method: 'POST',
      body: JSON.stringify({
        agentId: AGENT_ID,
        threadId,
        query: '7331',
        domains: ['user', `agent:${AGENT_ID}`],
      }),
    });
    const factFragment = (specific.fragments ?? []).find((fragment) => String(fragment.gist).includes('7331'));
    if (!factFragment) {
      throw new Error(`具体问题没有命中端口事实（silenceReason=${specific.silenceReason ?? 'null'}，fragments=${JSON.stringify((specific.fragments ?? []).map((f) => f.gist))}，warnings=${JSON.stringify(specific.warnings ?? [])}）`);
    }
    if (!factFragment.detail?.text?.includes('7331')) {
      throw new Error(`具体问题没有展开 7331 详情（detail=${JSON.stringify(factFragment.detail)}）`);
    }
    console.log(`  命中 ${specific.fragments.length} 个片段；detail 已展开`);
    console.log(`  - gist: ${factFragment.gist}`);
    console.log(`  - detail(${factFragment.detail.format}): ${factFragment.detail.text}`);

    console.log('\n[5/6] /context 预算块（maxBytes=2048, tokenBudget=500）');
    const context = await requestSidecar('/context', {
      method: 'POST',
      body: JSON.stringify({
        agentId: AGENT_ID,
        threadId,
        turnId: `turn_${runId}`,
        turnKind: 'human',
        query: '7331',
        domains: ['user', `agent:${AGENT_ID}`],
        includeCheckpoint: true,
        includeSelf: true,
        maxFragments: 3,
        maxBytes: 2048,
        tokenBudget: 500,
      }),
    });
    const blocks = context.blocks ?? [];
    if (blocks.length === 0) throw new Error('context 没有生成预算块');
    console.log(`  blocks=${blocks.length} · estimatedBytes=${context.estimatedBytes} · estimatedTokens=${context.estimatedTokens} · truncated=${context.truncated} · untrusted=${context.untrusted}`);
    for (const block of blocks) {
      console.log(`  - [${block.kind}] ${block.content.replace(/\s+/g, ' ').slice(0, 180)}${block.content.length > 180 ? '…' : ''}`);
    }

    console.log('\n[6/6] checkpoint 写入/读取（经 capability 上云）');
    const checkpoint = await requestSidecar(`/checkpoints/${encodeURIComponent(threadId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        agentId: AGENT_ID,
        domain: `task:${threadId}`,
        state: { step: 'demo', cursor: 2, note: 'ingest + recall + context 已完成' },
        summary: 'Memory Runtime 演示已完成第 2 步',
      }),
    });
    const written = checkpoint.checkpoint;
    console.log(`  写入 revision=${written.revision} · domain=${written.domain} · source=${checkpoint.source}`);
    const readBack = await requestSidecar(`/checkpoints/${encodeURIComponent(threadId)}?agentId=${encodeURIComponent(AGENT_ID)}`);
    const loaded = readBack.checkpoint;
    if (!loaded || loaded.revision !== written.revision || loaded.summary !== 'Memory Runtime 演示已完成第 2 步') {
      throw new Error(`checkpoint 读回不一致：${JSON.stringify(loaded)}`);
    }
    console.log(`  读回 revision=${loaded.revision} · summary=${loaded.summary}`);

    console.log('\n摘要：偏好与项目事实经 sidecar → capability → 同一张图；宽泛召回只给 gist，具体问题展开 7331 详情；/context 在 2048B/500 token 内返回不可信背景块；checkpoint 写入并读回成功。');
    return 0;
  } catch (error) {
    console.error(`\n演示失败：${error?.message ?? error}`);
    if (error?.stack && process.env.DEBUG) console.error(error.stack);
    return 1;
  } finally {
    await server?.close().catch(() => undefined);
    await app?.shutdown().catch(() => undefined);
    if (ephemeral) {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    } else {
      console.log(`\n数据保留在：${home}（可再次用 --home 复用；下次运行会复用已有主密钥与图）`);
    }
  }
}

const code = await main().catch((error) => {
  console.error(`演示失败：${error?.message ?? error}`);
  return 1;
});
process.exitCode = code;
