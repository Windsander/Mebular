// Phase 5b2a · 桌面 App 启动更新检查 / 增量提示 / child/service 升级编排。
// 全程离线：check/upgrade/ensure/dialog 都是替身；不启 Electron、不启 daemon。

import { describe, it, expect } from '@jest/globals';
import {
  RUNTIME_UPDATE_ACTION,
  buildRuntimeUpdateFailurePrompt,
  buildRuntimeUpdatePrompt,
  createRuntimeUpdateSession,
  inspectSharedUpgradeStatus,
  maybePromptForRuntimeUpdate,
  performRuntimeUpdate,
  runtimeUpdateActionForResponse,
  runtimeUpdatePromptDecision,
  startStartupRuntimeUpdateCheck,
  waitForSharedUpgradeIdle,
} from '../../apps/desktop/src/main/runtime-updates.mjs';

const t = (key, vars = {}) => {
  const template = {
    'update.title': 'Runtime 更新',
    'update.message': '{current} → {latest}',
    'update.message.service': '服务会短暂重启',
    'update.message.child': '守护会重启',
    'update.action.update': '更新',
    'update.action.later': '稍后',
    'update.action.skip': '跳过此版本',
    'update.action.ok': '知道了',
    'update.failed.title': '更新失败',
    'update.failed.message': '{latest} 失败（{reason}）；仍使用 {current}',
    'update.busy.title': '正在更新',
    'update.busy.message': '另一个入口正在更新',
  }[key];
  return String(template ?? key).replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
};

const availableCheck = {
  ok: true,
  status: 'update_available',
  decision: 'update_available',
  available: true,
  skipped: false,
  currentVersion: '0.1.1',
  latestVersion: '0.1.2',
  latest: '0.1.2',
};

describe('runtime update prompt decision', () => {
  it('available 且空闲/向导完成 → 提示', () => {
    expect(runtimeUpdatePromptDecision({ check: availableCheck })).toMatchObject({
      show: true,
      reason: 'update_available',
      currentVersion: '0.1.1',
      latestVersion: '0.1.2',
    });
  });

  it('离线/失败、skipped、未 available、busy、任务中、wizard 未完成、已提示 → 不弹', () => {
    expect(runtimeUpdatePromptDecision({ check: { ok: false, status: 'offline', reason: 'offline' } }))
      .toMatchObject({ show: false, reason: 'offline' });
    expect(runtimeUpdatePromptDecision({ check: { ...availableCheck, available: false, skipped: true } }))
      .toMatchObject({ show: false, reason: 'skipped' });
    expect(runtimeUpdatePromptDecision({ check: { ...availableCheck, available: false } }))
      .toMatchObject({ show: false, reason: 'update_available' });
    expect(runtimeUpdatePromptDecision({ check: availableCheck, busy: true }))
      .toMatchObject({ show: false, reason: 'entry_busy' });
    expect(runtimeUpdatePromptDecision({ check: availableCheck, tasksRunning: true }))
      .toMatchObject({ show: false, reason: 'tasks_running' });
    expect(runtimeUpdatePromptDecision({ check: availableCheck, wizardComplete: false }))
      .toMatchObject({ show: false, reason: 'wizard_incomplete' });
    expect(runtimeUpdatePromptDecision({ check: availableCheck, prompted: true }))
      .toMatchObject({ show: false, reason: 'already_prompted' });
    expect(runtimeUpdatePromptDecision({ check: { ...availableCheck, currentVersion: '0.1.2' } }))
      .toMatchObject({ show: false, reason: 'up_to_date' });
  });

  it('dialog 模型：更新 / 稍后 / 跳过此版本，service 重启提示；response 映射稳定', () => {
    const prompt = buildRuntimeUpdatePrompt({ check: availableCheck, serviceRestart: true, t });
    expect(prompt.buttons).toEqual(['更新', '稍后', '跳过此版本']);
    expect(prompt.detail).toContain('0.1.1 → 0.1.2');
    expect(prompt.detail).toContain('服务会短暂重启');
    expect(runtimeUpdateActionForResponse(0)).toBe(RUNTIME_UPDATE_ACTION.UPDATE);
    expect(runtimeUpdateActionForResponse(1)).toBe(RUNTIME_UPDATE_ACTION.LATER);
    expect(runtimeUpdateActionForResponse(2)).toBe(RUNTIME_UPDATE_ACTION.SKIP);
    expect(runtimeUpdateActionForResponse(99)).toBe(RUNTIME_UPDATE_ACTION.LATER);

    const failed = buildRuntimeUpdateFailurePrompt({
      check: availableCheck,
      result: { ok: false, reason: 'http_error' },
      t,
    });
    expect(failed.type).toBe('error');
    expect(failed.detail).toContain('http_error');
    expect(failed.detail).toContain('0.1.1');
  });
});

