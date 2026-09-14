// G6.6 跨网 e2e 门禁单元测试
//
// 覆盖：需求检查（缺失即红）、证据判定（全绿/逐项红）、出口判据、以及
// 真实调用门禁脚本「无环境 → 退出码 1 且打印所需环境」。不依赖真实两机。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from '@jest/globals';
import { checkCrossEnv, judgeCrossEvidence, REQUIRED_ENV } from '../../scripts/mcp-cross-lib.mjs';
import { judgeDifferentNetwork, isPrivateIp } from '../../scripts/wan-egress.mjs';

const gateScript = fileURLToPath(new URL('../../scripts/verify-mcp-cross.mjs', import.meta.url));

const FULL_ENV = {
  MEBULAR_WAN_PEER: '/ip4/203.0.113.9/tcp/4001/p2p/relay/p2p-circuit/p2p/abc',
  MEBULAR_WAN_PEER_ID: 'device-A',
  MEBULAR_WAN_MCP_A: 'https://a.example:7331',
  MEBULAR_WAN_MCP_A_TOKEN: 'tok-a',
  MEBULAR_WAN_PEER_EGRESS: '198.51.100.7',
};

describe('mcp-cross.checkCrossEnv', () => {
  it('空环境：ok=false，且列出全部必需 env', () => {
    const r = checkCrossEnv({});
    expect(r.ok).toBe(false);
    for (const [k] of REQUIRED_ENV) expect(r.missing).toContain(k);
    expect(r.missing).toHaveLength(REQUIRED_ENV.length);
  });

  it('缺一项：ok=false 且只点名缺的那项', () => {
    const r = checkCrossEnv({ ...FULL_ENV, MEBULAR_WAN_MCP_A_TOKEN: '' });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['MEBULAR_WAN_MCP_A_TOKEN']);
  });

  it('必需齐全：ok=true，B 端与输出取默认值', () => {
    const r = checkCrossEnv(FULL_ENV);
    expect(r.ok).toBe(true);
    expect(r.config.mcpB).toBe('http://127.0.0.1:7331');
    expect(r.config.out).toBe('mcp-cross-evidence.json');
    expect(r.config.peerId).toBe('device-A');
  });
});

describe('mcp-cross.judgeCrossEvidence', () => {
  const green = {
    markerFound: true,
    stateMatches: true,
    identityShared: true,
    differentPublicNetwork: true,
    differentPublicNetworkBasis: 'distinct-public-egress',
    pendingPeers: 0,
  };

  it('全绿 → passed=true 无失败项', () => {
    const v = judgeCrossEvidence(green);
    expect(v.passed).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it.each([
    ['markerFound', false, 'markerFound'],
    ['stateMatches', false, 'stateMatches'],
    ['identityShared', false, 'identityShared'],
    ['differentPublicNetwork', null, 'differentPublicNetwork'],
    ['pendingPeers', 3, 'pendingPeers'],
  ])('单项不达标 %s → passed=false 且点名', (key, value, needle) => {
    const v = judgeCrossEvidence({ ...green, [key]: value });
    expect(v.passed).toBe(false);
    expect(v.failures.join('\n')).toContain(needle);
  });

  it('缺字段（undefined）视为不达标', () => {
    const v = judgeCrossEvidence({});
    expect(v.passed).toBe(false);
    expect(v.failures.length).toBe(5);
  });
});

describe('wan-egress.judgeDifferentNetwork', () => {
  it('均公网且不同 → true；同 IP → false；任一私网/未知 → false/null', () => {
    expect(judgeDifferentNetwork('198.51.100.7', '203.0.113.9')).toEqual({ value: true, basis: 'distinct-public-egress' });
    expect(judgeDifferentNetwork('198.51.100.7', '198.51.100.7')).toEqual({ value: false, basis: 'same-egress-ip' });
    expect(judgeDifferentNetwork('10.0.0.1', '203.0.113.9')).toEqual({ value: false, basis: 'private-or-loopback' });
    expect(judgeDifferentNetwork(null, '203.0.113.9')).toEqual({ value: null, basis: 'egress-unknown' });
    expect(judgeDifferentNetwork('::1', '203.0.113.9')).toEqual({ value: false, basis: 'private-or-loopback' });
  });

  it('isPrivateIp：RFC1918/CGNAT/回环/链路本地为真，公网为假', () => {
    for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.1.1', '100.64.5.5', '169.254.1.1', '127.0.0.1', '::1', 'fd00::1']) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    expect(isPrivateIp('203.0.113.9')).toBe(false);
    expect(isPrivateIp(null)).toBe(true);
  });
});

describe('verify-mcp-cross 红灯门禁（真实调用脚本，无环境）', () => {
  it('清除 MEBULAR_WAN_* 后运行 → 退出码 1 且打印所需环境', () => {
    const clean = { ...process.env };
    for (const key of Object.keys(clean)) {
      if (key.startsWith('MEBULAR_WAN_') || key.startsWith('MEBULAR_MCP_CROSS')) delete clean[key];
    }
    const res = spawnSync(process.execPath, [gateScript], { env: clean, encoding: 'utf-8' });
    expect(res.status).toBe(1);
    const out = `${res.stdout}\n${res.stderr}`;
    expect(out).toContain('缺少跨网环境');
    expect(out).toContain('MEBULAR_WAN_PEER');
    expect(out).toContain('MEBULAR_WAN_MCP_A');
    expect(out).toContain('退出码 1');
  });
});
