// M1：桌面 App 守护托管 / IPC 白名单单元测试（纯逻辑，不启 GUI）
//
// 覆盖：参数解析、健康探测、复用判定、服务优先、子进程兜底（显式 MEBULAR_HOME）、
// 退出策略、IPC 白名单（含负例）、端口冲突人话处置。

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_VERSION,
  createAppServiceAdapter,
  parseArgs,
  probeHealth,
  probeRuntimeIdentity,
  ensureDaemon,
  registerAppRuntimeProvider,
  stopManaged,
  diagnosePort,
  healthUrl,
  consoleUrl,
  resolveHttp,
  homeKey,
  serviceDescriptorFor,
  reconcileManagedState,
  resolveAppServiceRuntime,
  appServiceFallbackBlock,
  installLegacyAppService,
} from '../../apps/desktop/src/main/daemon.mjs';
import * as runtimeProviders from '../../packages/mcp/src/runtime-providers.mjs';
import * as runtimeSupervisor from '../../packages/mcp/src/runtime-supervisor.mjs';
import * as runtimeCurrent from '../../packages/mcp/src/runtime-current.mjs';
import { IPC_CHANNELS, isAllowedChannel, buildHandlerTable, diagnostics } from '../../apps/desktop/src/main/ipc.mjs';
import { iconDataUrl, iconDataUrl2x, TRAY_STATES } from '../../apps/desktop/src/main/tray-icons.mjs';

const http = { host: '127.0.0.1', port: 7331 };
const running = async () => ({ ok: true, json: async () => ({ instance: homeKey('/h') }) });
const refused = async () => { throw new Error('ECONNREFUSED'); };

const tempDirs = [];
afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix = 'mebular-desktop-daemon-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakeSupervisor(result) {
  const calls = [];
  return {
    calls,
    ensureRuntime: async (options) => {
      calls.push(options);
      return typeof result === 'function' ? result(options) : result;
    },
  };
}

describe('M1 桌面 App：参数 / URL', () => {
  it('parseArgs 支持 --k v、--k=v、布尔', () => {
    expect(parseArgs(['--home', '/h', '--port=7332', '--flag'])).toEqual({ home: '/h', port: '7332', flag: true });
  });
  it('healthUrl / consoleUrl 固定 127.0.0.1；resolveHttp 尊重 config/env', () => {
    expect(healthUrl(http)).toBe('http://127.0.0.1:7331/healthz');
    expect(consoleUrl(http)).toBe('http://127.0.0.1:7331/console');
    expect(resolveHttp({ mcp: { http: { port: 7444 } } }, {}).port).toBe(7444);
    expect(resolveHttp({}, { MEBULAR_HTTP_PORT: '7555' }).port).toBe(7555);
  });
});

describe('M1 桌面 App：运行期展示名', () => {
  it('probeRuntimeIdentity 读 overview 的网络派生名；失败返回 null（保留上一值）', async () => {
    const okFetch = async (url) => {
      expect(url).toBe('http://127.0.0.1:7331/admin/api/overview');
      return {
        ok: true,
        json: async () => ({ cloud: { name: '网络名' }, device: { name: '本机名' } }),
      };
    };
    expect(await probeRuntimeIdentity(okFetch, http)).toEqual({ cloudName: '网络名', deviceName: '本机名' });
    expect(await probeRuntimeIdentity(refused, http)).toBeNull();
    expect(await probeRuntimeIdentity(async () => ({ ok: false }), http)).toBeNull();
  });
});

