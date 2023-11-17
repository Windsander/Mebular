// 身份管理器 - 管理设备密钥和用户主密钥

import { SignatureManager } from './signature.js';

export interface DeviceKeyPair {
  deviceId: string;
  publicKey: string;
  privateKey?: string;
  certificate?: string;
  createdAt: number;
  name: string;
}

export interface UserMasterKey {
  publicKey: string;
  createdAt: number;
  name: string;
}

export interface DeviceCertificate {
  deviceId: string;
  devicePublicKey: string;
  userMasterPublicKey: string;
  signature: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export class IdentityManager {
  private signatureManager: SignatureManager;
  private deviceKeys: Map<string, DeviceKeyPair> = new Map();
  private userMasterKey: UserMasterKey | null = null;

  constructor(signatureManager?: SignatureManager) {
    this.signatureManager = signatureManager || new SignatureManager();
  }

  async generateDeviceKey(deviceId: string, name: string): Promise<DeviceKeyPair> {
    const keyPair = await this.signatureManager.generateKeyPair();
    
    const publicKeyBytes = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    const privateKeyBytes = await crypto.subtle.exportKey('raw', keyPair.privateKey);
    
    const publicKey = this.bytesToBase58(publicKeyBytes);
    const privateKey = this.bytesToBase58(privateKeyBytes);
    
    const deviceKey: DeviceKeyPair = {
      deviceId,
      publicKey,
      privateKey,
      createdAt: Date.now(),
      name,
    };
    
    this.deviceKeys.set(deviceId, deviceKey);
    
    return deviceKey;
  }

  async signDeviceCertificate(
    deviceKey: DeviceKeyPair,
    userMasterPublicKey: string
  ): Promise<DeviceCertificate> {
    const certificateData = {
      deviceId: deviceKey.deviceId,
      devicePublicKey: deviceKey.publicKey,
      createdAt: deviceKey.createdAt,
      metadata: { name: deviceKey.name },
    };
    
    const dataStr = JSON.stringify(certificateData);
    const signature = await this.signatureManager.sign(dataStr);
    
    const certificate: DeviceCertificate = {
      deviceId: deviceKey.deviceId,
      devicePublicKey: deviceKey.publicKey,
      userMasterPublicKey,
      signature,
      createdAt: Date.now(),
      metadata: certificateData.metadata,
    };
    
    deviceKey.certificate = JSON.stringify(certificate);
    this.deviceKeys.set(deviceKey.deviceId, deviceKey);
    
    return certificate;
  }

  async verifyDeviceCertificate(certificate: DeviceCertificate): Promise<boolean> {
    const dataToSign = {
      deviceId: certificate.deviceId,
      devicePublicKey: certificate.devicePublicKey,
      createdAt: certificate.createdAt,
      metadata: certificate.metadata ?? {},
    };
    const dataStr = JSON.stringify(dataToSign);
    
    return this.signatureManager.verify(dataStr, certificate.signature);
  }

  setUserMasterKey(publicKey: string, name: string): void {
    this.userMasterKey = {
      publicKey,
      createdAt: Date.now(),
      name,
    };
  }

  getUserMasterKey(): UserMasterKey | null {
    return this.userMasterKey;
  }

  getDeviceKey(deviceId: string): DeviceKeyPair | undefined {
    return this.deviceKeys.get(deviceId);
  }

  getAllDeviceKeys(): DeviceKeyPair[] {
    return Array.from(this.deviceKeys.values());
  }

  removeDeviceKey(deviceId: string): boolean {
    return this.deviceKeys.delete(deviceId);
  }

  private bytesToBase58(bytes: ArrayBuffer): string {
    const bytesArr = new Uint8Array(bytes);
    let result = '';
    for (let i = 0; i < bytesArr.byteLength; i++) {
      result += String.fromCharCode(bytesArr[i]!);
    }
    return btoa(result);
  }
}
