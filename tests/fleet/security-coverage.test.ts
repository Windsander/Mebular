// S2 覆盖率补齐：security.ts 的错误分支/边界/记录读写/高风险门禁/备份解析。
// 目标：真实断言，不调低 global/per-file 门槛。

import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendSecurityRecord,
  approvalsFromEvents,
  base32Decode,
  base32Encode,
  canonicalJson,
  collectRecoveryRegistry,
  crockfordDecode,
  crockfordEncode,
  decodeRecoveryCode,
  encodeRecoveryCode,
  evaluateSecurityGate,
  exportMasterKeyBackup,
  findApproval,
  formatRecoveryCode,
  generateRecoveryCode,
  generateTotpSecret,
  importTotpSeed,
  latestRecoveryRecord,
  listPolicyEvents,
  normalizeSecurityLevel,
  parseTotpInput,
  pendingApprovals,
  readSecurityState,
  readTotpSeed,
  readTotpStatus,
  renderTotpShare,
  renderTotpShareSvg,
  resolveHomeMasterKey,
  restoreMasterKeyBackup,
  securityActionCanonical,
  securityActionDigest,
  signBreakGlass,
  signCosignProof,
  totpCodeAt,
  totpFingerprint,
  totpOtpauthUri,
  verifyBreakGlassProof,
  verifyCosignProofSignature,
  verifyTotp,
  writeDeviceRevoke,
  writeSecurityApproval,
  writeSecurityRecovery,
  writeSecurityTier,
  writeSecurityTotpAudit,
  writeTotpSeed,
  type BreakGlassProof,
  type CosignProof,
  type PolicyEvent,
  type SecurityApp,
} from '../../packages/fleet/src/security.js';
import {
  generateMasterKey,
  masterKeyFingerprint,
  readMasterKeyFile,
  writeMasterKeyFile,
} from '../../packages/fleet/src/config.js';

const noSleep = async (): Promise<void> => undefined;

type MemoryApp = SecurityApp & { events: PolicyEvent[] };
function memoryApp(overrides: Partial<SecurityApp> = {}): MemoryApp {
  const events: PolicyEvent[] = [];
  const app = {
    deviceId: 'device-A',
    events,
    eventLog: {
      append: async (input: Record<string, unknown>) => {
        const event = { id: `e-${events.length + 1}`, timestamp: Date.now(), author: 'device-A', ...input } as PolicyEvent;
        events.push(event);
        return event;
      },
      listEvents: async () => events,
    },
    ...overrides,
  } as MemoryApp;
  return app;
}

