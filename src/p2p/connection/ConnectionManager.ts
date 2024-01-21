// 连接管理器

import { PeerId, Connection, ConnectionState } from '../index.js';
import { EventEmitter } from 'events';

export interface ConnectionManagerOptions {
  maxConnections?: number;
  connectTimeout?: number;
  keepAliveInterval?: number;
}

export class ConnectionManager extends EventEmitter {
  private options: ConnectionManagerOptions;
  private running = false;
  private connections: Map<string, Connection> = new Map();
  private keepAliveInterval: NodeJS.Timeout | null = null;

  constructor(options: ConnectionManagerOptions = {}) {
    super();
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('ConnectionManager already running');
    }
    this.running = true;

    this.keepAliveInterval = setInterval(() => {
      this.sendKeepAlive();
    }, this.options.keepAliveInterval ?? 30000);
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

    if (this.connections.size >= (this.options.maxConnections ?? 100)) {
      throw new Error('Max connections reached');
    }

    throw new Error('Not implemented');
  }

  getConnection(peerId: PeerId): Connection | null {
    return this.connections.get(peerId.id) ?? null;
  }

  getConnections(): Connection[] {
    return Array.from(this.connections.values());
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  disconnect(peerId: PeerId): Promise<void> {
    throw new Error('Not implemented');
  }

  async closeAll(): Promise<void> {
    const promises = Array.from(this.connections.values()).map(conn => conn.close());
    await Promise.all(promises);
    this.connections.clear();
  }

  setConnection(peerId: PeerId, connection: Connection): void {
    this.connections.set(peerId.id, connection);
    this.emit('connection-opened', connection);
  }

  removeConnection(peerId: PeerId): Connection | undefined {
    const connection = this.connections.get(peerId.id);
    if (connection) {
      this.connections.delete(peerId.id);
      this.emit('connection-closed', peerId);
    }
    return connection;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async sendKeepAlive(): Promise<void> {
    if (!this.running) {
      return;
    }

    const promises = Array.from(this.connections.values()).map(conn => {
      if (conn && conn.isAuthenticated()) {
        return conn.send(new Uint8Array([0]));
      }
      return Promise.resolve();
    });

    await Promise.all(promises);
  }
}
