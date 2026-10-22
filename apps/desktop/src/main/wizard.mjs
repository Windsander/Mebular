// M2/UX-2 · 一屏两段向导（首次上手）纯逻辑：状态机 / 深链 / 邀请构造 / 日志脱敏
//
// 不 import electron；home/http/cli 可注入，便于单测与 smoke（无 GUI、有界）。
// 向导**幂等可重入**：每步用「真实状态检测」判 done，重跑不会重复副作用。
// UX-2：邀请移出引导（控制台单动作页）；段②「已完成」需用户显式确认（assistantsAcked 持久化）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 步骤（唯一真源）。UX-2：两段（邀请移出引导）。 */
export const WIZARD_STEPS = Object.freeze(['start', 'assistants']);

// 展示文案不放在逻辑层：title / titleKey 是 desktop pack key，渲染层用 t() 翻译。
export const STEP_TITLES = Object.freeze({
  start: 'wizard.step.start.title',
  assistants: 'wizard.step.assistants.title',
});

/**
 * 计算向导状态（每步 done 由真实检测决定；current = 首个未完成步，全完成则 null）。
 * 入参均为「已探测结果」，本函数不发起 IO。
 *
 * P4：步骤① done 只看 daemonHealthy——UNINITIALIZED 是正常引导阶段
 * （建新/加入由 P3 控制台锁定壳的顶栏弹框完成），不再让 provisionRequired 阻塞「启动」。
 * provision 字段保留在 detail 里作诊断，不参与 done 判定。
 */
/**
 * R-1 高-1：桌面壳状态文件（<home>/.desktop-state.json）——向导完成态跨进程持久。
 * 只记壳层事实（曾生成邀请 / 用户跳过向导），不是配置项；读失败一律当空。
 */
export function desktopStatePath(home) {
  return join(home, '.desktop-state.json');
}

