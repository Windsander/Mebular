// 跨机前置预检单元测试（G3-P2）
//
// probe/log 注入，覆盖：探测超时、relay 不可达、只给 --relay 不给 --peer、
// 格式错误、全可达。不依赖真实网络。

import { describe, it, expect } from '@jest/globals';
import { parseTcpTarget, preflightCross } from '../../scripts/wan-preflight.mjs';

function capture() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

describe('wan-preflight.parseTcpTarget', () => {
  it('解析 direct / relay-circuit / dns 地址；拒绝非 multiaddr', () => {
    expect(parseTcpTarget('/ip4/1.2.3.4/tcp/4001/p2p/abc')).toEqual({ host: '1.2.3.4', port: 4001 });
    // circuit 地址取第一个 /tcp/（relay 侧）
    expect(parseTcpTarget('/ip4/1.2.3.4/tcp/4001/p2p/relay/p2p-circuit/p2p/abc')).toEqual({
      host: '1.2.3.4',
      port: 4001,
    });
    expect(parseTcpTarget('/dns4/host.example/tcp/9000')).toEqual({ host: 'host.example', port: 9000 });
    expect(parseTcpTarget('not-a-multiaddr')).toBeNull();
    expect(parseTcpTarget(undefined)).toBeNull();
    expect(parseTcpTarget('/ip4/1.2.3.4/udp/4001/quic')).toBeNull();
  });
});

describe('wan-preflight.preflightCross', () => {
  it('探测超时：返回 false，点名 HOST_A 且提示超时', async () => {
    const { lines, log } = capture();
    const probe = async () => ({ ok: false, error: 'TCP 连接超时 1ms' });
    const ok = await preflightCross({
      peer: '/ip4/1.2.3.4/tcp/4001',
      peerId: 'device-A',
      probe,
      log,
      timeoutMs: 1,
    });
    expect(ok).toBe(false);
    const text = lines.join('\n');
    expect(text).toContain('前置预检未通过');
    expect(text).toContain('HOST_A 不可达');
    expect(text).toContain('超时');
  });

  it('relay 不可达：HOST_A 通、RELAY 挂 → false 且点名 RELAY', async () => {
    const { lines, log } = capture();
    const probe = async (host) =>
      host === 'relay.example' ? { ok: false, error: 'ECONNREFUSED' } : { ok: true, error: null };
    const ok = await preflightCross({
      peer: '/ip4/1.2.3.4/tcp/4001',
      peerId: 'device-A',
      relay: '/dns4/relay.example/tcp/4000',
      probe,
      log,
    });
    expect(ok).toBe(false);
    const text = lines.join('\n');
    expect(text).toContain('RELAY 不可达');
    expect(text).toContain('relay.example:4000');
  });

  it('只给 --relay 不给 --peer：缺 HOST_A 地址与 deviceId，且不触发探测', async () => {
    const { lines, log } = capture();
    let probed = false;
    const probe = async () => {
      probed = true;
      return { ok: true, error: null };
    };
    const ok = await preflightCross({ relay: '/ip4/9.9.9.9/tcp/4000', probe, log });
    expect(ok).toBe(false);
    expect(probed).toBe(false);
    const text = lines.join('\n');
    expect(text).toContain('缺少 HOST_A 地址');
    expect(text).toContain('缺少 HOST_A deviceId');
  });

  it('地址格式错误：返回 false 且提示解析失败', async () => {
    const { lines, log } = capture();
    const ok = await preflightCross({
      peer: 'not-a-multiaddr',
      peerId: 'device-A',
      probe: async () => ({ ok: true, error: null }),
      log,
    });
    expect(ok).toBe(false);
    expect(lines.join('\n')).toContain('解析不出 TCP 目标');
  });

  it('全部可达：返回 true 并打印通过信息', async () => {
    const { lines, log } = capture();
    const ok = await preflightCross({
      peer: '/ip4/1.2.3.4/tcp/4001',
      peerId: 'device-A',
      relay: '/ip4/5.6.7.8/tcp/4000',
      probe: async () => ({ ok: true, error: null }),
      log,
    });
    expect(ok).toBe(true);
    expect(lines.join('\n')).toContain('[preflight] 通过');
  });
});
