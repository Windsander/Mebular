// 共享 service 层：`mebular-serve` 的所有权、描述符、安装/状态/重启/卸载。
//
// 边界：
//   - 描述符优先指向 `<cloudRoot>/runtime/current.json` 的共享 runtime CLI；没有可用
//     current 时，只有调用方显式提供 App/CLI provider 才允许回退（并记录 owner/provider），
//     绝不下载/安装 runtime；
//   - `runtime service install`（无 fallback）在 current 不可用时返回稳定的
//     `runtime_required`，不写 unit/manifest；
//   - 一个 serviceHome 下只有一个 `mebular-serve` manifest；新的 manifest 记录
//     runtimePath/version/provider/owner/execPath，便于 status/upgrade 与 Plugin 检测；
//   - uninstall 只移除 unit/manifest，不删除 runtime、provider 注册表或任何数据。

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { cloudError } from './profiles.mjs';
import { readRuntimeCurrent, publicRuntimeCurrent } from './runtime-current.mjs';
import { loadServiceModule } from './service-loader.mjs';

export const RUNTIME_SERVICE_KIND = 'mebular-serve';

/**
 * 当前 daemon 进程的来源（supervisor/service 启动时写入 env）。用于 Console 在 current
 * 不可用时保留 App/CLI owner，不下载第二个 runtime。
 */
export function runtimeProviderFromEnv({ env = process.env, execPath = process.execPath, cliPath = null } = {}) {
  const path = typeof env.MEBULAR_RUNTIME_PATH === 'string' && env.MEBULAR_RUNTIME_PATH.length > 0
    ? env.MEBULAR_RUNTIME_PATH
    : (typeof cliPath === 'string' && cliPath.length > 0 ? cliPath : process.argv[1]);
  if (typeof path !== 'string' || path.length === 0) return null;
  return {
    path,
    kind: typeof env.MEBULAR_RUNTIME_PROVIDER === 'string' && env.MEBULAR_RUNTIME_PROVIDER.length > 0
      ? env.MEBULAR_RUNTIME_PROVIDER
      : 'cli',
    owner: typeof env.MEBULAR_RUNTIME_OWNER === 'string' && env.MEBULAR_RUNTIME_OWNER.length > 0
      ? env.MEBULAR_RUNTIME_OWNER
      : 'cli',
    version: typeof env.MEBULAR_RUNTIME_VERSION === 'string' && env.MEBULAR_RUNTIME_VERSION.length > 0
      ? env.MEBULAR_RUNTIME_VERSION
      : null,
    runtimePath: typeof env.MEBULAR_RUNTIME_ROOT === 'string' && env.MEBULAR_RUNTIME_ROOT.length > 0
      ? env.MEBULAR_RUNTIME_ROOT
      : null,
    execPath,
    electron: env.ELECTRON_RUN_AS_NODE === '1' || Boolean(process.versions?.electron),
  };
}

function serviceOptions({ serviceHome, platform, run, now, autostart, label, sha } = {}) {
  const home = serviceHome ?? process.env.MEBULAR_SERVICE_UNIT_HOME ?? homedir();
  return {
    home,
    ...(platform ? { platform } : {}),
    ...(run ? { run } : {}),
    ...(now !== undefined ? { now } : {}),
    ...(autostart !== undefined ? { autostart } : {}),
    ...(label ? { label } : {}),
    ...(sha ? { sha } : {}),
  };
}

function normalizeFallbackProvider(provider) {
  if (!provider || typeof provider !== 'object') return null;
  if (typeof provider.path !== 'string' || provider.path.trim().length === 0) return null;
  const path = provider.path.trim();
  if (!existsSync(path)) return null;
  return {
    kind: typeof provider.kind === 'string' && provider.kind.length > 0 ? provider.kind : 'cli',
    path,
    version: typeof provider.version === 'string' && provider.version.length > 0 ? provider.version : null,
    owner: typeof provider.owner === 'string' && provider.owner.length > 0
      ? provider.owner
      : (typeof provider.kind === 'string' && provider.kind.length > 0 ? provider.kind : 'cli'),
    execPath: typeof provider.execPath === 'string' && provider.execPath.length > 0 ? provider.execPath : process.execPath,
    electron: provider.electron === true || provider.env?.ELECTRON_RUN_AS_NODE === '1',
    runtimePath: typeof provider.runtimePath === 'string' && provider.runtimePath.length > 0 ? provider.runtimePath : null,
  };
}

