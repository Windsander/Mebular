// Streamable HTTP server（G6.3）：/mcp、/healthz、OAuth 最小 AS+RS、单实例锁。
//
// - 传输：SDK WebStandardStreamableHTTPServerTransport（stateful + JSON 响应）。
// - 认证：none（stdio 除外；环回可无）/ bearer（tokensFile 存 sha256）/ oauth（内置最小 AS+RS）。
// - fail closed：非环回必须 TLS 且 auth != none，否则拒绝启动。
// - 单实例：<home>/lock O_EXCL + PID 存活检测 + 陈旧回收。

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { TOOL_SCOPES } from './tools.mjs';
import { buildJoinToken } from './jointoken.mjs';

const SCOPES = ['memory.read', 'memory.write', 'memory.admin'];
const SCOPE_RANK = { 'memory.read': 0, 'memory.write': 1, 'memory.admin': 2 };
const DEFAULT_SCOPES = ['memory.read'];
const ACCESS_TTL = 900; // 15min
const REFRESH_TTL = 30 * 24 * 3600; // 30d
const RATE_WINDOW_MS = 60_000;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function basicPassword(header) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    return idx === -1 ? null : decoded.slice(idx + 1);
  } catch {
    return null;
  }
}

function makeRateLimiter(max) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    list.push(now);
    hits.set(key, list);
    if (list.length > max) {
      return { limited: true, retryAfter: Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - list[0])) / 1000)) };
    }
    return { limited: false };
  };
}

// ---------- 客户端注册 / 同意码 / 撤销持久（D45） ----------

async function loadClientRegistry(clientsFile) {
  if (!existsSync(clientsFile)) return [];
  try {
    const data = JSON.parse(await readFile(clientsFile, 'utf-8'));
    return Array.isArray(data.clients) ? data.clients : [];
  } catch (error) {
    throw new Error(`clientsFile 损坏：${clientsFile}（${error.message}）`);
  }
}

async function findClient(clientsFile, clientId) {
  if (!clientId) return null;
  return (await loadClientRegistry(clientsFile)).find((c) => c.clientId === clientId) ?? null;
}

async function saveClientRegistry(clientsFile, clients) {
  await mkdir(dirname(clientsFile), { recursive: true });
  await writeFile(clientsFile, JSON.stringify({ clients }, null, 2), 'utf-8');
  await chmod(clientsFile, 0o600);
}

async function consumeConsent(consentFile, code) {
  if (!code || !existsSync(consentFile)) return null;
  let data;
  try {
    data = JSON.parse(await readFile(consentFile, 'utf-8'));
  } catch {
    return null;
  }
  const codes = Array.isArray(data.codes) ? data.codes : [];
  const idx = codes.findIndex((c) => c.code === code && !c.usedAt && c.exp > Date.now());
  if (idx === -1) return null;
  codes[idx].usedAt = new Date().toISOString();
  await writeFile(consentFile, JSON.stringify({ codes }, null, 2), 'utf-8');
  await chmod(consentFile, 0o600);
  return codes[idx];
}

async function loadRevoked(revokedFile) {
  if (!existsSync(revokedFile)) return new Set();
  try {
    const data = JSON.parse(await readFile(revokedFile, 'utf-8'));
    return new Set(Array.isArray(data.jti) ? data.jti : []);
  } catch {
    return new Set();
  }
}

async function persistRevoked(revokedFile, revoked) {
  await mkdir(dirname(revokedFile), { recursive: true });
  await writeFile(revokedFile, JSON.stringify({ jti: [...revoked], updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
  await chmod(revokedFile, 0o600);
}

// ---------- 单实例锁 ----------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(home, storagePath) {
  const path = join(home, 'lock');
  await mkdir(dirname(path), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), storagePath });
  const write = () => writeFile(path, payload, 'utf-8');
  const release = async () => { await unlink(path).catch(() => undefined); };

  if (!existsSync(path)) {
    await writeFile(path, payload, { encoding: 'utf-8', flag: 'wx' });
    return { path, release };
  }
  let held = null;
  try {
    held = JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    // 损坏锁按陈旧处理
  }
  if (held?.pid && pidAlive(held.pid)) {
    const error = new Error(
      `存储已被占用：pid ${held.pid}（自 ${held.startedAt}，${held.storagePath}）。请复用该 serve 实例，或先停止它。`,
    );
    error.code = 'MCP_STORAGE_LOCKED';
    throw error;
  }
  // 陈旧锁回收
  await write();
  return { path, release };
}

