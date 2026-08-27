// Mebular 门面类（spec-004 / phase-4-plan 4.0）
//
// 一个入口收拢所有子系统：IdentityManager / JsonFileStorage / EventLog /
// GraphStore / SyncManager / P2PNode。
//
// 生命周期：
//   initialize()  存储打开 → 身份就绪（身份文件优先，缺则需主私钥现场签发）
//                 → 事件日志恢复（重启后时钟连续）→ 图 → 同步 → 网络（可选）
//   shutdown()    逆序收拢：停网络 → 关存储
//
// 身份文件（<storagePath>.identity.json）保存设备私钥（PKCS8 base64）与证书，
// 与 ~/.ssh 同级的本地信任假设；不入事件日志、不参与同步。

import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { GraphStore } from './core/GraphStore.js';
import { EventLog } from './eventlog/EventLog.js';
import { JsonFileStorage } from './storage/JsonFileStorage.js';
import type { StorageAdapter } from './storage/StorageAdapter.js';
import { SyncManager } from './sync/syncmgr/SyncManager.js';
import { IdentityManager, type DeviceIdentity } from './crypto/IdentityManager.js';
import { P2PNode } from './p2p/P2PNetwork.js';
import type { BonjourServiceFactory } from './p2p/DeviceDiscovery.js';
import type { ConnectionProvider } from './p2p/transport/InMemoryTransport.js';
import { Libp2pProvider } from './p2p/transport/Libp2pProvider.js';
import {
  bytesToHex,
  hexToBytes,
  type DeviceCertificate,
} from './p2p/handshake/AuthenticationHandshake.js';
import { IdentityError, MebularError, StorageError, ErrorCodes } from './errors.js';

export interface MebularConfig {
  /** 存储文件路径（JSONL）；身份文件落在同路径加 .identity.json 后缀 */
  storagePath: string;
  /** 本机设备 ID */
  deviceId: string;
  deviceName?: string;
  encryption?: {
    level?: 'none' | 'device' | 'user' | 'fine-grained';
    /** 用户主公钥：验证对端证书与设备证书所需 */
    userMasterKey?: Uint8Array;
    /** 用户主私钥：为本机签发设备证书所需（首次初始化；仅主设备持有） */
    userMasterPrivateKey?: CryptoKey;
  };
  network?: {
    enabled: boolean;
    /** 拨号/监听抽象（InMemoryHub 等）；配置 libp2p 时以 libp2p 装配为准 */
    provider?: ConnectionProvider;
    bonjourFactory?: BonjourServiceFactory;
    listenPort?: number;
    /** libp2p 真实网络栈（可选依赖；缺包时报 NETWORK_LIBP2P_NOT_AVAILABLE） */
    libp2p?: { listen?: string[]; protocol?: string };
  };
  sync?: {
    autoSync: boolean;
    peerWhitelist?: string[];
    syncTimeout?: number;
  };
}

interface IdentityFileRecord {
  deviceId: string;
  deviceName: string;
  publicKeyHex: string;
  privateKeyPkcs8: string;
  certificate: DeviceCertificate;
  createdAt: number;
}

export class Mebular {
  readonly identity: IdentityManager;
  private readonly config: MebularConfig;
  private initialized = false;

  private storageImpl: StorageAdapter | null = null;
  private eventLogImpl: EventLog | null = null;
  private graphImpl: GraphStore | null = null;
  private syncImpl: SyncManager | null = null;
  private nodeImpl: P2PNode | null = null;
  private libp2pProvider: Libp2pProvider | null = null;

  constructor(config: MebularConfig) {
    this.config = config;
    this.identity = new IdentityManager();
    if (config.encryption?.userMasterKey) {
      this.identity.setUserMasterPublicKey(config.encryption.userMasterKey);
    }
    if (config.encryption?.userMasterPrivateKey) {
      this.identity.setUserMasterPrivateKey(config.encryption.userMasterPrivateKey);
    }
  }

  // ---------- 生命周期 ----------

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // 1. 存储
    try {
      this.storageImpl = await JsonFileStorage.open(this.config.storagePath);
    } catch (error) {
      throw new StorageError(
        `存储打开失败：${this.config.storagePath}`,
        ErrorCodes.STORAGE_INIT_FAILED,
        error as Error,
      );
    }

    // 2. 身份
    const deviceIdentity = await this.loadOrCreateIdentity();

    // 3. 事件日志（从存储恢复时钟，重启后计数器不回退）
    this.eventLogImpl = await EventLog.restore(this.storageImpl, this.config.deviceId, {
      signer: { deviceId: this.config.deviceId, privateKey: deviceIdentity.privateKey },
    });

    // 4. 图存储（事件化接线；实体时钟由事件时钟驱动）
    this.graphImpl = new GraphStore({
      storage: this.storageImpl,
      author: this.config.deviceId,
      eventLog: this.eventLogImpl,
    });

