// core 展示名校验与应用层忆云名/设备名校验必须同一口径（名称只作展示元数据）。
import { describe, it, expect } from '@jest/globals';
import { normalizeDisplayName } from '../../src/core/displayName.js';
import { normalizeProfileName } from '../../packages/mcp/src/profiles.mjs';

const normalizeOrNull = (raw) => {
  try {
    return normalizeProfileName(raw);
  } catch {
    return null;
  }
};

describe('展示名校验口径（core ↔ 忆云 registry）', () => {
  const cases = [
    '忆云 1',
    '  工作室  ',
    'a\u0000b',
    '😀'.repeat(24),
    '😀'.repeat(25),
    'a/b',
    'a\\b',
    'a..b',
    '',
    '   ',
    '\u0000\u0001',
    'a b',
  ];
  it.each(cases)('输入 %j 结果一致', (raw) => {
    expect(normalizeOrNull(raw)).toBe(normalizeDisplayName(raw));
  });

  it('非法输入抛 INVALID_NAME（HTTP 层错误码稳定）', () => {
    for (const bad of ['', 'a/b', 'a\\b', 'a..b', '忆'.repeat(25)]) {
      let caught = null;
      try {
        normalizeProfileName(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught?.code).toBe('INVALID_NAME');
    }
  });
});
