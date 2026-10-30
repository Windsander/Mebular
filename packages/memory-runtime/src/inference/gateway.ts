// OpenAI-compatible `/v1/chat/completions` 客户端（0.3.0）
//
// 只面向用户显式配置的一个 endpoint；失败只回退调用方提供的 heuristic，
// 不会自动切换供应商、不会读取宿主凭据、不会把响应体/密钥写进错误消息。
//
// 能力：JSON schema 请求 + 本地结构校验、单次请求超时、429/5xx/网络重试一次、
// 5 次/60s 熔断、失败回退 heuristic。

import { normalizeChatBaseUrl } from './url.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonResponseSchema {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatJsonRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseSchema?: JsonResponseSchema;
  /** 附加请求字段；不能覆盖 messages/model/stream/response_format。 */
  extraBody?: Record<string, unknown>;
}

export interface ChatFetchResponse {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}

export type ChatFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<ChatFetchResponse>;

export interface ChatGatewayOptions {
  /** 已包含 `/v1` 的根地址，例如 `http://127.0.0.1:8080/v1`。 */
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  /** 首次请求之外的额外重试次数；默认 1。 */
  maxRetries?: number;
  retryDelayMs?: number;
  circuitFailureThreshold?: number;
  circuitWindowMs?: number;
  circuitCooldownMs?: number;
  fetch?: ChatFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type GatewayFailureCode =
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid_response'
  | 'invalid_json'
  | 'schema_mismatch'
  | 'circuit_open'
  | 'aborted';

export interface GatewayFailure {
  code: GatewayFailureCode;
  message: string;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
}

export interface GatewaySuccess<T> {
  ok: true;
  data: T;
  content: string;
  attempts: number;
  latencyMs: number;
  degraded: false;
}

export interface GatewayFallbackOutcome<T> {
  ok: false;
  /** 固定为 heuristic：本客户端不会自动切第三方。 */
  fallback: 'heuristic';
  data: T;
  error: GatewayFailure;
  attempts: number;
  latencyMs: number;
  degraded: true;
}

export type GatewayOutcome<T> = GatewaySuccess<T> | GatewayFallbackOutcome<T>;

export type GatewayFallback<T> = (failure: GatewayFailure) => T | Promise<T>;

export class GatewayError extends Error {
  readonly failure: GatewayFailure;

  constructor(failure: GatewayFailure) {
    super(failure.message);
    this.name = 'GatewayError';
    this.failure = failure;
  }
}

class RequestError extends Error {
  constructor(
    readonly code: GatewayFailureCode,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RequestError';
  }

  toFailure(): GatewayFailure {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}

export interface JsonSchemaValidation {
  ok: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/**
 * 小型 JSON Schema 子集校验器。只用于验证模型输出结构，不执行任何 schema 指令。
 * 未识别的关键字忽略（前向兼容），`required`/`properties`/`items`/`enum` 等常用项生效。
 */
export function validateJsonSchemaValue(
  value: unknown,
  schema: unknown,
  path = '$',
): JsonSchemaValidation {
  const errors: string[] = [];
  validate(value, schema, path, errors, 0);
  return { ok: errors.length === 0, errors };
}

function validate(
  value: unknown,
  schema: unknown,
  path: string,
  errors: string[],
  depth: number,
): void {
  if (depth > 32) {
    errors.push(`${path}: schema nesting is too deep`);
    return;
  }
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push(`${path}: schema does not allow a value`);
    return;
  }
  if (!isRecord(schema)) return;

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path}: value is not in enum`);
  }
  if ('const' in schema && !Object.is(schema.const, value)) {
    errors.push(`${path}: value does not match const`);
  }

  const types = Array.isArray(schema.type)
    ? schema.type.filter((item): item is string => typeof item === 'string')
    : typeof schema.type === 'string'
      ? [schema.type]
      : [];
  if (types.length > 0 && !types.some((type) => typeMatches(value, type))) {
    errors.push(`${path}: expected ${types.join('|')}`);
    return;
  }

  if (Array.isArray(schema.allOf)) {
    for (const item of schema.allOf) validate(value, item, path, errors, depth + 1);
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((item) => validateJsonSchemaValue(value, item, path).ok);
    if (!matches) errors.push(`${path}: does not match anyOf`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((item) => validateJsonSchemaValue(value, item, path).ok).length;
    if (matches !== 1) errors.push(`${path}: must match exactly one oneOf branch`);
  }
  if (schema.not !== undefined && validateJsonSchemaValue(value, schema.not, path).ok) {
    errors.push(`${path}: matches forbidden schema`);
  }

  if (isRecord(value)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [];
    for (const key of required) {
      if (!(key in value)) errors.push(`${path}.${key}: required property is missing`);
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) validate(value[key], childSchema, `${path}.${key}`, errors, depth + 1);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}.${key}: additional property is not allowed`);
      }
    } else if (isRecord(schema.additionalProperties)) {
      for (const [key, childValue] of Object.entries(value)) {
        if (!(key in properties)) {
          validate(childValue, schema.additionalProperties, `${path}.${key}`, errors, depth + 1);
        }
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: expected at most ${schema.maxItems} items`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`, errors, depth + 1));
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path}: string is shorter than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path}: string is longer than ${schema.maxLength}`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: number is below minimum`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path}: number is above maximum`);
    }
  }
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const firstLineEnd = trimmed.indexOf('\n');
  if (firstLineEnd < 0 || !trimmed.endsWith('```')) return trimmed;
  return trimmed.slice(firstLineEnd + 1, -3).trim();
}

