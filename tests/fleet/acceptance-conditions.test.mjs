// F-FLAKE-1 · 验收断言精确谓词的确定性回归测试
//
// 三处抖动的同一反模式：**等弱条件、单次读强断言**。本测试用「半成品观测」证明
// 旧写法会通过弱条件却让强断言失败，而修复后的谓词只在完整条件成立时为真。
// 另加源码锚点：两个 verify 脚本必须使用这些谓词（回退即红）。

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentResultsMatch,
  onboardAgentDone,
  negotiationDone,
  negotiationLimit,
} from '../../scripts/lib/acceptance-conditions.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('F-FLAKE-1 onboard：必须等完整条件（submitted+done+resultsMatch）', () => {
  it('半成品观测（仅 submitted）→ false；补齐 done/resultsMatch 后才 true', () => {
    const partial = '{"role":"worker","submitted": 3}\n';
    const withDone = `${partial}{"submitted": 3, "done": 3, "resultsMatch": false}\n`;
    const complete = `${partial}{"submitted": 3, "done": 3, "resultsMatch": true}\n`;
    // 旧写法只等 `"submitted": 3` → 在 partial 上就返回，随后强断言失败（抖动根因）
    expect(/"submitted":\s*3/.test(partial)).toBe(true);
    expect(onboardAgentDone(partial)).toBe(false);      // 修复后的谓词不放行半成品
    expect(onboardAgentDone(withDone)).toBe(false);     // 结果未匹配也不算完成
    expect(onboardAgentDone(complete)).toBe(true);
  });

  it('agentResultsMatch(text, n)：n 可参数化，半成品/数量不符/未匹配 均否', () => {
    const ok2 = '{"submitted": 2, "done": 2, "resultsMatch": true}';
    expect(agentResultsMatch(ok2, 2)).toBe(true);
    expect(agentResultsMatch(ok2, 3)).toBe(false);          // 数量不符
    expect(agentResultsMatch('{"submitted": 2}', 2)).toBe(false); // 只有 submitted
    expect(agentResultsMatch('{"submitted": 2, "done": 2, "resultsMatch": false}', 2)).toBe(false);
    // 边界：`3` 不应匹配 `30`
    expect(agentResultsMatch('{"submitted": 30, "done": 30, "resultsMatch": true}', 3)).toBe(false);
  });
});

describe('F-FLAKE-1 collab：终态/超限谓词必须精确', () => {
  it('negotiationDone：仅 status==="done" 为真（queued/pending/failed/null 均否）', () => {
    expect(negotiationDone({ status: 'done' })).toBe(true);
    expect(negotiationDone({ status: 'queued' })).toBe(false);
    expect(negotiationDone({ status: 'pending' })).toBe(false);
    expect(negotiationDone({ status: 'failed', reason: 'NEGOTIATION_LIMIT: 2>1' })).toBe(false);
    expect(negotiationDone(null)).toBe(false);
  });

  it('negotiationLimit：reason 恰为 "NEGOTIATION_LIMIT: 2>1"（近似串不算）', () => {
    expect(negotiationLimit({ reason: 'NEGOTIATION_LIMIT: 2>1' })).toBe(true);
    expect(negotiationLimit({ reason: 'NEGOTIATION_LIMIT: 3>1' })).toBe(false);
    expect(negotiationLimit({ reason: undefined })).toBe(false);
    expect(negotiationLimit({ reason: 'NEGOTIATION_LIMIT: 2>1 ' })).toBe(false);
  });
});

