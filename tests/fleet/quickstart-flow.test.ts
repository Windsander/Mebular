// Stage 1 一键上车：库级 hermetic 流程（真实 libp2p loopback 仅用于捕获 multiaddr）。
// 不依赖外部 CLI；覆盖 quickstart / joinFleet / pending / approve / autoApprove。
import { describe, it, expect, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import {
  approveDevice,
  autoApproveOnce,
  decodeJoinCode,
  defaultDeviceName,
  detectAgents,
  defaultFleetDir,
  encodeJoinCode,
  joinFleet,
  loadFleetConfig,
  offlineMebularOptions,
  pendingDevices,
  quickstart,
  readMasterKeyFile,
  fleetConfigPath,
} from '../../packages/fleet/src/index.js';

jest.setTimeout(90000);

const AGENTS = [{ name: 'echo', kind: 'echo' as const }];

async function openOffline(dir: string): Promise<Mebular> {
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const m = new Mebular(offlineMebularOptions(config, encryption) as never);
  await m.initialize();
  return m;
}

describe('一键上车（Stage 1）库级流程', () => {
  it('quickstart → joinFleet（幂等）→ pending/approve → autoApprove；版本不符拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-qs-jest-'));
    const A = join(root, 'A');
    const B = join(root, 'B');
    try {
      const qs = await quickstart({
        dir: A,
        device: 'device-A',
        namespace: 'tasks',
        listen: '/ip4/127.0.0.1/tcp/0',
        skipPortCheck: true,
        agents: AGENTS,
        buildSha: 'TESTSHA',
      });
      expect(qs.device).toBe('device-A');
      expect(qs.code.length).toBeGreaterThan(100);
      expect(qs.multiaddrs.length).toBeGreaterThan(0);
      expect(decodeJoinCode(qs.code).device).toBe('device-A');
      // A 自声明签发者/成员/自授权
      const a = await openOffline(A);
      try {
        expect((await a.getEffectiveNamespaces('device-A')).includes('tasks')).toBe(true);
        expect((await a.getNamespaceMembership('tasks')).members).toContain('device-A');
      } finally {
        await a.shutdown();
      }

      const j1 = await joinFleet({
        dir: B,
        code: qs.code,
        device: 'device-B',
        namespace: 'tasks',
        listen: '/ip4/127.0.0.1/tcp/0',
        skipPortCheck: true,
        agents: AGENTS,
        buildSha: 'TESTSHA',
      });
      expect(j1.awaitingApproval).toBe(true);
      expect(j1.alreadyJoined).toBe(false);

      const j2 = await joinFleet({
        dir: B,
        code: qs.code,
        device: 'device-B',
        listen: '/ip4/127.0.0.1/tcp/0',
        skipPortCheck: true,
        agents: AGENTS,
        buildSha: 'TESTSHA',
      });
      expect(j2.alreadyJoined).toBe(true);

      await expect(
        joinFleet({
          dir: join(root, 'B2'),
          code: encodeJoinCode({ ...decodeJoinCode(qs.code), sha: 'OTHER' }),
          device: 'device-B2',
          listen: '/ip4/127.0.0.1/tcp/0',
          skipPortCheck: true,
          agents: AGENTS,
          buildSha: 'TESTSHA',
        }),
      ).rejects.toThrow(/版本不一致/);

      // B 未连接时 A 看不到其成员记录 → pending 为空
      const p0 = await pendingDevices(A, 'tasks');
      expect(p0.pending).toEqual([]);

      const ap = await approveDevice(A, { device: 'device-B', namespace: 'tasks' });
      expect(ap.grantId.length).toBeGreaterThan(0);
      expect(ap.peerRegistered).toBe(true);
      const cfgA = await loadFleetConfig(fleetConfigPath(A));
      expect(cfgA.peers.some((p) => p.device === 'device-B')).toBe(true);

      // autoApprove：B 在册且未授权 → 自动授权一次
      const a2 = await openOffline(A);
      try {
        await a2.declareNamespaceMembership({ member: 'device-C', namespace: 'tasks', active: true });
        const before = await a2.getEffectiveNamespaces('device-C');
        expect(before.includes('tasks')).toBe(false);
        const approved = await autoApproveOnce(a2, 'device-A', 'tasks');
        expect(approved).toBeGreaterThanOrEqual(1);
        expect((await a2.getEffectiveNamespaces('device-C')).includes('tasks')).toBe(true);
      } finally {
        await a2.shutdown();
      }

      // 默认值工具
      expect(defaultDeviceName('My-Host.local')).toBe('my-host.local');
      expect(typeof defaultFleetDir({ HOME: '/home/x' })).toBe('string');
      expect(defaultFleetDir({ HOME: '/home/x' })).toBe(join('/home/x', '.fleet'));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('quickstart --auto-approve + 服务安装回调；detectAgents(hermes)；pending/approve 分支', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-qs-jest2-'));
    const A = join(root, 'A');
    const binDir = join(root, 'bin');
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, 'hermes'), '#!/bin/sh\n', { mode: 0o755 });

      const qs = await quickstart({
        dir: A,
        device: 'device-A',
        listen: '/ip4/127.0.0.1/tcp/0',
        skipPortCheck: true,
        autoApprove: true,
        agents: AGENTS,
        buildSha: 'TESTSHA',
        installService: async () => ({ installed: true, note: 'stub' }),
        env: { PATH: binDir },
      });
      expect(qs.autoApprove).toBe(true);
      expect(qs.serviceInstalled).toBe(true);
      expect(qs.serviceNote).toBe('stub');
      expect(JSON.parse(await (await import('node:fs/promises')).readFile(fleetConfigPath(A), 'utf-8')).autoApprove).toBe(true);

      // detectAgents(hermes) 分支
      const probed = detectAgents({ PATH: binDir }, 'linux');
      expect(probed.agents.some((a) => a.kind === 'hermes')).toBe(true);
      expect(probed.sources).toContain('hermes:PATH');

      // decode 直接 JSON 分支
      expect(decodeJoinCode(JSON.stringify(decodeJoinCode(qs.code))).device).toBe('device-A');

      // pending：在册但未授权的第三方 → pending；self 在 authorized
      const a = await openOffline(A);
      try {
        await a.declareNamespaceMembership({ member: 'device-C', namespace: 'tasks', active: true });
        const p = await pendingDevices(A, 'tasks');
        expect(p.pending).toContain('device-C');
        expect(p.authorized).toContain('device-A');
      } finally {
        await a.shutdown();
      }

      // approve 二次调用命中已有对端分支（更新 addr）
      await approveDevice(A, { device: 'device-C', namespace: 'tasks', addr: '/ip4/127.0.0.1/tcp/1111/p2p/c' });
      const ap2 = await approveDevice(A, { device: 'device-C', namespace: 'tasks', addr: '/ip4/127.0.0.1/tcp/2222/p2p/c' });
      expect(ap2.peerRegistered).toBe(true);
      const cfg = await loadFleetConfig(fleetConfigPath(A));
      expect(cfg.peers.find((x) => x.device === 'device-C')?.addr).toBe('/ip4/127.0.0.1/tcp/2222/p2p/c');

      // 目录被其它设备占用 → join 拒绝
      const B = join(root, 'B');
      await quickstart({ dir: B, device: 'device-X', listen: '/ip4/127.0.0.1/tcp/0', skipPortCheck: true, agents: AGENTS, buildSha: 'TESTSHA' });
      await expect(
        joinFleet({
          dir: B,
          code: qs.code,
          device: 'device-Y',
          listen: '/ip4/127.0.0.1/tcp/0',
          skipPortCheck: true,
          agents: AGENTS,
          buildSha: 'TESTSHA',
        }),
      ).rejects.toThrow(/已被设备/);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
