// 0.3 验收：跨设备 / 跨 Agent / 删除 / 归档 / Raw 隔离。
//
// 链路：真实 Mebular app（独立 home、同一 master key、不同 deviceId）
//       → 真实 startHttpServer + /internal/memory/v1
//       → 真实 supervisor 启动的 Memory Runtime sidecar
//       → 真实 SecureChannel + SyncManager 同步。
//
// 不启动模型、不访问外部网络；所有 home 在 afterAll 清理。

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';

import { createCluster } from './lib/cluster.mjs';

jest.setTimeout(180_000);

const RUN = randomUUID().slice(0, 8);
const SECRET_RAW = `RAW-SECRET-${RUN}-不要跨设备`;
const POLICY_B = {
  schema: 1,
  agents: {
    opencode: {
      readDomains: ['user', 'default', 'agent:opencode', 'agent:hermes', 'agent:compactor', 'task:*', 'shared'],
      writeDomains: ['user', 'default', 'agent:opencode', 'task:*', 'shared'],
      userWriteConfirmation: true,
    },
  },
};

function assertOk(result, label) {
  if (result.status !== 200 || result.body?.ok !== true) {
    throw new Error(`${label} 失败：${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.data;
}

function fragmentFor(recall, marker) {
  return (recall.fragments ?? []).find((fragment) => String(fragment.gist ?? '').includes(marker));
}

describe('0.3 共享记忆：真实 sidecar + capability + 设备同步', () => {
  let cluster;
  let a;
  let b;
  let sync;

  beforeAll(async () => {
    cluster = await createCluster({ b: { sidecarPolicy: POLICY_B } });
    a = cluster.a;
    b = cluster.b;
    sync = cluster.sync;
  });

  afterAll(async () => {
    await cluster?.cleanup();
  });

  it('A sidecar ingest 用户偏好 → capability → 同步 → B recall 带 A provenance', async () => {
    const marker = `SHARED-PREF-${RUN}`;
    const threadId = `th_shared_${RUN}`;
    const ingest = await a.sidecar.ingest({
      requestId: `req_shared_${RUN}`,
      agentId: 'hermes',
      agentName: 'Hermes',
      threadId,
      extractor: 'host',
      chunks: [{ role: 'user', text: `${SECRET_RAW} ${marker}`, messageId: `m_shared_${RUN}` }],
      candidates: [{
        kind: 'preference',
        content: { entity: 'user', preferenceType: 'theme', value: marker, confidence: 0.93 },
        domain: 'user',
        confirmation: 'explicit',
      }],
    });
    const data = assertOk(ingest, 'A ingest');
    expect(data.queued).toBe(false);
    expect(data.records).toHaveLength(1);
    expect(data.records[0].domain).toBe('user');
    expect(data.detailIds.length).toBeGreaterThan(0);

    // 成功沉降后 staging 清理；详情权威在 capability 图/事件日志。
    expect((await a.sidecar.stagingTexts()).some((text) => text.includes(SECRET_RAW))).toBe(false);

    // A 本机 recall 产生一条本地 trace（只在本机）。
    const recallA = assertOk(await a.sidecar.recall({
      agentId: 'hermes',
      query: marker,
      domains: ['user'],
    }), 'A recall');
    expect(fragmentFor(recallA, marker)).toBeDefined();
    const fragmentA = fragmentFor(recallA, marker);
    const expansionA = assertOk(await a.sidecar.expand(recallA.recallId, {
      agentId: 'hermes',
      fragmentId: fragmentA.id,
    }), 'A expand');
    expect(expansionA.detail.text).toContain(SECRET_RAW);

    await sync();

    const recallResult = await b.sidecar.recall({
      agentId: 'opencode',
      threadId: `th_recall_${RUN}`,
      query: marker,
      domains: ['user'],
    });
    const recall = assertOk(recallResult, 'B recall');
    const fragment = fragmentFor(recall, marker);
    expect(fragment).toBeDefined();
    expect(fragment.owner).toMatchObject({ role: 'user', domain: 'user' });
    expect(fragment.provenance.agentId).toBe('hermes');
    expect(fragment.provenance.agentName).toBe('Hermes');
    expect(fragment.provenance.deviceId).toBe(a.deviceId);
    expect(fragment.provenance.deviceId).not.toBe(b.deviceId);
    expect(fragment.provenance.hostId).toEqual(expect.any(String));
    // 详情随域同步：B 在保留期内可以展开原文，不再依赖写入设备。
    expect(fragment.detailAvailable).toBe(true);
    expect(fragment.detailAvailability).toContain('available');
    expect(fragment.detailIds.length).toBeGreaterThan(0);
    const expansionB = assertOk(await b.sidecar.expand(recall.recallId, {
      agentId: 'opencode',
      threadId: `th_recall_${RUN}`,
      fragmentId: fragment.id,
    }), 'B expand');
    expect(expansionB.detail).toMatchObject({ format: 'verbatim', source: 'capability', stale: false });
    expect(expansionB.detail.text).toContain(SECRET_RAW);
    expect(expansionB.detail.citations[0]).toMatchObject({ type: 'detail_record', domain: 'user' });

    // 本机 staging / Trace 不跨设备；B 的图/事件里可以有详情，但日志不含正文。
    expect(await b.sidecar.stagingTexts()).toEqual([]);
    const bTraces = await b.sidecar.traces();
    expect(bTraces.length).toBeGreaterThan(0);
    expect(JSON.stringify(bTraces)).not.toContain(SECRET_RAW);
    const bStatus = await b.capability.status('opencode');
    expect(bTraces.every((trace) => trace.hostId === bStatus.identity.hostId)).toBe(true);
    expect(fragment.provenance.hostId).not.toBe(bStatus.identity.hostId);
    expect(JSON.stringify(bStatus)).not.toContain(SECRET_RAW);
    expect(JSON.stringify(await b.sidecar.status())).not.toContain(SECRET_RAW);

    // A 自己的 trace 仍在本机（证明 trace 确实产生，只是没有同步）。
    const aStatus = await a.capability.status('hermes');
    const aTraces = await a.sidecar.traces();
    expect(aTraces.length).toBeGreaterThan(0);
    expect(aTraces.every((trace) => trace.hostId === aStatus.identity.hostId)).toBe(true);
    expect(fragment.provenance.hostId).toBe(aStatus.identity.hostId);
    expect(bTraces.map((trace) => trace.id)).not.toContain(aTraces[0].id);
    expect(aStatus.identity.hostId).not.toBe(bStatus.identity.hostId);

    // /context 也返回同一份跨设备记忆（组装块不被当成系统指令）。
    const context = assertOk(await b.sidecar.context({
      agentId: 'opencode',
      threadId: `th_context_${RUN}`,
      query: marker,
      domains: ['user'],
    }), 'B context');
    expect(context.blocks.length).toBeGreaterThan(0);
    expect(context.blocks.some((block) => String(block.content).includes(marker))).toBe(true);
    expect(context.trusted).toBe(false);
    expect(context.untrusted).toBe(true);

    // capability 直读也能看到同一条记录与 A 的归属。
    const direct = assertOk(await b.capability.query({
      query: marker,
      agentId: 'opencode',
      domains: ['user'],
    }), 'B capability query');
    expect(direct.records).toHaveLength(1);
    expect(direct.records[0]).toMatchObject({
      domain: 'user',
      ownerType: 'user',
      kind: 'preference',
    });
    expect(direct.records[0].provenance).toMatchObject({
      deviceId: a.deviceId,
      agentId: 'hermes',
      agentName: 'Hermes',
    });
    expect(direct.records[0].content).toMatchObject({
      subject: 'user',
      predicate: 'theme',
      object: marker,
    });
  });

  it('域路由：user / agent:<id> / default / task:<threadId>', async () => {
    const userMarker = `USER-FACT-${RUN}`;
    const obsMarker = `OBS-${RUN}`;
    const defaultMarker = `DEFAULT-FACT-${RUN}`;
    const threadId = `th_task_${RUN}`;

    const userIngest = assertOk(await a.sidecar.ingest({
      requestId: `req_user_${RUN}`,
      agentId: 'hermes',
      agentName: 'Hermes',
      extractor: 'host',
      chunks: [{ role: 'user', text: userMarker }],
      candidates: [{
        kind: 'fact',
        domain: 'user',
        confirmation: 'explicit',
        content: { subject: 'user', predicate: 'workspace', object: userMarker },
      }],
    }), 'user ingest');
    expect(userIngest.records[0].domain).toBe('user');

    const obsIngest = assertOk(await a.sidecar.ingest({
      requestId: `req_obs_${RUN}`,
      agentId: 'hermes',
      agentName: 'Hermes',
      extractor: 'host',
      chunks: [{ role: 'user', text: obsMarker }],
      candidates: [{
        kind: 'observation',
        content: { content: `${obsMarker} 端口是 7731` },
      }],
    }), 'agent observation ingest');
    expect(obsIngest.records[0].domain).toBe('agent:hermes');
    expect(obsIngest.records[0].type).toBe('episode');

    const defaultIngest = assertOk(await a.sidecar.ingest({
      requestId: `req_default_${RUN}`,
      agentId: 'hermes',
      agentName: 'Hermes',
      extractor: 'host',
      chunks: [{ role: 'user', text: defaultMarker }],
      candidates: [{
        kind: 'fact',
        content: { subject: 'acme', predicate: 'code', object: defaultMarker },
      }],
    }), 'default ingest');
    expect(defaultIngest.records[0].domain).toBe('default');

    const checkpointResult = await a.sidecar.putCheckpoint(threadId, {
      agentId: 'hermes',
      state: {
        schema: 2,
        contentMode: 'structured',
        task: { key: `task:${threadId}`, threadId, fleetTaskId: null },
        goal: `CP-${RUN}`,
        nextSteps: [{ id: 'n1', text: 'continue' }],
        references: { recordIds: [], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
        cursor: 3,
      },
      summary: `CP-${RUN}`,
    });
    const checkpoint = assertOk(checkpointResult, 'task checkpoint put').checkpoint;
    expect(checkpoint).toMatchObject({
      domain: `task:${threadId}`,
      namespace: `task:${threadId}`,
      ownerType: 'other',
      ownerId: `task:${threadId}`,
      agentId: 'hermes',
      threadId,
      internal: true,
      source: 'cloud',
    });

    // 用户事实/偏好必须在 user；Agent 观察在自己的域；未分类事实在 default。
    const userRecords = assertOk(await a.capability.query({
      query: userMarker,
      agentId: 'hermes',
      domains: ['user'],
    }), 'user query');
    expect(userRecords.records).toHaveLength(1);
    expect(userRecords.records[0]).toMatchObject({
      domain: 'user',
      ownerType: 'user',
      kind: 'fact',
    });

    const agentRecords = assertOk(await a.capability.query({
      query: obsMarker,
      agentId: 'hermes',
      domains: ['agent:hermes'],
    }), 'agent query');
    expect(agentRecords.records).toHaveLength(1);
    expect(agentRecords.records[0]).toMatchObject({
      type: 'episode',
      domain: 'agent:hermes',
      ownerType: 'agent',
      ownerId: 'hermes',
      kind: 'observation',
    });
    // 观察与公共 memory_write 一致，落为 episode(observation)；正文保留在 content 与 text。
    expect(agentRecords.records[0].content).toMatchObject({
      episodeType: 'observation',
      content: `${obsMarker} 端口是 7731`,
    });
    expect(agentRecords.records[0].text).toBe(`${obsMarker} 端口是 7731`);
    expect(agentRecords.records[0].provenance).toMatchObject({
      agentId: 'hermes',
      agentName: 'Hermes',
      deviceId: a.deviceId,
    });

    const defaultRecords = assertOk(await a.capability.query({
      query: defaultMarker,
      agentId: 'hermes',
      domains: ['default'],
    }), 'default query');
    expect(defaultRecords.records).toHaveLength(1);
    expect(defaultRecords.records[0]).toMatchObject({
      domain: 'default',
      ownerType: 'other',
      ownerId: 'default',
    });

    // 同一线程的 checkpoint 始终在 task:<threadId>，不是本地权威。
    const checkpointNode = (await a.app.graph.listNodes({ type: 'context_checkpoint' }))
      .find((node) => node.id === checkpoint.id);
    expect(checkpointNode).toBeDefined();
    expect(checkpointNode.namespace).toBe(`task:${threadId}`);
  });

  it('跨 Agent：显式读取保留归属；不能写 agent:A；SelfRecord 按 agentId 隔离', async () => {
    const marker = `CROSS-${RUN}`;
    const selfGoal = `SELF-HERMES-${RUN}`;
    const opencodeGoal = `SELF-OPENCODE-${RUN}`;

    const ingest = assertOk(await a.sidecar.ingest({
      requestId: `req_cross_${RUN}`,
      agentId: 'hermes',
      agentName: 'Hermes',
      extractor: 'host',
      chunks: [{ role: 'user', text: marker }],
      candidates: [{
        kind: 'fact',
        domain: 'agent:hermes',
        content: { subject: 'hermes', predicate: 'learned', object: marker },
      }],
    }), 'cross-agent ingest');
    expect(ingest.records[0].domain).toBe('agent:hermes');

    const selfResult = await a.sidecar.putSelf('hermes', {
      displayName: 'Hermes',
      goals: [selfGoal],
    });
    expect(assertOk(selfResult, 'hermes self put').selfRecord).toMatchObject({
      domain: 'agent:hermes',
      agentId: 'hermes',
      source: 'cloud',
    });
    const bSelfResult = await b.sidecar.putSelf('opencode', {
      displayName: 'OpenCode',
      goals: [opencodeGoal],
    });
    expect(assertOk(bSelfResult, 'opencode self put').selfRecord).toMatchObject({
      domain: 'agent:opencode',
      agentId: 'opencode',
      source: 'cloud',
    });

    await sync();

    // capability：显式域可读，owner/provenance 完整。
    const crossRecords = assertOk(await b.capability.query({
      query: marker,
      agentId: 'opencode',
      domains: ['agent:hermes'],
    }), 'cross-agent capability query');
    expect(crossRecords.records).toHaveLength(1);
    expect(crossRecords.records[0]).toMatchObject({
      domain: 'agent:hermes',
      ownerType: 'agent',
      ownerId: 'hermes',
    });
    expect(crossRecords.records[0].provenance).toMatchObject({
      agentId: 'hermes',
      agentName: 'Hermes',
      deviceId: a.deviceId,
    });

    // sidecar：B 显式列出 agent:hermes（policy.json 已授权）后可读，且不冒充自己。
    const crossRecall = assertOk(await b.sidecar.recall({
      agentId: 'opencode',
      query: marker,
      domains: ['agent:hermes'],
    }), 'cross-agent recall');
    const crossFragment = fragmentFor(crossRecall, marker);
    expect(crossFragment).toBeDefined();
    expect(crossFragment.owner).toMatchObject({
      role: 'agent',
      domain: 'agent:hermes',
      agentId: 'hermes',
      agentName: 'Hermes',
    });
    expect(crossFragment.provenance).toMatchObject({
      agentId: 'hermes',
      agentName: 'Hermes',
      deviceId: a.deviceId,
    });
    expect(crossFragment.owner.domain).not.toBe('agent:opencode');

    // Agent 不能写其他 Agent 的域：capability 与 sidecar 都拒绝。
    const denied = await b.capability.write([{
      domain: 'agent:hermes',
      kind: 'observation',
      content: { content: `DENIED-${RUN}` },
    }], { agentId: 'opencode' });
    expect(denied.status).toBe(403);
    expect(denied.body?.error?.code).toBe('domain_write_forbidden');

    const deniedIngest = await b.sidecar.ingest({
      agentId: 'opencode',
      extractor: 'host',
      chunks: [{ role: 'user', text: `DENIED-${RUN}` }],
      candidates: [{
        kind: 'observation',
        domain: 'agent:hermes',
        content: { content: `DENIED-${RUN}` },
      }],
    });
    expect(deniedIngest.status).toBe(403);
    expect(deniedIngest.body?.error?.code).toBe('domain_write_forbidden');

    const deniedRecords = assertOk(await b.capability.query({
      query: `DENIED-${RUN}`,
      domains: ['agent:hermes'],
    }), 'denied query');
    expect(deniedRecords.records).toHaveLength(0);

    // SelfRecord：跨设备可读同一 Agent 的 self；不同 agentId 互不串。
    const hermesSelf = assertOk(await b.sidecar.getSelf('hermes'), 'B get hermes self');
    expect(hermesSelf.selfRecord).toMatchObject({
      domain: 'agent:hermes',
      agentId: 'hermes',
      source: 'cloud',
    });
    expect(hermesSelf.selfRecord.content.goals).toContain(selfGoal);
    expect(JSON.stringify(hermesSelf.selfRecord.content)).not.toContain(opencodeGoal);

    const opencodeSelf = assertOk(await b.sidecar.getSelf('opencode'), 'B get opencode self');
    expect(opencodeSelf.selfRecord).toMatchObject({
      domain: 'agent:opencode',
      agentId: 'opencode',
      source: 'cloud',
    });
    expect(opencodeSelf.selfRecord.content.goals).toContain(opencodeGoal);
    expect(JSON.stringify(opencodeSelf.selfRecord.content)).not.toContain(selfGoal);

    const selfForbidden = await b.capability.internalObject({
      actor: { type: 'agent', agentId: 'opencode' },
      kind: 'self_record',
      op: 'get',
      agentId: 'hermes',
    });
    expect(selfForbidden.status).toBe(403);
    expect(selfForbidden.body?.error?.code).toBe('forbidden_scope');

    const selfByUser = assertOk(await b.capability.internalObject({
      actor: { type: 'user' },
      kind: 'self_record',
      op: 'get',
      agentId: 'hermes',
    }), 'user read hermes self');
    expect(selfByUser.object).toMatchObject({
      domain: 'agent:hermes',
      agentId: 'hermes',
    });
  });

  it('删除墓碑 / 归档跨设备；compact 源删除后 stale', async () => {
    const alpha = `ALPHA-${RUN}`;
    const beta = `BETA-${RUN}`;
    const gamma = `GAMMA-${RUN}`;
    const compactAgent = 'compactor';
    const compactDomain = `agent:${compactAgent}`;

    // 独立 Agent 域里只放 compact 的两个来源，避免其他测试的同域记录干扰
    // sourceIds 解析（capability query 的 limit 语义）。
    const first = assertOk(await a.sidecar.ingest({
      requestId: `req_lifecycle_${RUN}`,
      agentId: compactAgent,
      extractor: 'host',
      chunks: [{ role: 'user', text: `${alpha} ${beta}` }],
      candidates: [
        {
          kind: 'fact',
          domain: compactDomain,
          content: { subject: 'project', predicate: 'alpha', object: alpha },
        },
        {
          kind: 'fact',
          domain: compactDomain,
          content: { subject: 'project', predicate: 'beta', object: beta },
        },
      ],
    }), 'lifecycle ingest');
    expect(first.records).toHaveLength(2);
    const [alphaId, betaId] = first.records.map((record) => record.id);

    const compactResult = await a.sidecar.compact({
      agentId: compactAgent,
      domain: compactDomain,
      sourceIds: [alphaId, betaId],
      strategy: 'summary',
    });
    const compact = assertOk(compactResult, 'compact create').compact;
    expect(compact.stale).toBe(false);
    expect(compact.sourceIds.sort()).toEqual([alphaId, betaId].sort());

    const gammaIngest = assertOk(await a.sidecar.ingest({
      requestId: `req_lifecycle_gamma_${RUN}`,
      agentId: compactAgent,
      extractor: 'host',
      chunks: [{ role: 'user', text: gamma }],
      candidates: [{
        kind: 'fact',
        domain: compactDomain,
        content: { subject: 'project', predicate: 'gamma', object: gamma },
      }],
    }), 'gamma ingest');
    expect(gammaIngest.records).toHaveLength(1);
    const gammaId = gammaIngest.records[0].id;

    await sync();

    const beforeDelete = assertOk(await b.sidecar.recall({
      agentId: 'opencode',
      query: alpha,
      domains: [compactDomain],
    }), 'B recall before delete');
    expect(fragmentFor(beforeDelete, alpha)).toBeDefined();
    const compactBefore = assertOk(await b.sidecar.getCompact(compact.id), 'B compact before delete').compact;
    expect(compactBefore.stale).toBe(false);

    // 删除：墓碑随事件同步。
    assertOk(await a.capability.delete([alphaId], { actor: { type: 'user' } }), 'delete alpha');
    await sync();

    for (const device of [a, b]) {
      const query = assertOk(await device.capability.query({
        query: alpha,
        domains: [compactDomain],
      }), `${device.deviceId} deleted query`);
      expect(query.records).toHaveLength(0);
      const recall = assertOk(await device.sidecar.recall({
        agentId: device === a ? compactAgent : 'opencode',
        query: alpha,
        domains: [compactDomain],
      }), `${device.deviceId} deleted recall`);
      expect(recall.fragments).toHaveLength(0);
    }

    const staleCompact = assertOk(await b.sidecar.getCompact(compact.id), 'B compact after delete').compact;
    expect(staleCompact.stale).toBe(true);

    // 归档：默认不返回；治理读取 includeArchived 可见；解除后恢复召回。
    assertOk(await a.capability.archive([gammaId], { archived: true }), 'archive gamma');
    await sync();

    const archivedDefault = assertOk(await b.capability.query({
      query: gamma,
      domains: [compactDomain],
    }), 'archived default query');
    expect(archivedDefault.records).toHaveLength(0);

    // 契约用 `includeArchived` 暴露归档对象（`includeHistory` 只含墓碑）。
    const archivedHistory = assertOk(await b.capability.query({
      query: gamma,
      domains: [compactDomain],
      includeHistory: true,
      includeArchived: true,
    }), 'archived history query');
    expect(archivedHistory.records).toHaveLength(1);
    expect(archivedHistory.records[0].id).toBe(gammaId);

    const archivedRecall = assertOk(await b.sidecar.recall({
      agentId: 'opencode',
      query: gamma,
      domains: [compactDomain],
    }), 'archived recall');
    expect(archivedRecall.fragments).toHaveLength(0);

    assertOk(await a.capability.archive([gammaId], { archived: false }), 'unarchive gamma');
    await sync();
    const restoredRecall = assertOk(await b.sidecar.recall({
      agentId: 'opencode',
      query: gamma,
      domains: [compactDomain],
    }), 'unarchived recall');
    expect(fragmentFor(restoredRecall, gamma)).toBeDefined();

    // 普通 recall/query 不返回 compact 内部对象。
    const compactQuery = assertOk(await b.capability.query({
      query: 'Compact',
      domains: [compactDomain],
    }), 'compact leak query');
    expect(compactQuery.records.map((record) => record.id)).not.toContain(compact.id);
  });

  it('checkpoint 始终上云并跨设备；无 sync 选项', async () => {
    const threadId = `th_cloud_${RUN}`;
    const summary = `CP-CLOUD-${RUN}`;

    const put = await a.sidecar.putCheckpoint(threadId, {
      agentId: 'hermes',
      state: {
        schema: 2,
        contentMode: 'structured',
        task: { key: `task:${threadId}`, threadId, fleetTaskId: null },
        goal: summary,
        nextSteps: [{ id: 'n1', text: 'sync and restore' }],
        references: { recordIds: [], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
        cursor: 7,
        plan: ['sync', 'restore'],
      },
      summary,
    });
    const checkpoint = assertOk(put, 'checkpoint put').checkpoint;
    expect(checkpoint).toMatchObject({
      domain: `task:${threadId}`,
      internal: true,
      source: 'cloud',
      revision: 1,
    });

    await sync();

    // 图节点在 A/B 都存在；不是本地权威文件。
    for (const device of [a, b]) {
      const node = (await device.app.graph.listNodes({ type: 'context_checkpoint' }))
        .find((entry) => entry.id === checkpoint.id);
      expect(node).toBeDefined();
      expect(node.namespace).toBe(`task:${threadId}`);
    }

    const onB = assertOk(await b.sidecar.getCheckpoint(threadId, { agentId: 'hermes' }), 'B get checkpoint');
    expect(onB.checkpoint).toMatchObject({
      id: checkpoint.id,
      domain: `task:${threadId}`,
      agentId: 'hermes',
      threadId,
      revision: 1,
      source: 'cloud',
    });
    expect(onB.checkpoint.state).toMatchObject({
      schema: 2,
      contentMode: 'structured',
      goal: summary,
      cursor: 7,
      plan: ['sync', 'restore'],
    });
    expect(onB.checkpoint.summary).toBe(summary);

    // task:* 是任务共享状态：其他参与 Agent 可读同一 revision。
    const otherAgent = assertOk(
      await b.sidecar.getCheckpoint(threadId, { agentId: 'opencode' }),
      'B get checkpoint other agent',
    );
    expect(otherAgent.checkpoint).toMatchObject({
      id: checkpoint.id,
      domain: `task:${threadId}`,
      revision: 1,
    });

    // sync=local / sync=cloud 已从 API 移除。
    const legacyGet = await b.sidecar.getCheckpoint(threadId, { agentId: 'hermes', sync: 'local' });
    expect(legacyGet.status).toBe(400);
    expect(legacyGet.body?.error?.code).toBe('legacy_sync_unsupported');

    const legacyPut = await b.sidecar.putCheckpoint(threadId, {
      agentId: 'hermes',
      state: { cursor: 8 },
      sync: 'local',
    });
    expect(legacyPut.status).toBe(400);
    expect(legacyPut.body?.error?.code).toBe('legacy_sync_unsupported');

    const legacySelf = await b.sidecar.request(`/self/hermes?sync=local`);
    expect(legacySelf.status).toBe(400);
    expect(legacySelf.body?.error?.code).toBe('legacy_sync_unsupported');
  });

  it('compact 指定 sourceIds 子集时不受同域其他记录干扰', async () => {
    const agentId = `busy_${RUN}`;
    const domain = `agent:${agentId}`;
    const write = await a.capability.write(
      Array.from({ length: 5 }, (_, index) => ({
        clientItemId: `busy_${RUN}_${index}`,
        domain,
        kind: 'fact',
        content: { subject: `host-${index}`, predicate: 'port', object: String(7300 + index) },
        provenance: { source: 'runtime', extractor: 'heuristic' },
      })),
      { agentId, requestId: `busy_write_${RUN}` },
    );
    const written = assertOk(write, 'busy domain write');
    expect(written.created).toBe(5);

    const sourceIds = [written.results[1].id, written.results[3].id];
    const compactResult = await a.sidecar.compact({ agentId, domain, sourceIds });
    const compact = assertOk(compactResult, 'busy domain compact').compact;
    expect(compact.sourceIds.sort()).toEqual([...sourceIds].sort());
    expect(compact.stale).toBe(false);
  });
});
