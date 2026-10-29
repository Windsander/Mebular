// Runtime 跨设备验收（真实 HTTP /runtime/v1 + 真实 SyncManager）。
//
// 两个临时 home，各自启动独立 HTTP 端点；A 用沉浸式写入，B 初始为轻量模式。
// 同步仍走真实 SecureChannel + SyncManager，不使用内存假图。
//
// 覆盖：HTTP 写入的 MemoryRecord/Compact/SelfRecord/云 Checkpoint 跨设备可见；
// 本地 Checkpoint、Raw、Trace 不跨设备；Self/Checkpoint 跨 Agent 隔离；
// 普通对象与内部对象在 HTTP 读取面的区分；B 独立切模式后写入再同步回 A；
// 重复同步幂等。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import { SecureChannelSyncTransport } from '../../src/sync/protocol.js';

const SECRET_RAW = 'HTTP-RAW-SECRET-2b7d-不要跨设备';

describe('/runtime/v1 跨设备（真实 HTTP + 真实同步）', () => {
  let home;
  let hub;
  let master;
  let a;
  let b;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mebular-runtime-cross-http-'));
    hub = new InMemoryHub();
    const key = await new IdentityManager().generateUserMasterKey();
    master = { userMasterKey: key.publicKey, userMasterPrivateKey: key.privateKey };
    a = await startDevice('device-A', {
      runtime: { mode: 'immersive', capture: 'local', checkpoint: { sync: 'cloud' } },
    });
    b = await startDevice('device-B', {
      runtime: { mode: 'mcp', capture: 'off', checkpoint: { sync: 'local' } },
    });
  });

  afterEach(async () => {
    await b?.server.close().catch(() => undefined);
    await a?.server.close().catch(() => undefined);
    await b?.app.shutdown().catch(() => undefined);
    await a?.app.shutdown().catch(() => undefined);
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function startDevice(deviceId, config) {
    const deviceHome = join(home, deviceId);
    const app = new Mebular({
      storagePath: join(deviceHome, 'device.jsonl'),
      deviceId,
      encryption: master,
      sync: {
        autoSync: false,
        syncStatePath: join(deviceHome, 'sync-state.json'),
      },
    });
    await app.initialize();
    const server = await startHttpServer({
      home: deviceHome,
      app,
      service: null,
      config,
      host: '127.0.0.1',
      port: 0,
      auth: 'none',
    });
    return { app, server, base: `http://127.0.0.1:${server.port}` };
  }

  function peerIdOf(device) {
    const identity = device.app.identity.getDeviceKey(device.app.deviceId);
    if (!identity) throw new Error(`missing device identity: ${device.app.deviceId}`);
    return {
      id: device.app.deviceId,
      multihash: identity.publicKey,
      pubKey: identity.publicKey,
    };
  }

  function syncPeerOf(device) {
    return { deviceId: device.app.deviceId, publicKey: peerIdOf(device).pubKey };
  }

  async function syncDevices(left, right) {
    const [connLeft, connRight] = hub.createLinkedPair(peerIdOf(left), peerIdOf(right));
    const channelLeft = new SecureChannelImpl(connLeft);
    const channelRight = new SecureChannelImpl(connRight);
    await Promise.all([channelLeft.start(), channelRight.start()]);
    const transportLeft = new SecureChannelSyncTransport(channelLeft);
    const transportRight = new SecureChannelSyncTransport(channelRight);
    try {
      return await Promise.all([
        left.app.sync.syncWithDevice(transportLeft, syncPeerOf(right), { direction: 'bidirectional' }),
        right.app.sync.acceptSync(transportRight, syncPeerOf(left)),
      ]);
    } finally {
      await Promise.allSettled([transportLeft.close(), transportRight.close()]);
    }
  }

  async function request(device, path, options = {}) {
    const { method = 'GET', body } = options;
    const response = await fetch(`${device.base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json();
    return { status: response.status, body: json };
  }

  const get = (device, path) => request(device, path);
  const post = (device, path, body) => request(device, path, { method: 'POST', body });
  const put = (device, path, body) => request(device, path, { method: 'PUT', body });

  it('HTTP 读写：共享对象同步、本地对象不外泄、跨 Agent 隔离、模式独立切换', async () => {
    const ingest = await post(a, '/runtime/v1/ingest', {
      requestId: 'req_http_shared',
      agentId: 'opencode',
      threadId: 'th_http_shared',
      namespace: 'notes',
      capture: 'local',
      extractor: 'host',
      chunks: [{ role: 'user', text: SECRET_RAW }],
      candidates: [
        {
          kind: 'fact',
          data: { subject: 'user', predicate: 'editor', object: 'Neovim' },
          namespace: 'notes',
        },
        {
          kind: 'preference',
          data: { entity: 'user', preferenceType: 'theme', value: 'dark' },
          namespace: 'notes',
        },
      ],
    });
    expect(ingest.status).toBe(200);
    expect(ingest.body.ok).toBe(true);
    expect(ingest.body.data.records).toHaveLength(2);
    expect(ingest.body.data.rawChunkIds).toHaveLength(1);
    const [editorRecord, preferenceRecord] = ingest.body.data.records;
    expect(editorRecord).toMatchObject({ type: 'fact', kind: 'fact', namespace: 'notes' });
    expect(preferenceRecord).toMatchObject({ type: 'fact', kind: 'preference', namespace: 'notes' });

    const compact = await post(a, '/runtime/v1/compact', { namespace: 'notes' });
    expect(compact.status).toBe(200);
    const compactId = compact.body.data.compactId;
    expect(compactId).toBeTruthy();

    const selfOpen = await put(a, '/runtime/v1/self/opencode', {
      displayName: 'OpenCode',
      goals: ['共享目标'],
    });
    expect(selfOpen.status).toBe(200);
    const selfHelper = await put(a, '/runtime/v1/self/helper', {
      displayName: 'Helper',
      goals: ['助手目标'],
    });
    expect(selfHelper.status).toBe(200);

    const cloudOpen = await put(a, '/runtime/v1/checkpoints/th_http_cloud', {
      agentId: 'opencode',
      state: { owner: 'opencode', cursor: 1 },
      summary: 'opencode checkpoint',
      sync: 'cloud',
    });
    expect(cloudOpen.status).toBe(200);
    expect(cloudOpen.body.data.checkpoint).toMatchObject({ revision: 1, sync: 'cloud' });
    const cloudHelper = await put(a, '/runtime/v1/checkpoints/th_http_cloud', {
      agentId: 'helper',
      state: { owner: 'helper' },
      summary: 'helper checkpoint',
      sync: 'cloud',
    });
    expect(cloudHelper.status).toBe(200);
    const localCheckpoint = await put(a, '/runtime/v1/checkpoints/th_http_local', {
      agentId: 'opencode',
      state: { localOnly: true },
      sync: 'local',
    });
    expect(localCheckpoint.status).toBe(200);
    expect(localCheckpoint.body.data.checkpoint).toMatchObject({ revision: 1, sync: 'local' });

    const aRecall = await post(a, '/runtime/v1/recall', {
      query: 'Neovim',
      agentId: 'opencode',
      namespaces: ['notes'],
    });
    expect(aRecall.status).toBe(200);
    expect(aRecall.body.data.records.map((record) => record.id)).toContain(editorRecord.id);
    const aTraceId = aRecall.body.data.traceId;
    expect(aTraceId).toMatch(/^tr_/);

    const aStatus = await get(a, '/runtime/v1/status');
    expect(aStatus.body.data.counts.localRawChunks).toBe(1);

    await syncDevices(a, b);

    // B 仍是轻量模式，但读端点可用；身份 cloudId 与 A 相同。
    const bStatus = await get(b, '/runtime/v1/status');
    expect(bStatus.status).toBe(200);
    expect(bStatus.body.data.mode).toBe('mcp');
    expect(bStatus.body.data.identity.cloudId).toBe(aStatus.body.data.identity.cloudId);
    expect(bStatus.body.data.identity.userId).toBe(aStatus.body.data.identity.userId);

    // Raw/Trace 没有跨设备；A 的 traceId 在 B 是 404。
    expect(bStatus.body.data.counts.localRawChunks).toBe(0);
    const bTraces = await get(b, '/runtime/v1/traces');
    expect(bTraces.body.data.traces).toEqual([]);
    const leakedTrace = await get(b, `/runtime/v1/traces/${aTraceId}`);
    expect(leakedTrace.status).toBe(404);

    // 共享记录/compact/self/云 checkpoint 在 B 可读。
    const bRecall = await post(b, '/runtime/v1/recall', {
      query: 'Neovim',
      agentId: 'opencode',
      namespaces: ['notes'],
    });
    expect(bRecall.status).toBe(200);
    expect(bRecall.body.data.records.map((record) => record.id)).toContain(editorRecord.id);

    const bCompact = await get(b, `/runtime/v1/compacts/${compactId}`);
    expect(bCompact.status).toBe(200);
    expect(bCompact.body.data.compact).toMatchObject({ namespace: 'notes', stale: false });

    const bSelfOpen = await get(b, '/runtime/v1/self/opencode');
    expect(bSelfOpen.body.data.self).toMatchObject({
      displayName: 'OpenCode',
      goals: ['共享目标'],
      agentId: 'opencode',
    });
    const bSelfHelper = await get(b, '/runtime/v1/self/helper');
    expect(bSelfHelper.body.data.self).toMatchObject({
      displayName: 'Helper',
      goals: ['助手目标'],
      agentId: 'helper',
    });
    const bSelfOther = await get(b, '/runtime/v1/self/other-agent');
    expect(bSelfOther.body.data.self).toBeNull();

    const bCloudOpen = await get(b, '/runtime/v1/checkpoints/th_http_cloud?agentId=opencode');
    expect(bCloudOpen.body.data.checkpoint).toMatchObject({
      revision: 1,
      state: { owner: 'opencode', cursor: 1 },
      sync: 'cloud',
    });
    const bCloudHelper = await get(b, '/runtime/v1/checkpoints/th_http_cloud?agentId=helper');
    expect(bCloudHelper.body.data.checkpoint).toMatchObject({
      state: { owner: 'helper' },
      summary: 'helper checkpoint',
    });
    const bLocal = await get(b, '/runtime/v1/checkpoints/th_http_local?agentId=opencode');
    expect(bLocal.body.data.checkpoint).toBeNull();
    const bLocalExplicit = await get(
      b,
      '/runtime/v1/checkpoints/th_http_local?agentId=opencode&sync=local',
    );
    expect(bLocalExplicit.body.data.checkpoint).toBeNull();

    // 普通对象与内部对象在 admin 调试读取面上可区分。
    const compactObject = await get(b, `/runtime/v1/objects/${compactId}?includeContent=true`);
    expect(compactObject.body.data.object).toMatchObject({
      id: compactId,
      internal: true,
      kind: 'compact',
    });
    const recordObject = await get(b, `/runtime/v1/objects/${editorRecord.id}`);
    expect(recordObject.body.data.object).toMatchObject({
      id: editorRecord.id,
      type: 'fact',
      internal: false,
      namespace: 'notes',
    });

    // 轻量模式下写端点 409；读端点仍可用。
    const blockedIngest = await post(b, '/runtime/v1/ingest', {
      agentId: 'opencode',
      capture: 'off',
      chunks: [{ role: 'user', text: 'mcp 模式不应写入' }],
    });
    expect(blockedIngest.status).toBe(409);
    expect(blockedIngest.body.error.code).toBe('mode_mismatch');

    // 模式是设备级：B 独立切到 immersive 后写入，再同步回 A。
    const mode = await post(b, '/runtime/v1/mode', { mode: 'immersive' });
    expect(mode.status).toBe(200);
    expect(mode.body.data.mode).toBe('immersive');

    const bIngest = await post(b, '/runtime/v1/ingest', {
      requestId: 'req_http_from_b',
      agentId: 'helper',
      threadId: 'th_http_from_b',
      namespace: 'notes',
      capture: 'off',
      extractor: 'host',
      candidates: [{
        kind: 'fact',
        data: { subject: 'user', predicate: 'http_owner', object: 'device-B' },
        namespace: 'notes',
      }],
    });
    expect(bIngest.status).toBe(200);
    const bRecord = bIngest.body.data.records[0];

    await syncDevices(a, b);
    const aRecallB = await post(a, '/runtime/v1/recall', {
      query: 'device-B',
      agentId: 'opencode',
      namespaces: ['notes'],
    });
    expect(aRecallB.body.data.records.map((record) => record.id)).toContain(bRecord.id);

    // 重复同步幂等：两端节点数不变。
    const nodesA = (await a.app.graph.listNodes({})).length;
    const nodesB = (await b.app.graph.listNodes({})).length;
    await syncDevices(a, b);
    await syncDevices(a, b);
    expect((await a.app.graph.listNodes({})).length).toBe(nodesA);
    expect((await b.app.graph.listNodes({})).length).toBe(nodesB);
  });
});
