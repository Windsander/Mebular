// H1（Console 轮）：`Mebular` 必须把 `network.libp2p.relayUnlimited` 透传给 `Libp2pProvider.create`
// ——L5「relay 默认限额、需显式放开」从守护/MCP 路径才可达。判别性：删掉 src/mebular.ts 的转发行必须红。
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { Libp2pProvider } from '../../src/p2p/transport/Libp2pProvider.js';

describe('H1 relayUnlimited 透传', () => {
  let dir: string;
  let master: { publicKey: Uint8Array; privateKey: CryptoKey };
  const calls: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-relay-unlimited-'));
    master = await new IdentityManager().generateUserMasterKey();
    calls.length = 0;
    // 断言「门面传给 provider 的 options」：以 InMemoryHub 作为等价传输实现返回，避开真实 libp2p 依赖。
    jest.spyOn(Libp2pProvider, 'create').mockImplementation((async (options: Record<string, unknown>) => {
      calls.push(options);
      const hub = new InMemoryHub();
      return {
        start: async () => undefined,
        stop: async () => undefined,
        dial: (peer: unknown, addr?: string) => hub.dial(peer as never, addr),
        onIncomingConnection: (cb: unknown) => hub.onIncomingConnection(cb as never),
        getMultiaddrs: () => [] as string[],
        forPeer: (peer: unknown) => hub.forPeer(peer as never),
        getLocalPeerId: () => ({ multihash: new Uint8Array(), pubKey: new Uint8Array(), id: 'unused' }),
      };
    }) as never);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const make = (libp2p: Record<string, unknown>): Mebular =>
    new Mebular({
      storagePath: join(dir, 'store.jsonl'),
      deviceId: 'device-RU',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'], ...libp2p } },
      sync: { autoSync: false },
    });

  it('relayUnlimited=true 透传到 provider options', async () => {
    const m = make({ relayUnlimited: true });
    await m.initialize();
    await m.shutdown();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.relayUnlimited).toBe(true);
  });

  it('未配置时透传 undefined（默认限额，不隐式放开）', async () => {
    const m = make({});
    await m.initialize();
    await m.shutdown();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.relayUnlimited).toBeUndefined();
  });
});
