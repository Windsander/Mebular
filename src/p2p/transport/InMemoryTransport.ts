// 传输抽象与内存传输实现
//
// ConnectionProvider 是 P2P 层与具体网络栈（未来的 libp2p、TCP、WebSocket 等）
// 之间的接缝：任何能提供「按 PeerId 拨号并拿到 Connection」的实现都可以接入。
// InMemoryHub 是同进程内的参考实现，用于本地联调与测试，让两个 P2PNode
// 可以真实地完成 发现 → 连接 → 认证 → 加密通信 的完整链路。

import type { Connection, ConnectionState, PeerId } from '../P2PNetwork.js';

/** 拨号抽象：由具体网络栈实现（libp2p 适配器、InMemoryHub 等） */
export interface ConnectionProvider {
  /** 按 PeerId（或已知地址）向对端发起连接 */
  dial(peerId: PeerId, address?: string): Promise<Connection>;
  /** 注册被动接入回调：当对端向本机拨号时触发 */
  onIncomingConnection(callback: (conn: Connection) => void): void;
}

/** 可由握手层回写认证状态的连接（传输实现可选支持） */
export interface MutableAuthenticationConnection extends Connection {
  markAuthenticated(): void;
}

/** 暴露最近活动时间的连接（供连接管理器做心跳超时判断） */
export interface ActivityTrackingConnection extends Connection {
  readonly lastActivityAt: number;
}

/**
 * 支持传输层探活的连接。
 * ping 只刷新双端活动时间，不产生任何应用层字节——
 * 字节流的帧格式归上层协议（如加密信道）所有。
 */
export interface PingCapableConnection extends Connection {
  ping(): Promise<void>;
}

/** 面向字节报文的阻塞队列：send 推入，receive 逐个取出，close 结束迭代 */
export class MessageQueue<T> {
  private items: T[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  private failure: Error | null = null;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }

