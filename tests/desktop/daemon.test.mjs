// M1：桌面 App 守护托管 / IPC 白名单单元测试（纯逻辑，不启 GUI）
//
// 覆盖：参数解析、健康探测、复用判定、服务优先、子进程兜底（显式 MEBULAR_HOME）、
// 退出策略、IPC 白名单（含负例）、端口冲突人话处置。

import { describe, it, expect } from '@jest/globals';
import {
  parseArgs,
  probeHealth,
  probeRuntimeIdentity,
  ensureDaemon,
  stopManaged,
  diagnosePort,
  healthUrl,
  consoleUrl,
  resolveHttp,
  homeKey,
  serviceDescriptorFor,
} from '../../apps/desktop/src/main/daemon.mjs';
import { IPC_CHANNELS, isAllowedChannel, buildHandlerTable, diagnostics } from '../../apps/desktop/src/main/ipc.mjs';
import { iconDataUrl, iconDataUrl2x, TRAY_STATES } from '../../apps/desktop/src/main/tray-icons.mjs';

const http = { host: '127.0.0.1', port: 7331 };
const running = async () => ({ ok: true, json: async () => ({ instance: homeKey('/h') }) });
const refused = async () => { throw new Error('ECONNREFUSED'); };

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
