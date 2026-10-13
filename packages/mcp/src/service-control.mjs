// H-1 · 「常驻运行」服务托管（动作式）：状态 / 安装 / 卸载 / 重启计划
//
// 复用 `@mebular/service`（不重造单元生成/生命周期）。硬性要求：
//   **服务命令必须带守护自身 home**（`MEBULAR_HOME=<home>` + workingDir=<home> + heartbeatDir=<home>），
//   禁止用 cwd —— 否则守护起来后读错 home（历史 F-ONB 的坑）。
//
// 可注入：`run`（命令执行器）与 `now`/`platform` 透传，CI 用替身断言命令序列与状态机（不真装服务）。

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  installService,
  uninstallService,
  serviceStatus,
  registeredServicesForDir,
  restartPlanFor,
} from '../../service/dist/index.js';

export const SERVICE_KIND = 'mebular-serve';

/** 本 CLI 入口（`mebular serve` 的服务命令指回它）。 */
export function cliBinPath() {
  // packages/mcp/src/service-control.mjs → packages/mcp/bin/mebular.mjs
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mebular.mjs');
}

/** 守护服务描述符：**必须**携带守护自身 home（env + workingDir + heartbeatDir）。 */
export function serviceDescriptor({ home, execPath = process.execPath, extraArgs = [] } = {}) {
  return {
    kind: SERVICE_KIND,
    args: [cliBinPath(), 'serve', ...extraArgs],
    heartbeatDir: home,
    workingDir: home,
    execPath,
    env: { MEBULAR_HOME: home },
  };
}

/** 读取当前 home 的常驻状态（registered / running / autostart / heartbeat）。 */
export function serviceStatusForHome({ home, platform, run, now } = {}) {
  const opts = { home, ...(platform ? { platform } : {}), ...(run ? { run } : {}), ...(now ? { now } : {}) };
  return serviceStatus(serviceDescriptor({ home }), opts);
}

/** 该 home 是否已登记常驻（用于「一键安装」入口的初值）。 */
export function registeredForHome({ home, platform } = {}) {
  return registeredServicesForDir(home, { home, ...(platform ? { platform } : {}) });
}

/** 安装常驻：服务命令带守护自身 home。 */
export function installServiceForHome({ home, autostart = true, platform, run, now, label } = {}) {
  const opts = {
    home,
    autostart,
    ...(platform ? { platform } : {}),
    ...(run ? { run } : {}),
    ...(now ? { now } : {}),
    ...(label ? { label } : {}),
  };
  return installService(serviceDescriptor({ home }), opts);
}

/** 卸载常驻。 */
export function uninstallServiceForHome({ home, platform, run, now } = {}) {
  const opts = { home, ...(platform ? { platform } : {}), ...(run ? { run } : {}), ...(now ? { now } : {}) };
  return uninstallService(serviceDescriptor({ home }), opts);
}

/** 重启计划（复用 @mebular/service 的平台计划；执行由既有 apply 通道负责）。 */
export function restartPlanForHome({ home, platform, run, now } = {}) {
  const opts = { home, ...(platform ? { platform } : {}), ...(run ? { run } : {}), ...(now ? { now } : {}) };
  return restartPlanFor(serviceDescriptor({ home }), opts);
}
