// NAT 穿透单元测试：注入式探测与信令通道

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  NATTraversal,
  isPublicIPv4,
  type NatProber,
  type HolePunchChannel,
} from '../../src/p2p/nat/NATTraversal.js';
import { createTestIdentity, type TestIdentity } from './helpers.js';

describe('NATTraversal', () => {
  let local: TestIdentity;
  let remote: TestIdentity;

  beforeEach(async () => {
    local = await createTestIdentity('device-local');
    remote = await createTestIdentity('device-remote');
  });

  it('isPublicIPv4 区分公网与各类保留地址', () => {
    expect(isPublicIPv4('10.0.0.5')).toBe(false);
    expect(isPublicIPv4('172.16.3.2')).toBe(false);
    expect(isPublicIPv4('172.32.0.1')).toBe(true);
    expect(isPublicIPv4('192.168.1.1')).toBe(false);
    expect(isPublicIPv4('127.0.0.1')).toBe(false);
    expect(isPublicIPv4('169.254.1.1')).toBe(false);
    expect(isPublicIPv4('100.64.0.1')).toBe(false);
    expect(isPublicIPv4('8.8.8.8')).toBe(true);
    expect(isPublicIPv4('not-an-ip')).toBe(false);
  });

  it('无探测服务且本机无公网地址时保守返回 unknown', async () => {
    const nat = new NATTraversal({ localInterfaces: ['nonexistent-if0'] });
    await nat.start();
    try {
      await expect(nat.detectNATType(local.peerId)).resolves.toBe('unknown');
    } finally {
      await nat.stop();
    }
  });

  it('外部映射一致 → restricted；不一致 → symmetric', async () => {
    const consistentProber: NatProber = {
      getExternalMapping: async () => ({ address: '203.0.113.1', port: 40000 }),
      testMappingConsistency: async () => 'consistent',
    };
    const nat1 = new NATTraversal({ localInterfaces: ['nonexistent-if0'], prober: consistentProber });
    await nat1.start();
    await expect(nat1.detectNATType(local.peerId)).resolves.toBe('restricted');
    await nat1.stop();

    const symmetricProber: NatProber = {
      getExternalMapping: async () => ({ address: '203.0.113.1', port: 40000 }),
      testMappingConsistency: async () => 'inconsistent',
    };
    const nat2 = new NATTraversal({ localInterfaces: ['nonexistent-if0'], prober: symmetricProber });
    await nat2.start();
    await expect(nat2.detectNATType(local.peerId)).resolves.toBe('symmetric');
    await nat2.stop();
  });

  it('收集候选地址：本机网卡 + 外部映射，均带端口且不重复', async () => {
    const prober: NatProber = {
      getExternalMapping: async () => ({ address: '203.0.113.1', port: 4000 }),
      testMappingConsistency: async () => 'consistent',
    };
    const nat = new NATTraversal({ prober, localPort: 4000 });
    await nat.start();
    try {
      const candidates = await nat.gatherCandidates();
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates).toContain('203.0.113.1:4000');
      expect(candidates.every((c) => c.endsWith(':4000'))).toBe(true);
      expect(new Set(candidates).size).toBe(candidates.length);
    } finally {
      await nat.stop();
    }
  });

  it('打洞成功返回打通的路由', async () => {
    const channel: HolePunchChannel = {
      exchangeCandidates: async () => ['203.0.113.9:5000', '198.51.100.2:5000'],
      dial: async (address) => address === '198.51.100.2:5000',
    };
    const nat = new NATTraversal({ channel, holePunchingTimeout: 3000 });
    await nat.start();
    try {
      await expect(nat.startHolePunching(local.peerId, remote.peerId)).resolves.toBe('198.51.100.2:5000');
      expect(nat.getEstablishedRoute()).toBe('198.51.100.2:5000');
    } finally {
      await nat.stop();
    }
  });

  it('全部候选不可达时打洞失败，可回退到中继', async () => {
    const channel: HolePunchChannel = {
      exchangeCandidates: async () => ['203.0.113.9:5000'],
      dial: async () => false,
    };
    const nat = new NATTraversal({ channel, holePunchingTimeout: 3000 });
    nat.addRelayServer({ address: 'relay.example.com', port: 7777 });
    await nat.start();
    try {
      await expect(nat.startHolePunching(local.peerId, remote.peerId)).rejects.toThrow(/failed/);
      expect(nat.selectRelay()).toEqual({ address: 'relay.example.com', port: 7777 });
    } finally {
      await nat.stop();
    }
  });

  it('未配置信令通道时打洞报错', async () => {
    const nat = new NATTraversal();
    await nat.start();
    try {
      await expect(nat.startHolePunching(local.peerId, remote.peerId)).rejects.toThrow(
        'Hole punch channel not configured',
      );
    } finally {
      await nat.stop();
    }
  });
});
