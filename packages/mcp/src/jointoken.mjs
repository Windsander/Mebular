// W2：守护侧加入令牌与 join 服务（**与 @mebular/fleet/src/jointoken.ts 线格式逐字段一致**）。
//
// 为何在此重复一份：`@mebular/mcp` 发布 tarball 仅依赖 `@mebular/core`（D41 只改写 core），
// 引入 `@mebular/fleet` 会破坏 pack/install。故按**同一格式**在守护内实现；跨包一致性由
// `tests/mcp/jointoken-parity.test.ts` 双向断言（fleet↔daemon 互验）防漂移。

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { bytesToBase64, bytesToHex, base64ToBytes, hexToBytes, verifyCertificateChain } from '@mebular/core';

export function canonicalJoinTokenData(token) {
  // 键序固定；C2 可选 hints 仅在存在时进入签名体（旧令牌签名不变）——须与 fleet 侧逐字段一致。
  return JSON.stringify({
    v: token.v,
    kind: token.kind,
    inviterDeviceId: token.inviterDeviceId,
    inviterPublicKey: token.inviterPublicKey,
    inviterChain: token.inviterChain,
    masterPublicKey: token.masterPublicKey,
    namespace: token.namespace,
    nonce: token.nonce,
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
    endpoint: token.endpoint,
    ...(token.endpoints !== undefined ? { endpoints: token.endpoints } : {}),
    ...(token.relaySeeds !== undefined ? { relaySeeds: token.relaySeeds } : {}),
    ...(token.pubReachable !== undefined ? { pubReachable: token.pubReachable } : {}),
  });
}

export function decodeJoinToken(text) {
  const trimmed = String(text).trim();
  if (trimmed.length === 0) throw new Error('令牌为空');
  const json = trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf-8');
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('令牌无法解析（既非 base64 也非 JSON）');
  }
  if (parsed.v !== 1 || parsed.kind !== 'mebular-fleet-join-token') throw new Error('令牌版本/类型不受支持');
  for (const key of ['inviterDeviceId', 'inviterPublicKey', 'masterPublicKey', 'namespace', 'nonce', 'endpoint', 'signature']) {
    if (typeof parsed[key] !== 'string') throw new Error(`令牌缺少字段：${key}`);
  }
  if (typeof parsed.issuedAt !== 'number' || typeof parsed.expiresAt !== 'number') throw new Error('令牌时间字段非法');
  if (!Array.isArray(parsed.inviterChain) || parsed.inviterChain.length === 0) throw new Error('令牌缺少 inviter 证书链');
  // C2：可选 hints 形状校验（缺省合法；非法即拒）
  if (parsed.endpoints !== undefined && (!Array.isArray(parsed.endpoints) || parsed.endpoints.some((e) => typeof e !== 'string'))) {
    throw new Error('令牌 endpoints 形状非法（应为字符串数组）');
  }
  if (parsed.relaySeeds !== undefined && (!Array.isArray(parsed.relaySeeds) || parsed.relaySeeds.some((e) => typeof e !== 'string'))) {
    throw new Error('令牌 relaySeeds 形状非法（应为字符串数组）');
  }
  if (parsed.pubReachable !== undefined && typeof parsed.pubReachable !== 'boolean') {
    throw new Error('令牌 pubReachable 形状非法（应为布尔）');
  }
  return parsed;
}

export async function buildJoinToken({
  mebular,
  deviceId,
  namespace,
  endpoint,
  ttlMs = 900_000,
  now = Date.now(),
  nonce = randomBytes(16).toString('hex'),
  endpoints,
  relaySeeds,
  pubReachable,
}) {
  const identity = mebular.identity.getDeviceKey(deviceId);
  if (!identity) throw new Error(`本机无设备密钥：${deviceId}`);
  const chain = identity.certificateChain ?? (identity.certificate ? [identity.certificate] : []);
  if (chain.length === 0) throw new Error('本机无有效证书链，无法签发令牌');
  const masterPub = mebular.identity.getUserMasterPublicKey();
  if (!masterPub) throw new Error('本机无用户主公钥，无法签发令牌');
  const unsigned = {
    v: 1,
    kind: 'mebular-fleet-join-token',
    inviterDeviceId: deviceId,
    inviterPublicKey: bytesToHex(identity.publicKey),
    inviterChain: chain,
    masterPublicKey: bytesToHex(masterPub),
    namespace,
    nonce,
    issuedAt: now,
    expiresAt: now + ttlMs,
    endpoint,
  };
  // C2：邀请方可达 P2P 地址（缺省自动收集）+ 可选 relay seeds + pubReachable
  const hintEndpoints = endpoints ?? collectReachableEndpoints(mebular);
  const hintSeeds = relaySeeds ?? collectRelaySeeds(mebular);
  if (hintEndpoints.length > 0) unsigned.endpoints = hintEndpoints;
  if (hintSeeds.length > 0) unsigned.relaySeeds = hintSeeds;
  const reachable = pubReachable ?? hintEndpoints.some((addr) => !isLoopbackAddress(addr));
  if (hintEndpoints.length > 0 || pubReachable !== undefined) unsigned.pubReachable = reachable;
  const signature = await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, identity.privateKey, new TextEncoder().encode(canonicalJoinTokenData(unsigned)));
  return { ...unsigned, signature: bytesToBase64(new Uint8Array(signature)) };
}