describe('maybePromptForRuntimeUpdate', () => {
  it('稍后：不写 skip、不调用升级、当前会话不重复弹', async () => {
    const session = createRuntimeUpdateSession();
    let showCalls = 0;
    let skipCalls = 0;
    let upgradeCalls = 0;
    const options = {
      root: '/root',
      session,
      checkFn: async () => availableCheck,
      showPromptFn: async () => {
        showCalls += 1;
        return RUNTIME_UPDATE_ACTION.LATER;
      },
      skipVersionFn: async () => { skipCalls += 1; },
      performUpgradeFn: async () => { upgradeCalls += 1; return { ok: true }; },
    };
    const first = await maybePromptForRuntimeUpdate(options);
    expect(first).toMatchObject({ shown: true, action: 'later' });
    expect(skipCalls).toBe(0);
    expect(upgradeCalls).toBe(0);

    const second = await maybePromptForRuntimeUpdate(options);
    expect(second).toMatchObject({ shown: false, reason: 'already_prompted' });
    expect(showCalls).toBe(1);
  });

  it('跳过此版本：只写共享 skippedVersion，不升级', async () => {
    const skipped = [];
    const result = await maybePromptForRuntimeUpdate({
      root: '/root',
      checkFn: async () => availableCheck,
      showPromptFn: async () => RUNTIME_UPDATE_ACTION.SKIP,
      skipVersionFn: async (root, version) => { skipped.push({ root, version }); },
      performUpgradeFn: async () => { throw new Error('must not upgrade'); },
    });
    expect(result).toMatchObject({ shown: true, action: 'skip', skipped: true });
    expect(skipped).toEqual([{ root: '/root', version: '0.1.2' }]);
  });

  it('真正展示提示前写共享 prompted；App 已提示的 latest 不再自动弹', async () => {
    const prompted = [];
    const session = createRuntimeUpdateSession();
    const options = {
      root: '/root',
      session,
      checkFn: async () => availableCheck,
      showPromptFn: async () => RUNTIME_UPDATE_ACTION.LATER,
      promptedVersionFn: async (root, version) => { prompted.push({ root, version }); },
    };
    const first = await maybePromptForRuntimeUpdate(options);
    expect(first).toMatchObject({ shown: true, action: 'later', promptedSaved: true });
    expect(prompted).toEqual([{ root: '/root', version: '0.1.2' }]);

    // 另一个 App 进程/入口读取共享状态：prompted=true，不自动弹。
    const other = await maybePromptForRuntimeUpdate({
      root: '/root',
      checkFn: async () => ({ ...availableCheck, prompted: true, promptedVersion: '0.1.2' }),
      showPromptFn: async () => { throw new Error('must not prompt'); },
    });
    expect(other).toMatchObject({ shown: false, reason: 'already_prompted' });

    // 只有提示写入失败也不阻塞本次展示，但返回 warning。
    const warned = await maybePromptForRuntimeUpdate({
      root: '/root',
      checkFn: async () => availableCheck,
      showPromptFn: async () => RUNTIME_UPDATE_ACTION.LATER,
      promptedVersionFn: async () => { throw new Error('state unavailable'); },
    });
    expect(warned).toMatchObject({ shown: true, promptedSaved: false, warning: 'state unavailable' });
    expect(prompted).toHaveLength(1);
  });

  it('skip/update/later 都先写 prompted（只写一次），另一个入口不再自动弹', async () => {
    for (const action of [RUNTIME_UPDATE_ACTION.LATER, RUNTIME_UPDATE_ACTION.SKIP, RUNTIME_UPDATE_ACTION.UPDATE]) {
      const prompted = [];
      const session = createRuntimeUpdateSession();
      const result = await maybePromptForRuntimeUpdate({
        root: '/root',
        session,
        checkFn: async () => availableCheck,
        showPromptFn: async () => action,
        promptedVersionFn: async (root, version) => { prompted.push({ root, version }); },
        skipVersionFn: async () => {},
        performUpgradeFn: async () => ({ ok: true }),
      });
      expect(result).toMatchObject({ shown: true, promptedSaved: true });
      expect(prompted).toEqual([{ root: '/root', version: '0.1.2' }]);
      expect(session.promptedVersions.has('0.1.2')).toBe(true);

      const again = await maybePromptForRuntimeUpdate({
        root: '/root',
        session,
        checkFn: async () => availableCheck,
        showPromptFn: async () => { throw new Error('must not prompt twice'); },
      });
      expect(again).toMatchObject({ shown: false, reason: 'already_prompted' });
    }
  });

  it('check 读取到共享 promptedVersion 时视为已提示，不调用 showPrompt', async () => {
    let showCalls = 0;
    const result = await maybePromptForRuntimeUpdate({
      root: '/root',
      checkFn: async () => ({
        ...availableCheck,
        prompted: false,
        promptedVersion: '0.1.2',
        promptedAt: '2026-01-01T00:00:00.000Z',
      }),
      showPromptFn: async () => { showCalls += 1; return RUNTIME_UPDATE_ACTION.UPDATE; },
    });
    expect(result).toMatchObject({ shown: false, reason: 'already_prompted' });
    expect(showCalls).toBe(0);
  });

  it('只有用户点更新才调用升级；失败结果原样返回', async () => {
    const upgrades = [];
    const result = await maybePromptForRuntimeUpdate({
      root: '/root',
      checkFn: async () => availableCheck,
      showPromptFn: async () => RUNTIME_UPDATE_ACTION.UPDATE,
      performUpgradeFn: async (options) => {
        upgrades.push(options);
        return { ok: false, reason: 'service_upgrade_failed' };
      },
    });
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]).toMatchObject({ to: '0.1.2', root: '/root' });
    expect(result).toMatchObject({ shown: true, action: 'update', ok: false });
    expect(result.result.reason).toBe('service_upgrade_failed');
  });

  it('离线/失败静默；另一个入口 upgrade lock busy 不弹；App 忙不弹', async () => {
    let showCalls = 0;
    const base = {
      root: '/root',
      showPromptFn: async () => { showCalls += 1; return RUNTIME_UPDATE_ACTION.UPDATE; },
      performUpgradeFn: async () => { throw new Error('must not upgrade'); },
    };
    const offline = await maybePromptForRuntimeUpdate({
      ...base,
      checkFn: async () => ({ ok: false, status: 'offline', reason: 'offline' }),
    });
    expect(offline).toMatchObject({ shown: false, reason: 'offline' });

    const busy = await maybePromptForRuntimeUpdate({
      ...base,
      checkFn: async () => availableCheck,
      upgradeStatusFn: async () => ({ busy: true }),
    });
    expect(busy).toMatchObject({ shown: false, reason: 'entry_busy' });

    let checkCalls = 0;
    const appBusy = await maybePromptForRuntimeUpdate({
      ...base,
      checkFn: async () => { checkCalls += 1; return availableCheck; },
      isBusy: () => true,
    });
    expect(appBusy).toMatchObject({ shown: false, reason: 'entry_busy' });
    expect(checkCalls).toBe(0);
    expect(showCalls).toBe(0);
  });

  it('任务运行中不弹（hook）', async () => {
    const result = await maybePromptForRuntimeUpdate({
      root: '/root',
      checkFn: async () => availableCheck,
      hasRunningTasks: async () => true,
      showPromptFn: async () => { throw new Error('must not prompt'); },
    });
    expect(result).toMatchObject({ shown: false, reason: 'tasks_running' });
  });
});

