#!/usr/bin/env node
// G6.3 Streamable HTTP MCP 验证（真实 MCP client）
//
// 覆盖：POST /mcp、GET /healthz、OAuth well-known、bearer/scope 校验、
// PKCE 授权码流程、单实例 lock 争用被拒、非环回无 TLS fail-closed。
// 干净环境退出码 0。前置：npm run build（core dist）。

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const bin = join(rootDir, 'packages', 'mcp', 'bin', 'mebular.mjs');

let passed = true;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) passed = false;
};
const base64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function spawnServe({ home, storage, args = [], env = {} }) {
  const proc = spawn(process.execPath, [bin, 'serve', '--port', '0', ...args], {
    // MEBULAR_PROVISION=0：本用例刻意在**空家目录**上验证自举 root 与 fail-closed 默认值（非 GUI 引导路径）
    env: { ...process.env, MEBULAR_HOME: home, MEBULAR_STORAGE_PATH: storage, MEBULAR_DEVICE_ID: 'device-http', MEBULAR_PROVISION: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });
  return { proc, getOut: () => out, getErr: () => err };
}

function waitReady(handle, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const m = handle.getOut().match(/SERVE_READY (\{.*\})/);
      if (m) {
        clearInterval(timer);
        resolve(JSON.parse(m[1]));
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`serve 未就绪：${handle.getErr()}`));
      }
    }, 100);
  });
}

function waitExit(handle, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('serve 未在超时内退出')), timeoutMs);
    handle.proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function stop(handle) {
  if (handle?.proc && handle.proc.exitCode === null) {
    handle.proc.kill('SIGTERM');
    await new Promise((r) => handle.proc.on('exit', r));
  }
}

async function httpJson(url, init) {
  const res = await fetch(url, init);
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null), location: res.headers.get('location') };
}