function parseJsonContent(content: string): unknown {
  const text = stripCodeFence(content);
  if (!text) throw new RequestError('invalid_json', 'model returned empty content', false);
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError('invalid_json', 'model response is not valid JSON', false);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 单 endpoint 的 chat completions 客户端。没有备用供应商。
 */
export class ChatCompletionGateway {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly fetchImpl: ChatFetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private failureTimes: number[] = [];
  private openUntil = 0;

  constructor(options: ChatGatewayOptions) {
    const normalized = normalizeChatBaseUrl(options.baseUrl);
    if (!normalized.ok) {
      throw new GatewayError({
        code: 'network',
        message: normalized.reason === 'base_url_required'
          ? 'baseUrl is required'
          : 'baseUrl is not an allowed OpenAI-compatible endpoint',
        retryable: false,
      });
    }
    if (!options.model) {
      throw new GatewayError({
        code: 'invalid_response',
        message: 'model is required',
        retryable: false,
      });
    }
    this.baseUrl = normalized.url;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 1));
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
    this.failureThreshold = Math.max(1, options.circuitFailureThreshold ?? 5);
    this.windowMs = Math.max(1, options.circuitWindowMs ?? 60_000);
    this.cooldownMs = Math.max(1, options.circuitCooldownMs ?? 30_000);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fetchImpl = options.fetch ?? ((url, init) => {
      const fetchFn = globalThis.fetch;
      if (typeof fetchFn !== 'function') {
        return Promise.reject(new Error('global fetch is unavailable'));
      }
      return fetchFn(url, init) as unknown as Promise<ChatFetchResponse>;
    });
  }

  isCircuitOpen(nowMs: number = this.now()): boolean {
    this.pruneFailures(nowMs);
    if (this.openUntil > nowMs) return true;
    if (this.openUntil !== 0) {
      this.openUntil = 0;
      this.failureTimes = [];
    }
    return false;
  }

  resetCircuit(): void {
    this.failureTimes = [];
    this.openUntil = 0;
  }

  private pruneFailures(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    this.failureTimes = this.failureTimes.filter((at) => at >= cutoff);
  }

  private recordFailure(): void {
    const nowMs = this.now();
    this.failureTimes.push(nowMs);
    this.pruneFailures(nowMs);
    if (this.failureTimes.length >= this.failureThreshold) {
      this.openUntil = nowMs + this.cooldownMs;
    }
  }

  private recordSuccess(): void {
    this.failureTimes = [];
    this.openUntil = 0;
  }

  /**
   * 请求 JSON 输出并校验；所有失败在提供 fallback 时返回 degraded 结果。
   * 不提供 fallback 时抛 GatewayError（调用方应显式处理）。
   */
  async completeJson<T>(
    request: ChatJsonRequest,
    fallback?: GatewayFallback<T>,
  ): Promise<GatewayOutcome<T>> {
    const startedAt = this.now();
    if (this.isCircuitOpen()) {
      const failure: GatewayFailure = {
        code: 'circuit_open',
        message: 'model gateway circuit is open',
        retryable: false,
      };
      if (fallback) {
        const data = await fallback(failure);
        return {
          ok: false,
          fallback: 'heuristic',
          data,
          error: failure,
          attempts: 0,
          latencyMs: this.now() - startedAt,
          degraded: true,
        };
      }
      throw new GatewayError(failure);
    }

    let attempts = 0;
    let lastError: RequestError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      attempts += 1;
      try {
        const content = await this.requestOnce(request);
        const parsed = parseJsonContent(content);
        if (request.responseSchema) {
          const validation = validateJsonSchemaValue(parsed, request.responseSchema.schema);
          if (!validation.ok) {
            throw new RequestError(
              'schema_mismatch',
              `model JSON does not match schema: ${validation.errors.slice(0, 3).join('; ')}`,
              false,
            );
          }
        }
        this.recordSuccess();
        return {
          ok: true,
          data: parsed as T,
          content,
          attempts,
          latencyMs: this.now() - startedAt,
          degraded: false,
        };
      } catch (error) {
        const requestError = error instanceof RequestError
          ? error
          : new RequestError('network', `model request failed: ${messageOf(error)}`, true);
        lastError = requestError;
        if (!requestError.retryable || attempt >= this.maxRetries) break;
        const delay = requestError.retryAfterMs ?? this.retryDelayMs;
        if (delay > 0) await this.sleep(delay);
      }
    }

    const failure = (lastError ?? new RequestError('network', 'model request failed', false)).toFailure();
    this.recordFailure();

    if (fallback) {
      const data = await fallback(failure);
      return {
        ok: false,
        fallback: 'heuristic',
        data,
        error: failure,
        attempts,
        latencyMs: this.now() - startedAt,
        degraded: true,
      };
    }
    throw new GatewayError(failure);
  }

  private async requestOnce(request: ChatJsonRequest): Promise<string> {
    const body: Record<string, unknown> = {
      ...(request.extraBody ?? {}),
      model: request.model ?? this.model,
      messages: request.messages,
      stream: false,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.responseSchema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: request.responseSchema.name,
                schema: request.responseSchema.schema,
                strict: request.responseSchema.strict ?? true,
              },
            },
          }
        : {}),
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new RequestError('timeout', `model request timed out after ${this.timeoutMs}ms`, true));
      }, this.timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    });

    try {
      const url = `${this.baseUrl}/chat/completions`;
      const response = await Promise.race([
        this.fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        timeout,
      ]);

      if (!response.ok) {
        const retryable = response.status === 408
          || response.status === 425
          || response.status === 429
          || response.status >= 500;
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.now());
        throw new RequestError(
          'http',
          `model endpoint returned HTTP ${response.status}`,
          retryable,
          response.status,
          retryAfterMs,
        );
      }

      const text = await Promise.race([response.text(), timeout]);
      let envelope: unknown;
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new RequestError('invalid_response', 'model endpoint returned invalid JSON envelope', false);
      }
      if (!isRecord(envelope) || !Array.isArray(envelope.choices) || envelope.choices.length === 0) {
        throw new RequestError('invalid_response', 'model response has no choices', false);
      }
      const first = envelope.choices[0];
      if (!isRecord(first) || !isRecord(first.message)) {
        throw new RequestError('invalid_response', 'model response choice has no message', false);
      }
      const content = first.message.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new RequestError('invalid_response', 'model response has no text content', false);
      }
      return content;
    } catch (error) {
      if (error instanceof RequestError) throw error;
      if (timedOut || controller.signal.aborted) {
        throw new RequestError('timeout', `model request timed out after ${this.timeoutMs}ms`, true);
      }
      throw new RequestError('network', `model request failed: ${messageOf(error)}`, true);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
