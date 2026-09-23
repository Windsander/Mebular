// verify:config —— 配置管道端到端矩阵（A 单一真源/暴露面 + C 一键重启 + D 三元组 + E 根因 + G 保存即生效）
//
//   S1 schema 驱动写校验：editable 可写 / status-only 拒写 400 / 敏感 internal 拒写 400 / 未知 400 / 非法值 400
//   S2 暴露面：configSchema=20 editable、statusSchema=11 status-only、internal 不出现在任何渲染面 + 三元组覆盖
//   S3 自锁防护：auth/host/tls → 409 needsConfirmation（不写盘、不重启）
//   S4 保存即生效：需重启项 → 自动重启 → lastApply=applied + 逐字段生效校验 + 待重启清空
//   S5 防抖：窗口内两次保存只触发一次重启（重启计数）
//   S6 热路径：MEBULAR_CONFIG_HOT_PATHS 声明的项保存不重启且不进待重启
//   S7 回滚兜底：新配置启动失败（join 端口被占）→ 自动回滚 .bak + 旧实例恢复 + lastApply=rolled-back
//   S8 一键重启接口：401（无凭证）/ 403（无 CSRF）/ 409（前台运行给手动指引）/ 202（服务托管 + dry-run）
//   S9 E 根因化：join 端口被占 → 启动错误含可执行修复（不是笼统「serve 起不来」）+ join.error.json

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = join(here, '..');
const bin = join(rootDir, 'packages', 'mcp', 'bin', 'mebular.mjs');

let pass = 0;
let fail = 0;
const failures = [];
function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? `（${detail}）` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function spawnServe({ home, storage, deviceId, port = 0, env = {} }) {
  const proc = spawn(process.execPath, [bin, 'serve', '--port', String(port)], {
    env: { ...process.env, MEBULAR_HOME: home, MEBULAR_STORAGE_PATH: storage, MEBULAR_DEVICE_ID: deviceId, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { err += d.toString(); });
  return { proc, getOut: () => out, getErr: () => err };
}

function waitReady(handle, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = handle.getOut().match(/SERVE_READY (\{.*\})/);
      if (match) { clearInterval(timer); resolve(JSON.parse(match[1])); return; }
      if (handle.proc.exitCode !== null) { clearInterval(timer); reject(new Error(`serve 提前退出：${handle.getErr()}`)); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`serve 未就绪：${handle.getErr()}`)); }
    }, 100);
  });
}

async function stop(handle) {
  if (!handle?.proc || handle.proc.exitCode !== null) return;
  handle.proc.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { handle.proc.kill('SIGKILL'); resolve(); }, 5000);
    handle.proc.on('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 长期占用一个端口（造 join 端口冲突）。 */
function occupyPort(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = createServer(() => {});
    server.once('error', reject);
    // 与 join 服务绑定**同一地址**才会真正 EADDRINUSE（0.0.0.0 与 127.0.0.1 在 macOS 可共存）
    server.listen(port, host, () => resolve(server));
  });
}

async function getJson(port, path, headers = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch (error) {
    return { status: 0, json: null, error: String(error?.message ?? error) };
  }
}

async function csrfToken(port) {
  const res = await fetch(`http://127.0.0.1:${port}/console`);
  const raw = (res.headers.getSetCookie?.() ?? []).join('; ') || res.headers.get('set-cookie') || '';
  const token = /mebular_csrf=([^;]+)/.exec(raw)?.[1] ?? '';
  return { token, cookie: `mebular_csrf=${token}` };
}

async function writePatch(port, patch, csrf, extra = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/admin/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf.token, cookie: csrf.cookie },
    body: JSON.stringify({ patch, ...extra }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** 深合并（Object.assign 会覆盖顶层键：sync 出现两次时后者吃掉前者）。 */
function deepMerge(...objects) {
  const out = {};
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj ?? {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = deepMerge(out[key] ?? {}, value);
      } else {
        out[key] = value;
      }
    }
  }
  return out;
}

