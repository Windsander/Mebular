// POST /admin/api/repair：只重跑客户端接入（MCP + Skill force），不触碰 memory/identity/cloud/task/audit。
//
// 子进程跑真实 startServeServer（与 provision-mcp 同策略，避免 jest coverage 下的 ESM 桶链接问题）。

import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const HARNESS = String.raw`
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.REPAIR_ROOT;
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const workspace = await mkdtemp(join(tmpdir(), 'repair-api-'));
const home = join(workspace, 'home');
const userHome = join(workspace, 'user');
const cloudRoot = join(workspace, 'cloud');
const fakeBin = join(workspace, 'bin');
await mkdir(home, { recursive: true });
await mkdir(userHome, { recursive: true });
await mkdir(cloudRoot, { recursive: true });
await mkdir(fakeBin, { recursive: true });

// 确定性的 opencode 替身：--version 与 mcp list 都成功（不依赖本机是否装了 opencode）。
if (process.platform === 'win32') {
  // Windows：PATH 解析要 .cmd（无扩展名的 POSIX shebang 脚本无法执行）。
  const pathext = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  if (!pathext.some((ext) => ext.toUpperCase() === '.CMD')) pathext.push('.CMD');
  process.env.PATHEXT = pathext.join(';');
  const fakeOpencodeCmd = join(fakeBin, 'opencode.cmd');
  await writeFile(fakeOpencodeCmd, [
    '@echo off',
    'if "%1"=="--version" echo 9.9.9',
    'if "%1"=="mcp" echo mebular http://127.0.0.1:7331/mcp',
    'exit /b 0',
    '',
  ].join('\r\n'), 'utf-8');
} else {
  // POSIX：保留原有 shell 替身。
  const fakeOpencode = join(fakeBin, 'opencode');
  await writeFile(fakeOpencode, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi\nif [ "$1" = "mcp" ]; then echo "mebular http://127.0.0.1:7331/mcp"; exit 0; fi\nexit 0\n', 'utf-8');
  await chmod(fakeOpencode, 0o755);
}

process.env.MEBULAR_HOME = home;
process.env.MEBULAR_USER_HOME = userHome;
process.env.MEBULAR_CLOUD_ROOT = cloudRoot;
process.env.MEBULAR_SKILL_AUTOWIRE = '0';
process.env.MEBULAR_NETWORK_ENABLED = '0';
process.env.PATH = [fakeBin, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
delete process.env.MEBULAR_PROVISION;
delete process.env.MEBULAR_STORAGE_PATH;

// 已存在客户端：opencode 配置 + 一份“用户自定义”的 Skill（repair force 应覆盖它）。
const opencodeDir = join(userHome, '.config', 'opencode');
await mkdir(opencodeDir, { recursive: true });
const opencodeConfig = join(opencodeDir, 'opencode.json');
await writeFile(opencodeConfig, JSON.stringify({
  theme: 'dark',
  mcp: {
    servers: {
      other: { keep: 1 },
      // 升级前遗留：runtime 现在监听随机端口，旧 loopback 端口必须判为 stale。
      mebular: { type: 'remote', url: 'http://127.0.0.1:56007/mcp' },
    },
  },
}, null, 2), 'utf-8');
const skillDir = join(opencodeDir, 'skills');
await mkdir(join(skillDir, 'mebular-memory'), { recursive: true });
await writeFile(join(skillDir, 'mebular-memory', 'SKILL.md'), 'CUSTOM USER SKILL', 'utf-8');

const readJson = async (path) => {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return null; }
};
const sha = async (path) => {
  try { return createHash('sha256').update(await readFile(path)).digest('hex'); } catch { return null; }
};

const csrf = async (base) => {
  const page = await fetch(base + '/console/');
  return {
    token: page.headers.get('x-mebular-csrf'),
    cookie: page.headers.getSetCookie().find((value) => value.startsWith('mebular_csrf=')).split(';')[0],
  };
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
const getJson = async (base, path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const waitFor = async (predicate, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return true; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

const { startServeServer } = await load('packages/mcp/src/server.mjs');
const { Client, StreamableHTTPClientTransport } = await load('node_modules/@modelcontextprotocol/client/dist/index.mjs');
const out = { cases: {} };
const srv = await startServeServer({ host: '127.0.0.1', port: 0, auth: 'none' });
const base = 'http://127.0.0.1:' + srv.port;
try {
  const auth = await csrf(base);
  out.cases.create = await post(base, '/app/provision/create', {
    confirm: true,
    deviceName: 'repair-device',
    cloudName: 'repair-cloud',
  }, auth);

  // runtime ready（热初始化 + 实际端口确定）后，旧 loopback URL 应被自动 reconcile。
  out.cases.currentMcpUrl = base + '/mcp';
  out.cases.autoHealed = await waitFor(async () => {
    const cfg = await readJson(opencodeConfig);
    return cfg?.mcp?.servers?.mebular?.url === base + '/mcp';
  });
  out.cases.autoReconciledConfig = await readJson(opencodeConfig);
  out.cases.clientsAfterStartup = await getJson(base, '/admin/api/clients');
  out.cases.skillAfterStartup = await readFile(join(skillDir, 'mebular-memory', 'SKILL.md'), 'utf-8').catch(() => null);

  // 先写一条真实记忆：让 store（记忆/任务/审计共用事件日志）存在且非空，
  // 修复前后按字节比对才有意义。
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'));
  const mcp = new Client({ name: 'repair-api-test', version: '1.0.0' });
  await mcp.connect(transport);
  out.cases.seed = await mcp.callTool({
    name: 'memory_write',
    arguments: { items: [{ type: 'fact', content: 'repair-seed', metadata: { namespace: 'notes' } }] },
  });
  await mcp.close();

  out.cases.before = {
    store: await sha(join(home, 'store.jsonl')),
    identity: await sha(join(home, 'store.jsonl.identity.json')),
    master: await sha(join(home, 'user-master-key.json')),
    config: await sha(join(home, 'config.json')),
    policy: await getJson(base, '/admin/api/policy'),
    memories: await getJson(base, '/admin/api/memories'),
    clouds: await getJson(base, '/admin/api/clouds'),
    overview: await getJson(base, '/admin/api/overview'),
  };

  // 启动自愈已完成后，再制造一次运行期漂移：验证手动「自动修复」兜底仍能把旧 URL 写回当前端点。
  await writeFile(opencodeConfig, JSON.stringify({
    theme: 'dark',
    mcp: { servers: { other: { keep: 1 }, mebular: { type: 'remote', url: 'http://127.0.0.1:56007/mcp' } } },
  }, null, 2), 'utf-8');
  out.cases.clientsBefore = await getJson(base, '/admin/api/clients?refresh=1');

  out.cases.repair = await post(base, '/admin/api/repair', {}, auth);

  out.cases.after = {
    store: await sha(join(home, 'store.jsonl')),
    identity: await sha(join(home, 'store.jsonl.identity.json')),
    master: await sha(join(home, 'user-master-key.json')),
    config: await sha(join(home, 'config.json')),
    policy: await getJson(base, '/admin/api/policy'),
    memories: await getJson(base, '/admin/api/memories'),
    clouds: await getJson(base, '/admin/api/clouds'),
    overview: await getJson(base, '/admin/api/overview'),
  };
  out.cases.opencodeConfig = await readJson(opencodeConfig);
  out.cases.skillFiles = await readdir(join(skillDir, 'mebular-memory')).catch(() => []);
  out.cases.skillMd = await readFile(join(skillDir, 'mebular-memory', 'SKILL.md'), 'utf-8').catch(() => null);
  out.cases.marker = await readJson(join(skillDir, 'mebular-memory', '.mebular-skill.json'));
  out.cases.mcpFragment = await readFile(join(skillDir, 'mebular-memory', 'mcp', 'opencode.json'), 'utf-8').catch(() => null);
} finally {
  await srv.close();
  out.cases.homeFiles = await readdir(home).catch(() => []);
}

await rm(workspace, { recursive: true, force: true });
console.log('REPAIR_RESULT ' + JSON.stringify(out));
`;

