// 0.3.2 WS2/WS3：平台 adapter（dsh / opencode / claude-code）契约测试。
//
// 全部使用 `process.execPath` + fixture JS，不依赖本机真实 CLI；覆盖：
// - DSH 默认 stdin / 可选 arg / 非 0 / timeout / health 缺失；
// - OpenCode `run` 与 Claude Code `-p` 的 argv 形状；
// - config 接受新 kind（不要求 command）且继续拒绝未知 kind；
// - registry 映射到正确 executor/descriptor，能力卡只暴露安全数值。

import { describe, it, expect } from '@jest/globals';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ClaudeCodeAgent,
  DshHeadlessAgent,
  OpenCodeAgent,
  buildRegistry,
  compileCapabilityCards,
  reduceTaskEvents,
  validateFleetConfig,
  type TaskState,
} from '../../packages/fleet/src/index.js';
import { mkEvent } from './helpers.js';
import { useHeavyTimeout } from '../helpers/timeouts.js';

useHeavyTimeout();

const FIXTURE = join(process.cwd(), 'tests/fleet/fixtures/fake-platform-cli.mjs');

/** 唯一 taskId，避免测试间执行记录/缓存相互影响。 */
let sequence = 0;
function task(intent: string): TaskState {
  sequence += 1;
  return reduceTaskEvents([
    mkEvent('created', `platform-${sequence}`, {
      to: { device: 'device-B', agent: 'worker' },
      intent,
      trace: { chain: [] },
    }),
  ])!;
}

function baseConfig() {
  return {
    v: 1,
    device: 'device-A',
    dir: '/tmp/fleet',
    storagePath: '/tmp/fleet/store.jsonl',
    masterKeyFile: '/tmp/fleet/master-key.json',
    namespace: 'tasks',
    listen: '/ip4/127.0.0.1/tcp/0',
    peers: [],
  };
}

describe('DSH headless adapter', () => {
  it('descriptor：kind=dsh / CLI / 可取消 / 默认 stdin', () => {
    const agent = new DshHeadlessAgent({ dshPath: process.execPath });
    expect(agent.descriptor).toMatchObject({
      kind: 'dsh',
      executionMode: 'cli',
      supportsCancel: true,
      promptMode: 'stdin',
    });
  });

  it('默认 stdin：prompt 写入 stdin，固定 --profile headless', async () => {
    const outcome = await new DshHeadlessAgent({
      dshPath: process.execPath,
      baseArgs: [FIXTURE],
    }).execute(task('hello via stdin'));
    expect(outcome.ok).toBe(true);
    expect(outcome.resultRef).toBe('IN:hello via stdin');
  });

  it('arg 模式：prompt 作为最后一个参数，且固定 --profile headless', async () => {
    const prompt = 'arg prompt with spaces';
    const outcome = await new DshHeadlessAgent({
      dshPath: process.execPath,
      baseArgs: [FIXTURE, '--mode', 'args'],
      promptMode: 'arg',
    }).execute(task(prompt));
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(outcome.resultRef!)).toEqual(['--mode', 'args', '--profile', 'headless', prompt]);
  });

  it('非 0 退出：EXIT_<code> + stderr 尾巴', async () => {
    const outcome = await new DshHeadlessAgent({
      dshPath: process.execPath,
      baseArgs: [FIXTURE, '--mode', 'fail', '--exit', '4', '--stderr', 'dsh failed'],
    }).execute(task('fail'));
    expect(outcome).toEqual({ ok: false, reason: 'EXIT_4: dsh failed' });
  });

  it('timeout：归一为 TIMEOUT', async () => {
    const outcome = await new DshHeadlessAgent({
      dshPath: process.execPath,
      baseArgs: [FIXTURE, '--mode', 'sleep', '--sleep', '5000'],
      timeoutMs: 80,
    }).execute(task('slow'));
    expect(outcome).toEqual({ ok: false, reason: 'TIMEOUT after 80ms' });
  });

  it('health：命令缺失 → unavailable，且详情不含 env/token', async () => {
    const missing = join(tmpdir(), `fleet-missing-dsh-${process.pid}`, 'dsh');
    const health = await new DshHeadlessAgent({ dshPath: missing }).health(500);
    expect(health.status).toBe('unavailable');
    expect(health.detail).toContain('not found');
    expect(health.detail).not.toContain('TOKEN');
    expect(health.detail).not.toContain('API_KEY');
  });
});

