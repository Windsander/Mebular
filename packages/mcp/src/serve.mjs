// Streamable HTTP server（G6.3）：/mcp、/healthz、OAuth 最小 AS+RS、单实例锁。
//
// - 传输：SDK WebStandardStreamableHTTPServerTransport（stateful + JSON 响应）。
// - 认证：none（stdio 除外；环回可无）/ bearer（tokensFile 存 sha256）/ oauth（内置最小 AS+RS）。
// - fail closed：非环回必须 TLS 且 auth != none，否则拒绝启动。
// - 单实例：<home>/lock O_EXCL + PID 存活检测 + 陈旧回收。

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { TOOL_ALL_SCOPES } from './tools.mjs';
import { attachFleetEvents, resolveFleetNamespace } from './fleet-events.mjs';
import { READ_ROUTES, buildHandoffPlan } from './admin.mjs';
import { configPath } from './config.mjs';
import { createServiceFacade } from './service-facade.mjs';
import { buildRuntimeService, createRuntimeHttpHandler, isRuntimePath } from './runtime-memory.mjs';
import { APP_VERSION } from './version.mjs';
import { resolveStaticAssetRoots } from './asset-roots.mjs';

// 兼容既有导入方：APP_VERSION 的真源是 ./version.mjs。
export { APP_VERSION } from './version.mjs';

// ---------- 控制台配置写入（schema 驱动：editable 可写 / status-only 只读 / internal 默认不可写） ----------
// 单一真源：packages/mcp/src/config-schema.mjs。写入策略（原子写 + .bak 备份；全部需重启生效）：
//   editable → 允许；status-only → 400（自动推导）；internal → 仅显式 writable 允许；未知 → 400。
import { CONFIG_SCHEMA_BY_PATH, isWritable, writeRejection } from './config-schema.mjs';
import {
  inspectJoinToken,
  isProvisionHome,
  provisionCreate,
  provisionJoin,
  provisionJoinInto,
  provisionRestore,
  provisionStatus,
  snapshotProvisionState,
  writeProvisionRecord,
} from './provision.mjs';
import {
  acquireActiveLock,
  cloudError,
  homeKey,
  masterFingerprintFromHex,
  newProfileId,
  normalizeProfileName,
  profileIdForHome,
  readRegistry,
  registerProfile,
  renameProfile,
  resolveCloudRoot,
  PROFILES_DIR,
} from './profiles.mjs';
import {
  APPLY_HEALTH_TIMEOUT_MS,
  RESTART_DEBOUNCE_MS,
  classifyChanges,
  hotPaths,
  runRestart,
  spawnSupervisor,
  writeApplyPending,
} from './config-apply.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * F-C2：**组合校验**（针对合并后的完整配置）——不允许存出「把自己搞挂」的组合。
 * 规则：mcp.http.tls=true ⇒ 必须给出 tlsKey 与 tlsCert；非回环 host ⇒ auth != none 且 tls=true（且证书齐备）。
 */
function validateConfigCombination(merged) {
  const http = merged?.mcp?.http ?? {};
  const errors = [];
  const host = typeof http.host === 'string' && http.host.length > 0 ? http.host : '127.0.0.1';
  const tlsOn = http.tls === true;
  const hasCert = typeof http.tlsKey === 'string' && http.tlsKey.length > 0 && typeof http.tlsCert === 'string' && http.tlsCert.length > 0;
  if (tlsOn && !hasCert) {
    errors.push('启用 TLS（mcp.http.tls=true）需要同时填写 mcp.http.tlsKey 与 mcp.http.tlsCert（证书路径）');
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    if ((http.auth ?? 'none') === 'none') {
      errors.push(`非回环监听（host=${host}）不允许 auth=none：请设 mcp.http.auth=bearer/oauth`);
    }
    if (!tlsOn) errors.push(`非回环监听（host=${host}）要求 mcp.http.tls=true（并配 tlsKey/tlsCert）`);
  }
  return errors;
}

function flattenPatch(patch, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...flattenPatch(value, path));
    } else {
      out.push([path, value]);
    }
  }
  return out;
}

function validateConfigPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { errors: ['patch 必须是对象'] };
  }
  const errors = [];
  const entries = [];
  for (const [path, raw] of flattenPatch(patch)) {
    const entry = CONFIG_SCHEMA_BY_PATH.get(path);
    if (!entry || !isWritable(path)) {
      const rejection = writeRejection(path);
      if (rejection === 'status-only') {
        errors.push(`「${entry?.ui?.label ?? path}」为只读项（值由运行时 / 自动推导，如 relay 池、自动同步）：不能通过控制台修改；如需变更请手工编辑 config.json`);
      } else {
        errors.push(`不允许修改 ${path}（设备身份 / 存储 / 加密等请手工编辑 config.json）`);
      }
      continue;
    }
    const spec = { kind: entry.kind, ...(entry.spec ?? {}) };
    if (spec.kind === 'bool') {
      if (typeof raw !== 'boolean') errors.push(`${path} 需要布尔值`);
      else entries.push({ path, value: raw });
    } else if (spec.kind === 'int' || spec.kind === 'num') {
      if (raw === null && spec.nullable) {
        entries.push({ path, value: null });
      } else if (typeof raw !== 'number' || !Number.isFinite(raw) || (spec.kind === 'int' && !Number.isInteger(raw))) {
        errors.push(`${path} 需要${spec.kind === 'int' ? '整数' : '数字'}`);
      } else if ((spec.min !== undefined && raw < spec.min) || (spec.max !== undefined && raw > spec.max)) {
        errors.push(`${path} 超出范围（${spec.min ?? '-∞'} ~ ${spec.max ?? '∞'}）`);
      } else {
        entries.push({ path, value: raw });
      }
    } else if (spec.kind === 'string') {
      if (typeof raw !== 'string') errors.push(`${path} 需要字符串`);
      else if (raw.trim().length === 0 && spec.empty === 'delete') entries.push({ path, value: null });
      else if (spec.nonEmpty && raw.trim().length === 0) errors.push(`${path} 需要非空字符串`);
      else entries.push({ path, value: raw.trim() });
    } else if (spec.kind === 'enum') {
      if (!spec.values.includes(raw)) errors.push(`${path} 必须是 ${spec.values.join(' | ')}`);
      else entries.push({ path, value: raw });
    } else if (spec.kind === 'list') {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
        errors.push(`${path} 需要字符串数组`);
      } else {
        const list = [...new Set(raw.map((v) => v.trim()).filter(Boolean))];
        if (spec.prefix && list.some((v) => !v.startsWith(spec.prefix))) {
          errors.push(`${path} 每项需以 ${spec.prefix} 开头的 multiaddr`);
        } else if (list.length === 0 && spec.empty === 'delete') {
          entries.push({ path, value: null });
        } else {
          entries.push({ path, value: list });
        }
      }
    }
  }
  if (entries.length === 0 && errors.length === 0) errors.push('patch 为空');
  return { errors, entries };
}

function setAtPath(root, path, value) {
  const keys = path.split('.');
  let node = root;
  for (const key of keys.slice(0, -1)) {
    if (node[key] === null || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function deleteAtPath(root, path) {
  const keys = path.split('.');
  const chain = [root];
  let node = root;
  for (const key of keys.slice(0, -1)) {
    if (node[key] === null || typeof node[key] !== 'object' || Array.isArray(node[key])) return;
    node = node[key];
    chain.push(node);
  }
  delete node[keys[keys.length - 1]];
  // 修剪残留的空对象（如删除 intervalMs 后 sync.antiEntropy 变空）
  for (let i = chain.length - 1; i > 0; i -= 1) {
    if (Object.keys(chain[i]).length === 0) delete chain[i - 1][keys[i - 1]];
    else break;
  }
}
import { endpointHostname, isLoopbackHost } from './lan-host.mjs';
import { activateJoinInvite, buildJoinToken } from './jointoken.mjs';
import { renderSvgQr } from './qr.mjs';
import { clearRuntimeFile, writeRuntimeFile } from './runtime-file.mjs';

// R1.3：记忆面 memory.* + 任务面 task.*（两轴独立；同一轴内 write ⇒ read、admin ⇒ 其余）
const SCOPES = ['memory.read', 'memory.write', 'memory.admin', 'task.read', 'task.write'];
const SCOPE_IMPLIES = {
  'memory.read': ['memory.read'],
  'memory.write': ['memory.read', 'memory.write'],
  'memory.admin': ['memory.read', 'memory.write', 'memory.admin'],
  'task.read': ['task.read'],
  'task.write': ['task.read', 'task.write'],
};
const DEFAULT_SCOPES = ['memory.read'];
const ACCESS_TTL = 900; // 15min
const REFRESH_TTL = 30 * 24 * 3600; // 30d
const RATE_WINDOW_MS = 60_000;
// 优雅停止的有限兜底：MCP/SSE/keep-alive 连接可能一直不主动断开。
// 先收 MCP sessions 与连接，再等 listener；最坏情况下整体不超过该值。
const CLOSE_TIMEOUT_MS = 5_000;
const SESSION_CLOSE_TIMEOUT_MS = 1_000;

/** 等待 promise 落定，最多 ms；用于关闭流程里不阻塞后续步骤。 */
function settleWithin(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(finish, Math.max(0, ms));
    Promise.resolve(promise).then(finish, finish);
  });
}

// /healthz、/app/embed/info 与 <home>/runtime.json 共用的对外版本号与 embed 协议版本。
// APP_VERSION 的唯一真源是 ./version.mjs；不要在 buildEmbedInfo / runtime 写入处再写字面量。
export const EMBED_PROTOCOL = 1;

// ---------- 控制台静态托管（D1） ----------
// 路径白名单：只认识这几个确切文件名，天然防目录穿越。允许 MEBULAR_CONSOLE_DIR 覆盖。
const DEFAULT_ASSET_ROOTS = resolveStaticAssetRoots(import.meta.url);
const CONSOLE_DIR = process.env.MEBULAR_CONSOLE_DIR ?? DEFAULT_ASSET_ROOTS.consoleDir;
// locale pack 数据层：唯一注册表 + 每语言目录（只读 JSON）。
// 允许 MEBULAR_LOCALES_DIR 覆盖（桌面打包时 extraResources 落在 <resources>/locales）。
const LOCALES_DIR = process.env.MEBULAR_LOCALES_DIR ?? DEFAULT_ASSET_ROOTS.localesDir;
const LOCALE_CODE_RE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const LOCALE_PACK_FILES = new Set(['console.json', 'desktop.json', 'errors.json']);
const CONSOLE_FILES = {
  'index.html': 'text/html; charset=utf-8',
  'shell-boot.js': 'text/javascript; charset=utf-8', // 走查修复 B：壳安全区首帧引导脚本
  'console.css': 'text/css; charset=utf-8',
  'console.js': 'text/javascript; charset=utf-8',
  'host.js': 'text/javascript; charset=utf-8',
  'dropdown.mjs': 'text/javascript; charset=utf-8',
  'assistants.js': 'text/javascript; charset=utf-8',
  'assistant-status.js': 'text/javascript; charset=utf-8',
  'deep-link.js': 'text/javascript; charset=utf-8',
  'settings-ia.js': 'text/javascript; charset=utf-8',
  'i18n.mjs': 'text/javascript; charset=utf-8',
  'starfield.js': 'text/javascript; charset=utf-8',
  'wizard.js': 'text/javascript; charset=utf-8',
  'nebula.js': 'text/javascript; charset=utf-8',
  'stars.js': 'text/javascript; charset=utf-8',
};

// CSRF：页面加载签发（SameSite=Strict cookie + 响应头），写请求要求头与 cookie 双提交且 token 在签发集合内。
const CSRF_COOKIE = 'mebular_csrf';
const CSRF_TTL_MS = 12 * 3600_000;
const issuedCsrf = new Map(); // token -> expiresAt

function issueCsrf() {
  const token = randomUUID().replace(/-/g, '');
  issuedCsrf.set(token, Date.now() + CSRF_TTL_MS);
  if (issuedCsrf.size > 512) {
    const now = Date.now();
    for (const [key, exp] of issuedCsrf) if (exp < now) issuedCsrf.delete(key);
  }
  return token;
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function csrfValid(req) {
  const header = req.headers['x-mebular-csrf'];
  const token = typeof header === 'string' ? header : '';
  if (!token || !issuedCsrf.has(token)) return false;
  if ((issuedCsrf.get(token) ?? 0) < Date.now()) {
    issuedCsrf.delete(token);
    return false;
  }
  const cookie = parseCookies(req.headers['cookie'])[CSRF_COOKIE];
  return cookie === token;
}

export function consoleSecurityHeaders(res, { tls = false, embed = false, loopback = false } = {}) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  const frameable = embed === true && loopback === true;
  if (!frameable) res.setHeader('x-frame-options', 'DENY');
  // DSH Web uses a loopback HTTP origin; DSH Desktop's top-level page is
  // `dsh-app://app`. Both are explicit DSH embed hosts; ordinary browser
  // navigation and non-embed requests remain denied.
  const frameAncestors = frameable
    ? 'http://127.0.0.1:* http://localhost:* dsh-app://app'
    : "'none'";
  res.setHeader(
    'content-security-policy',
    `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors ${frameAncestors}`,
  );
  void tls;
}

async function sendConsoleFile(res, file, { embed = false, loopback = false } = {}) {
  const resolved = join(CONSOLE_DIR, file);
  let content;
  try {
    content = await readFile(resolved);
  } catch {
    return sendJson(res, 404, {
      error: 'console_not_found',
      message: `未找到控制台资源 ${file}（${resolved}）。请确认 packages/console 存在，或用 MEBULAR_CONSOLE_DIR 指定。`,
    });
  }
  res.statusCode = 200;
  res.setHeader('content-type', CONSOLE_FILES[file]);
  res.setHeader('cache-control', file === 'index.html' ? 'no-store' : 'no-cache');
  consoleSecurityHeaders(res, { embed, loopback });
  res.end(content);
}

/**
 * Client-usable host for runtime.json. Wildcard binds are reachable on loopback;
 * `localhost` is normalized so the file never depends on resolver behavior.
 * @param {string} host
 */
function runtimeHost(host) {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '::0') return '::1';
  if (host === 'localhost') return '127.0.0.1';
  return host;
}

/** DSH 发现契约：只暴露非敏感信息；非 loopback 明确不提供嵌入。 */
export function buildEmbedInfo({ origin, loopback = false } = {}) {
  const base = String(origin ?? '').replace(/\/+$/, '');
  const canEmbed = loopback === true;
  return {
    ok: true,
    name: 'mebular',
    version: APP_VERSION,
    embedProtocol: EMBED_PROTOCOL,
    consoleUrl: `${base}/console`,
    embedUrl: `${base}/console/?embed=dsh`,
    mcpUrl: `${base}/mcp`,
    loopback: canEmbed,
    capabilities: { embedConsole: canEmbed },
  };
}

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

