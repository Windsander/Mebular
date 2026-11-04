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
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createController } from '../../../packages/opencode-plugin/index.js';
import { requestSidecar, startRealRuntime } from './lib/real-runtime.mjs';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startCapabilityProxy(port, targetPort) {
  let paused = false;
  const server = createHttpServer((req, res) => {
    if (paused) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: { code: 'capability_unavailable', message: 'proxy paused', retryable: true },
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
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: { code: 'capability_unavailable', message: 'proxy upstream failed', retryable: true },
        }));
      } else {
        res.end();
      }
    });
    req.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    pause() { paused = true; },
    resume() { paused = false; },
    close: () => new Promise((resolve) => server.close(resolve)),
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

  const mcpPort = await getFreePort();
  const proxyPort = await getFreePort();
  const proxy = await startCapabilityProxy(proxyPort, mcpPort);
  const previousCapabilityUrl = process.env.MEBULAR_CAPABILITY_URL;
  process.env.MEBULAR_CAPABILITY_URL = proxy.url;

  let runtime = null;
  let controller = null;
  try {
    runtime = await startRealRuntime({
      root,
      port: mcpPort,
      memoryRuntime: { enabled: true },
      manageMemoryRuntime: true,
    });
    const discovery = await runtime.waitForSidecar();
    if (previousCapabilityUrl === undefined) delete process.env.MEBULAR_CAPABILITY_URL;
    else process.env.MEBULAR_CAPABILITY_URL = previousCapabilityUrl;

    const putBodies = [];
    let loseFirstCheckpointResponse = true;
    const fetchImpl = async (url, init = {}) => {
      const response = await fetch(url, init);
      const pathname = new URL(url).pathname;
      const method = init.method ?? 'GET';
      if (method === 'PUT' && pathname.includes('/checkpoints/')) {
        const body = JSON.parse(init.body);
        putBodies.push(body);
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
    const conflictsBefore = controller.getStatus().counts.checkpoints.conflicts;
    await sendCompaction('cmp_real_rev_3');
    check('删除后重建通过一次冲突恢复提交', Boolean(await waitFor(
      () => controller.getStatus().counts.checkpoints.sent >= sentBeforeRevision + 3,
    )) && controller.getStatus().counts.checkpoints.conflicts >= conflictsBefore + 1);
    const recreated = await runtime.sidecarCheckpoint(revThread, 'opencode');
    check('删除后重建为 revision 1',
      recreated?.revision === 1 && recreated?.state?.compactionId === 'cmp_real_rev_3',
      JSON.stringify({ revision: recreated?.revision, compactionId: recreated?.state?.compactionId }));

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
    const pendingView = await runtime.sidecarCheckpoint(outboxThread, 'opencode');
    check('sidecar GET 呈现 pending 而非 committed revision',
      pendingView?.pending === true && pendingView?.revision === null,
      JSON.stringify({ pending: pendingView?.pending, revision: pendingView?.revision }));

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
      Boolean(drained) && (drained?.deadLetter ?? 0) === 0,
      JSON.stringify(drained?.counts));
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

    check('checkpoint 写失败计数为 0', controller.getStatus().counts.checkpoints.failed === 0,
      JSON.stringify(controller.getStatus().counts.checkpoints));
  } finally {
    if (previousCapabilityUrl === undefined) delete process.env.MEBULAR_CAPABILITY_URL;
    else process.env.MEBULAR_CAPABILITY_URL = previousCapabilityUrl;
    if (controller) await controller.dispose().catch(() => undefined);
    await proxy.close().catch(() => undefined);
    if (runtime) await runtime.cleanup().catch(() => undefined);
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
