// 设备发现服务

import { PeerId, PeerInfo } from './index.js';
import { EventEmitter } from 'events';

export interface DiscoveryOptions {
  timeout?: number;
  interval?: number;
  maxPeers?: number;
}

export class DeviceDiscovery extends EventEmitter {
  private options: DiscoveryOptions;
  private running = false;
  private discoveredPeers: Map<string, PeerInfo> = new Map();
  private discoveryInterval: NodeJS.Timeout | null = null;

  constructor(options: DiscoveryOptions = {}) {
    super();
    this.options = {
      timeout: 30000,
      interval: 5000,
      maxPeers: 100,
      ...options,
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

    const peers = await this.findPeers();
    for (const peer of peers) {
      const key = peer.peerId.id;
      if (!this.discoveredPeers.has(key)) {
        this.discoveredPeers.set(key, peer);
        this.emit('peer-discovered', peer);
      }
    }

    if (this.discoveredPeers.size > this.options.maxPeers) {
      const peersToRemove = this.discoveredPeers.size - this.options.maxPeers;
      const entries = Array.from(this.discoveredPeers.entries());
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

  private async findPeers(): Promise<PeerInfo[]> {
    throw new Error('Not implemented');
  }

  getPeer(peerId: PeerId): PeerInfo | null {
    return this.discoveredPeers.get(peerId.id) || null;
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
