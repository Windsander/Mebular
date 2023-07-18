// SyncManager 同步管理器

import type { StorageAdapter } from '../../storage/StorageAdapter.js';
import { VectorClock } from '../vectorclock/index.js';
import type { Event } from '../../types/event.js';

export interface SyncState {
  lastSyncedClock: VectorClock;
  pendingEvents: Event[];
  isSyncing: boolean;
}

export class SyncManager {
  private storage: StorageAdapter;
  private clock: VectorClock;
  private state: SyncState;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
    this.clock = new VectorClock();
    this.state = {
      lastSyncedClock: new VectorClock(),
      pendingEvents: [],
      isSyncing: false,
    };
  }

  getCurrentClock(): VectorClock {
    return this.clock;
  }

  getState(): SyncState {
    return {
      lastSyncedClock: this.state.lastSyncedClock,
      pendingEvents: [...this.state.pendingEvents],
      isSyncing: this.state.isSyncing,
    };
  }

  reset(): void {
    this.clock = new VectorClock();
    this.state.lastSyncedClock = new VectorClock();
    this.state.pendingEvents = [];
    this.state.isSyncing = false;
  }

  setSyncedClock(clock: VectorClock): void {
    this.state.lastSyncedClock = clock;
  }

  addPendingEvent(event: Event): void {
    this.state.pendingEvents.push(event);
  }

  getPendingEvents(): Event[] {
    return [...this.state.pendingEvents];
  }

  clearPendingEvents(): void {
    this.state.pendingEvents = [];
  }

  setSyncing(syncing: boolean): void {
    this.state.isSyncing = syncing;
  }

  async startSync(): Promise<void> {
    if (this.state.isSyncing) {
      return;
    }

    this.state.isSyncing = true;
    try {
      await this.sync();
    } finally {
      this.state.isSyncing = false;
    }
  }

  protected async sync(): Promise<void> {
    throw new Error('Not implemented: P2P network integration required');
  }
}
