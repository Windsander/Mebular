// C7 · 扫码即通：令牌 grant 字段（含跨包 parity）+ 二维码渲染/降级 parity
import { describe, it, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular, IdentityManager } from '@mebular/core';
import {
  buildJoinToken,
  decodeJoinToken,
  encodeJoinToken,
  verifyJoinToken,
  canonicalJoinTokenData as fleetCanonical,
  DEFAULT_GRANT_TTL_MS,
  renderSvgQr as fleetSvg,
  renderTerminalQr as fleetTerminal,
} from '../../packages/fleet/src/index.js';
import { offlineMebularOptions, onboardDevice } from '../../packages/fleet/src/index.js';

// daemon 侧（.mjs，无类型声明）：经 createRequire 同步加载（Node 支持 require(ESM)）
jest.setTimeout(60000);

async function makeInviter(dir: string): Promise<Mebular> {
  await onboardDevice({ dir, device: 'device-A', agents: [{ name: 'echo', kind: 'echo' }], configGrant: false, policyIssuers: ['device-A'] });
  const { loadFleetConfig, fleetConfigPath, readMasterKeyFile } = await import('../../packages/fleet/src/index.js');
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const app = new Mebular(offlineMebularOptions(config, encryption) as never);
  await app.initialize();
  return app;
}

describe('C7 · 令牌 grant 字段', () => {
  it('默认不写签名体（旧版本逐字节兼容）；显式关闭/显式 TTL 才写入；跨包 canonical/验签一致', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'c7-token-'));
    const inviter = await makeInviter(dir);
    try {
      const base = { mebular: inviter, deviceId: 'device-A', namespace: 'tasks', endpoint: 'http://127.0.0.1:1', ttlMs: 60_000, now: 1_000 };
      const plain = await buildJoinToken({ ...base, nonce: 'n0' });
      expect(plain.grantOnJoin).toBeUndefined();
      expect(plain.grantTtlMs).toBeUndefined();
      expect(fleetCanonical(plain)).not.toContain('grantOnJoin');
      expect(await verifyJoinToken(plain, { now: 2_000 })).toMatchObject({ ok: true });

      const optOut = await buildJoinToken({ ...base, nonce: 'n1', grantOnJoin: false, grantTtlMs: 3_600_000 });
      const roundTrip = decodeJoinToken(encodeJoinToken(optOut));
      expect(roundTrip.grantOnJoin).toBe(false);
      expect(roundTrip.grantTtlMs).toBe(3_600_000);
      // 跨包（daemon 侧）parity 断言在 scripts/verify-daemon.mjs（原生 ESM 环境）中执行
      expect(DEFAULT_GRANT_TTL_MS).toBe(24 * 3600_000);
      expect(() => decodeJoinToken(JSON.stringify({ ...optOut, grantOnJoin: 'yes' }))).toThrow(/grantOnJoin/);
      expect(() => decodeJoinToken(JSON.stringify({ ...optOut, grantTtlMs: -1 }))).toThrow(/grantTtlMs/);
    } finally {
      await inviter.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('C7 · 二维码渲染与降级（fleet ↔ daemon parity）', () => {
  const token = 'eyJ2IjoxLCJraW5kIjoibWVidWxhci1mbGVldC1qb2luLXRva2VuIn0=';

  it('真可选依赖在场：SVG/terminal 产出（内容=令牌文本，无自定义 scheme）', async () => {
    const fleet = await fleetSvg(token);
    expect(fleet?.value.startsWith('<svg')).toBe(true);
    expect(fleet?.value).not.toContain('mebular://');
    const termFleet = await fleetTerminal(token);
    expect(termFleet?.kind).toBe('terminal');
  });

  it('缺可选依赖：返回 null + 告警（只给文本，不报错）', async () => {
    const warnings: string[] = [];
    const loader = () => { throw new Error("Cannot find module 'qrcode'"); };
    expect(await fleetSvg(token, { loadModule: loader, onWarn: (m: string) => warnings.push(`fleet:${m}`) })).toBeNull();
    expect(await fleetTerminal(token, { loadModule: loader, onWarn: (m: string) => warnings.push(`fleet:${m}`) })).toBeNull();
    expect(warnings.some((m) => m.startsWith('fleet:') && m.includes('qrcode'))).toBe(true);
  });

  it('显式传入的 qrcode 形模块可用（注入 loader 路径）', async () => {
    const fake = { toString: async (text: string, options?: Record<string, unknown>) => `<svg data-kind="${String(options?.type)}">${text.length}</svg>` };
    const result = await fleetSvg(token, { loadModule: () => fake });
    expect(result?.value).toContain('data-kind="svg"');
  });
});

void IdentityManager;
