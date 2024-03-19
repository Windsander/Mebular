// 设备发现服务

import { PeerId, PeerInfo } from './index.js';
import { EventEmitter } from 'events';

export interface DiscoveryOptions {
  timeout?: number;
  interval?: number;
  maxPeers?: number;
}

export class DeviceDiscovery extends EventEmitter {
  private options: Required<DiscoveryOptions>;
  private running = false;
  private discoveredPeers: Map<string, PeerInfo> = new Map();
  private discoveryInterval: NodeJS.Timeout | null = null;

  constructor(options: DiscoveryOptions = {}) {
    super();
    this.options = {
      timeout: options.timeout ?? 30000,
      interval: options.interval ?? 5000,
      maxPeers: options.maxPeers ?? 100,
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Discovery already running');
    }
    this.running = true;

    this.discoveryInterval = setInterval(() => {
      this.discoverPeers();
    }, this.options.interval);
  }

  async stop(): Promise<void> {
    if (!this.running) {
      throw new Error('Discovery not running');
    }
    this.running = false;

    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }
  }

  private async discoverPeers(): Promise<void> {
    if (!this.running) {
      return;
    }

    const maxPeers = this.options.maxPeers;
    if (this.discoveredPeers.size > maxPeers) {
      const peersToRemove = this.discoveredPeers.size - maxPeers;
      const entries = Array.from(this.discoveredPeers.entries());
      if (entries.length > 0) {
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

        for (let i = 0; i < peersToRemove; i++) {
          const entry = entries[i];
          if (entry !== undefined) {
            const key = entry[0];
            if (key !== undefined) {
              this.discoveredPeers.delete(key);
            }
          }
        }
      }
    }
  }

  private async findPeers(): Promise<PeerInfo[]> {
    throw new Error('Not implemented');
  }

  getPeer(peerId: PeerId): PeerInfo | null {
    return this.discoveredPeers.get(peerId.id) ?? null;
  }

  getAllPeers(): PeerInfo[] {
    return Array.from(this.discoveredPeers.values());
  }

  removePeer(peerId: PeerId): boolean {
    return this.discoveredPeers.delete(peerId.id);
  }

  isRunning(): boolean {
    return this.running;
  }

  getDiscoveredPeerCount(): number {
    return this.discoveredPeers.size;
  }

  clearDiscoveredPeers(): void {
    this.discoveredPeers.clear();
  }

  onPeerDiscovered(callback: (peer: PeerInfo) => void): void {
    this.on('peer-discovered', callback);
  }

  offPeerDiscovered(callback: (peer: PeerInfo) => void): void {
    this.off('peer-discovered', callback);
  }
}
