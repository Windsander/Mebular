// Fleet Step 1b：设备上车 + doctor 自检单测（含 0600 权限与脱敏锚点）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import {
  fleetConfigPath,
  fleetMasterKeyPath,
  generateMasterKey,
  loadFleetConfig,
  masterKeyFingerprint,
  readMasterKeyFile,
  saveFleetConfig,
  validateFleetConfig,
  writeMasterKeyFile,
  onboardDevice,
  doctor,
  buildRegistry,
  mebularOptions,
} from '../../packages/fleet/src/index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-onboard-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('config：主密钥与配置 IO', () => {
  it('主密钥写读往返（0600）+ 指纹稳定且非密钥材料', async () => {
    const key = await generateMasterKey();
    const path = fleetMasterKeyPath(dir);
    await writeMasterKeyFile(path, key);
    const back = await readMasterKeyFile(path);
    expect(Buffer.from(back.userMasterKey).equals(Buffer.from(key.userMasterKey))).toBe(true);
    expect(masterKeyFingerprint(key.userMasterKey)).toBe(masterKeyFingerprint(back.userMasterKey));
    expect(masterKeyFingerprint(key.userMasterKey)).toMatch(/^sha256:[0-9a-f]{12}$/);
    // 指纹不等于任何私钥材料
    const raw = await readFile(path, 'utf-8');
    expect(raw).not.toContain(masterKeyFingerprint(key.userMasterKey));
  });

  it('配置保存 0600 且可往返；非法形状被拒绝', async () => {
    const path = fleetConfigPath(dir);
    const base = {
      v: 1 as const, device: 'device-A', dir, storagePath: join(dir, 'store.jsonl'),
      masterKeyFile: fleetMasterKeyPath(dir), namespace: 'tasks', listen: '/ip4/0.0.0.0/tcp/0',
      peers: [], policyIssuers: [], agents: [{ name: 'echo', kind: 'echo' as const }],
    };
    expect(validateFleetConfig(base)).toEqual([]);
    await saveFleetConfig(path, base);
    expect((await loadFleetConfig(path)).device).toBe('device-A');
    expect((await readFile(path, 'utf-8')).length).toBeGreaterThan(0);

    const reg = buildRegistry([{ name: 'echo', kind: 'echo' }]);
    expect(reg.resolve('echo')).not.toBeNull();
    expect(reg.resolve('nope')).toBeNull(); // 未知 agent 不静默回退

    expect(validateFleetConfig({ ...base, agents: [] }).some((e) => e.includes('agents'))).toBe(true);
    expect(validateFleetConfig({ ...base, agents: [{ name: 'x', kind: 'nope' }] }).some((e) => e.includes('agent.kind'))).toBe(true);
    expect(validateFleetConfig({ ...base, agents: [{ name: 'x', kind: 'command' }] }).some((e) => e.includes('需要 command'))).toBe(true);
    expect(validateFleetConfig({ ...base, agents: [{ name: 'x', kind: 'command', command: '' }] }).some((e) => e.includes('需要 command'))).toBe(true);
    expect(validateFleetConfig(null)).toEqual(['config 必须是对象']);
  });
});

describe('onboard：一条命令上车（幂等）', () => {
  it('生成主密钥/配置/身份，二次执行显式“已上车”', async () => {
    const first = await onboardDevice({ dir, device: 'device-A', peerDevice: 'device-B', agents: [{ name: 'echo', kind: 'echo' }] });
    expect(first.alreadyOnboarded).toBe(false);
    expect(first.masterKeyCreated).toBe(true);
    const cfg = await loadFleetConfig(fleetConfigPath(dir));
    expect(cfg.peers[0]?.device).toBe('device-B');
    // 身份文件由 core 落盘
    await expect(readFile(`${cfg.storagePath}.identity.json`, 'utf-8')).resolves.toBeTruthy();

    const second = await onboardDevice({ dir, device: 'device-A', peerDevice: 'device-B', agents: [{ name: 'echo', kind: 'echo' }] });
    expect(second.alreadyOnboarded).toBe(true);
    expect(second.masterKeyCreated).toBe(false);
    expect(second.masterKeyFingerprint).toBe(first.masterKeyFingerprint); // 身份未被破坏
  });

  it('导入既有主密钥（同一指纹）', async () => {
    const src = join(dir, 'src-key.json');
    const key = await generateMasterKey();
    await writeMasterKeyFile(src, key);
    const imported = await onboardDevice({ dir: join(dir, 'dev'), device: 'device-B', masterKeyFile: src });
    expect(imported.masterKeyFingerprint).toBe(masterKeyFingerprint(key.userMasterKey));
  });
});

