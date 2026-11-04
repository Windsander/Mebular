// P1：三机（进程内 loopback）能力卡同步可见。
import { describe, it, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import {
  AGENT_NAMESPACE,
  activeCapabilityCards,
  agentDirectoryStore,
  latestCapabilityCards,
  listCapabilityCards,
  publishFleetCards,
  type FleetAgentConfig,
  type FleetConfig,
} from '../../packages/fleet/src/index.js';
import { useHeavyTimeout } from '../helpers/timeouts.js';

useHeavyTimeout();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function config(device: string, capabilities: string[]): FleetConfig {
  const agents: FleetAgentConfig[] = [{ name: 'worker', kind: 'echo', capabilities }];
  return {
    v: 1,
    device,
    dir: join(tmpdir(), `fleet-card-sync-${device}`),
    storagePath: join(tmpdir(), `fleet-card-sync-${device}`, 'store.jsonl'),
    masterKeyFile: join(tmpdir(), `fleet-card-sync-${device}`, 'master-key.json'),
    namespace: 'tasks',
    listen: '/ip4/127.0.0.1/tcp/0',
    peers: [],
    agents,
  };
}

describe('P1 三机能力卡同步', () => {
  it('A/B/C 各自发布能力卡后，三端都能读到三张最新卡', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-card-sync-'));
    const master = await Mebular.generateUserMasterKey();
    const encryption = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
    const hub = new InMemoryHub();
    const mk = (device: string) => new Mebular({
      storagePath: join(dir, `${device}.jsonl`),
      deviceId: device,
      encryption,
      network: { enabled: true, provider: hub },
      sync: {
        autoSync: true,
        pushOnWrite: true,
        pushOnWriteThrottleMs: 20,
        namespaces: ['tasks', AGENT_NAMESPACE],
        antiEntropy: { enabled: true, intervalMs: 3_600_000, jitterRatio: 0 },
      },
    });
    const a = mk('device-A');
    const b = mk('device-B');
    const c = mk('device-C');
    try {
      await a.initialize();
      await b.initialize();
      await c.initialize();
      // 全互连（InMemoryHub 的拨号/接入是单连接语义；三机全互连最稳定）。
      await b.node!.connectToPeer(a.node!.peerId);
      await c.node!.connectToPeer(a.node!.peerId);
      await c.node!.connectToPeer(b.node!.peerId);
      await a.node!.connectToPeer(b.node!.peerId);
      await a.node!.connectToPeer(c.node!.peerId);
      await b.node!.connectToPeer(c.node!.peerId);

      for (const [mebular, device, capabilities] of [
        [a, 'device-A', ['code.write']],
        [b, 'device-B', ['review']],
        [c, 'device-C', ['research']],
      ] as const) {
        const result = await publishFleetCards({
          mebular,
          config: config(device, [...capabilities]),
          now: 100,
        });
        expect(result.errors).toEqual([]);
        expect(result.cards.published).toBe(1);
      }

      const deadline = Date.now() + 10_000;
      let visible = false;
      while (Date.now() < deadline) {
        await a.sync.runAntiEntropyCycle();
        await b.sync.runAntiEntropyCycle();
        await c.sync.runAntiEntropyCycle();
        const sets = await Promise.all([a, b, c].map(async (mebular) => {
          const cards = activeCapabilityCards(latestCapabilityCards(await listCapabilityCards(mebular)));
          const directories = await agentDirectoryStore(mebular, AGENT_NAMESPACE).all();
          return {
            devices: cards.map((card) => card.device).sort(),
            directoryDevices: [...new Set(directories.map((entry) => entry.device))].sort(),
          };
        }));
        visible = sets.every((set) =>
          JSON.stringify(set.devices) === JSON.stringify(['device-A', 'device-B', 'device-C'])
          && JSON.stringify(set.directoryDevices) === JSON.stringify(['device-A', 'device-B', 'device-C']));
        if (visible) break;
        await sleep(25);
      }
      expect(visible).toBe(true);

      const cardsA = activeCapabilityCards(latestCapabilityCards(await listCapabilityCards(a)));
      expect(cardsA.map((card) => [card.device, card.agent, card.capabilities])).toEqual([
        ['device-A', 'worker', ['code.write', 'fleet.task']],
        ['device-B', 'worker', ['fleet.task', 'review']],
        ['device-C', 'worker', ['fleet.task', 'research']],
      ]);
    } finally {
      await a.shutdown().catch(() => undefined);
      await b.shutdown().catch(() => undefined);
      await c.shutdown().catch(() => undefined);
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
