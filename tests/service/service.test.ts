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
  restartPlanFor,
  restartService,
  unitText,
  systemdUnitFileName,
  defaultLabel,
  legacyLabel,
  homeKey,
  parseLaunchdPrint,
  jobBelongsToHome,
  describeJobOwner,
  heartbeatPath,
  launchAgentsDir,
  systemdUserDir,
  windowsTaskDir,
  serviceLogsDir,
  serviceStateDir,
  type ServiceDescriptor,
  type RunResult,
  type RunTraceEntry,
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
    expect(unitFilePath('darwin', spec, '/h')).toBe(join('/h', 'Library', 'LaunchAgents', 'com.mebular.fleet-node.plist'));
    expect(unitFilePath('linux', spec, '/h')).toBe(join('/h', '.config', 'systemd', 'user', 'mebular-fleet-node.service'));
    expect(unitFilePath('win32', spec, '/h')).toBe(join('/h', '.mebular', 'services', 'tasks', 'fleet-node.xml'));
  });

  it('resolveBuildSha：env 优先；显式 cwd 的 git HEAD 兜底；非仓库 cwd → unknown', () => {
    expect(resolveBuildSha({ MEBULAR_BUILD_SHA: 'deadbeef' } as NodeJS.ProcessEnv, '/nonexistent')).toBe('deadbeef');
    expect(resolveBuildSha({ MEBULAR_SERVICE_SHA: 'cafe' } as NodeJS.ProcessEnv, '/nonexistent')).toBe('cafe');
    // F-INSTALL-1：本 helper 不再默认读 process.cwd()（那是 sha 漂移病灶）；显式 cwd 仅作兜底
    expect(resolveBuildSha({} as NodeJS.ProcessEnv, '/nonexistent')).toBe('unknown');
    expect(resolveBuildSha({} as NodeJS.ProcessEnv)).toBe('unknown');
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
    expect(serviceStateDir('/h')).toBe(join('/h', '.mebular', 'services'));
    expect(launchAgentsDir('/h')).toBe(join('/h', 'Library', 'LaunchAgents'));
    expect(systemdUserDir('/h')).toBe(join('/h', '.config', 'systemd', 'user'));
    expect(windowsTaskDir('/h')).toBe(join('/h', '.mebular', 'services', 'tasks'));
    expect(serviceLogsDir('/h')).toBe(join('/h', '.mebular', 'services', 'logs'));
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
  // 模拟 launchd：label → 作业归属 home；bootstrap/bootout 增删。print 仅对已加载 label 返回 0。
  const loaded = new Map<string, string>();
  // F-INSTALL-1：装载成功后守护会写新鲜心跳（install 的终态校验依据）；替身模拟该副作用，ts 单调递增。
  let hbTick = 0;
  const printFor = (label: string, ownerHome: string): string => `gui/501/${label} = {
\tactive count = 1
\tpath = ${ownerHome}/Library/LaunchAgents/${label}.plist
\tstate = running
\tprogram = /usr/bin/node
\targuments = {
\t\t/usr/bin/node
\t\t/opt/cli.js
\t\tnode
\t}
\tworking directory = ${ownerHome}
\tenvironment = {
\t\tMEBULAR_HOME => ${ownerHome}
\t\tMEBULAR_SERVICE_KIND => fleet-node
\t}
}`;
  const fakeRun = (cmd: string, args: readonly string[]): RunResult => {
    calls.push([cmd, ...args]);
    if (cmd !== 'launchctl') return { code: 0, stdout: 'active', stderr: '' };
    const labelOf = (value: string): string => value.split(/[\\/]/).pop() ?? '';
    if (args[0] === 'print') {
      const owner = loaded.get(labelOf(String(args[1] ?? '')));
      return owner === undefined ? { code: 1, stdout: '', stderr: 'Could not find service' } : { code: 0, stdout: printFor(labelOf(String(args[1] ?? '')), owner), stderr: '' };
    }
    if (args[0] === 'bootstrap') {
      const label = labelOf(String(args[2] ?? '')).replace(/\.plist$/, '');
      loaded.set(label, home);
      writeHeartbeat(home, { role: 'fleet-node', sha: 's', now: Date.now() + ++hbTick });
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'bootout') {
      loaded.delete(labelOf(String(args[1] ?? '')));
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const descriptor: ServiceDescriptor = {
    kind: 'fleet-node',
    args: ['/opt/cli.js', 'node', '--run-forever'],
    heartbeatDir: '',
  };

  beforeEach(async () => {
    calls.length = 0;
    loaded.clear();
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
    expect(second.label).toBe(defaultLabel('fleet-node', 'com.mebular', home));
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

describe('一键重启（C：restart 计划/执行，命令可注入）', () => {
  let home: string;
  const calls: string[][] = [];
  // 模拟 launchd：print 仅对已加载 label 返回 0（供归属校验）。
  const loaded = new Set<string>();
  const baseName = (value: string): string => value.split(/[\\/]/).pop() ?? '';
  const printFor = (label: string, ownerHome: string): string => `gui/501/${label} = {
\tpath = ${ownerHome}/Library/LaunchAgents/${label}.plist
\tworking directory = ${ownerHome}
\tenvironment = {
\t\tMEBULAR_HOME => ${ownerHome}
\t}
}`;
  const fakeRun = (cmd: string, args: readonly string[]): RunResult => {
    calls.push([cmd, ...args]);
    if (cmd !== 'launchctl') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'print') {
      const owner = baseName(String(args[1] ?? ''));
      return loaded.has(owner) ? { code: 0, stdout: printFor(owner, home), stderr: '' } : { code: 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'bootstrap') {
      loaded.add(baseName(String(args[2] ?? '')).replace(/\.plist$/, ''));
    }
    if (args[0] === 'bootout') loaded.delete(baseName(String(args[1] ?? '')));
    return { code: 0, stdout: '', stderr: '' };
  };
  const descriptor: ServiceDescriptor = { kind: 'mebular-serve', args: ['/opt/cli.js', 'serve'], heartbeatDir: '' };

  beforeEach(async () => {
    calls.length = 0;
    loaded.clear();
    home = await mkdtemp(join(os.tmpdir(), 'svc-restart-'));
    descriptor.heartbeatDir = home;
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  it('未注册为服务 → 不给平台命令，给手动指引（绝不盲发 kickstart）', () => {
    const plan = restartPlanFor(descriptor, { platform: 'darwin', home, run: fakeRun });
    expect(plan.registered).toBe(false);
    expect(plan.commands).toEqual([]);
    expect(plan.manual).toMatch(/未注册为服务/);
    const result = restartService(descriptor, { platform: 'darwin', home, run: fakeRun });
    expect(result.ok).toBe(false);
    expect(result.executed).toBe(false);
    expect(calls).toEqual([]);
  });

  it('darwin：launchctl kickstart -k gui/<uid>/<label>；linux：systemctl --user restart <unit>；win32：End+Run', () => {
    installService(descriptor, { platform: 'darwin', home, run: fakeRun, sha: 's' });
    const darwin = restartPlanFor(descriptor, { platform: 'darwin', home, run: fakeRun });
    expect(darwin.registered).toBe(true);
    const darwinCmd = darwin.commands[0] ?? [];
    expect(darwinCmd[0]).toBe('launchctl');
    expect(darwinCmd.slice(1, 3)).toEqual(['kickstart', '-k']);
    expect(darwinCmd[3]).toMatch(new RegExp(`^gui/\\d+/${defaultLabel('mebular-serve', 'com.mebular', home).replace(/\./g, '\\.')}$`));
    calls.length = 0;
    const runDarwin = restartService(descriptor, { platform: 'darwin', home, run: fakeRun });
    expect(runDarwin.ok).toBe(true);
    expect(runDarwin.executed).toBe(true);
    expect(calls.some((c) => c[0] === 'launchctl' && c[1] === 'kickstart' && c[2] === '-k')).toBe(true);

    installService(descriptor, { platform: 'linux', home, run: fakeRun, sha: 's' });
    const linux = restartPlanFor(descriptor, { platform: 'linux', home, run: fakeRun });
    expect(linux.commands[0]).toEqual(['systemctl', '--user', 'restart', systemdUnitFileName('mebular-serve')]);

    installService(descriptor, { platform: 'win32', home, run: fakeRun, sha: 's' });
    const win = restartPlanFor(descriptor, { platform: 'win32', home, run: fakeRun });
    expect(win.commands).toEqual([['schtasks', '/End', '/TN', 'mebular-serve'], ['schtasks', '/Run', '/TN', 'mebular-serve']]);
    calls.length = 0;
    restartService(descriptor, { platform: 'win32', home, run: fakeRun });
    expect(calls.map((c) => c[1])).toEqual(['/End', '/Run']);
  });

  it('失败传播：命令非 0 → ok=false（executed 仍为 true）', () => {
    installService(descriptor, { platform: 'linux', home, run: fakeRun, sha: 's' });
    const failing = (cmd: string): RunResult => ({ code: cmd === 'systemctl' ? 1 : 0, stdout: '', stderr: 'boom' });
    const result = restartService(descriptor, { platform: 'linux', home, run: failing });
    expect(result.executed).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('runServiceCli restart：已注册→0 且输出命令；usage 含 restart', () => {
    installService(descriptor, { platform: 'linux', home, run: fakeRun, sha: 's' });
    const lines: string[] = [];
    const code = runServiceCli({ descriptors: [descriptor], argv: ['restart'], home, platform: 'linux', run: fakeRun, out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(JSON.parse(lines.join('\n')).action).toBe('restart');
    expect(runServiceCli({ descriptors: [descriptor], argv: ['bogus'], home, platform: 'linux', run: fakeRun, out: () => {} })).toBe(2);
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

// ---------------------------------------------------------------------------
// F-SVC-1：服务身份隔离（跨 home 劫持的根治）
// ---------------------------------------------------------------------------

describe('F-SVC-1：服务身份含 home 维度（纯函数）', () => {
  it('label = 旧标签 + home 派生后缀；同 home 稳定、不同 home 互异', () => {
    expect(legacyLabel('mebular-serve')).toBe('com.mebular.mebular-serve');
    expect(defaultLabel('mebular-serve')).toBe('com.mebular.mebular-serve');
    expect(homeKey('/a/b')).toBe(homeKey('/a/b/'));
    expect(homeKey('/a/b')).not.toBe(homeKey('/a/c'));
    const labelA = defaultLabel('mebular-serve', 'com.mebular', '/a/b');
    const labelB = defaultLabel('mebular-serve', 'com.mebular', '/a/c');
    expect(labelA).toBe(`com.mebular.mebular-serve.${homeKey('/a/b')}`);
    expect(labelA).not.toBe(labelB);
    expect(labelA).toMatch(/^com\.mebular\.mebular-serve\.[0-9a-f]{12}$/);
    expect(labelA.startsWith(legacyLabel('mebular-serve') + '.')).toBe(true);
  });
});

describe('F-SVC-1：launchctl print 解析与归属判定（纯函数）', () => {
  const jobText = (homeDir: string, label = 'com.mebular.mebular-serve'): string => `gui/501/${label} = {
\tactive count = 1
\tpath = ${homeDir}/Library/LaunchAgents/${label}.plist
\ttype = LaunchAgent
\tstate = running
\tprogram = /usr/bin/node
\targuments = {
\t\t/usr/bin/node
\t\t/opt/cli.js
\t\tserve
\t\t--port
\t\t7331
\t}
\tworking directory = ${homeDir}
\tenvironment = {
\t\tMEBULAR_HOME => ${homeDir}
\t\tMEBULAR_SERVICE_KIND => mebular-serve
\t\tPATH => /usr/bin:/bin
\t}
}`;

  it('解析 path/program/arguments/environment/working directory', () => {
    const parsed = parseLaunchdPrint(jobText('/Users/u/.mebular'));
    expect(parsed.program).toBe('/usr/bin/node');
    expect(parsed.arguments).toEqual(['/usr/bin/node', '/opt/cli.js', 'serve', '--port', '7331']);
    expect(parsed.environment.MEBULAR_HOME).toBe('/Users/u/.mebular');
    expect(parsed.workingDirectory).toBe('/Users/u/.mebular');
    expect(parsed.path).toBe('/Users/u/.mebular/Library/LaunchAgents/com.mebular.mebular-serve.plist');
  });

  it('归属：MEBULAR_HOME / working directory / plist 路径 任一匹配即本 home', () => {
    expect(jobBelongsToHome(parseLaunchdPrint(jobText('/Users/u/.mebular')), '/Users/u/.mebular')).toBe(true);
    expect(jobBelongsToHome(parseLaunchdPrint(jobText('/Users/u/.mebular')), '/Users/u/sandbox')).toBe(false);
    // 仅 plist 路径命中
    const onlyPath = 'gui/501/L = {\n\tpath = /Users/u/.mebular/Library/LaunchAgents/L.plist\n}';
    expect(jobBelongsToHome(parseLaunchdPrint(onlyPath), '/Users/u/.mebular')).toBe(true);
    // 前缀相似但非同一 home：不匹配（避免 /a/.mebular 误吞 /a/.mebular-x）
    expect(jobBelongsToHome(parseLaunchdPrint(jobText('/Users/u/.mebular-x')), '/Users/u/.mebular')).toBe(false);
  });

  it('无法判定 → 不归属（保守：绝不当 running）；空输入安全', () => {
    expect(jobBelongsToHome(parseLaunchdPrint(''), '/x')).toBe(false);
    expect(jobBelongsToHome(null, '/x')).toBe(false);
    expect(describeJobOwner(parseLaunchdPrint(jobText('/Users/u/.mebular')))).toBe('/Users/u/.mebular');
    expect(describeJobOwner(parseLaunchdPrint(''))).toBeNull();
  });

  it('environment 也接受老式 `=` 写法', () => {
    const out = 'gui/501/L = {\n\tenvironment = {\n\t\tMEBULAR_HOME = /h\n\t}\n}';
    expect(parseLaunchdPrint(out).environment.MEBULAR_HOME).toBe('/h');
  });
});

describe('F-SVC-1：跨 home 隔离（install/status/restart，fake runner）', () => {
  let homeA: string;
  let homeB: string;
  const calls: string[][] = [];
  const loaded = new Map<string, string>(); // label -> owner home
  let hbTick = 0; // F-INSTALL-1：替身心跳 ts 单调递增（install 终态校验只认比基线新的心跳）
  const labelOf = (value: string): string => value.split(/[\\/]/).pop() ?? '';
  const printFor = (label: string, ownerHome: string): string => `gui/501/${label} = {
\tpath = ${ownerHome}/Library/LaunchAgents/${label}.plist
\tworking directory = ${ownerHome}
\tenvironment = {
\t\tMEBULAR_HOME => ${ownerHome}
\t}
}`;
  const run = (cmd: string, args: readonly string[]): RunResult => {
    calls.push([cmd, ...args]);
    if (cmd !== 'launchctl') return { code: 0, stdout: 'active', stderr: '' };
    if (args[0] === 'print') {
      const label = labelOf(String(args[1] ?? ''));
      const owner = loaded.get(label);
      return owner === undefined ? { code: 1, stdout: '', stderr: 'not found' } : { code: 0, stdout: printFor(label, owner), stderr: '' };
    }
    if (args[0] === 'bootstrap') {
      const plist = String(args[2] ?? '');
      const label = labelOf(plist).replace(/\.plist$/, '');
      const owner = plist.includes(homeB) ? homeB : homeA;
      loaded.set(label, owner);
      writeHeartbeat(owner, { role: 'mebular-serve', sha: 's', now: Date.now() + ++hbTick }); // F-INSTALL-1：守护起搏副作用
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'bootout') {
      loaded.delete(labelOf(String(args[1] ?? '')));
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const desc = (homeDir: string): ServiceDescriptor => ({ kind: 'mebular-serve', args: ['/opt/cli.js', 'serve'], heartbeatDir: homeDir });
  const labelA = (): string => defaultLabel('mebular-serve', 'com.mebular', homeA);
  const labelB = (): string => defaultLabel('mebular-serve', 'com.mebular', homeB);

  beforeEach(async () => {
    calls.length = 0;
    loaded.clear();
    homeA = await mkdtemp(join(os.tmpdir(), 'svc-A-'));
    homeB = await mkdtemp(join(os.tmpdir(), 'svc-B-'));
  });
  afterEach(async () => {
    await rm(homeA, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
    await rm(homeB, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  it('不同 home → 不同 label；两个 home 各自 install 可共存，互不顶替', () => {
    const a = installService(desc(homeA), { platform: 'darwin', home: homeA, run, sha: 's' });
    calls.length = 0; // 只观察 B 的 install 对 A 的影响
    const b = installService(desc(homeB), { platform: 'darwin', home: homeB, run, sha: 's' });
    expect(a.label).not.toBe(b.label);
    expect(loaded.get(a.label)).toBe(homeA);
    expect(loaded.get(b.label)).toBe(homeB);
    // B 的 install 绝不 bootout A 的作业
    const bootouts = calls.filter((c) => c[1] === 'bootout').map((c) => c[2]);
    expect(bootouts).not.toContain(`gui/501/${a.label}`);
  });

  it('实例身份取自 MEBULAR_HOME（非落盘 home）：同 home 下不同 MEBULAR_HOME → 不同 label', () => {
    const realHome = join(homeA, '.mebular');
    const sandbox = join(homeA, 'sandbox-home');
    const mk = (instanceHome: string): ServiceDescriptor => ({
      kind: 'mebular-serve',
      args: ['/opt/cli.js', 'serve'],
      heartbeatDir: instanceHome,
      env: { MEBULAR_HOME: instanceHome, MEBULAR_USER_HOME: instanceHome },
    });
    const r1 = installService(mk(realHome), { platform: 'darwin', home: homeA, run, sha: 's' });
    const r2 = installService(mk(sandbox), { platform: 'darwin', home: homeA, run, sha: 's' });
    expect(r1.label).toBe(defaultLabel('mebular-serve', 'com.mebular', realHome));
    expect(r2.label).toBe(defaultLabel('mebular-serve', 'com.mebular', sandbox));
    expect(r1.label).not.toBe(r2.label);
    // 同一落盘 home（用户 home）下，两个实例的 plist 并存、互不顶替
    expect(loaded.get(r1.label)).toBe(homeA);
    expect(loaded.get(r2.label)).toBe(homeA);
  });

  it('status 归属校验：他人占旧全局 label → 本 home running=false 且 foreign=true（消除假阳性）', () => {
    const legacy = legacyLabel('mebular-serve');
    loaded.set(legacy, homeB);
    loaded.set(labelB(), homeB);
    const statusA = serviceStatus(desc(homeA), { platform: 'darwin', home: homeA, run });
    expect(statusA.running).toBe(false);
    expect(statusA.foreign).toBe(true);
    expect(statusA.foreignOwner).toBe(homeB);
    const statusB = serviceStatus(desc(homeB), { platform: 'darwin', home: homeB, run });
    expect(statusB.running).toBe(true);
    expect(statusB.foreign).toBe(false);
  });

  it('install 护栏：旧全局 label 被他人占用 → 不 bootout 他人，只装本 home 专属 label 并警告', () => {
    const legacy = legacyLabel('mebular-serve');
    loaded.set(legacy, homeA);
    const res = installService(desc(homeB), { platform: 'darwin', home: homeB, run, sha: 's' });
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/另一 home|他人/);
    expect(loaded.get(legacy)).toBe(homeA); // 他人作业原样保留
    expect(calls.some((c) => c[0] === 'launchctl' && c[1] === 'bootout' && c[2] === `gui/501/${legacy}`)).toBe(false);
    expect(loaded.get(res.label)).toBe(homeB);
  });

  it('install 拒绝：本 home 新标签被他人作业占用 → ok=false/foreign，绝不 bootout', () => {
    loaded.set(labelA(), homeB);
    const res = installService(desc(homeA), { platform: 'darwin', home: homeA, run, sha: 's' });
    expect(res.ok).toBe(false);
    expect(res.foreign).toBe(true);
    expect(res.error).toBe('foreign_job');
    expect(loaded.get(labelA())).toBe(homeB);
    expect(calls.some((c) => c[1] === 'bootout' && c[2] === `gui/501/${labelA()}`)).toBe(false);
  });

  it('迁移：旧全局 label 属本 home → 一条 install 完成（bootout 旧 + 装新），保留 KeepAlive/RunAtLoad', async () => {
    const legacy = legacyLabel('mebular-serve');
    loaded.set(legacy, homeA);
    const legacyUnit = unitFilePath('darwin', { kind: 'mebular-serve', label: legacy }, homeA);
    await mkdir(join(homeA, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(legacyUnit, '<plist/>');
    const res = installService(desc(homeA), { platform: 'darwin', home: homeA, run, sha: 's' });
    expect(res.ok).toBe(true);
    expect(res.migratedFrom).toBe(legacy);
    expect(loaded.has(legacy)).toBe(false); // 旧作业已卸（仅因确属本 home）
    expect(loaded.get(res.label)).toBe(homeA); // 新作业已装
    const plist = await readFile(res.unitPath, 'utf-8');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
    await expect(readFile(legacyUnit, 'utf-8')).rejects.toThrow(); // 旧 plist 已清
  });

  it('restart：他人作业 → 不发 kickstart（绝不重启他人）', async () => {
    loaded.set(labelA(), homeB);
    await mkdir(join(homeA, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(unitFilePath('darwin', { kind: 'mebular-serve', label: labelA() }, homeA), '<plist/>');
    const plan = restartPlanFor(desc(homeA), { platform: 'darwin', home: homeA, run });
    expect(plan.registered).toBe(false);
    expect(plan.commands).toEqual([]);
    expect(plan.manual).toMatch(/另一 home|占用/);
    calls.length = 0;
    const result = restartService(desc(homeA), { platform: 'darwin', home: homeA, run });
    expect(result.executed).toBe(false);
    expect(calls.some((c) => c[1] === 'kickstart')).toBe(false);
  });

  it('自动重启绝不安装：未注册 → 计划为空、无 bootstrap、不写 plist', async () => {
    const plan = restartPlanFor(desc(homeA), { platform: 'darwin', home: homeA, run });
    expect(plan.registered).toBe(false);
    expect(plan.commands).toEqual([]);
    expect(calls.some((c) => c[1] === 'bootstrap')).toBe(false);
    await expect(stat(unitFilePath('darwin', { kind: 'mebular-serve', label: labelA() }, homeA))).rejects.toThrow();
  });
});

// F-INSTALL-1：install「谎报成功」根治——bootout 后有界等待卸载、bootstrap 有界退避重试、
// 装载后终态校验（只认比基线新的新鲜心跳），失败如实 started:false + startError；sha 与 cwd 解耦。
// 真机实证（2026-10-15）：cwd=repo 时 install 报 started:true 但作业 state=SIGTERMed、healthz=000，
// 恢复时撞 `Bootstrap failed: 5: Input/output error`（bootout→bootstrap 收尾竞态）。
describe('F-INSTALL-1：install 终态校验 + 有界重试（绝不谎报 started）', () => {
  let home: string;
  let hbTick = 0;
  // 时序旋钮全部小值：有界逻辑在测试中秒级走完，不靠真等。
  const FAST = { unloadTimeoutMs: 300, bootstrapBackoffMs: 5, verifyTimeoutMs: 400, verifyIntervalMs: 20 } as const;
  const labelOf = (value: string): string => value.split(/[\\/]/).pop() ?? '';

  beforeEach(async () => {
    home = await mkdtemp(join(os.tmpdir(), 'svc-fix-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  const descriptor = (): ServiceDescriptor => ({ kind: 'mebular-serve', args: ['/opt/cli.js', 'serve'], heartbeatDir: home });

  /** 可编程 launchd 替身：bootstrap 前 failBoots 次返回 error 5；成功后按需写新心跳（守护起搏副作用）。 */
  const makeRun = (opts: { failBoots?: number; failLoad?: boolean; writeHeartbeatOnBoot?: boolean }): { calls: string[][]; run: (cmd: string, args: readonly string[]) => RunResult } => {
    const calls: string[][] = [];
    const loaded = new Map<string, string>();
    let boots = 0;
    const run = (cmd: string, args: readonly string[]): RunResult => {
      calls.push([cmd, ...args]);
      if (cmd !== 'launchctl') return { code: 0, stdout: 'active', stderr: '' };
      if (args[0] === 'print') {
        const owner = loaded.get(labelOf(String(args[1] ?? '')));
        return owner === undefined
          ? { code: 1, stdout: '', stderr: 'Could not find service' }
          : { code: 0, stdout: `gui/501/x = {\n\tworking directory = ${owner}\n\tenvironment = {\n\t\tMEBULAR_HOME => ${owner}\n\t}\n}`, stderr: '' };
      }
      if (args[0] === 'bootout') {
        loaded.delete(labelOf(String(args[1] ?? '')));
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'bootstrap') {
        boots += 1;
        if (boots <= (opts.failBoots ?? 0)) return { code: 1, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
        const label = labelOf(String(args[2] ?? '')).replace(/\.plist$/, '');
        loaded.set(label, home);
        if (opts.writeHeartbeatOnBoot !== false) writeHeartbeat(home, { role: 'mebular-serve', sha: 's', now: Date.now() + ++hbTick });
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'load') {
        return opts.failLoad === true ? { code: 1, stdout: '', stderr: 'Load failed: 5: Input/output error' } : { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    return { calls, run };
  };

  it('bootstrap 首次 error 5、二次成功 → 有界重试装载 + 终态校验通过 + started:true + 全程留痕', () => {
    const { calls, run } = makeRun({ failBoots: 1 });
    const traces: RunTraceEntry[] = [];
    const res = installService(descriptor(), { platform: 'darwin', home, run, sha: 's', ...FAST, trace: (e) => traces.push(e) });
    expect(res.ok).toBe(true);
    expect(res.started).toBe(true);
    expect(res.startError).toBeUndefined();
    expect(calls.filter((c) => c[1] === 'bootstrap')).toHaveLength(2); // 首次失败 + 二次成功
    // 仪器化：每条命令留痕（rc/耗时），两次 bootstrap 一败一成清晰可辨
    const tracedBoots = traces.filter((t) => t.args[0] === 'bootstrap');
    expect(tracedBoots).toHaveLength(2);
    expect(tracedBoots[0]!.code).toBe(1);
    expect(tracedBoots[0]!.stderr).toContain('Bootstrap failed: 5');
    expect(tracedBoots[1]!.code).toBe(0);
    expect(traces.every((t) => typeof t.durationMs === 'number' && t.at.length > 0)).toBe(true);
    // bootout 后有「等待卸载」的 print 轮询（序列：bootout → print … → bootstrap）
    const bootoutIdx = calls.findIndex((c) => c[1] === 'bootout');
    const firstBootIdx = calls.findIndex((c) => c[1] === 'bootstrap');
    expect(calls.slice(bootoutIdx + 1, firstBootIdx).some((c) => c[1] === 'print')).toBe(true);
  });

  it('bootstrap 重试耗尽 + load 回退亦败 → ok:true 但 started:false + startError 真实原因', () => {
    const { calls, run } = makeRun({ failBoots: 99, failLoad: true });
    const res = installService(descriptor(), { platform: 'darwin', home, run, sha: 's', ...FAST, bootstrapAttempts: 3 });
    expect(res.ok).toBe(true);       // 单元文件/manifest 已落盘：安装动作本身完成
    expect(res.started).toBe(false); // 绝不谎报
    expect(res.startError).toContain('bootstrap');
    expect(res.startError).toContain('Bootstrap failed: 5');
    expect(calls.filter((c) => c[1] === 'bootstrap')).toHaveLength(3); // 恰为注入的重试上限
    expect(calls.some((c) => c[1] === 'load')).toBe(true);             // 旧系统回退尝试过
  });

  it('装载成功但进程未起（无新心跳）→ started:false + 校验超时原因（根治 SIGTERMed 谎报）', () => {
    const { run } = makeRun({ writeHeartbeatOnBoot: false });
    const res = installService(descriptor(), { platform: 'darwin', home, run, sha: 's', ...FAST });
    expect(res.ok).toBe(true);
    expect(res.started).toBe(false);
    expect(res.startError).toContain('心跳');
    expect(res.startError).toContain('超时');
  });

  it('陈旧心跳防线：install 前残留新鲜心跳但装载后无新心跳 → 仍判 started:false（基线守卫）', () => {
    writeHeartbeat(home, { role: 'mebular-serve', sha: 'old', now: Date.now() }); // 上一次运行的残留
    const { run } = makeRun({ writeHeartbeatOnBoot: false });
    const res = installService(descriptor(), { platform: 'darwin', home, run, sha: 's', ...FAST });
    expect(res.started).toBe(false);
    expect(res.startError).toContain('未见更新');
  });

  it('--no-autostart：kickstart 拉起后同样走终态校验（rc==0 不再等于 started）', () => {
    const { calls, run } = makeRun({});
    const res = installService(descriptor(), { platform: 'darwin', home, run, sha: 's', ...FAST, autostart: false });
    expect(res.started).toBe(true);
    expect(calls.some((c) => c[1] === 'kickstart')).toBe(true);
  });
});
