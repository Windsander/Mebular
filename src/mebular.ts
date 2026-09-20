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

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'path';
import { normalizeNamespace, normalizeNamespaceList } from './core/namespace.js';
import type { Event } from './types/event.js';
import { GraphStore } from './core/GraphStore.js';
import { EventLog } from './eventlog/EventLog.js';
import { JsonFileStorage } from './storage/JsonFileStorage.js';
import { SqliteStorage } from './storage/SqliteStorage.js';
import type { StorageAdapter } from './storage/StorageAdapter.js';
import { SyncManager } from './sync/syncmgr/SyncManager.js';
import { ConfigNamespacePolicy, CompositeNamespacePolicy } from './sync/namespacePolicy.js';
import {
  GraphNamespacePolicy,
  POLICY_NAMESPACE,
  NAMESPACE_GRANT_EVENT,
  NAMESPACE_REVOKE_EVENT,
  DEVICE_REVOKE_EVENT,
  POLICY_ISSUER_DECLARE_EVENT,
  NAMESPACE_MEMBERSHIP_EVENT,
  NAMESPACE_HANDOFF_EVENT,
  type NamespaceGrantRecord,
  type NamespaceRevokeRecord,
  type DeviceRevokeRecord,
  type PolicyIssuerDeclareRecord,
  type NamespaceMembershipRecord,
  type NamespaceHandoffRecord,
} from './sync/grantPolicy.js';
import {
  IdentityManager,
  type DeviceIdentity,
  type UserMasterKeyPair,
} from './crypto/IdentityManager.js';
import { P2PNode } from './p2p/P2PNetwork.js';
import { resolveVectorIndex, type EmbeddingModuleImporter } from './memory/transformers.js';
import type { EmbeddingProvider } from './memory/embedding.js';
import type { VectorIndex } from './memory/VectorIndex.js';
import type { BonjourServiceFactory } from './p2p/DeviceDiscovery.js';
import type { ConnectionProvider } from './p2p/transport/InMemoryTransport.js';
import { Libp2pProvider } from './p2p/transport/Libp2pProvider.js';
import {
  bytesToHex,
  hexToBytes,
  base64ToBytes,
  bytesToBase64,
  type DeviceCertificate,
} from './p2p/handshake/AuthenticationHandshake.js';
import { IdentityError, MebularError, StorageError, ErrorCodes } from './errors.js';
import {
  decryptPrivateKeyPkcs8,
  encryptPrivateKeyPkcs8,
  type EncryptedKeyMaterial,
} from './crypto/KeyProtector.js';
import { StorageCipher } from './crypto/StorageCipher.js';

/**
 * 口令提供者接缝（操作系统 keychain / 用户交互等）：
 * 门面未直接配置 passphrase 时，经此按需取口令；返回 null 表示无法提供。
 */
export interface KeychainProvider {
  getPassphrase(deviceId: string): Promise<string | null>;
}