export function readDesktopState(home) {
  try {
    const data = JSON.parse(readFileSync(desktopStatePath(home), 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function writeDesktopState(home, patch) {
  const next = { ...readDesktopState(home), ...(patch ?? {}) };
  try {
    writeFileSync(desktopStatePath(home), `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  } catch {
    // 落盘失败不阻断向导（下次启动重新推导真实状态）
  }
  return next;
}

/**
 * UX-2：complete = ① 跑通 ∧ ② 用户显式点「已完成」（wizard.assistantsAcked，持久化）。
 * 「已接入 ✓」不自动翻段——接入 ≥1 只解锁「已完成」按钮；邀请不再参与完成推导（移出引导）。
 * wizard.skipped（用户点「跳过，直接进入控制台」）视为向导结束（complete）。
 */
export function computeWizardState({ daemonHealthy, provisionRequired, provisioned, service, assistants, wizard } = {}) {
  const steps = [
    {
      id: 'start',
      title: STEP_TITLES.start,
      titleKey: STEP_TITLES.start,
      done: Boolean(daemonHealthy),
      detail: {
        healthy: Boolean(daemonHealthy),
        // P4 诊断字段（不参与 start.done）：UNINITIALIZED 不再表示启动未完成
        provision: { required: Boolean(provisionRequired), provisioned: provisionRequired ? Boolean(provisioned) : null },
        // F2a 双保险①：registered/running 保三态（true/false/null=未知）——
        // probeService 模块加载失败/探测异常时 registered 为 undefined，绝不能坍缩成 false（会误显「让 Mebular 常驻」）
        ...(service
          ? {
              registered: service.registered === undefined || service.registered === null ? null : Boolean(service.registered),
              running: service.running === undefined || service.running === null ? null : Boolean(service.running),
              autostart: service.autostart ?? null,
            }
          : {}),
      },
    },
    {
      id: 'assistants',
      title: STEP_TITLES.assistants,
      titleKey: STEP_TITLES.assistants,
      done: Boolean(wizard?.assistantsAcked),
      detail: assistants ?? null,
    },
  ];
  const current = steps.find((s) => !s.done)?.id ?? null;
  const skipped = Boolean(wizard?.skipped);
  return { steps, current, skipped, complete: current === null || skipped };
}

/**
 * F2b 安装幂等判定（纯函数，可单测）：已注册 → no-op（不重写 plist、不重启守护）。
 * @returns {{ action: 'noop' | 'install', already: boolean }}
 */
export function installDecision(status) {
  return status?.registered === true ? { action: 'noop', already: true } : { action: 'install', already: false };
}

/** 深链：控制台（H-1「连接 AI 助手」面板 / 邀请设备）。 */
export function deepLinks(http = { host: '127.0.0.1', port: 7331 }) {
  const base = `http://${http.host}:${http.port}/console`;
  return {
    console: base,
    assistants: `${base}?view=connect`,
    device: `${base}?view=connect&step=device`,
  };
}

/** 只允许回环 http(s) 深链（安全红线：不加载外站）。 */
export function isLoopbackUrl(url) {
  return /^https?:\/\/127\.0\.0\.1(:\d+)?([/?#]|$)/.test(String(url));
}

/**
 * 邀请命令构造（**只构造，不发送**）：优先 `fleet invite`（QR/文本由输出给出）。
 * 返回 { command, args, cwd }；执行由调用方（主进程 IPC）负责。
 */
export function invitePlan({ fleetBin, home, device, relay }) {
  const args = ['invite', '--dir', home];
  if (typeof device === 'string' && device.length > 0) args.push('--device', device);
  if (typeof relay === 'string' && relay.length > 0) args.push('--relay', relay);
  return { command: process.execPath, args: [fleetBin, ...args], cwd: home };
}

/** 解析 `fleet invite` 输出（取最后一个 JSON 行）→ { token, qrSvg|null, endpoint|null }。 */
export function parseInviteOutput(output) {
  const lines = String(output ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const data = JSON.parse(lines[i]);
      return {
        token: typeof data.token === 'string' ? data.token : null,
        qrSvg: typeof data.qrSvg === 'string' && data.qrSvg.length > 0 ? data.qrSvg : null,
        endpoint: typeof data.endpoint === 'string' ? data.endpoint : null,
        warning: typeof data.warning === 'string' ? data.warning : null,
      };
    } catch {
      // 继续向上找
    }
  }
  return { token: null, qrSvg: null, endpoint: null, warning: null };
}

/** 文本令牌兜底（qrcode 缺失时）。 */
export function inviteText({ token, endpoint }) {
  if (!token) return null;
  return endpoint
    ? `加入令牌（复制给另一台设备的 Mebular App）：\n${token}\n\n邀请方端点：${endpoint}`
    : `加入令牌（复制给另一台设备的 Mebular App）：\n${token}`;
}

// ---------- 日志脱敏 ----------

const SECRET_KEYS = 'token|accessToken|refreshToken|privateKey|privateKeyPkcs8|userMasterKey|masterKey|passphrase|secret|password|csrf';

/**
 * 日志脱敏：不回显令牌/密钥/口令。
 * 顺序要点：先抹 `Bearer <credential>`（否则键值规则会把 scheme 词 `Bearer` 当值、留下凭据）。
 */
export function redactLog(text) {
  let out = String(text ?? '');
  out = out.replace(/("signature"\s*:\s*")([^"]{4,})(")/gi, '$1[redacted]$3');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=#-]{8,}/gi, '$1[redacted]');
  out = out.replace(new RegExp(`("(?:${SECRET_KEYS})"\\s*:\\s*")([^"]{1,})(")`, 'gi'), '$1[redacted]$3');
  out = out.replace(new RegExp(`(\\b(?:${SECRET_KEYS})\\s*[=:]\\s*)([^\\s"']{4,})`, 'gi'), '$1[redacted]');
  out = out.replace(/\bmeb_[A-Za-z0-9_-]{6,}/g, 'meb_[redacted]');
  return out;
}

/** 取末尾 N 行（日志页默认窗口）。 */
export function tailText(text, lines = 200) {
  const arr = String(text ?? '').split('\n');
  while (arr.length > 0 && arr[arr.length - 1] === '') arr.pop(); // 去全部尾部空行（日志常以换行结尾）
  return arr.slice(-Math.max(0, lines)).join('\n');
}

/**
 * R-1 中-8：邀请改走与控制台同源的 `POST /admin/api/invite`（主进程直调）。
 * 不再依赖 `fleet invite` CLI（fresh home 无 fleet.config.json 时 CLI 必 ENOENT）。
 * 返回与 parseInviteOutput 同形：{ token, qrSvg, endpoint, warning }。
 */
export async function inviteViaApi(fetchImpl, http = { host: '127.0.0.1', port: 7331 }, timeoutMs = 8000) {
  const base = `http://${http.host}:${http.port}`;
  try {
    const csrf = await prefetchCsrf(fetchImpl, base, timeoutMs);
    const res = await fetchImpl(`${base}/admin/api/invite`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...csrfHeaders(csrf),
      },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data?.error === 'join_disabled') {
      return { token: null, qrSvg: null, endpoint: null, warning: '未启用加入服务：在控制台点「邀请设备」可就地启用加入服务并继续（将重启守护）。' };
    }
    if (!res.ok) {
      return { token: null, qrSvg: null, endpoint: null, warning: `邀请失败（HTTP ${res.status}）：${data?.message ?? '请看诊断日志'}` };
    }
    return {
      token: typeof data?.token === 'string' ? data.token : null,
      qrSvg: typeof data?.qrSvg === 'string' && data.qrSvg.length > 0 ? data.qrSvg : null,
      endpoint: typeof data?.endpoint === 'string' ? data.endpoint : null,
      warning: typeof data?.warning === 'string' ? data.warning : null,
    };
  } catch (error) {
    return { token: null, qrSvg: null, endpoint: null, warning: `邀请失败：${error?.message ?? error}` };
  }
}

// ---------- UX-2 段②行级接入：助手列表 / 接入动作（主进程直调回环 admin API） ----------

/**
 * CSRF 双提交预取（修死）：token **仅由 `GET /console/` 下发**（响应头 `x-mebular-csrf`
 * + `Set-Cookie: mebular_csrf=<同值>`）；`/admin/api/*` 从不下发——此前从
 * `/admin/api/overview` 预取恒空 → 桌面主进程一切写操作 403。
 * 服务端 csrfValid 要求 **头 ∧ cookie 同值**，故两者都要取。
 * 返回 { token, cookie } | null（失败不阻断：写请求会得到服务端明确的 403 文案）。
 */
export async function prefetchCsrf(fetchImpl, base, timeoutMs = 8000) {
  try {
    const pre = await fetchImpl(`${base}/console/`, { signal: AbortSignal.timeout(timeoutMs) });
    const token = pre?.headers?.get?.('x-mebular-csrf') ?? null;
    if (!token) return null;
    const raw = typeof pre?.headers?.getSetCookie === 'function'
      ? pre.headers.getSetCookie().join('; ')
      : String(pre?.headers?.get?.('set-cookie') ?? '');
    const match = raw.match(/(?:^|;\s*)mebular_csrf=([^;]*)/);
    // 服务端保证 cookie 值 == token（setCsrfCookie）；解析失败时按契约回退
    const cookie = `mebular_csrf=${match ? match[1] : token}`;
    return { token, cookie };
  } catch {
    return null;
  }
}

/** CSRF 双提交头（`x-mebular-csrf` ∧ `cookie: mebular_csrf=<同值>`；null → 空对象）。 */
function csrfHeaders(csrf) {
  return csrf ? { 'x-mebular-csrf': csrf.token, cookie: csrf.cookie } : {};
}

/** GET /admin/api/clients → { ok, clients, warning? }（读失败不阻断向导，给 warning）。 */
export async function clientsViaApi(fetchImpl, http = { host: '127.0.0.1', port: 7331 }, timeoutMs = 8000) {
  const base = `http://${http.host}:${http.port}`;
  try {
    const res = await fetchImpl(`${base}/admin/api/clients`, { signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, clients: [], warning: `助手列表读取失败（HTTP ${res.status}）` };
    return { ok: true, clients: Array.isArray(data?.clients) ? data.clients : [] };
  } catch (error) {
    return { ok: false, clients: [], warning: `助手列表读取失败：${error?.message ?? error}` };
  }
}

/**
 * POST /admin/api/clients/{id}/{action}（connect/recheck/verify；CSRF 双提交）。
 * verify = 用户已确认重载后的重新验证（body {userConfirmedReload:true}），返回透传 state/steps。
 * 返回 { ok, changed?, state?, needsManual?, reason?, warning? }；id/action 仅允许安全字符（防路径注入）。
 */
export async function clientActionViaApi(fetchImpl, http = { host: '127.0.0.1', port: 7331 }, id, action, timeoutMs = 15000) {
  if (!/^[\w-]{1,64}$/.test(String(id ?? '')) || !/^(connect|recheck|verify)$/.test(String(action ?? ''))) {
    return { ok: false, warning: '非法的助手动作参数' };
  }
  const base = `http://${http.host}:${http.port}`;
  try {
    const csrf = await prefetchCsrf(fetchImpl, base, timeoutMs);
    const res = await fetchImpl(`${base}/admin/api/clients/${id}/${action}`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...csrfHeaders(csrf),
      },
      body: action === 'verify' ? '{"userConfirmedReload":true}' : '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 补丁 3：失败语义透传 rolledBack/backupPath（UI 据此明示「已自动还原原配置」）
      return {
        ok: false,
        needsManual: Boolean(data?.needsManual),
        rolledBack: Boolean(data?.rolledBack),
        backupPath: typeof data?.backupPath === 'string' ? data.backupPath : null,
        warning: data?.reason ?? data?.message ?? `动作失败（HTTP ${res.status}）`,
      };
    }
    // verify：未过也是有效结果（HTTP 200，body 带 ok/state/steps）
    return {
      ok: action === 'verify' ? Boolean(data?.ok) : true,
      changed: Boolean(data?.changed),
      state: data?.state ?? null,
      steps: Array.isArray(data?.steps) ? data.steps : null,
      needsManual: Boolean(data?.needsManual),
      reason: data?.reason ?? null,
    };
  } catch (error) {
    return { ok: false, warning: `动作失败：${error?.message ?? error}` };
  }
}

export { existsSync, join };
