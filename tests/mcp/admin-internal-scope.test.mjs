// /admin/api/memories?includeInternal=1 必须由 memory.admin scope 打开；
// 普通 memory.read token 只能看到公开记录。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer, hashToken } from '../../packages/mcp/src/serve.mjs';

const dirs = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true });
});

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const at = Date.UTC(2026, 9, 29, 12, 0, 0);
const nodes = [
  {
    id: 'fact-public', type: 'fact', content: { subject: 'user', predicate: 'theme', object: 'dark' },
    createdAt: at, updatedAt: at, namespace: 'default', tags: [],
  },
  {
    id: 'compact-internal', type: 'compact', content: { summary: 'internal' },
    createdAt: at, updatedAt: at, namespace: 'notes', tags: [],
    metadata: { internal: true, internalObject: { schema: 1, kind: 'compact' } },
  },
];

const app = {
  storage: { listNodes: async () => nodes },
  sync: { on() {}, off() {} },
  getBlockedDevices: async () => [],
};
const service = {
  status: async () => ({ running: true, nodeCount: nodes.length, pendingEventCount: 0, peerId: null }),
  // 本测试只关心 scope；管理读面的过滤语义由 admin-internal-filter.test.mjs 覆盖。
  listRecords: async ({ includeInternal = false } = {}) => {
    const visible = includeInternal
      ? nodes
      : nodes.filter((node) => node.metadata?.internal !== true
        && !(typeof node.namespace === 'string' && node.namespace.startsWith('__')));
    return { total: visible.length, nodes: visible };
  },
};

async function setup() {
  const home = await tempDir('mebular-admin-scope-home-');
  const authDir = await tempDir('mebular-admin-scope-auth-');
  const readToken = 'meb-read-only';
  const adminToken = 'meb-admin';
  const tokensFile = join(authDir, 'tokens.json');
  await mkdir(authDir, { recursive: true });
  await writeFile(tokensFile, JSON.stringify({
    tokens: [
      { id: 'read', sha256: hashToken(readToken), scope: ['memory.read'], revoked: false },
      { id: 'admin', sha256: hashToken(adminToken), scope: ['memory.admin'], revoked: false },
    ],
  }), 'utf-8');
  const server = await startHttpServer({
    home,
    app,
    service,
    config: {},
    host: '127.0.0.1',
    port: 0,
    auth: 'bearer',
    tokensFile,
  });
  return { base: `http://127.0.0.1:${server.port}`, readToken, adminToken, close: () => server.close() };
}

describe('/admin/api/memories 内部对象 scope', () => {
  it('普通读 token 默认只看到公开记录，includeInternal=1 需要 memory.admin', async () => {
    const { base, readToken, adminToken, close } = await setup();
    try {
      const plain = await fetch(`${base}/admin/api/memories`, {
        headers: { authorization: `Bearer ${readToken}` },
      });
      expect(plain.status).toBe(200);
      const plainBody = await plain.json();
      expect(plainBody.total).toBe(1);
      expect(plainBody.memories.map((entry) => entry.id)).toEqual(['fact-public']);

      const denied = await fetch(`${base}/admin/api/memories?includeInternal=1`, {
        headers: { authorization: `Bearer ${readToken}` },
      });
      expect(denied.status).toBe(403);
      expect((await denied.json()).message).toContain('memory.admin');

      const allowed = await fetch(`${base}/admin/api/memories?includeInternal=1`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(allowed.status).toBe(200);
      const allowedBody = await allowed.json();
      expect(allowedBody.total).toBe(2);
      expect(allowedBody.memories.map((entry) => entry.id).sort()).toEqual(['compact-internal', 'fact-public']);
    } finally {
      await close();
    }
  });
});
