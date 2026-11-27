// 0.4.0 Memory Runtime effective mode（MCP 轻量视图）。
//
// 与 sidecar `src/sidecar/effective.ts` 同一张推导表：
// - `memoryRuntime.enabled` 是 immersive 的唯一真值；
// - enabled=false / 缺少字段 → lightweight / off，不启动 sidecar；
// - immersive + heuristic → heuristic；
// - immersive + local/host/api/auto → model（0.4.0 local 仅 assisted/shadow）；
// - 旧 intervention.mode 不参与 production，只产生稳定 warning；
// - shadow 只能由内部 diagnostic 打开。
//
// 本模块只做纯计算，不读文件/环境；不返回 token、keyRef 或配置正文。

import {
  DEFAULT_MEMORY_RUNTIME_MODEL_SOURCE,
  normalizeMemoryRuntimeModelSource,
} from './memory-runtime-config.mjs';

export const MEMORY_RUNTIME_MODES = Object.freeze(['lightweight', 'immersive']);
export const LEGACY_INTERVENTION_MODE_IGNORED = 'legacy_intervention_mode_ignored';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 由 MCP 配置 + sidecar model.source 推导 effective mode。
 *
 * 输入 `config` 是 MCP `<home>/config.json` 的（结构化）视图；`modelSource` 可由调用方
 * 从 sidecar 只读视图传入。`legacyMode`/`legacyModePresent` 只在状态诊断时需要。
 */
export function resolveMemoryRuntimeEffectiveMode({
  config,
  modelSource,
  legacyMode = null,
  legacyModePresent,
  diagnosticShadow = false,
} = {}) {
  const root = isObject(config) ? config : {};
  const memoryRuntime = isObject(root.memoryRuntime) ? root.memoryRuntime : {};
  const enabled = memoryRuntime.enabled === true;
  const source = normalizeMemoryRuntimeModelSource(
    modelSource ?? root.modelSource ?? (isObject(root.model) ? root.model.source : undefined),
  ) ?? DEFAULT_MEMORY_RUNTIME_MODEL_SOURCE;

  const production = source === 'heuristic' ? 'heuristic' : 'model';
  const present = legacyModePresent ?? (legacyMode !== null && legacyMode !== undefined);
  let legacyModeIgnored = false;
  let legacyModeConflict = false;
  const warnings = [];

  if (present && legacyMode !== null && legacyMode !== undefined) {
    // 显式 off 是历史默认值：保持静默。
    legacyModeIgnored = legacyMode !== 'off' && legacyMode !== production;
    legacyModeConflict = (legacyMode === 'off' && production === 'model')
      || (legacyMode === 'heuristic' && production === 'model')
      || (legacyMode === 'model' && production === 'heuristic');
    if (legacyModeIgnored) warnings.push(LEGACY_INTERVENTION_MODE_IGNORED);
  }

  const shadow = enabled && diagnosticShadow === true;
  return {
    mode: enabled ? 'immersive' : 'lightweight',
    enabled,
    effective: !enabled ? 'off' : (shadow ? 'shadow' : production),
    planner: enabled ? production : 'off',
    source,
    derivedMode: enabled ? production : 'off',
    legacyModePresent: present && legacyMode !== null && legacyMode !== undefined,
    legacyModeIgnored,
    legacyModeConflict,
    diagnosticShadow: shadow,
    warnings,
  };
}
