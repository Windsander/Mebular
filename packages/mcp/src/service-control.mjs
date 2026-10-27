// H-1 · 「常驻运行」服务托管（动作式）：状态 / 安装 / 卸载 / 重启计划
//
// 复用 `@mebular/service`（不重造单元生成/生命周期）。硬性要求：
//   **服务命令必须带守护自身 home**（`MEBULAR_HOME=<home>` + workingDir=<home> + heartbeatDir=<home>），
//   禁止用 cwd —— 否则守护起来后读错 home（历史 F-ONB 的坑）。
//
// 两套 home 必须分开（H-1 假阴性根因）：
//   - 实例 home（`home`）：Mebular 身份，写 descriptor 的 `MEBULAR_HOME`/workingDir/heartbeatDir；
//   - 服务 home（`serviceHome`）：**用户 OS home**，决定 unit/manifest/日志落盘位置。
// 旧实现把实例 home 同时当服务 home，控制台于是去 `~/.mebular/Library/LaunchAgents` 找 unit，
// 而 CLI 服务实际装在 `~/Library/LaunchAgents` → 「临时运行」假阴性，install 也会写错位置。
//
// 可注入：`run`（命令执行器）与 `now`/`platform` 透传，CI 用替身断言命令序列与状态机（不真装服务）。

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  installService,
  uninstallService,
  serviceStatus,
  restartPlanFor,
} from '../../service/dist/index.js';

export const SERVICE_KIND = 'mebular-serve';

/**
 * 服务单元/manifest 的落盘 home：默认**用户 OS home**（与实例 home 无关）。
 * `MEBULAR_SERVICE_UNIT_HOME` 只用于测试/隔离，生产不设置。
 */
export function resolveServiceHome(serviceHome) {
  return serviceHome ?? process.env.MEBULAR_SERVICE_UNIT_HOME ?? homedir();
}

/** 本 CLI 入口（`mebular serve` 的服务命令指回它）。 */
export function cliBinPath() {
  // packages/mcp/src/service-control.mjs → packages/mcp/bin/mebular.mjs
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mebular.mjs');
}

/** 守护服务描述符：**必须**携带守护自身 home（env + workingDir + heartbeatDir）。 */
export function serviceDescriptor({ home, execPath = process.execPath, extraArgs = [], cloudRoot = null } = {}) {
  const cliPath = cliBinPath();
  return {
    kind: SERVICE_KIND,
    args: [cliPath, 'serve', ...extraArgs],
    heartbeatDir: home,
    workingDir: home,
    execPath,
    env: {
      MEBULAR_HOME: home,
      ...(typeof cloudRoot === 'string' && cloudRoot.length > 0 ? { MEBULAR_CLOUD_ROOT: cloudRoot } : {}),
      MEBULAR_RUNTIME_PROVIDER: 'cli',
      MEBULAR_RUNTIME_OWNER: 'cli',
      MEBULAR_RUNTIME_PATH: cliPath,
      ELECTRON_RUN_AS_NODE: '1',
    },
    runtime: {
      version: null,
      runtimePath: null,
      cliPath,
      provider: 'cli',
      owner: 'cli',
      execPath,
      electron: Boolean(process.versions.electron),
      cloudRoot: typeof cloudRoot === 'string' && cloudRoot.length > 0 ? cloudRoot : null,
      home,
    },
  };
}

/** 读取该实例的常驻状态（unit/manifest 落在 serviceHome；心跳来自实例 home）。 */
export function serviceStatusForHome({ home, serviceHome, platform, run, now } = {}) {
  const opts = {
    home: resolveServiceHome(serviceHome),
    ...(platform ? { platform } : {}),
    ...(run ? { run } : {}),
    ...(now ? { now } : {}),
  };
  return serviceStatus(serviceDescriptor({ home }), opts);
}

/**
 * 该实例是否已登记常驻（用于「一键安装」入口的初值）。
 * descriptor 的实例身份在 `env.MEBULAR_HOME` 而非 args，`registeredServicesForDir` 无法据此匹配；
 * 故以 serviceStatus 的 unitPath/manifest 判定（两者都在 serviceHome 下）。
 */
export function registeredForHome({ home, serviceHome, platform, run, now } = {}) {
  const status = serviceStatusForHome({ home, serviceHome, platform, run, now });
  return status.registered ? [status.kind] : [];
}

/** 安装常驻：服务命令带守护自身 home；unit/manifest 落 serviceHome。 */
export function installServiceForHome({ home, serviceHome, autostart = true, platform, run, now, label } = {}) {
  const opts = {
    home: resolveServiceHome(serviceHome),
    autostart,
    ...(platform ? { platform } : {}),
    ...(run ? { run } : {}),
    ...(now ? { now } : {}),
    ...(label ? { label } : {}),
  };
  return installService(serviceDescriptor({ home }), opts);
}

/** 卸载常驻（按 serviceHome 定位本实例的 unit/manifest）。 */
export function uninstallServiceForHome({ home, serviceHome, platform, run, now } = {}) {
  const opts = {
    home: resolveServiceHome(serviceHome),
    ...(platform ? { platform } : {}),
    ...(run ? { run } : {}),
    ...(now ? { now } : {}),
  };
  return uninstallService(serviceDescriptor({ home }), opts);
}

/** 重启计划（复用 @mebular/service 的平台计划；执行由既有 apply 通道负责）。 */
export function restartPlanForHome({ home, serviceHome, platform, run, now } = {}) {
  const opts = {
    home: resolveServiceHome(serviceHome),
    ...(platform ? { platform } : {}),
    ...(run ? { run } : {}),
    ...(now ? { now } : {}),
  };
  return restartPlanFor(serviceDescriptor({ home }), opts);
}
