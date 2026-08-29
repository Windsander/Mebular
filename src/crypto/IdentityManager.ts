// 身份管理器 - 用户主密钥 + 设备密钥 + 证书签发
//
// Phase 4 重写（phase-4-plan 4.0，收口已知差距）：
// 证书签发与验证统一走握手层（AuthenticationHandshake）的证书格式与
// 规范化数据（canonicalCertificateData）——设备公钥 hex 编码、
// 签名 base64 编码、由用户主私钥签发。旧版自签/base64 混用路径
// 已随 D11 死代码清偿移除（Phase 6.0，见 project-status 决策记录）。

import {
  canonicalCertificateData,
  bytesToHex,
  hexToBytes,
  bytesToBase64,
  base64ToBytes,
  type DeviceCertificate,
} from '../p2p/handshake/AuthenticationHandshake.js';
import { CryptoError, IdentityError } from '../errors.js';

export type { DeviceCertificate };

/** 设备身份：密钥对 + （可选）证书；私钥以 CryptoKey 持有 */
export interface DeviceIdentity {
  deviceId: string;
  name: string;
  publicKey: Uint8Array; // 原始 32 字节
  privateKey: CryptoKey; // Ed25519（sign）
  createdAt: number;
  certificate?: DeviceCertificate;
}

export interface UserMasterKeyPair {
  publicKey: Uint8Array;
  privateKey: CryptoKey;
}

export class IdentityManager {
  private deviceKeys: Map<string, DeviceIdentity> = new Map();
  private masterPublicKey: Uint8Array | null = null;
  private masterPrivateKey: CryptoKey | null = null;
  private masterName: string | null = null;

  // ---------- 用户主密钥 ----------

  /** 生成新的用户主密钥对（同一用户所有设备的信任根） */
  async generateUserMasterKey(name = 'user-master'): Promise<UserMasterKeyPair> {
    try {
      const keyPair = (await crypto.subtle.generateKey(
        { name: 'Ed25519' },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair;
      const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
      this.masterPublicKey = publicKey;
      this.masterPrivateKey = keyPair.privateKey;
      this.masterName = name;
      return { publicKey, privateKey: keyPair.privateKey };
    } catch (error) {
      throw new CryptoError('用户主密钥生成失败', error as Error);
    }
  }

  /** 设置已知的用户主公钥（验证设备证书所需） */
  setUserMasterPublicKey(publicKey: Uint8Array, name = 'user-master'): void {
    this.masterPublicKey = publicKey;
    this.masterName = name;
  }

  /** 设置用户主私钥（签发设备证书所需；仅主设备持有） */
  setUserMasterPrivateKey(privateKey: CryptoKey): void {
    this.masterPrivateKey = privateKey;
  }

  getUserMasterPublicKey(): Uint8Array | null {
    return this.masterPublicKey ? new Uint8Array(this.masterPublicKey) : null;
  }

  getUserMasterKeyName(): string | null {
    return this.masterName;
  }

  hasMasterPrivateKey(): boolean {
    return this.masterPrivateKey !== null;
  }

  // ---------- 设备密钥 ----------

  async generateDeviceKey(deviceId: string, name: string): Promise<DeviceIdentity> {
    try {
      const keyPair = (await crypto.subtle.generateKey(
        { name: 'Ed25519' },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair;
      const identity: DeviceIdentity = {
        deviceId,
        name,
        publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)),
        privateKey: keyPair.privateKey,
        createdAt: Date.now(),
      };
      this.deviceKeys.set(deviceId, identity);
      return identity;
    } catch (error) {
      throw new CryptoError('设备密钥生成失败', error as Error);
    }
  }

  /** 登记外部生成/恢复的设备身份（如门面从身份文件加载） */
  registerDeviceKey(identity: DeviceIdentity): void {
    this.deviceKeys.set(identity.deviceId, identity);
  }

  getDeviceKey(deviceId: string): DeviceIdentity | undefined {
    return this.deviceKeys.get(deviceId);
  }

  getAllDeviceKeys(): DeviceIdentity[] {
    return Array.from(this.deviceKeys.values());
  }

  removeDeviceKey(deviceId: string): boolean {
    return this.deviceKeys.delete(deviceId);
  }

  // ---------- 证书（与握手层同一条路径） ----------

  /** 用用户主私钥为设备签发证书（握手层 DeviceCertificate 格式） */
  async issueDeviceCertificate(deviceId: string): Promise<DeviceCertificate> {
    const device = this.deviceKeys.get(deviceId);
    if (!device) {
      throw new IdentityError(`设备密钥不存在：${deviceId}`);
    }
    if (!this.masterPrivateKey) {
      throw new IdentityError('缺少用户主私钥，无法签发设备证书');
    }

    const certificate: DeviceCertificate = {
      deviceId: device.deviceId,
      devicePublicKey: bytesToHex(device.publicKey),
      createdAt: Date.now(),
      metadata: { name: device.name },
      signature: '',
    };
    try {
      const signature = await crypto.subtle.sign(
        { name: 'Ed25519' },
        this.masterPrivateKey,
        new TextEncoder().encode(canonicalCertificateData(certificate)),
      );
      certificate.signature = bytesToBase64(new Uint8Array(signature));
    } catch (error) {
      throw new CryptoError('设备证书签发失败', error as Error);
    }

    device.certificate = certificate;
    this.deviceKeys.set(deviceId, device);
    return certificate;
  }

  /** 用用户主公钥验证设备证书 */
  async verifyDeviceCertificate(certificate: DeviceCertificate): Promise<boolean> {
    if (!this.masterPublicKey) {
      throw new IdentityError('缺少用户主公钥，无法验证设备证书');
    }
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        this.masterPublicKey.buffer as ArrayBuffer,
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
      return await crypto.subtle.verify(
        { name: 'Ed25519' },
        key,
        base64ToBytes(certificate.signature).buffer as ArrayBuffer,
        new TextEncoder().encode(canonicalCertificateData(certificate)),
      );
    } catch {
      return false;
    }
  }

  // ---------- 密钥序列化（门面身份文件持久化用） ----------

  /** 导出 Ed25519 私钥（PKCS8 → base64） */
  static async exportPrivateKey(key: CryptoKey): Promise<string> {
    try {
      const pkcs8 = await crypto.subtle.exportKey('pkcs8', key);
      return bytesToBase64(new Uint8Array(pkcs8));
    } catch (error) {
      throw new CryptoError('私钥导出失败', error as Error);
    }
  }

  /** 导入 Ed25519 私钥（base64 的 PKCS8） */
  static async importPrivateKey(encoded: string): Promise<CryptoKey> {
    try {
      return await crypto.subtle.importKey(
        'pkcs8',
        base64ToBytes(encoded).buffer as ArrayBuffer,
        { name: 'Ed25519' },
        true,
        ['sign'],
      );
    } catch (error) {
      throw new CryptoError('私钥导入失败', error as Error);
    }
  }

  /** 导出 Ed25519 公钥（raw → hex） */
  static async exportPublicKeyHex(key: CryptoKey): Promise<string> {
    try {
      const raw = await crypto.subtle.exportKey('raw', key);
      return bytesToHex(new Uint8Array(raw));
    } catch (error) {
      throw new CryptoError('公钥导出失败', error as Error);
    }
  }

  /** 导入 Ed25519 公钥（hex 编码的 raw 32 字节） */
  static async importPublicKeyHex(hex: string): Promise<Uint8Array> {
    return hexToBytes(hex);
  }
}