function sourceFromCurrent(currentState, fallbackProvider) {
  return {
    ok: true,
    source: 'shared',
    provider: 'shared',
    owner: 'shared',
    version: currentState.current.version,
    runtimePath: currentState.current.runtimePath,
    cliPath: currentState.current.cliPath,
    execPath: fallbackProvider?.execPath ?? process.execPath,
    electron: fallbackProvider?.electron === true,
    current: publicRuntimeCurrent(currentState.current),
    currentSource: currentState.source,
    warnings: [...currentState.warnings],
  };
}

function sourceFromProvider(provider) {
  return {
    ok: true,
    source: provider.kind,
    provider: provider.kind,
    owner: provider.owner,
    version: provider.version,
    runtimePath: provider.runtimePath,
    cliPath: provider.path,
    execPath: provider.execPath,
    electron: provider.electron === true,
    current: null,
    currentSource: 'fallback',
    warnings: [],
  };
}

/**
 * 解析 service 当前应使用的 runtime 来源。
 *
 * `currentState` 可注入（已读过的 current），否则从 root 读取。current 可用时永远优先；
 * 不可用时才使用显式 App/CLI fallback；都没有 → `runtime_required`。
 */
export function resolveRuntimeServiceSource({
  currentState = null,
  fallbackProvider = null,
} = {}) {
  const state = currentState && typeof currentState === 'object'
    ? currentState
    : { current: null, usable: false, source: 'missing', warnings: [] };
  const fallback = normalizeFallbackProvider(fallbackProvider);
  if (state.usable === true && state.current) {
    return sourceFromCurrent(state, fallback);
  }
  if (fallback !== null) {
    return {
      ...sourceFromProvider(fallback),
      warnings: [...(state.warnings ?? [])],
    };
  }
  return {
    ok: false,
    source: null,
    provider: null,
    owner: null,
    version: state.current?.version ?? null,
    runtimePath: state.current?.runtimePath ?? null,
    cliPath: state.current?.cliPath ?? null,
    execPath: process.execPath,
    electron: false,
    current: publicRuntimeCurrent(state.current),
    currentSource: state.source ?? 'missing',
    reason: 'runtime_required',
    message: '没有可用的共享 runtime（current 缺失/无效）：请先安装 runtime 或打开 Mebular App/CLI',
    warnings: [...(state.warnings ?? [])],
  };
}

