// T2：加入令牌 + join 服务 + joinWithToken（loopback HTTP；不复制主密钥）。
import { describe, it, expect, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { Mebular, bytesToBase64 } from '@mebular/core';
import {
  buildJoinToken,
  decodeJoinToken,
  describeJoinToken,
  encodeJoinToken,
  joinNonceStatePath,
  offlineMebularOptions,
  onboardDevice,
  readJoinNonceState,
  requestJoin,
  startJoinService,
  chainFingerprint,
  canonicalJoinTokenData,
  verifyJoinToken,
  joinWithToken,
  loadFleetConfig,
  fleetConfigPath,
  readMasterKeyFile,
} from '../../packages/fleet/src/index.js';

jest.setTimeout(60000);

const AGENTS = [{ name: 'echo', kind: 'echo' as const }];

async function makeInviter(dir: string, device = 'device-A'): Promise<Mebular> {
  await onboardDevice({ dir, device, agents: AGENTS, configGrant: false, policyIssuers: [device] });
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const m = new Mebular(offlineMebularOptions(config, encryption) as never);
  await m.initialize();
  return m;
}

describe('T2 加入令牌与 join 服务', () => {
  it('令牌往返/脱敏；验签/TTL/一次性/撕票/inviter 匹配', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-token-'));
    try {
      const inviter = await makeInviter(join(root, 'A'));
      const token = await buildJoinToken({
        mebular: inviter, deviceId: 'device-A', namespace: 'tasks',
        endpoint: 'http://127.0.0.1:1', ttlMs: 60_000, now: 1000, nonce: 'n1',
      });
      const decoded = decodeJoinToken(encodeJoinToken(token));
      expect(decoded).toEqual(token);
      const described = JSON.stringify(describeJoinToken(decoded));
      expect(described).not.toContain(token.signature);
      expect(describeJoinToken(decoded).hasMasterPrivateKey).toBe(false);

      expect((await verifyJoinToken(decoded, { now: 2000 })).ok).toBe(true);
      expect(await verifyJoinToken(decoded, { now: 2000, used: ['n1'] })).toEqual({ ok: false, reason: 'used' });
      expect(await verifyJoinToken(decoded, { now: 2000, revoked: ['n1'] })).toEqual({ ok: false, reason: 'revoked' });
      expect(await verifyJoinToken(decoded, { now: 200_000 })).toEqual({ ok: false, reason: 'expired' });
      expect(await verifyJoinToken(decoded, { now: 2000, expectedInviter: 'device-Z' })).toEqual({ ok: false, reason: 'inviter' });
      const tampered = { ...decoded, namespace: 'evil' };
      expect(await verifyJoinToken(tampered, { now: 2000 })).toEqual({ ok: false, reason: 'signature' });

      await inviter.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('join 服务签发委派证书；nonce 一次性；joinWithToken 不写主私钥', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-join-'));
    try {
      const A = join(root, 'A');
      const B = join(root, 'B');
      const inviter = await makeInviter(A);
      const svc = await startJoinService({ mebular: inviter, deviceId: 'device-A', storagePath: join(A, 'store.jsonl'), port: 0 });
      const endpoint = `http://127.0.0.1:${svc.port}`;
      try {
        const token = await buildJoinToken({ mebular: inviter, deviceId: 'device-A', namespace: 'tasks', endpoint, ttlMs: 60_000 });
        const inline = encodeJoinToken(token);

        const res = await joinWithToken({ dir: B, token: inline, device: 'device-B', listen: '/ip4/127.0.0.1/tcp/0', agents: AGENTS });
        expect(res.awaitingApproval).toBe(true);
        expect(res.alreadyJoined).toBe(false);
        expect(res.inviterDeviceId).toBe('device-A');

        // B 的主密钥文件**无主私钥**；身份文件有委派链（A→B）
        const bMaster = await readMasterKeyFile(join(B, 'master-key.json'));
        expect(bMaster.userMasterPrivateKey).toBeUndefined();
        const rec = JSON.parse(await (await import('node:fs/promises')).readFile(join(B, 'store.jsonl.identity.json'), 'utf-8'));
        expect(rec.certificateChain.length).toBe(2);
        expect(rec.certificate.issuer.deviceId).toBe('device-A');

        const state = await readJoinNonceState(join(A, 'store.jsonl'));
        expect(state.used).toContain(token.nonce);
        expect(joinNonceStatePath(join(A, 'store.jsonl'))).toContain('.join-tokens.json');

        // 令牌一次性：再用同令牌请求 → 403 used
        await expect(
          requestJoin({ endpoint, token: inline, deviceId: 'device-C', devicePublicKeyHex: 'a'.repeat(64) }),
        ).rejects.toThrow(/used/);

        // joinWithToken 幂等（已加入目录 + 同名设备）→ 不再消费令牌
        const again = await joinWithToken({ dir: B, token: inline, device: 'device-B', listen: '/ip4/127.0.0.1/tcp/0', agents: AGENTS });
        expect(again.alreadyJoined).toBe(true);

        // 目录占用拒绝
        await expect(
          joinWithToken({ dir: B, token: inline, device: 'device-X', listen: '/ip4/127.0.0.1/tcp/0', agents: AGENTS }),
        ).rejects.toThrow(/已被设备/);
      } finally {
        await svc.close();
        await inviter.shutdown();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('F-2：同一令牌**并发**请求只成功一次（先占用后签发）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-join-race-'));
    try {
      const A = join(root, 'A');
      const inviter = await makeInviter(A);
      const svc = await startJoinService({ mebular: inviter, deviceId: 'device-A', storagePath: join(A, 'store.jsonl'), port: 0 });
      const endpoint = `http://127.0.0.1:${svc.port}`;
      try {
        const token = encodeJoinToken(await buildJoinToken({ mebular: inviter, deviceId: 'device-A', namespace: 'tasks', endpoint, ttlMs: 60_000 }));
        const [r1, r2] = await Promise.allSettled([
          requestJoin({ endpoint, token, deviceId: 'device-P', devicePublicKeyHex: 'a'.repeat(64) }),
          requestJoin({ endpoint, token, deviceId: 'device-Q', devicePublicKeyHex: 'b'.repeat(64) }),
        ]);
        const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
        const rejected = [r1, r2].filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/used|令牌不可用/);
        const state = await readJoinNonceState(join(A, 'store.jsonl'));
        expect(state.used.filter((n) => n === (JSON.parse(Buffer.from(token, 'base64').toString('utf-8')) as { nonce: string }).nonce)).toHaveLength(1);
      } finally {
        await svc.close();
        await inviter.shutdown();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('decode/verify 负例 + join 服务 HTTP 分支 + 响应解析失败', async () => {

    const root = await mkdtemp(join(tmpdir(), 'fleet-token2-'));
    try {
      // decode 负例
      expect(() => decodeJoinToken('')).toThrow(/空/);
      expect(() => decodeJoinToken('not-base64-@@@')).toThrow(/无法解析/);
      expect(() => decodeJoinToken(Buffer.from(JSON.stringify({ v: 1, kind: 'mebular-fleet-join-token' })).toString('base64'))).toThrow(/缺少字段/);
      expect(() => decodeJoinToken(Buffer.from(JSON.stringify({ v: 1, kind: 'mebular-fleet-join-token', inviterDeviceId: 'x', inviterPublicKey: 'x', masterPublicKey: 'x', namespace: 'tasks', nonce: 'n', endpoint: 'http://x', signature: 's', issuedAt: 0, expiresAt: 1, inviterChain: [] })).toString('base64'))).toThrow(/证书链/);

      const A = join(root, 'A');
      const inviter = await makeInviter(A);
      const token = await buildJoinToken({ mebular: inviter, deviceId: 'device-A', namespace: 'tasks', endpoint: 'http://127.0.0.1:1' });
      // 无效公钥 → 签名判定失败
      expect(await verifyJoinToken({ ...token, inviterPublicKey: 'zz' }, { now: token.issuedAt })).toEqual({ ok: false, reason: 'signature' });
      // 链被篡改但签名有效（用 inviter 密钥重签）→ chain 失败
      const aKey = inviter.identity.getDeviceKey('device-A')!;
      const badChain = { ...token, inviterChain: [{ ...token.inviterChain[0]!, deviceId: 'device-X' }] };
      const sig = await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, aKey.privateKey, new TextEncoder().encode(canonicalJoinTokenData(badChain)));
      badChain.signature = bytesToBase64(new Uint8Array(sig));
      expect(await verifyJoinToken(badChain, { now: token.issuedAt })).toEqual({ ok: false, reason: 'chain' });
      expect(chainFingerprint(token.inviterChain)).toMatch(/^sha256:/);

      const svc = await startJoinService({ mebular: inviter, deviceId: 'device-A', storagePath: join(A, 'store.jsonl'), port: 0 });
      const base = `http://127.0.0.1:${svc.port}`;
      const call = (path: string, body?: unknown): Promise<{ status: number; body: string }> =>
        new Promise((resolve, reject) => {
          const payload = body === undefined ? undefined : JSON.stringify(body);
          const req = http.request(base + path, { method: payload === undefined ? 'GET' : 'POST', headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
            let d = '';
            res.on('data', (c: Buffer) => (d += c.toString('utf-8')));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
          });
          req.on('error', reject);
          if (payload !== undefined) req.write(payload);
          req.end();
        });
      try {
        expect((await call('/mebular/ping')).status).toBe(200);
        expect((await call('/nope')).status).toBe(404);
        expect((await call('/mebular/join', {})).status).toBe(400);
        expect((await call('/mebular/join', { token: encodeJoinToken(token), deviceId: 'device-X', devicePublicKey: 'zz' })).status).toBe(400);
        // 超大请求体 → 服务端拒绝（500 或连接被销毁）
        const big = { token: encodeJoinToken(token), deviceId: 'device-X', devicePublicKey: 'a'.repeat(300 * 1024) };
        let bigStatus: number | string;
        try {
          bigStatus = (await call('/mebular/join', big)).status;
        } catch {
          bigStatus = 'hang';
        }
        expect([500, 'hang']).toContain(bigStatus);
      } finally {
        await svc.close();
      }

      // 响应非 JSON → requestJoin 解析失败
      const junk = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not-json'); });
      await new Promise<void>((resolve) => junk.listen(0, '127.0.0.1', () => resolve()));
      const junkPort = (junk.address() as { port: number }).port;
      try {
        await expect(
          requestJoin({ endpoint: `http://127.0.0.1:${junkPort}`, token: encodeJoinToken(token), deviceId: 'device-X', devicePublicKeyHex: 'a'.repeat(64) }),
        ).rejects.toThrow(/无法解析/);
      } finally {
        await new Promise<void>((resolve) => junk.close(() => resolve()));
      }
      await inviter.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// C2：配对即连 —— 令牌 hints（endpoints/relaySeeds/pubReachable）+ join 侧写入地址簿
describe('C2 配对 hints', () => {
  it('无节点时令牌不含 hints（与旧格式等价）且旧令牌仍可验签（向后兼容）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-hints-'));
    try {
      const inviter = await makeInviter(join(root, 'A'));
      const token = await buildJoinToken({
        mebular: inviter, deviceId: 'device-A', namespace: 'tasks',
        endpoint: 'http://127.0.0.1:1', ttlMs: 60_000, now: 1000, nonce: 'nh0',
      });
      expect(token.endpoints).toBeUndefined();
      expect(token.relaySeeds).toBeUndefined();
      expect(token.pubReachable).toBeUndefined();
      // canonical 与「无 hints」签名体一致（老实现签出的令牌可继续验签）
      expect(canonicalJoinTokenData(token)).not.toContain('endpoints');
      expect((await verifyJoinToken(token, { now: 2000 })).ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('显式 hints 进签名体、可解码，且 join 写入地址簿（deviceId + peerId 双键、0600）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-hints2-'));
    try {
      const inviter = await makeInviter(join(root, 'A'));
      const endpoints = ['/ip4/192.168.1.20/tcp/4001/p2p/peerX'];
      const relaySeeds = ['/ip4/203.0.113.7/tcp/4001/p2p/relayY'];
      const token = await buildJoinToken({
        mebular: inviter, deviceId: 'device-A', namespace: 'tasks',
        endpoint: 'http://192.168.1.20:4002', ttlMs: 60_000, now: 1000, nonce: 'nh1',
        endpoints, relaySeeds, pubReachable: true,
      });
      expect(decodeJoinToken(encodeJoinToken(token)).endpoints).toEqual(endpoints);
      expect((await verifyJoinToken(token, { now: 2000 })).ok).toBe(true);

      // join 侧落盘（与 joinWithToken 同一函数）
      const home = join(root, 'B');
      const { persistInviterHints } = await import('../../packages/fleet/src/join.js');
      const written = await persistInviterHints(home, {
        inviterDeviceId: 'device-A',
        inviterPublicKey: token.inviterPublicKey,
        endpoints,
        relaySeeds,
      });
      expect(written).toBeGreaterThan(0);

      const { FileEndpointStore, EndpointBook, RELAY_SEEDS_KEY } = await import('@mebular/core');
      const book = new EndpointBook({ store: new FileEndpointStore(join(home, 'net', 'peers.json')) });
      await book.load();
      expect(book.addresses('device-A')).toEqual(endpoints);
      expect(book.relaySeeds()).toEqual(relaySeeds);
      expect(book.keys()).toContain(RELAY_SEEDS_KEY);
      const { stat } = await import('node:fs/promises');
      expect(((await stat(join(home, 'net', 'peers.json'))).mode & 0o777)).toBe(0o600);

      // 无 hints（旧令牌）→ no-op
      expect(await persistInviterHints(join(root, 'C'), { inviterDeviceId: 'device-A', inviterPublicKey: token.inviterPublicKey })).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
