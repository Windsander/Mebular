// C2 · relay 白名单/预约上限策略单测（纯函数；Libp2pProvider 据此组装 connectionGater 与 reservations）
import { describe, it, expect } from '@jest/globals';
import { buildRelayPolicy } from '../../src/p2p/connection/RelayPolicy.js';

const peer = (id: string) => ({ toString: () => id });

describe('C2 RelayPolicy', () => {
  it('默认开放：未配白名单时放行任意 peer（仍受 maxReservations 约束）', () => {
    const policy = buildRelayPolicy({ maxReservations: 8 });
    expect(policy.denyInboundRelayReservation(peer('peer-A'))).toBe(false);
    expect(policy.denyOutboundRelayedConnection(peer('peer-A'))).toBe(false);
    expect(policy.reservations).toEqual({ maxReservations: 8 });
  });

  it('白名单模式：仅放行列出的 peer，其余拒绝', () => {
    const policy = buildRelayPolicy({ allowedRelayPeers: ['peer-A'] });
    expect(policy.isAllowed('peer-A')).toBe(true);
    expect(policy.denyInboundRelayReservation(peer('peer-A'))).toBe(false);
    expect(policy.denyInboundRelayReservation(peer('peer-B'))).toBe(true);
  });

  it('拒绝列表优先于白名单', () => {
    const policy = buildRelayPolicy({ allowedRelayPeers: ['peer-A'], deniedRelayPeers: ['peer-A'] });
    expect(policy.isDenied('peer-A')).toBe(true);
    expect(policy.isAllowed('peer-A')).toBe(false);
    expect(policy.denyInboundRelayReservation(peer('peer-A'))).toBe(true);
  });

  it('出站经 circuit 可整体拒绝；预约时长/上限进入 reservations', () => {
    const policy = buildRelayPolicy({ denyOutboundRelayedConnection: true, reservationTtlMs: 60_000, maxReservations: 2 });
    expect(policy.denyOutboundRelayedConnection(peer('peer-A'))).toBe(true);
    expect(policy.reservations).toEqual({ maxReservations: 2, defaultDurationLimit: 60_000 });
  });
});
