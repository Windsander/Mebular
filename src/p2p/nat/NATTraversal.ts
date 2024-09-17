// NAT 穿透服务
//
// 策略按 spec-005 的优先级落地：
//   1. 直接连接：本机持有公网地址，或对端候选地址可达；
//   2. 打洞：通过信令通道交换候选地址后并发尝试拨号；
//   3. 中继：打洞失败时回退到已配置的中继服务器。
//
// 外部探测（STUN 类）与信令交换都是可注入接口——真实部署接入 STUN/TURN
// 与信令服务，测试与本地环境使用内存实现，保证行为可验证、可复现。

import os from 'os';
import { EventEmitter } from 'events';
import type { PeerId } from '../P2PNetwork.js';

export interface NATTraversalOptions {
  timeout?: number;
  holePunchingTimeout?: number;
  maxRelays?: number;
  localInterfaces?: string[];
  /** 外部映射探测（STUN 类服务抽象）；缺省时只能给出保守结论 */
  prober?: NatProber;
  /** 打洞所需的信令与拨号通道 */
  channel?: HolePunchChannel;
  /** 本机监听端口，用于组装候选地址 */
  localPort?: number;
}

/** 外部映射探测抽象：一次 STUN 绑定请求能回答什么 */
export interface NatProber {
  /** 查询 NAT 为本机端口分配的外部映射地址；无服务可用时返回 null */
  getExternalMapping(localPort: number): Promise<{ address: string; port: number } | null>;
  /**
   * 映射一致性：向两个不同目的探测，外部端口是否一致。
   * consistent → 端点无关映射（可打洞）；inconsistent → 对称型 NAT。
   */
  testMappingConsistency(localPort: number): Promise<'consistent' | 'inconsistent' | 'unknown'>;
}

/** 打洞信令抽象：与对端交换候选地址并尝试拨号 */
export interface HolePunchChannel {
  /** 把本端候选地址发给对端，取回对端候选地址 */
  exchangeCandidates(remotePeerId: PeerId, localCandidates: string[]): Promise<string[]>;
  /** 尝试向某个候选地址拨号，返回是否打通 */
  dial(address: string, timeoutMs: number): Promise<boolean>;
}

export type NATType =
  | 'open'
  | 'restricted'
  | 'port-restricted'
  | 'symmetric'
  | 'unknown';

export interface RelayServer {
  address: string;
  port: number;
}

export class NATTraversal extends EventEmitter {
  private options: Required<Omit<NATTraversalOptions, 'prober' | 'channel'>> & {
    prober?: NatProber;
    channel?: HolePunchChannel;
  };
  private running = false;
  private natType: NATType = 'unknown';
  private relayServers: RelayServer[] = [];
  private candidateAddresses: string[] = [];
  private holePunchingInProgress = false;
  private establishedRoute: string | null = null;

