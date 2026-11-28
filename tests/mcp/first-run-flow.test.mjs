// 0.4.0 W1b：首启披露 → 初始化的服务端集成测试。
//
// 与 provision-lifecycle 同策略：原生 Node 子进程跑真实 startServeServer + HTTP handler，
// 避免 jest ESM/coverage 下的链接问题。
//
// 覆盖：
// - 空 home status 带 firstRun pending；未回传披露 → 不启用（fail closed）；
// - 披露成功（版本匹配）→ enabled=true + sidecar source=auto + effective=model，只发生一次；
// - 版本不匹配 → 不 ack、不启用；
// - acked 后重启 → serve 启动时重试初始化；
// - 已有用户（无 marker）→ 不出示、不补字段、配置逐字保留。

import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const HARNESS = String.raw`
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.FIRST_RUN_FLOW_ROOT;
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { startServeServer } = await load('packages/mcp/src/server.mjs');
const { readMemoryRuntimeModelSource } = await load('packages/mcp/src/memory-runtime-config.mjs');
const { resolveMemoryRuntimeEffectiveMode } = await load('packages/mcp/src/memory-runtime-effective.mjs');
const { detectFreshHome, readFirstRunMarker } = await load('packages/mcp/src/first-run.mjs');

const workspace = await mkdtemp(join(tmpdir(), 'first-run-flow-'));
const out = { homes: {}, cases: {} };

for (const key of Object.keys(process.env)) {
  if (key.startsWith('MEBULAR_')) delete process.env[key];
}
process.env.MEBULAR_USER_HOME = workspace;
process.env.MEBULAR_NETWORK_ENABLED = '0';
// 不真的拉起 sidecar：只验证 enabled/source/effective 与失败闭合。
process.env.MEBULAR_MEMORY_RUNTIME_BIN = join(workspace, 'missing-memory-runtime');

const readJson = async (path) => {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return null; }
};
const readText = async (path) => {
  try { return await readFile(path, 'utf-8'); } catch { return null; }
};
const csrf = async (base) => {
  const page = await fetch(base + '/console/');
  return {
    token: page.headers.get('x-mebular-csrf'),
    cookie: page.headers.getSetCookie().find((value) => value.startsWith('mebular_csrf=')).split(';')[0],
  };
};
const getJson = async (base, path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = async (base, path, body, auth) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mebular-csrf': auth.token,
      cookie: auth.cookie,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const stop = async (srv) => {
  await srv.close().catch(() => undefined);
  await srv.lock?.release?.().catch(() => undefined);
};

const useHome = (name) => {
  const home = join(workspace, name);
  process.env.MEBULAR_HOME = home;
  process.env.MEBULAR_CLOUD_ROOT = home;
  out.homes[name] = home;
  return home;
};

// ---------- A) 未回传披露：provision 成功但保持 disabled ----------
{
  const home = useHome('no-disclosure');
  const srv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const base = 'http://127.0.0.1:' + srv.port;
  try {
    const status = await getJson(base, '/app/provision/status');
    out.cases.noDisclosure = { status };
    const auth = await csrf(base);
    out.cases.noDisclosure.create = await post(base, '/app/provision/create', { confirm: true }, auth);
    out.cases.noDisclosure.config = await readJson(join(home, 'config.json'));
    out.cases.noDisclosure.marker = await readJson(join(home, 'first-run.json'));
    out.cases.noDisclosure.sidecarExists = existsSync(join(home, 'memory-runtime', 'config.json'));
    out.cases.noDisclosure.statusAfter = await getJson(base, '/app/provision/status');
    out.cases.noDisclosure.fresh = await detectFreshHome({ home, env: process.env });
  } finally {
    await stop(srv);
  }
}

// ---------- B) 披露版本不匹配：不 ack、不启用 ----------
{
  const home = useHome('wrong-version');
  const srv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const base = 'http://127.0.0.1:' + srv.port;
  try {
    const auth = await csrf(base);
    out.cases.wrongVersion = {
      create: await post(base, '/app/provision/create', {
        confirm: true,
        firstRunDisclosure: true,
        firstRunDisclosureVersion: 2,
      }, auth),
    };
    out.cases.wrongVersion.config = await readJson(join(home, 'config.json'));
    out.cases.wrongVersion.marker = await readJson(join(home, 'first-run.json'));
    out.cases.wrongVersion.sidecarExists = existsSync(join(home, 'memory-runtime', 'config.json'));
  } finally {
    await stop(srv);
  }
}

// ---------- B2) 披露版本缺失：拒绝 ack、不启用 ----------
{
  const home = useHome('missing-version');
  const srv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const base = 'http://127.0.0.1:' + srv.port;
  try {
    const auth = await csrf(base);
    out.cases.missingVersion = {
      create: await post(base, '/app/provision/create', {
        confirm: true,
        firstRunDisclosure: true,
      }, auth),
    };
    out.cases.missingVersion.config = await readJson(join(home, 'config.json'));
    out.cases.missingVersion.marker = await readJson(join(home, 'first-run.json'));
    out.cases.missingVersion.sidecarExists = existsSync(join(home, 'memory-runtime', 'config.json'));
  } finally {
    await stop(srv);
  }
}

// ---------- C) 披露成功：唯一一次 enabled + source=auto + effective=model ----------
{
  const home = useHome('disclosed');
  const srv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const base = 'http://127.0.0.1:' + srv.port;
  try {
    const status = await getJson(base, '/app/provision/status');
    const auth = await csrf(base);
    const create = await post(base, '/app/provision/create', {
      confirm: true,
      firstRunDisclosure: true,
      firstRunDisclosureVersion: 1,
    }, auth);
    const config = await readJson(join(home, 'config.json'));
    const source = await readMemoryRuntimeModelSource({ home, env: process.env });
    out.cases.disclosed = {
      status,
      create,
      config,
      source,
      effective: resolveMemoryRuntimeEffectiveMode({
        config,
        modelSource: source.source,
        sourcePresent: source.sourcePresent,
      }),
      sidecar: await readJson(join(home, 'memory-runtime', 'config.json')),
      marker: await readJson(join(home, 'first-run.json')),
      statusAfter: await getJson(base, '/app/provision/status'),
      freshAfter: await detectFreshHome({ home, env: process.env }),
    };
  } finally {
    await stop(srv);
  }
}

// ---------- D) acked 后重启：serve 启动时重试初始化 ----------
{
  const home = useHome('retry');
  const first = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const firstBase = 'http://127.0.0.1:' + first.port;
  try {
    const auth = await csrf(firstBase);
    await post(firstBase, '/app/provision/create', { confirm: true }, auth);
  } finally {
    await stop(first);
  }
  const marker = await readJson(join(home, 'first-run.json'));
  await writeFile(join(home, 'first-run.json'), JSON.stringify({
    ...marker,
    state: 'acked',
    ackedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');

  const second = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  try {
    const source = await readMemoryRuntimeModelSource({ home, env: process.env });
    const config = await readJson(join(home, 'config.json'));
    out.cases.retry = {
      config,
      source,
      effective: resolveMemoryRuntimeEffectiveMode({
        config,
        modelSource: source.source,
        sourcePresent: source.sourcePresent,
      }),
      sidecar: await readJson(join(home, 'memory-runtime', 'config.json')),
      marker: await readJson(join(home, 'first-run.json')),
    };
  } finally {
    await stop(second);
  }
}

// ---------- E) 已有用户：无 marker、不出示、不补字段 ----------
{
  const home = useHome('existing');
  const seeded = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const seededBase = 'http://127.0.0.1:' + seeded.port;
  try {
    const auth = await csrf(seededBase);
    await post(seededBase, '/app/provision/create', { confirm: true }, auth);
  } finally {
    await stop(seeded);
  }
  // 模拟 0.4.0 之前的已有用户：显式 enabled=false + 自己的 source=local + 无 first-run marker。
  await rm(join(home, 'first-run.json'), { force: true });
  const raw = '{\n    "memoryRuntime": { "enabled": false },\n    "storagePath": ' + JSON.stringify(join(home, 'store.jsonl')) + '\n}\n';
  await writeFile(join(home, 'config.json'), raw, 'utf-8');
  const sidecar = await readJson(join(home, 'memory-runtime', 'config.json'));
  const sidecarRaw = sidecar ? JSON.stringify(sidecar, null, 4) : null;
  if (sidecar) await writeFile(join(home, 'memory-runtime', 'config.json'), sidecarRaw, 'utf-8');

  const srv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const base = 'http://127.0.0.1:' + srv.port;
  try {
    const status = await getJson(base, '/app/provision/status');
    out.cases.existing = {
      status,
      configRawUnchanged: (await readText(join(home, 'config.json'))) === raw,
      sidecarRawUnchanged: sidecarRaw === null
        ? null
        : (await readText(join(home, 'memory-runtime', 'config.json'))) === sidecarRaw,
      markerExists: existsSync(join(home, 'first-run.json')),
      fresh: await detectFreshHome({ home, env: process.env }),
    };
  } finally {
    await stop(srv);
  }
}

// ---------- F) 外部 storage path：不命中 first-run ----------
{
  const home = useHome('external-storage');
  const externalStore = join(workspace, 'external-store.jsonl');
  await writeFile(externalStore, '{"id":"existing"}\n', 'utf-8');
  process.env.MEBULAR_STORAGE_PATH = externalStore;
  const srv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const base = 'http://127.0.0.1:' + srv.port;
  try {
    out.cases.externalStorage = {
      status: await getJson(base, '/app/provision/status'),
      markerExists: existsSync(join(home, 'first-run.json')),
      fresh: await detectFreshHome({ home, env: process.env }),
    };
  } finally {
    await stop(srv);
    delete process.env.MEBULAR_STORAGE_PATH;
  }
}

// ---------- G) acked 后初始化失败：不阻塞启动，保留 warning/重试 ----------
{
  const home = useHome('retry-failure');
  const first = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  const firstBase = 'http://127.0.0.1:' + first.port;
  try {
    const auth = await csrf(firstBase);
    await post(firstBase, '/app/provision/create', { confirm: true }, auth);
  } finally {
    await stop(first);
  }
  const pending = await readJson(join(home, 'first-run.json'));
  await writeFile(join(home, 'first-run.json'), JSON.stringify({
    ...pending,
    state: 'acked',
    ackedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
  const configBefore = await readJson(join(home, 'config.json'));
  const brokenConfig = { ...configBefore, memoryRuntime: 'broken' };
  await writeFile(join(home, 'config.json'), JSON.stringify(brokenConfig, null, 2), 'utf-8');

  const broken = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  try {
    out.cases.retryFailure = {
      health: await getJson('http://127.0.0.1:' + broken.port, '/healthz'),
      config: await readJson(join(home, 'config.json')),
      marker: await readJson(join(home, 'first-run.json')),
      sidecarExists: existsSync(join(home, 'memory-runtime', 'config.json')),
    };
  } finally {
    await stop(broken);
  }

  const fixedConfig = await readJson(join(home, 'config.json'));
  delete fixedConfig.memoryRuntime;
  await writeFile(join(home, 'config.json'), JSON.stringify(fixedConfig, null, 2), 'utf-8');
  const fixed = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
  try {
    const source = await readMemoryRuntimeModelSource({ home, env: process.env });
    out.cases.retryFailure.fixed = {
      config: await readJson(join(home, 'config.json')),
      sidecar: await readJson(join(home, 'memory-runtime', 'config.json')),
      source,
      marker: await readJson(join(home, 'first-run.json')),
    };
  } finally {
    await stop(fixed);
  }
}

await rm(workspace, { recursive: true, force: true });
console.log('FIRST_RUN_RESULT ' + JSON.stringify(out));
`;

