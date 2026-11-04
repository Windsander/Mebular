import { describe, expect, it } from '@jest/globals';
import { DETAIL_KINDS } from '@mebular/core';
import { RUNTIME_DETAIL_KINDS } from '../../src/runtime/types.js';

describe('runtime/core DetailRecord 类型契约', () => {
  it('detail-kind 枚举完全对齐，不包含旧 raw_quote', () => {
    expect([...RUNTIME_DETAIL_KINDS]).toEqual([...DETAIL_KINDS]);
    expect(RUNTIME_DETAIL_KINDS).not.toContain('raw_quote');
    expect(RUNTIME_DETAIL_KINDS).toContain('tool_output');
  });
});
