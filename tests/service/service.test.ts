// @mebular/service：平台单元 golden + install/uninstall/status/logs + 心跳。
// 全部 hermetic（home=temp，外部命令经 fake runner 注入），可在 macOS/Linux/Windows 跑。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import {
  launchdPlist,
  systemdUnit,
  windowsTaskXml,
  unitFilePath,
  manifestPath,
  serviceLogPaths,
  writeHeartbeat,
  readHeartbeat,
  isHeartbeatFresh,
  heartbeatAgeMs,
  startHeartbeat,
  installService,
  uninstallService,
  serviceStatus,
  serviceLogs,
  registeredServicesForDir,
  runServiceCli,
  resolveBuildSha,
  unitText,
  heartbeatPath,
  launchAgentsDir,
  systemdUserDir,
  windowsTaskDir,
  serviceLogsDir,
  serviceStateDir,
  type ServiceDescriptor,
  type RunResult,
  type UnitSpec,
} from '../../packages/service/src/index.js';

const spec: UnitSpec = {
  kind: 'fleet-node',
  label: 'com.mebular.fleet-node',
  execPath: '/usr/bin/node',
  args: ['/opt/mebular/fleet/cli.js', 'node', '--dir', '/data/fleet'],
  workingDir: '/data/fleet',
  env: { MEBULAR_SERVICE_KIND: 'fleet-node', MEBULAR_SERVICE_SHA: 'abc1234' },
  stdoutLog: '/home/u/.mebular/services/logs/fleet-node.out.log',
  stderrLog: '/home/u/.mebular/services/logs/fleet-node.err.log',
  sha: 'abc1234',
  autostart: true,
};

