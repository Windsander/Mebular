// P2P 网络抽象层与节点编排
//
// P2PNode 把五个组件串成完整链路：
//   设备发现(DeviceDiscovery) → 连接管理(ConnectionManager)
//   → 认证握手(AuthenticationHandshake) → 加密信道(SecureChannelImpl)
//   NAT 穿透(NATTraversal) 作为连接建立的策略辅助。
//
// 具体网络栈通过 ConnectionProvider 注入（当前提供 InMemoryHub；
// libp2p 适配器在此接缝上接入，见 docs.design/project-status.md 的技术决策记录）。

import { createHash } from 'crypto';
import { DeviceDiscovery, type BonjourServiceFactory } from './DeviceDiscovery.js';
import { ConnectionManager } from './connection/ConnectionManager.js';
import {
  AuthenticationHandshake,
  type DeviceCertificate,
} from './handshake/AuthenticationHandshake.js';
import { SecureChannelImpl, type SecureChannel } from './secure/SecureChannelImpl.js';
import type { ConnectionProvider } from './transport/InMemoryTransport.js';

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

export interface P2PNetwork {
  readonly peerId: PeerId;
  readonly config: P2PConfig;
  discoverPeer(peerId: PeerId): Promise<PeerInfo | null>;
  connectToPeer(peerId: PeerId): Promise<Connection>;
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

    this.peerId = options.peerId ?? this.derivePeerId();
    this.connectionManager = options.connectionManager ?? new ConnectionManager({
      maxConnections: this.config.maxConnections,
      connectTimeout: this.config.connectionTimeout,
      keepAliveInterval: this.config.heartbeatInterval,
    });
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
      });
    }
  }

  /** PeerId 从设备公钥派生（sha256），与身份绑定；无身份时退化为随机 ID */
  private derivePeerId(): PeerId {
    if (this.identity) {
      const digest = createHash('sha256').update(this.identity.devicePublicKey).digest();
      return {
        multihash: new Uint8Array(digest),
        pubKey: this.identity.devicePublicKey,
        id: new Uint8Array(digest).reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), ''),
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
      throw new Error('P2P node already running');
    }

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

    // 设备发现：显式注入优先，其次按 bonjourFactory 装配，都没有则跳过
    this.discovery = this.injectedDiscovery
      ?? (this.bonjourFactory
        ? new DeviceDiscovery({ createBonjourService: this.bonjourFactory })
        : null);
    if (this.discovery) {
      this.discovery.setLocalInfo(this.peerId, this.config.listenPort ?? 0);
      await this.discovery.start();
    }

    this.attachComponentListeners();
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      throw new Error('P2P node not running');
    }
    this.running = false;

    for (const channelPromise of this.channels.values()) {
      try {
        const channel = await channelPromise;
        await channel.close();
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
      throw new Error('P2P node not running');
    }
    return this.discovery?.getPeer(peerId) ?? null;
  }

  async connectToPeer(peerId: PeerId): Promise<Connection> {
    if (!this.running) {
      throw new Error('P2P node not running');
    }

    const peerInfo = await this.discoverPeer(peerId);
    const address = peerInfo?.addresses[0];

    const connection = await this.connectionManager.connect(peerId, address);
    try {
      const authenticated = await this.authenticatePeer(connection);
      if (!authenticated) {
        throw new Error(`Authentication failed for peer ${peerId.id}`);
      }
      return connection;
    } catch (error) {
      // 认证失败不能留下未受信任的连接
      await this.connectionManager.disconnect(peerId).catch(() => undefined);
      throw error;
    }
  }

  async authenticatePeer(connection: Connection): Promise<boolean> {
    if (!this.running) {
      throw new Error('P2P node not running');
    }
    const session = await this.handshake.initiateAuth(connection);
    if (session.state === 'authenticated') {
      this.prepareChannel(connection);
      return true;
    }
    return false;
  }

  /** 被动接入：完成对端发起的认证，认证成功后登记连接并准备信道 */
  private async handleIncomingConnection(connection: Connection): Promise<void> {
    try {
      const session = await this.handshake.acceptAuth(connection);
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
      throw new Error('P2P node not running');
    }
    if (!connection.isAuthenticated()) {
      throw new Error('Connection not authenticated');
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
    const channel = new SecureChannelImpl(connection);
    const started = channel.start().then(() => channel);
    started.catch(() => {
      // 建信道失败不阻塞连接本身；首次收发时会再暴露错误
      this.channels.delete(key);
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

  getDiscovery(): DeviceDiscovery | null {
    return this.discovery;
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
