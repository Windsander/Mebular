// H-1 · 常驻运行（服务托管）单元测试：命令序列 + 服务命令必须带守护自身 home
//
// 用替身 runner（`run`）断言命令序列与单元内容；不真装服务。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import {
  serviceDescriptor,
  serviceStatusForHome,
  installServiceForHome,
  uninstallServiceForHome,
  restartPlanForHome,
  SERVICE_KIND,
} from '../../packages/mcp/src/service-control.mjs';

function recorder() {
  const commands = [];
  return { commands, run: (cmd, args) => { commands.push([cmd, ...(args ?? [])]); return { status: 0, stdout: '', stderr: '' }; } };
}

describe('H-1 service-control：常驻运行', () => {
  let home;
  let rec;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'h1-svc-'));
    rec = recorder();
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
    expect(unit).toContain(`MEBULAR_HOME=${home}`);
    expect(unit).toContain(`WorkingDirectory=${home}`);
    expect(rec.commands[0]).toEqual(['systemctl', '--user', 'daemon-reload']);
    expect(rec.commands.some((c) => c[0] === 'systemctl' && c.includes('enable'))).toBe(true);
    expect(existsSync(res.manifestPath)).toBe(true);
  });

  it('darwin：安装 → plist 含 MEBULAR_HOME=home；launchctl 序列', () => {
    const res = installServiceForHome({ home, platform: 'darwin', run: rec.run, now: 1700000000000 });
    expect(res.ok).toBe(true);
    expect(res.unitPath.endsWith('.plist')).toBe(true);
    const plist = readFileSync(res.unitPath, 'utf-8');
    expect(plist).toContain('MEBULAR_HOME');
    expect(plist).toContain(home);
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
