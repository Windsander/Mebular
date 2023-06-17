// 向量时钟接口 - 供 VectorClock 类实现

export interface VectorClockShape {
  clocks: Record<string, number>;
  increment(deviceId: string): void;
  merge(other: VectorClockShape): VectorClockShape;
  compare(other: VectorClockShape): 'less' | 'equal' | 'greater' | 'concurrent';
  lessThan(other: VectorClockShape): boolean;
  equals(other: VectorClockShape): boolean;
  greaterThan(other: VectorClockShape): boolean;
  isConcurrent(other: VectorClockShape): boolean;
  toJSON(): Record<string, number>;
}
