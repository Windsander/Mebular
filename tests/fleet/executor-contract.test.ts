// 0.3.2 WS1：统一执行层 / adapter 契约测试。
//
// 覆盖：timeout、非 0 退出、输出截断、env 白名单、未知 kind、registry 映射、
// CLI promptMode(arg|stdin)、descriptor 与健康探测。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BaseExecutor,
  CommandAgent,
  ExecutionLog,
  buildRegistry,
  reduceTaskEvents,
  validateFleetConfig,
  type ExecutorAdapter,
  type TaskState,
} from '../../packages/fleet/src/index.js';
import { mkEvent } from './helpers.js';
import { useHeavyTimeout } from '../helpers/timeouts.js';

useHeavyTimeout();

const FIXTURE = join(process.cwd(), 'tests/fleet/fixtures/fake-agent.mjs');

function task(intent: string): TaskState {
  return reduceTaskEvents([
    mkEvent('created', `contract-${intent}`, {
      to: { device: 'device-B', agent: 'worker' },
      intent,
      trace: { chain: [] },
    }),
  ])!;
}

const descriptor = {
  kind: 'test',
  executionMode: 'in-process' as const,
  supportsCancel: true,
};

afterEach(() => {
  delete process.env.FLEET_CONTRACT_SECRET;
});

