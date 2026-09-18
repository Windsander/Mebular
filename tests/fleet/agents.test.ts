// Fleet M4 目标一：Agent 注册表 + 命令行/Hermes 适配器（确定性 fake agent 驱动）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExecutorRegistry,
  CommandAgent,
  HermesAgent,
  truncateOutput,
  FleetWorker,
  FileTaskEventStore,
  NullTransport,
  EchoExecutor,
  ExecutionLog,
  reduceTaskEvents,
} from '../../packages/fleet/src/index.js';
import { mkEvent } from './helpers.js';

const FIXTURE = join(process.cwd(), 'tests/fleet/fixtures/fake-agent.mjs');
const node = (args: string[]): CommandAgent =>
  new CommandAgent({ command: process.execPath, baseArgs: [FIXTURE, ...args] });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-agent-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function task(intent: string, agent = 'echo', device = 'device-B') {
  return reduceTaskEvents([mkEvent('created', `t-${intent}`, { to: { device, agent }, intent, trace: { chain: [] } })])!;
}

describe('ExecutorRegistry：按 agent 名字路由', () => {
  it('精确匹配 / 通配 / 未知返回 null（不静默回退）', () => {
    const reg = new ExecutorRegistry();
    const echo = new EchoExecutor();
    reg.register('echo', echo);
    reg.register('*', echo);
    expect(reg.resolve('echo')).toBe(echo);
    expect(reg.resolve('*')).toBe(echo);
    expect(reg.resolve('hermes')).toBeNull(); // 未注册 → null
    expect(reg.has('echo')).toBe(true);
    expect(reg.has('nope')).toBe(false);
    expect(reg.names()).toEqual(['echo']);
  });
});

describe('CommandAgent：参数数组 / 超时 / 非零退出 / 输出截断', () => {
  it('成功：结果为 stdout（截断）', async () => {
    const outcome = await node([]).execute(task('hello'));
    expect(outcome).toEqual({ ok: true, resultRef: 'FAKE:hello' });
  });

  it('超时：failed 带 TIMEOUT 原因', async () => {
    const agent = new CommandAgent({ command: process.execPath, baseArgs: [FIXTURE, '--mode', 'sleep', '--sleep', '5000'], timeoutMs: 200 });
    const outcome = await agent.execute(task('slow'));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/^TIMEOUT after \d+ms$/);
  }, 10000);

  it('非零退出：failed 带 exit code 与 stderr 尾巴', async () => {
    const outcome = await node(['--mode', 'fail', '--exit', '3', '--stderr', 'boom-detail']).execute(task('x'));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('EXIT_3');
    expect(outcome.reason).toContain('boom-detail');
  });

  it('输出超限：按字节截断并附标记', async () => {
    const outcome = await node(['--mode', 'large', '--bytes', '100000']).execute(task('big'));
    // CommandAgent 默认 65536 上限
    expect(outcome.ok).toBe(true);
    expect(Buffer.byteLength(outcome.resultRef!, 'utf-8')).toBeLessThan(70000);
    expect(outcome.resultRef).toContain('[truncated');
    // 直接测截断函数边界
    const t = truncateOutput('abcdef', 3);
    expect(t.truncated).toBe(true);
    expect(t.totalBytes).toBe(6);
  });

  it('参数数组传参：prompt 作为单个参数、无 shell 解释（防注入）', async () => {
    const marker = join(dir, 'injected');
    const prompt = `$(touch ${marker}) ' "; echo pwned`;
    const outcome = await node(['--mode', 'args']).execute(task(prompt));
    expect(outcome.ok).toBe(true);
    const argv = JSON.parse(outcome.resultRef!) as string[];
    expect(argv).toContain(prompt); // 原样作为**一个**参数
    expect(existsSync(marker)).toBe(false); // 未发生 shell 求值
  });

  it('并发上限可配：concurrency=1 串行、=2 并行', async () => {
    const sleepMs = 300;
    const mk = (concurrency: number) => new CommandAgent({ command: process.execPath, baseArgs: [FIXTURE, '--mode', 'sleep', '--sleep', String(sleepMs)], concurrency });
    const serialAgent = mk(1); // 同一实例：并发闸生效
    const t0 = Date.now();
    await Promise.all([serialAgent.execute(task('a')), serialAgent.execute(task('b'))]);
    const serial = Date.now() - t0;
    const parallelAgent = mk(2);
    const t1 = Date.now();
    await Promise.all([parallelAgent.execute(task('c')), parallelAgent.execute(task('d'))]);
    const parallel = Date.now() - t1;
    expect(serial).toBeGreaterThanOrEqual(sleepMs * 1.2); // 两次串行（含 CI 抖动容差）
    expect(parallel).toBeLessThan(serial);
  }, 15000);

  it('env 白名单：不继承 daemon 的任意环境变量（判别锚点）', async () => {
    process.env.FLEET_TEST_SECRET = 'leak-123';
    try {
      const leaked = await node(['--mode', 'env', '--env-key', 'FLEET_TEST_SECRET']).execute(task('env'));
      expect(leaked.ok).toBe(true);
      expect(leaked.resultRef).toBe('ENV:MISSING'); // 未被透传

      // 白名单项仍可用（PATH 必须存在，否则子进程无法运行/找不到可执行）
      const path = await node(['--mode', 'env', '--env-key', 'PATH']).execute(task('env'));
      expect(path.ok).toBe(true);
      expect(path.resultRef).not.toBe('ENV:MISSING');
      expect(path.resultRef).toMatch(/^ENV:.+/);
    } finally {
      delete process.env.FLEET_TEST_SECRET;
    }
  });
});

