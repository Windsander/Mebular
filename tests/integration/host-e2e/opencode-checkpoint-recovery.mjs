#!/usr/bin/env node
// Real sidecar + real capability checkpoint recovery scenarios.
//
// Boundaries:
//   * real Memory Runtime sidecar, real MCP capability API, real GraphStore;
//   * real HTTP fetches for plugin -> sidecar and sidecar -> capability;
//   * fake host ctx (controller only), no real OpenCode process;
//   * capability outage is simulated by a controllable loopback proxy.
//
// This script covers the cases that cannot be proven by a fake 409:
//   - lost checkpoint response after the graph commit, retried with the same
//     body requestId, yielding one revision;
//   - expectedRevision preflight/advance/delete-recreate;
//   - capability-down PUT 202 -> sidecar outbox -> recovery -> authoritative
//     GET commit, yielding one revision.

import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as createHttpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createController, summaryOnlyCheckpointState } from '../../../packages/opencode-plugin/index.js';
import { requestSidecar, startRealRuntime } from './lib/real-runtime.mjs';

let passed = 0;
let failed = 0;
const results = [];
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
  return ok;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await Promise.resolve()
      .then(predicate)
      .catch(() => null);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

async function startCapabilityProxy() {
  let paused = false;
  let failDetail = false;
  let targetPort = null;
  const server = createHttpServer((req, res) => {
    const unavailable = (message) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: { code: 'capability_unavailable', message, retryable: true },
      }));
    };
    if (paused || targetPort === null) {
      unavailable(targetPort === null ? 'proxy target not ready' : 'proxy paused');
      return;
    }
    if (failDetail && String(req.url).startsWith('/internal/memory/v1/detail')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: { code: 'forbidden_scope', message: 'detail writes forbidden by negative fixture', retryable: false },
      }));
      return;
    }
    const upstream = createHttpRequest({
      host: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) unavailable('proxy upstream failed');
      else res.end();
    });
    req.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    setTarget(nextPort) { targetPort = nextPort; },
    setFailDetail(value) { failDetail = value === true; },
    pause() { paused = true; },
    resume() { paused = false; },
    close: () => new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      timer.unref?.();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    }),
  };
}

function makeFakeCtx() {
  return {
    app: { version: '2.2.0' },
    options: {},
    session: {
      hook: async () => ({ dispose: async () => {} }),
      context: async () => [],
      generate: async () => ({ text: '[]' }),
    },
    event: {
      subscribe: async (options = {}) => ({
        async *[Symbol.asyncIterator]() {
          while (!options.signal?.aborted) await sleep(10);
          yield undefined;
        },
      }),
    },
    tool: { transform: async () => ({ dispose: async () => {} }) },
  };
}

function outboxItems(status) {
  if (typeof status?.outbox === 'number') return status.outbox;
  if (typeof status?.outbox?.items === 'number') return status.outbox.items;
  if (typeof status?.counts?.objectWritesQueued === 'number') return status.counts.objectWritesQueued;
  return 0;
}

function deadLetterItems(status) {
  if (typeof status?.counts?.deadLetter === 'number') return status.counts.deadLetter;
  if (typeof status?.deadLetter === 'number') return status.deadLetter;
  return 0;
}

