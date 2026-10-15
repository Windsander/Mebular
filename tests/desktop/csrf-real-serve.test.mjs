// UX-2 收口 · CSRF 修死回归（**真实 serve 集成测试，非 mock**）：
// 桌面主进程从 `GET /console/` 取 CSRF（头 ∧ cookie）→ 写链走通。
// 修死前：预取打 /admin/api/overview（从不下发 token）→ 一切写操作 403。
// 覆盖：prefetchCsrf 双取 / 负例（只带头不带 cookie → 403）/ connect 写链 200 + 落盘效果。

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prefetchCsrf, clientActionViaApi, inviteViaApi } from '../../apps/desktop/src/main/wizard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', '..', 'packages', 'mcp', 'bin', 'mebular.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let home;
let serve;
let base;
const opencodePath = () => join(home, '.config', 'opencode', 'opencode.json');

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'mebular-csrf-it-'));
  await writeFile(join(home, 'config.json'), JSON.stringify({
    storagePath: join(home, 'store.jsonl'),
    deviceId: 'device-csrf-it',
    encryption: { level: 'none' },
    network: { enabled: false },
    sync: { autoSync: true, pushOnWrite: true, antiEntropy: { enabled: false } },
    mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none', tls: false } },
  }, null, 2), 'utf-8');
  // 写链目标：opencode 配置存在但无 mebular 键（connect 应合并写入）
  await mkdir(join(home, '.config', 'opencode'), { recursive: true });
  await writeFile(opencodePath(), JSON.stringify({ theme: 'dark' }, null, 2), 'utf-8');

  serve = spawn(process.execPath, [bin, 'serve', '--port', '0'], {
    // F-FIX-A：沙箱 serve 必须声明用户主目录，否则 assistant 落面会写到**真实** `~/.config/…`
    env: { ...process.env, MEBULAR_HOME: home, MEBULAR_USER_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  serve.stdout.on('data', (d) => { out += d.toString(); });
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const match = out.match(/SERVE_READY (\{.*\})/);
    if (match) {
      const ready = JSON.parse(match[1]);
      base = `http://127.0.0.1:${ready.port}`;
      return;
    }
    if (serve.exitCode !== null) throw new Error('serve 提前退出');
    await sleep(150);
  }
  throw new Error('serve 就绪超时');
}, 45000);

afterAll(async () => {
  if (serve && serve.exitCode === null) serve.kill();
  if (home) await rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('CSRF 修死 · 真实 serve（沙箱 home，非 mock）', () => {
  it('prefetchCsrf：GET /console/ 取得 token ∧ cookie（同值双提交件）', async () => {
    const csrf = await prefetchCsrf(fetch, base);
    expect(csrf).not.toBeNull();
    expect(typeof csrf.token).toBe('string');
    expect(csrf.token.length).toBeGreaterThan(0);
    expect(csrf.cookie).toBe(`mebular_csrf=${csrf.token}`);
  });

  it('负例：只带头不带 cookie → 403（服务端 csrfValid 头∧cookie 双校验）', async () => {
    const csrf = await prefetchCsrf(fetch, base);
    const res = await fetch(`${base}/admin/api/invite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf.token },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const data = await res.json().catch(() => ({}));
    expect(data?.message ?? '').toContain('CSRF');
  });

  it('写链走通：clientActionViaApi(connect) → 200 changed:true + mebular 键落盘', async () => {
    const res = await clientActionViaApi(fetch, { host: '127.0.0.1', port: Number(new URL(base).port) }, 'opencode', 'connect');
    expect(res.warning ?? null).toBeNull();
    expect(res).toMatchObject({ ok: true, changed: true });
    // 落盘效果：opencode.json 现含 mcp.servers.mebular（备份同时生成）
    const written = JSON.parse(await readFile(opencodePath(), 'utf-8'));
    expect(written.mcp?.servers?.mebular).toBeTruthy();
    expect(written.theme).toBe('dark'); // 合并而非覆盖
  });

  it('inviteViaApi：CSRF 不再是阻碍（不因 403 失败；join 未启用给 409 人话）', async () => {
    const res = await inviteViaApi(fetch, { host: '127.0.0.1', port: Number(new URL(base).port) });
    // 未启用加入服务 → 409 join_disabled 人话；关键：不是 403 CSRF
    expect(res.warning ?? '').not.toContain('403');
    expect(res.warning ?? '').not.toContain('CSRF');
    expect(res.warning ?? '').toContain('加入服务');
  });
});