describe('M1 桌面 App：守护托管', () => {
  it('probeHealth：健康 true / 拒连 false（不抛）', async () => {
    expect(await probeHealth(running, http)).toBe(true);
    expect(await probeHealth(refused, http)).toBe(false);
  });

  it('已有实例健康 → reused（不重复启动、不起子进程）', async () => {
    const r = await ensureDaemon({ home: '/h', http, fetchImpl: running, service: {}, spawnFn: () => { throw new Error('no'); } });
    expect(r.mode).toBe('reused');
    expect(r.child).toBeNull();
  });

  it('reconcileManagedState：App 托管的 child 仍存活时，reused 不得覆盖 child 身份', () => {
    const alive = { exitCode: null, killed: false };
    expect(reconcileManagedState({ resultMode: 'reused', resultChild: null, existingChild: alive }))
      .toEqual({ mode: 'child', child: alive });
    // service 同理：child 是本 App 拉起的，不能改认外部托管
    expect(reconcileManagedState({ resultMode: 'service', resultChild: null, existingChild: alive }))
      .toEqual({ mode: 'child', child: alive });
  });

  it('reconcileManagedState：child 已退出/已 kill → 接受 reused/service', () => {
    const exited = { exitCode: 1, killed: false };
    const killed = { exitCode: null, killed: true };
    const signaled = { exitCode: null, signalCode: 'SIGTERM', killed: false };
    expect(reconcileManagedState({ resultMode: 'reused', existingChild: exited }))
      .toEqual({ mode: 'reused', child: null });
    expect(reconcileManagedState({ resultMode: 'service', existingChild: killed }))
      .toEqual({ mode: 'service', child: null });
    expect(reconcileManagedState({ resultMode: 'reused', existingChild: signaled }))
      .toEqual({ mode: 'reused', child: null });
    expect(reconcileManagedState({ resultMode: 'reused' }))
      .toEqual({ mode: 'reused', child: null });
  });

  it('reconcileManagedState：ensureDaemon 新拉起 child → child（以本次结果为准）', () => {
    const spawned = { exitCode: null, killed: false };
    const old = { exitCode: null, killed: false };
    expect(reconcileManagedState({ resultMode: 'child', resultChild: spawned, existingChild: old }))
      .toEqual({ mode: 'child', child: spawned });
  });

  it('服务托管已登记 → service（优先于子进程）', async () => {
    let restarted = false;
    const r = await ensureDaemon({
      home: '/h', http, fetchImpl: refused, cliBin: '/x/mebular.mjs',
      service: { registeredServicesForDir: () => ['mebular-serve'], restartService: () => { restarted = true; } },
      spawnFn: () => { throw new Error('should not spawn'); },
    });
    expect(r.mode).toBe('service');
    expect(restarted).toBe(true);
  });

  it('无服务 → 子进程兜底且显式传 MEBULAR_HOME / CLOUD_ROOT / ELECTRON_RUN_AS_NODE（禁止 cwd）', async () => {
    let spawned = null;
    const r = await ensureDaemon({
      home: '/h', http, fetchImpl: refused, cliBin: '/x/mebular.mjs', cloudRoot: '/root',
      service: { registeredServicesForDir: () => [] },
      spawnFn: (exec, args, opts) => { spawned = { exec, args, opts }; return { kill: () => true }; },
    });
    expect(r.mode).toBe('child');
    expect(spawned.args).toEqual(['/x/mebular.mjs', 'serve', '--port', '7331']);
    expect(spawned.opts.env).toMatchObject({
      MEBULAR_HOME: '/h',
      MEBULAR_CLOUD_ROOT: '/root',
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(spawned.opts.env.MEBULAR_DEVICE_ID).toBeUndefined();
    expect(spawned.opts.env.MEBULAR_DEVICE_NAME).toBeUndefined();
  });

  it('服务描述符：OS home 与实例 home 分离；env 带 root + ELECTRON_RUN_AS_NODE', () => {
    const descriptor = serviceDescriptorFor({ home: '/cloud', cliBin: '/x/mebular.mjs', cloudRoot: '/root', http });
    expect(descriptor).toMatchObject({
      heartbeatDir: '/cloud',
      workingDir: '/cloud',
      env: {
        MEBULAR_HOME: '/cloud',
        MEBULAR_CLOUD_ROOT: '/root',
        ELECTRON_RUN_AS_NODE: '1',
      },
    });
    expect(descriptor.env.MEBULAR_DEVICE_ID).toBeUndefined();
    expect(descriptor.env.MEBULAR_DEVICE_NAME).toBeUndefined();
    expect(descriptor.args).toEqual(['/x/mebular.mjs', 'serve', '--port', '7331']);
  });

  it('退出策略：仅停子进程托管（服务托管不返回子进程）', () => {
    expect(stopManaged({ kill: () => true })).toBe(true);
    expect(stopManaged(null)).toBe(false);
    expect(stopManaged({})).toBe(false);
  });

  it('端口冲突人话处置：健康 → null；占用且不健康 → 可读建议', async () => {
    expect(await diagnosePort({ http, fetchImpl: running, probePort: async () => true })).toBeNull();
    const msg = await diagnosePort({ http, fetchImpl: refused, probePort: async () => true });
    expect(msg).toMatch(/端口 7331 已被占用/);
    expect(await diagnosePort({ http, fetchImpl: refused, probePort: async () => false })).toBeNull();
  });
});

describe('Phase 2 · ensureDaemon 委托共享 Runtime Supervisor', () => {
  const base = {
    home: '/cloud',
    cloudRoot: '/root',
    cliBin: '/x/mebular.mjs',
    execPath: '/electron',
    http: { host: '127.0.0.1', port: 7444 },
    env: { PATH: '/bin' },
    service: {},
    fetchImpl: refused,
  };

  it('reused → App reused；传给 supervisor 的是 App 专属 descriptor/provider/env', async () => {
    const supervisor = fakeSupervisor({ ok: true, mode: 'reused', home: '/cloud' });
    const result = await ensureDaemon({
      ...base,
      supervisor,
      spawnFn: () => { throw new Error('should not spawn'); },
    });

    expect(result).toMatchObject({ mode: 'reused', home: '/cloud', child: null, adapter: 'supervisor' });
    expect(supervisor.calls).toHaveLength(1);
    const options = supervisor.calls[0];
    expect(options).toMatchObject({
      home: '/cloud',
      port: 7444,
      cliBin: '/x/mebular.mjs',
      execPath: '/electron',
      serviceHome: homedir(),
      includeSelf: false,
      includeStandardApp: false,
    });
    expect(options.env).toMatchObject({ PATH: '/bin', MEBULAR_CLOUD_ROOT: '/root' });
    expect(options.registryProviders).toEqual([{
      kind: 'app',
      path: '/x/mebular.mjs',
      version: APP_VERSION,
      capabilities: ['serve'],
    }]);
    // App 的 service adapter 仍使用 App descriptor：args 带 --port、execPath、env 三件套、heartbeat=home。
    expect(options.service.descriptor).toMatchObject({
      args: ['/x/mebular.mjs', 'serve', '--port', '7444'],
      execPath: '/electron',
      heartbeatDir: '/cloud',
      workingDir: '/cloud',
      env: {
        MEBULAR_HOME: '/cloud',
        MEBULAR_CLOUD_ROOT: '/root',
        ELECTRON_RUN_AS_NODE: '1',
      },
    });
  });

  it('service/child 映射：只有 child 返回 App 持有的句柄（退出只停自己的 child）', async () => {
    const service = await ensureDaemon({
      ...base,
      supervisor: fakeSupervisor({ ok: true, mode: 'service', home: '/cloud' }),
    });
    expect(service).toMatchObject({ mode: 'service', home: '/cloud', child: null });
    expect(stopManaged(service.child)).toBe(false);

    const child = { kill: () => true };
    const managed = await ensureDaemon({
      ...base,
      supervisor: fakeSupervisor({ ok: true, mode: 'child', home: '/cloud', child }),
    });
    expect(managed.mode).toBe('child');
    expect(managed.child).toBe(child);
    expect(stopManaged(managed.child)).toBe(true);
    // reused/service 没有 child：App 退出不会误停外部 daemon。
    const reused = await ensureDaemon({
      ...base,
      supervisor: fakeSupervisor({ ok: true, mode: 'reused', home: '/cloud' }),
    });
    expect(reused.child).toBeNull();
    expect(stopManaged(reused.child)).toBe(false);
  });

  it('conflict 保留 reason/message：instance 不匹配与 CLOUD_ALREADY_ACTIVE 文案不变', async () => {
    const mismatch = await ensureDaemon({
      ...base,
      supervisor: fakeSupervisor({
        ok: false,
        mode: 'conflict',
        reason: 'instance_mismatch',
        instance: 'other',
        message: 'supervisor 原文',
      }),
    });
    expect(mismatch).toMatchObject({
      mode: 'conflict',
      reason: 'instance_mismatch',
      instance: 'other',
      child: null,
    });
    expect(mismatch.message).toBe('端口 7444 上是另一张忆云，请先停止它');

    const active = '已有忆云守护在运行（pid 4242，home=/other）：请先停止它';
    const conflict = await ensureDaemon({
      ...base,
      supervisor: fakeSupervisor({
        ok: false,
        mode: 'conflict',
        reason: 'CLOUD_ALREADY_ACTIVE',
        message: active,
      }),
    });
    expect(conflict).toMatchObject({ mode: 'conflict', reason: 'CLOUD_ALREADY_ACTIVE', message: active });
  });

  it('download_required / error 只映射为 App 不可用/冲突提示，绝不下载/安装', async () => {
    const download = await ensureDaemon({
      ...base,
      supervisor: fakeSupervisor({ ok: false, mode: 'download_required', reason: 'download_required' }),
    });
    expect(download.mode).toBe('conflict');
    expect(download.reason).toBe('download_required');
    expect(download.message).toMatch(/不会自动下载/);

    const error = await ensureDaemon({
      ...base,
      supervisor: fakeSupervisor({
        ok: false,
        mode: 'error',
        reason: 'RUNTIME_SERVICE_RESTART_FAILED',
        message: '常驻服务重启失败：launchctl kickstart 失败',
      }),
    });
    expect(error).toMatchObject({
      mode: 'conflict',
      reason: 'RUNTIME_SERVICE_RESTART_FAILED',
      message: '常驻服务重启失败：launchctl kickstart 失败',
      child: null,
    });
  });

  it('cloudRoot 不可用（自定义 home）→ 保留 App 原有路径，不改变受限环境行为', async () => {
    const result = await ensureDaemon({
      home: '/h',
      http,
      cloudRoot: null,
      service: {},
      fetchImpl: running,
      spawnFn: () => { throw new Error('should not spawn'); },
    });
    expect(result).toMatchObject({ mode: 'reused', adapter: 'legacy' });
  });

  it('真实 supervisor child：App spawnFn 收到 App 参数/env，返回的句柄只由 App 停止', async () => {
    const root = await tempDir();
    const probe = createServer();
    await new Promise((resolvePromise, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolvePromise);
    });
    const port = probe.address().port;
    await new Promise((resolvePromise) => probe.close(resolvePromise));

    const cliBin = join(root, 'fake-provider.mjs');
    await writeFile(cliBin, `import { createServer } from 'node:http';
const index = process.argv.indexOf('--port');
const port = Number(process.argv[index + 1]);
const instance = process.env.FAKE_INSTANCE;
const server = createServer((req, res) => {
  if (req.url !== '/healthz') { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', instance, version: '0.1.2' }));
});
server.listen(port, '127.0.0.1');
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`, 'utf-8');
    await writeFile(join(root, 'config.json'), JSON.stringify({
      mcp: { http: { host: '127.0.0.1', port } },
    }, null, 2), 'utf-8');

    let spawned = null;
    let spawnedChild = null;
    let result = null;
    try {
      result = await ensureDaemon({
        home: root,
        cloudRoot: root,
        cliBin,
        http: { host: '127.0.0.1', port },
        env: { PATH: process.env.PATH ?? '', FAKE_INSTANCE: homeKey(root) },
        service: {},
        fetchImpl: fetch,
        spawnFn: (exec, args, options) => {
          spawned = { exec, args, options };
          spawnedChild = spawn(exec, args, { ...options, stdio: 'ignore' });
          return spawnedChild;
        },
        supervisor: runtimeSupervisor,
        probePortFn: async () => false,
        waitAttempts: 40,
        waitIntervalMs: 50,
      });

      expect(result.mode).toBe('child');
      expect(spawned.args).toEqual([cliBin, 'serve', '--port', String(port)]);
      expect(spawned.options.env).toMatchObject({
        MEBULAR_HOME: root,
        MEBULAR_CLOUD_ROOT: root,
        ELECTRON_RUN_AS_NODE: '1',
        FAKE_INSTANCE: homeKey(root),
      });
      expect(result.child).toBe(spawnedChild);
      expect(result.child?.pid).toBeGreaterThan(0);
    } finally {
      if (result?.child) {
        const exited = new Promise((resolvePromise) => {
          if (result.child.exitCode !== null) resolvePromise();
          else result.child.once('exit', resolvePromise);
        });
        expect(stopManaged(result.child)).toBe(true);
        await exited;
        if (result.child.exitCode === null && result.child.signalCode === null) {
          result.child.kill('SIGKILL');
        }
      }
    }
  });
});

describe('Phase 2 · App 专属 service adapter / provider 注册', () => {
  it('serviceStatus 使用 App descriptor（--port/execPath/ELECTRON_RUN_AS_NODE/OS serviceHome）', async () => {
    const seen = [];
    const adapter = createAppServiceAdapter({
      service: {
        serviceStatus: (descriptor, options) => {
          seen.push({ descriptor, options });
          return { registered: true, running: true, autostart: true, foreign: false, unitPath: '/unit' };
        },
      },
      home: '/cloud',
      cliBin: '/x/mebular.mjs',
      execPath: '/electron',
      http: { host: '127.0.0.1', port: 7444 },
      cloudRoot: '/root',
      serviceHome: '/os-home',
    });

    expect(await adapter.status()).toMatchObject({
      ok: true,
      registered: true,
      running: true,
      foreign: false,
      unitPath: '/unit',
    });
    expect(seen[0].options).toEqual({ home: '/os-home' });
    expect(seen[0].descriptor).toMatchObject({
      args: ['/x/mebular.mjs', 'serve', '--port', '7444'],
      execPath: '/electron',
      heartbeatDir: '/cloud',
      workingDir: '/cloud',
      env: {
        MEBULAR_HOME: '/cloud',
        MEBULAR_CLOUD_ROOT: '/root',
        ELECTRON_RUN_AS_NODE: '1',
      },
    });
  });

  it('serviceStatus 抛错 → ok:false（supervisor fail-closed，不伪装未登记）', async () => {
    const adapter = createAppServiceAdapter({
      service: { serviceStatus: () => { throw new Error('launchctl unavailable'); } },
      home: '/cloud',
      cliBin: '/x/mebular.mjs',
      http,
      cloudRoot: '/root',
    });
    expect(await adapter.status()).toMatchObject({
      ok: false,
      registered: false,
      error: 'launchctl unavailable',
    });
  });

  it('restart 失败保留 App 现有中文错误信息；无 service 模块时保持未登记的旧 child 兜底', async () => {
    const failing = createAppServiceAdapter({
      service: { restartService: () => ({ ok: false, manual: 'launchctl kickstart -k gui/501/x' }) },
      home: '/cloud',
      cliBin: '/x/mebular.mjs',
      http,
      cloudRoot: '/root',
    });
    await expect(failing.restart()).rejects.toThrow(/常驻服务重启失败：launchctl kickstart -k gui\/501\/x/);

    const missing = createAppServiceAdapter({ service: {}, home: '/cloud', cliBin: '/x/mebular.mjs', http });
    expect(await missing.status()).toMatchObject({ ok: true, registered: false, available: false });
  });

  it('current 存在 + runtime-service 不可用：legacy App service install 被阻断，不调用 installService', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'runtime'), { recursive: true });
    await writeFile(join(root, 'runtime', 'current.json'), JSON.stringify({ v: 1 }), 'utf-8');
    let calls = 0;
    const service = {
      installService: () => {
        calls += 1;
        return { ok: true, started: true, unitPath: '/unit' };
      },
    };
    const descriptor = serviceDescriptorFor({ home: '/cloud', cliBin: '/x/mebular.mjs', cloudRoot: root });
    const blocked = await installLegacyAppService({
      service,
      descriptor,
      cloudRoot: root,
      serviceHome: '/os-home',
      runtimeServiceAvailable: false,
    });
    expect(blocked).toMatchObject({ ok: false, reason: 'RUNTIME_SERVICE_UNAVAILABLE' });
    expect(calls).toBe(0);
    expect(appServiceFallbackBlock({ cloudRoot: root, runtimeServiceAvailable: false })).toMatchObject({
      ok: false,
      reason: 'RUNTIME_SERVICE_UNAVAILABLE',
    });
  });

  it('current 不存在：legacy App service fallback 保持可用（调用 installService）', async () => {
    const root = await tempDir();
    let calls = 0;
    const service = {
      installService: () => {
        calls += 1;
        return { ok: true, started: true, unitPath: '/unit' };
      },
    };
    const descriptor = serviceDescriptorFor({ home: '/cloud', cliBin: '/x/mebular.mjs', cloudRoot: root });
    expect(appServiceFallbackBlock({ cloudRoot: root, runtimeServiceAvailable: false })).toBe(null);
    const installed = await installLegacyAppService({
      service,
      descriptor,
      cloudRoot: root,
      serviceHome: '/os-home',
      runtimeServiceAvailable: false,
    });
    expect(installed).toMatchObject({ ok: true, registered: true, unitPath: '/unit' });
    expect(calls).toBe(1);
  });

  it('App service 来源：current 可用指向共享 runtime；缺失时保留 App provider 且不下载', async () => {
    const root = await tempDir();
    const appCli = join(root, 'app', 'mebular.mjs');
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(appCli, '// app\n', 'utf-8');

    const fallback = await resolveAppServiceRuntime({ cliBin: appCli, cloudRoot: root, currentModule: runtimeCurrent });
    expect(fallback).toMatchObject({
      currentUsable: false,
      source: { provider: 'app', owner: 'app', cliPath: appCli },
    });

    const runtimePath = join(root, 'runtime', '0.1.2');
    const core = join(runtimePath, 'node_modules', '@mebular', 'core');
    await mkdir(join(core, 'packages', 'mcp', 'bin'), { recursive: true });
    await writeFile(join(core, 'package.json'), JSON.stringify({ name: '@mebular/core', version: '0.1.2' }), 'utf-8');
    const sharedCli = join(core, 'packages', 'mcp', 'bin', 'mebular.mjs');
    await writeFile(sharedCli, '// shared\n', 'utf-8');
    await writeFile(join(root, 'runtime', 'current.json'), JSON.stringify({
      v: 1,
      version: '0.1.2',
      runtimePath,
      cliPath: sharedCli,
      provider: 'shared',
      owner: 'shared',
      installedAt: '2026-01-01T00:00:00.000Z',
    }), 'utf-8');

    const current = await resolveAppServiceRuntime({ cliBin: appCli, cloudRoot: root, currentModule: runtimeCurrent });
    expect(current).toMatchObject({
      currentUsable: true,
      source: {
        provider: 'shared',
        owner: 'shared',
        version: '0.1.2',
        runtimePath,
        cliPath: sharedCli,
        execPath: process.execPath,
        electron: true,
      },
      current: { version: '0.1.2' },
    });

    const adapter = createAppServiceAdapter({
      service: {},
      home: '/cloud',
      cliBin: appCli,
      execPath: '/electron',
      http: { host: '127.0.0.1', port: 7444 },
      cloudRoot: root,
      runtimeSource: current.source,
      current: current.current,
      currentUsable: true,
    });
    expect(adapter.descriptor).toMatchObject({
      args: [sharedCli, 'serve', '--port', '7444'],
      execPath: '/electron',
      env: {
        MEBULAR_HOME: '/cloud',
        MEBULAR_CLOUD_ROOT: root,
        ELECTRON_RUN_AS_NODE: '1',
        MEBULAR_RUNTIME_PROVIDER: 'shared',
        MEBULAR_RUNTIME_OWNER: 'shared',
      },
      runtime: {
        version: '0.1.2',
        runtimePath,
        cliPath: sharedCli,
        provider: 'shared',
        owner: 'shared',
      },
    });
  });

  it('注册 kind:app provider：版本更新同一条、可被 provider 发现、失败不阻塞且不覆盖损坏文件', async () => {
    const root = await tempDir();
    const cliBin = join(root, 'mebular.mjs');
    await writeFile(cliBin, '// fake app runtime entry\n', 'utf-8');

    const first = await registerAppRuntimeProvider({
      cloudRoot: root,
      cliBin,
      version: '0.1.2',
      providers: runtimeProviders,
    });
    expect(first).toMatchObject({ ok: true, created: true });
    expect(first.provider).toMatchObject({
      kind: 'app',
      path: cliBin,
      version: '0.1.2',
      capabilities: ['serve'],
    });

    let listed = await runtimeProviders.listRuntimeProviders(root);
    expect(listed.providers).toHaveLength(1);
    expect(listed.providers[0]).toMatchObject({
      kind: 'app',
      path: cliBin,
      version: '0.1.2',
      capabilities: ['serve'],
      available: true,
    });
    const raw = await readFile(runtimeProviders.runtimeProvidersPath(root), 'utf-8');
    expect(raw).not.toMatch(/token|privateKey|identity|secret/i);
    const registeredAt = first.provider.registeredAt;

    const unchanged = await registerAppRuntimeProvider({
      cloudRoot: root,
      cliBin,
      version: '0.1.2',
      providers: runtimeProviders,
    });
    expect(unchanged).toMatchObject({ ok: true, unchanged: true });

    const updated = await registerAppRuntimeProvider({
      cloudRoot: root,
      cliBin,
      version: '0.1.3',
      providers: runtimeProviders,
    });
    expect(updated).toMatchObject({ ok: true, created: false, provider: { version: '0.1.3', registeredAt } });
    listed = await runtimeProviders.listRuntimeProviders(root);
    expect(listed.providers).toHaveLength(1);
    expect(listed.providers[0].version).toBe('0.1.3');

    // 路径变化：同一把写锁内替换 kind:app，旧路径记录不保留（避免 Plugin 选中旧 runtime）。
    const movedCli = join(root, 'Mebular-moved.app', 'mebular.mjs');
    await mkdir(join(root, 'Mebular-moved.app'), { recursive: true });
    await writeFile(movedCli, '// relocated app runtime entry\n', 'utf-8');
    const moved = await registerAppRuntimeProvider({
      cloudRoot: root,
      cliBin: movedCli,
      version: '0.1.4',
      providers: runtimeProviders,
    });
    expect(moved).toMatchObject({ ok: true, created: false });
    expect(moved.replaced).toHaveLength(1);
    expect(moved.replaced[0].path).toBe(cliBin);
    listed = await runtimeProviders.listRuntimeProviders(root);
    expect(listed.providers).toHaveLength(1);
    expect(listed.providers[0]).toMatchObject({ kind: 'app', path: movedCli, version: '0.1.4' });

    const discovery = await runtimeSupervisor.discoverRuntimeProviders({
      root,
      env: { PATH: '' },
      includeSelf: false,
      includeStandardApp: false,
    });
    expect(discovery.selected).toMatchObject({ kind: 'app', path: movedCli, version: '0.1.4' });
    expect(discovery.available.map((entry) => entry.path)).not.toContain(cliBin);
  });

  it('provider 注册：cloudRoot 不可用跳过；损坏注册表返回错误且不改文件', async () => {
    const skipped = await registerAppRuntimeProvider({ cloudRoot: null, cliBin: '/x/mebular.mjs' });
    expect(skipped).toMatchObject({ ok: false, skipped: true, reason: 'cloud_unavailable' });

    const root = await tempDir();
    const file = runtimeProviders.runtimeProvidersPath(root);
    await writeFile(file, '{broken', 'utf-8');
    const failed = await registerAppRuntimeProvider({
      cloudRoot: root,
      cliBin: join(root, 'mebular.mjs'),
      providers: runtimeProviders,
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/注册表/);
    expect(await readFile(file, 'utf-8')).toBe('{broken');
  });

  it('真实 supervisor：第二入口已健康 → reused attach，不 spawn', async () => {
    const root = await tempDir();
    const port = 18999;
    await writeFile(join(root, 'config.json'), JSON.stringify({
      deviceId: 'device-app',
      mcp: { http: { host: '127.0.0.1', port } },
    }, null, 2), 'utf-8');
    const instance = homeKey(root);
    let spawned = 0;

    const result = await ensureDaemon({
      home: root,
      cloudRoot: root,
      cliBin: '/x/mebular.mjs',
      http: { host: '127.0.0.1', port },
      env: { PATH: process.env.PATH ?? '', MEBULAR_CLOUD_ROOT: root },
      service: {},
      fetchImpl: refused,
      spawnFn: () => { spawned += 1; return { kill: () => true }; },
      supervisor: runtimeSupervisor,
      probeHealthFn: async () => ({ ok: true, instance, body: { instance, version: '0.1.2' } }),
      probePortFn: async () => false,
    });

    expect(result).toMatchObject({ mode: 'reused', home: root, child: null, adapter: 'supervisor' });
    expect(spawned).toBe(0);
  });

  it('真实 supervisor：service 状态未知 / restart 失败 → fail-closed，不 spawn 第二个 daemon', async () => {
    const root = await tempDir();
    const port = 18998;
    await writeFile(join(root, 'config.json'), JSON.stringify({
      mcp: { http: { host: '127.0.0.1', port } },
    }, null, 2), 'utf-8');
    const down = async () => ({ ok: false, reason: 'unreachable' });
    let spawned = 0;
    const spawnFn = () => { spawned += 1; return { kill: () => true }; };

    let restarts = 0;
    const unknown = await ensureDaemon({
      home: root,
      cloudRoot: root,
      cliBin: '/x/mebular.mjs',
      http: { host: '127.0.0.1', port },
      env: { PATH: process.env.PATH ?? '', MEBULAR_CLOUD_ROOT: root },
      service: { serviceStatus: () => { throw new Error('launchctl unavailable'); } },
      fetchImpl: refused,
      spawnFn,
      supervisor: runtimeSupervisor,
      probeHealthFn: down,
      probePortFn: async () => false,
    });
    expect(unknown).toMatchObject({ mode: 'conflict', reason: 'service_unknown' });
    expect(unknown.message).toMatch(/无法确认 mebular-serve 状态/);
    expect(spawned).toBe(0);

    const failedRestart = await ensureDaemon({
      home: root,
      cloudRoot: root,
      cliBin: '/x/mebular.mjs',
      http: { host: '127.0.0.1', port },
      env: { PATH: process.env.PATH ?? '', MEBULAR_CLOUD_ROOT: root },
      service: {
        serviceStatus: () => ({ registered: true, running: false }),
        restartService: () => { restarts += 1; return { ok: false, manual: 'launchctl kickstart failed' }; },
      },
      fetchImpl: refused,
      spawnFn,
      supervisor: runtimeSupervisor,
      probeHealthFn: down,
      probePortFn: async () => false,
    });
    expect(failedRestart).toMatchObject({
      mode: 'conflict',
      reason: 'RUNTIME_SERVICE_RESTART_FAILED',
      message: '常驻服务重启失败：launchctl kickstart failed',
    });
    expect(restarts).toBe(1);
    expect(spawned).toBe(0);
  });
});


