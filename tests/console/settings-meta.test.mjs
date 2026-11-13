// 设置 · 常用短 meta：只展示可扫读的 host:port，不把 multiaddr / URL 长串塞进行宽。

import { describe, expect, it } from '@jest/globals';
import { settingsEndpointHostPort, settingsListenHostPort } from '../../packages/console/settings-ia.js';

describe('设置只读状态短 meta', () => {
  it.each([
    ['/ip4/127.0.0.1/tcp/4001', '127.0.0.1:4001'],
    ['/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWExample', '127.0.0.1:4001'],
    ['/dns4/relay.example.com/tcp/443/tls', 'relay.example.com:443'],
    ['/ip6/::1/tcp/4001/p2p/peer-a', '[::1]:4001'],
    ['/ip4/127.0.0.1/udp/4001', '—'],
    ['/ip4/127.0.0.1/tcp/70000', '—'],
    ['', '—'],
    [null, '—'],
  ])('multiaddr %s → %s', (input, expected) => {
    expect(settingsListenHostPort(input)).toBe(expected);
  });

  it.each([
    ['http://192.168.0.100:4002', '192.168.0.100:4002'],
    ['https://invite.example.com:8443/join?from=qr', 'invite.example.com:8443'],
    ['invite.example.com:4002/', 'invite.example.com:4002'],
    ['http://user:secret@invite.example.com:4002/join', 'invite.example.com:4002'],
    ['http://[::1]:4002/join', '[::1]:4002'],
    ['https://invite.example.com/join', '—'],
    ['not a URL', '—'],
    [undefined, '—'],
  ])('endpoint %s → %s', (input, expected) => {
    expect(settingsEndpointHostPort(input)).toBe(expected);
  });
});
