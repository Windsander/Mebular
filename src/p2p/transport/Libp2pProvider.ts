// libp2p 传输适配器
//
// 把 js-libp2p（v3，可选依赖）适配到 ConnectionProvider 接缝上，
// 让 P2PNode 的 发现 → 连接 → 认证 → 加密信道 链路可以跑在真实 TCP 之上。
//
// 设计要点：
// - 可选依赖：libp2p 系包是 optionalDependencies，这里只做运行时动态导入；
//   包缺失时诚实抛出 NETWORK_LIBP2P_NOT_AVAILABLE，不影响自建传输。
// - 结构类型：本文件只用最小结构化接口描述用到的 libp2p 表面，
//   编译期不依赖可选包的类型声明（包不存在时 tsc 依然通过）。
// - 身份映射：本机 Ed25519 设备私钥 → generateKeyPairFromSeed → libp2p 身份，
//   双方 PeerId 派生自同一把公钥，与我方 PeerId（sha256 hex）双向可换算。
// - 帧边界：TCP 是字节流，send() 的写边界用 4 字节大端长度前缀保留，
//   使握手与加密信道的「一次 send 对应一次 receive」语义在流式传输上成立。
// - ping 语义：libp2p 连接存活由传输层自身保证（断开会终结流），
//   ping() 只刷新本端活动时间，不注入任何应用层字节。

import { createHash } from 'crypto';
import { ErrorCodes, NetworkError } from '../../errors.js';
import type { Connection, ConnectionState, PeerId } from '../P2PNetwork.js';
import type {
  ActivityTrackingConnection,
  ConnectionProvider,
  MutableAuthenticationConnection,
  PingCapableConnection,
} from './InMemoryTransport.js';
import { MessageQueue } from './InMemoryTransport.js';

/** 默认应用协议标识 */
export const MEBULAR_PROTOCOL = '/mebular/1.0.0';

/** 单帧载荷上限（防御畸形长度前缀导致的内存耗尽） */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

// ---------- 可选包的结构化类型（仅描述用到的最小表面） ----------

/** 能被 subarray() 成 Uint8Array 的接收块（Uint8Array 或 Uint8ArrayList） */
interface ChunkLike {
  subarray(): Uint8Array;
}

/** libp2p 流（@libp2p/interface Stream 的最小表面） */
export interface Libp2pStreamLike extends AsyncIterable<ChunkLike> {
  readonly status: 'open' | 'closing' | 'closed' | 'aborted' | 'reset';
  send(data: Uint8Array): boolean;
  close(): Promise<void>;
  onDrain(): Promise<void>;
}

/** libp2p 连接（仅取对端身份与地址） */
interface Libp2pConnectionLike {
  remotePeer: Libp2pPeerIdLike;
  remoteAddr: { toString(): string };
}

/** libp2p PeerId（Ed25519 身份内嵌公钥对象） */
interface Libp2pPeerIdLike {
  toString(): string;
  publicKey?: { type: string; raw: Uint8Array };
}

/** libp2p 节点（最小表面） */
interface Libp2pNodeLike {
  peerId: Libp2pPeerIdLike;
  start(): Promise<void>;
  stop(): Promise<void>;
  handle(
    protocol: string,
    handler: (stream: Libp2pStreamLike, connection: Libp2pConnectionLike) => void,
  ): Promise<void>;
  dialProtocol(target: unknown, protocol: string): Promise<Libp2pStreamLike>;
  /** 拨号（relay 预约用） */
  dial(target: unknown): Promise<unknown>;
  getMultiaddrs(): Array<{ toString(): string }>;
}

/** relay 可选依赖集合（@libp2p/circuit-relay-v2 + @libp2p/identify） */
interface RelayModules {
  circuitRelayTransport(options?: Record<string, unknown>): unknown;
  circuitRelayServer(options?: Record<string, unknown>): unknown;
  identify(): unknown;
}

/** 动态导入得到的模块集合 */
interface Libp2pModules {
  createLibp2p(options: Record<string, unknown>): Promise<Libp2pNodeLike>;
  tcp(): unknown;
  noise(): unknown;
  yamux(): unknown;
  generateKeyPairFromSeed(type: 'Ed25519', seed: Uint8Array): Promise<unknown>;
  publicKeyFromRaw(raw: Uint8Array): unknown;
  peerIdFromPublicKey(publicKey: unknown): Libp2pPeerIdLike;
  multiaddr(input: string): unknown;
}