// ---------- bearer ----------

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function loadTokens(tokensFile) {
  if (!tokensFile || !existsSync(tokensFile)) return [];
  try {
    const data = JSON.parse(await readFile(tokensFile, 'utf-8'));
    return Array.isArray(data.tokens) ? data.tokens : [];
  } catch (error) {
    throw new Error(`tokensFile 损坏：${tokensFile}（${error.message}）`);
  }
}

async function verifyBearer(token, tokensFile) {
  const digest = hashToken(token);
  const tokens = await loadTokens(tokensFile);
  const record = tokens.find((t) => t.sha256 === digest && !t.revoked);
  if (!record) return null;
  return { tokenId: record.id ?? 'bearer', scopes: record.scope ?? [] };
}

// ---------- OAuth 最小 AS/RS ----------

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s) {
  return new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}
function ab(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function loadOrCreateSigningKey(home) {
  const path = join(home, 'auth', 'as-key.json');
  if (existsSync(path)) {
    const data = JSON.parse(await readFile(path, 'utf-8'));
    const privateKey = await crypto.subtle.importKey('pkcs8', ab(b64urlToBytes(data.privateKeyPkcs8)), { name: 'Ed25519' }, true, ['sign']);
    return { privateKey, publicRaw: b64urlToBytes(data.publicKey), kid: data.kid };
  }
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const kid = randomUUID();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ privateKeyPkcs8: b64url(pkcs8), publicKey: b64url(publicRaw), kid }), 'utf-8');
  await chmod(path, 0o600);
  return { privateKey: kp.privateKey, publicRaw, kid };
}

async function signJwt(signingKey, payload) {
  const header = { alg: 'EdDSA', typ: 'JWT', kid: signingKey.kid };
  const body = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, signingKey.privateKey, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

async function verifyJwt(signingKey, token, { issuer, resource, revoked }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const data = new TextEncoder().encode(`${h}.${p}`);
  const key = await crypto.subtle.importKey('raw', ab(signingKey.publicRaw), { name: 'Ed25519' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, ab(b64urlToBytes(s)), data);
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64urlToBytes(p), 'utf8').toString('utf-8'));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== issuer) return null;
  if (payload.aud !== resource) return null;
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (revoked.has(payload.jti)) return null;
  return payload;
}

function metadataFor(issuer, { registrationEnabled = false } = {}) {
  const resource = `${issuer}/mcp`;
  return {
    protectedResource: {
      resource,
      authorization_servers: [issuer],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header'],
    },
    authorizationServer: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      ...(registrationEnabled ? { registration_endpoint: `${issuer}/register` } : {}),
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: SCOPES,
    },
  };
}

// ---------- 请求/响应桥 ----------

function toWebRequest(req, body, origin) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else if (v !== undefined) headers.set(k, v);
  }
  return new Request(new URL(req.url, origin), {
    method: req.method,
    headers,
    ...(body && body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
  });
}

async function writeWebResponse(res, response) {
  res.statusCode = response.status;
  for (const [k, v] of response.headers) res.setHeader(k, v);
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  }
  res.end();
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function requiredScopeForBody(body) {
  let messages;
  try {
    const parsed = JSON.parse(body.toString('utf-8'));
    messages = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return 'memory.read';
  }
  let required = 'memory.read';
  for (const msg of messages) {
    if (!msg || typeof msg.method !== 'string') continue;
    if (msg.method === 'initialize' || msg.method.startsWith('notifications/') || msg.method === 'ping') continue;
    let scope = 'memory.read';
    if (msg.method === 'tools/call') {
      scope = TOOL_SCOPES[msg.params?.name] ?? 'memory.read';
    } else if (msg.method.startsWith('tools/') || msg.method.startsWith('resources/') || msg.method.startsWith('prompts/')) {
      scope = 'memory.read';
    }
    if ((SCOPE_RANK[scope] ?? 0) > (SCOPE_RANK[required] ?? 0)) required = scope;
  }
  return required;
}

