// 0.4.0 Memory Runtime effective mode（MCP 轻量视图）。
//
// 与 sidecar `src/sidecar/effective.ts` 同一张推导表：
// - `memoryRuntime.enabled` 是 immersive 的唯一真值；
// - enabled=false / 缺少字段 → lightweight / off，不启动 sidecar；
// - enabled=true 但 `model.source` 缺失 → off（保持 0.3 baseline，不能静默 heuristic）；
// - enabled=true + 显式 heuristic → heuristic；
// - enabled=true + local/host/api/auto → model（0.4.0 local 仅 assisted/shadow）；
// - 旧 intervention.mode 不参与 production，只产生稳定 warning（显式 off 也不例外）；
// - shadow 只能由内部 diagnostic 打开。
//
// 本模块只做纯计算，不读文件/环境；不返回 token、keyRef 或配置正文。

import {
  DEFAULT_MEMORY_RUNTIME_MODEL_SOURCE,
  normalizeMemoryRuntimeModelSource,
} from './memory-runtime-config.mjs';

export const MEMORY_RUNTIME_MODES = Object.freeze(['lightweight', 'immersive']);
export const LEGACY_INTERVENTION_MODE_IGNORED = 'legacy_intervention_mode_ignored';
export const MODEL_SOURCE_MISSING = 'model_source_missing';

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 由 MCP 配置 + sidecar model.source 推导 effective mode。
 *
 * 输入 `config` 是 MCP `<home>/config.json` 的（结构化）视图；`modelSource`/`sourcePresent`
 * 由调用方从 sidecar 只读视图传入。`legacyMode`/`legacyModePresent` 只在状态诊断时需要。
 */
export function resolveMemoryRuntimeEffectiveMode({
  config,
  modelSource,
  sourcePresent,
  legacyMode = null,
  legacyModePresent,
  diagnosticShadow = false,
} = {}) {
  const root = isObject(config) ? config : {};
  const memoryRuntime = isObject(root.memoryRuntime) ? root.memoryRuntime : {};
  const enabled = memoryRuntime.enabled === true;
  const configuredSource = modelSource
    ?? root.modelSource
    ?? (isObject(root.model) ? root.model.source : undefined);
  const source = normalizeMemoryRuntimeModelSource(configuredSource)
    ?? DEFAULT_MEMORY_RUNTIME_MODEL_SOURCE;
  // 未显式传入 presence 时，按“是否提供了 source”推断；空配置视为缺失。
  const present = sourcePresent
    ?? (configuredSource !== undefined && configuredSource !== null);

  // enabled=false 时没有 sidecar，也不进入介入；但诊断仍按 source 推导。
  const production = !present ? 'off' : source === 'heuristic' ? 'heuristic' : 'model';
  const effectivePlanner = enabled ? production : 'off';
  const effective = !enabled ? 'off' : (diagnosticShadow && present ? 'shadow' : production);

  const legacyModeValue = legacyMode ?? null;
  const legacyModeIsPresent = legacyModePresent
    ?? (legacyModeValue !== null);
  let legacyModeIgnored = false;
  let legacyModeConflict = false;
  const warnings = [];

  // 只有 immersive 的缺失 source 才值得告警；lightweight 不启动介入。
  if (enabled && !present) warnings.push(MODEL_SOURCE_MISSING);

  if (legacyModeIsPresent && legacyModeValue !== null) {
    // 显式旧值一律不参与 production；显式 off 也不例外（W1a review B2）。
    legacyModeIgnored = legacyModeValue !== production;
    legacyModeConflict = (legacyModeValue === 'off' && production === 'model')
      || (legacyModeValue === 'heuristic' && production === 'model')
      || (legacyModeValue === 'model' && production === 'heuristic');
    if (legacyModeIgnored) warnings.push(LEGACY_INTERVENTION_MODE_IGNORED);
  }

  return {
    mode: enabled ? 'immersive' : 'lightweight',
    enabled,
    effective,
    planner: effectivePlanner,
    source,
    sourcePresent: present,
    derivedMode: production,
    legacyModePresent: legacyModeIsPresent && legacyModeValue !== null,
    legacyModeIgnored,
    legacyModeConflict,
    diagnosticShadow: enabled && present && diagnosticShadow === true,
    warnings,
  };
}
