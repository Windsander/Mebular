// Mebular 错误体系（spec-004 错误处理节）
//
// 统一错误码 + 层级化错误类，门面与 provider 层先行接入，
// 底层模块逐步替换裸 Error（Phase 6.0 起新码一律入册，不再产生裸字符串）。

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

/** 网络/P2P 层错误（Phase 6.0 起底层裸 Error 逐步收敛到此） */
export class NetworkError extends MebularError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = 'NetworkError';
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
  /** 存储已关闭后的访问 */
  STORAGE_CLOSED: 'STORAGE_CLOSED',

  // 同步错误
  SYNC_PEER_UNAUTHORIZED: 'SYNC_PEER_UNAUTHORIZED',
  SYNC_CONNECTION_FAILED: 'SYNC_CONNECTION_FAILED',
  SYNC_TIMEOUT: 'SYNC_TIMEOUT',
  SYNC_CONFLICT: 'SYNC_CONFLICT',
  SYNC_INVALID_EVENT: 'SYNC_INVALID_EVENT',
  SYNC_VECTOR_CLOCK_CONFLICT: 'SYNC_VECTOR_CLOCK_CONFLICT',
  /** 同步协议帧序/类型违规 */
  SYNC_PROTOCOL_VIOLATION: 'SYNC_PROTOCOL_VIOLATION',
  /** 对端报告的同步错误 */
  SYNC_REMOTE_ERROR: 'SYNC_REMOTE_ERROR',

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

  // 网络/P2P 错误
  NETWORK_ALREADY_RUNNING: 'NETWORK_ALREADY_RUNNING',
  NETWORK_NOT_RUNNING: 'NETWORK_NOT_RUNNING',
  NETWORK_CONNECTION_CLOSED: 'NETWORK_CONNECTION_CLOSED',
  NETWORK_AUTH_FAILED: 'NETWORK_AUTH_FAILED',
  /** 连接尚未完成认证 */
  NETWORK_NOT_AUTHENTICATED: 'NETWORK_NOT_AUTHENTICATED',
  NETWORK_SESSION_NOT_ESTABLISHED: 'NETWORK_SESSION_NOT_ESTABLISHED',
  /** 密钥交换帧缺少身份签名（D22 要求） */
  NETWORK_KEY_EXCHANGE_UNSIGNED: 'NETWORK_KEY_EXCHANGE_UNSIGNED',
  /** 密钥交换帧身份签名验签失败（疑似 MITM） */
  NETWORK_KEY_EXCHANGE_REJECTED: 'NETWORK_KEY_EXCHANGE_REJECTED',
  NETWORK_FRAME_INVALID: 'NETWORK_FRAME_INVALID',
  NETWORK_FRAME_TOO_LARGE: 'NETWORK_FRAME_TOO_LARGE',
  NETWORK_MAX_CONNECTIONS: 'NETWORK_MAX_CONNECTIONS',
  NETWORK_PROVIDER_NOT_SET: 'NETWORK_PROVIDER_NOT_SET',
  NETWORK_PEER_UNREACHABLE: 'NETWORK_PEER_UNREACHABLE',
  /** 拨号前置条件未满足（如拨号方身份未绑定） */
  NETWORK_DIAL_FAILED: 'NETWORK_DIAL_FAILED',
  NETWORK_NAT_FAILED: 'NETWORK_NAT_FAILED',
  NETWORK_DISCOVERY_FAILED: 'NETWORK_DISCOVERY_FAILED',
  NETWORK_HANDSHAKE_FAILED: 'NETWORK_HANDSHAKE_FAILED',
  /** libp2p 可选依赖未安装（D19） */
  NETWORK_LIBP2P_NOT_AVAILABLE: 'NETWORK_LIBP2P_NOT_AVAILABLE',
  /** 对端 PeerId 无法反解出 Ed25519 公钥 */
  NETWORK_PEER_IDENTITY_UNSUPPORTED: 'NETWORK_PEER_IDENTITY_UNSUPPORTED',

  // 交换格式 / 适配器错误（Phase 5）
  CMF_FORMAT_INVALID: 'CMF_FORMAT_INVALID',
  CMF_VERSION_UNSUPPORTED: 'CMF_VERSION_UNSUPPORTED',
  ADAPTER_DUPLICATE: 'ADAPTER_DUPLICATE',
  ADAPTER_NOT_FOUND: 'ADAPTER_NOT_FOUND',

  // 门面错误
  MEBULAR_NOT_INITIALIZED: 'MEBULAR_NOT_INITIALIZED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