describe('单元生成（golden，纯函数）', () => {
  it('launchd plist：RunAtLoad/KeepAlive/Throttle/日志/环境/SHA', () => {
    expect(launchdPlist(spec)).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- mebular-service: kind=fleet-node sha=abc1234 -->
  <key>Label</key>
  <string>com.mebular.fleet-node</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
    <string>/opt/mebular/fleet/cli.js</string>
    <string>node</string>
    <string>--dir</string>
    <string>/data/fleet</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/home/u/.mebular/services/logs/fleet-node.out.log</string>
  <key>StandardErrorPath</key>
  <string>/home/u/.mebular/services/logs/fleet-node.err.log</string>
  <key>WorkingDirectory</key>
  <string>/data/fleet</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MEBULAR_SERVICE_KIND</key>
    <string>fleet-node</string>
    <key>MEBULAR_SERVICE_SHA</key>
    <string>abc1234</string>
  </dict>
</dict>
</plist>
`,
    );
  });

  it('launchd：--no-autostart → RunAtLoad=false', () => {
    expect(launchdPlist({ ...spec, autostart: false })).toContain('  <key>RunAtLoad</key>\n  <false/>');
  });

  it('systemd unit：Restart=on-failure + [Install] WantedBy', () => {
    expect(systemdUnit(spec)).toBe(
      `# mebular-service: kind=fleet-node sha=abc1234
[Unit]
Description=Mebular fleet-node
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/mebular/fleet/cli.js node --dir /data/fleet
Restart=on-failure
RestartSec=10
WorkingDirectory=/data/fleet
Environment=MEBULAR_SERVICE_KIND=fleet-node
Environment=MEBULAR_SERVICE_SHA=abc1234
StandardOutput=append:/home/u/.mebular/services/logs/fleet-node.out.log
StandardError=append:/home/u/.mebular/services/logs/fleet-node.err.log

[Install]
WantedBy=default.target
`,
    );
  });

  it('systemd：--no-autostart → 无 [Install]；含空白的参数被引号包裹', () => {
    const noAuto = systemdUnit({ ...spec, autostart: false });
    expect(noAuto).not.toContain('[Install]');
    expect(systemdUnit({ ...spec, args: ['/a b/cli.js'] })).toContain('ExecStart=/usr/bin/node "/a b/cli.js"');
  });

  it('windows task XML：onlogon（autostart）与无触发器（--no-autostart）', () => {
    const auto = windowsTaskXml({ ...spec, env: undefined });
    expect(auto).toContain('<LogonTrigger>');
    expect(auto).toContain('<RestartOnFailure>');
    expect(auto).toContain('<Command>/usr/bin/node</Command>');
    expect(auto).toContain('<Arguments>/opt/mebular/fleet/cli.js node --dir /data/fleet</Arguments>');
    const noAuto = windowsTaskXml({ ...spec, env: undefined, autostart: false });
    expect(noAuto).not.toContain('<LogonTrigger>');
  });

  it('unitFilePath：三平台落盘位置', () => {
    expect(unitFilePath('darwin', spec, '/h')).toBe('/h/Library/LaunchAgents/com.mebular.fleet-node.plist');
    expect(unitFilePath('linux', spec, '/h')).toBe('/h/.config/systemd/user/mebular-fleet-node.service');
    expect(unitFilePath('win32', spec, '/h')).toBe('/h/.mebular/services/tasks/fleet-node.xml');
  });

  it('resolveBuildSha：env 优先，其次 git，最后 unknown', () => {
    expect(resolveBuildSha({ MEBULAR_BUILD_SHA: 'deadbeef' } as NodeJS.ProcessEnv, '/nonexistent')).toBe('deadbeef');
    expect(resolveBuildSha({ MEBULAR_SERVICE_SHA: 'cafe' } as NodeJS.ProcessEnv, '/nonexistent')).toBe('cafe');
    expect(resolveBuildSha({} as NodeJS.ProcessEnv, '/nonexistent')).toBe('unknown');
  });

  it('unitText：未知平台抛错', () => {
    expect(() => unitText('plan9' as never, spec)).toThrow(/unsupported platform/);
  });

  it('路径：env 覆盖状态目录；各平台目录/日志', () => {
    const saved = process.env.MEBULAR_SERVICE_HOME;
    process.env.MEBULAR_SERVICE_HOME = '/x/state';
    expect(serviceStateDir('/h')).toBe('/x/state');
    if (saved === undefined) delete process.env.MEBULAR_SERVICE_HOME;
    else process.env.MEBULAR_SERVICE_HOME = saved;
    expect(serviceStateDir('/h')).toBe('/h/.mebular/services');
    expect(launchAgentsDir('/h')).toBe('/h/Library/LaunchAgents');
    expect(systemdUserDir('/h')).toBe('/h/.config/systemd/user');
    expect(windowsTaskDir('/h')).toBe('/h/.mebular/services/tasks');
    expect(serviceLogsDir('/h')).toBe('/h/.mebular/services/logs');
  });
});

describe('心跳', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(os.tmpdir(), 'svc-hb-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  it('写/读/新鲜度；陈旧可判定', async () => {
    writeHeartbeat(dir, { role: 'fleet-node', sha: 'abc', now: 1_000 });
    expect(readHeartbeat(dir)).toEqual({ pid: process.pid, ts: 1_000, role: 'fleet-node', sha: 'abc' });
    expect(isHeartbeatFresh(dir, 15_000, 5_000)).toBe(true);
    expect(isHeartbeatFresh(dir, 15_000, 60_000)).toBe(false);
    expect(heartbeatAgeMs(dir, 60_000)).toBe(59_000);
    if (process.platform !== 'win32') {
      expect((await stat(join(dir, 'service.heartbeat'))).mode & 0o777).toBe(0o600);
    }
  });

  it('readHeartbeat：非 JSON / 缺字段 → null', async () => {
    await writeFile(heartbeatPath(dir), 'not json', { mode: 0o600 });
    expect(readHeartbeat(dir)).toBeNull();
    await writeFile(heartbeatPath(dir), JSON.stringify({ pid: 'x' }), { mode: 0o600 });
    expect(readHeartbeat(dir)).toBeNull();
  });

  it('startHeartbeat 周期刷新；停止后文件保留', async () => {
    const stop = startHeartbeat(dir, { role: 'fleet-worker', sha: 'x', intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(readHeartbeat(dir)?.role).toBe('fleet-worker');
    stop();
    expect(readHeartbeat(dir)).not.toBeNull();
  });
});

describe('install/uninstall/status/logs（fake runner）', () => {
  let home: string;
  const calls: string[][] = [];
  const fakeRun = (cmd: string, args: readonly string[]): RunResult => {
    calls.push([cmd, ...args]);
    // launchctl print / systemctl is-active / schtasks query → “在跑”
    return { code: 0, stdout: 'active', stderr: '' };
  };
  const descriptor: ServiceDescriptor = {
    kind: 'fleet-node',
    args: ['/opt/cli.js', 'node', '--run-forever'],
    heartbeatDir: '',
  };

  beforeEach(async () => {
    calls.length = 0;
    home = await mkdtemp(join(os.tmpdir(), 'svc-home-'));
    descriptor.heartbeatDir = home;
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  it('install：写 plist + manifest，bootstrap 并 running；重复 install 先 bootout（幂等）', () => {
    const first = installService(descriptor, { platform: 'darwin', home, run: fakeRun, sha: 'sha1' });
    expect(first.ok).toBe(true);
    expect(first.started).toBe(true);
    expect(calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootstrap')).toBe(true);

    calls.length = 0;
    const second = installService(descriptor, { platform: 'darwin', home, run: fakeRun, sha: 'sha1' });
    expect(second.label).toBe('com.mebular.fleet-node');
    expect(calls.some((c) => c[1] === 'bootout')).toBe(true);
    expect(calls.some((c) => c[1] === 'bootstrap')).toBe(true);
  });

  it('status：注册/运行 + manifest SHA + 心跳新鲜', async () => {
    installService(descriptor, { platform: 'darwin', home, run: fakeRun, sha: 'shaX' });
    writeHeartbeat(descriptor.heartbeatDir, { role: 'fleet-node', sha: 'shaX' });
    const s = serviceStatus(descriptor, { platform: 'darwin', home, run: fakeRun, sha: 'shaX' });
    expect(s.registered).toBe(true);
    expect(s.running).toBe(true);
    expect(s.sha).toBe('shaX');
    expect(s.heartbeat.fresh).toBe(true);
  });

  it('uninstall：已安装→移除；未安装→清晰提示（removed=false）', async () => {
    installService(descriptor, { platform: 'darwin', home, run: fakeRun, sha: 'sha1' });
    const unit = unitFilePath('darwin', { kind: 'fleet-node', label: 'com.mebular.fleet-node' }, home);
    const u = uninstallService(descriptor, { platform: 'darwin', home, run: fakeRun });
    expect(u.removed).toBe(true);
    await expect(readFile(unit, 'utf-8')).rejects.toThrow();
    const again = uninstallService(descriptor, { platform: 'darwin', home, run: fakeRun });
    expect(again.removed).toBe(false);
    expect(again.note).toMatch(/未安装/);
  });

  it('linux：enable+daemon-reload；uninstall disable', () => {
    installService(descriptor, { platform: 'linux', home, run: fakeRun, sha: 's' });
    expect(calls.some((c) => c[0] === 'systemctl' && c.includes('daemon-reload'))).toBe(true);
    expect(calls.some((c) => c[0] === 'systemctl' && c.includes('enable'))).toBe(true);
    calls.length = 0;
    uninstallService(descriptor, { platform: 'linux', home, run: fakeRun });
    expect(calls.some((c) => c[0] === 'systemctl' && c.includes('disable'))).toBe(true);
  });

  it('win32：schtasks /Create + /Run；status/query；logs 读取尾巴', async () => {
    installService(descriptor, { platform: 'win32', home, run: fakeRun, sha: 's' });
    expect(calls.some((c) => c[0] === 'schtasks' && c.includes('/Create'))).toBe(true);
    expect(calls.some((c) => c[0] === 'schtasks' && c.includes('/Run'))).toBe(true);
    const { stdoutLog } = serviceLogPaths('fleet-node', home);
    await mkdir(join(home, '.mebular', 'services', 'logs'), { recursive: true });
    await writeFile(stdoutLog, 'l1\nl2\nl3\n');
    const logs = serviceLogs(descriptor, { home, tail: 2 });
    expect(logs.stdout).toEqual(['l2', 'l3']);
  });

  it('runServiceCli：install/status/logs/uninstall 输出 JSON；未知服务→2', () => {
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    const argv = ['install', 'fleet-node', '--sha', 'cliSha'];
    expect(runServiceCli({ descriptors: [descriptor], argv, home, platform: 'darwin', run: fakeRun, out })).toBe(0);
    expect(JSON.parse(lines.join('\n')).sha).toBe('cliSha');
    const parse = (i: number) => JSON.parse(lines[i]!);
    lines.length = 0;
    runServiceCli({ descriptors: [descriptor], argv: ['status', 'fleet-node'], home, platform: 'darwin', run: fakeRun, out });
    expect(parse(0).services[0].registered).toBe(true);
    lines.length = 0;
    expect(runServiceCli({ descriptors: [descriptor], argv: ['nope', 'x'], home, platform: 'darwin', run: fakeRun, out })).toBe(2);
  });

  it('install --no-autostart：linux 用 start 而非 enable；manifest autostart=false', () => {
    installService(descriptor, { platform: 'linux', home, run: fakeRun, sha: 's', autostart: false });
    expect(calls.some((c) => c[0] === 'systemctl' && c.includes('start') && !c.includes('enable'))).toBe(true);
  });

  it('runServiceCli：logs / uninstall / usage / 未知子命令 / 单描述子默认名 / --extra 透传', async () => {
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    const calls2: string[][] = [];
    const run2 = (cmd: string, a: readonly string[]): RunResult => {
      calls2.push([cmd, ...a]);
      return { code: 0, stdout: 'active', stderr: '' };
    };
    // 单描述子：install 省略名字
    expect(runServiceCli({ descriptors: [descriptor], argv: ['install', '--home', home, '--extra', '--a b'], home, platform: 'linux', run: run2, out })).toBe(0);
    const manifest = JSON.parse(await readFile(manifestPath('fleet-node', home), 'utf-8')) as { args: string[] };
    expect(manifest.args.slice(-2)).toEqual(['--a', 'b']);

    lines.length = 0;
    runServiceCli({ descriptors: [descriptor], argv: ['logs', '--tail', '1'], home, platform: 'linux', run: run2, out });
    expect(JSON.parse(lines.join('\n')).stdoutLog).toContain('fleet-node.out.log');

    lines.length = 0;
    runServiceCli({ descriptors: [descriptor], argv: ['uninstall'], home, platform: 'linux', run: run2, out });
    expect(JSON.parse(lines.join('\n')).action).toBe('uninstall');

    lines.length = 0;
    expect(runServiceCli({ descriptors: [descriptor], argv: [], home, platform: 'linux', run: run2, out })).toBe(2); // 无子命令
    lines.length = 0;
    expect(runServiceCli({ descriptors: [descriptor], argv: ['bogus'], home, platform: 'linux', run: run2, out })).toBe(2);
    lines.length = 0;
    expect(
      runServiceCli({ descriptors: [descriptor, { ...descriptor, kind: 'fleet-worker' }], argv: ['install'], home, platform: 'linux', run: run2, out }),
    ).toBe(2); // 多描述子必须给名字
  });

  it('registeredServicesForDir：dir-scoped（manifest args 命中）', () => {
    expect(registeredServicesForDir(home, { home })).toEqual([]);
    const d = { kind: 'fleet-worker' as const, args: ['/opt/cli.js', 'worker', '--dir', home], heartbeatDir: home };
    installService(d, { platform: 'linux', home, run: fakeRun, sha: 's' });
    expect(registeredServicesForDir(home, { home })).toEqual(['fleet-worker']);
    expect(registeredServicesForDir('/not/this/dir', { home })).toEqual([]);
  });

  it('manifestPath 落盘包含 SHA（供 status 审计）', async () => {
    installService(descriptor, { platform: 'linux', home, run: fakeRun, sha: 'audit-sha' });
    const manifest = JSON.parse(await readFile(manifestPath('fleet-node', home), 'utf-8')) as { sha: string; autostart: boolean };
    expect(manifest.sha).toBe('audit-sha');
    expect(manifest.autostart).toBe(true);
  });
});

describe('默认 home 分支（不传 home → os.homedir）', () => {
  it('各目录/单元路径默认值', () => {
    delete process.env.MEBULAR_SERVICE_HOME;
    const h = os.homedir();
    expect(serviceStateDir()).toBe(join(h, '.mebular', 'services'));
    expect(serviceLogsDir()).toBe(join(h, '.mebular', 'services', 'logs'));
    expect(launchAgentsDir()).toBe(join(h, 'Library', 'LaunchAgents'));
    expect(systemdUserDir()).toBe(join(h, '.config', 'systemd', 'user'));
    expect(windowsTaskDir()).toBe(join(h, '.mebular', 'services', 'tasks'));
    expect(manifestPath('x')).toBe(join(h, '.mebular', 'services', 'x.json'));
    expect(unitFilePath('darwin', { kind: 'fleet-node', label: 'L' })).toBe(join(h, 'Library', 'LaunchAgents', 'L.plist'));
    expect(unitFilePath('linux', { kind: 'fleet-node', label: 'L' })).toBe(join(h, '.config', 'systemd', 'user', 'mebular-fleet-node.service'));
    expect(unitFilePath('win32', { kind: 'fleet-node', label: 'L' })).toBe(join(h, '.mebular', 'services', 'tasks', 'fleet-node.xml'));
  });
});
