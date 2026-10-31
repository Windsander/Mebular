// 0.3 详情保留维护：MCP daemon 启动后扫描过期 DetailRecord。
//
// - 启动即跑一次，此后每 24h 一次；timer.unref，不拖住宿主退出。
// - 只调用 MemoryService.pruneExpiredDetails()：复用图 + 事件日志，不做第二套存储/同步。
// - 失败只记录到 status 并打一行日志；绝不阻断 MCP READY 或后续定时任务。
// - 同一进程内热切换 service 时复用同一个 timer/状态；当天已成功跑过则跳过重复扫描。

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(at) {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function errorCode(error) {
  return typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'ERROR';
}

/**
 * @param {{
 *   getService: () => ({ pruneExpiredDetails?: (options?: { now?: number }) => Promise<string[]> } | null),
 *   intervalMs?: number,
 *   now?: () => number,
 *   setIntervalFn?: typeof setInterval,
 *   clearIntervalFn?: typeof clearInterval,
 *   logger?: Pick<Console, 'error'>,
 * }} options
 */
export function createDetailMaintenance({
  getService,
  intervalMs = DAY_MS,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
} = {}) {
  let timer = null;
  let stopped = false;
  let activeRun = null;
  let lastAttemptAt = null;
  let lastSuccessAt = null;
  let lastSuccessDay = null;
  let lastResult = null;
  let lastError = null;

  const status = () => ({
    running: timer !== null,
    intervalMs,
    lastAttemptAt,
    lastSuccessAt,
    lastSuccessDay,
    lastResult,
    lastError,
  });

  const serviceReady = () => {
    const service = typeof getService === 'function' ? getService() : null;
    return Boolean(service) && typeof service.pruneExpiredDetails === 'function';
  };

  const runOnce = ({ reason = 'startup', force = false } = {}) => {
    if (stopped) return Promise.resolve(null);
    if (activeRun) return activeRun;
    if (!serviceReady()) return Promise.resolve(null);
    const service = getService();
    const at = now();
    const day = dayKey(at);
    if (!force && lastSuccessDay === day) {
      return Promise.resolve({ skipped: true, reason: 'already_ran_today', day });
    }
    lastAttemptAt = at;
    activeRun = (async () => {
      try {
        const pruned = await service.pruneExpiredDetails({ now: at });
        lastSuccessAt = at;
        lastSuccessDay = day;
        lastResult = {
          reason,
          pruned: Array.isArray(pruned) ? pruned.length : 0,
          at,
        };
        lastError = null;
        return lastResult;
      } catch (error) {
        lastError = {
          reason,
          code: errorCode(error),
          message: String(error?.message ?? error),
          at,
        };
        logger?.error?.(`DETAIL_MAINTENANCE_FAILED ${lastError.code} ${lastError.message}`);
        return lastError;
      } finally {
        activeRun = null;
      }
    })();
    return activeRun;
  };

  const start = () => {
    if (stopped) return status();
    if (timer === null && serviceReady()) {
      timer = setIntervalFn(() => {
        void runOnce({ reason: 'interval' });
      }, intervalMs);
      timer?.unref?.();
    }
    // 启动/热切换都尝试一次；当天已成功跑过时会直接跳过。
    void runOnce({ reason: timer === null ? 'service_pending' : 'startup' });
    return status();
  };

  const stop = () => {
    stopped = true;
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
    return status();
  };

  const idle = () => activeRun ?? Promise.resolve(null);

  return {
    start,
    stop,
    runOnce,
    idle,
    status,
    serviceReady,
  };
}

export const DETAIL_MAINTENANCE_INTERVAL_MS = DAY_MS;