/** 动态导入器：可注入以便测试「缺包」路径；默认实现绕开转译器的 import 改写 */
export type ModuleImporter = (specifier: string) => Promise<Record<string, unknown>>;

const defaultImporter: ModuleImporter = new Function(
  'specifier',
  'return import(specifier);',
) as ModuleImporter;

/**
 * 加载 libp2p 模块集合；任一缺失即抛 NETWORK_LIBP2P_NOT_AVAILABLE。
 * 错误信息附带缺失包名与安装提示。
 */
export async function loadLibp2pModules(
  importer: ModuleImporter = defaultImporter,
): Promise<Libp2pModules> {
  const specs = [
    'libp2p',
    '@libp2p/tcp',
    '@chainsafe/libp2p-noise',
    '@chainsafe/libp2p-yamux',
    '@libp2p/crypto/keys',
    '@libp2p/peer-id',
    '@multiformats/multiaddr',
  ];
  const loaded: Record<string, Record<string, unknown>> = {};
  for (const spec of specs) {
    try {
      loaded[spec] = await importer(spec);
    } catch (error) {
      throw new NetworkError(
        `libp2p 可选依赖缺失（${spec}）。安装：npm install libp2p @libp2p/tcp ` +
          '@chainsafe/libp2p-noise @chainsafe/libp2p-yamux @libp2p/crypto @libp2p/peer-id ' +
          '@multiformats/multiaddr；或使用 network.provider 注入自建传输。',
        ErrorCodes.NETWORK_LIBP2P_NOT_AVAILABLE,
        error as Error,
      );
    }
  }

  const keys = loaded['@libp2p/crypto/keys']!;
  const peerIdModule = loaded['@libp2p/peer-id']!;
  return {
    createLibp2p: loaded['libp2p']!.createLibp2p as Libp2pModules['createLibp2p'],
    tcp: loaded['@libp2p/tcp']!.tcp as Libp2pModules['tcp'],
    noise: loaded['@chainsafe/libp2p-noise']!.noise as Libp2pModules['noise'],
    yamux: loaded['@chainsafe/libp2p-yamux']!.yamux as Libp2pModules['yamux'],
    generateKeyPairFromSeed: keys.generateKeyPairFromSeed as Libp2pModules['generateKeyPairFromSeed'],
    publicKeyFromRaw: keys.publicKeyFromRaw as Libp2pModules['publicKeyFromRaw'],
    peerIdFromPublicKey: peerIdModule.peerIdFromPublicKey as Libp2pModules['peerIdFromPublicKey'],
    multiaddr: loaded['@multiformats/multiaddr']!.multiaddr as Libp2pModules['multiaddr'],
  };
}

/**
 * 加载 circuit relay 可选依赖（`@libp2p/circuit-relay-v2` + `@libp2p/identify`）；
 * 任一缺失即抛 `NETWORK_RELAY_NOT_AVAILABLE`，调用方可据此降级手动 multiaddr。
 */
export async function loadRelayModules(
  importer: ModuleImporter = defaultImporter,
): Promise<RelayModules> {
  const specs = ['@libp2p/circuit-relay-v2', '@libp2p/identify'];
  const loaded: Record<string, Record<string, unknown>> = {};
  for (const spec of specs) {
    try {
      loaded[spec] = await importer(spec);
    } catch (error) {
      throw new NetworkError(
        `中继可选依赖缺失（${spec}）。安装：npm install @libp2p/circuit-relay-v2 @libp2p/identify；` +
          '或改用手动 multiaddr（network.libp2p.relayServers 留空）。',
        ErrorCodes.NETWORK_RELAY_NOT_AVAILABLE,
        error as Error,
      );
    }
  }
  const relay = loaded['@libp2p/circuit-relay-v2']!;
  const identify = loaded['@libp2p/identify']!;
  const circuitRelayTransport = relay['circuitRelayTransport'];
  const circuitRelayServer = relay['circuitRelayServer'];
  const identifyFn = identify['identify'];
  if (
    typeof circuitRelayTransport !== 'function' ||
    typeof circuitRelayServer !== 'function' ||
    typeof identifyFn !== 'function'
  ) {
    throw new NetworkError(
      'circuit relay 可选依赖导出的表面不符（版本不兼容）',
      ErrorCodes.NETWORK_RELAY_NOT_AVAILABLE,
    );
  }
  return {
    circuitRelayTransport: circuitRelayTransport as RelayModules['circuitRelayTransport'],
    circuitRelayServer: circuitRelayServer as RelayModules['circuitRelayServer'],
    identify: identifyFn as RelayModules['identify'],
  };
}

