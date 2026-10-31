// Console 管理读面：/admin/api/memories 与 /admin/api/namespaces 统一走
// MemoryService.listRecords()/namespaceStats()，不再自行过滤/统计。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular, MemoryService } from '@mebular/core';
import { buildMemories, buildNamespaces } from '../../packages/mcp/src/admin.mjs';

const memoryUrl = (query = '') => new URL(`http://localhost/admin/api/memories${query}`);
const idsOf = (rows) => rows.map((row) => row.id).sort();

describe('Console 管理读面统一走 MemoryService', () => {
  let dir;
  let app;
  let service;
  let keep;
  let note;
  let archived;
  let deleted;
  let internal;
  let reserved;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-admin-read-'));
    const master = await Mebular.generateUserMasterKey();
    app = new Mebular({
      storagePath: join(dir, 'store.jsonl'),
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: { enabled: false },
      sync: { autoSync: false, namespaces: [] },
    });
    await app.initialize();
    service = new MemoryService(app);

    const written = await service.write([
      { type: 'fact', content: '保留记录' },
      { type: 'fact', content: '笔记记录', metadata: { namespace: 'notes' } },
      { type: 'fact', content: '归档记录', metadata: { namespace: 'notes' } },
      { type: 'fact', content: '墓碑记录', metadata: { namespace: 'notes' } },
    ]);
    [keep, note, archived, deleted] = written;
    await service.archive([archived.id], true);
    await service.delete([deleted.id]);

    internal = await app.graph.createNode('compact', { summary: '内部摘要' }, undefined, {
      namespace: 'notes',
    });
    await app.graph.updateNode(internal.id, {
      metadata: { internal: true, internalObject: { schema: 1, kind: 'compact' } },
    });
    reserved = await app.graph.createNode('fact', {
      subject: 'user', predicate: 'debug', object: 'raw',
    }, undefined, { namespace: '__raw__' });
  });

  afterEach(async () => {
    await app.shutdown().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it('buildMemories 的 total/rows 与 listRecords 一致（各 include* 与 namespace/limit）', async () => {
    const cases = [
      { query: '', options: {} },
      { query: '?includeArchived=1', options: { includeArchived: true } },
      { query: '?includeDeleted=1', options: { includeDeleted: true } },
      { query: '?includeInternal=1', options: { includeInternal: true } },
      {
        query: '?includeArchived=1&includeDeleted=1&includeInternal=1',
        options: { includeArchived: true, includeDeleted: true, includeInternal: true },
      },
      { query: '?namespace=notes', options: { namespace: 'notes' } },
      {
        query: '?namespace=notes&includeArchived=1',
        options: { namespace: 'notes', includeArchived: true },
      },
      {
        query: '?namespace=notes&includeDeleted=1',
        options: { namespace: 'notes', includeDeleted: true },
      },
      {
        query: '?namespace=notes&includeInternal=1',
        options: { namespace: 'notes', includeInternal: true },
      },
      { query: '?limit=1', options: { limit: 1 } },
      {
        query: '?namespace=notes&includeArchived=1&includeDeleted=1&includeInternal=1&limit=2',
        options: {
          namespace: 'notes',
          includeArchived: true,
          includeDeleted: true,
          includeInternal: true,
          limit: 2,
        },
      },
    ];

    for (const testCase of cases) {
      const out = await buildMemories({ service, url: memoryUrl(testCase.query) });
      const expected = await service.listRecords(testCase.options);
      expect({ query: testCase.query, total: out.total, ids: idsOf(out.memories) }).toEqual({
        query: testCase.query,
        total: expected.total,
        ids: idsOf(expected.nodes),
      });
    }

    const plain = await buildMemories({ service, url: memoryUrl() });
    expect(idsOf(plain.memories)).toEqual([keep.id, note.id].sort());
    expect(plain.memories.every((entry) => entry.archived === false && entry.deleted === false)).toBe(true);
    expect(plain.includeArchived).toBe(false);
    expect(plain.includeDeleted).toBe(false);
    expect(plain.includeInternal).toBe(false);

    const withArchived = await buildMemories({ service, url: memoryUrl('?includeArchived=1') });
    expect(withArchived.memories.find((entry) => entry.id === archived.id)).toMatchObject({
      archived: true,
    });
    expect(typeof withArchived.memories.find((entry) => entry.id === archived.id)?.archivedAt).toBe('number');

    const withDeleted = await buildMemories({ service, url: memoryUrl('?includeDeleted=1') });
    expect(withDeleted.memories.find((entry) => entry.id === deleted.id)).toMatchObject({
      deleted: true,
    });

    const withInternal = await buildMemories({ service, url: memoryUrl('?includeInternal=1') });
    expect(idsOf(withInternal.memories)).toEqual(expect.arrayContaining([internal.id, reserved.id]));
  });

  it('buildNamespaces 的计数/更新时间/记录数/内部对象数与 namespaceStats 一致', async () => {
    const rows = await buildNamespaces({
      app,
      service,
      config: { sync: { namespaces: [] } },
    });
    const expected = await service.namespaceStats({ includeReserved: true });

    for (const domain of expected) {
      const row = rows.find((entry) => entry.namespace === domain.domain);
      expect(row).toBeTruthy();
      expect({
        namespace: row.namespace,
        count: row.count,
        memoryRecords: row.memoryRecords,
        internalObjects: row.internalObjects,
        lastUpdatedAt: row.lastUpdatedAt,
      }).toEqual({
        namespace: domain.domain,
        count: domain.count,
        memoryRecords: domain.memoryRecords,
        internalObjects: domain.internalObjects,
        lastUpdatedAt: domain.lastUpdatedAt || null,
      });
    }

    // 保留域不静默丢失（Console 旧行为）；公共 stats/capability 默认仍排除。
    expect(rows.some((entry) => entry.namespace === '__raw__')).toBe(true);
    expect((await service.namespaceStats()).some((entry) => entry.domain === '__raw__')).toBe(false);
    expect((await service.stats()).domains.map((entry) => entry.domain)).not.toContain('__raw__');

    const notes = rows.find((entry) => entry.namespace === 'notes');
    expect(notes).toMatchObject({ count: 4, memoryRecords: 3, internalObjects: 1, declared: false });

    // 只有域公告、没有节点的域仍显示（count=0）。
    await app.declareNamespace({ namespace: 'ledger' });
    const afterDeclare = await buildNamespaces({
      app,
      service,
      config: { sync: { namespaces: [] } },
    });
    expect(afterDeclare.find((entry) => entry.namespace === 'ledger')).toMatchObject({
      count: 0,
      memoryRecords: 0,
      internalObjects: 0,
      lastUpdatedAt: null,
      declared: true,
    });
  });
});
