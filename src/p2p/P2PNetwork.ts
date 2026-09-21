// P2P 网络抽象层与节点编排
//
// P2PNode 把五个组件串成完整链路：
//   设备发现(DeviceDiscovery) → 连接管理(ConnectionManager)
//   → 认证握手(AuthenticationHandshake) → 加密信道(SecureChannelImpl)
//   NAT 穿透(NATTraversal) 作为连接建立的策略辅助。
//
// 具体网络栈通过 ConnectionProvider 注入（当前提供 InMemoryHub；
// libp2p 适配器在此接缝上接入，见 src/p2p/transport/Libp2pProvider.ts）。

import { createHash } from 'crypto';
import { DeviceDiscovery, type BonjourServiceFactory } from './DeviceDiscovery.js';
import { ConnectionManager } from './connection/ConnectionManager.js';
import { EndpointBook, RELAY_SEEDS_KEY, derivePeerIdHex, classifyEndpoint, type EndpointCandidate, type PathState } from './connection/EndpointBook.js';
import { createDefaultBonjourFactory } from './discovery/bonjourDefault.js';
import { decideRelayRole, type RelayRoleDecision, type RelayServiceMode } from './relay/RelayRole.js';
import {
  AuthenticationHandshake,
  hexToBytes,
  type DeviceCertificate,
} from './handshake/AuthenticationHandshake.js';
import { SecureChannelImpl, type SecureChannel } from './secure/SecureChannelImpl.js';
import type { ConnectionProvider } from './transport/InMemoryTransport.js';
import { ErrorCodes, NetworkError } from '../errors.js';

export interface P2PConfig {
  transports?: ('tcp' | 'QUIC' | 'WebSocket')[];
  connectionEncryption?: ('TLS' | 'Noise')[];
  discovery?: ('mDNS' | 'DHT')[];
  maxConnections?: number;
  connectionTimeout?: number;
  keepAlive?: boolean;
  heartbeatInterval?: number;
  /** 本机监听端口（用于设备发现发布与候选地址组装） */
  listenPort?: number;
  defaultConfig?: P2PConfig;
}

export interface PeerId {
  readonly multihash: Uint8Array;
  readonly pubKey: Uint8Array;
  readonly id: string;
}

export interface PeerInfo {
  /** 发现层来源的 PeerId 只有 id 可信；multihash/pubKey 为占位值，公钥以握手证书为准 */
  peerId: PeerId;
  name: string;
  addresses: string[];
  port: number;
  timestamp: number;
}

export type ConnectionState =
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'disconnecting'
  | 'closed';

export interface Connection {
  readonly peerId: PeerId;
  readonly state: ConnectionState;
  readonly remoteAddress: string;
  send(data: Uint8Array): Promise<void>;
  receive(): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
  authenticate(): Promise<boolean>;
  isAuthenticated(): boolean;
}

/** C3：LAN 自动发现策略（机制在 core；开关由 app 决定） */
export interface LanDiscoveryOptions {
  /** 是否启用 mDNS 发现（默认 true；false = 不装配发现层） */
  enabled?: boolean;
  /** 发现到「已知/白名单」对端时是否自动拨号（默认 true） */
  autoDial?: boolean;
}

/** C6：内建 relay 角色状态（诊断/控制台只读展示） */
export interface RelayRoleStatus {
  mode: RelayServiceMode;
  serving: boolean;
  reason: string;
  publicAddrs: string[];
  inboundDirectEvidence: boolean;
  /** 允许预约的中转客户端（地址簿 paired/config 的 peer 键） */
  allowedClients: number;
}

/** C3：发现层状态快照（诊断/doctor 用） */
export interface LanDiscoveryStatus {
  enabled: boolean;
  running: boolean;
  autoDial: boolean;
  discovered: number;
  lanCandidates: number;
  ignoredUnknown: number;
  lastError: string | null;
}

export interface P2PNetwork {
  readonly peerId: PeerId;
  readonly config: P2PConfig;
  /** C1：当前生效路径（null = 未连/未知） */
  getPath(peerId: PeerId): PathState | null;
  /** C1：候选端点簿（未启用时 null） */
  getEndpointBook(): EndpointBook | null;
  /** C3：发现层状态（诊断用） */
  getLanStatus(): LanDiscoveryStatus;
  /** C6：内建 relay 角色状态（诊断/控制台只读） */
  getRelayStatus(): RelayRoleStatus;
  /** C6/C5：relay 角色变化回调（供 app 触发地址广播等） */
  onRelayRoleChanged(callback: (decision: RelayRoleDecision) => void): void;
  /** C4：打洞/直连成功上报（地址簿候选 + 路径升级 direct） */
  noteDirectConnection(peerIdHex: string, address: string): void;
  discoverPeer(peerId: PeerId): Promise<PeerInfo | null>;
  /**
   * 连接对端。`address` 提供时按显式地址拨号（手动 multiaddr / relay），
   * 否则用发现层地址。
   */
  connectToPeer(peerId: PeerId, address?: string): Promise<Connection>;
  /** 主动断开与某对端的连接（重连触发新会话） */
  disconnectPeer(peerId: PeerId): Promise<void>;
  authenticatePeer(connection: Connection): Promise<boolean>;
  sendMessage(connection: Connection, message: Uint8Array): Promise<void>;
  receiveMessage(connection: Connection): AsyncIterable<Uint8Array>;
  start(): Promise<void>;
  stop(): Promise<void>;
  onPeerDiscovered(callback: (peer: PeerInfo) => void): void;
  onConnectionOpened(callback: (conn: Connection) => void): void;
  onConnectionClosed(callback: (peerId: PeerId) => void): void;
}

