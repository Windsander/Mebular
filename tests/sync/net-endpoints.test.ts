// C5 · net_endpoints 记录（纯逻辑）：默认 full 三类并排序 / 过期忽略 / 吊销级联 / subject 绑定
import { describe, it, expect } from '@jest/globals';
import {
  NET_NAMESPACE,
  NET_KIND_PRIORITY,
  buildNetEndpointsPayload,
  classifyNetEndpoint,
  acceptNetEndpointsEvent,
  orderedNetEndpointAddresses,
  parseNetEndpointsPayload,
} from '../../src/sync/netEndpoints.js';

const LAN = '/ip4/192.168.9.20/tcp/4001/p2p/peerX';
const PUBLIC = '/ip4/198.51.100.20/tcp/4001/p2p/peerX';
const RELAY = '/ip4/203.0.113.20/tcp/4001/p2p/relayY/p2p-circuit/p2p/peerX';
const LOOPBACK = '/ip4/127.0.0.1/tcp/4001/p2p/peerX';

describe('C5 · 广播内容（默认 full）', () => {
  it('默认 full：发布实际存在的 lan/public/relay 三类地址，且按 public>lan>relay 排序', () => {
    const payload = buildNetEndpointsPayload({
      subject: 'device-A',
      addresses: [RELAY, LAN, PUBLIC],
      relayCapable: true,
      now: 1_000,
      ttlMs: 60_000,
    });
    expect(payload.endpoints.map((e) => e.kind)).toEqual(['public', 'lan', 'relay']);
    expect(orderedNetEndpointAddresses(payload)).toEqual([PUBLIC, LAN, RELAY]);
    expect(payload.expiry).toBe(61_000);
    expect(payload.relayCapable).toBe(true);
    expect(NET_KIND_PRIORITY.public).toBeLessThan(NET_KIND_PRIORITY.lan);
    expect(NET_KIND_PRIORITY.lan).toBeLessThan(NET_KIND_PRIORITY.relay);
  });

  it('relay-only 只发布 relay；off 档由调用方不发布；回环不外发；重复地址去重', () => {
    const relayOnly = buildNetEndpointsPayload({ subject: 'device-A', addresses: [RELAY, LAN, PUBLIC, LOOPBACK], relayCapable: false, mode: 'relay-only' });
    expect(relayOnly.endpoints.map((e) => e.addr)).toEqual([RELAY]);
    const full = buildNetEndpointsPayload({ subject: 'device-A', addresses: [LAN, LOOPBACK, LAN], relayCapable: false });
    expect(full.endpoints.map((e) => e.addr)).toEqual([LAN]);
    expect(classifyNetEndpoint(PUBLIC)).toBe('public');
    expect(classifyNetEndpoint(LAN)).toBe('lan');
    expect(classifyNetEndpoint(RELAY)).toBe('relay');
  });
});

describe('C5 · 读取侧过滤（本地策略）', () => {
  const payload = buildNetEndpointsPayload({ subject: 'device-A', addresses: [LAN, PUBLIC], relayCapable: true, now: 1_000, ttlMs: 60_000 });

  it('仅 subject 签发：author≠subject 或命名空间不对一律忽略', () => {
    expect(acceptNetEndpointsEvent({ author: 'device-A', namespace: NET_NAMESPACE, data: payload }, { now: 2_000 })).toMatchObject({ ok: true });
    expect(acceptNetEndpointsEvent({ author: 'device-B', namespace: NET_NAMESPACE, data: payload }, { now: 2_000 })).toEqual({ ok: false, reason: 'subject' });
    expect(acceptNetEndpointsEvent({ author: 'device-A', namespace: 'default', data: payload }, { now: 2_000 })).toEqual({ ok: false, reason: 'shape' });
  });

  it('过期记录被忽略（本地墙钟，不影响一致性）', () => {
    expect(acceptNetEndpointsEvent({ author: 'device-A', namespace: NET_NAMESPACE, data: payload }, { now: 61_000 })).toEqual({ ok: false, reason: 'expired' });
  });

  it('吊销级联过滤：subject 被吊销 → 忽略其记录', () => {
    const result = acceptNetEndpointsEvent(
      { author: 'device-A', namespace: NET_NAMESPACE, data: payload },
      { now: 2_000, isRevoked: (subject) => subject === 'device-A' },
    );
    expect(result).toEqual({ ok: false, reason: 'revoked' });
  });

  it('形状非法/空端点被拒（不抛异常）', () => {
    expect(parseNetEndpointsPayload(null)).toBeNull();
    expect(parseNetEndpointsPayload({ subject: 'd', endpoints: [{ addr: LAN, kind: 'wan' }], relayCapable: true, issuedAt: 1, expiry: 2 })).toBeNull();
    expect(acceptNetEndpointsEvent({ author: 'device-A', namespace: NET_NAMESPACE, data: { subject: 'device-A', endpoints: [], relayCapable: false, issuedAt: 1, expiry: 9_999 } }, { now: 2 })).toEqual({ ok: false, reason: 'empty' });
  });
});