export async function verifyJoinToken(token, { now = Date.now(), used = [], revoked = [], expectedInviter } = {}) {
  try {
    const key = await globalThis.crypto.subtle.importKey('raw', hexToBytes(token.inviterPublicKey).buffer, { name: 'Ed25519' }, false, ['verify']);
    const ok = await globalThis.crypto.subtle.verify({ name: 'Ed25519' }, key, base64ToBytes(token.signature).buffer, new TextEncoder().encode(canonicalJoinTokenData(token)));
    if (!ok) return { ok: false, reason: 'signature' };
  } catch {
    return { ok: false, reason: 'signature' };
  }
  const chainOk = await verifyCertificateChain(token.inviterChain, hexToBytes(token.masterPublicKey), { subjectDeviceId: token.inviterDeviceId });
  if (!chainOk) return { ok: false, reason: 'chain' };
  if (expectedInviter !== undefined && token.inviterDeviceId !== expectedInviter) return { ok: false, reason: 'inviter' };
  if (!(now <= token.expiresAt)) return { ok: false, reason: 'expired' };
  if (used.includes(token.nonce)) return { ok: false, reason: 'used' };
  if (revoked.includes(token.nonce)) return { ok: false, reason: 'revoked' };
  return { ok: true };
}

/** C2：本机可达 P2P 地址（与 fleet 侧同实现；供守护签发令牌时携带 hints）。 */
export function collectReachableEndpoints(mebular) {
  const node = mebular?.node;
  if (!node || (typeof node.isRunning === 'function' && !node.isRunning())) return [];
  const peerId = node.peerId?.id;
  const addrs = typeof node.getLocalMultiaddrs === 'function' ? node.getLocalMultiaddrs() : [];
  const out = [];
  for (const addr of addrs) {
    if (typeof addr !== 'string' || addr.includes('/p2p-circuit')) continue;
    const withPeer = /\/p2p\//.test(addr) || !peerId ? addr : `${addr}/p2p/${peerId}`;
    if (!out.includes(withPeer)) out.push(withPeer);
  }
  return out;
}

/** C2：可共享的 relay seeds（app 已把 network.relaySeeds 并入 relayServers）。 */
export function collectRelaySeeds(mebular) {
  const seeds = mebular?.relayServers;
  return Array.isArray(seeds) ? seeds.filter((entry) => typeof entry === 'string' && entry.length > 0) : [];
}

/** 地址是否为回环（pubReachable 提示用）。 */
export function isLoopbackAddress(address) {
  const host = /\/(?:ip4|ip6|dns4|dns6|dns)\/([^/]+)/.exec(String(address))?.[1] ?? '';
  return ['127.0.0.1', '::1', 'localhost', ''].includes(host) || host.startsWith('127.');
}

export function joinNonceStatePath(storagePath) {
  return `${storagePath}.join-tokens.json`;
}
export async function readJoinNonceState(storagePath) {
  try {
    const parsed = JSON.parse(await readFile(joinNonceStatePath(storagePath), 'utf-8'));
    return { used: Array.isArray(parsed.used) ? parsed.used : [], revoked: Array.isArray(parsed.revoked) ? parsed.revoked : [] };
  } catch {
    return { used: [], revoked: [] };
  }
}
export async function writeJoinNonceState(storagePath, state) {
  const path = joinNonceStatePath(storagePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c.toString('utf-8');
      if (data.length > limit) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
const nonceLocks = new Map();
function withNonceLock(key, fn) {
  const prev = nonceLocks.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  nonceLocks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

/** 守护 join 服务：验令牌后签发委派证书（先占用 nonce 再签发，fail-closed）。 */
export async function createJoinServer({ mebular, deviceId, storagePath, bind = '0.0.0.0', port, log }) {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === 'GET' && req.url === '/mebular/ping') return sendJson(res, 200, { ok: true, deviceId });
        if (req.method !== 'POST' || req.url !== '/mebular/join') return sendJson(res, 404, { ok: false, error: 'not found' });
        const body = JSON.parse(await readBody(req));
        if (typeof body.token !== 'string' || typeof body.deviceId !== 'string' || typeof body.devicePublicKey !== 'string') {
          return sendJson(res, 400, { ok: false, error: '缺少 token/deviceId/devicePublicKey' });
        }
        const token = decodeJoinToken(body.token);
        if (!/^[0-9a-fA-F]{64}$/.test(body.devicePublicKey)) return sendJson(res, 400, { ok: false, error: 'devicePublicKey 必须为 32 字节 hex' });
        await withNonceLock(storagePath, async () => {
          const state = await readJoinNonceState(storagePath);
          const verdict = await verifyJoinToken(token, { used: state.used, revoked: state.revoked, expectedInviter: deviceId });
          if (!verdict.ok) return sendJson(res, 403, { ok: false, error: `令牌不可用：${verdict.reason}` });
          state.used.push(token.nonce);
          await writeJoinNonceState(storagePath, state);
          try {
            const issued = await mebular.identity.issueDelegatedCertificateFor(body.deviceId, body.devicePublicKey, deviceId);
            log?.(`join: issued delegated cert for ${body.deviceId} (nonce consumed)`);
            sendJson(res, 200, {
              ok: true,
              certificate: issued.certificate,
              chain: issued.certificateChain,
              namespace: token.namespace,
              inviterDeviceId: token.inviterDeviceId,
              inviterMultiaddrs: mebular.node?.getLocalMultiaddrs() ?? [],
            });
          } catch (error) {
            log?.(`join: nonce ${token.nonce} consumed but issuance failed: ${(error).message}`);
            sendJson(res, 500, { ok: false, error: '签发失败（令牌已消费，fail-closed）' });
          }
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: (error).message });
      }
    })();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: bind === '0.0.0.0' ? undefined : bind, port }, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  return { port: actualPort, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export function chainFingerprint(chain) {
  const leaf = chain[0];
  const material = JSON.stringify(leaf) + (chain[chain.length - 1]?.deviceId ?? '');
  return `sha256:${createHash('sha256').update(material).digest('hex').slice(0, 12)}`;
}
