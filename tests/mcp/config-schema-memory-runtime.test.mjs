// Memory Runtime 配置 schema：只保留 MCP 侧生命周期开关，旧 runtime.* 原型键全部退场。

import { describe, it, expect } from '@jest/globals';
import {
  CONFIG_SCHEMA,
  CONFIG_SCHEMA_BY_PATH,
  EDITABLE_PATHS,
  WRITABLE_INTERNAL_PATHS,
  isWritable,
} from '../../packages/mcp/src/config-schema.mjs';

describe('memory runtime config schema', () => {
  it('不再包含旧 Runtime 的 runtime.* 记忆键', () => {
    const legacy = CONFIG_SCHEMA
      .filter((entry) => entry.path.startsWith('runtime.'))
      .map((entry) => entry.path);
    expect(legacy).toEqual([]);
    expect(EDITABLE_PATHS.filter((path) => path.startsWith('runtime.'))).toEqual([]);
    expect(WRITABLE_INTERNAL_PATHS.filter((path) => path.startsWith('runtime.'))).toEqual([]);
  });

  it('旧 runtime.* 路径不可经配置 API 写入', () => {
    for (const path of [
      'runtime.mode',
      'runtime.capture',
      'runtime.trace',
      'runtime.model.source',
      'runtime.checkpoint.sync',
      'runtime.self.sync',
    ]) {
      expect(CONFIG_SCHEMA_BY_PATH.has(path)).toBe(false);
      expect(isWritable(path)).toBe(false);
    }
  });

  it('memoryRuntime.* 生命周期键存在且默认安全', () => {
    const enabled = CONFIG_SCHEMA_BY_PATH.get('memoryRuntime.enabled');
    expect(enabled.read({})).toBe(false);
    expect(enabled.default).toBe(false);
    expect(enabled.read({ memoryRuntime: { enabled: true } })).toBe(true);
    expect(isWritable('memoryRuntime.enabled')).toBe(true);

    expect(CONFIG_SCHEMA_BY_PATH.get('memoryRuntime.command').read({})).toBeNull();
    expect(CONFIG_SCHEMA_BY_PATH.get('memoryRuntime.startTimeoutMs').read({})).toBe(5000);
  });
});
