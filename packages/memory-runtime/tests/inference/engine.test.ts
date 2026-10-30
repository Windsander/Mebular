// llama-server supervisor：随机端口/ token、健康启动、空闲停止、崩溃熔断、SIGKILL 清理。

import { describe, it, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
  EngineError,
  LlamaServerEngine,
  type ChildProcessLike,
  type SpawnLike,
} from '../../src/index.js';

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  readonly kills: Array<NodeJS.Signals | number | undefined> = [];

  constructor(private readonly ignoreTerm = false) {
    super();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    if (signal === 'SIGTERM' && this.ignoreTerm) return true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, signal ?? null));
    return true;
  }
}

const TOKEN = 'token-0123456789abcdef';

function harness(options: {
  health?: () => Promise<boolean>;
  maxCrashes?: number;
  idleTimeoutMs?: number;
  ignoreTerm?: boolean;
} = {}) {
  const children: FakeChild[] = [];
  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  const healthCalls: Array<{ url: string; token: string }> = [];
  const spawn: SpawnLike = (command, args) => {
    const child = new FakeChild(options.ignoreTerm ?? false);
    children.push(child);
    spawnCalls.push({ command, args: [...args] });
    return child as unknown as ChildProcessLike;
  };
  let now = 1000;
  let spawnPort = 54321;
  const engine = new LlamaServerEngine({
    modelPath: '/fake/model.gguf',
    modelId: 'qwen-test',
    binaryPath: 'llama-server-test',
    spawn,
    findPort: async () => spawnPort,
    tokenFactory: () => TOKEN,
    healthCheck: async (url, token) => {
      healthCalls.push({ url, token });
      return options.health ? options.health() : true;
    },
    now: () => now,
    sleep: async () => {},
    autoIdleCheck: false,
    startupTimeoutMs: 30,
    healthIntervalMs: 1,
    healthProbeTimeoutMs: 20,
    stopTimeoutMs: 10,
    killTimeoutMs: 20,
    crashWindowMs: 1_000_000,
    idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
    maxCrashes: options.maxCrashes ?? 3,
  });
  return {
    engine,
    children,
    spawnCalls,
    healthCalls,
    advance: (ms: number) => {
      now += ms;
    },
    setPort: (port: number) => {
      spawnPort = port;
    },
  };
}

describe('LlamaServerEngine', () => {
  it('启动：loopback 随机端口、bearer token、health，状态不泄漏 token', async () => {
    const h = harness();
    const connection = await h.engine.acquire();

    expect(connection).toMatchObject({
      baseUrl: 'http://127.0.0.1:54321/v1',
      apiKey: TOKEN,
      port: 54321,
      modelPath: '/fake/model.gguf',
    });
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]).toMatchObject({ command: 'llama-server-test' });
    expect(h.spawnCalls[0]!.args).toEqual(expect.arrayContaining([
      '--model', '/fake/model.gguf',
      '--host', '127.0.0.1',
      '--port', '54321',
      '--api-key', TOKEN,
    ]));
    expect(h.healthCalls[0]).toEqual({
      url: 'http://127.0.0.1:54321/health',
      token: TOKEN,
    });

    const status = h.engine.getStatus();
    expect(status).toMatchObject({
      state: 'running',
      pid: 4242,
      port: 54321,
      health: 'ok',
      crashCount: 0,
    });
    expect(JSON.stringify(status)).not.toContain(TOKEN);

    await h.engine.stop();
    expect(h.children[0]!.kills).toEqual(['SIGTERM']);
    expect(h.engine.getStatus().state).toBe('stopped');
    await h.engine.stop();
    expect(h.children[0]!.kills).toEqual(['SIGTERM']);
  });

  it('启动超时：杀掉子进程并进入 crashed，不留孤儿', async () => {
    const h = harness({ health: async () => false });
    await expect(h.engine.acquire()).rejects.toMatchObject({ code: 'startup_timeout' });
    expect(h.children[0]!.kills).toContain('SIGTERM');
    expect(h.engine.getStatus()).toMatchObject({ state: 'crashed', health: 'unhealthy' });
    expect(h.engine.getStatus().lastError?.code).toBe('startup_timeout');
  });

  it('崩溃熔断：窗口内达到阈值后拒绝启动，resetCircuit 后恢复', async () => {
    const h = harness({ maxCrashes: 2 });
    await h.engine.acquire();
    h.children[0]!.emit('exit', 1, null);
    expect(h.engine.getStatus().state).toBe('crashed');

    await h.engine.acquire();
    h.children[1]!.emit('exit', 1, null);
    expect(h.engine.getStatus().state).toBe('circuit_open');
    expect(h.spawnCalls).toHaveLength(2);

    await expect(h.engine.acquire()).rejects.toBeInstanceOf(EngineError);
    await expect(h.engine.acquire()).rejects.toMatchObject({ code: 'circuit_open' });
    expect(h.spawnCalls).toHaveLength(2);

    h.engine.resetCircuit();
    expect(h.engine.getStatus().state).toBe('stopped');
    await h.engine.acquire();
    expect(h.spawnCalls).toHaveLength(3);
    expect(h.engine.getStatus()).toMatchObject({ state: 'running', crashCount: 0 });
    await h.engine.stop();
  });

  it('空闲停止：超过 idleTimeout 后主动 stop', async () => {
    const h = harness({ idleTimeoutMs: 100 });
    await h.engine.acquire();
    h.advance(99);
    expect(await h.engine.checkIdle()).toBe(false);
    h.advance(2);
    expect(await h.engine.checkIdle()).toBe(true);
    expect(h.children[0]!.kills).toEqual(['SIGTERM']);
    expect(h.engine.getStatus().state).toBe('stopped');
  });

  it('SIGTERM 无效时升级 SIGKILL，waitForExit 不悬挂', async () => {
    const h = harness({ ignoreTerm: true });
    await h.engine.acquire();
    await h.engine.stop();
    expect(h.children[0]!.kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.engine.getStatus().state).toBe('stopped');
  });

  it('非法端口在 spawn 前拒绝', async () => {
    const h = harness();
    h.setPort(0);
    await expect(h.engine.acquire()).rejects.toMatchObject({ code: 'invalid_port' });
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.engine.getStatus().state).toBe('crashed');
  });
});