function hasScope(granted, required) {
  const rank = SCOPE_RANK[required] ?? 0;
  return (granted ?? []).some((s) => (SCOPE_RANK[s] ?? -1) >= rank);
}

/**
 * 启动 HTTP MCP server。
 * @returns {Promise<{ server: import('node:http').Server, host: string, port: number, auth: string, close: () => Promise<void> }>}
 */
export async function startHttpServer({ home, app, service, buildServer, host = '127.0.0.1', port = 7331, auth = 'none', tls = false, tlsKey, tlsCert, tokensFile, deviceId, namespace = 'tasks', joinEndpoint }) {
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLoopback && (auth === 'none' || !tls)) {
    const error = new Error(
      `fail closed：非环回地址 ${host} 必须启用 TLS 且 auth != none（当前 auth=${auth}, tls=${tls}）`,
    );
    error.code = 'MCP_INSECURE_CONFIG';
    throw error;
  }
  if (!isLoopback && tls && !tlsKey) {
    const error = new Error('fail closed：TLS 需要提供证书（tlsKey/tlsCert）');
    error.code = 'MCP_INSECURE_CONFIG';
    throw error;
  }

  const scheme = tls ? 'https' : 'http';
  // D45：OAuth 硬化配置（密钥/secret 不落 config，仅 env）
  const adminSecret = process.env.MEBULAR_OAUTH_ADMIN_SECRET ?? null;
  const registerSecret = process.env.MEBULAR_OAUTH_REGISTER_SECRET ?? null;
  const registrationEnabled = Boolean(registerSecret);
  const clientsFile = process.env.MEBULAR_OAUTH_CLIENTS_FILE ?? join(home, 'auth', 'clients.json');
  const consentFile = process.env.MEBULAR_OAUTH_CONSENT_FILE ?? join(home, 'auth', 'consent.json');
  const revokedFile = process.env.MEBULAR_OAUTH_REVOKED_FILE ?? join(home, 'auth', 'revoked.json');
  const rateLimit = makeRateLimiter(Number(process.env.MEBULAR_OAUTH_RATE_LIMIT ?? 60));

  // origin/issuer 在 listen 后按实际端口重算（支持 --port 0）
  let origin = `${scheme}://${isLoopback ? '127.0.0.1' : host}:${port}`;
  let issuer = process.env.MEBULAR_OAUTH_ISSUER ?? origin;
  let metadata = metadataFor(issuer, { registrationEnabled });
  const signingKey = auth === 'oauth' ? await loadOrCreateSigningKey(home) : null;
  const codes = new Map();
  const revoked = await loadRevoked(revokedFile);

  // 单实例 transport（stateful + JSON 响应）
  const mcpServer = buildServer(service);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await mcpServer.connect(transport);

  async function authenticate(req, body, requiredOverride) {
    if (auth === 'none') return { ok: true };
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return { ok: false, status: 401, message: 'missing bearer token', challenge: 'Bearer' };
    }
    const token = header.slice('Bearer '.length);
    let grant = null;
    if (auth === 'bearer') {
      grant = await verifyBearer(token, tokensFile);
    } else {
      const payload = await verifyJwt(signingKey, token, { issuer, resource: `${issuer}/mcp`, revoked });
      if (payload && payload.type === 'access') grant = { tokenId: payload.jti, scopes: payload.scope ?? [] };
    }
    if (!grant) {
      return { ok: false, status: 401, message: 'invalid token', challenge: 'Bearer error="invalid_token"' };
    }
    const required = requiredOverride ?? requiredScopeForBody(body);
    if (!hasScope(grant.scopes, required)) {
      return { ok: false, status: 403, message: `insufficient scope: need ${required}`, challenge: `Bearer error="insufficient_scope", scope="${required}"`, tokenId: grant.tokenId };
    }
    return { ok: true, tokenId: grant.tokenId, scopes: grant.scopes };
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const path = url.pathname;
      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : Buffer.alloc(0);

      if (path === '/healthz' && req.method === 'GET') {
        return sendJson(res, 200, { status: 'ok', name: 'mebular', version: '0.1.0', auth, tls });
      }
      if (auth === 'oauth') {
        if (path === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
          return sendJson(res, 200, metadata.protectedResource);
        }
        if (path === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
          return sendJson(res, 200, metadata.authorizationServer);
        }
        if (path === '/jwks' && req.method === 'GET') {
          return sendJson(res, 200, {
            keys: [{ kty: 'OKP', crv: 'Ed25519', x: b64url(signingKey.publicRaw), kid: signingKey.kid, use: 'sig', alg: 'EdDSA' }],
          });
        }
        if (path === '/register' && req.method === 'POST') {
          // D45：默认禁用；仅 bootstrap secret 匹配时允许，且 scope 上限 memory.read
          if (!registrationEnabled) return sendJson(res, 404, { error: 'not_found' });
          const provided = req.headers['x-mebular-register-secret'];
          const bearer = typeof req.headers['authorization'] === 'string' && req.headers['authorization'].startsWith('Bearer ')
            ? req.headers['authorization'].slice('Bearer '.length)
            : null;
          if (!safeEqual(typeof provided === 'string' ? provided : '', registerSecret) && !safeEqual(bearer ?? '', registerSecret)) {
            return sendJson(res, 401, { error: 'invalid_client' });
          }
          let meta = {};
          try {
            meta = JSON.parse(body.toString('utf-8') || '{}');
          } catch {
            meta = {};
          }
          const redirectUris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris.filter((s) => typeof s === 'string') : [];
          if (redirectUris.length === 0) return sendJson(res, 400, { error: 'invalid_redirect_uri' });
          const clientId = randomUUID();
          const clients = await loadClientRegistry(clientsFile);
          clients.push({ clientId, redirectUris, allowedScopes: [...DEFAULT_SCOPES], source: 'dcr', createdAt: new Date().toISOString() });
          await saveClientRegistry(clientsFile, clients);
          return sendJson(res, 201, { client_id: clientId, redirect_uris: redirectUris, scope: DEFAULT_SCOPES.join(' '), token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
        }
        if (path === '/authorize' && (req.method === 'GET' || req.method === 'POST')) {
          const ip = req.socket?.remoteAddress ?? 'unknown';
          const rl = rateLimit(ip);
          if (rl.limited) {
            res.setHeader('retry-after', String(rl.retryAfter));
            return sendJson(res, 429, { error: 'too_many_requests' });
          }
          const params = req.method === 'GET' ? url.searchParams : new URLSearchParams(body.toString('utf-8'));
          if (params.get('response_type') !== 'code') {
            return sendJson(res, 400, { error: 'unsupported_response_type' });
          }
          const client = await findClient(clientsFile, params.get('client_id'));
          if (!client) return sendJson(res, 401, { error: 'invalid_client', error_description: 'client_id 未注册' });
          const redirectUri = params.get('redirect_uri');
          if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
            return sendJson(res, 400, { error: 'invalid_request', error_description: 'redirect_uri 未注册（需精确匹配）' });
          }
          const codeChallenge = params.get('code_challenge');
          if (!codeChallenge || params.get('code_challenge_method') !== 'S256') {
            return sendJson(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 required' });
          }
          // 用户认证/同意：管理员口令 或 一次性本地同意码，二者缺一即拒（绝不 302）
          const headerSecret = req.headers['x-mebular-admin-secret'];
          const suppliedSecret =
            params.get('admin_secret') ??
            (typeof headerSecret === 'string' ? headerSecret : null) ??
            basicPassword(req.headers['authorization']);
          let userAuthorized = false;
          let consentScopes = null;
          if (adminSecret && suppliedSecret && safeEqual(String(suppliedSecret), adminSecret)) {
            userAuthorized = true;
          } else {
            const consent = await consumeConsent(consentFile, params.get('consent_code'));
            if (consent) {
              userAuthorized = true;
              consentScopes = Array.isArray(consent.scopes) ? consent.scopes : DEFAULT_SCOPES;
            }
          }
          if (!userAuthorized) {
            return sendJson(res, 401, { error: 'access_denied', error_description: '需要管理员口令或本地同意码' });
          }
          const requested = (params.get('scope') ?? '').split(/\s+/).filter(Boolean);
          const requestedScopes = requested.length > 0 ? requested : [...DEFAULT_SCOPES];
          const unknown = requestedScopes.filter((s) => !SCOPES.includes(s));
          if (unknown.length > 0) return sendJson(res, 400, { error: 'invalid_scope', error_description: unknown.join(' ') });
          const notAllowed = requestedScopes.filter((s) => !client.allowedScopes.includes(s));
          if (notAllowed.length > 0) {
            return sendJson(res, 403, { error: 'insufficient_scope', error_description: `超出客户端 allowed_scopes: ${notAllowed.join(' ')}` });
          }
          const granted = consentScopes ? requestedScopes.filter((s) => consentScopes.includes(s)) : requestedScopes;
          if (granted.length === 0) return sendJson(res, 403, { error: 'insufficient_scope', error_description: '同意范围不含请求 scope' });
          const code = randomUUID();
          const state = params.get('state');
          codes.set(code, { clientId: client.clientId, redirectUri, codeChallenge, scope: granted, exp: Date.now() + 300_000 });
          const location = `${redirectUri}?code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
          res.statusCode = 302;
          res.setHeader('location', location);
          return res.end();
        }
        if (path === '/token' && req.method === 'POST') {
          const ip = req.socket?.remoteAddress ?? 'unknown';
          const rl = rateLimit(ip);
          if (rl.limited) {
            res.setHeader('retry-after', String(rl.retryAfter));
            return sendJson(res, 429, { error: 'too_many_requests' });
          }
          const params = new URLSearchParams(body.toString('utf-8'));
          const grantType = params.get('grant_type');
          const now = Math.floor(Date.now() / 1000);
          let scope = [...DEFAULT_SCOPES];
          let clientId = params.get('client_id');
          if (grantType === 'authorization_code') {
            const code = params.get('code') ?? '';
            const record = codes.get(code);
            if (!record || record.exp < Date.now()) return sendJson(res, 400, { error: 'invalid_grant' });
            const client = await findClient(clientsFile, clientId);
            if (!client || client.clientId !== record.clientId) return sendJson(res, 400, { error: 'invalid_client' });
            if (params.get('redirect_uri') !== record.redirectUri) {
              return sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
            }
            const verifier = params.get('code_verifier') ?? '';
            const challenge = b64url(createHash('sha256').update(verifier).digest());
            if (challenge !== record.codeChallenge) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
            codes.delete(code);
            scope = record.scope;
            clientId = record.clientId;
          } else if (grantType === 'refresh_token') {
            const payload = await verifyJwt(signingKey, params.get('refresh_token') ?? '', { issuer, resource: `${issuer}/mcp`, revoked });
            if (!payload || payload.type !== 'refresh') return sendJson(res, 400, { error: 'invalid_grant' });
            if (clientId && payload.client_id && clientId !== payload.client_id) return sendJson(res, 400, { error: 'invalid_grant' });
            revoked.add(payload.jti); // 轮换：旧 refresh 失效，持久化
            await persistRevoked(revokedFile, revoked);
            scope = Array.isArray(payload.scope) ? payload.scope : DEFAULT_SCOPES;
            clientId = payload.client_id ?? clientId;
          } else {
            // D45：client_credentials 已移除
            return sendJson(res, 400, { error: 'unsupported_grant_type' });
          }
          const claims = { iss: issuer, aud: `${issuer}/mcp`, sub: 'user', client_id: clientId ?? null, scope };
          const access = await signJwt(signingKey, { ...claims, type: 'access', jti: randomUUID(), iat: now, exp: now + ACCESS_TTL });
          const refresh = await signJwt(signingKey, { ...claims, type: 'refresh', jti: randomUUID(), iat: now, exp: now + REFRESH_TTL });
          return sendJson(res, 200, { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: scope.join(' ') });
        }
        if (path === '/token/revoke' && req.method === 'POST') {
          const params = new URLSearchParams(body.toString('utf-8'));
          const token = params.get('token') ?? '';
          const parts = token.split('.');
          if (parts.length === 3) {
            try {
              const payload = JSON.parse(Buffer.from(b64urlToBytes(parts[1]), 'utf8').toString('utf-8'));
              if (payload.jti) {
                revoked.add(payload.jti);
                await persistRevoked(revokedFile, revoked);
              }
            } catch {
              // ignore malformed
            }
          }
          return sendJson(res, 200, {});
        }
      }
      // W2 A3：本机 app 接口（loopback + token；单写者由 serve 锁保证）
      if (path.startsWith('/app/')) {
        const appRequired = req.method === 'POST' ? 'memory.write' : 'memory.read';
        const check = await authenticate(req, body, appRequired);
        if (!check.ok) {
          res.statusCode = check.status;
          if (check.challenge) res.setHeader('www-authenticate', check.challenge);
          return sendJson(res, check.status, { ok: false, error: check.message });
        }
        if (path === '/app/network' && req.method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            deviceId: deviceId ?? null,
            peerId: app.node?.peerId?.id ?? null,
            multiaddrs: app.node?.getLocalMultiaddrs?.() ?? [],
          });
        }
        if (path === '/app/namespaces' && req.method === 'GET') {
          const nodes = await app.graph.listNodes({});
          const namespaces = [...new Set(nodes.map((n) => n.namespace ?? 'default'))].sort();
          return sendJson(res, 200, { ok: true, namespaces, count: namespaces.length });
        }
        if (path === '/app/nodes' && req.method === 'POST') {
          let payload;
          try {
            payload = JSON.parse(body.toString('utf-8') || '{}');
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid json' });
          }
          const type = typeof payload.type === 'string' && payload.type.length > 0 ? payload.type : null;
          if (!type) return sendJson(res, 400, { ok: false, error: 'type 必填' });
          const node = await app.graph.createNode(
            type,
            typeof payload.content === 'object' && payload.content !== null ? payload.content : {},
            Array.isArray(payload.edges) ? payload.edges : [],
            payload.namespace ? { namespace: payload.namespace } : {},
          );
          return sendJson(res, 200, { ok: true, node: { id: node.id, type: node.type, namespace: node.namespace ?? 'default' } });
        }
        if (path === '/app/nodes' && req.method === 'GET') {
          const filter = {};
          const ns = url.searchParams.get('namespace');
          const type = url.searchParams.get('type');
          const limit = Number(url.searchParams.get('limit') ?? '0');
          if (ns) filter.namespace = ns;
          if (type) filter.type = type;
          const nodes = await app.graph.listNodes(filter);
          const trimmed = Number.isInteger(limit) && limit > 0 ? nodes.slice(0, limit) : nodes;
          return sendJson(res, 200, {
            ok: true,
            count: trimmed.length,
            nodes: trimmed.map((n) => ({ id: n.id, type: n.type, namespace: n.namespace ?? 'default', content: n.content })),
          });
        }
        // W2 A4：join 邀请（守护用自身身份签发令牌）
        if (path === '/app/join/invite' && req.method === 'POST') {
          if (typeof deviceId !== 'string' || typeof joinEndpoint !== 'string') {
            return sendJson(res, 400, { ok: false, error: '守护未启用 joinService（缺 deviceId/joinEndpoint）' });
          }
          let payload;
          try {
            payload = JSON.parse(body.toString('utf-8') || '{}');
          } catch {
            payload = {};
          }
          const ns = typeof payload.namespace === 'string' && payload.namespace ? payload.namespace : namespace;
          const ttlMs = Number.isInteger(payload.ttlMs) && payload.ttlMs > 0 ? payload.ttlMs : 900_000;
          const endpoint = typeof payload.endpoint === 'string' && payload.endpoint ? payload.endpoint : joinEndpoint;
          const token = await buildJoinToken({ mebular: app, deviceId, namespace: ns, endpoint, ttlMs });
          const inline = Buffer.from(JSON.stringify(token), 'utf-8').toString('base64');
          return sendJson(res, 200, { ok: true, token: inline, endpoint, namespace: ns, expiresAt: token.expiresAt, nonce: token.nonce });
        }
        // W2：策略/成员（守护持有图表；fleet 客户端化）
        if (path === '/app/policy/effective' && req.method === 'GET') {
          const device = url.searchParams.get('device');
          if (!device) return sendJson(res, 400, { ok: false, error: 'device 必填' });
          const namespaces = await app.getEffectiveNamespaces(device);
          return sendJson(res, 200, { ok: true, device, namespaces });
        }
        if (path === '/app/policy/membership' && req.method === 'GET') {
          const ns = url.searchParams.get('namespace') ?? namespace;
          const membership = await app.getNamespaceMembership(ns);
          return sendJson(res, 200, { ok: true, namespace: ns, ...membership });
        }
        if (path.startsWith('/app/policy/') && req.method === 'POST') {
          let payload;
          try {
            payload = JSON.parse(body.toString('utf-8') || '{}');
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid json' });
          }
          if (path === '/app/policy/grant') {
            const namespaces = Array.isArray(payload.namespaces) ? payload.namespaces : payload.namespace ? [payload.namespace] : [];
            if (typeof payload.subject !== 'string' || namespaces.length === 0) return sendJson(res, 400, { ok: false, error: 'subject/namespaces 必填' });
            const event = await app.grantNamespaces({ subject: payload.subject, namespaces, ...(typeof payload.note === 'string' ? { note: payload.note } : {}) });
            return sendJson(res, 200, { ok: true, eventId: event.id, grant: event.data?.grant ?? null });
          }
          if (path === '/app/policy/revoke') {
            if (typeof payload.grantId !== 'string' || !payload.grantId) return sendJson(res, 400, { ok: false, error: 'grantId 必填' });
            const event = await app.revokeGrant({ grantId: payload.grantId, ...(typeof payload.subject === 'string' ? { subject: payload.subject } : {}), ...(typeof payload.note === 'string' ? { note: payload.note } : {}) });
            return sendJson(res, 200, { ok: true, eventId: event.id });
          }
          if (path === '/app/policy/member') {
            const ns = typeof payload.namespace === 'string' && payload.namespace ? payload.namespace : namespace;
            if (typeof payload.member !== 'string' || !payload.member) return sendJson(res, 400, { ok: false, error: 'member 必填' });
            const event = await app.declareNamespaceMembership({ member: payload.member, namespace: ns, active: payload.active !== false, ...(typeof payload.note === 'string' ? { note: payload.note } : {}) });
            return sendJson(res, 200, { ok: true, eventId: event.id });
          }
          if (path === '/app/policy/declare-issuer') {
            if (typeof payload.subject !== 'string' || !payload.subject) return sendJson(res, 400, { ok: false, error: 'subject 必填' });
            const event = await app.declarePolicyIssuer({ subject: payload.subject, ...(typeof payload.note === 'string' ? { note: payload.note } : {}) });
            return sendJson(res, 200, { ok: true, eventId: event.id });
          }
        }
        return sendJson(res, 404, { ok: false, error: 'not_found', path });
      }
      if (path === '/mcp') {
        const check = await authenticate(req, body);
        if (!check.ok) {
          res.statusCode = check.status;
          if (check.challenge) res.setHeader('www-authenticate', check.challenge);
          return sendJson(res, check.status, { jsonrpc: '2.0', error: { code: -32001, message: check.message }, id: null });
        }
        const webRequest = toWebRequest(req, body, origin);
        const response = await transport.handleRequest(webRequest);
        return writeWebResponse(res, response);
      }
      return sendJson(res, 404, { error: 'not_found', path });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: String(error?.message ?? error) });
      else res.end();
    }
  };

  let server;
  if (tls) {
    server = https.createServer({ key: await readFile(tlsKey, 'utf-8'), cert: await readFile(tlsCert, 'utf-8') }, handler);
  } else {
    server = http.createServer(handler);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const actualPort = server.address().port;
  origin = `${scheme}://${isLoopback ? '127.0.0.1' : host}:${actualPort}`;
  issuer = process.env.MEBULAR_OAUTH_ISSUER ?? origin;
  metadata = metadataFor(issuer, { registrationEnabled });
  const close = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await mcpServer.close().catch(() => undefined);
  };
  return { server, host, port: actualPort, auth, issuer, close };
}