async function mcpClient(port, headers = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers },
  });
  const client = new Client({ name: 'mebular-http-verify', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

console.log('Mebular G6.3 HTTP MCP 验证');
console.log('==========================');

const home = await mkdtemp(join(tmpdir(), 'mebular-mcp-http-'));
const servers = [];

try {
  // ---------- 1) auth=none：healthz + /mcp ----------
  {
    const h = spawnServe({ home: join(home, 'none'), storage: join(home, 'none', 's.jsonl') });
    servers.push(h);
    const ready = await waitReady(h);
    check('serve 启动（SERVE_READY）', Number.isInteger(ready.port) && ready.port > 0, `port=${ready.port}`);

    const health = await httpJson(`http://127.0.0.1:${ready.port}/healthz`);
    check('GET /healthz 200 + status ok', health.status === 200 && health.json?.status === 'ok');

    const client = await mcpClient(ready.port);
    const { tools } = await client.listTools();
    check('POST /mcp 真实 MCP client tools/list=27（统一入口）', tools.length === 27, `count=${tools.length}`);
    const w = await client.callTool({ name: 'memory_write', arguments: { items: [{ type: 'fact', content: 'http-smoke' }] } });
    check('POST /mcp tools/call 落图', Array.isArray(w.structuredContent?.stored));
    await client.close();
  }

  // ---------- 2) bearer + scope ----------
  {
    const bearerHome = join(home, 'bearer');
    const tokensFile = join(bearerHome, 'auth', 'tokens.json');
    const readToken = 'meb_readtoken';
    const writeToken = 'meb_writetoken';
    const taskReadToken = 'meb_taskreadtoken';
    await mkdir(dirname(tokensFile), { recursive: true });
    await writeFile(
      tokensFile,
      JSON.stringify({
        tokens: [
          { id: 't-read', sha256: createHash('sha256').update(readToken).digest('hex'), scope: ['memory.read'], revoked: false },
          { id: 't-write', sha256: createHash('sha256').update(writeToken).digest('hex'), scope: ['memory.write'], revoked: false },
          { id: 't-taskread', sha256: createHash('sha256').update(taskReadToken).digest('hex'), scope: ['task.read'], revoked: false },
        ],
      }),
      'utf-8',
    );
    const h = spawnServe({ home: bearerHome, storage: join(bearerHome, 's.jsonl'), args: ['--auth', 'bearer', '--tokens-file', tokensFile] });
    servers.push(h);
    const ready = await waitReady(h);

    const noToken = await httpJson(`http://127.0.0.1:${ready.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    check('无 token → 401', noToken.status === 401, `status=${noToken.status}`);

    const wrongScope = await httpJson(`http://127.0.0.1:${ready.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${readToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_write', arguments: { items: [] } } }),
    });
    check('错误 scope（read 调 write）→ 403', wrongScope.status === 403, `status=${wrongScope.status}`);

    const client = await mcpClient(ready.port, { authorization: `Bearer ${readToken}` });
    const { tools } = await client.listTools();
    check('正确 read token → tools/list 成功（27，含任务面）', tools.length === 27);
    await client.close();

    // R1.3：任务面 scope（memory.read ≠ task.read；两轴独立）
    const taskWithMemoryToken = await httpJson(`http://127.0.0.1:${ready.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${readToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_status', arguments: {} } }),
    });
    check('任务只读工具用 memory.read token → 403（两轴独立）', taskWithMemoryToken.status === 403, `status=${taskWithMemoryToken.status}`);
    // F-UNI-2：prompts/get 与 resources/* 必须按 memory.read 校验（不得随纯元数据放宽为 auth-only）
    const mcpPost = (token, payload) => httpJson(`http://127.0.0.1:${ready.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Streamable HTTP：不带 event-stream 的 Accept 会被判 406（探针踩过）
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const scopeMsgOf = (res) => String(res.json?.error?.message ?? res.json?.message ?? '');
    const promptNoRead = await mcpPost(taskReadToken, { jsonrpc: '2.0', id: 11, method: 'prompts/get', params: { name: 'memory_policy', arguments: {} } });
    check('F-UNI-2 prompts/get 无 memory.read（task.read-only）→ 403 + 需要 memory.read',
      promptNoRead.status === 403 && /memory\.read/.test(scopeMsgOf(promptNoRead)),
      `status=${promptNoRead.status} msg=${scopeMsgOf(promptNoRead).slice(0, 70)}`);
    const resourcesListNoRead = await mcpPost(taskReadToken, { jsonrpc: '2.0', id: 12, method: 'resources/list', params: {} });
    check('F-UNI-2 resources/list 无 memory.read（task.read-only）→ 403 + 需要 memory.read',
      resourcesListNoRead.status === 403 && /memory\.read/.test(scopeMsgOf(resourcesListNoRead)),
      `status=${resourcesListNoRead.status} msg=${scopeMsgOf(resourcesListNoRead).slice(0, 70)}`);
    const resourcesReadNoRead = await mcpPost(taskReadToken, { jsonrpc: '2.0', id: 13, method: 'resources/read', params: { uri: 'mebular://memory/policy' } });
    check('F-UNI-2 resources/read 无 memory.read（task.read-only）→ 403 + 需要 memory.read',
      resourcesReadNoRead.status === 403 && /memory\.read/.test(scopeMsgOf(resourcesReadNoRead)),
      `status=${resourcesReadNoRead.status} msg=${scopeMsgOf(resourcesReadNoRead).slice(0, 70)}`);
    // 正向：memory.read 令牌 → prompts/get 拿到内容；resources/* 的 scope 门开启（2xx，而非 403/406）
    const readClient = await mcpClient(ready.port, { authorization: `Bearer ${readToken}` });
    const promptOk = await readClient.getPrompt({ name: 'memory_policy', arguments: {} });
    check('F-UNI-2 prompts/get 带 memory.read → 成功返回文本（非 403/406）',
      (promptOk?.messages?.length ?? 0) >= 1, `messages=${promptOk?.messages?.length ?? 0}`);
    // resources 正例：经真实会话（Streamable HTTP 裸请求在过门后仍会被会话校验拒 400）；
    // 判据 = **不是 scope 错误**（未注册资源时 SDK 会抛方法/资源不存在，也说明门已开）
    let resourcesGateOpened = false;
    let resourcesNote = '';
    try {
      const list = await readClient.listResources();
      resourcesGateOpened = Array.isArray(list?.resources);
      resourcesNote = `resources=${list?.resources?.length ?? 0}`;
    } catch (error) {
      resourcesNote = String(error?.message ?? error).slice(0, 90);
      resourcesGateOpened = !/insufficient scope|403|memory\.read/i.test(resourcesNote);
    }
    check('F-UNI-2 resources/* 带 memory.read → 过 scope 门（非 403/需 scope）',
      resourcesGateOpened, resourcesNote);
    await readClient.close();

    const taskClient = await mcpClient(ready.port, { authorization: `Bearer ${taskReadToken}` });
    const taskCall = await taskClient.callTool({ name: 'task_status', arguments: {} });
    const boardWithRead = await httpJson(`http://127.0.0.1:${ready.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${taskReadToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'board_create', arguments: { name: 'x' } } }),
    });
    const boardMsg = String(boardWithRead.json?.error?.message ?? boardWithRead.json?.message ?? '');
    check('H1 回归：board_create（写+授权）用 task.read token → 403（need task.write）',
      boardWithRead.status === 403 && /task\.write/.test(boardMsg),
      `status=${boardWithRead.status} msg=${boardMsg.slice(0, 80)}`);
    check('task.read token → 任务工具可调用（结构化信封，非 403）',
      taskCall !== undefined && (taskCall.structuredContent?.ok === true || typeof taskCall.structuredContent?.error?.code === 'string'),
      JSON.stringify(taskCall?.structuredContent ?? {}).slice(0, 120));
    await taskClient.close();
  }

  // ---------- 3) oauth（well-known + PKCE） ----------
  {
    const oauthHome = join(home, 'oauth');
    const h = spawnServe({ home: oauthHome, storage: join(oauthHome, 's.jsonl'), args: ['--auth', 'oauth'] });
    servers.push(h);
    const ready = await waitReady(h);
    const base = `http://127.0.0.1:${ready.port}`;

    const pr = await httpJson(`${base}/.well-known/oauth-protected-resource`);
    check(
      '/.well-known/oauth-protected-resource（resource 用实际端口）',
      pr.status === 200 && pr.json?.resource === `${base}/mcp`,
      pr.json?.resource,
    );
    const as = await httpJson(`${base}/.well-known/oauth-authorization-server`);
    check('/.well-known/oauth-authorization-server', as.status === 200 && Array.isArray(as.json?.code_challenge_methods_supported) && as.json.code_challenge_methods_supported.includes('S256'));
    const jwks = await httpJson(`${base}/jwks`);
    check('/jwks 提供 EdDSA 公钥', jwks.status === 200 && jwks.json?.keys?.[0]?.alg === 'EdDSA' && jwks.json.keys[0].crv === 'Ed25519');

    // D45：预注册客户端 + 本地同意码（不再有匿名 DCR / client_credentials）
    const redirectUri = 'http://127.0.0.1/callback';
    const cliEnv = { ...process.env, MEBULAR_HOME: oauthHome, MEBULAR_STORAGE_PATH: join(oauthHome, 's.jsonl') };
    const addClient = JSON.parse(
      execFileSync(process.execPath, [bin, 'token', 'client', 'add', '--redirect', redirectUri, '--scope', 'memory.read,memory.write'], { env: cliEnv, encoding: 'utf-8' }),
    );
    const clientId = addClient.clientId;
    check('token client add 预注册客户端', typeof clientId === 'string' && clientId.length > 0);
    const consent = JSON.parse(
      execFileSync(process.execPath, [bin, 'token', 'consent', '--scope', 'memory.read,memory.write', '--ttl', '600'], { env: cliEnv, encoding: 'utf-8' }),
    );

    // 匿名 /authorize 不得颁发 code
    const anon = await fetch(`${base}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=x&code_challenge_method=S256&scope=memory.read`, { redirect: 'manual' });
    check('匿名 /authorize 被拒且无 code', anon.status === 401 && !anon.headers.get('location'), `status=${anon.status}`);

    // PKCE 授权码流程
    const verifier = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const authzRes = await fetch(
      `${base}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent('memory.read memory.write')}&state=xyz&consent_code=${consent.code}`,
      { redirect: 'manual' },
    );
    const location = authzRes.headers.get('location') ?? '';
    const code = new URL(location).searchParams.get('code');
    const state = new URL(location).searchParams.get('state');
    check('PKCE /authorize（同意码）302 带 code', authzRes.status === 302 && !!code && state === 'xyz', `status=${authzRes.status}`);

    const badVerifier = await httpJson(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: 'wrong' }).toString(),
    });
    check('PKCE 错误 verifier → invalid_grant', badVerifier.status === 400 && badVerifier.json?.error === 'invalid_grant');

    const tokenRes = await httpJson(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }).toString(),
    });
    check('PKCE /token 颁发 access_token', tokenRes.status === 200 && typeof tokenRes.json?.access_token === 'string' && tokenRes.json?.token_type === 'Bearer');

    const client = await mcpClient(ready.port, { authorization: `Bearer ${tokenRes.json.access_token}` });
    const { tools } = await client.listTools();
    check('oauth access token → /mcp tools/list 成功（27）', tools.length === 27, `count=${tools.length}`);
    await client.close();
  }

  // ---------- 4) 单实例 lock 争用 ----------
  {
    const lockHome = join(home, 'lock');
    const h1 = spawnServe({ home: lockHome, storage: join(lockHome, 's.jsonl') });
    servers.push(h1);
    await waitReady(h1);

    const h2 = spawnServe({ home: lockHome, storage: join(lockHome, 's.jsonl') });
    const code = await waitExit(h2);
    check('第二实例被拒（退出码非 0）', code !== 0, `code=${code}`);
    check('错误含 MCP_STORAGE_LOCKED', h2.getErr().includes('MCP_STORAGE_LOCKED'), h2.getErr().split('\n')[0]);
  }

  // ---------- 5) 非环回无 TLS fail-closed ----------
  {
    const badHome = join(home, 'insecure');
    const h = spawnServe({ home: badHome, storage: join(badHome, 's.jsonl'), args: ['--host', '0.0.0.0', '--auth', 'none'] });
    const code = await waitExit(h);
    check('非环回 + auth=none + 无 TLS → 拒绝启动', code !== 0, `code=${code}`);
    check('错误含 MCP_INSECURE_CONFIG', h.getErr().includes('MCP_INSECURE_CONFIG'));
  }
} catch (error) {
  check('HTTP MCP 端到端', false, String(error?.message ?? error).substring(0, 400));
} finally {
  for (const s of servers) await stop(s);
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

console.log('==========================');
if (passed) {
  console.log('✓ G6.3 HTTP MCP 验证通过');
  process.exit(0);
} else {
  console.log('✗ G6.3 HTTP MCP 验证失败');
  process.exit(1);
}
