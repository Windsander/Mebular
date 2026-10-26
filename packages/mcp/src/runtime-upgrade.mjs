// 共享 Runtime 受控升级（Phase 5a）：显式 `runtime upgrade --to <version>`。
//
// 复用 4a installer 的下载/校验/备份/原子换入与 provider 注册；本模块只负责：
//   1. 记录升级前 current/provider/service 快照；
//   2. 安装新版本（installer 成功后写 current）；
//   3. 若 mebular-serve 已注册，更新 manifest 并重启（不启动第二个 daemon）；
//   4. 任何后置失败都把 current/provider/service 回滚到升级前，旧 runtime 始终保留。
//
// 入口（App/Plugin）拥有 child 时，只应重启自己的 supervise；本 CLI/共享路径不杀外部
// daemon，也不自动 ensure 新版本。

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { resolveCloudRoot } from './profiles.mjs';
import { installRuntime } from './runtime-installer.mjs';
import { assertRuntimeVersion } from './runtime-layout.mjs';
import {
  clearRuntimeCurrent,
  publicRuntimeCurrent,
  readRuntimeCurrent,
  writeRuntimeCurrent,
} from './runtime-current.mjs';
import { readRuntimeProviders, writeRuntimeProviders } from './runtime-providers.mjs';
import {
  installRuntimeService,
  runtimeServiceStatus,
} from './runtime-service.mjs';

function failure(fields = {}) {
  return {
    ok: false,
    action: 'upgrade',
    command: 'upgrade',
    reason: fields.reason ?? 'upgrade_failed',
    message: fields.message ?? 'runtime 升级失败',
    ...fields,
  };
}

function sourceFromManifestRuntime(runtime, { current = null } = {}) {
  if (!runtime || typeof runtime.cliPath !== 'string' || runtime.cliPath.length === 0) return null;
  return {
    ok: true,
    source: runtime.provider ?? 'shared',
    provider: runtime.provider ?? 'shared',
    owner: runtime.owner ?? runtime.provider ?? 'shared',
    version: runtime.version ?? null,
    runtimePath: runtime.runtimePath ?? null,
    cliPath: runtime.cliPath,
    execPath: runtime.execPath ?? process.execPath,
    electron: runtime.electron === true,
    current,
    currentSource: 'rollback',
    warnings: [],
  };
}

async function snapshotProviders(root) {
  try {
    return (await readRuntimeProviders(root)).registry.providers.map((entry) => ({ ...entry }));
  } catch {
    return null;
  }
}

async function restoreRuntimePointers({
  root,
  previousCurrent,
  previousProviders,
}) {
  const notes = [];
  if (previousProviders !== null) {
    try {
      await writeRuntimeProviders(root, { v: 1, providers: previousProviders });
    } catch {
      notes.push('previous_provider_restore_failed');
    }
  }
  try {
    if (previousCurrent !== null) {
      await writeRuntimeCurrent(root, previousCurrent);
    } else {
      await clearRuntimeCurrent(root);
    }
  } catch {
    notes.push('previous_current_restore_failed');
  }
  return notes;
}

/**
 * 显式升级共享 runtime。
 *
 * 返回稳定 JSON（CLI 直接输出）：`ok/reason/current/previousCurrent/service` 等。
 * `installRuntimeFn` / `serviceStatusFn` / `installServiceFn` 可注入，便于离线测试。
 */