export function pidAlive(pid) {
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

/**
 * C2：邀请令牌的地址 hints —— 邀请方可达 multiaddr（含 /p2p/<peerId>）+ 可共享 relay seeds + pubReachable。
 * 只影响「候选地址簿」，与授权/成员判定无关。缺节点（网络未启用）时返回空 hints（令牌与旧格式等价）。
 */
function collectInviteHints(app, config) {
  const node = app?.node;
  const addrs = node && typeof node.getLocalMultiaddrs === 'function' ? node.getLocalMultiaddrs() ?? [] : [];
  const peerId = node?.peerId?.id ?? null;
  const endpoints = [];
  for (const addr of addrs) {
    if (typeof addr !== 'string' || addr.includes('/p2p-circuit')) continue;
    const withPeer = /\/p2p\//.test(addr) || !peerId ? addr : `${addr}/p2p/${peerId}`;
    if (!endpoints.includes(withPeer)) endpoints.push(withPeer);
  }
  const relaySeeds = Array.isArray(config?.network?.relaySeeds)
    ? config.network.relaySeeds.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : [];
  return {
    ...(endpoints.length > 0 ? { endpoints } : {}),
    ...(relaySeeds.length > 0 ? { relaySeeds } : {}),
    ...(endpoints.length > 0 ? { pubReachable: endpoints.some((addr) => !isLoopbackMultiaddr(addr)) } : {}),
  };
}

/** 地址是否为回环（pubReachable 提示用）。 */
function isLoopbackMultiaddr(address) {
  const host = /\/(?:ip4|ip6|dns4|dns6|dns)\/([^/]+)/.exec(String(address))?.[1] ?? '';
  return ['127.0.0.1', '::1', 'localhost', ''].includes(host) || host.startsWith('127.');
}

// ---------- 安全三档（S2）：写端点门禁 + 安全后端端点 ----------
//
// S1 未合并时 `getSecurityTier()` 缺失 → fleet security 模块按 low 处理（不炸、不放宽）。
// 本文件的 `securityWriteGate` 只做**本机程序门槛**；权威采纳（会签/恢复码）在 core 推导。
let fleetSecurityPromise = null;

/** 延迟加载 @mebular/fleet 安全模块（测试/未构建时返回 null，门禁按 low 放行）。 */
export function loadFleetSecurity() {
  if (fleetSecurityPromise === null) {
    fleetSecurityPromise = import('../../fleet/dist/index.js').catch(() => null);
  }
  return fleetSecurityPromise;
}

/**
 * 写端点门禁：medium 要动态码；high 要会签批准/恢复码；low 放行。
 * 导出供 S2-3 单测直接断言（HTTP 层同样走这里）。
 */
export async function securityWriteGate({ app, home, path, input = {}, namespace = 'tasks' }) {
  const lib = await loadFleetSecurity();
  if (!lib || typeof lib.evaluateSecurityGate !== 'function') return { ok: true };
  let action = null;
  let subject;
  let level;
  if (path === '/admin/api/invite') {
    action = 'invite';
  } else if (/^\/admin\/api\/devices\/[^/]+\/revoke$/.test(path)) {
    action = 'revoke';
    subject = decodeURIComponent(path.split('/')[4] ?? '');
  } else if (path === '/admin/api/security/tier') {
    action = 'tier';
    level = typeof input.level === 'string' ? input.level : undefined;
  }
  if (action === null) return { ok: true };
  // S4：恢复码不是预签证明，必须由端点 derive + sign 后才落盘。
  // 这里只放行 revoke/tier 的 recoveryCode 请求；档位/当前 keyId 的权威校验在端点内完成，
  // 避免在门禁里提前消费一次性 nonce，也避免把码写进任何错误路径。
  const recoveryCode = typeof input.recoveryCode === 'string' ? input.recoveryCode.trim() : '';
  if (recoveryCode.length > 0 && (action === 'revoke' || action === 'tier')) return { ok: true };
  return lib.evaluateSecurityGate(app, home, {
    action,
    ...(typeof input.code === 'string' ? { code: input.code } : {}),
    ...(input.cosign !== undefined ? { cosign: input.cosign } : {}),
    ...(input.breakGlass !== undefined ? { breakGlass: input.breakGlass } : {}),
    ...(typeof input.approvalId === 'string' ? { approvalId: input.approvalId } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(level !== undefined ? { level } : {}),
    namespace: typeof input.namespace === 'string' && input.namespace.length > 0 ? input.namespace : namespace,
  });
}

/**
 * S4：恢复码代签（服务端 derive → 对齐当刻 keyId → signBreakGlass）。
 * 仅高档可用；返回证明供 writeDeviceRevoke / writeSecurityTier 落盘。
 * 本函数及调用方都不得记录/回显 code（只在内存里派生私钥）。
 */
async function signRecoveryProof({ lib, app, code, op, subject, level, initiator }) {
  const state = await lib.readSecurityState(app);
  if (state.level !== 'high') {
    return {
      ok: false,
      status: 409,
      error: 'recovery_not_applicable',
      message: `当前不是高档（${state.level}）：恢复码只用于替代高档会签，无需输入。`,
    };
  }
  // 以 core 的当刻派生为准（getSecurityTier().recoveryKeyId）：不在服务端另建登记口径。
  const currentKeyId = state.recoveryKeyId;
  if (currentKeyId === undefined) {
    return {
      ok: false,
      status: 409,
      error: 'recovery_missing',
      message: '尚未生成恢复码：请先在安全卡生成/轮换恢复码。',
    };
  }
  let derived;
  try {
    derived = lib.deriveRecoveryKey(code);
  } catch {
    return {
      ok: false,
      status: 400,
      error: 'recovery_invalid',
      message: '恢复码格式不正确：请完整输入 34 位（连字符可省略）。',
    };
  }
  if (derived.keyId !== currentKeyId) {
    return {
      ok: false,
      status: 403,
      error: 'recovery_mismatch',
      message: '恢复码不匹配当前 keyId（可能已被轮换）：请使用最新恢复码。',
    };
  }
  const signed = lib.signBreakGlass({
    code,
    op,
    initiator,
    ...(subject !== undefined ? { subject } : {}),
    ...(level !== undefined ? { level } : {}),
  });
  const verified = lib.verifyBreakGlassProof(signed.proof, {
    publicKeyHex: derived.publicKeyHex,
    expectedDigest: signed.digest,
    currentKeyId,
  });
  if (!verified.ok) {
    return {
      ok: false,
      status: 500,
      error: 'recovery_sign_failed',
      message: '恢复码签名校验失败：请重试；若持续失败请轮换恢复码。',
    };
  }
  return { ok: true, proof: signed.proof, digest: signed.digest, nonce: signed.nonce };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(body);
}

/** 持久化运行期订阅集（热生效；空 = 订阅全部，删除显式键）。 */
async function persistSubscriptionNamespaces(home, next) {
  const cfgFile = configPath(home);
  let current = {};
  try {
    current = JSON.parse(await readFile(cfgFile, 'utf-8'));
  } catch {
    current = {};
  }
  const merged = JSON.parse(JSON.stringify(current));
  if (next.length === 0) delete merged.sync?.namespaces;
  else {
    merged.sync = merged.sync && typeof merged.sync === 'object' ? merged.sync : {};
    merged.sync.namespaces = next;
  }
  const tmp = `${cfgFile}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  if (existsSync(cfgFile)) await copyFile(cfgFile, `${cfgFile}.bak`);
  await rename(tmp, cfgFile);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 请求体所需 scope（可多条；记忆与任务两轴互不蕴含）。 */
function requiredScopeForBody(body) {
  let messages;
  try {
    const parsed = JSON.parse(body.toString('utf-8'));
    messages = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return ['memory.read'];
  }
  const required = new Set();
  for (const msg of messages) {
    if (!msg || typeof msg.method !== 'string') continue;
    if (msg.method === 'initialize' || msg.method.startsWith('notifications/') || msg.method === 'ping') continue;
    if (msg.method === 'tools/call') {
      required.add(TOOL_ALL_SCOPES[msg.params?.name] ?? 'memory.read');
    } else if (msg.method === 'prompts/list' || msg.method === 'prompts/get'
      || msg.method === 'resources/list' || msg.method === 'resources/read' || msg.method === 'resources/templates/list') {
      // 评审：prompts/resources 按声明 scope 校验（静态 memory_policy 属读面）；不得随纯元数据放宽
      required.add('memory.read');
    }
    // 纯元数据（tools/list、initialize、ping、notifications/*）：只要求已认证
    // —— 统一入口的工具清单横跨记忆与任务两轴，按 memory.read 要求会挡住 task.read-only 令牌。
  }
  return [...required];
}

/** 授权是否覆盖所需 scope（按轴蕴含：memory.admin ⊇ memory.write ⊇ memory.read；task.write ⊇ task.read）。 */
function hasScope(granted, required) {
  const list = Array.isArray(required) ? required : [required];
  const grantedList = granted ?? [];
  return list.every((req) => grantedList.some((s) => (SCOPE_IMPLIES[s] ?? []).includes(req)));
}

/**
 * 启动 HTTP MCP server。
 * @returns {Promise<{ server: import('node:http').Server, host: string, port: number, auth: string, close: () => Promise<void> }>}
 */
export async function startHttpServer({
  home,
  app: initialApp = null,
  service: initialService = null,
  config: initialConfig = {},
  buildServer,
  host = '127.0.0.1',
  port = 7331,
  auth = 'none',
  tls = false,
  tlsKey,
  tlsCert,
  tokensFile,
  deviceId: initialDeviceId = null,
  namespace: initialNamespace = 'tasks',
  joinEndpoint: initialJoinEndpoint,
  // 生效运行时快照（console 设置卡展示用；含 CLI/env 覆盖后的实际值）
  runtime: initialRuntime = null,
  // D1 只读；D2 打开写端点（仍需 memory.admin scope + CSRF）
  writesEnabled: initialWritesEnabled = false,
  // C：一键重启执行器（可注入；verify:config 用 MEBULAR_RESTART_DRY_RUN 或注入替身）
  restartRunner = null,
  // 引导态（空家目录）：只服务 /healthz + /console 引导页 + /app/provision/*；其余 409 provision_required
  provision: initialProvision = false,
  // P1：同一进程内热初始化。返回新的运行时上下文；成功后本 server 从 UNINITIALIZED → READY。
  initializeRuntime = null,
  // 关闭钩子：热初始化后由 server.mjs 关闭 app / join / 广播计时器（HTTP server 本身由本函数关闭）
  onClose = null,
}) {
  // P1：生命周期状态。所有路由共用**可变**上下文；create/join 成功后就地切换，不重启进程 / 端口。
  let app = initialApp;
  let service = initialService;
  let config = initialConfig ?? {};
  let runtime = initialRuntime;
  let deviceId = initialDeviceId;
  let namespace = initialNamespace;
  let joinEndpoint = initialJoinEndpoint;
  let writesEnabled = initialWritesEnabled;
  let phase = initialProvision ? 'UNINITIALIZED' : 'READY';
  let hotInitialized = false;
  let activeLock = null;
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

  // 邀请 nonce 状态与 join 服务共用同一 storagePath（生成新令牌时撤销旧 active）。
  const computeJoinStateStoragePath = () => (typeof runtime?.storagePath === 'string'
    ? runtime.storagePath
    : typeof config?.storagePath === 'string' ? config.storagePath : join(home, 'store.jsonl'));
  let joinStateStoragePath = computeJoinStateStoragePath();

  // 忆云档案上下文（root 解析 + 单活）。自定义 home / 危险 env → available:false（档案端点 503/403）。
  const cloud = resolveCloudRoot({ home, env: process.env });
  let cloudId = app && service && cloud.available
    ? await profileIdForHome(cloud.root, home).catch(() => null)
    : null;

  /** 热初始化成功后把路由可见的上下文整体切换；失败时调用方负责回滚文件并保持 UNINITIALIZED。 */
  async function activateRuntime(next, { viaHotInit = false } = {}) {
    if (!next?.app || !next?.service) throw new Error('初始化结果缺少 app/service');
    app = next.app;
    service = next.service;
    config = next.config ?? {};
    runtime = next.runtime ?? null;
    deviceId = next.deviceId ?? null;
    namespace = next.namespace ?? 'tasks';
    joinEndpoint = next.joinEndpoint;
    if (next.writesEnabled !== undefined) writesEnabled = Boolean(next.writesEnabled);
    if (next.activeLock) activeLock = next.activeLock;
    joinStateStoragePath = computeJoinStateStoragePath();
    cloudId = cloud.available ? await profileIdForHome(cloud.root, home).catch(() => null) : null;
    phase = 'READY';
    if (viaHotInit) hotInitialized = true;
    return { phase, cloudId };
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

  // W3：**多会话** transport（每个 `mcp-session-id` 一条；CLI 每次调用可各自 initialize）。
  // 无 session 头的请求（如 CLI initialize）新建会话；会话经 `onsessioninitialized` 登记，关闭时回收。
  //
  // P2：UNINITIALIZED 也允许 /mcp 完成 initialize / list；server 先持有惰性 service 代理，
  // 热初始化后同一会话内的 tools/call 直接转发到真实 MemoryService（不重连、不重新 initialize）。
  const runtimeReady = () => phase === 'READY' && Boolean(service);
  const serviceFacade = createServiceFacade({ getService: () => service, isReady: runtimeReady });

  // 0.3 Runtime：设备级服务层（G0/G1 只读 status + mode 切换）。
  // app 热初始化后切换实例；本地 Raw/Trace 固定落在 <home>/runtime。
  let runtimeService = null;
  let runtimeServiceApp = null;
  const getRuntimeService = () => {
    if (!app) return null;
    if (runtimeServiceApp !== app) {
      runtimeService = buildRuntimeService({
        app,
        config,
        home,
        version: APP_VERSION,
        hostKey: homeKey(home),
        profileId: cloudId,
      });
      runtimeServiceApp = app;
    }
    return runtimeService;
  };
  const runtimeHttpHandler = createRuntimeHttpHandler({
    getService: getRuntimeService,
    getConfig: () => config,
    onModeChanged: (mode) => {
      const next = config && typeof config === 'object' ? config : {};
      const current = next.runtime && typeof next.runtime === 'object' && !Array.isArray(next.runtime)
        ? next.runtime
        : {};
      next.runtime = { ...current, mode };
      config = next;
    },
    home,
    authenticate,
    sendJson,
    origin: () => origin,
    csrfValid,
  });

  const mcpSessions = new Map(); // sessionId → { transport, server }
  async function transportFor(sessionId) {
    if (sessionId) return mcpSessions.get(sessionId)?.transport ?? null;
    const server = buildServer(serviceFacade, {
      isReady: runtimeReady,
      // 任务工具复用**当前** live app（热初始化后 app 会切换，故用 getter）：同一 EventLog 才会触发
      // 本地 append / push-on-write / fleet SSE，而不是另开一个离线实例写同一份库。
      toolContext: () => ({ home, ...(app ? { mebular: app } : {}) }),
    });
    const entry = { transport: null, server };
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        entry.transport = transport;
        mcpSessions.set(id, entry);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) mcpSessions.delete(id);
      void server.close().catch(() => undefined);
    };
    entry.transport = transport;
    await server.connect(transport);
    return transport;
  }

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
      const need = Array.isArray(required) ? required.join(' ') : required;
      return { ok: false, status: 403, message: `insufficient scope: need ${need}`, challenge: `Bearer error="insufficient_scope", scope="${need}"`, tokenId: grant.tokenId };
    }
    return { ok: true, tokenId: grant.tokenId, scopes: grant.scopes };
  }

  /**
   * /mcp：UNINITIALIZED 与 READY 共用同一条路径（loopback + 现有 auth 语义）。
   * 未初始化时由 service facade + registerTools 的 readiness guard 返回业务错误，
   * 传输层本身仍正常完成 initialize / tools/list / prompts/list。
   */
  async function handleMcp(req, res, body) {
    const check = await authenticate(req, body);
    if (!check.ok) {
      res.statusCode = check.status;
      if (check.challenge) res.setHeader('www-authenticate', check.challenge);
      return sendJson(res, check.status, { jsonrpc: '2.0', error: { code: -32001, message: check.message }, id: null });
    }
    const sessionId = req.headers['mcp-session-id'];
    const transport = await transportFor(typeof sessionId === 'string' ? sessionId : undefined);
    if (!transport) {
      return sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'unknown session' }, id: null });
    }
    const webRequest = toWebRequest(req, body, origin);
    const response = await transport.handleRequest(webRequest);
    return writeWebResponse(res, response);
  }

  // ---------- 控制台路由（D1 只读 + 写端点 CSRF/scope 门） ----------

  function setCsrfCookie(res, token) {
    const attrs = [`${CSRF_COOKIE}=${token}`, 'Path=/', 'SameSite=Strict', `Max-Age=${Math.floor(CSRF_TTL_MS / 1000)}`];
    if (tls) attrs.push('Secure');
    res.setHeader('set-cookie', attrs.join('; '));
  }

  async function handleConsole(req, res, url) {
    const path = url.pathname;
    const embed = url.searchParams.get('embed') === 'dsh';
    // 目录语义：无尾斜杠时补一个，保证 HTML 内相对资源（./console.css 等）解析到 /console/ 下
    if (path === '/console') {
      res.statusCode = 308;
      res.setHeader('location', `/console/${url.search}`);
      return res.end();
    }
    if (path === '/console/' || path === '/console/index.html') {
      const token = issueCsrf();
      setCsrfCookie(res, token);
      res.setHeader('x-mebular-csrf', token);
      return sendConsoleFile(res, 'index.html', { embed, loopback: isLoopback });
    }
    if (path.startsWith('/console/')) {
      const file = path.slice('/console/'.length);
      if (Object.prototype.hasOwnProperty.call(CONSOLE_FILES, file)) {
        return sendConsoleFile(res, file, { embed, loopback: isLoopback });
      }
      return sendJson(res, 404, { error: 'console_not_found', path });
    }
    return sendJson(res, 404, { error: 'not_found', path });
  }

  /**
   * /locales/*：只读 locale pack 数据层。
   * 白名单：manifest.json 或 <locale>/<console|desktop|errors>.json；只允许 JSON 扩展名。
   * 目录内 realpath 校验，拒绝 traversal / 符号链接逃逸。
   */
  async function handleLocales(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }
    let relative;
    try {
      relative = decodeURIComponent(url.pathname.slice('/locales/'.length));
    } catch {
      return sendJson(res, 404, { error: 'locale_not_found', path: url.pathname });
    }
    if (!relative || relative.includes('\0') || relative.includes('\\')) {
      return sendJson(res, 404, { error: 'locale_not_found', path: url.pathname });
    }
    const parts = relative.split('/');
    const valid = relative === 'manifest.json'
      || (parts.length === 2 && LOCALE_CODE_RE.test(parts[0]) && LOCALE_PACK_FILES.has(parts[1]));
    if (!valid) return sendJson(res, 404, { error: 'locale_not_found', path: url.pathname });

    let root;
    let resolved;
    try {
      root = realpathSync(LOCALES_DIR);
      resolved = realpathSync(join(root, relative));
    } catch {
      return sendJson(res, 404, { error: 'locale_not_found', path: url.pathname });
    }
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
      return sendJson(res, 404, { error: 'locale_not_found', path: url.pathname });
    }
    let content;
    try {
      content = await readFile(resolved);
    } catch {
      return sendJson(res, 404, { error: 'locale_not_found', path: url.pathname });
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    consoleSecurityHeaders(res);
    res.end(content);
  }

  async function handleSecurityRead(req, res) {
    if (!app || !service) {
      return sendJson(res, 503, { error: 'console_unavailable', message: 'Mebular 尚未初始化' });
    }
    const check = await authenticate(req, Buffer.alloc(0), 'memory.read');
    if (!check.ok) {
      res.statusCode = check.status;
      if (check.challenge) res.setHeader('www-authenticate', check.challenge);
      return sendJson(res, check.status, { error: 'unauthorized', message: check.message });
    }
    const lib = await loadFleetSecurity();
    if (!lib) {
      return sendJson(res, 200, {
        ok: true,
        level: 'low',
        admitted: [],
        rejections: [],
        coreTierAvailable: false,
        totp: { imported: false, failures: 0, lockedUntil: 0, backoffUntil: 0, lastAcceptedAt: 0 },
        recovery: { registered: false },
        pendingApprovals: [],
        recentApprovals: [],
      });
    }
    const state = await lib.readSecurityState(app);
    const events = await lib.listPolicyEvents(app);
    const registry = lib.collectRecoveryRegistry(events);
    const latest = lib.latestRecoveryRecord(events);
    const totp = await lib.readTotpStatus(home).catch(() => ({
      imported: false, failures: 0, lockedUntil: 0, backoffUntil: 0, lastAcceptedAt: 0,
    }));
    return sendJson(res, 200, {
      ok: true,
      ...state,
      totp,
      recovery: latest === null
        ? { registered: false }
        : {
            registered: true,
            keyId: latest.keyId,
            mode: latest.mode,
            createdAt: latest.createdAt,
            lastUsedAt: registry.lastUsedAt ?? null,
            current: registry.currentKeyId === latest.keyId,
          },
      pendingApprovals: lib.pendingApprovals(events),
      recentApprovals: lib.approvalsFromEvents(events).slice(-50),
    });
  }

  async function handleAdminRead(req, res, path, url) {
    const builder = READ_ROUTES[path];
    if (!builder) return false;
    // P2：助手列表只读本机配置，UNINITIALIZED 也开放；其余 admin 读数据面仍需 READY。
    if ((!app || !service) && path !== '/admin/api/clients') {
      return sendJson(res, 503, { error: 'console_unavailable', message: 'Mebular 尚未初始化' });
    }
    const check = await authenticate(req, Buffer.alloc(0), 'memory.read');
    if (!check.ok) {
      res.statusCode = check.status;
      if (check.challenge) res.setHeader('www-authenticate', check.challenge);
      return sendJson(res, check.status, { error: 'unauthorized', message: check.message });
    }
    // 注意：CSRF token 只在 /console/ 页面加载时签发。若在 overview 轮询里重新签发，
    // cookie 会被每次轮询改写，与并发的写请求竞争（读 cookie 后、发出写之前又来一次
    // overview）→ header 与 cookie 不一致而 403。token 12h 有效，页面加载签发一次即可。
    let payload;
    try {
      payload = await builder({ app, service, config, runtime, home, url, cloud });
    } catch (error) {
      if (error?.code === 'CLOUD_UNAVAILABLE') {
        return sendJson(res, 503, { ok: false, error: 'CLOUD_UNAVAILABLE', message: error.message, reason: error.reason ?? null });
      }
      if (error?.code === 'CLOUD_REGISTRY_INVALID') {
        return sendJson(res, 500, { ok: false, error: 'CLOUD_REGISTRY_INVALID', message: error.message });
      }
      if (error?.code === 'CLOUD_REGISTRY_LOCKED') {
        return sendJson(res, 503, { ok: false, error: 'CLOUD_REGISTRY_LOCKED', message: error.message });
      }
      throw error;
    }
    if (path === '/admin/api/overview') {
      payload.features = { writes: Boolean(writesEnabled) };
    }
    return sendJson(res, 200, payload);
  }

  // ---------- /admin/events（SSE：状态与同步实时脉冲） ----------

  async function handleAdminEvents(req, res, url) {
    if (phase !== 'READY') {
      return sendJson(res, 409, { error: 'provision_required', provision: true, phase, message: '实例尚未初始化：请先在控制台完成「建新 / 加入」' });
    }
    if (!app || !service) {
      return sendJson(res, 503, { error: 'console_unavailable', message: 'Mebular 尚未初始化' });
    }
    if (auth !== 'none' && !req.headers['authorization']) {
      const token = url.searchParams.get('token');
      if (token) req.headers.authorization = `Bearer ${token}`;
    }
    const check = await authenticate(req, Buffer.alloc(0), 'memory.read');
    if (!check.ok) {
      res.statusCode = check.status;
      if (check.challenge) res.setHeader('www-authenticate', check.challenge);
      return sendJson(res, check.status, { error: 'unauthorized', message: check.message });
    }
    // 任务域在写响应头前解析，避免 hello 之后到监听接入之间漏掉短暂窗口内的事件。
    const fleetNamespace = await resolveFleetNamespace({ home, fallback: namespace });
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event, data) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // 连接已断开
      }
    };
    send('hello', { at: Date.now() });

    // fleet：真实任务 `created` 事件 → 控制台实时绘制航道/舰队（只读广播；契约见 fleet-events.mjs）。
    // 本地 append 与远端同步应用（events-applied）都接入；清理时统一移除监听。
    let detachFleet = null;
    try {
      detachFleet = attachFleetEvents({
        eventLog: app.eventLog,
        sync: app.sync,
        namespace: fleetNamespace,
        send,
      });
    } catch {
      // 任务面不可用时不影响其余 SSE 事件
      detachFleet = null;
    }

    const onSync = (result) => send('sync', {
      at: Date.now(),
      peerDeviceId: result?.peerDeviceId,
      sentEvents: result?.sentEvents,
      receivedEvents: result?.receivedEvents,
      // P3/SP-29：显式信号接线（诊断字段；缺省不发送）
      ...(result?.reportedAhead !== undefined ? { reportedAhead: result.reportedAhead } : {}),
      ...(result?.denied !== undefined ? { denied: result.denied } : {}),
      ...(result?.subscriptionRejected !== undefined ? { subscriptionRejected: result.subscriptionRejected } : {}),
      ...(result?.ackedOutgoing !== undefined ? { ackedOutgoing: result.ackedOutgoing } : {}),
      ...(result?.watermarkDownCorrections !== undefined ? { watermarkDownCorrections: result.watermarkDownCorrections } : {}),
      ...(result?.unknownEventTypes !== undefined ? { unknownEventTypes: result.unknownEventTypes } : {}),
    });
    const onFail = (payload) => send('sync-failed', {
      at: Date.now(),
      message: String(payload?.error?.message ?? payload?.error ?? ''),
    });
    // P3：收敛状态翻转（每对端）→ 控制台即时刷新（只读；状态本体走 /admin/api/devices）
    let offConvergence = null;
    try {
      offConvergence = typeof app.onConvergence === 'function'
        ? app.onConvergence((transition) => send('convergence', {
            at: Date.now(),
            peerDeviceId: transition?.peerDeviceId,
            from: transition?.from,
            to: transition?.to,
            reasons: transition?.reasons,
          }))
        : null;
    } catch {
      offConvergence = null;
    }
    try {
      app.sync.on('sync-completed', onSync);
      app.sync.on('sync-failed', onFail);
    } catch {
      // 门面未初始化时 sync 不可访问
    }

    let closed = false;
    const emitStatus = async () => {
      if (closed) return;
      try {
        const status = await service.status();
        send('status', {
          at: Date.now(),
          running: status.running,
          nodeCount: status.nodeCount,
          pendingEventCount: status.pendingEventCount,
          peerId: status.peerId,
        });
      } catch {
        // 保活失败忽略
      }
    };
    await emitStatus();
    const timer = setInterval(emitStatus, 2500);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try {
        app.sync.off('sync-completed', onSync);
        app.sync.off('sync-failed', onFail);
      } catch {
        // ignore
      }
      try { offConvergence?.(); } catch { /* ignore */ }
      try { detachFleet?.(); } catch { /* ignore */ }
      try { res.end(); } catch { /* ignore */ }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return undefined;
  }

  const WRITE_PATTERNS = [
    /^\/admin\/api\/clouds\/(join|rename|inspect)$/,
    /^\/admin\/api\/subscriptions$/,
    /^\/admin\/api\/namespaces$/,
    /^\/admin\/api\/devices\/self\/name$/,
    /^\/admin\/api\/devices\/([^/]+)\/(revoke|restore|connect|disconnect|sync|reset-watermarks)$/,
    /^\/admin\/api\/config$/,
    /^\/admin\/api\/restart$/,
    /^\/admin\/api\/memories\/([^/]+)\/(archive|unarchive|delete)$/,
    /^\/admin\/api\/invite$/,
    /^\/admin\/api\/security\/tier$/,
    /^\/admin\/api\/security\/approvals$/,
    /^\/admin\/api\/security\/approvals\/([^/]+)\/(approve|deny)$/,
    /^\/admin\/api\/security\/totp\/(show|import)$/,
    /^\/admin\/api\/security\/recovery\/(generate|rotate)$/,
    /^\/admin\/api\/namespaces\/([^/]+)\/(rejoin|leave)$/,
    /^\/admin\/api\/service\/(install|uninstall)$/,
    /^\/admin\/api\/repair$/,
    /^\/admin\/api\/clients\/([^/]+)\/(connect|rollback|skills|preview|verify|recheck)$/,
    /^\/admin\/api\/assistants$/,
    /^\/admin\/api\/assistants\/([^/]+)$/,
    /^\/admin\/api\/assistants\/([^/]+)\/remove$/,
  ];

  // P2：UNINITIALIZED 仅开放本机助手配置所需的读写动作（列表 / 预览 / 接入 / 验证 / 重探）。
  // 不暴露 memory/network/admin 数据面；写端点仍走 handleAdminWrite 的 Origin + CSRF + scope 门。
  const UNINITIALIZED_CLIENT_ACTION = /^\/admin\/api\/clients\/([^/]+)\/(connect|preview|verify|recheck)$/;

  function parseJsonBody(body) {
    try {
      const parsed = JSON.parse(body?.toString('utf-8') || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return null;
    }
  }

  // ---------- 忆云档案端点（A：控制台准备；App/CLI 负责真正的停旧/起新） ----------

  const publicProfile = (profile, currentId = null) => ({
    id: profile.id,
    name: profile.name,
    home: profile.home,
    kind: profile.kind,
    createdAt: profile.createdAt ?? null,
    lastUsedAt: profile.lastUsedAt ?? null,
    nameUpdatedAt: profile.nameUpdatedAt ?? null,
    masterFingerprint: profile.masterFingerprint ?? null,
    deviceId: profile.deviceId ?? null,
    ...(currentId !== null ? { current: profile.id === currentId } : {}),
  });

  const scrubToken = (value, token) => (
    typeof token === 'string' && token.length > 0 ? String(value).split(token).join('[redacted]') : String(value)
  );

  function sendCloudError(res, error, { disabled = false } = {}) {
    const code = error?.code ?? 'CLOUD_FAILED';
    const status = {
      CONFIRMATION_REQUIRED: 400,
      TOKEN_REQUIRED: 400,
      TOKEN_INVALID: 400,
      TOKEN_EXPIRED: 400,
      TOKEN_REJECTED: 400,
      INVALID_NAME: 400,
      NAME_TAKEN: 400,
      CLOUD_ARCHIVED: 409,
      CLOUD_BLOCKED: 403,
      PROFILE_NOT_FOUND: 404,
      CLOUD_ALREADY_JOINED: 409,
      ALREADY_PROVISIONED: 409,
      ENDPOINT_UNREACHABLE: 502,
      CLOUD_UNAVAILABLE: disabled ? 403 : 503,
      CLOUD_DISABLED: 403,
      CLOUD_REGISTRY_INVALID: 500,
      CLOUD_REGISTRY_LOCKED: 503,
      CLOUD_PROFILE_PATH_INVALID: 500,
      PROFILE_JOIN_FAILED: 500,
    }[code] ?? 500;
    const errorName = disabled && code === 'CLOUD_UNAVAILABLE' ? 'CLOUD_DISABLED' : code;
    return sendJson(res, status, {
      ok: false,
      error: errorName,
      message: error?.message ?? String(error),
      ...(error?.existing !== undefined ? { existing: error.existing } : {}),
      ...(error?.reason !== undefined ? { reason: error.reason } : {}),
    });
  }

  async function decodeCloudToken(token) {
    const fleet = await import('../../fleet/dist/index.js');
    return inspectJoinToken(fleet.decodeJoinToken, token);
  }

  function cloudUnavailableError() {
    return cloudError(
      'CLOUD_DISABLED',
      `当前为自定义 home / 受限 env（${cloud.reason ?? 'unavailable'}）：忆云档案功能不可用`,
      { reason: cloud.reason ?? 'unavailable' },
    );
  }

  const parseListenPort = (configValue) => {
    const listen = configValue?.network?.libp2p?.listen;
    const first = Array.isArray(listen) ? listen.find((entry) => typeof entry === 'string') : null;
    const port = first ? Number(/\/tcp\/(\d+)/.exec(first)?.[1] ?? 0) : 0;
    return Number.isInteger(port) && port > 0 ? port : 0;
  };

  // 当前守护的**实际**监听端口（config 写 0 时也能复用；取不到再回退 config）。
  const currentListenPort = () => {
    try {
      const addrs = app?.node?.getLocalMultiaddrs?.() ?? [];
      for (const addr of addrs) {
        const port = Number(/\/tcp\/(\d+)/.exec(String(addr))?.[1] ?? 0);
        if (Number.isInteger(port) && port > 0) return port;
      }
    } catch {
      // 回退 config
    }
    return parseListenPort(config);
  };

  async function handleCloudInspect(req, res, body) {
    const input = parseJsonBody(body) ?? {};
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (token.length === 0) return sendCloudError(res, cloudError('TOKEN_REQUIRED', '需要加入令牌'));
    let parsed;
    try {
      parsed = await decodeCloudToken(token);
    } catch (error) {
      return sendCloudError(res, error);
    }
    const fingerprint = masterFingerprintFromHex(parsed.masterPublicKey);
    let alreadyJoined = null;
    if (cloud.available && fingerprint !== null) {
      try {
        const state = await readRegistry(cloud.root);
        const duplicate = state.registry.profiles.find((profile) => profile.masterFingerprint === fingerprint);
        if (duplicate) alreadyJoined = { id: duplicate.id, name: duplicate.name };
      } catch {
        // inspect 不因注册表瞬时错误失败
      }
    }
    return sendJson(res, 200, {
      ok: true,
      inviterDeviceId: parsed.inviterDeviceId,
      namespace: parsed.namespace,
      masterFingerprint: fingerprint,
      expiresAt: parsed.expiresAt,
      alreadyJoined,
    });
  }

  async function handleCloudJoin(req, res, body) {
    const input = parseJsonBody(body) ?? {};
    if (input.confirm !== true) {
      return sendCloudError(res, cloudError('CONFIRMATION_REQUIRED', '加入忆云需要显式确认（confirm:true）'));
    }
    if (!cloud.available) return sendCloudError(res, cloudUnavailableError(), { disabled: true });
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (token.length === 0) return sendCloudError(res, cloudError('TOKEN_REQUIRED', '需要加入令牌'));

    let parsed;
    try {
      parsed = await decodeCloudToken(token);
    } catch (error) {
      return sendCloudError(res, error);
    }
    const fingerprint = masterFingerprintFromHex(parsed.masterPublicKey);

    // 指纹重复：不创建目录；返回已有条目，前端提供「切换到它」。
    let state;
    try {
      state = await readRegistry(cloud.root);
    } catch (error) {
      return sendCloudError(res, error, { disabled: true });
    }
    if (fingerprint !== null) {
      const duplicate = state.registry.profiles.find((profile) => profile.masterFingerprint === fingerprint);
      if (duplicate) {
        return sendCloudError(res, cloudError(
          'CLOUD_ALREADY_JOINED',
          `这台设备已加入「${duplicate.name}」，可直接切换`,
          { existing: { id: duplicate.id, name: duplicate.name } },
        ));
      }
    }
    // 名字先校验（不消耗令牌/不建目录）；锁内 registerProfile 仍会再查一次防并发。
    if (input.name !== undefined) {
      let name;
      try {
        name = normalizeProfileName(input.name);
      } catch (error) {
        return sendCloudError(res, error);
      }
      if (state.registry.profiles.some((profile) => profile.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
        return sendCloudError(res, cloudError('NAME_TAKEN', '已有同名忆云，请换一个名字'));
      }
    }

    const profilesDir = join(cloud.root, PROFILES_DIR);
    // profiles/ 已存在时做 realpath containment：防止有人把它 symlink 到 root 外。
    if (existsSync(profilesDir)) {
      try {
        const realProfiles = realpathSync(profilesDir);
        const realRoot = realpathSync(cloud.root);
        if (realProfiles !== realRoot && !realProfiles.startsWith(`${realRoot}${sep}`)) {
          throw cloudError('CLOUD_PROFILE_PATH_INVALID', 'profiles/ 指向 root 之外，拒绝创建忆云目录');
        }
      } catch (error) {
        if (error?.code === 'CLOUD_PROFILE_PATH_INVALID') return sendCloudError(res, error);
        return sendCloudError(res, cloudError(
          'PROFILE_JOIN_FAILED',
          `无法校验忆云目录：${scrubToken(error?.message ?? error, token)}`,
        ));
      }
    }
    try {
      await mkdir(profilesDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      return sendCloudError(res, cloudError(
        'PROFILE_JOIN_FAILED',
        `本机无法创建忆云目录：${scrubToken(error?.message ?? error, token)}`,
      ));
    }
    let id = null;
    let newHome = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let candidate;
      try {
        candidate = newProfileId(state.registry.profiles);
      } catch (error) {
        return sendCloudError(res, cloudError('PROFILE_JOIN_FAILED', error?.message ?? String(error)));
      }
      const candidateHome = join(profilesDir, candidate);
      try {
        await mkdir(candidateHome, { mode: 0o700 });
        id = candidate;
        newHome = candidateHome;
        break;
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        return sendCloudError(res, cloudError(
          'PROFILE_JOIN_FAILED',
          `本机无法创建忆云目录：${scrubToken(error?.message ?? error, token)}`,
        ));
      }
    }
    if (newHome === null) {
      return sendCloudError(res, cloudError('PROFILE_JOIN_FAILED', '无法分配新的忆云目录：请重试'));
    }

    // 标记只含 id/时间/pid（绝不含令牌）；失败时整目录删除（尚未注册）。
    try {
      await writeFile(
        join(newHome, '.provisioning'),
        JSON.stringify({ id, at: new Date().toISOString(), pid: process.pid }),
        { mode: 0o600 },
      );
    } catch (error) {
      await rm(newHome, { recursive: true, force: true }).catch(() => undefined);
      return sendCloudError(res, cloudError(
        'PROFILE_JOIN_FAILED',
        `本机无法写入忆云目录：${scrubToken(error?.message ?? error, token)}`,
      ));
    }

    let registered = false;
    try {
      const mcpPort = runtime?.mcp?.port ?? config?.mcp?.http?.port ?? 7331;
      const joinPort = runtime?.join?.port ?? config?.joinService?.port ?? 4002;
      const listenPort = currentListenPort();
      const result = await provisionJoinInto({
        home: newHome,
        token,
        ports: { mcp: mcpPort, join: joinPort, listen: listenPort },
        rollbackDirectory: true,
        ...(Number.isFinite(input.timeoutMs) ? { timeoutMs: input.timeoutMs } : {}),
      });
      // 校验落盘：config + 委派身份 + 指纹一致（缺失/不一致 → 失败，且整目录删除）
      if (!existsSync(configPath(newHome)) || !existsSync(join(newHome, 'store.jsonl.identity.json'))) {
        throw cloudError('PROFILE_JOIN_FAILED', '新忆云落盘不完整（config/身份缺失），已回滚');
      }
      if (fingerprint !== null && result.fingerprint !== null && result.fingerprint !== fingerprint) {
        throw cloudError('PROFILE_JOIN_FAILED', '新忆云主公钥指纹与令牌不一致，已回滚');
      }

      const registeredResult = await registerProfile(cloud.root, {
        id,
        name: input.name,
        kind: 'delegated',
        masterFingerprint: fingerprint ?? result.fingerprint ?? null,
        deviceId: result.deviceId,
        createdAt: new Date().toISOString(),
      });
      registered = true;
      const profile = registeredResult.value;
      const current = registeredResult.registry.current;
      await rm(join(newHome, '.provisioning'), { force: true }).catch(() => undefined);
      await writeProvisionRecord(newHome, { ...result, at: new Date().toISOString() }).catch(() => undefined);
      return sendJson(res, 201, {
        ok: true,
        profile: publicProfile(profile),
        current,
        switch: { required: true, command: `mebular cloud use ${profile.id}` },
      });
    } catch (error) {
      if (!registered) await rm(newHome, { recursive: true, force: true }).catch(() => undefined);
      const known = new Set([
        'CONFIRMATION_REQUIRED', 'TOKEN_REQUIRED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'TOKEN_REJECTED',
        'ENDPOINT_UNREACHABLE', 'CLOUD_ALREADY_JOINED', 'INVALID_NAME', 'NAME_TAKEN', 'PROFILE_EXISTS',
        'INVALID_PROFILE_ID', 'PROFILE_JOIN_FAILED', 'CLOUD_DISABLED', 'CLOUD_UNAVAILABLE',
        'CLOUD_REGISTRY_INVALID', 'CLOUD_REGISTRY_LOCKED', 'CLOUD_PROFILE_PATH_INVALID',
      ]);
      const wrapped = known.has(error?.code)
        ? error
        : cloudError('PROFILE_JOIN_FAILED', scrubToken(error?.message ?? error, token));
      // 走到这里时令牌可能已在邀请方处兑换（兑换后本机写失败）——文案必须说明需重新生成。
      if (['PROFILE_JOIN_FAILED', 'CLOUD_REGISTRY_LOCKED', 'CLOUD_REGISTRY_INVALID'].includes(wrapped.code)) {
        wrapped.message = `${wrapped.message}（令牌可能已在对方处兑换；请让邀请方重新生成）`;
      }
      return sendCloudError(res, wrapped, { disabled: true });
    }
  }

  async function handleCloudRename(req, res, body) {
    if (!cloud.available) return sendCloudError(res, cloudUnavailableError(), { disabled: true });
    const input = parseJsonBody(body) ?? {};
    const id = typeof input.id === 'string' ? input.id : '';
    if (id.length === 0) return sendCloudError(res, cloudError('PROFILE_NOT_FOUND', '需要忆云 id'));
    try {
      const state = await readRegistry(cloud.root);
      if (!state.registry.profiles.some((profile) => profile.id === id)) {
        throw cloudError('PROFILE_NOT_FOUND', `未找到忆云：${id}`);
      }
      // 第一版：只有当前忆云能写网络级 `cloud_name`；归档忆云不广播旧名。
      if (id !== state.registry.current) {
        throw cloudError(
          'CLOUD_ARCHIVED',
          '归档忆云不支持网络改名；请先切换到该忆云后再改名',
          { id, current: state.registry.current },
        );
      }
      const name = normalizeProfileName(input.name);
      if (state.registry.profiles.some((profile) => profile.id !== id
        && String(profile.name).trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw cloudError('NAME_TAKEN', '已有同名忆云，请换一个名字');
      }
      const blocked = await app.getBlockedDevices();
      if (blocked.includes(app.deviceId)) {
        throw cloudError('CLOUD_BLOCKED', '本机已被移出当前忆云，不能改名');
      }
      // 先写网络事件，再更新本机 registry 缓存；失败时 registry 不变（fallback 仍可用）。
      const event = await app.setCloudName({ name });
      const result = await renameProfile(cloud.root, id, name);
      let derived = null;
      try {
        derived = await app.getCloudName();
      } catch {
        derived = null;
      }
      return sendJson(res, 200, {
        ok: true,
        profile: publicProfile(result.value, result.registry.current),
        cloud: {
          id,
          name,
          nameSource: 'network',
          nameUpdatedAt: result.value.nameUpdatedAt ?? null,
          eventId: event.id,
        },
        derived: derived ?? null,
      });
    } catch (error) {
      return sendCloudError(res, error, { disabled: true });
    }
  }

  /** 按会话证书把 deviceId 映射到在线连接；找不到返回 null */
  function findConnectionByDevice(deviceId) {
    const node = app?.node;
    if (!node || !node.isRunning()) return null;
    for (const connection of node.getConnectionManager().getConnections()) {
      const session = node.getHandshake().getSession(connection.peerId);
      if (session?.state === 'authenticated' && session.certificate?.deviceId === deviceId) {
        return { connection, session };
      }
    }
    return null;
  }

  // G：保存即生效——同进程防抖窗口内的多次保存合并为一次重启；supervisor 负责健康校验 / 回滚兜底。
  let applyRestartTimer = null;
  let applyPendingFields = new Set();
  let applyPendingPort = null;
  let applyAttempt = 0;

  function scheduleApplyRestart({ fields, port, timeoutMs }) {
    for (const field of fields) applyPendingFields.add(field);
    if (typeof port === 'number' && port > 0) applyPendingPort = port;
    if (applyRestartTimer) return { debounced: true };
    applyRestartTimer = setTimeout(() => {
      applyRestartTimer = null;
      const list = [...applyPendingFields];
      applyPendingFields = new Set();
      const target = applyPendingPort;
      applyPendingPort = null;
      void performApplyRestart(list, target, timeoutMs).catch(() => undefined);
    }, RESTART_DEBOUNCE_MS);
    applyRestartTimer.unref?.();
    return { debounced: false };
  }

  async function performApplyRestart(fields, port, timeoutMs) {
    applyAttempt += 1;
    const attempt = applyAttempt;
    await writeApplyPending(home, {
      attempt,
      at: new Date().toISOString(),
      fields,
      attempts: 1,
      port: port ?? null,
      oldPid: process.pid,
    });
    // 先起监督进程（它等旧进程退出 → 校验新实例健康 → 不健康则回滚），再触发重启
    const supervisorPath = join(dirname(fileURLToPath(import.meta.url)), 'apply-supervisor.mjs');
    spawnSupervisor({
      supervisorPath,
      args: [
        '--home', home,
        '--config', configPath(home),
        '--old-pid', String(process.pid),
        '--port', String(port ?? 0),
        '--fields', fields.join(','),
        ...(timeoutMs ? ['--timeout', String(timeoutMs)] : []),
      ],
    });
    await runRestart({ home, kind: process.env.MEBULAR_SERVICE_KIND });
  }

  /**
   * 默认重启执行器（C）：由 @mebular/service 读服务计划（launchd/systemd/计划任务），
   * 先返回 202 再**分离式**触发（守护被重启/终止后命令仍能完成）。
   *  - 前台 nohup 运行（无 MEBULAR_SERVICE_KIND）→ registered:false → 接口给手动指引
   *  - MEBULAR_RESTART_DRY_RUN=1 → 只回计划不执行（verify:config 用）
   */
  async function defaultRestartRunner() {
    const kind = process.env.MEBULAR_SERVICE_KIND;
    const cmdOverride = String(process.env.MEBULAR_RESTART_CMD ?? '').trim();
    if (cmdOverride) {
      const dryRun = process.env.MEBULAR_RESTART_DRY_RUN === '1';
      return {
        registered: true,
        command: cmdOverride,
        dryRun,
        trigger: async () => { await runRestart({ home, kind: kind ?? undefined }); },
      };
    }
    if (!kind) {
      return {
        registered: false,
        // R-1 高-4：命令串用真实 home（不写死 ~/.mebular）
        command: `nohup mebular serve > ${home}/serve.log 2>&1 &`,
        manual: `未以服务方式运行（前台 nohup）：请手动重启（nohup mebular serve > ${home}/serve.log 2>&1 &）`,
      };
    }
    let plan;
    try {
      const { planRuntimeServiceRestart, runtimeProviderFromEnv } = await import('./runtime-service.mjs');
      const { resolveServiceHome } = await import('./service-control.mjs');
      plan = await planRuntimeServiceRestart({
        root: cloud.available ? cloud.root : null,
        home,
        serviceHome: resolveServiceHome(),
        fallbackProvider: runtimeProviderFromEnv({ cliPath: process.argv[1] }),
      });
    } catch (error) {
      return { registered: false, manual: `服务管理不可用（${String(error?.message ?? error)}）：请手动重启` };
    }
    const command = plan.commands?.map((entry) => entry.join(' ')).join(' && ') || null;
    if (!plan.registered) return { registered: false, command, manual: plan.manual };
    const dryRun = process.env.MEBULAR_RESTART_DRY_RUN === '1';
    return {
      registered: true,
      command,
      commands: plan.commands,
      dryRun,
      trigger: async () => {
        for (const [cmd, ...args] of plan.commands) {
          const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
          child.unref();
        }
      },
    };
  }

  // P2：UNINITIALIZED 的助手动作——只读写本机助手配置，不触碰 app/service 数据面。
  // 返回 false 表示不是受支持的助手动作（调用方继续按原 503 处理）。
  async function handleUninitializedClientAction(req, res, path, _body) {
    const match = path.match(UNINITIALIZED_CLIENT_ACTION);
    if (!match) return false;
    const { connectClient, previewClient, listAssistantsAsync, assistantUserHome, daemonMcpUrl } = await import('./clients.mjs');
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    const mcpUrl = daemonMcpUrl({ host: req.headers?.host, encrypted: Boolean(req.socket?.encrypted) });
    const opts = { home, cwd: process.cwd(), mcpUrl };
    try {
      if (action === 'preview') {
        return sendJson(res, 200, previewClient(id, opts));
      }
      if (action === 'verify') {
        // 未初始化不是「连接失败」：返回稳定的待初始化结果，让 UI 保留配置并等待 READY。
        return sendJson(res, 200, {
          ok: false,
          state: 'pending-initialization',
          needsManual: false,
          pendingInitialization: true,
          reason: 'not_initialized',
          message: '待初始化：请先新建或加入忆云，再验证连接',
          steps: [],
        });
      }
      if (action === 'recheck') {
        const out = await listAssistantsAsync({ ...opts, userHome: assistantUserHome(), refresh: true });
        const client = out.assistants.find((entry) => entry.id === id) ?? null;
        if (!client) return sendJson(res, 404, { ok: false, error: 'unknown_client', id });
        return sendJson(res, 200, { ok: true, client, cached: false, pendingInitialization: true });
      }
      const result = await connectClient(id, opts);
      return sendJson(res, result.ok ? 200 : 422, result);
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: 'client_action_failed', message: String(error?.message ?? error) });
    }
  }

  // 设置 · 常用「自动修复」：只重跑客户端接入（MCP 条目 + Skill），不碰 memory/identity/cloud/task/audit。
  async function handleRepair(req, res) {
    const { repairClients, assistantUserHome, daemonMcpUrl } = await import('./clients.mjs');
    const mcpUrl = daemonMcpUrl({ host: req.headers?.host, encrypted: Boolean(req.socket?.encrypted) });
    try {
      const result = await repairClients({ home, cwd: process.cwd(), mcpUrl, userHome: assistantUserHome() });
      // 逐项失败也是有效结果：200 + per-client report，由 UI 展示摘要。
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        scope: 'client-integration',
        error: 'repair_failed',
        message: `自动修复失败：${String(error?.message ?? error)}`,
      });
    }
  }

  // D2 写端点实现（memory.admin scope + CSRF 已在 handleAdminWrite 校验）
  async function applyAdminWrite(req, res, path, body) {
    if (!app || !service) {
      if (phase !== 'READY') {
        const handled = await handleUninitializedClientAction(req, res, path, body);
        if (handled !== false) return handled;
      }
      return sendJson(res, 503, { error: 'console_unavailable', message: 'Mebular 尚未初始化' });
    }

    // 忆云档案写端点：**不**经 securityWriteGate（§6.3：加入是出站动作，语义相反）。
    if (path === '/admin/api/clouds/inspect') return handleCloudInspect(req, res, body);
    if (path === '/admin/api/clouds/join') return handleCloudJoin(req, res, body);
    if (path === '/admin/api/clouds/rename') return handleCloudRename(req, res, body);

    // 自动修复：客户端接入修复，**不**经 securityWriteGate（不写记忆/安全状态）。
    if (path === '/admin/api/repair') return handleRepair(req, res);

    // S2：安全三档写端点门禁（medium 动态码 / high 会签或恢复码；low 放行）。
    const gateInput = parseJsonBody(body) ?? {};
    const gate = await securityWriteGate({ app, home, path, input: gateInput, namespace });
    if (!gate.ok) {
      if (gate.retryAfterMs !== undefined) res.setHeader('retry-after', String(Math.ceil(gate.retryAfterMs / 1000)));
      return sendJson(res, gate.status ?? 403, {
        ok: false,
        error: gate.error ?? 'security_gate',
        message: gate.message ?? '安全门槛未通过',
        ...(gate.retryAfterMs !== undefined ? { retryAfterMs: gate.retryAfterMs } : {}),
      });
    }

    // S2：安全后端端点（tier 读写 / 批准请求 / 待批准 / 批准 / 拒绝 / 恢复码状态）。
    // S2：TOTP 分发（显示需先输入一次动态码；导入写审计）。
    const totpAction = path.match(/^\/admin\/api\/security\/totp\/(show|import)$/);
    if (totpAction) {
      const lib = await loadFleetSecurity();
      if (!lib) return sendJson(res, 503, { ok: false, error: 'security_unavailable', message: '安全模块不可用' });
      const input = parseJsonBody(body) ?? {};
      if (totpAction[1] === 'show') {
        let seed;
        try {
          seed = await lib.readTotpSeed(home);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: 'totp_invalid_file', message: String(error?.message ?? error) });
        }
        if (seed === null) {
          if (input.generate !== true) {
            return sendJson(res, 409, {
              ok: false,
              error: 'totp_not_configured',
              message: '本机尚未导入动态码种子：请从一台已有设备导入，或由 root 生成新种子',
            });
          }
          if (!app.identity?.hasMasterPrivateKey?.()) {
            return sendJson(res, 403, { ok: false, error: 'root_required', message: '仅 root（持有主密钥私钥的设备）可生成动态码种子' });
          }
          seed = await lib.writeTotpSeed(home, lib.generateTotpSecret());
        } else {
          if (typeof input.code !== 'string' || input.code.trim().length === 0) {
            return sendJson(res, 403, { ok: false, error: 'totp_required', message: '显示动态码种子前需要输入一次本机动态码（code）' });
          }
          const check = await lib.verifyTotp(seed.secret, input.code, Date.now(), { dir: home });
          if (!check.ok) {
            return sendJson(res, check.reason === 'locked' ? 429 : 403, {
              ok: false,
              error: check.reason === 'locked' ? 'totp_locked' : check.reason === 'replay' ? 'totp_replayed' : 'totp_invalid',
              message: check.reason === 'locked'
                ? `动态码已锁定：请在 ${Math.ceil((check.retryAfterMs ?? 0) / 1000)} 秒后重试`
                : check.reason === 'replay' ? '动态码已使用过（重放被拒）' : '动态码无效：请检查设备时间',
              ...(check.retryAfterMs !== undefined ? { retryAfterMs: check.retryAfterMs } : {}),
            });
          }
        }
        const share = await lib.renderTotpShare(seed.secret, deviceId, { qr: true });
        const svg = await lib.renderTotpShareSvg(seed.secret, deviceId);
        await lib.writeSecurityTotpAudit(app, {
          device: deviceId,
          fingerprint: seed.fingerprint,
          issuedAt: Date.now(),
          note: 'console show',
        });
        return sendJson(res, 200, {
          ok: true,
          device: deviceId,
          fingerprint: seed.fingerprint,
          secret: seed.secret,
          groups: share.groups,
          otpauth: share.otpauth,
          qr: share.qrText ?? null,
          qrSvg: svg,
          warning: '种子等于这一档的钥匙：只在两台你自己的设备之间当面出示；不要截图、不要发聊天工具。',
        });
      }
      const inputSecret = typeof input.secret === 'string'
        ? input.secret
        : typeof input.uri === 'string' ? input.uri : '';
      if (inputSecret.length === 0) {
        return sendJson(res, 400, { ok: false, error: 'bad_request', message: '需要 secret（base32）或 uri（otpauth://…）' });
      }
      try {
        const record = await lib.importTotpSeed(home, inputSecret, {
          ...(typeof input.expectedFingerprint === 'string' ? { expectedFingerprint: input.expectedFingerprint } : {}),
        });
        await lib.writeSecurityTotpAudit(app, {
          device: deviceId,
          fingerprint: record.fingerprint,
          issuedAt: Date.now(),
          note: 'console import',
        });
        return sendJson(res, 200, { ok: true, device: deviceId, fingerprint: record.fingerprint, createdAt: record.createdAt });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: 'totp_import_failed', message: String(error?.message ?? error) });
      }
    }

    // S2：恢复码生成/轮换（新码只返回一次）。
    const recoveryAction = path.match(/^\/admin\/api\/security\/recovery\/(generate|rotate)$/);
    if (recoveryAction) {
      const lib = await loadFleetSecurity();
      if (!lib) return sendJson(res, 503, { ok: false, error: 'security_unavailable', message: '安全模块不可用' });
      const input = parseJsonBody(body) ?? {};
      const events = await lib.listPolicyEvents(app);
      if (recoveryAction[1] === 'generate') {
        const existing = lib.latestRecoveryRecord(events);
        if (existing !== null) {
          return sendJson(res, 409, {
            ok: false,
            error: 'recovery_exists',
            message: `已存在恢复码（keyId ${existing.keyId.slice(0, 8)}…）：请使用轮换`,
          });
        }
        const material = lib.generateRecoveryCode();
        const event = await lib.writeSecurityRecovery(app, {
          keyId: material.keyId,
          publicKey: material.publicKeyHex,
          createdAt: material.createdAt,
          mode: 'set',
          ...(typeof input.note === 'string' ? { note: input.note } : {}),
        });
        return sendJson(res, 201, {
          ok: true,
          keyId: material.keyId,
          code: material.code,
          codeFormatted: lib.formatRecoveryCode(material.code),
          eventId: event.id,
          shownOnce: true,
        });
      }
      const oldCode = typeof input.oldCode === 'string' ? input.oldCode : typeof input.code === 'string' ? input.code : '';
      if (oldCode.length === 0) {
        return sendJson(res, 400, { ok: false, error: 'bad_request', message: '轮换需要 oldCode（当前恢复码）' });
      }
      const registry = lib.collectRecoveryRegistry(events);
      const state = await lib.readSecurityState(app);
      const currentKeyId = state.recoveryKeyId ?? registry.currentKeyId ?? lib.latestRecoveryRecord(events)?.keyId;
      if (currentKeyId === undefined) {
        return sendJson(res, 409, { ok: false, error: 'recovery_missing', message: '尚未生成恢复码' });
      }
      let oldDerived;
      try {
        oldDerived = lib.deriveRecoveryKey(oldCode);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: 'recovery_invalid', message: String(error?.message ?? error) });
      }
      if (oldDerived.keyId !== currentKeyId) {
        return sendJson(res, 403, { ok: false, error: 'recovery_mismatch', message: '恢复码不匹配当前 keyId（可能已被轮换）' });
      }
      const material = lib.generateRecoveryCode();
      const signed = lib.signBreakGlass({
        code: oldCode,
        op: 'rotate',
        initiator: deviceId,
        oldKeyId: currentKeyId,
        newPublicKey: material.publicKeyHex,
      });
      const event = await lib.writeSecurityRecovery(app, {
        keyId: material.keyId,
        publicKey: material.publicKeyHex,
        createdAt: material.createdAt,
        mode: 'rotate',
        nonce: signed.proof.nonce,
        breakGlass: signed.proof,
        ...(typeof input.note === 'string' ? { note: input.note } : {}),
      });
      return sendJson(res, 200, {
        ok: true,
        oldKeyId: currentKeyId,
        keyId: material.keyId,
        code: material.code,
        codeFormatted: lib.formatRecoveryCode(material.code),
        eventId: event.id,
        shownOnce: true,
      });
    }

    if (path === '/admin/api/security/tier') {
      const input = parseJsonBody(body) ?? {};
      const level = typeof input.level === 'string' ? input.level : '';
      if (!['low', 'medium', 'high'].includes(level)) {
        return sendJson(res, 400, { ok: false, error: 'bad_request', message: 'level 必须是 low|medium|high' });
      }
      const lib = await loadFleetSecurity();
      if (!lib) return sendJson(res, 503, { ok: false, error: 'security_unavailable', message: '安全模块不可用（@mebular/fleet 未构建）' });
      const state = await lib.readSecurityState(app);
      const events = await lib.listPolicyEvents(app);
      const suppliedRecoveryCode = typeof input.recoveryCode === 'string' ? input.recoveryCode.trim() : '';
      let breakGlass = input.breakGlass;
      if (suppliedRecoveryCode.length > 0) {
        if (input.breakGlass !== undefined || input.cosign !== undefined || input.nonce !== undefined
          || typeof input.approvalId === 'string') {
          return sendJson(res, 400, {
            ok: false,
            error: 'bad_request',
            message: 'recoveryCode 不能与 breakGlass / 会签批准 / 自定义 nonce 同时使用：请只选一种执行方式。',
          });
        }
        if (level === 'high') {
          return sendJson(res, 409, {
            ok: false,
            error: 'recovery_not_applicable',
            message: '恢复码只用于高档降档；升档或保持高档无需恢复码。',
          });
        }
        const signed = await signRecoveryProof({
          lib,
          app,
          code: suppliedRecoveryCode,
          op: 'tier',
          level,
          initiator: app.deviceId ?? deviceId ?? '',
        });
        if (!signed.ok) {
          return sendJson(res, signed.status, { ok: false, error: signed.error, message: signed.message });
        }
        breakGlass = signed.proof;
      }
      let recoveryCode;
      let recoveryKeyId = state.recoveryKeyId;
      if (level === 'high' && state.level !== 'high') {
        const registry = lib.collectRecoveryRegistry(events);
        if (registry.currentKeyId === undefined && recoveryKeyId === undefined) {
          const material = lib.generateRecoveryCode();
          await lib.writeSecurityRecovery(app, {
            keyId: material.keyId,
            publicKey: material.publicKeyHex,
            createdAt: material.createdAt,
            mode: 'set',
            note: 'tier-upgrade-high',
          });
          recoveryCode = material.code;
          recoveryKeyId = material.keyId;
        }
      }
      let cosign = input.cosign;
      let approvalNonce;
      if (cosign === undefined && breakGlass === undefined && typeof input.approvalId === 'string') {
        const approval = lib.findApproval(events, input.approvalId);
        cosign = approval?.cosign;
        approvalNonce = approval?.nonce;
      }
      const written = await lib.writeSecurityTier(app, {
        level,
        ...(typeof input.note === 'string' ? { note: input.note } : {}),
        ...(input.nonce !== undefined ? { nonce: input.nonce } : approvalNonce !== undefined ? { nonce: approvalNonce } : {}),
        ...(cosign !== undefined ? { cosign } : {}),
        ...(breakGlass !== undefined ? { breakGlass } : {}),
      });
      return sendJson(res, 200, {
        ok: true,
        level,
        ...(written.id !== undefined ? { eventId: written.id } : {}),
        ...(suppliedRecoveryCode.length > 0 ? { method: 'breakGlass', auditLabel: '恢复码' } : {}),
        ...(recoveryKeyId !== undefined ? { recoveryKeyId } : {}),
        ...(recoveryCode !== undefined ? {
          recoveryCode,
          recoveryCodeFormatted: lib.formatRecoveryCode(recoveryCode),
          mustAcknowledge: true,
          message: '已生成离线恢复码：只显示这一次，请抄写到离线介质后确认已保存。',
        } : {}),
      });
    }

    if (path === '/admin/api/security/approvals') {
      const input = parseJsonBody(body) ?? {};
      const op = input.op;
      if (!['kick', 'join', 'tier', 'restore'].includes(op)) {
        return sendJson(res, 400, { ok: false, error: 'bad_request', message: 'op 必须是 kick|join|tier|restore' });
      }
      if ((op === 'kick' || op === 'restore') && typeof input.target !== 'string') {
        return sendJson(res, 400, { ok: false, error: 'bad_request', message: `${op} 需要 target（设备）` });
      }
      if (op === 'join' && typeof input.namespace !== 'string') {
        return sendJson(res, 400, { ok: false, error: 'bad_request', message: 'join 需要 namespace' });
      }
      if (op === 'tier' && !['low', 'medium', 'high'].includes(input.level)) {
        return sendJson(res, 400, { ok: false, error: 'bad_request', message: 'tier 需要 level=low|medium|high' });
      }
      const lib = await loadFleetSecurity();
      if (!lib) return sendJson(res, 503, { ok: false, error: 'security_unavailable', message: '安全模块不可用' });
      const approvalId = randomUUID();
      const nonce = randomUUID();
      const digest = lib.securityActionDigest({
        op,
        initiator: deviceId,
        ...(op === 'kick' || op === 'restore' ? { subject: input.target } : {}),
        ...(op === 'join' ? { namespace: input.namespace } : {}),
        ...(op === 'tier' ? { level: input.level } : {}),
        nonce,
      });
      const record = {
        approvalId,
        op,
        decision: 'request',
        initiator: deviceId,
        ...(op === 'kick' || op === 'restore' ? { target: input.target } : {}),
        ...(op === 'join' ? { namespace: input.namespace } : {}),
        ...(op === 'tier' ? { level: input.level } : {}),
        nonce,
        digest,
        pairingCode: lib.pairingCodeForDigest(digest),
        expiresAt: Date.now() + 10 * 60_000,
        issuedAt: Date.now(),
        ...(typeof input.note === 'string' ? { note: input.note } : {}),
      };
      const event = await lib.writeSecurityApproval(app, record);
      return sendJson(res, 201, { ok: true, ...record, eventId: event.id });
    }

    const approvalAction = path.match(/^\/admin\/api\/security\/approvals\/([^/]+)\/(approve|deny)$/);
    if (approvalAction) {
      const approvalId = decodeURIComponent(approvalAction[1]);
      const decision = approvalAction[2];
      const lib = await loadFleetSecurity();
      if (!lib) return sendJson(res, 503, { ok: false, error: 'security_unavailable', message: '安全模块不可用' });
      const events = await lib.listPolicyEvents(app);
      const request = lib.approvalsFromEvents(events).find((record) => record.approvalId === approvalId && record.decision === 'request');
      if (!request) return sendJson(res, 404, { ok: false, error: 'approval_not_found', message: '待批准请求不存在或已处理' });
      if (request.initiator === deviceId) {
        return sendJson(res, 403, { ok: false, error: 'self_approval', message: '发起设备不能批准自己的动作' });
      }
      if (decision === 'deny') {
        const record = {
          ...request,
          decision: 'deny',
          issuedAt: Date.now(),
        };
        const event = await lib.writeSecurityApproval(app, record);
        return sendJson(res, 200, { ok: true, approvalId, decision: 'deny', eventId: event.id });
      }
      const identity = app.identity?.getDeviceKey?.(deviceId);
      if (!identity || identity.privateKey === undefined) {
        return sendJson(res, 409, { ok: false, error: 'identity_unavailable', message: '本机设备身份不可用，无法会签' });
      }
      const chain = Array.isArray(identity.certificateChain) && identity.certificateChain.length > 0
        ? identity.certificateChain
        : identity.certificate !== undefined ? [identity.certificate] : [];
      const cosign = await lib.signCosignProof({
        privateKey: identity.privateKey,
        approver: deviceId,
        approverCertificateChain: chain,
        approvalId,
        op: request.op,
        digest: request.digest,
        pairingCode: request.pairingCode,
      });
      const record = {
        ...request,
        decision: 'approve',
        cosign,
        issuedAt: Date.now(),
      };
      const event = await lib.writeSecurityApproval(app, record);
      return sendJson(res, 200, { ok: true, approvalId, decision: 'approve', eventId: event.id, cosign });
    }

    // 新设备上车：生成一次性加入令牌（需 joinService 已启用；由守护 identity 生成）
    if (path === '/admin/api/invite') {
      // C7：二维码 + 文本一起给（QR 内容 = 内联令牌文本；缺可选依赖 → 只给文本，不报错）
      if (typeof deviceId !== 'string' || typeof joinEndpoint !== 'string') {
        return sendJson(res, 409, {
          ok: false,
          error: 'join_disabled',
          message: '未启用加入服务：在「设置 → 常用配置」开启 joinService.enabled 并重启 serve',
        });
      }
      const input = parseJsonBody(body) ?? {};
      // 被移出设备不生成新令牌（作者级否定）。
      if (typeof app.getBlockedDevices === 'function') {
        const blocked = await app.getBlockedDevices().catch(() => []);
        if (Array.isArray(blocked) && blocked.includes(deviceId)) {
          return sendJson(res, 403, {
            ok: false,
            error: 'inviter_blocked',
            message: '本机已被移出网络（device_revoke 已采纳）：不能再生成加入令牌',
          });
        }
      }
      // §3.7 ④：高档下把已核对的批准随响应交给新设备（内嵌到首现记录用）。
      let securityApproval = null;
      if (typeof input.approvalId === 'string' && input.approvalId.length > 0) {
        const lib = await loadFleetSecurity();
        if (lib) {
          const events = await lib.listPolicyEvents(app);
          const approval = lib.findApproval(events, input.approvalId);
          if (!approval) {
            return sendJson(res, 409, { ok: false, error: 'approval_missing', message: '批准记录不存在或未生效' });
          }
          securityApproval = {
            approvalId: approval.approvalId,
            nonce: approval.nonce,
            initiator: approval.initiator,
            ...(approval.cosign !== undefined ? { cosign: approval.cosign } : {}),
          };
        }
      }
      const ns = typeof input.namespace === 'string' && input.namespace ? input.namespace : namespace;
      const ttlMs = Number.isInteger(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : 900_000;
      // F-C6：端点默认取守护计算的**可达**地址（通配 bind → 本机 LAN IPv4）；允许调用方显式覆盖
      // （控制台邀请面板可填写），令牌内 endpoint 与返回 endpoint 始终一致。
      const override = typeof input.endpoint === 'string' && input.endpoint.trim() ? input.endpoint.trim() : null;
      if (override && endpointHostname(override) === null) {
        return sendJson(res, 400, { error: 'bad_request', errorKey: 'invite_endpoint_invalid', message: 'endpoint 需为 http(s) URL，例如 http://192.168.1.20:4002' });
      }
      const endpoint = override ?? joinEndpoint;
      // C2：令牌携带邀请方可达端点（hints），新设备 join 后写入地址簿 → 自动选路
      const hints = collectInviteHints(app, config);
      const nonce = randomBytes(16).toString('hex');
      const token = await buildJoinToken({
        mebular: app,
        deviceId,
        namespace: ns,
        endpoint,
        ttlMs,
        nonce,
        ...(securityApproval !== null ? { securityApproval } : {}),
        ...hints,
      });
      // 单一有效邀请：新令牌激活时把上一个 active nonce 放进 revoked（join 服务验证时拒绝）。
      await activateJoinInvite(joinStateStoragePath, nonce);
      const inline = Buffer.from(JSON.stringify(token), 'utf-8').toString('base64');
      const endpointHost = endpointHostname(endpoint);
      const invalidEndpoint = endpointHost === null;
      const loopback = endpointHost !== null && isLoopbackHost(endpointHost);
      const qrWarnings = [];
      const qrSvg = await renderSvgQr(inline, { onWarn: (m) => qrWarnings.push(m) });
      return sendJson(res, 201, {
        ok: true,
        token: inline,
        // C7：服务端渲染 SVG（data-uri 由前端组装）；库不可用时为 null
        qrSvg: qrSvg ? qrSvg.value : null,
        ...(qrWarnings.length > 0 ? { qrWarnings } : {}),
        endpoint,
        endpointSource: override ? 'override' : 'daemon',
        namespace: ns,
        expiresAt: token.expiresAt,
        ttlMs,
        ...(securityApproval !== null ? { securityApproval } : {}),
        ...(invalidEndpoint
          ? { warning: '邀请端点不是有效地址：请在「设置 → 高级 → 常驻服务」检查 joinService.bind/port，或手工修正 config.json 中的 joinService.endpoint。' }
          : loopback
            ? { warning: '该端点是回环地址，其他设备无法访问：请在「设置 → 高级 → 常驻服务」将 joinService.bind 设为 0.0.0.0。' }
            : {}),
      });
    }

    // 控制台配置写入：curated 合并 + 原子写 + .bak 备份（全部需重启生效）
    if (path === '/admin/api/config') {
      const input = parseJsonBody(body);
      if (!input || typeof input.patch !== 'object') {
        return sendJson(res, 400, { error: 'bad_request', errorKey: 'config_patch_invalid', message: '需要 { patch: { ... } }' });
      }
      const { errors, entries } = validateConfigPatch(input.patch);
      if (errors.length > 0) {
        return sendJson(res, 400, { error: 'bad_request', errorKey: 'config_patch_invalid', message: errors.join('；'), details: errors });
      }
      const cfgFile = configPath(home);
      let current = {};
      try {
        current = JSON.parse(await readFile(cfgFile, 'utf-8'));
      } catch {
        current = {};
      }
      const merged = JSON.parse(JSON.stringify(current));
      for (const entry of entries) {
        if (entry.value === null) deleteAtPath(merged, entry.path);
        else setAtPath(merged, entry.path, entry.value);
      }
      // F-C2：组合校验（基于合并结果；拒绝会把自己搞挂的 host/auth/tls 组合）
      const comboErrors = validateConfigCombination(merged);
      if (comboErrors.length > 0) {
        return sendJson(res, 400, { error: 'bad_request', errorKey: 'config_patch_invalid', message: comboErrors.join('；'), details: comboErrors });
      }
      const changedPaths = entries.map((e) => e.path);
      const { restart: restartPaths, immediate: immediatePaths, selfLock } = classifyChanges(changedPaths, hotPaths());
      // G4：自锁防护——命中 auth/host/tls 需显式确认（重启后控制台可能不可达）；未确认则不写不重启
      if (selfLock.length > 0 && input.confirm !== true) {
        return sendJson(res, 409, {
          ok: false,
          error: 'needs_confirmation',
          needsConfirmation: true,
          paths: selfLock,
          message: `改动命中 ${selfLock.join(', ')}：保存并重启后控制台可能无法访问。如失联请手工编辑 ${cfgFile} 改回并重启。请带 { confirm: true } 重试。`,
        });
      }
      const tmp = `${cfgFile}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(merged, null, 2), 'utf-8');
      if (existsSync(cfgFile)) await copyFile(cfgFile, `${cfgFile}.bak`);
      await rename(tmp, cfgFile);
      const backup = existsSync(`${cfgFile}.bak`) ? `${cfgFile}.bak` : null;
      const base = { ok: true, applied: changedPaths, backup, path: cfgFile, config: merged };

      // G1：全部即时生效项 → 不重启，就地生效（前端随即刷新 effective）
      if (restartPaths.length === 0) {
        return sendJson(res, 200, { ...base, restartRequired: false, effectiveImmediately: true, restart: { mode: 'none' }, immediatePaths });
      }

      const autoRestart = process.env.MEBULAR_CONFIG_AUTORESTART !== '0';
      const serviceManaged = Boolean(process.env.MEBULAR_SERVICE_KIND) || Boolean(String(process.env.MEBULAR_RESTART_CMD ?? '').trim());
      // 前台 nohup（无服务托管）或显式关闭 → 手动指引；待重启语义保留（#80 检测仍有效）
      if (!autoRestart || !serviceManaged) {
        return sendJson(res, 200, {
          ...base,
          restartRequired: true,
          restarting: false,
          restart: {
            mode: 'foreground',
            command: `nohup mebular serve > ${home}/serve.log 2>&1 &`,
            backup,
            manual: `未以服务方式运行：请手动重启（nohup mebular serve > ${home}/serve.log 2>&1 &）；如新配置起不来，用备份回滚：cp ${backup ?? `${cfgFile}.bak`} ${cfgFile}`,
          },
        });
      }
      // 服务托管 → 自动重启（保存动作即确认；防抖窗口内多次保存合并为一次）
      const targetPort = (() => {
        const raw = merged?.mcp?.http?.port;
        return typeof raw === 'number' && raw > 0 ? raw : (typeof runtime?.mcp?.port === 'number' ? runtime.mcp.port : 0);
      })();
      const timeoutMs = Number(process.env.MEBULAR_APPLY_TIMEOUT_MS ?? '') > 0 ? Number(process.env.MEBULAR_APPLY_TIMEOUT_MS) : APPLY_HEALTH_TIMEOUT_MS;
      const scheduled = scheduleApplyRestart({ fields: restartPaths, port: targetPort, timeoutMs });
      return sendJson(res, 200, {
        ...base,
        restartRequired: true,
        restarting: true,
        restart: {
          mode: 'service',
          debounceMs: RESTART_DEBOUNCE_MS,
          deferred: scheduled.debounced,
          fields: restartPaths,
          timeoutMs,
        },
      });
    }

    // G-ML-1：记忆生命周期（动作式，无开关）——归档/解除归档（可逆）+ 删除（墓碑）
    const memoryActionMatch = path.match(/^\/admin\/api\/memories\/([^/]+)\/(archive|unarchive|delete)$/);
    if (memoryActionMatch) {
      const id = decodeURIComponent(memoryActionMatch[1]);
      const action = memoryActionMatch[2];
      if (action === 'delete') {
        const result = await service.delete([id]);
        if (result.deleted.length === 0) {
          return sendJson(res, 404, { ok: false, error: 'not_found', errorKey: 'memory_not_found', message: `记忆不存在：${id}` });
        }
        return sendJson(res, 200, { ok: true, action: 'delete', id, ...result });
      }
      const result = await service.archive([id], action === 'archive');
      if (result.notFound.length > 0) {
        return sendJson(res, 404, { ok: false, error: 'not_found', errorKey: 'memory_not_found', message: `记忆不存在：${id}` });
      }
      if (result.skipped.length > 0) {
        return sendJson(res, 409, { ok: false, error: 'conflict', errorKey: 'memory_deleted_archive', message: '已删除（墓碑）的记忆不可归档', id });
      }
      return sendJson(res, 200, { ok: true, action, id, ...result });
    }

    // 一键重启（C）：设置页「待重启」横幅 → 立即让保存的配置生效
    if (path === '/admin/api/restart') {
      const input = parseJsonBody(body) ?? {};
      if (input.confirm !== true) {
        return sendJson(res, 400, { error: 'confirmation_required', message: '重启需二次确认：请带 { confirm: true }' });
      }
      const runner = typeof restartRunner === 'function' ? restartRunner : defaultRestartRunner;
      const plan = await runner({ home });
      if (!plan?.registered) {
        return sendJson(res, 409, {
          ok: false,
          error: 'not_service_managed',
          message: plan?.manual ?? '未以服务方式运行：请手动重启',
          manual: plan?.manual ?? null,
          command: plan?.command ?? null,
        });
      }
      // 先返回 202，再触发重启（避免响应被重启信号打断）
      sendJson(res, 202, {
        ok: true,
        action: 'restart',
        command: plan.command,
        ...(plan.commands ? { commands: plan.commands } : {}),
        ...(plan.dryRun ? { dryRun: true } : {}),
        note: '守护正在重启；页面会在稍后轮询中自动恢复',
      });
      setImmediate(() => { void Promise.resolve(plan.trigger?.()).catch(() => undefined); });
      return true;
    }

    // 新建记忆域（零门槛）：写自签名 `namespace_declare`；不自动订阅。
    if (path === '/admin/api/namespaces') {
      const input = parseJsonBody(body);
      if (!input || typeof input.namespace !== 'string' || input.namespace.trim().length === 0) {
        return sendJson(res, 400, { error: 'bad_request', errorKey: 'namespace_required', message: '需要 { namespace }' });
      }
      const event = await app.declareNamespace({
        namespace: input.namespace,
        ...(typeof input.note === 'string' ? { note: input.note } : {}),
      });
      const namespace = event.data?.declaration?.namespace ?? input.namespace;
      // 默认自订阅（零门槛）：创建完就能写；用户仍可随时退订。
      const subscribed = input.subscribe !== false;
      if (subscribed) {
        await app.subscribeNamespace(namespace);
        await persistSubscriptionNamespaces(home, app.sync.getSubscriptionNamespaces());
      }
      return sendJson(res, 201, { ok: true, namespace, eventId: event.id, subscribed });
    }

    // 订阅/退订（只改本机；热生效，不重启）
    if (path === '/admin/api/subscriptions') {
      const input = parseJsonBody(body);
      if (!input || typeof input.namespace !== 'string' || input.namespace.trim().length === 0) {
        return sendJson(res, 400, { error: 'bad_request', errorKey: 'namespace_required', message: '需要 { namespace, active?, nextNamespaces? }' });
      }
      const ns = input.namespace;
      const active = input.active !== false;
      const event = active
        ? await app.subscribeNamespace(ns)
        : await app.unsubscribeNamespace(ns);
      // 持久化 sync.namespaces（热生效：不重启；core 运行期已更新）
      const next = Array.isArray(input.nextNamespaces)
        ? input.nextNamespaces.filter((entry) => typeof entry === 'string' && entry.length > 0)
        : app.sync.getSubscriptionNamespaces();
      if (next.length > 0 || input.nextNamespaces !== undefined || !active) {
        await persistSubscriptionNamespaces(home, next);
      }
      return sendJson(res, 200, {
        ok: true,
        namespace: ns,
        active,
        eventId: event.id,
        subscriptions: app.sync.getSubscriptionNamespaces(),
      });
    }

    // 本机设备名（只有本人可改；写自签名 device_name，不重签证书）。
    if (path === '/admin/api/devices/self/name') {
      const input = parseJsonBody(body) ?? {};
      if (typeof input.name !== 'string' || input.name.trim().length === 0) {
        return sendJson(res, 400, { error: 'invalid_name', message: '需要 { name }（1–24 个字符）' });
      }
      try {
        const event = await app.setDeviceName({ name: input.name });
        const derived = await app.getDeviceName(app.deviceId);
        return sendJson(res, 200, {
          ok: true,
          deviceId: app.deviceId,
          name: derived?.name ?? input.name,
          eventId: event.id,
          deviceName: derived ?? null,
        });
      } catch (error) {
        const status = error?.code === 'VALIDATION_INVALID_ARGUMENT' ? 400 : 500;
        return sendJson(res, status, {
          ok: false,
          error: error?.code ?? 'device_name_failed',
          message: error?.message ?? String(error),
        });
      }
    }

    const deviceMatch = path.match(/^\/admin\/api\/devices\/([^/]+)\/(revoke|restore|connect|disconnect|sync|reset-watermarks)$/);
    if (deviceMatch) {
      const deviceId = decodeURIComponent(deviceMatch[1]);
      const action = deviceMatch[2];

      if (action === 'revoke') {
        const input = parseJsonBody(body) ?? {};
        const lib = await loadFleetSecurity();
        const suppliedRecoveryCode = typeof input.recoveryCode === 'string' ? input.recoveryCode.trim() : '';
        if (suppliedRecoveryCode.length > 0) {
          if (!lib) return sendJson(res, 503, { ok: false, error: 'security_unavailable', message: '安全模块不可用（@mebular/fleet 未构建）' });
          if (input.breakGlass !== undefined || input.cosign !== undefined || input.nonce !== undefined
            || typeof input.approvalId === 'string') {
            return sendJson(res, 400, {
              ok: false,
              error: 'bad_request',
              message: 'recoveryCode 不能与 breakGlass / 会签批准 / 自定义 nonce 同时使用：请只选一种执行方式。',
            });
          }
          const signed = await signRecoveryProof({
            lib,
            app,
            code: suppliedRecoveryCode,
            op: 'kick',
            subject: deviceId,
            initiator: app.deviceId ?? deviceId ?? '',
          });
          if (!signed.ok) {
            return sendJson(res, signed.status, { ok: false, error: signed.error, message: signed.message });
          }
          const event = await lib.writeDeviceRevoke(app, {
            subject: deviceId,
            note: typeof input.note === 'string' ? input.note : 'recovery-code',
            breakGlass: signed.proof,
          });
          return sendJson(res, 200, {
            ok: true,
            deviceId,
            eventId: event.id,
            method: 'breakGlass',
            auditLabel: '恢复码',
          });
        }
        let cosign = input.cosign;
        let approvalNonce = typeof input.nonce === 'string' ? input.nonce : undefined;
        if (lib && (cosign !== undefined || typeof input.approvalId === 'string') && input.breakGlass === undefined) {
          const events = await lib.listPolicyEvents(app);
          const approvalId = typeof input.approvalId === 'string'
            ? input.approvalId
            : typeof cosign?.approvalId === 'string' ? cosign.approvalId : null;
          if (approvalId !== null) {
            const approval = lib.findApproval(events, approvalId);
            if (cosign === undefined) cosign = approval?.cosign;
            if (approvalNonce === undefined) approvalNonce = approval?.nonce;
          }
        }
        if (lib && (cosign !== undefined || input.breakGlass !== undefined)) {
          const event = await lib.writeDeviceRevoke(app, {
            subject: deviceId,
            ...(typeof input.note === 'string' ? { note: input.note } : {}),
            ...(approvalNonce !== undefined ? { nonce: approvalNonce } : {}),
            ...(cosign !== undefined ? { cosign } : {}),
            ...(input.breakGlass !== undefined ? { breakGlass: input.breakGlass } : {}),
          });
          return sendJson(res, 200, {
            ok: true,
            deviceId,
            eventId: event.id,
            method: input.breakGlass !== undefined ? 'breakGlass' : 'cosign',
            ...(input.breakGlass !== undefined ? { auditLabel: '恢复码' } : {}),
          });
        }
        const event = await app.revokeDevice({
          subject: deviceId,
          ...(typeof input.note === 'string' ? { note: input.note } : {}),
        });
        return sendJson(res, 200, { ok: true, deviceId, eventId: event.id });
      }

      if (action === 'restore') {
        const input = parseJsonBody(body) ?? {};
        const lib = await loadFleetSecurity();
        const suppliedRecoveryCode = typeof input.recoveryCode === 'string' ? input.recoveryCode.trim() : '';
        if (suppliedRecoveryCode.length > 0) {
          if (!lib) return sendJson(res, 503, { ok: false, error: 'security_unavailable', message: '安全模块不可用（@mebular/fleet 未构建）' });
          if (input.breakGlass !== undefined || input.cosign !== undefined || input.nonce !== undefined
            || typeof input.approvalId === 'string') {
            return sendJson(res, 400, {
              ok: false,
              error: 'bad_request',
              message: 'recoveryCode 不能与 breakGlass / 会签批准 / 自定义 nonce 同时使用：请只选一种执行方式。',
            });
          }
          const signed = await signRecoveryProof({
            lib,
            app,
            code: suppliedRecoveryCode,
            op: 'restore',
            subject: deviceId,
            initiator: app.deviceId ?? deviceId ?? '',
          });
          if (!signed.ok) {
            return sendJson(res, signed.status, { ok: false, error: signed.error, message: signed.message });
          }
          const event = await lib.writeDeviceRestore(app, {
            subject: deviceId,
            note: typeof input.note === 'string' ? input.note : 'recovery-code',
            breakGlass: signed.proof,
          });
          return sendJson(res, 200, {
            ok: true,
            deviceId,
            eventId: event.id,
            method: 'breakGlass',
            auditLabel: '恢复码',
          });
        }
        let cosign = input.cosign;
        let approvalNonce = typeof input.nonce === 'string' ? input.nonce : undefined;
        if (lib && (cosign !== undefined || typeof input.approvalId === 'string') && input.breakGlass === undefined) {
          const events = await lib.listPolicyEvents(app);
          const approvalId = typeof input.approvalId === 'string'
            ? input.approvalId
            : typeof cosign?.approvalId === 'string' ? cosign.approvalId : null;
          if (approvalId !== null) {
            const approval = lib.findApproval(events, approvalId);
            if (cosign === undefined) cosign = approval?.cosign;
            if (approvalNonce === undefined) approvalNonce = approval?.nonce;
          }
        }
        if (lib && (cosign !== undefined || input.breakGlass !== undefined)) {
          const event = await lib.writeDeviceRestore(app, {
            subject: deviceId,
            ...(typeof input.note === 'string' ? { note: input.note } : {}),
            ...(approvalNonce !== undefined ? { nonce: approvalNonce } : {}),
            ...(cosign !== undefined ? { cosign } : {}),
            ...(input.breakGlass !== undefined ? { breakGlass: input.breakGlass } : {}),
          });
          return sendJson(res, 200, {
            ok: true,
            deviceId,
            eventId: event.id,
            method: input.breakGlass !== undefined ? 'breakGlass' : 'cosign',
            ...(input.breakGlass !== undefined ? { auditLabel: '恢复码' } : {}),
          });
        }
        const event = await app.restoreDevice({
          subject: deviceId,
          ...(typeof input.note === 'string' ? { note: input.note } : {}),
        });
        return sendJson(res, 200, { ok: true, deviceId, eventId: event.id });
      }

      if (action === 'reset-watermarks') {
        await app.resetPeerWatermarks(deviceId);
        return sendJson(res, 200, { ok: true, deviceId });
      }

      const node = app.node;
      if (!node || !node.isRunning()) {
        return sendJson(res, 409, { error: 'network_not_running', message: '网络未启用，无法连接或同步' });
      }

      if (action === 'connect') {
        const input = parseJsonBody(body) ?? {};
        if (typeof input.address !== 'string' || input.address.length === 0) {
          return sendJson(res, 400, { error: 'bad_request', errorKey: 'address_required', message: '需要 { address }（对端 multiaddr，含 /p2p/…）' });
        }
        const peerId = { multihash: new Uint8Array(), pubKey: new Uint8Array(), id: deviceId };
        const connection = await node.connectToPeer(peerId, input.address);
        return sendJson(res, 200, { ok: true, deviceId, remoteAddress: connection.remoteAddress });
      }

      const found = findConnectionByDevice(deviceId);
      if (!found) {
        return sendJson(res, 409, {
          error: 'not_connected',
          message: `${deviceId} 当前未连接；请先用 connect 提供对端 multiaddr`,
        });
      }

      if (action === 'disconnect') {
        await node.disconnectPeer(found.connection.peerId);
        return sendJson(res, 200, { ok: true, deviceId });
      }

      if (action === 'sync') {
        // v1.1 起会话由 SyncManager 常驻循环统一编排（PeerFrames 单消费者）。
        // 不能在裸信道上另起 syncWithDevice：会与会话循环抢帧，导致
        // "Sync timeout waiting for sync-hello" 并抛 500。
        // runAntiEntropyCycle 是公共触发路径：对在线且确有 pending 的对端
        // 唤醒发起方循环（响应方角色由 nudge 机制覆盖）。
        const before = await app.sync.getSyncStatus();
        await app.sync.runAntiEntropyCycle();
        return sendJson(res, 200, {
          ok: true,
          deviceId,
          triggered: before.pendingCount > 0,
          pendingBefore: before.pendingCount,
        });
      }
    }

    // 分区动作：rejoin（重入恢复）/ leave（退出并交接；force 不走控制台）
    const nsActionMatch = path.match(/^\/admin\/api\/namespaces\/([^/]+)\/(rejoin|leave)$/);
    if (nsActionMatch) {
      const namespace = decodeURIComponent(nsActionMatch[1]);
      const action = nsActionMatch[2];
      const input = parseJsonBody(body) ?? {};
      if (action === 'rejoin') {
        const result = await app.rejoinNamespace({ namespace });
        return sendJson(res, result.ok ? 200 : 409, result);
      }
      if (input.force === true) {
        // SEALING §3：force 仅限本地 CLI，不经 MCP/远程
        return sendJson(res, 400, { error: 'bad_request', errorKey: 'handoff_force_local_only', message: 'force 仅限本地 CLI（SEALING §3），控制台不提供' });
      }
      if (typeof input.successor !== 'string' || input.successor.length === 0) {
        return sendJson(res, 400, { error: 'bad_request', errorKey: 'handoff_successor_required', message: '需要 { successor }（继任者 deviceId）' });
      }
      const result = await app.leaveNamespace({
        namespace,
        successor: input.successor,
        ...(typeof input.note === 'string' ? { note: input.note } : {}),
      });
      return sendJson(res, result.ok ? 200 : 409, result);
    }

    // H-1：常驻运行（服务托管，动作式；统一走共享 runtime/service 层）。CI 用 MEBULAR_SERVICE_DRY_RUN=1 替身断言命令序列。
    const svcAction = path.match(/^\/admin\/api\/service\/(install|uninstall)$/);
    if (svcAction) {
      const {
        installRuntimeService,
        runtimeProviderFromEnv,
        runtimeServiceStatus,
        uninstallRuntimeService,
      } = await import('./runtime-service.mjs');
      const { resolveServiceHome } = await import('./service-control.mjs');
      const dryRun = process.env.MEBULAR_SERVICE_DRY_RUN === '1';
      const commands = [];
      const run = dryRun ? (cmd, args) => { commands.push([cmd, ...(args ?? [])]); return { status: 0, stdout: '', stderr: '' }; } : undefined;
      // 两套 home：home = 实例身份（descriptor），serviceHome = unit/manifest 落盘（用户 OS home）。
      const serviceHome = resolveServiceHome();
      const root = cloud.available ? cloud.root : null;
      const fallbackProvider = runtimeProviderFromEnv({ cliPath: process.argv[1] });
      if (root === null) {
        // 自定义 home / 受限 env：保留 App 既有 service-control 行为。
        const { installServiceForHome, uninstallServiceForHome, serviceStatusForHome } = await import('./service-control.mjs');
        try {
          const action = svcAction[1];
          const result = action === 'install'
            ? installServiceForHome({ home, serviceHome, ...(run ? { run } : {}) })
            : uninstallServiceForHome({ home, serviceHome, ...(run ? { run } : {}) });
          const status = serviceStatusForHome({ home, serviceHome, ...(run ? { run } : {}) });
          return sendJson(res, 200, { ok: true, action, dryRun, commands, result, status });
        } catch (error) {
          return sendJson(res, 500, { ok: false, action: svcAction[1], error: 'service_action_failed', message: String(error?.message ?? error) });
        }
      }
      try {
        const action = svcAction[1];
        const result = action === 'install'
          ? await installRuntimeService({ root, home, serviceHome, http: { port }, fallbackProvider, ...(run ? { run } : {}) })
          : await uninstallRuntimeService({ root, home, serviceHome, ...(run ? { run } : {}) });
        const status = await runtimeServiceStatus({
          root,
          home,
          serviceHome,
          fallbackProvider,
          ...(run ? { run } : {}),
        });
        if (result?.ok !== true) {
          const httpStatus = ['runtime_required', 'service_conflict', 'service_foreign'].includes(result?.reason) ? 409 : 500;
          return sendJson(res, httpStatus, {
            ok: false,
            action,
            dryRun,
            commands,
            reason: result?.reason ?? 'service_action_failed',
            message: result?.message ?? 'service action failed',
            current: result?.current ?? null,
            result,
            status,
          });
        }
        return sendJson(res, 200, { ok: true, action, dryRun, commands, result, status });
      } catch (error) {
        return sendJson(res, 500, { ok: false, action: svcAction[1], error: 'service_action_failed', message: String(error?.message ?? error) });
      }
    }

    // UX-2：自定义助手条目 CRUD（注册表 = 内置 ∪ `<home>/assistants.custom.json`；内置不可改删）
    const assistantsMatch = path.match(/^\/admin\/api\/assistants(?:\/([^/]+))?(\/remove)?$/);
    if (assistantsMatch) {
      const { addCustomAssistant, updateCustomAssistant, removeCustomAssistant } = await import('./clients.mjs');
      const id = assistantsMatch[1] ? decodeURIComponent(assistantsMatch[1]) : null;
      const isRemove = assistantsMatch[2] === '/remove';
      const input = parseJsonBody(body) ?? {};
      const opts = { home, cwd: process.cwd() };
      try {
        if (isRemove && id) {
          const result = await removeCustomAssistant(id, opts);
          return sendJson(res, result.ok ? 200 : 422, result);
        }
        if (req.method === 'POST' && !id) {
          const result = await addCustomAssistant(input, opts);
          return sendJson(res, result.ok ? 200 : 422, result);
        }
        if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
          const result = await updateCustomAssistant(id, input, opts);
          return sendJson(res, result.ok ? 200 : 422, result);
        }
        return sendJson(res, 405, { error: 'method_not_allowed', errorKey: 'invalid_action', message: '新增用 POST /admin/api/assistants；更新用 PUT/PATCH …/:id；删除用 POST …/:id/remove' });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: 'assistant_registry_failed', message: String(error?.message ?? error) });
      }
    }

    // H-1：「连接我的 AI 助手」接入 / 预览 / 回滚 / Skill / 验证（只并 mebular 键；备份 + 原子写 + 幂等）
    const cliAction = path.match(/^\/admin\/api\/clients\/([^/]+)\/(connect|rollback|skills|preview|verify|recheck)$/);
    if (cliAction) {
      const { connectClient, rollbackClient, installSkills, previewClient, verifyAssistant, listAssistantsAsync, assistantUserHome, daemonMcpUrl } = await import('./clients.mjs');
      const id = decodeURIComponent(cliAction[1]);
      const action = cliAction[2];
      const input = parseJsonBody(body) ?? {};
      // F-FIX-B：与本 serve 实例同一守护端点（HTTP /mcp）→ 条目/片段/写入都用它
      const mcpUrl = daemonMcpUrl({ host: req.headers?.host, encrypted: Boolean(req.socket?.encrypted) });
      const opts = { home, cwd: process.cwd(), mcpUrl };
      try {
        if (action === 'preview') return sendJson(res, 200, previewClient(id, opts));
        if (action === 'verify') {
          // 验证未过也是**有效结果**（体里带 ok/state/steps），故一律 200 由 UI 读 body
          const result = await verifyAssistant(id, {
            ...opts,
            ...(input.userConfirmedReload === true ? { userConfirmedReload: true } : {}),
            ...(typeof input.backupPath === 'string' ? { backupPath: input.backupPath } : {}),
          });
          return sendJson(res, 200, result);
        }
        if (action === 'connect') {
          const result = await connectClient(id, opts);
          return sendJson(res, result.ok ? 200 : 422, result);
        }
        if (action === 'recheck') {
          // F-FIX-A：桌面白名单已允许 `recheck`（服务端此前 404）。语义 = 单客户端**强制重探**：
          // 只读某条状态，但会真实探测（CLI/进程/文件），故与 preview/connect 同族走动作端点
          // （同一鉴权 + CSRF 管线），并强制 `refresh:true` 绕过缓存——避免 GET 被缓存/预取而看不到即时状态。
          const out = await listAssistantsAsync({ home, userHome: assistantUserHome(), cwd: process.cwd(), refresh: true, mcpUrl });
          const client = out.assistants.find((c) => c.id === id) ?? null;
          if (!client) return sendJson(res, 404, { ok: false, error: 'unknown_client', id });
          return sendJson(res, 200, { ok: true, client, cached: false });
        }
        if (action === 'rollback') {
          const result = await rollbackClient(id, { ...opts, ...(typeof input.backupPath === 'string' ? { backupPath: input.backupPath } : {}) });
          return sendJson(res, result.ok ? 200 : 422, result);
        }
        const result = await installSkills(id, { ...opts, repoRoot: process.cwd() });
        return sendJson(res, result.ok ? 200 : 422, result);
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: 'client_action_failed', message: String(error?.message ?? error) });
      }
    }

    return sendJson(res, 404, { error: 'not_found', path });
  }

  async function handleAdminWrite(req, res, path, body) {
    if (!WRITE_PATTERNS.some((re) => re.test(path))) return false;
    // H3：写请求仅允许 POST/PUT/PATCH
    if (!['POST', 'PUT', 'PATCH'].includes(req.method ?? '')) {
      return sendJson(res, 405, { error: 'method_not_allowed', message: '写端点仅接受 POST/PUT/PATCH' });
    }
    // H3：跨站点写防护——若浏览器带了 Origin，必须与本服务同源（CLI/脚本不带 Origin）
    const reqOrigin = req.headers.origin;
    if (typeof reqOrigin === 'string' && reqOrigin.length > 0 && reqOrigin !== origin) {
      return sendJson(res, 403, { error: 'forbidden', message: `跨站点写被拒（Origin=${reqOrigin}）` });
    }
    // 1) 鉴权（写操作要求 memory.admin）
    const check = await authenticate(req, Buffer.alloc(0), 'memory.admin');
    if (!check.ok) {
      res.statusCode = check.status;
      if (check.challenge) res.setHeader('www-authenticate', check.challenge);
      return sendJson(res, check.status, { error: 'unauthorized', message: check.message });
    }
    // 2) CSRF 双提交
    if (!csrfValid(req)) {
      return sendJson(res, 403, { error: 'forbidden', message: 'CSRF token 缺失或无效' });
    }
    // 3) D1：只读降级；D2 起由 applyAdminWrite 处理
    if (!writesEnabled || typeof applyAdminWrite !== 'function') {
      if (/^\/admin\/api\/clouds\/(join|rename|inspect)$/.test(path)) {
        return sendJson(res, 403, {
          ok: false,
          error: 'CLOUD_DISABLED',
          reason: 'read_only',
          message: '控制台处于只读模式：忆云写操作已禁用',
        });
      }
      return sendJson(res, 403, { error: 'forbidden', reason: 'console_read_only' });
    }
    return applyAdminWrite(req, res, path, body);
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const path = url.pathname;
      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : Buffer.alloc(0);

      if (path === '/healthz' && req.method === 'GET') {
        return sendJson(res, 200, {
          status: 'ok',
          name: 'mebular',
          version: APP_VERSION,
          auth,
          tls,
          // 实例身份：App 用 instance 校验端口上是不是目标忆云（200 但 instance 不符 = 另一张忆云）。
          instance: homeKey(home),
          ...(cloudId !== null ? { cloudId } : {}),
        });
      }
      // DSH 嵌入发现：匿名只读、无敏感信息；同样在 OAuth / /app 鉴权之前。
      if (path === '/app/embed/info') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
        res.setHeader('cache-control', 'no-store');
        return sendJson(res, 200, buildEmbedInfo({ origin, loopback: isLoopback }));
      }
      // 0.3 Runtime API：与 /mcp 同端口、同 bearer/OAuth/scope；未初始化时返回 503。
      if (isRuntimePath(path)) {
        return runtimeHttpHandler({ req, res, url, body });
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
      if (path === '/console' || path.startsWith('/console/')) {
        return handleConsole(req, res, url);
      }
      if (path === '/locales' || path.startsWith('/locales/')) {
        return handleLocales(req, res, url);
      }
      if (path === '/admin/events' && req.method === 'GET') {
        return handleAdminEvents(req, res, url);
      }
      // P1：热初始化完成后的重复 create/join —— 本进程曾处于引导态，返回结构化 409（不重启、不重复写盘）。
      // 普通正常实例仍保持「引导路径不泄漏」的 404 语义。
      if (phase === 'READY' && hotInitialized
        && (path === '/app/provision/create' || path === '/app/provision/join' || path === '/app/provision/restore')) {
        return sendJson(res, 409, {
          ok: false,
          error: 'already_provisioned',
          provisioned: true,
          initialized: true,
          restartRequired: false,
          message: '家目录已完成初始化：守护已在同一进程内进入正常态，无需重复建新 / 加入。',
        });
      }
      if (phase !== 'READY') {
        // 实际绑定端口（--port 0 时 port 参数为 0，但 listen 后系统已分配）
        const boundPort = (() => {
          const addr = server?.address();
          return typeof addr === 'object' && addr !== null ? addr.port : port;
        })();
        if (path === '/mcp') {
          // P2：UNINITIALIZED 也允许 MCP 握手/列表；tools/call 由统一 readiness guard 返回业务错误。
          return handleMcp(req, res, body);
        }
        if (path === '/admin/api/clients' && req.method === 'GET') {
          // P2：引导态只开放本机助手列表（不读 memory/network/admin 数据面）。
          return handleAdminRead(req, res, path, url);
        }
        if (UNINITIALIZED_CLIENT_ACTION.test(path)) {
          // P2：connect 只写本机助手配置；preview/verify/recheck 不触碰 app/service。
          // Origin + CSRF + 现有 auth scope 仍在 handleAdminWrite 内校验。
          const done = await handleAdminWrite(req, res, path, body);
          if (done !== false) return done;
        }
        if (path === '/app/provision/status' && req.method === 'GET') {
          return sendJson(res, 200, provisionStatus({
            home,
            mcpPort: boundPort,
            phase,
            provisioned: !isProvisionHome(home),
          }));
        }
        if (path === '/app/provision/create' || path === '/app/provision/join' || path === '/app/provision/restore') {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
          const reqOrigin = req.headers.origin;
          if (typeof reqOrigin === 'string' && reqOrigin.length > 0 && reqOrigin !== origin) {
            return sendJson(res, 403, { error: 'forbidden', message: `跨站点写被拒（Origin=${reqOrigin}）` });
          }
          if (!csrfValid(req)) return sendJson(res, 403, { error: 'forbidden', message: 'CSRF token 缺失或无效' });
          if (phase === 'INITIALIZING') {
            return sendJson(res, 409, { ok: false, error: 'initialization_in_progress', phase, message: '初始化正在进行，请稍候' });
          }
          if (!isProvisionHome(home)) {
            return sendJson(res, 409, {
              ok: false,
              error: 'already_provisioned',
              provisioned: true,
              initialized: false,
              restartRequired: false,
              message: '家目录已完成初始化：无需重复建新 / 加入。',
            });
          }
          const input = parseJsonBody(body) ?? {};
          if (input.confirm !== true) {
            return sendJson(res, 400, { error: 'confirmation_required', message: '需要 { confirm: true }（写入配置并由当前进程完成初始化）' });
          }
          if (typeof initializeRuntime !== 'function') {
            return sendJson(res, 500, {
              ok: false,
              error: 'initializer_unavailable',
              message: '当前服务器未装配热初始化执行器：请升级 / 重启 mebular serve',
            });
          }
          const action = path.endsWith('/create') ? 'create' : path.endsWith('/join') ? 'join' : 'restore';
          // 先占住 INITIALIZING，避免两个并发 create/join 都通过上面的 UNINITIALIZED 检查。
          phase = 'INITIALIZING';
          let transaction = null;
          try {
            transaction = await snapshotProvisionState(home, {
              storagePath: process.env.MEBULAR_STORAGE_PATH ?? join(home, 'store.jsonl'),
            });
            const result = action === 'create'
              ? await provisionCreate({
                home,
                deviceName: typeof input.deviceName === 'string' ? input.deviceName : undefined,
                ...(typeof input.cloudName === 'string' ? { cloudName: input.cloudName } : {}),
                ...(typeof input.deviceId === 'string' ? { deviceId: input.deviceId } : {}),
                mcpPort: boundPort,
                joinPort: input.joinPort,
                listenPort: input.listenPort,
              })
              : action === 'join'
                ? await provisionJoin({
                  home,
                  token: typeof input.token === 'string' ? input.token : '',
                  deviceName: typeof input.deviceName === 'string' ? input.deviceName : undefined,
                  mcpPort: boundPort,
                  joinPort: input.joinPort,
                  listenPort: input.listenPort,
                  timeoutMs: Number.isFinite(input.timeoutMs) ? input.timeoutMs : undefined,
                })
                : await provisionRestore({
                  home,
                  file: typeof input.file === 'string' ? input.file : '',
                  code: typeof input.code === 'string' ? input.code : '',
                  deviceName: typeof input.deviceName === 'string' ? input.deviceName : undefined,
                  ...(typeof input.cloudName === 'string' ? { cloudName: input.cloudName } : {}),
                  ...(typeof input.deviceId === 'string' ? { deviceId: input.deviceId } : {}),
                  mcpPort: boundPort,
                  joinPort: input.joinPort,
                  listenPort: input.listenPort,
                });
            await writeProvisionRecord(home, { ...result, at: new Date().toISOString() });
            const next = await initializeRuntime({
              action,
              result,
              server: {
                host,
                port: boundPort,
                auth,
                tls,
                tlsKey,
                tlsCert,
                tokensFile,
                writesEnabled,
              },
            });
            await activateRuntime(next, { viaHotInit: true });
            // 首次初始化成功：对已检测到的客户端 ensure Skill（后台执行；失败不阻断初始化响应）。
            void import('./clients.mjs')
              .then(({ autoEnsureSkills, assistantUserHome }) => autoEnsureSkills({ home, userHome: assistantUserHome(), cwd: process.cwd() }))
              .then((result) => {
                if (result?.summary?.failed > 0 || (result?.ok === false && result?.skipped !== true)) {
                  console.error(`SKILL_ENSURE_PENDING_REPAIR ${result?.reason ?? `${result?.summary?.failed ?? 1} client(s)`}`);
                }
              })
              .catch((error) => console.error(`SKILL_ENSURE_FAILED ${error?.code ?? 'ERROR'}`));
            // 自动自愈（主路径）：热初始化后实际端口已确定 → 只更新已存在的本机 loopback Mebular 条目。
            void import('./clients.mjs')
              .then(({ reconcileClientEndpoints, assistantUserHome, daemonMcpUrl }) => {
                const reconcileHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
                return reconcileClientEndpoints({
                  home,
                  userHome: assistantUserHome(),
                  cwd: process.cwd(),
                  mcpUrl: daemonMcpUrl({ host: `${reconcileHost}:${boundPort}`, encrypted: tls }),
                });
              })
              .then((result) => {
                if (result?.summary?.failed > 0) {
                  console.error(`CLIENT_ENDPOINT_RECONCILE_PARTIAL ${result.summary.failed} client(s)`);
                }
              })
              .catch((error) => console.error(`CLIENT_ENDPOINT_RECONCILE_FAILED ${error?.code ?? 'ERROR'}`));
            return sendJson(res, 200, {
              ok: true,
              ...result,
              initialized: true,
              phase: 'READY',
            });
          } catch (error) {
            // 回滚本次新建的落盘产物；home 锁仍由当前进程持有（不释放/不重抢）。
            await transaction?.rollback().catch(() => undefined);
            phase = 'UNINITIALIZED';
            const code = error?.code ?? 'provision_failed';
            const status = code === 'ALREADY_PROVISIONED' ? 409 : 400;
            return sendJson(res, status, {
              ok: false,
              error: code,
              phase,
              message: String(error?.message ?? error),
            });
          }
        }
        if (path.startsWith('/admin/api/') || path.startsWith('/admin/') || path === '/mcp' || path.startsWith('/app/')) {
          return sendJson(res, 409, {
            error: 'provision_required',
            provision: true,
            phase,
            message: '实例尚未初始化：请打开控制台完成「建新 Mebular / 加入已有 Mebular」',
          });
        }
        return sendJson(res, 404, { error: 'not_found', path });
      }
      if (path.startsWith('/admin/api/')) {
        if (req.method === 'GET' && (path === '/admin/api/security' || path === '/admin/api/security/approvals')) return handleSecurityRead(req, res);
        const planMatch = path.match(/^\/admin\/api\/namespaces\/([^/]+)\/handoff-plan$/);
        if (req.method === 'GET' && planMatch) {
          if (!app || !service) {
            return sendJson(res, 503, { error: 'console_unavailable', message: 'Mebular 尚未初始化' });
          }
          const check = await authenticate(req, Buffer.alloc(0), 'memory.read');
          if (!check.ok) {
            res.statusCode = check.status;
            if (check.challenge) res.setHeader('www-authenticate', check.challenge);
            return sendJson(res, check.status, { error: 'unauthorized', message: check.message });
          }
          const successor = url.searchParams.get('successor') ?? '';
          const out = await buildHandoffPlan({ app }, decodeURIComponent(planMatch[1]), successor);
          return sendJson(res, out.status, out.body);
        }
        if (req.method === 'GET' && READ_ROUTES[path]) return handleAdminRead(req, res, path, url);
        // 写端点路径：任何方法都交给 handleAdminWrite（非 POST/PUT/PATCH → 405；Origin/CSRF/scope 同处校验）
        if (WRITE_PATTERNS.some((re) => re.test(path))) {
          const done = await handleAdminWrite(req, res, path, body);
          if (done !== false) return;
        }
        return sendJson(res, 404, { error: 'not_found', path });
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
        // W2 A4：join 邀请（守护用自身身份生成令牌）
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
          const token = await buildJoinToken({
            mebular: app,
            deviceId,
            namespace: ns,
            endpoint,
            ttlMs,
            ...collectInviteHints(app, config),
          });
          await activateJoinInvite(joinStateStoragePath, token.nonce);
          const inline = Buffer.from(JSON.stringify(token), 'utf-8').toString('base64');
          return sendJson(res, 200, { ok: true, token: inline, endpoint, namespace: ns, expiresAt: token.expiresAt, nonce: token.nonce });
        }
        // W2：订阅（守护持有图表；fleet 客户端化）
        if (path === '/app/policy/subscriptions' && req.method === 'GET') {
          const device = url.searchParams.get('device');
          const ns = url.searchParams.get('namespace');
          if (device) {
            const namespaces = await app.getSubscriptions(device);
            return sendJson(res, 200, { ok: true, device, namespaces });
          }
          if (ns) {
            const subscriptions = await app.getNamespaceSubscriptions(ns);
            return sendJson(res, 200, { ok: true, namespace: ns, ...subscriptions });
          }
          return sendJson(res, 400, { ok: false, error: 'device 或 namespace 必填' });
        }
        if (path.startsWith('/app/policy/') && req.method === 'POST') {
          let payload;
          try {
            payload = JSON.parse(body.toString('utf-8') || '{}');
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid json' });
          }
          if (path === '/app/policy/subscription') {
            const ns = typeof payload.namespace === 'string' && payload.namespace ? payload.namespace : namespace;
            if (!ns) return sendJson(res, 400, { ok: false, error: 'namespace 必填' });
            const event = payload.active === false
              ? await app.unsubscribeNamespace(ns)
              : await app.subscribeNamespace(ns);
            return sendJson(res, 200, { ok: true, eventId: event.id, namespace: ns, active: payload.active !== false });
          }
          if (path === '/app/policy/namespace') {
            if (typeof payload.namespace !== 'string' || !payload.namespace) return sendJson(res, 400, { ok: false, error: 'namespace 必填' });
            const event = await app.declareNamespace({ namespace: payload.namespace, ...(typeof payload.note === 'string' ? { note: payload.note } : {}) });
            return sendJson(res, 200, { ok: true, eventId: event.id });
          }
        }
        return sendJson(res, 404, { ok: false, error: 'not_found', path });
      }
      if (path === '/mcp') {
        return handleMcp(req, res, body);
      }
      return sendJson(res, 404, { error: 'not_found', path });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: String(error?.message ?? error) });
      else res.end();
    }
  };

  // root 级硬单活：仅已初始化档案的守护获取（引导态 app/service 为空，不参与）。
  // 被活 PID 占用且 home 不同 → CLOUD_ALREADY_ACTIVE（复用 <home>/lock 的 PID 检查纪律）。
  activeLock = app && service && cloud.available
    ? await acquireActiveLock({ root: cloud.root, home, profileId: cloudId })
    : null;

  let server;
  try {
    if (tls) {
      server = https.createServer({ key: await readFile(tlsKey, 'utf-8'), cert: await readFile(tlsCert, 'utf-8') }, handler);
    } else {
      server = http.createServer(handler);
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
  } catch (error) {
    await activeLock?.release?.().catch(() => undefined);
    throw error;
  }
  const bound = server.address();
  const actualPort = bound.port;
  const actualHost = runtimeHost(typeof bound.address === 'string' && bound.address.length > 0 ? bound.address : host);
  origin = `${scheme}://${isLoopback ? '127.0.0.1' : host}:${actualPort}`;
  issuer = process.env.MEBULAR_OAUTH_ISSUER ?? origin;
  metadata = metadataFor(issuer, { registrationEnabled });
  // 发现信息只在 listen 成功后落盘；失败只影响自动发现，不影响守护启动。
  await writeRuntimeFile(home, {
    version: APP_VERSION,
    host: actualHost,
    port: actualPort,
    embedProtocol: EMBED_PROTOCOL,
  }).catch((error) => {
    console.error(`RUNTIME_FILE_WRITE_FAILED ${error?.code ?? 'ERROR'}`);
  });
  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      // 优雅停止的顺序很重要：MCP/SSE/keep-alive 连接不会自己断，
      // 先收 MCP sessions，再主动结束连接，最后才等 listener（带有限超时）。
      const deadline = Date.now() + CLOSE_TIMEOUT_MS;
      try {
        // 1) 先让每个 MCP session 的 transport/server 正常收尾。
        //    单个 session 卡住也不能拖死整个停止流程：最多等 SESSION_CLOSE_TIMEOUT_MS。
        const sessions = [...mcpSessions.values()];
        mcpSessions.clear();
        const sessionBudget = Math.max(0, Math.min(SESSION_CLOSE_TIMEOUT_MS, deadline - Date.now()));
        await Promise.all(sessions.map((entry) => settleWithin(
          Promise.resolve().then(() => entry.server.close()),
          sessionBudget,
        )));
        // 2) 结束空闲 keep-alive 与仍活跃的 SSE/streaming 连接，避免 server.close 永久等待。
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        // 3) 停止接受新连接；有限超时兜底，超时后强制断开并继续清理。
        await new Promise((resolve) => {
          let done = false;
          let timer = null;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve();
          };
          timer = setTimeout(() => {
            server.closeAllConnections?.();
            finish();
          }, Math.max(0, deadline - Date.now()));
          try {
            server.close(() => finish());
          } catch {
            finish();
          }
        });
      } finally {
        // 4) 无论前面如何都要清理；pid 守卫保证不误删新实例的 runtime.json。
        await clearRuntimeFile(home, { pid: process.pid }).catch(() => undefined);
        // 5) 保留最新 main 的生命周期收尾：root 单活锁 + 热初始化上下文（app/join/广播）。
        await activeLock?.release?.().catch(() => undefined);
        await onClose?.().catch(() => undefined);
      }
    })();
    return closePromise;
  };
  return {
    server,
    host,
    port: actualPort,
    auth,
    issuer,
    close,
    getState: () => ({ phase, hotInitialized, app, service, config, runtime, deviceId }),
  };
}