export interface MebularConfig {
  /** 存储文件路径（JSONL / SQLite）；身份文件落在同路径加 .identity.json 后缀 */
  storagePath: string;
  /** 本机设备 ID */
  deviceId: string;
  deviceName?: string;
  /** 存储适配器（G4）：'json'（缺省，JSONL）或 'sqlite'（node:sqlite，Node ≥ 22.5） */
  storageAdapter?: 'json' | 'sqlite';
  encryption?: {
    /**
     * 静态加密作用域（G1）：
     * - `none` / 缺省：明文落盘（向后兼容）；
     * - `user`：以用户主私钥经 HKDF 派生对称密钥，落盘密文（Level 3）。
     * `device` / `fine-grained` 暂未实现，配置即诚实报错。
     */
    level?: 'none' | 'device' | 'user' | 'fine-grained';
    /** 用户主公钥：验证对端证书与设备证书所需 */
    userMasterKey?: Uint8Array;
    /** 用户主私钥：为本机签发设备证书所需（首次初始化；仅主设备持有） */
    userMasterPrivateKey?: CryptoKey;
    /**
     * 显式静态加密密钥（32 字节，keychain / 身份文件分发接缝）。
     * 配置后即启用静态加密，优先于 `level: 'user'` 的派生路径。
     */
    storageKey?: Uint8Array;
    /**
     * 身份文件解锁口令（Phase 5.1）：配置后设备私钥以 PBKDF2+AES-GCM
     * 加密存放；已有的明文身份文件在首次带口令初始化时自动迁移。
     */
    passphrase?: string;
    /** 口令提供者接缝：未直接配置 passphrase 时经此获取（如系统 keychain） */
    keychain?: KeychainProvider;
  };
  network?: {
    enabled: boolean;
    /** 拨号/监听抽象（InMemoryHub 等）；配置 libp2p 时以 libp2p 装配为准 */
    provider?: ConnectionProvider;
    bonjourFactory?: BonjourServiceFactory;
    listenPort?: number;
    /**
     * libp2p 真实网络栈（可选依赖；缺包时报 NETWORK_LIBP2P_NOT_AVAILABLE）。
     * `relayServer`/`relayServers` 启用 circuit relay（G3；需额外可选依赖，
     * 缺包抛 NETWORK_RELAY_NOT_AVAILABLE）。
     */
    libp2p?: {
      listen?: string[];
      protocol?: string;
      relayServer?: boolean;
      relayServers?: string[];
      /** circuit relay 资源放开（仅可信自托管时开启；默认限额） */
      relayUnlimited?: boolean;
    };
  };
  sync?: {
    autoSync: boolean;
    peerWhitelist?: string[];
    syncTimeout?: number;
    /** 已确认集合持久化文件路径（6.4）；缺省派生为 <storagePath 去 .json>.sync-state.json */
    syncStatePath?: string;
    /**
     * 初始同步快照阈值（G4）：对端空时钟且本地缺失事件数 ≥ 阈值时，
     * 以物化快照替代全量事件重放。缺省不启用。
     */
    snapshotThreshold?: number;
    /** 本机订阅的 namespace：空/缺省 = 全部（保持现状语义） */
    namespaces?: string[];
    /**
     * 对端授权策略（配置驱动，**默认拒绝**）：peerDeviceId → 允许接收的
     * namespace 白名单。未列出的对端拿不到任何分区，必须显式写入才能同步；
     * 空数组 = 明确不允许。该接缝为将来「授权来自图上的 grant 记忆」预留
     * 实现位（本期不实现）。
     */
    peerNamespacePolicy?: Record<string, string[]>;
    /** 本地写入后向订阅对端即时推送（默认关闭，保持既有行为；常驻入口默认开启） */
    pushOnWrite?: boolean;
    /** push-on-write 节流窗口（ms，默认 50） */
    pushOnWriteThrottleMs?: number;
    /** 周期 anti-entropy（C）：缺省关闭；常驻入口（serve/MCP）默认开启 */
    antiEntropy?: { enabled?: boolean; intervalMs?: number; jitterRatio?: number };
    /**
     * 引导期策略签发者白名单（R-a，可多台）：列出的设备可为任意 namespace 签发。
     * 未列出者只能在其自身已获授权范围内签发/撤销。缺省空。各端应保持一致。
     */
    policyIssuers?: string[];
  };
  /** 语义召回（G2，可选依赖；缺包降级关键词并告警） */
  semantic?: {
    enabled: boolean;
    /** embedding 模型 ID（缺省 Xenova/all-MiniLM-L6-v2） */
    model?: string;
    /** 模型缓存目录 */
    cacheDir?: string;
    /** 权重精度/后端（如 'q8'） */
    dtype?: string;
    /** 最低余弦相似度（低相关不返回）；缺省 0.2 */
    minScore?: number;
    /** 注入自定义 EmbeddingProvider（测试/替代实现） */
    provider?: EmbeddingProvider;
    /** 动态导入器（测试用；缺省运行时 import） */
    importer?: EmbeddingModuleImporter;
    /** true：缺包时初始化失败而非降级；缺省 false */
    required?: boolean;
  };
}

interface IdentityFileRecord {
  deviceId: string;
  deviceName: string;
  publicKeyHex: string;
  /** 明文 PKCS8（旧格式；配置口令后首次初始化自动迁移为加密封套） */
  privateKeyPkcs8?: string;
  /** 加密封套（Phase 5.1 起的目标格式） */
  privateKeyEncrypted?: EncryptedKeyMaterial;
  certificate: DeviceCertificate;
  /** 叶→根证书链（T2；可选，兼容旧身份文件） */
  certificateChain?: DeviceCertificate[];
  createdAt: number;
}

/** 2b：交接前置校验结果（退订方视角）。 */
export interface NamespaceHandoffPlan {
  ok: boolean;
  namespace: string;
  successor: string;
  /** 继任者是否为该分区的**生效成员** */
  successorIsMember: boolean;
  /** 退订方仍持有、继任者尚未 ack 的事件总数（0 = 已全量覆盖） */
  pendingTotal: number;
  /** 未完全覆盖的作者明细（诊断：缺哪些作者/多少条） */
  pendingByAuthor: Array<{ author: string; count: number }>;
}

/** 2b：退订交接结果。 */
/** 2c：重订阅恢复结果。 */
export interface NamespaceRejoinResult {
  ok: boolean;
  action: 'rejoin';
  namespace: string;
  /** 是否已声明“本机该分区已重置/为空”（触发对端向下修正并从 0 重发） */
  reset: boolean;
  member: boolean;
  authorized: boolean;
  reason?: 'not-authorized' | 'membership-not-active';
}

export interface NamespaceHandoffResult {
  ok: boolean;
  action: 'leave';
  namespace: string;
  successor: string;
  forced: boolean;
  aborted?: boolean;
  reason?: 'successor-not-member' | 'successor-incomplete';
  deleted?: { events: number; nodes: number; edges: number };
  handoffEventId?: string;
  resumed?: boolean;
  missing?: Array<{ author: string; count: number }>;
}

export class Mebular {
  readonly identity: IdentityManager;
  private readonly config: MebularConfig;
  private initialized = false;

