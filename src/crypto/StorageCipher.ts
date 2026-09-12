// 记忆静态加密：user 作用域对称密钥（HKDF-SHA256）+ AES-256-GCM
//
// 设计（G1，对齐 spec-002 的 Level 3「用户主密钥加密」）：
// - 对称密钥由用户主私钥经 HKDF 派生：同一用户所有持有主密钥的设备
//   推导出同一把密钥，因此可互相解密对方落盘的记忆。
// - 密钥只用于**静态**（落盘）加密；事件签名、内容寻址、同步全部基于
//   内存明文，密码学语义不被破坏。
// - 信封格式 `enc:v1:<base64(iv(12) || ciphertext+tag)>`，可直接作为
//   JSONL 一行；无需密钥即可识别「这是密文」，但无法解出内容。
// - 缺密钥 / 错密钥一律诚实报错（STORAGE_KEY_MISSING /
//   STORAGE_DECRYPT_FAILED），绝不返回垃圾数据。
//
// 零运行时新增依赖：只用 Web Crypto。

import { ErrorCodes, StorageError } from '../errors.js';
import { bytesToBase64, base64ToBytes } from '../p2p/handshake/AuthenticationHandshake.js';

/** 密文信封前缀（版本化，便于未来轮换格式） */
export const AT_REST_PREFIX = 'enc:v1:';

const HKDF_SALT = new TextEncoder().encode('mebular/storage/salt/v1');
const HKDF_INFO = new TextEncoder().encode('mebular/storage/user-key/v1');
const IV_BYTES = 12;
const KEY_BYTES = 32;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class StorageCipher {
  private constructor(private readonly key: CryptoKey) {}

  /** 用显式 32 字节密钥构造（keychain / 身份文件分发接缝） */
  static async fromRawKey(raw: Uint8Array): Promise<StorageCipher> {
    if (raw.length !== KEY_BYTES) {
      throw new StorageError(
        `静态加密密钥必须为 ${KEY_BYTES} 字节，收到 ${raw.length} 字节`,
        ErrorCodes.CRYPTO_KEY_INVALID,
      );
    }
    const key = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(raw),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
    return new StorageCipher(key);
  }

  /**
   * 由用户主私钥派生对称密钥（HKDF-SHA256）。
   * 以主私钥的 PKCS8 字节为 IKM，固定 salt/info 保证派生确定性——
   * 同一主密钥在任意设备上派生出同一把密钥。
   */
  static async fromUserMasterPrivateKey(privateKey: CryptoKey): Promise<StorageCipher> {
    let pkcs8: Uint8Array;
    try {
      pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
    } catch (error) {
      throw new StorageError(
        '用户主私钥不可导出，无法派生静态加密密钥',
        ErrorCodes.STORAGE_KEY_MISSING,
        error as Error,
      );
    }
    const ikm = await crypto.subtle.importKey('raw', toArrayBuffer(pkcs8), 'HKDF', false, [
      'deriveKey',
    ]);
    const key = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: toArrayBuffer(HKDF_SALT),
        info: toArrayBuffer(HKDF_INFO),
      },
      ikm,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    return new StorageCipher(key);
  }

  /** 文本是否为静态加密信封 */
  static isEnvelope(text: string): boolean {
    return text.startsWith(AT_REST_PREFIX);
  }

  /** 加密一条文本，返回可直接落盘的信封 */
  async encrypt(plaintext: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    try {
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(iv) },
        this.key,
        new TextEncoder().encode(plaintext),
      );
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ciphertext), iv.length);
      return AT_REST_PREFIX + bytesToBase64(combined);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('静态加密失败', ErrorCodes.STORAGE_WRITE_FAILED, error as Error);
    }
  }

  /** 解出信封明文；格式非法或 GCM 认证失败一律 STORAGE_DECRYPT_FAILED */
  async decrypt(envelope: string): Promise<string> {
    if (!StorageCipher.isEnvelope(envelope)) {
      throw new StorageError('不是静态加密信封', ErrorCodes.STORAGE_DECRYPT_FAILED);
    }
    let combined: Uint8Array;
    try {
      combined = base64ToBytes(envelope.slice(AT_REST_PREFIX.length));
    } catch (error) {
      throw new StorageError('静态加密信封编码损坏', ErrorCodes.STORAGE_DECRYPT_FAILED, error as Error);
    }
    if (combined.length <= IV_BYTES) {
      throw new StorageError('静态加密信封过短', ErrorCodes.STORAGE_DECRYPT_FAILED);
    }
    const iv = combined.subarray(0, IV_BYTES);
    const ciphertext = combined.subarray(IV_BYTES);
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(iv) },
        this.key,
        toArrayBuffer(ciphertext),
      );
      return new TextDecoder().decode(plain);
    } catch (error) {
      throw new StorageError(
        '静态解密失败：密钥错误或密文已损坏',
        ErrorCodes.STORAGE_DECRYPT_FAILED,
        error as Error,
      );
    }
  }
}
