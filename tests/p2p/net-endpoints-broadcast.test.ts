// C5 · 自动广播接线：记录进候选池但**不改授权**；过期/吊销忽略；opt-in 发布与去抖；relayCapable 无义务无权限
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { NET_NAMESPACE, NET_ENDPOINTS_EVENT, buildNetEndpointsPayload } from '../../src/sync/netEndpoints.js';

const LAN = '/ip4/192.168.9.20/tcp/4001/p2p/peerX';
const PUBLIC = '/ip4/198.51.100.20/tcp/4001/p2p/peerX';

describe('C5 · 广播记录只作 hints', () => {
  let dir: string;
  let master: { publicKey: Uint8Array; privateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-net-'));
    master = await new IdentityManager().generateUserMasterKey();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const makeApp = async (network: Record<string, unknown>) => {
    const hub = new InMemoryHub();
    const app = new Mebular({
      storagePath: join(dir, 'store.jsonl'),
      deviceId: 'device-self',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: {
        enabled: true,
        provider: hub.forPeer({ multihash: new Uint8Array(), pubKey: new Uint8Array(), id: 'device-self' }),
        ...network,
      },
      // 让本机成为策略权威：这样「若 hints 被越界写成授权」锚点才会真的变红
      sync: { autoSync: false, policyIssuers: ['device-self'] },
    });
    await app.initialize();
    return app;
  };

  it('注入 net_endpoints 记录 → 进候选池，但**授权判定不变**（hints 永不参与授权）', async () => {
    const app = await makeApp({});
    try {
      const before = await app.getEffectiveNamespaces('device-B');
      expect(before).toEqual([]);
      const policyEventsBefore = await app.eventLog.listEvents({ type: 'namespace_grant' });

      const payload = buildNetEndpointsPayload({ subject: 'device-B', addresses: [LAN, PUBLIC], relayCapable: true, now: Date.now(), ttlMs: 60_000 });
      const accepted = await app.ingestNetEndpointsEvent({ author: 'device-B', namespace: NET_NAMESPACE, data: payload });
      expect(accepted).toBe(true);

      // hints 进了候选池（source=learned）……
      expect(app.endpointBook?.addresses('device-B')).toEqual([PUBLIC, LAN]);
      // ……授权仍然为空（默认拒绝未被放松）
      expect(await app.getEffectiveNamespaces('device-B')).toEqual([]);
      expect(app.getNetEndpointsStatus().applied).toBe(1);
      // 读取侧绝不写授权状态：策略事件数量不变
      expect(await app.eventLog.listEvents({ type: 'namespace_grant' })).toHaveLength(policyEventsBefore.length);
    } finally {
      await app.shutdown();
    }
  });

  it('过期/吊销/伪装 subject 的记录被忽略（不写候选池）', async () => {
    const app = await makeApp({});
    try {
      const expired = buildNetEndpointsPayload({ subject: 'device-B', addresses: [LAN], relayCapable: false, now: 1_000, ttlMs: 1_000 });
      expect(await app.ingestNetEndpointsEvent({ author: 'device-B', namespace: NET_NAMESPACE, data: expired })).toBe(false);
      expect(app.getNetEndpointsStatus().ignored.expired).toBeGreaterThan(0);

      const spoofed = buildNetEndpointsPayload({ subject: 'device-B', addresses: [LAN], relayCapable: false });
      expect(await app.ingestNetEndpointsEvent({ author: 'device-attacker', namespace: NET_NAMESPACE, data: spoofed })).toBe(false);
      expect(app.getNetEndpointsStatus().ignored.subject).toBeGreaterThan(0);

      // 吊销级联：device-B 被吊销后其记录一律忽略
      await app.revokeDevice({ subject: 'device-B' });
      const fresh = buildNetEndpointsPayload({ subject: 'device-B', addresses: [PUBLIC], relayCapable: true });
      expect(await app.ingestNetEndpointsEvent({ author: 'device-B', namespace: NET_NAMESPACE, data: fresh })).toBe(false);
      expect(app.getNetEndpointsStatus().ignored.revoked).toBeGreaterThan(0);
      expect(app.endpointBook?.addresses('device-B') ?? []).not.toContain(PUBLIC);
    } finally {
      await app.shutdown();
    }
  });

  it('opt-in 才发布：未 opt-in 不产生记录；opt-in 后发布一次并去抖；relayCapable 不改变桥角色', async () => {
    const plain = await makeApp({});
    try {
      expect(await plain.publishNetEndpoints('test')).toBeNull();
      expect(plain.getNetEndpointsStatus().enabled).toBe(false);
    } finally {
      await plain.shutdown();
    }

    const app = await makeApp({ broadcast: { mode: 'full' } });
    try {
      const status0 = app.getNetEndpointsStatus();
      expect(status0.enabled).toBe(true);
      expect(status0.mode).toBe('full');

      const first = await app.publishNetEndpoints('test');
      expect(first?.subject).toBe('device-self');
      expect(typeof first?.relayCapable).toBe('boolean');
      // 重复发布（地址未变）→ 去抖，不再追加事件
      expect(await app.publishNetEndpoints('test')).toBeNull();
      expect(app.getNetEndpointsStatus().published).toBe(1);

      const events = await app.eventLog.listEvents({ type: NET_ENDPOINTS_EVENT, namespace: NET_NAMESPACE });
      expect(events).toHaveLength(1);
      expect(events[0]!.author).toBe('device-self');
      // relayCapable 只是信息：不使本机成为桥
      expect(app.node?.getRelayStatus().serving).toBe(false);
    } finally {
      await app.shutdown();
    }
  });

  it('sync.namespaces 含 __net__ 也视为 opt-in（无需显式 broadcast 配置）', async () => {
    const app = await makeApp({ broadcast: undefined });
    try {
      // 通过 sync.namespaces 打开：另建实例以覆盖该路径
      void app;
    } finally {
      await app.shutdown();
    }
    const hub = new InMemoryHub();
    const app2 = new Mebular({
      storagePath: join(dir, 'store2.jsonl'),
      deviceId: 'device-self2',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: {
        enabled: true,
        provider: hub.forPeer({ multihash: new Uint8Array(), pubKey: new Uint8Array(), id: 'device-self2' }),
      },
      sync: { autoSync: false, namespaces: [NET_NAMESPACE] },
    });
    await app2.initialize();
    try {
      expect(app2.getNetEndpointsStatus().enabled).toBe(true);
      const payload = await app2.publishNetEndpoints('test');
      expect(payload).not.toBeNull();
    } finally {
      await app2.shutdown();
    }
  });
});
