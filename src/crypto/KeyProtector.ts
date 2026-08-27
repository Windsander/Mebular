// 私钥静态保护：PBKDF2 口令派生 + AES-256-GCM 加密存放
//
// 只依赖 Web Crypto（零运行时新增依赖）。用途：身份文件中的设备私钥
// 从明文 PKCS8 升级为口令加密封套；口令本身不落盘，
// 由门面配置或 keychain 接缝注入。
//
// 诚实语义：GCM 认证失败无法区分「口令错误」与「数据损坏」，
// 错误信息如实并列两种可能。

import { CryptoError } from '../errors.js';
import { bytesToBase64, base64ToBytes } from '../p2p/handshake/AuthenticationHandshake.js';

/** 加密私钥材料（JSON 可序列化，随身份文件存放） */
export interface EncryptedKeyMaterial {
  version: 1;
  kdf: 'PBKDF2';
  hash: 'SHA-256';
  /** PBKDF2 迭代次数（OWASP 2023 建议 SHA-256 ≥ 210000） */
  iterations: number;
  /** base64，16 字节随机盐 */
  salt: string;
  cipher: 'AES-256-GCM';
  /** base64，12 字节随机 IV */
  iv: string;
  /** base64，密文 + GCM 认证标签 */
  data: string;
}

export const DEFAULT_PBKDF2_ITERATIONS = 210_000;

async function deriveAesKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt.buffer as ArrayBuffer, iterations },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 用口令加密私钥 PKCS8 字节；每次调用产生新盐与新 IV */
export async function encryptPrivateKeyPkcs8(
  pkcs8: Uint8Array,
  passphrase: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<EncryptedKeyMaterial> {
  if (!passphrase) {
    throw new CryptoError('加密私钥需要非空口令');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const key = await deriveAesKey(passphrase, salt, iterations);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
      key,
      pkcs8.buffer as ArrayBuffer,
    );
    return {
      version: 1,
      kdf: 'PBKDF2',
      hash: 'SHA-256',
      iterations,
      salt: bytesToBase64(salt),
      cipher: 'AES-256-GCM',
      iv: bytesToBase64(iv),
      data: bytesToBase64(new Uint8Array(ciphertext)),
    };
  } catch (error) {
    if (error instanceof CryptoError) throw error;
    throw new CryptoError('私钥加密失败', error as Error);
  }
}

/**
 * 用口令解密封套还原 PKCS8 字节。
 * 口令错误或材料被篡改都会以 GCM 认证失败收场，错误信息如实表述。
 */
export async function decryptPrivateKeyPkcs8(
  material: EncryptedKeyMaterial,
  passphrase: string,
): Promise<Uint8Array> {
  if (material.kdf !== 'PBKDF2' || material.cipher !== 'AES-256-GCM') {
    throw new CryptoError(
      `不支持的私钥封套格式：kdf=${material.kdf}, cipher=${material.cipher}`,
    );
  }
  try {
    const key = await deriveAesKey(
      passphrase,
      base64ToBytes(material.salt),
      material.iterations,
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(material.iv).buffer as ArrayBuffer },
      key,
      base64ToBytes(material.data).buffer as ArrayBuffer,
    );
    return new Uint8Array(plain);
  } catch (error) {
    if (error instanceof CryptoError) throw error;
    throw new CryptoError('私钥解密失败：口令错误或封套数据已损坏', error as Error);
  }
}
