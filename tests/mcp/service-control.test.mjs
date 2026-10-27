// H-1 · 常驻运行（服务托管）单元测试：命令序列 + 两套 home 的隔离
//
// 两套 home：
//   - instanceHome（`home`）：MEBULAR 实例身份，写 descriptor 的 MEBULAR_HOME/workingDir/heartbeatDir；
//   - serviceHome：用户 OS home，unit/manifest/日志落盘位置。
// 用替身 runner（`run`）断言命令序列与单元内容；不真装服务。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import {
  serviceDescriptor,
  serviceStatusForHome,
  registeredForHome,
  installServiceForHome,
  uninstallServiceForHome,
  restartPlanForHome,
  resolveServiceHome,
  SERVICE_KIND,
} from '../../packages/mcp/src/service-control.mjs';

function recorder(instanceHome) {
  const commands = [];
  return {
    commands,
    run: (cmd, args) => {
      commands.push([cmd, ...(args ?? [])]);
      // F-INSTALL-1：print 恒「未加载」（bootout 后的等待卸载轮询即刻通过）；bootstrap 模拟守护起搏副作用
      // （写新鲜心跳——install 的终态校验只认比基线新的新鲜心跳，不再以「作业已装载」谎报 started）。
      if (cmd === 'launchctl' && args?.[0] === 'print') return { code: 1, status: 1, stdout: '', stderr: 'Could not find service' };
      if (cmd === 'launchctl' && args?.[0] === 'bootstrap') {
        writeFileSync(join(instanceHome, 'service.heartbeat'), JSON.stringify({ pid: process.pid, ts: Date.now(), role: 'mebular-serve', sha: 's' }), { mode: 0o600 });
      }
      return { code: 0, status: 0, stdout: '', stderr: '' };
    },
  };
}

const tailOf = (value) => value.split(/[\\/]/).filter(Boolean).pop();

