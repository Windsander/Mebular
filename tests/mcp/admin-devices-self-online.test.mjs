// `/admin/api/devices`：self 是本地节点，始终 online=true；对端仍按真实已认证连接判定。
import { describe, it, expect } from '@jest/globals';
import { buildDevices, POLICY_NS } from '../../packages/mcp/src/admin.mjs';

function makeApp({ policyEvents = [], connections = [] } = {}) {
  return {
    deviceId: 'device-self',
    eventLog: {
      listEvents: async ({ namespace } = {}) => (namespace === POLICY_NS ? policyEvents : []),
    },
    node: {
      isRunning: () => true,
      getConnectionManager: () => ({ getConnections: () => connections }),
      getHandshake: () => ({ getSession: () => null }),
    },
    sync: {
      getSyncStatus: async () => null,
      getSubscriptionNamespaces: () => ['tasks'],
      getPendingEvents: async () => [],
    },
    getSubscriptions: async () => ['tasks'],
    getDeviceNames: async () => ({}),
    getConvergenceStatus: () => null,
    getBlockedDevices: async () => [],
  };
}

const subscriptionEvent = (issuer, member) => ({
  id: `sub-${issuer}-${member}`,
  timestamp: 1_700_000_000_000,
  author: issuer,
  type: 'namespace_subscription',
  data: { subscription: { member, namespace: 'tasks', active: true } },
});

describe('admin /admin/api/devices：self online', () => {
  it('self 恒为 online（本地节点），不依赖入站连接', async () => {
    const devices = await buildDevices({ app: makeApp(), config: {}, runtime: null });
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ deviceId: 'device-self', online: true });
  });

  it('对端仍按真实连接：未连接 = offline', async () => {
    const app = makeApp({ policyEvents: [subscriptionEvent('device-self', 'device-peer')] });
    const devices = await buildDevices({ app, config: {}, runtime: null });
    const byId = new Map(devices.map((device) => [device.deviceId, device]));
    expect(byId.get('device-self')?.online).toBe(true);
    expect(byId.get('device-peer')?.online).toBe(false);
  });
});
