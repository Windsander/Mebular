// /runtime/v1 HTTP API（0.3.0 contract §6）
//
// 与 /mcp 同端口、同 bearer/OAuth + scope：
//   GET    /status                       memory.read
//   POST   /mode                         memory.admin
//   POST   /ingest                       memory.write
//   GET    /extractions/:id              memory.read
//   POST   /extractions/:id              memory.write
//   POST   /recall                       memory.read
//   POST   /context                      memory.read
//   GET    /checkpoints/:threadId        memory.read
//   PUT    /checkpoints/:threadId        memory.write
//   DELETE /checkpoints/:threadId        memory.admin
//   POST   /compact                      memory.admin
//   GET    /compacts/:id                 memory.read
//   GET    /self/:agentId                memory.read
//   PUT    /self/:agentId                memory.write
//   POST   /recall/:traceId/feedback     memory.write
//   GET    /objects/:id                  memory.admin
//   GET    /traces                       memory.admin
//   GET    /traces/:id                   memory.admin
//
// 响应使用统一信封：
//   { ok:true, requestId, data, warnings:[] }
//   { ok:false, requestId, error:{ code, message, retryable, details? } }
//
// mode=mcp 时写端点返回 409 mode_mismatch；读端点保持可用。不新增 MCP 工具。

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configPath } from './config.mjs';

// 开发/工作树里 `@mebular/core` 可能经 node_modules 指向旧包；优先使用包内
// 当前构建产物，保证 RuntimeService 与源码同版本（发布包里二者等价）。
async function loadCoreRuntime() {
  try {
    const core = await import('@mebular/core');
    if (typeof core.RuntimeService === 'function') {
      return { RuntimeService: core.RuntimeService, RuntimeModeError: core.RuntimeModeError };
    }
  } catch {
    // 回退到本包 dist
  }
  const fallback = await import(new URL('../../../dist/index.js', import.meta.url).href);
  return { RuntimeService: fallback.RuntimeService, RuntimeModeError: fallback.RuntimeModeError };
}

const { RuntimeService, RuntimeModeError } = await loadCoreRuntime();

export const RUNTIME_API_PREFIX = '/runtime/v1';
const MAX_RUNTIME_BODY_BYTES = 2 * 1024 * 1024;

export function isRuntimePath(path) {
  return path === RUNTIME_API_PREFIX || path.startsWith(`${RUNTIME_API_PREFIX}/`);
}