describe('M1 桌面 App：IPC 白名单 / 托盘', () => {
  it('白名单集合固定；任意通道与注入串被拒', () => {
    expect(IPC_CHANNELS).toContain('daemon:status');
    expect(isAllowedChannel('daemon:status')).toBe(true);
    expect(isAllowedChannel('console:open')).toBe(true);
    expect(isAllowedChannel('exec:arbitrary')).toBe(false);
    expect(isAllowedChannel('')).toBe(false);
    expect(isAllowedChannel('daemon:status --evil')).toBe(false);
  });

  it('handler 表只注册白名单通道（丢弃非白名单）', () => {
    const table = buildHandlerTable({ 'daemon:status': () => 'ok', 'exec:arbitrary': () => 'no' });
    expect(Object.keys(table)).toEqual(['daemon:status']);
  });

  it('菜单栏星章：任意 state 同一品牌图形（模板图）+ @2x 载荷可取', () => {
    expect(TRAY_STATES).toEqual(['green', 'yellow', 'red']);
    expect(iconDataUrl('green')).toMatch(/^data:image\/png;base64,/);
    expect(iconDataUrl('nonsense')).toBe(iconDataUrl('red'));
    expect(iconDataUrl2x()).toMatch(/^data:image\/png;base64,/);
  });

  it('diagnostics 仅本地信息（无外联字段）', () => {
    const d = diagnostics({ appVersion: '0.1.0', electronVersion: '33.0.0', mode: 'child', home: '/h', http, healthy: true });
    expect(d.app).toBe('@mebular/desktop@0.1.0');
    expect(d.daemon).toMatchObject({ mode: 'child', home: '/h', healthy: true });
    expect(JSON.stringify(d)).not.toMatch(/telemetry|analytics|endpoint/i);
  });
});