describe('F-FLAKE-1 源码锚点：verify 脚本按精确谓词做有界轮询（回退即红）', () => {
  const collab = readFileSync(join(root, 'scripts', 'verify-fleet-collab.mjs'), 'utf-8');
  const onboard = readFileSync(join(root, 'scripts', 'verify-fleet-onboard.mjs'), 'utf-8');

  it('collab：1d-b 两用例用 waitForTaskState 轮询精确谓词', () => {
    expect(collab).toMatch(/await waitForTaskState\(n2, nid, negotiationDone\)/);
    expect(collab).toMatch(/await waitForTaskState\(n3, oid, negotiationLimit\)/);
  });

  it('collab：不再「等终态后单次读 reason」（旧反模式缺席）', () => {
    // 旧写法：await n3.waitForTerminal([oid], …) 之后直接单次断言 reason
    expect(collab).not.toMatch(/await n3\.waitForTerminal\(\[oid\]/);
    // 旧写法：等「出现终态」后单次读状态
    expect(collab).not.toMatch(/waitFor\(async \(\) => negotiationDone\(await n2\.stateOf\(nid\)\)/);
  });

  it('collab：夹具关闭周期反熵（loop 显式驱动）并收紧会话超时 → 无退避毒化', () => {
    expect(collab).toMatch(/syncTimeout:\s*\d+/);
    // F-FLAKE-2：改为 `enabled: false`（反熵由 loop 显式驱动 runAntiEntropyCycle），
    // 从根本上消除「失败退避基数 = intervalMs」把兜底封停近 1 小时的毒化。
    expect(collab).toMatch(/antiEntropy:\s*\{\s*enabled:\s*false\s*\}/);
    expect(collab).not.toMatch(/antiEntropy:\s*\{\s*enabled:\s*true,\s*intervalMs:/);
  });

  it('collab：1d-a 负例用 waitForTaskState 轮询 dagCycleRejected 谓词（不再单次读）', () => {
    expect(collab).toMatch(/await waitForTaskState\(n1, badId, dagCycleRejected\)/);
    expect(collab).not.toMatch(/await n1\.waitForDagCompletion\(badId/);
  });

  it('onboard：等待完整条件而非只等 submitted', () => {
    expect(onboard).toMatch(/await waitFor\(async \(\) => onboardAgentDone\(serveA\.state\.out\)/);
    // 旧写法：只等 `"submitted": 3` 就返回
    expect(onboard).not.toMatch(/waitFor\(async \(\) => \/"submitted":\\s\*3\/\.test\(serveA\.state\.out\)/);
  });

  it('grant / membership：同一反模式已修（等完整条件而非只等 submitted）', () => {
    const grant = readFileSync(join(root, 'scripts', 'verify-fleet-grant.mjs'), 'utf-8');
    const membership = readFileSync(join(root, 'scripts', 'verify-fleet-membership.mjs'), 'utf-8');
    expect(grant).toMatch(/waitFor\(async \(\) => agentResultsMatch\(serveA\.state\.out, 3\)/);
    expect(membership).toMatch(/waitFor\(\(\) => agentResultsMatch\(node1\.state\.out, 3\)/);
    expect(grant).not.toMatch(/waitFor\(async \(\) => \/"submitted":\\s\*3\/\.test\(serveA\.state\.out\)/);
    expect(membership).not.toMatch(/waitFor\(\(\) => \/"submitted":\\s\*3\/\.test\(node1\.state\.out\)/);
  });
});

describe('F-FLAKE-1 夹具恢复界：最坏「卡住→重试」时间必须远小于验收预算', () => {
  const collab = readFileSync(join(root, 'scripts', 'verify-fleet-collab.mjs'), 'utf-8');

  it('3 次连续会话卡住（无退避）仍 < 60s（远小于 90s 等待）', () => {
    const timeoutMs = Number(/syncTimeout:\s*(\d+)/.exec(collab)?.[1]);
    expect(Number.isFinite(timeoutMs) && timeoutMs > 0).toBe(true);
    // F-FLAKE-2：反熵 `enabled:false` ⇒ `recordSyncOutcome` 不记退避（没有 intervalMs 基数可被毒化），
    // 最坏「卡住→重试」= 3 × syncTimeout（不再叠加指数退避）。
    expect(collab).toMatch(/antiEntropy:\s*\{\s*enabled:\s*false\s*\}/);
    expect(3 * timeoutMs).toBeLessThan(60_000);
  });
});
