#!/usr/bin/env node
// G6.3 补丁：内置 OAuth AS 鉴权缺口修复验证（E1）
//
// 红灯 1–5（修复前必须为红）：
//   1. 匿名 POST /token grant_type=client_credentials&scope=memory.admin → 非 2xx、无 access_token
//   2. 匿名 GET /authorize（无口令/无同意码，scope=memory.admin）→ 401/403，绝不 302 带 code
//   3. /authorize 未注册 redirect_uri → 拒绝、无 code
//   4. /authorize 请求超出客户端 allowed_scopes → 403/insufficient_scope
//   5. 匿名 POST /register（无 bootstrap secret）→ 拒绝/404，无 client_id
// 绿灯 6–8：
//   6. 预注册客户端 + 用户同意/口令 → code → token → /mcp tools/list 成功
//   7. 撤销跨重启仍生效
//   8. refresh 轮换后旧 refresh 失效（跨重启亦然）；限流触发 429
// 另验：metadata 不再广告 client_credentials、端点与实现一致。
// 干净环境退出码 0。前置：npm run build。

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const bin = join(rootDir, 'packages', 'mcp', 'bin', 'mebular.mjs');
const ADMIN_SECRET = 'admin-secret-for-hardening-test';
const REDIRECT = 'http://127.0.0.1:9911/callback';
const REDIRECT_UNREGISTERED = 'http://127.0.0.1:9912/evil';

let passed = true;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) passed = false;
};
const base64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pkce = () => {
  const verifier = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
};

const home = await mkdtemp(join(tmpdir(), 'mebular-oauth-hardening-'));
const mainHome = join(home, 'main');
const servers = [];
// issuer 固定，使跨重启的 token 校验不受随机端口影响（才能真正验证撤销/轮换持久）
const FIXED_ISSUER = 'https://mebular.hardening.test';

function spawnServe({ subdir, args = [], env = {} }) {
  const h = join(home, subdir);
  const proc = spawn(process.execPath, [bin, 'serve', '--port', '0', '--auth', 'oauth', ...args], {
    // MEBULAR_PROVISION=0：本用例依赖空家目录自举 root（验证 OAuth 硬化，与 GUI 引导无关）
    env: { ...process.env, MEBULAR_HOME: h, MEBULAR_STORAGE_PATH: join(h, 'store.jsonl'), MEBULAR_DEVICE_ID: 'device-hardening', MEBULAR_PROVISION: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });
  const handle = { proc, home: h, getOut: () => out, getErr: () => err };
  servers.push(handle);
  return handle;
}

function waitReady(handle, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const m = handle.getOut().match(/SERVE_READY (\{.*\})/);
      if (m) { clearInterval(timer); resolve(JSON.parse(m[1])); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`serve 未就绪：${handle.getErr()}`)); }
    }, 100);
  });
}

async function stop(handle) {
  if (handle?.proc && handle.proc.exitCode === null) {
    handle.proc.kill('SIGTERM');
    await new Promise((r) => handle.proc.on('exit', r));
  }
}

function cli(args, env = {}, storageHome) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, MEBULAR_HOME: storageHome ?? home, MEBULAR_STORAGE_PATH: join(storageHome ?? home, 'store.jsonl'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('exit', (code) => resolve({ code, out, err }));
  });
}

async function httpJson(url, init) {
  const res = await fetch(url, init);
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null), location: res.headers.get('location') };
}

async function getAuthorize(base, params) {
  const res = await fetch(`${base}/authorize?${new URLSearchParams(params)}`, { redirect: 'manual' });
  const location = res.headers.get('location');
  let code = null;
  if (location) { try { code = new URL(location).searchParams.get('code'); } catch { code = null; } }
  return { status: res.status, location, code, json: await res.json().catch(() => null) };
}

