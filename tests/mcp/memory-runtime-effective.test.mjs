// 0.4.0 MCP effective mode：enabled 是 immersive 唯一真值；source 决定 planner。
//
// 与 sidecar effective.ts 同一张表；architecture parity 测试会对照两者。

import { describe, it, expect } from '@jest/globals';
import {
  LEGACY_INTERVENTION_MODE_IGNORED,
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
        derivedMode: 'off',
        source: 'heuristic',
        warnings: [],
      });
    }
    expect(resolveMemoryRuntimeEffectiveMode().mode).toBe('lightweight');
  });

  it('enabled=true + heuristic → heuristic', () => {
    expect(resolveMemoryRuntimeEffectiveMode({
      config: { memoryRuntime: { enabled: true } },
      modelSource: 'heuristic',
    })).toMatchObject({
      mode: 'immersive',
      enabled: true,
      effective: 'heuristic',
      planner: 'heuristic',
      source: 'heuristic',
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

    expect(resolveMemoryRuntimeEffectiveMode({
      config: { memoryRuntime: { enabled: true } },
      modelSource: 'heuristic',
      legacyMode: 'off',
      legacyModePresent: true,
    })).toMatchObject({ effective: 'heuristic', legacyModePresent: true, warnings: [] });

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
