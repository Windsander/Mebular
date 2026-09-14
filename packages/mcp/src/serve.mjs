// Streamable HTTP server（G6.3）：/mcp、/healthz、OAuth 最小 AS+RS、单实例锁。
//
// - 传输：SDK WebStandardStreamableHTTPServerTransport（stateful + JSON 响应）。
// - 认证：none（stdio 除外；环回可无）/ bearer（tokensFile 存 sha256）/ oauth（内置最小 AS+RS）。
// - fail closed：非环回必须 TLS 且 auth != none，否则拒绝启动。
// - 单实例：<home>/lock O_EXCL + PID 存活检测 + 陈旧回收。

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { TOOL_SCOPES } from './tools.mjs';

const SCOPES = ['memory.read', 'memory.write', 'memory.admin'];
const SCOPE_RANK = { 'memory.read': 0, 'memory.write': 1, 'memory.admin': 2 };
const ACCESS_TTL = 900; // 15min
const REFRESH_TTL = 30 * 24 * 3600; // 30d

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

function metadataFor(issuer) {
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
      registration_endpoint: `${issuer}/register`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
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
export async function startHttpServer({ home, service, buildServer, host = '127.0.0.1', port = 7331, auth = 'none', tls = false, tlsKey, tlsCert, tokensFile }) {
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
  // origin/issuer 在 listen 后按实际端口重算（支持 --port 0）
  let origin = `${scheme}://${isLoopback ? '127.0.0.1' : host}:${port}`;
  let issuer = process.env.MEBULAR_OAUTH_ISSUER ?? origin;
  let metadata = metadataFor(issuer);
  const signingKey = auth === 'oauth' ? await loadOrCreateSigningKey(home) : null;
  const codes = new Map();
  const revoked = new Set();

  // 单实例 transport（stateful + JSON 响应）
  const mcpServer = buildServer(service);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await mcpServer.connect(transport);

  async function authenticate(req, body) {
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
    const required = requiredScopeForBody(body);
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
          return sendJson(res, 201, { client_id: randomUUID(), token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
        }
        if (path === '/authorize' && (req.method === 'GET' || req.method === 'POST')) {
          const params = req.method === 'GET' ? url.searchParams : new URLSearchParams(body.toString('utf-8'));
          const redirectUri = params.get('redirect_uri');
          const codeChallenge = params.get('code_challenge');
          const method = params.get('code_challenge_method');
          const state = params.get('state');
          if (!redirectUri || !codeChallenge || method !== 'S256') {
            return sendJson(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 required' });
          }
          const code = randomUUID();
          codes.set(code, {
            redirectUri,
            codeChallenge,
            scope: (params.get('scope') ?? 'memory.read').split(/\s+/).filter(Boolean),
            exp: Date.now() + 300_000,
          });
          const location = `${redirectUri}?code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
          res.statusCode = 302;
          res.setHeader('location', location);
          return res.end();
        }
        if (path === '/token' && req.method === 'POST') {
          const params = new URLSearchParams(body.toString('utf-8'));
          const grantType = params.get('grant_type');
          const now = Math.floor(Date.now() / 1000);
          let scope = ['memory.read'];
          if (grantType === 'authorization_code') {
            const record = codes.get(params.get('code') ?? '');
            if (!record || record.exp < Date.now()) return sendJson(res, 400, { error: 'invalid_grant' });
            const verifier = params.get('code_verifier') ?? '';
            const challenge = b64url(createHash('sha256').update(verifier).digest());
            if (challenge !== record.codeChallenge) return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
            codes.delete(params.get('code'));
            scope = record.scope;
          } else if (grantType === 'refresh_token') {
            const payload = await verifyJwt(signingKey, params.get('refresh_token') ?? '', { issuer, resource: `${issuer}/mcp`, revoked });
            if (!payload || payload.type !== 'refresh') return sendJson(res, 400, { error: 'invalid_grant' });
            revoked.add(payload.jti); // 轮换：旧 refresh 失效
            scope = payload.scope ?? ['memory.read'];
          } else if (grantType === 'client_credentials') {
            scope = (params.get('scope') ?? 'memory.read').split(/\s+/).filter((s) => SCOPES.includes(s));
            if (scope.length === 0) return sendJson(res, 400, { error: 'invalid_scope' });
          } else {
            return sendJson(res, 400, { error: 'unsupported_grant_type' });
          }
          const access = await signJwt(signingKey, { iss: issuer, aud: `${issuer}/mcp`, sub: 'user', scope, type: 'access', jti: randomUUID(), iat: now, exp: now + ACCESS_TTL });
          const refresh = await signJwt(signingKey, { iss: issuer, aud: `${issuer}/mcp`, sub: 'user', scope, type: 'refresh', jti: randomUUID(), iat: now, exp: now + REFRESH_TTL });
          return sendJson(res, 200, { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: scope.join(' ') });
        }
        if (path === '/token/revoke' && req.method === 'POST') {
          const params = new URLSearchParams(body.toString('utf-8'));
          const token = params.get('token') ?? '';
          const parts = token.split('.');
          if (parts.length === 3) {
            try {
              const payload = JSON.parse(Buffer.from(b64urlToBytes(parts[1]), 'utf8').toString('utf-8'));
              if (payload.jti) revoked.add(payload.jti);
            } catch {
              // ignore malformed
            }
          }
          return sendJson(res, 200, {});
        }
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
  metadata = metadataFor(issuer);
  const close = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await mcpServer.close().catch(() => undefined);
  };
  return { server, host, port: actualPort, auth, issuer, close };
}