describe('doctor：逐项自检 + 权限断言（判别锚点）', () => {
  it('全新上车目录：ok=true，且 skipped 明列 peer/同步原因（不静默跳过）', async () => {
    await onboardDevice({ dir, device: 'device-A', peerDevice: 'device-B', agents: [{ name: 'echo', kind: 'echo' }] });
    const report = await doctor(dir);
    expect(report.ok).toBe(true);
    expect(report.skipped).toContain('peer 可达');
    expect(report.skipped).toContain('同步已收敛');
    // 脱敏：输出不含主密钥私钥材料
    const privateMaterial = await readFile(fleetMasterKeyPath(dir), 'utf-8');
    const parsed = JSON.parse(privateMaterial) as { privateKeyPkcs8: string };
    expect(JSON.stringify(report)).not.toContain(parsed.privateKeyPkcs8);
  });

  it('主密钥权限过宽（0644）→ FAIL（判别锚点）', async () => {
    await onboardDevice({ dir, device: 'device-A', agents: [{ name: 'echo', kind: 'echo' }] });
    await chmod(fleetMasterKeyPath(dir), 0o644);
    const report = await doctor(dir);
    expect(report.ok).toBe(false);
    const check = report.checks.find((c) => c.name === '主密钥权限');
    expect(check?.status).toBe('FAIL');
    expect(check?.hint).toContain('chmod 600');
  });

  it('配置损坏 → 清晰 FAIL', async () => {
    await writeFile(fleetConfigPath(dir), '{ not json', { mode: 0o600 });
    const report = await doctor(dir);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.name).toBe('config');
    expect(report.checks[0]?.status).toBe('FAIL');
  });
});

async function listenOnce(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('doctor：peer/同步/身份链 与注册表/选项', () => {
  it('buildRegistry 覆盖各 kind；mebularOptions 生成默认拒绝策略', async () => {
    const reg = buildRegistry([
      { name: 'e', kind: 'echo' },
      { name: 'c', kind: 'command', command: process.execPath },
      { name: 'h', kind: 'hermes' },
      { name: 'o', kind: 'openchamber' },
    ]);
    for (const n of ['e', 'c', 'h', 'o']) expect(reg.resolve(n)).not.toBeNull();
    expect(reg.names()).toEqual(['c', 'e', 'h', 'o']);

    await onboardDevice({ dir, device: 'device-A', peerDevice: 'device-B', agents: [{ name: 'echo', kind: 'echo' }] });
    const cfg = await loadFleetConfig(fleetConfigPath(dir));
    const enc = await readMasterKeyFile(cfg.masterKeyFile);
    const opts = mebularOptions(cfg, enc) as { sync: { peerNamespacePolicy: Record<string, string[]> } };
    expect(opts.sync.peerNamespacePolicy).toEqual({ 'device-B': ['tasks'] });
  });

  it('peer 可达：对端监听 → PASS；不可达 → FAIL', async () => {
    const srv = await listenOnce();
    await onboardDevice({
      dir,
      device: 'device-A',
      peerDevice: 'device-B',
      peerAddr: `/ip4/127.0.0.1/tcp/${srv.port}/p2p/x`,
      agents: [{ name: 'echo', kind: 'echo' }],
    });
    const okReport = await doctor(dir);
    expect(okReport.checks.find((c) => c.name.startsWith('peer 可达'))?.status).toBe('PASS');
    await srv.close();

    await chmod(fleetConfigPath(dir), 0o600);
    const cfg = await loadFleetConfig(fleetConfigPath(dir));
    await saveFleetConfig(fleetConfigPath(dir), { ...cfg, peers: [{ device: 'device-B', addr: '/ip4/127.0.0.1/tcp/1/p2p/x' }] });
    const failReport = await doctor(dir);
    expect(failReport.checks.find((c) => c.name.startsWith('peer 可达'))?.status).toBe('FAIL');
  });

  it('同步已收敛：见到对端署名事件 → PASS；仅非对端 → FAIL', async () => {
    await onboardDevice({ dir, device: 'device-A', peerDevice: 'device-B', agents: [{ name: 'echo', kind: 'echo' }] });
    const cfg = await loadFleetConfig(fleetConfigPath(dir));
    const enc = await readMasterKeyFile(cfg.masterKeyFile);
    const write = async (author: string): Promise<void> => {
      const m = new Mebular({ storagePath: cfg.storagePath, deviceId: cfg.device, encryption: enc, network: { enabled: false } } as never);
      await m.initialize();
      await m.graph.createNode('task_event', { actor: { device: author } } as never, [], { namespace: 'tasks' });
      await m.shutdown();
    };
    await write('device-Z');
    expect((await doctor(dir)).checks.find((c) => c.name === '同步已收敛')?.status).toBe('FAIL');
    await write('device-B');
    const report = await doctor(dir);
    expect(report.checks.find((c) => c.name === '同步已收敛')?.status).toBe('PASS');
    expect(report.skipped).not.toContain('同步已收敛');
  });

  it('身份文件损坏 → 主密钥链 FAIL（清晰）', async () => {
    await onboardDevice({ dir, device: 'device-A', agents: [{ name: 'echo', kind: 'echo' }] });
    const cfg = await loadFleetConfig(fleetConfigPath(dir));
    await writeFile(`${cfg.storagePath}.identity.json`, '{ broken', { mode: 0o600 });
    const report = await doctor(dir);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === '主密钥链')?.status).toBe('FAIL');
  });

  it('主密钥文件缺失 → FAIL；形状非法 → readMasterKeyFile 抛错', async () => {
    await onboardDevice({ dir, device: 'device-A', agents: [{ name: 'echo', kind: 'echo' }] });
    const cfg = await loadFleetConfig(fleetConfigPath(dir));
    await rm(cfg.masterKeyFile, { force: true });
    expect((await doctor(dir)).checks.find((c) => c.name === '主密钥权限')?.status).toBe('FAIL');

    const bad = join(dir, 'bad-key.json');
    await writeFile(bad, JSON.stringify({ v: 1 }), { mode: 0o600 });
    await expect(readMasterKeyFile(bad)).rejects.toThrow(/形状非法/);
  });
});
