// Mebular 错误体系（spec-004 错误处理节）
//
// 统一错误码 + 层级化错误类，门面与 provider 层先行接入，
// 底层模块逐步替换裸 Error。

export class MebularError extends Error {
  readonly code: string;
  readonly cause?: Error;

  constructor(message: string, code: string, cause?: Error) {
    super(message);
    this.name = 'MebularError';
    this.code = code;
    this.cause = cause;
  }
}

export class IdentityError extends MebularError {
  constructor(message: string, code: string = ErrorCodes.IDENTITY_NOT_INITIALIZED, cause?: Error) {
    super(message, code, cause);
    this.name = 'IdentityError';
  }
}

export class StorageError extends MebularError {
  constructor(message: string, code: string = ErrorCodes.STORAGE_WRITE_FAILED, cause?: Error) {
    super(message, code, cause);
    this.name = 'StorageError';
  }
}

export class SyncError extends MebularError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = 'SyncError';
  }
}

export class ValidationError extends MebularError {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, ErrorCodes.VALIDATION_INVALID_NODE);
    this.name = 'ValidationError';
    this.details = details;
  }
}

export class CryptoError extends MebularError {
  constructor(message: string, cause?: Error) {
    super(message, ErrorCodes.CRYPTO_SIGN_FAILED, cause);
    this.name = 'CryptoError';
  }
}

export const ErrorCodes = {
  // 身份错误
  IDENTITY_NOT_INITIALIZED: 'IDENTITY_NOT_INITIALIZED',
  IDENTITY_KEY_GENERATION_FAILED: 'IDENTITY_KEY_GENERATION_FAILED',
  IDENTITY_SIGNATURE_INVALID: 'IDENTITY_SIGNATURE_INVALID',
  IDENTITY_CERTIFICATE_INVALID: 'IDENTITY_CERTIFICATE_INVALID',
  IDENTITY_DEVICE_NOT_AUTHORIZED: 'IDENTITY_DEVICE_NOT_AUTHORIZED',
  /** 身份文件已加密但未提供解锁口令 */
  IDENTITY_LOCKED: 'IDENTITY_LOCKED',
  /** 解锁口令错误（或封套数据损坏） */
  IDENTITY_UNLOCK_FAILED: 'IDENTITY_UNLOCK_FAILED',

  // 存储错误
  STORAGE_INIT_FAILED: 'STORAGE_INIT_FAILED',
  STORAGE_NODE_NOT_FOUND: 'STORAGE_NODE_NOT_FOUND',
  STORAGE_EDGE_NOT_FOUND: 'STORAGE_EDGE_NOT_FOUND',
  STORAGE_WRITE_FAILED: 'STORAGE_WRITE_FAILED',
  STORAGE_READ_FAILED: 'STORAGE_READ_FAILED',

  // 同步错误
  SYNC_PEER_UNAUTHORIZED: 'SYNC_PEER_UNAUTHORIZED',
  SYNC_CONNECTION_FAILED: 'SYNC_CONNECTION_FAILED',
  SYNC_TIMEOUT: 'SYNC_TIMEOUT',
  SYNC_CONFLICT: 'SYNC_CONFLICT',
  SYNC_INVALID_EVENT: 'SYNC_INVALID_EVENT',
  SYNC_VECTOR_CLOCK_CONFLICT: 'SYNC_VECTOR_CLOCK_CONFLICT',

  // 加密错误
  CRYPTO_ENCRYPT_FAILED: 'CRYPTO_ENCRYPT_FAILED',
  CRYPTO_DECRYPT_FAILED: 'CRYPTO_DECRYPT_FAILED',
  CRYPTO_SIGN_FAILED: 'CRYPTO_SIGN_FAILED',
  CRYPTO_VERIFY_FAILED: 'CRYPTO_VERIFY_FAILED',
  CRYPTO_KEY_INVALID: 'CRYPTO_KEY_INVALID',

  // 验证错误
  VALIDATION_INVALID_NODE: 'VALIDATION_INVALID_NODE',
  VALIDATION_INVALID_EDGE: 'VALIDATION_INVALID_EDGE',
  VALIDATION_INVALID_EVENT: 'VALIDATION_INVALID_EVENT',
  VALIDATION_TIME_CONFLICT: 'VALIDATION_TIME_CONFLICT',
  VALIDATION_SIGNATURE_MISSING: 'VALIDATION_SIGNATURE_MISSING',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
