// 通用类型：签名、加密等

export interface Signature {
  algorithm: string;
  data: string; // base64 or hex encoded signature
}

export interface EncryptedData {
  ciphertext: string;
  iv: Uint8Array;
  algorithm: string;
  keyId?: string;
}

export interface ContentId {
  value: string;
  algorithm: string;
}
