// 架构守卫：core 不得反向依赖 memory-runtime / runtime / inference；
// memory-runtime 不得 import core 内部路径。
//
// 与 `npm run check:architecture` 共用 scripts/check-architecture.mjs。

import { describe, it, expect } from '@jest/globals';
import { checkArchitecture } from '../../scripts/check-architecture.mjs';

describe('包边界', () => {
  it('core 与 memory-runtime 的 import 方向符合 0.3.0 契约', async () => {
    expect(await checkArchitecture()).toEqual([]);
  });
});
