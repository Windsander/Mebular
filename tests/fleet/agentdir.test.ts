// W1 Agent 目录 → task_targets（授权 ∩ 目录；最新版本；确定序）。
import { describe, it, expect } from '@jest/globals';
import {
  agentDirectoryFingerprint,
  compileAgentDirectory,
  deriveAgentExecution,
  expandTargets,
  latestDirectories,
  validateAgentDirectory,
  type AgentDirectoryEntry,
} from '../../packages/fleet/src/index.js';

const dir = (device: string, version: number, agents: Array<{ name: string; kind: string }>): AgentDirectoryEntry => ({
  v: 1,
  device,
  agents: agents.map((a) => ({ ...a })),
  updatedAt: 0,
  version,
});

describe('W1 Agent 目录 → targets', () => {
  it('目录 → targets 推导（授权 ∩ 目录；非授权设备被排除）', () => {
    const entries = [
      dir('device-B', 1, [{ name: 'echo', kind: 'echo' }, { name: 'hermes', kind: 'hermes' }]),
      dir('device-C', 1, [{ name: 'echo', kind: 'echo' }]),
      dir('device-D', 5, [{ name: 'evil', kind: 'command' }]), // 未授权 → 排除
    ];
    const targets = expandTargets(entries, ['device-B', 'device-C']);
    expect(targets).toEqual([
      { device: 'device-B', agent: 'echo', kind: 'echo' },
      { device: 'device-B', agent: 'hermes', kind: 'hermes' },
      { device: 'device-C', agent: 'echo', kind: 'echo' },
    ]);
    // 授权为空 → 默认拒绝（无 targets）
    expect(expandTargets(entries, [])).toEqual([]);
  });

  it('latestDirectories：同设备取最大 version（确定性）', () => {
    const latest = latestDirectories([
      dir('device-B', 1, [{ name: 'echo', kind: 'echo' }]),
      dir('device-B', 7, [{ name: 'echo', kind: 'echo' }, { name: 'fake', kind: 'command' }]),
      dir('device-B', 3, [{ name: 'echo', kind: 'echo' }]),
    ]);
    expect(latest).toHaveLength(1);
    expect(latest[0]!.version).toBe(7);
  });

  it('latestDirectories：同 version 平局取稳定序列化较大者；非法 agent 项在展开时跳过', () => {
    const tie = latestDirectories([
      { v: 1, device: 'device-B', version: 1, updatedAt: 0, agents: [{ name: 'a', kind: 'echo' }] },
      { v: 1, device: 'device-B', version: 1, updatedAt: 0, agents: [{ name: 'b', kind: 'echo' }] },
    ]);
    expect(tie).toHaveLength(1);
    const withBad = expandTargets(
      [{ v: 1, device: 'device-B', version: 1, updatedAt: 0, agents: [{ name: '', kind: 'echo' }, { name: 'ok', kind: '' }, { name: 'echo', kind: 'echo' }] }],
      ['device-B'],
    );
    expect(withBad).toEqual([{ device: 'device-B', agent: 'echo', kind: 'echo' }]);
  });

  it('校验：形状非法被拒', () => {
    expect(validateAgentDirectory({ v: 1, device: '', agents: [], updatedAt: 0, version: 1 }).ok).toBe(false);
    expect(validateAgentDirectory(dir('device-B', 1, [{ name: 'echo', kind: 'echo' }])).ok).toBe(true);
    expect(validateAgentDirectory({ v: 1, device: 'd', updatedAt: 0, version: 1, agents: 'no' }).ok).toBe(false);
    expect(validateAgentDirectory({ v: 1, device: 'd', updatedAt: 0, version: 1, agents: [{ name: 'a', kind: 'echo', capabilities: [1] }] }).ok).toBe(false);
    expect(validateAgentDirectory({ v: 1, device: 'd', updatedAt: 0, version: 1, agents: [{ name: 'a', kind: 'echo', concurrency: 0 }] }).ok).toBe(false);
    expect(validateAgentDirectory({ v: 1, device: 'd', updatedAt: 0, version: 1, agents: [{ name: 'a', kind: 'echo', capacity: -1 }] }).ok).toBe(false);
    expect(validateAgentDirectory({ v: 1, device: 'd', updatedAt: 0, version: 1, agents: [{ name: 'a', kind: 'echo', executable: 'yes' }] }).ok).toBe(false);
    expect(validateAgentDirectory({ v: 1, device: 'd', updatedAt: 0, version: 1, agents: [{ name: 'a', kind: 'echo', executionMode: 'shell' }] }).ok).toBe(false);
  });

  it('compileAgentDirectory：静态推导 executable/executionMode；旧目录缺字段仍兼容', () => {
    const entry = compileAgentDirectory({
      device: 'device-A',
      agents: [
        { name: 'echo', kind: 'echo' },
        { name: 'board', kind: 'echo' },
        { name: 'no-command', kind: 'command' },
        { name: 'cli', kind: 'command', command: '/opt/agent' },
        { name: 'hermes', kind: 'hermes' },
        { name: 'dsh', kind: 'dsh' },
        { name: 'opencode', kind: 'opencode' },
        { name: 'claude-code', kind: 'claude-code' },
        { name: 'openchamber', kind: 'openchamber' },
      ],
    }, { version: 1, updatedAt: 0 });
    const byName = new Map(entry.agents.map((agent) => [agent.name, agent]));
    expect(byName.get('echo')).toMatchObject({ executable: false, executionMode: 'in-process' });
    expect(byName.get('board')).toMatchObject({ executable: false, executionMode: 'in-process' });
    expect(byName.get('no-command')).toMatchObject({ executable: false, executionMode: 'cli' });
    for (const name of ['cli', 'hermes', 'dsh', 'opencode', 'claude-code']) {
      expect(byName.get(name)).toMatchObject({ executable: true, executionMode: 'cli' });
    }
    expect(byName.get('openchamber')).toMatchObject({ executable: true, executionMode: 'http' });
    expect(deriveAgentExecution({ name: 'board', kind: 'hermes' })).toMatchObject({ executable: false, reason: 'demo' });
    expect(deriveAgentExecution({ name: 'x', kind: 'command' })).toMatchObject({ executable: false, reason: 'missing-command' });
    expect(deriveAgentExecution({ name: 'x', kind: 'mystery' })).toMatchObject({ executable: false, reason: 'unsupported-kind' });

    // 新字段进入指纹：内容变化必须可检测。
    const changed = compileAgentDirectory({
      device: 'device-A',
      agents: [{ name: 'echo', kind: 'echo' }],
    }, { version: 1, updatedAt: 0 });
    expect(agentDirectoryFingerprint(entry)).not.toBe(agentDirectoryFingerprint(changed));

    // 旧 peer 目录：缺字段合法，expandTargets 不得伪造 false。
    const legacy: AgentDirectoryEntry = {
      v: 1,
      device: 'device-B',
      agents: [{ name: 'legacy', kind: 'hermes' }],
      updatedAt: 0,
      version: 1,
    };
    expect(validateAgentDirectory(legacy).ok).toBe(true);
    expect(expandTargets([legacy], ['device-B'])).toEqual([
      { device: 'device-B', agent: 'legacy', kind: 'hermes' },
    ]);
  });

  it('expandTargets：additive 暴露 executable/executionMode；显式 false 带 reason', () => {
    const compiled = compileAgentDirectory({
      device: 'device-B',
      agents: [
        { name: 'echo', kind: 'echo' },
        { name: 'hermes', kind: 'hermes', capabilities: ['code'], concurrency: 2 },
      ],
    }, { version: 1, updatedAt: 0 });
    expect(expandTargets([compiled], ['device-B'])).toEqual([
      { device: 'device-B', agent: 'echo', kind: 'echo', executable: false, executionMode: 'in-process', reason: 'demo' },
      { device: 'device-B', agent: 'hermes', kind: 'hermes', concurrency: 2, executable: true, executionMode: 'cli' },
    ]);
  });
});
