// 平台服务单元生成（**纯函数**）：输入 spec，输出单元文本。无 IO、无时钟、无平台副作用，
// 因此可对三种平台做 golden 测试，也可被 macOS/Linux/Windows 之外的环境安全调用。
//
// 角色命名（D2）：fleet-node（任务板/发起端）· fleet-worker（执行端）· mebular-serve（记忆/同步/MCP 底座）。

export type ServicePlatform = 'darwin' | 'linux' | 'win32';

/** 三个常驻组件（服务单元名 = 角色名）。 */
export type ServiceKind = 'fleet-node' | 'fleet-worker' | 'mebular-serve';

export const SERVICE_KINDS: readonly ServiceKind[] = ['fleet-node', 'fleet-worker', 'mebular-serve'];

/** 默认服务名前缀（标签/任务名由它派生；测试可用 labelPrefix 覆盖）。 */
export const DEFAULT_LABEL_PREFIX = 'com.mebular';

export interface UnitSpec {
  kind: ServiceKind;
  /** launchd Label / systemd 单元名 / Windows 任务名（派生后的完整名） */
  label: string;
  /** 解释器（通常 process.execPath） */
  execPath: string;
  /** 解释器参数（通常 [cli.js, 'node'|'worker', ...]） */
  args: readonly string[];
  workingDir?: string;
  env?: Readonly<Record<string, string>>;
  /** 服务日志（stdout/stderr）绝对路径 */
  stdoutLog: string;
  stderrLog: string;
  /** 当前构建 SHA（钉死版本，供 `service status` 输出） */
  sha: string;
  /** 是否登录/开机自启（false = 仅安装、不自启） */
  autostart: boolean;
  /** 崩溃自拉节流（秒），默认 10 */
  throttleSeconds?: number;
}

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** systemd ExecStart / Environment 的引号规则：含空白或特殊字符时用双引号包裹并转义。 */
export function systemdQuote(value: string): string {
  if (value.length > 0 && !/[\s"'\\$]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 单元内的审计注释（`service status` 与人工排查都从这里/state manifest 读 SHA）。 */
export const auditComment = (spec: UnitSpec): string => `mebular-service: kind=${spec.kind} sha=${spec.sha}`;

/** macOS launchd 用户级 LaunchAgent plist。 */
export function launchdPlist(spec: UnitSpec): string {
  const throttle = spec.throttleSeconds ?? 10;
  const envKeys = Object.keys(spec.env ?? {});
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">');
  lines.push('<plist version="1.0">');
  lines.push('<dict>');
  lines.push('  <!-- ' + auditComment(spec) + ' -->');
  lines.push('  <key>Label</key>');
  lines.push(`  <string>${escapeXml(spec.label)}</string>`);
  lines.push('  <key>ProgramArguments</key>');
  lines.push('  <array>');
  lines.push(`    <string>${escapeXml(spec.execPath)}</string>`);
  for (const arg of spec.args) lines.push(`    <string>${escapeXml(arg)}</string>`);
  lines.push('  </array>');
  lines.push('  <key>RunAtLoad</key>');
  lines.push(spec.autostart ? '  <true/>' : '  <false/>');
  lines.push('  <key>KeepAlive</key>');
  lines.push('  <true/>');
  lines.push('  <key>ThrottleInterval</key>');
  lines.push(`  <integer>${throttle}</integer>`);
  lines.push('  <key>StandardOutPath</key>');
  lines.push(`  <string>${escapeXml(spec.stdoutLog)}</string>`);
  lines.push('  <key>StandardErrorPath</key>');
  lines.push(`  <string>${escapeXml(spec.stderrLog)}</string>`);
  if (spec.workingDir !== undefined) {
    lines.push('  <key>WorkingDirectory</key>');
    lines.push(`  <string>${escapeXml(spec.workingDir)}</string>`);
  }
  if (envKeys.length > 0) {
    lines.push('  <key>EnvironmentVariables</key>');
    lines.push('  <dict>');
    for (const key of envKeys) {
      lines.push(`    <key>${escapeXml(key)}</key>`);
      lines.push(`    <string>${escapeXml(spec.env![key]!)}</string>`);
    }
    lines.push('  </dict>');
  }
  lines.push('</dict>');
  lines.push('</plist>');
  return `${lines.join('\n')}\n`;
}

/** Linux systemd --user 单元。 */
export function systemdUnit(spec: UnitSpec): string {
  const throttle = spec.throttleSeconds ?? 10;
  const lines: string[] = [];
  lines.push(`# ${auditComment(spec)}`);
  lines.push('[Unit]');
  lines.push(`Description=Mebular ${spec.kind}`);
  lines.push('After=network.target');
  lines.push('');
  lines.push('[Service]');
  lines.push('Type=simple');
  lines.push(`ExecStart=${[spec.execPath, ...spec.args].map(systemdQuote).join(' ')}`);
  lines.push('Restart=on-failure');
  lines.push(`RestartSec=${throttle}`);
  if (spec.workingDir !== undefined) lines.push(`WorkingDirectory=${systemdQuote(spec.workingDir)}`);
  for (const [key, value] of Object.entries(spec.env ?? {})) lines.push(`Environment=${systemdQuote(`${key}=${value}`)}`);
  lines.push(`StandardOutput=append:${systemdQuote(spec.stdoutLog)}`);
  lines.push(`StandardError=append:${systemdQuote(spec.stderrLog)}`);
  if (spec.autostart) {
    lines.push('');
    lines.push('[Install]');
    lines.push('WantedBy=default.target');
  }
  return `${lines.join('\n')}\n`;
}

/** Windows Task Scheduler 任务 XML（onlogon，无需管理员；InteractiveToken + LeastPrivilege）。 */
export function windowsTaskXml(spec: UnitSpec): string {
  const throttle = spec.throttleSeconds ?? 10;
  const args = [spec.execPath, ...spec.args].map((a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-16"?>');
  lines.push('<!-- ' + auditComment(spec) + ' -->');
  lines.push('<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">');
  lines.push('  <RegistrationInfo>');
  lines.push(`    <Description>Mebular ${spec.kind}</Description>`);
  lines.push('  </RegistrationInfo>');
  lines.push('  <Triggers>');
  if (spec.autostart) {
    lines.push('    <LogonTrigger>');
    lines.push('      <Enabled>true</Enabled>');
    lines.push('    </LogonTrigger>');
  }
  lines.push('  </Triggers>');
  lines.push('  <Principals>');
  lines.push('    <Principal id="Author">');
  lines.push('      <LogonType>InteractiveToken</LogonType>');
  lines.push('      <RunLevel>LeastPrivilege</RunLevel>');
  lines.push('    </Principal>');
  lines.push('  </Principals>');
  lines.push('  <Settings>');
  lines.push('    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  lines.push('    <AllowHardTerminate>true</AllowHardTerminate>');
  lines.push('    <StartWhenAvailable>true</StartWhenAvailable>');
  lines.push('    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>');
  lines.push('    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  lines.push('    <RestartOnFailure>');
  lines.push('      <Interval>PT' + throttle + 'S</Interval>');
  lines.push('      <Count>3</Count>');
  lines.push('    </RestartOnFailure>');
  lines.push('  </Settings>');
  lines.push('  <Actions Context="Author">');
  lines.push('    <Exec>');
  lines.push(`      <Command>${escapeXml(spec.execPath)}</Command>`);
  lines.push(`      <Arguments>${escapeXml(args.slice(spec.execPath.length + 1))}</Arguments>`);
  if (spec.workingDir !== undefined) lines.push(`      <WorkingDirectory>${escapeXml(spec.workingDir)}</WorkingDirectory>`);
  lines.push('    </Exec>');
  lines.push('  </Actions>');
  lines.push('</Task>');
  return `${lines.join('\n')}\n`;
}

/** 按平台生成单元文本。 */
export function unitText(platform: ServicePlatform, spec: UnitSpec): string {
  switch (platform) {
    case 'darwin':
      return launchdPlist(spec);
    case 'linux':
      return systemdUnit(spec);
    case 'win32':
      return windowsTaskXml(spec);
    default: {
      const never: never = platform;
      throw new Error(`unsupported platform: ${String(never)}`);
    }
  }
}

/** 默认标签/单元名（kind → com.mebular.<kind>）。 */
export function defaultLabel(kind: ServiceKind, labelPrefix = DEFAULT_LABEL_PREFIX): string {
  return `${labelPrefix}.${kind}`;
}

/** systemd 单元文件名（`mebular-<kind>.service`）。 */
export function systemdUnitFileName(kind: ServiceKind): string {
  return `mebular-${kind}.service`;
}
