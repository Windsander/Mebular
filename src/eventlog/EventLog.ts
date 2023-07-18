// 事件日志类

import type { Event, EventFilter, EventType } from '../types/event.js';
import { VectorClock } from '../sync/vectorclock/index.js';
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import { ulid } from 'ulid';

export type { Event, EventFilter, EventData, EventType };

export class EventLog {
  private storage: StorageAdapter;
  private clock: VectorClock;
  private deviceId: string;

  constructor(storage: StorageAdapter, deviceId: string, initialClock?: Record<string, number>) {
    this.storage = storage;
    this.deviceId = deviceId;
    this.clock = new VectorClock(initialClock);
  }

  async append(event: Omit<Event, 'id' | 'timestamp' | 'vectorClock' | 'author' | 'signature'>): Promise<Event> {
    const timestamp = Date.now();
    this.clock.increment(this.deviceId);

    const fullEvent: Event = {
      id: ulid(),
      ...event,
      timestamp,
      vectorClock: this.clock.toJSON(),
      author: this.deviceId,
      signature: '',
    };

    await this.storage.putEvent(fullEvent);
    return fullEvent;
  }

  async getEvent(id: string): Promise<Event | null> {
    return this.storage.getEvent(id);
  }

  async listEvents(filter?: EventFilter): Promise<Event[]> {
    return this.storage.listEvents(filter);
  }

  async deleteEvent(id: string): Promise<void> {
    await this.storage.deleteEvent(id);
  }

  getClock(): VectorClock {
    return this.clock;
  }

  getDeviceId(): string {
    return this.deviceId;
  }
}