/** 构造共享 service 描述符；runtime 元数据会随 manifest 落盘（不含秘密）。 */
export function runtimeServiceDescriptor({
  root,
  home,
  source,
  http = null,
  extraArgs = [],
  providerEnv = {},
} = {}) {
  if (!source || source.ok === false || typeof source.cliPath !== 'string' || source.cliPath.length === 0) {
    throw cloudError('runtime_required', '缺少可用的 runtime 来源，无法构造 mebular-serve 描述符');
  }
  if (typeof home !== 'string' || home.length === 0) {
    throw cloudError('SERVICE_DESCRIPTOR_INVALID', '缺少 service 实例 home');
  }
  const port = Number(http?.port);
  const listenArgs = Number.isInteger(port) && port > 0 ? ['--port', String(port)] : [];
  const runtime = {
    version: source.version ?? null,
    runtimePath: source.runtimePath ?? null,
    cliPath: source.cliPath,
    provider: source.provider ?? source.source ?? null,
    owner: source.owner ?? source.provider ?? source.source ?? null,
    execPath: source.execPath ?? process.execPath,
    electron: source.electron === true,
    cloudRoot: typeof root === 'string' && root.length > 0 ? root : null,
    home,
  };
  return {
    kind: RUNTIME_SERVICE_KIND,
    args: [source.cliPath, 'serve', ...listenArgs, ...extraArgs],
    heartbeatDir: home,
    workingDir: home,
    execPath: runtime.execPath,
    env: {
      MEBULAR_HOME: home,
      ...(typeof root === 'string' && root.length > 0 ? { MEBULAR_CLOUD_ROOT: root } : {}),
      ...(source.electron === true ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...(source.provider ? { MEBULAR_RUNTIME_PROVIDER: source.provider } : {}),
      ...(source.owner ? { MEBULAR_RUNTIME_OWNER: source.owner } : {}),
      ...(source.version ? { MEBULAR_RUNTIME_VERSION: source.version } : {}),
      ...(source.cliPath ? { MEBULAR_RUNTIME_PATH: source.cliPath } : {}),
      ...(source.runtimePath ? { MEBULAR_RUNTIME_ROOT: source.runtimePath } : {}),
      ...providerEnv,
    },
    runtime,
  };
}

function manifestPathFrom(lib, serviceHome) {
  if (typeof lib?.manifestPath === 'function') return lib.manifestPath(RUNTIME_SERVICE_KIND, serviceHome);
  return join(serviceHome, '.mebular', 'services', `${RUNTIME_SERVICE_KIND}.json`);
}

function readManifestSync(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function publicManifestRuntime(manifest) {
  const runtime = manifest?.runtime;
  if (!runtime || typeof runtime !== 'object') return null;
  return {
    version: typeof runtime.version === 'string' ? runtime.version : null,
    runtimePath: typeof runtime.runtimePath === 'string' ? runtime.runtimePath : null,
    cliPath: typeof runtime.cliPath === 'string' ? runtime.cliPath : null,
    provider: typeof runtime.provider === 'string' ? runtime.provider : null,
    owner: typeof runtime.owner === 'string' ? runtime.owner : null,
    execPath: typeof runtime.execPath === 'string' ? runtime.execPath : (typeof manifest?.execPath === 'string' ? manifest.execPath : null),
    electron: runtime.electron === true,
    home: typeof runtime.home === 'string' ? runtime.home : null,
    cloudRoot: typeof runtime.cloudRoot === 'string' ? runtime.cloudRoot : null,
  };
}

function expectedServiceLabel(lib, home) {
  try {
    if (typeof lib?.defaultLabel === 'function') {
      return lib.defaultLabel(RUNTIME_SERVICE_KIND, undefined, home);
    }
  } catch {
    // fall through
  }
  return null;
}

function conflictResult(action, message, details = {}) {
  return {
    ok: false,
    action,
    reason: details.reason ?? 'service_conflict',
    message,
    ...details,
  };
}

async function loadLib(serviceLib) {
  return serviceLib ?? loadServiceModule();
}

/**
 * 安装/更新共享 service。
 *
 * 先解析 runtime 来源，再做 manifest 冲突检查；任何前置失败都不会写 unit/manifest。
 * 安装失败时尽力恢复旧 unit/manifest（若有），避免半安装覆盖。
 */
export async function installRuntimeService({
  root,
  home,
  serviceHome,
  http = null,
  userHome = homedir(),
  currentState = null,
  fallbackProvider = null,
  sourceOverride = null,
  autostart = true,
  replaceExisting = false,
  serviceLib = null,
  platform = process.platform,
  run,
  now,
  sha,
} = {}) {
  const action = 'install';
  if (typeof root !== 'string' || root.length === 0) {
    return conflictResult(action, '缺少 cloudRoot，无法安装共享 service', { reason: 'cloud_unavailable' });
  }
  if (typeof home !== 'string' || home.length === 0) {
    return conflictResult(action, '缺少 service 实例 home，无法安装共享 service', { reason: 'SERVICE_DESCRIPTOR_INVALID' });
  }

  const state = currentState ?? await readRuntimeCurrent(root, { userHome });
  const source = sourceOverride ?? resolveRuntimeServiceSource({ currentState: state, fallbackProvider });
  if (source.ok !== true) {
    return {
      ...conflictResult(action, source.message, { reason: source.reason, current: source.current, warnings: source.warnings }),
      source: null,
      service: null,
    };
  }

  let lib;
  try {
    lib = await loadLib(serviceLib);
  } catch (error) {
    return conflictResult(action, `共享 service 模块不可用：${error?.message ?? error}`, {
      reason: 'service_unavailable',
    });
  }

  const descriptor = runtimeServiceDescriptor({ root, home, source, http });
  const options = serviceOptions({
    serviceHome,
    platform,
    run,
    now,
    autostart,
    sha,
  });

  let statusBefore = null;
  try {
    statusBefore = lib.serviceStatus(descriptor, options);
  } catch (error) {
    return conflictResult(action, `无法确认现有 mebular-serve 状态：${error?.message ?? error}`, {
      reason: 'service_unknown',
    });
  }
  if (statusBefore?.foreign === true) {
    return conflictResult(action, 'mebular-serve 标签被其他 home 的作业占用：拒绝安装/覆盖', {
      reason: 'service_foreign',
      service: statusBefore,
    });
  }

  const manifestPath = manifestPathFrom(lib, options.home);
  const previousManifest = readManifestSync(manifestPath);
  const previousRuntime = publicManifestRuntime(previousManifest);
  const expectedLabel = expectedServiceLabel(lib, home);
  const legacyManifestOtherHome = previousRuntime === null
    && typeof previousManifest?.label === 'string'
    && previousManifest.label.length > 0
    && typeof expectedLabel === 'string'
    && previousManifest.label !== expectedLabel;
  const samePath = (left, right) => typeof left === 'string' && left.length > 0
    && typeof right === 'string' && right.length > 0
    && resolve(left) === resolve(right);
  const sameService = previousManifest === null
    || previousRuntime === null
    || previousRuntime.home === null
    || samePath(previousRuntime.home, home);
  const sameRoot = previousManifest === null
    || previousRuntime === null
    || previousRuntime.cloudRoot === null
    || samePath(previousRuntime.cloudRoot, root);
  if (legacyManifestOtherHome && !replaceExisting) {
    return conflictResult(action, '已存在另一个 home 的 legacy mebular-serve（manifest 无 runtime 元数据）：拒绝覆盖', {
      reason: 'service_conflict',
      existing: {
        label: previousManifest.label ?? null,
        unitPath: previousManifest.unitPath ?? null,
        runtime: previousRuntime,
      },
      service: statusBefore,
      current: source.current,
    });
  }
  const usingFallbackWithoutCurrent = source.currentSource === 'fallback';
  if (previousManifest !== null
    && !replaceExisting
    && usingFallbackWithoutCurrent
    && previousRuntime !== null
    && typeof previousRuntime.cliPath === 'string'
    && previousRuntime.cliPath.length > 0
    && !samePath(previousRuntime.cliPath, source.cliPath)) {
    return conflictResult(action, 'current 不可用且已有不同来源的 mebular-serve：拒绝覆盖现有 service', {
      reason: 'service_conflict',
      existing: {
        label: previousManifest.label ?? null,
        unitPath: previousManifest.unitPath ?? null,
        runtime: previousRuntime,
      },
      service: statusBefore,
      current: source.current,
    });
  }
  if (previousManifest !== null && !replaceExisting && (!sameService || !sameRoot)) {
    return conflictResult(action, '已存在另一个 home/cloudRoot 的 mebular-serve：拒绝覆盖', {
      reason: 'service_conflict',
      existing: {
        label: previousManifest.label ?? null,
        unitPath: previousManifest.unitPath ?? null,
        runtime: previousRuntime,
      },
      service: statusBefore,
      current: source.current,
    });
  }

  // 同 home 且 source 完全一致、已在运行：幂等 no-op，避免 Console 安装按钮重启健康 daemon。
  if (statusBefore?.registered === true
    && statusBefore?.running === true
    && previousRuntime !== null
    && previousRuntime.cliPath === source.cliPath
    && previousRuntime.version === source.version
    && previousRuntime.provider === source.provider) {
    return {
      ok: true,
      action,
      already: true,
      registered: true,
      running: true,
      label: statusBefore.label ?? null,
      unitPath: statusBefore.unitPath ?? null,
      manifestPath,
      autostart: statusBefore.autostart ?? autostart,
      runtime: previousRuntime,
      current: source.current,
      provider: source.provider,
      owner: source.owner,
      version: source.version,
      warnings: source.warnings,
    };
  }

  const previousUnit = typeof statusBefore?.unitPath === 'string' && existsSync(statusBefore.unitPath)
    ? { path: statusBefore.unitPath, content: readFileSync(statusBefore.unitPath, 'utf-8') }
    : null;
  const previousManifestRaw = previousManifest === null ? null : JSON.stringify(previousManifest, null, 2);

  const restorePrevious = () => {
    try {
      if (previousUnit !== null) {
        writeFileSync(previousUnit.path, previousUnit.content, { mode: 0o644 });
      } else if (typeof statusBefore?.unitPath === 'string' && existsSync(statusBefore.unitPath)) {
        rmSync(statusBefore.unitPath, { force: true });
      }
      if (previousManifestRaw !== null) {
        writeFileSync(manifestPath, previousManifestRaw, { mode: 0o600 });
      } else if (existsSync(manifestPath)) {
        rmSync(manifestPath, { force: true });
      }
      return true;
    } catch {
      return false;
    }
  };

  let result;
  try {
    result = lib.installService(descriptor, options);
  } catch (error) {
    const restored = restorePrevious();
    return conflictResult(action, `共享 service 安装失败：${error?.message ?? error}`, {
      reason: 'service_install_failed',
      restored,
      current: source.current,
      runtime: descriptor.runtime,
    });
  }

  if (result?.ok !== true || result?.started !== true) {
    const restored = restorePrevious();
    let restarted = false;
    if (previousManifest !== null && typeof lib.restartService === 'function') {
      try {
        restarted = lib.restartService(descriptor, options)?.ok === true;
      } catch {
        restarted = false;
      }
    }
    return conflictResult(action, `共享 service 安装失败或未启动：${result?.startError ?? result?.error ?? 'unknown'}`, {
      reason: result?.foreign === true ? 'service_foreign' : 'service_install_failed',
      restored,
      restarted,
      unitPath: result?.unitPath ?? null,
      current: source.current,
      runtime: descriptor.runtime,
    });
  }

  return {
    ok: true,
    action,
    already: false,
    registered: true,
    running: true,
    label: result.label ?? null,
    unitPath: result.unitPath ?? null,
    manifestPath,
    autostart: result.autostart ?? autostart,
    runtime: descriptor.runtime,
    current: source.current,
    provider: source.provider,
    owner: source.owner,
    version: source.version,
    warnings: [...source.warnings, ...(Array.isArray(result.warning) ? result.warning : [])],
  };
}

function descriptorForExistingService({ root, home, manifest }) {
  const runtime = publicManifestRuntime(manifest);
  const cliPath = runtime?.cliPath ?? (Array.isArray(manifest?.args) ? manifest.args[0] : null) ?? '';
  return {
    kind: RUNTIME_SERVICE_KIND,
    args: Array.isArray(manifest?.args) ? [...manifest.args] : [cliPath, 'serve'].filter(Boolean),
    heartbeatDir: home,
    workingDir: home,
    ...(typeof manifest?.execPath === 'string' ? { execPath: manifest.execPath } : {}),
    env: {
      MEBULAR_HOME: home,
      ...(typeof root === 'string' && root.length > 0 ? { MEBULAR_CLOUD_ROOT: root } : {}),
    },
    ...(runtime ? { runtime } : {}),
  };
}

/** 只读 service 状态：版本/current/running/owner 都来自非敏感文件。 */
export async function runtimeServiceStatus({
  root,
  home,
  serviceHome,
  userHome = homedir(),
  currentState = null,
  fallbackProvider = null,
  serviceLib = null,
  platform = process.platform,
  run,
  now,
} = {}) {
  const action = 'status';
  const state = currentState ?? (typeof root === 'string' && root.length > 0
    ? await readRuntimeCurrent(root, { userHome })
    : { current: null, usable: false, source: 'unavailable', warnings: ['cloudRoot 不可用'] });
  let lib;
  try {
    lib = await loadLib(serviceLib);
  } catch (error) {
    return {
      ok: false,
      action,
      reason: 'service_unavailable',
      message: `共享 service 模块不可用：${error?.message ?? error}`,
      current: publicRuntimeCurrent(state.current),
      currentUsable: state.usable === true,
      warnings: [...(state.warnings ?? [])],
    };
  }

  const options = serviceOptions({ serviceHome, platform, run, now });
  const manifestPath = manifestPathFrom(lib, options.home);
  const manifest = readManifestSync(manifestPath);
  const runtime = publicManifestRuntime(manifest);

  let descriptor;
  const source = resolveRuntimeServiceSource({ currentState: state, fallbackProvider });
  if (source.ok === true) {
    descriptor = runtimeServiceDescriptor({ root, home, source });
  } else {
    descriptor = descriptorForExistingService({ root, home, manifest });
  }

  let status;
  try {
    status = lib.serviceStatus(descriptor, options);
  } catch (error) {
    return {
      ok: false,
      action,
      reason: 'service_unknown',
      message: `无法读取 mebular-serve 状态：${error?.message ?? error}`,
      current: publicRuntimeCurrent(state.current),
      currentUsable: state.usable === true,
      runtime,
      warnings: [...(state.warnings ?? [])],
    };
  }

  return {
    ok: true,
    action,
    kind: RUNTIME_SERVICE_KIND,
    home,
    serviceHome: options.home,
    label: status?.label ?? null,
    manifestLabel: manifest?.label ?? null,
    expectedLabel: expectedServiceLabel(lib, home),
    registered: status?.registered === true,
    running: status?.running === true,
    autostart: status?.autostart ?? null,
    foreign: status?.foreign === true,
    foreignOwner: status?.foreignOwner ?? null,
    unitPath: status?.unitPath ?? null,
    manifestPath,
    runtime,
    version: runtime?.version ?? state.current?.version ?? null,
    runtimePath: runtime?.runtimePath ?? state.current?.runtimePath ?? null,
    provider: runtime?.provider ?? null,
    owner: runtime?.owner ?? null,
    cliPath: runtime?.cliPath ?? (Array.isArray(status?.args) ? status.args[0] : null) ?? null,
    args: Array.isArray(status?.args) ? [...status.args] : [],
    execPath: status?.execPath ?? runtime?.execPath ?? null,
    current: publicRuntimeCurrent(state.current),
    currentUsable: state.usable === true,
    currentSource: state.source,
    warnings: [...(state.warnings ?? [])],
  };
}

/** 重启共享 service（只执行平台计划；不启动第二个 daemon）。 */
export async function restartRuntimeService({
  root,
  home,
  serviceHome,
  userHome = homedir(),
  currentState = null,
  fallbackProvider = null,
  serviceLib = null,
  platform = process.platform,
  run,
  now,
} = {}) {
  const action = 'restart';
  const status = await runtimeServiceStatus({
    root,
    home,
    serviceHome,
    userHome,
    currentState,
    fallbackProvider,
    serviceLib,
    platform,
    run,
    now,
  });
  if (status.ok !== true) return { ...status, action };
  if (status.registered !== true) {
    return {
      ...status,
      ok: false,
      action,
      reason: 'service_not_registered',
      message: '当前 home 未注册 mebular-serve；未启动第二个 daemon',
    };
  }
  let lib;
  try {
    lib = await loadLib(serviceLib);
  } catch (error) {
    return { ...status, ok: false, action, reason: 'service_unavailable', message: String(error?.message ?? error) };
  }
  const manifest = readManifestSync(status.manifestPath);
  const descriptor = descriptorForExistingService({ root, home, manifest });
  let result;
  try {
    result = lib.restartService(descriptor, serviceOptions({ serviceHome, platform, run, now }));
  } catch (error) {
    return { ...status, ok: false, action, reason: 'service_restart_failed', message: String(error?.message ?? error) };
  }
  return {
    ...status,
    ok: result?.ok === true,
    action,
    restarted: result?.ok === true,
    commands: result?.commands ?? [],
    manual: result?.manual ?? null,
    reason: result?.ok === true ? null : 'service_restart_failed',
  };
}

/** 重启计划（不执行；Console /admin/api/restart 复用）。 */
export async function planRuntimeServiceRestart({
  root,
  home,
  serviceHome,
  userHome = homedir(),
  currentState = null,
  fallbackProvider = null,
  serviceLib = null,
  platform = process.platform,
  run,
  now,
} = {}) {
  const status = await runtimeServiceStatus({
    root,
    home,
    serviceHome,
    userHome,
    currentState,
    fallbackProvider,
    serviceLib,
    platform,
    run,
    now,
  });
  if (status.ok !== true) {
    return { registered: false, manual: status.message ?? '服务管理不可用：请手动重启', status };
  }
  if (status.registered !== true) {
    return {
      registered: false,
      manual: `未注册为服务：请手动重启（nohup mebular serve > ${home}/serve.log 2>&1 &）`,
      status,
    };
  }
  let lib;
  try {
    lib = await loadLib(serviceLib);
  } catch (error) {
    return { registered: false, manual: `服务管理不可用（${error?.message ?? error}）：请手动重启`, status };
  }
  const manifest = readManifestSync(status.manifestPath);
  const descriptor = descriptorForExistingService({ root, home, manifest });
  try {
    const plan = lib.restartPlanFor(descriptor, serviceOptions({ serviceHome, platform, run, now }));
    return { ...plan, status };
  } catch (error) {
    return { registered: false, manual: `服务重启计划不可用（${error?.message ?? error}）：请手动重启`, status };
  }
}

/**
 * 卸载共享 service：只移除 unit/manifest。
 * 不删除 runtime 目录、runtime-providers.json、store、identity 或任何数据。
 */
export async function uninstallRuntimeService({
  root,
  home,
  serviceHome,
  serviceLib = null,
  platform = process.platform,
  run,
  now,
} = {}) {
  const action = 'uninstall';
  let lib;
  try {
    lib = await loadLib(serviceLib);
  } catch (error) {
    return {
      ok: false,
      action,
      reason: 'service_unavailable',
      message: `共享 service 模块不可用：${error?.message ?? error}`,
    };
  }
  const options = serviceOptions({ serviceHome, platform, run, now });
  const manifestPath = manifestPathFrom(lib, options.home);
  const manifest = readManifestSync(manifestPath);
  const manifestRuntime = publicManifestRuntime(manifest);
  const expectedLabel = expectedServiceLabel(lib, home);
  if (!manifestRuntime?.home
    && typeof manifest?.label === 'string'
    && manifest.label.length > 0
    && typeof expectedLabel === 'string'
    && manifest.label !== expectedLabel) {
    return {
      ok: false,
      action,
      reason: 'service_conflict',
      message: 'manifest 属于另一个 home 的 legacy mebular-serve：拒绝卸载他人服务',
      existing: { label: manifest.label, unitPath: manifest?.unitPath ?? null, runtime: null },
    };
  }
  if (manifestRuntime?.home && resolve(manifestRuntime.home) !== resolve(home)) {
    return {
      ok: false,
      action,
      reason: 'service_conflict',
      message: 'manifest 属于另一个 home 的 mebular-serve：拒绝卸载他人服务',
      existing: { label: manifest?.label ?? null, unitPath: manifest?.unitPath ?? null, runtime: manifestRuntime },
    };
  }
  if (manifestRuntime?.cloudRoot && typeof root === 'string' && resolve(manifestRuntime.cloudRoot) !== resolve(root)) {
    return {
      ok: false,
      action,
      reason: 'service_conflict',
      message: 'manifest 属于另一个 cloudRoot 的 mebular-serve：拒绝卸载他人服务',
      existing: { label: manifest?.label ?? null, unitPath: manifest?.unitPath ?? null, runtime: manifestRuntime },
    };
  }
  const cliPath = (Array.isArray(manifest?.args) ? manifest.args[0] : null) ?? '';
  const descriptor = {
    kind: RUNTIME_SERVICE_KIND,
    args: Array.isArray(manifest?.args) ? [...manifest.args] : (cliPath ? [cliPath, 'serve'] : []),
    heartbeatDir: home,
    workingDir: home,
    ...(typeof manifest?.execPath === 'string' ? { execPath: manifest.execPath } : {}),
    env: {
      MEBULAR_HOME: home,
      ...(typeof root === 'string' && root.length > 0 ? { MEBULAR_CLOUD_ROOT: root } : {}),
    },
    ...(manifestRuntime ? { runtime: manifestRuntime } : {}),
  };
  let result;
  try {
    result = lib.uninstallService(descriptor, options);
  } catch (error) {
    return { ok: false, action, reason: 'service_uninstall_failed', message: String(error?.message ?? error) };
  }
  return {
    ok: true,
    action,
    kind: RUNTIME_SERVICE_KIND,
    removed: result?.removed === true,
    serviceHome: options.home,
    manifestPath,
    unitPath: result?.unitPath ?? manifest?.unitPath ?? null,
    label: result?.label ?? manifest?.label ?? null,
    note: result?.note ?? null,
    runtimePreserved: true,
  };
}
