// 连接管理器

import { PeerId, Connection } from '../index.js';
import type {
  ActivityTrackingConnection,
  ConnectionProvider,
  PingCapableConnection,
} from '../transport/InMemoryTransport.js';
import { EventEmitter } from 'events';
import { ErrorCodes, NetworkError } from '../../errors.js';
import { EndpointBook, type PathState } from './EndpointBook.js';

export interface ConnectionManagerOptions {
  maxConnections?: number;
  connectTimeout?: number;
  keepAliveInterval?: number;
  heartbeatTimeout?: number;
  /** C1：候选端点簿（缺省不启用 → 行为与历史一致：单地址拨号） */
  endpointBook?: EndpointBook;
  /** C1：全候选失败后的退避重试基数（ms，默认 1000）；0 = 不自动重试 */
  dialBackoffBaseMs?: number;
  /** C1：退避上限（ms，默认 30000） */
  dialBackoffMaxMs?: number;
}

export class ConnectionManager extends EventEmitter {
  private options: Required<Omit<ConnectionManagerOptions, 'endpointBook'>>;
  private running = false;
  private connections: Map<string, Connection> = new Map();
  private pendingConnections: Map<string, Connection> = new Map();
  private pendingDials: Map<string, Promise<Connection>> = new Map();
  private provider: ConnectionProvider | null = null;
  private endpointBook: EndpointBook | null;
  private backoffs: Map<string, { attempts: number; timer: NodeJS.Timeout | null; lastError?: string }> = new Map();
  private keepAliveInterval: NodeJS.Timeout | null = null;
  private heartbeatCheckInterval: NodeJS.Timeout | null = null;

