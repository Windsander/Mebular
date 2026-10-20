// 加入令牌安全矩阵（纯令牌；无网络）：往返/签名/TTL/一次性/受信方匹配/脱敏。
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import {
  buildJoinToken,
  canonicalJoinTokenData,
  decodeJoinToken,
  describeJoinToken,
  encodeJoinToken,
  onboardDevice,
  offlineMebularOptions,
  readMasterKeyFile,
  loadFleetConfig,
  fleetConfigPath,
  verifyJoinToken,
} from '../../packages/fleet/src/index.js';

const AGENTS = [{ name: 'echo', kind: 'echo' as const }];

describe('加入令牌安全矩阵', () => {
  let dir: string;
  let app: Mebular;
  let token: Awaited<ReturnType<typeof buildJoinToken>>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fleet-token-sec-'));
    await onboardDevice({ dir, device: 'device-A', agents: AGENTS });
    const config = await loadFleetConfig(fleetConfigPath(dir));
    const encryption = await readMasterKeyFile(config.masterKeyFile);
    app = new Mebular(offlineMebularOptions(config, encryption) as never);
    await app.initialize();
    token = await buildJoinToken({
      mebular: app,
      deviceId: 'device-A',
      namespace: 'tasks',
      endpoint: 'http://127.0.0.1:1',
      ttlMs: 60_000,
      now: 1_000,
      nonce: 'nonce-1',
    });
  });
  afterEach(async () => {
    await app.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  it('encode/decode 往返', () => {
    expect(decodeJoinToken(encodeJoinToken(token))).toEqual(token);
  });

  it('canonical 数据确定且不含 signature', () => {
    const canonical = canonicalJoinTokenData(token);
    expect(canonical).not.toContain(token.signature);
    expect(canonicalJoinTokenData({ ...token })).toBe(canonical);
  });

  it('有效签名 + TTL 内通过', async () => {
    expect(await verifyJoinToken(token, { now: 2_000 })).toEqual({ ok: true });
  });

  it('篡改 namespace → signature', async () => {
    expect(await verifyJoinToken({ ...token, namespace: 'evil' }, { now: 2_000 })).toEqual({ ok: false, reason: 'signature' });
  });

  it('篡改 signature → signature', async () => {
    expect(await verifyJoinToken({ ...token, signature: 'AAAA' }, { now: 2_000 })).toEqual({ ok: false, reason: 'signature' });
  });

  it('过期 → expired', async () => {
    expect(await verifyJoinToken(token, { now: 999_999 })).toEqual({ ok: false, reason: 'expired' });
  });

  it('nonce 已用 → used', async () => {
    expect(await verifyJoinToken(token, { now: 2_000, used: ['nonce-1'] })).toEqual({ ok: false, reason: 'used' });
  });

  it('nonce 已撕 → revoked', async () => {
    expect(await verifyJoinToken(token, { now: 2_000, revoked: ['nonce-1'] })).toEqual({ ok: false, reason: 'revoked' });
  });

  it('邀请方不匹配 → inviter', async () => {
    expect(await verifyJoinToken(token, { now: 2_000, expectedInviter: 'device-Z' })).toEqual({ ok: false, reason: 'inviter' });
  });

  it('describe 不含签名/主私钥', () => {
    const text = JSON.stringify(describeJoinToken(token));
    expect(text).not.toContain(token.signature);
    expect(describeJoinToken(token).hasMasterPrivateKey).toBe(false);
  });
});