/**
 * 构造 RuntimeService。runtimeDir 固定为 `<home>/runtime`，本地 Raw/Trace 不进入图。
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

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodePath(path) {
  return path
    .slice(RUNTIME_API_PREFIX.length)
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

function queryFlag(url, name) {
  return url?.searchParams?.get(name) === '1' || url?.searchParams?.get(name) === 'true';
}

function querySync(url) {
  const value = url?.searchParams?.get('sync');
  return value === 'local' || value === 'cloud' ? value : undefined;
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
  // 写请求 Idempotency-Key：同 key 重放返回首次成功结果；进程内 24h。
  const idempotentWrites = new Map();

  return async function handleRuntimeRequest({ req, res, url, body }) {
    const path = url.pathname;
    if (!isRuntimePath(path)) return false;

    const requestId = requestIdOf(req);
    res.setHeader('x-request-id', requestId);

    const sendOk = (data, warnings = [], status = 200) => {
      sendJson(res, status, { ok: true, requestId, data, warnings });
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
    res.setHeader('x-mebular-degraded', 'false');

    if (body && body.length > MAX_RUNTIME_BODY_BYTES) {
      return sendError(413, 'payload_too_large', `请求体超过 ${MAX_RUNTIME_BODY_BYTES} 字节`);
    }

    const authorize = async (scope) => {
      const check = await authenticate(req, body ?? Buffer.alloc(0), scope);
      if (check.ok) return true;
      if (check.challenge) res.setHeader('www-authenticate', check.challenge);
      sendError(
        check.status ?? 401,
        check.status === 403 ? 'forbidden_scope' : 'unauthorized',
        check.message ?? 'unauthorized',
      );
      return false;
    };

    // 浏览器同源 cookie 调用沿用控制台 CSRF 姿态；纯 bearer/CLI 不受影响。
    const guardBrowserWrite = () => {
      const reqOrigin = req.headers?.origin;
      if (typeof reqOrigin === 'string' && reqOrigin.length > 0
        && typeof origin === 'function' && reqOrigin !== origin()) {
        sendError(403, 'forbidden', `跨站点写被拒（Origin=${reqOrigin}）`);
        return false;
      }
      if (typeof req.headers?.cookie === 'string' && typeof csrfValid === 'function' && !csrfValid(req)) {
        sendError(403, 'forbidden', 'CSRF token 缺失或无效');
        return false;
      }
      return true;
    };

    const ensureMode = () => {
      if (service.getMode() !== 'mcp') return true;
      sendError(409, 'mode_mismatch', '当前为轻量 MCP 模式，写端点不可用', { mode: 'mcp' });
      return false;
    };

    const idempotencyKey = () => {
      if (req.method === 'GET' || req.method === 'HEAD') return null;
      const key = req.headers?.['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return null;
      return `${req.method}:${path}:${key}`;
    };

    const replayIdempotent = (key) => {
      if (!key) return false;
      const entry = idempotentWrites.get(key);
      if (!entry) return false;
      if (Date.now() - entry.at > 24 * 60 * 60 * 1000) {
        idempotentWrites.delete(key);
        return false;
      }
      return sendOk(entry.data, entry.warnings, entry.status);
    };

    const rememberIdempotent = (key, data, warnings, status = 200) => {
      if (!key) return;
      idempotentWrites.set(key, { at: Date.now(), data, warnings, status });
      if (idempotentWrites.size > 500) {
        const oldest = idempotentWrites.keys().next().value;
        if (oldest !== undefined) idempotentWrites.delete(oldest);
      }
    };

    const sendServiceError = (error) => {
      if (error instanceof RuntimeModeError || error?.code === 'invalid_mode') {
        return sendError(400, 'invalid_request', String(error?.message ?? 'invalid mode'));
      }
      const known = typeof error?.code === 'string' && typeof error?.status === 'number';
      if (known) {
        return sendError(
          error.status,
          error.code,
          typeof error.message === 'string' && error.message.length > 0 ? error.message : 'Runtime 请求失败',
          error.details,
          error.retryable === true,
        );
      }
      return sendError(500, 'internal', 'Runtime 请求失败', undefined, true);
    };

    const requireBodyObject = () => {
      const payload = parseJsonBody(body);
      if (!isObject(payload)) {
        sendError(400, 'invalid_request', '请求体必须是 JSON 对象');
        return null;
      }
      return payload;
    };

    try {
      if (path === `${RUNTIME_API_PREFIX}/status`) {
        if (req.method !== 'GET') return sendError(405, 'method_not_allowed', 'status 仅接受 GET');
        if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
        if (!await authorize('memory.read')) return true;
        const data = await service.status();
        res.setHeader('x-mebular-degraded', String(data?.model?.degraded === true));
        return sendOk(data, Array.isArray(data?.warnings) ? data.warnings : []);
      }

      if (path === `${RUNTIME_API_PREFIX}/mode`) {
        if (req.method !== 'POST') return sendError(405, 'method_not_allowed', 'mode 仅接受 POST');
        if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
        if (!await authorize('memory.admin')) return true;
        if (!guardBrowserWrite()) return true;
        const payload = requireBodyObject();
        if (!payload) return true;
        if (payload.mode !== 'mcp' && payload.mode !== 'immersive') {
          return sendError(400, 'invalid_request', '需要 { mode: "mcp" | "immersive" }');
        }

        const previous = service.getMode();
        let result;
        try {
          result = await service.setMode(payload.mode);
        } catch (error) {
          return sendServiceError(error);
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

      const parts = decodePath(path);

      if (parts.length === 1 && parts[0] === 'ingest') {
        if (req.method !== 'POST') return sendError(405, 'method_not_allowed', 'ingest 仅接受 POST');
        if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
        if (!await authorize('memory.write')) return true;
        if (!guardBrowserWrite()) return true;
        if (!ensureMode()) return true;
        const key = idempotencyKey();
        if (replayIdempotent(key)) return true;
        const payload = requireBodyObject();
        if (!payload) return true;
        const result = await service.ingest(payload);
        const status = result?.extraction?.status === 'pending' ? 202 : 200;
        res.setHeader('x-mebular-degraded', String(
          result?.degraded === true || result?.extraction?.degraded === true,
        ));
        rememberIdempotent(key, result, result?.warnings ?? [], status);
        return sendOk(result, result?.warnings ?? [], status);
      }

      if (parts.length === 2 && parts[0] === 'extractions') {
        if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
        const id = parts[1];
        if (req.method === 'GET') {
          if (!await authorize('memory.read')) return true;
          const extraction = await service.getExtraction(id);
          if (!extraction) return sendError(404, 'not_found', '抽取任务不存在');
          return sendOk(extraction, extraction.warnings ?? []);
        }
        if (req.method === 'POST') {
          if (!await authorize('memory.write')) return true;
          if (!guardBrowserWrite()) return true;
          if (!ensureMode()) return true;
          const key = idempotencyKey();
          if (replayIdempotent(key)) return true;
          const payload = requireBodyObject();
          if (!payload) return true;
          if (!Array.isArray(payload.candidates)) {
            return sendError(400, 'invalid_request', '需要 { candidates: CandidateRecord[] }');
          }
          const result = await service.completeExtraction(id, payload.candidates);
          res.setHeader('x-mebular-degraded', String(result?.degraded === true));
          rememberIdempotent(key, result, result.warnings ?? []);
          return sendOk(result, result.warnings ?? []);
        }
        return sendError(405, 'method_not_allowed', 'extractions 仅接受 GET/POST');
      }

      if (parts.length === 1 && parts[0] === 'recall') {
        if (req.method !== 'POST') return sendError(405, 'method_not_allowed', 'recall 仅接受 POST');
        if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
        if (!await authorize('memory.read')) return true;
        const payload = requireBodyObject();
        if (!payload) return true;
        const result = await service.recall(payload);
        res.setHeader('x-mebular-degraded', String(result?.degraded === true));
        return sendOk(result, result?.warnings ?? []);
      }

      if (parts.length === 1 && parts[0] === 'context') {
        if (req.method !== 'POST') return sendError(405, 'method_not_allowed', 'context 仅接受 POST');
        if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
        if (!await authorize('memory.read')) return true;
        const payload = requireBodyObject();
        if (!payload) return true;
        const result = await service.context(payload);
        res.setHeader('x-mebular-degraded', String(result?.degraded === true));
        return sendOk(result, result?.warnings ?? []);
      }

      if (parts.length === 2 && parts[0] === 'checkpoints') {
        if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
        const threadId = parts[1];
        const agentId = url.searchParams.get('agentId') ?? service.getAgentId();
        if (req.method === 'GET') {
          if (!await authorize('memory.read')) return true;
          const sync = querySync(url);
          const result = await service.getCheckpoint(threadId, agentId, sync ? { sync } : {});
          return sendOk(result);
        }
        if (req.method === 'PUT') {
          const raw = parseJsonBody(body);
          if (!isObject(raw)) return sendError(400, 'invalid_request', '请求体必须是 JSON 对象');
          if (!await authorize(raw.force === true ? 'memory.admin' : 'memory.write')) return true;
          if (!guardBrowserWrite()) return true;
          if (!ensureMode()) return true;
          const key = idempotencyKey();
          if (replayIdempotent(key)) return true;
          const result = await service.putCheckpoint(threadId, raw);
          rememberIdempotent(key, result, []);
          return sendOk(result);
        }
        if (req.method === 'DELETE') {
          if (!await authorize('memory.admin')) return true;
          if (!guardBrowserWrite()) return true;
          if (!ensureMode()) return true;
          const key = idempotencyKey();
          if (replayIdempotent(key)) return true;
          const sync = querySync(url);
          const result = await service.deleteCheckpoint(threadId, agentId, sync ? { sync } : {});
          rememberIdempotent(key, result, []);
          return sendOk(result);
        }
        return sendError(405, 'method_not_allowed', 'checkpoints 仅接受 GET/PUT/DELETE');
      }

      if (parts.length === 1 && parts[0] === 'compact') {
        if (req.method !== 'POST') return sendError(405, 'method_not_allowed', 'compact 仅接受 POST');
        if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
        if (!await authorize('memory.admin')) return true;
        if (!guardBrowserWrite()) return true;
        if (!ensureMode()) return true;
        const key = idempotencyKey();
        if (replayIdempotent(key)) return true;
        const payload = requireBodyObject();
        if (!payload) return true;
        const result = await service.compact(payload);
        res.setHeader('x-mebular-degraded', String(result?.degraded === true));
        rememberIdempotent(key, result, result?.warnings ?? []);
        return sendOk(result, result?.warnings ?? []);
      }

      if (parts.length === 2 && parts[0] === 'compacts') {
        if (req.method !== 'GET') return sendError(405, 'method_not_allowed', 'compacts 仅接受 GET');
        if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
        if (!await authorize('memory.read')) return true;
        const compact = await service.getCompact(parts[1]);
        if (!compact) return sendError(404, 'not_found', 'compact 不存在');
        return sendOk({ compact });
      }

      if (parts.length === 2 && parts[0] === 'self') {
        if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
        const agentId = parts[1];
        if (req.method === 'GET') {
          if (!await authorize('memory.read')) return true;
          const result = await service.getSelf(agentId);
          return sendOk(result);
        }
        if (req.method === 'PUT') {
          if (!await authorize('memory.write')) return true;
          if (!guardBrowserWrite()) return true;
          if (!ensureMode()) return true;
          const key = idempotencyKey();
          if (replayIdempotent(key)) return true;
          const payload = requireBodyObject();
          if (!payload) return true;
          if (payload.agentId !== undefined && payload.agentId !== agentId) {
            return sendError(400, 'invalid_request', 'body.agentId 与路径不一致');
          }
          const result = await service.putSelf(agentId, payload);
          rememberIdempotent(key, result, []);
          return sendOk(result);
        }
        return sendError(405, 'method_not_allowed', 'self 仅接受 GET/PUT');
      }

      if (parts.length === 3 && parts[0] === 'recall' && parts[2] === 'feedback') {
        if (req.method !== 'POST') return sendError(405, 'method_not_allowed', 'feedback 仅接受 POST');
        if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
        if (!await authorize('memory.write')) return true;
        if (!guardBrowserWrite()) return true;
        if (!ensureMode()) return true;
        const key = idempotencyKey();
        if (replayIdempotent(key)) return true;
        const payload = requireBodyObject();
        if (!payload) return true;
        const result = await service.traceFeedback(parts[1], payload);
        rememberIdempotent(key, result, []);
        return sendOk(result);
      }

      if (parts.length === 2 && parts[0] === 'objects') {
        if (req.method !== 'GET') return sendError(405, 'method_not_allowed', 'objects 仅接受 GET');
        if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
        if (!await authorize('memory.admin')) return true;
        const result = await service.getObject(parts[1], {
          includeContent: queryFlag(url, 'includeContent'),
        });
        if (!result?.object) return sendError(404, 'not_found', '对象不存在');
        return sendOk(result);
      }

      if (parts.length === 1 && parts[0] === 'traces') {
        if (req.method !== 'GET') return sendError(405, 'method_not_allowed', 'traces 仅接受 GET');
        if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
        if (!await authorize('memory.admin')) return true;
        const limitRaw = Number(url.searchParams.get('limit') ?? '50');
        const traces = await service.listTraces(Number.isFinite(limitRaw) ? limitRaw : 50);
        return sendOk({ traces });
      }

      if (parts.length === 2 && parts[0] === 'traces') {
        if (req.method !== 'GET') return sendError(405, 'method_not_allowed', 'traces 仅接受 GET');
        if (!service) return sendError(503, 'runtime_not_ready', 'Runtime 尚未初始化', undefined, true);
        if (!await authorize('memory.admin')) return true;
        const trace = await service.getTrace(parts[1]);
        if (!trace) return sendError(404, 'not_found', 'trace 不存在');
        return sendOk({ trace });
      }

      return sendError(404, 'not_found', `未知 Runtime 路径：${path}`);
    } catch (error) {
      return sendServiceError(error);
    }
  };
}
