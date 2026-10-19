// Stage 1 一键上车：库级 hermetic 流程（真实 libp2p loopback 仅用于捕获 multiaddr）。
// 不依赖外部 CLI；覆盖 quickstart / joinFleet / 订阅 / 服务安装。
import { describe, it, expect, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import {
  decodeJoinCode,
  defaultDeviceName,
  detectAgents,
  defaultFleetDir,
  encodeJoinCode,
  joinFleet,
  loadFleetConfig,
  offlineMebularOptions,
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
  it('quickstart → joinFleet（幂等）→ 订阅；版本不符拒绝', async () => {
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
        expect((await a.getNamespaceSubscriptions('tasks')).subscribers).toContain('device-A');
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

      // W2：quickstart --daemon 写守护 home + fleet 客户端（store=daemon）
      const D = join(root, 'D');
      const qd = await quickstart({ dir: D, device: 'device-D', listen: '/ip4/127.0.0.1/tcp/0', skipPortCheck: true, agents: AGENTS, buildSha: 'TESTSHA', daemon: true, daemonPort: 7901 });
      expect(qd.daemon?.endpoint).toBe('http://127.0.0.1:7901');
      const fleetCfg = JSON.parse(await (await import('node:fs/promises')).readFile(fleetConfigPath(D), 'utf-8'));
      const daemonCfg = JSON.parse(await (await import('node:fs/promises')).readFile(join(D, 'config.json'), 'utf-8'));
      expect(fleetCfg.store).toBe('daemon');
      expect(fleetCfg.daemon.endpoint).toBe('http://127.0.0.1:7901');
      expect(typeof fleetCfg.daemon.token).toBe('string');
      expect(daemonCfg.identity.mode).toBe('root');
      expect(daemonCfg.joinService.enabled).toBe(true);
      expect(daemonCfg.mcp.http.auth).toBe('bearer');

      // 默认值工具
      expect(defaultFleetDir({ HOME: '/home/x' })).toBe(join('/home/x', '.mebular'));
      expect(defaultFleetDir({ MEBULAR_HOME: '/m' })).toBe('/m');
      expect(defaultDeviceName('My-Host.local')).toBe('my-host.local');
      expect(typeof defaultFleetDir({ HOME: '/home/x' })).toBe('string');
      expect(defaultFleetDir({ HOME: '/home/x' })).toBe(join('/home/x', '.mebular'));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('服务安装回调；detectAgents(hermes)；join 目录占用', async () => {
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
        agents: AGENTS,
        buildSha: 'TESTSHA',
        installService: async () => ({ installed: true, note: 'stub' }),
        env: { PATH: binDir },
      });
      expect(qs.serviceInstalled).toBe(true);
      expect(qs.serviceNote).toBe('stub');

      // detectAgents(hermes) 分支
      const probed = detectAgents({ PATH: binDir }, 'linux');
      expect(probed.agents.some((a) => a.kind === 'hermes')).toBe(true);
      expect(probed.sources).toContain('hermes:PATH');

      // decode 直接 JSON 分支
      expect(decodeJoinCode(JSON.stringify(decodeJoinCode(qs.code))).device).toBe('device-A');

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
