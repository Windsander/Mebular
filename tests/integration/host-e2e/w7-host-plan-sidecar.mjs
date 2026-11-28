#!/usr/bin/env node
// 0.4.0 W7：真实 sidecar 的 host plan 消费/拒绝路径。
//
// 边界：host plan 由本脚本按 W0-A schema 合成（不是真实宿主生成），因此证据等级
// 是 `R-RS-synthetic-host-plan`，不能算真实 host adapter E2E。真实 OpenCode
// adapter 的两轮 host 命中当前被 adapter 的已注入集合阻断（所有 recall fragments
// 都被记为已注入），本脚本不掩盖该阻断。
//
// 用法：node tests/integration/host-e2e/w7-host-plan-sidecar.mjs [--json out.json]

import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requestSidecar, startRealRuntime } from './lib/real-runtime.mjs';

const jsonArg = process.argv.find((arg) => arg.startsWith('--json='));
const jsonOut = jsonArg ? jsonArg.slice('--json='.length) : null;

function metaOf(response) {
  return response?.data?.interventionMeta ?? response?.data?.decision?.planner ?? null;
}

function planFor({ threadId, hostInstanceId, meta, overrides = {} }) {
  const now = Date.now();
  return {
    schema: 1,
    planId: `hp_${randomUUID().replace(/-/g, '')}`,
    host: 'opencode',
    hostInstanceId,
    agentId: 'opencode',
    threadId,
    scope: 'session',
    basedOnTurnId: meta.turnId,
    cueFingerprint: meta.cueFingerprint,
    basisCandidateFingerprint: (meta.candidateFingerprint ?? []).slice(0, 3),
    createdAt: now,
    expiresAt: now + 60_000,
    action: 'speak',
    depth: 'detail',
    confidence: 0.9,
    reasonCode: 'high_relevance',
    plannerKind: 'host-model',
    plannerVersion: 'w7-evidence-synthetic',
    policyVersion: 'host-plan:v1',
    ...overrides,
  };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mebular-w7-host-plan-'));
  const hostInstanceId = `hi_${randomUUID().replace(/-/g, '')}`;
  const hostApp = 'opencode';
  const runtime = await startRealRuntime({
    root,
    memoryRuntime: { enabled: true },
    sidecarConfig: {
      schema: 1,
      trace: 'local',
      model: { source: 'host' },
      intervention: { minConfidence: 0.3, maxSilentStreak: 99, explorationRate: 0 },
      context: { deadlineMs: 1500 },
      http: { host: '127.0.0.1', port: 0 },
    },
  });
  const checks = [];
  function check(id, name, ok, detail = '') {
    checks.push({ id, name, ok: Boolean(ok), detail });
    console.log(`  ${ok ? '✓' : '✗'} [${id}] ${name}${detail ? `（${detail}）` : ''}`);
  }
  try {
    await runtime.waitForSidecar({ timeoutMs: 60000 });
    const threadId = 'th_w7_host_plan';
    await runtime.seedMemory({
      text: '以后 deepwork 主题统一用深色主题 W7HOSTPLAN',
      namespace: 'default', agentId: 'opencode', threadId,
    });
    const discovery = await runtime.sidecarDiscovery();
    const postContext = (body) => requestSidecar(discovery, '/context', {
      method: 'POST',
      headers: {
        'x-mebular-host-app': hostApp,
        'x-mebular-host-instance': hostInstanceId,
      },
      body: JSON.stringify({
        agentId: 'opencode', threadId,
        maxFragments: 3, allowRemote: false,
        ...body,
      }),
    });
    const base = (turnId, query, extra = {}) => ({ turnId, query, ...extra });

    const first = await postContext(base('turn_host_1', 'deepwork'));
    const firstMeta = metaOf(first);
    check('first', '无 plan 时 host source 立即 heuristic',
      firstMeta?.prefetched === false && firstMeta?.fallbackReason === 'host_plan_missing',
      JSON.stringify(firstMeta));

    const plan = planFor({ threadId, hostInstanceId, meta: firstMeta });
    const second = await postContext(base('turn_host_2', 'deepwork', {
      hostPlan: plan, previousTurnId: firstMeta.turnId,
    }));
    const secondMeta = metaOf(second);
    check('hit', '真实 sidecar 消费合法 host plan',
      secondMeta?.prefetched === true && secondMeta?.resolvedSource === 'host',
      JSON.stringify(secondMeta));
    check('hit-not-fallback', '命中未触发 fallback', secondMeta?.fallbackReason === undefined,
      JSON.stringify(secondMeta?.fallbackReason));

    const expired = await postContext(base('turn_host_3', 'deepwork', {
      hostPlan: planFor({
        threadId,
        hostInstanceId,
        meta: secondMeta,
        overrides: { createdAt: Date.now() - 120_000, expiresAt: Date.now() - 60_000 },
      }),
      previousTurnId: secondMeta.turnId,
    }));
    const expiredMeta = metaOf(expired);
    check('expired', '过期 host plan 被拒绝并 fallback',
      expiredMeta?.prefetched === false && expiredMeta?.fallbackReason === 'host_plan_expired',
      JSON.stringify(expiredMeta));

    const mismatch = await postContext(base('turn_host_4', '完全不同的话题：旅行预算', {
      hostPlan: planFor({ threadId, hostInstanceId, meta: metaOf(expired) ?? firstMeta }),
      previousTurnId: metaOf(expired)?.turnId ?? secondMeta.turnId,
    }));
    const mismatchMeta = metaOf(mismatch);
    check('cue-mismatch', 'cue 不匹配的 host plan 未被消费',
      mismatchMeta?.prefetched === false,
      JSON.stringify(mismatchMeta));

    const latestMeta = metaOf(mismatch) ?? metaOf(expired) ?? secondMeta;
    const replayPlan = planFor({
      threadId, hostInstanceId, meta: latestMeta,
      overrides: {
        cueFingerprint: firstMeta.cueFingerprint,
        basisCandidateFingerprint: secondMeta.candidateFingerprint,
      },
    });
    const replay1 = await postContext(base('turn_host_5', 'deepwork', {
      hostPlan: replayPlan, previousTurnId: latestMeta.turnId,
    }));
    const replay2 = await postContext(base('turn_host_6', 'deepwork', {
      hostPlan: replayPlan, previousTurnId: metaOf(replay1)?.turnId ?? latestMeta.turnId,
    }));
    const replayMeta = metaOf(replay2);
    check('replay', '同一 planId 只允许消费一次',
      metaOf(replay1)?.prefetched === true
      && (replayMeta?.fallbackReason === 'host_plan_replayed' || replayMeta?.prefetched === false),
      JSON.stringify({ first: metaOf(replay1), replay: replayMeta }));

    const summary = {
      evidenceLevel: 'R-RS-synthetic-host-plan',
      host: 'opencode',
      note: 'host plan 由脚本按契约合成；只证明 sidecar 消费/拒绝，真实 adapter 两轮见 w7-intervention-evidence',
      passed: checks.filter((entry) => entry.ok).length,
      failed: checks.filter((entry) => !entry.ok).length,
      checks,
    };
    console.log(JSON.stringify({ passed: summary.passed, failed: summary.failed }));
    if (jsonOut) await writeFile(jsonOut, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    process.exitCode = summary.failed === 0 ? 0 : 1;
  } finally {
    await runtime.cleanup();
  }
}

await main();
