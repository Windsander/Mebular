// C1 · 候选端点簿（EndpointBook / EndpointStore）单测
// 判别性：删除分类/优先级/来源合并/持久化任一实现，对应断言必须红。
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EndpointBook,
  FileEndpointStore,
  InMemoryEndpointStore,
  KIND_PRIORITY,
  classifyEndpoint,
  extractEndpointHost,
} from '../../src/p2p/connection/EndpointBook.js';

describe('C1 EndpointBook · 分类与优先级', () => {
  it('分类：/p2p-circuit → relay；私有 IPv4/`.local` → lan；其余 → direct', () => {
    expect(classifyEndpoint('/ip4/203.0.113.9/tcp/4001/p2p/abc')).toBe('direct');
    expect(classifyEndpoint('/ip4/192.168.1.20/tcp/4001/p2p/abc')).toBe('lan');
    expect(classifyEndpoint('/ip4/10.0.0.5/tcp/4001')).toBe('lan');
    expect(classifyEndpoint('/dns4/host.local/tcp/4001')).toBe('lan');
    expect(classifyEndpoint('/ip4/203.0.113.9/tcp/4001/p2p/relay/p2p-circuit/p2p/abc')).toBe('relay');
    expect(KIND_PRIORITY.direct).toBeLessThan(KIND_PRIORITY.lan);
    expect(KIND_PRIORITY.lan).toBeLessThan(KIND_PRIORITY.relay);
    expect(extractEndpointHost('/dns4/relay.example/tcp/4001')).toBe('relay.example');
    expect(extractEndpointHost('')).toBeNull();
  });

  it('拨号顺序：direct > lan > relay；同类别按最近成功优先', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    await book.upsert('peer-1', [
      '/ip4/203.0.113.9/tcp/4001/p2p/peer-1/p2p-circuit/p2p/relay',
      '/ip4/192.168.1.7/tcp/4001/p2p/peer-1',
      '/ip4/198.51.100.7/tcp/4001/p2p/peer-1',
    ], 'paired');
    expect(book.addresses('peer-1')).toEqual([
      '/ip4/198.51.100.7/tcp/4001/p2p/peer-1',
      '/ip4/192.168.1.7/tcp/4001/p2p/peer-1',
      '/ip4/203.0.113.9/tcp/4001/p2p/peer-1/p2p-circuit/p2p/relay',
    ]);
    // 失败者排后、成功者在同类别内提前（类别优先级仍高于成败）
    await book.upsert('peer-1', ['/ip4/198.51.100.8/tcp/4001/p2p/peer-1'], 'paired');
    book.recordSuccess('peer-1', '/ip4/198.51.100.8/tcp/4001/p2p/peer-1');
    expect(book.addresses('peer-1')[0]).toBe('/ip4/198.51.100.8/tcp/4001/p2p/peer-1');
    book.recordSuccess('peer-1', '/ip4/192.168.1.7/tcp/4001/p2p/peer-1');
    expect(book.addresses('peer-1')[2]).toBe('/ip4/192.168.1.7/tcp/4001/p2p/peer-1');
  });
});

