// U-1 · CSRF 403 自愈（长开页面 / 守护重启后旧 token）：
//   - 只对「403 + CSRF token 缺失或无效」触发；
//   - 重取一次 token 后原样重试一次；表单 body 不重建、不重复提交；
//   - 恢复失败 / 重试仍 403 → 统一友好文案（不无限重试）。

import { describe, expect, it } from '@jest/globals';
import {
  CSRF_ERROR_MESSAGE,
  CSRF_RETRY_FAILED_MESSAGE,
  csrfRetryError,
  isCsrfFailure,
  refreshCsrfToken,
  withCsrfRetry,
} from '../../packages/console/settings-ia.js';

const csrf403 = (payload = { error: 'forbidden', message: CSRF_ERROR_MESSAGE }) => {
  const error = new Error(payload.message ?? CSRF_ERROR_MESSAGE);
  error.status = 403;
  error.payload = payload;
  return error;
};

describe('U-1 CSRF 自愈', () => {
  it('只识别服务端明确的 CSRF 403（scope/其它 403 不触发）', () => {
    expect(isCsrfFailure(csrf403())).toBe(true);
    const scope = new Error('需要 memory.admin');
    scope.status = 403;
    expect(isCsrfFailure(scope)).toBe(false);
    expect(isCsrfFailure(new Error(CSRF_ERROR_MESSAGE))).toBe(false);
  });

  it('旧 token → 恢复一次 → 原 body 重试一次成功（无重复提交）', async () => {
    const body = { patch: { 'joinService.bind': '127.0.0.1' } };
    const attempts = [];
    let recoveries = 0;
    const result = await withCsrfRetry(
      async () => {
        attempts.push(body);
        if (attempts.length === 1) throw csrf403();
        return { ok: true };
      },
      async () => {
        recoveries += 1;
        return 'new-token';
      },
    );
    expect(result).toEqual({ ok: true });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(body); // 同一份表单内容，不重建 body
    expect(recoveries).toBe(1);
  });

  it('恢复失败 → 友好文案，且不发出第二次写', async () => {
    let sends = 0;
    await expect(withCsrfRetry(
      async () => { sends += 1; throw csrf403(); },
      async () => null,
    )).rejects.toMatchObject({
      message: CSRF_RETRY_FAILED_MESSAGE,
      status: 403,
      csrfRetry: true,
    });
    expect(sends).toBe(1);
  });

  it('重试仍 CSRF 403 → 友好文案（不做无限重试）', async () => {
    let sends = 0;
    await expect(withCsrfRetry(
      async () => { sends += 1; throw csrf403(); },
      async () => 'new-token',
    )).rejects.toMatchObject({ message: CSRF_RETRY_FAILED_MESSAGE, csrfRetry: true });
    expect(sends).toBe(2);
  });

  it('非 CSRF 失败原样抛出（保留服务端错误）', async () => {
    const original = new Error('字段不合法');
    original.status = 400;
    await expect(withCsrfRetry(async () => { throw original; }, async () => 'unused')).rejects.toBe(original);
  });

  it('csrfRetryError 保留原状态码与载荷', () => {
    const cause = csrf403({ error: 'forbidden', message: CSRF_ERROR_MESSAGE, detail: 'x' });
    const friendly = csrfRetryError(cause);
    expect(friendly.message).toBe(CSRF_RETRY_FAILED_MESSAGE);
    expect(friendly.status).toBe(403);
    expect(friendly.payload).toBe(cause.payload);
    expect(friendly.cause).toBe(cause);
  });

  it('重取 token：优先响应头；失败回退 cookie；非 2xx 返回 null', async () => {
    const headerFetch = async () => ({ ok: true, headers: { get: (name) => (name === 'x-mebular-csrf' ? 'header-token' : null) } });
    expect(await refreshCsrfToken({ fetchImpl: headerFetch, readCookie: () => 'cookie-token' })).toBe('header-token');

    const cookieFetch = async () => ({ ok: true, headers: { get: () => null } });
    expect(await refreshCsrfToken({ fetchImpl: cookieFetch, readCookie: (name) => (name === 'mebular_csrf' ? 'cookie-token' : null) })).toBe('cookie-token');

    const failFetch = async () => ({ ok: false, headers: { get: () => null } });
    expect(await refreshCsrfToken({ fetchImpl: failFetch, readCookie: () => 'cookie-token' })).toBe(null);
  });
});
