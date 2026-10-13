// M2 · 三步向导（首次上手）纯逻辑：状态机 / 深链 / 邀请构造 / 日志脱敏
//
// 不 import electron；home/http/cli 可注入，便于单测与 smoke（无 GUI、有界）。
// 向导**幂等可重入**：每步用「真实状态检测」判 done，重跑不会重复副作用。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 步骤（唯一真源）。 */
export const WIZARD_STEPS = Object.freeze(['start', 'assistants', 'device']);

export const STEP_TITLES = Object.freeze({
  start: '① 启动 Mebular',
  assistants: '② 连接 AI 助手',
  device: '③ 添加设备',
});

/**
 * 计算向导状态（每步 done 由真实检测决定；current = 首个未完成步，全完成则 null）。
 * 入参均为「已探测结果」，本函数不发起 IO。
 *
 * 高-1（W-1）：步骤① done = daemonHealthy && !provisionRequired——
 * 守护进程活着但处于引导/待重启态（/app/provision/status 200 且 provision===true）时
 * 不算完成「启动」，current 停在 start 并给「建新/加入 →」CTA；404 = 正常态。
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
 * R-1 高-1：③done 改真实状态推导——曾生成邀请（wizard.inviteCreated，持久化）
 * ∨ 已知对端 ≥1（peers.known，来自 /admin/api/devices）；不再依赖主进程内存变量。
 * wizard.skipped（用户点「跳过，直接进入控制台」）视为向导结束（complete）。
 */
export function computeWizardState({ daemonHealthy, provisionRequired, provisioned, service, assistants, invite, peers, wizard } = {}) {
  const steps = [
    {
      id: 'start',
      title: STEP_TITLES.start,
      done: Boolean(daemonHealthy) && !provisionRequired,
      detail: {
        provision: { required: Boolean(provisionRequired), provisioned: provisionRequired ? Boolean(provisioned) : null },
        ...(service
          ? { registered: Boolean(service.registered), running: Boolean(service.running), autostart: service.autostart ?? null }
          : {}),
      },
    },
    {
      id: 'assistants',
      title: STEP_TITLES.assistants,
      done: Number(assistants?.connectedCount ?? 0) > 0,
      detail: assistants ?? null,
    },
    {
      id: 'device',
      title: STEP_TITLES.device,
      done: Boolean(invite?.created) || Boolean(wizard?.inviteCreated) || Number(peers?.known ?? 0) >= 1,
      detail: { invite: invite ?? null, knownPeers: Number(peers?.known ?? 0), inviteCreated: Boolean(wizard?.inviteCreated) },
    },
  ];
  const current = steps.find((s) => !s.done)?.id ?? null;
  const skipped = Boolean(wizard?.skipped);
  return { steps, current, skipped, complete: current === null || skipped };
}

/** 深链：控制台（H-1「连接 AI 助手」面板 / 添加设备）。 */
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
 * CSRF：先 GET 读端点取 `x-mebular-csrf` 响应头（回环 auth=none 下服务端会下发），再带头发 POST。
 * 返回与 parseInviteOutput 同形：{ token, qrSvg, endpoint, warning }。
 */
export async function inviteViaApi(fetchImpl, http = { host: '127.0.0.1', port: 7331 }, timeoutMs = 8000) {
  const base = `http://${http.host}:${http.port}`;
  try {
    let csrf = null;
    try {
      const pre = await fetchImpl(`${base}/admin/api/overview`, { signal: AbortSignal.timeout(timeoutMs) });
      csrf = pre?.headers?.get?.('x-mebular-csrf') ?? null;
    } catch {
      // 预取失败不阻断：POST 仍尝试（服务端校验失败会给出明确错误）
    }
    const res = await fetchImpl(`${base}/admin/api/invite`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...(csrf ? { 'x-mebular-csrf': csrf } : {}),
      },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data?.error === 'join_disabled') {
      return { token: null, qrSvg: null, endpoint: null, warning: '未启用加入服务：在控制台「设置 → 常用配置」开启加入服务并重启后再试。' };
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

export { existsSync, join };
