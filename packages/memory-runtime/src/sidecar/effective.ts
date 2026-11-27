// 0.4.0 Effective intervention mode。
//
// 契约（docs/design/0.4.0-w0-contract.md §3 + W1a review B1/B2）：
// - production 只由 `memoryRuntime.enabled + model.source` 推导；
// - `model.source` 缺失不等于显式 heuristic：缺失时保持 0.3 baseline/off；
// - `intervention.mode` 不再参与决策，只保留文件原值并给稳定 warning；
// - `shadow` 只能由进程内 diagnostic/canary 打开，不能由旧配置自动生效；
// - 不新增第二个持久化 mode 字段。
//
// 本模块是纯函数：不读文件、不读环境、不写 trace，也不包含 token/key。

import type { InferenceSettings, SidecarInterventionSettings } from './config.js';

export type InterventionPlannerSource = InferenceSettings['source'];
export type LegacyInterventionMode = SidecarInterventionSettings['mode'];

/** 生效的介入模式：production 为 off/heuristic/model；shadow 仅 diagnostic。 */
export type EffectiveInterventionMode = 'off' | 'heuristic' | 'model' | 'shadow';

/** recall 实际执行的 planner；off = 0.3 baseline（不跑介入策略）。 */
export type EffectiveInterventionPlanner = 'off' | 'heuristic' | 'model';

/** 旧字段被忽略时的稳定 warning；用于 `/status` / `/version` / 日志。 */
export const LEGACY_INTERVENTION_MODE_IGNORED = 'legacy_intervention_mode_ignored';
/** model.source 缺失（不是显式 heuristic）时的稳定诊断 code。 */
export const MODEL_SOURCE_MISSING = 'model_source_missing';

export interface ResolveEffectiveInterventionInput {
  /** 已归一化的 `model.source`，不会被改写。 */
  source: InterventionPlannerSource;
  /** `model.source` 是否真的出现在配置文件中；缺省视为存在。 */
  sourcePresent?: boolean;
  /** 配置里的旧 `intervention.mode`；缺省/未知时由调用方保证为 null。 */
  legacyMode?: LegacyInterventionMode | null;
  /**
   * 旧字段是否真的出现在配置文件里。
   * `legacyMode` 本身无法区分“缺省 = off”与“显式 off”，所以由 config 层提供。
   */
  legacyModePresent?: boolean;
  /** 仅内部 diagnostic/canary；不得来自用户配置的旧 mode。 */
  diagnosticShadow?: boolean;
}

export interface EffectiveInterventionResolution {
  /** 生效模式；shadow 时 planner 仍按 source 计算，但不改变注入。 */
  mode: EffectiveInterventionMode;
  /** recall 应使用的 planner；off 表示 0.3 baseline。 */
  planner: EffectiveInterventionPlanner;
  /** 归一化后的 source（缺失时为默认 heuristic，但由 sourcePresent 区分）。 */
  source: InterventionPlannerSource;
  /** source 是否显式存在。 */
  sourcePresent: boolean;
  /** 仅按 source presence/source 推导的 production 模式。 */
  derivedMode: EffectiveInterventionPlanner;
  legacyModePresent: boolean;
  legacyModeIgnored: boolean;
  legacyModeConflict: boolean;
  diagnosticShadow: boolean;
  /** 稳定 warning code 列表；不含路径/token/正文。 */
  warnings: string[];
}

/** 环境变量只接受明确的 truthy 值；未知值一律 false。 */
export function isDiagnosticShadowEnabled(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * 由 source presence + source 推导 production 模式。
 *
 * - source 缺失 → off（0.3 baseline；不把缺失静默当成 heuristic）；
 * - heuristic → heuristic（进程内规则，不调模型）；
 * - local/host/api/auto → model（0.4.0 local 仅 assisted/shadow，不等于 local-authoritative）；
 * - enabled=false 不会到达这里：sidecar 不启动，由 MCP 侧返回 off/lightweight。
 */
export function resolveEffectiveIntervention(
  input: ResolveEffectiveInterventionInput,
): EffectiveInterventionResolution {
  const source = input.source;
  const sourcePresent = input.sourcePresent ?? true;
  const derivedMode: EffectiveInterventionPlanner = !sourcePresent
    ? 'off'
    : source === 'heuristic' ? 'heuristic' : 'model';
  const legacyMode = input.legacyMode ?? null;
  const legacyModePresent = input.legacyModePresent
    ?? (legacyMode !== null);

  let legacyModeIgnored = false;
  let legacyModeConflict = false;
  const warnings: string[] = [];

  if (!sourcePresent) warnings.push(MODEL_SOURCE_MISSING);

  if (legacyModePresent && legacyMode !== null) {
    // 显式旧值一律不参与 production；与派生结果不同就忽略并给稳定 warning。
    // 显式 off 也不例外（W1a review B2）：不能静默。
    legacyModeIgnored = legacyMode !== derivedMode;
    // 冲突只作为诊断布尔；warning 仍统一用 legacy_intervention_mode_ignored。
    legacyModeConflict = (legacyMode === 'off' && derivedMode === 'model')
      || (legacyMode === 'heuristic' && derivedMode === 'model')
      || (legacyMode === 'model' && derivedMode === 'heuristic');
    if (legacyModeIgnored) warnings.push(LEGACY_INTERVENTION_MODE_IGNORED);
  }

  // 没有 source 就没有可执行的 planner，diagnostic shadow 也不能凭空生效。
  const diagnosticShadow = sourcePresent && input.diagnosticShadow === true;
  return {
    mode: diagnosticShadow ? 'shadow' : derivedMode,
    planner: derivedMode,
    source,
    sourcePresent,
    derivedMode,
    legacyModePresent,
    legacyModeIgnored,
    legacyModeConflict,
    diagnosticShadow,
    warnings,
  };
}