describe('BaseExecutor：公共层超时 / 归一化 / 健康', () => {
  it('timeout：abort adapter 并归一为 TIMEOUT', async () => {
    let aborted = false;
    const adapter: ExecutorAdapter = {
      descriptor,
      invoke: (_request, signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: true, resultRef: 'late' }), 5_000);
          signal.addEventListener('abort', () => {
            aborted = true;
            clearTimeout(timer);
            resolve({ ok: false, reason: 'aborted' });
          }, { once: true });
        }),
    };
    const executor = new BaseExecutor(adapter, { timeoutMs: 30 });
    const outcome = await executor.execute(task('slow'));
    expect(outcome).toEqual({ ok: false, reason: 'TIMEOUT after 30ms' });
    expect(aborted).toBe(true);
  });

  it('adapter 抛错：归一为 EXECUTOR_ERROR', async () => {
    const executor = new BaseExecutor({
      descriptor,
      invoke: async () => {
        throw new Error('adapter boom');
      },
    });
    expect(await executor.execute(task('boom'))).toEqual({ ok: false, reason: 'EXECUTOR_ERROR: adapter boom' });
  });

  it('无 health probe：degraded（不是 ok/unavailable），detail 固定', async () => {
    const executor = new BaseExecutor({ descriptor, invoke: async () => ({ ok: true }) });
    const health = await executor.health(1_000);
    expect(health).toMatchObject({ status: 'degraded', detail: 'adapter has no health probe' });
    expect(health.checkedAt).toEqual(expect.any(Number));
  });

  it('健康探测：degraded 结果透传并补 latency', async () => {
    const executor = new BaseExecutor({
      descriptor,
      invoke: async () => ({ ok: true }),
      health: async () => ({ status: 'degraded' as const, checkedAt: Date.now(), detail: 'probe' }),
    });
    const health = await executor.health(1_000);
    expect(health.status).toBe('degraded');
    expect(health.detail).toBe('probe');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('descriptor 元数据可从执行器读取', () => {
    const executor = new BaseExecutor({ descriptor, invoke: async () => ({ ok: true }) });
    expect(executor.descriptor).toEqual(descriptor);
  });

  it('执行记录：同一 taskId 只调用 adapter 一次', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-contract-log-'));
    try {
      const log = await ExecutionLog.open(join(dir, 'exec.jsonl'));
      let calls = 0;
      const executor = new BaseExecutor(
        {
          descriptor,
          invoke: async () => {
            calls += 1;
            return { ok: true, resultRef: 'once' };
          },
        },
        { log },
      );
      expect(await executor.execute(task('once'))).toEqual({ ok: true, resultRef: 'once' });
      expect(await executor.execute(task('once'))).toEqual({ ok: true, resultRef: 'once' });
      expect(calls).toBe(1);
      expect(log.size()).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI adapter 契约：非 0 退出 / 输出截断 / env 白名单', () => {
  it('非 0 退出：EXIT_<code> + stderr 尾巴', async () => {
    const agent = new CommandAgent({
      command: process.execPath,
      baseArgs: [FIXTURE, '--mode', 'fail', '--exit', '7', '--stderr', 'contract-detail'],
    });
    const outcome = await agent.execute(task('fail'));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('EXIT_7');
    expect(outcome.reason).toContain('contract-detail');
  });

  it('输出截断：按字节封顶并附标记', async () => {
    const agent = new CommandAgent({
      command: process.execPath,
      baseArgs: [FIXTURE, '--mode', 'large', '--bytes', '100000'],
      maxOutputBytes: 1_000,
    });
    const outcome = await agent.execute(task('big'));
    expect(outcome.ok).toBe(true);
    expect(Buffer.byteLength(outcome.resultRef!, 'utf-8')).toBeLessThanOrEqual(1_000 + 64);
    expect(outcome.resultRef).toContain('[truncated');
  });

  it('env 白名单：daemon 私有变量不外流，PATH 保留', async () => {
    process.env.FLEET_CONTRACT_SECRET = 'leak-contract';
    const secret = new CommandAgent({
      command: process.execPath,
      baseArgs: [FIXTURE, '--mode', 'env', '--env-key', 'FLEET_CONTRACT_SECRET'],
    }).execute(task('env'));
    expect((await secret).resultRef).toBe('ENV:MISSING');

    const path = await new CommandAgent({
      command: process.execPath,
      baseArgs: [FIXTURE, '--mode', 'env', '--env-key', 'PATH'],
    }).execute(task('env'));
    expect(path.resultRef).toMatch(/^ENV:.+/);
    expect(path.resultRef).not.toBe('ENV:MISSING');
  });
});

describe('CommandAgent promptMode：arg / stdin', () => {
  it('arg（默认）：prompt 作为单个参数追加，不再注入通用 -z', async () => {
    const prompt = 'plain prompt with spaces';
    const outcome = await new CommandAgent({
      command: process.execPath,
      baseArgs: [FIXTURE, '--mode', 'args'],
    }).execute(task(prompt));
    expect(outcome.ok).toBe(true);
    const argv = JSON.parse(outcome.resultRef!) as string[];
    expect(argv.at(-1)).toBe(prompt);
    expect(argv).not.toContain('-z');
  });

  it('stdin：prompt 写入子进程 stdin', async () => {
    const outcome = await new CommandAgent({
      command: process.execPath,
      baseArgs: [
        '-e',
        'let d="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write("IN:"+d))',
      ],
      promptMode: 'stdin',
    }).execute(task('via-stdin'));
    expect(outcome.ok).toBe(true);
    expect(outcome.resultRef).toBe('IN:via-stdin');
  });
});

describe('registry：kind -> factory 映射与未知 kind', () => {
  it('既有 + 新增 kind 均映射到执行器，descriptor 可读', () => {
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
    expect(registry.descriptorOf('c')).toMatchObject({ kind: 'command', executionMode: 'cli', supportsCancel: true });
    expect(registry.descriptorOf('h')).toMatchObject({ kind: 'hermes', executionMode: 'cli' });
    expect(registry.descriptorOf('o')).toMatchObject({ kind: 'openchamber', executionMode: 'http' });
    expect(registry.descriptorOf('d')).toMatchObject({ kind: 'dsh', executionMode: 'cli' });
    expect(registry.descriptorOf('oc')).toMatchObject({ kind: 'opencode', executionMode: 'cli' });
    expect(registry.descriptorOf('cc')).toMatchObject({ kind: 'claude-code', executionMode: 'cli' });
  });

  it('未知 kind：配置校验拒绝，registry 显式抛错（无 OpenChamber 兜底）', () => {
    const base = {
      v: 1,
      device: 'device-A',
      dir: '/tmp/fleet',
      storagePath: '/tmp/fleet/store.jsonl',
      masterKeyFile: '/tmp/fleet/master-key.json',
      namespace: 'tasks',
      listen: '/ip4/127.0.0.1/tcp/0',
      peers: [],
    };
    expect(validateFleetConfig({ ...base, agents: [{ name: 'x', kind: 'nope' }] }).some((e) => e.includes('agent.kind'))).toBe(true);
    expect(() => buildRegistry([{ name: 'x', kind: 'nope' as never }])).toThrow('UNKNOWN_AGENT_KIND: nope');
  });

  it('factory 表可扩展（后续 adapter 会话无需改公共层）', () => {
    const registry = buildRegistry(
      [{ name: 'x', kind: 'echo' }],
      { echo: () => new CommandAgent({ command: process.execPath, baseArgs: [FIXTURE] }) },
    );
    expect(registry.descriptorOf('x')?.kind).toBe('command');
  });
});
