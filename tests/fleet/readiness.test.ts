// Fleet 0.3.2 agent readiness：PATH 自动探测 + doctor 的 plan owner/defaultAgent/materializer 检查。
//
// 不启网络；所有目录为 temp，fake CLI 只用于 `commandExists` 的 PATH 命中判定。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectAgents,
  doctor,
  fleetConfigPath,
  loadFleetConfig,
  onboardDevice,
  planOwnerReadiness,
  saveFleetConfig,
} from '../../packages/fleet/src/index.js';
import { daemonConfigToFleet } from '../../packages/fleet/src/config.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-readiness-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function fakeBin(names: string[]): Promise<string> {
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  for (const name of names) await writeFile(join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
  return bin;
}

function checkOf(report: Awaited<ReturnType<typeof doctor>>, name: string): { status: string; detail: string; hint?: string } | undefined {
  return report.checks.find((check) => check.name === name);
}

describe('detectAgents：PATH 自动探测 dsh/opencode/claude', () => {
  it('dsh / opencode / claude 各自命中，kind 与 source 稳定', async () => {
    const bin = await fakeBin(['dsh', 'opencode', 'claude']);
    const probe = detectAgents({ PATH: bin }, 'linux');
    expect(probe.agents).toEqual([
      { name: 'dsh', kind: 'dsh' },
      { name: 'opencode', kind: 'opencode' },
      { name: 'claude-code', kind: 'claude-code' },
    ]);
    expect(probe.sources).toEqual(['dsh:PATH', 'opencode:PATH', 'claude-code:PATH']);
    // 结果稳定：重复调用顺序一致
    expect(detectAgents({ PATH: bin }, 'linux')).toEqual(probe);
  });

  it('与 hermes / openchamber env 合并时顺序稳定且去重', async () => {
    const bin = await fakeBin(['hermes', 'dsh', 'opencode', 'claude']);
    const probe = detectAgents({ PATH: bin, MEBULAR_FLEET_OPENCHAMBER_ENDPOINT: 'http://127.0.0.1:1' }, 'linux');
    expect(probe.agents.map((agent) => agent.name)).toEqual(['hermes', 'dsh', 'opencode', 'claude-code', 'openchamber']);
    expect(probe.sources).toEqual(['hermes:PATH', 'dsh:PATH', 'opencode:PATH', 'claude-code:PATH', 'openchamber:env']);
    expect(new Set(probe.agents.map((agent) => agent.name)).size).toBe(probe.agents.length);
  });

  it('没有真实 CLI 时才 fallback echo（cursor 不自动声明）', async () => {
    const bin = await fakeBin(['cursor']);
    const none = detectAgents({ PATH: bin }, 'linux');
    expect(none.agents).toEqual([{ name: 'echo', kind: 'echo' }]);
    expect(none.sources).toEqual(['echo:default']);
  });
});

