import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular, POLICY_NAMESPACE } from '@mebular/core';

import {
  doctor,
  fleetConfigPath,
  grantNamespace,
  loadFleetConfig,
  offlineMebularOptions,
  onboardDevice,
  readMasterKeyFile,
  revokeNamespaceGrant,
  setNamespaceMembership,
  namespaceMembers,
  namespaceMembership,
  validateFleetConfig,
} from '../../packages/fleet/src/index.js';

const echoAgent = [{ name: 'echo', kind: 'echo' as const }];
const baseConfig = {
  v: 1,
  device: 'd',
  dir: '/tmp/d',
  storagePath: '/tmp/d/store.jsonl',
  masterKeyFile: '/tmp/d/master-key.json',
  namespace: 'tasks',
  listen: '/ip4/0.0.0.0/tcp/0',
  peers: [],
  policyIssuers: [],
  agents: echoAgent,
};

async function namespaceCheck(dir: string): Promise<{ status: string; hint?: string } | undefined> {
  const report = await doctor(dir);
  return report.checks.find((c) => c.name === 'namespace 已授权');
}

describe('G1：图上授权为主（默认拒绝；配置白名单仅 bootstrap）', () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fleet-grant-'));
    dir = join(root, 'A');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('仅图上 grant（无配置白名单）：拒绝 → grant 后 PASS → revoke 后 FAIL 且 hint 指向新 grantId', async () => {
    await onboardDevice({
      dir,
      device: 'device-A',
      peerDevice: 'device-B',
      policyIssuers: ['device-A'],
      configGrant: false,
      agents: echoAgent,
    });
    const cfg = await loadFleetConfig(fleetConfigPath(dir));
    expect(cfg.peerNamespacePolicy).toEqual({}); // 只有图上 grant，无配置白名单

    expect((await namespaceCheck(dir))?.status).toBe('FAIL');

    const grant = await grantNamespace(dir, { to: 'device-B' });
    expect(grant.grantId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await namespaceCheck(dir))?.status).toBe('PASS');

    await revokeNamespaceGrant(dir, { grantId: grant.grantId });
    const after = await namespaceCheck(dir);
    expect(after?.status).toBe('FAIL');
    expect(after?.hint ?? '').toMatch(/新 grantId|R-d/);
  });

  it('撤销后复用旧 grantId 重新授予：不恢复（R-d）', async () => {
    await onboardDevice({
      dir,
      device: 'device-A',
      peerDevice: 'device-B',
      policyIssuers: ['device-A'],
      configGrant: false,
      agents: echoAgent,
    });
    const grant = await grantNamespace(dir, { to: 'device-B' });
    await revokeNamespaceGrant(dir, { grantId: grant.grantId });
    expect((await namespaceCheck(dir))?.status).toBe('FAIL');

    const cfg = await loadFleetConfig(fleetConfigPath(dir));
    const enc = await readMasterKeyFile(cfg.masterKeyFile);
    const mebular = new Mebular(offlineMebularOptions(cfg, enc) as never);
    await mebular.initialize();
    await mebular.eventLog.append({
      type: 'namespace_grant',
      data: { grant: { grantId: grant.grantId, subject: 'device-B', namespaces: ['tasks'], issuedAt: Date.now() } },
      namespace: POLICY_NAMESPACE,
    });
    await mebular.shutdown();

    expect((await namespaceCheck(dir))?.status).toBe('FAIL');
  });

  it('未授权设备自授不生效（R-a）：grant 已签发但不被采纳', async () => {
    await onboardDevice({
      dir,
      device: 'device-C',
      peerDevice: 'device-A',
      configGrant: false,
      agents: echoAgent,
    });
    const grant = await grantNamespace(dir, { to: 'device-A' });
    expect(grant.grantId).toBeTruthy();
    expect((await namespaceCheck(dir))?.status).toBe('FAIL');
  });

  it('grant 携带 --expires-at：事件记录该字段（本轮不强制生效，仍 PASS）', async () => {
    await onboardDevice({
      dir,
      device: 'device-A',
      peerDevice: 'device-B',
      policyIssuers: ['device-A'],
      configGrant: false,
      agents: echoAgent,
    });
    const expiresAt = Date.now() + 3_600_000;
    const grant = await grantNamespace(dir, { to: 'device-B', expiresAt });

    const cfg = await loadFleetConfig(fleetConfigPath(dir));
    const enc = await readMasterKeyFile(cfg.masterKeyFile);
    const mebular = new Mebular(offlineMebularOptions(cfg, enc) as never);
    await mebular.initialize();
    const events = (await mebular.eventLog.listEvents({ namespace: POLICY_NAMESPACE })) as unknown as Array<{
      data?: { grant?: { grantId?: string; expiresAt?: number } };
    }>;
    await mebular.shutdown();

    const record = events.find((e) => e.data?.grant?.grantId === grant.grantId)?.data?.grant;
    expect(record?.expiresAt).toBe(expiresAt);
    expect((await namespaceCheck(dir))?.status).toBe('PASS');
  });

  it('校验/组合：peerNamespacePolicy 形状；显式 {} 覆盖 peers 推导', async () => {
    expect(validateFleetConfig(baseConfig)).toEqual([]);
    expect(validateFleetConfig({ ...baseConfig, peerNamespacePolicy: {} })).toEqual([]);
    expect(validateFleetConfig({ ...baseConfig, peerNamespacePolicy: { 'device-B': ['tasks'] } })).toEqual([]);
    expect(
      validateFleetConfig({ ...baseConfig, peerNamespacePolicy: { 'device-B': 'tasks' } }).some((e) =>
        e.includes('peerNamespacePolicy'),
      ),
    ).toBe(true);
    expect(
      validateFleetConfig({ ...baseConfig, peerNamespacePolicy: { 'device-B': [1] } }).some((e) =>
        e.includes('peerNamespacePolicy'),
      ),
    ).toBe(true);
  });
});

