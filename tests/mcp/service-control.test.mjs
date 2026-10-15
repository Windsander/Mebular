// H-1 · 常驻运行（服务托管）单元测试：命令序列 + 服务命令必须带守护自身 home
//
// 用替身 runner（`run`）断言命令序列与单元内容；不真装服务。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import {
  serviceDescriptor,
  serviceStatusForHome,
  installServiceForHome,
  uninstallServiceForHome,
  restartPlanForHome,
  SERVICE_KIND,
} from '../../packages/mcp/src/service-control.mjs';

function recorder(home) {
  const commands = [];
  return {
    commands,
    run: (cmd, args) => {
      commands.push([cmd, ...(args ?? [])]);
      // F-INSTALL-1：print 恒「未加载」（bootout 后的等待卸载轮询即刻通过）；bootstrap 模拟守护起搏副作用
      // （写新鲜心跳——install 的终态校验只认比基线新的新鲜心跳，不再以「作业已装载」谎报 started）。
      if (cmd === 'launchctl' && args?.[0] === 'print') return { code: 1, status: 1, stdout: '', stderr: 'Could not find service' };
      if (cmd === 'launchctl' && args?.[0] === 'bootstrap') {
        writeFileSync(join(home, 'service.heartbeat'), JSON.stringify({ pid: process.pid, ts: Date.now(), role: 'mebular-serve', sha: 's' }), { mode: 0o600 });
      }
      return { code: 0, status: 0, stdout: '', stderr: '' };
    },
  };
}

describe('H-1 service-control：常驻运行', () => {
  let home;
  let rec;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'h1-svc-'));
    rec = recorder(home);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('描述符：服务命令带守护自身 home（env + workingDir + heartbeatDir，禁止 cwd）', () => {
    const desc = serviceDescriptor({ home });
    expect(desc.kind).toBe(SERVICE_KIND);
    expect(desc.args[desc.args.length - 1]).toBe('serve');
    expect(desc.env.MEBULAR_HOME).toBe(home);
    expect(desc.workingDir).toBe(home);
    expect(desc.heartbeatDir).toBe(home);
  });

  it('linux：安装 → 单元含 MEBULAR_HOME/WorkingDirectory=home；命令序列固定', () => {
    const res = installServiceForHome({ home, platform: 'linux', run: rec.run, now: 1700000000000 });
    expect(res.ok).toBe(true);
    expect(res.unitPath.startsWith(home)).toBe(true);
    const unit = readFileSync(res.unitPath, 'utf-8');
    // 平台无关：home 可能被 systemdQuote 转义（Windows 路径含反斜杠）；用 token + 唯一目录名断言
    const base = home.split(/[\\/]/).filter(Boolean).pop();
    expect(unit).toContain('MEBULAR_HOME');
    expect(unit).toContain('WorkingDirectory=');
    expect(unit).toContain(base);
    expect(rec.commands[0]).toEqual(['systemctl', '--user', 'daemon-reload']);
    expect(rec.commands.some((c) => c[0] === 'systemctl' && c.includes('enable'))).toBe(true);
    expect(existsSync(res.manifestPath)).toBe(true);
  });

  it('darwin：安装 → plist 含 MEBULAR_HOME=home；launchctl 序列', () => {
    const res = installServiceForHome({ home, platform: 'darwin', run: rec.run, now: 1700000000000 });
    expect(res.ok).toBe(true);
    expect(res.started).toBe(true); // F-INSTALL-1：终态校验（替身 bootstrap 写了新鲜心跳）通过才算 started
    expect(res.unitPath.endsWith('.plist')).toBe(true);
    const plist = readFileSync(res.unitPath, 'utf-8');
    const base = home.split(/[\\/]/).filter(Boolean).pop();
    expect(plist).toContain('MEBULAR_HOME');
    expect(plist).toContain(base);
    expect(rec.commands.some((c) => c[0] === 'launchctl' && c.includes('bootstrap'))).toBe(true);
  });

  it('状态机：未装 registered=false；装后 registered=true/autostart=true；卸载后回 false', () => {
    expect(serviceStatusForHome({ home, platform: 'linux', run: rec.run }).registered).toBe(false);
    installServiceForHome({ home, platform: 'linux', run: rec.run, now: 1700000000000 });
    const st = serviceStatusForHome({ home, platform: 'linux', run: rec.run, now: 1700000000000 });
    expect(st.registered).toBe(true);
    expect(st.autostart).toBe(true);
    const un = uninstallServiceForHome({ home, platform: 'linux', run: rec.run, now: 1700000000000 });
    expect(un.ok).toBe(true);
    expect(serviceStatusForHome({ home, platform: 'linux', run: rec.run }).registered).toBe(false);
  });

  it('重启计划：包含服务 kind 与平台命令（复用 @mebular/service 计划）', () => {
    installServiceForHome({ home, platform: 'linux', run: rec.run, now: 1700000000000 });
    const plan = restartPlanForHome({ home, platform: 'linux', run: rec.run, now: 1700000000000 });
    expect(plan).toBeTruthy();
    expect(JSON.stringify(plan)).toContain('systemctl');
  });
});
