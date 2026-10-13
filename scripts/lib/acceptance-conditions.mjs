// F-FLAKE-1 · 验收断言的**精确谓词**与**条件驱动的有界等待**（唯一真源，供 verify 脚本与单测共用）
//
// 背景：三处验收抖动都源于同一反模式——**等待较弱的条件、然后单次读取更强断言**：
//   · collab 1d-b：等 `waitForTerminal` 返回（或超时）→ 单次读 status/reason；
//   · onboard A：只等 `"submitted": 3` → 但断言还要求 `"done": 3` 与 `"resultsMatch": true`。
// 修法：把断言的**完整条件**写成纯谓词，用**有界轮询**直到满足或超时（不放宽断言、不固定 sleep）。
//
// 谓词是纯函数（输入为「一次观测」），便于确定性单测——可构造「半成品观测」证明旧写法会漏。

import { setTimeout as delay } from 'node:timers/promises';

/** 派发完成谓词：n 条提交、n 条完成、且结果前缀匹配（三者同时成立才算「收齐」）。 */
export function agentResultsMatch(text, n) {
  const out = String(text ?? '');
  const count = String(n);
  return new RegExp(`"submitted":\\s*${count}\\b`).test(out)
    && new RegExp(`"done":\\s*${count}\\b`).test(out)
    && /"resultsMatch":\s*true/.test(out);
}

/** onboard A：3 条收齐（`agentResultsMatch(text, 3)` 的具名别名）。 */
export function onboardAgentDone(text) {
  return agentResultsMatch(text, 3);
}

/** collab 1d-b 协商成功：任务到达 `done`（不接受 queued/pending/failed）。 */
export function negotiationDone(state) {
  return state?.status === 'done';
}

/** collab 1d-b 超限：reason 恰为 `NEGOTIATION_LIMIT: 2>1`。 */
export function negotiationLimit(state) {
  return state?.reason === 'NEGOTIATION_LIMIT: 2>1';
}

/** DAG 完成（1d-a 及负例）：全部可达任务到终态。 */
export function dagComplete(completion) {
  return completion?.complete === true;
}

/** 聊天收件达到 n 条（1d-c）。 */
export function inboxAtLeast(messages, n) {
  return Array.isArray(messages) && messages.length >= n;
}

/**
 * 条件驱动的有界等待（F-FLAKE-1 核心）：
 *
 * `waitForTerminal` / `waitForDagCompletion` 不只是「等待」——它们**驱动**节点
 * （`pollOnce()` 收件 + `applyNegotiationPolicy()` 回写协商），被动读 `stateOf`
 * 会让协商停在首轮（实测：1d-b 卡在 `queued`）。因此本助手在轮询**精确断言谓词**
 * 的同时保持同一驱动语义，并可额外注入「收敛驱动」（两端的 anti-entropy），
 * 使等待不依赖后台循环的节奏。
 *
 * 诚实约定：**不放宽断言**——超时后返回最后一次观测，由调用方以**原断言**判定；
 * 谓词为真即返回，不固定 sleep 碰运气（`pollMs` 仅在未满足时作为轮询节奏）。
 */
export async function waitForTaskState(node, taskId, predicate, options = {}) {
  const { timeoutMs = 90000, pollMs = 10, drivers = [] } = options;
  const deadline = Date.now() + timeoutMs;
  const drive = async () => {
    await node.pollOnce();
    await node.applyNegotiationPolicy();
    for (const driver of drivers) {
      await driver().catch(() => undefined);
    }
  };
  await drive();
  let state = await node.stateOf(taskId);
  while (!predicate(state) && Date.now() < deadline) {
    await delay(pollMs);
    await drive();
    state = await node.stateOf(taskId);
  }
  return { ok: predicate(state), state };
}
