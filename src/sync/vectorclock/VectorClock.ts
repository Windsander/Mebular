// 向量时钟实现

import type { VectorClockShape } from '../../types/vectorclock.js';

export class VectorClock implements VectorClockShape {
  clocks: Record<string, number> = {};

  constructor(initialClocks?: Record<string, number>) {
    if (initialClocks) {
      this.clocks = { ...initialClocks };
    }
  }

  increment(deviceId: string): void {
    this.clocks[deviceId] = (this.clocks[deviceId] || 0) + 1;
  }

  merge(other: VectorClockShape): this {
    for (const [id, value] of Object.entries(other.clocks)) {
      const current = this.clocks[id] ?? 0;
      if (value > current) {
        this.clocks[id] = value;
      }
    }
    return this;
  }

  compare(other: VectorClockShape): 'less' | 'equal' | 'greater' | 'concurrent' {
    const allKeys = new Set([
      ...Object.keys(this.clocks),
      ...Object.keys(other.clocks),
    ]);

    let allLess = false;
    let allGreater = false;

    for (const key of allKeys) {
      const a = this.clocks[key] ?? 0;
      const b = other.clocks[key] ?? 0;

      if (a < b) allLess = true;
      if (a > b) allGreater = true;
    }

    if (allLess && allGreater) return 'concurrent';
    if (allLess) return 'less';
    if (allGreater) return 'greater';
    return 'equal';
  }

  lessThan(other: VectorClockShape): boolean {
    return this.compare(other) === 'less';
  }

  equals(other: VectorClockShape): boolean {
    return this.compare(other) === 'equal';
  }

  greaterThan(other: VectorClockShape): boolean {
    return this.compare(other) === 'greater';
  }

  isConcurrent(other: VectorClockShape): boolean {
    return this.compare(other) === 'concurrent';
  }

  toJSON(): Record<string, number> {
    return { ...this.clocks };
  }

  static fromJSON(data: Record<string, number>): VectorClock {
    const instance = new VectorClock();
    instance.clocks = { ...data };
    return instance;
  }
}
