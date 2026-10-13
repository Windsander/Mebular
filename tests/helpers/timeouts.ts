// F-HYGIENE-1：重集成用例的**显式、有界**时间预算。
//
// 背景：Windows 慢机（并行跑多个 workflow 时）会让 libp2p / sqlite / 子进程类重集成用例
// 超过 jest 默认 5000ms 上限，报 `Exceeded timeout of 5000 ms`——同一 SHA 有时绿有时红，
// 且每次挂的用例不同。这里给重集成套件**显式**预算：Windows 放宽到 30s，其余平台 15s。
//
// 原则（F-HYGIENE-1）：
// - **只动预算**：断言、用例、产品代码一字不动；
// - **有界**：不是无限；真实卡死仍会在 30s 内失败；
// - **不全局一刀切**：纯单测保持 jest 默认 5s（对回归仍敏感），只有重集成文件调用本助手。

import { jest } from '@jest/globals';

export const IS_WINDOWS = process.platform === 'win32';

/** 重集成用例预算：Windows 30s；macOS/Linux 15s。 */
export const HEAVY_TIMEOUT_MS = IS_WINDOWS ? 30_000 : 15_000;

/** 在重集成套件顶部调用：把本文件默认用例预算设为有界的 `HEAVY_TIMEOUT_MS`。 */
export function useHeavyTimeout(): void {
  jest.setTimeout(HEAVY_TIMEOUT_MS);
}
