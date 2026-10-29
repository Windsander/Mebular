// Runtime 设备级配置（contract §5.2）
//
// 旧 config.json 没有 `runtime` 时全部取默认；这里只做归一化，不写盘。
// 默认值：mode=mcp、capture=off、trace=local、checkpoint=local、self=cloud。

import {
  RUNTIME_CAPTURE_MODES,
  RUNTIME_MODEL_SOURCES,
  RUNTIME_MODES,
  RUNTIME_TRACE_MODES,
  type RuntimeCaptureMode,
  type RuntimeCheckpointSync,
  type RuntimeMode,
  type RuntimeModelSource,
  type RuntimeTraceMode,
} from './types.js';

export interface RuntimeRetentionSettings {
  rawDays: number;
  traceDays: number;
  checkpointDays: number;
}

export interface RuntimeModelSettings {
  source: RuntimeModelSource;
  local: {
    pack: string | null;
    path: string | null;
    threads: number;
  };
  api: {
    baseUrl: string | null;
    model: string | null;
    keyRef: string | null;
    allowRemote: boolean;
    timeoutMs: number;
  };
}

export interface RuntimeLimitsSettings {
  maxChunkBytes: number;
  maxContextTokens: number;
  maxRecall: number;
}

export interface RuntimeSettings {
  mode: RuntimeMode;
  capture: RuntimeCaptureMode;
  trace: RuntimeTraceMode;
  retention: RuntimeRetentionSettings;
  model: RuntimeModelSettings;
  checkpoint: { sync: RuntimeCheckpointSync };
  self: { sync: RuntimeCheckpointSync };
  limits: RuntimeLimitsSettings;
}

export function defaultRuntimeSettings(): RuntimeSettings {
  return {
    mode: 'mcp',
    capture: 'off',
    trace: 'local',
    retention: { rawDays: 7, traceDays: 7, checkpointDays: 30 },
    model: {
      source: 'heuristic',
      local: { pack: null, path: null, threads: 4 },
      api: {
        baseUrl: null,
        model: null,
        keyRef: null,
        allowRemote: false,
        timeoutMs: 10_000,
      },
    },
    checkpoint: { sync: 'local' },
    self: { sync: 'cloud' },
    limits: { maxChunkBytes: 262_144, maxContextTokens: 12_000, maxRecall: 50 },
  };
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function enumOf<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function intOf(value: unknown, fallback: number, min = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= min
    ? value
    : fallback;
}

function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * 归一化 `runtime` 配置组；非法/缺失值回落到默认，不抛错（旧配置可直接启动）。
 */
export function normalizeRuntimeSettings(raw: unknown): RuntimeSettings {
  const defaults = defaultRuntimeSettings();
  const input = objectOf(raw);
  const retention = objectOf(input.retention);
  const model = objectOf(input.model);
  const local = objectOf(model.local);
  const api = objectOf(model.api);
  const checkpoint = objectOf(input.checkpoint);
  const self = objectOf(input.self);
  const limits = objectOf(input.limits);

  return {
    mode: enumOf(input.mode, RUNTIME_MODES, defaults.mode),
    capture: enumOf(input.capture, RUNTIME_CAPTURE_MODES, defaults.capture),
    trace: enumOf(input.trace, RUNTIME_TRACE_MODES, defaults.trace),
    retention: {
      rawDays: intOf(retention.rawDays, defaults.retention.rawDays),
      traceDays: intOf(retention.traceDays, defaults.retention.traceDays),
      checkpointDays: intOf(retention.checkpointDays, defaults.retention.checkpointDays),
    },
    model: {
      source: enumOf(model.source, RUNTIME_MODEL_SOURCES, defaults.model.source),
      local: {
        pack: stringOrNull(local.pack),
        path: stringOrNull(local.path),
        threads: intOf(local.threads, defaults.model.local.threads, 1),
      },
      api: {
        baseUrl: stringOrNull(api.baseUrl),
        model: stringOrNull(api.model),
        keyRef: stringOrNull(api.keyRef),
        allowRemote: boolOf(api.allowRemote, defaults.model.api.allowRemote),
        timeoutMs: intOf(api.timeoutMs, defaults.model.api.timeoutMs, 1),
      },
    },
    checkpoint: {
      sync: enumOf(checkpoint.sync, ['local', 'cloud'] as const, defaults.checkpoint.sync),
    },
    self: {
      sync: enumOf(self.sync, ['local', 'cloud'] as const, defaults.self.sync),
    },
    limits: {
      maxChunkBytes: intOf(limits.maxChunkBytes, defaults.limits.maxChunkBytes, 1),
      maxContextTokens: intOf(limits.maxContextTokens, defaults.limits.maxContextTokens, 1),
      maxRecall: intOf(limits.maxRecall, defaults.limits.maxRecall, 1),
    },
  };
}