describe('OpenCode adapter', () => {
  it('descriptor：kind=opencode / CLI / 默认 arg', () => {
    const agent = new OpenCodeAgent({ opencodePath: process.execPath });
    expect(agent.descriptor).toMatchObject({
      kind: 'opencode',
      executionMode: 'cli',
      supportsCancel: true,
      promptMode: 'arg',
    });
  });

  it('入口为 opencode run <prompt>', async () => {
    const prompt = 'opencode prompt';
    const outcome = await new OpenCodeAgent({
      opencodePath: process.execPath,
      baseArgs: [FIXTURE, '--mode', 'args'],
    }).execute(task(prompt));
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(outcome.resultRef!)).toEqual(['--mode', 'args', 'run', prompt]);
  });
});

describe('Claude Code adapter', () => {
  it('descriptor：kind=claude-code / CLI / 默认 arg', () => {
    const agent = new ClaudeCodeAgent({ claudePath: process.execPath });
    expect(agent.descriptor).toMatchObject({
      kind: 'claude-code',
      executionMode: 'cli',
      supportsCancel: true,
      promptMode: 'arg',
    });
  });

  it('入口为 claude -p <prompt>', async () => {
    const prompt = 'claude prompt';
    const outcome = await new ClaudeCodeAgent({
      claudePath: process.execPath,
      baseArgs: [FIXTURE, '--mode', 'args'],
    }).execute(task(prompt));
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(outcome.resultRef!)).toEqual(['--mode', 'args', '-p', prompt]);
  });
});

describe('config / registry / capability card：kind 扩展', () => {
  it('新 kind 不要求 command，合法配置通过校验', () => {
    const errors = validateFleetConfig({
      ...baseConfig(),
      agents: [
        { name: 'd', kind: 'dsh' },
        { name: 'oc', kind: 'opencode' },
        { name: 'cc', kind: 'claude-code' },
      ],
    });
    expect(errors).toEqual([]);
  });

  it('未知 kind 仍被 config 拒绝', () => {
    const errors = validateFleetConfig({ ...baseConfig(), agents: [{ name: 'x', kind: 'nope' }] });
    expect(errors.some((error) => error.includes('agent.kind'))).toBe(true);
  });

  it('registry 映射到正确 executor/descriptor', () => {
    const registry = buildRegistry([
      { name: 'e', kind: 'echo' },
      { name: 'c', kind: 'command', command: process.execPath },
      { name: 'h', kind: 'hermes' },
      { name: 'o', kind: 'openchamber' },
      { name: 'd', kind: 'dsh' },
      { name: 'oc', kind: 'opencode' },
      { name: 'cc', kind: 'claude-code' },
    ]);
    expect(registry.names()).toEqual(['c', 'cc', 'd', 'e', 'h', 'o', 'oc']);
    expect(registry.resolve('d')).toBeInstanceOf(DshHeadlessAgent);
    expect(registry.resolve('oc')).toBeInstanceOf(OpenCodeAgent);
    expect(registry.resolve('cc')).toBeInstanceOf(ClaudeCodeAgent);
    expect(registry.descriptorOf('d')).toMatchObject({ kind: 'dsh', executionMode: 'cli', supportsCancel: true });
    expect(registry.descriptorOf('oc')).toMatchObject({ kind: 'opencode', executionMode: 'cli', supportsCancel: true });
    expect(registry.descriptorOf('cc')).toMatchObject({ kind: 'claude-code', executionMode: 'cli', supportsCancel: true });
  });

  it('能力卡对长跑平台 kind 使用安全默认超时，不包含 command/env', () => {
    const config = {
      ...baseConfig(),
      agents: [
        { name: 'd', kind: 'dsh' as const },
        { name: 'oc', kind: 'opencode' as const },
        { name: 'cc', kind: 'claude-code' as const },
      ],
    };
    const cards = compileCapabilityCards({ config, now: 1_700_000_000_000 });
    expect(cards.map((card) => card.limits.timeoutMs)).toEqual([600_000, 600_000, 600_000]);
    const serialized = JSON.stringify(cards);
    expect(serialized).not.toContain('"command"');
    expect(serialized).not.toContain('"env"');
  });
});