// ---------- 长度前缀帧编解码 ----------

/** 编码一帧：4 字节大端长度 + 载荷 */
export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new NetworkError(`帧载荷超限：${payload.byteLength} > ${MAX_FRAME_BYTES}`, ErrorCodes.NETWORK_FRAME_TOO_LARGE);
  }
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

/** 增量帧解码器：喂入任意切分的字节块，吐出完整载荷 */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;

    const frames: Uint8Array[] = [];
    for (;;) {
      if (this.buffer.byteLength < 4) break;
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset).getUint32(0, false);
      if (length > MAX_FRAME_BYTES) {
        throw new NetworkError(`帧长度前缀越界：${length} > ${MAX_FRAME_BYTES}`, ErrorCodes.NETWORK_FRAME_TOO_LARGE);
      }
      if (this.buffer.byteLength < 4 + length) break;
      frames.push(this.buffer.slice(4, 4 + length));
      this.buffer = this.buffer.slice(4 + length);
    }
    return frames;
  }
}

// ---------- 身份映射 ----------

/** 从设备公钥派生我方 PeerId（与 P2PNode.derivePeerId 同一算法：sha256 hex） */
export function peerIdFromDevicePublicKey(publicKey: Uint8Array): PeerId {
  const digest = createHash('sha256').update(publicKey).digest();
  return {
    multihash: new Uint8Array(digest),
    pubKey: publicKey,
    id: new Uint8Array(digest).reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), ''),
  };
}

/** 我方 PeerId（Ed25519 raw 公钥）→ libp2p PeerId */
export function toLibp2pPeerId(peerId: PeerId, modules: Libp2pModules): Libp2pPeerIdLike {
  return modules.peerIdFromPublicKey(modules.publicKeyFromRaw(peerId.pubKey));
}

/**
 * libp2p PeerId → 我方 PeerId。
 * 仅支持 Ed25519 身份内嵌公钥的 peer id（Mebular 对端必然满足）；
 * 其他形态诚实报错而不是退化成不可对应的 ID。
 */
export function fromLibp2pPeerId(peerId: Libp2pPeerIdLike): PeerId {
  const publicKey = peerId.publicKey;
  if (!publicKey || publicKey.type !== 'Ed25519' || publicKey.raw.byteLength !== 32) {
    throw new NetworkError(
      `对端 peer id 未内嵌 Ed25519 公钥，无法映射：${peerId.toString()}`,
      ErrorCodes.NETWORK_PEER_IDENTITY_UNSUPPORTED,
    );
  }
  return peerIdFromDevicePublicKey(new Uint8Array(publicKey.raw));
}

// ---------- 连接包装 ----------

function mapStreamStatus(status: Libp2pStreamLike['status']): ConnectionState {
  switch (status) {
    case 'open':
      return 'connected';
    case 'closing':
      return 'disconnecting';
    default:
      return 'closed';
  }
}

