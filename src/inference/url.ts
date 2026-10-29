// OpenAI-compatible endpoint 地址校验与归一化（0.3.0 hardening）。
//
// 规则：
// - 只接受 https；http 仅允许回环地址（127.0.0.0/8、::1、localhost）；
// - 拒绝 URL userinfo（`https://user:pass@host/`）——不能把凭据放进 baseUrl；
// - 拒绝云 metadata 地址与 link-local 地址，避免模型请求被配置到实例元数据；
// - 允许用户只写 `https://api.example.com`，统一补成 `/v1`；已有 `/v1` 不重复追加。
//
// 本模块不做 DNS 解析；拒绝的是字面量地址/已知 metadata 主机名。DNS rebinding
// 不在 0.3 的防护范围内。

export type ChatBaseUrlError =
  | 'base_url_required'
  | 'base_url_invalid'
  | 'base_url_userinfo'
  | 'base_url_insecure'
  | 'base_url_metadata'
  | 'base_url_link_local';

export type NormalizedChatBaseUrl =
  | { ok: true; url: string }
  | { ok: false; reason: ChatBaseUrlError };

const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.internal',
  'instance-data',
]);

const METADATA_IPV4 = new Set([
  '100.100.100.200', // Alibaba Cloud
  '169.254.0.23', // Tencent Cloud
  '169.254.169.254', // AWS / GCP / Azure / OpenStack
  '169.254.170.2', // AWS ECS task metadata
]);

const METADATA_IPV6 = new Set([
  'fd00:ec2::254', // AWS IPv6 instance metadata
]);

function ipv4Parts(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map((value) => Number(value));
  return parts.every((value) => value >= 0 && value <= 255) ? parts : null;
}

function bareHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

/** `::ffff:7f00:1` → 127.0.0.1；WHATWG URL 会把 IPv4-mapped IPv6 规范成十六进制。 */
function ipv4MappedParts(host: string): number[] | null {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (!match) return null;
  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function literalIpv4Parts(host: string): number[] | null {
  return ipv4Parts(host) ?? ipv4MappedParts(host);
}

function isLoopbackHost(hostname: string): boolean {
  const host = bareHostname(hostname).toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  const parts = literalIpv4Parts(host);
  return parts !== null && parts[0] === 127;
}

function isMetadataHost(hostname: string): boolean {
  const host = bareHostname(hostname).toLowerCase();
  if (METADATA_HOSTS.has(host) || METADATA_IPV6.has(host)) return true;
  const parts = literalIpv4Parts(host);
  return parts !== null && METADATA_IPV4.has(parts.join('.'));
}

function isLinkLocalHost(hostname: string): boolean {
  const host = bareHostname(hostname).toLowerCase();
  const parts = literalIpv4Parts(host);
  if (parts !== null) return parts[0] === 169 && parts[1] === 254;
  // IPv6 link-local: fe80::/10 → fe80–febf.
  return /^fe[89ab][0-9a-f]:/i.test(host) || host === 'fe80::';
}

function withV1Path(url: URL): string {
  let path = url.pathname.replace(/\/+$/, '');
  if (path.length === 0) path = '/v1';
  else if (!/\/v1$/i.test(path)) path = `${path}/v1`;
  url.pathname = path;
  return url.toString().replace(/\/+$/, '');
}

/**
 * 把用户配置的 API base URL 规范成 OpenAI-compatible `/v1` 根地址。
 * 失败时只返回稳定原因码，不返回原始值（避免把 userinfo 等敏感片段带到状态/日志）。
 */
export function normalizeChatBaseUrl(value: string | null | undefined): NormalizedChatBaseUrl {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, reason: 'base_url_required' };
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, reason: 'base_url_invalid' };
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, reason: 'base_url_userinfo' };
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    return { ok: false, reason: 'base_url_invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'base_url_insecure' };
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return { ok: false, reason: 'base_url_insecure' };
  }
  if (isMetadataHost(url.hostname)) {
    return { ok: false, reason: 'base_url_metadata' };
  }
  if (isLinkLocalHost(url.hostname)) {
    return { ok: false, reason: 'base_url_link_local' };
  }

  return { ok: true, url: withV1Path(url) };
}
