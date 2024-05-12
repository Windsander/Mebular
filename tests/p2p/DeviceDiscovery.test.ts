import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { DeviceDiscovery, type BonjourService, type BonjourServiceInstance, type BonjourServiceFactory } from '../../src/p2p/DeviceDiscovery.js';
import type { PeerId, PeerInfo } from '../../src/p2p/P2PNetwork.js';

function createPeerId(id: string): PeerId {
  return {
    id,
    multihash: new TextEncoder().encode(id),
    pubKey: new TextEncoder().encode(id),
  } as PeerId;
}

function createMockBonjourService(): BonjourServiceInstance & {
  _addDiscoveredService: (svc: BonjourService) => void;
  _getPublishedServices: () => BonjourService[];
} {
  const discoveredServices: BonjourService[] = [];
  const publishedServices: BonjourService[] = [];
  const registeredCallbacks: ((svc: BonjourService) => void)[] = [];

  const instance: BonjourServiceInstance & {
    _addDiscoveredService: (svc: BonjourService) => void;
    _getPublishedServices: () => BonjourService[];
  } = {
    publish: jest.fn((options) => {
      publishedServices.push(options as unknown as BonjourService);
    }),
    find: jest.fn((_query: { type: string }, callback: (svc: BonjourService) => void) => {
      registeredCallbacks.push(callback);
      // Also trigger any already-discovered services
      discoveredServices.forEach((svc) => callback(svc));
      return {
        stop: jest.fn(),
      };
    }),
    destroy: jest.fn(),
    _addDiscoveredService: (svc: BonjourService) => {
      discoveredServices.push(svc);
      // Notify all registered callbacks immediately
      registeredCallbacks.forEach((cb) => cb(svc));
    },
    _getPublishedServices: () => publishedServices,
  };

  return instance;
}

const mockPublishedService: BonjourService = {
  name: 'test-service',
  type: '_mebular._tcp',
  port: 40000,
  txt: { id: 'peer-1' },
};

