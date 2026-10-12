// F-NET-1 · 启动健壮性（A 锚点 / B fail-soft）
//
// A：默认 bonjour loader 必须以**模块 URL** 为解析锚点，而不是 `process.argv[1]`（入口脚本路径）——
//    CLI 经 `~/.local/bin/mebular` 符号链接启动时，argv[1] 落在 bin 目录，向上找不到 node_modules/bonjour
//    → factory 返回 null → 发现层误判不可用。
// B：factory 返回 null / discovery 启动失败**不得阻断** node.start()；置 lastError + 告警 + 禁用发现。

import { describe, it, expect } from '@jest/globals';
import { EventEmitter } from 'events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultBonjourFactory } from '../../src/p2p/discovery/bonjourDefault.js';
import { P2PNode } from '../../src/p2p/P2PNetwork.js';
import type { BonjourServiceFactory } from '../../src/p2p/index.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { createTestIdentity, type TestIdentity } from './helpers.js';

class StubHandshake extends EventEmitter {
  async start(): Promise<void> { /* noop */ }
  async stop(): Promise<void> { /* noop */ }
  isRunning(): boolean { return true; }
  setIdentity(): void { /* noop */ }
  setUserMasterPublicKey(): void { /* noop */ }
  setUserMasterPrivateKey(): void { /* noop */ }
}

describe('F-NET-1 A：默认 bonjour loader 锚点', () => {
  it('入口为符号链接时按**真实路径**解析（不受 argv[1] 符号链接影响）→ factory() 非 null', async () => {
    // 模拟 `~/.local/bin/mebular` 符号链接启动：argv[1] 落在无 node_modules 的临时 bin 目录，
    // 旧实现 `createRequire(process.argv[1])` 锚在此处 → 找不到 bonjour → 返回 null。
    const dir = await mkdtemp(join(tmpdir(), 'fnet1-symlink-'));
    const link = join(dir, 'mebular');
    const realBin = join(__dirname, '..', '..', 'packages', 'mcp', 'bin', 'mebular.mjs');
    await symlink(realBin, link);
    const original = process.argv[1];
    process.argv[1] = link;
    const warnings: string[] = [];
    try {
      const svc = createDefaultBonjourFactory({ onWarn: (m) => warnings.push(m) })();
      expect(svc).not.toBeNull();
      expect(warnings).toHaveLength(0);
      svc?.destroy();
    } finally {
      if (original === undefined) delete process.argv[1];
      else process.argv[1] = original;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('F-NET-1 B：发现层 fail-soft（不阻断 node.start）', () => {
  it('factory 返回 null → start() 成功；getLanStatus 显示「已禁用 + 原因」+ 告警', async () => {
    const local: TestIdentity = await createTestIdentity('device-local');
    const warnings: string[] = [];
    const nullFactory: BonjourServiceFactory = () => null;
    const node = new P2PNode({
      identity: {
        deviceId: local.identity.deviceId,
        devicePublicKey: local.identity.devicePublicKey,
        devicePrivateKey: local.identity.devicePrivateKey,
        certificate: { deviceId: local.identity.deviceId, devicePublicKey: '', createdAt: 0, metadata: {}, signature: '' },
      },
      provider: new InMemoryHub() as never,
      bonjourFactory: nullFactory,
      lan: { enabled: true },
      handshake: new StubHandshake() as never,
      onWarn: (message: string) => warnings.push(message),
      config: { maxConnections: 8, listenPort: 0 },
    });
    try {
      await expect(node.start()).resolves.toBeUndefined();
      const lan = node.getLanStatus();
      expect(lan.enabled).toBe(false);
      expect(lan.running).toBe(false);
      expect(String(lan.lastError ?? '')).toContain('bonjour');
      expect(warnings.some((w) => /设备发现不可用/.test(w))).toBe(true);
      expect(node.isRunning()).toBe(true);
    } finally {
      await node.stop().catch(() => undefined);
    }
  });
});