describe('performRuntimeUpdate', () => {
  it('App child：先停自己的 child，升级后 ensure 一次（不产生第二个 daemon）', async () => {
    const calls = [];
    const result = await performRuntimeUpdate({
      root: '/root',
      home: '/home',
      to: '0.1.2',
      isChildAlive: () => true,
      stopChild: async () => { calls.push('stop'); return true; },
      waitForChildExit: async () => { calls.push('wait'); return true; },
      upgradeFn: async (options) => {
        calls.push('upgrade');
        expect(options).toMatchObject({ to: '0.1.2', entry: 'app' });
        return { ok: true, version: '0.1.2', runtimeChanged: true, serviceChanged: false };
      },
      ensureFn: async () => { calls.push('ensure'); return { mode: 'child' }; },
      upgradeStatusFn: async () => ({ busy: false }),
    });
    expect(calls).toEqual(['stop', 'wait', 'upgrade', 'ensure']);
    expect(result).toMatchObject({
      ok: true,
      version: '0.1.2',
      childStopped: true,
      restarted: true,
      ensure: { mode: 'child' },
    });
  });

  it('service 模式：不停 child，升级后 ensure/attach', async () => {
    const calls = [];
    const result = await performRuntimeUpdate({
      root: '/root',
      home: '/home',
      to: '0.1.2',
      isChildAlive: () => false,
      stopChild: async () => { calls.push('stop'); return true; },
      upgradeFn: async () => { calls.push('upgrade'); return { ok: true, serviceChanged: true }; },
      ensureFn: async () => { calls.push('ensure'); return { mode: 'service' }; },
      upgradeStatusFn: async () => ({ busy: false }),
    });
    expect(calls).toEqual(['upgrade', 'ensure']);
    expect(result).toMatchObject({ ok: true, childStopped: false, restarted: true, ensure: { mode: 'service' } });
  });

  it('升级失败：ensure 恢复旧 daemon，reason 保留', async () => {
    const calls = [];
    const result = await performRuntimeUpdate({
      root: '/root',
      home: '/home',
      to: '0.1.2',
      isChildAlive: () => true,
      stopChild: async () => { calls.push('stop'); return true; },
      waitForChildExit: async () => true,
      upgradeFn: async () => { calls.push('upgrade'); return { ok: false, reason: 'service_upgrade_failed' }; },
      ensureFn: async () => { calls.push('ensure'); return { mode: 'child' }; },
      upgradeStatusFn: async () => ({ busy: false }),
    });
    expect(calls).toEqual(['stop', 'upgrade', 'ensure']);
    expect(result).toMatchObject({
      ok: false,
      reason: 'service_upgrade_failed',
      childStopped: true,
      recovered: true,
      ensure: { mode: 'child' },
    });
  });

  it('child 停不下来 → 不升级（避免第二个 daemon）', async () => {
    let upgrades = 0;
    const result = await performRuntimeUpdate({
      root: '/root',
      to: '0.1.2',
      isChildAlive: () => true,
      stopChild: async () => false,
      upgradeFn: async () => { upgrades += 1; return { ok: true }; },
      ensureFn: async () => ({ mode: 'child' }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'child_stop_failed', childStopped: false });
    expect(upgrades).toBe(0);
  });

  it('另一个入口已在升级：不执行升级，等结束后 reconnect', async () => {
    const statuses = [{ busy: true }, { busy: false }];
    let upgrades = 0;
    let ensures = 0;
    const result = await performRuntimeUpdate({
      root: '/root',
      to: '0.1.2',
      isChildAlive: () => true,
      stopChild: async () => { throw new Error('must not stop'); },
      upgradeFn: async () => { upgrades += 1; return { ok: true }; },
      ensureFn: async () => { ensures += 1; return { mode: 'reused' }; },
      upgradeStatusFn: async () => statuses.shift() ?? { busy: false },
      reconnectTimeoutMs: 10_000,
      reconnectIntervalMs: 0,
      sleepFn: async () => undefined,
    });
    expect(upgrades).toBe(0);
    expect(ensures).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      busy: true,
      reason: 'busy',
      childStopped: false,
      reconnectRequired: false,
      ensure: { mode: 'reused' },
    });
  });

  it('预检后的竞态 busy：不重试升级，等对方结束后只 ensure 一次', async () => {
    const statuses = [{ busy: false }, { busy: false }];
    let upgrades = 0;
    let ensures = 0;
    const result = await performRuntimeUpdate({
      root: '/root',
      to: '0.1.2',
      upgradeFn: async () => {
        upgrades += 1;
        return { ok: false, busy: true, reason: 'busy' };
      },
      ensureFn: async () => { ensures += 1; return { mode: 'child' }; },
      upgradeStatusFn: async () => statuses.shift() ?? { busy: false },
      reconnectTimeoutMs: 10_000,
      reconnectIntervalMs: 0,
      sleepFn: async () => undefined,
    });
    expect(upgrades).toBe(1);
    expect(ensures).toBe(1);
    expect(result).toMatchObject({ ok: false, busy: true, reason: 'busy', reconnectRequired: false });
  });

  it('ensure 失败不丢失升级结果（App 会显示 ensure_failed）', async () => {
    const result = await performRuntimeUpdate({
      root: '/root',
      to: '0.1.2',
      upgradeFn: async () => ({ ok: true, version: '0.1.2' }),
      ensureFn: async () => { throw new Error('port in use'); },
    });
    expect(result).toMatchObject({ ok: true, version: '0.1.2', ensure: { ok: false } });
  });
});

