// 配置类型

export interface Config {
  vectorClock?: VectorClockConfig;
  storage?: StorageConfig;
  encryption?: EncryptionConfig;
  sync?: SyncConfig;
}

export interface VectorClockConfig {
  initialClock?: Record<string, number>;
  clockId?: string;
}

export interface StorageConfig {
  type: 'memory' | 'persistent' | string;
  path?: string;
  memory?: boolean;
}

export interface EncryptionConfig {
  keyDerivationAlgorithm?: string;
  signatureAlgorithm?: string;
  encryptionAlgorithm?: string;
}

export interface SyncConfig {
  maxBatchSize?: number;
  batchTimeoutMs?: number;
  retryPolicy?: {
    maxRetries?: number;
    initialDelayMs?: number;
  };
}