function runHarness() {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', HARNESS], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 240_000,
    env: { ...process.env, REPAIR_ROOT: ROOT, NODE_NO_WARNINGS: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`repair harness failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`);
  }
  const line = String(result.stdout).split('\n').find((entry) => entry.startsWith('REPAIR_RESULT '));
  if (!line) throw new Error(`repair harness produced no result:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice('REPAIR_RESULT '.length));
}

const result = runHarness();

describe('POST /admin/api/repair：只修客户端接入', () => {
  it('端点可用：逐项返回 connect / skills / verify 结果，失败不中断其他客户端', () => {
    expect(result.cases.create.status).toBe(200);
    expect(result.cases.create.body).toMatchObject({ ok: true, initialized: true });
    expect(result.cases.seed.isError).not.toBe(true);
    expect(result.cases.before.store).toMatch(/^[0-9a-f]{64}$/);
    expect(result.cases.repair.status).toBe(200);
    expect(result.cases.repair.body).toMatchObject({ ok: true, scope: 'client-integration' });
    const clients = result.cases.repair.body.clients ?? [];
    expect(Array.isArray(clients)).toBe(true);
    expect(clients.length).toBeGreaterThan(0);
    const opencode = clients.find((entry) => entry.id === 'opencode');
    expect(opencode).toBeTruthy();
    expect(opencode.connect).toMatchObject({ ok: true });
    expect(opencode.skills).toMatchObject({ ok: true });
    expect(opencode.skills.installed.length + opencode.skills.updated.length).toBeGreaterThanOrEqual(2);
    expect(opencode.verify.ok).toBe(true);
    expect(['pending-restart', 'connected']).toContain(opencode.stateAfter);
  });

  it('MCP 条目 + Skill（含 mcp/ 片段）被强制重跑，用户自定义 Skill 被覆盖', () => {
    expect(result.cases.opencodeConfig?.theme).toBe('dark');
    expect(result.cases.opencodeConfig?.mcp?.servers?.other).toEqual({ keep: 1 });
    expect(result.cases.opencodeConfig?.mcp?.servers?.mebular?.url).toBe(result.cases.currentMcpUrl);
    expect(result.cases.skillMd).not.toBe('CUSTOM USER SKILL');
    expect(result.cases.skillMd).toMatch(/name:\s*mebular-memory/);
    expect(result.cases.mcpFragment).toContain('mebular');
    expect(result.cases.marker).toMatchObject({ schema: 1, managedBy: 'mebular', skill: 'mebular-memory' });
    expect(result.cases.marker.files['mcp/opencode.json']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('runtime ready 自动 reconcile 旧 loopback URL：不 force Skill，其他 server 保留', () => {
    expect(result.cases.autoHealed).toBe(true);
    const healed = result.cases.autoReconciledConfig;
    expect(healed?.theme).toBe('dark');
    expect(healed?.mcp?.servers?.other).toEqual({ keep: 1 });
    expect(healed?.mcp?.servers?.mebular).toEqual({
      type: 'remote',
      url: result.cases.currentMcpUrl,
      oauth: false,
      codemode: false,
    });
    expect(result.cases.skillAfterStartup).toBe('CUSTOM USER SKILL');
    const afterStartup = (result.cases.clientsAfterStartup?.body?.clients ?? []).find((entry) => entry.id === 'opencode');
    expect(afterStartup?.connected).toBe(true);
    expect(afterStartup?.state).toBe('connected');
  });

  it('旧 56007 URL：/admin/api/clients 不报 connected，repair 写回当前 mcpUrl', () => {
    const beforeClients = result.cases.clientsBefore?.body?.clients ?? [];
    const beforeOpencode = beforeClients.find((entry) => entry.id === 'opencode');
    expect(beforeOpencode).toBeTruthy();
    expect(beforeOpencode.state).toBe('stale');
    expect(beforeOpencode.connected).toBe(false);
    expect(beforeOpencode.staleUrl).toBe(true);
    expect(beforeOpencode.landing?.staleUrl).toBe(true);
    expect(beforeOpencode.landing?.configuredUrl).toMatch(/56007/);
    expect(beforeOpencode.landing?.expectedUrl).toBe(result.cases.currentMcpUrl);
    expect(beforeOpencode.landing?.staleReason).toMatch(/56007/);
    expect(beforeOpencode.landing?.staleReason).toMatch(/过期/);

    const repaired = (result.cases.repair.body.clients ?? []).find((entry) => entry.id === 'opencode');
    expect(repaired?.stateBefore).toBe('stale');
    expect(repaired?.verify?.ok).toBe(true);
  });

  it('不触碰 memory / identity / cloud / task / audit：store、身份、主密钥、config 字节不变', () => {
    const before = result.cases.before;
    const after = result.cases.after;
    expect(after.store).toBe(before.store);
    expect(after.identity).toBe(before.identity);
    expect(after.master).toBe(before.master);
    expect(after.config).toBe(before.config);
    expect(after.policy.status).toBe(200);
    expect(after.memories.status).toBe(200);
    expect(after.clouds.status).toBe(200);
    expect(before.memories.body.memories?.length).toBeGreaterThan(0);
    expect(after.policy.body.events?.length).toBe(before.policy.body.events?.length);
    expect(after.memories.body.memories?.length).toBe(before.memories.body.memories?.length);
    expect(after.clouds.body.profiles?.length).toBe(before.clouds.body.profiles?.length);
    expect(after.overview.body.device?.deviceId).toBe(before.overview.body.device?.deviceId);
    // home 内文件集合也不因修复增减（repair 不建身份/忆云/任务文件）
    expect(result.cases.homeFiles).toEqual(expect.arrayContaining(['config.json', 'store.jsonl', 'store.jsonl.identity.json', 'user-master-key.json']));
  });
});
