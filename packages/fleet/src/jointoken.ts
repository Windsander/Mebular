// 信任模型 v2（T2）：加入令牌 + join 请求-签发（**embedded / test-only**）。
//
// W2 起：**生产 join 由守护托管**（`mebular serve` 的 `/mebular/join`，见 packages/mcp/src/jointoken.mjs）；
// 本文件仅供 **embedded 模式**（`--store embedded`，测试/CI）与 `fleet node --join-serve` 自托管使用。
//
// 设计（含用户修正：去中心化）：
// - **任意**在册设备都可作 inviter（无“指定主设备/CA”）；令牌由**inviter 设备私钥**签名。
// - 令牌只含**授权信息**（inviter 身份/证书链、用户主公钥、命名空间、nonce、TTL、endpoint），
//   **绝不含主密钥私钥**；主密钥可完全离线。
// - 过期（TTL）/ 一次性（nonce 已用）/ 被撕（显式撤销）三种吊销与**设备证书吊销**（`device_revoke` 级联）
//   分开：前者是准入凭据，后者是身份失效。
// - 服务端验令牌后，用 inviter 设备私钥为请求设备签发**委派证书**（1 跳；链上界由 core 强制）。

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import http, { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import {
  bytesToBase64,
  bytesToHex,
  hexToBytes,
  base64ToBytes,
  canonicalCertificateData,
  verifyCertificateChain,
  type DeviceCertificate,
  type Mebular,
} from '@mebular/core';

/** 令牌（inviter 设备私钥签名；不含主密钥）。 */
export interface JoinToken {
  v: 1;
  kind: 'mebular-fleet-join-token';
  inviterDeviceId: string;
  /** inviter 设备公钥（hex） */
  inviterPublicKey: string;
  /** inviter 的证书链（叶→根），供请求方与验签方锚定到主密钥 */
  inviterChain: DeviceCertificate[];
  /** 用户主公钥（hex；公开信息，非秘密） */
  masterPublicKey: string;
  namespace: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  /** join 服务端点（http(s)://host:port） */
  endpoint: string;
  /** inviter 设备私钥对 canonical 数据的签名（base64） */
  signature: string;
}

/** 令牌规范化签名内容（固定键序，排除 signature）。 */
export function canonicalJoinTokenData(token: Omit<JoinToken, 'signature'> & { signature?: string }): string {
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
  });
}

export function encodeJoinToken(token: JoinToken): string {
  return Buffer.from(JSON.stringify(token), 'utf-8').toString('base64');
}

export function decodeJoinToken(text: string): JoinToken {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error('令牌为空');
  const json = trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('令牌无法解析（既非 base64 也非 JSON）');
  }
  const t = parsed as Record<string, unknown>;
  if (t.v !== 1 || t.kind !== 'mebular-fleet-join-token') throw new Error('令牌版本/类型不受支持');
  for (const key of ['inviterDeviceId', 'inviterPublicKey', 'masterPublicKey', 'namespace', 'nonce', 'endpoint', 'signature']) {
    if (typeof t[key] !== 'string') throw new Error(`令牌缺少字段：${key}`);
  }
  if (typeof t.issuedAt !== 'number' || typeof t.expiresAt !== 'number') throw new Error('令牌时间字段非法');
  if (!Array.isArray(t.inviterChain) || t.inviterChain.length === 0) throw new Error('令牌缺少 inviter 证书链');
  return t as unknown as JoinToken;
}

/** 脱敏描述：**不含签名**，供日志/报告。 */
export function describeJoinToken(token: JoinToken): Record<string, unknown> {
  return {
    v: token.v,
    kind: token.kind,
    inviterDeviceId: token.inviterDeviceId,
    namespace: token.namespace,
    nonce: token.nonce,
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
    endpoint: token.endpoint,
    chainLen: token.inviterChain.length,
    hasMasterPrivateKey: false,
  };
}

/** 令牌 nonce 状态文件（本地；0600）。 */
export interface JoinNonceState {
  used: string[];
  revoked: string[];
}
export function joinNonceStatePath(storagePath: string): string {
  return `${storagePath}.join-tokens.json`;
}
export async function readJoinNonceState(storagePath: string): Promise<JoinNonceState> {
  try {
    const parsed = JSON.parse(await readFile(joinNonceStatePath(storagePath), 'utf-8')) as Partial<JoinNonceState>;
    return { used: Array.isArray(parsed.used) ? parsed.used : [], revoked: Array.isArray(parsed.revoked) ? parsed.revoked : [] };
  } catch {
    return { used: [], revoked: [] };
  }
}
export async function writeJoinNonceState(storagePath: string, state: JoinNonceState): Promise<void> {
  const path = joinNonceStatePath(storagePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows 无 POSIX mode；忽略
  }
}

