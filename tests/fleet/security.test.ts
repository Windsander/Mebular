// S2 红绿：TOTP / 分发 / 备份恢复 / 恢复码（spec §6.2 S2-1…S2-5 的模块级用例）。

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  base32Decode,
  base32Encode,
  collectRecoveryRegistry,
  decodeRecoveryCode,
  deriveRecoveryKey,
  encodeRecoveryCode,
  evaluateSecurityGate,
  exportMasterKeyBackup,
  formatRecoveryCode,
  generateRecoveryCode,
  generateTotpSecret,
  importTotpSeed,
  pairingCodeForDigest,
  parseTotpInput,
  readTotpSeed,
  readTotpStatus,
  readSecurityState,
  renderTotpShare,
  restoreMasterKeyBackup,
  securityActionDigest,
  signBreakGlass,
  signCosignProof,
  totpCodeAt,
  totpFingerprint,
  totpOtpauthUri,
  verifyBreakGlassProof,
  verifyCosignProofSignature,
  verifyTotp,
  writeBackupFile,
  writeSecurityRecovery,
  writeTotpSeed,
  type PolicyEvent,
  type SecurityRecoveryRecord,
  type SecurityApp,
} from '../../packages/fleet/src/security.js';
import { generateMasterKey, masterKeyFingerprint, readMasterKeyFile, writeMasterKeyFile } from '../../packages/fleet/src/config.js';

const noSleep = async (): Promise<void> => undefined;

/** 假 app：只在内存事件流上落 `__policy__` 记录（与真实 EventLog append 形状一致）。 */
function fakeApp(deviceId = 'device-A'): SecurityApp & { events: PolicyEvent[] } {
  const events: PolicyEvent[] = [];
  const app = {
    deviceId,
    events,
    eventLog: {
      append: async (input: Record<string, unknown>) => {
        const event = {
          id: `ev-${events.length + 1}`,
          timestamp: Date.now(),
          author: deviceId,
          ...input,
        } as PolicyEvent;
        events.push(event);
        return event;
      },
      listEvents: async () => events,
    },
  };
  return app;
}

