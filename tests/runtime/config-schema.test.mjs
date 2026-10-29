// runtime.* 配置 schema：默认 mcp/off、旧配置无 runtime 时仍可读、不扩张 Console 可编辑面。

import { describe, it, expect } from '@jest/globals';
import {
  CONFIG_SCHEMA,
  CONFIG_SCHEMA_BY_PATH,
  EDITABLE_PATHS,
  isWritable,
} from '../../packages/mcp/src/config-schema.mjs';

describe('runtime config schema', () => {
  it('包含契约冻结字段，默认 mcp/off/local', () => {
    const runtimePaths = CONFIG_SCHEMA.filter((entry) => entry.path.startsWith('runtime.')).map((entry) => entry.path);
    expect(runtimePaths).toEqual(expect.arrayContaining([
      'runtime.mode',
      'runtime.capture',
      'runtime.trace',
      'runtime.retention.rawDays',
      'runtime.retention.traceDays',
      'runtime.retention.checkpointDays',
      'runtime.model.source',
      'runtime.checkpoint.sync',
      'runtime.self.sync',
      'runtime.limits.maxChunkBytes',
      'runtime.limits.maxContextTokens',
      'runtime.limits.maxRecall',
    ]));
    expect(runtimePaths).toHaveLength(20);

    const mode = CONFIG_SCHEMA_BY_PATH.get('runtime.mode');
    expect(mode.read({})).toBe('mcp');
    expect(mode.default).toBe('mcp');
    expect(mode.read({ runtime: { mode: 'immersive' } })).toBe('immersive');
    expect(CONFIG_SCHEMA_BY_PATH.get('runtime.capture').read({})).toBe('off');
    expect(CONFIG_SCHEMA_BY_PATH.get('runtime.trace').read({})).toBe('local');
    expect(CONFIG_SCHEMA_BY_PATH.get('runtime.checkpoint.sync').read({})).toBe('local');
    expect(CONFIG_SCHEMA_BY_PATH.get('runtime.self.sync').read({})).toBe('cloud');
    expect(CONFIG_SCHEMA_BY_PATH.get('runtime.limits.maxChunkBytes').read({})).toBe(262144);
  });

  it('全部 internal + writable + 热生效，不改变 Console editable 面', () => {
    for (const entry of CONFIG_SCHEMA.filter((item) => item.path.startsWith('runtime.'))) {
      expect(entry.exposure).toBe('internal');
      expect(entry.writable).toBe(true);
      expect(entry.requiresRestart).toBe(false);
      expect(isWritable(entry.path)).toBe(true);
    }
    expect(EDITABLE_PATHS.filter((path) => path.startsWith('runtime.'))).toHaveLength(0);
  });
});
