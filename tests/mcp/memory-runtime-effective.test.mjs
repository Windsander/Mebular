// 0.4.0 MCP effective mode：enabled 是 immersive 唯一真值；source 决定 planner。
//
// 与 sidecar effective.ts 同一张表；architecture parity 测试会对照两者。

import { describe, it, expect } from '@jest/globals';
import {
  LEGACY_INTERVENTION_MODE_IGNORED,
  MODEL_SOURCE_MISSING,
  resolveMemoryRuntimeEffectiveMode,
} from '../../packages/mcp/src/memory-runtime-effective.mjs';

describe('MCP memory runtime effective mode', () => {
  it('缺少字段/enabled=false → lightweight/off，不启动介入', () => {
    for (const config of [{}, { memoryRuntime: {} }, { memoryRuntime: { enabled: false } }]) {
      expect(resolveMemoryRuntimeEffectiveMode({ config })).toMatchObject({
        mode: 'lightweight',
        enabled: false,
        effective: 'off',
        planner: 'off',
        source: 'heuristic',
        sourcePresent: false,
        warnings: [],
      });
    }
    expect(resolveMemoryRuntimeEffectiveMode().mode).toBe('lightweight');
  });

  it('enabled=true + source 缺失 → off/baseline，不能静默 heuristic', () => {
    expect(resolveMemoryRuntimeEffectiveMode({
      config: { memoryRuntime: { enabled: true } },
      sourcePresent: false,
    })).toMatchObject({
      mode: 'immersive',
      enabled: true,
      effective: 'off',
      planner: 'off',
      derivedMode: 'off',
      sourcePresent: false,
      warnings: [MODEL_SOURCE_MISSING],
    });
  });

  it('enabled=true + 显式 heuristic → heuristic', () => {
    expect(resolveMemoryRuntimeEffectiveMode({
      config: { memoryRuntime: { enabled: true } },
      modelSource: 'heuristic',
      sourcePresent: true,
    })).toMatchObject({
      mode: 'immersive',
      enabled: true,
      effective: 'heuristic',
      planner: 'heuristic',
      source: 'heuristic',
      sourcePresent: true,
      warnings: [],
    });
  });

  it('enabled=true + local/host/api/auto → model', () => {
    for (const source of ['local', 'host', 'api', 'auto']) {
      expect(resolveMemoryRuntimeEffectiveMode({
        config: { memoryRuntime: { enabled: true } },
        modelSource: source,
      })).toMatchObject({
        mode: 'immersive',
        effective: 'model',
        planner: 'model',
        source,
      });
    }
  });

  it('旧 mode 不参与 production：缺失/显式 off/显式 shadow/冲突', () => {
    expect(resolveMemoryRuntimeEffectiveMode({
      config: { memoryRuntime: { enabled: true } },
      modelSource: 'heuristic',
    }).warnings).toEqual([]);

    // 显式旧 off 不再静默（W1a review B2）。
    expect(resolveMemoryRuntimeEffectiveMode({
      config: { memoryRuntime: { enabled: true } },
      modelSource: 'heuristic',
      legacyMode: 'off',
      legacyModePresent: true,
    })).toMatchObject({
      effective: 'heuristic',
      legacyModePresent: true,
      legacyModeIgnored: true,
      legacyModeConflict: false,
      warnings: [LEGACY_INTERVENTION_MODE_IGNORED],
    });

    expect(resolveMemoryRuntimeEffectiveMode({
      config: { memoryRuntime: { enabled: true } },
      modelSource: 'heuristic',
      legacyMode: 'shadow',
      legacyModePresent: true,
    })).toMatchObject({
      effective: 'heuristic',
      legacyModeIgnored: true,
      diagnosticShadow: false,
      warnings: [LEGACY_INTERVENTION_MODE_IGNORED],
    });

    expect(resolveMemoryRuntimeEffectiveMode({
      config: { memoryRuntime: { enabled: true } },
      modelSource: 'heuristic',
      legacyMode: 'model',
      legacyModePresent: true,
    })).toMatchObject({
      effective: 'heuristic',
      legacyModeIgnored: true,
      legacyModeConflict: true,
      warnings: [LEGACY_INTERVENTION_MODE_IGNORED],
    });

    expect(resolveMemoryRuntimeEffectiveMode({
      config: { memoryRuntime: { enabled: true } },
      modelSource: 'api',
      legacyMode: 'off',
      legacyModePresent: true,
    })).toMatchObject({
      effective: 'model',
      legacyModeIgnored: true,
      legacyModeConflict: true,
      warnings: [LEGACY_INTERVENTION_MODE_IGNORED],
    });
  });

  it('shadow 只由内部 diagnostic 打开', () => {
    expect(resolveMemoryRuntimeEffectiveMode({
      config: { memoryRuntime: { enabled: true } },
      modelSource: 'api',
      legacyMode: 'shadow',
      legacyModePresent: true,
      diagnosticShadow: true,
    })).toMatchObject({
      mode: 'immersive',
      effective: 'shadow',
      planner: 'model',
      diagnosticShadow: true,
    });
  });

  it('未知 source 回退 heuristic，且状态不含 keyRef/token', () => {
    const resolved = resolveMemoryRuntimeEffectiveMode({
      config: {
        memoryRuntime: { enabled: true },
        model: { source: 'not-a-source' },
      },
    });
    expect(resolved.source).toBe('heuristic');
    const text = JSON.stringify(resolved);
    expect(text).not.toContain('keyRef');
    expect(text).not.toContain('token');
  });
});
