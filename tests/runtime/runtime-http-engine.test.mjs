// /runtime/v1 完整路由：ingest / recall / context / checkpoint / compact / self / traces / mode gating。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';

describe('/runtime/v1 完整路由', () => {
  let home;
  let app;
  let server;
  let base;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mebular-runtime-http-engine-'));
    const master = await new IdentityManager().generateUserMasterKey();
    app = new Mebular({
      storagePath: join(home, 'device.jsonl'),
      deviceId: 'device-http-engine',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      sync: { autoSync: false },
    });
    await app.initialize();
    server = await startHttpServer({
      home,
      app,
      service: null,
      config: { runtime: { mode: 'immersive', capture: 'local' } },
      host: '127.0.0.1',
      port: 0,
      auth: 'none',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server?.close().catch(() => undefined);
    await app?.shutdown().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });

  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('读写路由端到端：统一信封、依赖对象、mode=mcp 写端点 409', async () => {
    const status = (await (await fetch(`${base}/runtime/v1/status`)).json());
    expect(status.ok).toBe(true);
    expect(status.data.capabilities).toMatchObject({
      ingest: true,
      recall: true,
      context: true,
      checkpoint: true,
      compact: true,
      rawCapture: 'local',
    });

    const ingest = await post('/runtime/v1/ingest', {
      requestId: 'req_http_1',
      agentId: 'opencode',
      threadId: 'th_http',
      namespace: 'notes',
      capture: 'local',
      chunks: [{ role: 'user', text: '以后默认用深色主题' }],
    });
    expect(ingest.status).toBe(200);
    const ingestBody = await ingest.json();
    expect(ingestBody).toMatchObject({ ok: true, data: { accepted: { chunks: 1, records: 1 }, duplicate: false } });
    expect(ingestBody.data.records[0]).toMatchObject({ kind: 'preference', namespace: 'notes' });

    const pending = await post('/runtime/v1/ingest', {
      requestId: 'req_http_pending',
      agentId: 'opencode',
      threadId: 'th_http',
      namespace: 'notes',
      extractor: 'host',
      capture: 'off',
      chunks: [{ role: 'user', text: '等待宿主候选' }],
    });
    expect(pending.status).toBe(202);
    const pendingBody = await pending.json();
    expect(pendingBody.data.extraction.status).toBe('pending');

    const extraction = await (await fetch(
      `${base}/runtime/v1/extractions/${pendingBody.data.extraction.id}`,
    )).json();
    expect(extraction.data.status).toBe('pending');
    const filled = await post(`/runtime/v1/extractions/${pendingBody.data.extraction.id}`, {
      candidates: [{ kind: 'fact', data: { subject: 'user', predicate: 'editor', object: 'Neovim' }, namespace: 'notes' }],
    });
    expect(filled.status).toBe(200);
    expect((await filled.json()).data.status).toBe('completed');

    const recall = await (await post('/runtime/v1/recall', {
      query: '深色',
      agentId: 'opencode',
      threadId: 'th_http',
      namespaces: ['notes'],
    })).json();
    expect(recall.data.records).toHaveLength(1);
    expect(recall.data.traceId).toMatch(/^tr_/);

    const context = await (await post('/runtime/v1/context', {
      agentId: 'opencode',
      threadId: 'th_http',
      query: '深色',
      namespaces: ['notes'],
      tokenBudget: 2000,
      includeSelf: true,
      includeCheckpoint: true,
    })).json();
    expect(context.data.blocks.every((block) => block.trusted === false)).toBe(true);
    expect(context.data.notice).toContain('不可信');

    const checkpoint = await fetch(`${base}/runtime/v1/checkpoints/th_http`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'opencode', state: { cursor: 1 }, summary: '第一步' }),
    });
    expect(checkpoint.status).toBe(200);
    const checkpointBody = await checkpoint.json();
    expect(checkpointBody.data.checkpoint).toMatchObject({ threadId: 'th_http', revision: 1, sync: 'local' });

    const gotCheckpoint = await (await fetch(
      `${base}/runtime/v1/checkpoints/th_http?agentId=opencode`,
    )).json();
    expect(gotCheckpoint.data.checkpoint).toMatchObject({ revision: 1, state: { cursor: 1 } });

    const compact = await (await post('/runtime/v1/compact', { namespace: 'notes' })).json();
    expect(compact.data.compactId).toBeTruthy();
    const compactGet = await (await fetch(
      `${base}/runtime/v1/compacts/${compact.data.compactId}`,
    )).json();
    expect(compactGet.data.compact).toMatchObject({ namespace: 'notes', stale: false });

    const selfPut = await fetch(`${base}/runtime/v1/self/opencode`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'OpenCode', goals: ['帮助用户'] }),
    });
    expect(selfPut.status).toBe(200);
    expect((await selfPut.json()).data.self).toMatchObject({ agentId: 'opencode', revision: 1 });
    const selfGet = await (await fetch(`${base}/runtime/v1/self/opencode`)).json();
    expect(selfGet.data.self).toMatchObject({ displayName: 'OpenCode', revision: 1 });

    const object = await (await fetch(
      `${base}/runtime/v1/objects/${compact.data.compactId}?includeContent=true`,
    )).json();
    expect(object.data.object).toMatchObject({ id: compact.data.compactId, internal: true, kind: 'compact' });
    expect(object.data.object.content).toMatchObject({ sourceIds: expect.any(Array) });

    const traces = await (await fetch(`${base}/runtime/v1/traces`)).json();
    expect(traces.data.traces.length).toBeGreaterThan(0);
    const trace = await (await fetch(
      `${base}/runtime/v1/traces/${recall.data.traceId}`,
    )).json();
    expect(trace.data.trace).toMatchObject({ id: recall.data.traceId, agentId: 'opencode' });

    const feedback = await post(`/runtime/v1/recall/${recall.data.traceId}/feedback`, {
      useful: true,
      reason: '命中偏好',
    });
    expect((await feedback.json()).data).toEqual({ recorded: true });

    // 切回 mcp：写端点 409 mode_mismatch，读端点仍可用。
    const mode = await post('/runtime/v1/mode', { mode: 'mcp' });
    expect((await mode.json()).data.mode).toBe('mcp');

    const blockedIngest = await post('/runtime/v1/ingest', {
      agentId: 'opencode',
      capture: 'off',
      chunks: [{ role: 'user', text: '以后默认用浅色主题' }],
    });
    expect(blockedIngest.status).toBe(409);
    expect((await blockedIngest.json()).error.code).toBe('mode_mismatch');

    const blockedCompact = await post('/runtime/v1/compact', { namespace: 'notes' });
    expect(blockedCompact.status).toBe(409);

    const blockedCheckpoint = await fetch(`${base}/runtime/v1/checkpoints/th_http`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'opencode', state: { cursor: 2 } }),
    });
    expect(blockedCheckpoint.status).toBe(409);

    const readRecall = await post('/runtime/v1/recall', {
      query: '深色',
      agentId: 'opencode',
      namespaces: ['notes'],
    });
    expect(readRecall.status).toBe(200);
    expect((await readRecall.json()).data.records).toHaveLength(1);
    const readCheckpoint = await fetch(`${base}/runtime/v1/checkpoints/th_http?agentId=opencode`);
    expect(readCheckpoint.status).toBe(200);
    expect((await readCheckpoint.json()).data.checkpoint).toMatchObject({ revision: 1 });
  });
});