  constructor(options: ConnectionManagerOptions = {}) {
    super();
    const defaults: Required<Omit<ConnectionManagerOptions, 'endpointBook'>> = {
      maxConnections: 100,
      connectTimeout: 30000,
      keepAliveInterval: 30000,
      heartbeatTimeout: 60000,
      // endpointBook 无默认值（undefined = 关闭），单独存放
      dialBackoffBaseMs: 1000,
      dialBackoffMaxMs: 30000,
    };
    // 显式传入的 undefined 不允许覆盖默认值
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) {
        (defaults as Record<string, unknown>)[key] = value;
      }
    }
    this.options = defaults;
    this.endpointBook = options.endpointBook ?? null;
  }

  /** C1：注入/替换候选端点簿（连接成功后学习入库、路径变化广播） */
  setEndpointBook(book: EndpointBook | null): void {
    this.endpointBook = book;
  }

  getEndpointBook(): EndpointBook | null {
    return this.endpointBook;
  }

  /** C1：当前生效路径（含 kind/address/since/lastError） */
  getPath(peerId: PeerId): PathState | null {
    return this.endpointBook?.getPath(peerId.id) ?? null;
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

    for (const state of this.backoffs.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.backoffs.clear();
    await this.closeAll();
  }

  async connect(peerId: PeerId, address?: string): Promise<Connection> {
    if (!this.running) {
      throw new NetworkError('ConnectionManager not running', ErrorCodes.NETWORK_NOT_RUNNING);
    }

    const existing = this.connections.get(peerId.id);
    if (existing && existing.state !== 'closed' && existing.state !== 'disconnecting') {
      return existing;
    }
    if (existing) {
      // 残留的死连接不得复用：先按关闭处理（触发上层清信道/会话），再拨新连接（F4）
      this.connections.delete(peerId.id);
      this.emit('connection-closed', existing.peerId);
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

    const dialPromise = this.dialWithCandidates(peerId, address);
    this.pendingDials.set(peerId.id, dialPromise);

    try {
      const connection = await dialPromise;
      this.setConnection(peerId, connection);
      this.clearBackoff(peerId.id);
      return connection;
    } finally {
      this.pendingDials.delete(peerId.id);
    }
  }

  /**
   * C1：按候选顺序拨号。无端点簿时退化为历史单地址拨号（零行为变化）；
   * 有端点簿时：显式地址优先 → 簿内候选（direct > lan > relay）逐个尝试，
   * 成功记录路径与成功统计，失败记录错误并尝试下一候选；全失败安排指数退避重试。
   */
  private async dialWithCandidates(peerId: PeerId, address?: string): Promise<Connection> {
    const book = this.endpointBook;
    if (!book) {
      return this.dialWithTimeout(peerId, address);
    }
    const candidates = this.candidateAddresses(peerId.id, address);
    if (candidates.length === 0) {
      // 簿内没有可用候选：沿用历史行为（由 provider/发现层决定）
      return this.dialWithTimeout(peerId, address);
    }

    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        const connection = await this.dialWithTimeout(peerId, candidate);
        book.recordSuccess(peerId.id, candidate);
        book.setPath(peerId.id, candidate);
        return connection;
      } catch (error) {
        lastError = error;
        book.recordFailure(peerId.id, candidate, error);
        book.setPath(peerId.id, candidate, error);
      }
    }
    this.scheduleBackoff(peerId);
    throw lastError instanceof Error
      ? lastError
      : new NetworkError(`All candidates failed for peer ${peerId.id}`, ErrorCodes.NETWORK_DIAL_FAILED);
  }

  /** 拨号候选顺序：显式地址（来自调用方/配对）在前，其后簿内候选（去重）。 */
  private candidateAddresses(peerId: string, address?: string): string[] {
    const fromBook = this.endpointBook?.addresses(peerId) ?? [];
    const ordered = address ? [address, ...fromBook] : [...fromBook];
    return [...new Set(ordered.filter((entry) => typeof entry === 'string' && entry.length > 0))];
  }

  /** 全失败后的指数退避（timer 不拖住宿主退出；重复调用只保留一个 timer）。 */
  private scheduleBackoff(peerId: PeerId): void {
    const base = this.options.dialBackoffBaseMs;
    if (!base || base <= 0) return;
    const current = this.backoffs.get(peerId.id);
    const attempts = (current?.attempts ?? 0) + 1;
    if (current?.timer) clearTimeout(current.timer);
    const delay = Math.min(base * 2 ** (attempts - 1), this.options.dialBackoffMaxMs);
    const timer = setTimeout(() => {
      const state = this.backoffs.get(peerId.id);
      if (state) state.timer = null;
      if (!this.running) return;
      this.connect(peerId).catch(() => undefined);
    }, delay);
    timer.unref();
    this.backoffs.set(peerId.id, { attempts, timer, lastError: current?.lastError });
    this.emit('dial-retry-scheduled', { peerId, attempts, delay });
  }

  private clearBackoff(peerId: string): void {
    const state = this.backoffs.get(peerId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.backoffs.delete(peerId);
  }

  /** 退避状态（诊断/测试用） */
  getBackoff(peerId: PeerId): { attempts: number; pending: boolean } | null {
    const state = this.backoffs.get(peerId.id);
    if (!state) return null;
    return { attempts: state.attempts, pending: state.timer !== null };
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
    this.endpointBook?.clearPath(peerId.id);
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
    // C1：学习成功地址（remoteAddress 形如 multiaddr 时才入库）
    const remote = connection.remoteAddress;
    if (this.endpointBook && typeof remote === 'string' && remote.includes('/')) {
      void this.endpointBook.upsert(peerId.id, [remote], 'learned').catch(() => undefined);
      this.endpointBook.setPath(peerId.id, remote);
    }
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
    const promises = Array.from(this.connections.entries()).map(async ([peerId, conn]) => {
      if (conn && conn.isAuthenticated()) {
        const pingable = conn as Partial<PingCapableConnection>;
        if (typeof pingable.ping === 'function') {
          try {
            await pingable.ping();
          } catch {
            // ping 探活失败即连接已死：收割并广播（Phase 6.1 修复，原为静默吞掉）
            this.reap(peerId, conn);
          }
        }
      }
    });

    await Promise.all(promises);
  }

  /** 从连接表收割死连接：尽力关闭并广播超时/关闭事件；幂等（重复收割无副作用） */
  private reap(peerId: string, conn: Connection): void {
    // 表中已换成新连接（重连）时，旧连接的迟到 ping 失败不得误删新连接（F4）
    if (this.connections.get(peerId) !== conn) {
      conn.close().catch(() => undefined);
      return;
    }
    this.connections.delete(peerId);
    this.endpointBook?.clearPath(peerId);
    conn.close().catch(() => undefined);
    this.emit('connection-timeout', conn.peerId);
    this.emit('connection-closed', conn.peerId);
  }

  private checkHeartbeatTimeout(): void {
    if (!this.running) {
      return;
    }

    const now = Date.now();
    for (const [peerId, conn] of this.connections.entries()) {
      // 已关闭/关闭中的连接无论能否观测活动都直接收割（Phase 6.1 修复）
      if (conn.state === 'closed' || conn.state === 'disconnecting') {
        this.reap(peerId, conn);
        continue;
      }
      // 只对暴露活动时间的连接做静默超时判断；无法观测的开放连接保持原状
      //（残余限制：此类连接的探活依赖 ping 失败收割路径，见上 sendHeartbeat）
      const tracked = conn as Partial<ActivityTrackingConnection>;
      const lastActivity = typeof tracked.lastActivityAt === 'number' ? tracked.lastActivityAt : null;
      if (lastActivity === null) {
        continue;
      }
      if (now - lastActivity > this.options.heartbeatTimeout) {
        this.reap(peerId, conn);
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