describe('HermesAgent：hermes argv 构造与结果', () => {
  it('拼出 hermes 参数（-p/-t/-m/--in/-z/--usage-file）', async () => {
    const agent = new HermesAgent({
      hermesPath: process.execPath,
      commandArgs: [FIXTURE, '--mode', 'args'],
      profile: 'work',
      toolsets: 'memory',
      model: 'm1',
      cwd: dir,
    });
    const outcome = await agent.execute(task('summarize'));
    expect(outcome.ok).toBe(true);
    const argv = JSON.parse(outcome.resultRef!) as string[];
    expect(argv).toEqual(
      expect.arrayContaining(['-p', 'work', '-t', 'memory', '-m', 'm1', '--in', dir, '-z', 'summarize']),
    );
    expect(argv).toContain('--usage-file');
  });

  it('成功解析 usage.session_id（reason 里回带）', async () => {
    const agent = new HermesAgent({ hermesPath: process.execPath, commandArgs: [FIXTURE] });
    const outcome = await agent.execute(task('ping'));
    expect(outcome).toEqual({ ok: true, reason: 'session:fake-session', resultRef: 'FAKE:ping' });
  });

  it('超时 → failed TIMEOUT', async () => {
    const agent = new HermesAgent({ hermesPath: process.execPath, commandArgs: [FIXTURE, '--mode', 'sleep', '--sleep', '5000'], timeoutMs: 200 });
    const outcome = await agent.execute(task('slow'));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/TIMEOUT/);
  });
});

describe('FleetWorker：注册表 + 未知 agent 显式失败', () => {
  it('已注册 agent 完成、未知 agent → failed(UNKNOWN_AGENT)', async () => {
    const store = await FileTaskEventStore.open(join(dir, 'w.jsonl'));
    await store.append(mkEvent('created', 'ok-1', { to: { device: 'device-B', agent: 'echo' }, intent: 'hi', trace: { chain: [] } }));
    await store.append(mkEvent('created', 'bad-1', { to: { device: 'device-B', agent: 'nope' }, intent: 'hi', trace: { chain: [] } }));
    const registry = new ExecutorRegistry();
    registry.register('echo', new EchoExecutor());
    const log = await ExecutionLog.open(join(dir, 'w.exec.jsonl'));
    const worker = new FleetWorker({ device: 'device-B', agent: 'worker', store, transport: new NullTransport(), registry, log });

    await worker.pollOnce();
    expect(reduceTaskEvents(await store.byTask('ok-1'))!.status).toBe('done');
    const bad = reduceTaskEvents(await store.byTask('bad-1'))!;
    expect(bad.status).toBe('failed');
    expect(bad.reason).toBe('UNKNOWN_AGENT: nope');
    expect(log.size()).toBe(1); // 未知 agent 不执行
  });

  it('通配 "*" 只在 to.agent 为 "*" 时命中', async () => {
    const store = await FileTaskEventStore.open(join(dir, 'w2.jsonl'));
    await store.append(mkEvent('created', 'star', { to: { device: 'device-B', agent: '*' }, intent: 'hi', trace: { chain: [] } }));
    const registry = new ExecutorRegistry();
    registry.register('*', new EchoExecutor());
    const log = await ExecutionLog.open(join(dir, 'w2.exec.jsonl'));
    const worker = new FleetWorker({ device: 'device-B', agent: 'worker', store, transport: new NullTransport(), registry, log });
    await worker.pollOnce();
    expect(reduceTaskEvents(await store.byTask('star'))!.status).toBe('done');
  });
});