    // 5. 同步管理器
    this.syncImpl = new SyncManager({
      eventLog: this.eventLogImpl,
      storage: this.storageImpl,
      deviceId: this.config.deviceId,
      autoSync: this.config.sync?.autoSync ?? true,
      peerWhitelist: this.config.sync?.peerWhitelist,
      syncTimeout: this.config.sync?.syncTimeout,
    });

    // 6. 网络（可选）
    if (this.config.network?.enabled) {
      // libp2p 配置优先：真实网络栈装配（可选依赖，缺包时诚实报错）
      let provider = this.config.network.provider;
      if (this.config.network.libp2p) {
        this.libp2pProvider = await Libp2pProvider.create({
          deviceKey: {
            publicKey: deviceIdentity.publicKey,
            privateKey: deviceIdentity.privateKey,
          },
          listen: this.config.network.libp2p.listen,
          protocol: this.config.network.libp2p.protocol,
        });
        await this.libp2pProvider.start();
        provider = this.libp2pProvider;
      }
      const masterPublicKey = this.identity.getUserMasterPublicKey();
      const node = new P2PNode({
        identity: {
          deviceId: deviceIdentity.deviceId,
          devicePublicKey: deviceIdentity.publicKey,
          devicePrivateKey: deviceIdentity.privateKey,
          certificate: deviceIdentity.certificate!,
        },
        userMasterPublicKey: masterPublicKey ?? undefined,
        provider,
        bonjourFactory: this.config.network.bonjourFactory,
        config: { listenPort: this.config.network.listenPort },
      });
      this.syncImpl.attachToNode(node);
      await node.start();
      this.nodeImpl = node;
    }

    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }
    if (this.nodeImpl?.isRunning()) {
      await this.nodeImpl.stop();
    }
    this.nodeImpl = null;
    if (this.libp2pProvider) {
      await this.libp2pProvider.stop();
      this.libp2pProvider = null;
    }
    this.syncImpl = null;
    this.graphImpl = null;
    this.eventLogImpl = null;
    if (this.storageImpl) {
      await this.storageImpl.close();
      this.storageImpl = null;
    }
    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // ---------- 子系统访问 ----------

  get storage(): StorageAdapter {
    return this.assertReady(this.storageImpl, 'storage');
  }

  get eventLog(): EventLog {
    return this.assertReady(this.eventLogImpl, 'eventLog');
  }

  get graph(): GraphStore {
    return this.assertReady(this.graphImpl, 'graph');
  }

  get sync(): SyncManager {
    return this.assertReady(this.syncImpl, 'sync');
  }

  /** 网络未启用时为 null */
  get node(): P2PNode | null {
    return this.nodeImpl;
  }

  // ---------- 身份文件 ----------

  private identityFilePath(): string {
    return `${this.config.storagePath}.identity.json`;
  }

  private async loadOrCreateIdentity(): Promise<DeviceIdentity> {
    const path = this.identityFilePath();

    let raw: string | null = null;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new IdentityError(`身份文件读取失败：${path}`, ErrorCodes.IDENTITY_NOT_INITIALIZED, error as Error);
      }
    }

    if (raw !== null) {
      let record: IdentityFileRecord;
      try {
        record = JSON.parse(raw) as IdentityFileRecord;
      } catch (error) {
        throw new IdentityError(`身份文件损坏：${path}`, ErrorCodes.IDENTITY_NOT_INITIALIZED, error as Error);
      }
      if (record.deviceId !== this.config.deviceId) {
        throw new IdentityError(
          `身份文件与 deviceId 不匹配：${record.deviceId} != ${this.config.deviceId}`,
        );
      }
      const identity: DeviceIdentity = {
        deviceId: record.deviceId,
        name: record.deviceName,
        publicKey: hexToBytes(record.publicKeyHex),
        privateKey: await IdentityManager.importPrivateKey(record.privateKeyPkcs8),
        createdAt: record.createdAt,
        certificate: record.certificate,
      };
      this.identity.registerDeviceKey(identity);
      return identity;
    }

    // 首次初始化：需要用户主私钥现场签发设备证书
    if (!this.identity.hasMasterPrivateKey()) {
      throw new IdentityError(
        '首次初始化需要用户主私钥为本机设备签发证书（config.encryption.userMasterPrivateKey）',
      );
    }
    const identity = await this.identity.generateDeviceKey(
      this.config.deviceId,
      this.config.deviceName ?? this.config.deviceId,
    );
    identity.certificate = await this.identity.issueDeviceCertificate(this.config.deviceId);

    const record: IdentityFileRecord = {
      deviceId: identity.deviceId,
      deviceName: identity.name,
      publicKeyHex: bytesToHex(identity.publicKey),
      privateKeyPkcs8: await IdentityManager.exportPrivateKey(identity.privateKey),
      certificate: identity.certificate,
      createdAt: identity.createdAt,
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(record, null, 2), 'utf-8');
    return identity;
  }

  private assertReady<T>(value: T | null, name: string): T {
    if (!this.initialized || value === null) {
      throw new MebularError(`Mebular 尚未初始化（访问 ${name}）`, 'MEBULAR_NOT_INITIALIZED');
    }
    return value;
  }
}
