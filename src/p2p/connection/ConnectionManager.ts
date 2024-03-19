// 连接管理器

import { PeerId, Connection, ConnectionState } from '../index.js';
import { EventEmitter } from 'events';

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
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private heartbeatCheckInterval: NodeJS.Timeout | null = null;

  constructor(options: ConnectionManagerOptions = {}) {
    super();
    this.options = {
      maxConnections: 100,
      connectTimeout: 30000,
      keepAliveInterval: 30000,
      heartbeatTimeout: 60000,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('ConnectionManager already running');
    }
    this.running = true;

    this.keepAliveInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.options.keepAliveInterval);

    this.heartbeatCheckInterval = setInterval(() => {
      this.checkHeartbeatTimeout();
    }, this.options.heartbeatTimeout);
  }

  async stop(): Promise<void> {
    if (!this.running) {
      throw new Error('ConnectionManager not running');
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

  async connect(peerId: PeerId): Promise<Connection> {
    if (!this.running) {
      throw new Error('ConnectionManager not running');
    }

    const existing = this.connections.get(peerId.id);
    if (existing) {
      return existing;
    }

    const pending = this.pendingConnections.get(peerId.id);
    if (pending) {
      return pending;
    }

    if (this.connections.size >= this.options.maxConnections) {
      throw new Error('Max connections reached');
    }

    throw new Error('Not implemented');
  }

  async disconnect(peerId: PeerId): Promise<void> {
    if (!this.running) {
      throw new Error('ConnectionManager not running');
    }

    const connection = this.connections.get(peerId.id);
    if (!connection) {
      const pending = this.pendingConnections.get(peerId.id);
      if (pending) {
        this.pendingConnections.delete(peerId.id);
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

    const promises = Array.from(this.connections.entries()).map(([peerId, conn]) => {
      if (conn && conn.isAuthenticated()) {
        try {
          return conn.send(new Uint8Array([0]));
        } catch (error) {
          return Promise.resolve();
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
      // 在實際實作中，這裡會檢查最後一次心跳時間
      // 如果超過 heartbeatTimeout，就斷開連接
    }
  }

  async closeAll(): Promise<void> {
    const promises = Array.from(this.connections.entries()).map(([peerId, conn]) => {
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