describe('S2-1 TOTP', () => {
  test('base32 roundtrip 与 otpauth', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect(Buffer.from(base32Decode(base32Encode(bytes))).toString('hex')).toBe(Buffer.from(bytes).toString('hex'));
    const secret = base32Encode(Buffer.from('12345678901234567890', 'utf-8'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    const uri = totpOtpauthUri(secret, 'device-A');
    expect(uri).toContain('otpauth://totp/Mebular%3Adevice-A?');
    expect(uri).toContain(`secret=${secret}`);
    expect(parseTotpInput(uri).secret).toBe(secret);
  });

  test('RFC 6238 向量（6 位）', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890', 'utf-8'));
    expect(totpCodeAt(secret, 1)).toBe('287082');
    expect(totpCodeAt(secret, 0)).toBe('755224');
  });

  test('±1 步接受、±2 拒绝；重放拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'totp-tol-'));
    try {
      const secret = generateTotpSecret();
      const now = 90_000; // step 3
      const step = Math.floor(now / 30_000);
      for (const delta of [-1, 0, 1]) {
        const dir = join(root, `d${delta}`);
        const result = await verifyTotp(secret, totpCodeAt(secret, step + delta), now, { dir, sleep: noSleep });
        expect(result.ok).toBe(true);
        expect(result.driftStep).toBe(delta);
      }
      for (const delta of [-2, 2]) {
        const dir = join(root, `x${delta}`);
        const result = await verifyTotp(secret, totpCodeAt(secret, step + delta), now, { dir, sleep: noSleep });
        expect(result.ok).toBe(false);
      }
      const dir = join(root, 'replay');
      const code = totpCodeAt(secret, step);
      expect((await verifyTotp(secret, code, now, { dir, sleep: noSleep })).ok).toBe(true);
      const replay = await verifyTotp(secret, code, now, { dir, sleep: noSleep });
      expect(replay.ok).toBe(false);
      expect(replay.reason).toBe('replay');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('5 次失败锁定 15 分钟，解锁后可再次通过', async () => {
    const root = await mkdtemp(join(tmpdir(), 'totp-lock-'));
    try {
      const secret = generateTotpSecret();
      const now = 1_800_000; // step 60
      const code = totpCodeAt(secret, 60);
      const bad = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 4; i += 1) {
        const result = await verifyTotp(secret, bad, now, { dir: root, sleep: noSleep });
        expect(result.ok).toBe(false);
        expect(result.failures).toBe(i + 1);
      }
      const fifth = await verifyTotp(secret, bad, now, { dir: root, sleep: noSleep });
      expect(fifth.ok).toBe(false);
      expect(fifth.reason).toBe('locked');
      const locked = await verifyTotp(secret, code, now + 60_000, { dir: root, sleep: noSleep });
      expect(locked.ok).toBe(false);
      expect(locked.reason).toBe('locked');
      const unlockAt = (fifth.lockedUntil ?? now + 15 * 60_000) + 1;
      const unlocked = await verifyTotp(secret, totpCodeAt(secret, Math.floor(unlockAt / 30_000)), unlockAt, { dir: root, sleep: noSleep });
      expect(unlocked.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('种子文件 0600；fingerprint 对账；显示需先有种子', async () => {
    const root = await mkdtemp(join(tmpdir(), 'totp-file-'));
    try {
      const secret = generateTotpSecret();
      const record = await writeTotpSeed(root, secret);
      expect(record.fingerprint).toBe(totpFingerprint(secret));
      if (process.platform !== 'win32') {
        expect((await stat(join(root, 'security-totp.json'))).mode & 0o777).toBe(0o600);
      }
      expect((await readTotpSeed(root))?.secret).toBe(secret);
      const imported = await importTotpSeed(root, secret, { expectedFingerprint: record.fingerprint });
      expect(imported.fingerprint).toBe(record.fingerprint);
      await expect(importTotpSeed(root, secret, { expectedFingerprint: 'deadbeef' })).rejects.toThrow(/指纹不一致/);
      const status = await readTotpStatus(root);
      expect(status.imported).toBe(true);
      expect(status.fingerprint).toBe(record.fingerprint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('S2-2 分发：分组文本 / otpauth / fingerprint（QR 关闭时降级为文本）', async () => {
    const secret = generateTotpSecret();
    const share = await renderTotpShare(secret, 'device-A', { qr: false });
    expect(share.qrText).toBeUndefined();
    expect(share.groups.replace(/\s/g, '')).toBe(secret);
    expect(share.otpauth).toContain('otpauth://totp/');
    expect(share.fingerprint).toHaveLength(8);
    // QR 开启但 qrcode 缺失时也必须有文本/otpauth（不阻断）
    const withQr = await renderTotpShare(secret, 'device-A', {
      qr: true,
      loadQrModule: () => {
        throw new Error('Cannot find module qrcode');
      },
    });
    expect(withQr.qrText).toBeUndefined();
    expect(withQr.groups.replace(/\s/g, '')).toBe(secret);
    expect(withQr.otpauth).toContain('otpauth://totp/');
  });
});

describe('S2-4 备份 / 恢复', () => {
  test('导出/恢复往返，主公钥一致；备份文件不含明文私钥；0600', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-'));
    try {
      const source = join(root, 'source');
      const target = join(root, 'target');
      const key = await generateMasterKey();
      await writeMasterKeyFile(join(source, 'master-key.json'), key);
      const code = formatRecoveryCode(encodeRecoveryCode(crypto.getRandomValues(new Uint8Array(20))));
      const exported = await exportMasterKeyBackup({ dir: source, code });
      expect(exported.codeGenerated).toBe(false);
      expect(exported.fingerprint).toBe(masterKeyFingerprint(key.userMasterKey));
      const serialized = JSON.stringify(exported.file);
      expect(serialized).not.toContain('privateKeyPkcs8');
      expect(serialized).not.toContain(Buffer.from(exported.file.kdf.salt, 'base64').toString('hex'));
      const backupPath = join(root, 'backup.json');
      await writeBackupFile(backupPath, exported.file);
      if (process.platform !== 'win32') {
        expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
      }
      const restored = await restoreMasterKeyBackup({
        file: await readFile(backupPath, 'utf-8'),
        code,
        dir: target,
        keyPath: join(target, 'master-key.json'),
      });
      const restoredKey = await readMasterKeyFile(join(target, 'master-key.json'));
      expect(Buffer.from(restoredKey.userMasterKey).toString('hex')).toBe(Buffer.from(key.userMasterKey).toString('hex'));
      expect(restored.fingerprint).toBe(exported.fingerprint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('错码 / 篡改文件 → 失败且无半成品残留', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-bad-'));
    try {
      const source = join(root, 'source');
      const key = await generateMasterKey();
      await writeMasterKeyFile(join(source, 'master-key.json'), key);
      const code = formatRecoveryCode(encodeRecoveryCode(crypto.getRandomValues(new Uint8Array(20))));
      const { file } = await exportMasterKeyBackup({ dir: source, code });
      const wrongCode = formatRecoveryCode(encodeRecoveryCode(crypto.getRandomValues(new Uint8Array(20))));
      const targetWrong = join(root, 'wrong');
      await expect(restoreMasterKeyBackup({
        file, code: wrongCode, dir: targetWrong, keyPath: join(targetWrong, 'master-key.json'),
      })).rejects.toThrow(/备份码错误|篡改/);
      await expect(stat(join(targetWrong, 'master-key.json'))).rejects.toThrow();

      const tampered = JSON.parse(JSON.stringify(file)) as typeof file;
      const raw = Buffer.from(tampered.cipher.ciphertext, 'base64');
      raw[0] = raw[0]! ^ 0xff;
      tampered.cipher.ciphertext = raw.toString('base64');
      const targetTampered = join(root, 'tampered');
      await expect(restoreMasterKeyBackup({
        file: tampered, code, dir: targetTampered, keyPath: join(targetTampered, 'master-key.json'),
      })).rejects.toThrow(/备份码错误|篡改/);
      await expect(stat(join(targetTampered, 'master-key.json'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('仅 root 可导出：委派设备（只有主公钥）明确失败', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-delegated-'));
    try {
      const source = join(root, 'source');
      const key = await generateMasterKey();
      await writeMasterKeyFile(join(source, 'master-key.json'), { userMasterKey: key.userMasterKey });
      await expect(exportMasterKeyBackup({ dir: source, code: encodeRecoveryCode(crypto.getRandomValues(new Uint8Array(20))) }))
        .rejects.toThrow(/仅 root/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('S2-5 恢复码 / break-glass', () => {
  test('Crockford 编码/校验/分组', () => {
    const secret = crypto.getRandomValues(new Uint8Array(20));
    const code = encodeRecoveryCode(secret);
    expect(code).toHaveLength(34);
    expect(Buffer.from(decodeRecoveryCode(code)).toString('hex')).toBe(Buffer.from(secret).toString('hex'));
    expect(formatRecoveryCode(code).split('-')).toHaveLength(9);
    const tampered = `${code.slice(0, 33)}${code[33] === '0' ? '1' : '0'}`;
    expect(() => decodeRecoveryCode(tampered)).toThrow(/校验失败|非法/);
    // Crockford 歧义字符归一：I/L→1、O→0
    expect(decodeRecoveryCode(code.toLowerCase().replace(/0/g, 'O'))).toEqual(secret);
  });

  test('动作摘要/配对号与 S1 core 逐字节一致（insertion-order JSON）', () => {
    const params = { op: 'kick' as const, initiator: 'device-A', subject: 'device-B', nonce: 'n-1' };
    const expectedCanonical = JSON.stringify({
      authority: 'mebular-security',
      op: 'kick',
      initiator: 'device-A',
      subject: 'device-B',
      nonce: 'n-1',
    });
    const expectedDigest = createHash('sha256').update(expectedCanonical).digest('hex');
    expect(securityActionDigest(params)).toBe(expectedDigest);
    const hash = createHash('sha256').update('mebular-pairing').update(expectedDigest).digest();
    const value = hash.readUInt32BE(0) % 1_000_000;
    const text = String(value).padStart(6, '0');
    expect(pairingCodeForDigest(expectedDigest)).toBe(`${text.slice(0, 3)}-${text.slice(3)}`);
  });

  test('HKDF→Ed25519 keyId 稳定；签名可验、digest 绑定、nonce 一次性', () => {
    const recovery = generateRecoveryCode();
    const derived = deriveRecoveryKey(recovery.code);
    expect(derived.keyId).toBe(recovery.keyId);
    expect(derived.publicKeyHex).toBe(recovery.publicKeyHex);

    const params = { op: 'kick' as const, initiator: 'device-A', subject: 'device-B', nonce: 'n-1' };
    const signed = signBreakGlass({ code: recovery.code, ...params });
    expect(signed.digest).toBe(securityActionDigest({ ...params }));
    const verify = verifyBreakGlassProof(signed.proof, {
      publicKeyHex: recovery.publicKeyHex,
      expectedDigest: signed.digest,
      currentKeyId: recovery.keyId,
      usedNonces: new Set(),
    });
    expect(verify.ok).toBe(true);
    expect(verifyBreakGlassProof(signed.proof, {
      publicKeyHex: recovery.publicKeyHex,
      currentKeyId: recovery.keyId,
      usedNonces: new Set([signed.proof.nonce]),
    })).toEqual({ ok: false, reason: 'stale-or-replayed-nonce' });
    expect(verifyBreakGlassProof(signed.proof, {
      publicKeyHex: recovery.publicKeyHex,
      expectedDigest: securityActionDigest({ ...params, subject: 'device-C' }),
      currentKeyId: recovery.keyId,
    }).ok).toBe(false);
  });

  test('轮换：旧码新签名不再采纳，新码可用；记录形状正确', async () => {
    const app = fakeApp();
    const first = generateRecoveryCode();
    await writeSecurityRecovery(app, {
      keyId: first.keyId,
      publicKey: first.publicKeyHex,
      createdAt: first.createdAt,
      mode: 'set',
    });
    const second = generateRecoveryCode();
    const rotate = signBreakGlass({
      code: first.code,
      op: 'rotate',
      initiator: 'device-A',
      oldKeyId: first.keyId,
      newPublicKey: second.publicKeyHex,
    });
    await writeSecurityRecovery(app, {
      keyId: second.keyId,
      publicKey: second.publicKeyHex,
      createdAt: second.createdAt,
      mode: 'rotate',
      nonce: rotate.proof.nonce,
      breakGlass: rotate.proof,
    });
    const records = app.events
      .filter((event) => event.type === 'security_recovery')
      .map((event) => event.data?.securityRecovery as SecurityRecoveryRecord);
    expect(records.map((record) => record.mode)).toEqual(['set', 'rotate']);
    expect(records[1]?.breakGlass?.keyId).toBe(first.keyId);
    const registry = collectRecoveryRegistry(app.events);
    expect(registry.currentKeyId).toBe(second.keyId);
    expect(registry.usedNonces.has(rotate.proof.nonce)).toBe(true);

    const oldNewAction = signBreakGlass({
      code: first.code,
      op: 'kick',
      initiator: 'device-A',
      subject: 'device-B',
      nonce: 'old-key-new-action',
    });
    expect(verifyBreakGlassProof(oldNewAction.proof, {
      publicKeyHex: first.publicKeyHex,
      currentKeyId: registry.currentKeyId,
    }).ok).toBe(false);
    const fresh = signBreakGlass({
      code: second.code,
      op: 'kick',
      initiator: 'device-A',
      subject: 'device-B',
      nonce: 'new-key-new-action',
    });
    expect(verifyBreakGlassProof(fresh.proof, {
      publicKeyHex: second.publicKeyHex,
      currentKeyId: registry.currentKeyId,
      usedNonces: registry.usedNonces,
    }).ok).toBe(true);
  });

  test('会签签名可验（Ed25519 设备密钥）', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const publicHex = Buffer.from(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))).toString('hex');
    const proof = await signCosignProof({
      privateKey: keyPair.privateKey,
      approver: 'device-B',
      approverCertificateChain: [],
      approvalId: 'approval-1',
      op: 'kick',
      digest: securityActionDigest({ op: 'kick', initiator: 'device-A', subject: 'device-C', nonce: 'n-2' }),
    });
    expect(await verifyCosignProofSignature(proof, publicHex)).toBe(true);
    proof.digest = '00'.repeat(32);
    expect(await verifyCosignProofSignature(proof, publicHex)).toBe(false);
  });
});

describe('S2-3 本机门禁（CLI/serve 共用）', () => {
  test('缺 getSecurityTier() → low（当前构建不炸）', async () => {
    const state = await readSecurityState({ deviceId: 'device-A' });
    expect(state.level).toBe('low');
    expect(state.coreTierAvailable).toBe(false);
  });

  test('medium：缺码/错码拒绝，正确码放行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gate-medium-'));
    try {
      const secret = generateTotpSecret();
      await writeTotpSeed(root, secret);
      const app: SecurityApp = {
        deviceId: 'device-A',
        getSecurityTier: async () => ({ level: 'medium', admitted: ['device-A'], rejections: [] }),
      };
      const missing = await evaluateSecurityGate(app, root, { action: 'invite' });
      expect(missing.ok).toBe(false);
      expect(missing.status).toBe(403);
      expect(missing.error).toBe('totp_required');
      const wrong = await evaluateSecurityGate(app, root, { action: 'revoke', subject: 'device-B', code: '000000', sleep: noSleep });
      expect(wrong.ok).toBe(false);
      const code = totpCodeAt(secret, Math.floor(Date.now() / 30_000));
      const ok = await evaluateSecurityGate(app, root, { action: 'revoke', subject: 'device-B', code, sleep: noSleep });
      expect(ok.ok).toBe(true);
      // medium→medium 不需要码
      expect((await evaluateSecurityGate(app, root, { action: 'tier', level: 'medium' })).ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('high：缺会签/恢复码 → 明确拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gate-high-'));
    try {
      const app: SecurityApp = {
        deviceId: 'device-A',
        getSecurityTier: async () => ({ level: 'high', admitted: ['device-A'], rejections: [] }),
      };
      const missing = await evaluateSecurityGate(app, root, { action: 'tier', level: 'low' });
      expect(missing.ok).toBe(false);
      expect(missing.status).toBe(403);
      expect(missing.error).toBe('approval_required');
      expect((await evaluateSecurityGate(app, root, { action: 'tier', level: 'high' })).ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