  private storageImpl: StorageAdapter | null = null;
  private eventLogImpl: EventLog | null = null;
  private graphImpl: GraphStore | null = null;
  private syncImpl: SyncManager | null = null;
  private graphPolicyImpl: GraphNamespacePolicy | null = null;
  private namespacePolicyImpl: CompositeNamespacePolicy | null = null;
  private nodeImpl: P2PNode | null = null;
  private libp2pProvider: Libp2pProvider | null = null;
  private semanticVectorIndexImpl: VectorIndex | null = null;

  /**
   * 便捷身份自举（G0）：生成用户主密钥对（同一用户所有设备的信任根），
   * 供首次初始化签发设备证书。
   *
   * 安全默认：本方法只生成并返回密钥对，**不落盘**；主私钥的持久化与
   * 保管由调用方负责（例如导出 PKCS8 存入受保护的位置），随后经
   * `config.encryption.userMasterPrivateKey` 传回。
   */
  static async generateUserMasterKey(name?: string): Promise<UserMasterKeyPair> {
    return new IdentityManager().generateUserMasterKey(name);
  }

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

    try {
      // 1. 存储（先解析静态加密密钥：缺失/错误在此如实报错，不包装成 INIT_FAILED）
      const storageCipher = await this.createStorageCipher();
      const storageAdapter = this.config.storageAdapter ?? 'json';
      try {
        this.storageImpl =
          storageAdapter === 'sqlite'
            ? await SqliteStorage.open(this.config.storagePath, { cipher: storageCipher })
            : await JsonFileStorage.open(this.config.storagePath, { cipher: storageCipher });
      } catch (error) {
        // 适配器自身抛出的结构化错误（如 SQLite 不可用）原样上抛，不糊成 INIT_FAILED
        if (error instanceof MebularError) throw error;
        throw new StorageError(
          `存储打开失败：${this.config.storagePath}`,
          ErrorCodes.STORAGE_INIT_FAILED,
          error as Error,
        );
      }

      // 2. 身份
      const deviceIdentity = await this.loadOrCreateIdentity();

      // 3. 事件日志（从存储恢复时钟，重启后计数器不回退；签名者携带证书链字段）
      this.eventLogImpl = await EventLog.restore(this.storageImpl, this.config.deviceId, {
        signer: {
          deviceId: this.config.deviceId,
          privateKey: deviceIdentity.privateKey,
          certificate: deviceIdentity.certificate,
          ...(deviceIdentity.certificateChain !== undefined ? { certificateChain: deviceIdentity.certificateChain } : {}),
        },
      });

      // 4. 图存储（事件化接线；实体时钟由事件时钟驱动）
      this.graphImpl = new GraphStore({
        storage: this.storageImpl,
        author: this.config.deviceId,
        eventLog: this.eventLogImpl,
      });

      // 5. 供给侧授权策略（Phase 2 · D/E）：图上授权（grant-as-memory）+ 配置引导。
      //    - GraphNamespacePolicy 只采纳「链到用户主密钥」的签发者记录；
      //    - 配置白名单作为 bootstrap 路径；两者并集，任一为空都不会放松默认拒绝；
      //    - 设备被吊销时读侧一律 []（配置白名单也绕不过）。
      this.graphPolicyImpl = new GraphNamespacePolicy({
        eventLog: this.eventLogImpl,
        userMasterPublicKey: this.identity.getUserMasterPublicKey(),
        policyIssuers: this.config.sync?.policyIssuers,
      });
      this.namespacePolicyImpl = new CompositeNamespacePolicy([
        this.graphPolicyImpl,
        new ConfigNamespacePolicy(this.config.sync?.peerNamespacePolicy ?? {}),
      ]);

      // 5.5 同步管理器（携带用户主公钥：信任链验签，收口 D9；
      //    已确认集合持久化到存储旁路文件，重启后首帧不再冗余，6.4）
      this.syncImpl = new SyncManager({
        eventLog: this.eventLogImpl,
        storage: this.storageImpl,
        deviceId: this.config.deviceId,
        autoSync: this.config.sync?.autoSync ?? true,
        peerWhitelist: this.config.sync?.peerWhitelist,
        syncTimeout: this.config.sync?.syncTimeout,
        snapshotThreshold: this.config.sync?.snapshotThreshold,
        subscriptionNamespaces: this.config.sync?.namespaces,
        // 默认拒绝：图上与配置任一为空都不会放松；两者都空 = 拒绝所有对端
        namespacePolicy: this.namespacePolicyImpl,
        // M1–M3：成员资格（来自图上成员记录；未启用分区沿用对端订阅声明）
        membershipPolicy: this.graphPolicyImpl,
        pushOnWrite: this.config.sync?.pushOnWrite,
        pushOnWriteThrottleMs: this.config.sync?.pushOnWriteThrottleMs,
        antiEntropy: this.config.sync?.antiEntropy,
        userMasterPublicKey: this.identity.getUserMasterPublicKey() ?? undefined,
        syncStatePath:
          this.config.sync?.syncStatePath ??
          `${this.config.storagePath.replace(/\.json$/i, '')}.sync-state.json`,
      });

      // 5.6 2c：依据图外「已重置」标记恢复 reset 声明（重入方 hello 以空时钟上报，
      //     触发对端向下修正并从 0 重发）。标记不同步、不入图。
      for (const ns of this.config.sync?.namespaces ?? []) {
        if (await this.hasRejoinReset(ns)) this.syncImpl.noteLocalReset(ns);
      }

      // 5.5 语义向量索引（可选依赖；缺包降级关键词并告警）
      if (this.config.semantic?.enabled) {
        this.semanticVectorIndexImpl = await resolveVectorIndex({
          model: this.config.semantic.model,
          cacheDir: this.config.semantic.cacheDir,
          dtype: this.config.semantic.dtype,
          minScore: this.config.semantic.minScore,
          provider: this.config.semantic.provider,
          importer: this.config.semantic.importer,
          required: this.config.semantic.required,
        });
      }

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
            relayServer: this.config.network.libp2p.relayServer,
            relayServers: this.config.network.libp2p.relayServers,
            relayUnlimited: this.config.network.libp2p.relayUnlimited,
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
            ...(deviceIdentity.certificateChain !== undefined ? { certificateChain: deviceIdentity.certificateChain } : {}),
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
    } catch (error) {
      // 部分初始化回滚：已打开的资源全部收拢，允许修正配置后重试
      await this.rollbackPartialInit();
      throw error;
    }
  }

  /** 初始化失败的清理：与 shutdown 同等收拢，但吞掉清理错误以保留原始错误 */
  private async rollbackPartialInit(): Promise<void> {
    if (this.nodeImpl?.isRunning()) {
      await this.nodeImpl.stop().catch(() => undefined);
    }
    this.nodeImpl = null;
    if (this.libp2pProvider) {
      await this.libp2pProvider.stop().catch(() => undefined);
      this.libp2pProvider = null;
    }
    this.syncImpl = null;
    this.namespacePolicyImpl = null;
    this.graphPolicyImpl = null;
    this.graphImpl = null;
    this.eventLogImpl = null;
    this.semanticVectorIndexImpl = null;
    if (this.storageImpl) {
      await this.storageImpl.close().catch(() => undefined);
      this.storageImpl = null;
    }
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
    this.namespacePolicyImpl = null;
    this.graphPolicyImpl = null;
    this.graphImpl = null;
    this.eventLogImpl = null;
    this.semanticVectorIndexImpl = null;
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

  /**
   * 清空 per-(对端, 分区) 同步水位（省略对端 = 全部）——对端水位被污染时的
   * **被认可修复路径**：只清水位、不动 per-event ack 集合，方向安全（最多让
   * 已确认事件冗余重发一次，不会漏发）。
   */
  async resetPeerWatermarks(peerDeviceId?: string): Promise<void> {
    await this.sync.resetPeerWatermarks(peerDeviceId);
  }

  // ---------- 授权作为记忆（Phase 2 · D）与身份吊销（E） ----------

  /**
   * 授予某设备若干分区（写入**本机签名**的策略记录，落保留命名空间 `__policy__`）。
   * 只有链到用户主密钥的设备签发的记录才会被其他设备采纳；本机需配置主密钥
   * （即拥有设备证书）才有签发资格。
   */
  async grantNamespaces(input: {
    subject: string;
    namespaces: string[];
    expiresAt?: number;
    note?: string;
  }): Promise<Event> {
    const grant: NamespaceGrantRecord = {
      grantId: randomUUID(),
      subject: input.subject,
      namespaces: normalizeNamespaceList(input.namespaces),
      issuedAt: Date.now(),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    return this.eventLog.append({
      type: NAMESPACE_GRANT_EVENT,
      data: { grant },
      namespace: POLICY_NAMESPACE,
    });
  }

  /** 按 grantId 撤销一条授权（签发者签名；立即反映到裁剪链）。 */
  async revokeGrant(input: { grantId: string; subject?: string; note?: string }): Promise<Event> {
    const revoke: NamespaceRevokeRecord = {
      grantId: input.grantId,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      issuedAt: Date.now(),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    return this.eventLog.append({
      type: NAMESPACE_REVOKE_EVENT,
      data: { revoke },
      namespace: POLICY_NAMESPACE,
    });
  }

  /**
   * 吊销某设备身份：读侧立即 `[]`，且其署名的事件在入站写入处被隔离。
   * 非终态——之后对该设备再写一条 grant 即恢复。
   */
  async revokeDevice(input: { subject: string; note?: string }): Promise<Event> {
    const deviceRevoke: DeviceRevokeRecord = {
      subject: input.subject,
      issuedAt: Date.now(),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    return this.eventLog.append({
      type: DEVICE_REVOKE_EVENT,
      data: { deviceRevoke },
      namespace: POLICY_NAMESPACE,
    });
  }

  /**
   * C1：把某设备声明为**引导签发者**（写入本机签名记录 `policy_issuer_declare`，落 `__policy__`）。
   *
   * 采纳**不做 R-a**（无条件），但受 R-b 约束（签发者/主体被吊销则不采纳）；生效集合
   * = 图上被采纳声明 ∪ 本地配置 `sync.policyIssuers`。用于去中心化 bootstrap：新设备同步到
   * 声明后即可采纳该签发者的授权，**无需本地配置一致**。
   */
  async declarePolicyIssuer(input: { subject: string; note?: string }): Promise<Event> {
    const policyIssuer: PolicyIssuerDeclareRecord = {
      subject: input.subject,
      issuedAt: Date.now(),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    return this.eventLog.append({
      type: POLICY_ISSUER_DECLARE_EVENT,
      data: { policyIssuer },
      namespace: POLICY_NAMESPACE,
    });
  }

  /**
   * 只读审计入口：当前**生效引导签发者集合**（图上被采纳声明 ∪ 配置 `sync.policyIssuers`，
   * 吊销优先）。不改变任何状态。
   */
  async getPolicyIssuers(): Promise<string[]> {
    return this.assertReady(this.graphPolicyImpl, 'namespacePolicy').getPolicyIssuers();
  }

  /**
   * M1：声明/注销某设备在某分区的**成员资格**（写本机签名 `namespace_membership` 到 `__policy__`）。
   * 采纳无条件（不做 R-a），受 R-b 约束。`active=false` 即**注销**（本轮只改成员集合，不做数据清理）。
   */
  async declareNamespaceMembership(input: {
    member: string;
    namespace: string;
    active?: boolean;
    note?: string;
  }): Promise<Event> {
    const membership: NamespaceMembershipRecord = {
      member: input.member,
      namespace: normalizeNamespace(input.namespace),
      active: input.active ?? true,
      issuedAt: Date.now(),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    return this.eventLog.append({
      type: NAMESPACE_MEMBERSHIP_EVENT,
      data: { membership },
      namespace: POLICY_NAMESPACE,
    });
  }

  /**
   * M1：某分区的**成员资格**（`active=false` = 该分区尚无被采纳成员记录，未启用成员资格）。
   * `members` 为图上在册成员（未 ∩ 授权）；生效成员请用 `getNamespaceMembers`。
   */
  async getNamespaceMembership(namespace: string): Promise<{ active: boolean; members: string[] }> {
    return this.assertReady(this.graphPolicyImpl, 'namespacePolicy').getNamespaceMembership(
      normalizeNamespace(namespace),
    );
  }

  /**
   * M2：某分区的**生效成员集合** = 图上在册成员 ∩ 各成员对该分区的**生效授权**（默认拒绝不变）。
   * 供 2b 的退订/继任者门禁使用。
   */
  async getNamespaceMembers(namespace: string): Promise<string[]> {
    const ns = normalizeNamespace(namespace);
    const adopted = await this.getNamespaceMembership(ns);
    if (!adopted.active) return [];
    const effective: string[] = [];
    for (const member of adopted.members) {
      if ((await this.getEffectiveNamespaces(member)).includes(ns)) effective.push(member);
    }
    return effective.sort();
  }

  // ---------- 2b：退订交接（继任者全量 ack 门禁 + 本地彻底清理） ----------

  private handoffIntentPath(): string {
    return `${this.config.storagePath}.handoff.json`;
  }

  /** 2c：本地「已清理/待重入」标记路径（图外、**不同步**、无 tombstone）。 */
  private rejoinMarkerPath(namespace?: string): string {
    return namespace === undefined
      ? `${this.config.storagePath}.rejoin.json`
      : `${this.config.storagePath}.rejoin.${namespace}.json`;
  }

  /** 2c：本机对某分区是否已声明重置（读图外标记，仅供本机诊断/决策）。 */
  async hasRejoinReset(namespace: string): Promise<boolean> {
    try {
      const parsed = JSON.parse(await readFile(this.rejoinMarkerPath(normalizeNamespace(namespace)), 'utf-8')) as {
        reset?: boolean;
      };
      return parsed.reset === true;
    } catch {
      return false;
    }
  }

  /**
   * 2c：重订阅恢复——退订清理后**重新加入**该分区。
   *
   * 准入（R1）：①该分区对**本设备**有**生效授权**（`getEffectiveNamespaces(self)` 含该分区，
   * 即存在签发给本机的 grant；默认拒绝不变）②本机重新声明成员在册。任一不满足 → **显式失败**。
   *
   * 重置（R2）：写**图外**「已清理」标记（R3，不同步），清空本机该分区本地水位；本机之后的
   * hello 会以**空时钟**上报该（显式订阅的）分区 → 对端按「自报水位只允许向下修正」**从 0 重发**
   * （或按既有“空水位”门禁发初始快照，**门禁不放宽**）。**不产生 tombstone、不改 `__policy__`。**
   */
  async rejoinNamespace(input: { namespace: string }): Promise<NamespaceRejoinResult> {
    const ns = normalizeNamespace(input.namespace);
    if (ns === POLICY_NAMESPACE) throw new MebularError('不允许对保留策略分区 __policy__ 执行重入', ErrorCodes.VALIDATION_INVALID_ARGUMENT);
    const authorized = (await this.getEffectiveNamespaces(this.config.deviceId)).includes(ns);
    if (!authorized) {
      return { ok: false, action: 'rejoin', namespace: ns, reset: false, member: false, authorized: false, reason: 'not-authorized' };
    }
    await this.declareNamespaceMembership({ member: this.config.deviceId, namespace: ns, active: true });
    const member = (await this.getNamespaceMembership(ns)).members.includes(this.config.deviceId);
    if (!member) {
      return { ok: false, action: 'rejoin', namespace: ns, reset: false, member: false, authorized: true, reason: 'membership-not-active' };
    }
    // R3：图外重置标记（不同步）
    const path = this.rejoinMarkerPath(ns);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ namespace: ns, reset: true, at: Date.now() }), { mode: 0o600 });
    // R2：清本机该分区本地水位（含快照水位）→ 登记 reset，使 hello 上报空时钟
    await this.sync.forgetNamespace(ns, []);
    this.sync.noteLocalReset(ns);
    return { ok: true, action: 'rejoin', namespace: ns, reset: true, member: true, authorized: true };
  }

  private async readHandoffIntent(): Promise<{
    namespace: string;
    successor: string;
    forced: boolean;
    handoffEventId: string;
    startedAt: number;
  } | null> {
    try {
      const parsed = JSON.parse(await readFile(this.handoffIntentPath(), 'utf-8')) as Record<string, unknown>;
      if (typeof parsed.namespace === 'string' && typeof parsed.handoffEventId === 'string') {
        return {
          namespace: parsed.namespace,
          successor: String(parsed.successor ?? ''),
          forced: parsed.forced === true,
          handoffEventId: parsed.handoffEventId,
          startedAt: Number(parsed.startedAt ?? 0),
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async writeHandoffIntent(intent: {
    namespace: string;
    successor: string;
    forced: boolean;
    handoffEventId: string;
    startedAt: number;
  }): Promise<void> {
    const path = this.handoffIntentPath();
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(intent), { mode: 0o600 });
    try {
      await chmod(tmp, 0o600);
    } catch {
      // Windows 无 POSIX mode
    }
    await rename(tmp, path);
  }

  private async clearHandoffIntent(): Promise<void> {
    await rm(this.handoffIntentPath(), { force: true });
  }

  /** 2b：物理删除某分区的全部事件/节点/边（**绝不触碰 `__policy__`**）；幂等可续跑。 */
  private async purgeNamespace(ns: string): Promise<{ events: number; nodes: number; edges: number; eventIds: string[] }> {
    if (ns === POLICY_NAMESPACE) throw new MebularError('拒绝清理保留策略分区 __policy__', ErrorCodes.VALIDATION_INVALID_ARGUMENT);
    const events = await this.storage.listEvents({ namespace: ns });
    const nodes = await this.storage.listNodes({ namespace: ns });
    const edges = await this.storage.listEdges({ namespace: ns });
    for (const event of events) await this.storage.deleteEvent(event.id);
    for (const node of nodes) await this.storage.deleteNode(node.id);
    for (const edge of edges) await this.storage.deleteEdge(edge.id);
    return { events: events.length, nodes: nodes.length, edges: edges.length, eventIds: events.map((e) => e.id) };
  }

  /**
   * 2b：交接**前置校验**（只读）——继任者是否为该分区生效成员，且是否已 ack 退订方在该分区的
   * 全部事件（含退订方自己作为作者的事件）。复用既有 per-event ack（`getPendingEvents`），
   * **不新增同步协议**、**不放宽快照门禁**。
   */
  async planNamespaceHandoff(input: { namespace: string; successor: string }): Promise<NamespaceHandoffPlan> {
    const ns = normalizeNamespace(input.namespace);
    if (ns === POLICY_NAMESPACE) throw new MebularError('不允许对保留策略分区 __policy__ 执行交接', ErrorCodes.VALIDATION_INVALID_ARGUMENT);
    if (typeof input.successor !== 'string' || input.successor.length === 0) {
      throw new MebularError('交接需要显式继任者（--successor <deviceId>）', ErrorCodes.VALIDATION_INVALID_ARGUMENT);
    }
    const members = await this.getNamespaceMembers(ns);
    const successorIsMember = members.includes(input.successor);
    // 覆盖要求：继任者已 ack 退订方在该分区持有的、**由他人署名**的事件。
    // 继任者**自己署名**的事件它本就拥有（无需 ack），排除以免误判“未覆盖”。
    const pending = (await this.sync.getPendingEvents(input.successor)).filter(
      (event) => normalizeNamespace(event.namespace) === ns && event.author !== input.successor,
    );
    const counts = new Map<string, number>();
    for (const event of pending) counts.set(event.author, (counts.get(event.author) ?? 0) + 1);
    const pendingByAuthor = [...counts.entries()]
      .map(([author, count]) => ({ author, count }))
      .sort((a, b) => (a.author < b.author ? -1 : a.author > b.author ? 1 : 0));
    return { ok: successorIsMember && pending.length === 0, namespace: ns, successor: input.successor, successorIsMember, pendingTotal: pending.length, pendingByAuthor };
  }

  /**
   * 2b：退订交接——**验前不删**：先校验继任者全量 ack（`force` 跳过门禁但**如实记录**），
   * 再写交接记录（`__policy__`，含 `forced` 与缺失明细），再**物理清理**本分区数据与本地水位。
   *
   * **绝不产生 tombstone**（无删除事件）；**保留 `__policy__`**；崩溃中途可重跑续完。
   * 重入/重订阅恢复**未支持**（属 2c）。
   */
  async leaveNamespace(input: {
    namespace: string;
    successor: string;
    force?: boolean;
    note?: string;
  }): Promise<NamespaceHandoffResult> {
    const ns = normalizeNamespace(input.namespace);
    if (ns === POLICY_NAMESPACE) throw new MebularError('不允许对保留策略分区 __policy__ 执行交接', ErrorCodes.VALIDATION_INVALID_ARGUMENT);
    if (typeof input.successor !== 'string' || input.successor.length === 0) {
      throw new MebularError('交接需要显式继任者（--successor <deviceId>）', ErrorCodes.VALIDATION_INVALID_ARGUMENT);
    }

    // 续跑：存在同一分区的未完成意图 → 直接继续删除（幂等）
    const intent = await this.readHandoffIntent();
    if (intent && intent.namespace === ns) {
      const purged = await this.purgeNamespace(ns);
      await this.sync.forgetNamespace(ns, purged.eventIds);
      await this.clearHandoffIntent();
      return {
        ok: true,
        action: 'leave',
        namespace: ns,
        successor: intent.successor,
        forced: intent.forced,
        deleted: { events: purged.events, nodes: purged.nodes, edges: purged.edges },
        handoffEventId: intent.handoffEventId,
        resumed: true,
      };
    }

    const force = input.force === true;
    // 始终如实计算覆盖明细（force 也记录真相）
    const plan = await this.planNamespaceHandoff({ namespace: ns, successor: input.successor });
    if (!force) {
      if (!plan.successorIsMember) {
        return { ok: false, action: 'leave', namespace: ns, successor: input.successor, forced: false, aborted: true, reason: 'successor-not-member', missing: plan.pendingByAuthor };
      }
      if (plan.pendingTotal > 0) {
        return { ok: false, action: 'leave', namespace: ns, successor: input.successor, forced: false, aborted: true, reason: 'successor-incomplete', missing: plan.pendingByAuthor };
      }
    }

    // 退订 = 成员资格退出（本机在该分区注销）
    await this.declareNamespaceMembership({ member: this.config.deviceId, namespace: ns, active: false });
    // 交接记录（审计；不参与策略推导）
    const handoff: NamespaceHandoffRecord = {
      handoffId: randomUUID(),
      namespace: ns,
      successor: input.successor,
      forced: force,
      pendingCount: plan.pendingTotal,
      ...(plan.pendingByAuthor.length > 0 ? { missingAuthors: plan.pendingByAuthor.map((m) => m.author) } : {}),
      issuedAt: Date.now(),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    const event = await this.eventLog.append({
      type: NAMESPACE_HANDOFF_EVENT,
      data: { handoff },
      namespace: POLICY_NAMESPACE,
    });
    // 意图记录（图外，崩溃安全）：写下后才开始删除；重跑据此续完
    await this.writeHandoffIntent({ namespace: ns, successor: input.successor, forced: force, handoffEventId: event.id, startedAt: Date.now() });
    const purged = await this.purgeNamespace(ns);
    await this.sync.forgetNamespace(ns, purged.eventIds);
    await this.clearHandoffIntent();
    return {
      ok: true,
      action: 'leave',
      namespace: ns,
      successor: input.successor,
      forced: force,
      deleted: { events: purged.events, nodes: purged.nodes, edges: purged.edges },
      handoffEventId: event.id,
    };
  }

  /**
   * 只读审计入口：某对端当前**生效**的授权分区（图上 grant ∪ 配置白名单，吊销
   * 优先）。便于排障与审计，不改变任何状态。
   */
  async getEffectiveNamespaces(peerDeviceId: string): Promise<string[]> {
    return this.assertReady(this.namespacePolicyImpl, 'namespacePolicy').getAuthorizedNamespaces(
      peerDeviceId,
    );
  }

  /** 只读审计入口：当前被吊销的设备集合。 */
  async getRevokedDevices(): Promise<string[]> {
    return [
      ...(await this.assertReady(this.namespacePolicyImpl, 'namespacePolicy').getRevokedDevices()),
    ];
  }

  /** 网络未启用时为 null */
  get node(): P2PNode | null {
    return this.nodeImpl;
  }

  /** 语义向量索引（G2）；未启用或缺 embedding 包降级时为 null */
  get semanticVectorIndex(): VectorIndex | null {
    return this.semanticVectorIndexImpl;
  }

  /** 本机设备 ID（G6.1 MemoryService.status 用） */
  get deviceId(): string {
    return this.config.deviceId;
  }

  /** 是否启用静态加密（G6.1） */
  get atRestEncryption(): boolean {
    return Boolean(this.config.encryption?.storageKey) || this.config.encryption?.level === 'user';
  }

  /** 配置的 relay 地址列表（G6.1） */
  get relayServers(): string[] {
    return this.config.network?.libp2p?.relayServers ?? [];
  }

  // ---------- 静态加密（G1） ----------

  /**
   * 解析静态加密器：
   * - 显式 `storageKey` 优先（keychain / 身份文件分发接缝）；
   * - `level: 'user'` 由用户主私钥经 HKDF 派生；
   * - `none` / 缺省为明文（向后兼容）；
   * - `device` / `fine-grained` 暂未实现，诚实报错。
   */
  private async createStorageCipher(): Promise<StorageCipher | null> {
    const encryption = this.config.encryption;
    if (encryption?.storageKey) {
      return StorageCipher.fromRawKey(encryption.storageKey);
    }
    const level = encryption?.level ?? 'none';
    if (level === 'none') {
      return null;
    }
    if (level !== 'user') {
      throw new StorageError(
        `暂不支持的静态加密作用域：${level}（当前支持 none / user）`,
        ErrorCodes.STORAGE_INIT_FAILED,
      );
    }
    if (!encryption?.userMasterPrivateKey) {
      throw new StorageError(
        '已启用 user 作用域静态加密，但缺少派生密钥的用户主私钥（config.encryption.userMasterPrivateKey 或 storageKey）',
        ErrorCodes.STORAGE_KEY_MISSING,
      );
    }
    return StorageCipher.fromUserMasterPrivateKey(encryption.userMasterPrivateKey);
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

      // 私钥材料：加密封套优先；明文 + 已配置口令时自动迁移为加密存放
      let privateKeyPkcs8: string;
      if (record.privateKeyEncrypted) {
        const passphrase = await this.resolvePassphrase();
        if (!passphrase) {
          throw new IdentityError(
            '身份文件已加密，但未提供解锁口令（config.encryption.passphrase 或 keychain）',
            ErrorCodes.IDENTITY_LOCKED,
          );
        }
        try {
          const pkcs8 = await decryptPrivateKeyPkcs8(record.privateKeyEncrypted, passphrase);
          privateKeyPkcs8 = bytesToBase64(pkcs8);
        } catch (error) {
          throw new IdentityError(
            '身份文件解锁失败：口令错误或文件已损坏',
            ErrorCodes.IDENTITY_UNLOCK_FAILED,
            error as Error,
          );
        }
      } else if (record.privateKeyPkcs8) {
        privateKeyPkcs8 = record.privateKeyPkcs8;
      } else {
        throw new IdentityError(`身份文件缺少私钥材料：${path}`);
      }

      const identity: DeviceIdentity = {
        deviceId: record.deviceId,
        name: record.deviceName,
        publicKey: hexToBytes(record.publicKeyHex),
        privateKey: await IdentityManager.importPrivateKey(privateKeyPkcs8),
        createdAt: record.createdAt,
        certificate: record.certificate,
        ...(record.certificateChain !== undefined ? { certificateChain: record.certificateChain } : {}),
      };
      this.identity.registerDeviceKey(identity);

      // 明文→加密迁移：配置口令后重写身份文件，去掉明文字段
      if (!record.privateKeyEncrypted && record.privateKeyPkcs8) {
        const passphrase = await this.resolvePassphrase();
        if (passphrase) {
          await this.persistIdentity(identity, passphrase);
        }
      }
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
    await this.persistIdentity(identity, await this.resolvePassphrase());
    return identity;
  }

  /** 口令解析：直接配置优先，其次 keychain 接缝 */
  private async resolvePassphrase(): Promise<string | null> {
    if (this.config.encryption?.passphrase) {
      return this.config.encryption.passphrase;
    }
    return this.config.encryption?.keychain?.getPassphrase(this.config.deviceId) ?? null;
  }

  /** 身份文件落盘：有口令存加密封套，无口令存明文 PKCS8（本地信任假设不变） */
  private async persistIdentity(identity: DeviceIdentity, passphrase: string | null): Promise<void> {
    const path = this.identityFilePath();
    const record: IdentityFileRecord = {
      deviceId: identity.deviceId,
      deviceName: identity.name,
      publicKeyHex: bytesToHex(identity.publicKey),
      certificate: identity.certificate!,
      ...(identity.certificateChain !== undefined ? { certificateChain: identity.certificateChain } : {}),
      createdAt: identity.createdAt,
    };
    const pkcs8 = base64ToBytes(await IdentityManager.exportPrivateKey(identity.privateKey));
    if (passphrase) {
      record.privateKeyEncrypted = await encryptPrivateKeyPkcs8(pkcs8, passphrase);
    } else {
      record.privateKeyPkcs8 = await IdentityManager.exportPrivateKey(identity.privateKey);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(record, null, 2), 'utf-8');
    // 私钥材料入文件：权限收紧到仅属主可读写（对齐 ~/.ssh 信任假设）
    await chmod(path, 0o600);
  }

  private assertReady<T>(value: T | null, name: string): T {
    if (!this.initialized || value === null) {
      throw new MebularError(`Mebular 尚未初始化（访问 ${name}）`, ErrorCodes.MEBULAR_NOT_INITIALIZED);
    }
    return value;
  }
}
