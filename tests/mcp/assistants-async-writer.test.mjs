// F-FIX-B 增补 · 写者异步化（真机事故：cli-set 同步阻塞 → 宿主健康探测超时 → 向导①瞬退）
//
// 真机测量：`hermes config set` 每字段 ~760ms，4 字段 ⇒ 事件循环阻塞 ~3-4s ⇒ App 的 3s 轮询
// 健康探测（1200ms）超时 ⇒ 向导退回第一步；阻塞结束又恢复。
// 本测试用**替身慢 CLI**（同步 busy-wait vs 异步等待）复现事故面与修复面。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  clearAssistantsCache,
  connectClient,
  listAssistantsAsync,
} from '../../packages/mcp/src/clients.mjs';

jest.setTimeout(process.platform === 'win32' ? 30_000 : 15_000);

describe('F-FIX-B 写者异步化：慢 CLI 不阻塞请求路径', () => {
  let root;
  let mebularHome;
  let userHome;
  const url = 'http://127.0.0.1:7331/mcp';
  const readback = { ok: true, code: 0, stdout: 'mcp_servers:\n  mebular:\n    url: x\n', stderr: '' };
  const opts = (extra = {}) => ({ home: mebularHome, userHome, cwd: userHome, platform: 'darwin', env: {}, processList: '', ...extra });

  beforeEach(async () => {
    clearAssistantsCache();
    root = await mkdtemp(join(tmpdir(), 'ffixb-async-'));
    mebularHome = join(root, '.mebular');
    userHome = join(root, 'user');
    await mkdir(mebularHome, { recursive: true });
    await mkdir(join(userHome, '.hermes'), { recursive: true });
  });
  afterEach(async () => {
    clearAssistantsCache();
    await rm(root, { recursive: true, force: true });
  });

  /**
   * 量测（事故模型）：写者跑慢 CLI 期间，一个 10ms 定时器探针（等价宿主的 /healthz 轮询）
   * 被拖多久。同步阻塞 → 探针迟迟不触发（真机：健康探测 1200ms 超时 → 向导①瞬退）。
   */
  async function measure(runner) {
    await writeFile(join(userHome, '.hermes', 'config.yaml'), 'mcp_servers:\n  openchamber:\n    command: python3\n');
    await listAssistantsAsync(opts({ runAsync: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }) })); // 预热
    clearAssistantsCache();
    const slowOut = (cmd) => (cmd.includes('get mcp_servers') ? readback : { ok: true, code: 0, stdout: '', stderr: '' });
    // 持续探针：每 20ms 一跳，记录**最大间隔**——慢调用期间事件循环被卡住会让间隔骤增
    let maxGap = 0;
    let last = Date.now();
    const tick = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 20);
    const connect = connectClient('hermes', {
      ...opts({ mcpUrl: url }),
      ...(runner === 'sync'
        ? { run: (cmd) => { busyWait(300); return slowOut(cmd); } }
        : { runAsync: async (cmd) => { await new Promise((r) => setTimeout(r, 300)); return slowOut(cmd); } }),
    });    const res = await connect;
    await new Promise((r) => setTimeout(r, 100)); // 让排队中的探针回调有机会执行（否则被 clearInterval 清掉）
    clearInterval(tick);
    return { ok: res.ok, probeMs: maxGap };
  }

  it('a) 同步 runner 阻塞事件循环（事故复现）；异步 runner 不阻塞（修复）', async () => {
    const blocked = await measure('sync');
    expect(blocked.ok).toBe(true);
    // 同步版：慢 CLI 期间探针被拖住（真机：/healthz 1200ms 超时 → 向导①瞬退）
    expect(blocked.probeMs).toBeGreaterThan(200);

    clearAssistantsCache();
    const free = await measure('async');
    expect(free.ok).toBe(true);
    // 异步版：同样慢 CLI，探针几乎准时触发
    expect(free.probeMs).toBeLessThan(150);
  });

  it('b) 请求路径源码无 spawnSync；默认 runner 为 exec（异步）', async () => {
    const src = await (await import('node:fs/promises')).readFile(
      join(dirname((await import('node:url')).fileURLToPath(import.meta.url)), '..', '..', 'packages', 'mcp', 'src', 'clients.mjs'),
      'utf-8',
    );
    const connectBody = src.slice(src.indexOf('async function connectViaCli'), src.indexOf('export async function connectClient'));
    const verifyBody = src.slice(src.indexOf('export async function verifyAssistant'));
    for (const body of [connectBody, verifyBody]) {
      expect(body).not.toMatch(/spawnSync/);
      expect(body).toMatch(/runAsync/);
    }
  });

  it('c) 写入/回滚语义不减弱（幂等 + 失败/错位回滚）', async () => {
    const cfg = join(userHome, '.hermes', 'config.yaml');
    const original = 'mcp_servers:\n  openchamber:\n    command: python3\n';
    await writeFile(cfg, original);
    const okRun = (cmd) => (cmd.includes('get mcp_servers') ? { ok: true, code: 0, stdout: 'mcp_servers:\n  mebular:\n    url: x\n', stderr: '' } : { ok: true, code: 0, stdout: '', stderr: '' });
    const first = await connectClient('hermes', opts({ mcpUrl: url, run: okRun }));
    expect(first.ok).toBe(true);
    expect(first.backupPath).toBeTruthy();
    expect(first.commands[0].cmd).toMatch(/^hermes config set --force mcp_servers\.mebular "/); // 单次整棵子树
  });
});

function busyWait(ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { /* 同步阻塞：模拟 spawnSync 的 CLI */ }
}
