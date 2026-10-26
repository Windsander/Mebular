// 桌面 App · 共享 Runtime 更新检查 / 增量提示 / 受控升级编排（Phase 5b2a）。
//
// 本模块不 import electron：窗口/对话框/托盘由 index.mjs 注入，便于离线单测。
//
// 边界：
//   - 启动检查非阻塞：index 通过 `startStartupRuntimeUpdateCheck` 延迟执行，不 await 窗口/向导；
//   - 只提示不静默安装：只有 `showPromptFn` 返回 `update` 才调用 `upgradeFn`；
//   - 共享状态：检查/跳过/升级锁全部走 `@mebular/mcp` 的 runtime-update / runtime-upgrade，
//     App 不写自己的版本仓库；
//   - App-owned child：升级前只停自己的 child；升级后/失败后调用 `ensureFn` 重连/恢复，
//     不产生第二个 daemon；
//   - 失败显示稳定 reason，不自动重试；旧 runtime/service/data 由核心保留。

export const RUNTIME_UPDATE_ACTION = Object.freeze({
  UPDATE: 'update',
  LATER: 'later',
  SKIP: 'skip',
  DISMISS: 'dismiss',
});

export function createRuntimeUpdateSession() {
  return { promptedVersions: new Set(), prompting: false };
}

/**
 * 纯决策：这次要不要弹更新提示。
 * 返回 `{ show, reason, currentVersion?, latestVersion?, serviceRestart? }`。
 */
export function runtimeUpdatePromptDecision({
  check = null,
  busy = false,
  tasksRunning = false,
  wizardComplete = true,
  prompted = false,
  serviceRestart = false,
} = {}) {
  if (prompted) return { show: false, reason: 'already_prompted' };
  if (!check || typeof check !== 'object') return { show: false, reason: 'no_check' };
  if (check.ok !== true) {
    return { show: false, reason: check.reason ?? check.status ?? 'check_failed' };
  }
  if (check.skipped === true) return { show: false, reason: 'skipped' };
  if (check.available !== true) {
    return { show: false, reason: check.decision ?? check.status ?? 'not_available' };
  }
  if (typeof check.currentVersion !== 'string' || typeof check.latestVersion !== 'string') {
    return { show: false, reason: 'version_missing' };
  }
  if (check.currentVersion === check.latestVersion) {
    return { show: false, reason: 'up_to_date' };
  }
  if (busy) return { show: false, reason: 'entry_busy' };
  if (tasksRunning) return { show: false, reason: 'tasks_running' };
  if (wizardComplete !== true) return { show: false, reason: 'wizard_incomplete' };
  return {
    show: true,
    reason: 'update_available',
    currentVersion: check.currentVersion,
    latestVersion: check.latestVersion,
    serviceRestart: serviceRestart === true,
  };
}

