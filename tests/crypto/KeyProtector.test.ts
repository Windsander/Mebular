// KeyProtector：PBKDF2+AES-GCM 私钥封套测试

import { CryptoError } from '../../src/errors.js';
import {
  DEFAULT_PBKDF2_ITERATIONS,
  decryptPrivateKeyPkcs8,
  encryptPrivateKeyPkcs8,
} from '../../src/crypto/KeyProtector.js';

const SAMPLE_PKCS8 = new Uint8Array(48).map((_, i) => i % 251);

// 低迭代加速测试；默认迭代数单独断言常量值
const FAST = 1_000;

describe('KeyProtector 私钥封套', () => {
  it('加密→解密往返还原原始字节', async () => {
    const sealed = await encryptPrivateKeyPkcs8(SAMPLE_PKCS8, 'correct horse', FAST);
    const opened = await decryptPrivateKeyPkcs8(sealed, 'correct horse');
    expect(Buffer.from(opened).equals(Buffer.from(SAMPLE_PKCS8))).toBe(true);
  });

  it('封套结构完整且每次加密的盐与 IV 都不同', async () => {
    const a = await encryptPrivateKeyPkcs8(SAMPLE_PKCS8, 'pw', FAST);
    const b = await encryptPrivateKeyPkcs8(SAMPLE_PKCS8, 'pw', FAST);
    for (const sealed of [a, b]) {
      expect(sealed.version).toBe(1);
      expect(sealed.kdf).toBe('PBKDF2');
      expect(sealed.hash).toBe('SHA-256');
      expect(sealed.cipher).toBe('AES-256-GCM');
      expect(sealed.iterations).toBe(FAST);
    }
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it('默认迭代数对齐 OWASP 建议（210000）', () => {
    expect(DEFAULT_PBKDF2_ITERATIONS).toBe(210_000);
  });

  it('口令错误时解密失败（GCM 认证不通过）', async () => {
    const sealed = await encryptPrivateKeyPkcs8(SAMPLE_PKCS8, 'right', FAST);
    await expect(decryptPrivateKeyPkcs8(sealed, 'wrong')).rejects.toThrow(CryptoError);
  });

  it('密文被篡改时解密失败', async () => {
    const sealed = await encryptPrivateKeyPkcs8(SAMPLE_PKCS8, 'pw', FAST);
    const raw = Buffer.from(sealed.data, 'base64');
    raw[0] = raw[0]! ^ 0xff;
    const tampered = { ...sealed, data: raw.toString('base64') };
    await expect(decryptPrivateKeyPkcs8(tampered, 'pw')).rejects.toThrow(CryptoError);
  });

  it('拒绝不支持的封套格式标记', async () => {
    const sealed = await encryptPrivateKeyPkcs8(SAMPLE_PKCS8, 'pw', FAST);
    const foreign = { ...sealed, cipher: 'AES-CBC' as never };
    await expect(decryptPrivateKeyPkcs8(foreign, 'pw')).rejects.toThrow('不支持的私钥封套格式');
  });

  it('空口令拒绝加密', async () => {
    await expect(encryptPrivateKeyPkcs8(SAMPLE_PKCS8, '', FAST)).rejects.toThrow(CryptoError);
  });
});
