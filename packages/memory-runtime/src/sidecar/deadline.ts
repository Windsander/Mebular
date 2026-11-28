// 0.4.0 W5：`/context` 延迟预算的共享常量。
//
// 只放纯常量/纯函数；不读配置、不读时钟，避免和 sidecar 生命周期耦合。

/** `/context` 单次绝对 deadline 上限（W0-A §6.1，冻结）。 */
export const CONTEXT_DEADLINE_MAX_MS = 1500;
/** 允许配置的最小 deadline；低于它没有意义，直接 clamp。 */
export const CONTEXT_DEADLINE_MIN_MS = 200;
/** 响应组装/序列化预留；planner 预算必须在它之前结束。 */
export const CONTEXT_RESPONSE_RESERVE_MS = 150;
/** trace 写入预留；来不及写就 skip-on-deadline。 */
export const CONTEXT_TRACE_RESERVE_MS = 50;
/** 剩余预算低于该值时直接 heuristic，不再启动模型（W0-A §6.1）。 */
export const MIN_PLANNER_BUDGET_MS = 200;

export function clampContextDeadline(value: number): number {
  if (!Number.isFinite(value)) return CONTEXT_DEADLINE_MAX_MS;
  return Math.max(CONTEXT_DEADLINE_MIN_MS, Math.min(CONTEXT_DEADLINE_MAX_MS, Math.floor(value)));
}

export type DeadlineOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; timedOut: boolean };

/**
 * 用绝对 deadline 等待一个 promise；超时不会取消底层调用。
 * 立即挂上 then/catch，避免超时后的迟到 rejection 变成 unhandled。
 */
export function awaitWithinDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number | undefined,
  now: () => number = Date.now,
): Promise<DeadlineOutcome<T>> {
  if (deadlineAt === undefined) {
    return promise.then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, timedOut: false }),
    );
  }
  const remaining = deadlineAt - now();
  if (remaining <= 0) {
    void promise.catch(() => undefined);
    return Promise.resolve({ ok: false, timedOut: true });
  }
  return new Promise<DeadlineOutcome<T>>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, timedOut: true });
    }, remaining);
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, timedOut: false });
      },
    );
  });
}