describe('H-1 service-control：常驻运行', () => {
  let instanceHome;
  let serviceHome;
  let rec;
  beforeEach(async () => {
    instanceHome = await mkdtemp(join(tmpdir(), 'h1-svc-instance-'));
    serviceHome = await mkdtemp(join(tmpdir(), 'h1-svc-unit-'));
    rec = recorder(instanceHome);
  });
  afterEach(async () => {
    await rm(instanceHome, { recursive: true, force: true });
    await rm(serviceHome, { recursive: true, force: true });
  });

  it('描述符：服务命令带守护自身 home（env + workingDir + heartbeatDir，禁止 cwd）', () => {
    const desc = serviceDescriptor({ home: instanceHome });
    expect(desc.kind).toBe(SERVICE_KIND);
    expect(desc.args[desc.args.length - 1]).toBe('serve');
    expect(desc.env.MEBULAR_HOME).toBe(instanceHome);
    expect(desc.workingDir).toBe(instanceHome);
    expect(desc.heartbeatDir).toBe(instanceHome);
  });

  it('描述符：Electron 作为 Node 运行时，显式带 ELECTRON_RUN_AS_NODE', () => {
    const desc = serviceDescriptor({ home: instanceHome });
    expect(desc.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(desc.runtime.electron).toBe(Boolean(process.versions.electron));
  });

  it('linux：unit/manifest 落 serviceHome；单元仍带实例 home 的 MEBULAR_HOME/WorkingDirectory', () => {
    const res = installServiceForHome({ home: instanceHome, serviceHome, platform: 'linux', run: rec.run, now: 1700000000000 });
    expect(res.ok).toBe(true);
    expect(res.unitPath.startsWith(serviceHome)).toBe(true);
    expect(res.unitPath.startsWith(instanceHome)).toBe(false);
    expect(res.unitPath.startsWith(join(serviceHome, '.config', 'systemd', 'user'))).toBe(true);
    expect(res.manifestPath.startsWith(serviceHome)).toBe(true);
    const unit = readFileSync(res.unitPath, 'utf-8');
    // 平台无关：home 可能被 systemdQuote 转义（Windows 路径含反斜杠）；用 token + 唯一目录名断言
    expect(unit).toContain('MEBULAR_HOME');
    expect(unit).toContain('WorkingDirectory=');
    // Windows unit 会转义反斜杠，不能直接比原始绝对路径；唯一目录名足以证明实例身份。
    expect(unit).toContain(tailOf(instanceHome));
    expect(rec.commands[0]).toEqual(['systemctl', '--user', 'daemon-reload']);
    expect(rec.commands.some((c) => c[0] === 'systemctl' && c.includes('enable'))).toBe(true);
    expect(existsSync(res.manifestPath)).toBe(true);
  });

  it('darwin：plist 落 serviceHome 且含实例 home；心跳写 instanceHome', () => {
    const res = installServiceForHome({ home: instanceHome, serviceHome, platform: 'darwin', run: rec.run, now: 1700000000000 });
    expect(res.ok).toBe(true);
    expect(res.started).toBe(true); // F-INSTALL-1：终态校验（替身 bootstrap 写了新鲜心跳）通过才算 started
    expect(res.unitPath.startsWith(serviceHome)).toBe(true);
    expect(res.unitPath.startsWith(instanceHome)).toBe(false);
    expect(res.manifestPath.startsWith(serviceHome)).toBe(true);
    expect(res.unitPath.endsWith('.plist')).toBe(true);
    const plist = readFileSync(res.unitPath, 'utf-8');
    expect(plist).toContain('MEBULAR_HOME');
    // 同上：Windows plist 文本会转义反斜杠。
    expect(plist).toContain(tailOf(instanceHome));
    expect(existsSync(join(instanceHome, 'service.heartbeat'))).toBe(true);
    expect(existsSync(join(serviceHome, 'service.heartbeat'))).toBe(false);
    expect(rec.commands.some((c) => c[0] === 'launchctl' && c.includes('bootstrap'))).toBe(true);
  });

  it('状态机：未装 registered=false；装后 registered=true/autostart=true；卸载后回 false', () => {
    expect(serviceStatusForHome({ home: instanceHome, serviceHome, platform: 'linux', run: rec.run }).registered).toBe(false);
    installServiceForHome({ home: instanceHome, serviceHome, platform: 'linux', run: rec.run, now: 1700000000000 });
    const st = serviceStatusForHome({ home: instanceHome, serviceHome, platform: 'linux', run: rec.run, now: 1700000000000 });
    expect(st.registered).toBe(true);
    expect(st.autostart).toBe(true);
    expect(registeredForHome({ home: instanceHome, serviceHome, platform: 'linux', run: rec.run })).toContain(SERVICE_KIND);
    const un = uninstallServiceForHome({ home: instanceHome, serviceHome, platform: 'linux', run: rec.run, now: 1700000000000 });
    expect(un.ok).toBe(true);
    expect(serviceStatusForHome({ home: instanceHome, serviceHome, platform: 'linux', run: rec.run }).registered).toBe(false);
    expect(registeredForHome({ home: instanceHome, serviceHome, platform: 'linux', run: rec.run })).not.toContain(SERVICE_KIND);
  });

  it('重启计划：包含服务 kind 与平台命令（复用 @mebular/service 计划）', () => {
    installServiceForHome({ home: instanceHome, serviceHome, platform: 'linux', run: rec.run, now: 1700000000000 });
    const plan = restartPlanForHome({ home: instanceHome, serviceHome, platform: 'linux', run: rec.run, now: 1700000000000 });
    expect(plan).toBeTruthy();
    expect(JSON.stringify(plan)).toContain('systemctl');
  });

  it('回归：home ≠ serviceHome 时 registered 以 serviceHome 为准，实例 home 路径不得误报', () => {
    installServiceForHome({ home: instanceHome, serviceHome, platform: 'darwin', run: rec.run, now: 1700000000000 });

    const status = serviceStatusForHome({ home: instanceHome, serviceHome, platform: 'darwin', run: rec.run, now: 1700000000000 });
    expect(status.registered).toBe(true);
    expect(status.unitPath.startsWith(serviceHome)).toBe(true);
    expect(registeredForHome({ home: instanceHome, serviceHome, platform: 'darwin', run: rec.run })).toContain(SERVICE_KIND);
    // 实例身份/心跳仍在 instanceHome，不能被 serviceHome 顶替；unit 文本按平台转义，用唯一尾名断言。
    expect(readFileSync(status.unitPath, 'utf-8')).toContain(tailOf(instanceHome));
    expect(existsSync(join(instanceHome, 'service.heartbeat'))).toBe(true);
    expect(existsSync(join(serviceHome, 'service.heartbeat'))).toBe(false);

    // 旧 bug 语义：把实例 home 当服务 home 查 → 指向不存在于实例 home 的 unit，必须为未注册（不误报）
    const wrong = serviceStatusForHome({ home: instanceHome, serviceHome: instanceHome, platform: 'darwin', run: rec.run, now: 1700000000000 });
    expect(wrong.registered).toBe(false);
    expect(wrong.unitPath.startsWith(serviceHome)).toBe(false);
    expect(registeredForHome({ home: instanceHome, serviceHome: instanceHome, platform: 'darwin', run: rec.run })).not.toContain(SERVICE_KIND);
  });

  it('serviceHome 解析：显式参数优先，其次 MEBULAR_SERVICE_UNIT_HOME（测试/隔离）', () => {
    const saved = process.env.MEBULAR_SERVICE_UNIT_HOME;
    process.env.MEBULAR_SERVICE_UNIT_HOME = serviceHome;
    try {
      expect(resolveServiceHome()).toBe(serviceHome);
      expect(resolveServiceHome(instanceHome)).toBe(instanceHome);
      const status = serviceStatusForHome({ home: instanceHome, platform: 'linux', run: rec.run });
      expect(status.unitPath.startsWith(serviceHome)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.MEBULAR_SERVICE_UNIT_HOME;
      else process.env.MEBULAR_SERVICE_UNIT_HOME = saved;
    }
  });
});