describe('M1–M3：fleet 成员资格 API 与 doctor', () => {
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fleet-mem-'));
    dir = join(root, 'A');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('setNamespaceMembership / namespaceMembership / namespaceMembers（含默认拒绝与注销）', async () => {
    await onboardDevice({ dir, device: 'device-A', peerDevice: 'device-B', policyIssuers: ['device-A'], configGrant: false, agents: echoAgent });
    expect((await namespaceMembership(dir)).active).toBe(false);
    const add = await setNamespaceMembership(dir, { to: 'device-B' });
    expect(add).toMatchObject({ member: 'device-B', namespace: 'tasks', active: true });
    expect((await namespaceMembership(dir)).members).toEqual(['device-B']);
    // 未授权 → 生效成员为空（默认拒绝不变）
    expect(await namespaceMembers(dir)).toEqual([]);
    // 授权后成为生效成员
    await grantNamespace(dir, { to: 'device-B' });
    expect(await namespaceMembers(dir)).toEqual(['device-B']);
    // 注销
    await setNamespaceMembership(dir, { to: 'device-B', active: false });
    expect((await namespaceMembership(dir)).members).toEqual([]);
    expect(await namespaceMembers(dir)).toEqual([]);
  });

  it('doctor：成员资格启用但本机不在册 → FAIL；自证在册 → PASS', async () => {
    await onboardDevice({ dir, device: 'device-A', peerDevice: 'device-B', policyIssuers: ['device-A'], configGrant: false, agents: echoAgent });
    await setNamespaceMembership(dir, { to: 'device-B' });
    let report = await doctor(dir);
    expect(report.checks.find((c) => c.name === 'namespace 成员资格')?.status).toBe('FAIL');
    await setNamespaceMembership(dir, { to: 'device-A' });
    report = await doctor(dir);
    expect(report.checks.find((c) => c.name === 'namespace 成员资格')?.status).toBe('PASS');
  });
});
