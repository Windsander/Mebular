// 忆云切换共享引擎：停旧 → 写 current → 起新 → 健康校验 →（失败）回滚旧。
//
// 进程生命周期归 App/CLI supervisor：本模块不 spawn、不杀进程、不装服务，只编排注入的
// stop/start/verify 适配器。App 与 `mebular cloud use` 共用本引擎，避免两套状态机。
//
// 关键纪律（SPEC §4.2）：
//   - 停旧成功后、起新之前写 `switch.intent.json` + 注册表 current=to（崩溃时按新档案恢复）；
//   - 新守护健康才删除 intent、更新 lastUsedAt；
//   - 起新失败：current 回滚 from、尝试重新起旧、保留已注册的新档案（永不删除）。

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  cloudError,
  profileHomeForEntry,
  readRegistry,
  setCurrentProfile,
} from './profiles.mjs';

export const SWITCH_INTENT_FILE = 'switch.intent.json';

export function switchIntentPath(root) {
  return join(root, SWITCH_INTENT_FILE);
}

/** 原子写 intent（tmp → rename，0600）。 */
export async function writeSwitchIntent(root, intent) {
  await mkdir(root, { recursive: true });
  const path = switchIntentPath(root);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readSwitchIntent(root) {
  try {
    const parsed = JSON.parse(await readFile(switchIntentPath(root), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearSwitchIntent(root) {
  await rm(switchIntentPath(root), { force: true }).catch(() => undefined);
}

function assertAdapters({ stop, start, verify }) {
  for (const [name, fn] of [['stop', stop], ['start', start], ['verify', verify]]) {
    if (typeof fn !== 'function') {
      throw cloudError('SWITCH_ADAPTER_REQUIRED', `切换引擎缺少 ${name} 适配器`);
    }
  }
}

/**
 * 执行一次忆云切换。
 *
 * 适配器契约（App / CLI 各自实现）：
 *   stop({ root, from, to, fromHome, toHome })   → 停旧（child/service/external）；失败必须 throw
 *   start({ root, from, to, fromHome, toHome, rollback }) → 起「to」；失败必须 throw
 *   verify({ root, from, to, home, rollback })   → 健康校验；返回 false / {ok:false} 视为失败
 *   abort({ root, from, to, fromHome, toHome })  → 可选：起新失败后停掉半启动的目标（防双活）
 *
 * 返回 { ok, changed, current, previous, profile, home, warning? }。
 * 失败时：current 回滚 from、intent 清理；目标档案目录与注册条目保留。
 */
export async function switchProfile({
  root,
  id,
  stop,
  start,
  verify,
  abort = null,
  now = () => new Date().toISOString(),
}) {
  assertAdapters({ stop, start, verify });

  const state = await readRegistry(root);
  const from = state.registry.current;
  const target = state.registry.profiles.find((profile) => profile.id === id) ?? null;
  if (!target) throw cloudError('PROFILE_NOT_FOUND', `未找到忆云：${id}`);
  if (from === id) {
    return { ok: true, changed: false, current: from, previous: null, profile: target, home: profileHomeForEntry(root, target) };
  }
  const previous = state.registry.profiles.find((profile) => profile.id === from) ?? null;
  const targetHome = profileHomeForEntry(root, target);
  if (!existsSync(targetHome)) {
    throw cloudError('PROFILE_HOME_MISSING', `忆云「${target.name}」的目录不存在：${targetHome}`);
  }
  const previousHome = previous ? profileHomeForEntry(root, previous) : null;

  await writeSwitchIntent(root, { from, to: id, at: now(), phase: 'stopping' });
  try {
    await stop({ root, from: previous, to: target, fromHome: previousHome, toHome: targetHome });
  } catch (error) {
    await clearSwitchIntent(root);
    throw error;
  }

  try {
    await setCurrentProfile(root, id);
  } catch (error) {
    // 旧已停、注册表写失败：尽量把旧守护拉回来，current 保持旧值。
    let rollbackOk = true;
    let rollbackError = null;
    try {
      await start({ root, from: target, to: previous, fromHome: targetHome, toHome: previousHome, rollback: true });
      if (previous) {
        const verified = await verify({ root, from: target, to: previous, home: previousHome, rollback: true });
        if (verified === false || (verified && typeof verified === 'object' && verified.ok === false)) {
          rollbackOk = false;
          rollbackError = '旧忆云健康校验失败';
        }
      }
    } catch (rollbackFailure) {
      rollbackOk = false;
      rollbackError = rollbackFailure;
    }
    await clearSwitchIntent(root);
    throw cloudError(
      'CLOUD_SWITCH_FAILED',
      `注册表写入失败，切换未开始${rollbackOk ? '；已恢复旧忆云' : `；旧忆云恢复失败：${rollbackError?.message ?? rollbackError}`}`,
      { cause: error, rollback: { ok: rollbackOk, error: rollbackError?.message ?? null, current: from } },
    );
  }

  await writeSwitchIntent(root, { from, to: id, at: now(), phase: 'starting' });
  try {
    await start({ root, from: previous, to: target, fromHome: previousHome, toHome: targetHome });
    const result = await verify({ root, from: previous, to: target, home: targetHome });
    if (result === false || (result && typeof result === 'object' && result.ok === false)) {
      throw cloudError('CLOUD_SWITCH_FAILED', `新忆云「${target.name}」健康校验失败`);
    }
  } catch (error) {
    await writeSwitchIntent(root, { from, to: id, at: now(), phase: 'rolling_back' }).catch(() => undefined);
    let rollbackOk = true;
    let rollbackError = null;
    // 起新失败/健康校验失败：先停掉可能已半启动的新忆云，避免回滚时双活。
    // abort 失败不阻断「重新起旧」的尝试（否则会留下两边都没起的最坏状态）。
    if (typeof abort === 'function') {
      try {
        await abort({ root, from: previous, to: target, fromHome: previousHome, toHome: targetHome });
      } catch (abortFailure) {
        rollbackOk = false;
        rollbackError = `停止新忆云失败：${abortFailure?.message ?? abortFailure}`;
      }
    }
    try {
      if (previous) await setCurrentProfile(root, from);
      await start({ root, from: target, to: previous, fromHome: targetHome, toHome: previousHome, rollback: true });
      if (previous) {
        const verified = await verify({ root, from: target, to: previous, home: previousHome, rollback: true });
        if (verified === false || (verified && typeof verified === 'object' && verified.ok === false)) {
          rollbackOk = false;
          rollbackError = rollbackError ?? '旧忆云健康校验失败';
        }
      }
    } catch (rollbackFailure) {
      rollbackOk = false;
      rollbackError = rollbackFailure?.message ?? String(rollbackFailure);
    }
    await clearSwitchIntent(root);
    const message = rollbackOk
      ? `新忆云「${target.name}」启动失败，已切回「${previous?.name ?? '旧忆云'}」；可稍后重试`
      : `新忆云「${target.name}」启动失败，且回滚也失败（${rollbackError}）：请检查诊断`;
    throw cloudError('CLOUD_SWITCH_FAILED', message, {
      cause: error,
      rollback: { ok: rollbackOk, error: rollbackError, current: rollbackOk ? from : null },
      kept: id,
    });
  }

  let warning = null;
  try {
    await setCurrentProfile(root, id, { lastUsedAt: now() });
  } catch (error) {
    warning = `切换已生效，但 lastUsedAt 更新失败：${error?.message ?? error}`;
  }
  await clearSwitchIntent(root);
  return {
    ok: true,
    changed: true,
    current: id,
    previous: previous?.id ?? null,
    profile: target,
    home: targetHome,
    ...(warning ? { warning } : {}),
  };
}

/**
 * 服务托管描述符：ServiceOptions.home 用 OS home；档案身份由 env.MEBULAR_HOME +
 * env.MEBULAR_CLOUD_ROOT + heartbeatDir 携带（SPEC §4.3）。
 */
export function profileServiceDescriptor({
  root,
  home,
  cliBin,
  execPath = process.execPath,
  extraArgs = [],
}) {
  if (typeof cliBin !== 'string' || cliBin.length === 0) {
    throw cloudError('SERVICE_DESCRIPTOR_INVALID', '缺少 CLI 入口路径');
  }
  return {
    kind: 'mebular-serve',
    args: [cliBin, 'serve', ...extraArgs],
    heartbeatDir: home,
    workingDir: home,
    execPath,
    env: { MEBULAR_HOME: home, MEBULAR_CLOUD_ROOT: root },
  };
}

async function serviceLib(deps) {
  if (deps) return deps;
  return import('@mebular/service');
}

export async function profileServiceStatus({ descriptor, serviceHome = homedir(), deps } = {}) {
  const lib = await serviceLib(deps);
  return lib.serviceStatus(descriptor, { home: serviceHome });
}

/** 停旧服务单元（bootout + 删旧 unit/manifest）；未安装时幂等返回 removed:false。 */
export async function uninstallProfileService({ descriptor, serviceHome = homedir(), deps } = {}) {
  const lib = await serviceLib(deps);
  return lib.uninstallService(descriptor, { home: serviceHome });
}

/** 装新服务单元；必须 ok && started（不能只看命令退出码）。 */
export async function installProfileService({
  descriptor,
  serviceHome = homedir(),
  autostart = true,
  deps,
} = {}) {
  const lib = await serviceLib(deps);
  const result = lib.installService(descriptor, { home: serviceHome, autostart });
  if (!result?.ok || result?.started !== true) {
    throw cloudError(
      'SERVICE_START_FAILED',
      `服务安装失败或未启动：${result?.message ?? result?.note ?? '未知原因'}`,
      { result },
    );
  }
  return result;
}
