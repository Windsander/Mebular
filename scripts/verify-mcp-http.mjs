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
    check('POST /mcp 真实 MCP client tools/list=11', tools.length === 11, `count=${tools.length}`);
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
    await mkdir(dirname(tokensFile), { recursive: true });
    await writeFile(
      tokensFile,
      JSON.stringify({
        tokens: [
          { id: 't-read', sha256: createHash('sha256').update(readToken).digest('hex'), scope: ['memory.read'], revoked: false },
          { id: 't-write', sha256: createHash('sha256').update(writeToken).digest('hex'), scope: ['memory.write'], revoked: false },
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
    check('正确 read token → tools/list 成功', tools.length === 11);
    await client.close();
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
    check('oauth access token → /mcp tools/list 成功', tools.length === 11);
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