/** 本机身份：设备密钥 + 用户主密钥签发的设备证书 */
export interface P2PNodeIdentity {
  deviceId: string;
  devicePublicKey: Uint8Array;
  devicePrivateKey: CryptoKey;
  certificate: DeviceCertificate;
  /** 叶→根证书链（T2 委派证书）；缺省按 `[certificate]` */
  certificateChain?: DeviceCertificate[];
}

export interface P2PNodeOptions {
  config?: P2PConfig;
  peerId?: PeerId;
  /** 节点身份；缺失时只能以匿名节点启动（无法通过认证） */
  identity?: P2PNodeIdentity;
  /** 用户主公钥：验证对端证书所必需 */
  userMasterPublicKey?: Uint8Array;
  /** 仅主设备持有：用于为本机即时签发证书 */
  userMasterPrivateKey?: CryptoKey;
  /** 拨号/监听抽象；InMemoryHub 节点会自动按本机身份绑定 */
  provider?: ConnectionProvider;
  /** mDNS 服务工厂；提供则自动启用设备发现 */
  bonjourFactory?: BonjourServiceFactory;
  /** 组件整体注入（测试/定制场景优先于内置装配） */
  discovery?: DeviceDiscovery;
  connectionManager?: ConnectionManager;
  handshake?: AuthenticationHandshake;
  /** C1：候选地址簿（app 注入存储；缺省不启用） */
  endpointBook?: EndpointBook;
  /** C1：无显式地址时使用地址簿自动拨号（默认 true） */
  autoConnect?: boolean;
  /** C3：LAN 发现策略（默认 enabled=true / autoDial=true） */
  lan?: LanDiscoveryOptions;
  /**
   * C3：允许名单（如 sync.peerWhitelist）。发现到的对端若既不在地址簿、也不在名单内，
   * **只忽略，绝不自动拨号**（安全不变式）。
   */
  peerAllowlist?: string[];
  /** C3：测试注入的 bonjour loader（配合 useDefaultBonjourFactory） */
  loadBonjourModule?: () => unknown;
  /**
   * C3：是否启用内置默认 bonjour factory（真 mDNS）。
   * 默认 **false**：库/测试不产生多播副作用；app（mcp/fleet）显式置 true。
   */
  useDefaultBonjourFactory?: boolean;
  /** 告警出口（发现禁用等非致命情况） */
  onWarn?: (message: string) => void;
  /**
   * C6：内建 relay 角色（守护内部；不再有 `mebular relay` 命令）。
   * `auto`（默认）仅在「对外可达监听」或「入站直连证据」成立时对外提供中转；
   * 仅服务地址簿中已配对/已授权对端；默认限额；不落任何记忆/授权状态。
   */
  relayService?: RelayServiceMode;
}

export class P2PNode implements P2PNetwork {
  readonly peerId: PeerId;
  readonly config: P2PConfig;

  private readonly identity: P2PNodeIdentity | null;
  private readonly provider: ConnectionProvider | null;
  private readonly bonjourFactory: BonjourServiceFactory | undefined;
  private readonly injectedDiscovery: DeviceDiscovery | undefined;

  private discovery: DeviceDiscovery | null = null;
  private connectionManager: ConnectionManager;
  private handshake: AuthenticationHandshake;
  private channels = new Map<string, Promise<SecureChannel>>();
  private endpointBook: EndpointBook | null;
  private autoConnect: boolean;
  private lanEnabled: boolean;
  private lanAutoDial: boolean;
  private peerAllowlist: Set<string>;
  private loadBonjourModule: (() => unknown) | undefined;
  private useDefaultBonjourFactory: boolean;
  private relayMode: RelayServiceMode;
  private relayDecision: RelayRoleDecision;
  private inboundDirectEvidence = false;
  private relayRoleChangedCallbacks: Array<(decision: RelayRoleDecision) => void> = [];
  private onWarn: (message: string) => void;
  /** 发现来源的 LAN 候选（peerId → 地址集合），用于降级时精确回退 */
  private discoveryAddrs = new Map<string, Set<string>>();
  private ignoredUnknownCount = 0;
  /** 发现层已撤销的 LAN 地址（阻止迟到的成功学习把候选学回来） */
  private withdrawnLan = new Map<string, Set<string>>();
  private lanLastError: string | null = null;
  /** stop() 时等待信道关闭的上限（ms） */
  private channelCloseTimeoutMs = 500;
  /** peerId → deviceId（握手成功后建立，用于把 deviceId 键的配对 hints 归并到 peerId） */
  private peerDeviceIds = new Map<string, string>();

