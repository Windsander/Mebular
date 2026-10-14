// F-PERF-2 · 探针异步化 + 会话内短 TTL 缓存（单飞 / 写后失效 / refresh）
//
// 全部在临时 home 中、探针执行器一律注入替身（不 spawn 真实 CLI）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSISTANTS_CACHE_TTL_MS,
  assistantState,
  assistantStateAsync,
  clearAssistantsCache,
  connectClient,
  descriptorFor,
  listAssistants,
  listAssistantsAsync,
  probeSignalAsync,
} from '../../packages/mcp/src/clients.mjs';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'mcp', 'src');

describe('F-PERF-2 异步探针 + 短 TTL 缓存', () => {
  let home;
  const opts = (extra = {}) => ({ home, cwd: home, platform: 'darwin', env: {}, processList: '', ...extra });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'perf2-clients-'));
    clearAssistantsCache();
  });
  afterEach(async () => {
    clearAssistantsCache();
    await rm(home, { recursive: true, force: true });
  });

  it('async 与 sync 判据一致（同替身 → 同 state/evidence）', async () => {
    const run = () => ({ ok: true, code: 0, stdout: '', stderr: '' });
    const d = descriptorFor('opencode', opts());
    const sync = assistantState(d, opts({ run }));
    const asyncState = await assistantStateAsync(d, opts({ runAsync: async (c, t) => run(c, t) }));
    expect(asyncState.state).toBe(sync.state);
    expect(asyncState.evidence.map((e) => [e.kind, e.hit])).toEqual(sync.evidence.map((e) => [e.kind, e.hit]));
  });

  it('缓存：TTL 内第二次命中（cached=true）且不再调用探针', async () => {
    let calls = 0;
    const runAsync = async () => { calls += 1; return { ok: true, code: 0, stdout: '', stderr: '' }; };
    const first = await listAssistantsAsync(opts({ runAsync }));
    expect(first.cached).toBe(false);
    const callsAfterFirst = calls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const second = await listAssistantsAsync(opts({ runAsync }));
    expect(second.cached).toBe(true);
    expect(calls).toBe(callsAfterFirst); // 命中不重新探测
    expect(second.assistants.length).toBe(first.assistants.length);
  });

  it('并发单飞：并发 10 次只跑一轮探针（不是 10 轮）', async () => {
    let calls = 0;
    const runAsync = async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return { ok: true, code: 0, stdout: '', stderr: '' }; };
    const results = await Promise.all(Array.from({ length: 10 }, () => listAssistantsAsync(opts({ runAsync }))));
    expect(results.every((r) => r.assistants.length === results[0].assistants.length)).toBe(true);
    const cliSignals = results[0].assistants.reduce((n, a) => n + a.evidence.filter((e) => e.kind === 'cli').length, 0);
    expect(cliSignals).toBeGreaterThan(0);
    expect(calls).toBe(cliSignals); // 一轮 = 每条 cli 信号一次；并发不放大
  });

  it('refresh:true 绕过列表缓存（重新探测）', async () => {
    let calls = 0;
    const runAsync = async () => { calls += 1; return { ok: true, code: 0, stdout: '', stderr: '' }; };
    await listAssistantsAsync(opts({ runAsync }));
    const after1 = calls;
    await listAssistantsAsync(opts({ runAsync }));
    expect(calls).toBe(after1); // 命中
    await listAssistantsAsync(opts({ runAsync, refresh: true }));
    expect(calls).toBeGreaterThan(after1); // 绕过
  });

  it('写后失效：connect 后重新探测（不返回陈旧「未接入」）', async () => {
    const cfg = join(home, '.config', 'opencode', 'opencode.json');
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, JSON.stringify({ theme: 'dark' }, null, 2));
    const runAsync = async () => ({ ok: true, code: 0, stdout: '', stderr: '' });
    const before = await listAssistantsAsync(opts({ runAsync }));
    expect(before.assistants.find((a) => a.id === 'opencode').state).toBe('not-connected');
    await connectClient('opencode', opts());          // 写（使用同步注入 run）
    const after = await listAssistantsAsync(opts({ runAsync })); // 缓存已被写操作清空
    expect(after.cached).toBe(false);
    expect(after.assistants.find((a) => a.id === 'opencode').state).toBe('connected');
  });

  it('listAssistantsAsync 形状与 sync 列表一致（注册表 ∪ 自定义）', async () => {
    const runAsync = async () => ({ ok: true, code: 0, stdout: '', stderr: '' });
    const asyncOut = await listAssistantsAsync(opts({ runAsync }));
    const syncOut = listAssistants(opts({ run: () => ({ ok: true, code: 0, stdout: '', stderr: '' }) }));
    expect(asyncOut.assistants.map((a) => a.id)).toEqual(syncOut.assistants.map((a) => a.id));
    expect(asyncOut.customPath).toBe(syncOut.customPath);
  });

  it('probeSignalAsync：cli 命中/未命中与 kind 语义与 sync 一致；异常不外抛', async () => {
    const hit = await probeSignalAsync({ kind: 'cli', command: 'x --version', timeoutMs: 100 }, { runAsync: async () => ({ ok: true, code: 0 }) });
    expect(hit).toMatchObject({ kind: 'cli', hit: true, detail: 'rc=0' });
    const miss = await probeSignalAsync({ kind: 'cli', command: 'x --version', timeoutMs: 100 }, { runAsync: async () => ({ ok: false, code: 127 }) });
    expect(miss.hit).toBe(false);
    const boom = await probeSignalAsync({ kind: 'cli', command: 'x' }, { runAsync: async () => { throw new Error('token=SEKRET'); } });
    expect(boom.hit).toBe(false);
    expect(boom.detail).toMatch(/探测异常/);
    expect(boom.detail).not.toMatch(/SEKRET/);
  });

  it('常量与源码锚点：请求路径不得同步 spawnSync；admin 走异步', async () => {
    expect(ASSISTANTS_CACHE_TTL_MS).toBeGreaterThanOrEqual(0);
    const clients = await readFile(join(srcRoot, 'clients.mjs'), 'utf-8');
    const asyncBody = clients.slice(clients.indexOf('export async function probeSignalAsync'), clients.indexOf('function builtinsCount'));
    expect(asyncBody).not.toMatch(/spawnSync/);            // 异步路径无同步 spawn
    expect(clients).toMatch(/export async function listAssistantsAsync/);
    expect(clients).toMatch(/assistantsInflight/);         // 单飞
    const admin = await readFile(join(srcRoot, 'admin.mjs'), 'utf-8');
    expect(admin).toMatch(/await listAssistantsAsync\(/);  // 读路由用异步
    expect(admin).not.toMatch(/listAssistants\(/);         // 不再用同步版
    expect(admin).toMatch(/refresh/);                      // ?refresh=1 绕过
  });
});
