// 连接管理器

import { PeerId, Connection } from '../index.js';
import type {
  ActivityTrackingConnection,
  ConnectionProvider,
  PingCapableConnection,
} from '../transport/InMemoryTransport.js';
import { EventEmitter } from 'events';
import { ErrorCodes, NetworkError } from '../../errors.js';

export interface ConnectionManagerOptions {
  maxConnections?: number;
  connectTimeout?: number;
  keepAliveInterval?: number;
  heartbeatTimeout?: number;
}

export class ConnectionManager extends EventEmitter {
  private options: Required<ConnectionManagerOptions>;
  private running = false;
  private connections: Map<string, Connection> = new Map();
  private pendingConnections: Map<string, Connection> = new Map();
  private pendingDials: Map<string, Promise<Connection>> = new Map();
  private provider: ConnectionProvider | null = null;
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private heartbeatCheckInterval: NodeJS.Timeout | null = null;

  constructor(options: ConnectionManagerOptions = {}) {
    super();
    const defaults: Required<ConnectionManagerOptions> = {
      maxConnections: 100,
      connectTimeout: 30000,
      keepAliveInterval: 30000,
      heartbeatTimeout: 60000,
    };
    // 显式传入的 undefined 不允许覆盖默认值
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) {
        (defaults as Record<string, unknown>)[key] = value;
      }
    }
    this.options = defaults;
  }

  /** 注入拨号抽象（libp2p 适配器、内存 Hub 等） */
  setConnectionProvider(provider: ConnectionProvider): void {
    this.provider = provider;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new NetworkError('ConnectionManager already running', ErrorCodes.NETWORK_ALREADY_RUNNING);
    }
    this.running = true;

    this.keepAliveInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.options.keepAliveInterval);
    // 库不应凭心跳计时器拖住宿主进程退出
    this.keepAliveInterval.unref();

    this.heartbeatCheckInterval = setInterval(() => {
      this.checkHeartbeatTimeout();
    }, this.options.heartbeatTimeout);
    this.heartbeatCheckInterval.unref();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      throw new NetworkError('ConnectionManager not running', ErrorCodes.NETWORK_NOT_RUNNING);
    }

    this.running = false;

    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }

    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval);
      this.heartbeatCheckInterval = null;
    }

    await this.closeAll();
  }

  async connect(peerId: PeerId, address?: string): Promise<Connection> {
    if (!this.running) {
      throw new NetworkError('ConnectionManager not running', ErrorCodes.NETWORK_NOT_RUNNING);
    }

    const existing = this.connections.get(peerId.id);
    if (existing) {
      return existing;
    }

    const pending = this.pendingConnections.get(peerId.id);
    if (pending) {
      return pending;
    }

    // 并发拨同一对端时共享同一个拨号 Promise，避免重复连接
    const inFlight = this.pendingDials.get(peerId.id);
    if (inFlight) {
      return inFlight;
    }

    if (this.connections.size >= this.options.maxConnections) {
      throw new NetworkError('Max connections reached', ErrorCodes.NETWORK_MAX_CONNECTIONS);
    }

    if (!this.provider) {
      throw new NetworkError('Connection provider not set. Call setConnectionProvider() first.', ErrorCodes.NETWORK_PROVIDER_NOT_SET);
    }

    const dialPromise = this.dialWithTimeout(peerId, address);
    this.pendingDials.set(peerId.id, dialPromise);

    try {
      const connection = await dialPromise;
      this.setConnection(peerId, connection);
      return connection;
    } finally {
      this.pendingDials.delete(peerId.id);
    }
  }

  private async dialWithTimeout(peerId: PeerId, address?: string): Promise<Connection> {
    const provider = this.provider;
    if (!provider) {
      throw new NetworkError('Connection provider not set', ErrorCodes.NETWORK_PROVIDER_NOT_SET);
    }

    return new Promise<Connection>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Connect to peer ${peerId.id} timed out`));
      }, this.options.connectTimeout);

      provider.dial(peerId, address).then(
        (connection) => {
          clearTimeout(timer);
          resolve(connection);
        },
        (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async disconnect(peerId: PeerId): Promise<void> {
    if (!this.running) {
      throw new NetworkError('ConnectionManager not running', ErrorCodes.NETWORK_NOT_RUNNING);
    }

    const connection = this.connections.get(peerId.id);
    if (!connection) {
      const pending = this.pendingConnections.get(peerId.id);
      if (pending) {
        this.pendingConnections.delete(peerId.id);
        // 挂起连接也要真正关闭，只删表会泄漏底层资源
        await pending.close().catch(() => undefined);
      }
      return;
    }

    try {
      await connection.close();
    } catch (error) {
      // ignore close errors
    }

    this.connections.delete(peerId.id);
    this.emit('connection-closed', peerId);
  }

  getConnection(peerId: PeerId): Connection | null {
    return this.connections.get(peerId.id) ?? null;
  }

  getPendingConnection(peerId: PeerId): Connection | null {
    return this.pendingConnections.get(peerId.id) ?? null;
  }

  getConnections(): Connection[] {
    return Array.from(this.connections.values());
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getPendingConnectionCount(): number {
    return this.pendingConnections.size;
  }

  setConnection(peerId: PeerId, connection: Connection): void {
    this.connections.set(peerId.id, connection);
    this.emit('connection-opened', connection);
  }

  setPendingConnection(peerId: PeerId, connection: Connection): void {
    this.pendingConnections.set(peerId.id, connection);
  }

  removePendingConnection(peerId: PeerId): Connection | undefined {
    const connection = this.pendingConnections.get(peerId.id);
    if (connection) {
      this.pendingConnections.delete(peerId.id);
    }
    return connection;
  }

  movePendingToConnected(peerId: PeerId): Connection | undefined {
    const pending = this.pendingConnections.get(peerId.id);
    if (!pending) {
      return undefined;
    }

    this.pendingConnections.delete(peerId.id);
    this.connections.set(peerId.id, pending);
    this.emit('connection-opened', pending);

    return pending;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.running) {
      return;
    }

    // 心跳只通过连接自带的 ping() 探活；绝不向字节流注入原始字节——
    // 上层协议（如加密信道）对帧格式有所有权，裸字节会破坏其帧边界。
    const promises = Array.from(this.connections.values()).map((conn) => {
      if (conn && conn.isAuthenticated()) {
        const pingable = conn as Partial<PingCapableConnection>;
        if (typeof pingable.ping === 'function') {
          return pingable.ping()!.catch(() => undefined);
        }
      }
      return Promise.resolve();
    });

    await Promise.all(promises);
  }

  private checkHeartbeatTimeout(): void {
    if (!this.running) {
      return;
    }

    const now = Date.now();
    for (const [peerId, conn] of this.connections.entries()) {
      // 只对暴露活动时间的连接做超时判断；无法观测的连接保持原状
      const tracked = conn as Partial<ActivityTrackingConnection>;
      const lastActivity = typeof tracked.lastActivityAt === 'number' ? tracked.lastActivityAt : null;
      if (lastActivity === null) {
        continue;
      }
      if (now - lastActivity > this.options.heartbeatTimeout) {
        this.connections.delete(peerId);
        conn.close().catch(() => undefined);
        this.emit('connection-timeout', conn.peerId);
        this.emit('connection-closed', conn.peerId);
      }
    }
  }

  async closeAll(): Promise<void> {
    const promises = Array.from(this.connections.entries()).map(([, conn]) => {
      try {
        return conn.close();
      } catch (error) {
        return Promise.resolve();
      }
    });

    await Promise.all(promises);
    this.connections.clear();
  }
}
