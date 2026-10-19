// E2-B · 真实 serve 的 /healthz instance 对齐（CL-05 契约，非 mock）
//
// 只起一个临时 home 的 serve（端口 0），验证 App 的 probeHealthDetail 能读到
// A1 的 instance=homeKey(home)；错误期望值必须判为 instance_mismatch。

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeKey, probeHealthDetail } from '../../apps/desktop/src/main/daemon.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', '..', 'packages', 'mcp', 'bin', 'mebular.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let home;
let serve;
let http;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'e2b-health-'));
  await writeFile(join(home, 'config.json'), JSON.stringify({
    deviceId: 'device-e2b-health',
    mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none', tls: false } },
    network: { enabled: false },
  }, null, 2), 'utf-8');
  serve = spawn(process.execPath, [bin, 'serve', '--port', '0'], {
    env: { ...process.env, MEBULAR_HOME: home, MEBULAR_USER_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  serve.stdout.on('data', (data) => { out += data.toString(); });
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const ready = out.match(/(?:SERVE_READY|PROVISION_READY) (\{.*\})/);
    if (ready) {
      const parsed = JSON.parse(ready[1]);
      http = { host: '127.0.0.1', port: parsed.port };
      return;
    }
    if (serve.exitCode !== null) throw new Error(`serve 提前退出（code=${serve.exitCode}）`);
    await sleep(150);
  }
  throw new Error('serve 就绪超时');
}, 45_000);

afterAll(async () => {
  if (serve && serve.exitCode === null) serve.kill();
  if (home) await rm(home, { recursive: true, force: true }).catch(() => undefined);
});

describe('CL-05 · 真实 /healthz instance', () => {
  it('instance 与 homeKey(home) 一致 → ok', async () => {
    const result = await probeHealthDetail(fetch, http, { expectedInstance: homeKey(home) });
    expect(result).toMatchObject({ ok: true, instance: homeKey(home) });
  });

  it('期望其它 instance → instance_mismatch（绝不当作目标忆云）', async () => {
    const result = await probeHealthDetail(fetch, http, { expectedInstance: 'ffffffffffff' });
    expect(result).toMatchObject({ ok: false, reason: 'instance_mismatch' });
  });
});