  private running = false;
  private peerDiscoveredCallbacks: Array<(peer: PeerInfo) => void> = [];
  private connectionOpenedCallbacks: Array<(conn: Connection) => void> = [];
  private connectionClosedCallbacks: Array<(peerId: PeerId) => void> = [];

  constructor(options: P2PNodeOptions = {}) {
    this.config = { ...options.config?.defaultConfig, ...options.config };
    this.identity = options.identity ?? null;
    this.provider = options.provider ?? null;
    this.bonjourFactory = options.bonjourFactory;
    this.injectedDiscovery = options.discovery;

    this.endpointBook = options.endpointBook ?? null;
    this.autoConnect = options.autoConnect !== false;
    this.lanEnabled = options.lan?.enabled !== false;
    this.lanAutoDial = options.lan?.autoDial !== false;
    this.peerAllowlist = new Set(options.peerAllowlist ?? []);
    this.loadBonjourModule = options.loadBonjourModule;
    this.useDefaultBonjourFactory = options.useDefaultBonjourFactory === true;
    this.relayMode = options.relayService ?? 'auto';
    this.relayDecision = decideRelayRole({ mode: this.relayMode });
    this.onWarn = options.onWarn ?? (() => undefined);
    this.peerId = options.peerId ?? this.derivePeerId();
    this.connectionManager = options.connectionManager ?? new ConnectionManager({
      maxConnections: this.config.maxConnections,
      connectTimeout: this.config.connectionTimeout,
      keepAliveInterval: this.config.heartbeatInterval,
    });
    // C3：学习守卫（发现层撤销的 LAN 地址不入库/不设为路径）
    this.connectionManager.setLearnGuard((peerId, address) => !(this.withdrawnLan.get(peerId)?.has(address)));
    this.connectionManagerForBook(this.connectionManager);
    this.handshake = options.handshake ?? new AuthenticationHandshake();

    if (options.userMasterPublicKey) {
      this.handshake.setUserMasterPublicKey(options.userMasterPublicKey);
    }
    if (options.userMasterPrivateKey) {
      this.handshake.setUserMasterPrivateKey(options.userMasterPrivateKey);
    }
    if (this.identity) {
      this.handshake.setIdentity({
        deviceId: this.identity.deviceId,
        devicePublicKey: this.identity.devicePublicKey,
        devicePrivateKey: this.identity.devicePrivateKey,
        certificate: this.identity.certificate,
        ...(this.identity.certificateChain !== undefined ? { certificateChain: this.identity.certificateChain } : {}),
      });
    }
  }

  /** 把注入的端点簿转交给连接管理器（保持单一实例） */
  private connectionManagerForBook(manager: ConnectionManager): void {
    if (this.endpointBook) manager.setEndpointBook(this.endpointBook);
  }