describe('S2 覆盖率补齐 · 编码/输入边界', () => {
  test('base32/Crockford 余位与非法字符', () => {
    expect(base32Encode(new Uint8Array([0xff]))).toBe('74');
    expect(() => base32Decode('!')).toThrow(/base32 非法字符/);
    expect(crockfordEncode(new Uint8Array([0xff]))).toBe('ZW');
    expect(() => crockfordDecode('!')).toThrow(/恢复码非法字符/);
    expect(() => encodeRecoveryCode(new Uint8Array(19))).toThrow(/20 字节/);
    expect(() => decodeRecoveryCode('ABC')).toThrow(/长度非法/);
    const secret = randomBytes(20);
    const good = encodeRecoveryCode(secret);
    const badCheck = `${good.slice(0, 33)}${good[33] === '0' ? '1' : '0'}`;
    expect(() => decodeRecoveryCode(badCheck)).toThrow(/校验失败/);
  });

  test('parseTotpInput 错误分支与 otpauth 元数据', () => {
    expect(() => parseTotpInput('')).toThrow(/为空/);
    expect(() => parseTotpInput('otpauth://hotp/x?secret=ABC')).toThrow(/仅支持 otpauth:\/\/totp/);
    expect(() => parseTotpInput('otpauth://totp/x')).toThrow(/缺少 secret/);
    expect(() => parseTotpInput('otpauth://totp/x?secret=ABC&digits=8')).toThrow(/digits=6/);
    expect(() => parseTotpInput('otpauth://totp/x?secret=ABC&period=60')).toThrow(/period=30/);
    expect(() => parseTotpInput('otpauth://totp/x?secret=ABC&algorithm=SHA256')).toThrow(/algorithm=SHA1/);
    const parsed = parseTotpInput('otpauth://totp/My%20Label?secret=abcd-efgh');
    expect(parsed.secret).toBe('ABCDEFGH');
    expect(parsed.label).toBe('My Label');
    expect(parsed.issuer).toBeUndefined();
    const issued = parseTotpInput('otpauth://totp/Label?secret=ABCD&issuer=Acme');
    expect(issued.issuer).toBe('Acme');
    expect(parseTotpInput(' abcd-efgh== ').secret).toBe('ABCDEFGH');
  });

  test('TOTP 状态/文件错误分支与自定义限次参数', async () => {
    const root = await mkdtemp(join(tmpdir(), 'totp-cov-'));
    try {
      await writeFile(join(root, 'security-totp.json'), JSON.stringify({ v: 2, secret: 1 }), 'utf-8');
      await expect(readTotpSeed(root)).rejects.toThrow(/形状非法/);
      const status = await readTotpStatus(root);
      expect(status.imported).toBe(false);
      await writeFile(join(root, 'security-totp.json.state'), 'not-json', 'utf-8');
      const status2 = await readTotpStatus(root);
      expect(status2.failures).toBe(0);

      await expect(importTotpSeed(root, '!!!!')).rejects.toThrow(/不是合法 base32/);
      const secret = generateTotpSecret();
      const malformed = await verifyTotp(secret, undefined as unknown as string, 60_000, {
        statePath: join(root, 'state-malformed.json'),
        sleep: noSleep,
      });
      expect(malformed.ok).toBe(false);
      expect(malformed.reason).toBe('malformed');

      // 不传 dir/statePath（纯函数校验，不持久化）；now/options 也用默认值
      const code = totpCodeAt(secret, Math.floor(Date.now() / 30_000));
      expect((await verifyTotp(secret, code)).ok).toBe(true);

      // 自定义 maxFailures/window/lock：两次失败即锁，且窗口过期后重置
      const statePath = join(root, 'custom.json');
      const bad = '000000';
      const first = await verifyTotp(secret, bad, 120_000, {
        statePath, sleep: noSleep, maxFailures: 2, windowMs: 1_000, lockMs: 5_000,
      });
      expect(first.ok).toBe(false);
      const second = await verifyTotp(secret, bad, 120_000, {
        statePath, sleep: noSleep, maxFailures: 2, windowMs: 1_000, lockMs: 5_000,
      });
      expect(second.reason).toBe('locked');
      expect(second.lockedUntil).toBeGreaterThan(120_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('seed 写入默认/自定义 createdAt 与 otpauth 自定义 issuer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'totp-seed-cov-'));
    try {
      const secret = generateTotpSecret(16);
      expect(secret.length).toBeGreaterThan(0);
      const record = await writeTotpSeed(root, secret, 123);
      expect(record.createdAt).toBe(123);
      const record2 = await writeTotpSeed(root, secret);
      expect(record2.createdAt).toBeGreaterThan(0);
      expect(totpOtpauthUri(secret, 'device-A', 'Acme')).toContain('issuer=Acme');
      expect(totpFingerprint(secret)).toHaveLength(8);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('S2 覆盖率补齐 · 摘要/证明/恢复码', () => {
  test('canonicalJson 非对象/数组/undefined 键', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(['a', { b: 1 }])).toBe('["a",{"b":1}]');
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
    expect(canonicalJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  test('securityActionCanonical 四种 op', () => {
    expect(securityActionCanonical({ op: 'kick', initiator: 'A', subject: 'B', nonce: 'n' })).toEqual({
      authority: 'mebular-security', op: 'kick', initiator: 'A', subject: 'B', nonce: 'n',
    });
    expect(securityActionCanonical({ op: 'join', initiator: 'A', namespace: 'tasks', nonce: 'n' })).toEqual({
      authority: 'mebular-security', op: 'join', initiator: 'A', namespace: 'tasks', nonce: 'n',
    });
    expect(securityActionCanonical({ op: 'tier', initiator: 'A', level: 'high', nonce: 'n' })).toEqual({
      authority: 'mebular-security', op: 'tier', initiator: 'A', level: 'high', nonce: 'n',
    });
    expect(securityActionCanonical({
      op: 'rotate', initiator: 'A', oldKeyId: 'old', newPublicKey: 'new', nonce: 'n',
    })).toEqual({
      authority: 'mebular-security', op: 'rotate', initiator: 'A', oldKeyId: 'old', newPublicKey: 'new', nonce: 'n',
    });
  });

  test('signBreakGlass join/tier 与显式 nonce/ttl', () => {
    const recovery = generateRecoveryCode(1_000);
    const join = signBreakGlass({
      code: recovery.code, op: 'join', initiator: 'A', namespace: 'tasks', nonce: 'fixed', now: 10, ttlMs: 99,
    });
    expect(join.proof.nonce).toBe('fixed');
    expect(join.proof.expiresAt).toBe(109);
    expect(verifyBreakGlassProof(join.proof, {
      publicKeyHex: recovery.publicKeyHex, expectedDigest: join.digest, currentKeyId: recovery.keyId,
    }).ok).toBe(true);
    const tier = signBreakGlass({ code: recovery.code, op: 'tier', initiator: 'A', level: 'high' });
    expect(verifyBreakGlassProof(tier.proof, {
      publicKeyHex: recovery.publicKeyHex, expectedDigest: tier.digest, currentKeyId: recovery.keyId,
    }).ok).toBe(true);
    const rotate = signBreakGlass({
      code: recovery.code, op: 'rotate', initiator: 'A', oldKeyId: 'old', newPublicKey: 'new',
    });
    expect(rotate.digest).toBe(securityActionDigest({
      op: 'rotate', initiator: 'A', oldKeyId: 'old', newPublicKey: 'new', nonce: rotate.nonce,
    }));
  });

  test('verifyBreakGlassProof 失败分支', () => {
    const recovery = generateRecoveryCode();
    const signed = signBreakGlass({ code: recovery.code, op: 'kick', initiator: 'A', subject: 'B' });
    expect(verifyBreakGlassProof(null as unknown as BreakGlassProof, { publicKeyHex: '00' }))
      .toEqual({ ok: false, reason: 'invalid-proof' });
    expect(verifyBreakGlassProof(signed.proof, { publicKeyHex: recovery.publicKeyHex, currentKeyId: 'other' }))
      .toEqual({ ok: false, reason: 'invalid-proof' });
    expect(verifyBreakGlassProof(signed.proof, { publicKeyHex: recovery.publicKeyHex, expectedDigest: '00' }))
      .toEqual({ ok: false, reason: 'invalid-proof' });
    expect(verifyBreakGlassProof(signed.proof, { publicKeyHex: 'zz' }))
      .toEqual({ ok: false, reason: 'invalid-proof' });
  });

  test('signCosignProof 显式 pairing/ttl；verify 非法 hex 返回 false', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const publicHex = Buffer.from(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))).toString('hex');
    const digest = securityActionDigest({ op: 'kick', initiator: 'A', subject: 'B', nonce: 'n' });
    const proof = await signCosignProof({
      privateKey: keyPair.privateKey,
      approver: 'B',
      approverCertificateChain: [],
      approvalId: 'a',
      op: 'kick',
      digest,
      pairingCode: '111-222',
      now: 5,
      ttlMs: 10,
    });
    expect(proof.pairingCode).toBe('111-222');
    expect(proof.expiresAt).toBe(15);
    expect(await verifyCosignProofSignature(proof, publicHex)).toBe(true);
    expect(await verifyCosignProofSignature(proof, 'zz')).toBe(false);
  });

  test('collectRecoveryRegistry 覆盖 tier/revoke/subscription/restore 与空记录', () => {
    const recovery = generateRecoveryCode();
    const proof = signBreakGlass({ code: recovery.code, op: 'kick', initiator: 'A', subject: 'B' }).proof;
    const events: PolicyEvent[] = [
      { id: '1', type: 'security_tier', timestamp: 1, data: { securityTier: { breakGlass: proof } } },
      { id: '2', type: 'device_revoke', timestamp: 2, data: { deviceRevoke: { breakGlass: { ...proof, nonce: 'n2' } } } },
      { id: '3', type: 'namespace_subscription', timestamp: 3, data: { subscription: { breakGlass: { ...proof, nonce: 'n3' } } } },
      { id: '4', type: 'device_restore', timestamp: 4, data: { deviceRestore: { breakGlass: { ...proof, nonce: 'n4' } } } },
      { id: '5', type: 'security_recovery', timestamp: 5, data: { securityRecovery: { keyId: 'k', publicKey: '00', createdAt: 5, mode: 'set' } } },
      { id: '6', type: 'other', timestamp: 6, data: { securityTier: null } },
      { id: '7', type: 'security_tier', timestamp: 1, data: { securityTier: {} } },
    ];
    const registry = collectRecoveryRegistry(events);
    expect(registry.currentKeyId).toBe('k');
    expect(registry.usedNonces.size).toBe(4);
    expect(registry.lastUsedAt).toBe(4);
    expect(registry.keys.k?.publicKeyHex).toBe('00');
    // 同一 timestamp 的 id 兜底
    const tie = collectRecoveryRegistry([
      { id: 'b', type: 'security_tier', timestamp: 1, data: {} },
      { id: 'a', type: 'security_tier', timestamp: 1, data: {} },
    ]);
    expect(tie.usedNonces.size).toBe(0);
  });

  test('latestRecoveryRecord / approvals / pending / findApproval 分支', () => {
    const base = { createdAt: 1, mode: 'set' as const };
    const events: PolicyEvent[] = [
      { id: '1', type: 'security_recovery', timestamp: 1, data: { securityRecovery: { ...base, keyId: 'a', publicKey: '00' } } },
      { id: '2', type: 'security_recovery', timestamp: 2, data: { securityRecovery: { ...base, keyId: 'b', publicKey: '00' } } },
      { id: '3', type: 'security_recovery', timestamp: 3, data: { securityRecovery: { ...base, publicKey: '00' } } },
      { id: '4', type: 'other', timestamp: 4, data: {} },
    ];
    expect(latestRecoveryRecord(events)?.keyId).toBe('b');
    expect(latestRecoveryRecord([])).toBeNull();
    const approval = {
      approvalId: 'a1', op: 'kick' as const, decision: 'request' as const, initiator: 'A',
      target: 'B', nonce: 'n', digest: 'd', pairingCode: '111-222', expiresAt: Date.now() + 10_000, issuedAt: 1,
    };
    const approvalEvents: PolicyEvent[] = [
      { id: 'a', type: 'security_approval', data: { securityApproval: approval } },
      { id: 'b', type: 'security_approval', data: {} },
      { id: 'c', type: 'other', data: { securityApproval: approval } },
      { id: 'd', type: 'security_approval', data: { securityApproval: { ...approval, approvalId: 'a2', decision: 'approve' } } },
      { id: 'e', type: 'security_approval', data: { securityApproval: { ...approval, approvalId: 'a3', expiresAt: 0 } } },
    ];
    expect(approvalsFromEvents(approvalEvents)).toHaveLength(3);
    expect(pendingApprovals(approvalEvents).map((entry) => entry.approvalId)).toEqual(['a1']);
    expect(findApproval(approvalEvents, 'a2')?.approvalId).toBe('a2');
    expect(findApproval(approvalEvents, 'missing')).toBeNull();
  });

  test('record 写入包装器与缺 eventLog 分支', async () => {
    const app = memoryApp();
    await writeSecurityApproval(app, {
      approvalId: 'a', op: 'tier', decision: 'request', initiator: 'A', nonce: 'n', digest: 'd',
      pairingCode: '111-222', expiresAt: 1, issuedAt: 1,
    });
    await writeSecurityRecovery(app, { keyId: 'k', publicKey: '00', createdAt: 1, mode: 'set' });
    await writeSecurityTotpAudit(app, { device: 'A', fingerprint: 'abcd', issuedAt: 1 });
    expect(app.events.map((event) => event.type)).toEqual([
      'security_approval', 'security_recovery', 'security_totp',
    ]);
    const empty = {} as SecurityApp;
    await expect(appendSecurityRecord(empty, 'x', 'y', {})).rejects.toThrow(/eventLog/);
    expect(await listPolicyEvents(empty)).toEqual([]);
  });
});

describe('S2 覆盖率补齐 · 档位/吊销记录写入', () => {
  test('readSecurityState 全字段/空值/异常/非法 level', async () => {
    const full = await readSecurityState({
      getSecurityTier: async () => ({
        level: 'high', changedAt: 1, changedBy: 'device-A', admitted: ['a', 1], recoveryKeyId: 'k',
        rejections: [{ eventId: 'e', reason: 'r' }, null],
      }),
    });
    expect(full).toMatchObject({
      level: 'high', changedAt: 1, changedBy: 'device-A', admitted: ['a'], recoveryKeyId: 'k',
      rejections: [{ eventId: 'e', reason: 'r' }], coreTierAvailable: true,
    });
    expect((await readSecurityState({ getSecurityTier: async () => null })).level).toBe('low');
    expect((await readSecurityState({ getSecurityTier: async () => { throw new Error('x'); } })).level).toBe('low');
    expect((await readSecurityState({ getSecurityTier: async () => ({ level: 'weird' }) })).level).toBe('low');
    expect(normalizeSecurityLevel('medium')).toBe('medium');
    expect(normalizeSecurityLevel('high')).toBe('high');
    expect(normalizeSecurityLevel('x')).toBe('low');
  });

  test('writeSecurityTier setSecurityTier 有/无 id 与直接落图', async () => {
    const withId = memoryApp({ setSecurityTier: async () => ({ id: 'tier-1' }) });
    expect(await writeSecurityTier(withId, { level: 'medium', note: 'n', nonce: 'x' })).toEqual({ id: 'tier-1', level: 'medium' });
    expect(withId.events).toHaveLength(0);
    const noId = memoryApp({ setSecurityTier: async () => null });
    expect(await writeSecurityTier(noId, { level: 'low' })).toEqual({ level: 'low' });

    const app = memoryApp();
    const recovery = generateRecoveryCode();
    const proof = signBreakGlass({ code: recovery.code, op: 'tier', initiator: 'A', level: 'low' }).proof;
    const result = await writeSecurityTier(app, { level: 'low', note: 'drop', breakGlass: proof });
    expect(result.id).toBe('e-1');
    const record = app.events[0]?.data?.securityTier as Record<string, unknown>;
    expect(record.nonce).toBe(proof.nonce);
    expect(record.note).toBe('drop');
    expect(record.breakGlass).toEqual(proof);
  });

  test('writeDeviceRevoke 证明/revokeDevice/直接落图', async () => {
    const app = memoryApp();
    const recovery = generateRecoveryCode();
    const proof = signBreakGlass({ code: recovery.code, op: 'kick', initiator: 'A', subject: 'B' }).proof;
    await writeDeviceRevoke(app, { subject: 'B', note: 'n', breakGlass: proof });
    const record = app.events[0]?.data?.deviceRevoke as Record<string, unknown>;
    expect(record.nonce).toBe(proof.nonce);
    expect(record.note).toBe('n');

    const cosign = { v: 1, op: 'kick', approver: 'C', approverCertificateChain: [], approvalId: 'a', digest: 'd', pairingCode: '111-222', issuedAt: 1, expiresAt: 2, signature: 's' } as CosignProof;
    await writeDeviceRevoke(app, { subject: 'D', cosign });
    expect((app.events[1]?.data?.deviceRevoke as Record<string, unknown>).cosign).toEqual(cosign);

    const revokeApp = memoryApp({
      revokeDevice: async () => ({ id: 'r-1' }),
    });
    expect(await writeDeviceRevoke(revokeApp, { subject: 'E' })).toEqual({ id: 'r-1' });
    const noIdApp = memoryApp({
      revokeDevice: async () => null,
    });
    expect(await writeDeviceRevoke(noIdApp, { subject: 'E' })).toEqual({});
    const appendApp = memoryApp();
    await writeDeviceRevoke(appendApp, { subject: 'F', note: 'fallback' });
    expect(appendApp.events[0]?.data?.deviceRevoke).toMatchObject({ subject: 'F', note: 'fallback' });
  });
});

describe('S2 覆盖率补齐 · 高风险门禁', () => {
  test('medium：种子缺失 / 锁定 / 重放', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gate-cov-'));
    try {
      const app: SecurityApp = { deviceId: 'A', getSecurityTier: async () => ({ level: 'medium', admitted: [], rejections: [] }) };
      const missing = await evaluateSecurityGate(app, root, { action: 'invite', code: '123456' });
      expect(missing).toMatchObject({ status: 403, error: 'totp_not_configured' });

      const secret = generateTotpSecret();
      await writeTotpSeed(root, secret);
      const now = 1_800_000;
      const code = totpCodeAt(secret, Math.floor(now / 30_000));
      const first = await evaluateSecurityGate(app, root, { action: 'revoke', subject: 'B', code, now, sleep: noSleep });
      expect(first.ok).toBe(true);
      const replay = await evaluateSecurityGate(app, root, { action: 'revoke', subject: 'B', code, now, sleep: noSleep });
      expect(replay).toMatchObject({ status: 403, error: 'totp_replayed' });

      const bad = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i += 1) {
        await evaluateSecurityGate(app, root, { action: 'invite', code: bad, now, sleep: noSleep });
      }
      const locked = await evaluateSecurityGate(app, root, { action: 'invite', code, now, sleep: noSleep });
      expect(locked.status).toBe(429);
      expect(locked.error).toBe('totp_locked');
      expect(locked.retryAfterMs).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('high：breakGlass 覆盖 kick/join/tier、过期 key、错误 digest、重放', async () => {
    const recovery = generateRecoveryCode();
    const app = memoryApp({
      deviceId: 'A',
      getSecurityTier: async () => ({ level: 'high', admitted: ['A', 'B'], rejections: [] }),
    });
    await writeSecurityRecovery(app, {
      keyId: recovery.keyId, publicKey: recovery.publicKeyHex, createdAt: 1, mode: 'set',
    });
    const kick = signBreakGlass({ code: recovery.code, op: 'kick', initiator: 'A', subject: 'B' });
    const join = signBreakGlass({ code: recovery.code, op: 'join', initiator: 'A', namespace: 'tasks' });
    const tier = signBreakGlass({ code: recovery.code, op: 'tier', initiator: 'A', level: 'low' });
    expect((await evaluateSecurityGate(app, '', { action: 'revoke', subject: 'B', breakGlass: kick.proof })).ok).toBe(true);
    expect((await evaluateSecurityGate(app, '', { action: 'invite', namespace: 'tasks', breakGlass: join.proof })).ok).toBe(true);
    expect((await evaluateSecurityGate(app, '', { action: 'tier', level: 'low', breakGlass: tier.proof })).ok).toBe(true);

    const wrongKey = generateRecoveryCode();
    expect((await evaluateSecurityGate(app, '', { action: 'revoke', subject: 'B', breakGlass: wrongKey.code ? signBreakGlass({ code: wrongKey.code, op: 'kick', initiator: 'A', subject: 'B' }).proof : kick.proof })))
      .toMatchObject({ status: 403, error: 'proof_invalid' });

    const wrongDigest = signBreakGlass({ code: recovery.code, op: 'kick', initiator: 'A', subject: 'C' });
    expect((await evaluateSecurityGate(app, '', { action: 'revoke', subject: 'B', breakGlass: wrongDigest.proof })))
      .toMatchObject({ status: 403, error: 'proof_invalid' });

    const replayProof = signBreakGlass({ code: recovery.code, op: 'kick', initiator: 'A', subject: 'X' });
    await writeDeviceRevoke(app, { subject: 'X', breakGlass: replayProof.proof });
    expect((await evaluateSecurityGate(app, '', { action: 'revoke', subject: 'X', breakGlass: replayProof.proof })))
      .toMatchObject({ status: 403, error: 'proof_replayed' });
  });

  test('high：approvalId 的 op/target/level/namespace/digest/approver 分支', async () => {
    const app = memoryApp({
      deviceId: 'A',
      getSecurityTier: async () => ({ level: 'high', admitted: ['A', 'B'], rejections: [] }),
    });
    const approvalId = 'a-1';
    const nonce = 'n-1';
    const digest = securityActionDigest({ op: 'kick', initiator: 'A', subject: 'B', nonce });
    await writeSecurityApproval(app, {
      approvalId, op: 'kick', decision: 'approve', initiator: 'A', target: 'B', nonce, digest,
      pairingCode: '111-222', expiresAt: 100, issuedAt: 1,
    });
    expect((await evaluateSecurityGate(app, '', { action: 'revoke', subject: 'B', approvalId })).ok).toBe(true);
    expect((await evaluateSecurityGate(app, '', { action: 'revoke', subject: 'C', approvalId })))
      .toMatchObject({ error: 'approval_invalid' });
    expect((await evaluateSecurityGate(app, '', { action: 'invite', namespace: 'tasks', approvalId })))
      .toMatchObject({ error: 'approval_invalid' });
    expect((await evaluateSecurityGate(app, '', { action: 'tier', level: 'low', approvalId })))
      .toMatchObject({ error: 'approval_invalid' });
    expect((await evaluateSecurityGate(app, '', { action: 'revoke', subject: 'B', approvalId: 'missing' })))
      .toMatchObject({ error: 'approval_missing' });

    // digest 不一致
    const badApp = memoryApp({
      deviceId: 'A',
      getSecurityTier: async () => ({ level: 'high', admitted: ['A', 'B'], rejections: [] }),
    });
    await writeSecurityApproval(badApp, {
      approvalId: 'bad', op: 'kick', decision: 'approve', initiator: 'A', target: 'B', nonce,
      digest: '00', pairingCode: '111-222', expiresAt: 100, issuedAt: 1,
    });
    expect((await evaluateSecurityGate(badApp, '', { action: 'revoke', subject: 'B', approvalId: 'bad' })))
      .toMatchObject({ error: 'approval_invalid' });

    // cosign 的 approver = initiator / subject / 未准入 / 签名无效
    const cosign = {
      v: 1 as const, op: 'kick' as const, approver: 'A', approverCertificateChain: [], approvalId,
      digest, pairingCode: '111-222', issuedAt: 1, expiresAt: 2, signature: 's',
    };
    const selfApp = memoryApp({
      deviceId: 'A',
      getSecurityTier: async () => ({ level: 'high', admitted: ['A', 'B'], rejections: [] }),
    });
    await writeSecurityApproval(selfApp, {
      approvalId, op: 'kick', decision: 'approve', initiator: 'A', target: 'B', nonce, digest,
      pairingCode: '111-222', expiresAt: 100, issuedAt: 1, cosign,
    });
    expect((await evaluateSecurityGate(selfApp, '', { action: 'revoke', subject: 'B', approvalId })))
      .toMatchObject({ error: 'approval_invalid' });

    const subjectApp = memoryApp({
      deviceId: 'A',
      getSecurityTier: async () => ({ level: 'high', admitted: ['A', 'B'], rejections: [] }),
    });
    const subjectCosign = { ...cosign, approver: 'B' };
    await writeSecurityApproval(subjectApp, {
      approvalId, op: 'kick', decision: 'approve', initiator: 'A', target: 'B', nonce, digest,
      pairingCode: '111-222', expiresAt: 100, issuedAt: 1, cosign: subjectCosign,
    });
    expect((await evaluateSecurityGate(subjectApp, '', { action: 'revoke', subject: 'B', approvalId })))
      .toMatchObject({ error: 'approval_invalid' });

    const notAdmitted = memoryApp({
      deviceId: 'A',
      getSecurityTier: async () => ({ level: 'high', admitted: ['A'], rejections: [] }),
    });
    const outsider = { ...cosign, approver: 'Z' };
    await writeSecurityApproval(notAdmitted, {
      approvalId, op: 'kick', decision: 'approve', initiator: 'A', target: 'B', nonce, digest,
      pairingCode: '111-222', expiresAt: 100, issuedAt: 1, cosign: outsider,
    });
    expect((await evaluateSecurityGate(notAdmitted, '', { action: 'revoke', subject: 'B', approvalId })))
      .toMatchObject({ error: 'approver_not_admitted' });

    const badSigApp = memoryApp({
      deviceId: 'A',
      getSecurityTier: async () => ({ level: 'high', admitted: ['A', 'B'], rejections: [] }),
    });
    const badSig = { ...cosign, approver: 'B', approverCertificateChain: [{ devicePublicKey: '00' }] };
    await writeSecurityApproval(badSigApp, {
      approvalId, op: 'kick', decision: 'approve', initiator: 'A', target: 'B', nonce, digest,
      pairingCode: '111-222', expiresAt: 100, issuedAt: 1, cosign: badSig as CosignProof,
    });
    expect((await evaluateSecurityGate(badSigApp, '', { action: 'revoke', subject: 'B', approvalId })))
      .toMatchObject({ error: 'approval_invalid' });
  });

  test('high：直接 cosign 的 proof 分支', async () => {
    const nonce = 'n-direct';
    const digest = securityActionDigest({ op: 'kick', initiator: 'A', subject: 'B', nonce });
    const approvalId = 'a-direct';
    const cosign = {
      v: 1 as const, op: 'kick' as const, approver: 'C', approverCertificateChain: [], approvalId,
      digest, pairingCode: '111-222', issuedAt: 1, expiresAt: 2, signature: 's',
    };
    const app = memoryApp({
      deviceId: 'A',
      getSecurityTier: async () => ({ level: 'high', admitted: ['A', 'B', 'C'], rejections: [] }),
    });
    await writeSecurityApproval(app, {
      approvalId, op: 'kick', decision: 'approve', initiator: 'A', target: 'B', nonce, digest,
      pairingCode: '111-222', expiresAt: 100, issuedAt: 1, cosign,
    });
    expect((await evaluateSecurityGate(app, '', { action: 'revoke', subject: 'B', cosign })).ok).toBe(true);
    expect((await evaluateSecurityGate(app, '', { action: 'revoke', subject: 'B', cosign: { ...cosign, digest: '00' } })))
      .toMatchObject({ error: 'proof_invalid' });
    expect((await evaluateSecurityGate(app, '', { action: 'revoke', subject: 'B', cosign: { ...cosign, approvalId: 'missing' } })))
      .toMatchObject({ error: 'approval_missing' });
    const self = { ...cosign, approver: 'A', approvalId };
    const selfApp = memoryApp({
      deviceId: 'A',
      getSecurityTier: async () => ({ level: 'high', admitted: ['A', 'B'], rejections: [] }),
    });
    await writeSecurityApproval(selfApp, {
      approvalId, op: 'kick', decision: 'approve', initiator: 'A', target: 'B', nonce, digest,
      pairingCode: '111-222', expiresAt: 100, issuedAt: 1, cosign: { ...cosign, approver: 'A' },
    });
    expect((await evaluateSecurityGate(selfApp, '', { action: 'revoke', subject: 'B', cosign: self })))
      .toMatchObject({ error: 'proof_invalid' });
    const subjectApp = memoryApp({
      deviceId: 'A',
      getSecurityTier: async () => ({ level: 'high', admitted: ['A', 'B'], rejections: [] }),
    });
    const subjectCosign = { ...cosign, approver: 'B' };
    await writeSecurityApproval(subjectApp, {
      approvalId, op: 'kick', decision: 'approve', initiator: 'A', target: 'B', nonce, digest,
      pairingCode: '111-222', expiresAt: 100, issuedAt: 1, cosign: subjectCosign,
    });
    expect((await evaluateSecurityGate(subjectApp, '', { action: 'revoke', subject: 'B', cosign: subjectCosign })))
      .toMatchObject({ error: 'proof_invalid' });
    const notAdmitted = memoryApp({
      deviceId: 'A',
      getSecurityTier: async () => ({ level: 'high', admitted: ['A'], rejections: [] }),
    });
    const outsider = { ...cosign, approver: 'Z' };
    await writeSecurityApproval(notAdmitted, {
      approvalId, op: 'kick', decision: 'approve', initiator: 'A', target: 'B', nonce, digest,
      pairingCode: '111-222', expiresAt: 100, issuedAt: 1, cosign: outsider,
    });
    expect((await evaluateSecurityGate(notAdmitted, '', { action: 'revoke', subject: 'B', cosign: outsider })))
      .toMatchObject({ error: 'approver_not_admitted' });
  });
});

describe('S2 覆盖率补齐 · 备份解析/恢复失败', () => {
  async function makeBackup(root: string): Promise<{ dir: string; file: Awaited<ReturnType<typeof exportMasterKeyBackup>>['file']; code: string }> {
    const dir = join(root, 'source');
    const key = await generateMasterKey();
    await writeMasterKeyFile(join(dir, 'master-key.json'), key);
    const code = formatRecoveryCode(encodeRecoveryCode(randomBytes(20)));
    const exported = await exportMasterKeyBackup({ dir, code, note: 'n' });
    return { dir, file: exported.file, code };
  }

  function reencrypt(file: Awaited<ReturnType<typeof exportMasterKeyBackup>>['file'], code: string, payload: unknown) {
    const secret = decodeRecoveryCode(code);
    const key = scryptSync(Buffer.from(secret), Buffer.from(file.kdf.salt, 'base64'), 32, {
      N: file.kdf.N, r: file.kdf.r, p: file.kdf.p, maxmem: 128 * 1024 * 1024,
    });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf-8'), cipher.final()]);
    return {
      ...file,
      cipher: {
        ...file.cipher,
        iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      },
    };
  }

  test('parseBackupFile 形状/算法错误；载荷形状/公钥/私钥不匹配', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-cov-'));
    try {
      const { file, code } = await makeBackup(root);
      await expect(restoreMasterKeyBackup({ file: { ...file, kind: 'x' as never }, code, dir: root }))
        .rejects.toThrow(/形状非法/);
      await expect(restoreMasterKeyBackup({ file: { ...file, v: 2 as never }, code, dir: root }))
        .rejects.toThrow(/形状非法/);
      await expect(restoreMasterKeyBackup({ file: { ...file, kdf: { ...file.kdf, name: 'x' as never } }, code, dir: root }))
        .rejects.toThrow(/算法不支持/);
      await expect(restoreMasterKeyBackup({ file: { ...file, cipher: { ...file.cipher, name: 'x' as never } }, code, dir: root }))
        .rejects.toThrow(/算法不支持/);

      const shape = reencrypt(file, code, { masterPublicKeyHex: file.masterPublicKeyHex });
      await expect(restoreMasterKeyBackup({ file: shape, code, dir: root }))
        .rejects.toThrow(/载荷形状非法/);

      const publicMismatch = reencrypt(file, code, {
        masterPrivateKeyPkcs8: 'AA==', masterPublicKeyHex: '00',
      });
      await expect(restoreMasterKeyBackup({ file: publicMismatch, code, dir: root }))
        .rejects.toThrow(/主公钥指纹不一致/);

      const other = await generateMasterKey();
      const otherPkcs8 = Buffer.from(new Uint8Array(await crypto.subtle.exportKey('pkcs8', other.userMasterPrivateKey!))).toString('base64');
      const privateMismatch = reencrypt(file, code, {
        masterPrivateKeyPkcs8: otherPkcs8, masterPublicKeyHex: file.masterPublicKeyHex,
      });
      await expect(restoreMasterKeyBackup({ file: privateMismatch, code, dir: root }))
        .rejects.toThrow(/私钥与主公钥不匹配/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('resolveHomeMasterKey：fleet/daemon/裸文件/缺失', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resolve-key-'));
    try {
      const key = await generateMasterKey();
      const keyPath = join(root, 'k.json');
      await writeMasterKeyFile(keyPath, key);
      // daemon + userMasterPublicKeyFile
      const d1 = join(root, 'd1');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(d1, { recursive: true }));
      await writeFile(join(d1, 'config.json'), JSON.stringify({ deviceId: 'D', encryption: { userMasterPublicKeyFile: keyPath } }), 'utf-8');
      expect((await resolveHomeMasterKey(d1)).deviceId).toBe('D');
      // daemon + keyFile
      const d2 = join(root, 'd2');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(d2, { recursive: true }));
      await writeFile(join(d2, 'config.json'), JSON.stringify({ encryption: { keyFile: keyPath } }), 'utf-8');
      expect((await resolveHomeMasterKey(d2)).keyPath).toBe(keyPath);
      // daemon + 默认 user-master-key.json
      const d3 = join(root, 'd3');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(d3, { recursive: true }));
      await writeFile(join(d3, 'config.json'), '{}', 'utf-8');
      await writeMasterKeyFile(join(d3, 'user-master-key.json'), key);
      expect((await resolveHomeMasterKey(d3)).keyPath).toBe(join(d3, 'user-master-key.json'));
      // 裸 master-key.json / user-master-key.json
      const bare = join(root, 'bare');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(bare, { recursive: true }));
      await writeMasterKeyFile(join(bare, 'master-key.json'), key);
      expect((await resolveHomeMasterKey(bare)).keyPath).toBe(join(bare, 'master-key.json'));
      const bare2 = join(root, 'bare2');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(bare2, { recursive: true }));
      await writeMasterKeyFile(join(bare2, 'user-master-key.json'), key);
      expect((await resolveHomeMasterKey(bare2)).keyPath).toBe(join(bare2, 'user-master-key.json'));
      await expect(resolveHomeMasterKey(join(root, 'empty'))).rejects.toThrow(/未找到主密钥文件/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('export 生成码/note；restore with device 与失败清理', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-device-'));
    try {
      const source = join(root, 'source');
      const key = await generateMasterKey();
      await writeMasterKeyFile(join(source, 'master-key.json'), key);
      const exported = await exportMasterKeyBackup({ dir: source, note: 'note' });
      expect(exported.codeGenerated).toBe(true);
      expect(exported.file.kdf.N).toBe(32768);
      expect(exported.fingerprint).toBe(masterKeyFingerprint(key.userMasterKey));

      const target = join(root, 'target');
      const restored = await restoreMasterKeyBackup({
        file: exported.file,
        code: exported.code,
        dir: target,
        device: 'device-R',
        namespace: 'tasks',
      });
      expect(restored.onboarded).toBe(true);
      expect(restored.configPath).toBe(join(target, 'fleet.config.json'));
      expect((await readMasterKeyFile(join(target, 'master-key.json'))).userMasterKey).toBeDefined();

      const failing = join(root, 'failing');
      await expect(restoreMasterKeyBackup({
        file: exported.file,
        code: exported.code,
        dir: failing,
        device: '',
      })).rejects.toThrow(/onboard 需要/);
      await expect(readFile(join(failing, 'master-key.json'), 'utf-8')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('S2 覆盖率补齐 · QR 渲染分支', () => {
  test('renderTotpShare/TotpShareSvg 的 qr 开关/缺依赖/注入实现', async () => {
    const secret = generateTotpSecret();
    const fakeQr = {
      toString: async () => '<svg>fake</svg>',
      toDataURL: async () => 'data:image/png;base64,AA==',
    };
    const text = await renderTotpShare(secret, 'device-A', { loadQrModule: () => fakeQr });
    expect(text.qrText).toBe('<svg>fake</svg>');
    const noQr = await renderTotpShare(secret, 'device-A', { qr: false });
    expect(noQr.qrText).toBeUndefined();
    const missing = await renderTotpShare(secret, 'device-A', {
      loadQrModule: () => { throw new Error('missing'); },
    });
    expect(missing.qrText).toBeUndefined();

    expect(await renderTotpShareSvg(secret, 'device-A', { qr: false })).toBeNull();
    expect(await renderTotpShareSvg(secret, 'device-A', { loadQrModule: () => fakeQr })).toBe('<svg>fake</svg>');
    expect(await renderTotpShareSvg(secret, 'device-A', {
      loadQrModule: () => { throw new Error('missing'); },
    })).toBeNull();
  });
});