describe('doctor：plan readiness', () => {
  it('echo-only / board 占位 → WARN（明确 plan owner/MR 会失败），不伪造可执行', async () => {
    await onboardDevice({
      dir,
      device: 'device-A',
      agents: [
        { name: 'echo', kind: 'echo' },
        { name: 'board', kind: 'echo' },
      ],
    });
    const report = await doctor(dir);
    const check = checkOf(report, 'plan owner 就绪');
    expect(check?.status).toBe('WARN');
    expect(check?.detail).toContain('PLAN_OWNER_UNEXECUTABLE');
    expect(check?.hint).toContain('fleet quickstart');
    expect(check?.hint).toContain('fleet join');
    // WARN 不改变既有 ok 语义（仍可上车/同步），但 readiness 已如实暴露。
    expect(report.ok).toBe(true);
  });

  it('真实 command agent → PASS；defaultAgent 指向它 → PASS', async () => {
    await onboardDevice({
      dir,
      device: 'device-A',
      agents: [{ name: 'fake', kind: 'command', command: process.execPath, baseArgs: ['/x/agent.mjs'] }],
    });
    const cfg = await loadFleetConfig(fleetConfigPath(dir));
    await saveFleetConfig(fleetConfigPath(dir), { ...cfg, defaultAgent: 'fake' });

    const report = await doctor(dir);
    expect(checkOf(report, 'plan owner 就绪')?.status).toBe('PASS');
    expect(checkOf(report, 'plan owner 就绪')?.detail).toContain('fake');
    expect(checkOf(report, 'defaultAgent')).toMatchObject({ status: 'PASS' });
  });

  it('defaultAgent ghost → doctor FAIL（配置校验拒绝 ghost 指向）', async () => {
    await onboardDevice({ dir, device: 'device-A', agents: [{ name: 'echo', kind: 'echo' }] });
    const cfg = await loadFleetConfig(fleetConfigPath(dir));
    await saveFleetConfig(fleetConfigPath(dir), { ...cfg, defaultAgent: 'ghost' });

    const report = await doctor(dir);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.name).toBe('config');
    expect(report.checks[0]?.status).toBe('FAIL');
    expect(report.checks[0]?.detail).toContain('defaultAgent');
  });

  it('defaultAgent 指向 echo（占位）→ FAIL（存在但不可执行）', async () => {
    await onboardDevice({
      dir,
      device: 'device-A',
      agents: [
        { name: 'echo', kind: 'echo' },
        { name: 'fake', kind: 'command', command: process.execPath },
      ],
    });
    const cfg = await loadFleetConfig(fleetConfigPath(dir));
    await saveFleetConfig(fleetConfigPath(dir), { ...cfg, defaultAgent: 'echo' });

    const report = await doctor(dir);
    expect(checkOf(report, 'plan owner 就绪')?.status).toBe('PASS'); // 仍有真实 agent
    expect(checkOf(report, 'defaultAgent')).toMatchObject({ status: 'FAIL' });
    expect(checkOf(report, 'defaultAgent')?.detail).toContain('kind=echo');
    expect(report.ok).toBe(false);
  });

  it('fleet-node 心跳：role=node 新鲜 → PASS；缺失/角色不符/陈旧 → WARN + 修复指引', async () => {
    await onboardDevice({ dir, device: 'device-A', agents: [{ name: 'echo', kind: 'echo' }] });

    // 缺失
    let report = await doctor(dir);
    expect(checkOf(report, 'plan materializer')?.status).toBe('WARN');
    expect(checkOf(report, 'plan materializer')?.hint).toContain('fleet node --run-forever');
    expect(checkOf(report, 'plan materializer')?.hint).toContain('fleet-node');

    // 角色不符（worker）
    await writeFile(join(dir, 'service.heartbeat'), JSON.stringify({ ts: Date.now(), role: 'worker', pid: 1, sha: 'test' }));
    report = await doctor(dir);
    expect(checkOf(report, 'plan materializer')?.status).toBe('WARN');
    expect(checkOf(report, 'plan materializer')?.detail).toContain('role=worker');

    // role=node 但陈旧
    await writeFile(join(dir, 'service.heartbeat'), JSON.stringify({ ts: Date.now() - 60_000, role: 'node', pid: 1, sha: 'test' }));
    report = await doctor(dir);
    expect(checkOf(report, 'plan materializer')?.status).toBe('WARN');
    expect(checkOf(report, 'plan materializer')?.detail).toContain('陈旧');

    // role=node 且新鲜
    await writeFile(join(dir, 'service.heartbeat'), JSON.stringify({ ts: Date.now(), role: 'node', pid: 1, sha: 'test' }));
    report = await doctor(dir);
    expect(checkOf(report, 'plan materializer')?.status).toBe('PASS');
    expect(checkOf(report, 'plan materializer')?.detail).toContain('role=node');
  });
});

describe('daemonConfigToFleet：保持 board 占位 + readiness 可识别', () => {
  it('守护 home 映射 board 占位，不伪造真实 agent；planOwnerReadiness=only-placeholders', async () => {
    const daemonDir = join(dir, 'daemon');
    await mkdir(daemonDir, { recursive: true });
    await writeFile(join(daemonDir, 'config.json'), JSON.stringify({
      deviceId: 'device-daemon',
      network: { enabled: false },
      sync: { namespaces: ['tasks'] },
    }), 'utf-8');
    const raw = JSON.parse(await readFile(join(daemonDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    const cfg = daemonConfigToFleet(daemonDir, raw);
    expect(cfg.agents).toEqual([{ name: 'board', kind: 'echo' }]);
    expect(planOwnerReadiness(cfg)).toMatchObject({
      executableAgents: [],
      placeholderAgents: ['board'],
      reason: 'only-placeholders',
    });
  });

  it('空 agents → reason=no-agents', () => {
    expect(planOwnerReadiness({ agents: [] })).toEqual({ executableAgents: [], placeholderAgents: [], reason: 'no-agents' });
  });
});
