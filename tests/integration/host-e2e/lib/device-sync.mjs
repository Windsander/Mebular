// Real two-device sync harness for the immersive journey.
//
// Both devices are full Mebular instances with the same user master key, a real
// P2PNode, a real SyncManager and an in-memory transport. Nothing is copied by
// hand: records, tombstones and DetailRecord nodes travel through the normal
// sync session, so a cross-device assertion exercises production sync code.
//
// The mock mDNS bus only replaces LAN discovery; the authenticated P2P handshake
// and the sync protocol are the real ones.

import { InMemoryHub } from '../../../../dist/index.js';

/** Shared in-memory mDNS bus (same shape as tests/integration/GraphSync). */
export class MockBonjourBus {
  constructor() {
    this.services = [];
    this.finders = [];
  }

  createInstance() {
    return {
      publish: (options) => {
        const service = {
          name: options.name,
          type: options.type,
          port: options.port,
          txt: options.txt ?? {},
          addresses: ['memory://local'],
        };
        this.services.push(service);
        for (const finder of [...this.finders]) finder(service);
      },
      find: (_query, callback) => {
        this.finders.push(callback);
        for (const service of this.services) callback(service);
        return {
          stop: () => {
            this.finders = this.finders.filter((finder) => finder !== callback);
          },
        };
      },
      destroy: () => {},
    };
  }
}

export function createSyncHarness() {
  const hub = new InMemoryHub();
  const bus = new MockBonjourBus();

  function network() {
    return {
      enabled: true,
      provider: hub,
      bonjourFactory: () => bus.createInstance(),
      lan: { enabled: true, autoDial: false },
      autoConnect: false,
    };
  }

  function sync(namespaces) {
    return {
      autoSync: true,
      pushOnWrite: true,
      namespaces,
    };
  }

  async function waitForNodes(devices, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (devices.every((device) => device.app?.node !== null && device.app?.node?.peerId)) return true;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    return false;
  }

  async function connect(left, right, { timeoutMs = 20000 } = {}) {
    if (!(await waitForNodes([left, right]))) throw new Error('P2P node was not ready');
    const leftPeer = right.app.node.peerId;
    const rightPeer = left.app.node.peerId;
    const leftDone = new Promise((resolve) => left.app.sync.once('sync-completed', resolve));
    const rightDone = new Promise((resolve) => right.app.sync.once('sync-completed', resolve));
    let lastError = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await left.app.node.connectToPeer(leftPeer);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
    }
    if (lastError !== null) throw lastError;
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('sync-completed timeout')), timeoutMs).unref?.();
    });
    const [leftResult, rightResult] = await Promise.race([
      Promise.all([leftDone, rightDone]),
      timeout,
    ]);
    return {
      left: leftResult,
      right: rightResult,
      peers: { left: leftPeer.id, right: rightPeer.id },
    };
  }

  function waitForSync(left, timeoutMs) {
    const leftDone = new Promise((resolve) => left.app.sync.once('sync-completed', resolve));
    return Promise.race([
      leftDone,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('sync-completed timeout')), timeoutMs).unref?.();
      }),
    ]);
  }

  async function request(left, right, { timeoutMs = 20000 } = {}) {
    if (!(await waitForNodes([left, right]))) throw new Error('P2P node was not ready');
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pending = waitForSync(left, Math.min(timeoutMs, 7000));
      let accepted = false;
      if (attempt === 0) {
        for (let poll = 0; poll < 8 && !accepted; poll += 1) {
          accepted = left.app.sync.requestSession(right.app.node.peerId.id);
          if (!accepted) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
        }
      }
      if (!accepted) {
        // The long DSH run can outlive an idle P2P connection. Drop it and
        // re-dial; the authenticated connection starts a fresh sync session.
        await left.app.node.disconnectPeer(right.app.node.peerId).catch(() => undefined);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
        await left.app.node.connectToPeer(right.app.node.peerId);
      }
      try {
        return await pending;
      } catch (error) {
        lastError = error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      }
    }
    throw lastError ?? new Error('sync request failed');
  }

  return { hub, bus, network, sync, connect, request };
}