async function postToken(base, params) {
  return httpJson(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

async function mcpListTools(base, token) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'mebular-oauth-hardening', version: '0.1.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.length;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function mcpRejected(base, token) {
  try {
    await mcpListTools(base, token);
    return false;
  } catch {
    return true;
  }
}

console.log('Mebular G6.3 补丁 OAuth 鉴权硬化验证');
console.log('=====================================');

try {
  // ---------- 预注册客户端 + 同意码（修复后 CLI；修复前不存在 → null） ----------
  const addRead = await cli(['token', 'client', 'add', '--redirect', REDIRECT, '--scope', 'memory.read'], {}, mainHome);
  const addWrite = await cli(['token', 'client', 'add', '--redirect', REDIRECT, '--scope', 'memory.read,memory.write'], {}, mainHome);
  const addAdmin = await cli(['token', 'client', 'add', '--redirect', REDIRECT, '--scope', 'memory.admin'], {}, mainHome);
  const clientRead = JSON.parse(addRead.out || '{}').clientId ?? null;
  const clientWrite = JSON.parse(addWrite.out || '{}').clientId ?? null;
  const clientAdmin = JSON.parse(addAdmin.out || '{}').clientId ?? null;
  check('CLI token client add 预注册客户端', Boolean(clientRead && clientWrite && clientAdmin), `read=${clientRead ? 'ok' : 'null'}`);
  const consent = await cli(['token', 'consent', '--scope', 'memory.read,memory.write', '--ttl', '600'], {}, mainHome);
  const consentCode = JSON.parse(consent.out || '{}').code ?? null;
  check('CLI token consent 生成一次性同意码', typeof consentCode === 'string', consentCode ? 'ok' : String(consent.err ?? '').split('\n')[0]);

  // 等待：客户端/同意码文件已落盘（serve 每个请求现读）
  await mkdir(join(mainHome, 'auth'), { recursive: true });

  const h = spawnServe({ subdir: 'main', env: { MEBULAR_OAUTH_ADMIN_SECRET: ADMIN_SECRET, MEBULAR_OAUTH_ISSUER: FIXED_ISSUER } });
  const ready = await waitReady(h);
  const base = `http://127.0.0.1:${ready.port}`;
  check('serve 启动（oauth）', Number.isInteger(ready.port) && ready.port > 0, `port=${ready.port}`);

  // ---------- metadata ----------
  const as = await httpJson(`${base}/.well-known/oauth-authorization-server`);
  const grants = as.json?.grant_types_supported ?? [];
  check('metadata 不再广告 client_credentials', !grants.includes('client_credentials'), grants.join(','));
  check('metadata grant_types 与实现一致', JSON.stringify([...grants].sort()) === JSON.stringify(['authorization_code', 'refresh_token']), grants.join(','));
  check('metadata 默认不含 registration_endpoint', !as.json?.registration_endpoint, as.json?.registration_endpoint ?? '(none)');

  // ---------- 红灯 1：匿名 client_credentials ----------
  const credRes = await postToken(base, { grant_type: 'client_credentials', scope: 'memory.admin' });
  check('1 匿名 client_credentials 被拒且无 token', credRes.status >= 400 && !credRes.json?.access_token, `status=${credRes.status}`);

  // ---------- 红灯 2：匿名 /authorize ----------
  const p2 = pkce();
  const anonAuthorize = await getAuthorize(base, {
    response_type: 'code', client_id: clientAdmin ?? 'verify-client', redirect_uri: REDIRECT,
    code_challenge: p2.challenge, code_challenge_method: 'S256', scope: 'memory.admin', state: 's2',
  });
  check('2 匿名 /authorize 被拒且无 code', (anonAuthorize.status === 401 || anonAuthorize.status === 403) && !anonAuthorize.code, `status=${anonAuthorize.status}`);

  // ---------- 红灯 3：未注册 redirect_uri ----------
  const p3 = pkce();
  const badRedirect = await getAuthorize(base, {
    response_type: 'code', client_id: clientRead ?? 'verify-client', redirect_uri: REDIRECT_UNREGISTERED,
    code_challenge: p3.challenge, code_challenge_method: 'S256', scope: 'memory.read', admin_secret: ADMIN_SECRET,
  });
  check('3 未注册 redirect_uri 被拒且无 code', badRedirect.status >= 400 && !badRedirect.code, `status=${badRedirect.status}`);

  // ---------- 红灯 4：超出客户端 allowed_scopes ----------
  const p4 = pkce();
  const overScope = await getAuthorize(base, {
    response_type: 'code', client_id: clientRead ?? 'verify-client', redirect_uri: REDIRECT,
    code_challenge: p4.challenge, code_challenge_method: 'S256', scope: 'memory.admin', admin_secret: ADMIN_SECRET,
  });
  check('4 超出 allowed_scopes → 403（insufficient_scope）', overScope.status === 403 && !overScope.code, `status=${overScope.status}`);

  // ---------- 红灯 5：匿名 /register ----------
  const reg = await httpJson(`${base}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], scope: 'memory.read' }),
  });
  check('5 匿名 /register 被拒且无 client_id', reg.status >= 400 && !reg.json?.client_id, `status=${reg.status}`);

  // ---------- 绿灯 6：合法路径（同意码 → code → token → /mcp） ----------
  let access = null;
  let refresh = null;
  {
    const p = pkce();
    const authz = await getAuthorize(base, {
      response_type: 'code', client_id: clientWrite ?? 'verify-client', redirect_uri: REDIRECT,
      code_challenge: p.challenge, code_challenge_method: 'S256', scope: 'memory.read memory.write', state: 'legit', consent_code: consentCode,
    });
    check('6a 预注册客户端 + 同意码 → 302 带 code', authz.status === 302 && !!authz.code && new URL(authz.location).searchParams.get('state') === 'legit', `status=${authz.status}`);
    const tok = await postToken(base, {
      grant_type: 'authorization_code', code: authz.code ?? '', redirect_uri: REDIRECT, client_id: clientWrite ?? 'verify-client', code_verifier: p.verifier,
    });
    access = tok.json?.access_token ?? null;
    refresh = tok.json?.refresh_token ?? null;
    check('6b /token 颁发 access+refresh', tok.status === 200 && typeof access === 'string' && typeof refresh === 'string', `status=${tok.status}`);
    const count = access ? await mcpListTools(base, access) : -1;
    check('6c oauth token → /mcp tools/list=27（统一入口）', count === 27, `count=${count}`);
  }
  // 6d 管理员口令路径（与同意码并存）
  {
    const p = pkce();
    const authz = await getAuthorize(base, {
      response_type: 'code', client_id: clientRead ?? 'verify-client', redirect_uri: REDIRECT,
      code_challenge: p.challenge, code_challenge_method: 'S256', scope: 'memory.read', admin_secret: ADMIN_SECRET,
    });
    check('6d 管理员口令 → 302 带 code', authz.status === 302 && !!authz.code, `status=${authz.status}`);
  }

  // ---------- 绿灯 8：refresh 轮换 + 持久 ----------
  let rotatedRefresh = null;
  if (refresh) {
    const r1 = await postToken(base, { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientWrite ?? 'verify-client' });
    rotatedRefresh = r1.json?.refresh_token ?? null;
    check('8a refresh 轮换成功', r1.status === 200 && typeof r1.json?.access_token === 'string', `status=${r1.status}`);
    const reuse = await postToken(base, { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientWrite ?? 'verify-client' });
    check('8b 旧 refresh 复用被拒', reuse.status === 400, `status=${reuse.status}`);
  } else {
    check('8a refresh 轮换成功', false, '无 refresh（6 未通过）');
    check('8b 旧 refresh 复用被拒', false, '无 refresh（6 未通过）');
  }

  // ---------- 绿灯 7：撤销跨重启 ----------
  if (access) {
    await httpJson(`${base}/token/revoke`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: access }).toString(),
    });
    check('7a revoke 后当前实例拒绝', await mcpRejected(base, access));
  } else {
    check('7a revoke 后当前实例拒绝', false, '无 access（6 未通过）');
  }

  // 重启同一 home
  await stop(h);
  const h2 = spawnServe({ subdir: 'main', env: { MEBULAR_OAUTH_ADMIN_SECRET: ADMIN_SECRET, MEBULAR_OAUTH_ISSUER: FIXED_ISSUER } });
  const ready2 = await waitReady(h2);
  const base2 = `http://127.0.0.1:${ready2.port}`;
  if (access) check('7b 重启后已撤销 token 仍被拒（持久）', await mcpRejected(base2, access));
  else check('7b 重启后已撤销 token 仍被拒（持久）', false, '无 access（6 未通过）');
  if (refresh || rotatedRefresh) {
    const oldRefresh = refresh;
    const afterRestart = oldRefresh
      ? await postToken(base2, { grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: clientWrite ?? 'verify-client' })
      : null;
    check('8c 重启后旧 refresh 仍失效（轮换持久）', afterRestart?.status === 400, `status=${afterRestart?.status}`);
  } else {
    check('8c 重启后旧 refresh 仍失效（轮换持久）', false, '无 refresh（6 未通过）');
  }
  await stop(h2);

  // ---------- 绿灯 8d：限流 429 ----------
  {
    const h3 = spawnServe({ subdir: 'ratelimit', env: { MEBULAR_OAUTH_RATE_LIMIT: '3' } });
    const ready3 = await waitReady(h3);
    const b3 = `http://127.0.0.1:${ready3.port}`;
    let saw429 = false;
    for (let i = 0; i < 6; i++) {
      const r = await postToken(b3, { grant_type: 'authorization_code', code: 'none', redirect_uri: REDIRECT, client_id: 'x', code_verifier: 'y' });
      if (r.status === 429) { saw429 = true; break; }
    }
    check('8d 限流触发 429', saw429);
    await stop(h3);
  }

  // ---------- 撤销文件持久化存在性 ----------
  const revokedFile = join(home, 'main', 'auth', 'revoked.json');
  const revokedRaw = await readFile(revokedFile, 'utf-8').catch(() => '');
  let revokedCount = 0;
  try { revokedCount = (JSON.parse(revokedRaw).jti ?? []).length; } catch { revokedCount = 0; }
  check('撤销落盘 .mebular/auth/revoked.json', revokedCount >= 1, `count=${revokedCount}`);
} catch (error) {
  check('OAuth 硬化端到端', false, String(error?.message ?? error).substring(0, 400));
} finally {
  for (const s of servers) await stop(s);
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
}

console.log('=====================================');
if (passed) {
  console.log('✓ G6.3 补丁 OAuth 鉴权硬化验证通过（E1）');
  process.exit(0);
} else {
  console.log('✗ G6.3 补丁 OAuth 鉴权硬化验证失败');
  process.exit(1);
}