/** 原生 dialog 的稳定模型（按钮顺序固定：更新 / 稍后 / 跳过此版本）。 */
export function buildRuntimeUpdatePrompt({ check, serviceRestart = false, t }) {
  const current = check?.currentVersion ?? '—';
  const latest = check?.latestVersion ?? '—';
  const restartNote = serviceRestart === true ? t('update.message.service') : t('update.message.child');
  return {
    type: 'info',
    message: t('update.title'),
    detail: `${t('update.message', { current, latest })}\n\n${restartNote}`,
    buttons: [
      t('update.action.update'),
      t('update.action.later'),
      t('update.action.skip'),
    ],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
}

/** dialog response → 稳定 action；未知/关闭按「稍后」处理，不写 skip。 */
export function runtimeUpdateActionForResponse(response) {
  if (response === 0) return RUNTIME_UPDATE_ACTION.UPDATE;
  if (response === 2) return RUNTIME_UPDATE_ACTION.SKIP;
  return RUNTIME_UPDATE_ACTION.LATER;
}

export function buildRuntimeUpdateFailurePrompt({ check, result, t }) {
  const current = check?.currentVersion ?? result?.current?.version ?? '—';
  const latest = check?.latestVersion ?? result?.to ?? '—';
  const reason = result?.reason ?? 'upgrade_failed';
  return {
    type: 'error',
    message: t('update.failed.title'),
    detail: t('update.failed.message', { current, latest, reason }),
    buttons: [t('update.action.ok')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

export function buildRuntimeUpgradeBusyPrompt({ t }) {
  return {
    type: 'info',
    message: t('update.busy.title'),
    detail: t('update.busy.message'),
    buttons: [t('update.action.ok')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/**
 * 读取共享 upgrade state/lock。锁是唯一互斥判定；state.upgrading 只作展示。
 * 模块不可用/读取失败时返回 not busy（不阻塞入口），但调用方仍会受 check 的 busy 影响。
 */
export async function inspectSharedUpgradeStatus({
  root,
  modules,
  now,
  pidAliveFn,
  staleMs,
} = {}) {
  const base = { busy: false, holder: null, stale: true, state: null, stateSource: 'unavailable' };
  if (typeof root !== 'string' || root.length === 0 || !modules) {
    return { ...base, reason: 'unavailable' };
  }
  let lock = null;
  if (typeof modules.inspectRuntimeUpgradeLock === 'function') {
    try {
      lock = await modules.inspectRuntimeUpgradeLock(root, { now, pidAliveFn, staleMs });
    } catch {
      lock = null;
    }
  }
  let stateRead = null;
  if (typeof modules.readRuntimeUpgradeState === 'function') {
    try {
      stateRead = await modules.readRuntimeUpgradeState(root);
    } catch {
      stateRead = null;
    }
  }
  return {
    busy: lock?.busy === true,
    holder: lock?.holder ?? null,
    stale: lock?.stale !== false,
    state: stateRead?.state ?? null,
    stateSource: stateRead?.source ?? 'unavailable',
  };
}

async function safeEnsure(ensureFn) {
  if (typeof ensureFn !== 'function') return null;
  try {
    const result = await ensureFn();
    return result ?? { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

const defaultSleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * 等另一个入口升级结束（有界）。返回 `{settled, waited}`；超时则调用方不 ensure，
 * 避免与另一个入口的 service 重启抢端口。
 */
export async function waitForSharedUpgradeIdle({
  upgradeStatusFn = null,
  timeoutMs = 30_000,
  intervalMs = 500,
  sleepFn = defaultSleep,
  nowMs = () => Date.now(),
} = {}) {
  if (typeof upgradeStatusFn !== 'function') return { settled: true, waited: false };
  const started = nowMs();
  for (;;) {
    let status = null;
    try {
      status = await upgradeStatusFn();
    } catch {
      return { settled: false, waited: nowMs() - started > 0, error: 'status_unavailable' };
    }
    if (status?.busy !== true) {
      return { settled: true, waited: nowMs() - started > 0 };
    }
    if (nowMs() - started >= timeoutMs) {
      return { settled: false, waited: true };
    }
    await sleepFn(intervalMs);
  }
}

/**
 * 执行一次用户同意的升级：
 *   1. 预检共享 upgrade.lock：另一个入口在升级 → 不重复执行，最多等 `reconnectTimeoutMs` 后 reconnect；
 *   2. 只停 App 自己托管的 child（service/外部 daemon 不动）；
 *   3. 调共享 `upgradeRuntime`（固定目标版本 latest）；
 *   4. 成功 → ensure/attach 新 runtime；失败 → ensure 恢复旧 runtime/daemon；busy → 等对方结束再 reconnect。
 *
 * 不重试安装；不启动第二个 daemon/version。
 */
export async function performRuntimeUpdate({
  root,
  home,
  to,
  entry = 'app',
  isChildAlive = () => false,
  stopChild = null,
  waitForChildExit = null,
  upgradeFn,
  ensureFn,
  upgradeStatusFn = null,
  reconnectTimeoutMs = 30_000,
  reconnectIntervalMs = 500,
  sleepFn = defaultSleep,
} = {}) {
  if (typeof to !== 'string' || to.trim().length === 0) {
    return { ok: false, action: 'upgrade', reason: 'unsupported_version', message: '缺少目标版本', busy: false };
  }
  if (typeof upgradeFn !== 'function') {
    return { ok: false, action: 'upgrade', reason: 'upgrade_unavailable', message: '共享升级模块不可用', busy: false };
  }

  let preflight = { busy: false };
  if (typeof upgradeStatusFn === 'function') {
    try {
      preflight = await upgradeStatusFn();
    } catch {
      preflight = { busy: false };
    }
  }
  if (preflight?.busy === true) {
    const idle = await waitForSharedUpgradeIdle({
      upgradeStatusFn,
      timeoutMs: reconnectTimeoutMs,
      intervalMs: reconnectIntervalMs,
      sleepFn,
    });
    const ensured = idle.settled ? await safeEnsure(ensureFn) : null;
    return {
      ok: false,
      action: 'upgrade',
      reason: 'busy',
      busy: true,
      message: '另一个入口正在升级共享 Runtime；本入口不重复安装',
      lock: preflight.holder ?? null,
      childStopped: false,
      reconnectRequired: !idle.settled,
      ensure: ensured,
    };
  }

  let childStopped = false;
  if (typeof isChildAlive === 'function' && isChildAlive() === true) {
    if (typeof stopChild !== 'function') {
      return {
        ok: false,
        action: 'upgrade',
        reason: 'child_stop_unavailable',
        busy: false,
        message: '无法停止 App 托管的守护，已取消升级',
        childStopped: false,
      };
    }
    let stopped;
    try {
      stopped = await stopChild();
    } catch (error) {
      return {
        ok: false,
        action: 'upgrade',
        reason: 'child_stop_failed',
        busy: false,
        message: `停止 App 托管的守护失败：${error?.message ?? error}`,
        childStopped: false,
      };
    }
    if (stopped === false) {
      return {
        ok: false,
        action: 'upgrade',
        reason: 'child_stop_failed',
        busy: false,
        message: 'App 托管的守护未能停止，已取消升级',
        childStopped: false,
      };
    }
    childStopped = true;
    if (typeof waitForChildExit === 'function') {
      const exited = await waitForChildExit();
      if (exited === false) {
        return {
          ok: false,
          action: 'upgrade',
          reason: 'child_stop_failed',
          busy: false,
          message: 'App 托管的守护仍在退出中，已取消升级',
          childStopped: true,
        };
      }
    }
  }

  let result;
  try {
    result = await upgradeFn({ root, home, to, entry });
  } catch (error) {
    result = {
      ok: false,
      action: 'upgrade',
      reason: error?.code ?? 'upgrade_failed',
      message: String(error?.message ?? error),
    };
  }

  if (result?.ok === true) {
    const ensured = await safeEnsure(ensureFn);
    return {
      ...result,
      childStopped,
      restarted: true,
      ensure: ensured,
    };
  }

  if (result?.busy === true || result?.reason === 'busy') {
    const idle = await waitForSharedUpgradeIdle({
      upgradeStatusFn,
      timeoutMs: reconnectTimeoutMs,
      intervalMs: reconnectIntervalMs,
      sleepFn,
    });
    const ensured = idle.settled ? await safeEnsure(ensureFn) : null;
    return {
      ...result,
      ok: false,
      busy: true,
      childStopped,
      reconnectRequired: !idle.settled,
      ensure: ensured,
    };
  }

  // 失败：核心已回滚 current/provider/service；尽量把旧 daemon 拉回来。
  const ensured = await safeEnsure(ensureFn);
  return {
    ...result,
    ok: false,
    childStopped,
    recovered: true,
    ensure: ensured,
  };
}

const defaultSchedule = (fn) => {
  const timer = setTimeout(fn, 0);
  timer.unref?.();
  return timer;
};

/**
 * 非阻塞启动检查：index 调用后立即返回；run 在下一轮事件循环执行。
 * 返回 timer/句柄（测试可注入 schedule）。
 */
export function startStartupRuntimeUpdateCheck({ run, schedule = defaultSchedule, onError = null } = {}) {
  if (typeof run !== 'function') return null;
  return schedule(() => {
    Promise.resolve()
      .then(run)
      .catch((error) => {
        if (typeof onError === 'function') onError(error);
      });
  });
}

/**
 * 检查 + 决策 + 展示 + 动作的统一入口（App index 只提供 dialog/upgrade/ensure 注入）。
 * 任何失败都静默跳过，不阻塞/不抛给启动流程。
 */
export async function maybePromptForRuntimeUpdate({
  root,
  session = createRuntimeUpdateSession(),
  checkFn,
  showPromptFn,
  upgradeStatusFn = null,
  skipVersionFn = null,
  promptedVersionFn = null,
  performUpgradeFn = null,
  isBusy = () => false,
  hasRunningTasks = () => false,
  wizardComplete = true,
  serviceRestart = () => false,
} = {}) {
  if (!session || session.prompting === true) return { shown: false, reason: 'prompting' };
  if (typeof checkFn !== 'function') return { shown: false, reason: 'no_check' };
  if (isBusy() === true) return { shown: false, reason: 'entry_busy' };

  let check;
  try {
    check = await checkFn();
  } catch (error) {
    return { shown: false, reason: 'check_failed', error: String(error?.message ?? error) };
  }

  let preflight = { busy: false };
  if (typeof upgradeStatusFn === 'function') {
    try {
      preflight = await upgradeStatusFn();
    } catch {
      preflight = { busy: false };
    }
  }
  let tasksRunning = false;
  try {
    tasksRunning = typeof hasRunningTasks === 'function'
      ? (await hasRunningTasks()) === true
      : hasRunningTasks === true;
  } catch {
    tasksRunning = false;
  }
  let restarts = false;
  try {
    restarts = typeof serviceRestart === 'function'
      ? (await serviceRestart()) === true
      : serviceRestart === true;
  } catch {
    restarts = false;
  }

  const prompted = (typeof check?.latestVersion === 'string'
    && session.promptedVersions?.has(check.latestVersion) === true)
    || check?.prompted === true
    || (typeof check?.promptedVersion === 'string'
      && typeof check?.latestVersion === 'string'
      && check.promptedVersion === check.latestVersion);
  const decision = runtimeUpdatePromptDecision({
    check,
    busy: isBusy() === true || preflight?.busy === true,
    tasksRunning,
    wizardComplete,
    prompted,
    serviceRestart: restarts,
  });
  if (decision.show !== true) return { shown: false, ...decision, check };

  // 只在真正要展示提示时写共享 prompted；skip/update/later 都算已提示，
  // 另一个入口（App/Plugin/CLI）之后不会自动弹同一 latestVersion。
  session.promptedVersions?.add(check.latestVersion);
  session.prompting = true;
  let promptedSaved = false;
  let promptWarning = null;
  if (typeof showPromptFn === 'function' && typeof promptedVersionFn === 'function') {
    try {
      await promptedVersionFn(root, check.latestVersion);
      promptedSaved = true;
    } catch (error) {
      promptWarning = String(error?.message ?? error);
    }
  }

  try {
    let action = RUNTIME_UPDATE_ACTION.LATER;
    if (typeof showPromptFn === 'function') {
      try {
        action = await showPromptFn({ check, decision, serviceRestart: restarts });
      } catch (error) {
        return {
          shown: false,
          reason: 'prompt_failed',
          action: RUNTIME_UPDATE_ACTION.LATER,
          error: String(error?.message ?? error),
          check,
        };
      }
    }
    if (action === RUNTIME_UPDATE_ACTION.SKIP) {
      let skipped = false;
      let warning = null;
      if (typeof skipVersionFn === 'function') {
        try {
          await skipVersionFn(root, check.latestVersion);
          skipped = true;
        } catch (error) {
          warning = String(error?.message ?? error);
        }
      }
      return {
        shown: true,
        action: RUNTIME_UPDATE_ACTION.SKIP,
        skipped,
        promptedSaved,
        warning: warning ?? promptWarning,
        check,
      };
    }
    if (action === RUNTIME_UPDATE_ACTION.UPDATE) {
      if (typeof performUpgradeFn !== 'function') {
        return {
          shown: true,
          action: RUNTIME_UPDATE_ACTION.UPDATE,
          ok: false,
          reason: 'upgrade_unavailable',
          promptedSaved,
          check,
        };
      }
      const result = await performUpgradeFn({ to: check.latestVersion, check, root });
      return {
        shown: true,
        action: RUNTIME_UPDATE_ACTION.UPDATE,
        ok: result?.ok === true,
        result,
        promptedSaved,
        check,
      };
    }
    // 稍后/关闭：不写 skip、不自动重试。
    return {
      shown: true,
      action: action === RUNTIME_UPDATE_ACTION.LATER ? RUNTIME_UPDATE_ACTION.LATER : RUNTIME_UPDATE_ACTION.DISMISS,
      promptedSaved,
      warning: promptWarning,
      check,
    };
  } finally {
    session.prompting = false;
  }
}