describe('C1 EndpointBook · 来源/去重/上限/别名/成败', () => {
  it('去重 + 来源升级（learned < paired < config）', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    await book.upsert('p', ['/ip4/198.51.100.1/tcp/1/p2p/p'], 'learned');
    await book.upsert('p', ['/ip4/198.51.100.1/tcp/1/p2p/p'], 'paired');
    expect(book.list('p')).toHaveLength(1);
    expect(book.getCandidate('p', '/ip4/198.51.100.1/tcp/1/p2p/p')?.source).toBe('paired');
    await book.upsert('p', ['/ip4/198.51.100.1/tcp/1/p2p/p'], 'config');
    expect(book.getCandidate('p', '/ip4/198.51.100.1/tcp/1/p2p/p')?.source).toBe('config');
    // 降级不覆盖（config → learned 不应把来源降回去）
    await book.upsert('p', ['/ip4/198.51.100.1/tcp/1/p2p/p'], 'learned');
    expect(book.getCandidate('p', '/ip4/198.51.100.1/tcp/1/p2p/p')?.source).toBe('config');
  });

  it('每对端候选上限（防 hints/学习无限增长）', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore(), maxPerPeer: 3 });
    await book.upsert('p', ['/ip4/198.51.100.1/tcp/1', '/ip4/198.51.100.2/tcp/1', '/ip4/198.51.100.3/tcp/1', '/ip4/198.51.100.4/tcp/1'], 'paired');
    expect(book.list('p')).toHaveLength(3);
  });

  it('alias：deviceId 键的配对 hints 可并入 peerId 键', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    await book.upsert('device-B', ['/ip4/198.51.100.9/tcp/4001/p2p/peerB'], 'paired');
    const merged = await book.alias('device-B', 'peerid-hex');
    expect(merged).toBe(1);
    expect(book.addresses('peerid-hex')).toEqual(['/ip4/198.51.100.9/tcp/4001/p2p/peerB']);
    expect(await book.alias('missing', 'peerid-hex')).toBe(0);
  });

  it('成败统计与路径事件（path-changed 仅在变化时发）', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    await book.upsert('p', ['/ip4/198.51.100.1/tcp/1', '/ip4/198.51.100.2/tcp/1'], 'paired');
    const events: Array<{ key: string; address: string | null }> = [];
    book.on('path-changed', ({ key, path }) => events.push({ key, address: path?.address ?? null }));

    book.recordFailure('p', '/ip4/198.51.100.1/tcp/1', new Error('refused'));
    expect(book.getCandidate('p', '/ip4/198.51.100.1/tcp/1')?.lastError).toBe('refused');
    book.setPath('p', '/ip4/198.51.100.1/tcp/1');
    expect(book.getPath('p')?.kind).toBe('direct');
    expect(book.setPath('p', '/ip4/198.51.100.1/tcp/1')).toBe(false); // 同路径不重复发事件
    book.setPath('p', '/ip4/192.168.1.1/tcp/1');
    expect(book.getPath('p')?.kind).toBe('lan');
    book.clearPath('p', new Error('closed'));
    expect(book.getPath('p')).toBeNull();
    expect(events).toEqual([
      { key: 'p', address: '/ip4/198.51.100.1/tcp/1' },
      { key: 'p', address: '/ip4/192.168.1.1/tcp/1' },
      { key: 'p', address: null },
    ]);
  });
});

describe('C1 EndpointStore · 内存与文件实现', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-endpoints-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('内存实现：save/load 深拷贝（外部修改不影响内部）', async () => {
    const store = new InMemoryEndpointStore();
    const book = new EndpointBook({ store });
    await book.upsert('p', ['/ip4/198.51.100.1/tcp/1'], 'paired');
    const loaded = await store.load();
    expect(loaded.p).toHaveLength(1);
    loaded.p![0]!.address = 'tampered';
    expect((await store.load()).p![0]!.address).toBe('/ip4/198.51.100.1/tcp/1');
  });

  it('文件实现：原子写 + 0600 + 损坏降级为空簿（不抛）', async () => {
    const path = join(dir, 'net', 'peers.json');
    const store = new FileEndpointStore(path);
    expect(await store.load()).toEqual({}); // 不存在 → 空簿

    const book = new EndpointBook({ store });
    await book.upsert('device-B', ['/ip4/198.51.100.5/tcp/4001/p2p/peerB'], 'paired');
    if (process.platform !== 'win32') {
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    const written = JSON.parse(await readFile(path, 'utf-8'));
    expect(written['device-B'][0].address).toBe('/ip4/198.51.100.5/tcp/4001/p2p/peerB');
    expect(written['device-B'][0].kind).toBe('direct');
    expect(written['device-B'][0].source).toBe('paired');

    // 重启后可从文件恢复（app 传路径 → core 只经 store 读写）
    const reopened = new EndpointBook({ store: new FileEndpointStore(path) });
    await reopened.load();
    expect(reopened.addresses('device-B')).toEqual(['/ip4/198.51.100.5/tcp/4001/p2p/peerB']);

    // 损坏文件：空簿而非抛错
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ not json', 'utf-8');
    expect(await new FileEndpointStore(path).load()).toEqual({});
  });
});