let harnessStderr = '';
function runHarness() {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', HARNESS], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 240_000,
    env: { ...process.env, FIRST_RUN_FLOW_ROOT: ROOT, NODE_NO_WARNINGS: '1' },
  });
  harnessStderr = String(result.stderr ?? '');
  if (result.status !== 0) {
    throw new Error(`first-run flow harness failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`);
  }
  const line = String(result.stdout).split('\n').find((entry) => entry.startsWith('FIRST_RUN_RESULT '));
  if (!line) throw new Error(`first-run flow harness produced no result:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice('FIRST_RUN_RESULT '.length));
}

const result = runHarness();

describe('0.4.0 W1b first-run 披露与初始化', () => {
  it('空 home：status 带 pending 披露；未回传 → 不启用', () => {
    const c = result.cases.noDisclosure;
    expect(c.status.status).toBe(200);
    expect(c.status.body).toMatchObject({
      provision: true,
      phase: 'UNINITIALIZED',
      firstRun: { pending: true, disclosureVersion: 1, state: 'pending' },
    });
    expect(c.create.status).toBe(200);
    expect(c.create.body.initialized).toBe(true);
    expect(c.create.body.firstRun).toBeUndefined();
    expect(c.config.memoryRuntime).toBeUndefined();
    expect(c.marker).toMatchObject({ state: 'pending', disclosureVersion: 1 });
    expect(c.sidecarExists).toBe(false);
    // 完成 provision 后正常态不再暴露引导 status（不会重复披露）。
    expect(c.statusAfter.status).toBe(404);
  });

  it('披露版本不匹配 → 不 ack、不启用', () => {
    const c = result.cases.wrongVersion;
    expect({ status: c.create.status, body: c.create.body }).toMatchObject({ status: 200, body: { firstRun: { acknowledged: false } } });
    expect(c.config.memoryRuntime).toBeUndefined();
    expect(c.marker).toMatchObject({ state: 'pending' });
    expect(c.sidecarExists).toBe(false);
  });

  it('披露版本缺失 → 拒绝 ack、不启用', () => {
    const c = result.cases.missingVersion;
    expect(c.create.status).toBe(200);
    expect(c.create.body.firstRun).toEqual({ acknowledged: false });
    expect(c.config.memoryRuntime).toBeUndefined();
    expect(c.marker).toMatchObject({ state: 'pending' });
    expect(c.sidecarExists).toBe(false);
  });

  it('披露成功 → enabled + source=auto + sourcePresent + effective=model', () => {
    const c = result.cases.disclosed;
    expect(c.status.body.firstRun).toMatchObject({ pending: true, disclosureVersion: 1 });
    expect(c.create.body.firstRun).toEqual({ acknowledged: true, initialized: true });
    expect(c.config.memoryRuntime).toEqual({ enabled: true });
    expect(c.sidecar).toEqual({ schema: 1, model: { source: 'auto' } });
    expect(c.source).toMatchObject({ source: 'auto', sourcePresent: true, exists: true });
    expect(c.effective).toMatchObject({
      mode: 'immersive',
      enabled: true,
      effective: 'model',
      planner: 'model',
      source: 'auto',
      sourcePresent: true,
      warnings: [],
    });
    expect(c.marker).toMatchObject({ state: 'done' });
    // 初始化后不再 pending：后续启动/刷新不会再次披露。
    expect(c.freshAfter).toBe(false);
    expect(c.statusAfter.status).toBe(404);
  });

  it('acked 后重启：serve 启动时幂等重试初始化', () => {
    const c = result.cases.retry;
    expect(c.config.memoryRuntime).toEqual({ enabled: true });
    expect(c.sidecar).toEqual({ schema: 1, model: { source: 'auto' } });
    expect(c.source).toMatchObject({ source: 'auto', sourcePresent: true });
    expect(c.effective.effective).toBe('model');
    expect(c.marker).toMatchObject({ state: 'done' });
  });

  it('acked 后初始化失败：不阻塞启动、配置不覆盖、修正后可重试', () => {
    const c = result.cases.retryFailure;
    expect(c.health.status).toBe(200);
    expect(c.config.memoryRuntime).toBe('broken');
    expect(c.marker).toMatchObject({ state: 'acked' });
    expect(c.sidecarExists).toBe(false);
    expect(harnessStderr).toContain('FIRST_RUN_INIT_FAILED config_invalid');
    expect(c.fixed.config.memoryRuntime).toEqual({ enabled: true });
    expect(c.fixed.sidecar).toEqual({ schema: 1, model: { source: 'auto' } });
    expect(c.fixed.source).toMatchObject({ source: 'auto', sourcePresent: true });
    expect(c.fixed.marker).toMatchObject({ state: 'done' });
  });

  it('外部 storage path：不写 marker、不披露', () => {
    const c = result.cases.externalStorage;
    expect(c.status.status).toBe(200);
    expect(c.status.body.firstRun).toBeUndefined();
    expect(c.markerExists).toBe(false);
    expect(c.fresh).toBe(false);
  });

  it('已有用户：不出示、不写 marker、配置逐字保留', () => {
    const c = result.cases.existing;
    expect(c.status.status).toBe(404);
    expect(c.fresh).toBe(false);
    expect(c.markerExists).toBe(false);
    expect(c.configRawUnchanged).toBe(true);
    expect(c.sidecarRawUnchanged === null || c.sidecarRawUnchanged === true).toBe(true);
  });
});