/** 签发令牌（inviter 设备私钥）。 */
export async function buildJoinToken(input: {
  mebular: Mebular;
  deviceId: string;
  namespace: string;
  endpoint: string;
  ttlMs?: number;
  now?: number;
  nonce?: string;
}): Promise<JoinToken> {
  const identity = input.mebular.identity.getDeviceKey(input.deviceId);
  if (!identity) throw new Error(`本机无设备密钥：${input.deviceId}`);
  const chain = identity.certificateChain ?? (identity.certificate ? [identity.certificate] : []);
  if (chain.length === 0) throw new Error('本机无有效证书链，无法签发令牌（先 onboard/join）');
  const masterPub = input.mebular.identity.getUserMasterPublicKey();
  if (!masterPub) throw new Error('本机无用户主公钥，无法签发令牌');
  const now = input.now ?? Date.now();
  const unsigned: Omit<JoinToken, 'signature'> = {
    v: 1,
    kind: 'mebular-fleet-join-token',
    inviterDeviceId: input.deviceId,
    inviterPublicKey: bytesToHex(identity.publicKey),
    inviterChain: chain,
    masterPublicKey: bytesToHex(masterPub),
    namespace: input.namespace,
    nonce: input.nonce ?? randomBytes(16).toString('hex'),
    issuedAt: now,
    expiresAt: now + (input.ttlMs ?? 900_000),
    endpoint: input.endpoint,
  };
  const signature = await globalThis.crypto.subtle.sign(
    { name: 'Ed25519' },
    identity.privateKey,
    new TextEncoder().encode(canonicalJoinTokenData(unsigned)),
  );
  return { ...unsigned, signature: bytesToBase64(new Uint8Array(signature)) };
}

export interface VerifyJoinTokenOptions {
  now?: number;
  used?: readonly string[];
  revoked?: readonly string[];
  /** 仅接受该 inviter（join 服务端 = 本机时使用） */
  expectedInviter?: string;
}

export type JoinTokenFailure =
  | 'signature'
  | 'chain'
  | 'inviter'
  | 'expired'
  | 'used'
  | 'revoked';

/** 校验令牌：签名 → 链锚定主密钥 → inviter 匹配 → TTL → 一次性 → 撕票。 */
export async function verifyJoinToken(
  token: JoinToken,
  opts: VerifyJoinTokenOptions = {},
): Promise<{ ok: true } | { ok: false; reason: JoinTokenFailure }> {
  // 1) 签名（inviter 设备公钥）
  try {
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      hexToBytes(token.inviterPublicKey).buffer as ArrayBuffer,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const ok = await globalThis.crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      base64ToBytes(token.signature).buffer as ArrayBuffer,
      new TextEncoder().encode(canonicalJoinTokenData(token)),
    );
    if (!ok) return { ok: false, reason: 'signature' };
  } catch {
    return { ok: false, reason: 'signature' };
  }
  // 2) inviter 证书链锚定主密钥
  const chainOk = await verifyCertificateChain(token.inviterChain, hexToBytes(token.masterPublicKey), {
    subjectDeviceId: token.inviterDeviceId,
  });
  if (!chainOk) return { ok: false, reason: 'chain' };
  // 3) inviter 匹配
  if (opts.expectedInviter !== undefined && token.inviterDeviceId !== opts.expectedInviter) {
    return { ok: false, reason: 'inviter' };
  }
  // 4) TTL（inviter/服务端时钟为准）
  const now = opts.now ?? Date.now();
  if (!(now <= token.expiresAt)) return { ok: false, reason: 'expired' };
  // 5) 一次性 / 撕票
  if ((opts.used ?? []).includes(token.nonce)) return { ok: false, reason: 'used' };
  if ((opts.revoked ?? []).includes(token.nonce)) return { ok: false, reason: 'revoked' };
  return { ok: true };
}

/** inviter 证书链的指纹（诊断/去重；非密钥材料）。 */
export function chainFingerprint(chain: readonly DeviceCertificate[]): string {
  const leaf = chain[0];
  const material = canonicalCertificateData(leaf!) + (chain[chain.length - 1]?.deviceId ?? '');
  return `sha256:${createHash('sha256').update(material).digest('hex').slice(0, 12)}`;
}

// ---------- join 服务端（最小监听端点） ----------

export interface JoinServiceOptions {
  mebular: Mebular;
  deviceId: string;
  storagePath: string;
  /** 绑定地址（默认 0.0.0.0）；令牌是 bearer，建议 LAN + 短 TTL */
  bind?: string;
  /** 端口（默认 0 = 随机；quickstart 默认 4002） */
  port: number;
  log?: (msg: string) => void;
}

