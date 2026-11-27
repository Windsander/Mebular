// 0.4.0 effective mode 表一致性：MCP 轻量视图与 sidecar resolver 必须同源同结果。
//
// MCP 不 import sidecar 业务实现（进程边界），所以用同一组输入对照输出。

import { describe, it, expect } from '@jest/globals';
import { resolveEffectiveIntervention } from '../../packages/memory-runtime/src/sidecar/effective.js';
import { resolveMemoryRuntimeEffectiveMode } from '../../packages/mcp/src/memory-runtime-effective.mjs';

const SOURCES = ['heuristic', 'local', 'host', 'api', 'auto'];
const LEGACY_MODES = [null, 'off', 'shadow', 'heuristic', 'model'];

describe('effective mode parity (sidecar ↔ MCP)', () => {
  it('enabled=true 时 source/旧 mode 的所有组合表一致', () => {
    for (const source of SOURCES) {
      for (const legacyMode of LEGACY_MODES) {
        const legacyModePresent = legacyMode !== null;
        const sidecar = resolveEffectiveIntervention({
          source,
          legacyMode,
          legacyModePresent,
        });
        const mcp = resolveMemoryRuntimeEffectiveMode({
          config: { memoryRuntime: { enabled: true } },
          modelSource: source,
          legacyMode,
          legacyModePresent,
        });
        expect({
          mode: mcp.mode,
          effective: mcp.effective,
          planner: mcp.planner,
          source: mcp.source,
          derivedMode: mcp.derivedMode,
          legacyModePresent: mcp.legacyModePresent,
          legacyModeIgnored: mcp.legacyModeIgnored,
          legacyModeConflict: mcp.legacyModeConflict,
          diagnosticShadow: mcp.diagnosticShadow,
          warnings: mcp.warnings,
        }).toEqual({
          mode: 'immersive',
          effective: sidecar.mode,
          planner: sidecar.planner,
          source: sidecar.source,
          derivedMode: sidecar.derivedMode,
          legacyModePresent: sidecar.legacyModePresent,
          legacyModeIgnored: sidecar.legacyModeIgnored,
          legacyModeConflict: sidecar.legacyModeConflict,
          diagnosticShadow: sidecar.diagnosticShadow,
          warnings: sidecar.warnings,
        });
      }
    }
  });

  it('diagnostic shadow 在两边都只影响 mode，不改变 planner', () => {
    for (const source of SOURCES) {
      const sidecar = resolveEffectiveIntervention({ source, diagnosticShadow: true });
      const mcp = resolveMemoryRuntimeEffectiveMode({
        config: { memoryRuntime: { enabled: true } },
        modelSource: source,
        diagnosticShadow: true,
      });
      expect(mcp.effective).toBe(sidecar.mode);
      expect(mcp.planner).toBe(sidecar.planner);
      expect(sidecar.mode).toBe('shadow');
    }
  });
});
