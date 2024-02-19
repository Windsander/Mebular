// NAT 穿透服务

import { PeerId } from '../index.js';
import { EventEmitter } from 'events';

export interface NATTraversalOptions {
  timeout?: number;
  holePunchingTimeout?: number;
  maxRelays?: number;
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
  private options: NATTraversalOptions;
  private running = false;
  private natType: NATType = 'unknown';
  private relayServers: RelayServer[] = [];

  constructor(options: NATTraversalOptions = {}) {
    super();
    this.options = {
      timeout: 30000,
      holePunchingTimeout: 10000,
      maxRelays: 3,
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

  private async performDetection(localPeerId: PeerId): Promise<NATType> {
    throw new Error('Not implemented');
  }

  async startHolePunching(localPeerId: PeerId, remotePeerId: PeerId): Promise<void> {
    if (!this.running) {
      throw new Error('NATTraversal not running');
    }

    throw new Error('Not implemented');
  }

  getCandidateAddresses(): string[] {
    throw new Error('Not implemented');
  }

  reportCandidate(peerId: PeerId, address: string): Promise<void> {
    throw new Error('Not implemented');
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
}