  constructor(options: NATTraversalOptions = {}) {
    super();
    this.options = {
      timeout: 30000,
      holePunchingTimeout: 10000,
      maxRelays: 3,
      localInterfaces: [],
      localPort: 0,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('NATTraversal already running');
    }
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      throw new Error('NATTraversal not running');
    }
    this.running = false;
    this.establishedRoute = null;
  }

  // ---------- NAT 类型检测 ----------

  async detectNATType(_localPeerId: PeerId): Promise<NATType> {
    if (!this.running) {
      throw new Error('NATTraversal not running');
    }

    try {
      this.natType = await this.performDetection();
    } catch {
      this.natType = 'unknown';
    }

    this.emit('nat-type-detected', this.natType);
    return this.natType;
  }

  private async performDetection(): Promise<NATType> {
    // 本机直接持有公网地址 → 无 NAT 或全锥形开放环境
    const localAddresses = this.getLocalAddresses();
    if (localAddresses.some((addr) => isPublicIPv4(addr))) {
      return 'open';
    }

    // 没有探测服务时保持诚实的 unknown，而不是猜测
    const prober = this.options.prober;
    if (!prober) {
      return 'unknown';
    }

    const mapping = await prober.getExternalMapping(this.options.localPort);
    if (!mapping) {
      return 'unknown';
    }

    const consistency = await prober.testMappingConsistency(this.options.localPort);
    if (consistency === 'inconsistent') {
      return 'symmetric';
    }
    if (consistency === 'consistent') {
      return 'restricted';
    }
    return 'unknown';
  }

  // ---------- 候选地址收集 ----------

  /** 收集本机候选地址：真实网卡地址 + （如有）外部映射 */
  async gatherCandidates(localPort?: number): Promise<string[]> {
    const port = localPort ?? this.options.localPort;
    const candidates: string[] = [];

    for (const addr of this.getLocalAddresses()) {
      candidates.push(`${addr}:${port}`);
    }

    const prober = this.options.prober;
    if (prober) {
      try {
        const mapping = await prober.getExternalMapping(port);
        if (mapping) {
          candidates.push(`${mapping.address}:${mapping.port}`);
        }
      } catch {
        // 探测失败不阻塞本地候选
      }
    }

    // 去重并保持顺序
    this.candidateAddresses = [...new Set(candidates)];
    return this.candidateAddresses;
  }

  private getLocalAddresses(): string[] {
    const addresses: string[] = [];
    const interfaces = os.networkInterfaces();
    for (const [name, infos] of Object.entries(interfaces)) {
      if (!infos) continue;
      if (this.options.localInterfaces.length > 0 && !this.options.localInterfaces.includes(name)) {
        continue;
      }
      for (const info of infos) {
        if (info.family !== 'IPv4' || info.internal) continue;
        addresses.push(info.address);
      }
    }
    return addresses;
  }

  // ---------- 打洞 ----------

  async startHolePunching(localPeerId: PeerId, remotePeerId: PeerId): Promise<string> {
    if (!this.running) {
      throw new Error('NATTraversal not running');
    }
    if (this.holePunchingInProgress) {
      throw new Error('Hole punching already in progress');
    }
    const channel = this.options.channel;
    if (!channel) {
      throw new Error('Hole punch channel not configured');
    }

    this.holePunchingInProgress = true;
    try {
      const route = await this.performHolePunching(remotePeerId, channel);
      this.establishedRoute = route;
      this.emit('hole-punched', { localPeerId, remotePeerId, route });
      return route;
    } finally {
      this.holePunchingInProgress = false;
    }
  }

  private async performHolePunching(
    remotePeerId: PeerId,
    channel: HolePunchChannel,
  ): Promise<string> {
    const deadline = Date.now() + this.options.holePunchingTimeout;

    const localCandidates = await this.gatherCandidates();
    const remoteCandidates = await channel.exchangeCandidates(remotePeerId, localCandidates);

    for (const address of remoteCandidates) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      const ok = await channel.dial(address, Math.min(remaining, 1000));
      if (ok) {
        return address;
      }
    }

    throw new Error('Hole punching timed out or failed');
  }

  /** 打洞成功后建立的直达路由 */
  getEstablishedRoute(): string | null {
    return this.establishedRoute;
  }

  // ---------- 中继 ----------

  addRelayServer(relay: RelayServer): void {
    if (this.relayServers.length < this.options.maxRelays) {
      this.relayServers.push(relay);
    }
  }

  getRelayServers(): RelayServer[] {
    return this.relayServers;
  }

  /** 选择中继：对称型 NAT 或打洞失败时的回退路径 */
  selectRelay(): RelayServer | null {
    return this.relayServers[0] ?? null;
  }

  // ---------- 查询 ----------

  getCandidateAddresses(): string[] {
    return this.candidateAddresses;
  }

  reportCandidate(peerId: PeerId, address: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!address || !address.includes(':')) {
        reject(new Error('Invalid address format'));
        return;
      }
      if (!this.candidateAddresses.includes(address)) {
        this.candidateAddresses.push(address);
      }
      this.emit('candidate-received', { peerId, address });
      resolve();
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  getNATType(): NATType {
    return this.natType;
  }
}

/** 判断是否为公网 IPv4（排除私网、环回、链路本地与 CGNAT 段） */
export function isPublicIPv4(address: string): boolean {
  const parts = address.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return false;                        // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
  if (a === 192 && b === 168) return false;          // 192.168.0.0/16
  if (a === 127) return false;                       // 127.0.0.0/8
  if (a === 169 && b === 254) return false;          // 169.254.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 (CGNAT)
  return true;
}
