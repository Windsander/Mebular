// C6 · 中继内部化：内建 relay 角色判定 + 动态白名单/开关（纯逻辑）
// 判别性锚点：只有「对外可达或入站直连证据」才提供（auto）；白名单外拒绝；off 永不提供。
import { describe, it, expect } from '@jest/globals';
import { decideRelayRole, isPubliclyReachable, isLoopbackEndpoint } from '../../src/p2p/relay/RelayRole.js';
import { buildRelayPolicy } from '../../src/p2p/connection/RelayPolicy.js';

const peer = (id: string) => ({ toString: () => id });

describe('C6 RelayRole · 可达才提供中转', () => {
  it('auto：仅回环/私网监听且无入站直连证据 → 不提供（原因可读）', () => {
    const decision = decideRelayRole({
      mode: 'auto',
      listenAddrs: ['/ip4/127.0.0.1/tcp/4001/p2p/x', '/ip4/192.168.1.10/tcp/4001/p2p/x'],
    });
    expect(decision.serve).toBe(false);
    expect(decision.publicAddrs).toEqual([]);
    expect(decision.reason).toContain('不对外提供中转');
  });

  it('auto：有公网监听地址 → 提供（列出该地址）；私网不计入', () => {
    const decision = decideRelayRole({
      mode: 'auto',
      listenAddrs: ['/ip4/127.0.0.1/tcp/4001/p2p/x', '/ip4/203.0.113.9/tcp/4001/p2p/x'],
    });
    expect(decision.serve).toBe(true);
    expect(decision.publicAddrs).toEqual(['/ip4/203.0.113.9/tcp/4001/p2p/x']);
    expect(decision.reason).toContain('对外可达');
  });

  it('auto：仅入站直连证据（无公网监听）→ 也提供', () => {
    const decision = decideRelayRole({ mode: 'auto', listenAddrs: ['/ip4/10.0.0.5/tcp/4001'], inboundDirectEvidence: true });
    expect(decision.serve).toBe(true);
    expect(decision.reason).toContain('入站直连');
  });

  it('off 永不提供；on 强制提供（内部/测试开关）', () => {
    expect(decideRelayRole({ mode: 'off', listenAddrs: ['/ip4/203.0.113.9/tcp/1'] }).serve).toBe(false);
    expect(decideRelayRole({ mode: 'on', listenAddrs: ['/ip4/127.0.0.1/tcp/1'] }).serve).toBe(true);
  });

  it('地址分类辅助：回环/私网 vs 公网', () => {
    expect(isLoopbackEndpoint('/ip4/127.0.0.1/tcp/1')).toBe(true);
    expect(isPubliclyReachable('/ip4/10.1.2.3/tcp/1')).toBe(false);
    expect(isPubliclyReachable('/ip4/192.168.4.5/tcp/1')).toBe(false);
    expect(isPubliclyReachable('/ip4/198.51.100.7/tcp/1')).toBe(true);
  });
});

describe('C6 RelayPolicy · 动态开关与白名单', () => {
  it('shouldServe=false → 一律拒绝预约（等价「不当桥」）', () => {
    const policy = buildRelayPolicy({ shouldServe: () => false, isPeerAllowed: () => true });
    expect(policy.denyInboundRelayReservation(peer('device-A'))).toBe(true);
  });

  it('白名单外拒绝、白名单内放行（动态 isPeerAllowed）', () => {
    const allowed = new Set(['device-A']);
    const policy = buildRelayPolicy({ shouldServe: () => true, isPeerAllowed: (id) => allowed.has(id) });
    expect(policy.denyInboundRelayReservation(peer('device-A'))).toBe(false);
    expect(policy.denyInboundRelayReservation(peer('device-stranger'))).toBe(true);
  });

  it('默认限额：applyDefaultLimit/maxReservations 选项可覆盖，出站 circuit 可整体拒绝', () => {
    const policy = buildRelayPolicy({ maxReservations: 4, reservationTtlMs: 30_000, denyOutboundRelayedConnection: true, shouldServe: () => true });
    expect(policy.reservations).toEqual({ maxReservations: 4, defaultDurationLimit: 30_000 });
    expect(policy.denyOutboundRelayedConnection(peer('device-A'))).toBe(true);
  });
});
