// 安全三档（S2）：TOTP（中档）、恢复码/break-glass、主密钥备份/恢复、写端点门禁。
//
// 口径（SECURITY-TIERS-SPEC v1.1）：
// - TOTP：RFC 6238 / HMAC-SHA-1 / 6 位 / 30s / ±1 步；重放按 lastAcceptedStep；15 分钟 5 次失败锁定 15 分钟；
//   失败按 1/2/4/8…s（上限 30s）指数退避。
// - 种子：`<home>/security-totp.json`（0600，**绝不**进事件/日志/同步）；校验状态 `<home>/security-totp.json.state`。
// - 恢复码：20B CSPRNG → Crockford base32 32 字符 + 2 校验字符；HKDF-SHA256 → Ed25519；
//   密钥材料绝不落盘（只在生成时一次性显示）。
// - 备份：scrypt(N=32768,r=8,p=1) + AES-256-GCM；文件 0600；默认只含主密钥材料。
// - 记录形状严格按 SPEC §1.1 / §3.1 / §3.6 / §2.6。S1 未合并时写记录仍按冻结形状落 `__policy__`，
//   读档位一律按 low（特性探测：缺 `getSecurityTier()` 不炸、不放宽）。

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  randomUUID,
  scryptSync,
  sign as ed25519Sign,
  timingSafeEqual,
  verify as ed25519Verify,
} from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { POLICY_NAMESPACE, type DeviceCertificate } from '@mebular/core';
import {
  fleetConfigPath,
  identityDeviceIdForStorage,
  loadFleetConfig,
  masterKeyFingerprint,
  permissionsApplicable,
  readMasterKeyFile,
  type FleetAgentConfig,
} from './config.js';
import { onboardDevice } from './onboard.js';
import { renderTerminalQr, renderSvgQr } from './qr.js';

export const SECURITY_TIER_EVENT = 'security_tier';
export const SECURITY_APPROVAL_EVENT = 'security_approval';
export const SECURITY_RECOVERY_EVENT = 'security_recovery';
export const SECURITY_TOTP_EVENT = 'security_totp';

export const SECURITY_TOTP_FILE = 'security-totp.json';
export const SECURITY_TOTP_STATE_FILE = 'security-totp.json.state';

export const TOTP_STEP_MS = 30_000;
export const TOTP_WINDOW_STEPS = 1;
export const TOTP_MAX_FAILURES = 5;
export const TOTP_FAILURE_WINDOW_MS = 15 * 60_000;
export const TOTP_LOCK_MS = 15 * 60_000;
export const TOTP_BACKOFF_MAX_MS = 30_000;

export type SecurityLevel = 'low' | 'medium' | 'high';

export interface SecurityTierState {
  level: SecurityLevel;
  changedAt?: number;
  changedBy?: string;
  admitted: string[];
  recoveryKeyId?: string;
  rejections: Array<{ eventId: string; reason: string }>;
}

/** `getSecurityTier()` 缺失时的保守读档（低档），并带特性探测标记。 */
export interface SecurityStateView extends SecurityTierState {
  coreTierAvailable: boolean;
}

export interface SecurityRejection {
  eventId: string;
  reason: string;
}