  close(): void {
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  fail(error: Error): void {
    this.failure = error;
    this.close();
  }

  async *iterate(): AsyncIterable<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/**
 * 内存连接：实现完整的 Connection 接口。
 * authenticate() 默认只读认证标记；真正的认证由 AuthenticationHandshake
 * 在连接上完成挑战-应答后通过 markAuthenticated() 回写。
 */
export class InMemoryConnection implements Connection, MutableAuthenticationConnection, ActivityTrackingConnection, PingCapableConnection {
  readonly peerId: PeerId;
  readonly remoteAddress: string;
  private readonly localPeerId: PeerId;
  private readonly inbox = new MessageQueue<Uint8Array>();
  private peerInbox: MessageQueue<Uint8Array> | null = null;
  private peerActivityHook: (() => void) | null = null;
  private currentState: ConnectionState = 'connected';
  private authenticated = false;
  private activityAt = Date.now();
  private onPeerClose: (() => void) | null = null;

  constructor(localPeerId: PeerId, remotePeerId: PeerId, remoteAddress: string) {
    this.localPeerId = localPeerId;
    this.peerId = remotePeerId;
    this.remoteAddress = remoteAddress;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  get lastActivityAt(): number {
    return this.activityAt;
  }

  /** 由 Hub 调用：把一对连接的信箱互相接上 */
  link(peer: InMemoryConnection): void {
    this.peerInbox = peer.inbox;
    this.peerActivityHook = () => {
      peer.touchActivity();
    };
    this.onPeerClose = () => {
      if (this.currentState !== 'closed') {
        this.currentState = 'closed';
        this.inbox.close();
      }
    };
  }

  /** 刷新本端活动时间（ping 与数据收发都会调用） */
  touchActivity(): void {
    this.activityAt = Date.now();
  }

  /** 传输层探活：刷新双端活动时间，不注入任何字节 */
  async ping(): Promise<void> {
    if (this.currentState === 'closed') {
      throw new Error('Connection closed');
    }
    this.touchActivity();
    this.peerActivityHook?.();
  }

  /** 由 Hub 调用：投递一份报文到本端 */
  deliver(data: Uint8Array): void {
    this.activityAt = Date.now();
    this.inbox.push(data);
  }

  async send(data: Uint8Array): Promise<void> {
    if (this.currentState === 'closed') {
      throw new Error('Connection closed');
    }
    if (!this.peerInbox) {
      throw new Error('Connection not linked');
    }
    this.activityAt = Date.now();
    this.peerInbox.push(new Uint8Array(data));
  }

  receive(): AsyncIterable<Uint8Array> {
    return this.inbox.iterate();
  }

  async close(): Promise<void> {
    if (this.currentState === 'closed') return;
    this.currentState = 'closed';
    this.inbox.close();
    const notify = this.onPeerClose;
    this.onPeerClose = null;
    if (notify) notify();
  }

  markAuthenticated(): void {
    this.authenticated = true;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  async authenticate(): Promise<boolean> {
    // 认证协议由 AuthenticationHandshake 在连接上执行；
    // 这里只报告当前认证状态，避免伪造一条「自认证」路径。
    return this.authenticated;
  }

  getLocalPeerId(): PeerId {
    return this.localPeerId;
  }
}

interface RegisteredNode {
  peerId: PeerId;
  address: string;
  onIncoming: ((conn: InMemoryConnection) => void) | null;
}

/**
 * 内存 Hub：模拟一个可达的局域网/信令环境。
 * 节点注册后获得 memory:// 地址，其他节点可按 PeerId 拨号。
 */
export class InMemoryHub implements ConnectionProvider {
  private nodes = new Map<string, RegisteredNode>();
  private dialerPeerId: PeerId | null = null;
  private dialerIncoming: ((conn: Connection) => void) | null = null;

  /** 供 ConnectionManager 使用的 provider 形态：绑定本机身份并确保已注册 */
  forPeer(peerId: PeerId): ConnectionProvider {
    if (!this.nodes.has(peerId.id)) {
      this.register(peerId);
    }
    const hub = this;
    return {
      dial: (target, address) => hub.dialFrom(peerId, target, address),
      onIncomingConnection: (callback) => hub.setIncomingHandler(peerId, callback),
    };
  }

  /** ConnectionProvider 接口：使用 forPeer 之前需先 bindDialer，或直接走 dialFrom */
  async dial(peerId: PeerId, address?: string): Promise<Connection> {
    if (!this.dialerPeerId) {
      throw new Error('Dialer identity not bound. Use forPeer() or dialFrom().');
    }
    return this.dialFrom(this.dialerPeerId, peerId, address);
  }

  onIncomingConnection(callback: (conn: Connection) => void): void {
    this.dialerIncoming = callback;
  }

  /** 注册节点，返回其 memory:// 地址 */
  register(peerId: PeerId): string {
    const address = `memory://${peerId.id}`;
    this.nodes.set(peerId.id, { peerId, address, onIncoming: null });
    return address;
  }

  unregister(peerId: PeerId): void {
    this.nodes.delete(peerId.id);
  }

  setIncomingHandler(peerId: PeerId, callback: (conn: Connection) => void): void {
    const node = this.nodes.get(peerId.id);
    if (node) {
      node.onIncoming = callback as (conn: InMemoryConnection) => void;
    }
    this.dialerPeerId = peerId;
    this.dialerIncoming = callback;
  }

  /** 查询已注册节点地址 */
  resolve(peerId: PeerId): string | null {
    return this.nodes.get(peerId.id)?.address ?? null;
  }

  /** 主动拨号：建立一对连接，把对端那份交给对端的接入回调 */
  async dialFrom(fromPeerId: PeerId, target: PeerId, address?: string): Promise<Connection> {
    const targetNode = this.nodes.get(target.id)
      ?? (address ? this.nodes.get(address.replace(/^memory:\/\//, '')) : undefined);
    if (!targetNode) {
      throw new Error(`Peer not reachable: ${target.id}`);
    }

    const local = new InMemoryConnection(fromPeerId, targetNode.peerId, targetNode.address);
    const remote = new InMemoryConnection(targetNode.peerId, fromPeerId, `memory://${fromPeerId.id}`);
    local.link(remote);
    remote.link(local);

    const handler = targetNode.onIncoming;
    if (handler) {
      // 异步投递，模拟真实网络的接入时序
      setTimeout(() => handler(remote), 0);
    }

    return local;
  }

  /** 测试辅助：不走注册表，直接造一对互联连接 */
  createLinkedPair(a: PeerId, b: PeerId): [InMemoryConnection, InMemoryConnection] {
    const connA = new InMemoryConnection(a, b, `memory://${b.id}`);
    const connB = new InMemoryConnection(b, a, `memory://${a.id}`);
    connA.link(connB);
    connB.link(connA);
    return [connA, connB];
  }
}