export async function upgradeRuntime(options = {}) {
  const {
    to,
    root: explicitRoot,
    home: explicitHome,
    env = process.env,
    userHome = homedir(),
    installRuntimeFn = installRuntime,
    serviceStatusFn = runtimeServiceStatus,
    installServiceFn = installRuntimeService,
    serviceHome,
    platform = process.platform,
    installOptions = {},
  } = options;

  let target;
  try {
    target = assertRuntimeVersion(to);
  } catch (error) {
    return failure({
      reason: error?.code ?? 'unsupported_version',
      message: error?.message ?? String(error),
      to: typeof to === 'string' ? to : null,
      current: null,
      previousCurrent: null,
      runtimeChanged: false,
      serviceChanged: false,
    });
  }

  let root = explicitRoot;
  if (typeof root !== 'string' || root.length === 0) {
    const cloud = resolveCloudRoot({ env, userHome });
    if (!cloud.available) {
      return failure({
        reason: cloud.reason ?? 'cloud_unavailable',
        message: `runtime 上下文不可用（${cloud.reason ?? 'cloud_unavailable'}）`,
        to: target,
        current: null,
        previousCurrent: null,
        runtimeChanged: false,
        serviceChanged: false,
      });
    }
    root = cloud.root;
  }
  root = resolve(root);
  const home = typeof explicitHome === 'string' && explicitHome.length > 0
    ? resolve(explicitHome)
    : root;

  const beforeState = await readRuntimeCurrent(root, { userHome });
  const previousCurrent = beforeState.current;
  const previousProviders = await snapshotProviders(root);

  let serviceBefore;
  try {
    serviceBefore = await serviceStatusFn({
      root,
      home,
      serviceHome,
      userHome,
      platform,
    });
  } catch (error) {
    return failure({
      reason: 'service_unknown',
      message: `无法确认 mebular-serve 状态，拒绝升级：${error?.message ?? error}`,
      to: target,
      current: publicRuntimeCurrent(previousCurrent),
      previousCurrent: publicRuntimeCurrent(previousCurrent),
      runtimeChanged: false,
      serviceChanged: false,
    });
  }
  if (serviceBefore?.ok === false) {
    return failure({
      reason: serviceBefore.reason ?? 'service_unknown',
      message: serviceBefore.message ?? '无法确认 mebular-serve 状态，拒绝升级',
      to: target,
      current: publicRuntimeCurrent(previousCurrent),
      previousCurrent: publicRuntimeCurrent(previousCurrent),
      runtimeChanged: false,
      serviceChanged: false,
    });
  }
  if (serviceBefore?.foreign === true) {
    return failure({
      reason: 'service_foreign',
      message: 'mebular-serve 标签被其他 home 的作业占用：拒绝升级/覆盖',
      to: target,
      current: publicRuntimeCurrent(previousCurrent),
      previousCurrent: publicRuntimeCurrent(previousCurrent),
      runtimeChanged: false,
      serviceChanged: false,
    });
  }

  const installed = await installRuntimeFn({
    ...installOptions,
    version: target,
    root,
    home,
    env,
    userHome,
  });
  if (installed?.ok !== true) {
    const restoreNotes = await restoreRuntimePointers({ root, previousCurrent, previousProviders });
    return failure({
      ...installed,
      ok: false,
      action: 'upgrade',
      command: 'upgrade',
      reason: installed?.reason ?? installed?.code ?? 'install_failed',
      message: installed?.message ?? 'runtime 升级安装失败',
      to: target,
      previousCurrent: publicRuntimeCurrent(previousCurrent),
      current: publicRuntimeCurrent(previousCurrent),
      runtimeChanged: false,
      serviceChanged: false,
      restoreNotes,
    });
  }

  const afterState = await readRuntimeCurrent(root, { userHome });
  if (afterState.usable !== true || afterState.current?.version !== target) {
    const restoreNotes = await restoreRuntimePointers({ root, previousCurrent, previousProviders });
    return failure({
      reason: 'current_registration_failed',
      message: '运行时安装成功但 current 未指向目标版本；已回滚 current/provider',
      to: target,
      previousCurrent: publicRuntimeCurrent(previousCurrent),
      current: publicRuntimeCurrent(previousCurrent),
      runtimeInstalled: installed.runtimeInstalled === true,
      runtimeChanged: false,
      serviceChanged: false,
      restoreNotes,
      install: installed,
    });
  }

  const newCurrent = afterState.current;
  if (serviceBefore?.registered !== true) {
    return {
      ok: true,
      action: 'upgrade',
      command: 'upgrade',
      reason: null,
      message: `共享 runtime 已升级到 ${target}；未注册 service，未启动/重启任何 daemon`,
      to: target,
      version: target,
      runtimePath: newCurrent.runtimePath,
      cliPath: newCurrent.cliPath,
      previousCurrent: publicRuntimeCurrent(previousCurrent),
      current: publicRuntimeCurrent(newCurrent),
      runtimeChanged: true,
      serviceChanged: false,
      service: serviceBefore,
      serviceUpdated: false,
      daemonStarted: false,
      restartRequired: false,
      backupPath: installed.backupPath ?? null,
      warnings: installed.warnings ?? [],
    };
  }

  const serviceFallback = {
    path: newCurrent.cliPath,
    kind: 'shared',
    owner: 'shared',
    version: newCurrent.version,
    runtimePath: newCurrent.runtimePath,
    execPath: serviceBefore.execPath ?? process.execPath,
    electron: serviceBefore.runtime?.electron === true,
  };
  const serviceResult = await installServiceFn({
    root,
    home,
    serviceHome,
    currentState: afterState,
    fallbackProvider: serviceFallback,
    autostart: serviceBefore.autostart !== false,
    replaceExisting: true,
    platform,
  });

  if (serviceResult?.ok !== true || serviceResult?.running === false) {
    const restoreNotes = await restoreRuntimePointers({ root, previousCurrent, previousProviders });

    let serviceRestored = false;
    if (serviceBefore.registered === true) {
      const previousState = await readRuntimeCurrent(root, { userHome });
      const previousSource = sourceFromManifestRuntime(serviceBefore.runtime ?? {
        version: serviceBefore.version,
        runtimePath: serviceBefore.runtimePath,
        cliPath: serviceBefore.cliPath,
        provider: serviceBefore.provider ?? 'cli',
        owner: serviceBefore.owner ?? 'cli',
        execPath: serviceBefore.execPath,
        electron: false,
      }, {
        current: publicRuntimeCurrent(previousState.current),
      });
      if (previousSource !== null) {
        try {
          const rollbackService = await installServiceFn({
            root,
            home,
            serviceHome,
            currentState: previousState,
            sourceOverride: previousSource,
            autostart: serviceBefore.autostart !== false,
            replaceExisting: true,
            platform,
          });
          serviceRestored = rollbackService?.ok === true && rollbackService?.running !== false;
        } catch {
          serviceRestored = false;
        }
      }
    }

    return failure({
      reason: 'service_upgrade_failed',
      message: `新 runtime 已安装，但 mebular-serve 更新/重启失败：${serviceResult?.message ?? 'unknown'}${serviceRestored ? '；已回滚 service' : '；service 回滚失败，请检查诊断'}`,
      to: target,
      previousCurrent: publicRuntimeCurrent(previousCurrent),
      current: publicRuntimeCurrent(previousCurrent),
      runtimeInstalled: installed.runtimeInstalled === true,
      runtimeChanged: false,
      serviceChanged: false,
      serviceRestored,
      serviceUpdateFailed: true,
      restoreNotes,
      install: installed,
      serviceAttempt: serviceResult,
    });
  }

  return {
    ok: true,
    action: 'upgrade',
    command: 'upgrade',
    reason: null,
    message: `共享 runtime 已升级到 ${target}；mebular-serve 已更新并重启`,
    to: target,
    version: target,
    runtimePath: newCurrent.runtimePath,
    cliPath: newCurrent.cliPath,
    previousCurrent: publicRuntimeCurrent(previousCurrent),
    current: publicRuntimeCurrent(newCurrent),
    runtimeChanged: true,
    serviceChanged: true,
    serviceUpdated: true,
    service: serviceResult,
    daemonStarted: false,
    restartRequired: false,
    backupPath: installed.backupPath ?? null,
    warnings: [...(installed.warnings ?? []), ...(serviceResult.warnings ?? [])],
  };
}