/** 把一条 libp2p 流包装成保留写边界的 Connection */
export class Libp2pConnection
  implements
    Connection,
    MutableAuthenticationConnection,
    ActivityTrackingConnection,
    PingCapableConnection
{
  readonly peerId: PeerId;
  readonly remoteAddress: string;

  private readonly stream: Libp2pStreamLike;
  private readonly inbox = new MessageQueue<Uint8Array>();
  private readonly decoder = new FrameDecoder();
  private authenticated = false;
  private activityAt = Date.now();
  private closing = false;

  constructor(stream: Libp2pStreamLike, remotePeerId: PeerId, remoteAddress: string) {
    this.stream = stream;
    this.peerId = remotePeerId;
    this.remoteAddress = remoteAddress;
    void this.pumpIncoming();
  }

  get state(): ConnectionState {
    if (this.closing) return 'disconnecting';
    return mapStreamStatus(this.stream.status);
  }

  get lastActivityAt(): number {
    return this.activityAt;
  }

  /** 后台泵：流的接收块 → 帧解码 → 收件队列（恢复写边界） */
  private async pumpIncoming(): Promise<void> {
    try {
      for await (const chunk of this.stream) {
        this.activityAt = Date.now();
        const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
        for (const frame of this.decoder.push(bytes)) {
          this.inbox.push(frame);
        }
      }
      this.inbox.close();
    } catch (error) {
      this.inbox.fail(
        error instanceof Error ? error : new Error(`libp2p 流读取失败：${String(error)}`),
      );
    }
  }

  async send(data: Uint8Array): Promise<void> {
    if (this.state === 'closed' || this.state === 'disconnecting') {
      throw new NetworkError('Connection closed', ErrorCodes.NETWORK_CONNECTION_CLOSED);
    }
    this.activityAt = Date.now();
    const writable = this.stream.send(encodeFrame(data));
    if (!writable) {
      await this.stream.onDrain();
    }
  }

  receive(): AsyncIterable<Uint8Array> {
    return this.inbox.iterate();
  }

  async close(): Promise<void> {
    if (this.closing || this.stream.status !== 'open') {
      if (this.stream.status === 'closed') this.inbox.close();
      return;
    }
    this.closing = true;
    try {
      await this.stream.close();
    } finally {
      this.inbox.close();
    }
  }

  /** libp2p 的连接存活由传输层保证；ping 只刷新本端活动时间，不产生字节 */
  async ping(): Promise<void> {
    if (this.state === 'closed') {
      throw new NetworkError('Connection closed', ErrorCodes.NETWORK_CONNECTION_CLOSED);
    }
    this.activityAt = Date.now();
  }

  markAuthenticated(): void {
    this.authenticated = true;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  async authenticate(): Promise<boolean> {
    return this.authenticated;
  }
}

// ---------- Provider ----------

export interface Libp2pProviderOptions {
  /** 本机设备密钥：libp2p 身份由它派生，保证与 P2PNode 的 PeerId 一致 */
  deviceKey: { publicKey: Uint8Array; privateKey: CryptoKey };
  /** 监听 multiaddr，默认全网卡随机端口 */
  listen?: string[];
  /** 应用协议标识，默认 /mebular/1.0.0 */
  protocol?: string;
  /**
   * 作为 circuit relay 服务器运行（供异网段主机预约中转）；
   * 需可选依赖 `@libp2p/circuit-relay-v2` + `@libp2p/identify`，缺包抛
   * `NETWORK_RELAY_NOT_AVAILABLE`。
   */
  relayServer?: boolean;
  /** 向这些 relay multiaddr 预约中转地址；缺包抛 `NETWORK_RELAY_NOT_AVAILABLE` */
  relayServers?: string[];
}

/**
 * libp2p 传输 Provider。
 * 生命周期归创建者：create() → start() → （交给 P2PNode 拨号/接听）→ stop()。
 */
export class Libp2pProvider implements ConnectionProvider {
  private readonly modules: Libp2pModules;
  private readonly node: Libp2pNodeLike;
  private readonly protocol: string;
  private readonly localPeerId: PeerId;
  private readonly relayServers: string[];
  private incomingHandler: ((conn: Connection) => void) | null = null;
  private running = false;

  private constructor(
    modules: Libp2pModules,
    node: Libp2pNodeLike,
    protocol: string,
    localPeerId: PeerId,
    relayServers: string[],
  ) {
    this.modules = modules;
    this.node = node;
    this.protocol = protocol;
    this.localPeerId = localPeerId;
    this.relayServers = relayServers;
  }

  /**
   * 创建 Provider（动态导入可选依赖 + 组装节点，但不启动）。
   * importer 参数用于测试注入（如模拟缺包）。
   */
  static async create(
    options: Libp2pProviderOptions,
    importer?: ModuleImporter,
  ): Promise<Libp2pProvider> {
    const modules = await loadLibp2pModules(importer);

    // WebCrypto PKCS8 → 32 字节种子 → libp2p Ed25519 私钥
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', options.deviceKey.privateKey));
    const privateKey = await modules.generateKeyPairFromSeed('Ed25519', pkcs8.slice(-32));

    // 中继为可选能力：仅在被请求时动态加载；缺包抛 NETWORK_RELAY_NOT_AVAILABLE
    const relayRequested = options.relayServer === true || (options.relayServers?.length ?? 0) > 0;
    const relayModules = relayRequested ? await loadRelayModules(importer) : null;

    const transports: unknown[] = [modules.tcp()];
    const services: Record<string, unknown> = {};
    const listen = [...(options.listen ?? ['/ip4/0.0.0.0/tcp/0'])];
    if (relayModules) {
      services['identify'] = relayModules.identify();
      if (options.relayServers?.length) {
        transports.push(relayModules.circuitRelayTransport());
        // circuit relay 通过 /p2p-circuit 监听地址请求预约；
        // 预约成功后 getMultiaddrs() 会包含 <relay>/p2p-circuit/p2p/<self>
        if (!listen.includes('/p2p-circuit')) {
          listen.push('/p2p-circuit');
        }
      }
      if (options.relayServer) {
        // 服务名须为 circuitRelay（与包内默认服务名一致）。
        // applyDefaultLimit:false → 预约不受限，允许在 circuit 上跑任意协议
        // （Mebular 同步流即在此之上）；v0.1 暂不做 relay 限额，属已知限制。
        services['circuitRelay'] = relayModules.circuitRelayServer({
          reservations: { maxReservations: 128, applyDefaultLimit: false },
        });
      }
    }

    const libp2pOptions: Record<string, unknown> = {
      privateKey,
      addresses: { listen },
      transports,
      connectionEncrypters: [modules.noise()],
      streamMuxers: [modules.yamux()],
    };
    if (Object.keys(services).length > 0) {
      libp2pOptions['services'] = services;
    }

    const node = await modules.createLibp2p(libp2pOptions);

    return new Libp2pProvider(
      modules,
      node,
      options.protocol ?? MEBULAR_PROTOCOL,
      peerIdFromDevicePublicKey(options.deviceKey.publicKey),
      options.relayServers ?? [],
    );
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new NetworkError('Libp2pProvider already running', ErrorCodes.NETWORK_ALREADY_RUNNING);
    }
    await this.node.handle(this.protocol, (stream, connection) => {
      const handler = this.incomingHandler;
      if (!handler) {
        // 尚未注册上层回调：拒绝而非悬挂
        void stream.close().catch(() => undefined);
        return;
      }
      try {
        const remotePeerId = fromLibp2pPeerId(connection.remotePeer);
        handler(new Libp2pConnection(stream, remotePeerId, connection.remoteAddr.toString()));
      } catch {
        void stream.close().catch(() => undefined);
      }
    });
    await this.node.start();
    this.running = true;

    // 向中继预约（best-effort）：拨号触发 circuit 预约，
    // 预约成功后 getMultiaddrs() 会包含 <relay>/p2p-circuit 地址。
    for (const relay of this.relayServers) {
      try {
        await this.node.dial(this.modules.multiaddr(relay));
      } catch {
        // 预约失败不阻塞启动：上层据 getMultiaddrs 是否含 /p2p-circuit 判断
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.node.stop();
  }

  async dial(peerId: PeerId, address?: string): Promise<Connection> {
    if (!this.running) {
      throw new NetworkError('Libp2pProvider not running', ErrorCodes.NETWORK_NOT_RUNNING);
    }
    const target = toLibp2pPeerId(peerId, this.modules);
    // 有显式 multiaddr 优先直连；否则按 peer id 拨号（依赖 peerStore/路由已知地址）
    const dialTarget = address ? this.modules.multiaddr(address) : target;
    const stream = await this.node.dialProtocol(dialTarget, this.protocol);
    return new Libp2pConnection(stream, peerId, address ?? `/p2p/${target.toString()}`);
  }

  onIncomingConnection(callback: (conn: Connection) => void): void {
    this.incomingHandler = callback;
  }

  /** 本机监听地址（含 /p2p/<id> 后缀），供上层发布到设备发现 */
  getMultiaddrs(): string[] {
    return this.node.getMultiaddrs().map((addr) => addr.toString());
  }

  /** 本机我方 PeerId（由设备公钥派生） */
  getLocalPeerId(): PeerId {
    return this.localPeerId;
  }

  /** 本机 libp2p peer id 字符串（日志/调试） */
  getLibp2pPeerIdString(): string {
    return this.node.peerId.toString();
  }

  isRunning(): boolean {
    return this.running;
  }
}

/** 便捷工厂：等价于 Libp2pProvider.create */
export async function createLibp2pProvider(
  options: Libp2pProviderOptions,
  importer?: ModuleImporter,
): Promise<Libp2pProvider> {
  return Libp2pProvider.create(options, importer);
}
