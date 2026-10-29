// /runtime/v1 HTTP API（0.3.0 G0/G1）
//
// 只挂 status 与 mode 两个端点；复用 serve 现有 bearer/OAuth + scope：
//   GET  /runtime/v1/status  memory.read
//   POST /runtime/v1/mode    memory.admin
//
// 响应使用契约统一信封：
//   { ok:true, requestId, data, warnings:[] }
//   { ok:false, requestId, error:{ code, message, retryable, details? } }
//
// 不新增 MCP 工具。ingest/recall/context/... 留给后续执行会话。

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeService, RuntimeModeError } from '@mebular/core';
import { configPath } from './config.mjs';

export const RUNTIME_API_PREFIX = '/runtime/v1';

export function isRuntimePath(path) {
  return path === RUNTIME_API_PREFIX || path.startsWith(`${RUNTIME_API_PREFIX}/`);
}

/**
 * 构造最小 RuntimeService。runtimeDir 固定为 `<home>/runtime`，本地 Raw/Trace 不进入图。
 * @param {{ app: object, config?: object, home: string, version?: string, hostKey?: string, profileId?: string|null }} options
 */
export function buildRuntimeService({ app, config = {}, home, version, hostKey, profileId = null }) {
  return new RuntimeService(app, {
    runtime: config?.runtime,
    runtimeDir: join(home, 'runtime'),
    hostKey: hostKey ?? home,
    profileId,
    ...(version ? { version } : {}),
  });
}

/**
 * 原子持久化 `runtime.mode`（保留配置其余字段；写前备份 .bak）。
 * 独立于 RuntimeService，便于测试与后续 CLI/Console 复用。
 */
export async function persistRuntimeMode({ home, mode, configFile = null }) {
  const file = configFile ?? configPath(home);
  let current = {};
  try {
    current = JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    current = {};
  }
  const merged = current && typeof current === 'object' && !Array.isArray(current)
    ? JSON.parse(JSON.stringify(current))
    : {};
  const runtime = merged.runtime && typeof merged.runtime === 'object' && !Array.isArray(merged.runtime)
    ? merged.runtime
    : {};
  merged.runtime = { ...runtime, mode };

  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(merged, null, 2), 'utf-8');
    if (existsSync(file)) await copyFile(file, `${file}.bak`);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    const wrapped = new Error(`Runtime 模式写入失败：${String(error?.message ?? error)}`);
    wrapped.code = 'runtime_mode_persist_failed';
    throw wrapped;
  }
  return merged;
}

function requestIdOf(req) {
  const incoming = req?.headers?.['x-request-id'];
  return typeof incoming === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)
    ? incoming
    : `req_${randomUUID()}`;
}

function parseJsonBody(body) {
  if (!body || body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf-8'));
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   getService: () => RuntimeService|null,
 *   getConfig?: () => object,
 *   onModeChanged?: (mode: string) => void,
 *   home: string,
 *   configFile?: string|null,
 *   authenticate: (req: object, body: Buffer, scope: string) => Promise<object>,
 *   sendJson: (res: object, status: number, body: object) => void,
 *   origin?: () => string,
 *   csrfValid?: (req: object) => boolean,
 *   persistMode?: (args: {home: string, mode: string, configFile?: string|null}) => Promise<object>
 * }} options
 */
export function createRuntimeHttpHandler({
  getService,
  getConfig,
  onModeChanged,
  home,
  configFile = null,
  authenticate,
  sendJson,
  origin,
  csrfValid,
  persistMode = persistRuntimeMode,
}) {
  return async function handleRuntimeRequest({ req, res, url, body }) {
    const path = url.pathname;
    if (!isRuntimePath(path)) return false;

    const requestId = requestIdOf(req);
    res.setHeader('x-request-id', requestId);

    const sendOk = (data, warnings = []) => {
      sendJson(res, 200, { ok: true, requestId, data, warnings });
      return true;
    };
    const sendError = (status, code, message, details, retryable = false) => {
      sendJson(res, status, {
        ok: false,
        requestId,
        error: {
          code,
          message,
          retryable,
          ...(details !== undefined ? { details } : {}),
        },
      });
      return true;
    };

    const service = (() => {
      try {
        return getService?.() ?? null;
      } catch {
        return null;
      }
    })();
    if (service) res.setHeader('x-mebular-mode', service.getMode());

    if (path === `${RUNTIME_API_PREFIX}/status`) {
      if (req.method !== 'GET') return sendError(405, 'method_not_allowed', 'status 仅接受 GET');
      if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
      const check = await authenticate(req, Buffer.alloc(0), 'memory.read');
      if (!check.ok) {
        if (check.challenge) res.setHeader('www-authenticate', check.challenge);
        return sendError(
          check.status ?? 401,
          check.status === 403 ? 'forbidden_scope' : 'unauthorized',
          check.message ?? 'unauthorized',
        );
      }
      const data = await service.status();
      res.setHeader('x-mebular-degraded', String(data?.model?.degraded === true));
      return sendOk(data, Array.isArray(data?.warnings) ? data.warnings : []);
    }

    if (path === `${RUNTIME_API_PREFIX}/mode`) {
      if (req.method !== 'POST') return sendError(405, 'method_not_allowed', 'mode 仅接受 POST');
      if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
      const check = await authenticate(req, body ?? Buffer.alloc(0), 'memory.admin');
      if (!check.ok) {
        if (check.challenge) res.setHeader('www-authenticate', check.challenge);
        return sendError(
          check.status ?? 401,
          check.status === 403 ? 'forbidden_scope' : 'unauthorized',
          check.message ?? 'unauthorized',
        );
      }
      // 浏览器同源 cookie 调用沿用控制台 CSRF 姿态；纯 bearer/CLI 无 Origin/Cookie 不受影响。
      const reqOrigin = req.headers?.origin;
      if (typeof reqOrigin === 'string' && reqOrigin.length > 0
        && typeof origin === 'function' && reqOrigin !== origin()) {
        return sendError(403, 'forbidden', `跨站点写被拒（Origin=${reqOrigin}）`);
      }
      if (typeof req.headers?.cookie === 'string' && typeof csrfValid === 'function' && !csrfValid(req)) {
        return sendError(403, 'forbidden', 'CSRF token 缺失或无效');
      }
      const payload = parseJsonBody(body);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || (payload.mode !== 'mcp' && payload.mode !== 'immersive')) {
        return sendError(400, 'invalid_request', '需要 { mode: "mcp" | "immersive" }');
      }

      const previous = service.getMode();
      let result;
      try {
        result = await service.setMode(payload.mode);
      } catch (error) {
        if (error instanceof RuntimeModeError || error?.code === 'invalid_mode') {
          return sendError(400, 'invalid_request', String(error?.message ?? 'invalid mode'));
        }
        return sendError(500, 'internal', '模式切换失败', undefined, true);
      }

      try {
        await persistMode({
          home,
          mode: payload.mode,
          ...(configFile !== null ? { configFile } : {}),
        });
        if (typeof onModeChanged === 'function') onModeChanged(payload.mode, getConfig?.());
      } catch {
        // 持久化失败：回滚内存模式，避免「返回成功但重启后丢失」。
        await service.setMode(previous).catch(() => undefined);
        return sendError(500, 'storage_failed', '模式写入失败，已回滚', undefined, true);
      }

      res.setHeader('x-mebular-mode', result.mode);
      return sendOk(result);
    }

    return sendError(404, 'not_found', `未知 Runtime 路径：${path}`);
  };
}