export interface CosignProof {
  v: 1;
  op: SecurityAction;
  approver: string;
  approverCertificateChain: DeviceCertificate[];
  approvalId: string;
  digest: string;
  pairingCode: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export interface BreakGlassProof {
  v: 1;
  op: SecurityAction;
  keyId: string;
  digest: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export interface SecurityTierRecord {
  level: SecurityLevel;
  nonce: string;
  issuedAt: number;
  note?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
}

export interface SecurityApprovalRecord {
  approvalId: string;
  op: SecurityAction;
  decision: 'request' | 'approve' | 'deny';
  initiator: string;
  target?: string;
  namespace?: string;
  level?: SecurityLevel;
  nonce: string;
  digest: string;
  pairingCode: string;
  cosign?: CosignProof;
  expiresAt: number;
  issuedAt: number;
  note?: string;
}

export interface SecurityRecoveryRecord {
  keyId: string;
  publicKey: string;
  createdAt: number;
  mode: 'set' | 'rotate';
  /** rotate 的动作 nonce（进入 digest；`set` 可缺省）。 */
  nonce?: string;
  note?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
}

export interface SecurityTotpRecord {
  device: string;
  fingerprint: string;
  epoch?: string;
  issuedAt: number;
  note?: string;
}

export type SecurityAction = 'kick' | 'join' | 'tier' | 'rotate' | 'restore';

export interface SecurityActionParams {
  op: SecurityAction;
  initiator: string;
  subject?: string;
  namespace?: string;
  level?: SecurityLevel;
  oldKeyId?: string;
  newPublicKey?: string;
  nonce: string;
}

export interface SecurityApp {
  deviceId?: string;
  eventLog?: {
    append(event: Record<string, unknown>): Promise<{ id: string }>;
    listEvents(filter?: Record<string, unknown>): Promise<Array<PolicyEvent>>;
  };
  getSecurityTier?: (...args: any[]) => Promise<unknown>;
  setSecurityTier?: (...args: any[]) => Promise<unknown>;
  getBlockedDevices?: (...args: any[]) => Promise<unknown>;
  revokeDevice?: (...args: any[]) => Promise<unknown>;
  restoreDevice?: (...args: any[]) => Promise<unknown>;
  identity?: any;
}

export interface PolicyEvent {
  id: string;
  type: string;
  author?: string;
  timestamp?: number;
  data?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// 通用 IO（0600）
// ---------------------------------------------------------------------------

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  if (permissionsApplicable()) await chmod(path, 0o700).catch(() => undefined);
}

/** 原子写 0600（先写临时文件再 rename；失败不留半成品）。 */
export async function writePrivateFile(path: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    if (permissionsApplicable()) await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readPrivateJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

// ---------------------------------------------------------------------------
// base32 / Crockford
// ---------------------------------------------------------------------------

const RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += RFC4648_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += RFC4648_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

export function base32Decode(input: string): Uint8Array {
  const normalized = String(input)
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/=+$/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of normalized) {
    const index = RFC4648_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`base32 非法字符：${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function normalizeCrockford(input: string): string {
  return String(input)
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

export function crockfordEncode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

export function crockfordDecode(input: string): Uint8Array {
  const normalized = normalizeCrockford(input);
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of normalized) {
    const index = CROCKFORD_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`恢复码非法字符：${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

export interface TotpSeedRecord {
  v: 1;
  secret: string;
  createdAt: number;
  fingerprint: string;
}

export interface TotpVerifyState {
  v: 1;
  failures: number;
  windowStartedAt: number;
  lockedUntil: number;
  backoffUntil: number;
  lastAcceptedStep: number;
  lastAcceptedAt: number;
  updatedAt: number;
}

export interface TotpStatus {
  imported: boolean;
  fingerprint?: string;
  createdAt?: number;
  failures: number;
  lockedUntil: number;
  backoffUntil: number;
  lastAcceptedAt: number;
}

const EMPTY_TOTP_STATE = (): TotpVerifyState => ({
  v: 1,
  failures: 0,
  windowStartedAt: 0,
  lockedUntil: 0,
  backoffUntil: 0,
  lastAcceptedStep: -1,
  lastAcceptedAt: 0,
  updatedAt: 0,
});

export function totpFingerprint(secret: string): string {
  return createHash('sha256').update(base32Decode(secret)).digest('hex').slice(0, 8);
}

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function totpOtpauthUri(secret: string, deviceId: string, issuer = 'Mebular'): string {
  const label = `${issuer}:${deviceId}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(TOTP_STEP_MS / 1000),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/** 解析纯 base32 / otpauth URI；返回 secret（base32）与可选元数据。 */
export function parseTotpInput(input: string): { secret: string; issuer?: string; label?: string } {
  const raw = String(input ?? '').trim();
  if (raw.length === 0) throw new Error('动态码种子为空');
  if (raw.startsWith('otpauth://')) {
    const url = new URL(raw);
    if (url.host !== 'totp') throw new Error('仅支持 otpauth://totp/…');
    const secret = (url.searchParams.get('secret') ?? '').toUpperCase().replace(/[\s-]+/g, '');
    if (secret.length === 0) throw new Error('otpauth URI 缺少 secret');
    const digits = url.searchParams.get('digits');
    const period = url.searchParams.get('period');
    const algorithm = url.searchParams.get('algorithm');
    if (digits !== null && digits !== '6') throw new Error('仅支持 digits=6');
    if (period !== null && period !== '30') throw new Error('仅支持 period=30');
    if (algorithm !== null && algorithm.toUpperCase() !== 'SHA1') throw new Error('仅支持 algorithm=SHA1');
    const issuer = url.searchParams.get('issuer') ?? undefined;
    const label = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || undefined;
    return { secret, ...(issuer !== undefined ? { issuer } : {}), ...(label !== undefined ? { label } : {}) };
  }
  // 分组文本：允许空格/连字符/等号
  return { secret: raw.toUpperCase().replace(/[\s-]+/g, '').replace(/=+$/g, '') };
}

export function totpCodeAt(secret: string, step: number): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = ((hmac[offset]! & 0x7f) << 24)
    | (hmac[offset + 1]! << 16)
    | (hmac[offset + 2]! << 8)
    | hmac[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

export async function readTotpSeed(dir: string): Promise<TotpSeedRecord | null> {
  const record = await readPrivateJson<TotpSeedRecord>(join(dir, SECURITY_TOTP_FILE));
  if (record === null) return null;
  if (record.v !== 1 || typeof record.secret !== 'string' || typeof record.fingerprint !== 'string') {
    throw new Error('security-totp.json 形状非法');
  }
  return record;
}

export async function writeTotpSeed(dir: string, secret: string, createdAt = Date.now()): Promise<TotpSeedRecord> {
  const record: TotpSeedRecord = { v: 1, secret, createdAt, fingerprint: totpFingerprint(secret) };
  await writePrivateFile(join(dir, SECURITY_TOTP_FILE), JSON.stringify(record, null, 2));
  return record;
}

/** 导入种子；`expectedFingerprint` 不一致即拒绝（防导入错误/被替换）。 */
export async function importTotpSeed(
  dir: string,
  input: string,
  options: { expectedFingerprint?: string } = {},
): Promise<TotpSeedRecord> {
  const { secret } = parseTotpInput(input);
  try {
    base32Decode(secret);
  } catch {
    throw new Error('动态码种子不是合法 base32');
  }
  const fingerprint = totpFingerprint(secret);
  if (options.expectedFingerprint !== undefined
    && options.expectedFingerprint.toLowerCase().replace(/^sha256:/, '') !== fingerprint) {
    throw new Error(`指纹不一致：期望 ${options.expectedFingerprint}，实际 ${fingerprint}`);
  }
  return writeTotpSeed(dir, secret);
}

async function readTotpState(path: string | undefined): Promise<TotpVerifyState> {
  if (path === undefined) return EMPTY_TOTP_STATE();
  const state = await readPrivateJson<TotpVerifyState>(path);
  if (state === null) return EMPTY_TOTP_STATE();
  return { ...EMPTY_TOTP_STATE(), ...state, v: 1 };
}

async function writeTotpState(path: string | undefined, state: TotpVerifyState): Promise<void> {
  if (path === undefined) return;
  await writePrivateFile(path, JSON.stringify(state, null, 2));
}

export function totpStatePath(dir: string): string {
  return join(dir, SECURITY_TOTP_STATE_FILE);
}

export interface VerifyTotpOptions {
  /** home 目录：状态落 `<home>/security-totp.json.state`。缺省不持久化（仅纯函数校验）。 */
  dir?: string;
  statePath?: string;
  /** 测试注入：失败退避延时；默认真实 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  maxFailures?: number;
  windowMs?: number;
  lockMs?: number;
}

export type TotpFailureReason = 'invalid' | 'replay' | 'locked' | 'malformed' | 'missing';

export interface VerifyTotpResult {
  ok: boolean;
  driftStep?: number;
  reason?: TotpFailureReason;
  retryAfterMs?: number;
  lockedUntil?: number;
  failures?: number;
}

const sleepDefault = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 校验 TOTP（±1 步）。状态持久化时同时执行重放/限次/退避。
 * 注意：`now` 是逻辑时间；测试可注入固定值 + 空 sleep。
 */
export async function verifyTotp(
  secret: string,
  code: string,
  now: number = Date.now(),
  options: VerifyTotpOptions = {},
): Promise<VerifyTotpResult> {
  const statePath = options.statePath ?? (options.dir !== undefined ? totpStatePath(options.dir) : undefined);
  const sleep = options.sleep ?? sleepDefault;
  const maxFailures = options.maxFailures ?? TOTP_MAX_FAILURES;
  const windowMs = options.windowMs ?? TOTP_FAILURE_WINDOW_MS;
  const lockMs = options.lockMs ?? TOTP_LOCK_MS;
  let clock = now;
  const state = await readTotpState(statePath);

  if (state.lockedUntil > 0 && clock >= state.lockedUntil) {
    state.failures = 0;
    state.windowStartedAt = 0;
    state.lockedUntil = 0;
    state.backoffUntil = 0;
  }
  if (state.lockedUntil > clock) {
    return {
      ok: false,
      reason: 'locked',
      retryAfterMs: state.lockedUntil - clock,
      lockedUntil: state.lockedUntil,
      failures: state.failures,
    };
  }
  if (state.backoffUntil > clock) {
    const waitMs = state.backoffUntil - clock;
    await sleep(waitMs);
    clock += waitMs;
    state.backoffUntil = 0;
  }

  const normalized = String(code ?? '').replace(/[\s-]+/g, '');
  const malformed = !/^\d{6}$/.test(normalized);
  const step = Math.floor(clock / TOTP_STEP_MS);
  let matchedStep: number | null = null;
  if (!malformed) {
    for (let delta = -TOTP_WINDOW_STEPS; delta <= TOTP_WINDOW_STEPS; delta += 1) {
      const candidate = step + delta;
      if (candidate <= state.lastAcceptedStep) continue;
      const expected = totpCodeAt(secret, candidate);
      if (expected.length === normalized.length && timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) {
        matchedStep = candidate;
        break;
      }
    }
  }

  if (matchedStep !== null) {
    const driftStep = matchedStep - step;
    state.failures = 0;
    state.windowStartedAt = 0;
    state.lockedUntil = 0;
    state.backoffUntil = 0;
    state.lastAcceptedStep = matchedStep;
    state.lastAcceptedAt = clock;
    state.updatedAt = clock;
    await writeTotpState(statePath, state);
    return { ok: true, driftStep, failures: 0 };
  }

  // 失败：重放单独归因（不影响限次口径）
  if (!malformed && state.lastAcceptedStep >= 0) {
    for (let delta = -TOTP_WINDOW_STEPS; delta <= TOTP_WINDOW_STEPS; delta += 1) {
      const candidate = step + delta;
      const expected = totpCodeAt(secret, candidate);
      if (expected === normalized) {
        state.updatedAt = clock;
        await writeTotpState(statePath, state);
        return { ok: false, reason: 'replay', failures: state.failures };
      }
    }
  }

  if (state.windowStartedAt === 0 || clock - state.windowStartedAt > windowMs) {
    state.failures = 0;
    state.windowStartedAt = clock;
  }
  state.failures += 1;
  state.updatedAt = clock;
  if (state.failures >= maxFailures) {
    state.lockedUntil = clock + lockMs;
    state.backoffUntil = 0;
    await writeTotpState(statePath, state);
    return {
      ok: false,
      reason: 'locked',
      retryAfterMs: lockMs,
      lockedUntil: state.lockedUntil,
      failures: state.failures,
    };
  }
  const backoffMs = Math.min(TOTP_BACKOFF_MAX_MS, 1_000 * 2 ** (state.failures - 1));
  state.backoffUntil = clock + backoffMs;
  await writeTotpState(statePath, state);
  await sleep(backoffMs);
  return {
    ok: false,
    reason: malformed ? 'malformed' : 'invalid',
    retryAfterMs: backoffMs,
    failures: state.failures,
  };
}

export async function readTotpStatus(dir: string): Promise<TotpStatus> {
  let seed: TotpSeedRecord | null = null;
  try {
    seed = await readTotpSeed(dir);
  } catch {
    seed = null;
  }
  const state = await readTotpState(totpStatePath(dir)).catch(() => EMPTY_TOTP_STATE());
  return {
    imported: seed !== null,
    ...(seed !== null ? { fingerprint: seed.fingerprint, createdAt: seed.createdAt } : {}),
    failures: state.failures,
    lockedUntil: state.lockedUntil,
    backoffUntil: state.backoffUntil,
    lastAcceptedAt: state.lastAcceptedAt,
  };
}

// ---------------------------------------------------------------------------
// 恢复码 / break-glass
// ---------------------------------------------------------------------------

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface RecoveryCodeMaterial {
  code: string;
  keyId: string;
  publicKeyHex: string;
  createdAt: number;
}

export interface DerivedRecoveryKey {
  privateKey: ReturnType<typeof createPrivateKey>;
  publicKey: ReturnType<typeof createPublicKey>;
  publicKeyHex: string;
  keyId: string;
}

function checkChars(secret: Uint8Array): string {
  const digest = createHash('sha256').update(secret).digest();
  const value = digest.readUInt16BE(0) & 0x03ff;
  return CROCKFORD_ALPHABET[value >> 5]! + CROCKFORD_ALPHABET[value & 0x1f]!;
}

/** 20B secret → 32 字符 Crockford + 2 校验字符。 */
export function encodeRecoveryCode(secret: Uint8Array): string {
  if (secret.length !== 20) throw new Error('恢复码 secret 必须为 20 字节');
  return crockfordEncode(secret) + checkChars(secret);
}

export function decodeRecoveryCode(code: string): Uint8Array {
  const compact = normalizeCrockford(code);
  if (compact.length !== 34) throw new Error('恢复码长度非法（需要 34 个字符）');
  const secret = crockfordDecode(compact.slice(0, 32));
  if (secret.length !== 20) throw new Error('恢复码数据长度非法');
  if (checkChars(secret) !== compact.slice(32)) throw new Error('恢复码校验失败');
  return secret;
}

/** 显示形态：8 组 ×4 + 2 位校验单独成组。 */
export function formatRecoveryCode(code: string): string {
  const compact = normalizeCrockford(code);
  const groups: string[] = [];
  for (let i = 0; i < compact.length; i += 4) groups.push(compact.slice(i, i + 4));
  return groups.join('-');
}

export function deriveRecoveryKey(code: string): DerivedRecoveryKey {
  const secret = decodeRecoveryCode(code);
  const seed = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'mebular-breakglass-v1', 32));
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyRaw = spki.subarray(spki.length - 32);
  const keyId = createHash('sha256').update(publicKeyRaw).digest('hex').slice(0, 16);
  return { privateKey, publicKey, publicKeyHex: publicKeyRaw.toString('hex'), keyId };
}

/** 生成恢复码（secret 不落盘；调用方只显示一次）。 */
export function generateRecoveryCode(now = Date.now()): RecoveryCodeMaterial {
  const secret = randomBytes(20);
  const code = encodeRecoveryCode(secret);
  const derived = deriveRecoveryKey(code);
  return { code, keyId: derived.keyId, publicKeyHex: derived.publicKeyHex, createdAt: now };
}

/** 规范 JSON：键序固定、无空白、忽略 undefined。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** §3.2 动作摘要的规范 JSON。 */
export function securityActionCanonical(params: SecurityActionParams): Record<string, unknown> {
  const base: Record<string, unknown> = { authority: 'mebular-security', op: params.op };
  if (params.op === 'kick') {
    base.initiator = params.initiator;
    base.subject = params.subject;
  } else if (params.op === 'join') {
    base.initiator = params.initiator;
    base.namespace = params.namespace;
  } else if (params.op === 'tier') {
    base.initiator = params.initiator;
    base.level = params.level;
  } else if (params.op === 'restore') {
    base.initiator = params.initiator;
    base.subject = params.subject;
  } else {
    base.initiator = params.initiator;
    base.oldKeyId = params.oldKeyId;
    base.newPublicKey = params.newPublicKey;
  }
  base.nonce = params.nonce;
  return base;
}

export function securityActionDigest(params: SecurityActionParams): string {
  // 与 core（S1 `grantPolicy.securityActionDigest`）逐字节一致：**insertion-order JSON.stringify**，
  // 不是排序键序（动作摘要的键序在 SPEC §3.2 冻结）。
  return sha256Hex(JSON.stringify(securityActionCanonical(params)));
}

/** 配对号：sha256('mebular-pairing'||digest) 前 4 字节 uint32 BE % 1e6 → 'NNN-NNN'。 */
export function pairingCodeForDigest(digest: string): string {
  const hash = createHash('sha256').update('mebular-pairing').update(digest).digest();
  const value = hash.readUInt32BE(0) % 1_000_000;
  const text = String(value).padStart(6, '0');
  return `${text.slice(0, 3)}-${text.slice(3)}`;
}

function breakGlassUnsigned(proof: BreakGlassProof): Record<string, unknown> {
  const { signature: _signature, ...rest } = proof;
  return rest;
}

export function cosignUnsigned(proof: CosignProof): Record<string, unknown> {
  const { signature: _signature, ...rest } = proof;
  return rest;
}

export interface SignBreakGlassInput {
  code: string;
  op: SecurityAction;
  initiator: string;
  subject?: string;
  namespace?: string;
  level?: SecurityLevel;
  oldKeyId?: string;
  newPublicKey?: string;
  nonce?: string;
  now?: number;
  ttlMs?: number;
}

export interface SignedBreakGlass {
  proof: BreakGlassProof;
  digest: string;
  nonce: string;
  pairingCode: string;
}

export function signBreakGlass(input: SignBreakGlassInput): SignedBreakGlass {
  const derived = deriveRecoveryKey(input.code);
  const nonce = input.nonce ?? randomUUID();
  const now = input.now ?? Date.now();
  const digest = securityActionDigest({
    op: input.op,
    initiator: input.initiator,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
    ...(input.level !== undefined ? { level: input.level } : {}),
    ...(input.oldKeyId !== undefined ? { oldKeyId: input.oldKeyId } : {}),
    ...(input.newPublicKey !== undefined ? { newPublicKey: input.newPublicKey } : {}),
    nonce,
  });
  const proof: BreakGlassProof = {
    v: 1,
    op: input.op,
    keyId: derived.keyId,
    digest,
    nonce,
    issuedAt: now,
    expiresAt: now + (input.ttlMs ?? 10 * 60_000),
    signature: '',
  };
  proof.signature = ed25519Sign(null, Buffer.from(canonicalJson(breakGlassUnsigned(proof))), derived.privateKey).toString('base64');
  return { proof, digest, nonce, pairingCode: pairingCodeForDigest(digest) };
}

export interface VerifyBreakGlassOptions {
  publicKeyHex: string;
  expectedDigest?: string;
  usedNonces?: Set<string>;
  currentKeyId?: string;
}

export function verifyBreakGlassProof(proof: BreakGlassProof, options: VerifyBreakGlassOptions): { ok: boolean; reason?: string } {
  if (!proof || proof.v !== 1 || typeof proof.signature !== 'string' || typeof proof.keyId !== 'string') {
    return { ok: false, reason: 'invalid-proof' };
  }
  if (options.currentKeyId !== undefined && proof.keyId !== options.currentKeyId) {
    return { ok: false, reason: 'invalid-proof' };
  }
  if (options.expectedDigest !== undefined && proof.digest !== options.expectedDigest) {
    return { ok: false, reason: 'invalid-proof' };
  }
  if (options.usedNonces?.has(proof.nonce)) {
    return { ok: false, reason: 'stale-or-replayed-nonce' };
  }
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(options.publicKeyHex, 'hex'),
      ]),
      format: 'der',
      type: 'spki',
    });
    const ok = ed25519Verify(
      null,
      Buffer.from(canonicalJson(breakGlassUnsigned(proof))),
      publicKey,
      Buffer.from(proof.signature, 'base64'),
    );
    return ok ? { ok: true } : { ok: false, reason: 'invalid-proof' };
  } catch {
    return { ok: false, reason: 'invalid-proof' };
  }
}

export interface SignCosignInput {
  privateKey: CryptoKey;
  approver: string;
  approverCertificateChain: DeviceCertificate[];
  approvalId: string;
  op: SecurityAction;
  digest: string;
  pairingCode?: string;
  now?: number;
  ttlMs?: number;
}

export async function signCosignProof(input: SignCosignInput): Promise<CosignProof> {
  const now = input.now ?? Date.now();
  const proof: CosignProof = {
    v: 1,
    op: input.op,
    approver: input.approver,
    approverCertificateChain: input.approverCertificateChain,
    approvalId: input.approvalId,
    digest: input.digest,
    pairingCode: input.pairingCode ?? pairingCodeForDigest(input.digest),
    issuedAt: now,
    expiresAt: now + (input.ttlMs ?? 10 * 60_000),
    signature: '',
  };
  const data = new TextEncoder().encode(canonicalJson(cosignUnsigned(proof)));
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, input.privateKey, data);
  proof.signature = Buffer.from(new Uint8Array(signature)).toString('base64');
  return proof;
}

export async function verifyCosignProofSignature(proof: CosignProof, approverPublicKeyHex: string): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey(
      'raw',
      Buffer.from(approverPublicKeyHex, 'hex'),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      Buffer.from(proof.signature, 'base64'),
      new TextEncoder().encode(canonicalJson(cosignUnsigned(proof))),
    );
  } catch {
    return false;
  }
}

export interface RecoveryRegistry {
  currentKeyId?: string;
  keys: Record<string, { publicKeyHex: string; createdAt: number }>;
  usedNonces: Set<string>;
  lastUsedAt?: number;
}

function collectBreakGlass(record: unknown, registry: RecoveryRegistry, at?: number): void {
  if (record === null || typeof record !== 'object') return;
  const proof = (record as { breakGlass?: BreakGlassProof }).breakGlass;
  if (proof === undefined || typeof proof.nonce !== 'string') return;
  registry.usedNonces.add(proof.nonce);
  if (typeof at === 'number' && (registry.lastUsedAt === undefined || at > registry.lastUsedAt)) {
    registry.lastUsedAt = at;
  }
}

/** 从 `__policy__` 事件推导恢复码登记/消费视图（本地预检口径；权威采纳在 core/S1）。 */
export function collectRecoveryRegistry(events: readonly PolicyEvent[]): RecoveryRegistry {
  const registry: RecoveryRegistry = { keys: {}, usedNonces: new Set() };
  const ordered = [...events].sort((a, b) => {
    const at = a.timestamp ?? 0;
    const bt = b.timestamp ?? 0;
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  for (const event of ordered) {
    const data = event.data ?? {};
    if (event.type === SECURITY_RECOVERY_EVENT) {
      const record = data.securityRecovery as SecurityRecoveryRecord | undefined;
      if (record && typeof record.keyId === 'string' && typeof record.publicKey === 'string') {
        registry.keys[record.keyId] = { publicKeyHex: record.publicKey, createdAt: record.createdAt };
        registry.currentKeyId = record.keyId;
        collectBreakGlass(record, registry, event.timestamp);
      }
      continue;
    }
    if (event.type === SECURITY_TIER_EVENT) collectBreakGlass(data.securityTier, registry, event.timestamp);
    else if (event.type === 'device_revoke') collectBreakGlass(data.deviceRevoke, registry, event.timestamp);
    else if (event.type === 'device_restore') collectBreakGlass(data.deviceRestore, registry, event.timestamp);
    else if (event.type === 'namespace_subscription') collectBreakGlass(data.subscription, registry, event.timestamp);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// `__policy__` 记录读写（S1 未合并时的兼容写入；形状与 SPEC 冻结一致）
// ---------------------------------------------------------------------------

export async function appendSecurityRecord(
  app: SecurityApp,
  type: string,
  key: string,
  record: unknown,
): Promise<{ id: string }> {
  if (app.eventLog === undefined) throw new Error('core 未初始化：缺少 eventLog，无法写安全记录');
  return app.eventLog.append({ type, data: { [key]: record }, namespace: POLICY_NAMESPACE });
}

export async function listPolicyEvents(app: SecurityApp): Promise<PolicyEvent[]> {
  if (app.eventLog === undefined) return [];
  return app.eventLog.listEvents({ namespace: POLICY_NAMESPACE });
}

export function normalizeSecurityLevel(value: unknown): SecurityLevel {
  return value === 'medium' || value === 'high' ? value : 'low';
}

/** 读档位：缺 `getSecurityTier()` → low（S1 未合并的当前构建不炸）。 */
export async function readSecurityState(app: SecurityApp): Promise<SecurityStateView> {
  if (typeof app.getSecurityTier === 'function') {
    try {
      const raw = await app.getSecurityTier();
      if (raw !== null && typeof raw === 'object') {
        const record = raw as Record<string, unknown>;
        const admitted = Array.isArray(record.admitted)
          ? record.admitted.filter((value): value is string => typeof value === 'string')
          : [];
        const rejections = Array.isArray(record.rejections)
          ? record.rejections
            .filter((value): value is Record<string, unknown> => value !== null && typeof value === 'object')
            .map((value) => ({ eventId: String(value.eventId ?? ''), reason: String(value.reason ?? '') }))
          : [];
        return {
          level: normalizeSecurityLevel(record.level),
          ...(typeof record.changedAt === 'number' ? { changedAt: record.changedAt } : {}),
          ...(typeof record.changedBy === 'string' ? { changedBy: record.changedBy } : {}),
          admitted,
          ...(typeof record.recoveryKeyId === 'string' ? { recoveryKeyId: record.recoveryKeyId } : {}),
          rejections,
          coreTierAvailable: true,
        };
      }
    } catch {
      // 读档失败按 low（fail-closed 的显示侧；无写放大）
    }
  }
  return { level: 'low', admitted: [], rejections: [], coreTierAvailable: false };
}

export interface WriteTierInput {
  level: SecurityLevel;
  note?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
  nonce?: string;
}

export async function writeSecurityTier(app: SecurityApp, input: WriteTierInput): Promise<{ id?: string; level: SecurityLevel }> {
  // 带证明的档位变更必须把 cosign/breakGlass 内嵌进记录；若 core 的 setSecurityTier 不接受
  // 证明字段，直接按冻结形状落图（S1 的推导会验收）。
  if (typeof app.setSecurityTier === 'function' && input.cosign === undefined && input.breakGlass === undefined) {
    const result = await app.setSecurityTier({
      level: input.level,
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
    });
    const id = result !== null && typeof result === 'object' && typeof (result as { id?: unknown }).id === 'string'
      ? String((result as { id: string }).id)
      : undefined;
    return { ...(id !== undefined ? { id } : {}), level: input.level };
  }
  const record: SecurityTierRecord = {
    level: input.level,
    nonce: input.nonce ?? input.breakGlass?.nonce ?? randomUUID(),
    issuedAt: Date.now(),
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.cosign !== undefined ? { cosign: input.cosign } : {}),
    ...(input.breakGlass !== undefined ? { breakGlass: input.breakGlass } : {}),
  };
  const event = await appendSecurityRecord(app, SECURITY_TIER_EVENT, 'securityTier', record);
  return { id: event.id, level: input.level };
}

export interface WriteDeviceRevokeInput {
  subject: string;
  note?: string;
  /** kick 动作 nonce（high 档进入 digest；带证明时必填/可由 breakGlass 推导）。 */
  nonce?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
}

export async function writeDeviceRevoke(app: SecurityApp, input: WriteDeviceRevokeInput): Promise<{ id?: string }> {
  // 带证明的记录直接按 SPEC §3.1 落图（S1 的 revokeDevice 未必接受可选证明字段）。
  if (input.cosign !== undefined || input.breakGlass !== undefined) {
    const nonce = input.nonce ?? input.breakGlass?.nonce;
    const event = await appendSecurityRecord(app, 'device_revoke', 'deviceRevoke', {
      subject: input.subject,
      issuedAt: Date.now(),
      ...(nonce !== undefined ? { nonce } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.cosign !== undefined ? { cosign: input.cosign } : {}),
      ...(input.breakGlass !== undefined ? { breakGlass: input.breakGlass } : {}),
    });
    return { id: event.id };
  }
  if (typeof app.revokeDevice === 'function') {
    const event = await app.revokeDevice({ subject: input.subject, ...(input.note !== undefined ? { note: input.note } : {}) });
    const id = event !== null && typeof event === 'object' && typeof (event as { id?: unknown }).id === 'string'
      ? String((event as { id: string }).id)
      : undefined;
    return { ...(id !== undefined ? { id } : {}) };
  }
  const event = await appendSecurityRecord(app, 'device_revoke', 'deviceRevoke', {
    subject: input.subject,
    issuedAt: Date.now(),
    ...(input.note !== undefined ? { note: input.note } : {}),
  });
  return { id: event.id };
}

export interface WriteDeviceRestoreInput {
  subject: string;
  note?: string;
  nonce?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
}

/** 写 `device_restore`（恢复纪元由 core 推导；high 档证明随记录走）。 */
export async function writeDeviceRestore(app: SecurityApp, input: WriteDeviceRestoreInput): Promise<{ id?: string }> {
  if (input.cosign !== undefined || input.breakGlass !== undefined) {
    const nonce = input.nonce ?? input.breakGlass?.nonce;
    const event = await appendSecurityRecord(app, 'device_restore', 'deviceRestore', {
      subject: input.subject,
      issuedAt: Date.now(),
      ...(nonce !== undefined ? { nonce } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.cosign !== undefined ? { cosign: input.cosign } : {}),
      ...(input.breakGlass !== undefined ? { breakGlass: input.breakGlass } : {}),
    });
    return { id: event.id };
  }
  if (typeof app.restoreDevice === 'function') {
    const event = await app.restoreDevice({ subject: input.subject, ...(input.note !== undefined ? { note: input.note } : {}) });
    const id = event !== null && typeof event === 'object' && typeof (event as { id?: unknown }).id === 'string'
      ? String((event as { id: string }).id)
      : undefined;
    return { ...(id !== undefined ? { id } : {}) };
  }
  const event = await appendSecurityRecord(app, 'device_restore', 'deviceRestore', {
    subject: input.subject,
    issuedAt: Date.now(),
    ...(input.note !== undefined ? { note: input.note } : {}),
  });
  return { id: event.id };
}

export async function writeSecurityApproval(app: SecurityApp, record: SecurityApprovalRecord): Promise<{ id: string }> {
  return appendSecurityRecord(app, SECURITY_APPROVAL_EVENT, 'securityApproval', record);
}

export async function writeSecurityRecovery(app: SecurityApp, record: SecurityRecoveryRecord): Promise<{ id: string }> {
  return appendSecurityRecord(app, SECURITY_RECOVERY_EVENT, 'securityRecovery', record);
}

export async function writeSecurityTotpAudit(app: SecurityApp, record: SecurityTotpRecord): Promise<{ id: string }> {
  return appendSecurityRecord(app, SECURITY_TOTP_EVENT, 'securityTotp', record);
}

/** 最新恢复码登记（本地预检；权威在 core）。 */
export function latestRecoveryRecord(events: readonly PolicyEvent[]): SecurityRecoveryRecord | null {
  let latest: SecurityRecoveryRecord | null = null;
  let latestAt = -1;
  for (const event of events) {
    if (event.type !== SECURITY_RECOVERY_EVENT) continue;
    const record = event.data?.securityRecovery as SecurityRecoveryRecord | undefined;
    if (record && typeof record.keyId === 'string') {
      const at = event.timestamp ?? 0;
      if (at >= latestAt) {
        latest = record;
        latestAt = at;
      }
    }
  }
  return latest;
}

export function approvalsFromEvents(events: readonly PolicyEvent[]): SecurityApprovalRecord[] {
  return events
    .filter((event) => event.type === SECURITY_APPROVAL_EVENT)
    .map((event) => event.data?.securityApproval as SecurityApprovalRecord | undefined)
    .filter((record): record is SecurityApprovalRecord => record !== undefined && typeof record.approvalId === 'string');
}

export function pendingApprovals(events: readonly PolicyEvent[], now = Date.now()): SecurityApprovalRecord[] {
  const all = approvalsFromEvents(events);
  const decided = new Set(all.filter((record) => record.decision !== 'request').map((record) => record.approvalId));
  return all.filter((record) => record.decision === 'request' && !decided.has(record.approvalId) && record.expiresAt > now);
}

export function findApproval(events: readonly PolicyEvent[], approvalId: string): SecurityApprovalRecord | null {
  return approvalsFromEvents(events).find((record) => record.approvalId === approvalId && record.decision === 'approve') ?? null;
}

// ---------------------------------------------------------------------------
// 本机门禁（CLI 与 serve 共用）
// ---------------------------------------------------------------------------

export interface SecurityGateResult {
  ok: boolean;
  status?: number;
  error?: string;
  message?: string;
  retryAfterMs?: number;
}

export interface SecurityGateInput {
  action: 'invite' | 'revoke' | 'tier' | 'restore';
  level?: SecurityLevel;
  code?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
  subject?: string;
  namespace?: string;
  approvalId?: string;
  now?: number;
  /** 测试注入：TOTP 失败退避延时；生产不传（真实 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 本机程序门槛（SPEC §2.5 / §1.4）：
 * - medium：invite/revoke/档位变更（除 medium→medium）需要动态码；
 * - high：invite/revoke/档位变更（除 high→high）需要会签或恢复码；
 * - low：无门槛。S1 未合并（getSecurityTier 缺失）→ low。
 */
export async function evaluateSecurityGate(
  app: SecurityApp,
  dir: string,
  input: SecurityGateInput,
): Promise<SecurityGateResult> {
  const state = await readSecurityState(app);
  const level = input.level;
  if (state.level === 'medium') {
    if (input.action === 'tier' && level === 'medium') return { ok: true };
    if (input.code === undefined || input.code.trim().length === 0) {
      return {
        ok: false,
        status: 403,
        error: 'totp_required',
        message: '中档（动态码）要求输入 6 位动态码：请在请求体提供 code',
      };
    }
    const seed = await readTotpSeed(dir).catch(() => null);
    if (seed === null) {
      return {
        ok: false,
        status: 403,
        error: 'totp_not_configured',
        message: '本机尚未导入动态码种子：请从一台已有设备导入后再试',
      };
    }
    const result = await verifyTotp(seed.secret, input.code, input.now ?? Date.now(), {
      dir,
      ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
    });
    if (!result.ok) {
      const status = result.reason === 'locked' ? 429 : 403;
      const reason = result.reason === 'locked'
        ? `动态码已锁定：请在 ${Math.ceil((result.retryAfterMs ?? 0) / 1000)} 秒后重试`
        : result.reason === 'replay'
          ? '动态码已使用过（重放被拒）：请等待下一个 30 秒窗口'
          : '动态码无效：请检查设备时间后重试';
      return {
        ok: false,
        status,
        error: result.reason === 'locked' ? 'totp_locked' : result.reason === 'replay' ? 'totp_replayed' : 'totp_invalid',
        message: reason,
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
      };
    }
    return { ok: true };
  }

  if (state.level === 'high') {
    if (input.action === 'tier' && level === 'high') return { ok: true };
    if (input.breakGlass !== undefined) {
      const events = await listPolicyEvents(app);
      const registry = collectRecoveryRegistry(events);
      const key = input.breakGlass.keyId !== undefined ? registry.keys[input.breakGlass.keyId] : undefined;
      if (key === undefined || registry.currentKeyId !== input.breakGlass.keyId) {
        return { ok: false, status: 403, error: 'proof_invalid', message: '恢复码无效或已被轮换：请使用当前恢复码' };
      }
      let expectedDigest: string | undefined;
      if (input.action === 'revoke' && input.subject !== undefined) {
        expectedDigest = securityActionDigest({
          op: 'kick',
          initiator: app.deviceId ?? '',
          subject: input.subject,
          nonce: input.breakGlass.nonce,
        });
      } else if (input.action === 'invite' && input.namespace !== undefined) {
        expectedDigest = securityActionDigest({
          op: 'join',
          initiator: app.deviceId ?? '',
          namespace: input.namespace,
          nonce: input.breakGlass.nonce,
        });
      } else if (input.action === 'tier' && input.level !== undefined) {
        expectedDigest = securityActionDigest({
          op: 'tier',
          initiator: app.deviceId ?? '',
          level: input.level,
          nonce: input.breakGlass.nonce,
        });
      } else if (input.action === 'restore' && input.subject !== undefined) {
        expectedDigest = securityActionDigest({
          op: 'restore',
          initiator: app.deviceId ?? '',
          subject: input.subject,
          nonce: input.breakGlass.nonce,
        });
      }
      const check = verifyBreakGlassProof(input.breakGlass, {
        publicKeyHex: key.publicKeyHex,
        ...(expectedDigest !== undefined ? { expectedDigest } : {}),
        usedNonces: registry.usedNonces,
        currentKeyId: registry.currentKeyId,
      });
      if (!check.ok) {
        return {
          ok: false,
          status: 403,
          error: check.reason === 'stale-or-replayed-nonce' ? 'proof_replayed' : 'proof_invalid',
          message: check.reason === 'stale-or-replayed-nonce' ? '恢复码 nonce 已使用（重放被拒）' : '恢复码签名无效',
        };
      }
      return { ok: true };
    }
    if (input.approvalId !== undefined && input.approvalId.length > 0) {
      const events = await listPolicyEvents(app);
      const approval = findApproval(events, input.approvalId);
      if (approval === null) {
        return { ok: false, status: 403, error: 'approval_missing', message: '会签批准记录不存在或未生效' };
      }
      const expectedOp = input.action === 'invite'
        ? 'join'
        : input.action === 'revoke'
          ? 'kick'
          : input.action === 'restore'
            ? 'restore'
            : 'tier';
      if (approval.op !== expectedOp || approval.initiator !== (app.deviceId ?? '')) {
        return { ok: false, status: 403, error: 'approval_invalid', message: '批准记录与本次动作不匹配（op/发起设备）' };
      }
      if ((input.action === 'revoke' || input.action === 'restore') && approval.target !== input.subject) {
        return { ok: false, status: 403, error: 'approval_invalid', message: '批准记录的对象与实际设备不一致' };
      }
      if (input.action === 'tier' && input.level !== undefined && approval.level !== input.level) {
        return { ok: false, status: 403, error: 'approval_invalid', message: '批准记录的档位与实际要变更的档位不一致' };
      }
      if (input.action === 'invite' && input.namespace !== undefined && approval.namespace !== input.namespace) {
        return { ok: false, status: 403, error: 'approval_invalid', message: '批准记录的分区与实际邀请分区不一致' };
      }
      const expectedDigest = securityActionDigest({
        op: approval.op,
        initiator: approval.initiator,
        ...(approval.op === 'kick' || approval.op === 'restore' ? { subject: approval.target ?? '' } : {}),
        ...(approval.op === 'join' ? { namespace: approval.namespace ?? '' } : {}),
        ...(approval.op === 'tier' ? { level: approval.level ?? 'low' } : {}),
        nonce: approval.nonce,
      });
      if (expectedDigest !== approval.digest) {
        return { ok: false, status: 403, error: 'approval_invalid', message: '批准记录的 digest 与动作摘要不一致' };
      }
      if (approval.cosign !== undefined) {
        const leaf = approval.cosign.approverCertificateChain?.[0];
        if (leaf !== undefined && typeof leaf.devicePublicKey === 'string') {
          const ok = await verifyCosignProofSignature(approval.cosign, leaf.devicePublicKey);
          if (!ok) return { ok: false, status: 403, error: 'approval_invalid', message: '批准记录的会签签名无效' };
        }
        if (approval.cosign.approver === approval.initiator) {
          return { ok: false, status: 403, error: 'approval_invalid', message: '发起设备不能批准自己的动作' };
        }
        if ((input.action === 'revoke' || input.action === 'restore') && approval.cosign.approver === input.subject) {
          return { ok: false, status: 403, error: 'approval_invalid', message: '目标设备不能批准对自己的动作' };
        }
        if (state.admitted.length > 0 && !state.admitted.includes(approval.cosign.approver)) {
          return { ok: false, status: 403, error: 'approver_not_admitted', message: '批准设备尚未准入（admitted）' };
        }
      }
      return { ok: true };
    }
    if (input.cosign !== undefined) {
      const events = await listPolicyEvents(app);
      const approval = findApproval(events, input.cosign.approvalId);
      if (approval === null || approval.cosign === undefined) {
        return { ok: false, status: 403, error: 'approval_missing', message: '会签批准记录不存在或未生效' };
      }
      if (approval.digest !== input.cosign.digest || approval.cosign.signature !== input.cosign.signature) {
        return { ok: false, status: 403, error: 'proof_invalid', message: '会签证明与批准记录不一致' };
      }
      if (approval.initiator === input.cosign.approver) {
        return { ok: false, status: 403, error: 'proof_invalid', message: '发起设备不能批准自己的动作' };
      }
      const leaf = input.cosign.approverCertificateChain?.[0];
      if (leaf !== undefined && typeof leaf.devicePublicKey === 'string') {
        const signatureOk = await verifyCosignProofSignature(input.cosign, leaf.devicePublicKey);
        if (!signatureOk) {
          return { ok: false, status: 403, error: 'proof_invalid', message: '会签签名无效' };
        }
      }
      if (input.action === 'revoke' && input.cosign.approver === input.subject) {
        return { ok: false, status: 403, error: 'proof_invalid', message: '被踢设备不能批准对自己的动作' };
      }
      if (state.admitted.length > 0 && !state.admitted.includes(input.cosign.approver)) {
        return { ok: false, status: 403, error: 'approver_not_admitted', message: '批准设备尚未准入（admitted）' };
      }
      return { ok: true };
    }
    return {
      ok: false,
      status: 403,
      error: 'approval_required',
      message: '高档（设备会签）要求另一台已受准设备批准，或使用离线恢复码',
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 主密钥备份 / 恢复（§4）
// ---------------------------------------------------------------------------

export const BACKUP_KIND = 'mebular-master-key-backup';
export const BACKUP_SCRYPT_N = 32_768;
export const BACKUP_SCRYPT_R = 8;
export const BACKUP_SCRYPT_P = 1;

export interface MasterKeyBackupFile {
  v: 1;
  kind: typeof BACKUP_KIND;
  createdAt: number;
  deviceId: string;
  masterPublicKeyHex: string;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { name: 'AES-256-GCM'; iv: string; ciphertext: string; tag: string };
}

export interface MasterKeyBackupPayload {
  masterPrivateKeyPkcs8: string;
  masterPublicKeyHex: string;
  createdAt: number;
  deviceId: string;
  note?: string;
}

export interface ExportBackupInput {
  dir: string;
  /** 备份码；缺省生成一个新码（调用方必须一次性显示）。 */
  code?: string;
  note?: string;
  now?: number;
}

export interface ExportBackupResult {
  file: MasterKeyBackupFile;
  code: string;
  codeGenerated: boolean;
  fingerprint: string;
  deviceId: string;
}

interface ResolvedHomeKey {
  keyPath: string;
  deviceId: string;
  encryption: Awaited<ReturnType<typeof readMasterKeyFile>>;
}

/** 解析 home 的主密钥路径（fleet home / 守护 home / 空 home）。 */
export async function resolveHomeMasterKey(dir: string): Promise<ResolvedHomeKey> {
  const fleetPath = fleetConfigPath(dir);
  if (existsSync(fleetPath)) {
    const config = await loadFleetConfig(fleetPath);
    return {
      keyPath: config.masterKeyFile,
      deviceId: config.device,
      encryption: await readMasterKeyFile(config.masterKeyFile),
    };
  }
  const daemonPath = join(dir, 'config.json');
  if (existsSync(daemonPath)) {
    const config = JSON.parse(await readFile(daemonPath, 'utf-8')) as Record<string, any>;
    const encryption = (config.encryption ?? {}) as Record<string, unknown>;
    const keyPath = typeof encryption.userMasterPublicKeyFile === 'string' && encryption.userMasterPublicKeyFile.length > 0
      ? encryption.userMasterPublicKeyFile
      : typeof encryption.keyFile === 'string' && encryption.keyFile.length > 0
        ? encryption.keyFile
        : join(dir, 'user-master-key.json');
    const storagePath = typeof config.storagePath === 'string' && config.storagePath.length > 0
      ? config.storagePath
      : join(dir, 'store.jsonl');
    return {
      keyPath,
      deviceId: identityDeviceIdForStorage(storagePath)
        ?? (typeof config.deviceId === 'string' ? config.deviceId : `device-${process.pid}`),
      encryption: await readMasterKeyFile(keyPath),
    };
  }
  const candidates = [join(dir, 'master-key.json'), join(dir, 'user-master-key.json')];
  for (const keyPath of candidates) {
    if (existsSync(keyPath)) {
      return { keyPath, deviceId: `device-${process.pid}`, encryption: await readMasterKeyFile(keyPath) };
    }
  }
  throw new Error(`未找到主密钥文件（${candidates.join(' / ')}）`);
}

function scryptKey(secret: Uint8Array, salt: Buffer): Buffer {
  return scryptSync(Buffer.from(secret), salt, 32, {
    N: BACKUP_SCRYPT_N,
    r: BACKUP_SCRYPT_R,
    p: BACKUP_SCRYPT_P,
    maxmem: 128 * 1024 * 1024,
  });
}

/** 导出主密钥备份（仅 root；委派设备无主私钥 → 明确失败）。 */
export async function exportMasterKeyBackup(input: ExportBackupInput): Promise<ExportBackupResult> {
  const resolved = await resolveHomeMasterKey(input.dir);
  if (resolved.encryption.userMasterPrivateKey === undefined) {
    throw new Error('仅 root（持有主密钥私钥的设备）可导出备份；本机是委派设备（无主私钥）');
  }
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', resolved.encryption.userMasterPrivateKey));
  const codeGenerated = input.code === undefined;
  const code = input.code ?? generateRecoveryCode().code;
  const secret = decodeRecoveryCode(code);
  const createdAt = input.now ?? Date.now();
  const payload: MasterKeyBackupPayload = {
    masterPrivateKeyPkcs8: Buffer.from(pkcs8).toString('base64'),
    masterPublicKeyHex: Buffer.from(resolved.encryption.userMasterKey).toString('hex'),
    createdAt,
    deviceId: resolved.deviceId,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptKey(secret, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const file: MasterKeyBackupFile = {
    v: 1,
    kind: BACKUP_KIND,
    createdAt,
    deviceId: resolved.deviceId,
    masterPublicKeyHex: payload.masterPublicKeyHex,
    kdf: { name: 'scrypt', N: BACKUP_SCRYPT_N, r: BACKUP_SCRYPT_R, p: BACKUP_SCRYPT_P, salt: salt.toString('base64') },
    cipher: {
      name: 'AES-256-GCM',
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    },
  };
  return {
    file,
    code,
    codeGenerated,
    fingerprint: masterKeyFingerprint(resolved.encryption.userMasterKey),
    deviceId: resolved.deviceId,
  };
}

export async function writeBackupFile(path: string, file: MasterKeyBackupFile): Promise<void> {
  await writePrivateFile(path, JSON.stringify(file, null, 2));
}

export interface RestoreBackupInput {
  file: string | MasterKeyBackupFile;
  code: string;
  dir: string;
  keyPath?: string;
  device?: string;
  namespace?: string;
  listen?: string;
  agents?: FleetAgentConfig[];
}

export interface RestoreBackupResult {
  fingerprint: string;
  masterPublicKeyHex: string;
  deviceId: string;
  keyPath: string;
  configPath?: string;
  onboarded: boolean;
}

function parseBackupFile(input: string | MasterKeyBackupFile): MasterKeyBackupFile {
  const file = typeof input === 'string' ? JSON.parse(input) as MasterKeyBackupFile : input;
  if (file === null || typeof file !== 'object' || file.kind !== BACKUP_KIND || file.v !== 1) {
    throw new Error('备份文件形状非法（kind/v 不匹配）');
  }
  if (file.kdf?.name !== 'scrypt' || file.cipher?.name !== 'AES-256-GCM') {
    throw new Error('备份文件算法不支持');
  }
  return file;
}

/**
 * 从备份恢复主密钥。**先解密/验公钥，再写盘**；失败不留半成品。
 * `device` 给出时顺带 `onboardDevice`（写 fleet 配置 + 设备证书，成为新 root）。
 */
export async function restoreMasterKeyBackup(input: RestoreBackupInput): Promise<RestoreBackupResult> {
  const file = parseBackupFile(input.file);
  const secret = decodeRecoveryCode(input.code);
  let payload: MasterKeyBackupPayload;
  try {
    const key = scryptKey(secret, Buffer.from(file.kdf.salt, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.cipher.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(file.cipher.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(file.cipher.ciphertext, 'base64')), decipher.final()]);
    payload = JSON.parse(plain.toString('utf-8')) as MasterKeyBackupPayload;
  } catch {
    throw new Error('恢复失败：备份码错误或文件被篡改');
  }
  if (typeof payload.masterPrivateKeyPkcs8 !== 'string' || typeof payload.masterPublicKeyHex !== 'string') {
    throw new Error('恢复失败：备份载荷形状非法');
  }
  if (payload.masterPublicKeyHex !== file.masterPublicKeyHex) {
    throw new Error('恢复失败：主公钥指纹不一致（文件被篡改）');
  }
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(payload.masterPrivateKeyPkcs8, 'base64'),
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  // 从私钥导出公钥，确保配对一致（私钥/公钥不匹配 → 拒绝）
  const derivedPublic = await exportEd25519PublicFromPrivate(privateKey);
  if (Buffer.from(derivedPublic).toString('hex') !== payload.masterPublicKeyHex) {
    throw new Error('恢复失败：私钥与主公钥不匹配');
  }

  const keyPath = input.keyPath ?? join(input.dir, 'user-master-key.json');
  const record = {
    v: 1,
    alg: 'Ed25519',
    publicKey: Buffer.from(derivedPublic).toString('base64'),
    privateKeyPkcs8: payload.masterPrivateKeyPkcs8,
  };
  const keyExisted = existsSync(keyPath);
  const created: string[] = [];
  try {
    await writePrivateFile(keyPath, JSON.stringify(record));
    if (!keyExisted) created.push(keyPath);
    let configPath: string | undefined;
    if (input.device !== undefined) {
      const onboard = await onboardDevice({
        dir: input.dir,
        device: input.device,
        masterKeyFile: keyPath,
        ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
        ...(input.listen !== undefined ? { listen: input.listen } : {}),
        ...(input.agents !== undefined ? { agents: input.agents } : {}),
      });
      configPath = fleetConfigPath(input.dir);
      created.push(configPath, `${onboard.config.storagePath}.identity.json`);
    }
    return {
      fingerprint: masterKeyFingerprint(derivedPublic),
      masterPublicKeyHex: payload.masterPublicKeyHex,
      deviceId: input.device ?? payload.deviceId,
      keyPath,
      ...(configPath !== undefined ? { configPath } : {}),
      onboarded: input.device !== undefined,
    };
  } catch (error) {
    // 失败不残留：只清理本次新建的文件
    for (const path of created.reverse()) await rm(path, { force: true }).catch(() => undefined);
    if (!keyExisted) await rm(keyPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 从 CryptoKey 私钥导出 raw 公钥（Node WebCrypto 无 direct public export；经 PKCS8→KeyObject）。 */
async function exportEd25519PublicFromPrivate(privateKey: CryptoKey): Promise<Uint8Array> {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
  const nodeKey = createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(nodeKey);
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return new Uint8Array(spki.subarray(spki.length - 32));
}

// ---------------------------------------------------------------------------
// 分发展示（QR 编码失败 → 分组文本降级）
// ---------------------------------------------------------------------------

export interface TotpShareResult {
  secret: string;
  fingerprint: string;
  otpauth: string;
  groups: string;
  qrText?: string;
}

export interface TotpShareOptions {
  qr?: boolean;
}

export async function renderTotpShare(
  secret: string,
  deviceId: string,
  options: TotpShareOptions = {},
): Promise<TotpShareResult> {
  const otpauth = totpOtpauthUri(secret, deviceId);
  const groups = secret.replace(/(.{4})/g, '$1 ').trim();
  const result: TotpShareResult = { secret, fingerprint: totpFingerprint(secret), otpauth, groups };
  if (options.qr === false) return result;
  const qr = await renderTerminalQr(otpauth).catch(() => null);
  if (qr !== null) result.qrText = qr.value;
  return result;
}

export async function renderTotpShareSvg(
  secret: string,
  deviceId: string,
  options: TotpShareOptions = {},
): Promise<string | null> {
  if (options.qr === false) return null;
  const qr = await renderSvgQr(totpOtpauthUri(secret, deviceId)).catch(() => null);
  return qr === null ? null : qr.value;
}
