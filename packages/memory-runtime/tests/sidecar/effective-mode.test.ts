// 0.4.0 effective intervention mode：只由 model.source 推导，旧 intervention.mode 仅诊断。
//
// 契约：docs/design/0.4.0-w0-contract.md §3。

import { describe, it, expect } from '@jest/globals';
import {
  LEGACY_INTERVENTION_MODE_IGNORED,
  isDiagnosticShadowEnabled,
  resolveEffectiveIntervention,
  type InterventionPlannerSource,
} from '../../src/sidecar/effective.js';

const SOURCES: InterventionPlannerSource[] = ['heuristic', 'local', 'host', 'api', 'auto'];

describe('effective intervention mode', () => {
  it('source → production mode 推导表', () => {
    for (const source of SOURCES) {
      const resolved = resolveEffectiveIntervention({ source });
      const expected = source === 'heuristic' ? 'heuristic' : 'model';
      expect(resolved).toMatchObject({
        mode: expected,
        derivedMode: expected,
        planner: expected,
        source,
        legacyModePresent: false,
        legacyModeIgnored: false,
        legacyModeConflict: false,
        diagnosticShadow: false,
        warnings: [],
      });
    }
  });

  it('字段缺失：按 source 派生，无 warning', () => {
    expect(resolveEffectiveIntervention({ source: 'heuristic' }).warnings).toEqual([]);
    expect(resolveEffectiveIntervention({ source: 'auto' }).warnings).toEqual([]);
  });

  it('显式 off：历史默认值保持静默，不改变派生结果', () => {
    const heuristic = resolveEffectiveIntervention({
      source: 'heuristic',
      legacyMode: 'off',
      legacyModePresent: true,
    });
    expect(heuristic).toMatchObject({
      mode: 'heuristic',
      legacyModePresent: true,
      legacyModeIgnored: false,
      legacyModeConflict: false,
      warnings: [],
    });

    // off + model source 是诊断冲突，但显式 off 仍不产生 warning。
    const model = resolveEffectiveIntervention({
      source: 'local',
      legacyMode: 'off',
      legacyModePresent: true,
    });
    expect(model).toMatchObject({
      mode: 'model',
      legacyModeIgnored: false,
      legacyModeConflict: true,
      warnings: [],
    });
  });

  it('显式 shadow：不启用 shadow，只给稳定 warning', () => {
    const resolved = resolveEffectiveIntervention({
      source: 'heuristic',
      legacyMode: 'shadow',
      legacyModePresent: true,
    });
    expect(resolved).toMatchObject({
      mode: 'heuristic',
      planner: 'heuristic',
      legacyModeIgnored: true,
      diagnosticShadow: false,
      warnings: [LEGACY_INTERVENTION_MODE_IGNORED],
    });
  });

  it('source/mode 冲突：派生按 source，旧值只诊断', () => {
    const modelSourceHeuristicMode = resolveEffectiveIntervention({
      source: 'api',
      legacyMode: 'heuristic',
      legacyModePresent: true,
    });
    expect(modelSourceHeuristicMode).toMatchObject({
      mode: 'model',
      planner: 'model',
      legacyModeIgnored: true,
      legacyModeConflict: true,
      warnings: [LEGACY_INTERVENTION_MODE_IGNORED],
    });

    const heuristicSourceModelMode = resolveEffectiveIntervention({
      source: 'heuristic',
      legacyMode: 'model',
      legacyModePresent: true,
    });
    expect(heuristicSourceModelMode).toMatchObject({
      mode: 'heuristic',
      planner: 'heuristic',
      legacyModeIgnored: true,
      legacyModeConflict: true,
      warnings: [LEGACY_INTERVENTION_MODE_IGNORED],
    });
  });

  it('旧值与 source 一致时不产生 warning', () => {
    expect(resolveEffectiveIntervention({
      source: 'heuristic',
      legacyMode: 'heuristic',
      legacyModePresent: true,
    })).toMatchObject({ mode: 'heuristic', legacyModeIgnored: false, warnings: [] });
    expect(resolveEffectiveIntervention({
      source: 'host',
      legacyMode: 'model',
      legacyModePresent: true,
    })).toMatchObject({ mode: 'model', legacyModeIgnored: false, warnings: [] });
  });

  it('shadow 只能由内部 diagnostic 打开，planner 仍按 source 计算', () => {
    expect(resolveEffectiveIntervention({
      source: 'heuristic',
      legacyMode: 'shadow',
      legacyModePresent: true,
      diagnosticShadow: true,
    })).toMatchObject({
      mode: 'shadow',
      planner: 'heuristic',
      diagnosticShadow: true,
    });
    expect(resolveEffectiveIntervention({
      source: 'auto',
      diagnosticShadow: true,
    })).toMatchObject({
      mode: 'shadow',
      planner: 'model',
      diagnosticShadow: true,
    });
  });

  it('diagnostic env 只接受明确 truthy 值', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) {
      expect(isDiagnosticShadowEnabled(value)).toBe(true);
    }
    for (const value of [undefined, null, '', '0', 'false', 'no', 'off', '2']) {
      expect(isDiagnosticShadowEnabled(value)).toBe(false);
    }
  });
});