describe('shared upgrade status / non-blocking scheduling', () => {
  it('lock 是唯一 busy 判定；state.upgrading 只作展示', async () => {
    const modules = {
      inspectRuntimeUpgradeLock: async () => ({ busy: true, stale: false, holder: { pid: 42 } }),
      readRuntimeUpgradeState: async () => ({
        source: 'main',
        state: { upgrading: true, toVersion: '0.1.2' },
      }),
    };
    const busy = await inspectSharedUpgradeStatus({ root: '/root', modules });
    expect(busy).toMatchObject({ busy: true, holder: { pid: 42 }, state: { upgrading: true } });

    const notBusy = await inspectSharedUpgradeStatus({
      root: '/root',
      modules: {
        inspectRuntimeUpgradeLock: async () => ({ busy: false, stale: true }),
        readRuntimeUpgradeState: async () => ({
          source: 'main',
          state: { upgrading: true, toVersion: '0.1.2' },
        }),
      },
    });
    expect(notBusy).toMatchObject({ busy: false, stale: true });
  });

  it('waitForSharedUpgradeIdle 有界等待并返回 settled', async () => {
    const statuses = [{ busy: true }, { busy: true }, { busy: false }];
    let now = 0;
    const idle = await waitForSharedUpgradeIdle({
      upgradeStatusFn: async () => statuses.shift() ?? { busy: false },
      timeoutMs: 100,
      intervalMs: 10,
      sleepFn: async () => { now += 10; },
      nowMs: () => now,
    });
    expect(idle).toMatchObject({ settled: true, waited: true });
  });

  it('startStartupRuntimeUpdateCheck 立即返回，run 在调度回调里执行', async () => {
    let ran = 0;
    let scheduled = null;
    const handle = startStartupRuntimeUpdateCheck({
      run: async () => { ran += 1; },
      schedule: (fn) => { scheduled = fn; return 'timer'; },
    });
    expect(handle).toBe('timer');
    expect(ran).toBe(0);
    scheduled();
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    expect(ran).toBe(1);
  });
});