async function main() {
  const root = join(tmpdir(), `mebular-opencode-checkpoint-recovery-${process.pid}-${Date.now()}`);
  const mebularHome = join(root, 'mebular-home');
  await mkdir(join(mebularHome, 'memory-runtime'), { recursive: true });
  await writeFile(join(mebularHome, 'memory-runtime', 'config.json'), JSON.stringify({
    schema: 1,
    trace: 'local',
    model: { source: 'heuristic' },
    http: { host: '127.0.0.1', port: 0 },
  }, null, 2), 'utf8');

  const proxy = await startCapabilityProxy();
  const previousCapabilityUrl = process.env.MEBULAR_CAPABILITY_URL;
  process.env.MEBULAR_CAPABILITY_URL = proxy.url;

  let runtime = null;
  let runtimeB = null;
  let controller = null;
  try {
    runtime = await startRealRuntime({
      root,
      memoryRuntime: { enabled: true },
      manageMemoryRuntime: true,
    });
    proxy.setTarget(Number(new URL(runtime.url).port));
    proxy.resume();
    const discovery = await runtime.waitForSidecar();
    if (previousCapabilityUrl === undefined) delete process.env.MEBULAR_CAPABILITY_URL;
    else process.env.MEBULAR_CAPABILITY_URL = previousCapabilityUrl;

    const putBodies = [];
    const ingestBodies = [];
    let loseFirstCheckpointResponse = true;
    let conflictThread = null;
    let conflictInjected = false;
    const fetchImpl = async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      const method = init.method ?? 'GET';
      const requestBody = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      const ingest = pathname.endsWith('/ingest');
      if (ingest) ingestBodies.push({ body: requestBody, status: null });
      if (method === 'PUT' && pathname.includes('/checkpoints/')
        && conflictThread !== null && !conflictInjected && requestBody?.threadId === conflictThread) {
        conflictInjected = true;
        await requestSidecar(
          discovery,
          `/checkpoints/${encodeURIComponent(conflictThread)}?agentId=opencode`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              requestId: 'req_real_external_writer',
              actor: { type: 'agent', agentId: 'opencode' },
              agentId: 'opencode',
              threadId: conflictThread,
              domain: `task:${conflictThread}`,
              summary: null,
              state: summaryOnlyCheckpointState(null, {
                threadId: conflictThread,
                domain: `task:${conflictThread}`,
              }),
              recordIds: [],
              detailIds: [],
              expiresAt: 0,
              expectedRevision: 0,
            }),
          },
        );
      }
      const response = await fetch(url, init);
      if (ingest) {
        ingestBodies.at(-1).status = response.status;
        const document = await response.clone().json().catch(() => null);
        ingestBodies.at(-1).error = document?.error?.code ?? null;
      }
      if (method === 'PUT' && pathname.includes('/checkpoints/')) {
        putBodies.push(requestBody);
        if (loseFirstCheckpointResponse) {
          loseFirstCheckpointResponse = false;
          // Drain the real response after the sidecar/capability commit. The
          // plugin sees a network failure and retries the same logical body.
          await response.text().catch(() => '');
          throw new Error('simulated lost checkpoint response');
        }
      }
      return response;
    };

    controller = createController({
      ctx: makeFakeCtx(),
      env: {},
      homeDir: mebularHome,
      config: {
        agentId: 'opencode',
        checkpointRetryMs: 100,
        checkpointPendingTimeoutMs: 20000,
        checkpointTimeoutMs: 3000,
        eventReconnectMs: 1000,
      },
      fetchImpl,
    });
    await controller.start();

    // H1: lost response after commit, retried with the same requestId/body.
    const idemThread = 'ses_real_idem';
    await controller.handleEvent({
      id: 'evt_real_idem',
      type: 'session.compaction.ended',
      data: {
        sessionID: idemThread,
        compactionId: 'cmp_real_idem',
        at: 1700000000000,
        reason: 'auto',
        messageCount: 2,
      },
    });
    check('丢响应后重试最终 committed', Boolean(await waitFor(
      () => controller.getStatus().counts.checkpoints.sent >= 1,
    ) && controller.getStatus().counts.checkpoints.pending === 0));
    const idemBody = putBodies.filter((body) => body.threadId === idemThread);
    check('首次提交与重试 body 完全一致（含 requestId/at）',
      idemBody.length >= 2 && JSON.stringify(idemBody[0]) === JSON.stringify(idemBody[1]),
      JSON.stringify(idemBody.map((body) => ({
        requestId: body.requestId,
        expectedRevision: body.expectedRevision,
        at: body.state?.at,
      }))));
    const idemCheckpoint = await runtime.sidecarCheckpoint(idemThread, 'opencode');
    check('真实图中只有一个 revision（丢响应重试）',
      idemCheckpoint?.revision === 1 && idemCheckpoint?.state?.compactionId === 'cmp_real_idem',
      JSON.stringify({ revision: idemCheckpoint?.revision, pending: idemCheckpoint?.pending }));

    // H1: same thread has a default-domain checkpoint. A task-domain GET must
    // not fall back to the default revision.
    const domainThread = 'ses_real_domain_scope';
    const defaultBody = {
      requestId: 'req_real_default_scope',
      actor: { type: 'agent', agentId: 'opencode' },
      agentId: 'opencode',
      threadId: domainThread,
      domain: 'default',
      summary: null,
      state: summaryOnlyCheckpointState(null, { threadId: domainThread, domain: 'default' }),
      recordIds: [],
      detailIds: [],
      expiresAt: 0,
      expectedRevision: 0,
    };
    const defaultCreated = await requestSidecar(
      discovery,
      `/checkpoints/${encodeURIComponent(domainThread)}?agentId=opencode`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(defaultBody),
      },
    );
    check('真实 default checkpoint 创建 revision 1',
      defaultCreated.status === 200 && defaultCreated.data?.checkpoint?.revision === 1,
      JSON.stringify({ status: defaultCreated.status, revision: defaultCreated.data?.checkpoint?.revision }));
    await controller.handleEvent({
      id: 'evt_real_domain_scope',
      type: 'session.compaction.ended',
      data: {
        sessionID: domainThread,
        compactionId: 'cmp_real_domain_scope',
        at: 1700000000000,
        reason: 'auto',
      },
    });
    check('task checkpoint 在 default 同 thread 下仍成功 revision 1', Boolean(await waitFor(
      () => controller.getStatus().counts.checkpoints.sent >= 2,
    )));
    const taskScoped = await runtime.sidecarCheckpoint(domainThread, 'opencode');
    const defaultScoped = await requestSidecar(
      discovery,
      `/checkpoints/${encodeURIComponent(domainThread)}?agentId=opencode&domain=default`,
    );
    check('task revision 1 且 default checkpoint 未变化',
      taskScoped?.domain === `task:${domainThread}`
      && taskScoped?.revision === 1
      && taskScoped?.state?.compactionId === 'cmp_real_domain_scope'
      && defaultScoped.data?.checkpoint?.domain === 'default'
      && defaultScoped.data?.checkpoint?.revision === 1
      && defaultScoped.data?.checkpoint?.state?.compactionId !== 'cmp_real_domain_scope',
      JSON.stringify({
        task: { domain: taskScoped?.domain, revision: taskScoped?.revision },
        default: {
          domain: defaultScoped.data?.checkpoint?.domain,
          revision: defaultScoped.data?.checkpoint?.revision,
        },
      }));
    const domainPut = putBodies.find((body) => body.threadId === domainThread);
    check('task checkpoint 首次 PUT expectedRevision=0',
      domainPut?.expectedRevision === 0,
      JSON.stringify({ expectedRevision: domainPut?.expectedRevision }));

    // M1: restart/fresh-envelope replay of the same logical compaction is a
    // no-op duplicate, not a new revision.
    const restartThread = 'ses_real_restart';
    const restartEvent = {
      id: 'evt_restart_1',
      type: 'session.compaction.ended',
      data: {
        sessionID: restartThread,
        compactionId: 'cmp_real_restart',
        at: 1700000000000,
        reason: 'auto',
      },
    };
    await controller.handleEvent(restartEvent);
    check('重启前 checkpoint committed', Boolean(await waitFor(
      () => controller.getStatus().counts.checkpoints.sent >= 3,
    )));
    const beforeRestart = await runtime.sidecarCheckpoint(restartThread, 'opencode');
    const ingestRestartEvent = {
      id: 'evt_ingest_restart',
      type: 'session.compaction.ended',
      data: {
        sessionID: 'ses_real_ingest_restart',
        compactionId: 'cmp_real_ingest_restart',
        at: 1700000000000,
        reason: 'auto',
        text: '以后默认用 ingest-restart 主题',
      },
    };
    await controller.handleEvent(ingestRestartEvent);
    const firstIngestBody = ingestBodies
      .filter((entry) => entry.body?.threadId === 'ses_real_ingest_restart')
      .at(-1);
    await controller.dispose();
    controller = createController({
      ctx: makeFakeCtx(),
      env: {},
      homeDir: mebularHome,
      config: {
        agentId: 'opencode',
        checkpointRetryMs: 100,
        checkpointPendingTimeoutMs: 20000,
        checkpointTimeoutMs: 3000,
      },
      fetchImpl,
    });
    await controller.start();
    await controller.handleEvent({
      ...restartEvent,
      id: 'evt_restart_fresh_envelope',
      data: { ...restartEvent.data, eventID: 'different_transport_event_id' },
    });
    const afterRestart = await runtime.sidecarCheckpoint(restartThread, 'opencode');
    check('重启/fresh envelope 重放同一逻辑 compaction 不新增 revision',
      beforeRestart?.revision === 1
      && afterRestart?.revision === 1
      && controller.getStatus().counts.checkpoints.duplicates >= 1,
      JSON.stringify({
        before: beforeRestart?.revision,
        after: afterRestart?.revision,
        duplicates: controller.getStatus().counts.checkpoints.duplicates,
      }));

    // M4: same event after restart must produce the same ingest body/requestId
    // (no wall-clock `at` in the idempotent body).
    await controller.handleEvent(ingestRestartEvent);
    await controller.whenIdle();
    const secondIngestBody = ingestBodies
      .filter((entry) => entry.body?.threadId === 'ses_real_ingest_restart')
      .at(-1);
    check('重启后同 requestId/ingest body 不产生 idempotency_conflict',
      Boolean(firstIngestBody)
      && Boolean(secondIngestBody)
      && JSON.stringify(firstIngestBody.body) === JSON.stringify(secondIngestBody.body)
      && firstIngestBody.status !== 409
      && secondIngestBody.status !== 409,
      JSON.stringify({
        firstStatus: firstIngestBody?.status,
        secondStatus: secondIngestBody?.status,
        firstError: firstIngestBody?.error,
        secondError: secondIngestBody?.error,
        firstRequestId: firstIngestBody?.body?.requestId,
        secondRequestId: secondIngestBody?.body?.requestId,
      }));

    // H1: real structured compaction replay must not bump revision after the
    // capability normalizes decisions/progress recordIds.
    const structuredThread = 'ses_real_structured';
    const structuredSummary = [
      '## Objective',
      'Ship structured checkpoint evidence.',
      '## Requirements',
      '- Keep schema 2',
      '## Decisions',
      '- Reuse checkpoint — no new endpoint',
      '## Work State',
      '- Done: evidence wiring',
      '- Doing: structured replay',
      '- Blocked: none',
      '## Next Move',
      '- Verify replay',
    ].join('\n');
    const structuredEvent = {
      id: 'evt_real_structured',
      type: 'session.compaction.ended',
      data: {
        sessionID: structuredThread,
        compactionId: 'cmp_real_structured',
        at: 1700000000000,
        reason: 'auto',
        text: structuredSummary,
      },
    };
    await controller.handleEvent(structuredEvent);
    await controller.handleEvent(structuredEvent);
    const structuredCheckpoint = await runtime.sidecarCheckpoint(structuredThread, 'opencode');
    check('真实结构化 compaction 同一事件重放 revision 不变',
      structuredCheckpoint?.revision === 1
      && structuredCheckpoint?.state?.contentMode === 'structured'
      && controller.getStatus().counts.checkpoints.updates === 0
      && controller.getStatus().counts.checkpoints.duplicates >= 1,
      JSON.stringify({
        revision: structuredCheckpoint?.revision,
        contentMode: structuredCheckpoint?.state?.contentMode,
        updates: controller.getStatus().counts.checkpoints.updates,
        duplicates: controller.getStatus().counts.checkpoints.duplicates,
      }));

    // M3: real sidecar ingest with a permanent detail-write failure must be
    // reported as partial, never committed.
    const partialThread = 'ses_real_partial';
    const committedBeforePartial = controller.getStatus().counts.ingest.committed;
    proxy.setFailDetail(true);
    await controller.handleContext({
      sessionID: partialThread,
      messages: [{ id: 'msg_partial_user', role: 'user', content: '以后默认用 partial-detail 主题' }],
      system: [],
      tools: {},
    });
    await controller.handleEvent({
      type: 'session.execution.succeeded',
      data: { sessionID: partialThread },
    });
    await controller.whenIdle();
    proxy.setFailDetail(false);
    const partialStatus = controller.getStatus();
    check('真实 partial 200（detail failed）不计入 committed',
      partialStatus.counts.ingest.partial >= 1
      && partialStatus.counts.ingest.committed === committedBeforePartial,
      JSON.stringify({
        partial: partialStatus.counts.ingest.partial,
        committed: partialStatus.counts.ingest.committed,
        accepted: partialStatus.counts.ingest.accepted,
        counts: partialStatus.counts.ingest,
      }));

    // H2: revision advances, delete, recreate with one conflict recovery.
    const revThread = 'ses_real_revision';
    const sendCompaction = async (compactionId) => {
      await controller.handleEvent({
        id: `evt_${compactionId}`,
        type: 'session.compaction.ended',
        data: {
          sessionID: revThread,
          compactionId,
          at: 1700000000000,
          reason: 'auto',
        },
      });
    };
    const sentBeforeRevision = controller.getStatus().counts.checkpoints.sent;
    await sendCompaction('cmp_real_rev_1');
    await sendCompaction('cmp_real_rev_2');
    check('连续 checkpoint 使用 expectedRevision 前进到 revision 2', Boolean(await waitFor(
      () => controller.getStatus().counts.checkpoints.sent >= sentBeforeRevision + 2,
    )));
    const revBodies = putBodies.filter((body) => body.threadId === revThread);
    check('真实 PUT 携带 expectedRevision 0 -> 1',
      revBodies.map((body) => body.expectedRevision).slice(0, 2).join(',') === '0,1',
      JSON.stringify(revBodies.map((body) => body.expectedRevision)));
    const rev2 = await runtime.sidecarCheckpoint(revThread, 'opencode');
    check('真实 capability revision=2', rev2?.revision === 2 && rev2?.pending === false,
      JSON.stringify({ revision: rev2?.revision }));

    const deleted = await requestSidecar(
      discovery,
      `/checkpoints/${encodeURIComponent(revThread)}?agentId=opencode`,
      { method: 'DELETE' },
    );
    check('真实 sidecar 删除 checkpoint', deleted.status === 200 && deleted.data?.deleted === true,
      JSON.stringify({ status: deleted.status, deleted: deleted.data?.deleted }));
    await sendCompaction('cmp_real_rev_3');
    check('删除后用权威 GET 重建提交', Boolean(await waitFor(
      () => controller.getStatus().counts.checkpoints.sent >= sentBeforeRevision + 3,
    )));
    const recreated = await runtime.sidecarCheckpoint(revThread, 'opencode');
    check('删除后重建不复用 revision（high-water 前进）',
      recreated?.revision === 3 && recreated?.state?.compactionId === 'cmp_real_rev_3',
      JSON.stringify({ revision: recreated?.revision, compactionId: recreated?.state?.compactionId }));

    // M2: a same-logical-id replay with new summary/refs must update, not
    // silently duplicate-skip.
    const evidenceThread = 'ses_real_evidence';
    await controller.handleEvent({
      id: 'evt_real_evidence_1',
      type: 'session.compaction.ended',
      data: {
        sessionID: evidenceThread,
        compactionId: 'cmp_real_evidence',
        at: 1700000000000,
        reason: 'auto',
      },
    });
    const evidenceInitial = await runtime.sidecarCheckpoint(evidenceThread, 'opencode');
    const evidenceRefs = await runtime.seedMemoryWithDetail({
      text: 'evidence update reference',
      namespace: `task:${evidenceThread}`,
      agentId: 'opencode',
      threadId: evidenceThread,
    });
    await controller.handleEvent({
      id: 'evt_real_evidence_2',
      type: 'session.compaction.ended',
      data: {
        sessionID: evidenceThread,
        compactionId: 'cmp_real_evidence',
        at: 1700000000000,
        reason: 'auto',
        text: '以后默认用 evidence-update 主题',
        recordIds: [evidenceRefs.recordId],
        detailIds: [evidenceRefs.detailId],
      },
    });
    const evidenceUpdated = await waitFor(async () => {
      const checkpoint = await runtime.sidecarCheckpoint(evidenceThread, 'opencode');
      return checkpoint?.revision === 2 ? checkpoint : null;
    });
    check('首次无 refs、重放有 summary 时显式更新；未验证外部 refs 被丢弃',
      evidenceInitial?.revision === 1
      && evidenceUpdated?.revision === 2
      && evidenceUpdated?.summary === '以后默认用 evidence-update 主题'
      && Array.isArray(evidenceUpdated?.recordIds)
      && evidenceUpdated.recordIds.length === 0
      && Array.isArray(evidenceUpdated?.detailIds)
      && evidenceUpdated.detailIds.length === 0
      && controller.getStatus().counts.checkpoints.updates >= 1
      && controller.getStatus().counts.checkpoints.droppedRefs >= 2,
      JSON.stringify({
        initial: evidenceInitial?.revision,
        updated: evidenceUpdated?.revision,
        summary: evidenceUpdated?.summary,
        records: evidenceUpdated?.recordIds,
        droppedRefs: controller.getStatus().counts.checkpoints.droppedRefs,
        updates: controller.getStatus().counts.checkpoints.updates,
      }));

    // M7: real revision conflict — another writer advances between the
    // plugin's GET and PUT. The plugin must re-read once and retry.
    const conflictThreadName = 'ses_real_conflict';
    conflictThread = conflictThreadName;
    const sentBeforeConflict = controller.getStatus().counts.checkpoints.sent;
    await controller.handleEvent({
      id: 'evt_real_conflict',
      type: 'session.compaction.ended',
      data: {
        sessionID: conflictThreadName,
        compactionId: 'cmp_real_conflict_plugin',
        at: 1700000000000,
        reason: 'auto',
      },
    });
    check('真实 GET/PUT 之间被另一写者推进后一次重读重试成功', Boolean(await waitFor(
      () => controller.getStatus().counts.checkpoints.sent === sentBeforeConflict + 1,
    )) && controller.getStatus().counts.checkpoints.conflicts >= 1
      && controller.getStatus().counts.checkpoints.failed === 0);
    const conflictCheckpoint = await runtime.sidecarCheckpoint(conflictThreadName, 'opencode');
    check('冲突恢复后 revision 前进到 2',
      conflictCheckpoint?.revision === 2
      && conflictCheckpoint?.state?.compactionId === 'cmp_real_conflict_plugin',
      JSON.stringify({
        revision: conflictCheckpoint?.revision,
        compactionId: conflictCheckpoint?.state?.compactionId,
      }));
    conflictThread = null;

    // M2: capability down -> PUT 202/outbox -> capability up -> one revision.
    const outboxThread = 'ses_real_outbox';
    proxy.pause();
    const sentBeforeOutbox = controller.getStatus().counts.checkpoints.sent;
    await controller.handleEvent({
      id: 'evt_real_outbox',
      type: 'session.compaction.ended',
      data: {
        sessionID: outboxThread,
        compactionId: 'cmp_real_outbox',
        at: 1700000000000,
        reason: 'auto',
      },
    });
    const queuedStatus = await waitFor(async () => {
      const status = await runtime.sidecarStatus();
      return outboxItems(status) > 0 ? status : null;
    });
    check('能力下线时 checkpoint 进入 sidecar outbox（202）',
      Boolean(queuedStatus) && controller.getStatus().counts.checkpoints.pending === 1,
      JSON.stringify({
        outbox: queuedStatus?.outbox,
        objectWritesQueued: queuedStatus?.counts?.objectWritesQueued,
        sent: controller.getStatus().counts.checkpoints.sent,
      }));
    check('能力下线时不把 202 当 committed',
      controller.getStatus().counts.checkpoints.sent === sentBeforeOutbox);
    const pendingResponse = await requestSidecar(
      discovery,
      `/checkpoints/${encodeURIComponent(outboxThread)}?agentId=opencode`,
    );
    const pendingData = pendingResponse.data ?? {};
    check('sidecar GET 分离 pending，不把 pending 当 committed',
      pendingData.checkpoint === null
        && pendingData.pending === true
        && pendingData.pendingCheckpoint?.pending === true
        && pendingData.pendingCheckpoint?.revision === null,
      JSON.stringify({
        checkpoint: pendingData.checkpoint,
        pending: pendingData.pending,
        pendingRevision: pendingData.pendingCheckpoint?.revision,
      }));

    proxy.resume();
    check('能力恢复后 outbox 重放并由权威 GET 确认为 committed', Boolean(await waitFor(
      () => controller.getStatus().counts.checkpoints.sent === sentBeforeOutbox + 1,
      { timeoutMs: 30000 },
    )));
    const drained = await waitFor(async () => {
      const status = await runtime.sidecarStatus();
      return outboxItems(status) === 0 ? status : null;
    });
    check('outbox 已清空且无 dead letter（能力恢复后重放成功）',
      Boolean(drained) && deadLetterItems(drained) === 0,
      JSON.stringify({ deadLetter: deadLetterItems(drained), counts: drained?.counts }));
    check('checkpoint 写失败计数为 0（revision 冲突计入 conflicts）',
      controller.getStatus().counts.checkpoints.failed === 0,
      JSON.stringify(controller.getStatus().counts.checkpoints));
    const outboxCheckpoint = await runtime.sidecarCheckpoint(outboxThread, 'opencode');
    check('202 恢复后只有一个 revision 且匹配 compactionId',
      outboxCheckpoint?.revision === 1
      && outboxCheckpoint?.pending === false
      && outboxCheckpoint?.state?.compactionId === 'cmp_real_outbox',
      JSON.stringify({
        revision: outboxCheckpoint?.revision,
        compactionId: outboxCheckpoint?.state?.compactionId,
        pending: outboxCheckpoint?.pending,
      }));
    const checkpointNodes = (await runtime.app.graph.listNodes({ type: 'context_checkpoint' }))
      .filter((node) => node?.namespace === `task:${outboxThread}`);
    check('真实图中只有一个 202 恢复后的 checkpoint 节点', checkpointNodes.length === 1,
      JSON.stringify({ nodes: checkpointNodes.length }));

    // M7: real instance switch. Start a second real runtime with its own MCP
    // capability, point the plugin's discovery at it, and verify the task
    // checkpoint updates in the new instance's revision space.
    const switchThread = 'ses_real_instance_switch';
    await controller.handleEvent({
      id: 'evt_instance_switch_a',
      type: 'session.compaction.ended',
      data: {
        sessionID: switchThread,
        compactionId: 'cmp_instance_switch_a',
        at: 1700000000000,
        reason: 'auto',
      },
    });
    const instanceACheckpoint = await runtime.sidecarCheckpoint(switchThread, 'opencode');
    const previousCapabilityForB = process.env.MEBULAR_CAPABILITY_URL;
    delete process.env.MEBULAR_CAPABILITY_URL;
    runtimeB = await startRealRuntime({
      root: join(root, 'instance-b'),
      memoryRuntime: { enabled: true },
      manageMemoryRuntime: true,
    });
    if (previousCapabilityForB === undefined) delete process.env.MEBULAR_CAPABILITY_URL;
    else process.env.MEBULAR_CAPABILITY_URL = previousCapabilityForB;
    const discoveryB = await runtimeB.waitForSidecar();
    const instanceBBody = {
      requestId: 'req_instance_b_initial',
      actor: { type: 'agent', agentId: 'opencode' },
      agentId: 'opencode',
      threadId: switchThread,
      domain: `task:${switchThread}`,
      summary: null,
      state: summaryOnlyCheckpointState(null, {
        threadId: switchThread,
        domain: `task:${switchThread}`,
      }),
      recordIds: [],
      detailIds: [],
      expiresAt: 0,
      expectedRevision: 0,
    };
    await requestSidecar(
      discoveryB,
      `/checkpoints/${encodeURIComponent(switchThread)}?agentId=opencode`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(instanceBBody),
      },
    );
    await writeFile(
      join(mebularHome, 'memory-runtime.json'),
      JSON.stringify(discoveryB),
      { encoding: 'utf8', mode: 0o600 },
    );
    await sleep(5100);
    await controller.handleContext({
      sessionID: switchThread,
      messages: [],
      system: [],
      tools: {},
    });
    await controller.handleEvent({
      id: 'evt_instance_switch_b',
      type: 'session.compaction.ended',
      data: {
        sessionID: switchThread,
        compactionId: 'cmp_instance_switch_b',
        at: 1700000000100,
        reason: 'auto',
      },
    });
    const instanceBCheckpoint = await runtimeB.sidecarCheckpoint(switchThread, 'opencode');
    const instanceAAfterResponse = await requestSidecar(
      discovery,
      `/checkpoints/${encodeURIComponent(switchThread)}?agentId=opencode`,
    );
    const instanceAAfter = instanceAAfterResponse.data?.checkpoint;
    check('真实实例切换后在新实例 revision 前进且旧实例不变',
      instanceACheckpoint?.revision === 1
      && instanceAAfter?.revision === 1
      && instanceBCheckpoint?.revision === 2
      && instanceBCheckpoint?.state?.compactionId === 'cmp_instance_switch_b',
      JSON.stringify({
        aBefore: instanceACheckpoint?.revision,
        aAfter: instanceAAfter?.revision,
        b: instanceBCheckpoint?.revision,
        runtimeUrl: controller.getStatus().runtime.url,
        discoveryB: discoveryB.url,
      }));

    const sidecarFinal = await requestSidecar(discovery, '/status');
    const sidecarCounts = sidecarFinal.data?.counts ?? {};
    check('sidecar objectWritesFailed 等于注入故障数且 deadLetter=0',
      sidecarCounts.objectWritesFailed === 1
      && sidecarCounts.deadLetter === 0,
      JSON.stringify({
        objectWritesFailed: sidecarCounts.objectWritesFailed,
        deadLetter: sidecarCounts.deadLetter,
      }));

    check('checkpoint 写失败计数为 0', controller.getStatus().counts.checkpoints.failed === 0,
      JSON.stringify(controller.getStatus().counts.checkpoints));
  } finally {
    if (previousCapabilityUrl === undefined) delete process.env.MEBULAR_CAPABILITY_URL;
    else process.env.MEBULAR_CAPABILITY_URL = previousCapabilityUrl;
    if (controller) await controller.dispose().catch(() => undefined);
    if (runtimeB) await runtimeB.cleanup().catch(() => undefined);
    if (runtime) await runtime.cleanup().catch(() => undefined);
    await proxy.close().catch(() => undefined);
  }

  const summaryPath = process.env.HOST_E2E_SUMMARY_FILE;
  if (summaryPath) {
    await writeFile(summaryPath, JSON.stringify({
      suite: 'opencode-checkpoint-recovery',
      passed,
      failed,
      checks: results.length,
    }, null, 2), 'utf8').catch(() => undefined);
  }
  console.log(`\n${failed === 0 ? '✓' : '✗'} OpenCode checkpoint recovery（真实 sidecar/capability，fake host）：${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ OpenCode checkpoint recovery 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
