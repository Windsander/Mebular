// NAT 穿透服务

import { PeerId } from '../index.js';
import { EventEmitter } from 'events';

export interface NATTraversalOptions {
  timeout?: number;
  holePunchingTimeout?: number;
  maxRelays?: number;
  localInterfaces?: string[];
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
  private options: Required<NATTraversalOptions>;
  private running = false;
  private natType: NATType = 'unknown';
  private relayServers: RelayServer[] = [];
  private candidateAddresses: string[] = [];
  private holePunchingInProgress = false;
  
  constructor(options: NATTraversalOptions = {}) {
    super();
    this.options = {
      timeout: 30000,
      holePunchingTimeout: 10000,
      maxRelays: 3,
      localInterfaces: [],
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
  }

  async detectNATType(localPeerId: PeerId): Promise<NATType> {
    if (!this.running) {
      throw new Error('NATTraversal not running');
    }

    this.natType = 'unknown';

    try {
      const detected = await this.performDetection(localPeerId);
      this.natType = detected;
    } catch (error) {
      this.natType = 'unknown';
    }

    return this.natType;
  }

  private async performDetection(_localPeerId: PeerId): Promise<NATType> {
    // NAT 類型檢測模擬：嘗試連接回響應伺服器並檢測映射行為
    // 在實際部署中，這會連接到已知的 STUN/TURN 伺服器
    try {
      const mapping = await this.detectExternalMapping();
      if (mapping === null) {
        return 'unknown';
      }
      
      // 檢查是否為對稱型 NAT（建議使用 relay）
      const isSymmetric = await this.testSymmetry();
      
      if (isSymmetric) {
        return 'symmetric';
      }
      
      return 'restricted';
    } catch {
      return 'unknown';
    }
  }

  private async detectExternalMapping(): Promise<string | null> {
    // 模擬：返回一個代表映射位址的虛擬位址
    // 在實際部署中，這會使用 STUN 協議查詢 NAT 映射
    return '192.0.2.1';
  }

  private async testSymmetry(): Promise<boolean> {
    // 模擬：預設非對稱 NAT
    return false;
  }

  async startHolePunching(localPeerId: PeerId, remotePeerId: PeerId): Promise<void> {
    if (!this.running) {
      throw new Error('NATTraversal not running');
    }

    if (this.holePunchingInProgress) {
      throw new Error('Hole punching already in progress');
    }

    this.holePunchingInProgress = true;

    try {
      await this.performHolePunching(localPeerId, remotePeerId);
    } finally {
      this.holePunchingInProgress = false;
    }
  }

  private async performHolePunching(localPeerId: PeerId, remotePeerId: PeerId): Promise<void> {
    const timeout = this.options.holePunchingTimeout;
    const startTime = Date.now();
    let attempts = 0;
    const maxAttempts = 5;

    while (Date.now() - startTime < timeout && attempts < maxAttempts) {
      attempts++;
      
      // 嘗試向遠程對等節點的位址發送探測包
      const remoteCandidate = await this.getRemoteCandidate(remotePeerId);
      if (remoteCandidate) {
        await this.sendHolePunchProbe(localPeerId, remoteCandidate);
        
        // 短暫等待以檢查連接是否建立
        await this.delay(100);
        
        // 檢查連接狀態
        if (await this.checkConnectionEstablished(localPeerId, remotePeerId)) {
          return;
        }
      }
    }

    throw new Error('Hole punching timed out or failed');
  }

  private async getRemoteCandidate(remotePeerId: PeerId): Promise<string | null> {
    // 模擬：返回虛擬遠程候選位址
    return '192.0.2.2:5000';
  }

  private async sendHolePunchProbe(localPeerId: PeerId, remoteAddress: string): Promise<void> {
    // 模擬：發送穿墻探測包
    // 在實際部署中，這會通過 UDP 發送穿墻探測包到遠程位址
  }

  private async checkConnectionEstablished(_localPeerId: PeerId, _remotePeerId: PeerId): Promise<boolean> {
    // 模擬：預設連接未建立（在實際部署中會檢查套接字狀態）
    return false;
  }

  getCandidateAddresses(): string[] {
    return this.candidateAddresses;
  }

  reportCandidate(peerId: PeerId, address: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        if (!address || !address.includes(':')) {
          reject(new Error('Invalid address format'));
          return;
        }

        this.candidateAddresses.push(address);
        this.emit('candidate-received', { peerId, address });
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  addRelayServer(relay: RelayServer): void {
    if (this.relayServers.length < this.options.maxRelays) {
      this.relayServers.push(relay);
    }
  }

  getRelayServers(): RelayServer[] {
    return this.relayServers;
  }

  isRunning(): boolean {
    return this.running;
  }

  getNATType(): NATType {
    return this.natType;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