export interface JoinService {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage, limitBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8');
      if (data.length > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

/**
 * 启动 join 服务：`POST /mebular/join {token, deviceId, devicePublicKey}` → 验令牌后签发**委派证书**。
 * `GET /mebular/ping` 用于就绪探测。**不接收、不返回任何主密钥材料**。
 */
/** 每 storagePath 的非一路串行锁：令牌「先占用后签发」在**单服务进程内**原子（跨进程见文档披露）。 */
const nonceLocks = new Map<string, Promise<unknown>>();
function withNonceLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = nonceLocks.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  nonceLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export async function startJoinService(opts: JoinServiceOptions): Promise<JoinService> {
  const bind = opts.bind ?? '0.0.0.0';
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === 'GET' && req.url === '/mebular/ping') {
          sendJson(res, 200, { ok: true, deviceId: opts.deviceId });
          return;
        }
        if (req.method !== 'POST' || req.url !== '/mebular/join') {
          sendJson(res, 404, { ok: false, error: 'not found' });
          return;
        }
        const body = JSON.parse(await readBody(req)) as {
          token?: string;
          deviceId?: string;
          devicePublicKey?: string;
        };
        if (typeof body.token !== 'string' || typeof body.deviceId !== 'string' || typeof body.devicePublicKey !== 'string') {
          sendJson(res, 400, { ok: false, error: '缺少 token/deviceId/devicePublicKey' });
          return;
        }
        const token = decodeJoinToken(body.token);
        const deviceId = body.deviceId;
        const devicePublicKey = body.devicePublicKey;
        if (!/^[0-9a-fA-F]{64}$/.test(devicePublicKey)) {
          sendJson(res, 400, { ok: false, error: 'devicePublicKey 必须为 32 字节 hex' });
          return;
        }
        // F-2：令牌「一次性」在**单服务进程内**原子（先占用后签发），并发不再重复签发。
        await withNonceLock(opts.storagePath, async () => {
          const state = await readJoinNonceState(opts.storagePath);
          const verdict = await verifyJoinToken(token, {
            used: state.used,
            revoked: state.revoked,
            expectedInviter: opts.deviceId,
          });
          if (!verdict.ok) {
            sendJson(res, 403, { ok: false, error: `令牌不可用：${verdict.reason}` });
            return;
          }
          // **先占用**（落盘 used）再签发：签发失败即 fail-closed（令牌已消费，不二次签发）。
          state.used.push(token.nonce);
          await writeJoinNonceState(opts.storagePath, state);
          try {
            const issued = await opts.mebular.identity.issueDelegatedCertificateFor(deviceId, devicePublicKey, opts.deviceId);
            opts.log?.(`join: issued delegated cert for ${deviceId} (nonce consumed)`);
            sendJson(res, 200, {
              ok: true,
              certificate: issued.certificate,
              chain: issued.certificateChain,
              namespace: token.namespace,
              inviterDeviceId: token.inviterDeviceId,
              inviterMultiaddrs: opts.mebular.node?.getLocalMultiaddrs() ?? [],
            });
          } catch (error) {
            opts.log?.(`join: nonce ${token.nonce} consumed but issuance failed: ${(error as Error).message}`);
            sendJson(res, 500, { ok: false, error: '签发失败（令牌已消费，fail-closed）' });
          }
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: (error as Error).message });
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: bind === '0.0.0.0' ? undefined : bind, port: opts.port }, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------- join 客户端 ----------

export interface JoinRequestResult {
  certificate: DeviceCertificate;
  chain: DeviceCertificate[];
  namespace: string;
  inviterDeviceId: string;
  inviterMultiaddrs: string[];
}

/** B 持令牌向 inviter 的 join 端点请求委派证书（纯 HTTP；令牌是 bearer）。 */
export async function requestJoin(input: {
  endpoint: string;
  token: string;
  deviceId: string;
  devicePublicKeyHex: string;
  timeoutMs?: number;
}): Promise<JoinRequestResult> {
  const url = new URL('/mebular/join', input.endpoint);
  const payload = JSON.stringify({ token: input.token, deviceId: input.deviceId, devicePublicKey: input.devicePublicKeyHex });
  return await new Promise<JoinRequestResult>((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res: IncomingMessage) => {
        let data = '';
        res.on('data', (c: Buffer) => (data += c.toString('utf-8')));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { ok?: boolean; error?: string } & Partial<JoinRequestResult>;
            if (res.statusCode !== 200 || parsed.ok !== true) {
              reject(new Error(`join 失败（HTTP ${res.statusCode}）：${parsed.error ?? '未知错误'}`));
              return;
            }
            resolve({
              certificate: parsed.certificate!,
              chain: parsed.chain!,
              namespace: parsed.namespace!,
              inviterDeviceId: parsed.inviterDeviceId!,
              inviterMultiaddrs: parsed.inviterMultiaddrs ?? [],
            });
          } catch (error) {
            reject(new Error(`join 响应无法解析：${(error as Error).message}`));
          }
        });
      },
    );
    req.setTimeout(input.timeoutMs ?? 15_000, () => req.destroy(new Error('join 请求超时')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
