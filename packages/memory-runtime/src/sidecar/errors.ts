// Memory Runtime sidecar 业务错误。
//
// 与 host API 错误信封（sidecar §11.1）对齐：稳定 code、HTTP status、
// retryable 与脱敏 details。错误消息不包含正文、token、Authorization。
//
// 本模块不 import @mebular/core，也不打开图/事件日志。

export type SidecarSettlementErrorCode =
  | 'invalid_request'
  | 'domain_invalid'
  | 'domain_mismatch'
  | 'domain_write_forbidden'
  | 'payload_too_large'
  | 'validation_failed'
  | 'content_hash_mismatch'
  | 'idempotency_conflict'
  | 'not_found'
  | 'outbox_full'
  | 'storage_full'
  | 'capability_unavailable'
  | 'stopping'
  | 'internal';

export class SidecarSettlementError extends Error {
  readonly code: SidecarSettlementErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: SidecarSettlementErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'SidecarSettlementError';
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.retryable = options.retryable === true;
    if (options.details !== undefined) this.details = options.details;
  }
}

function defaultStatus(code: SidecarSettlementErrorCode): number {
  switch (code) {
    case 'invalid_request':
    case 'domain_invalid':
    case 'domain_mismatch':
      return 400;
    case 'domain_write_forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'idempotency_conflict':
      return 409;
    case 'payload_too_large':
      return 413;
    case 'validation_failed':
    case 'content_hash_mismatch':
      return 422;
    case 'outbox_full':
    case 'storage_full':
    case 'capability_unavailable':
    case 'stopping':
      return 503;
    case 'internal':
    default:
      return 500;
  }
}