  /** PeerId 从设备公钥派生（sha256），与身份绑定；无身份时退化为随机 ID */
  private derivePeerId(): PeerId {
    if (this.identity) {
      const digest = createHash('sha256').update(this.identity.devicePublicKey).digest();
      return {
        multihash: new Uint8Array(digest),
        pubKey: this.identity.devicePublicKey,
        id: derivePeerIdHex(this.identity.devicePublicKey),
      };
    }
    const id = crypto.randomUUID();
    return {
      multihash: new TextEncoder().encode(id),
      pubKey: new TextEncoder().encode(id),
      id,
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new NetworkError('P2P node already running', ErrorCodes.NETWORK_ALREADY_RUNNING);
    }

    try {
      if (this.identity && !this.identity.certificate) {
        // 主设备场景：持有用户主私钥时可即时自签发
        this.identity.certificate = await this.handshake.createCertificate(this.peerId);
      }

      await this.handshake.start();

      if (this.provider) {
        const bound = bindProvider(this.provider, this.peerId);
        this.connectionManager.setConnectionProvider(bound);
        bound.onIncomingConnection((conn) => {
          void this.handleIncomingConnection(conn);
        });
      }
      await this.connectionManager.start();

      // 设备发现（C3）：显式注入优先 → 显式 bonjourFactory → 默认 bonjour factory（软降级）
      // `network.lan.enabled=false` 时不装配发现层（app 策略优先）
      // 注意：core **不默认**启动真 mDNS（库/测试环境不应产生多播副作用）。
      // 默认 factory 由 app 显式启用（见 Mebular.network.lan.defaultFactory / packages/mcp config）。
      const factory = this.lanEnabled
        ? (this.bonjourFactory ?? (this.useDefaultBonjourFactory
          ? createDefaultBonjourFactory({
              ...(this.loadBonjourModule ? { loadModule: this.loadBonjourModule } : {}),
              onWarn: (message) => {
                this.lanLastError = message;
                this.onWarn(message);
              },
            })
          : null))
        : null;
      this.discovery = this.lanEnabled
        ? (this.injectedDiscovery ?? (factory ? new DeviceDiscovery({ createBonjourService: factory }) : null))
        : null;
      if (this.discovery) {
        // multiaddr 桥接（6.4，解除 D19 限制）：provider 暴露本机监听
        // multiaddr（Libp2pProvider.getMultiaddrs，含 /p2p/<id> 后缀）时
        // 随 mDNS TXT 发布，对端发现后可直接按 multiaddr 拨号；
        // provider 无此能力（InMemoryHub 等）时传空，行为与此前一致
        const addrs = this.getProviderMultiaddrs();
        // 端口回填：CLI/config 未给 listenPort 时从 provider multiaddrs 取（否则 mDNS 无法发布）
        const portFromAddrs = addrs
          .map((addr) => Number(/\/tcp\/(\d+)/.exec(addr)?.[1] ?? 0))
          .find((port) => port > 0) ?? 0;
        const listenPort = this.config.listenPort && this.config.listenPort > 0 ? this.config.listenPort : portFromAddrs;
        this.discovery.setLocalInfo(this.peerId, listenPort, addrs);
        await this.discovery.start();
        // C3：发现 → LAN 候选/自动拨号（仅限已知或白名单对端）
        this.discovery.onPeerDiscovered((peer) => {
          void this.handleLanDiscovery(peer);
        });
        this.discovery.on('peer-removed', (peerId: PeerId) => {
          void this.handleLanPeerRemoved(peerId.id);
        });
      }

      this.attachComponentListeners();
      this.running = true;
      this.refreshRelayRole(); // C6：启动后按实际监听地址评估是否当桥
    } catch (error) {
      // 部分启动回滚：已启动组件逆序收拢，不留下泄漏的计时器/监听器
      if (this.discovery?.isRunning()) {
        await this.discovery.stop().catch(() => undefined);
      }
      this.discovery = null;
      if (this.connectionManager.isRunning()) {
        await this.connectionManager.stop().catch(() => undefined);
      }
      if (this.handshake.isRunning()) {
        await this.handshake.stop().catch(() => undefined);
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      throw new NetworkError('P2P node not running', ErrorCodes.NETWORK_NOT_RUNNING);
    }
    await this.degradeAllLan().catch(() => undefined);
    this.running = false;

    for (const channelPromise of this.channels.values()) {
      try {
        // 有界等待：信道若卡在密钥交换（对端已消失），不得拖住 stop（生产同理）
        const channel = await Promise.race([
          channelPromise,
          new Promise<null>((resolve) => {
            // 注意：此处**不** unref —— stop() 是关闭路径，需要这 500ms 兜底保持事件循环
            // 直到 promise 落定（否则脚本/短进程会出现 unsettled top-level await）
            setTimeout(() => resolve(null), this.channelCloseTimeoutMs);
          }),
        ]);
        if (channel) await channel.close();
      } catch {
        // 忽略已损坏的信道
      }
    }
    this.channels.clear();

    if (this.discovery?.isRunning()) {
      await this.discovery.stop();
    }
    if (this.connectionManager.isRunning()) {
      await this.connectionManager.stop();
    }
    if (this.handshake.isRunning()) {
      await this.handshake.stop();
    }
  }

  // ---------- 发现与连接 ----------

  async discoverPeer(peerId: PeerId): Promise<PeerInfo | null> {
    if (!this.running) {
      throw new NetworkError('P2P node not running', ErrorCodes.NETWORK_NOT_RUNNING);
    }
    return this.discovery?.getPeer(peerId) ?? null;
  }

  async connectToPeer(peerId: PeerId, address?: string): Promise<Connection> {
    if (!this.running) {
      throw new NetworkError('P2P node not running', ErrorCodes.NETWORK_NOT_RUNNING);
    }

    // 显式地址优先（手动 multiaddr / relay）；否则用发现层地址；两者都可进入候选簿
    const peerInfo = address ? null : await this.discoverPeer(peerId);
    const targetAddress = address ?? peerInfo?.addresses[0];

    if (this.endpointBook) {
      if (address) {
        await this.endpointBook.upsert(peerId.id, [address], 'config').catch(() => undefined);
      }
      const discovered = peerInfo?.addresses ?? [];
      if (discovered.length > 0) {
        await this.endpointBook.upsert(peerId.id, discovered, 'learned').catch(() => undefined);
      }
      // 配对 hints 以 deviceId 为键：已知映射时并入 peerId 键
      const deviceId = this.peerDeviceIds.get(peerId.id);
      if (deviceId) await this.endpointBook.alias(deviceId, peerId.id).catch(() => undefined);
    }

    const connection = await this.connectionManager.connect(
      peerId,
      this.autoConnect ? targetAddress : targetAddress,
    );
    try {
      const authenticated = await this.authenticatePeer(connection);
      if (!authenticated) {
        throw new NetworkError(`Authentication failed for peer ${peerId.id}`, ErrorCodes.NETWORK_AUTH_FAILED);
      }
      return connection;
    } catch (error) {
      // 认证失败不能留下未受信任的连接
      await this.connectionManager.disconnect(peerId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * 主动断开与某对端的连接（G3-R 两阶段重连用）。
   * 断开后可用 connectToPeer 重新拨号触发新的握手与同步会话。
   */
  async disconnectPeer(peerId: PeerId): Promise<void> {
    if (!this.running) {
      throw new NetworkError('P2P node not running', ErrorCodes.NETWORK_NOT_RUNNING);
    }
    await this.connectionManager.disconnect(peerId);
  }

  async authenticatePeer(connection: Connection): Promise<boolean> {
    if (!this.running) {
      throw new NetworkError('P2P node not running', ErrorCodes.NETWORK_NOT_RUNNING);
    }
    // 活连接上已认证：复用现有信道，不重复握手
    const existingSession = this.handshake.getSession(connection.peerId);
    if (
      existingSession?.state === 'authenticated' &&
      connection.isAuthenticated() &&
      connection.state !== 'closed' &&
      connection.state !== 'disconnecting'
    ) {
      return true;
    }
    // 重连：在握手完成（authenticated 事件）前作废旧信道——
    // 消费者在 getChannel 中会等待基于新连接的信道，而不是命中死信道（F4）
    this.channels.delete(connection.peerId.id);
    const session = await this.handshake.initiateAuth(connection);
    if (session.state === 'authenticated') {
      this.learnPeerIdentity(connection, session.certificate?.deviceId);
      this.prepareChannel(connection);
      return true;
    }
    return false;
  }

  /** C1：学习 peerId ↔ deviceId 与可用远端地址（用于把配对 hints 归并到 peerId 键） */
  private learnPeerIdentity(connection: Connection, deviceId?: string): void {
    if (!this.endpointBook) return;
    if (deviceId && deviceId.length > 0) {
      this.peerDeviceIds.set(connection.peerId.id, deviceId);
      void this.endpointBook.alias(deviceId, connection.peerId.id).catch(() => undefined);
    }
    const remote = connection.remoteAddress;
    if (typeof remote === 'string' && remote.includes('/')) {
      void this.endpointBook.upsert(connection.peerId.id, [remote], 'learned').catch(() => undefined);
    }
  }

  getPath(peerId: PeerId): PathState | null {
    return this.connectionManager.getPath(peerId);
  }

  getEndpointBook(): EndpointBook | null {
    return this.endpointBook;
  }

  /** 测试/诊断：当前候选（按拨号顺序） */
  getCandidates(peerId: PeerId): EndpointCandidate[] {
    return this.endpointBook?.list(peerId.id) ?? [];
  }

  // ---------- C3：LAN 自动发现与路径切换 ----------

  /**
   * 发现事件处理（安全不变式）：
   * 只有「地址簿里已有该对端（paired/config）」或「在 peerAllowlist 内」才对端才记录 LAN
   * 候选并（autoDial 时）自动拨号；**陌生设备只计入 ignoredUnknown，绝不拨号**。
   */
  private async handleLanDiscovery(peer: PeerInfo): Promise<void> {
    if (!this.running || !this.lanEnabled) return;
    const peerId = peer.peerId.id;
    if (peerId === this.peerId.id) return;
    if (!this.isKnownOrAllowed(peerId)) {
      this.ignoredUnknownCount += 1;
      return;
    }
    if (!this.endpointBook) return;
    const lanAddrs = (peer.addresses ?? []).filter((addr) => classifyEndpoint(addr) === 'lan');
    if (lanAddrs.length === 0) return;
    const tracked = this.discoveryAddrs.get(peerId) ?? new Set<string>();
    const knownBefore = new Set(tracked);
    for (const addr of lanAddrs) {
      tracked.add(addr);
      this.withdrawnLan.get(peerId)?.delete(addr); // LAN 重新出现 → 允许再次学习
    }
    this.discoveryAddrs.set(peerId, tracked);
    await this.endpointBook.upsert(peerId, lanAddrs, 'learned').catch(() => undefined);

    if (!this.lanAutoDial) return;
    const peerRef = { id: peerId, multihash: new Uint8Array(), pubKey: new Uint8Array() };
    const connection = this.connectionManager.getConnection(peerRef);
    const currentPath = this.getPath(peerRef);
    const hasNewLan = [...lanAddrs].some((addr) => !knownBefore.has(addr));
    if (!connection) {
      try {
        await this.connectToPeer(peerRef);
      } catch {
        // 拨号失败由 ConnectionManager 的候选/退避策略处理（LAN 失效会回退 relay/direct）
      }
      return;
    }
    // LAN↔WAN 无感升级：当前走非 LAN（relay/direct）且发现到**新** LAN 候选 → 断开重连走 LAN
    if (hasNewLan && currentPath?.kind !== 'lan') {
      await this.connectionManager.disconnect(peerRef).catch(() => undefined);
      try {
        await this.connectToPeer(peerRef);
      } catch {
        // 升级失败保持原候选顺序（下次拨号/退避会再试）
      }
    }
  }

  /** 已知或白名单：地址簿存在 ≥1 候选（含 deviceId↔peerId 别名键）或命中 allowlist。 */
  private isKnownOrAllowed(peerId: string): boolean {
    if (this.peerAllowlist.has(peerId)) return true;
    const book = this.endpointBook;
    if (!book) return false;
    if (book.list(peerId).length > 0) return true;
    // 别名：deviceId 键的候选（配对/配置）——用握手学习到的映射反查
    for (const [knownPeer, deviceId] of this.peerDeviceIds.entries()) {
      if (knownPeer === peerId && book.list(deviceId).length > 0) return true;
    }
    return false;
  }

  /**
   * 对端从发现层消失（mDNS 撤销/超时）：撤销其 LAN 候选并降级路径，
   * 让后续拨号回退到 relay/direct；autoDial 时立即重试（触发降级切换）。
   */
  private async handleLanPeerRemoved(peerId: string): Promise<void> {
    const tracked = this.discoveryAddrs.get(peerId);
    if (!tracked || tracked.size === 0) return;
    this.discoveryAddrs.delete(peerId);
    const withdrawn = this.withdrawnLan.get(peerId) ?? new Set<string>();
    for (const addr of tracked) withdrawn.add(addr);
    this.withdrawnLan.set(peerId, withdrawn);

    const book = this.endpointBook;
    const peerRef = { id: peerId, multihash: new Uint8Array(), pubKey: new Uint8Array() };
    const current = this.getPath(peerRef);
    if (book) {
      for (const addr of tracked) await book.remove(peerId, addr).catch(() => undefined);
    }
    // 当前若正走已消失的 LAN：断开并让下一次拨号回退 relay/direct（真正的降级）
    const wasLan = Boolean(current && tracked.has(current.address));
    if (wasLan) {
      book?.clearPath(peerId, new Error('LAN 候选消失（mDNS 撤销/超时）'));
      await this.connectionManager.disconnect(peerRef).catch(() => undefined);
    }
    if (this.lanAutoDial) {
      this.connectToPeer(peerRef).catch(() => undefined);
    }
  }

  /** 发现层关闭/停止：撤销全部发现来源 LAN 候选并降级路径（无感切到 relay/direct）。 */
  private async degradeAllLan(): Promise<void> {
    const book = this.endpointBook;
    for (const [peerId, tracked] of this.discoveryAddrs.entries()) {
      if (book) {
        for (const addr of tracked) await book.remove(peerId, addr).catch(() => undefined);
        const path = book.getPath(peerId);
        if (path && tracked.has(path.address)) book.clearPath(peerId, new Error('发现层已关闭'));
      }
    }
    this.discoveryAddrs.clear();
  }

  // ---------- C6：内建 relay 角色 ----------

  /** 重新评估 relay 角色（监听地址变化 / 入站直连证据出现时调用） */
  refreshRelayRole(): RelayRoleDecision {
    const listenAddrs = this.getLocalMultiaddrs();
    const next = decideRelayRole({
      mode: this.relayMode,
      listenAddrs,
      inboundDirectEvidence: this.inboundDirectEvidence,
    });
    const changed = next.serve !== this.relayDecision.serve
      || JSON.stringify(next.publicAddrs) !== JSON.stringify(this.relayDecision.publicAddrs);
    this.relayDecision = next;
    if (changed) {
      for (const callback of this.relayRoleChangedCallbacks) {
        try { callback({ ...next }); } catch { /* 回调失败不影响角色判定 */ }
      }
    }
    return { ...next };
  }

  getRelayStatus(): RelayRoleStatus {
    const book = this.endpointBook;
    const allowedClients = book
      ? book.keys().filter((key) => key !== RELAY_SEEDS_KEY && book.list(key).some((c) => c.source === 'paired' || c.source === 'config')).length
      : 0;
    return {
      mode: this.relayMode,
      serving: this.relayDecision.serve,
      reason: this.relayDecision.reason,
      publicAddrs: [...this.relayDecision.publicAddrs],
      inboundDirectEvidence: this.inboundDirectEvidence,
      allowedClients,
    };
  }

  /** C6：中转预约是否放行该 peer（仅地址簿 paired/config 键；不含纯发现学习来的对端） */
  private isRelayReservationAllowed(peerId: string): boolean {
    if (!this.relayDecision.serve) return false;
    const book = this.endpointBook;
    if (!book) return false;
    return book.list(peerId).some((candidate) => candidate.source === 'paired' || candidate.source === 'config');
  }

  onRelayRoleChanged(callback: (decision: RelayRoleDecision) => void): void {
    this.relayRoleChangedCallbacks.push(callback);
  }

  /**
   * C4：观测到直连（AutoNAT/DCUtR 打洞成功或本就直接）→ 入候选池并**升级路径为 direct**。
   * 只动地址簿/路径状态；不涉授权。
   */
  noteDirectConnection(peerIdHex: string, address: string): void {
    if (!peerIdHex || !address || address.includes('/p2p-circuit')) return;
    const book = this.endpointBook;
    if (!book) return;
    void book.upsert(peerIdHex, [address], 'learned').catch(() => undefined);
    book.recordSuccess(peerIdHex, address);
    book.setPath(peerIdHex, address);
  }

  /** C6：Libp2pProvider 用 —— 当前是否对外提供中转 + 是否放行该 peer */
  relayGaterPredicates(): { serve: boolean; isAllowed: (peerId: string) => boolean } {
    return {
      serve: this.relayDecision.serve,
      isAllowed: (peerId: string) => this.isRelayReservationAllowed(peerId),
    };
  }

  getLanStatus(): LanDiscoveryStatus {
    let lanCandidates = 0;
    for (const tracked of this.discoveryAddrs.values()) lanCandidates += tracked.size;
    return {
      enabled: this.lanEnabled,
      running: Boolean(this.discovery?.isRunning()),
      autoDial: this.lanAutoDial,
      discovered: this.discovery?.getDiscoveredPeerCount() ?? 0,
      lanCandidates,
      ignoredUnknown: this.ignoredUnknownCount,
      lastError: this.lanLastError,
    };
  }

  /** 被动接入：完成对端发起的认证，认证成功后登记连接并准备信道 */
  private async handleIncomingConnection(connection: Connection): Promise<void> {
    try {
      // C6：入站直连证据（非 circuit）→ 说明外部确实能连到本机，可作为「对外可达」的依据
      const remote = typeof connection.remoteAddress === 'string' ? connection.remoteAddress : '';
      if (remote.length > 0 && !remote.includes('p2p-circuit') && !this.inboundDirectEvidence) {
        this.inboundDirectEvidence = true;
        this.refreshRelayRole();
      }
      // 重连：acceptAuth 完成即触发 authenticated 事件，必须在事件前清掉旧信道（F4）
      this.channels.delete(connection.peerId.id);
      const session = await this.handshake.acceptAuth(connection);
      if (session.state === 'authenticated') this.learnPeerIdentity(connection, session.certificate?.deviceId);
      if (session.state === 'authenticated') {
        this.connectionManager.setConnection(connection.peerId, connection);
        this.prepareChannel(connection);
      }
    } catch (error) {
      await connection.close().catch(() => undefined);
      this.emit('auth-failed', connection.peerId, error);
    }
  }

  // ---------- 加密消息 ----------

  async sendMessage(connection: Connection, message: Uint8Array): Promise<void> {
    if (!this.running) {
      throw new NetworkError('P2P node not running', ErrorCodes.NETWORK_NOT_RUNNING);
    }
    if (!connection.isAuthenticated()) {
      throw new NetworkError('Connection not authenticated', ErrorCodes.NETWORK_NOT_AUTHENTICATED);
    }
    const channel = await this.channelFor(connection);
    await channel.send(message);
  }

  async *receiveMessage(connection: Connection): AsyncIterable<Uint8Array> {
    const channel = await this.channelFor(connection);
    yield* channel.receive();
  }

  /** 认证完成后双端各自建信道：同时发临时公钥，协商自然收敛 */
  private prepareChannel(connection: Connection): void {
    const key = connection.peerId.id;
    if (this.channels.has(key)) {
      return;
    }
    // 身份绑定：密钥交换帧由本机设备私钥签名，并用握手已验证的对端证书公钥验签
    const session = this.handshake.getSession(connection.peerId);
    const peerDevicePublicKey = session?.certificate
      ? hexToBytes(session.certificate.devicePublicKey)
      : undefined;
    const channel = new SecureChannelImpl(connection, {
      ...(this.identity ? { devicePrivateKey: this.identity.devicePrivateKey } : {}),
      ...(peerDevicePublicKey ? { peerDevicePublicKey } : {}),
    });
    const started = channel.start().then(() => channel);
    started.catch(() => {
      // 建信道失败不阻塞连接本身；仅当表项仍是本信道时才移除——
      // 否则旧连接信道的延迟失败会误删重连后的新信道（G3-R 两阶段重连）
      if (this.channels.get(key) === started) {
        this.channels.delete(key);
      }
    });
    this.channels.set(key, started);
  }

  private channelFor(connection: Connection): Promise<SecureChannel> {
    const key = connection.peerId.id;
    let channel = this.channels.get(key);
    if (!channel) {
      this.prepareChannel(connection);
      channel = this.channels.get(key);
    }
    return channel!;
  }

  // ---------- 事件 ----------

  onPeerDiscovered(callback: (peer: PeerInfo) => void): void {
    this.peerDiscoveredCallbacks.push(callback);
    if (this.running && this.discovery) {
      this.discovery.onPeerDiscovered(callback);
    }
  }

  onConnectionOpened(callback: (conn: Connection) => void): void {
    this.connectionOpenedCallbacks.push(callback);
    if (this.running) {
      this.connectionManager.on('connection-opened', callback);
    }
  }

  onConnectionClosed(callback: (peerId: PeerId) => void): void {
    this.connectionClosedCallbacks.push(callback);
    if (this.running) {
      this.connectionManager.on('connection-closed', callback);
    }
  }

  private attachComponentListeners(): void {
    // 连接关闭即释放对应加密信道与认证会话，避免重连命中过期状态
    // （否则 initiateAuth 命中已认证会话而跳过握手，对端读到信道帧报 malformed）（G3-R）
    this.connectionManager.on('connection-closed', (peerId: PeerId) => {
      this.channels.delete(peerId.id);
      this.handshake.removeSession(peerId);
    });
    if (this.discovery) {
      for (const cb of this.peerDiscoveredCallbacks) {
        this.discovery.onPeerDiscovered(cb);
      }
    }
    for (const cb of this.connectionOpenedCallbacks) {
      this.connectionManager.on('connection-opened', cb);
    }
    for (const cb of this.connectionClosedCallbacks) {
      this.connectionManager.on('connection-closed', cb);
    }
  }

  private emit(event: string, ...args: unknown[]): void {
    // P2PNode 自身不继承 EventEmitter；认证失败等事件通过回调透出
    if (event === 'auth-failed') {
      // 目前仅记录；后续可扩展为公开事件流
      void args;
    }
  }

  // ---------- 组件访问（测试与上层编排用） ----------

  getConnectionManager(): ConnectionManager {
    return this.connectionManager;
  }

  getHandshake(): AuthenticationHandshake {
    return this.handshake;
  }

  /**
   * 取得到端的加密信道。认证完成时信道异步建立，
   * timeoutMs 内轮询等待其就绪（默认 5s），超时返回 null。
   * 绑定已关闭连接的残留信道不返回：继续等待重连后的新信道（F4）。
   */
  async getChannel(peerId: PeerId, timeoutMs = 5000): Promise<SecureChannel | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pending = this.channels.get(peerId.id);
      if (pending) {
        try {
          const channel = await pending;
          if (channel.connection.state !== 'closed' && channel.connection.state !== 'disconnecting') {
            return channel;
          }
        } catch {
          // 建信道失败的条目会被移除，继续轮询等待重建
        }
      }
      if (Date.now() >= deadline) {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  getDiscovery(): DeviceDiscovery | null {
    return this.discovery;
  }

  /**
   * 本机可拨 multiaddr（libp2p 场景，含 relay 预约地址）；无 multiaddr
   * 能力（InMemoryHub 等）时返回空数组。供手动寻址 / 跨网测试交换。
   */
  getLocalMultiaddrs(): string[] {
    return this.getProviderMultiaddrs();
  }

  /**
   * provider 具备 multiaddr 暴露能力（Libp2pProvider）时取本机监听地址；
   * 鸭子类型探测保持 ConnectionProvider 接缝不变，异常向上传递不静默
   */
  private getProviderMultiaddrs(): string[] {
    const provider = this.provider as { getMultiaddrs?: () => string[] } | null;
    if (provider && typeof provider.getMultiaddrs === 'function') {
      return provider.getMultiaddrs();
    }
    return [];
  }

  isRunning(): boolean {
    return this.running;
  }
}

/** InMemoryHub 需要按本机身份绑定；已绑定的 provider 原样使用 */
function bindProvider(provider: ConnectionProvider, peerId: PeerId): ConnectionProvider {
  const bindable = provider as ConnectionProvider & {
    forPeer?: (id: PeerId) => ConnectionProvider;
  };
  if (typeof bindable.forPeer === 'function') {
    return bindable.forPeer(peerId);
  }
  return provider;
}
