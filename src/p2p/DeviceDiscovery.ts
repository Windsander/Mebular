import { PeerId, PeerInfo } from './index.js';
import { EventEmitter } from 'events';

export interface DiscoveryOptions {
  timeout?: number;
  interval?: number;
  maxPeers?: number;
  serviceType?: string;
  serviceName?: string;
}

export interface BonjourService {
  name: string;
  type: string;
  port: number;
  txt: Record<string, string>;
  addresses?: string[];
}

export interface BonjourServiceInstance {
  publish(options: {
    name: string;
    type: string;
    port: number;
    txt?: Record<string, string>;
  }): void;
  destroy(): void;
  find(
    query: { type: string },
    callback: (service: BonjourService) => void,
  ): { stop: () => void };
}

export type BonjourServiceFactory = () => BonjourServiceInstance | null;

export interface DeviceDiscoveryOptions extends DiscoveryOptions {
  createBonjourService?: BonjourServiceFactory;
}

export class DeviceDiscovery extends EventEmitter {
  private readonly options: Required<DiscoveryOptions>;
  private running = false;
  private discoveredPeers = new Map<string, PeerInfo>();
  private discoveryInterval: NodeJS.Timeout | null = null;
  private bonjourService: BonjourServiceInstance | null = null;
  private bonjourBrowser: { stop: () => void } | null = null;
  private localPeerId: PeerId | null = null;
  private localPort: number = 0;
  private createBonjourService?: BonjourServiceFactory;

  constructor(options: DeviceDiscoveryOptions = {}) {
    super();
    this.options = {
      timeout: options.timeout ?? 30000,
      interval: options.interval ?? 5000,
      maxPeers: options.maxPeers ?? 100,
      serviceType: options.serviceType ?? '_mebular._tcp',
      serviceName: options.serviceName ?? 'mebular-device',
    };
    this.createBonjourService = options.createBonjourService;
  }

  setLocalInfo(peerId: PeerId, port: number): void {
    this.localPeerId = peerId;
    this.localPort = port;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Discovery already running');
    }

    if (!this.localPeerId) {
      throw new Error('Local peer ID not set. Call setLocalInfo() first.');
    }

    if (!this.bonjourService) {
      const factory = this.createBonjourService;
      if (factory) {
        const svc = factory();
        if (!svc) {
          throw new Error('Failed to create bonjour service');
        }
        this.bonjourService = svc;
      } else {
        throw new Error('Bonjour service factory not provided');
      }
    }

    const bonjourSvc = this.bonjourService;
    if (!bonjourSvc) {
      throw new Error('Failed to initialize bonjour service');
    }

    const serviceName =
      this.options.serviceName + '-' + this.localPeerId.id.slice(0, 8);

    bonjourSvc.publish({
      name: serviceName,
      type: this.options.serviceType,
      port: this.localPort,
      txt: {
        id: this.localPeerId.id,
        name: serviceName,
      },
    });

    const browser = bonjourSvc.find(
      { type: this.options.serviceType },
      (svc: BonjourService) => {
        this.handleDiscovery(svc);
      },
    );
    this.bonjourBrowser = browser;

    this.running = true;
    this.discoveryInterval = setInterval(() => {
      this.discoverPeers();
    }, this.options.interval);
  }

  async stop(): Promise<void> {
    if (!this.running) {
      throw new Error('Discovery not running');
    }

    const browser = this.bonjourBrowser;
    if (browser) {
      browser.stop();
      this.bonjourBrowser = null;
    }

    const bonjourSvc = this.bonjourService;
    if (bonjourSvc) {
      bonjourSvc.destroy();
      this.bonjourService = null;
    }

    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }

    this.discoveredPeers.clear();
    this.running = false;
  }

  private handleDiscovery(service: BonjourService): void {
    const peerId = service.txt?.id;
    if (!peerId) {
      return;
    }

    if (this.localPeerId?.id === peerId) {
      return;
    }

    if (this.discoveredPeers.has(peerId)) {
      const existing = this.discoveredPeers.get(peerId);
      if (existing) {
        existing.port = service.port;
        existing.name = service.name;
        existing.timestamp = Date.now();
      }
      return;
    }

    const peerInfo: PeerInfo = {
      peerId: {
        id: peerId,
        multihash: new TextEncoder().encode(peerId),
        pubKey: new TextEncoder().encode(peerId),
      },
      name: service.name,
      addresses: service.addresses ?? [],
      port: service.port,
      timestamp: Date.now(),
    };

    this.discoveredPeers.set(peerId, peerInfo);
    this.emit('peer-discovered', peerInfo);
  }

  private discoverPeers(): void {
    const now = Date.now();
    for (const [id, peer] of this.discoveredPeers.entries()) {
      if (now - peer.timestamp > this.options.timeout) {
        this.discoveredPeers.delete(id);
      }
    }

    const maxPeers = this.options.maxPeers;
    if (this.discoveredPeers.size > maxPeers) {
      const removeCount = this.discoveredPeers.size - maxPeers;
      const sorted = Array.from(this.discoveredPeers.entries()).sort(
        (a, b) => a[1].timestamp - b[1].timestamp,
      );

      for (let i = 0; i < removeCount; i++) {
        const entry = sorted[i];
        if (entry) {
          this.discoveredPeers.delete(entry[0]);
        }
      }
    }
  }

  getPeer(peerId: PeerId): PeerInfo | null {
    return this.discoveredPeers.get(peerId.id) ?? null;
  }

  getAllPeers(): PeerInfo[] {
    return Array.from(this.discoveredPeers.values());
  }

  removePeer(peerId: PeerId): boolean {
    const removed = this.discoveredPeers.delete(peerId.id);
    if (removed) {
      this.emit('peer-removed', peerId);
    }
    return removed;
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
