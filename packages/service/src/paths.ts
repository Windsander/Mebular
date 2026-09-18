// 平台路径与单元落盘位置（纯函数；home 可注入，便于测试）。

import os from 'node:os';
import { join } from 'node:path';
import type { ServiceKind, ServicePlatform, UnitSpec } from './units.js';
import { systemdUnitFileName } from './units.js';

/** 状态目录（manifest + 日志）。`MEBULAR_SERVICE_HOME` 可覆盖（测试/隔离环境）。 */
export const serviceStateDir = (home: string = os.homedir()): string =>
  process.env.MEBULAR_SERVICE_HOME ?? join(home, '.mebular', 'services');
export const serviceLogsDir = (home: string = os.homedir()): string => join(serviceStateDir(home), 'logs');
export const launchAgentsDir = (home: string = os.homedir()): string => join(home, 'Library', 'LaunchAgents');
export const systemdUserDir = (home: string = os.homedir()): string => join(home, '.config', 'systemd', 'user');
export const windowsTaskDir = (home: string = os.homedir()): string => join(serviceStateDir(home), 'tasks');

/** 安装清单（记录 SHA/args/role，供 `service status`）。 */
export const manifestPath = (name: string, home: string = os.homedir()): string =>
  join(serviceStateDir(home), `${name}.json`);

/** 单元文件落盘路径。 */
export function unitFilePath(
  platform: ServicePlatform,
  spec: Pick<UnitSpec, 'kind' | 'label'>,
  home: string = os.homedir(),
): string {
  switch (platform) {
    case 'darwin':
      return join(launchAgentsDir(home), `${spec.label}.plist`);
    case 'linux':
      return join(systemdUserDir(home), systemdUnitFileName(spec.kind));
    case 'win32':
      return join(windowsTaskDir(home), `${spec.kind}.xml`);
  }
}

/** 服务 stdout/stderr 日志路径。 */
export const serviceLogPaths = (kind: ServiceKind, home: string = os.homedir()): { stdoutLog: string; stderrLog: string } => {
  const dir = serviceLogsDir(home);
  return { stdoutLog: join(dir, `${kind}.out.log`), stderrLog: join(dir, `${kind}.err.log`) };
};