const TEST_RESTART_HELPER = `import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.argv[2];
const state = JSON.parse(readFileSync(join(home, 'test-serve.json'), 'utf-8'));
appendFileSync(join(home, 'restart-count.log'), 'restart\\n');
try { process.kill(state.pid, 'SIGTERM'); } catch {}
setTimeout(() => {
  const proc = spawn(process.execPath, [state.bin, 'serve', '--port', String(state.port)], {
    env: { ...process.env, ...state.env }, detached: true, stdio: 'ignore',
  });
  proc.unref();
  writeFileSync(join(home, 'test-serve.json'), JSON.stringify({ ...state, pid: proc.pid }));
}, 250);
`;

/** 读 supervisor/新实例写下的状态。 */
async function readJsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return null; }
}

async function waitFor(predicate, { timeoutMs = 30000, pollMs = 250 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return null;
    await sleep(pollMs);
  }
}

const restartCount = (home) => (existsSync(join(home, 'restart-count.log'))
  ? readFile(join(home, 'restart-count.log'), 'utf-8').then((t) => t.split('\n').filter(Boolean).length).catch(() => 0)
  : Promise.resolve(0));

async function main() {
  console.log('Mebular 配置管道验证（verify:config）\n');
  const schema = await import('../packages/mcp/src/config-schema.mjs');
  const workspace = await mkdtemp(join(tmpdir(), 'mebular-config-'));
  await rm(workspace, { recursive: true, force: true });
  const livePids = new Set();

  // ================================================================ 主夹具（服务托管 + 自动重启）
  const home = join(workspace, 'home');
  await mkdir(join(home, 'auth'), { recursive: true });
  const storage = join(home, 'store.jsonl');
  const tokensFile = join(home, 'auth', 'tokens.json');
  await writeFile(tokensFile, JSON.stringify({ tokens: [] }), 'utf-8');
  const port = await freePort();
  await writeFile(join(home, 'config.json'), JSON.stringify({
    deviceId: 'device-config',
    sync: { autoSync: true, pushOnWrite: true, namespaces: ['notes'], peerWhitelist: ['device-peer'] },
    mcp: { http: { host: '127.0.0.1', port, auth: 'none', tls: false, tokensFile } },
    network: { enabled: false, libp2p: { listen: [], relayServers: ['/ip4/127.0.0.1/tcp/4001/p2p/seed'] } },
  }, null, 2), 'utf-8');
  const helper = join(home, 'restart-cmd.mjs');
  await writeFile(helper, TEST_RESTART_HELPER, 'utf-8');
  const serveEnv = {
    MEBULAR_HOME: home,
    MEBULAR_STORAGE_PATH: storage,
    MEBULAR_DEVICE_ID: 'device-config',
    MEBULAR_SERVICE_KIND: 'mebular-serve',
    MEBULAR_RESTART_CMD: `"${process.execPath}" "${helper}" "${home}"`,
    MEBULAR_APPLY_TIMEOUT_MS: '20000',
  };
  let handle = spawnServe({ home, storage, deviceId: 'device-config', port, env: serveEnv });
  livePids.add(handle.proc.pid);
  const ready = await waitReady(handle).catch((error) => { console.log(`✗ serve 启动失败：${error.message}`); process.exit(1); });
  await writeFile(join(home, 'test-serve.json'), JSON.stringify({ pid: handle.proc.pid, bin, port, env: serveEnv }), 'utf-8');
  const refreshHandle = async () => {
    const state = await readJsonFile(join(home, 'test-serve.json'));
    if (state?.pid) livePids.add(state.pid);
    return state;
  };
  check('主夹具：serve 启动（SERVE_READY）', Number.isInteger(ready.port) && ready.port > 0, `port=${ready.port}`);
  const csrf = await csrfToken(ready.port);
  check('控制台下发 CSRF（可双提交）', csrf.token.length > 0);

  // ---------------- S1 schema 驱动写校验 ----------------
  {
    const statusOnly = await writePatch(ready.port, { network: { libp2p: { relayServers: ['/ip4/1.2.3.4/tcp/4001/p2p/x'] } } }, csrf);
    check('S1 status-only（relayServers）拒写 400 且提示「只读」',
      statusOnly.status === 400 && /只读/.test(String(statusOnly.json?.message ?? '')),
      `status=${statusOnly.status}`);
    check('S1 敏感 internal（storagePath）拒写 400', (await writePatch(ready.port, { storagePath: '/tmp/x.jsonl' }, csrf)).status === 400);
    check('S1 未知 path 拒写 400', (await writePatch(ready.port, { nope: { field: 1 } }, csrf)).status === 400);
    check('S1 enum 非法值拒写 400', (await writePatch(ready.port, { mcp: { http: { auth: 'nope' } } }, csrf)).status === 400);
    check('S1 数值越界拒写 400', (await writePatch(ready.port, { mcp: { http: { port: 99999 } } }, csrf)).status === 400);
    check('S1 组合校验（tls=true 缺证书）拒写 400', (await writePatch(ready.port, { mcp: { http: { tls: true } } }, csrf)).status === 400);
    check('S1 可写性由 schema 显式声明（relayUnlimited 可写 / storagePath·tokensFile 保护）',
      schema.isWritable('network.libp2p.relayUnlimited') === true
        && schema.isWritable('storagePath') === false && schema.isWritable('mcp.http.tokensFile') === false);
  }

  // ---------------- S2 暴露面 + 三元组覆盖 ----------------
  {
    const settings = (await getJson(ready.port, '/admin/api/settings')).json;
    const configPaths = (settings.configSchema ?? []).map((e) => e.path).sort();
    const statusPaths = (settings.statusSchema ?? []).map((e) => e.path).sort();
    const effectivePaths = (settings.effective ?? []).map((r) => r.path).sort();
    check(`S2 configSchema = editable 20 项（实得 ${configPaths.length}）`,
      configPaths.length === 20 && JSON.stringify(configPaths) === JSON.stringify([...schema.EDITABLE_PATHS].sort()));
    check(`S2 statusSchema = status-only 11 项（实得 ${statusPaths.length}）`,
      statusPaths.length === 11 && JSON.stringify(statusPaths) === JSON.stringify([...schema.STATUS_ONLY_PATHS].sort()));
    check('S2 收敛：relayServers 仅只读面；relayUnlimited 不在任何渲染面',
      statusPaths.includes('network.libp2p.relayServers')
        && !configPaths.includes('network.libp2p.relayServers')
        && !configPaths.includes('network.libp2p.relayUnlimited')
        && !statusPaths.includes('network.libp2p.relayUnlimited'));
    check(`S2 三元组覆盖 = editable ∪ status-only（实得 ${effectivePaths.length}）`,
      effectivePaths.length === 31
        && JSON.stringify(effectivePaths) === JSON.stringify([...schema.EDITABLE_PATHS, ...schema.STATUS_ONLY_PATHS].sort()));
  }

  // ---------------- S3 自锁防护（不写盘 / 不重启） ----------------
  {
    const before = JSON.parse(await readFile(join(home, 'config.json'), 'utf-8'));
    const selfLockPatches = [
      ['auth', { mcp: { http: { auth: 'bearer' } } }],
      // host 自锁：必须给合法组合（非回环 + auth + TLS + 证书），否则先被组合校验 400 拦下
      ['host', { mcp: { http: { host: '0.0.0.0', auth: 'bearer', tls: true, tlsKey: '/tmp/k.pem', tlsCert: '/tmp/c.pem' } } }],
      ['tls', { mcp: { http: { tls: true, tlsKey: '/tmp/k.pem', tlsCert: '/tmp/c.pem' } } }],
    ];
    for (const [key, patch] of selfLockPatches) {
      const res = await writePatch(ready.port, patch, csrf);
      check(`S3 自锁项 mcp.http.${key} 未确认 → 409 needsConfirmation（不重启）`,
        res.status === 409 && res.json?.needsConfirmation === true && (res.json?.paths ?? []).includes(`mcp.http.${key}`),
        `status=${res.status}`);
    }
    const after = JSON.parse(await readFile(join(home, 'config.json'), 'utf-8'));
    check('S3 未确认时不写盘', JSON.stringify(before.mcp) === JSON.stringify(after.mcp));
    check('S3 未确认不触发重启（计数 0）', (await restartCount(home)) === 0);
  }

  // ---------------- S4 保存即生效（自动重启 + 生效校验） ----------------
  const restartFields = [
    ['sync.antiEntropy.intervalMs', { sync: { antiEntropy: { intervalMs: 123456 } } }],
    ['sync.snapshotThreshold', { sync: { snapshotThreshold: 4096 } }],
    ['semantic.minScore', { semantic: { minScore: 0.33 } }],
    ['joinService.bind', { joinService: { bind: '127.0.0.1' } }],
    ['joinService.port', { joinService: { port: 4021 } }],
    ['sync.policyIssuers', { sync: { policyIssuers: ['device-config'] } }],
  ];
  {
    const oldPid = handle.proc.pid;
    const saved = await writePatch(ready.port, deepMerge(...restartFields.map(([, p]) => p)), csrf, { confirm: true });
    check('S4 保存需重启项 → 200 + restarting:true + restart.mode=service',
      saved.status === 200 && saved.json?.restarting === true && saved.json?.restart?.mode === 'service',
      `status=${saved.status} mode=${saved.json?.restart?.mode}`);
    const pending = (await getJson(ready.port, '/admin/api/settings')).json?.pendingRestart ?? [];
    const pendingPaths = new Set(pending.map((p) => p.path));
    check('S4 保存后立即（防抖窗口内）待重启命中全部改动字段 + 每项含 label/file/running/reason',
      restartFields.every(([p]) => pendingPaths.has(p))
        && pending.every((p) => typeof p.label === 'string' && 'file' in p && 'running' in p && /待重启/.test(String(p.reason))),
      `pending=${[...pendingPaths].join(',')}`);
    const newState = await waitFor(async () => {
      const state = await readJsonFile(join(home, 'test-serve.json'));
      return state && state.pid !== oldPid ? state : null;
    }, { timeoutMs: 20000 });
    livePids.add(newState?.pid);
    check('S4 自动重启：新实例已监听（pid 变化 + serve-ready）',
      Boolean(newState) && Boolean(await readJsonFile(join(home, 'serve-ready.json'))), `old=${oldPid} new=${newState?.pid}`);
    const result = await waitFor(() => readJsonFile(join(home, 'config-apply.result.json')).then((r) => (r?.status === 'applied' ? r : null)), { timeoutMs: 20000 });
    const verify = Array.isArray(result?.verify) ? result.verify : [];
    check('S4 lastApply=applied 且逐字段生效校验全通过',
      Boolean(result) && verify.length >= restartFields.length && verify.every((r) => r.ok !== false)
        && restartFields.every(([p]) => verify.some((r) => r.path === p && r.ok === true)),
      `verify=${JSON.stringify(verify.map((r) => `${r.path}:${r.ok}`))}`.slice(0, 220));
    const settingsNew = (await getJson(ready.port, '/admin/api/settings')).json;
    check('S4 新实例待重启清单清空（restartRequired 归零）', (settingsNew?.pendingRestart ?? []).length === 0);
    const row = (settingsNew?.effective ?? []).find((r) => r.path === 'sync.antiEntropy.intervalMs');
    check('S4 实际生效：intervalMs=保存值 且原因=已生效', row?.actual === 123456 && row?.reason === '已生效', `actual=${row?.actual}`);
    check('S4 lastApply 暴露给控制台（状态 + 字段清单）',
      settingsNew?.lastApply?.status === 'applied' && (settingsNew?.lastApply?.fields ?? []).includes('joinService.port'));
  }

  // ---------------- S5 防抖（窗口内两次保存 → 一次重启） ----------------
  {
    const portNow = (await refreshHandle())?.port ?? port;
    const csrfNow = await csrfToken(portNow);
    const before = await restartCount(home);
    const csrfThrow = true; void csrfThrow;
    await writePatch(portNow, { sync: { antiEntropy: { intervalMs: 222222 } } }, csrfNow, { confirm: true });
    await writePatch(portNow, { sync: { antiEntropy: { jitterRatio: 0.4 } } }, csrfNow, { confirm: true });
    const newState = await waitFor(async () => {
      const state = await refreshHandle();
      const readyNow = await readJsonFile(join(home, 'serve-ready.json'));
      return state && readyNow && readyNow.pid === state.pid && state.pid !== (await readJsonFile(join(home, 'config-apply.result.json')))?.pid ? state : null;
    }, { timeoutMs: 20000, pollMs: 250 });
    void newState;
    await sleep(2000);
    const after = await restartCount(home);
    check('S5 防抖：窗口内两次保存合并为一次重启（计数 +1）', after - before === 1, `before=${before} after=${after}`);
    const row = ((await getJson(portNow, '/admin/api/settings')).json?.effective ?? []).find((r) => r.path === 'sync.antiEntropy.intervalMs');
    check('S5 两次保存的值都落盘并生效（intervalMs=222222）', row?.actual === 222222, `actual=${row?.actual}`);
  }

  // ---------------- S6 热路径（MEBULAR_CONFIG_HOT_PATHS：不重启 + 不进待重启） ----------------
  {
    const hotHome = join(workspace, 'hot');
    await mkdir(hotHome, { recursive: true });
    const hotStorage = join(hotHome, 'store.jsonl');
    const hotPort = await freePort();
    await writeFile(join(hotHome, 'config.json'), JSON.stringify({
      deviceId: 'device-hot',
      mcp: { http: { host: '127.0.0.1', port: hotPort, auth: 'none', tls: false } },
      network: { enabled: false },
    }, null, 2), 'utf-8');
    const hotHandle = spawnServe({
      home: hotHome, storage: hotStorage, deviceId: 'device-hot', port: hotPort,
      env: { MEBULAR_CONFIG_HOT_PATHS: 'semantic.minScore' },
    });
    livePids.add(hotHandle.proc.pid);
    const hotReady = await waitReady(hotHandle);
    const hotCsrf = await csrfToken(hotReady.port);
    const hotSaved = await writePatch(hotReady.port, { semantic: { minScore: 0.44 } }, hotCsrf);
    check('S6 热路径保存 → 200 + effectiveImmediately:true + restart.mode=none',
      hotSaved.status === 200 && hotSaved.json?.effectiveImmediately === true && hotSaved.json?.restart?.mode === 'none',
      `status=${hotSaved.status} mode=${hotSaved.json?.restart?.mode}`);
    const hotSettings = (await getJson(hotReady.port, '/admin/api/settings')).json;
    check('S6 热路径不触发重启（进程 pid 不变、无 lastApply）',
      hotHandle.proc.exitCode === null && alive(hotHandle.proc.pid) && !hotSettings?.lastApply);
    check('S6 热路径不进待重启横幅（原因=已声明为热生效）',
      (hotSettings?.pendingRestart ?? []).every((p) => p.path !== 'semantic.minScore')
        && (hotSettings?.effective ?? []).find((r) => r.path === 'semantic.minScore')?.reason?.includes('热生效'),
      `reason=${(hotSettings?.effective ?? []).find((r) => r.path === 'semantic.minScore')?.reason}`);
    await stop(hotHandle);
  }

  // ---------------- S7 回滚兜底（join 端口被占 → 启动失败 → 自动回滚） ----------------
  {
    const rbHome = join(workspace, 'rollback');
    await mkdir(rbHome, { recursive: true });
    const rbStorage = join(rbHome, 'store.jsonl');
    const rbPort = await freePort();
    const busyJoinPort = await freePort();
    const blocker = await occupyPort(busyJoinPort, '127.0.0.1');
    await writeFile(join(rbHome, 'config.json'), JSON.stringify({
      deviceId: 'device-rb',
      joinService: { enabled: false, bind: '127.0.0.1', port: busyJoinPort },
      mcp: { http: { host: '127.0.0.1', port: rbPort, auth: 'none', tls: false } },
      network: { enabled: false },
    }, null, 2), 'utf-8');
    const rbHelper = join(rbHome, 'restart-cmd.mjs');
    await writeFile(rbHelper, TEST_RESTART_HELPER, 'utf-8');
    const rbEnv = {
      MEBULAR_HOME: rbHome,
      MEBULAR_STORAGE_PATH: rbStorage,
      MEBULAR_DEVICE_ID: 'device-rb',
      MEBULAR_SERVICE_KIND: 'mebular-serve',
      MEBULAR_RESTART_CMD: `"${process.execPath}" "${rbHelper}" "${rbHome}"`,
      MEBULAR_APPLY_TIMEOUT_MS: '8000',
    };
    const rbHandle = spawnServe({ home: rbHome, storage: rbStorage, deviceId: 'device-rb', port: rbPort, env: rbEnv });
    livePids.add(rbHandle.proc.pid);
    const rbReady = await waitReady(rbHandle);
    await writeFile(join(rbHome, 'test-serve.json'), JSON.stringify({ pid: rbHandle.proc.pid, bin, port: rbPort, env: rbEnv }), 'utf-8');
    const rbCsrf = await csrfToken(rbReady.port);
    const oldPid = rbHandle.proc.pid;
    const saved = await writePatch(rbReady.port, { joinService: { enabled: true, bind: '127.0.0.1', port: busyJoinPort } }, rbCsrf, { confirm: true });
    check('S7 保存 joinService.enabled=true（端口被占）→ 触发自动重启', saved.status === 200 && saved.json?.restarting === true);
    const result = await waitFor(() => readJsonFile(join(rbHome, 'config-apply.result.json')).then((r) => (r?.status === 'rolled-back' || r?.status === 'rollback-failed' || r?.status === 'failed' ? r : null)), { timeoutMs: 40000, pollMs: 400 });
    check('S7 新配置启动失败 → lastApply=rolled-back（含根因）',
      result?.status === 'rolled-back' && /被占|占用|EADDRINUSE|未健康/.test(String(result?.reason ?? '')),
      `status=${result?.status} reason=${String(result?.reason ?? '').slice(0, 120)}`);
    const restored = JSON.parse(await readFile(join(rbHome, 'config.json'), 'utf-8'));
    check('S7 已回滚：config.json 恢复为备份（joinService.enabled=false）', restored.joinService?.enabled === false, `enabled=${restored.joinService?.enabled}`);
    const stateAfter = await waitFor(async () => {
      const state = await readJsonFile(join(rbHome, 'test-serve.json'));
      if (!state || state.pid === oldPid) return null;
      const readyNow = await readJsonFile(join(rbHome, 'serve-ready.json'));
      return readyNow?.pid === state.pid ? state : null;
    }, { timeoutMs: 30000, pollMs: 400 });
    livePids.add(stateAfter?.pid);
    check('S7 回滚后旧配置实例恢复健康（serve-ready = 新 pid）', Boolean(stateAfter), `pid=${stateAfter?.pid}`);
    const rbSettings = (await getJson(rbPort, '/admin/api/settings')).json;
    check('S7 回滚结果暴露给控制台（诊断页可查原因/字段/备份）',
      rbSettings?.lastApply?.status === 'rolled-back' && Array.isArray(rbSettings?.lastApply?.fields) && Boolean(rbSettings?.lastApply?.backup));
    blocker.close();
    await stop(rbHandle);
  }

  // ---------------- S8 一键重启接口（401 / 403 / 409 / 202） ----------------
  {
    // 主夹具已重启多次：CSRF 由新进程签发，必须重取（否则 403）
    const csrfFresh = await csrfToken(ready.port);
    // 403：无 CSRF（主夹具）
    const noCsrf = await fetch(`http://127.0.0.1:${ready.port}/admin/api/restart`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    });
    check('S8 无 CSRF → 403', noCsrf.status === 403, `status=${noCsrf.status}`);
    const noConfirm = await fetch(`http://127.0.0.1:${ready.port}/admin/api/restart`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrfFresh.token, cookie: csrfFresh.cookie }, body: '{}',
    });
    check('S8 无二次确认（confirm 缺失）→ 400', noConfirm.status === 400, `status=${noConfirm.status}`);

    // 401：bearer 夹具（无凭证）
    const bHome = join(workspace, 'bearer');
    await mkdir(join(bHome, 'auth'), { recursive: true });
    const bStorage = join(bHome, 'store.jsonl');
    const bPort = await freePort();
    await writeFile(join(bHome, 'config.json'), JSON.stringify({
      deviceId: 'device-bearer',
      mcp: { http: { host: '127.0.0.1', port: bPort, auth: 'bearer', tls: false } },
      network: { enabled: false },
    }, null, 2), 'utf-8');
    const bHandle = spawnServe({ home: bHome, storage: bStorage, deviceId: 'device-bearer', port: bPort });
    livePids.add(bHandle.proc.pid);
    await waitReady(bHandle);
    const bRes = await fetch(`http://127.0.0.1:${bPort}/admin/api/restart`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    });
    check('S8 未授权（bearer 无 token）→ 401', bRes.status === 401, `status=${bRes.status}`);
    await stop(bHandle);

    // 409：前台运行（无服务托管）→ 手动指引
    const fHome = join(workspace, 'foreground');
    await mkdir(fHome, { recursive: true });
    const fStorage = join(fHome, 'store.jsonl');
    const fPort = await freePort();
    await writeFile(join(fHome, 'config.json'), JSON.stringify({
      deviceId: 'device-fg',
      mcp: { http: { host: '127.0.0.1', port: fPort, auth: 'none', tls: false } },
      network: { enabled: false },
    }, null, 2), 'utf-8');
    const fHandle = spawnServe({ home: fHome, storage: fStorage, deviceId: 'device-fg', port: fPort });
    livePids.add(fHandle.proc.pid);
    await waitReady(fHandle);
    const fCsrf = await csrfToken(fPort);
    const fRes = await fetch(`http://127.0.0.1:${fPort}/admin/api/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mebular-csrf': fCsrf.token, cookie: fCsrf.cookie },
      body: JSON.stringify({ confirm: true }),
    });
    const fJson = await fRes.json().catch(() => null);
    check('S8 前台 nohup → 409 + 手动指引（命令 + .bak 回滚提示）',
      fRes.status === 409 && fJson?.error === 'not_service_managed' && /nohup mebular serve/.test(String(fJson?.manual ?? '')),
      `status=${fRes.status}`);
    // 前台保存需重启项 → 手动指引（不自动重启）
    const fSaved = await writePatch(fPort, { sync: { snapshotThreshold: 777 } }, fCsrf);
    check('S8 前台保存需重启项 → restarting:false + 手动指引（待重启语义保留）',
      fSaved.status === 200 && fSaved.json?.restarting === false && fSaved.json?.restart?.mode === 'foreground',
      `mode=${fSaved.json?.restart?.mode}`);
    check('S8 前台待重启仍在（#80 语义不弱化）',
      ((await getJson(fPort, '/admin/api/settings')).json?.pendingRestart ?? []).some((p) => p.path === 'sync.snapshotThreshold'));
    await stop(fHandle);

    // 202：服务托管 + dry-run（可注入）
    const dHome = join(workspace, 'dryrun');
    await mkdir(dHome, { recursive: true });
    const dStorage = join(dHome, 'store.jsonl');
    const dPort = await freePort();
    await writeFile(join(dHome, 'config.json'), JSON.stringify({
      deviceId: 'device-dry',
      mcp: { http: { host: '127.0.0.1', port: dPort, auth: 'none', tls: false } },
      network: { enabled: false },
    }, null, 2), 'utf-8');
    const dHandle = spawnServe({
      home: dHome, storage: dStorage, deviceId: 'device-dry', port: dPort,
      env: { MEBULAR_SERVICE_KIND: 'mebular-serve', MEBULAR_RESTART_CMD: 'true', MEBULAR_RESTART_DRY_RUN: '1' },
    });
    livePids.add(dHandle.proc.pid);
    await waitReady(dHandle);
    const dCsrf = await csrfToken(dPort);
    const dRes = await fetch(`http://127.0.0.1:${dPort}/admin/api/restart`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mebular-csrf': dCsrf.token, cookie: dCsrf.cookie },
      body: JSON.stringify({ confirm: true }),
    });
    const dJson = await dRes.json().catch(() => null);
    check('S8 服务托管 + dry-run → 202（先返回再触发，未真正执行）',
      dRes.status === 202 && dJson?.ok === true && dJson?.dryRun === true,
      `status=${dRes.status}`);
    check('S8 dry-run 未影响进程（仍存活）', dHandle.proc.exitCode === null && alive(dHandle.proc.pid));
    await stop(dHandle);
  }

  // ---------------- S9 E 根因化（join 端口被占 → 启动错误含修复动作） ----------------
  {
    const eHome = join(workspace, 'join-error');
    await mkdir(eHome, { recursive: true });
    const ePort = await freePort();
    const eJoin = await freePort();
    const blocker = await occupyPort(eJoin, '127.0.0.1');
    await writeFile(join(eHome, 'config.json'), JSON.stringify({
      deviceId: 'device-err',
      joinService: { enabled: true, bind: '127.0.0.1', port: eJoin },
      mcp: { http: { host: '127.0.0.1', port: ePort, auth: 'none', tls: false } },
      network: { enabled: false },
    }, null, 2), 'utf-8');
    const eHandle = spawnServe({ home: eHome, storage: join(eHome, 'store.jsonl'), deviceId: 'device-err', port: ePort });
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => { eHandle.proc.kill('SIGKILL'); resolve('timeout'); }, 20000);
      eHandle.proc.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 0); });
    });
    const stderr = eHandle.getErr();
    check('S9 join 端口被占 → serve 退出且错误含根因与修复动作（改端口/释放占用）',
      exitCode !== 'timeout' && exitCode !== 0 && /joinService\.port \d+ 被占/.test(stderr) && /改端口|释放/.test(stderr),
      `exit=${exitCode} err=${stderr.trim().split('\n').slice(-1)[0]?.slice(0, 140)}`);
    const joinError = await readJsonFile(join(eHome, 'join.error.json'));
    check('S9 落盘 join.error.json（供控制台/诊断展示原因）',
      joinError?.code === 'JOIN_PORT_IN_USE' && joinError?.port === eJoin, `code=${joinError?.code}`);
    blocker.close();
  }

  for (const pid of livePids) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
  await rm(workspace, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? '✓' : '✗'} 配置管道验证${fail === 0 ? '通过' : '失败'}（${pass} 通过 / ${fail} 失败）`);
  if (failures.length > 0) console.log(`失败项：\n- ${failures.join('\n- ')}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main().catch((error) => {
  console.error(`✗ verify:config 异常：${error?.stack ?? error}`);
  process.exit(1);
});
