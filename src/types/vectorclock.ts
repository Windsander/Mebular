// 向量时钟类型

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

export type VectorClockComparison = 'less' | 'equal' | 'greater' | 'concurrent';

export interface VectorClockFilter {
  deviceIds?: string[];
}