describe('DeviceDiscovery', () => {
  let discovery: DeviceDiscovery;
  let localPeerId: PeerId;
  let mockService: BonjourServiceInstance & {
    _addDiscoveredService: (svc: BonjourService) => void;
    _getPublishedServices: () => BonjourService[];
  };

  beforeEach(() => {
    jest.clearAllMocks();

    localPeerId = createPeerId('local-peer-' + Math.random().toString(36).slice(2));
    mockService = createMockBonjourService();

    const createBonjourService: BonjourServiceFactory = () => mockService;

    discovery = new DeviceDiscovery({
      serviceType: '_mebular._tcp',
      serviceName: 'mebular-device',
      interval: 100,
      maxPeers: 10,
      createBonjourService,
    });

    discovery.setLocalInfo(localPeerId, 40000);
  });

  afterEach(async () => {
    if (discovery && discovery.isRunning()) {
      await discovery.stop();
    }
    jest.clearAllMocks();
  });

  it('should create with default options', () => {
    const defaultDiscovery = new DeviceDiscovery();
    expect(defaultDiscovery['options'].timeout).toBe(30000);
    expect(defaultDiscovery['options'].interval).toBe(5000);
    expect(defaultDiscovery['options'].maxPeers).toBe(100);
    expect(defaultDiscovery['options'].serviceType).toBe('_mebular._tcp');
    expect(defaultDiscovery['options'].serviceName).toBe('mebular-device');
  });

  it('should create with custom options', () => {
    const customDiscovery = new DeviceDiscovery({
      serviceType: '_custom._tcp',
      serviceName: 'custom-device',
      interval: 200,
      maxPeers: 20,
      timeout: 10000,
    });
    expect(customDiscovery['options'].serviceType).toBe('_custom._tcp');
    expect(customDiscovery['options'].serviceName).toBe('custom-device');
    expect(customDiscovery['options'].interval).toBe(200);
    expect(customDiscovery['options'].maxPeers).toBe(20);
    expect(customDiscovery['options'].timeout).toBe(10000);
  });

  it('should set local peer info', () => {
    const peerId = createPeerId('test-peer');
    discovery.setLocalInfo(peerId, 50000);
    expect((discovery as any).localPeerId).toBeDefined();
    expect((discovery as any).localPort).toBe(50000);
  });

  it('should start successfully', async () => {
    await discovery.start();
    expect(discovery.isRunning()).toBe(true);
    expect(mockService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringContaining('mebular-device'),
        type: '_mebular._tcp',
        port: 40000,
      })
    );
    expect(mockService.find).toHaveBeenCalledWith(
      { type: '_mebular._tcp' },
      expect.any(Function)
    );
  });

  it('should throw when starting without bonjour factory', async () => {
    const noFactoryDiscovery = new DeviceDiscovery({
      serviceType: '_mebular._tcp',
      serviceName: 'test-device',
    });
    noFactoryDiscovery.setLocalInfo(localPeerId, 40000);

    await expect(noFactoryDiscovery.start()).rejects.toThrow('Bonjour service factory not provided');
  });

  it('should throw when starting twice', async () => {
    await discovery.start();
    await expect(discovery.start()).rejects.toThrow('Discovery already running');
    await discovery.stop();
  });

  it('should throw when stopping without start', async () => {
    await expect(discovery.stop()).rejects.toThrow('Discovery not running');
  });

  it('should stop successfully', async () => {
    await discovery.start();
    expect(discovery.isRunning()).toBe(true);

    await discovery.stop();
    expect(discovery.isRunning()).toBe(false);
    expect(mockService.destroy).toHaveBeenCalled();
  });

  it('should discover peers via mDNS', async () => {
    await discovery.start();
    expect(discovery.isRunning()).toBe(true);

    // Add a discovered service
    mockService._addDiscoveredService(mockPublishedService);

    const peers = discovery.getAllPeers();
    expect(peers.length).toBeGreaterThan(0);
    expect(peers[0]!.name).toBe('test-service');
    expect(peers[0]!.port).toBe(40000);
  });

  it('should emit peer-discovered event', async () => {
    let eventFired = false;
    discovery.on('peer-discovered', () => {
      eventFired = true;
    });

    await discovery.start();

    // Add a discovered service
    mockService._addDiscoveredService(mockPublishedService);

    expect(eventFired).toBe(true);
  });

  it('should filter out self from discovered peers', async () => {
    const mockServiceSelf: BonjourService = {
      name: 'test-service-self',
      type: '_mebular._tcp',
      port: 40000,
      txt: { id: localPeerId.id },
    };

    await discovery.start();

    // Add a service with same ID as local peer
    mockService._addDiscoveredService(mockServiceSelf);

    const peers = discovery.getAllPeers();
    expect(peers.length).toBe(0);
  });

  it('should update existing peer info', async () => {
    const updatedService: BonjourService = {
      name: 'test-service',
      type: '_mebular._tcp',
      port: 40001,
      txt: { id: 'peer-1' },
    };

    await discovery.start();

    // First discovery
    mockService._addDiscoveredService(mockPublishedService);
    expect(discovery.getDiscoveredPeerCount()).toBe(1);

    // Second discovery with updated port
    mockService._addDiscoveredService(updatedService);

    const peer = discovery.getPeer(createPeerId('peer-1'));
    expect(peer).toBeDefined();
    expect((peer as PeerInfo).port).toBe(40001);
  });

  it('should remove stale peers based on timeout', async () => {
    await discovery.start();

    // Add a discovered service
    mockService._addDiscoveredService(mockPublishedService);
    const initialCount = discovery.getDiscoveredPeerCount();
    expect(initialCount).toBeGreaterThan(0);

    // Manually age out peers by modifying timestamps
    const peers = discovery.getAllPeers();
    if (peers.length > 0) {
      (peers[0] as any).timestamp = Date.now() - 60000; // 1 minute old
    }

    // Trigger cleanup
    (discovery as any).discoverPeers();

    // Peer should be removed due to timeout
    const remainingPeers = discovery.getAllPeers();
    expect(remainingPeers.length).toBeLessThan(initialCount);
  });

  it('should limit peer count to maxPeers', () => {
    // Create discovery with small maxPeers
    const limitedDiscovery = new DeviceDiscovery({
      serviceType: '_mebular._tcp',
      serviceName: 'test-device',
      interval: 100,
      maxPeers: 3,
      timeout: 5000,
      createBonjourService: () => mockService,
    });

    limitedDiscovery.setLocalInfo(localPeerId, 40000);
    (limitedDiscovery as any).discoveredPeers.clear();

    // Add 5 peers (more than maxPeers)
    for (let i = 0; i < 5; i++) {
      const peerId = createPeerId('peer-' + i);
      const peerInfo: PeerInfo = {
        peerId,
        name: 'peer-' + i,
        addresses: [],
        port: 40000 + i,
        timestamp: Date.now() - (i * 1000),
      };
      (limitedDiscovery as any).discoveredPeers.set(peerId.id, peerInfo);
    }

    expect(limitedDiscovery.getDiscoveredPeerCount()).toBe(5);

    // Trigger cleanup
    (limitedDiscovery as any).discoverPeers();

    // Should only keep the 3 most recent peers
    const remainingPeers = limitedDiscovery.getAllPeers();
    expect(remainingPeers.length).toBeLessThanOrEqual(3);
  });

  it('should get peer by peerId', async () => {
    await discovery.start();

    // Add a discovered service
    mockService._addDiscoveredService(mockPublishedService);

    const discoveredPeer = discovery.getAllPeers()[0];
    if (discoveredPeer) {
      const foundPeer = discovery.getPeer(discoveredPeer.peerId);
      expect(foundPeer).toBeDefined();
      expect(foundPeer?.name).toBe(discoveredPeer.name);
    }
  });

  it('should remove specific peer', async () => {
    await discovery.start();

    // Add a discovered service
    mockService._addDiscoveredService(mockPublishedService);

    const discoveredPeer = discovery.getAllPeers()[0];
    if (discoveredPeer) {
      const initialCount = discovery.getDiscoveredPeerCount();
      discovery.removePeer(discoveredPeer.peerId);
      expect(discovery.getDiscoveredPeerCount()).toBe(initialCount - 1);
    }
  });

  it('should clear all discovered peers', async () => {
    await discovery.start();

    // Add a discovered service
    mockService._addDiscoveredService(mockPublishedService);

    expect(discovery.getDiscoveredPeerCount()).toBeGreaterThan(0);
    discovery.clearDiscoveredPeers();
    expect(discovery.getDiscoveredPeerCount()).toBe(0);
  });

  it('should have correct peer count', async () => {
    await discovery.start();

    // Add a discovered service
    mockService._addDiscoveredService(mockPublishedService);

    const count = discovery.getDiscoveredPeerCount();
    const allPeers = discovery.getAllPeers();
    expect(count).toBe(allPeers.length);
  });

  it('should handle peer discovery with multiple services', async () => {
    await discovery.start();

    // Simulate multiple discoveries
    const services: BonjourService[] = [];
    for (let i = 0; i < 3; i++) {
      const service: BonjourService = {
        name: 'test-service-' + i,
        type: '_mebular._tcp',
        port: 40000 + i,
        txt: { id: 'peer-' + i },
      };
      services.push(service);
    }

    // Add all services
    services.forEach((svc) => mockService._addDiscoveredService(svc));

    const peers = discovery.getAllPeers();
    expect(peers.length).toBeGreaterThanOrEqual(3);
  });
});
