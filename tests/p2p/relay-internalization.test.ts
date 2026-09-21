// C6 · 中继内部化接线：守护内建 relay 角色（无独立命令）+ 角色随可达性/白名单生效
// 判别性锚点：删命令后全仓无残留引用；mode/可达性决定 relayServer 与 gater 行为。
import { describe, it, expect, jest } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { Libp2pProvider } from '../../src/p2p/transport/Libp2pProvider.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { decideRelayRole } from '../../src/p2p/relay/RelayRole.js';

const ROOT = join(__dirname, '..', '..');

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', '.wan-evidence', '.openchamber'].includes(entry)) continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) collectSources(full, out);
    else if (/\.(mjs|js|ts|md|yml|json)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('C6 · 无残留 relay 命令', () => {
  it('代码中不再有 relay 命令/runRelayHost/MEBULAR_RELAY_*；文档中的提及只能是「已删除/不再/内部化」说明', () => {
    const codeHits: string[] = [];
    const docHits: string[] = [];
    for (const file of collectSources(ROOT)) {
      if (file.endsWith('relay-internalization.test.ts')) continue; // 自身允许出现字样
      let text: string;
      try { text = readFileSync(file, 'utf-8'); } catch { continue; }
      const isDoc = file.endsWith('.md');
      if (/\brunRelayHost\b/.test(text)) codeHits.push(`${file}:runRelayHost`);
      if (/MEBULAR_RELAY_(HOST|LISTEN|UNLIMITED)/.test(text)) codeHits.push(`${file}:MEBULAR_RELAY_*`);
      if (/\bcase 'relay'|'\u0020\u0020relay \[/.test(text)) codeHits.push(`${file}:relay-command-surface`);
      for (const [index, line] of text.split('\n').entries()) {
        if (!/mebular relay\b/.test(line)) continue;
        // 「命令已删除/不再有/内部化」这类说明性提及（注释/文档）是允许的
        const explainsRemoval = /(已删除|不再有|不再|内部化|removed|no longer)/.test(line);
        if (explainsRemoval) continue;
        if (isDoc) docHits.push(`${file}:${index + 1}`);
        else codeHits.push(`${file}:${index + 1}:mebular relay`);
      }
    }
    expect(codeHits).toEqual([]);
    expect(docHits).toEqual([]);
    const help = readFileSync(join(ROOT, 'packages', 'mcp', 'bin', 'mebular.mjs'), 'utf-8');
    expect(help).not.toMatch(/^\s*relay \[/m);
  });
});

describe('C6 · relay 角色接线（mode → relayServer / gater）', () => {
  const identitySpy = () => jest.spyOn(Libp2pProvider, 'create').mockImplementation((async (options: Record<string, unknown>) => {
    calls.push(options);
    const hub = new InMemoryHub();
    return {
      start: async () => undefined,
      stop: async () => undefined,
      dial: (peer: unknown, addr?: string) => hub.dial(peer as never, addr),
      onIncomingConnection: (cb: unknown) => hub.onIncomingConnection(cb as never),
      getMultiaddrs: () => [] as string[],
      forPeer: (peer: unknown) => hub.forPeer(peer as never),
      getLocalPeerId: () => ({ multihash: new Uint8Array(), pubKey: new Uint8Array(), id: 'unused' }),
    };
  }) as never);
  const calls: Array<Record<string, unknown>> = [];
  let master: { publicKey: Uint8Array; privateKey: CryptoKey };

  const make = (relayService?: 'auto' | 'off' | 'on') => new Mebular({
    storagePath: `/tmp/mebular-relay-role-${process.pid}-${relayService ?? 'auto'}.jsonl`,
    deviceId: 'device-relay-role',
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    network: {
      enabled: true,
      libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] },
      ...(relayService !== undefined ? { relayService } : {}),
    },
    sync: { autoSync: false },
  });

  it('mode=off → 不装配 circuitRelayServer；auto（回环监听）→ 装配但 gater 当前拒绝预约', async () => {
    master = await new IdentityManager().generateUserMasterKey();
    calls.length = 0;
    identitySpy();
    try {
      const off = make('off');
      await off.initialize();
      await off.shutdown();
      expect(calls[0]!.relayServer).toBe(false);
      expect(calls[0]!.relayPolicy).toBeUndefined();

      calls.length = 0;
      const auto = make('auto');
      await auto.initialize();
      try {
        expect(calls[0]!.relayServer).toBe(true);
        const policy = calls[0]!.relayPolicy as { shouldServe: () => boolean; isPeerAllowed: (id: string) => boolean };
        expect(typeof policy.shouldServe).toBe('function');
        // 回环监听 → 角色判定不提供
        expect(policy.shouldServe()).toBe(false);
        // 白名单：地址簿空 → 任何 peer 都不放行
        expect(policy.isPeerAllowed('device-x')).toBe(false);
        const status = (auto as unknown as { node: { getRelayStatus: () => { serving: boolean; mode: string } } }).node.getRelayStatus();
        expect(status.mode).toBe('auto');
        expect(status.serving).toBe(false);
      } finally {
        await auto.shutdown();
      }
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe('C6 · relay 不落记忆/授权状态（不变式）', () => {
  it('角色判定是纯函数：多次判定不产生图事件/策略写入（无副作用）', () => {
    const before = decideRelayRole({ mode: 'auto', listenAddrs: ['/ip4/127.0.0.1/tcp/1'] });
    const after = decideRelayRole({ mode: 'auto', listenAddrs: ['/ip4/127.0.0.1/tcp/1'] });
    expect(after).toEqual(before);
    // 判定入参对象不被修改（纯函数）
    const input = { mode: 'auto' as const, listenAddrs: ['/ip4/127.0.0.1/tcp/1'], inboundDirectEvidence: false };
    decideRelayRole(input);
    expect(input).toEqual({ mode: 'auto', listenAddrs: ['/ip4/127.0.0.1/tcp/1'], inboundDirectEvidence: false });
  });
});
